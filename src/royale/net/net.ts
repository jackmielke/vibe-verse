/**
 * SPLASH ROYALE — multiplayer transport over Supabase Realtime.
 *
 * The battle-royale twin of `src/components/city/multiplayer.ts`, which has
 * been carrying Vibe City in production for months: one channel per room,
 * presence for the roster, a throttled broadcast for poses, another for
 * gameplay events and chat. That file is not imported here — it is welded to
 * Vibe City's GLTF character rig — but its shape is the shape below, because
 * its shape works.
 *
 * Three things it does that a naive port would not:
 *
 *  - **It is optional.** `/drop-zero` is live and single-player. If Supabase
 *    is unreachable, blocked, or simply never joined, `online` stays false,
 *    every method is a no-op, and the game is exactly what it was. The
 *    Supabase client is even loaded through a dynamic import, so a build that
 *    never joins a room never pays for the socket.
 *  - **It interpolates.** At 10 Hz a raw position write is visibly steppy.
 *    Peers are rendered ~140 ms in the past, between the two most recent
 *    packets, with extrapolation clamped hard so a peer whose connection
 *    dies coasts a metre or two and stops instead of sliding into the sea.
 *  - **It runs on simulated time.** Every timer here — the send rate, the
 *    interpolation delay, the peer reap — is measured in `ctx.elapsed`
 *    seconds. Under SwiftSHADER this container simulates ~400x slower than
 *    wall clock, and anything keyed off `performance.now()` behaves like it
 *    is being fast-forwarded. The one exception is the socket-connect
 *    timeout, which is genuinely a wall-clock network event and is marked as
 *    such below.
 *
 * Authority is the sender's, over its own position and its own dryness.
 * There is no hit validation. This is a friendly water fight; a simple model
 * that ships beats a correct one that does not.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { System, SystemFactory, WorldCtx } from "../types";
import type { ChatLine, NetEventKind, NetPose, NetProfile, NetService, PeerState } from "./types";

// ---------------------------------------------------------------- tuning

/** Pose send rate. 10 Hz is the sweet spot: cheap, and interpolatable. */
const POSE_INTERVAL = 1 / 10;
/** Resend even when nothing changed, so peers know we are still here. */
const POSE_HEARTBEAT = 1.5;
/** Movement below these deltas is not worth a packet. */
const POS_EPSILON = 0.04;
const ANGLE_EPSILON = 0.02;
const DRY_EPSILON = 0.5;

/**
 * Render peers this far in the past (simulated seconds). Slightly more than
 * one send interval, so under normal jitter there is always a packet on both
 * sides of the render time and we interpolate rather than guess.
 */
const INTERP_DELAY = 0.14;
/** Never extrapolate further than this past the newest packet. */
const MAX_EXTRAP = 0.3;
/** ...and never further than this in metres, whatever the maths says. */
const MAX_EXTRAP_DIST = 3.5;
/** A jump larger than this is a teleport (bus drop, respawn) — snap, don't lerp. */
const TELEPORT_DIST = 25;
/** Drop a peer that has said nothing for this long, in simulated seconds. */
const PEER_TIMEOUT = 6;
/** Chat backlog cap. */
const MAX_MESSAGES = 80;
/** Wall-clock ceiling on the initial socket handshake, in ms. */
const CONNECT_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------- codes

/**
 * Room-code vocabulary. Water words plus a three-character suffix drawn from
 * an alphabet with no 0/O/1/I/5/S, because these get read aloud over voice
 * chat and "SPLASH-0B1" is a support ticket waiting to happen.
 */
const CODE_WORDS = [
  "SPLASH",
  "SOAK",
  "DRIP",
  "RINSE",
  "SPRAY",
  "PUDDLE",
  "GEYSER",
  "MIST",
  "TORRENT",
  "DRENCH",
] as const;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRTUVWXYZ";

/** A fresh shareable lobby code, e.g. "SPLASH-4B2". */
export function generateRoomCode(rng: () => number = Math.random): string {
  const word = CODE_WORDS[Math.floor(rng() * CODE_WORDS.length) % CODE_WORDS.length];
  let tail = "";
  for (let i = 0; i < 3; i++) {
    tail += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return `${word}-${tail}`;
}

/**
 * Canonicalise whatever a player typed or pasted into the code that names
 * the channel. Case, spaces and stray punctuation must not split a lobby in
 * two — "splash 4b2" and "SPLASH-4B2" are the same match.
 */
export function normalizeRoomCode(raw: string): string {
  const cleaned = (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return cleaned;
}

// ---------------------------------------------------------------- internals

/** One received pose, stamped with the simulated time it arrived. */
interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** A peer plus the two-sample buffer the interpolator runs on. */
interface PeerRecord extends PeerState {
  prev: Sample | null;
  last: Sample | null;
}

/** Wire format. Single-letter keys — this goes out ten times a second. */
interface PoseWire {
  i: string;
  x: number;
  y: number;
  z: number;
  a: number;
  p: number;
  s: string;
  d: number;
  t?: string;
  n?: string;
  g?: 1;
}

interface EventWire {
  i: string;
  k: NetEventKind;
  p: unknown;
}

interface PresenceMeta {
  name: string;
  team?: string;
  agent?: boolean;
}

/** Round to 2dp. Centimetre precision is far finer than a water fight needs. */
const q = (n: number): number => Math.round(n * 100) / 100;

/** Shortest-arc angle interpolation, so yaw never spins the long way round. */
function lerpAngle(a: number, b: number, u: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * u;
}

// ---------------------------------------------------------------- system

/**
 * Build the transport and publish it as `ctx.services.net`.
 *
 * Returns immediately and offline: nothing connects until something calls
 * `join()`. The one exception is a `?room=` (or `?soaked=`) query parameter,
 * which auto-joins — that is what makes a shared link land two people in the
 * same match without a lobby screen in between.
 */
export const createNetSystem: SystemFactory = (ctx: WorldCtx): System => {
  const selfId = `s-${Math.random().toString(36).slice(2, 10)}`;
  const peers = new Map<string, PeerState>();
  const messages: ChatLine[] = [];
  const handlers = new Map<NetEventKind, Set<(from: string, payload: unknown) => void>>();

  let channel: RealtimeChannel | null = null;
  let online = false;
  let roomCode: string | null = null;
  let profile: NetProfile = { name: "player" };
  let disposed = false;
  /** Guards against two overlapping join() calls racing to own `channel`. */
  let joinToken = 0;

  let pending: NetPose | null = null;
  let lastSentAt = -Infinity;
  let lastSent: NetPose | null = null;

  const record = (id: string): PeerRecord => {
    let p = peers.get(id) as PeerRecord | undefined;
    if (!p) {
      p = {
        id,
        name: "player",
        team: null,
        agent: false,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        state: "ground",
        dry: 100,
        lastSeen: ctx.elapsed,
        posed: false,
        prev: null,
        last: null,
      };
      peers.set(id, p);
      ctx.emit("soaked:peer-join", { id });
    }
    return p;
  };

  const dropPeer = (id: string) => {
    if (!peers.delete(id)) return;
    ctx.emit("soaked:peer-leave", { id });
  };

  const announce = () => {
    ctx.emit("soaked:net", { online, roomCode, peers: peers.size, selfId });
  };

  const pushMessage = (line: ChatLine) => {
    messages.push(line);
    if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
    ctx.emit("soaked:chat", line);
  };

  const dispatch = (kind: NetEventKind, from: string, payload: unknown) => {
    const set = handlers.get(kind);
    if (!set) return;
    // Copy: a handler is allowed to unsubscribe itself from inside itself.
    for (const fn of [...set]) {
      try {
        fn(from, payload);
      } catch (err) {
        console.warn(`[SPLASH ROYALE net] handler for "${kind}" threw:`, err);
      }
    }
  };

  const onPose = (w: PoseWire) => {
    if (!w || typeof w.i !== "string" || w.i === selfId) return;
    if (!Number.isFinite(w.x) || !Number.isFinite(w.y) || !Number.isFinite(w.z)) return;
    const p = record(w.i);
    if (w.n) p.name = w.n;
    if (w.t !== undefined) p.team = w.t || null;
    if (w.g) p.agent = true;
    p.state = typeof w.s === "string" ? w.s : p.state;
    // The sender owns its own dryness. We copy, we do not arbitrate.
    if (Number.isFinite(w.d)) p.dry = Math.max(0, Math.min(100, w.d));
    p.lastSeen = ctx.elapsed;

    const s: Sample = {
      t: ctx.elapsed,
      x: w.x,
      y: w.y,
      z: w.z,
      yaw: Number.isFinite(w.a) ? w.a : 0,
      pitch: Number.isFinite(w.p) ? w.p : 0,
    };
    const jumped =
      !p.last ||
      Math.hypot(s.x - p.last.x, s.y - p.last.y, s.z - p.last.z) > TELEPORT_DIST;
    if (jumped) {
      // First sighting, or a bus drop / respawn. Interpolating across it
      // would draw a peer skating the length of the island.
      p.prev = s;
      p.last = s;
      p.x = s.x;
      p.y = s.y;
      p.z = s.z;
      p.yaw = s.yaw;
      p.pitch = s.pitch;
    } else {
      p.prev = p.last;
      p.last = s;
    }
    p.posed = true;
  };

  const onEvent = (w: EventWire) => {
    if (!w || typeof w.i !== "string" || w.i === selfId) return;
    const peer = peers.get(w.i) as PeerRecord | undefined;
    if (peer) peer.lastSeen = ctx.elapsed;
    if (w.k === "chat") {
      const body = (w.p ?? {}) as { text?: string; name?: string };
      const text = typeof body.text === "string" ? body.text.slice(0, 280) : "";
      if (!text) return;
      pushMessage({
        id: `${w.i}-${messages.length}-${ctx.elapsed.toFixed(3)}`,
        from: w.i,
        name: body.name || peer?.name || "player",
        text,
        t: ctx.elapsed,
        self: false,
        agent: peer?.agent ?? false,
      });
    }
    dispatch(w.k, w.i, w.p);
  };

  const teardownChannel = () => {
    const dying = channel;
    channel = null;
    online = false;
    if (!dying) return;
    // Fire-and-forget: a socket that is already dead still needs unhooking,
    // and there is nothing useful to do if the unhook itself fails.
    void import("@/integrations/supabase/client")
      .then(({ supabase }) => supabase.removeChannel(dying))
      .catch(() => {});
  };

  const service: NetService = {
    get online() {
      return online;
    },
    get roomCode() {
      return roomCode;
    },
    selfId,
    peers,
    messages,

    async join(code: string, prof: NetProfile): Promise<boolean> {
      if (disposed) return false;
      const wanted = normalizeRoomCode(code) || generateRoomCode(ctx.rng);
      profile = { name: prof?.name || "player", team: prof?.team, agent: !!prof?.agent };
      if (channel && roomCode === wanted) {
        // Already here — just refresh who we say we are.
        void channel.track(presenceMeta());
        return online;
      }
      // Order matters: leave() bumps `joinToken` itself, so the token this
      // join is guarded by has to be taken *after* the old room is dropped.
      if (channel) service.leave();
      const token = ++joinToken;
      roomCode = wanted;
      announce();

      let supabase: typeof import("@/integrations/supabase/client").supabase;
      try {
        // Dynamic so a solo build never pulls the realtime client in, and so
        // a missing/invalid VITE_SUPABASE_* config fails here — as a false —
        // instead of at module scope where it would take the route down.
        ({ supabase } = await import("@/integrations/supabase/client"));
      } catch (err) {
        console.warn("[SPLASH ROYALE net] Supabase unavailable; playing solo.", err);
        announce();
        return false;
      }
      if (disposed || token !== joinToken) return false;

      try {
        const ch = supabase.channel(`splash-${wanted}`, {
          config: {
            presence: { key: selfId },
            broadcast: { self: false, ack: false },
          },
        });
        channel = ch;

        ch.on("presence", { event: "sync" }, () => {
          const state = ch.presenceState<PresenceMeta>();
          const keys = new Set(Object.keys(state));
          for (const key of keys) {
            if (key === selfId) continue;
            const meta = state[key]?.[0];
            if (!meta) continue;
            const p = record(key);
            if (meta.name) p.name = meta.name;
            p.team = meta.team ?? p.team;
            p.agent = !!meta.agent || p.agent;
          }
          // Presence leave is authoritative and instant; the timeout reap
          // below only exists for peers that vanish without a goodbye.
          for (const id of [...peers.keys()]) if (!keys.has(id)) dropPeer(id);
          announce();
        });
        ch.on("broadcast", { event: "pose" }, ({ payload }) => onPose(payload as PoseWire));
        ch.on("broadcast", { event: "ev" }, ({ payload }) => onEvent(payload as EventWire));

        const connected = await new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(ok);
          };
          // Wall clock on purpose: this is a TCP/WebSocket handshake, which
          // happens in real time regardless of how slowly the scene renders.
          const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
          ch.subscribe((status) => {
            if (status === "SUBSCRIBED") {
              finish(true);
            } else if (
              status === "CHANNEL_ERROR" ||
              status === "TIMED_OUT" ||
              status === "CLOSED"
            ) {
              // Not fatal: `online` simply stays false and we play solo.
              finish(false);
            }
          });
        });

        if (disposed || token !== joinToken || channel !== ch) return false;
        online = connected;
        if (connected) {
          await ch.track(presenceMeta());
          // Force the next update() to send, whatever the change filter says.
          lastSent = null;
        } else {
          teardownChannel();
        }
        announce();
        return connected;
      } catch (err) {
        console.warn("[SPLASH ROYALE net] could not join room; playing solo.", err);
        teardownChannel();
        announce();
        return false;
      }
    },

    leave() {
      joinToken++;
      teardownChannel();
      for (const id of [...peers.keys()]) dropPeer(id);
      lastSent = null;
      pending = null;
      roomCode = null;
      announce();
    },

    publishPose(p: NetPose) {
      // Just stash it. The wire write happens in update(), on the clock.
      if (!p || !Number.isFinite(p.x)) return;
      pending = p;
    },

    send(kind: NetEventKind, payload: unknown) {
      if (!online || !channel) return;
      const wire: EventWire = { i: selfId, k: kind, p: payload };
      void channel.send({ type: "broadcast", event: "ev", payload: wire }).catch(() => {});
    },

    on(kind: NetEventKind, fn: (from: string, payload: unknown) => void) {
      let set = handlers.get(kind);
      if (!set) {
        set = new Set();
        handlers.set(kind, set);
      }
      set.add(fn);
      return () => {
        set!.delete(fn);
      };
    },

    chat(text: string) {
      const body = (text ?? "").slice(0, 280).trim();
      if (!body) return;
      // Echo locally first, always. A player typing into a dead socket still
      // sees their own words — silence reads as a broken game.
      pushMessage({
        id: `${selfId}-${messages.length}-${ctx.elapsed.toFixed(3)}`,
        from: selfId,
        name: profile.name,
        text: body,
        t: ctx.elapsed,
        self: true,
        agent: !!profile.agent,
      });
      service.send("chat", { text: body, name: profile.name });
    },
  };

  function presenceMeta(): PresenceMeta {
    return { name: profile.name, team: profile.team, agent: !!profile.agent };
  }

  ctx.services.net = service;

  // A shared link is the whole distribution model for this game, so honour a
  // room code in the URL without making the player click through a lobby.
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("room") ?? params.get("soaked");
    if (fromUrl) void service.join(fromUrl, { name: "player" });
  } catch {
    /* no window (SSR/test) — nothing to auto-join. */
  }

  return {
    name: "net",

    update(_dt: number, c: WorldCtx) {
      const now = c.elapsed;

      // ---- outbound: rate-limited, change-gated pose ----
      if (online && channel && pending) {
        const due = now - lastSentAt >= POSE_INTERVAL;
        if (due) {
          const p = pending;
          const changed =
            !lastSent ||
            Math.abs(lastSent.x - p.x) > POS_EPSILON ||
            Math.abs(lastSent.y - p.y) > POS_EPSILON ||
            Math.abs(lastSent.z - p.z) > POS_EPSILON ||
            Math.abs(lastSent.yaw - p.yaw) > ANGLE_EPSILON ||
            Math.abs(lastSent.pitch - p.pitch) > ANGLE_EPSILON ||
            lastSent.state !== p.state ||
            Math.abs(lastSent.dry - p.dry) > DRY_EPSILON ||
            now - lastSentAt > POSE_HEARTBEAT;
          if (changed) {
            lastSentAt = now;
            lastSent = { ...p };
            const wire: PoseWire = {
              i: selfId,
              x: q(p.x),
              y: q(p.y),
              z: q(p.z),
              a: q(p.yaw),
              p: q(p.pitch),
              s: p.state,
              d: Math.round(p.dry),
              t: p.team ?? profile.team,
              n: profile.name,
            };
            if (profile.agent) wire.g = 1;
            void channel.send({ type: "broadcast", event: "pose", payload: wire }).catch(() => {});
          }
        }
      }

      // ---- inbound: interpolate, then reap ----
      const renderT = now - INTERP_DELAY;
      for (const id of [...peers.keys()]) {
        const p = peers.get(id) as PeerRecord;
        if (now - p.lastSeen > PEER_TIMEOUT) {
          dropPeer(id);
          continue;
        }
        const a = p.prev;
        const b = p.last;
        if (!a || !b) continue;

        const span = Math.max(b.t - a.t, 1e-3);
        // u > 1 means we have run past the newest packet and are guessing.
        // Cap the guess in seconds here and in metres below: a peer whose
        // connection died must coast and stop, not sail off the island.
        let u = (renderT - a.t) / span;
        u = Math.max(0, Math.min(u, 1 + MAX_EXTRAP / span));

        let x = a.x + (b.x - a.x) * u;
        let y = a.y + (b.y - a.y) * u;
        let z = a.z + (b.z - a.z) * u;
        if (u > 1) {
          const dx = x - b.x;
          const dy = y - b.y;
          const dz = z - b.z;
          const d = Math.hypot(dx, dy, dz);
          if (d > MAX_EXTRAP_DIST) {
            const k = MAX_EXTRAP_DIST / d;
            x = b.x + dx * k;
            y = b.y + dy * k;
            z = b.z + dz * k;
          }
        }
        p.x = x;
        p.y = y;
        p.z = z;
        p.yaw = lerpAngle(a.yaw, b.yaw, Math.min(u, 1));
        p.pitch = a.pitch + (b.pitch - a.pitch) * Math.min(u, 1);
      }
    },

    dispose() {
      disposed = true;
      service.leave();
      handlers.clear();
      messages.length = 0;
      if (ctx.services.net === service) ctx.services.net = undefined;
    },
  };
};

export default createNetSystem;
