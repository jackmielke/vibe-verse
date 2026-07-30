/**
 * audio/index.ts — one import for the whole audio system.
 *
 *   import SfAudio, { sfAudio } from "@/sf/audio";
 *
 *   <SfAudio />                                  // in the Canvas, once
 *   sfAudio.playShot("ar556", { x, y, z });      // from anywhere
 *
 * Integration checklist for the composition root:
 *   1. Mount `<SfAudio />` inside `<Canvas>`.
 *   2. Nothing else is required. The context unlocks on the first gesture,
 *      the weapon bridge finds the sink through `globalThis.__sfAudio`, and
 *      the listener, reverb, ambience and score all follow the camera and
 *      `frame` on their own.
 *
 * Optional wiring, if the systems that own the data want richer audio:
 *   - vehicles:  `sfAudio.updateVehicle(id, kind, state, dt)` each frame
 *   - weapons:   `setWeaponAudioSink(sfAudio.weaponSink)` for immediate binding
 *   - interiors: `sfAudio.setEnvironment("indoor")` on enter/exit triggers
 */
export { default } from "./Audio";
export { default as SfAudio, type SfAudioProps } from "./Audio";

export { sfAudio, type SfAudioApi, type SfAudioStats } from "./api";

export {
  audioEngine,
  setOcclusionProbe,
  probeOcclusion,
  terrainOcclusion,
  updateEnvironmentFromFrame,
  ENVIRONMENTS,
  BUS_NAMES,
  DEFAULT_SETTINGS,
  type AudioSettings,
  type BusName,
  type EnvironmentKind,
  type OcclusionProbe,
} from "./engine";

export {
  voicePool,
  playBuffer,
  playBufferAt,
  stopVoice,
  distanceTo,
  dopplerRate,
  scratchOptions,
  beginOptions,
  Voice,
  type VoiceOptions,
} from "./spatial";

export {
  playShot,
  playDistantShot,
  playWeaponMech,
  playCasing,
  weaponSink,
  gunProfile,
  primeWeaponBanks,
  primeTailsFor,
  GUN_PROFILES,
  MECH_BANKS,
  type GunProfile,
  type ShotOptions,
} from "./weaponSounds";

export {
  playExplosion,
  playDebrisShower,
  playIgnition,
  playTinnitus,
  updateExplosions,
  primeExplosionBanks,
  type DebrisKind,
  type ExplosionKind,
  type ExplosionOptions,
} from "./explosionSounds";

export {
  playFootstep,
  playLanding,
  playJump,
  playImpact,
  playRicochet,
  playBodyFall,
  playFoley,
  updateFootsteps,
  surfaceAt,
  surfaceFoot,
  primeFootstepBanks,
  type AudioSurface,
  type FoleyKind,
  type FootstepOptions,
  type ImpactOptions,
} from "./footsteps";

export {
  vehicleAudio,
  VehicleVoice,
  HelicopterVoice,
  engineSpec,
  playHorn,
  ENGINE_SPECS,
  type EngineSpec,
  type RoadSurface,
  type SirenMode,
  type VehicleAudioState,
  type VehicleKind,
} from "./vehicleSounds";

export {
  worldAmbience,
  primeAmbience,
  clearAmbienceTimers,
  playFoghorn,
  playSeagull,
  playCableCarBell,
  playChurchBell,
  playMuniPass,
  playJackhammer,
  playShipHorn,
  playDistantSiren,
} from "./worldAmbience";

export { music, primeMusic, type StingerKind } from "./music";

export {
  // DSP toolkit — exported because the VFX and UI layers occasionally want to
  // build their own one-off sounds without reimplementing envelopes.
  fillNoise,
  noiseBuffer,
  velvetNoise,
  bakeSync,
  bakeOffline,
  bakedBuffer,
  clearBakeCache,
  adsr,
  percEnv,
  rampPoints,
  expApproach,
  expRamp,
  biquad,
  saturator,
  waveshaperCurve,
  SVF,
  svfSweep,
  onePoleLowpass,
  dcBlock,
  normalize,
  softClip,
  edgeFade,
  renderModal,
  impactNodes,
  MODAL_LIBRARY,
  GranularPlayer,
  renderIR,
  dbToGain,
  gainToDb,
  noteHz,
  airCutoff,
  SPEED_OF_SOUND,
  type AdsrSpec,
  type GrainSpec,
  type IrSpec,
  type ModalMode,
  type ModalSpec,
  type NoiseKind,
  type ShaperKind,
} from "./synth";
