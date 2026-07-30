/**
 * The landmark layer — public surface.
 *
 * Mount `<Landmarks />` inside the R3F canvas and everything else here is
 * optional. The queries exist because landmarks are the only geometry in the
 * world that other systems genuinely have to know about: they are what the
 * grapple hooks onto, what the vehicles drive over on the bridges and Lombard,
 * and what the character controller stands on 67 m above the water.
 *
 *   <Landmarks />                                  the streamer
 *   landmarkSurfaceHeight(x, z, ceiling, driving)  top of the deck under a point
 *   queryLandmarkColliders(x, z, r, out)           boxes near a point
 *   landmarkColliders()                            everything, read-only
 *   LANDMARK_BUILDERS                              kind -> module, for tooling
 *   GOLDEN_GATE / BAY_BRIDGE                       bridge geometry constants
 *   goldenGateDeckPoints()                         a path for bridge traffic
 */
export { default as Landmarks } from "./Landmarks";
export { default } from "./Landmarks";
export type { LandmarksProps } from "./Landmarks";

export {
  clearLandmarkColliders,
  clearLandmarkCollidersFor,
  landmarkColliders,
  landmarkSurfaceHeight,
  queryLandmarkColliders,
  streetYaw,
  bearingYaw,
} from "./types";

export type {
  ColliderSink,
  LandmarkCollider,
  LandmarkCtx,
  LandmarkModule,
} from "./types";

export { LANDMARK_BUILDERS, builderFor } from "./registry";

export { GOLDEN_GATE, goldenGateDeckPoints } from "./goldenGate";
export { BAY_BRIDGE } from "./bayBridge";

export { disposeLandmarkMaterials } from "./materials";
