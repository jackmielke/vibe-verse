/**
 * Vibe Kart: PRISM SKYWAY, the rainbow road in the sky.
 *
 * A drop-in for `track/index.ts`: it publishes the same `TrackService`, so the
 * physics, AI, items, camera, minimap, audio and post stack all run unchanged
 * and the karts feel exactly the way they do on Sunset Bluff. What differs is
 * the ground: there is none. Off the edge is `void`, and the physics already
 * knows what to do about that.
 *
 * The course data is pure (`course.ts`); the meshes are in `visuals.ts`.
 */
import * as THREE from "three";
import type {
  GridSlot,
  ItemBoxSpec,
  KartCtx,
  SurfaceSample,
  System,
  TrackFrame,
  TrackService,
  WallHit,
} from "../types";
import { buildCourse, HALF_WIDTH, liftAt, RAIL_HEIGHT, RAIL_OFFSET, SECTION_NAMES, type Course } from "./course";
import { buildSkywayVisuals } from "./visuals";

const LAPS = 3;
const CHECKPOINTS = 24;
/** Sundown: the sun on the horizon, the first stars, the snow going pink below. */
export const PRISM_TIME_OF_DAY = 0.5;
export const PRISM_NAME = "Prism Skyway";

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const wrap01 = (t: number) => ((t % 1) + 1) % 1;

export interface ProjectHit {
  t: number;
  s: number;
  lateral: number;
  height: number;
  centreY: number;
  above: number;
}

/** Interpolated frame and projection over the station table. */
export function makeQueries(c: Course) {
  const { count, ds, pos, fwd, rgt, up } = c;
  const total = c.length;

  const sample = (s: number, P: THREE.Vector3, F: THREE.Vector3, R: THREE.Vector3, U: THREE.Vector3) => {
    const idx = (((s / ds) % count) + count) % count;
    const i0 = Math.floor(idx) % count;
    const i1 = (i0 + 1) % count;
    const w = idx - Math.floor(idx);
    const lerp3 = (arr: Float32Array, out: THREE.Vector3) =>
      out.set(
        arr[i0 * 3] + (arr[i1 * 3] - arr[i0 * 3]) * w,
        arr[i0 * 3 + 1] + (arr[i1 * 3 + 1] - arr[i0 * 3 + 1]) * w,
        arr[i0 * 3 + 2] + (arr[i1 * 3 + 2] - arr[i0 * 3 + 2]) * w,
      );
    lerp3(pos, P);
    lerp3(fwd, F).normalize();
    lerp3(up, U).normalize();
    lerp3(rgt, R).normalize();
  };

  const d2 = (px: number, py: number, pz: number, i: number) => {
    const dx = px - pos[i * 3];
    const dy = py - pos[i * 3 + 1];
    const dz = pz - pos[i * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };

  const P = new THREE.Vector3();
  const F = new THREE.Vector3();
  const R = new THREE.Vector3();
  const U = new THREE.Vector3();
  const hit: ProjectHit = { t: 0, s: 0, lateral: 0, height: 0, centreY: 0, above: 0 };

  function project(p: THREE.Vector3, hint?: number): ProjectHit {
    const px = p.x, py = p.y, pz = p.z;
    let best = Infinity;
    let bi = 0;
    if (hint !== undefined && Number.isFinite(hint)) {
      const centre = Math.round(wrap01(hint) * count);
      for (let k = -40; k <= 40; k++) {
        const i = (centre + k + count * 2) % count;
        const d = d2(px, py, pz, i);
        if (d < best) {
          best = d;
          bi = i;
        }
      }
    }
    if (best > 400) {
      for (let i = 0; i < count; i += 4) {
        const d = d2(px, py, pz, i);
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      const c0 = bi;
      for (let k = -4; k <= 4; k++) {
        const i = (c0 + k + count) % count;
        const d = d2(px, py, pz, i);
        if (d < best) {
          best = d;
          bi = i;
        }
      }
    }
    // Sub-station refinement against the forward chord.
    const nx = (bi + 1) % count;
    const vx = pos[nx * 3] - pos[bi * 3];
    const vy = pos[nx * 3 + 1] - pos[bi * 3 + 1];
    const vz = pos[nx * 3 + 2] - pos[bi * 3 + 2];
    const len2 = vx * vx + vy * vy + vz * vz || 1e-9;
    let f = ((px - pos[bi * 3]) * vx + (py - pos[bi * 3 + 1]) * vy + (pz - pos[bi * 3 + 2]) * vz) / len2;
    f = clamp(f, -1, 1);
    const s = (((bi + f) * ds) % total + total) % total;
    sample(s, P, F, R, U);
    const dx = px - P.x, dy = py - P.y, dz = pz - P.z;
    const lateral = dx * R.x + dy * R.y + dz * R.z;
    hit.t = wrap01(s / total);
    hit.s = s;
    hit.lateral = lateral;
    hit.height = P.y + R.y * lateral;
    hit.centreY = P.y;
    hit.above = dx * U.x + dy * U.y + dz * U.z - liftAt(c, s);
    return hit;
  }

  const solidAt = (s: number) => c.solid[Math.floor(((s / ds) % count + count) % count)] === 1;
  const railAt = (s: number, side: 0 | 1) => {
    const i = Math.floor(((s / ds) % count + count) % count);
    return (side === 1 ? c.railR[i] : c.railL[i]) === 1;
  };
  const boostAt = (s: number, lateral: number) => {
    const i = Math.floor(((s / ds) % count + count) % count);
    const a = c.boost0[i];
    return Number.isFinite(a) && lateral >= a && lateral <= c.boost1[i];
  };

  return { sample, project, solidAt, railAt, boostAt };
}

export default function createPrismTrack(ctx: KartCtx): System {
  const course = buildCourse();
  const q = makeQueries(course);
  const total = course.length;

  // Twilight over the cloud decks, set on the environment that already booted.
  const env = ctx.services.env as { setTimeOfDay?: (v: number, rebake?: boolean) => void } | undefined;
  env?.setTimeOfDay?.(PRISM_TIME_OF_DAY, true);

  const visuals = buildSkywayVisuals(course, q, ctx.quality);
  // A violet sky fill so the karts read against the dusk instead of going to
  // silhouettes. Added at boot, before anything compiles, so no recompiles.
  const fill = new THREE.HemisphereLight(0xc8b4ff, 0x5a2a7a, 0.85);
  ctx.scene.add(fill);
  // The mountain below is kilometres across; let the camera see all of it.
  const farWas = ctx.camera.far;
  ctx.camera.far = 9000;
  ctx.camera.updateProjectionMatrix();
  ctx.scene.add(visuals.root);

  // --- scratch --------------------------------------------------------------
  const P = new THREE.Vector3();
  const F = new THREE.Vector3();
  const R = new THREE.Vector3();
  const U = new THREE.Vector3();
  const N = new THREE.Vector3();

  /** World point on the road at (s, lateral), lifted along the normal. */
  const onRoad = (s: number, lateral: number, lift: number, out: THREE.Vector3) => {
    q.sample(s, P, F, R, U);
    return out
      .copy(P)
      .addScaledVector(R, lateral)
      .addScaledVector(U, liftAt(course, s) + lift);
  };

  // --- racing line: toward the inside, smoothed ----------------------------
  const line = new Float32Array(course.count);
  {
    let peak = 1e-4;
    for (let i = 0; i < course.count; i++) peak = Math.max(peak, Math.abs(course.curvature[i]));
    for (let i = 0; i < course.count; i++) line[i] = clamp(course.curvature[i] / peak, -1, 1) * HALF_WIDTH * 0.55;
    const Rr = 34;
    const src = line.slice();
    for (let i = 0; i < course.count; i++) {
      let acc = 0;
      let w = 0;
      for (let k = -Rr; k <= Rr; k++) {
        const wt = 1 - Math.abs(k) / (Rr + 1);
        acc += src[(i + k + course.count * 2) % course.count] * wt;
        w += wt;
      }
      line[i] = acc / w;
    }
    // Over the gap and its run-up, aim dead centre.
    const g0 = course.spans.kick.start - 40;
    const g1 = course.spans.gap.end + 20;
    for (let i = 0; i < course.count; i++) {
      const s = i * course.ds;
      if (s > g0 && s < g1) line[i] *= 0.1;
    }
  }
  const racingLine = (t: number) => {
    const idx = wrap01(t) * course.count;
    const i0 = Math.floor(idx) % course.count;
    const i1 = (i0 + 1) % course.count;
    const w = idx - Math.floor(idx);
    return line[i0] * (1 - w) + line[i1] * w;
  };

  // --- item boxes and coins ------------------------------------------------
  const itemBoxes: ItemBoxSpec[] = [];
  const rows = [
    course.spans.launch.start + 200,
    course.spans.aurora.start + 250,
    course.spans.hairpin.start + 230,
    course.spans.under.start + 210,
    course.spans.helix.start + 300,
  ];
  for (const s of rows) {
    for (let k = -2; k <= 2; k++) {
      const lateral = k * 3.1;
      const v = new THREE.Vector3();
      onRoad(s, lateral, 1.45, v);
      itemBoxes.push({ position: v, t: wrap01(s / total), lateral });
    }
  }

  const coins: THREE.Vector3[] = [];
  {
    let s = 30;
    let run = 0;
    const g0 = course.spans.kick.start - 6;
    const g1 = course.spans.gap.end + 6;
    while (s < total - 20) {
      if (s < g0 || s > g1) {
        const v = new THREE.Vector3();
        onRoad(s, racingLine(s / total), 1.0, v);
        coins.push(v);
      }
      run++;
      if (run >= 4) {
        run = 0;
        s += 38;
      } else s += 5.5;
    }
  }

  // --- poses ---------------------------------------------------------------
  const basis = new THREE.Matrix4();
  const negF = new THREE.Vector3();
  const poseAt = (s: number, lateral: number, lift: number): GridSlot => {
    const position = new THREE.Vector3();
    onRoad(s, lateral, lift, position);
    q.sample(s, P, F, R, U);
    negF.copy(F).multiplyScalar(-1);
    basis.makeBasis(R, U, negF);
    return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(basis) };
  };
  const safeS = (s: number) => {
    let x = ((s % total) + total) % total;
    const k0 = course.spans.kick.start - 6;
    const g1 = course.spans.gap.end + 4;
    if (x > k0 && x < g1) x = course.spans.kick.start - 34;
    return x;
  };

  // Beauty marks: [s of the camera, lateral, height above road, s to look at, look height, fov]
  const marks: [number, number, number, number, number, number][] = [
    [total - 34, -16, 7, 30, 2, 50],
    [course.spans.aurora.start + 120, 34, 16, course.spans.aurora.start + 230, 0, 55],
    [course.spans.kick.start - 70, 14, 9, course.spans.gap.end + 30, -6, 52],
    [course.spans.under.start + 180, -40, 4, course.spans.under.start + 280, 10, 58],
    [course.spans.helix.start + 220, 60, 30, course.spans.helix.start + 330, 0, 60],
  ];
  const scenic = marks.map(([s0, l0, h0, s1, h1, fov]) => {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    q.sample(s0, P, F, R, U);
    a.copy(P).addScaledVector(R, l0).add(new THREE.Vector3(0, h0, 0));
    q.sample(s1, P, F, R, U);
    b.copy(P).add(new THREE.Vector3(0, h1, 0));
    return { position: a, lookAt: b, fov };
  });

  const frame = (s: number, out: TrackFrame) => {
    q.sample(s, out.position, out.forward, out.right, out.up);
    out.position.addScaledVector(out.up, liftAt(course, s));
    const i = Math.floor(((s / course.ds) % course.count + course.count) % course.count);
    out.t = wrap01(s / total);
    out.halfWidth = HALF_WIDTH;
    out.bank = course.bank[i];
    out.curvature = course.curvature[i];
    out.grade = course.grade[i];
    return out;
  };

  const service: TrackService & Record<string, unknown> = {
    name: PRISM_NAME,
    length: total,
    laps: LAPS,
    checkpointCount: CHECKPOINTS,
    root: visuals.root,
    itemBoxes,
    coins,
    scenicCount: scenic.length,
    sections: SECTION_NAMES.map((sec) => ({
      id: sec.id,
      label: sec.label,
      start: course.spans[sec.id].start,
      end: course.spans[sec.id].end,
    })),

    frameAt(t: number, out?: TrackFrame): TrackFrame {
      const o = out ?? {
        t: 0,
        position: new THREE.Vector3(),
        forward: new THREE.Vector3(),
        right: new THREE.Vector3(),
        up: new THREE.Vector3(),
        halfWidth: HALF_WIDTH,
        bank: 0,
        curvature: 0,
        grade: 0,
      };
      return frame(wrap01(t) * total, o);
    },

    project(position: THREE.Vector3, hint?: number) {
      const pr = q.project(position, hint);
      return { t: pr.t, lateral: pr.lateral, height: pr.height };
    },

    surfaceAt(p: THREE.Vector3, hint?: number, out?: SurfaceSample): SurfaceSample {
      const o =
        out ?? { height: 0, normal: new THREE.Vector3(), kind: "antigrav", onTrack: false, lateral: 0, t: 0 };
      const pr = q.project(p, hint);
      const lat = pr.lateral;
      const a = Math.abs(lat);
      const side: 0 | 1 = lat >= 0 ? 1 : 0;
      const edge = q.railAt(pr.s, side) ? HALF_WIDTH + RAIL_OFFSET : HALF_WIDTH + 0.4;
      o.t = pr.t;
      o.lateral = lat;
      if (q.solidAt(pr.s) && a <= edge && pr.above > -2.5) {
        q.sample(pr.s, P, F, R, U);
        const l0 = liftAt(course, pr.s - 0.5);
        const l1 = liftAt(course, pr.s + 0.5);
        N.copy(U).addScaledVector(F, -(l1 - l0)).normalize();
        const sx = P.x + R.x * lat + U.x * liftAt(course, pr.s);
        const sy = P.y + R.y * lat + U.y * liftAt(course, pr.s);
        const sz = P.z + R.z * lat + U.z * liftAt(course, pr.s);
        o.normal.copy(N);
        o.kind = q.boostAt(pr.s, lat) ? "boost" : "antigrav";
        o.onTrack = true;
        o.height = p.y - (p.x - sx) * N.x - (p.y - sy) * N.y - (p.z - sz) * N.z;
        return o;
      }
      // Off the edge, or over the Comet Gap: a long way down.
      o.kind = "void";
      o.onTrack = false;
      o.normal.set(0, 1, 0);
      o.height = pr.centreY - 90;
      return o;
    },

    wallAt(p: THREE.Vector3, radius: number, hint?: number): WallHit | null {
      const pr = q.project(p, hint);
      const side: 0 | 1 = pr.lateral >= 0 ? 1 : 0;
      if (!q.railAt(pr.s, side) || !q.solidAt(pr.s)) return null;
      const face = HALF_WIDTH + RAIL_OFFSET;
      const depth = Math.abs(pr.lateral) + radius - face;
      if (depth <= 0) return null;
      if (pr.above > RAIL_HEIGHT + radius * 0.6 || pr.above < -3) return null;
      q.sample(pr.s, P, F, R, U);
      const sign = side === 1 ? 1 : -1;
      return {
        point: P.clone()
          .addScaledVector(R, face * sign)
          .addScaledVector(U, clamp(pr.above, 0, RAIL_HEIGHT)),
        normal: R.clone().multiplyScalar(-sign),
        depth,
        solid: true,
      };
    },

    gridSlot(index: number): GridSlot {
      const i = Math.max(0, Math.floor(index));
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const s = (total - (14 + row * 7.5)) % total;
      return poseAt(s, side * 3.7, 0.35);
    },

    respawnAt(t: number, lane = 0): GridSlot {
      return poseAt(safeS(wrap01(t) * total), clamp(lane, -1, 1) * 3.4, 1.6);
    },

    checkpointOf(t: number): number {
      return Math.min(CHECKPOINTS - 1, Math.floor(wrap01(t) * CHECKPOINTS));
    },

    scenicPose(index: number) {
      const s = scenic[((index % scenic.length) + scenic.length) % scenic.length];
      return { position: s.position.clone(), lookAt: s.lookAt.clone() };
    },

    scenicFov(index: number): number {
      return scenic[((index % scenic.length) + scenic.length) % scenic.length].fov;
    },

    racingLine,
  };

  ctx.services.track = service;
  ctx.emit("track:ready", { name: service.name, length: service.length });

  return {
    update(dt: number) {
      visuals.update(dt, ctx.elapsed, ctx.camera);
    },
    dispose() {
      ctx.scene.remove(visuals.root);
      ctx.scene.remove(fill);
      fill.dispose();
      visuals.dispose();
      ctx.camera.far = farWas;
      ctx.camera.updateProjectionMatrix();
      if (ctx.services.track === service) delete ctx.services.track;
    },
  };
}
