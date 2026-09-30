/**
 * Your homies in the next cloud city.
 *
 * Presence only, like `src/sf/net`: nobody can affect anybody's buoyancy, so
 * there is no authority and nothing to agree on. Every few seconds each city
 * says what it is (name, people, layout), and everybody else draws it riding
 * the same wind a kilometre away. The one thing that crosses over is a gift,
 * because on Venus the building material is the sky and there is no scarcity
 * to protect.
 *
 * Two transports behind one interface, the shape the Magician uses:
 *  - `online`: a Supabase Realtime broadcast channel, one per room
 *  - `local`: a BroadcastChannel, every tab of one browser — the only half
 *    that runs in the sandbox, and a real way to play two cities on one laptop
 *
 * Joining is allowed to fail. No channel, no neighbours but the drawn ones.
 */
import type { ModuleId, ResourceId } from "./modules";
import type { Tile } from "./sim";

export type NetMode = "off" | "local" | "online";

export interface PeerCity {
  id: string;
  name: string;
  pop: number;
  alt: number;
  /** "dome:1:0:2;bladder:2:0:1" — module:q:r:level */
  layout: string;
  at: number;
}

export type Wire =
  | { t: "city"; id: string; n: string; p: number; a: number; l: string }
  | { t: "hi"; id: string }
  | { t: "gift"; id: string; n: string; to: string; res: Partial<Record<ResourceId, number>> }
  | { t: "bye"; id: string };

interface Transport {
  send(msg: Wire): void;
  receive(fn: (msg: Wire) => void): void;
  close(): void;
}

const TOPIC = "venus";
const CONNECT_TIMEOUT_MS = 6000;
const SAY_EVERY_MS = 4000;
const FORGET_AFTER_MS = 16000;

function isWire(v: unknown): v is Wire {
  return !!v && typeof v === "object" && typeof (v as { t?: unknown }).t === "string" && typeof (v as { id?: unknown }).id === "string";
}

export function encodeLayout(tiles: Tile[]): string {
  return tiles.map((t) => `${t.id}:${t.q}:${t.r}:${t.level ?? 1}`).join(";");
}

const IDS = new Set<ModuleId>(["core", "dome", "bladder", "solar", "harvester", "still", "moxie", "greenhouse", "biolab", "nanofab", "jazz", "ballroom", "skyport"]);

/** Never trust a stranger's layout: known modules, small coordinates, capped. */
export function decodeLayout(s: string): Array<{ id: ModuleId; q: number; r: number; level: number }> {
  const out: Array<{ id: ModuleId; q: number; r: number; level: number }> = [];
  if (typeof s !== "string") return out;
  for (const part of s.split(";").slice(0, 100)) {
    const [id, q, r, l] = part.split(":");
    const Q = Number(q), Rr = Number(r), L = Number(l);
    if (!IDS.has(id as ModuleId) || !Number.isInteger(Q) || !Number.isInteger(Rr) || Math.abs(Q) > 6 || Math.abs(Rr) > 6) continue;
    out.push({ id: id as ModuleId, q: Q, r: Rr, level: Math.max(1, Math.min(3, Number.isFinite(L) ? Math.round(L) : 1)) });
  }
  return out;
}

async function openTransport(mode: NetMode, room: string): Promise<Transport | null> {
  if (mode === "off") return null;
  try {
    return mode === "local" ? openLocal(room) : await openOnline(room);
  } catch {
    return null;
  }
}

function openLocal(room: string): Transport | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(`venus-${room}`);
  let handler: ((msg: Wire) => void) | null = null;
  ch.onmessage = (ev: MessageEvent) => { if (handler && isWire(ev.data)) handler(ev.data); };
  return {
    send: (msg) => { try { ch.postMessage(msg); } catch { /* closed */ } },
    receive: (fn) => { handler = fn; },
    close: () => { handler = null; try { ch.close(); } catch { /* closed */ } },
  };
}

async function openOnline(room: string): Promise<Transport | null> {
  const { supabase } = await import("@/integrations/supabase/client");
  const channel = supabase.channel(`venus-${room}`, { config: { broadcast: { self: false, ack: false } } });
  let handler: ((msg: Wire) => void) | null = null;
  channel.on("broadcast", { event: TOPIC }, ({ payload }: { payload: unknown }) => { if (handler && isWire(payload)) handler(payload); });
  const ok = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    const timer = window.setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    channel.subscribe((status: string) => {
      if (status === "SUBSCRIBED") { window.clearTimeout(timer); finish(true); }
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") { window.clearTimeout(timer); finish(false); }
    });
  });
  if (!ok) { try { await supabase.removeChannel(channel); } catch { /* nothing */ } return null; }
  return {
    send: (msg) => { void channel.send({ type: "broadcast", event: TOPIC, payload: msg }); },
    receive: (fn) => { handler = fn; },
    close: () => { handler = null; void supabase.removeChannel(channel); },
  };
}

export interface SkyNet {
  readonly id: string;
  readonly connected: boolean;
  peers(): PeerCity[];
  gift(to: string, res: Partial<Record<ResourceId, number>>): void;
  close(): void;
}

export interface NetOptions {
  mode: NetMode;
  room: string;
  /** What to say about ourselves, asked for every few seconds. */
  describe(): { name: string; pop: number; alt: number; tiles: Tile[] } | null;
  onGift(from: string, res: Partial<Record<ResourceId, number>>): void;
  onChange(): void;
}

const GIFT_CAP = 200;

export function joinSky(opts: NetOptions): SkyNet {
  const id = Math.random().toString(36).slice(2, 10);
  const peers = new Map<string, PeerCity>();
  let transport: Transport | null = null;
  let connected = false;
  let closed = false;
  let timer = 0;

  const say = () => {
    const me = opts.describe();
    if (!transport || !me) return;
    transport.send({ t: "city", id, n: me.name.slice(0, 32), p: Math.round(me.pop), a: Math.round(me.alt * 10) / 10, l: encodeLayout(me.tiles) });
  };

  void openTransport(opts.mode, opts.room).then((t) => {
    if (closed) { t?.close(); return; }
    transport = t;
    connected = !!t;
    if (!t) return;
    t.receive((msg) => {
      if (msg.id === id) return;
      if (msg.t === "city") {
        const prev = peers.get(msg.id);
        peers.set(msg.id, { id: msg.id, name: String(msg.n || "A city").slice(0, 32), pop: Number(msg.p) || 0, alt: Number(msg.a) || 54, layout: String(msg.l || ""), at: Date.now() });
        if (!prev || prev.layout !== msg.l || prev.name !== msg.n) opts.onChange();
      } else if (msg.t === "hi") {
        say();
      } else if (msg.t === "gift" && msg.to === id) {
        const res: Partial<Record<ResourceId, number>> = {};
        for (const k of ["carbon", "air", "water"] as ResourceId[]) {
          const v = Number(msg.res?.[k]);
          if (Number.isFinite(v) && v > 0) res[k] = Math.min(GIFT_CAP, v);
        }
        if (Object.keys(res).length) opts.onGift(String(msg.n || "A neighbour").slice(0, 32), res);
      } else if (msg.t === "bye") {
        if (peers.delete(msg.id)) opts.onChange();
      }
    });
    t.send({ t: "hi", id });
    say();
    opts.onChange();
  });

  timer = window.setInterval(() => {
    say();
    const now = Date.now();
    let dropped = false;
    for (const [k, p] of peers) if (now - p.at > FORGET_AFTER_MS) { peers.delete(k); dropped = true; }
    if (dropped) opts.onChange();
  }, SAY_EVERY_MS);

  const onHide = () => { transport?.send({ t: "bye", id }); };
  window.addEventListener("pagehide", onHide);

  return {
    id,
    get connected() { return connected; },
    peers: () => [...peers.values()],
    gift(to, res) {
      const me = opts.describe();
      transport?.send({ t: "gift", id, n: me?.name ?? "A neighbour", to, res });
    },
    close() {
      closed = true;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", onHide);
      transport?.send({ t: "bye", id });
      transport?.close();
      transport = null;
    },
  };
}
