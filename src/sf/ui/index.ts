/**
 * The UI subsystem's public surface.
 *
 * Two things the integrator needs and one thing every other subsystem needs:
 *
 *   INTEGRATION
 *     <SfUi />            — mount next to <Canvas>. That is the whole HUD,
 *                           map, menus, photo mode and Vibeverse chrome.
 *     <PhotoCameraRig />  — mount INSIDE <Canvas>. Inert unless photo mode
 *                           is active; it is what actually flies the camera.
 *
 *   PRODUCERS (weapons, vehicles, player, AI)
 *     hudTelemetry        — mutate in place from your own frame loop.
 *     hudEvents           — allocation-free one-shots: hit, kill, damage.
 *
 * Everything else here is exported because it is genuinely reusable (the
 * theme tokens, the shared rAF driver, the formatters), not because a HUD
 * widget needs to be importable from outside.
 */

/* ---- mount points ---- */
export { default as SfUi } from "./SfUi";
export type { SfUiProps } from "./SfUi";
export { default as PhotoCameraRig } from "./PhotoCameraRig";

/* ---- individual surfaces, if the integrator wants finer control ---- */
export { default as Hud } from "./Hud";
export type { HudProps } from "./Hud";
export { default as Minimap } from "./Minimap";
export { default as MapScreen } from "./MapScreen";
export { default as Menus } from "./Menus";
export { default as LoadingScreen } from "./LoadingScreen";
export { default as PhotoMode } from "./PhotoMode";
export { default as Notifications } from "./Notifications";
export { default as DeathScreen } from "./DeathScreen";
export { default as Discovery } from "./Discovery";

/* ---- the 60 Hz channel other subsystems write to ---- */
export {
  hudTelemetry,
  hudEvents,
  drainHudEvents,
  clearHudEvents,
  deriveTelemetry,
  resetTelemetry,
} from "./telemetry";
export type { HudTelemetry, VehicleTelemetry, Contact, HudEvent, HudEventKind } from "./telemetry";

/* ---- settings + bindings, for the input and audio systems ---- */
export {
  useUiStore,
  ui,
  actionFor,
  keyFor,
  ACTIONS,
  DEFAULT_SETTINGS,
} from "./uiStore";
export type {
  SfUiState,
  UiSettings,
  UiRoute,
  SettingsTab,
  Bindings,
  ActionId,
  Waypoint,
  SubtitleSize,
} from "./uiStore";

/* ---- photo mode runtime, for cinematics ---- */
export {
  photoRig,
  enterPhotoMode,
  exitPhotoMode,
  exportPhoto,
  applyPhotoLens,
  PHOTO_FILTERS,
  filterById,
} from "./photo";
export type { PhotoRig, PhotoFilter, ExportOptions } from "./photo";

/* ---- shared utilities ---- */
export { subscribeUiFrame, useUiFrame, useUiInterval, setText, setAttr, setStyleVar, approach } from "./raf";
export { installUiStyles } from "./styles";
export { COLORS, MOTION, LAYOUT, Z, CVD_PALETTES, cvdColor, rgba, mixHex, healthColor } from "./theme";
export type { CvdMode } from "./theme";
export { weaponUi, WHEEL_ORDER, spreadToPixels } from "./weaponMeta";
export type { WeaponUi, ReticleKind } from "./weaponMeta";
export * as fmt from "./format";

/* ---- map rendering, reusable for any other cartography ---- */
export {
  drawBaseMap,
  drawPlayer,
  drawPin,
  drawPinAt,
  drawHeat,
  w2s,
  s2w,
  MINIMAP_STYLE,
  FULLMAP_STYLE,
} from "./map/mapRender";
export type { MapView, MapStyle } from "./map/mapRender";
export { buildHillshade, getHillshade, hillshadeProgress } from "./map/hillshade";
