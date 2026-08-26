/**
 * protocol.ts — what one player in San Francisco tells the others.
 *
 * Deliberately tiny and deliberately dumb. Every message is a complete
 * statement of where somebody is, so there is no ordering requirement, no
 * delta chain to resynchronise and nothing to recover after a dropped packet:
 * miss one and the next one, an eighth of a second later, is already the whole
 * truth. That is worth far more here than bandwidth, because the transport is
 * a shared WebSocket over the public internet and the failure mode we actually
 * see is "three seconds of nothing, then a burst", not "steady 2% loss".
 *
 * The state message doubles as the heartbeat. A peer is present because it is
 * still talking; nobody has to announce anything, and a browser tab that is
 * closed, crashed, backgrounded or driven into a tunnel all look the same and
 * are all handled the same way — see `PEER_TIMEOUT_MS`.
 *
 * Nothing in this file imports three, React or Supabase. That is what lets the
 * whole protocol be exercised over an in-process loopback in a unit test, which
 * is the only way any of it gets verified in an environment with no network —
 * the same trade `blob/net` made, for the same reason.
 */

/** How often each client states its position. */
export const SEND_HZ = 9;
export const SEND_INTERVAL_MS = 1000 / SEND_HZ;

/**
 * How far behind live we render other players.
 *
 * Interpolating *between* two received samples rather than extrapolating past
 * the newest one is what makes a remote body move smoothly instead of
 * stuttering and correcting. The cost is that everyone else is this far in the
 * past, which at a tenth of a second nobody can perceive in a game with no
 * shooting in it. Slightly more than one send interval, so an ordinary gap
 * between packets is always covered by real data.
 */
export const INTERP_DELAY_MS = 140;

/**
 * Drop a peer that has said nothing for this long.
 *
 * Long enough to ride out a backgrounded tab throttling its timers and a phone
 * changing cells; short enough that somebody who closed the tab is gone before
 * you walk over to say hello to a statue.
 */
export const PEER_TIMEOUT_MS = 6000;

/** Hard ceiling on rendered peers, newest-seen first. */
export const MAX_PEERS = 48;

/** What a body is doing, so the receiver can pick a gait without a physics sim. */
export const MOTION_IDLE = 0;
export const MOTION_WALK = 1;
export const MOTION_RUN = 2;
export type Motion = typeof MOTION_IDLE | typeof MOTION_WALK | typeof MOTION_RUN;

/**
 * One player's whole state.
 *
 * Single letters because this goes out nine times a second per player and
 * these names appear in every packet; the decode side names them properly
 * immediately, and nothing outside this file and `peers.ts` sees a `k`.
 */
export interface StateMsg {
  t: "s";
  /** Sender id. Stable for the lifetime of the tab. */
  i: string;
  /** Display name, already resolved by `useVibeIdentity`. */
  n: string;
  /** Character id from `@/lib/characters`. */
  c: string;
  /** Position, centimetre-rounded. */
  p: [number, number, number];
  /** Yaw, radians. */
  a: number;
  /** Gait. */
  m: Motion;
  /** Vehicle kind when driving, absent on foot. */
  v?: string;
}

/** A clean goodbye, so nobody waits out the timeout for somebody who left. */
export interface ByeMsg {
  t: "q";
  i: string;
}

export type Wire = StateMsg | ByeMsg;

/** Transport contract. Two implementations: Supabase Realtime, and a
 *  same-machine BroadcastChannel. Neither is allowed to echo to the sender. */
export interface NetTransport {
  send(msg: Wire): void;
  receive(fn: (msg: Wire) => void): void;
  close(): void;
}

/**
 * How high a driven car's physics origin sits above the road.
 *
 * `p[1]` on the wire always means *the ground under this player*, never "where
 * their body happens to be" — the sender knows whether it is a capsule centre
 * or a vehicle chassis and corrects before sending, so the receiver can place
 * one group and have both a rig (feet at its own zero) and the kerbside car
 * prop (origin at road level) land correctly in it.
 *
 * Getting this wrong is invisible to the person driving and obvious to
 * everybody else, which is the worst way for a bug to be distributed.
 */
export const CAR_ORIGIN_Y = 0.55;

/** Round to centimetres. A millimetre of precision on a 9 km city is noise. */
export function cm(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Is this a message we can act on?
 *
 * The wire is public — anybody can join a Supabase Realtime channel and post
 * whatever shape they like — so nothing downstream may assume a field exists
 * or is the right type. A malformed message is dropped silently rather than
 * throwing inside a frame callback and taking the render loop with it.
 */
export function isWire(v: unknown): v is Wire {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  if (typeof m.i !== "string" || m.i.length === 0 || m.i.length > 64) return false;
  if (m.t === "q") return true;
  if (m.t !== "s") return false;
  if (typeof m.n !== "string" || typeof m.c !== "string") return false;
  if (!Array.isArray(m.p) || m.p.length !== 3) return false;
  for (const n of m.p) if (typeof n !== "number" || !Number.isFinite(n)) return false;
  if (typeof m.a !== "number" || !Number.isFinite(m.a)) return false;
  if (typeof m.m !== "number") return false;
  if (m.v !== undefined && typeof m.v !== "string") return false;
  return true;
}

/** Trim a name to something that fits over a head and cannot be a paragraph. */
export function cleanName(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return (s.length > 18 ? `${s.slice(0, 17)}…` : s) || "Someone";
}
