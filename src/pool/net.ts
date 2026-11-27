/**
 * Playing a friend online: one Supabase Realtime broadcast channel per room.
 *
 * Pool takes turns, so there is nothing to predict and nothing to fight over.
 * Only the player whose turn it is can touch the cue ball. While they line up,
 * their aim goes out ten times a second so the other side watches the cue
 * move. When they shoot, they send the table they shot from and the strike;
 * both sides run the same physics on it, so both watch the same shot. When it
 * stops, the shooter's result is the truth and the other side adopts it,
 * which papers over any rounding difference between two machines.
 *
 *  - `online` is Supabase Realtime.
 *  - `local` is a BroadcastChannel between tabs of one browser. It is how this
 *    is tested in the sandbox, where Realtime is blocked.
 */
import type { Strike } from "./physics";
import type { PoolState } from "./rules";

export type NetMode = "online" | "local";

export type Wire =
  | { t: "hi"; name: string }
  | { t: "start"; st: PoolState; names: [string, string] }
  | { t: "aim"; a: number; p: number; sx: number; sy: number; cx: number; cy: number; called: number | null }
  | { t: "shot"; from: PoolState; k: Strike }
  | { t: "rest"; st: PoolState }
  | { t: "again"; st: PoolState }
  | { t: "bye" };

export interface Transport {
  send(msg: Wire): void;
  receive(fn: (msg: Wire) => void): void;
  close(): void;
}

const CONNECT_TIMEOUT_MS = 8000;
const TOPIC = "pool";

const isWire = (m: unknown): m is Wire =>
  typeof m === "object" && m !== null && typeof (m as { t?: unknown }).t === "string";

export async function openTransport(mode: NetMode, room: string): Promise<Transport | null> {
  try {
    return mode === "local" ? openLocal(room) : await openOnline(room);
  } catch {
    return null;
  }
}

function openLocal(room: string): Transport | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(`pool-${room}`);
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
  const channel = supabase.channel(`pool-${room}`, { config: { broadcast: { self: false, ack: false } } });
  let handler: ((msg: Wire) => void) | null = null;
  channel.on("broadcast", { event: TOPIC }, ({ payload }: { payload: unknown }) => { if (handler && isWire(payload)) handler(payload); });
  const ok = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean): void => { if (!settled) { settled = true; resolve(v); } };
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

/** Four letters nobody will misread on a phone. */
export function roomCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
