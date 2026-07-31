/**
 * Vibe Kart — the post pipeline.
 *
 * Owns the final image. The engine hands over the draw by way of the
 * `postfx:override` event; from that point on nothing else calls
 * `renderer.render` against the canvas.
 *
 * The frame, in order:
 *
 *   scene ──▶ HDR + depth
 *      │
 *      ├─▶ AO (½ res, blurred) ──┐
 *      │                         ▼
 *      └────────────────▶ resolve (AO applied, motion blur)
 *                               │
 *                        [ TAA, opt-in ]
 *                               │
 *              ┌────────────────┼────────────────┐
 *              ▼                ▼                ▼
 *         DOF (½ res)     bloom pyramid    god rays (¼ res)
 *              └────────────────┼────────────────┘
 *                               ▼
 *                         composite  (tonemap, grade, lens, game layer)
 *                               ▼
 *                             FXAA ──▶ screen
 *
 * Design rules this file exists to enforce:
 *
 *  · **One tonemap, one encode.** three never tone maps into a render target,
 *    so every buffer before the composite is render-linear and un-encoded. The
 *    composite applies exposure, ACES and the sRGB transfer function exactly
 *    once and writes display-space bytes. Nothing downstream converts again.
 *  · **Nothing is required.** Every consumed service — physics, env — is read
 *    defensively. A missing environment system costs sun shafts and nothing
 *    else; a missing physics system costs the speed ramp and nothing else. The
 *    picture still renders.
 *  · **Every optional format is probed.** On the software rasteriser the chain
 *    degrades to 8-bit with a lowered bloom threshold, and the passes that need
 *    a depth texture switch themselves off rather than sampling garbage.
 *  · **Nothing is allocated per frame.** Every vector, matrix and colour the
 *    frame loop touches is hoisted; the render function does no work the GC
 *    will ever see.
 */
import * as THREE from "three";
import type {
  KartCtx,
  KartQuality,
  PhysicsService,
  PostFxFlags,
  PostFxService,
  RacerState,
  System,
} from "../types";
import { TUNING } from "../types";

import { AoPass } from "./ao";
import { BloomPyramid } from "./bloom";
import { CompositePass } from "./composite";
import { DofPass } from "./dof";
import { FxaaPass } from "./fxaa";
import { GodRayPass } from "./godrays";
import { bakeInkTexture, ImpactMixer, type ImpactKind } from "./impact";
import { GradeLut, KART_GRADE, type GradeParams } from "./lut";
import { ResolvePass } from "./resolve";
import { TaaPass } from "./taa";
import {
  Blitter,
  createSharedUniforms,
  disposeTarget,
  makeTarget,
  probeCaps,
  resizeTarget,
  type PostFxCaps,
} from "./targets";

/**
 * The published handle.
 *
 * `PostFxService` is the contract in `types.ts`; everything below it is
 * additive and optional, declared here because `types.ts` is shared law and
 * this module does not get to rewrite it. Consumers should feature-test.
 */
export interface KartPostFxService extends PostFxService {
  /** What the driver actually supports — the debug HUD reads this. */
  readonly caps: PostFxCaps;
  /** Fire a full-screen impact. The item system's hook into the picture. */
  impact(kind: ImpactKind, opts?: { strength?: number; duration?: number; color?: number }): void;
  /** Cancel every impact in flight — respawn, restart, pause. */
  clearImpacts(): void;
  /** Re-bake the grade. Useful for a tunnel, a night lap, the results screen. */
  setGrade(params: Partial<GradeParams>): void;
  /** Drop temporal history: camera cuts, teleports, quality changes. */
  resetHistory(): void;
  /**
   * Offline mode for the screenshot harness. With a static camera there is no
   * reprojection error to make, so temporal accumulation is pure gain.
   */
  setOffline(enabled: boolean): void;
  readonly offline: boolean;
  /** Frames of converged temporal history, or 0 when TAA is off. */
  readonly taaFrames: number;
  /** Live description of the running chain, for the debug HUD. */
  readonly info: { passes: string[]; width: number; height: number; hdr: boolean };
}

// ---------------------------------------------------------------------------
// Quality tiers
// ---------------------------------------------------------------------------

interface Tier {
  bloomMips: number;
  aoDirections: number;
  aoSteps: number;
  aoScale: number;
  motionTaps: number;
  dofTaps: number;
  godRayTaps: number;
  godRayScale: number;
}

const TIERS: Record<KartQuality, Tier> = {
  low: { bloomMips: 4, aoDirections: 3, aoSteps: 2, aoScale: 2, motionTaps: 4, dofTaps: 8, godRayTaps: 12, godRayScale: 4 },
  medium: { bloomMips: 5, aoDirections: 4, aoSteps: 3, aoScale: 2, motionTaps: 6, dofTaps: 10, godRayTaps: 16, godRayScale: 4 },
  high: { bloomMips: 6, aoDirections: 5, aoSteps: 4, aoScale: 2, motionTaps: 8, dofTaps: 14, godRayTaps: 24, godRayScale: 4 },
  ultra: { bloomMips: 6, aoDirections: 6, aoSteps: 5, aoScale: 2, motionTaps: 12, dofTaps: 18, godRayTaps: 28, godRayScale: 2 },
};

function defaultFlags(quality: KartQuality): PostFxFlags {
  const rich = quality === "high" || quality === "ultra";
  return {
    bloom: true,
    // Motion blur is the first thing to go: it is the pass whose absence the
    // player notices least and whose cost is a full-resolution gather.
    motionBlur: quality !== "low",
    dof: rich,
    ssao: rich,
    godRays: quality !== "low",
    chromatic: quality !== "low",
    grain: true,
    vignette: true,
    grade: true,
    fxaa: true,
    // TAA would need per-object velocity to be safe against a field of eight
    // karts moving relative to the camera. It has none, so it stays off until
    // something asks for it — the offline harness does, because a static
    // camera cannot produce the failure.
    taa: false,
    speedLines: true,
    exposure: 1,
  };
}

// ---------------------------------------------------------------------------
// Helpers and module-scope constants
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Frame-rate independent exponential approach. */
function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/**
 * The subset of the environment service this module reads.
 *
 * Structural on purpose: importing another subsystem's module — even for a
 * type — is the one thing that would break the boot contract, so the shape is
 * restated here and every field is optional.
 */
interface SunReadout {
  sunDirection?: THREE.Vector3;
  sunScreen?: THREE.Vector2;
  sunOnScreen?: boolean;
  keyColor?: THREE.Color;
  night?: number;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export default function createPostFx(ctx: KartCtx): System {
  const renderer = ctx.renderer;
  const caps = probeCaps(renderer);
  const tier = TIERS[ctx.quality];
  const flags = defaultFlags(ctx.quality);

  // Without a depth texture there is no reconstruction, and every pass that
  // depends on one has to stand down. Bloom, the grade and the lens layer are
  // colour-only and survive intact — which is the whole reason the chain is
  // split the way it is.
  function clampFlagsToCaps(): void {
    if (caps.depthTexture) return;
    flags.ssao = false;
    flags.dof = false;
    flags.godRays = false;
    flags.motionBlur = false;
    flags.taa = false;
  }
  clampFlagsToCaps();

  const blitter = new Blitter();
  const shared = createSharedUniforms();

  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  let width = Math.max(1, size.x);
  let height = Math.max(1, size.y);

  // --- targets -------------------------------------------------------------
  const sceneTarget = makeTarget(width, height, "KartScene", caps, {
    depth: true,
    depthTexture: caps.depthTexture,
  });
  // The composite writes display-space bytes; there is nothing left to hold in
  // half float, and an 8-bit buffer halves FXAA's read bandwidth.
  const ldrTarget = makeTarget(width, height, "KartLdr", caps, { ldr: true });
  shared.tDepth.value = sceneTarget.depthTexture ?? null;

  // --- passes --------------------------------------------------------------
  const lut = new GradeLut(KART_GRADE);
  const bloom = new BloomPyramid(caps, { mips: tier.bloomMips });
  const fxaa = new FxaaPass(shared);
  const dof = new DofPass(caps, shared, { taps: tier.dofTaps });
  const composite = new CompositePass(shared, dof.coc, lut);
  const impacts = new ImpactMixer();
  const inkTexture = bakeInkTexture(ctx.rng);

  // Everything below is allocated on first use. A tier that never enables TAA
  // never pays for two full-resolution history buffers, and a tier with no AO
  // and no motion blur never allocates the full-resolution resolve target.
  let resolve: ResolvePass | null = null;
  let ao: AoPass | null = null;
  let godRays: GodRayPass | null = null;
  let taa: TaaPass | null = null;

  function ensureResolve(): ResolvePass {
    if (!resolve) {
      resolve = new ResolvePass(caps, shared, { taps: tier.motionTaps });
      resolve.setSize(width, height);
    }
    return resolve;
  }

  function ensureAo(): AoPass | null {
    if (!caps.depthTexture) return null;
    if (!ao) {
      ao = new AoPass(caps, shared, {
        directions: tier.aoDirections,
        steps: tier.aoSteps,
        scale: tier.aoScale,
      });
      ao.setSize(width, height);
    }
    return ao;
  }

  function ensureGodRays(): GodRayPass | null {
    if (!caps.depthTexture) return null;
    if (!godRays) {
      godRays = new GodRayPass(caps, shared, { taps: tier.godRayTaps, scale: tier.godRayScale });
      godRays.setSize(width, height);
    }
    return godRays;
  }

  function ensureTaa(): TaaPass | null {
    if (!caps.depthTexture) return null;
    if (!taa) {
      taa = new TaaPass(caps, shared);
      taa.setSize(width, height);
    }
    return taa;
  }

  if (flags.ssao) ensureAo();
  if (flags.godRays) ensureGodRays();
  if (flags.ssao || flags.motionBlur) ensureResolve();

  function bindCompositeTextures(): void {
    composite.setTextures({
      bloom: flags.bloom ? bloom.texture : null,
      dof: flags.dof ? dof.texture : null,
      godRays: flags.godRays && godRays ? godRays.texture : null,
      ink: inkTexture,
    });
  }
  bindCompositeTextures();

  // --- per-frame scratch (the frame loop allocates nothing) ---------------
  const currViewProjection = new THREE.Matrix4();
  const prevViewProjection = new THREE.Matrix4();
  const baseProjection = new THREE.Matrix4();
  const jitter = new THREE.Vector2();
  const sunUv = new THREE.Vector2(0.5, 0.5);
  const vanish = new THREE.Vector2(0.5, 0.5);
  const vanishTarget = new THREE.Vector2(0.5, 0.5);
  const tmpVec = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const godTint = new THREE.Color(1, 0.92, 0.78);
  const passNames: string[] = [];

  let hasPrevViewProjection = false;
  let frameIndex = 0;
  let boostBlend = 0;
  let speedBlend = 0;
  let starBlend = 0;
  let sunWeight = 0;
  let offline = false;
  let disposed = false;

  // The engine resets `renderer.info` at the top of every `render` call, and
  // this pipeline issues a dozen of them per frame — leaving it on would make
  // the debug HUD report the triangle count of the FXAA triangle. Taking
  // ownership of the reset is the only way that number means anything.
  const prevAutoReset = renderer.info.autoReset;
  renderer.info.autoReset = false;

  function setSize(w: number, h: number): void {
    width = Math.max(1, Math.floor(w));
    height = Math.max(1, Math.floor(h));
    resizeTarget(sceneTarget, width, height);
    resizeTarget(ldrTarget, width, height);
    bloom.setSize(width, height);
    dof.setSize(width, height);
    resolve?.setSize(width, height);
    ao?.setSize(width, height);
    godRays?.setSize(width, height);
    taa?.setSize(width, height);
    shared.uTexel.value.set(1 / width, 1 / height);
    shared.uAspect.value = width / Math.max(1, height);
  }
  setSize(width, height);

  // -------------------------------------------------------------------------
  // Game state -> uniforms
  // -------------------------------------------------------------------------

  /**
   * Where the streaks and the radial blur converge.
   *
   * Not the middle of the screen: a point 70 m ahead of the kart, so on a long
   * left-hander the whole speed effect leans into the corner with the player
   * instead of pointing at the horizon they are not driving toward.
   */
  function updateVanishingPoint(player: RacerState | undefined, dt: number): void {
    vanishTarget.set(0.5, 0.5);
    if (player) {
      tmpVec.set(0, 0, -1).applyQuaternion(player.quaternion);
      tmpVec.multiplyScalar(70).add(player.position).addScaledVector(UP, 1.2);
      ndc.copy(tmpVec).project(ctx.camera);
      if (ndc.z > -1 && ndc.z < 1) {
        // Clamped well inside the frame: a vanishing point at the very edge
        // turns the radial blur into a one-sided wipe.
        vanishTarget.set(
          Math.min(Math.max(ndc.x * 0.5 + 0.5, 0.2), 0.8),
          Math.min(Math.max(ndc.y * 0.5 + 0.5, 0.2), 0.8),
        );
      }
    }
    // Slow: a vanishing point that snaps around under the steering input makes
    // the speed lines look bolted to the steering wheel.
    vanish.x = approach(vanish.x, vanishTarget.x, 3.5, dt);
    vanish.y = approach(vanish.y, vanishTarget.y, 3.5, dt);
  }

  function updateSun(): void {
    const env = ctx.services.env as SunReadout | undefined;
    if (!env) {
      sunWeight = 0;
      return;
    }

    let onScreen = env.sunOnScreen;
    if (env.sunScreen) {
      sunUv.copy(env.sunScreen);
    } else if (env.sunDirection) {
      // The environment system normally publishes a projected sun; if this is
      // a build that does not, project it ourselves rather than giving up.
      ctx.camera.getWorldPosition(camPos);
      tmpVec.copy(camPos).addScaledVector(env.sunDirection, ctx.camera.far * 0.4);
      ndc.copy(tmpVec).project(ctx.camera);
      sunUv.set(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5);
      onScreen = ndc.z > -1 && ndc.z < 1;
    } else {
      sunWeight = 0;
      return;
    }

    // Fade with distance outside the frame rather than cutting: shafts that
    // vanish the instant the sun crosses the edge are worse than no shafts.
    const dx = Math.max(0, Math.abs(sunUv.x - 0.5) - 0.5);
    const dy = Math.max(0, Math.abs(sunUv.y - 0.5) - 0.5);
    const edge = 1 - Math.min(Math.sqrt(dx * dx + dy * dy) / 0.35, 1);
    sunWeight = onScreen === false ? 0 : edge * (1 - (env.night ?? 0));

    // Shafts inherit the key light's colour, pulled toward white so a deep
    // golden sun does not paint the whole frame orange.
    if (env.keyColor) godTint.copy(env.keyColor).lerp(WHITE, 0.35);
  }

  function syncUniforms(dt: number): void {
    const physics = ctx.services.physics as PhysicsService | undefined;
    const player = physics?.player;

    const speed01 = player ? clamp01(Math.abs(player.speed) / TUNING.topSpeed) : 0;
    const boosting = player ? player.boost > 0 : false;
    speedBlend = approach(speedBlend, speed01, 6, dt);
    // Boost attacks hard and releases slowly — the release is the "coming down
    // off it" beat, and cutting it dead makes a mini-turbo feel weightless.
    boostBlend = approach(boostBlend, boosting ? 1 : 0, boosting ? 16 : 3.5, dt);
    starBlend = approach(starBlend, player && player.star > 0 ? 1 : 0, 6, dt);

    updateVanishingPoint(player, dt);
    updateSun();

    const u = composite.uniforms;
    const s = impacts.state;

    // Fold in the renderer's own exposure so anything that dims the world the
    // conventional way (a tunnel, a fade to black) still works with the
    // pipeline installed — three's tonemap is bypassed, its exposure is not.
    u.uExposure.value = flags.exposure * renderer.toneMappingExposure;
    u.uLutAmount.value = flags.grade ? 1 : 0;
    u.uBloomStrength.value = flags.bloom ? bloom.decode * 0.85 : 0;
    u.uBloomBlend.value = flags.bloom ? 0.06 : 0;
    u.uDofAmount.value = flags.dof ? 1 : 0;
    u.uGodStrength.value = flags.godRays && godRays ? 0.55 * sunWeight : 0;
    (u.uGodTint.value as THREE.Color).copy(godTint);

    // The lens reacts to speed. Everything here is deliberately understated at
    // cruising pace and only really bites during a boost — that contrast *is*
    // the effect. A constant 1.5 px of aberration is just a soft image.
    const rush = clamp01(speedBlend * 0.75 + boostBlend * 0.9);
    u.uCa.value = flags.chromatic ? 0.4 + rush * 1.15 : 0;
    u.uBarrel.value = flags.chromatic ? rush * rush * 0.055 : 0;
    // The vignette closes in a little under boost — a cheap tunnel-vision cue
    // that costs nothing and reads instantly.
    u.uVignette.value = flags.vignette ? 0.42 + boostBlend * 0.22 : 0;
    u.uGrain.value = flags.grain ? 0.32 : 0;
    u.uSpeedLines.value = flags.speedLines
      ? clamp01(boostBlend + Math.max(0, speedBlend - 0.8) * 2)
      : 0;
    (u.uVanish.value as THREE.Vector2).copy(vanish);

    u.uFlash.value = s.flash;
    (u.uFlashColor.value as THREE.Color).copy(s.flashColor);
    u.uInk.value = s.ink;
    u.uInkPhase.value = s.inkPhase;
    u.uStun.value = s.stun;
    u.uShock.value = s.shock;
    // The star's own channel and the physics-driven one, whichever is higher:
    // the event gives the punchy attack, the state keeps it alive for exactly
    // as long as the power-up lasts.
    u.uStar.value = Math.max(s.star, starBlend);

    if (resolve) {
      resolve.setAo(flags.ssao && ao ? ao.texture : null, 0.85);
      resolve.setMotion(
        flags.motionBlur ? 0.5 + boostBlend * 0.3 : 0,
        flags.motionBlur ? speedBlend * speedBlend * 0.006 + boostBlend * 0.014 : 0,
        vanish,
      );
    }
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  function render(dt: number): void {
    if (disposed) return;

    renderer.info.reset();
    frameIndex++;

    // A dpr or canvas change can land without a resize event (monitor swap,
    // browser zoom). Comparing the drawing-buffer size is one cheap call.
    renderer.getDrawingBufferSize(size);
    if (size.x !== width || size.y !== height) setSize(size.x, size.y);

    const camera = ctx.camera;
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    // Velocity is computed from the *unjittered* projection: TAA's own jitter
    // must not read as motion, or every pixel rejects its own history and the
    // pass degenerates into an expensive copy.
    baseProjection.copy(camera.projectionMatrix);
    currViewProjection.multiplyMatrices(baseProjection, camera.matrixWorldInverse);
    if (!hasPrevViewProjection) {
      prevViewProjection.copy(currViewProjection);
      hasPrevViewProjection = true;
    }
    shared.uPrevViewProjection.value.copy(prevViewProjection);
    shared.uNear.value = camera.near;
    shared.uFar.value = camera.far;
    shared.uCameraMatrixWorld.value.copy(camera.matrixWorld);
    shared.uTime.value = ctx.elapsed;
    shared.uFrame.value = frameIndex;

    impacts.update(dt);
    syncUniforms(dt);

    const taaActive = flags.taa && taa !== null;

    // --- 1. the scene ------------------------------------------------------
    if (taaActive && taa) {
      taa.jitterInto(frameIndex, jitter);
      // A sub-pixel offset is two pixels' worth of NDC per screen pixel.
      camera.projectionMatrix.elements[8] += (jitter.x * 2) / width;
      camera.projectionMatrix.elements[9] += (jitter.y * 2) / height;
    }
    // The inverse must match the matrix the depth buffer was rendered with,
    // jitter included, or every reconstruction is half a pixel out.
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    shared.uInverseProjection.value.copy(camera.projectionMatrixInverse);

    renderer.setRenderTarget(sceneTarget);
    renderer.render(ctx.scene, camera);

    if (taaActive) {
      camera.projectionMatrix.copy(baseProjection);
      camera.projectionMatrixInverse.copy(baseProjection).invert();
    }

    // --- 2. ambient occlusion ---------------------------------------------
    if (flags.ssao && ao) {
      // 0.5 · P[1][1] converts a world radius at unit depth into UV.
      ao.render(renderer, blitter, 0.5 * baseProjection.elements[5]);
    }

    // --- 3. resolve: AO applied, motion blur ------------------------------
    let image: THREE.Texture = sceneTarget.texture;
    if (resolve && ((flags.ssao && ao) || flags.motionBlur)) {
      resolve.render(renderer, blitter, sceneTarget.texture);
      image = resolve.target.texture;
    }

    // --- 4. temporal resolve ----------------------------------------------
    if (taaActive && taa) image = taa.render(renderer, blitter, image);

    // --- 5. defocus, bloom, shafts ----------------------------------------
    if (flags.dof) dof.render(renderer, blitter, image);
    if (flags.bloom) bloom.render(renderer, blitter, image, width, height);
    // Two passes skipped entirely when the sun is behind the camera or below
    // the horizon; the composite's strength is zero in the same condition, so
    // the buffer it samples going stale is unobservable.
    if (flags.godRays && godRays && sunWeight > 0.001) {
      // Shafts read the *raw* scene: the sky is the light source and it must
      // not arrive already defocused, blurred or temporally smeared.
      godRays.render(renderer, blitter, sceneTarget.texture, sunUv, sunWeight);
    }

    // --- 6. composite + FXAA ----------------------------------------------
    composite.render(renderer, blitter, image, flags.fxaa ? ldrTarget : null);
    if (flags.fxaa) fxaa.render(renderer, blitter, ldrTarget.texture, null);

    renderer.setRenderTarget(null);
    prevViewProjection.copy(currViewProjection);
  }

  // -------------------------------------------------------------------------
  // Service
  // -------------------------------------------------------------------------

  function describe(): string[] {
    passNames.length = 0;
    passNames.push(caps.halfFloat ? "scene:hdr" : "scene:ldr");
    if (flags.ssao && ao) passNames.push("ssao");
    if (flags.motionBlur) passNames.push("motionBlur");
    if (flags.taa && taa) passNames.push("taa");
    if (flags.dof) passNames.push("dof");
    if (flags.bloom) passNames.push("bloom");
    if (flags.godRays && godRays) passNames.push("godRays");
    passNames.push("composite");
    if (flags.fxaa) passNames.push("fxaa");
    // A copy: the scratch array is rebuilt on the next call, and a debug HUD
    // that cached the previous one would silently watch it empty itself.
    return passNames.slice();
  }

  const service: KartPostFxService = {
    flags,
    caps,
    render,

    set(next) {
      // Turning a pass on for the first time allocates it here rather than at
      // boot; turning one off leaves the allocation in place, because the
      // options menu is a thing people flip back and forth.
      if (next.ssao) ensureAo();
      if (next.godRays) ensureGodRays();
      if (next.taa) ensureTaa();
      if (next.ssao || next.motionBlur) ensureResolve();
      Object.assign(flags, next);
      clampFlagsToCaps();
      bindCompositeTextures();
    },

    impact(kind, opts) {
      impacts.trigger(kind, opts);
    },

    clearImpacts() {
      impacts.clear();
    },

    setGrade(params) {
      lut.bake({ ...KART_GRADE, ...params });
    },

    resetHistory() {
      taa?.reset();
      hasPrevViewProjection = false;
    },

    setOffline(enabled) {
      offline = enabled;
      if (enabled) {
        // A still frame has no motion to blur, and everything to gain from
        // temporal accumulation of the stochastic passes.
        flags.motionBlur = false;
        if ((ctx.quality === "high" || ctx.quality === "ultra") && ensureTaa()) {
          flags.taa = true;
        }
      }
      taa?.accumulate(enabled);
      taa?.reset();
      bindCompositeTextures();
    },

    get offline() {
      return offline;
    },
    get taaFrames() {
      return taa?.frames ?? 0;
    },
    get info() {
      return { passes: describe(), width, height, hdr: caps.halfFloat };
    },
  };

  ctx.services.postfx = service;
  ctx.emit("postfx:override", render);

  // -------------------------------------------------------------------------
  // Events — the item system's hook into the picture
  // -------------------------------------------------------------------------

  const unsubscribe: Array<() => void> = [];

  function isPlayer(racer: number | undefined): boolean {
    const physics = ctx.services.physics as PhysicsService | undefined;
    // Racer 0 is always the human player; falling back to that keeps the
    // effects working even if the physics system never booted.
    return racer === (physics?.player?.id ?? 0);
  }

  unsubscribe.push(
    ctx.on("kart:hit", ((p: { racer: number; by: string }) => {
      if (!p || !isPlayer(p.racer)) return;
      switch (p.by) {
        case "lightning":
          // The one effect allowed to blow the entire frame out.
          service.impact("flash", { strength: 1, color: 0xffffff });
          service.impact("shock", { strength: 1 });
          break;
        case "blooper":
          service.impact("ink", { strength: 1 });
          break;
        case "wall":
          service.impact("stun", { strength: 0.3, duration: 0.45 });
          break;
        default:
          service.impact("flash", { strength: 0.4, color: 0xffe4b0, duration: 0.28 });
          service.impact("stun", { strength: 0.85 });
          break;
      }
    }) as (p: never) => void),
  );

  unsubscribe.push(
    ctx.on("item:use", ((p: { racer: number; kind: string }) => {
      if (!p || !isPlayer(p.racer)) return;
      if (p.kind === "star") service.impact("star", { strength: 1, duration: TUNING.starTime });
      if (p.kind === "lightning") {
        service.impact("flash", { strength: 0.55, color: 0xdff0ff, duration: 0.4 });
      }
    }) as (p: never) => void),
  );

  unsubscribe.push(
    ctx.on("kart:boost", ((p: { racer: number }) => {
      if (!p || !isPlayer(p.racer)) return;
      // A very short warm bloom on the lens as the boost lights — small enough
      // that back-to-back mini-turbos do not strobe.
      service.impact("flash", { strength: 0.16, color: 0xfff0c8, duration: 0.2 });
    }) as (p: never) => void),
  );

  unsubscribe.push(
    ctx.on("race:respawn", ((p: { racer: number }) => {
      if (!p || !isPlayer(p.racer)) return;
      service.clearImpacts();
      service.resetHistory();
    }) as (p: never) => void),
  );

  // A camera cut invalidates every temporal assumption in the pipeline.
  unsubscribe.push(ctx.on("camera:cut", (() => service.resetHistory()) as (p: never) => void));
  unsubscribe.push(ctx.on("race:start", (() => service.resetHistory()) as (p: never) => void));

  return {
    resize() {
      renderer.getDrawingBufferSize(size);
      setSize(size.x, size.y);
      service.resetHistory();
    },

    dispose() {
      disposed = true;
      // Hand the draw back before anything is freed, or the engine's next
      // frame calls into a pipeline whose targets are gone.
      ctx.emit("postfx:override", null);
      for (const off of unsubscribe) off();

      disposeTarget(sceneTarget);
      disposeTarget(ldrTarget);
      bloom.dispose();
      dof.dispose();
      composite.dispose();
      fxaa.dispose();
      resolve?.dispose();
      ao?.dispose();
      godRays?.dispose();
      taa?.dispose();
      lut.dispose();
      inkTexture.dispose();
      blitter.dispose();

      renderer.info.autoReset = prevAutoReset;
      renderer.setRenderTarget(null);
      if (ctx.services.postfx === service) delete ctx.services.postfx;
    },
  };
}
