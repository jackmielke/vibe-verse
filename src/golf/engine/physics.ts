/**
 * Vibe Golf — 2D physics.
 *
 * A small, deterministic solver purpose-built for a golf ball: swept motion
 * with adaptive substepping (so a 60 m/s drive can never tunnel through a
 * 20 cm wall), per-material restitution and friction, spin with a Magnus
 * curve, a distinct rolling regime on shallow contacts, and a settle test
 * that doesn't jitter.
 *
 * Broadphase is a uniform spatial hash over segments, rebuilt per hole.
 * Everything is allocation-free in the step loop — this runs 60× a second on
 * a phone.
 *
 * Publishes `PhysicsService`.
 */
import type {
  BallState,
  GolfCtx,
  Hole,
  PhysicsService,
  RayHit2,
  Surface,
  SurfaceMaterial,
  System,
  SystemFactory,
  Vec2,
} from "../types";
import { BALL_TYPES, MATERIALS, v2 } from "../types";

/** One collidable edge, pre-flattened from the hole's surfaces. */
interface Edge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Unit normal (pointing "out" of the solid). */
  nx: number;
  ny: number;
  material: SurfaceMaterial;
  surface: Surface;
}

const GRID = 4; // metres per broadphase cell
const REST_SPEED = 0.42; // m/s below which the ball is a candidate to settle
const REST_TIME = 0.28; // seconds it must stay slow to be called resting
const MAX_SUBSTEPS = 48;
const SKIN = 0.004; // separation kept after a push-out, metres
/** Contacts shallower than this are treated as rolling, not bouncing. */
const ROLL_NORMAL_SPEED = 1.5;
const MAGNUS = 0.0016;

const createPhysics: SystemFactory = (ctx) => {
  let edges: Edge[] = [];
  const cells = new Map<number, number[]>();
  let hole: Hole | null = null;

  const balls: BallState[] = [];
  const gravity = v2(0, -22);
  const wind = v2(0, 0);

  const key = (cx: number, cy: number) => (cx & 0xffff) | ((cy & 0xffff) << 16);

  function buildBroadphase(): void {
    cells.clear();
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const minX = Math.min(e.ax, e.bx);
      const maxX = Math.max(e.ax, e.bx);
      const minY = Math.min(e.ay, e.by);
      const maxY = Math.max(e.ay, e.by);
      const c0x = Math.floor(minX / GRID);
      const c1x = Math.floor(maxX / GRID);
      const c0y = Math.floor(minY / GRID);
      const c1y = Math.floor(maxY / GRID);
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let cy = c0y; cy <= c1y; cy++) {
          const k = key(cx, cy);
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(i);
        }
      }
    }
  }

  function setHole(h: Hole): void {
    hole = h;
    edges = [];
    for (const s of h.surfaces) {
      const n = s.points.length;
      if (n < 2) continue;
      const last = s.closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const a = s.points[i];
        const b = s.points[(i + 1) % n];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        // Normal is the left-hand perpendicular. Course authoring winds
        // ground strips left-to-right so this points up out of the ground.
        edges.push({
          ax: a.x, ay: a.y, bx: b.x, by: b.y,
          nx: -dy / len, ny: dx / len,
          material: s.material, surface: s,
        });
      }
    }
    buildBroadphase();
  }

  /** Scratch list reused by every query — keeps the step loop allocation-free. */
  const candidates: number[] = [];
  let stamp = 0;
  const seen = new Int32Array(0);
  let seenArr = seen;

  function gather(minX: number, minY: number, maxX: number, maxY: number): void {
    candidates.length = 0;
    if (seenArr.length < edges.length) seenArr = new Int32Array(edges.length);
    stamp++;
    const c0x = Math.floor(minX / GRID);
    const c1x = Math.floor(maxX / GRID);
    const c0y = Math.floor(minY / GRID);
    const c1y = Math.floor(maxY / GRID);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const list = cells.get(key(cx, cy));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const idx = list[i];
          if (seenArr[idx] === stamp) continue;
          seenArr[idx] = stamp;
          candidates.push(idx);
        }
      }
    }
  }

  /** Closest point on edge `e` to (px,py), written into `outCP`. */
  const outCP = { x: 0, y: 0, t: 0 };
  function closestOnEdge(e: Edge, px: number, py: number): void {
    const dx = e.bx - e.ax;
    const dy = e.by - e.ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - e.ax) * dx + (py - e.ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    outCP.x = e.ax + dx * t;
    outCP.y = e.ay + dy * t;
    outCP.t = t;
  }

  function probe(p: Vec2, maxDist: number): RayHit2 | null {
    gather(p.x - maxDist, p.y - maxDist, p.x + maxDist, p.y + maxDist);
    let best: RayHit2 | null = null;
    let bestD = maxDist;
    for (const idx of candidates) {
      const e = edges[idx];
      closestOnEdge(e, p.x, p.y);
      const dx = p.x - outCP.x;
      const dy = p.y - outCP.y;
      const d = Math.hypot(dx, dy);
      if (d >= bestD) continue;
      bestD = d;
      const inv = d > 1e-6 ? 1 / d : 0;
      best = {
        point: v2(outCP.x, outCP.y),
        normal: d > 1e-6 ? v2(dx * inv, dy * inv) : v2(e.nx, e.ny),
        t: 0,
        material: e.material,
        surface: e.surface,
      };
    }
    return best;
  }

  /** Swept circle against the hole. Returns the earliest hit, or null. */
  function sweep(from: Vec2, to: Vec2, radius: number): RayHit2 | null {
    const minX = Math.min(from.x, to.x) - radius;
    const maxX = Math.max(from.x, to.x) + radius;
    const minY = Math.min(from.y, to.y) - radius;
    const maxY = Math.max(from.y, to.y) + radius;
    gather(minX, minY, maxX, maxY);

    const mx = to.x - from.x;
    const my = to.y - from.y;
    let bestT = 1.0001;
    let best: RayHit2 | null = null;

    for (const idx of candidates) {
      const e = edges[idx];
      // March the swept segment in a few samples and refine — cheap, stable,
      // and exact enough at the substep sizes we actually run at.
      const steps = 8;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = from.x + mx * t;
        const py = from.y + my * t;
        closestOnEdge(e, px, py);
        const dx = px - outCP.x;
        const dy = py - outCP.y;
        if (dx * dx + dy * dy > radius * radius) continue;
        if (t >= bestT) break;
        const d = Math.hypot(dx, dy);
        const inv = d > 1e-6 ? 1 / d : 0;
        bestT = t;
        best = {
          point: v2(outCP.x, outCP.y),
          normal: d > 1e-6 ? v2(dx * inv, dy * inv) : v2(e.nx, e.ny),
          t,
          material: e.material,
          surface: e.surface,
        };
        break;
      }
    }
    return best;
  }

  /**
   * Resolve every overlap at the ball's current position. Runs a few
   * iterations because corners put the ball inside two edges at once.
   */
  function resolveContacts(b: BallState, dt: number): void {
    const props = BALL_TYPES[b.type];
    for (let iter = 0; iter < 4; iter++) {
      gather(b.pos.x - b.radius, b.pos.y - b.radius, b.pos.x + b.radius, b.pos.y + b.radius);
      let hit = false;

      for (const idx of candidates) {
        const e = edges[idx];
        closestOnEdge(e, b.pos.x, b.pos.y);
        let dx = b.pos.x - outCP.x;
        let dy = b.pos.y - outCP.y;
        let d = Math.hypot(dx, dy);
        if (d >= b.radius) continue;

        const mat = MATERIALS[e.material];

        // Degenerate: dead centre on the edge — fall back to the face normal.
        if (d < 1e-6) {
          dx = e.nx;
          dy = e.ny;
          d = 1e-6;
        }
        const nx = dx / d;
        const ny = dy / d;

        if (mat.lethal && !props.ghost) {
          ctx.emit("golf:hazard", { material: e.material, at: { x: b.pos.x, y: b.pos.y } });
          b.active = false;
          return;
        }
        if (props.ghost && e.material !== "outOfBounds") continue;

        // Positional correction.
        const pen = b.radius - d + SKIN;
        b.pos.x += nx * pen;
        b.pos.y += ny * pen;
        hit = true;

        // Split velocity into normal + tangent.
        const vn = b.vel.x * nx + b.vel.y * ny;
        if (vn >= 0) continue; // already separating

        const tx = -ny;
        const ty = nx;
        const vt = b.vel.x * tx + b.vel.y * ty;

        const speedIn = Math.abs(vn);
        const rolling = speedIn < ROLL_NORMAL_SPEED;

        if (props.sticky && !b.stuck) {
          b.vel.x = 0;
          b.vel.y = 0;
          b.spin = 0;
          b.stuck = true;
          b.resting = true;
          ctx.emit("golf:stick", { at: { x: b.pos.x, y: b.pos.y } });
          ctx.services.audio?.play("stick");
          return;
        }

        let newVn: number;
        if (rolling) {
          // Kill the normal component entirely so the ball settles onto the
          // surface instead of buzzing against it.
          newVn = 0;
        } else {
          const e2 = Math.min(0.98, mat.restitution * props.bounce);
          newVn = speedIn * e2;
          ctx.emit("golf:bounce", {
            at: { x: b.pos.x, y: b.pos.y },
            material: e.material,
            speed: speedIn,
          });
        }

        // Friction acts on the tangential component. Rolling contact also
        // couples spin to surface speed, which is what makes backspin bite.
        const surfaceSpeed = vt - b.spin * b.radius;
        const fr = rolling
          ? Math.min(1, mat.friction * (props.sticky ? 2 : 1) * 0.5)
          : Math.min(1, mat.friction);
        const dvt = -surfaceSpeed * fr;
        let newVt = vt + dvt;
        b.spin -= (dvt / b.radius) * 0.55;

        if (rolling) {
          // Rolling resistance as a constant deceleration opposing motion.
          // Gravity's along-slope component is already in `newVt`, so the
          // ball stops iff rollDrag exceeds the slope's tangent — which is
          // exactly the real-world condition, and why this settles.
          const decel = mat.rollDrag * 9.81 * dt;
          const sp = Math.abs(newVt);
          newVt = sp <= decel ? 0 : newVt - Math.sign(newVt) * decel;
          b.spin *= 1 - Math.min(1, mat.rollDrag * dt * 6);
        }

        b.vel.x = nx * newVn + tx * newVt;
        b.vel.y = ny * newVn + ty * newVt;
      }
      if (!hit) break;
    }
  }

  function stepBall(b: BallState, dt: number): void {
    if (!b.active || b.stuck) return;
    const props = BALL_TYPES[b.type];

    // Adaptive substepping: never move more than a quarter radius per
    // substep, so discrete resolution behaves like continuous detection.
    const speed = Math.hypot(b.vel.x, b.vel.y);
    const maxStep = b.radius * 0.25;
    const n = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil((speed * dt) / maxStep)));
    const h = dt / n;

    for (let i = 0; i < n; i++) {
      if (!b.active) return;

      // Forces: gravity, wind (weight-scaled), Magnus from spin.
      b.vel.x += gravity.x * h;
      b.vel.y += gravity.y * h;

      const windScale = props.drag > 1.3 ? 0.15 : 1; // heavy ball ignores wind
      b.vel.x += wind.x * h * windScale * 0.6;
      b.vel.y += wind.y * h * windScale * 0.6;

      // Magnus: perpendicular to velocity, proportional to spin × speed.
      const sp = Math.hypot(b.vel.x, b.vel.y);
      if (sp > 0.5 && Math.abs(b.spin) > 0.01) {
        const m = MAGNUS * b.spin * sp;
        // Snapshot before writing — using the updated vx to compute vy would
        // couple the two axes and spiral the ball.
        const vx = b.vel.x;
        const vy = b.vel.y;
        b.vel.x += -vy * m * h;
        b.vel.y += vx * m * h;
      }

      // Air drag.
      const air = Math.exp(-0.055 * props.drag * h * Math.max(1, sp * 0.06));
      b.vel.x *= air;
      b.vel.y *= air;
      b.spin *= Math.exp(-0.55 * h);

      b.pos.x += b.vel.x * h;
      b.pos.y += b.vel.y * h;

      resolveContacts(b, h);
    }

    // Out of bounds.
    if (hole) {
      const { min, max } = hole.bounds;
      if (b.pos.x < min.x || b.pos.x > max.x || b.pos.y < min.y) {
        ctx.emit("golf:hazard", { material: "outOfBounds", at: { x: b.pos.x, y: b.pos.y } });
        b.active = false;
        return;
      }
    }

    // Settle test: slow, and actually supported by something underneath.
    const sp2 = Math.hypot(b.vel.x, b.vel.y);
    if (sp2 < REST_SPEED) {
      const support = probe(b.pos, b.radius + 0.06);
      if (support && support.normal.y > 0.25) {
        b.restTimer += dt;
        if (b.restTimer >= REST_TIME) {
          b.resting = true;
          b.vel.x = 0;
          b.vel.y = 0;
          b.spin = 0;
        }
      } else {
        b.restTimer = 0;
      }
    } else {
      b.restTimer = 0;
      b.resting = false;
    }

    // Trail sampling for the renderer.
    if (!b.resting) {
      b.trail.push(v2(b.pos.x, b.pos.y));
      if (b.trail.length > 42) b.trail.shift();
    }
  }

  const service: PhysicsService = {
    balls,
    gravity,
    wind,
    setHole,
    sweep,
    probe,
    step(dt: number) {
      for (const b of balls) stepBall(b, dt);
    },
    impulse(at: Vec2, radius: number, force: Vec2) {
      for (const b of balls) {
        if (!b.active) continue;
        const d = Math.hypot(b.pos.x - at.x, b.pos.y - at.y);
        if (d > radius) continue;
        const f = 1 - d / radius;
        b.vel.x += force.x * f;
        b.vel.y += force.y * f;
        b.resting = false;
        b.restTimer = 0;
      }
    },
  };

  ctx.services.physics = service;

  const sys: System = {
    name: "physics",
    update(dt) {
      // Fixed-step the solver so behaviour is identical on a 144 Hz laptop
      // and a 60 Hz phone. Accumulate and drain.
      acc += Math.min(dt, 0.1);
      while (acc >= FIXED) {
        service.step(FIXED);
        acc -= FIXED;
      }
    },
  };

  let acc = 0;
  const FIXED = 1 / 120;

  return sys;
};

export default createPhysics;
