/**
 * game/index.ts — the game layer's public surface.
 *
 *   import GameDirector, { chaos, missions, upgrades } from "@/sf/game";
 *
 * Mount `<GameDirector />` inside the Canvas after `<CityAI />` and the layer
 * runs itself. Everything else here is for the HUD, the map screen and the
 * player systems that read upgrade values.
 *
 * See README.md in this directory for the design: the core loop, the chaos
 * economy, the escalation curve and the full activity list.
 */

/* ---- the component ---- */
export { default } from "./GameDirector";
export { default as GameDirector } from "./GameDirector";
export type { GameDirectorProps } from "./GameDirector";

/* ---- chaos economy ---- */
export {
  chaos,
  installChaosEconomy,
  refreshChaosHooks,
  chaosRank,
  chaosRankIndex,
  rankProgress,
  CHAOS_RANKS,
  COMBO_TIERS,
  STYLE_TAGS,
} from "./chaos";
export type {
  ChaosClass,
  ChaosAward,
  ChaosReportOptions,
  ChaosRank,
  ComboTier,
  StyleTag,
} from "./chaos";

/* ---- heat (scoring side; the response side lives in @/sf/ai) ---- */
export { gameHeat, PRESSURE_HOSTILE } from "./heat";
export type { Provocation } from "./heat";

/* ---- the director ---- */
export { director, unexploredDistricts } from "./director";
export type { AmbientEvent, AmbientKind, ActivityOffer, DirectorPhase } from "./director";

/* ---- missions ---- */
export {
  missions,
  MISSIONS,
  MISSION_BY_ID,
  MISSION_KIND_LABEL,
  missionsInDistrict,
  markerHeight,
} from "./missions";
export type {
  MissionDef,
  MissionKind,
  MissionState,
  MissionEvent,
  MissionActor,
  ActorKind,
  ObjectiveSpec,
  ObjectiveKind,
  FailureSpec,
  MissionReward,
  WorldPoint,
} from "./missions";

/* ---- progression ---- */
export {
  progression,
  upgrades,
  UNLOCKS,
  UNLOCK_BY_ID,
  CHALLENGES,
  CHALLENGE_BY_ID,
  formatTime,
} from "./progression";
export type { Upgrades, UnlockDef, UnlockCategory, Challenge, PlayerStats } from "./progression";

/* ---- discoveries ---- */
export {
  discoveries,
  DISCOVERIES,
  DISCOVERY_BY_KEY,
  discoveriesInDistrict,
  districtCompletion,
  nearestUndiscovered,
} from "./discoveries";
export type { Discovery, DiscoveryKind } from "./discoveries";

/* ---- persistence ---- */
export {
  saveSystem,
  saveGame,
  loadGame,
  clearSave,
  hasSave,
  exportSave,
  importSave,
  snapshot,
  SAVE_VERSION,
} from "./save";
export type { SaveData, SaveSettings } from "./save";
