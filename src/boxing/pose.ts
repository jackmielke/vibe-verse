/**
 * Turning a body into boxing inputs.
 *
 * Everything here is pure: it takes pose landmarks (MediaPipe's 33-point
 * body, normalised to the camera image) one frame at a time and says what the
 * player is doing with them. That is so the part that decides "was that a
 * punch?" runs in node with synthetic arms, because the sandbox has no person
 * in front of its camera.
 *
 * Coordinates: the camera image is shown mirrored, like a mirror, so the
 * player's left hand is on the left of the screen. `sx = 1 - x` is that
 * mirrored x, and every "L" and "R" below is screen left and screen right.
 * Distances are measured in shoulder widths, so standing closer to the phone
 * or further away does not change how hard a punch has to be.
 */

export interface Landmark { x: number; y: number; z: number; visibility?: number }

export type Hand = "L" | "R";
export type PunchKind = "jab" | "hook" | "uppercut";

export interface PunchEvent {
  hand: Hand;
  kind: PunchKind;
  /** 0..1, from how fast the fist was moving. */
  power: number;
  /** Where the fist was, mirrored screen space 0..1. */
  sx: number;
  sy: number;
}

export interface BodyRead {
  /** A body is in the frame and the shoulders are visible. */
  present: boolean;
  /** Both fists up by the face. */
  guard: boolean;
  /** Head offset from where the player usually stands, in shoulder widths. Negative is screen left. */
  lean: number;
  /** Fists in mirrored screen space, for drawing gloves on them. */
  fists: { L: { sx: number; sy: number; seen: boolean }; R: { sx: number; sy: number; seen: boolean } };
  /** Head in mirrored screen space. */
  head: { sx: number; sy: number };
  shoulderWidth: number;
  punches: PunchEvent[];
}

// landmark indices
const NOSE = 0;
const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_WRIST = 15;
const R_WRIST = 16;

/** Tunables, exported so a test can read them rather than guess. */
export const TUNING = {
  /** How far back the speed is measured. */
  windowMs: 110,
  /** Fist speed, in shoulder widths per second, that counts as a punch. */
  punchSpeed: 3.2,
  /** Speed that counts as a full-power punch. */
  fullSpeed: 9,
  /** A hand cannot throw again until it has slowed below this... */
  rearmSpeed: 1.4,
  /** ...and at least this long has passed. */
  cooldownMs: 260,
  /** Fists above the shoulders and this close to the nose, sideways, is a guard. */
  guardReach: 0.95,
  /** How quickly "where you usually stand" follows you, per second. */
  recentre: 0.35,
  minVisibility: 0.45,
};

interface Sample { t: number; x: number; y: number; z: number }

interface HandState {
  hist: Sample[];
  armed: boolean;
  last: number;
}

export class BodyReader {
  private hands: Record<Hand, HandState> = {
    L: { hist: [], armed: true, last: -1e9 },
    R: { hist: [], armed: true, last: -1e9 },
  };
  private centre: number | null = null;
  private lastT = 0;
  /**
   * An uppercut that is only "rising" waits a moment: both fists rising
   * together is somebody putting their guard up, not a double uppercut.
   */
  private pending: Partial<Record<Hand, { ev: PunchEvent; t: number }>> = {};

  reset(): void {
    this.pending = {};
    this.hands.L = { hist: [], armed: true, last: -1e9 };
    this.hands.R = { hist: [], armed: true, last: -1e9 };
    this.centre = null;
  }

  /** Where the player stands now becomes the middle. */
  recentre(): void { this.centre = null; }

  read(lm: Landmark[] | null | undefined, tMs: number): BodyRead {
    const empty: BodyRead = {
      present: false, guard: false, lean: 0,
      fists: { L: { sx: 0.3, sy: 0.8, seen: false }, R: { sx: 0.7, sy: 0.8, seen: false } },
      head: { sx: 0.5, sy: 0.3 }, shoulderWidth: 0, punches: [],
    };
    const dt = Math.max(0, Math.min(0.25, (tMs - this.lastT) / 1000));
    this.lastT = tMs;
    if (!lm || lm.length < 17) return empty;
    const vis = (i: number) => (lm[i].visibility ?? 1) >= TUNING.minVisibility;
    if (!vis(L_SHOULDER) || !vis(R_SHOULDER)) return empty;

    const sx = (i: number) => 1 - lm[i].x;
    // Shoulder width in image units. Floor it so a side-on body cannot divide by ~0.
    const sw = Math.max(0.06, Math.hypot(sx(L_SHOULDER) - sx(R_SHOULDER), lm[L_SHOULDER].y - lm[R_SHOULDER].y));
    const midX = (sx(L_SHOULDER) + sx(R_SHOULDER)) / 2;
    const midY = (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2;
    const noseX = vis(NOSE) ? sx(NOSE) : midX;
    const noseY = vis(NOSE) ? lm[NOSE].y : midY - sw * 0.7;

    // The player's own left wrist is landmark 15, and mirrored it sits on screen left.
    const wrist: Record<Hand, number> = { L: L_WRIST, R: R_WRIST };
    const shoulder: Record<Hand, number> = { L: L_SHOULDER, R: R_SHOULDER };

    const out: BodyRead = {
      present: true,
      guard: false,
      lean: 0,
      fists: {
        L: { sx: sx(L_WRIST), sy: lm[L_WRIST].y, seen: vis(L_WRIST) },
        R: { sx: sx(R_WRIST), sy: lm[R_WRIST].y, seen: vis(R_WRIST) },
      },
      head: { sx: noseX, sy: noseY },
      shoulderWidth: sw,
      punches: [],
    };

    // Lean: the head against where this player usually stands. The centre
    // follows slowly, so walking a step sideways re-zeroes within a few seconds
    // but a quick slip does not.
    if (this.centre === null) this.centre = noseX;
    out.lean = (noseX - this.centre) / sw;
    if (Math.abs(out.lean) < 0.6) this.centre += (noseX - this.centre) * Math.min(1, TUNING.recentre * dt);

    // Guard: both fists up, near the face.
    const up = (h: Hand) => out.fists[h].seen && lm[wrist[h]].y < midY + sw * 0.15 && Math.abs(out.fists[h].sx - noseX) < sw * TUNING.guardReach;
    out.guard = up("L") && up("R");

    for (const h of ["L", "R"] as Hand[]) {
      const st = this.hands[h];
      if (!out.fists[h].seen) { st.hist.length = 0; continue; }
      // Body-relative, in shoulder widths, so a player walking does not "punch".
      const s: Sample = {
        t: tMs,
        x: (out.fists[h].sx - midX) / sw,
        y: (lm[wrist[h]].y - midY) / sw,
        z: lm[wrist[h]].z / sw,
      };
      st.hist.push(s);
      while (st.hist.length > 2 && tMs - st.hist[0].t > TUNING.windowMs) st.hist.shift();
      const a = st.hist[0];
      const span = (s.t - a.t) / 1000;
      if (span < 0.03) continue;
      const dx = s.x - a.x, dy = s.y - a.y;
      // MediaPipe's z is noisy; it helps with a punch straight at the lens,
      // which barely moves in x and y, so it counts at half weight.
      const dz = s.z - a.z;
      const speed = Math.hypot(dx, dy, dz * 0.5) / span;

      if (!st.armed && speed < TUNING.rearmSpeed) st.armed = true;
      if (!st.armed || speed < TUNING.punchSpeed || tMs - st.last < TUNING.cooldownMs) continue;

      // A punch goes out. Pulling the fist back in is just as fast and is not
      // a punch, so the fist has to be getting further from its own shoulder
      // or closer to the camera.
      const shX = (sx(shoulder[h]) - midX) / sw, shY = (lm[shoulder[h]].y - midY) / sw;
      const reachNow = Math.hypot(s.x - shX, s.y - shY);
      const reachThen = Math.hypot(a.x - shX, a.y - shY);
      // A fist driving upward fast is an uppercut, which travels toward the
      // shoulder rather than away from it, so it counts as going out too.
      const rising = -dy > 0.25 && -dy > Math.abs(dx);
      const outward = reachNow - reachThen > 0.12 || dz < -0.25 || rising;
      // Below the belt does not count, and neither does dropping your arms.
      const high = s.y < 1.6 && dy < 0.6 * Math.hypot(dx, dy) + 0.05;
      if (!outward || !high) continue;

      let kind: PunchKind = "jab";
      if (rising && -dy > Math.abs(dx) * 1.2) kind = "uppercut";
      else if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.sign(dx) === (h === "L" ? 1 : -1) && Math.abs(dx) > 0.45) kind = "hook";

      const power = Math.max(0.15, Math.min(1, (speed - TUNING.punchSpeed) / (TUNING.fullSpeed - TUNING.punchSpeed) * 0.85 + 0.15));
      const ev: PunchEvent = { hand: h, kind, power, sx: out.fists[h].sx, sy: lm[wrist[h]].y };
      const onlyRising = rising && !(reachNow - reachThen > 0.12 || dz < -0.25);
      if (onlyRising) this.pending[h] = { ev, t: tMs };
      else out.punches.push(ev);
      st.armed = false;
      st.last = tMs;
    }

    const pl = this.pending.L, pr = this.pending.R;
    if (pl && pr) {
      // both at once: a guard going up
      this.pending = {};
    } else {
      for (const h of ["L", "R"] as Hand[]) {
        const p = this.pending[h];
        if (p && tMs - p.t >= 90) { out.punches.push(p.ev); delete this.pending[h]; }
      }
    }
    return out;
  }
}
