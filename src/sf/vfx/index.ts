/**
 * The San Francisco: FREE FALL VFX system — public surface.
 *
 *   import Vfx, { vfx } from "@/sf/vfx";
 *
 *   <Vfx />                                    // once, inside the Canvas
 *   vfx.spawnExplosion(x, y, z, "tank")        // from anywhere
 *   vfx.spawnImpact(x, y, z, nx, ny, nz, "brick")
 *   vfx.setWeather({ rain: 0.8 })
 *
 * Everything is pooled, nothing allocates per frame, and every call is a safe
 * no-op before `<Vfx />` has mounted.
 */

/* ---- the component + the imperative singleton ---- */
export { default, vfx, spawnImpact, spawnMuzzleFlash, spawnCasingGlint, bloodSpray } from "./Vfx";
export type { VfxProps } from "./Vfx";

/* ---- explosions ---- */
export {
  explosions, spawnExplosion, shockwaveBuffer, shockwaveCount, MAX_SHOCKWAVES,
  explosionLightBudget, particleBudget,
} from "./explosion";
export type { ExplosionOptions, ExplosionYield } from "./explosion";

/* ---- particles ---- */
export {
  particles, Billboard, P, resetDesc, budget, setParticleScale, vfxRng,
  emitSphere, emitCone, emitRing, emitTrail, emitOne, STRIDE,
} from "./particles";
export type { ParticleDesc, BillboardMode, LayerName, EmitShapeOptions } from "./particles";

/* ---- fire ---- */
export {
  fire, igniteFire, extinguishFire, isBurningNear, registerFlammable, clearFlammables,
  flammableCount, spawnSmallFire, spawnVehicleFire, spawnFuelFire, flameBurst,
} from "./fire";
export type { FireOptions, Flammable } from "./fire";

/* ---- debris ---- */
export { debris, spawnDebrisBurst, spawnImpactChips, spawnCollapseDust } from "./debris";
export type { DebrisBurstOptions } from "./debris";

/* ---- decals ---- */
export {
  decals, scorchDecal, bulletHoleDecal, bloodDecal, oilDecal, tyreMarkDecal,
  graffitiDecal, crackDecal, wetDecal, sootDecal,
} from "./decals";
export type { DecalOptions } from "./decals";

/* ---- trails ---- */
export {
  trails, rocketTrail, tracerTrail, wingtipTrail, grappleTrail, smokeTrail, contrail,
} from "./trails";
export type { TrailOptions, TrailHandle } from "./trails";

/* ---- environment + weather ---- */
export {
  environment, weather, setWeather, emitExhaust, emitTyreSmoke, emitPowerlineSpark,
  emitWaterSplash, emitFootDust, emitRotorWash,
} from "./environmental";
export type { WeatherState } from "./environmental";

/* ---- textures (for anything that needs the same sprites) ---- */
export {
  Tile, Decal, particleAtlas, decalAtlas, smokeFlipbook, fireFlipbook,
  fireRampTexture, trailProfileTexture, bakeFlipbook, disposeVfxTextures,
  preloadVfxTextures, vfxTextureBytes, tilePxForTier, decalTilePxForTier,
  ATLAS_COLS, ATLAS_ROWS,
} from "./textures";
export type { TileIndex, DecalIndex } from "./textures";
