/**
 * Playing in the valley together.
 *
 * The fifth netcode in this repository, and the simplest, because the world
 * is already data: everything Vibey changes is a `Patch`, so a shared valley
 * is nothing more than every patch broadcast to everybody in the room. Say
 * "make it rain" and it rains for all of you. The other players are ghosts
 * that walk around in it.
 *
 * Two transports behind one interface, the same shape as `src/sf/net`:
 *  - `online` is a Supabase Realtime broadcast channel, one per room
 *  - `local` is a BroadcastChannel: every tab of one browser, no server,
 *    and the only half of this that runs in the sandbox
 *
 * Joining is allowed to fail. No room, no peers, and the valley is exactly
 * what it was.
 *
 * Wire: `{t:"p"}` presence at eight hertz (position, yaw, body); `{t:"s"}`
 * a patch; `{t:"hi"}` a newcomer asking; `{t:"full"}` someone answering
 * with the whole state. Nobody is the host: the first `full` a newcomer
 * hears wins, which is fine for a world whose worst inconsistency is that
 * one person's rain arrives a second late.
 */
import type { Patch, WorldState } from "./state";

export type NetMode = "off" | "local" | "online";

export interface PeerPresence {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  body: string;
  /** Last heard, ms. */
  at: number;
  /** Whether they were talking (their voice session live). */
  talking: boolean;
}

export type Wire =
  | { t: "p"; id: string; n: string; x: number; y: number; z: number; yaw: number; b: string; v: boolean }
  | { t: "s"; id: string; patch: Patch }
  | { t: "hi"; id: string }
  | { t: "full"; id: string; to: string; state: WorldState }
  | { t: "bye"; id: string };

export function isWire(v: unknown): v is Wire {
  if (!v || typeof v !== "object") return false;
  const w = v as { t?: unknown; id?: unknown };
  return typeof w.t === "string" && typeof w.id === "string" && ["p", "s", "hi", "full", "bye"].includes(w.t);
}

export interface Transport {
  send(msg: Wire): void;
  receive(fn: (msg: Wire) => void): void;
  close(): void;
}

const CONNECT_TIMEOUT_MS = 8000;
const TOPIC = "m";

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
  const ch = new BroadcastChannel(`magician-${room}`);
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
  const channel = supabase.channel(`magician-${room}`, { config: { broadcast: { self: false, ack: false } } });
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

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

export interface RoomOptions {
  mode: NetMode;
  room: string;
  name: string;
  /** Our id; random per tab. */
  id?: string;
  /** Called with a patch somebody else made. Apply it without re-broadcasting. */
  onPatch(patch: Patch): void;
  /** Somebody answered our hello with the whole world. */
  onFull(state: WorldState): void;
  /** Peer table changed. */
  onPeers(peers: PeerPresence[]): void;
  /** Somebody joined or left, for the toast. */
  onJoin?(name: string): void;
  onLeave?(name: string): void;
  /** Answer a newcomer: the whole current state. */
  currentState(): WorldState;
}

export interface Room {
  id: string;
  connected: boolean;
  /** Broadcast a patch we made. */
  patch(p: Patch): void;
  /** Send our presence. Call from the frame loop; it rate-limits itself. */
  presence(x: number, y: number, z: number, yaw: number, body: string, talking: boolean): void;
  peers(): PeerPresence[];
  close(): void;
}

export const PEER_TIMEOUT_MS = 6000;
const PRESENCE_INTERVAL_MS = 125;

export function readNetMode(): NetMode {
  try {
    const q = new URLSearchParams(window.location.search).get("net");
    if (q === "off" || q === "local" || q === "online") return q;
  } catch { /* no window */ }
  return "online";
}

export function readRoom(): string {
  try {
    const q = new URLSearchParams(window.location.search).get("room");
    if (q && /^[a-z0-9-]{1,40}$/i.test(q)) return q.toLowerCase();
  } catch { /* no window */ }
  return "hoshimura";
}

export async function joinRoom(opts: RoomOptions): Promise<Room> {
  const id = opts.id ?? Math.random().toString(36).slice(2, 10);
  const peers = new Map<string, PeerPresence>();
  let transport: Transport | null = null;
  let closed = false;
  const list = () => [...peers.values()];
  // The latest presence, sent on a timer rather than from the frame loop: a
  // background tab stops rendering but keeps (slow) timers, so two tabs on
  // one laptop do not lose each other the moment one is not in front.
  let latest: Wire | null = null;
  let dirty = false;
  const pump = () => {
    if (!transport) return;
    if (latest && dirty) { transport.send(latest); dirty = false; }
    const now = performance.now();
    for (const [pid, peer] of peers) {
      if (now - peer.at > PEER_TIMEOUT_MS) { peers.delete(pid); opts.onLeave?.(peer.name); opts.onPeers(list()); }
    }
  };
  let pumpTimer: number | null = null;

  const room: Room = {
    id,
    connected: false,
    patch(p) { transport?.send({ t: "s", id, patch: p }); },
    presence(x, y, z, yaw, body, talking) {
      latest = { t: "p", id, n: opts.name, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), yaw: +yaw.toFixed(3), b: body, v: talking };
      dirty = true;
    },
    peers: list,
    close() {
      closed = true;
      if (pumpTimer !== null) { clearInterval(pumpTimer); pumpTimer = null; }
      transport?.send({ t: "bye", id });
      transport?.close();
      transport = null;
    },
  };

  transport = await openTransport(opts.mode, opts.room);
  if (!transport || closed) { transport?.close(); return room; }
  room.connected = true;
  let gotFull = false;
  transport.receive((msg) => {
    if (msg.id === id) return;
    switch (msg.t) {
      case "p": {
        const known = peers.get(msg.id);
        peers.set(msg.id, { id: msg.id, name: msg.n, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, body: msg.b, at: performance.now(), talking: msg.v });
        if (!known) { opts.onJoin?.(msg.n); opts.onPeers(list()); }
        break;
      }
      case "s":
        opts.onPatch(msg.patch);
        break;
      case "hi":
        transport?.send({ t: "full", id, to: msg.id, state: opts.currentState() });
        break;
      case "full":
        if (msg.to === id && !gotFull) { gotFull = true; opts.onFull(msg.state); }
        break;
      case "bye": {
        const p = peers.get(msg.id);
        if (p) { peers.delete(msg.id); opts.onLeave?.(p.name); opts.onPeers(list()); }
        break;
      }
    }
  });
  transport.send({ t: "hi", id });
  pumpTimer = window.setInterval(pump, PRESENCE_INTERVAL_MS);
  // A quiet tab still says hello every so often, so it is not swept.
  const keepAlive = window.setInterval(() => { if (transport && latest) transport.send(latest); }, 2000);
  const origClose = room.close;
  room.close = () => { clearInterval(keepAlive); origClose(); };
  return room;
}
