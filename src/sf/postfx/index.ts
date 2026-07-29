/**
 * Public API of the post-processing subsystem.
 *
 * Two things matter to the rest of the game:
 *   - mount `<PostFx />` inside the R3F canvas, after the world;
 *   - call `postFx.*` from anywhere to drive it.
 *
 * Everything else here is exported for tooling, tests and the odd system that
 * wants to reach into a specific effect (the vehicle code registering a car for
 * per-object motion blur, say).
 */

export { PostFx, Pipeline, type PipelineProps } from "./Pipeline";

export {
  postFx,
  postfx,
  resetPostFx,
  MAX_HEAT_SOURCES,
  type PostFxHandle,
  type PostFxRuntime,
  type GradeLook,
} from "./state";

export {
  registerVelocityObject,
  unregisterVelocityObject,
  clearVelocityObjects,
  VelocityPass,
} from "./velocity";

export { TaaPass, makeJitterSequence, type TaaOptions } from "./taa";
export { GtaoEffect, type GtaoOptions } from "./gtao";
export { SsrEffect, type SsrOptions } from "./ssr";
export { VolumetricLightEffect, type VolumetricOptions } from "./volumetrics";
export { BloomPyramid, type BloomOptions } from "./bloom";
export { DepthOfFieldEffect, type DofOptions } from "./dof";
export { MotionBlurEffect, type MotionBlurOptions } from "./motionBlur";
export { HeatHazeEffect } from "./heatHaze";
export { GradeEffect, type GradeOptions } from "./grade";

export {
  BlendableLut,
  buildLookLattice,
  lookWeightsForHour,
  LUT_SIZE,
  type LookName,
} from "./lut";

export { makeBlueNoiseTexture, makeLensDirtTexture } from "./textures";
export { envUniforms } from "./env";
