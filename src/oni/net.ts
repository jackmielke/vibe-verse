/**
 * Oni's wire: who is in the square, and where.
 *
 * The same two transports as the valley (`src/magician/net.ts`): a Supabase
 * Realtime broadcast channel per room, and a BroadcastChannel for tabs of
 * one browser, which is what runs in the sandbox and what two people on one
 * laptop use. Joining is allowed to fail; you are then alone in the square.
 *
 * Presence is sent on a timer, at a rate that shrinks as the room grows
 * (`presenceHz`) so a room full of phones stays under the project's
 * Realtime message rate. Each packet carries velocity, and the receiver
 * dead-reckons from it, so four packets a second still look like running.
 */
import type { Round, Tag } from "./rules";
import { PEER_TIMEOUT_MS, presenceHz } from "./rules";

export type NetMode = "off" | "local" | "online";

export type OniWire =
  | { t: "p"; id: string; n: string; c: string; x: number; y: number; z: number; yaw: number; vx: number; vz: number; o: 0 | 1; r: string; d?: string }
  | { t: "round"; id: string; round: Round }
  | { t: "tag"; id: string; r: string; v: string; by: string; at: number }
  | { t: "hi"; id: string }
  | { t: "sync"; id: string; round: Round | null; tags: Tag[] }
  | { t: "e"; id: string; e: string }
  | { t: "bye"; id: string };

const KINDS = ["p", "round", "tag", "hi", "sync", "e", "bye"];

export function isOniWire(v: unknown): v is OniWire {
  if (!v || typeof v !== "object") return false;
  const w = v as { t?: unknown; id?: unknown };
  return typeof w.t === "string" && typeof w.id === "string" && KINDS.includes(w.t);
}

export interface Transport {
  send(msg: OniWire): void;
  receive(fn: (msg: OniWire) => void): void;
  close(): void;
}

const CONNECT_TIMEOUT_MS = 8000;
const EVENT = "o";

export async function openTransport(mode: NetMode, room: string): Promise<Transport | null> {
  if (mode === "off") return null;
  try {
    return mode === "local" ? openLocal(room) : await openOnline(room);
  } catch {
    return null;
  }
}

function openLocal(room: string): Transport | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(`oni-${room}`);
  let handler: ((msg: OniWire) => void) | null = null;
  ch.onmessage = (ev: MessageEvent) => { if (handler && isOniWire(ev.data)) handler(ev.data); };
  return {
    send: (msg) => { try { ch.postMessage(msg); } catch { /* closed */ } },
    receive: (fn) => { handler = fn; },
    close: () => { handler = null; try { ch.close(); } catch { /* closed */ } },
  };
}

async function openOnline(room: string): Promise<Transport | null> {
  const { supabase } = await import("@/integrations/supabase/client");
  const channel = supabase.channel(`oni-${room}`, { config: { broadcast: { self: false, ack: false } } });
  let handler: ((msg: OniWire) => void) | null = null;
  channel.on("broadcast", { event: EVENT }, ({ payload }: { payload: unknown }) => { if (handler && isOniWire(payload)) handler(payload); });
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
    send: (msg) => { void channel.send({ type: "broadcast", event: EVENT, payload: msg }); },
    receive: (fn) => { handler = fn; },
    close: () => { handler = null; void supabase.removeChannel(channel); },
  };
}

export function readNetMode(): NetMode {
  try {
    const q = new URLSearchParams(window.location.search).get("net");
    if (q === "off" || q === "local" || q === "online") return q;
  } catch { /* no window */ }
  return "online";
}

export const DEFAULT_ROOM = "matsuri";

export function cleanRoom(q: string | null | undefined): string {
  if (q && /^[a-z0-9-]{1,40}$/i.test(q)) return q.toLowerCase();
  return DEFAULT_ROOM;
}

export function readRoom(): string {
  try { return cleanRoom(new URLSearchParams(window.location.search).get("room")); } catch { return DEFAULT_ROOM; }
}

// ---------------------------------------------------------------------------
// The room: a peer table on top of a transport
// ---------------------------------------------------------------------------

export interface Peer {
  id: string;
  name: string;
  char: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  oni: boolean;
  round: string;
  /** performance.now() when last heard. */
  at: number;
  /** A stable one-way tag of their device (`d`), so a block outlives their tab. Older pages omit it. */
  device?: string;
}

export type Presence = Omit<Extract<OniWire, { t: "p" }>, "t" | "id">;

export interface OniRoom {
  id: string;
  connected: boolean;
  send(msg: OniWire): void;
  /** Our latest presence; sent on the room's timer. Null for a watcher, who is not a player. */
  setPresence(p: Presence | null): void;
  /** Send presence now (a tag, a jump) instead of waiting for the timer. */
  flush(): void;
  peers(): Peer[];
  close(): void;
}

export interface RoomOptions {
  mode: NetMode;
  room: string;
  id?: string;
  /** Stable device tag sent with presence as `d`; optional, so older pages still read it. */
  device?: string;
  onMessage(msg: OniWire): void;
  onPeers(peers: Peer[]): void;
  onJoin?(peer: Peer): void;
  onLeave?(peer: Peer): void;
}

export async function joinOniRoom(opts: RoomOptions): Promise<OniRoom> {
  const id = opts.id ?? Math.random().toString(36).slice(2, 10);
  const peers = new Map<string, Peer>();
  let transport: Transport | null = null;
  let closed = false;
  let latest: Presence | null = null;
  let lastSent = 0;
  const list = () => [...peers.values()];

  const sendPresence = () => {
    if (!transport || !latest) return;
    transport.send({ t: "p", id, ...latest, ...(opts.device ? { d: opts.device } : {}) });
    lastSent = performance.now();
  };

  const room: OniRoom = {
    id,
    connected: false,
    send(msg) { transport?.send(msg); },
    setPresence(p) { latest = p; },
    flush: sendPresence,
    peers: list,
    close() {
      closed = true;
      if (timer !== null) { clearInterval(timer); timer = null; }
      transport?.send({ t: "bye", id });
      transport?.close();
      transport = null;
    },
  };

  // One timer at 20 Hz decides whether it is time to send, so the rate can
  // follow the room's size without restarting anything.
  let timer: number | null = null;
  const tick = () => {
    const now = performance.now();
    const hz = presenceHz(peers.size + 1);
    if (latest && now - lastSent >= 1000 / hz) sendPresence();
    for (const [pid, peer] of peers) {
      if (now - peer.at > PEER_TIMEOUT_MS) { peers.delete(pid); opts.onLeave?.(peer); opts.onPeers(list()); }
    }
  };

  transport = await openTransport(opts.mode, opts.room);
  if (!transport || closed) { transport?.close(); transport = null; return room; }
  room.connected = true;
  transport.receive((msg) => {
    if (msg.id === id) return;
    if (msg.t === "p") {
      const known = peers.get(msg.id);
      const peer: Peer = { id: msg.id, name: String(msg.n).slice(0, 20), char: String(msg.c), x: +msg.x || 0, y: +msg.y || 0, z: +msg.z || 0, yaw: +msg.yaw || 0, vx: +msg.vx || 0, vz: +msg.vz || 0, oni: msg.o === 1, round: String(msg.r ?? ""), at: performance.now(), device: typeof msg.d === "string" ? msg.d.slice(0, 40) : undefined };
      peers.set(msg.id, peer);
      if (!known) { opts.onJoin?.(peer); opts.onPeers(list()); }
      else if (known.char !== peer.char || known.name !== peer.name) opts.onPeers(list());
    } else if (msg.t === "bye") {
      const p = peers.get(msg.id);
      if (p) { peers.delete(msg.id); opts.onLeave?.(p); opts.onPeers(list()); }
    }
    opts.onMessage(msg);
  });
  transport.send({ t: "hi", id });
  timer = window.setInterval(tick, 50);
  return room;
}
