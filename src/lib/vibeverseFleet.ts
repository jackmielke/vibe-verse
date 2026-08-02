/**
 * The fleet — everyone else flying the galaxy right now.
 *
 * Mirrors the pattern Vibe City already established in
 * `components/city/multiplayer.ts`: one Supabase Realtime channel carrying
 * presence for who is here, and a low-rate broadcast for where they are. No
 * tables and no migrations — presence is ephemeral by construction, which is
 * exactly right for "who is flying at this instant" and means shipping this
 * costs the database nothing.
 *
 * Two things shape the design.
 *
 * The galaxy is fourteen systems, and two ships in different systems cannot see
 * each other at all — so position is only worth broadcasting to people in the
 * same one. Everyone gets presence (cheap, and the star map wants it); only
 * same-system traffic gets coordinates.
 *
 * And it has to be *inert* when it cannot connect. The ship is flown from a
 * route that may be offline or blocked, and a world that will not start because
 * a socket refused is a worse world than one you fly alone. Every path here
 * fails to "you are the only one out here".
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

/** How often a ship tells the others where it is. */
const POS_HZ = 4;
/** A traveller unheard from for this long is treated as gone. */
const STALE_MS = 25_000;

export interface Traveller {
  /** Presence key — stable for the length of a session. */
  id: string;
  name: string;
  /** Hex, validated before it ever reaches a canvas or a material. */
  color: string;
  /** Which star system they are in, by galaxy index. */
  systemId: number;
  systemName: string;
  /** Position within that system, in world units. Absent until they broadcast. */
  x?: number;
  y?: number;
  z?: number;
  /** Fraction of max speed, 0..1 — drives how their contact is drawn. */
  speed?: number;
  /** Wall-clock of the last thing we heard from them. */
  seen: number;
}

export interface FleetSnapshot {
  /** Everyone else, anywhere in the galaxy. */
  travellers: Traveller[];
  /** Everyone else in the same system as us. */
  here: Traveller[];
  /** How many systems have somebody in them, by galaxy index. */
  bySystem: Record<number, number>;
  online: boolean;
  /** Newest first: arrivals and departures, for the ship's log. */
  events: { text: string; ts: number }[];
}

const HEX = /^#[0-9a-f]{6}$/i;
const safeColor = (c: unknown) => (typeof c === "string" && HEX.test(c) ? c : "#8fe4ff");
const safeName = (n: unknown) =>
  String(n ?? "Traveller").replace(/\s+/g, " ").trim().slice(0, 22) || "Traveller";

/**
 * Join the fleet.
 *
 * Returns a handle whose `snapshot()` is safe to call every frame — it is a
 * plain read of already-reduced state, not a query. `dispose()` must be called
 * when the route unmounts; a channel that outlives the world keeps a socket and
 * a presence entry alive, and the next visitor sees a ghost that never moves.
 */
export function joinFleet(opts: {
  name: string;
  color?: string;
  onEvent?: (text: string) => void;
}) {
  const me = {
    name: safeName(opts.name),
    color: safeColor(opts.color),
    systemId: -1,
    systemName: "",
  };

  const others = new Map<string, Traveller>();
  const events: { text: string; ts: number }[] = [];
  let channel: RealtimeChannel | null = null;
  let online = false;
  let disposed = false;
  let posTimer: ReturnType<typeof setInterval> | null = null;
  let pos = { x: 0, y: 0, z: 0, speed: 0 };

  const note = (text: string) => {
    events.unshift({ text, ts: Date.now() });
    if (events.length > 12) events.pop();
    opts.onEvent?.(text);
  };

  try {
    channel = supabase.channel("vibeverse-fleet", {
      config: { presence: { key: crypto.randomUUID?.() || String(Math.random()) } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
       try {
        const state = channel!.presenceState() as Record<string, Array<Record<string, unknown>>>;
        const seenNow = new Set<string>();
        for (const [key, metas] of Object.entries(state)) {
          const m = metas?.[metas.length - 1];
          if (!m) continue;
          seenNow.add(key);
          const prev = others.get(key);
          const t: Traveller = {
            id: key,
            name: safeName(m.name),
            color: safeColor(m.color),
            systemId: Number(m.systemId ?? -1),
            systemName: String(m.systemName ?? ""),
            x: prev?.x, y: prev?.y, z: prev?.z, speed: prev?.speed,
            seen: Date.now(),
          };
          if (!prev) note(`${t.name} is flying${t.systemName ? ` · ${t.systemName}` : ""}`);
          others.set(key, t);
        }
        // Presence sync is authoritative about who exists.
        for (const key of [...others.keys()]) {
          if (!seenNow.has(key)) {
            const gone = others.get(key);
            others.delete(key);
            if (gone) note(`${gone.name} has folded out`);
          }
        }
       } catch (e) {
        /* Socket callbacks are invoked from the realtime client's own stack;
           a throw here propagates somewhere nobody is catching it. */
        console.warn("fleet presence sync failed", e);
       }
      })
      .on("broadcast", { event: "nav" }, ({ payload }) => {
       try {
        const p = payload as Record<string, unknown>;
        const key = String(p.id ?? "");
        const t = others.get(key);
        if (!t) return;                       // presence has not caught up yet
        t.x = Number(p.x) || 0;
        t.y = Number(p.y) || 0;
        t.z = Number(p.z) || 0;
        t.speed = Math.max(0, Math.min(1, Number(p.speed) || 0));
        t.systemId = Number(p.systemId ?? t.systemId);
        t.seen = Date.now();
       } catch (e) { console.warn("fleet nav dropped", e); }
      })
      .subscribe((status) => {
        try {
          online = status === "SUBSCRIBED";
          if (online) {
            void channel!.track({ ...me });
            note("fleet link established");
          }
        } catch (e) { console.warn("fleet subscribe failed", e); online = false; }
      });

    /* Position goes out on a timer rather than per frame. At sixty frames a
       second this would be sixty messages a second per ship, which is both
       rude to the socket and pointless — nothing in the galaxy moves fast
       enough at this scale for four updates a second to look stepped. */
    posTimer = setInterval(() => {
      try {
      if (!online || !channel || me.systemId < 0) return;
      void channel.send({
        type: "broadcast",
        event: "nav",
        payload: { id: channel.params?.config?.presence?.key, systemId: me.systemId, ...pos },
      });
      } catch (e) { console.warn("fleet position send failed", e); }
    }, 1000 / POS_HZ);
  } catch (e) {
    // Offline, blocked, or no realtime on this project. Fly alone.
    console.warn("fleet unavailable", e);
    online = false;
  }

  return {
    /** Tell the fleet which system we are in. Cheap to call repeatedly. */
    setSystem(systemId: number, systemName: string) {
      if (disposed) return;
      if (me.systemId === systemId) return;
      me.systemId = systemId;
      me.systemName = systemName;
      if (online && channel) void channel.track({ ...me });
    },
    /** Tell the fleet where we are. Called every frame; sent four times a second. */
    setPosition(x: number, y: number, z: number, speed: number) {
      pos = { x, y, z, speed: Math.max(0, Math.min(1, speed || 0)) };
    },
    snapshot(): FleetSnapshot {
      const now = Date.now();
      const travellers: Traveller[] = [];
      const bySystem: Record<number, number> = {};
      for (const t of others.values()) {
        // A ship whose tab was closed without a clean leave stops updating.
        if (now - t.seen > STALE_MS) continue;
        travellers.push(t);
        if (t.systemId >= 0) bySystem[t.systemId] = (bySystem[t.systemId] || 0) + 1;
      }
      return {
        travellers,
        here: travellers.filter((t) => t.systemId === me.systemId),
        bySystem,
        online,
        events,
      };
    },
    dispose() {
      disposed = true;
      if (posTimer) clearInterval(posTimer);
      posTimer = null;
      try { channel?.untrack(); } catch { /* already gone */ }
      try { if (channel) void supabase.removeChannel(channel); } catch { /* ditto */ }
      channel = null;
      online = false;
    },
  };
}

export type Fleet = ReturnType<typeof joinFleet>;
