/**
 * Vibe Kart — SUNSET BLUFF SPEEDWAY.
 *
 * This module owns the course. It builds the centreline, the analytic surface
 * the physics probes, every mesh from the tarmac to the sea, and publishes
 * `ctx.services.track` synchronously so that every system booted after it —
 * physics, AI, items, minimap, scenery — finds a track waiting.
 *
 * Build order is load-bearing:
 *   spline   the arc-length table and rotation-minimising frames,
 *   ground   the land, which needs the spline to know where the road is,
 *   surface  the cross-section and the queries, which need both,
 *   ↳ and then `ground.setShelf` closes the loop, handing the land the road's
 *     real banked edge height so the terrain meets the apron exactly rather
 *     than six metres under it in the Quarry Bowl,
 *   meshes   ribbon → structures → terrain, all sharing one ring list.
 *
 * Everything hangs off one root Object3D, and `dispose` frees every geometry it
 * made. Materials come from `ctx.services.materials` and are *not* ours to free;
 * the handful this module has to invent (vertex-coloured turf, double-sided
 * rock) are owned by the resolver and freed with it.
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
import { ITEM_ROWS, SCENIC, SEGMENTS, placementS } from "./layout";
import { buildCurve, makeTrackFrame, type TrackCurve } from "./spline";
import { buildGround, SEA_LEVEL, type GroundField } from "./ground";
import { APRON_DROP, buildSurface, makeCross, makeSurfaceSample, type TrackSurface } from "./surface";
import { buildRings, buildRibbon } from "./ribbon";
import { buildStructures } from "./structures";
import { buildTerrain } from "./terrain";
import { MaterialResolver, clamp, lerp, wrap01 } from "./util";

/** Laps in a standard race, and how finely progress is validated. */
const LAPS = 3;
const CHECKPOINTS = 24;

/**
 * The published handle. `TrackService` is the contract; the extras below are
 * additive and every consumer is free to ignore them. They are declared here
 * rather than in `types.ts` because this module does not get to edit shared law.
 */
export interface KartTrackService extends TrackService {
  /** Resampled centreline: stations, frames, curvature. */
  curve: TrackCurve;
  /** The analytic cross-section and queries. */
  surface: TrackSurface;
  /** The terrain height field, for anything that wants to plant something. */
  ground: GroundField;
  /** World Y of the waterline. */
  seaLevel: number;
  /** Named sections, in lap order, with their arc ranges — anchors for scenery. */
  sections: Array<{ id: string; label: string; start: number; end: number }>;
  /** Suggested lateral offset of the racing line at `t`, in metres. */
  racingLine(t: number): number;
  /** How many beauty shots `scenicPose` can serve. */
  scenicCount: number;
  /** Field of view the beauty shot was framed for, in degrees. */
  scenicFov(index: number): number;
  /** The dirt cut: sampled centreline of the hairpin shortcut. */
  shortcutPath(): THREE.Vector3[];
}

export default function createTrack(ctx: KartCtx): System {
  const mats = new MaterialResolver(ctx.services);
  const quality = ctx.quality;

  const curve = buildCurve();
  const ground = buildGround(curve);
  const surface = buildSurface(curve, ground);

  // Close the loop between the road and the land: the corridor now grades to
  // the *banked* outer edge of the ribbon, minus the apron's drop.
  {
    const c = makeCross();
    const p = new THREE.Vector3();
    const f = new THREE.Vector3();
    const r = new THREE.Vector3();
    const u = new THREE.Vector3();
    ground.setShelf((s, lateral) => {
      surface.crossAt(s, c);
      curve.sample(s, p, f, r, u);
      const yAt = (l: number) => p.y + r.y * l + u.y * surface.profile(c, l);
      // The shelf follows the *shape* of the cross-section rather than one flat
      // plane, so the ground under the Quarry Bowl's banking sweeps up with it
      // instead of standing as a twenty-metre vertical wall with a stretched
      // rock texture on it. The 3 m lateral window is slack against projection
      // error: the ground has to be under the tarmac even when the nearest
      // station is a station out.
      const at = clamp(lateral, -c.driveL, c.driveR);
      let low = Infinity;
      for (let k = -2; k <= 2; k++) {
        low = Math.min(low, yAt(clamp(at + k * 1.5, -c.driveL, c.driveR)));
      }
      return low - APRON_DROP;
    });
  }

  const root = new THREE.Group();
  root.name = "track/Sunset Bluff Speedway";
  const geometries: THREE.BufferGeometry[] = [];

  const rings = buildRings(curve, quality);
  const ribbon = buildRibbon(curve, surface, mats, quality, rings);
  root.add(ribbon.root);
  geometries.push(...ribbon.geometries);

  const structures = buildStructures(curve, surface, ground, mats, quality, rings);
  root.add(structures.root);
  geometries.push(...structures.geometries);

  const terrain = buildTerrain(curve, ground, mats, quality);
  root.add(terrain.root);
  geometries.push(...terrain.geometries);

  ctx.scene.add(root);

  // ---------------------------------------------------------------------
  // Racing line — a smoothed apex-seeking lateral, published for the AI and
  // used here to string the coins along something worth driving.
  // ---------------------------------------------------------------------
  const line = new Float32Array(curve.count);
  {
    let peak = 1e-4;
    for (let i = 0; i < curve.count; i++) peak = Math.max(peak, Math.abs(curve.curvature[i]));
    for (let i = 0; i < curve.count; i++) {
      // Toward the inside in proportion to how hard the corner is.
      line[i] = clamp(curve.curvature[i] / peak, -1, 1) * curve.halfWidth[i] * 0.6;
    }
    // Smoothing over ~34 m is what turns "hug the apex" into a real line: it
    // pulls the entry wide and lets the exit run out.
    const R = Math.max(1, Math.round(34 / curve.ds));
    const src = line.slice();
    for (let i = 0; i < curve.count; i++) {
      let acc = 0;
      let w = 0;
      for (let k = -R; k <= R; k++) {
        const weight = 1 - Math.abs(k) / (R + 1);
        acc += src[(i + k + curve.count * 2) % curve.count] * weight;
        w += weight;
      }
      line[i] = acc / w;
    }
  }

  const racingLine = (t: number): number => {
    const idx = curve.indexAt(wrap01(t) * curve.length);
    const i0 = Math.floor(idx) % curve.count;
    const i1 = (i0 + 1) % curve.count;
    return lerp(line[i0], line[i1], idx - Math.floor(idx));
  };

  // ---------------------------------------------------------------------
  // Item boxes and coins
  // ---------------------------------------------------------------------
  const scratchFrame = makeTrackFrame();
  const scratchCross = makeCross();

  const scratchNormal = new THREE.Vector3();

  /** World point on the ribbon at (s, lateral), lifted along the road normal. */
  const onRoad = (s: number, lateral: number, lift: number, out: THREE.Vector3): THREE.Vector3 => {
    const f = curve.frameAtS(s, scratchFrame);
    surface.crossAt(s, scratchCross);
    const h = surface.profile(scratchCross, lateral);
    const slope = surface.profileSlope(scratchCross, lateral);
    scratchNormal.copy(f.up).addScaledVector(f.right, -slope).normalize();
    return out
      .copy(f.position)
      .addScaledVector(f.right, lateral)
      .addScaledVector(f.up, h)
      .addScaledVector(scratchNormal, lift);
  };

  const itemBoxes: ItemBoxSpec[] = [];
  for (const row of ITEM_ROWS) {
    const s = placementS(row);
    for (let k = -2; k <= 2; k++) {
      const lateral = (row.spread * k) / 2;
      const v = new THREE.Vector3();
      onRoad(s, lateral, 1.45, v);
      itemBoxes.push({ position: v, t: wrap01(s / curve.length), lateral });
    }
  }

  const coins: THREE.Vector3[] = [];
  {
    // Strung along the line in short runs with gaps, so they read as a route
    // rather than a dotted texture — and never on the jump or the plating.
    let s = 6;
    let inRun = 0;
    while (s < curve.length - 6) {
      const seg = SEGMENTS[curve.segmentAt(s)];
      const skip = seg.road === "gap" || seg.id === "kick" || seg.id === "land";
      if (!skip) {
        const v = new THREE.Vector3();
        onRoad(s, racingLine(s / curve.length), 1.0, v);
        coins.push(v);
      }
      inRun++;
      if (inRun >= 4) {
        inRun = 0;
        s += 34;
      } else {
        s += 5.5;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Grid, respawn, checkpoints
  // ---------------------------------------------------------------------
  const basis = new THREE.Matrix4();
  const negFwd = new THREE.Vector3();

  const poseAt = (s: number, lateral: number, lift: number): GridSlot => {
    const position = new THREE.Vector3();
    onRoad(s, lateral, lift, position);
    const f = curve.frameAtS(s, scratchFrame);
    negFwd.copy(f.forward).multiplyScalar(-1);
    basis.makeBasis(f.right, f.up, negFwd);
    return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(basis) };
  };

  /** Nudge an arc position off anything you cannot be respawned onto. */
  const safeS = (s: number): number => {
    let x = ((s % curve.length) + curve.length) % curve.length;
    for (let guard = 0; guard < 8; guard++) {
      const seg = SEGMENTS[curve.segmentAt(x)];
      if (seg.road !== "gap" && seg.id !== "kick") break;
      x = (curve.spanOf("kick").start - 26 + curve.length) % curve.length;
    }
    return x;
  };

  // ---------------------------------------------------------------------
  // Beauty shots
  // ---------------------------------------------------------------------
  const scenic = SCENIC.map((spec) => {
    const flat = new THREE.Vector3();
    const place = (seg: string, f: number, lateral: number, height: number) => {
      const s = placementS({ seg, f });
      const fr = curve.frameAtS(s, scratchFrame);
      curve.flatRightAt(s, flat);
      // Deliberately the *horizontal* frame: on the plating the road frame's up
      // points sideways, and a camera authored in it would be unusable.
      return new THREE.Vector3()
        .copy(fr.position)
        .addScaledVector(flat, lateral)
        .add(new THREE.Vector3(0, height, 0));
    };
    return {
      position: place(spec.from.seg, spec.from.f, spec.from.lateral, spec.height),
      lookAt: place(spec.to.seg, spec.to.f, spec.to.lateral, spec.toHeight),
      fov: spec.fov ?? 55,
      name: spec.name,
    };
  });

  // ---------------------------------------------------------------------
  // The service
  // ---------------------------------------------------------------------
  const service: KartTrackService = {
    name: "Sunset Bluff Speedway",
    length: curve.length,
    laps: LAPS,
    checkpointCount: CHECKPOINTS,
    root,
    itemBoxes,
    coins,
    curve,
    surface,
    ground,
    seaLevel: SEA_LEVEL,
    scenicCount: scenic.length,

    sections: SEGMENTS.map((seg, i) => ({
      id: seg.id,
      label: seg.label,
      start: curve.segStart[i],
      end: curve.segStart[i + 1],
    })),

    frameAt(t: number, out?: TrackFrame): TrackFrame {
      return curve.frameAt(t, out);
    },

    project(position: THREE.Vector3, hint?: number) {
      const pr = curve.project(position, hint);
      return { t: pr.t, lateral: pr.lateral, height: pr.height };
    },

    surfaceAt(position: THREE.Vector3, hint?: number, out?: SurfaceSample): SurfaceSample {
      return surface.surfaceAt(position, hint, out ?? makeSurfaceSample());
    },

    wallAt(position: THREE.Vector3, radius: number, hint?: number): WallHit | null {
      return surface.wallAt(position, radius, hint);
    },

    gridSlot(index: number): GridSlot {
      const i = Math.max(0, Math.floor(index));
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      // Staggered two abreast, 7.5 m apart, starting 14 m back from the line —
      // which puts the whole grid on the pit straight, under the gantry.
      const s = (curve.length - (14 + row * 7.5)) % curve.length;
      return poseAt(s, side * 3.7, 0.35);
    },

    respawnAt(t: number, lane = 0): GridSlot {
      return poseAt(safeS(wrap01(t) * curve.length), clamp(lane, -1, 1) * 3.4, 1.6);
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

    shortcutPath(): THREE.Vector3[] {
      const sc = surface.shortcut;
      const out: THREE.Vector3[] = [];
      for (let i = 0; i < sc.count; i++) {
        out.push(new THREE.Vector3(sc.pos[i * 3], sc.pos[i * 3 + 1], sc.pos[i * 3 + 2]));
      }
      return out;
    },
  };

  ctx.services.track = service;
  // Scenery, minimap and the shot harness all want to know the course exists
  // before they start placing things; the boot order guarantees it, and this
  // lets anything hot-reloaded find out too.
  ctx.emit("track:ready", { name: service.name, length: service.length });

  return {
    dispose() {
      ctx.scene.remove(root);
      for (const g of geometries) g.dispose();
      geometries.length = 0;
      mats.dispose();
      if (ctx.services.track === service) delete ctx.services.track;
    },
  };
}
