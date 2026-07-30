/**
 * The post-processing pipeline for San Francisco: FREE FALL.
 *
 * One component owns the whole chain: buffer formats, pass order, per-frame
 * uniform sync, TAA jitter, and the quality-tier gating. Everything upstream of
 * it renders plain linear HDR and knows nothing about any of this.
 *
 * ── Pass order, and why it is this order ──────────────────────────────────
 *
 *   RenderPass          scene → HalfFloat HDR
 *   VelocityPass        camera + per-object motion vectors
 *   GTAO / SSR / Fog    all depth-driven, all blended in HDR *before* AA so
 *                       that TAA gets to integrate their stochastic sampling
 *   TAA                 (or SMAA/FXAA at the end when TAA is off)
 *   Motion blur         after TAA: blurring the history is how you get smear
 *   Heat haze           a UV distortion, so it must precede DoF and bloom
 *   Depth of field      defocus before bloom, so defocused highlights bloom
 *   Grade               bloom composite → exposure → ACES → LUT → lens → sRGB
 *
 * ── HDR ──────────────────────────────────────────────────────────────────
 * Every intermediate buffer is `HalfFloatType`. three skips its own tonemap and
 * colour-space conversion whenever it renders into a render target, so the
 * chain carries scene-referred radiance the whole way and only the final effect
 * maps it to display. Put a single UnsignedByte buffer anywhere before that and
 * bloom bands, volumetrics posterise, and the LUT gets a clipped input.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  EffectComposer,
  EffectPass,
  RenderPass,
  FXAAEffect,
  SMAAEffect,
  SMAAPreset,
  EdgeDetectionMode,
} from "postprocessing";

import { QUALITY, type QualityTier } from "../config";
import { frame, useSfStore } from "../state/store";
import { clamp01, damp } from "../math/rng";

import {
  bindShadowMap,
  envUniforms,
  rollEnvHistory,
  updateEnvAtmosphere,
  updateEnvCamera,
} from "./env";
import { postFx, postfx, type PostFxHandle } from "./state";
import { makeBlueNoiseTexture, makeLensDirtTexture } from "./textures";
import { BlendableLut, lookWeightsForHour } from "./lut";
import { VelocityPass } from "./velocity";
import { TaaPass } from "./taa";
import { GtaoEffect } from "./gtao";
import { SsrEffect } from "./ssr";
import { VolumetricLightEffect } from "./volumetrics";
import { BloomPyramid } from "./bloom";
import { DepthOfFieldEffect } from "./dof";
import { MotionBlurEffect } from "./motionBlur";
import { HeatHazeEffect } from "./heatHaze";
import { GradeEffect } from "./grade";

/* ------------------------------------------------------------------ *
 * Per-tier chain
 * ------------------------------------------------------------------ */

interface Chain {
  composer: EffectComposer;
  velocity: VelocityPass | null;
  taa: TaaPass | null;
  gtao: GtaoEffect | null;
  ssr: SsrEffect | null;
  volumetrics: VolumetricLightEffect | null;
  dof: DepthOfFieldEffect | null;
  dofPass: EffectPass | null;
  motionBlur: MotionBlurEffect | null;
  motionBlurPass: EffectPass | null;
  heat: HeatHazeEffect | null;
  heatPass: EffectPass | null;
  grade: GradeEffect;
  dispose(): void;
}

function buildChain(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  tier: QualityTier,
  dirt: THREE.Texture,
): Chain {
  const q = QUALITY[tier];

  const composer = new EffectComposer(gl, {
    // HDR end to end. This is the single most important line in the file.
    frameBufferType: THREE.HalfFloatType,
    // MSAA is pointless here: TAA resolves geometric edges, and multisampling a
    // half-float target costs bandwidth we would rather spend on volumetrics.
    multisampling: 0,
    depthBuffer: true,
    stencilBuffer: false,
  });
  composer.autoRenderToScreen = true;

  composer.addPass(new RenderPass(scene, camera));

  const wantsVelocity = q.taa || q.motionBlur || q.ssao || q.ssr || q.volumetrics;
  const velocity = wantsVelocity ? new VelocityPass(camera) : null;
  if (velocity) composer.addPass(velocity);

  /* ---- depth-driven effects, merged into one pass ---- */
  const gtao = q.ssao
    ? new GtaoEffect({
        slices: tier === "ultra" ? 3 : 2,
        steps: Math.max(4, Math.round(q.ssaoSamples / 2)),
        radius: 2.4,
        thickness: 0.6,
        power: 1.4,
        intensity: 0.92,
        resolutionScale: tier === "ultra" ? 1 : 0.5,
      })
    : null;

  const ssr = q.ssr
    ? new SsrEffect({
        steps: tier === "ultra" ? 40 : 26,
        maxDistance: 190,
        thickness: 0.6,
        resolutionScale: 0.5,
      })
    : null;

  const volumetrics = q.volumetrics
    ? new VolumetricLightEffect({
        steps: q.volumetricSteps,
        resolutionScale: tier === "ultra" ? 0.75 : 0.5,
        fogHeight: 170,
        fogFloor: -10,
        anisotropy: 0.74,
        extinction: 0.0042,
        maxDistance: Math.min(2600, q.drawDistance * 0.4),
      })
    : null;

  const depthEffects = [gtao, ssr, volumetrics].filter(Boolean) as (
    | GtaoEffect
    | SsrEffect
    | VolumetricLightEffect
  )[];
  if (depthEffects.length > 0) {
    composer.addPass(new EffectPass(camera, ...depthEffects));
  }

  /* ---- temporal AA ---- */
  const taa = q.taa
    ? new TaaPass(velocity ? velocity.renderTarget.texture : null, {
        feedback: 0.92,
        clampGamma: 1.25,
        sampleCount: tier === "ultra" ? 16 : 8,
      })
    : null;
  if (taa) composer.addPass(taa);

  /* ---- motion blur ---- */
  const motionBlur =
    q.motionBlur && velocity
      ? new MotionBlurEffect(velocity.renderTarget.texture, {
          samples: tier === "ultra" ? 16 : 10,
          tileSize: 20,
          intensity: 1,
        })
      : null;
  const motionBlurPass = motionBlur ? new EffectPass(camera, motionBlur) : null;
  if (motionBlurPass) composer.addPass(motionBlurPass);

  /* ---- heat haze: allocated everywhere but low, enabled only when live ---- */
  const heat = tier === "low" ? null : new HeatHazeEffect();
  const heatPass = heat ? new EffectPass(camera, heat) : null;
  if (heatPass) {
    heatPass.enabled = false;
    composer.addPass(heatPass);
  }

  /* ---- depth of field ---- */
  const dof = q.depthOfField
    ? new DepthOfFieldEffect({
        samples: tier === "ultra" ? 48 : 32,
        maxCoC: tier === "ultra" ? 30 : 22,
        resolutionScale: 0.5,
      })
    : null;
  const dofPass = dof ? new EffectPass(camera, dof) : null;
  if (dofPass) {
    dofPass.enabled = false;
    composer.addPass(dofPass);
  }

  /* ---- final grade (owns bloom) ---- */
  const bloom = q.bloom
    ? new BloomPyramid({
        threshold: 1.0,
        softKnee: 0.55,
        scatter: 0.72,
        mips: tier === "low" ? 4 : 6,
        lensFlare: q.lensEffects,
        anamorphic: q.lensEffects && tier !== "low",
      })
    : null;

  // The LUT is built per chain rather than shared: `Effect.dispose` is called
  // for us when the composer is torn down on a quality change, and a shared
  // lattice would be disposed out from under the next chain.
  const grade = new GradeEffect({ lut: new BlendableLut(), dirtTexture: dirt, bloom });
  composer.addPass(new EffectPass(camera, grade));

  /* ---- spatial AA fallback when TAA is off ---- */
  if (!q.taa) {
    // Run after the grade, on the tonemapped image: edge detection on HDR
    // radiance finds "edges" between 40 and 400 nits that the eye cannot see,
    // and misses the ones it can.
    const aa =
      tier === "low"
        ? new FXAAEffect()
        : new SMAAEffect({
            preset: SMAAPreset.HIGH,
            edgeDetectionMode: EdgeDetectionMode.COLOR,
          });
    composer.addPass(new EffectPass(camera, aa));
  }

  // Wire the velocity texture into everything that reprojects.
  if (velocity) {
    const vt = velocity.renderTarget.texture;
    taa?.setVelocityTexture(vt);
    gtao?.setVelocityTexture(vt);
    ssr?.setVelocityTexture(vt);
    volumetrics?.setVelocityTexture(vt);
    motionBlur?.setVelocityTexture(vt);
  }

  return {
    composer,
    velocity,
    taa,
    gtao,
    ssr,
    volumetrics,
    dof,
    dofPass,
    motionBlur,
    motionBlurPass,
    heat,
    heatPass,
    grade,
    dispose() {
      composer.dispose();
      // EffectComposer turns the renderer's auto-clear off for its own use;
      // hand it back so a bypassed frame still clears.
      gl.autoClear = true;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export interface PipelineProps {
  /** Override the auto-detected quality tier. */
  tier?: QualityTier;
  /** Turn the whole chain off (renders the scene directly). */
  enabled?: boolean;
}

// Hoisted scratch. Nothing in the frame loop may allocate.
const unjitteredProjection = new THREE.Matrix4();
const bufferSize = new THREE.Vector2(1, 1);
const jitterOffset = new THREE.Vector2();

export const Pipeline = forwardRef<PostFxHandle, PipelineProps>(function Pipeline(
  { tier, enabled = true },
  ref,
) {
  const { gl, scene, camera, size } = useThree();
  const storeTier = useSfStore((s) => s.quality);
  const activeTier = tier ?? storeTier;

  useImperativeHandle(ref, () => postFx, []);

  /* ---- seeded, deterministic lens assets. Generated once, reused across
         quality changes so a tier switch does not re-run void-and-cluster. ---- */
  const assets = useMemo(
    () => ({
      blueNoise: makeBlueNoiseTexture(64),
      dirt: makeLensDirtTexture(512),
    }),
    [],
  );

  useEffect(
    () => () => {
      assets.blueNoise.dispose();
      assets.dirt.dispose();
    },
    [assets],
  );

  // Publish the shared blue-noise tile before any effect can sample it.
  envUniforms.blueNoise.value = assets.blueNoise;
  envUniforms.blueNoiseTexel.value.set(
    1 / (assets.blueNoise.image as { width: number }).width,
    1 / (assets.blueNoise.image as { height: number }).height,
  );

  const chain = useMemo(
    () => buildChain(gl, scene, camera as THREE.PerspectiveCamera, activeTier, assets.dirt),
    [gl, scene, camera, activeTier, assets],
  );

  useEffect(() => () => chain.dispose(), [chain]);

  /* ---- size ---- */
  useEffect(() => {
    chain.composer.setSize(size.width, size.height);
    chain.taa?.reset();
    chain.gtao?.reset();
    chain.ssr?.reset();
    chain.volumetrics?.reset();
  }, [chain, size.width, size.height]);

  /* ---- log-depth detection ---- */
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    envUniforms.logDepthFC.value = gl.capabilities.logarithmicDepthBuffer
      ? 2 / (Math.log(cam.far + 1) / Math.LN2)
      : 0;
  }, [gl, camera, activeTier]);

  /* ---- the frame ---- */
  // Priority 1 takes over rendering from R3F entirely; everything else in the
  // game runs at priority 0 and has therefore already written `frame` by now.
  useFrame((_state, delta) => {
    const cam = camera as THREE.PerspectiveCamera;
    const dt = Math.min(delta, 1 / 15);

    if (!enabled || !postfx.enabled) {
      // The composer left auto-clear off; do it by hand so the bypass path is a
      // complete frame rather than a smear of the last composed one.
      gl.setRenderTarget(null);
      gl.clear();
      gl.render(scene, cam);
      postfx.heatCount = 0;
      return;
    }

    /* ---------- atmosphere ---------- */
    updateEnvAtmosphere(frame.timeOfDay, frame.fogDensity);
    envUniforms.time.value = frame.time;
    envUniforms.wind.value.copy(frame.windDirection).multiplyScalar(frame.windSpeed * 0.12);
    bindShadowMap(scene);

    /* ---------- camera, unjittered ---------- */
    // Rebuild the projection from the camera's own parameters rather than
    // restoring a saved copy. Gameplay systems change `fov` every frame (sprint
    // and ADS both push it) at priority 0, i.e. before this callback; restoring
    // last frame's matrix would silently undo their change one frame late.
    cam.updateProjectionMatrix();
    unjitteredProjection.copy(cam.projectionMatrix);
    // Drawing-buffer pixels, not CSS pixels: every render target in the chain is
    // sized from `getDrawingBufferSize`, so a texel offset computed from the CSS
    // size would be wrong by exactly the device pixel ratio.
    gl.getDrawingBufferSize(bufferSize);
    updateEnvCamera(cam, unjitteredProjection, bufferSize.x, bufferSize.y);
    envUniforms.logDepthFC.value = gl.capabilities.logarithmicDepthBuffer
      ? 2 / (Math.log(cam.far + 1) / Math.LN2)
      : 0;

    /* ---------- gameplay-driven state ---------- */
    syncRuntime(chain, dt);

    /* ---------- TAA jitter ---------- */
    if (chain.taa) {
      chain.taa.jitterInto(envUniforms.frameIndex.value, jitterOffset);
      // Sub-pixel offset injected straight into the projection matrix. This is
      // the same thing setViewOffset does, minus the side effects on the
      // camera's view-offset state that other systems might read.
      const e = cam.projectionMatrix.elements;
      e[8] += (jitterOffset.x * 2) / Math.max(1, bufferSize.x);
      e[9] += (jitterOffset.y * 2) / Math.max(1, bufferSize.y);
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }

    chain.composer.render(dt);

    // Without a TAA pass nothing else advances the convergence counter, and the
    // screenshot harness would wait forever on a still that is already stable.
    if (!chain.taa) postfx.taaFrames = Math.min(postfx.taaFrames + 1, 64);

    /* ---------- roll ---------- */
    rollEnvHistory();
    postfx.heatCount = 0;
    decayTransients(dt);
  }, 1);

  return null;
});

/** The name the composition root mounts. */
export const PostFx = Pipeline;

export default Pipeline;

/* ------------------------------------------------------------------ *
 * Per-frame sync
 * ------------------------------------------------------------------ */

let lastLookWeights: [number, number, number] = [1, 0, 0];

/**
 * Push the runtime state into shader uniforms.
 *
 * Values gameplay sets explicitly win, but sensible defaults are derived from
 * `frame` so that swimming tints the screen and a wingsuit dive streaks even if
 * nobody remembered to call the API — combined with `max`, so an explicit call
 * can always push an effect further but never accidentally cancel one.
 */
function syncRuntime(chain: Chain, dt: number): void {
  const store = useSfStore.getState();
  const g = chain.grade;

  /* ---- exposure: gentle adaptation toward the scene's own brightness ---- */
  // Night needs to be lifted or the neon is the only thing visible; midday needs
  // pulling back or the fog blows out. Driven off the sun rather than a
  // histogram readback, which would cost a GPU stall every frame.
  const night = envUniforms.nightFactor.value;
  const target = 1 + night * 0.55 - (1 - night) * 0.08;
  postfx.adaptedExposure = damp(postfx.adaptedExposure, target, 1.1, dt);
  g.u("gExposure").value = postfx.exposure * postfx.adaptedExposure;

  /* ---- colour grade ---- */
  let weights: [number, number, number];
  if (postfx.look === "auto") {
    weights = lookWeightsForHour(frame.timeOfDay);
  } else {
    weights =
      postfx.look === "day" ? [1, 0, 0] : postfx.look === "golden" ? [0, 1, 0] : [0, 0, 1];
  }
  if (
    Math.abs(weights[0] - lastLookWeights[0]) > 0.004 ||
    Math.abs(weights[1] - lastLookWeights[1]) > 0.004 ||
    Math.abs(weights[2] - lastLookWeights[2]) > 0.004
  ) {
    g.lut.setWeights(weights[0], weights[1], weights[2]);
    lastLookWeights = weights;
  }
  g.u("lutAmount").value = postfx.lookBlend;

  /* ---- lens ---- */
  if (g.bloom) g.u("bloomAmount").value = postfx.bloomIntensity;
  g.u("grainAmount").value = postfx.grain;
  g.u("caAmount").value = postfx.chromaticAberration;
  g.u("vignetteAmount").value = postfx.vignette;
  g.u("dirtAmount").value = postfx.lensDirt;
  g.u("sharpenAmount").value = postfx.sharpen * 0.5;
  chain.taa?.setSharpness(postfx.sharpen);

  /* ---- damage ---- */
  const healthFrac = store.maxHealth > 0 ? store.health / store.maxHealth : 1;
  const chronic = clamp01((0.35 - healthFrac) / 0.35);
  g.u("damageAmount").value = postfx.damage;
  g.u("lowHealthAmount").value = Math.max(postfx.lowHealth, chronic);
  g.u("flashAmount").value = postfx.flash;
  // World heading → screen-space lobe direction. +Y is "in front of you".
  const rel = postfx.damageDirection - frame.yaw;
  (g.u("damageVec").value as THREE.Vector2).set(Math.sin(rel), Math.cos(rel));

  /* ---- speed lines: automatic above ~40 m/s, more in a wingsuit ---- */
  const autoSpeed =
    frame.movement === "wingsuit"
      ? clamp01((frame.speed - 34) / 55)
      : clamp01((frame.speed - 44) / 60) * 0.65;
  g.u("speedAmount").value = Math.max(postfx.speedBlur, autoSpeed);

  /* ---- underwater ---- */
  const autoWater = frame.movement === "swimming" ? 1 : 0;
  g.u("underwaterAmount").value = Math.max(postfx.underwater, autoWater);

  g.u("nightVisionAmount").value = postfx.nightVision;
  g.u("thermalAmount").value = postfx.thermal;

  /* ---- SSR: the streets get wetter as the marine layer thickens ---- */
  if (chain.ssr) {
    chain.ssr.wetness = clamp01(postfx.wetness + frame.fogDensity * 0.35);
    chain.ssr.glassiness = postfx.glassiness;
  }

  /* ---- volumetrics: shafts only matter when there is something to catch ---- */
  if (chain.volumetrics) {
    chain.volumetrics.shaftStrength = 0.25 + frame.fogDensity * 0.75;
  }

  /* ---- motion blur ---- */
  if (chain.motionBlur) {
    // Shutter angle is defined relative to the frame time, so a 30 fps frame
    // must blur twice as far as a 60 fps one to represent the same exposure.
    chain.motionBlur.intensity = postfx.motionBlurScale * Math.min(dt * 60, 2);
    if (chain.motionBlurPass) {
      chain.motionBlurPass.enabled = postfx.motionBlurScale > 0.01;
    }
  }

  /* ---- depth of field ---- */
  if (chain.dof && chain.dofPass) {
    const aiming = store.aiming;
    const photo = store.phase === "photo";
    let blend = postfx.dofBlend;
    let aperture = postfx.aperture;
    let focal = postfx.focalLength;
    if (aiming && blend < 0.85) {
      // Aiming down sights: a long-ish lens wide open, focused on whatever the
      // crosshair is on. This is the shot the player is composing.
      blend = 0.85;
      aperture = Math.min(aperture, 3.5);
      focal = Math.max(focal, 55);
    }
    if (photo) blend = Math.max(blend, 1);
    chain.dofPass.enabled = blend > 0.01;
    if (chain.dofPass.enabled) {
      chain.dof.setLens(
        postfx.focusDistance,
        aperture,
        focal,
        blend,
        postfx.autoFocus || aiming,
        dt,
      );
    }
  }

  /* ---- heat haze ---- */
  if (chain.heatPass && chain.heat) {
    chain.heatPass.enabled = postfx.heatCount > 0;
  }
}

/** Decay the one-shot effects. Frame-rate independent, so a hitch is not a strobe. */
function decayTransients(dt: number): void {
  postfx.damage = Math.max(0, postfx.damage - dt * 1.35);
  postfx.flash = Math.max(0, postfx.flash - dt * 4.5);
}
