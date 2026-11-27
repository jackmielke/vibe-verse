/**
 * The table, the balls and the cloth. Pure: no DOM, no clock, no randomness.
 *
 * Units are metres and seconds. The table is a seven foot bar box, the size
 * most 8-ball is played on, centred on the origin with x along its length and
 * y across it, z up out of the cloth.
 *
 * What makes it feel like pool rather than air hockey is that every ball
 * carries a full 3D spin, and the cloth turns slip into roll:
 *
 *  - A ball whose contact point is skidding over the cloth (just struck, or
 *    just stopped dead by a collision) feels sliding friction, which both slows
 *    it and spins it up toward natural roll. That is where stun, draw and
 *    follow come from: nothing scripts them. A centre-ball hit on a straight
 *    shot stops the cue ball dead because the collision takes its velocity and
 *    leaves its (zero) spin; a low hit leaves backspin that the cloth turns
 *    into a draw back.
 *  - A ball that is rolling feels only the much smaller rolling resistance.
 *  - Spin about the vertical axis (side, "english") decays on its own and
 *    grips the cushion, so it changes the angle a ball comes off a rail.
 *
 * The simulation steps at a fixed 1/1000 s so a break (seven metres a second
 * into a tight rack) never tunnels and every client steps the same way.
 */

export const R = 0.028575; // 2 1/4 inch ball
export const L = 1.98; // playing length
export const W = 0.99; // playing width
export const G = 9.81;

const MU_SLIDE = 0.2;
const MU_ROLL = 0.0125;
const SPIN_DECAY = 22; // rad/s² of side spin lost to the cloth
const E_BALL = 0.94;
const MU_CUSHION = 0.14;
export const DT = 1 / 1000;
const INV_I = 2.5 / (R * R); // 1 / (2/5 m R²), per unit mass

/** Where the corner and side pocket openings begin, along each rail. */
export const CORNER_MOUTH = 0.084;
export const SIDE_MOUTH = 0.064;

export interface Ball {
  id: number; // 0 is the cue ball, 8 is the eight
  x: number;
  y: number;
  vx: number;
  vy: number;
  wx: number;
  wy: number;
  wz: number;
  /** Orientation, a unit quaternion [w, x, y, z]: only drawing cares. */
  q: [number, number, number, number];
  /** On the table. A potted ball has `on` false and `pocket` set. */
  on: boolean;
  pocket: number;
}

export interface Pocket {
  /** Where a ball drops: once its centre is this close it is gone. */
  x: number;
  y: number;
  r: number;
  /** Where the mouth is, for aiming and for drawing the hole. */
  mx: number;
  my: number;
  corner: boolean;
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export type SimEvent =
  | { type: "hit"; a: number; b: number; speed: number }
  | { type: "rail"; ball: number; speed: number }
  | { type: "pot"; ball: number; pocket: number; speed: number };

/* ----------------------------------------------------------------- the box */

const hx = L / 2;
const hy = W / 2;

export const POCKETS: Pocket[] = (() => {
  const p: Pocket[] = [];
  for (const sy of [1, -1]) {
    for (const sx of [-1, 1]) {
      p.push({
        x: sx * (hx + 0.012), y: sy * (hy + 0.012), r: 0.06,
        mx: sx * (hx - 0.012), my: sy * (hy - 0.012), corner: true,
      });
    }
    p.push({ x: 0, y: sy * (hy + 0.03), r: 0.058, mx: 0, my: sy * (hy - 0.004), corner: false });
  }
  // Order: 0 top-left, 1 top-right, 2 top-side, 3 bottom-left, 4 bottom-right, 5 bottom-side.
  return p;
})();

/**
 * The cushion noses and the pocket jaws, as segments. A ball's centre may not
 * come within R of any of them. The ends of the long segments are the points
 * of the jaws, which is what rattles a ball that is cut too thin.
 */
export const CUSHIONS: Segment[] = (() => {
  const s: Segment[] = [];
  const J = 0.05; // jaw length
  for (const sy of [1, -1]) {
    const y = sy * hy;
    // Long rails, either side of the side pocket.
    s.push({ ax: -hx + CORNER_MOUTH, ay: y, bx: -SIDE_MOUTH, by: y });
    s.push({ ax: SIDE_MOUTH, ay: y, bx: hx - CORNER_MOUTH, by: y });
    // Corner jaws on the long rails, angled in toward the pocket.
    for (const sx of [-1, 1]) {
      const x0 = sx * (hx - CORNER_MOUTH);
      s.push({ ax: x0, ay: y, bx: x0 + sx * J * 0.8, by: y + sy * J * 0.6 });
    }
    // Side pocket jaws, nearly square.
    for (const sx of [-1, 1]) {
      const x0 = sx * SIDE_MOUTH;
      s.push({ ax: x0, ay: y, bx: x0 - sx * 0.012, by: y + sy * J });
    }
  }
  for (const sx of [1, -1]) {
    const x = sx * hx;
    s.push({ ax: x, ay: -hy + CORNER_MOUTH, bx: x, by: hy - CORNER_MOUTH });
    for (const sy of [-1, 1]) {
      const y0 = sy * (hy - CORNER_MOUTH);
      s.push({ ax: x, ay: y0, bx: x + sx * J * 0.6, by: y0 + sy * J * 0.8 });
    }
  }
  return s;
})();

export const HEAD_STRING = -L / 4;
export const FOOT_SPOT = { x: L / 4, y: 0 };
export const HEAD_SPOT = { x: -L / 4, y: 0 };

/* ------------------------------------------------------------- the balls */

export function makeBall(id: number, x: number, y: number): Ball {
  return { id, x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, q: [1, 0, 0, 0], on: true, pocket: -1 };
}

export function cloneBalls(balls: Ball[]): Ball[] {
  return balls.map((b) => ({ ...b, q: [b.q[0], b.q[1], b.q[2], b.q[3]] }));
}

export const moving = (b: Ball): boolean =>
  b.on && (b.vx !== 0 || b.vy !== 0 || b.wx !== 0 || b.wy !== 0 || b.wz !== 0);

export const anyMoving = (balls: Ball[]): boolean => balls.some(moving);

/** A cue ball may sit here: on the cloth, clear of the rails and every ball. */
export function canPlace(balls: Ball[], x: number, y: number, kitchen = false): boolean {
  if (Math.abs(x) > hx - R || Math.abs(y) > hy - R) return false;
  if (kitchen && x > HEAD_STRING) return false;
  for (const b of balls) {
    if (b.id === 0 || !b.on) continue;
    if (Math.hypot(b.x - x, b.y - y) < 2 * R + 0.0005) return false;
  }
  return true;
}

/** The nearest free spot to (x, y), searching outward. */
export function nearestFree(balls: Ball[], x: number, y: number, kitchen = false): { x: number; y: number } {
  const cx = Math.max(-hx + R, Math.min(kitchen ? HEAD_STRING : hx - R, x));
  const cy = Math.max(-hy + R, Math.min(hy - R, y));
  if (canPlace(balls, cx, cy, kitchen)) return { x: cx, y: cy };
  for (let ring = 1; ring < 80; ring++) {
    const d = ring * R * 0.5;
    const n = 8 + ring * 4;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = cx + Math.cos(a) * d;
      const py = cy + Math.sin(a) * d;
      if (canPlace(balls, px, py, kitchen)) return { x: px, y: py };
    }
  }
  return { x: cx, y: cy };
}

/* --------------------------------------------------------------- the cue */

export interface Strike {
  /** Direction of the cue, radians. */
  angle: number;
  /** Cue ball speed straight off the tip, m/s. */
  speed: number;
  /** Where the tip meets the ball, -1..1 each way: x is right english, y is top. */
  spinX: number;
  spinY: number;
}

export const MAX_SPEED = 6.6;
export const MIN_SPEED = 0.25;
const MAX_OFFSET = 0.5 * R;

/** Power 0..1 to a cue ball speed. Squared, so soft shots get the travel. */
export const powerToSpeed = (p: number): number =>
  MIN_SPEED + (MAX_SPEED - MIN_SPEED) * Math.pow(Math.max(0, Math.min(1, p)), 1.6);

export function strike(cue: Ball, s: Strike): void {
  const dx = Math.cos(s.angle);
  const dy = Math.sin(s.angle);
  cue.vx = dx * s.speed;
  cue.vy = dy * s.speed;
  // Tip offset relative to the centre, in the plane perpendicular to the cue.
  const a = Math.max(-1, Math.min(1, s.spinX)) * MAX_OFFSET; // to the right
  const b = Math.max(-1, Math.min(1, s.spinY)) * MAX_OFFSET; // up
  // r = a·right + b·up, right = d × z = (dy, -dx, 0); w = r × v / I.
  const rx = a * dy;
  const ry = -a * dx;
  const rz = b;
  const vx = cue.vx;
  const vy = cue.vy;
  cue.wx = (ry * 0 - rz * vy) * INV_I;
  cue.wy = (rz * vx - rx * 0) * INV_I;
  cue.wz = (rx * vy - ry * vx) * INV_I;
}

/* ------------------------------------------------------------- one step */

function rotate(b: Ball, dt: number): void {
  const [qw, qx, qy, qz] = b.q;
  const h = 0.5 * dt;
  const wx = b.wx * h;
  const wy = b.wy * h;
  const wz = b.wz * h;
  const nw = qw - wx * qx - wy * qy - wz * qz;
  const nx = qx + wx * qw + wy * qz - wz * qy;
  const ny = qy - wx * qz + wy * qw + wz * qx;
  const nz = qz + wx * qy - wy * qx + wz * qw;
  const n = 1 / Math.hypot(nw, nx, ny, nz);
  b.q[0] = nw * n;
  b.q[1] = nx * n;
  b.q[2] = ny * n;
  b.q[3] = nz * n;
}

function cloth(b: Ball, dt: number): void {
  // Velocity of the contact point: v + w × (0, 0, -R).
  const ux = b.vx - R * b.wy;
  const uy = b.vy + R * b.wx;
  const slip = Math.hypot(ux, uy);
  if (slip > 0.002) {
    const k = (MU_SLIDE * G) / slip;
    const ax = -ux * k;
    const ay = -uy * k;
    // Slip falls at 3.5 μg; stop exactly at rolling rather than overshoot.
    const reach = slip / (3.5 * MU_SLIDE * G);
    const t = Math.min(dt, reach);
    b.vx += ax * t;
    b.vy += ay * t;
    b.wx += (2.5 / R) * ay * t;
    b.wy += (-2.5 / R) * ax * t;
    if (t < dt) {
      b.wx = -b.vy / R;
      b.wy = b.vx / R;
    }
  } else {
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > 0) {
      const ns = Math.max(0, sp - MU_ROLL * G * dt);
      const f = ns / sp;
      b.vx *= f;
      b.vy *= f;
      if (ns < 0.004) {
        b.vx = 0;
        b.vy = 0;
      }
    }
    b.wx = -b.vy / R;
    b.wy = b.vx / R;
  }
  if (b.wz !== 0) {
    const d = SPIN_DECAY * dt;
    b.wz = Math.abs(b.wz) <= d ? 0 : b.wz - Math.sign(b.wz) * d;
  }
}

function collideBalls(a: Ball, b: Ball, events: SimEvent[]): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  const min = 2 * R;
  if (d2 >= min * min || d2 === 0) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  // Push apart.
  const over = (min - d) / 2;
  a.x -= nx * over;
  a.y -= ny * over;
  b.x += nx * over;
  b.y += ny * over;
  const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (rel <= 0) return;
  const j = ((1 + E_BALL) / 2) * rel;
  a.vx -= j * nx;
  a.vy -= j * ny;
  b.vx += j * nx;
  b.vy += j * ny;
  events.push({ type: "hit", a: a.id, b: b.id, speed: rel });
}

function collideCushion(b: Ball, s: Segment, events: SimEvent[]): void {
  const ex = s.bx - s.ax;
  const ey = s.by - s.ay;
  const len2 = ex * ex + ey * ey;
  let t = ((b.x - s.ax) * ex + (b.y - s.ay) * ey) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = s.ax + ex * t;
  const cy = s.ay + ey * t;
  const dx = b.x - cx;
  const dy = b.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= R * R || d2 === 0) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  b.x = cx + nx * R;
  b.y = cy + ny * R;
  const vn = b.vx * nx + b.vy * ny;
  if (vn >= 0) return;
  // Faster balls lose more to the rubber.
  const e = Math.max(0.6, 0.86 - 0.035 * -vn);
  const jn = -(1 + e) * vn; // per unit mass
  // Friction at the contact point (r = -R n), against its slip along the rail.
  const tx = -ny;
  const ty = nx;
  // Contact velocity: v + w × r, r = (-R nx, -R ny, 0).
  const cvx = b.vx + (b.wy * 0 - b.wz * -R * ny);
  const cvy = b.vy + (b.wz * -R * nx - b.wx * 0);
  const slip = cvx * tx + cvy * ty;
  // Effective mass along the tangent for a solid sphere is 2/7.
  let jt = -slip * (2 / 7);
  const cap = MU_CUSHION * jn;
  if (jt > cap) jt = cap;
  if (jt < -cap) jt = -cap;
  const jx = nx * jn + tx * jt;
  const jy = ny * jn + ty * jt;
  b.vx += jx;
  b.vy += jy;
  // dw = (r × J) / I, r = (-R nx, -R ny, 0), J = (jx, jy, 0).
  b.wz += (-R * nx * jy - -R * ny * jx) * INV_I;
  // The cushion nose sits a little above the centre, so a hard hit also
  // scrubs some of the roll: lose a share of the spin that was into the rail.
  b.wx *= 0.7;
  b.wy *= 0.7;
  events.push({ type: "rail", ball: b.id, speed: -vn });
}

const NEAR_X = hx - R - 0.02;
const NEAR_Y = hy - R - 0.02;

/**
 * Advance the table by one fixed step. Returns false once nothing moves.
 * `spinPose` is off for the computer's lookahead, which never draws.
 */
export function step(balls: Ball[], events: SimEvent[], spinPose = true): boolean {
  const dt = DT;
  let live = false;
  for (const b of balls) {
    if (!b.on) continue;
    if (b.vx === 0 && b.vy === 0 && b.wx === 0 && b.wy === 0 && b.wz === 0) continue;
    live = true;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (spinPose) rotate(b, dt);
    cloth(b, dt);
  }
  if (!live) return false;
  const n = balls.length;
  for (let i = 0; i < n; i++) {
    const a = balls[i];
    if (!a.on) continue;
    const am = a.vx !== 0 || a.vy !== 0;
    for (let k = i + 1; k < n; k++) {
      const b = balls[k];
      if (!b.on) continue;
      if (!am && b.vx === 0 && b.vy === 0) continue;
      collideBalls(a, b, events);
    }
  }
  for (const b of balls) {
    if (!b.on || (b.vx === 0 && b.vy === 0)) continue;
    if (Math.abs(b.x) > NEAR_X || Math.abs(b.y) > NEAR_Y) {
      for (const s of CUSHIONS) collideCushion(b, s, events);
      for (let p = 0; p < POCKETS.length; p++) {
        const pk = POCKETS[p];
        const far = Math.abs(b.x) > hx + R * 1.2 || Math.abs(b.y) > hy + R * 1.2;
        if (far || Math.hypot(b.x - pk.x, b.y - pk.y) < pk.r) {
          let best = p;
          if (far) {
            let bd = Infinity;
            POCKETS.forEach((q, qi) => {
              const dd = Math.hypot(b.x - q.x, b.y - q.y);
              if (dd < bd) { bd = dd; best = qi; }
            });
          }
          const sp = Math.hypot(b.vx, b.vy);
          b.on = false;
          b.pocket = best;
          b.x = POCKETS[best].x;
          b.y = POCKETS[best].y;
          b.vx = b.vy = b.wx = b.wy = b.wz = 0;
          events.push({ type: "pot", ball: b.id, pocket: best, speed: sp });
          break;
        }
      }
    }
  }
  return true;
}

/** What a shot did, in the order the rules want to know it. */
export interface ShotRecord {
  firstHit: number | null;
  /** Any ball reached a cushion after the cue ball first touched one. */
  railAfterContact: boolean;
  potted: { ball: number; pocket: number }[];
  /** Object balls that touched a cushion, for the break rule. */
  railBalls: number[];
}

export const emptyRecord = (): ShotRecord => ({ firstHit: null, railAfterContact: false, potted: [], railBalls: [] });

/** Fold the events of one or more steps into the record. */
export function record(rec: ShotRecord, events: SimEvent[]): void {
  for (const e of events) {
    if (e.type === "hit") {
      if (rec.firstHit === null && (e.a === 0 || e.b === 0)) rec.firstHit = e.a === 0 ? e.b : e.a;
    } else if (e.type === "rail") {
      if (rec.firstHit !== null) rec.railAfterContact = true;
      if (e.ball !== 0 && !rec.railBalls.includes(e.ball)) rec.railBalls.push(e.ball);
    } else if (e.type === "pot") {
      rec.potted.push({ ball: e.ball, pocket: e.pocket });
    }
  }
}

/** Run a shot to rest. The computer's lookahead, and the tests. */
export function simulate(balls: Ball[], maxSeconds = 30, spinPose = false): ShotRecord {
  const rec = emptyRecord();
  const events: SimEvent[] = [];
  const steps = Math.round(maxSeconds / DT);
  for (let i = 0; i < steps; i++) {
    events.length = 0;
    const live = step(balls, events, spinPose);
    record(rec, events);
    if (!live) break;
  }
  // Anything still creeping after the limit stops where it is.
  for (const b of balls) { b.vx = b.vy = b.wx = b.wy = b.wz = 0; }
  return rec;
}
