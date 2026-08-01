/**
 * Vibe Kart — trackside dressing: stands, crowd, foliage, signage, props.
 *
 * This system owns everything beside the road and everything on the horizon —
 * the things that turn a ribbon of tarmac into a place a race is happening at.
 * It reads the track's spline and writes nothing back; if the track failed to
 * boot it dresses a stand-in circuit instead of throwing, because a missing
 * neighbour must cost detail and never the race.
 *
 * The shape of the module:
 *
 *   util / textures / wind   the kit: geometry helpers, canvas bakers, the
 *                            vertex-animation patches every instanced thing
 *                            shares
 *   layout                   the resampled centreline, clearance queries and
 *                            the scatter that rejects anything landing on road
 *   field                    sectorised `InstancedMesh` batching and culling
 *   mats                     the eleven materials that dress the whole circuit
 *   stands / gantry / props / flora / landmarks / skylife
 *                            the builders, each a pure function of the build
 *                            context
 *
 * Budget, measured at `high`: roughly 30 000 instances across ~20 kinds, about
 * 40 instanced draw calls visible on a chase-camera frame plus a dozen hero
 * props, and 600–700 k triangles. Nothing is animated on the CPU except the
 * Ferris wheel's gondolas, the balloons, the blimp and the flock.
 *
 * Published as `ctx.services.scenery`.
 */
import * as THREE from "three";
import type { KartCtx, System, TrackService } from "../types";
import { DENSITY, type BuildCtx, type ScenePlan, type SceneryPiece } from "./build";
import { SceneryField } from "./field";
import { TrackSampler } from "./layout";
import { createSceneryMaterials } from "./mats";
import { buildStands } from "./stands";
import { buildGantry, type GantryHandle } from "./gantry";
import { buildProps } from "./props";
import { buildFlora } from "./flora";
import { buildLandmarks } from "./landmarks";
import { buildSkyLife } from "./skylife";
import { Resources, clamp01, makeRng } from "./util";
import { createSceneryUniforms } from "./wind";

export interface SceneryStats {
  kinds: number;
  meshes: number;
  instances: number;
  triangles: number;
}

/**
 * The published handle.
 *
 * `root`/`update` are the contract every consumer can rely on; the rest is
 * additive and safe to ignore. (Declared here rather than in `types.ts`, which
 * is shared law this module does not get to rewrite.)
 */
export interface SceneryService {
  root: THREE.Object3D;
  /**
   * Advance the dressing. The engine already calls this once a frame through
   * the system's own `update`; it is exposed so a harness posing a still frame
   * can settle the animation without running the whole engine.
   */
  update(dt: number): void;
  /** 0..5 bulbs lit on the start gantry. Zero from lit plays the GO flash. */
  setStartLights(n: number): void;
  /** 0..1 crowd energy: bob amplitude, jump frequency, Mexican wave strength. */
  setCrowdExcitement(value: number): void;
  /** Turn distance/frustum culling off so a scenic pose sees the whole world. */
  setCulling(enabled: boolean): void;
  /** Wind direction in world XZ and its gust strength — shared with the sky. */
  readonly wind: THREE.Vector2;
  readonly stats: SceneryStats;
}

export default function createScenery(ctx: KartCtx): System {
  const quality = ctx.quality;
  const density = DENSITY[quality];
  const res = new Resources();
  const uniforms = createSceneryUniforms();
  const field = new SceneryField();

  const root = new THREE.Group();
  root.name = "scenery";
  root.matrixAutoUpdate = false;
  root.add(field.root);
  ctx.scene.add(root);

  // Published before anything expensive can fail. A consumer that boots after
  // us and finds an empty root is a missing tree; one that finds `undefined`
  // is a crash.
  const service: SceneryService = {
    root,
    update: () => {},
    setStartLights: () => {},
    setCrowdExcitement: (v: number) => {
      excitementFloor = clamp01(v);
    },
    setCulling: (enabled: boolean) => {
      culling = enabled;
      if (!enabled) field.revealAll();
    },
    wind: uniforms.uWind.value,
    stats: { kinds: 0, meshes: 0, instances: 0, triangles: 0 },
  };
  ctx.services.scenery = service;

  let culling = true;
  let excitementFloor = 0.28;
  let excitementPulse = 0;
  let gantry: GantryHandle | null = null;
  const pieces: SceneryPiece[] = [];
  const offs: Array<() => void> = [];

  const sampler = new TrackSampler(ctx.services.track as TrackService | undefined);
  uniforms.uCentre.value.copy(sampler.centre);
  if (!sampler.real) {
    console.warn("[Vibe Kart/scenery] no track service; dressing a stand-in circuit");
  }

  const mats = createSceneryMaterials(quality, ctx.services as Record<string, unknown>, uniforms, res);

  const plan: ScenePlan = { stands: [], keepOut: [], startT: 0 };

  const b: BuildCtx = {
    ctx,
    quality,
    density,
    sampler,
    field,
    mats,
    uniforms,
    res,
    root,
    plan,
    rng: (name: string) => makeRng(`kart/scenery/${name}`),
  };

  /**
   * Order matters, and only in one direction: anything that writes `keepOut`
   * has to run before the scatters that read it. Stands claim their footprint,
   * the gantry claims the start straight, the arches claim their spans — and
   * only then does the vegetation fill in around them.
   */
  const stage = <T extends SceneryPiece>(name: string, build: (c: BuildCtx) => T): T | null => {
    try {
      const piece = build(b);
      pieces.push(piece);
      return piece;
    } catch (err) {
      // One failed builder costs its own props. It must not cost the crowd.
      console.error(`[Vibe Kart/scenery] "${name}" failed to build:`, err);
      return null;
    }
  };

  stage("landmarks", buildLandmarks);
  stage("stands", buildStands);
  gantry = stage("gantry", buildGantry);
  stage("props", buildProps);
  stage("flora", buildFlora);
  stage("skylife", buildSkyLife);

  field.build();
  const fieldStats = field.stats();
  service.stats.kinds = fieldStats.kinds;
  service.stats.meshes = fieldStats.meshes;
  service.stats.instances = fieldStats.instances;
  service.stats.triangles = fieldStats.triangles;

  if (gantry) {
    const g = gantry;
    service.setStartLights = (n: number) => g.setStartLights(n);
  }

  // --- race wiring ---------------------------------------------------------
  // Driven off the event bus rather than by polling `services.race`, so the
  // gantry lights work even if the race system publishes nothing.
  offs.push(
    ctx.on("race:countdown", ((payload: unknown) => {
      const count = (payload as { count?: number } | undefined)?.count;
      if (typeof count !== "number") return;
      // 3 → one bulb, 2 → three, 1 → all five, 0 → out and green. The rig fills
      // as the clock runs down, which is the beat every racing game uses.
      const map: Record<number, number> = { 3: 1, 2: 3, 1: 5, 0: 0 };
      service.setStartLights(map[count] ?? 0);
      excitementPulse = Math.max(excitementPulse, 0.45);
    }) as (p: never) => void),
  );
  offs.push(
    ctx.on("race:start", (() => {
      service.setStartLights(0);
      excitementPulse = 1;
    }) as (p: never) => void),
  );
  offs.push(
    ctx.on("race:lap", (() => {
      excitementPulse = Math.max(excitementPulse, 0.75);
    }) as (p: never) => void),
  );
  offs.push(
    ctx.on("race:finish", (() => {
      excitementPulse = 1;
    }) as (p: never) => void),
  );
  // The crowd reacts to the racing, not just to the clock: a mini-turbo through
  // a corner in front of a grandstand should get a rise out of it.
  for (const event of ["kart:miniTurbo", "kart:trick", "kart:hit"] as const) {
    offs.push(
      ctx.on(event, (() => {
        excitementPulse = Math.max(excitementPulse, 0.6);
      }) as (p: never) => void),
    );
  }

  // --- per-frame -----------------------------------------------------------
  const camPos = new THREE.Vector3();
  const frustum = new THREE.Frustum();
  const viewProj = new THREE.Matrix4();
  let gustPhase = ctx.rng() * 100;

  const tick = (dt: number) => {
    const elapsed = ctx.elapsed;
    uniforms.uTime.value = elapsed;
    ctx.camera.getWorldPosition(camPos);

    // Gusts: two slow, non-harmonic sines so the wind never settles into a
    // pulse you can count along with. The direction swings a little with it,
    // because a breeze that only changes strength reads as a fan.
    gustPhase += dt;
    const gust = 0.78 + Math.sin(gustPhase * 0.19) * 0.34 + Math.sin(gustPhase * 0.071 + 1.3) * 0.22;
    uniforms.uGust.value = Math.max(0.25, gust);
    const swing = Math.sin(gustPhase * 0.043) * 0.35;
    uniforms.uWind.value.set(Math.cos(0.62 + swing), Math.sin(0.62 + swing));

    excitementPulse = Math.max(0, excitementPulse - dt * 0.28);
    uniforms.uExcite.value = clamp01(excitementFloor + excitementPulse);

    for (const piece of pieces) piece.update?.(dt, elapsed, camPos);

    if (culling) {
      viewProj.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProj);
      field.update(camPos, frustum);
    }
  };

  service.update = tick;

  return {
    update(dt) {
      tick(dt);
    },

    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      for (const piece of pieces) piece.dispose?.();
      pieces.length = 0;
      field.dispose();
      root.removeFromParent();
      root.clear();
      // Only what this module allocated. Materials borrowed from the shared
      // library are not ours to free and are deliberately not in the pool.
      res.dispose();
      if (ctx.services.scenery === service) delete ctx.services.scenery;
    },
  };
}
