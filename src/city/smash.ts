/**
 * smash — street furniture you can knock over with a car.
 *
 * Trees, lamp posts, stop signs and signal poles in Vibe City are instanced
 * meshes: hundreds of them for a handful of draw calls, and deliberately not
 * collidable, because a pedestrian who bumps a lamp post and stops dead is
 * worse than one who brushes past it. That left a car driving through them
 * like ghosts, which is the opposite of what anybody behind a wheel wants.
 *
 * So each one is registered here as a *prop*: a point on the ground, a radius,
 * and the instance slots that draw it. A car (yours, or a bot that has been
 * sent flying) asks `hit()` with its position and heading, and anything
 * standing inside the radius falls over in that direction, pivoting on its
 * base, skidding a little and bouncing once. It lies there until nobody is
 * looking and then quietly stands back up, so the city does not end the
 * session as a field of stumps.
 *
 * Nothing here allocates per frame; the falling animation rewrites only the
 * instance matrices of the props that are actually moving.
 */
import * as THREE from "three";

export type PropKind = "tree" | "lamp" | "sign" | "signal";

/** One instance slot that draws part of a prop. */
export interface PropPart {
  mesh: THREE.InstancedMesh;
  index: number;
  /** Hide this part outright once the prop is down (a lamp's light pool). */
  hideWhenDown?: boolean;
}

interface Prop {
  kind: PropKind;
  x: number;
  z: number;
  baseY: number;
  radius: number;
  parts: Array<PropPart & { rest: THREE.Matrix4 }>;
  /** 0 while standing; otherwise seconds since it was hit. */
  down: number;
  /** Fall direction, unit, in XZ. */
  dx: number;
  dz: number;
  angle: number;
  angVel: number;
  /** Skid along the ground after the hit. */
  slide: number;
  slideVel: number;
  /** Was already lying still last frame, so its matrix need not be rewritten. */
  still: boolean;
}

export interface SmashHit {
  kind: PropKind;
  x: number;
  z: number;
}

export interface Smashables {
  /** Register one prop. Its parts' current instance matrices are its rest pose. */
  add(kind: PropKind, x: number, z: number, baseY: number, radius: number, parts: PropPart[]): void;
  /**
   * Knock down anything standing within `r` of (x, z). `vx`/`vz` is the
   * direction of travel (any length) and `speed` how hard. Returns what fell,
   * so the caller can pay damage, play a sound and throw leaves.
   */
  hit(x: number, z: number, r: number, vx: number, vz: number, speed: number): SmashHit[];
  /** Knock down everything in a radius, outward from the centre. For blasts. */
  blast(x: number, z: number, r: number, force: number): SmashHit[];
  /** Animate falling props; stand them back up when the viewer is far enough away. */
  update(dt: number, viewer: THREE.Vector3 | null): void;
  /**
   * Props still standing within `r` of (x, z), optionally of one kind. For
   * things that happen to a prop without knocking it over: a tree catching
   * fire. The array is reused.
   */
  standing(x: number, z: number, r: number, kind?: PropKind): ReadonlyArray<SmashHit>;
  /** How many are currently down, for harnesses. */
  downCount(): number;
  count(): number;
}

/** Below this a car just brushes past. */
const MIN_SPEED = 3;
/** Seconds a prop lies there before it may stand back up… */
const RESTORE_AFTER = 35;
/** …and only once the viewer is at least this far away, unless it is very old. */
const RESTORE_DIST = 45;
const CELL = 8;

export function createSmashables(): Smashables {
  const props: Prop[] = [];
  const grid = new Map<number, number[]>();
  const moving = new Set<Prop>();
  const key = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

  const M = new THREE.Matrix4();
  const T = new THREE.Matrix4();
  const R = new THREE.Matrix4();
  const AX = new THREE.Vector3();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const dirty = new Set<THREE.InstancedMesh>();

  const write = (p: Prop) => {
    // Pivot at the base, rotate about the axis across the fall direction, then
    // put it back — and add the skid.
    AX.set(p.dz, 0, -p.dx);
    R.makeRotationAxis(AX, p.angle);
    for (const part of p.parts) {
      if (part.hideWhenDown && p.down > 0) {
        part.mesh.setMatrixAt(part.index, ZERO);
      } else if (p.down === 0) {
        part.mesh.setMatrixAt(part.index, part.rest);
      } else {
        T.makeTranslation(-p.x, -p.baseY, -p.z);
        M.copy(T).premultiply(R);
        T.makeTranslation(p.x + p.dx * p.slide, p.baseY, p.z + p.dz * p.slide);
        M.premultiply(T);
        M.multiply(part.rest);
        part.mesh.setMatrixAt(part.index, M);
      }
      dirty.add(part.mesh);
    }
  };

  const knock = (p: Prop, dx: number, dz: number, speed: number) => {
    const len = Math.hypot(dx, dz) || 1;
    p.dx = dx / len;
    p.dz = dz / len;
    p.down = 1e-3;
    p.angle = 0;
    // A sapling goes over faster than a lamp post, and both faster the harder
    // they were hit. Never zero, or a gentle nudge leaves it hanging upright.
    p.angVel = 0.8 + Math.min(4, speed * 0.12) * (p.kind === "tree" ? 1 : 0.8);
    p.slide = 0;
    p.slideVel = Math.min(9, speed * 0.35);
    p.still = false;
    moving.add(p);
  };

  const near = (x: number, z: number, r: number, out: Prop[]) => {
    out.length = 0;
    const c0x = Math.floor((x - r) / CELL);
    const c1x = Math.floor((x + r) / CELL);
    const c0z = Math.floor((z - r) / CELL);
    const c1z = Math.floor((z + r) / CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const list = grid.get(key(cx, cz));
        if (!list) continue;
        for (const i of list) out.push(props[i]);
      }
    }
    return out;
  };
  const scratch: Prop[] = [];
  const standingOut: SmashHit[] = [];

  return {
    add(kind, x, z, baseY, radius, parts) {
      const rest = parts.map((part) => {
        const m = new THREE.Matrix4();
        part.mesh.getMatrixAt(part.index, m);
        part.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        return { ...part, rest: m };
      });
      const i = props.length;
      props.push({
        kind, x, z, baseY, radius, parts: rest,
        down: 0, dx: 0, dz: 1, angle: 0, angVel: 0, slide: 0, slideVel: 0, still: false,
      });
      const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    },

    hit(x, z, r, vx, vz, speed) {
      const out: SmashHit[] = [];
      if (speed < MIN_SPEED) return out;
      for (const p of near(x, z, r + 1, scratch)) {
        if (p.down > 0) continue;
        const reach = r + p.radius;
        if ((p.x - x) ** 2 + (p.z - z) ** 2 > reach * reach) continue;
        // Mostly the way the car was going, plus a little away from its line,
        // so a row of trees hit on the diagonal fans out instead of stacking.
        const ax = p.x - x;
        const az = p.z - z;
        const al = Math.hypot(ax, az) || 1;
        const vl = Math.hypot(vx, vz) || 1;
        knock(p, vx / vl + (ax / al) * 0.35, vz / vl + (az / al) * 0.35, speed);
        out.push({ kind: p.kind, x: p.x, z: p.z });
      }
      return out;
    },

    blast(x, z, r, force) {
      const out: SmashHit[] = [];
      for (const p of near(x, z, r, scratch)) {
        if (p.down > 0) continue;
        const d = Math.hypot(p.x - x, p.z - z);
        if (d > r) continue;
        knock(p, p.x - x || 1e-3, p.z - z, force * (1 - d / r) + 4);
        out.push({ kind: p.kind, x: p.x, z: p.z });
      }
      return out;
    },

    update(dt, viewer) {
      for (const p of moving) {
        p.down += dt;
        if (p.angle < Math.PI / 2) {
          // Gravity takes over as it tips: a toppling pole speeds up.
          p.angVel += Math.sin(p.angle + 0.15) * 9 * dt;
          p.angle += p.angVel * dt;
          if (p.angle >= Math.PI / 2 - 0.08) {
            // One bounce off the pavement, then rest just shy of flat so the
            // crown does not sink into the road.
            p.angle = Math.PI / 2 - 0.08;
            p.angVel = -Math.abs(p.angVel) * 0.18;
            if (Math.abs(p.angVel) < 0.15) p.angVel = 0;
          }
        }
        if (p.slideVel > 0) {
          p.slide += p.slideVel * dt;
          p.slideVel = Math.max(0, p.slideVel - 14 * dt);
        }
        const settled = p.angVel === 0 && p.slideVel === 0;
        const far = !viewer || Math.hypot(viewer.x - p.x, viewer.z - p.z) > RESTORE_DIST;
        if (p.down > RESTORE_AFTER && (far || p.down > RESTORE_AFTER * 4)) {
          p.down = 0;
          p.angle = 0;
          p.slide = 0;
          write(p);
          moving.delete(p);
          continue;
        }
        // Lying still: stop rewriting it every frame, but keep it in the set
        // so the restore clock keeps running.
        if (!settled || !p.still) write(p);
        p.still = settled;
      }
      for (const m of dirty) m.instanceMatrix.needsUpdate = true;
      dirty.clear();
    },

    standing(x, z, r, kind) {
      standingOut.length = 0;
      for (const p of near(x, z, r, scratch)) {
        if (p.down > 0 || (kind && p.kind !== kind)) continue;
        if ((p.x - x) ** 2 + (p.z - z) ** 2 > r * r) continue;
        standingOut.push({ kind: p.kind, x: p.x, z: p.z });
      }
      return standingOut;
    },

    downCount() {
      return moving.size;
    },
    count() {
      return props.length;
    },
  };
}
