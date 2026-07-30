/**
 * weapons/index.ts — the whole gunplay stack, one import.
 *
 * The integrator needs exactly two things: the component, and the sink setters
 * for audio/VFX/damage/hitboxes. Everything else is exported because tools,
 * missions and the HUD legitimately want it.
 *
 *   import Weapons, { weaponHud, setHitboxProvider } from "@/sf/weapons";
 *   …
 *   <Weapons />                       // after the player controller
 */
export { default, default as Weapons, WeaponSystem, weaponHud, weaponSystem } from "./Weapons";
export type { WeaponsProps } from "./Weapons";

export {
  WEAPONS,
  WEAPON_ORDER,
  getWeapon,
  isExplosive,
  fireInterval,
  damageAtRange,
  spreadDegrees,
  recoilStep,
  maxCarried,
} from "./registry";

export type {
  WeaponDef,
  WeaponClass,
  FireMode,
  BallisticMode,
  ActionType,
  HitPart,
  DamageKnot,
  HitMultipliers,
  SpreadProfile,
  RecoilProfile,
  HandlingProfile,
  SightProfile,
  ExplosiveProfile,
  ViewmodelSpec,
  WeaponHit,
  Hitbox,
  HitboxProvider,
  ShotContext,
} from "./types";
export { makeWeaponHit } from "./types";

export {
  fireHitscan,
  spawnProjectile,
  updateBallistics,
  detonateSticky,
  stickyCount,
  forEachProjectile,
  clearBallistics,
  spreadDirection,
  segmentCapsule,
  onWeaponExplosion,
  type Projectile,
  type ProjectileKind,
  type HitHandler,
} from "./ballistics";

export { recoilSystem, RecoilSystem } from "./recoil";
export { viewmodelAnimator, ViewmodelAnimator } from "./viewmodelAnim";
export type { ViewmodelPose, VmClip, VmEvent } from "./viewmodelAnim";
export { buildViewmodel } from "./viewmodelMesh";
export type { Viewmodel } from "./viewmodelMesh";

export { WeaponEffects } from "./effects";
export { ImpactSystem } from "./impacts";
export { ParticlePool, pspec } from "./particles";
export type { ParticleSpec } from "./particles";
export {
  flashTexture,
  smokeTexture,
  dustTexture,
  sparkTexture,
  decalTexture,
  disposeWeaponTextures,
  type DecalFamily,
} from "./textures";

export {
  setWeaponAudioSink,
  setWeaponVfxSink,
  setWeaponDamageSink,
  setHitboxProvider,
  hitboxProvider,
  primeWeaponAudio,
  disposeWeaponAudio,
  environmentEcho,
  playWeaponSound,
  playGunshot,
  playImpactSound,
  playExplosionSound,
  type WeaponAudioSink,
  type WeaponVfxSink,
  type WeaponDamageSink,
  type WeaponSoundOpts,
  type WeaponVfxEvent,
  type EchoEstimate,
} from "./bridge";

export { weaponInput, installWeaponInput, resetWeaponInput } from "./input";
export type { WeaponInputSnapshot } from "./input";
