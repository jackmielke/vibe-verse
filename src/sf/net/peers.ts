/**
 * peers.ts — everybody else, smoothed.
 *
 * Nine updates a second is not enough to move a body with. Played back raw, a
 * remote player teleports nine times a second; played back with the newest
 * sample extrapolated forward, they overshoot every time somebody stops and
 * then snap back. So each peer keeps a short buffer of timestamped samples and
 * is rendered `INTERP_DELAY_MS` behind live, *between* two samples that have
 * actually arrived. Everyone else is a tenth of a second in the past and it is
 * invisible, which is the whole trick.
 *
 * Three things here are less obvious than they look and each is covered by a
 * test in `net.test.ts`:
 *
 *  • **Yaw is an angle, not a number.** Interpolating 179° → −179° the naive
 *    way spins the body 358° the wrong way. Every blend goes through the
 *    shortest arc.
 *  • **Time is the transport's, not the sender's.** Samples are stamped on
 *    arrival, so a peer with a wrong clock, a different timezone or a
 *    mid-session NTP correction cannot push their body into next week.
 *  • **A gap is not a licence to extrapolate.** When the buffer runs dry the
 *    body holds at the newest sample. Somebody whose tab froze should stand
 *    still and then vanish, not glide serenely through the Transamerica.
 */
import {
  INTERP_DELAY_MS,
  MAX_PEERS,
  MOTION_IDLE,
  PEER_TIMEOUT_MS,
  cleanName,
  type Motion,
  type StateMsg,
  type Wire,
} from "./protocol";

/** One received state, stamped when it arrived here. */
interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  motion: Motion;
  vehicle: string | null;
}

/** What the renderer needs to draw one peer this frame. */
export interface PeerPose {
  id: string;
  name: string;
  char: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  motion: Motion;
  vehicle: string | null;
}

/** Keep a little more than the interpolation window; the rest is dead weight. */
const MAX_SAMPLES = 12;

/**
 * A jump further than this is a teleport, not travel, and is cut rather than
 * interpolated.
 *
 * Nine samples a second means even a car at 40 m/s moves about four metres
 * between them, and a full second of packet loss moves it forty. Sixty is
 * comfortably past anything real and comfortably short of a fast-travel hop.
 * Without this, somebody using the Go menu skis smoothly across San Francisco
 * for everybody else — through the buildings — for as long as the
 * interpolation takes to eat the gap.
 */
const TELEPORT_M = 60;

export class Peer {
  readonly id: string;
  name = "Someone";
  char = "vibey";
  /** Arrival time of the newest sample, for the timeout sweep. */
  lastSeen = 0;
  private buf: Sample[] = [];

  constructor(id: string) {
    this.id = id;
  }

  /** Fold in a state message that arrived at `now`. */
  apply(msg: StateMsg, now: number): void {
    this.name = cleanName(msg.n);
    this.char = msg.c;
    this.lastSeen = now;

    // Out of order or duplicated: the transport gives no ordering guarantee,
    // and a sample older than one we already hold can only make the playback
    // worse. Dropping it is correct — the next one is a whole truth anyway.
    const newest = this.buf[this.buf.length - 1];
    if (newest && now <= newest.t) return;

    // Teleport: drop the history so the body cuts to the new place instead of
    // being interpolated through everything in between.
    if (newest) {
      const dx = msg.p[0] - newest.x;
      const dy = msg.p[1] - newest.y;
      const dz = msg.p[2] - newest.z;
      if (dx * dx + dy * dy + dz * dz > TELEPORT_M * TELEPORT_M) this.buf.length = 0;
    }

    this.buf.push({
      t: now,
      x: msg.p[0],
      y: msg.p[1],
      z: msg.p[2],
      yaw: msg.a,
      motion: msg.m,
      vehicle: msg.v ?? null,
    });
    if (this.buf.length > MAX_SAMPLES) this.buf.splice(0, this.buf.length - MAX_SAMPLES);
  }

  /** True once there is anything at all to draw. */
  get ready(): boolean {
    return this.buf.length > 0;
  }

  /**
   * Where this peer is, as far as we are willing to claim, at wall-clock `now`.
   *
   * Returns null before the first sample lands. Never extrapolates: outside
   * the buffered range the nearest end is held.
   */
  sample(now: number, out: PeerPose): PeerPose | null {
    const buf = this.buf;
    if (buf.length === 0) return null;

    out.id = this.id;
    out.name = this.name;
    out.char = this.char;

    const target = now - INTERP_DELAY_MS;

    // Before the buffer: the peer only just appeared. Hold the oldest rather
    // than run the body backwards to meet it.
    const oldest = buf[0];
    if (target <= oldest.t) {
      copy(oldest, out);
      return out;
    }
    // After the buffer: they have gone quiet. Hold, do not glide.
    const newest = buf[buf.length - 1];
    if (target >= newest.t) {
      copy(newest, out);
      // A body that has stopped receiving updates has also stopped walking;
      // leaving the last gait running gives a moonwalk on the spot.
      if (now - newest.t > INTERP_DELAY_MS * 2) out.motion = MOTION_IDLE;
      return out;
    }

    // Between two real samples: the good case, and the common one.
    for (let i = buf.length - 1; i > 0; i--) {
      const b = buf[i];
      const a = buf[i - 1];
      if (target >= a.t && target <= b.t) {
        const span = b.t - a.t;
        const k = span > 1e-6 ? (target - a.t) / span : 0;
        out.x = a.x + (b.x - a.x) * k;
        out.y = a.y + (b.y - a.y) * k;
        out.z = a.z + (b.z - a.z) * k;
        out.yaw = lerpAngle(a.yaw, b.yaw, k);
        // Discrete facts take the newer of the two rather than a blend: there
        // is no halfway between walking and driving.
        out.motion = k > 0.5 ? b.motion : a.motion;
        out.vehicle = k > 0.5 ? b.vehicle : a.vehicle;
        return out;
      }
    }
    copy(newest, out);
    return out;
  }

  /** Drop buffered history, keeping identity — used when a peer teleports. */
  clearHistory(): void {
    this.buf.length = 0;
  }
}

function copy(s: Sample, out: PeerPose): void {
  out.x = s.x;
  out.y = s.y;
  out.z = s.z;
  out.yaw = s.yaw;
  out.motion = s.motion;
  out.vehicle = s.vehicle;
}

/** Blend two angles along the shortest arc. */
export function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * Everybody else in the city.
 *
 * Owns nothing renderable — it is a table of poses. The React layer reads it
 * every frame and reconciles meshes against it, which keeps all the three.js
 * lifetime handling in one place and all the netcode in this one.
 */
export class PeerTable {
  private peers = new Map<string, Peer>();
  /** Our own id, so our own broadcast is ignored if a transport echoes it. */
  selfId = "";
  private scratch: PeerPose = {
    id: "",
    name: "",
    char: "",
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    motion: MOTION_IDLE,
    vehicle: null,
  };

  get size(): number {
    return this.peers.size;
  }

  /** Handle one inbound message. `now` is the arrival time, in ms. */
  ingest(msg: Wire, now: number): void {
    // A transport that echoes our own traffic would otherwise give us a ghost
    // of ourselves, permanently a tenth of a second behind and standing in our
    // own body. Both transports are configured not to, and this is the belt.
    if (msg.i === this.selfId) return;

    if (msg.t === "q") {
      this.peers.delete(msg.i);
      return;
    }

    let p = this.peers.get(msg.i);
    if (!p) {
      // Full is full. Dropping the *newcomer* rather than evicting somebody
      // established keeps the population stable instead of churning.
      if (this.peers.size >= MAX_PEERS) return;
      p = new Peer(msg.i);
      this.peers.set(msg.i, p);
    }
    p.apply(msg, now);
  }

  /** Forget anybody who has gone quiet. Returns the ids dropped. */
  prune(now: number, dropped: string[] = []): string[] {
    dropped.length = 0;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > PEER_TIMEOUT_MS) {
        this.peers.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  /** Visit every peer that has something to draw, at wall-clock `now`. */
  forEach(now: number, fn: (pose: PeerPose) => void): void {
    for (const p of this.peers) {
      const pose = p[1].sample(now, this.scratch);
      if (pose) fn(pose);
    }
  }

  /** Names of everybody present, for the roster. */
  names(): string[] {
    const out: string[] = [];
    for (const [, p] of this.peers) if (p.ready) out.push(p.name);
    return out;
  }

  clear(): void {
    this.peers.clear();
  }
}
