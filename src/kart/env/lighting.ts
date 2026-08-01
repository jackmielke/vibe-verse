/**
 * The lighting rig — three-point, not one lamp.
 *
 * A single directional light is what a prototype looks like: every surface
 * facing away from it collapses into the same flat ambient grey and the karts
 * lose their silhouettes against the scenery. The rig here is the same one a
 * portrait photographer would set up:
 *
 *   · **key**    the sun. Warm, hard, the only shadow caster.
 *   · **fill**   a hemisphere, sky above and bounced ground below, so
 *                upward-facing surfaces read cool and undersides read warm.
 *   · **rim**    a cool counter-key from the anti-sun side, ~35° up. This is
 *                the light doing the actual work on silhouette readability.
 *   · **bounce** a warm, weak light coming back *up* off the tarmac into the
 *                kart bellies and driver chins.
 *
 * ## The shadow camera follows the player
 * A directional shadow map covering the whole course at 2048² would give each
 * kart about four texels. Instead the ortho frustum is a ~90 m box that chases
 * the player, biased in the direction the camera is looking, which puts every
 * texel where someone can actually see it. Two details make that survivable:
 *
 *   · the focus point is **snapped to whole shadow texels** in the light's own
 *     screen plane, otherwise the entire shadow map re-samples every frame and
 *     every shadow edge crawls — the single most common tell of a hand-rolled
 *     cascade;
 *   · `normalBias` is set in world units just over one texel, which kills
 *     acne on curved bodywork without the peter-panning a large depth `bias`
 *     would introduce under the karts.
 */
import * as THREE from "three";
import type { KartQuality } from "../types";
import type { AtmosphereState } from "./atmosphere";

interface ShadowProfile {
  /** Shadow map resolution, 0 = no shadows at all. */
  size: number;
  /** Half-extent of the ortho frustum in metres. */
  extent: number;
}

const SHADOWS: Record<KartQuality, ShadowProfile> = {
  low: { size: 0, extent: 0 },
  medium: { size: 1024, extent: 38 },
  high: { size: 2048, extent: 46 },
  ultra: { size: 4096, extent: 54 },
};

export interface LightRig {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  rim: THREE.DirectionalLight | null;
  bounce: THREE.DirectionalLight | null;
  ambient: THREE.AmbientLight;
  /** Re-aim the key light's shadow box around a focus point. */
  focus(point: THREE.Vector3, viewDir: THREE.Vector3): void;
  applyAtmosphere(s: AtmosphereState): void;
  /** IBL present ⇒ the analytic ambient steps back so nothing double-counts. */
  setEnvironmentPresent(present: boolean): void;
  dispose(): void;
}

export function createLightRig(scene: THREE.Scene, quality: KartQuality): LightRig {
  const profile = SHADOWS[quality];
  const rich = quality !== "low";

  const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
  sun.name = "kart-sun";
  sun.castShadow = profile.size > 0;
  if (sun.castShadow) {
    sun.shadow.mapSize.set(profile.size, profile.size);
    const cam = sun.shadow.camera;
    cam.left = -profile.extent;
    cam.right = profile.extent;
    cam.top = profile.extent;
    cam.bottom = -profile.extent;
    cam.near = 1;
    cam.far = profile.extent * 6 + 120;
    cam.updateProjectionMatrix();
    // VSM (ultra) filters in depth-variance space and does not want a depth
    // bias at all; PCF does, but only a hair of one — the normal offset is
    // doing the real work.
    const vsm = quality === "ultra";
    sun.shadow.bias = vsm ? -0.00008 : -0.00022;
    sun.shadow.normalBias = vsm ? 0.022 : (profile.extent * 2) / profile.size + 0.012;
    sun.shadow.radius = vsm ? 2.5 : 1.15;
    sun.shadow.blurSamples = 8;
  }
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0x9fc9f2, 0x7a6d52, 0.5);
  hemi.name = "kart-fill";
  scene.add(hemi);

  // A floor under the darkest shadows. Small on purpose: it exists so nothing
  // in the frame ever reaches literal black, not to light the scene.
  const ambient = new THREE.AmbientLight(0x2c3550, 0.12);
  scene.add(ambient);

  let rim: THREE.DirectionalLight | null = null;
  let bounce: THREE.DirectionalLight | null = null;
  if (rich) {
    rim = new THREE.DirectionalLight(0x8fc4ff, 0.5);
    rim.name = "kart-rim";
    scene.add(rim, rim.target);

    bounce = new THREE.DirectionalLight(0xffc07a, 0.35);
    bounce.name = "kart-bounce";
    scene.add(bounce, bounce.target);
  }

  // --- shadow focus scratch -------------------------------------------------
  const focusPoint = new THREE.Vector3();
  const lightAxis = new THREE.Vector3(0, 1, 0);
  const axisRight = new THREE.Vector3();
  const axisUp = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const fallbackUp = new THREE.Vector3(0, 0, 1);
  const rimOffset = new THREE.Vector3(0, 60, 0);
  const bounceOffset = new THREE.Vector3(0, -40, 0);
  const texelStep = profile.size > 0 ? (profile.extent * 2) / profile.size : 0;
  let envPresent = false;
  let state: AtmosphereState | null = null;

  function focus(point: THREE.Vector3, viewDir: THREE.Vector3): void {
    // Bias the box toward whatever the camera is pointing at: the player sits
    // in the near third of the screen, so centring the frustum on the kart
    // wastes two thirds of the map behind them.
    focusPoint.copy(point).addScaledVector(viewDir, profile.extent * 0.42);
    focusPoint.y += 1.5;

    const dist = profile.extent * 2.6 + 60;
    if (profile.size > 0 && texelStep > 0) {
      // Snap in the light's own screen plane so the depth map re-projects onto
      // itself frame to frame and the shadow edges stop crawling.
      const up = Math.abs(lightAxis.y) > 0.985 ? fallbackUp : worldUp;
      axisRight.crossVectors(up, lightAxis).normalize();
      axisUp.crossVectors(lightAxis, axisRight).normalize();
      const dx = focusPoint.dot(axisRight);
      const dy = focusPoint.dot(axisUp);
      focusPoint
        .addScaledVector(axisRight, Math.round(dx / texelStep) * texelStep - dx)
        .addScaledVector(axisUp, Math.round(dy / texelStep) * texelStep - dy);
    }

    sun.target.position.copy(focusPoint);
    sun.position.copy(focusPoint).addScaledVector(lightAxis, dist);
    // The rig's fill lights are direction-only, but keeping them near the
    // action costs nothing and keeps any future shadow-casting fill honest.
    if (rim) {
      rim.target.position.copy(focusPoint);
      rim.position.copy(focusPoint).add(rimOffset);
    }
    if (bounce) {
      bounce.target.position.copy(focusPoint);
      bounce.position.copy(focusPoint).add(bounceOffset);
    }
  }

  function applyAtmosphere(s: AtmosphereState): void {
    state = s;
    lightAxis.copy(s.direction);

    sun.color.copy(s.keyColor);
    sun.intensity = s.keyIntensity;
    // Fog steals contrast from the key and hands it to the ambient; letting
    // the key keep its full punch through thick haze looks like a compositing
    // error, because it is one.
    sun.intensity *= 1 - Math.min(0.35, s.turbidity * 0.03);

    hemi.color.copy(s.skyColor);
    hemi.groundColor.copy(s.groundColor);
    hemi.intensity = s.fillIntensity * (envPresent ? 0.55 : 1.35);

    ambient.color.copy(s.skyColor);
    ambient.intensity = envPresent ? 0.05 : 0.16 + s.night * 0.05;

    if (rim) {
      rim.color.copy(s.rimColor);
      rim.intensity = s.rimIntensity * (envPresent ? 0.85 : 1.1);
      // Opposite azimuth, lifted ~35°: raking across the far side of every
      // kart rather than staring straight down the anti-sun axis.
      rimOffset.set(-s.direction.x, 0, -s.direction.z).setLength(70).setY(52);
    }
    if (bounce) {
      bounce.color.copy(s.bounceColor);
      bounce.intensity = s.bounceIntensity;
      // Up off the road, tilted back toward the sun so the warm kick lands on
      // the side the eye already expects to be warm.
      bounceOffset.set(s.direction.x, 0, s.direction.z).setLength(30).setY(-46);
    }
  }

  return {
    sun,
    hemi,
    rim,
    bounce,
    ambient,
    focus,
    applyAtmosphere,
    setEnvironmentPresent(present: boolean) {
      envPresent = present;
      if (state) applyAtmosphere(state);
    },
    dispose() {
      scene.remove(sun, sun.target, hemi, ambient);
      sun.dispose();
      hemi.dispose();
      ambient.dispose();
      if (rim) {
        scene.remove(rim, rim.target);
        rim.dispose();
      }
      if (bounce) {
        scene.remove(bounce, bounce.target);
        bounce.dispose();
      }
    },
  };
}
