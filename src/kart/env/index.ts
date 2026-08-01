/**
 * Vibe Kart — sky, sun, IBL, fog and the lighting rig.
 *
 * This module owns everything above and around the track: the atmosphere the
 * course sits in, the light that falls on it, the reflections in its chrome and
 * the haze that eats its horizon. It publishes `ctx.services.env` and touches
 * nothing else — the rest of the game reads the sun direction off the service
 * and lets `scene.environment` do the work.
 *
 * Boot order matters here and it is deliberate:
 *   1. patch the fog chunks (must happen before the first program compiles),
 *   2. build the light rig and publish the service *immediately*, so anything
 *      booting after us finds a `sun` and a `sunDirection` even if the heavy
 *      work below throws,
 *   3. bake the clouds and cook the first PMREM.
 *
 * Per frame the cost is: one uniform write for cloud scroll, one shadow-camera
 * re-aim, and one projection of the sun into screen space for the post stack.
 * The scattering, the cloud field and the IBL are all baked, and are only ever
 * redone when `timeOfDay` actually changes.
 */
import * as THREE from "three";
import type { EnvironmentService, KartCtx, PhysicsService, System } from "../types";
import {
  computeAtmosphere,
  GOLDEN_HOUR,
  applyAtmosphere,
  type AtmosphereState,
} from "./atmosphere";
import { createSkyDome } from "./sky";
import { createClouds } from "./clouds";
import { createLightRig } from "./lighting";
import { createIbl } from "./ibl";
import { patchFogChunks, restoreFogChunks } from "./fog";

/**
 * The published handle. `EnvironmentService` is the contract every other
 * system codes against; the extra fields below are additive and optional —
 * read them if they are there, and nothing breaks if this module never booted.
 *
 * (These extensions are declared here rather than in `types.ts` on purpose:
 * `types.ts` is shared law and this module does not get to rewrite it.)
 */
export interface KartEnvironmentService extends EnvironmentService {
  /** Warm key-light colour, matching `sun.color`. */
  keyColor: THREE.Color;
  /** Fog / horizon colour in render-linear units — for the grade to key off. */
  hazeColor: THREE.Color;
  /** A world point far along the sun direction from the camera. God rays. */
  sunWorldPosition: THREE.Vector3;
  /** Sun position in [0,1] screen UV. Only meaningful when `sunOnScreen`. */
  sunScreen: THREE.Vector2;
  sunOnScreen: boolean;
  /** 0 by day, 1 at full night. */
  night: number;
  /** 0 with the sun on the horizon, 1 with it high. */
  dayness: number;
  hemisphere: THREE.HemisphereLight;
  fog: THREE.FogExp2 | null;
  /** Move the sun. Rebakes the IBL unless quality is 'low'. */
  setTimeOfDay(value: number, rebake?: boolean): void;
  /** Force a fresh PMREM cook (after a track swaps its ground colours, say). */
  rebake(): void;
}

export default function createEnvironment(ctx: KartCtx): System {
  const quality = ctx.quality;

  // Height fog has to be installed before anything compiles a program.
  const fogPatched = patchFogChunks();

  // --- lights + service, published before anything expensive can fail ------
  const rig = createLightRig(ctx.scene, quality);
  const state: AtmosphereState = computeAtmosphere(GOLDEN_HOUR);

  const fog = new THREE.FogExp2(0x000000, state.fogDensity);
  fog.color.copy(state.hazeColor);
  ctx.scene.fog = fog;

  const service: KartEnvironmentService = {
    envMap: null,
    sun: rig.sun,
    timeOfDay: GOLDEN_HOUR,
    sunDirection: state.direction.clone(),
    keyColor: state.keyColor.clone(),
    hazeColor: state.hazeColor.clone(),
    sunWorldPosition: new THREE.Vector3(),
    sunScreen: new THREE.Vector2(0.5, 0.5),
    sunOnScreen: false,
    night: state.night,
    dayness: state.dayness,
    hemisphere: rig.hemi,
    fog,
    setTimeOfDay(value: number, rebake = true) {
      const t = ((value % 1) + 1) % 1;
      if (Math.abs(t - service.timeOfDay) < 1e-5) return;
      service.timeOfDay = t;
      computeAtmosphere(t, state);
      pushState();
      // A PMREM cook is ~6 cube faces plus a mip chain. Worth it when the sun
      // genuinely moves; never worth it on the tier that is already struggling.
      if (rebake && quality !== "low") cookIbl();
      ctx.emit("env:changed", { timeOfDay: t });
    },
    rebake() {
      cookIbl();
    },
  };
  ctx.services.env = service;

  // --- sky, clouds, IBL ---------------------------------------------------
  const sky = createSkyDome(quality);
  ctx.scene.add(sky.mesh);

  const clouds = createClouds(quality, Math.floor(ctx.rng() * 0xffff) ^ 0x5c1f);
  ctx.scene.add(clouds.root);

  const ibl = createIbl(ctx.renderer, sky.makeProxy());

  function cookIbl(): void {
    const tex = ibl.bake();
    service.envMap = tex;
    ctx.scene.environment = tex;
    rig.setEnvironmentPresent(tex !== null);
    if (tex) ctx.emit("env:ready", { envMap: tex });
  }

  /** Fan the current atmosphere state out to everything that consumes it. */
  function pushState(): void {
    applyAtmosphere(sky.uniforms, state);
    clouds.applyAtmosphere(state);
    rig.applyAtmosphere(state);

    service.sunDirection.copy(state.direction);
    service.keyColor.copy(state.keyColor);
    service.hazeColor.copy(state.hazeColor);
    service.night = state.night;
    service.dayness = state.dayness;

    fog.color.copy(state.hazeColor);
    fog.density = state.fogDensity;
  }

  pushState();
  cookIbl();

  // --- per-frame scratch --------------------------------------------------
  const camPos = new THREE.Vector3();
  const viewDir = new THREE.Vector3();
  const focusPoint = new THREE.Vector3();
  const ndc = new THREE.Vector3();

  return {
    update(dt: number) {
      sky.uniforms.uTime.value = ctx.elapsed;
      clouds.update(dt, ctx.camera);
    },

    lateUpdate() {
      ctx.camera.getWorldPosition(camPos);

      // The dome rides with the camera. Scale, not position, is what makes the
      // one-frame lag here irrelevant — see the note in sky.ts.
      sky.mesh.position.copy(camPos);
      sky.mesh.updateMatrix();

      // Aim the shadow box at the player, biased along the view. Falling back
      // to the camera keeps shadows sharp even if physics never booted.
      const physics = ctx.services.physics as PhysicsService | undefined;
      const player = physics?.player;
      focusPoint.copy(player ? player.position : camPos);
      ctx.camera.getWorldDirection(viewDir);
      viewDir.y = 0;
      if (viewDir.lengthSq() < 1e-6) viewDir.set(0, 0, -1);
      else viewDir.normalize();
      rig.focus(focusPoint, viewDir);

      // Screen-space sun for the god-ray pass. Half the far plane keeps the
      // point inside the frustum so `project` stays well conditioned.
      service.sunWorldPosition
        .copy(camPos)
        .addScaledVector(state.direction, ctx.camera.far * 0.4);
      ndc.copy(service.sunWorldPosition).project(ctx.camera);
      service.sunScreen.set(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5);
      // Behind-the-camera projections mirror back into range, so the depth
      // test is the one that actually decides visibility.
      service.sunOnScreen =
        ndc.z > -1 &&
        ndc.z < 1 &&
        state.altitude > -0.02 &&
        service.sunScreen.x > -0.4 &&
        service.sunScreen.x < 1.4 &&
        service.sunScreen.y > -0.4 &&
        service.sunScreen.y < 1.4;
    },

    dispose() {
      ctx.scene.remove(sky.mesh);
      sky.dispose();
      clouds.dispose();
      ibl.dispose();
      rig.dispose();
      service.envMap = null;
      ctx.scene.environment = null;
      ctx.scene.fog = null;
      if (fogPatched) restoreFogChunks();
      if (ctx.services.env === service) delete ctx.services.env;
    },
  };
}
