/**
 * SOAKED — water mode, as data.
 *
 * DROP ZERO already has an arsenal, a health bar, three build materials and a
 * purple storm. SOAKED is the same game with every one of those restated in
 * water-fight terms, and the cheapest way to do that is a lookup table rather
 * than 65k lines of edits. This file IS that table.
 *
 * ── What this is, and is not ──────────────────────────────────────────────
 * Pure data plus pure functions. No THREE, no React, no service registry, no
 * side effects, no module-level mutable state. Every import is `import type`,
 * so nothing here drags a WebGL dependency in: this file is importable from a
 * vitest spec, from `node --experimental-strip-types`, from a balance script.
 * That property is the reason the numbers live here instead of next to the
 * systems that use them.
 *
 * ── How other systems consume it ──────────────────────────────────────────
 * Every water weapon carries an `archetype` — the id of an existing DROP ZERO
 * weapon (`"ar"`, `"pump"`, `"sniper"`, …). The ballistics, the fire mode, the
 * recoil spring and the reload beats are all reused from that def; this table
 * only overrides what the re-theme actually changes: what it is called, how
 * much it soaks, how big its tank is, how fast it refills, how wide it sprays,
 * how fast and how heavy its stream flies, and what colour that stream is.
 *
 *   weapons  → `WATER.weapons`, `waterWeapon(id)`, `waterStats(id, rarity)`
 *   damage   → `applySoak()` (poncho absorbs first, dryness after)
 *   regen    → `dryRate()` — the mechanic the whole mode hangs on
 *   storm    → `downpourSoak(circle)`, `WATER.downpour.palette`
 *   build    → `buildMaterial(kind)`
 *   HUD      → `WATER.strings`, `drynessState(dryness)`
 *   glue     → `WATER.glue`, `glueAccel()`, `stumbleChance()`, `struggleStep()`
 *
 * ── Timing ────────────────────────────────────────────────────────────────
 * Every duration and rate in this file is in SIMULATED SECONDS. Callers must
 * drive them off `ctx.elapsed` / the `dt` handed to `fixed()`, never off
 * `performance.now()`. Under SwiftSHADER this container simulates ~400x slower
 * than wall clock, and a rate compared against wall time silently becomes a
 * different game.
 *
 * ── The one design note worth reading ─────────────────────────────────────
 * "Last one dry" is only a game because of `dryRate`. If dryness were a health
 * bar with a new sticker, the mode would play exactly like DROP ZERO. Because
 * you dry off on your own — slowly, only once nobody has hit you for a few
 * seconds, faster in the wind, not at all in the rain — breaking contact is a
 * real move, chip soak is recoverable, and the Downpour is a clock rather than
 * a wall. Retreating to dry off is the mode. Tune `DRY_*` last and carefully.
 */
import type { HarvestKind, Rarity } from "../types";

/* ------------------------------------------------------------------------ *
 * Small pure helpers used throughout
 * ------------------------------------------------------------------------ */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** `0x8fd8ff` → `"#8fd8ff"`. The HUD is CSS; the renderer is not. */
export function hexColor(n: number): string {
  return `#${(n >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
}

export const RARITY_ORDER: readonly Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];

function rarityIndex(r: Rarity): number {
  const i = RARITY_ORDER.indexOf(r);
  return i < 0 ? 0 : i;
}

/**
 * Rarity scalars. Deliberately the same gentle ladder DROP ZERO uses (~+5% a
 * tier) — a Common Super Soaker has to stay a real weapon, or the mode becomes
 * a loot lottery. Higher tiers also carry more water and spray a touch tighter,
 * which is the part players actually feel.
 */
const RARITY_SOAK = [1, 1.05, 1.11, 1.17, 1.24];
const RARITY_TANK = [1, 1.08, 1.16, 1.25, 1.35];
const RARITY_SPREAD = [1, 0.97, 0.94, 0.91, 0.88];
const RARITY_REFILL = [1, 1.06, 1.12, 1.2, 1.3];

/** Rarity colours, duplicated rather than imported — `types.ts` pulls THREE. */
export const RARITY_TINT: Record<Rarity, number> = {
  common: 0xb1b1b1,
  uncommon: 0x53d24a,
  rare: 0x4c8bf5,
  epic: 0xb455f0,
  legendary: 0xf2a93b,
};

const RARITY_LABEL: Record<Rarity, string> = {
  common: "Leaky",
  uncommon: "Sealed",
  rare: "Pressurised",
  epic: "High-Pressure",
  legendary: "Industrial",
};

/* ------------------------------------------------------------------------ *
 * Weapons
 * ------------------------------------------------------------------------ */

/**
 * The DROP ZERO weapon whose ballistics code this water gun rides on. Ids match
 * `ARSENAL` in `play/weapons.ts` one-for-one; a water weapon is never a new
 * fire mode, only a new skin, a new number set and a new stream.
 */
export type WaterArchetype =
  | "ar"
  | "smg"
  | "pump"
  | "tac"
  | "sniper"
  | "burst"
  | "rocket"
  | "pistol"
  | "minigun";

/** How the stream is drawn and simulated. Maps onto `Ballistic` in weapons.ts. */
export type StreamKind =
  /** A continuous jet. Hitscan under the hood, drawn as a ribbon of droplets. */
  | "jet"
  /** A fan of droplets — the shotgun cone. */
  | "spray"
  /** A discrete travelling blob with real arc. `bullet` ballistics. */
  | "lob"
  /** A blob that bursts on contact. `rocket` ballistics, non-lethal payload. */
  | "burst"
  /** The glue strand. Travels like `lob`, then links what it hits. */
  | "strand";

export interface WaterWeaponDef {
  /** Stable id. Loot, inventory and the HUD key off this. */
  id: string;
  name: string;
  /** Four-to-six char HUD tag. */
  short: string;
  /** The existing weapon whose ballistics/mesh/recoil are reused. */
  archetype: WaterArchetype;
  /** One-line role, shown on the pickup card. */
  role: string;
  /** Which tiers this can roll at. Loot must not roll outside this list. */
  rarities: readonly Rarity[];
  /** Relative weight in the loot table, per rarity roll. */
  lootWeight: number;

  stream: StreamKind;
  /** Dryness removed per hit, at Common. Pellet weapons: per pellet. */
  soak: number;
  /** Droplets per trigger pull. >1 means a cone. */
  pellets: number;
  /** Multiplier for a hit to the face. Kept low — a faceful is funny, not fatal. */
  faceful: number;

  /** Tank capacity in "squirts". Replaces magazine size. */
  tank: number;
  /** Tank units consumed per trigger pull. */
  costPerShot: number;
  /**
   * Units per second regained while pumping (the reload) — a tank is topped up
   * continuously rather than swapped, so interrupting a refill keeps whatever
   * you got in. That is the one mechanical difference from reloading a mag and
   * it makes every fight a question of "do I have enough for one more push".
   */
  refillRate: number;
  /** Seconds of wind-up before `refillRate` starts flowing. */
  refillDelay: number;
  /** Seconds standing in a water source to fill the tank completely. */
  dunkTime: number;

  /** Cone half-angle, radians: hip, sighted, and the extra while moving. */
  spread: number;
  spreadAds: number;
  spreadMove: number;

  /** Metres/second the stream leaves the nozzle at. */
  speed: number;
  /**
   * Downward acceleration on the stream, m/s². This is the arc, and it is the
   * single biggest departure from DROP ZERO: water falls. The Hydro Lance is
   * flattest because leading a drop at 200 m is the whole skill of it; the
   * Balloon Launcher is heaviest because lobbing over a wall is the point.
   */
  arc: number;
  /** Effective reach in metres — past this the stream has fallen apart. */
  range: number;
  /** Metres at which soak starts falling off, and where it bottoms out. */
  falloffStart: number;
  falloffEnd: number;
  /** Fraction of `soak` still delivered past `falloffEnd`. */
  falloffFloor: number;

  /** Impulse applied to whoever it hits, m/s. The Firehose is a shove. */
  knockback: number;
  /** Impulse applied back to the shooter. The Firehose pushes you too. */
  selfPush: number;

  /** Stream colour, and the lighter colour of its spray/mist. */
  streamColor: number;
  mistColor: number;
  /** Nozzle glow radius in metres. 0 = no light. */
  nozzleGlow: number;
  /** Audio cue names this weapon asks the audio system for. */
  sound: string;
  soundRefill: string;
}

/**
 * The arsenal.
 *
 * Balance target: a full bar is 100 dryness plus a poncho worth another 125
 * soak (see `DRYNESS.ponchoEfficiency`), so 225 soak end to end. A Common
 * Super Soaker at 12 a hit needs 19 connected hits for that, and 9 against
 * someone with no poncho — call it three to four seconds of held trigger once
 * misses are in. That is long enough to react, build and break contact, which
 * is what makes the drying mechanic matter, and short enough that a good push
 * still wins. Everything else is placed against that number: use
 * `hitsToSoak()` rather than trusting any of these comments.
 */
export const WATER_WEAPONS: readonly WaterWeaponDef[] = [
  {
    id: "soaker9000",
    name: "Super Soaker 9000",
    short: "SS9K",
    archetype: "ar",
    role: "all-round",
    rarities: ["common", "uncommon", "rare", "epic", "legendary"],
    lootWeight: 30,
    stream: "jet",
    soak: 12,
    pellets: 1,
    faceful: 1.5,
    tank: 30,
    costPerShot: 1,
    refillRate: 12,
    refillDelay: 0.45,
    dunkTime: 1.6,
    spread: 0.021,
    spreadAds: 0.006,
    spreadMove: 0.03,
    speed: 130,
    arc: 5.5,
    range: 220,
    falloffStart: 45,
    falloffEnd: 130,
    falloffFloor: 0.55,
    knockback: 0.4,
    selfPush: 0,
    streamColor: 0x4fc3f7,
    mistColor: 0xd7f2ff,
    nozzleGlow: 0.6,
    sound: "soak-ar",
    soundRefill: "pump-refill",
  },
  {
    id: "squirt-pistol",
    name: "Squirt Pistol",
    short: "SQRT",
    archetype: "pistol",
    role: "sidearm",
    rarities: ["common", "uncommon", "rare", "epic"],
    lootWeight: 26,
    stream: "jet",
    soak: 14,
    pellets: 1,
    faceful: 1.6,
    tank: 16,
    costPerShot: 1,
    // A pistol tops up fast — it is the gun you always have, so it should
    // never be the reason you lose a fight you had already won.
    refillRate: 16,
    refillDelay: 0.3,
    dunkTime: 0.9,
    spread: 0.016,
    spreadAds: 0.005,
    spreadMove: 0.028,
    speed: 105,
    arc: 7.5,
    range: 140,
    falloffStart: 26,
    falloffEnd: 70,
    falloffFloor: 0.45,
    knockback: 0.3,
    selfPush: 0,
    streamColor: 0x7fd7ff,
    mistColor: 0xe4f7ff,
    nozzleGlow: 0.4,
    sound: "soak-pistol",
    soundRefill: "pump-refill",
  },
  {
    id: "drizzler",
    name: "Drizzler 500",
    short: "DRZL",
    archetype: "smg",
    role: "close quarters",
    rarities: ["common", "uncommon", "rare", "epic"],
    lootWeight: 24,
    stream: "jet",
    soak: 7,
    pellets: 1,
    faceful: 1.35,
    tank: 40,
    costPerShot: 1,
    refillRate: 18,
    refillDelay: 0.35,
    dunkTime: 1.8,
    spread: 0.034,
    spreadAds: 0.014,
    spreadMove: 0.042,
    speed: 90,
    arc: 9,
    range: 90,
    falloffStart: 16,
    falloffEnd: 46,
    falloffFloor: 0.4,
    knockback: 0.25,
    selfPush: 0,
    streamColor: 0x6ad0f2,
    mistColor: 0xdff4ff,
    nozzleGlow: 0.45,
    sound: "soak-smg",
    soundRefill: "pump-refill",
  },
  {
    id: "pump-blaster",
    name: "Pump Blaster",
    short: "PUMP",
    archetype: "pump",
    role: "point blank",
    rarities: ["common", "uncommon", "rare", "epic", "legendary"],
    lootWeight: 22,
    stream: "spray",
    // 11 droplets × 9 = 99 at contact range: one pull takes an unponchoed
    // player to a sliver, three get through a full poncho. The falloff floor
    // is brutal on purpose — this gun should be useless at 25 m.
    soak: 9,
    pellets: 11,
    faceful: 1.35,
    tank: 5,
    costPerShot: 1,
    refillRate: 1.4,
    refillDelay: 0.2,
    dunkTime: 2.2,
    spread: 0.105,
    spreadAds: 0.078,
    spreadMove: 0.12,
    speed: 70,
    arc: 14,
    range: 42,
    falloffStart: 6,
    falloffEnd: 24,
    falloffFloor: 0.22,
    knockback: 1.6,
    selfPush: 0.4,
    streamColor: 0x9be8ff,
    mistColor: 0xf2fbff,
    nozzleGlow: 0.9,
    sound: "soak-pump",
    soundRefill: "pump-action",
  },
  {
    id: "hydro-lance",
    name: "Hydro Lance",
    short: "LANCE",
    archetype: "sniper",
    role: "long range",
    rarities: ["rare", "epic", "legendary"],
    lootWeight: 10,
    stream: "jet",
    // Two clean body hits on an unponchoed player, three through a poncho.
    // Never a one-shot through a poncho, even to the face: an instant
    // elimination you never saw coming is the least funny thing that can
    // happen in a water fight.
    soak: 78,
    pellets: 1,
    faceful: 1.6,
    tank: 4,
    costPerShot: 1,
    refillRate: 0.9,
    refillDelay: 0.5,
    dunkTime: 2.6,
    spread: 0.02,
    spreadAds: 0.0,
    spreadMove: 0.06,
    // Fast and flat, but still arcing — the drop is the skill, and it is
    // readable at 150 m+ because the jet is a visible ribbon, not a tracer.
    speed: 230,
    arc: 3.2,
    range: 600,
    falloffStart: 400,
    falloffEnd: 600,
    falloffFloor: 0.8,
    knockback: 1.0,
    selfPush: 0,
    streamColor: 0x2f9fe0,
    mistColor: 0xcfeeff,
    nozzleGlow: 1.1,
    sound: "soak-lance",
    soundRefill: "lance-charge",
  },
  {
    id: "firehose",
    name: "The Firehose",
    short: "HOSE",
    archetype: "minigun",
    role: "suppression / shove",
    rarities: ["rare", "epic", "legendary"],
    lootWeight: 8,
    stream: "jet",
    // Low soak, enormous rate, and the only weapon that genuinely moves people.
    // Its job is denial and comedy: shove someone off their ramp tower.
    soak: 4,
    pellets: 1,
    faceful: 1.1,
    tank: 120,
    costPerShot: 1,
    refillRate: 26,
    refillDelay: 1.1,
    dunkTime: 4.0,
    spread: 0.05,
    spreadAds: 0.032,
    spreadMove: 0.058,
    speed: 80,
    arc: 11,
    range: 110,
    falloffStart: 22,
    falloffEnd: 70,
    falloffFloor: 0.35,
    knockback: 4.2,
    // The recoil pushes YOU too, which is a free movement tech the moment
    // anyone works it out. Leave it in; that is the good kind of emergent.
    selfPush: 1.8,
    streamColor: 0x3fb8f0,
    mistColor: 0xeaf9ff,
    nozzleGlow: 1.3,
    sound: "soak-hose",
    soundRefill: "hose-spool",
  },
  {
    id: "balloon-launcher",
    name: "Balloon Launcher",
    short: "LOB",
    archetype: "rocket",
    role: "anti-structure / area",
    rarities: ["rare", "epic", "legendary"],
    lootWeight: 7,
    stream: "burst",
    /** Direct-hit soak. The burst (see `WATER.balloon`) does most of the work. */
    soak: 34,
    pellets: 1,
    faceful: 1.0,
    tank: 4,
    costPerShot: 1,
    refillRate: 0.6,
    refillDelay: 0.6,
    dunkTime: 3.0,
    spread: 0.012,
    spreadAds: 0.004,
    spreadMove: 0.03,
    speed: 42,
    // Heavy arc: you lob it over your own wall, which is the entire appeal.
    arc: 22,
    range: 260,
    falloffStart: 260,
    falloffEnd: 260,
    falloffFloor: 1,
    knockback: 2.4,
    selfPush: 0,
    streamColor: 0xff5fa2,
    mistColor: 0xffd9e8,
    nozzleGlow: 0.5,
    sound: "soak-lob",
    soundRefill: "balloon-load",
  },
  {
    id: "glue-gun",
    name: "GLUE GUN",
    short: "GLUE",
    archetype: "tac",
    role: "control",
    rarities: ["uncommon", "rare", "epic", "legendary"],
    lootWeight: 9,
    stream: "strand",
    // Barely soaks. It is not a damage weapon and must never become one — its
    // whole value is the strand, and giving it real soak on top would make it
    // the only gun anyone picks up.
    soak: 5,
    pellets: 1,
    faceful: 1.0,
    tank: 6,
    costPerShot: 1,
    refillRate: 1.1,
    refillDelay: 0.5,
    dunkTime: 2.4,
    spread: 0.014,
    spreadAds: 0.005,
    spreadMove: 0.04,
    speed: 58,
    arc: 12,
    range: 60,
    falloffStart: 60,
    falloffEnd: 60,
    falloffFloor: 1,
    knockback: 0,
    selfPush: 0,
    streamColor: 0xd8f36b,
    mistColor: 0xf3ffc9,
    nozzleGlow: 0.7,
    sound: "glue-fire",
    soundRefill: "glue-load",
  },
  {
    id: "triple-tap",
    name: "Triple Tap",
    short: "TRPL",
    archetype: "burst",
    role: "mid range",
    rarities: ["uncommon", "rare", "epic"],
    lootWeight: 14,
    stream: "jet",
    soak: 13,
    pellets: 1,
    faceful: 1.5,
    tank: 24,
    costPerShot: 1,
    refillRate: 11,
    refillDelay: 0.45,
    dunkTime: 1.7,
    spread: 0.014,
    spreadAds: 0.003,
    spreadMove: 0.032,
    speed: 140,
    arc: 5,
    range: 240,
    falloffStart: 60,
    falloffEnd: 150,
    falloffFloor: 0.6,
    knockback: 0.4,
    selfPush: 0,
    streamColor: 0x5ecfff,
    mistColor: 0xdcf4ff,
    nozzleGlow: 0.55,
    sound: "soak-burst",
    soundRefill: "pump-refill",
  },
  {
    id: "tac-soaker",
    name: "Tac Soaker",
    short: "TACS",
    archetype: "tac",
    role: "sustained close",
    rarities: ["common", "uncommon", "rare", "epic"],
    lootWeight: 16,
    stream: "spray",
    soak: 5,
    pellets: 9,
    faceful: 1.25,
    tank: 8,
    costPerShot: 1,
    refillRate: 2.2,
    refillDelay: 0.25,
    dunkTime: 2.0,
    spread: 0.12,
    spreadAds: 0.095,
    spreadMove: 0.14,
    speed: 66,
    arc: 15,
    range: 46,
    falloffStart: 9,
    falloffEnd: 28,
    falloffFloor: 0.25,
    knockback: 0.9,
    selfPush: 0.2,
    streamColor: 0x8fe0ff,
    mistColor: 0xeffbff,
    nozzleGlow: 0.7,
    sound: "soak-tac",
    soundRefill: "pump-action",
  },
];

const WEAPON_BY_ID = new Map<string, WaterWeaponDef>(WATER_WEAPONS.map((w) => [w.id, w]));
/** Reverse map: which water gun replaces a given DROP ZERO archetype by default. */
const WEAPON_BY_ARCHETYPE = new Map<WaterArchetype, WaterWeaponDef>();
for (const w of WATER_WEAPONS) if (!WEAPON_BY_ARCHETYPE.has(w.archetype)) WEAPON_BY_ARCHETYPE.set(w.archetype, w);

export function waterWeapon(id: string): WaterWeaponDef | null {
  return WEAPON_BY_ID.get(id) ?? null;
}

/**
 * The conversion hook loot needs: given a DROP ZERO weapon id, what does it
 * become in water mode? Returns null for archetypes we chose not to re-theme,
 * which the caller should treat as "do not spawn".
 */
export function waterFor(archetype: string): WaterWeaponDef | null {
  return WEAPON_BY_ARCHETYPE.get(archetype as WaterArchetype) ?? null;
}

/** Resolved per-rarity numbers. Nothing should read a raw def field for these. */
export interface WaterStats {
  def: WaterWeaponDef;
  rarity: Rarity;
  /** Soak per droplet. */
  soak: number;
  /** Soak of one complete trigger pull at point blank — the number to show. */
  pullSoak: number;
  faceful: number;
  tank: number;
  refillRate: number;
  /** Seconds from empty to full, including the wind-up. */
  refillTime: number;
  spread: number;
  spreadAds: number;
  displayName: string;
  color: number;
  streamColor: number;
}

export function waterStats(id: string, rarity: Rarity): WaterStats | null {
  const def = WEAPON_BY_ID.get(id);
  if (!def) return null;
  const i = rarityIndex(rarity);
  const soak = def.soak * RARITY_SOAK[i];
  const tank = Math.max(1, Math.round(def.tank * RARITY_TANK[i]));
  const refillRate = def.refillRate * RARITY_REFILL[i];
  return {
    def,
    rarity,
    soak,
    pullSoak: soak * def.pellets,
    faceful: def.faceful,
    tank,
    refillRate,
    refillTime: def.refillDelay + tank / Math.max(0.01, refillRate),
    spread: def.spread * RARITY_SPREAD[i],
    spreadAds: def.spreadAds * RARITY_SPREAD[i],
    displayName: `${RARITY_LABEL[rarity]} ${def.name}`,
    color: RARITY_TINT[rarity],
    streamColor: def.streamColor,
  };
}

/**
 * Soak actually delivered at a distance, after falloff. Pure; callers pass the
 * already-rarity-resolved base soak so this stays one multiply.
 */
export function soakAtRange(def: WaterWeaponDef, baseSoak: number, distance: number): number {
  if (distance <= def.falloffStart) return baseSoak;
  if (distance >= def.range) return 0;
  const span = Math.max(0.001, def.falloffEnd - def.falloffStart);
  const t = clamp01((distance - def.falloffStart) / span);
  return baseSoak * (1 - t * (1 - def.falloffFloor));
}

/* ------------------------------------------------------------------------ *
 * Water balloons — the throwable, and the best thing in the game
 * ------------------------------------------------------------------------ */

export interface BalloonDef {
  id: string;
  name: string;
  /** How many fit in one inventory slot. */
  stack: number;
  rarity: Rarity;
  /** Launch speed, and how much of it is upward. */
  speed: number;
  lift: number;
  /** Downward acceleration, m/s². Heavier than a gun stream — it is a water bomb. */
  gravity: number;
  /** Air drag per second. */
  drag: number;
  /**
   * Seconds before it pops on its own. Long, because a balloon that survives a
   * bounce and rolls under someone's ramp is the shot everyone tells stories
   * about. It bursts on player contact regardless of the fuse.
   */
  fuse: number;
  /** True: bursts the instant it touches anything solid. */
  burstOnImpact: boolean;
  /** Metres. Generous on purpose — you should not need to be precise. */
  radius: number;
  /** Soak at the centre of the burst, falling to `edgeSoak` at the rim. */
  soak: number;
  edgeSoak: number;
  /** Outward impulse, m/s. Enough to stagger, never enough to kill by fall. */
  knockback: number;
  /** Seconds the ground stays a slippery puddle after a burst. */
  puddleTime: number;
  /** Movement multiplier while standing in that puddle. */
  puddleFriction: number;
  /** How much speed survives a bounce, and how much the surface scrubs. */
  restitution: number;
  friction: number;
  /** Seconds before you can throw again. */
  cooldown: number;
  /** Skin colours it rolls between — balloons should never all match. */
  colors: readonly number[];
  splashColor: number;
  sound: string;
  soundBurst: string;
}

/**
 * One balloon, several skins.
 *
 * 62 centre soak with a 6.5 m radius is decisive without being an elimination
 * on its own: it takes a full poncho off, or it finishes anyone already wet.
 * The radius is the deliberate part — Fortnite's frag is 5.4 m and demands a
 * good throw; this is bigger so that a *bad* throw still does something, which
 * is what makes it fun to spam and what makes a box fight chaos.
 */
export const WATER_BALLOON: BalloonDef = {
  id: "balloon",
  name: "Water Balloon",
  stack: 8,
  rarity: "uncommon",
  speed: 19,
  lift: 0.32,
  gravity: 22,
  drag: 0.1,
  fuse: 4.5,
  burstOnImpact: true,
  radius: 6.5,
  soak: 62,
  edgeSoak: 18,
  knockback: 3.2,
  puddleTime: 6,
  puddleFriction: 0.72,
  restitution: 0.28,
  friction: 0.62,
  cooldown: 0.5,
  colors: [0xff5fa2, 0x5ecfff, 0xffe45e, 0x8affc1, 0xc08aff],
  splashColor: 0xdff4ff,
  sound: "balloon-throw",
  soundBurst: "balloon-burst",
};

/** Soak delivered by a balloon burst at a distance from its centre. */
export function balloonSoakAt(distance: number, def: BalloonDef = WATER_BALLOON): number {
  if (distance >= def.radius) return 0;
  const t = clamp01(distance / def.radius);
  // Quadratic falloff, not linear: the centre stays punishing while the rim
  // still counts for something, which is how a big radius avoids feeling like
  // a flat area-denial rectangle.
  return def.edgeSoak + (def.soak - def.edgeSoak) * (1 - t) * (1 - t);
}

/* ------------------------------------------------------------------------ *
 * THE GLUE GUN
 * ------------------------------------------------------------------------ */

/** What the far end of a strand is stuck to. */
export type GlueAnchorKind = "player" | "ground" | "build";

/** Why a strand ended — the HUD and the audio both branch on this. */
export type GlueBreakReason = "expired" | "stretched" | "struggled" | "eliminated";

export interface GlueDef {
  /** Resting length. Inside this the strand is slack and costs nothing. */
  restLength: number;
  /**
   * Past this the strand snaps on its own after `snapHold` seconds. The gap
   * between rest and max is the whole game of being glued: 3.2 → 7 m is close
   * enough to fight in and far enough to make a run for it feel possible.
   */
  maxLength: number;
  /** Seconds spent beyond `maxLength` before the strand gives way. */
  snapHold: number;

  /**
   * Pull acceleration per metre of stretch beyond rest, m/s². Applied toward
   * the other end, to BOTH ends — a glued pair is a two-body problem and if
   * only the victim felt it the shooter would have a free tether.
   */
  pullPerMetre: number;
  /** Ceiling on that acceleration, so a long stretch is not a slingshot. */
  maxPull: number;
  /** Speed multiplier while stretched past rest, scaling to `minSlow` at max. */
  minSlow: number;

  /**
   * Move faster than this while stretched and you start rolling to stumble.
   * Below walk speed (5.6) so that walking while glued is always safe and
   * sprinting never is — that is the readable rule players learn in one match.
   */
  stumbleSpeed: number;
  /** Stumble rolls per second at full stretch and full speed. */
  stumbleRate: number;
  /** Seconds face-down after a stumble: no firing, no building, camera low. */
  fallTime: number;
  /** Seconds of stumble immunity after getting back up. */
  fallCooldown: number;
  /** Soak taken on hitting the ground. Small — the indignity is the punishment. */
  fallSoak: number;

  /** Seconds a strand lasts if nothing else breaks it. */
  duration: number;
  /** Struggle progress (0..1) added per struggle input press. */
  struggleGain: number;
  /** Struggle progress bled off per second when you stop mashing. */
  struggleDecay: number;
  /** Input the struggle prompt asks for. */
  struggleKey: string;

  /** Ground/build anchors: no pull, just a leash of this radius. */
  anchorRadius: number;
  /** Movement multiplier while anchored, inside that radius. */
  anchorSlow: number;

  /** Strands drawn per player at once. Beyond this the oldest breaks. */
  maxStrands: number;
  /** Rendering: rope segments, radius, and how far it sags at rest. */
  segments: number;
  strandRadius: number;
  sag: number;
  color: number;
  glowColor: number;
  sound: string;
  soundStick: string;
  soundSnap: string;
  soundStumble: string;
}

/**
 * The glue gun, in full.
 *
 * Design intent: it never removes control, it makes control expensive. You can
 * always move — you just cannot move FAST, and choosing to anyway is what puts
 * you on your face. Nothing here should ever be tuned into a stun.
 */
export const GLUE: GlueDef = {
  restLength: 3.2,
  maxLength: 7.0,
  snapHold: 0.6,
  pullPerMetre: 8.5,
  maxPull: 26,
  minSlow: 0.45,
  stumbleSpeed: 5.0,
  stumbleRate: 2.4,
  fallTime: 1.6,
  fallCooldown: 1.2,
  fallSoak: 4,
  duration: 12,
  // Measured against `struggleStep`: a realistic 8 presses/second frees you in
  // ~22 presses, about 2.7 seconds. The decay is set so half-hearted mashing
  // (under ~4/s) never converges at all — you either commit or you stay stuck.
  struggleGain: 0.09,
  struggleDecay: 0.35,
  struggleKey: "Space",
  anchorRadius: 2.6,
  anchorSlow: 0.55,
  maxStrands: 2,
  segments: 14,
  strandRadius: 0.05,
  sag: 0.35,
  color: 0xd8f36b,
  glowColor: 0xf3ffc9,
  sound: "glue-fire",
  soundStick: "glue-stick",
  soundSnap: "glue-snap",
  soundStumble: "glue-stumble",
};

/** Acceleration the strand applies to each end, given the current separation. */
export function glueAccel(distance: number, def: GlueDef = GLUE): number {
  const stretch = distance - def.restLength;
  if (stretch <= 0) return 0;
  return Math.min(def.maxPull, stretch * def.pullPerMetre);
}

/** Movement multiplier for a glued player at the current separation. */
export function glueSlow(distance: number, def: GlueDef = GLUE): number {
  const span = Math.max(0.001, def.maxLength - def.restLength);
  const t = clamp01((distance - def.restLength) / span);
  return 1 - t * (1 - def.minSlow);
}

/**
 * Probability of stumbling this step. Callers pass SIMULATED dt (from
 * `fixed()`), compare against `ctx.rng()`, and get a Poisson-ish roll that is
 * frame-rate independent — the same tether feels the same at 30 and 240 fps.
 */
export function stumbleChance(speed: number, distance: number, dt: number, def: GlueDef = GLUE): number {
  if (speed <= def.stumbleSpeed) return 0;
  if (distance <= def.restLength) return 0;
  const span = Math.max(0.001, def.maxLength - def.restLength);
  const stretch = clamp01((distance - def.restLength) / span);
  const over = clamp01((speed - def.stumbleSpeed) / Math.max(0.001, def.stumbleSpeed));
  return clamp01(def.stumbleRate * stretch * over * dt);
}

/**
 * Advance a struggle meter. `pressed` is the edge-triggered struggle input for
 * this step; `dt` is simulated seconds. Returns the new 0..1 progress — at 1
 * the strand breaks with reason `"struggled"`.
 */
export function struggleStep(progress: number, pressed: boolean, dt: number, def: GlueDef = GLUE): number {
  const next = progress + (pressed ? def.struggleGain : 0) - def.struggleDecay * dt;
  return clamp01(next);
}

/* ------------------------------------------------------------------------ *
 * Dryness — health, restated
 * ------------------------------------------------------------------------ */

/** Coarse condition bands. The HUD colours the bar off these; bots read them too. */
export type DrynessBand = "bone-dry" | "damp" | "wet" | "drenched" | "soaked";

export interface DrynessBandInfo {
  key: DrynessBand;
  label: string;
  /** Inclusive lower bound of the band. */
  min: number;
  color: number;
}

/**
 * Five bands. Named so a callout ("I'm drenched") means one specific thing to
 * a squad, which is why the labels are short and non-overlapping.
 */
export const DRYNESS_BANDS: readonly DrynessBandInfo[] = [
  { key: "bone-dry", label: "BONE DRY", min: 80, color: 0xffe9a8 },
  { key: "damp", label: "DAMP", min: 55, color: 0xd6f0b0 },
  { key: "wet", label: "WET", min: 30, color: 0x8fd8ff },
  { key: "drenched", label: "DRENCHED", min: 10, color: 0x4c9fe0 },
  { key: "soaked", label: "SOAKED THROUGH", min: 0, color: 0x2a5f96 },
];

export function drynessBand(dryness: number): DrynessBandInfo {
  for (const b of DRYNESS_BANDS) if (dryness >= b.min) return b;
  return DRYNESS_BANDS[DRYNESS_BANDS.length - 1];
}

export interface DrynessDef {
  /** 100 = bone dry. 0 = out. */
  max: number;
  /** Poncho ceiling — the shield bar. */
  ponchoMax: number;
  /**
   * Poncho soaks up water at a discount before any reaches you. 0.8 means a
   * poncho eats 100 soak with 80 points of poncho, i.e. it is worth slightly
   * more than raw dryness, which is what makes looting one a real priority.
   */
  ponchoEfficiency: number;
  /**
   * Fraction of a hit that bleeds through a poncho to dryness anyway. Small,
   * but nonzero: a fully ponchoed player should still visibly get wetter, or
   * the shield bar becomes an invisible second health bar with no feedback.
   */
  ponchoBleed: number;

  /** Dryness per second regained, once drying has started. */
  dryRate: number;
  /** Seconds without taking soak before drying starts. */
  dryDelay: number;
  /** Ceiling natural drying reaches. Below `max` — a towel gets the last of it. */
  dryCap: number;
  /** Multiplier while sprinting: wind. The reason running away actually works. */
  dryWindBonus: number;
  /** Multiplier while under cover (a roof, a built floor overhead). */
  dryShelterBonus: number;
  /** Multiplier while in the Downpour or in water: none of it, ever. */
  dryInRain: number;
  /** Poncho never dries on its own. Only an item restores it. */
  ponchoRegen: number;

  /** Below this you are downed rather than out, in squads. */
  downThreshold: number;
  /** Dryness you are revived at. */
  reviveDryness: number;
  /** Dryness lost per second while downed. */
  downBleed: number;
  /** Seconds to revive a downed teammate. */
  reviveTime: number;
}

export const DRYNESS: DrynessDef = {
  max: 100,
  ponchoMax: 100,
  ponchoEfficiency: 0.8,
  ponchoBleed: 0.08,
  // 3.2/s means a full bar from empty in ~30 seconds of hiding — long enough
  // that it is a real commitment, short enough that it is worth doing.
  dryRate: 3.2,
  dryDelay: 5,
  dryCap: 100,
  dryWindBonus: 1.35,
  dryShelterBonus: 1.6,
  dryInRain: 0,
  ponchoRegen: 0,
  downThreshold: 0,
  reviveDryness: 30,
  downBleed: 2.2,
  reviveTime: 7,
};

export interface SoakResult {
  dryness: number;
  poncho: number;
  /** How much of the hit the poncho ate. */
  absorbedByPoncho: number;
  /** How much actually reached the player. */
  toDryness: number;
  /** True if this hit took them to zero. */
  soakedOut: boolean;
}

/**
 * Apply soak. Poncho first (at a discount, with a small bleed-through), then
 * dryness. Pure — returns new values, mutates nothing, so combat can preview a
 * hit and the AI teammate can reason about one without touching state.
 */
export function applySoak(
  dryness: number,
  poncho: number,
  amount: number,
  def: DrynessDef = DRYNESS,
): SoakResult {
  const dry0 = clamp(dryness, 0, def.max);
  const pon0 = clamp(poncho, 0, def.ponchoMax);
  const hit = Math.max(0, amount);

  const bleed = pon0 > 0 ? hit * def.ponchoBleed : 0;
  const forPoncho = hit - bleed;
  const ponchoCost = forPoncho * def.ponchoEfficiency;
  const absorbedCost = Math.min(pon0, ponchoCost);
  const absorbedSoak = absorbedCost / Math.max(0.001, def.ponchoEfficiency);
  const overflow = forPoncho - absorbedSoak;

  const toDryness = bleed + Math.max(0, overflow);
  const dryness1 = clamp(dry0 - toDryness, 0, def.max);
  return {
    dryness: dryness1,
    poncho: clamp(pon0 - absorbedCost, 0, def.ponchoMax),
    absorbedByPoncho: absorbedCost,
    toDryness,
    soakedOut: dryness1 <= 0,
  };
}

/**
 * How many hits of `soakPerHit` it takes to soak someone out from here. This
 * is the balance function — every "n hits to kill" claim in this file is a
 * call to it, and a balance script or a spec can check them all in a loop.
 */
export function hitsToSoak(
  soakPerHit: number,
  dryness = DRYNESS.max,
  poncho = DRYNESS.ponchoMax,
  def: DrynessDef = DRYNESS,
): number {
  if (soakPerHit <= 0) return Infinity;
  let d = dryness;
  let p = poncho;
  let n = 0;
  // Iterated rather than solved, because the poncho bleed makes the two bars
  // drain at once and a closed form would drift from what combat actually does.
  while (d > 0 && n < 1000) {
    const r = applySoak(d, p, soakPerHit, def);
    d = r.dryness;
    p = r.poncho;
    n++;
  }
  return n;
}

/** Conditions the drying model cares about. All booleans, all cheap to read. */
export interface DryConditions {
  /** Simulated seconds since the last soak of any kind. */
  sinceSoak: number;
  /** In the Downpour, in the sea, or standing in a balloon puddle. */
  inRain: boolean;
  /** Sprinting — wind across a wet shirt. */
  sprinting: boolean;
  /** Under a roof or a built floor. */
  sheltered: boolean;
}

/**
 * Dryness per SIMULATED second regained right now. Multiply by `dt` in
 * `fixed()`; never by a wall-clock delta.
 *
 * The three multipliers stack (wind × shelter) on purpose: standing under an
 * awning after a sprint is the fastest way to dry, which quietly teaches
 * players to disengage into cover rather than into the open.
 */
export function dryRate(cond: DryConditions, def: DrynessDef = DRYNESS): number {
  if (cond.inRain) return def.dryRate * def.dryInRain;
  if (cond.sinceSoak < def.dryDelay) return 0;
  let r = def.dryRate;
  if (cond.sprinting) r *= def.dryWindBonus;
  if (cond.sheltered) r *= def.dryShelterBonus;
  return r;
}

/** Convenience: apply one step of natural drying. Pure. */
export function dryStep(dryness: number, cond: DryConditions, dt: number, def: DrynessDef = DRYNESS): number {
  return clamp(dryness + dryRate(cond, def) * dt, 0, def.dryCap);
}

/* ------------------------------------------------------------------------ *
 * Towels — consumables, restated
 * ------------------------------------------------------------------------ */

export interface TowelDef {
  id: string;
  /** The DROP ZERO consumable this replaces, so inventory can map 1:1. */
  replaces: string;
  name: string;
  useTime: number;
  /** Dryness restored, and the ceiling it restores to (0 = the player's max). */
  dryness: number;
  drynessCap: number;
  /** Poncho restored, and its ceiling. */
  poncho: number;
  ponchoCap: number;
  stack: number;
  rarity: Rarity;
  sound: string;
}

/**
 * The caps carry the same design as DROP ZERO's: a Poncho Patch tops out at
 * half, so the back half of the blue bar is always a Full Poncho, and a towel
 * stops at 75 so the last quarter of dryness costs you a Hair Dryer or a fight
 * taken wet.
 */
export const TOWELS: readonly TowelDef[] = [
  {
    id: "poncho-patch",
    replaces: "shield-small",
    name: "Poncho Patch",
    useTime: 2.0,
    dryness: 0,
    drynessCap: 0,
    poncho: 25,
    ponchoCap: 50,
    stack: 6,
    rarity: "uncommon",
    sound: "poncho-on",
  },
  {
    id: "poncho-full",
    replaces: "shield-big",
    name: "Full Poncho",
    useTime: 5.0,
    dryness: 0,
    drynessCap: 0,
    poncho: 50,
    ponchoCap: 0,
    stack: 3,
    rarity: "rare",
    sound: "poncho-on",
  },
  {
    id: "towel",
    replaces: "bandage",
    name: "Beach Towel",
    useTime: 4.0,
    dryness: 15,
    drynessCap: 75,
    poncho: 0,
    ponchoCap: 0,
    stack: 15,
    rarity: "common",
    sound: "towel-rub",
  },
  {
    id: "hair-dryer",
    replaces: "medkit",
    name: "Hair Dryer",
    useTime: 10.0,
    dryness: 100,
    drynessCap: 0,
    poncho: 0,
    ponchoCap: 0,
    stack: 3,
    rarity: "uncommon",
    sound: "hair-dryer",
  },
];

const TOWEL_BY_ID = new Map<string, TowelDef>(TOWELS.map((t) => [t.id, t]));
const TOWEL_BY_SOURCE = new Map<string, TowelDef>(TOWELS.map((t) => [t.replaces, t]));

export function towel(id: string): TowelDef | null {
  return TOWEL_BY_ID.get(id) ?? null;
}

/** Given a DROP ZERO consumable id (`"shield-small"`), what it becomes here. */
export function towelFor(consumableId: string): TowelDef | null {
  return TOWEL_BY_SOURCE.get(consumableId) ?? null;
}

/* ------------------------------------------------------------------------ *
 * Build materials
 * ------------------------------------------------------------------------ */

export interface WaterMaterialDef {
  /** The `HarvestKind` this maps onto. Three tiers, same as ever. */
  kind: HarvestKind;
  name: string;
  /** Singular, for the harvest popup. */
  unit: string;
  /** Tint applied to the built piece. */
  color: number;
  /** Accent used for the edge recess and the HUD counter. */
  accent: number;
  /**
   * Fraction of incoming soak that passes THROUGH a piece of this material to
   * whoever is behind it. Foam drinks a jet; a tarp sheds it entirely. This is
   * the one genuinely new build stat the re-theme adds, and it gives the tiers
   * a reason to exist beyond hit points.
   */
  soakThrough: number;
  /** What a harvested surface sounds like. */
  harvestSound: string;
}

/**
 * Pool noodles, deck planks, corrugated tarp. Same three-tier ladder, same HP
 * (that lives in `building.ts` and is not ours to change) — what changes is the
 * name, the colour and how wet you get standing behind it.
 */
export const WATER_MATERIALS: Record<HarvestKind, WaterMaterialDef> = {
  wood: {
    kind: "wood",
    name: "Pool Noodles",
    unit: "noodle",
    color: 0xff9f43,
    accent: 0xffd9a8,
    soakThrough: 0.18,
    harvestSound: "harvest-foam",
  },
  stone: {
    kind: "stone",
    name: "Deck Planks",
    unit: "plank",
    color: 0xd9c39a,
    accent: 0xf0e3c6,
    soakThrough: 0.08,
    harvestSound: "harvest-plank",
  },
  metal: {
    kind: "metal",
    name: "Corrugated Tarp",
    unit: "tarp",
    color: 0x7fd0e8,
    accent: 0xcdeef8,
    soakThrough: 0.0,
    harvestSound: "harvest-tarp",
  },
};

export function buildMaterial(kind: HarvestKind): WaterMaterialDef {
  return WATER_MATERIALS[kind];
}

/* ------------------------------------------------------------------------ *
 * THE DOWNPOUR — the storm, restated
 * ------------------------------------------------------------------------ */

export interface DownpourPalette {
  /** The wall itself, and the brighter rim where it meets the ground. */
  wall: number;
  rim: number;
  /** Falling rain streaks, and the mist that hangs at the base. */
  rain: number;
  mist: number;
  /** Spray kicked up where the wall crosses terrain. */
  spray: number;
  /** The next-circle marker ribbon on the ground and on the map. */
  nextRing: number;
  /** Safe-zone ring on the map. */
  safeRing: number;
  /** Sky tint inside the Downpour, for fog and ambient. */
  skyTint: number;
  /** Screen-edge vignette while you are caught in it. */
  vignette: number;
}

export interface DownpourDef {
  name: string;
  palette: DownpourPalette;
  /**
   * Soak per second outside the wall, indexed by circle (0-based; circle 1 is
   * index 0). Eight circles, mirroring `PHASES` in `play/storm.ts`.
   *
   * These run slightly hotter than DROP ZERO's storm dps because dryness comes
   * BACK. 0.9/s against a 3.2/s dry rate is genuinely survivable early; by
   * circle 7 at 8.5/s you are losing ground five times faster than you can
   * recover it, which is exactly when the ring should stop being negotiable.
   */
  soakPerSecond: readonly number[];
  /** Soak lands in whole ticks this often — discrete feedback beats a drip. */
  tickInterval: number;
  /** Wall opacity, rain density (drops per m³) and streak length. */
  wallOpacity: number;
  rainDensity: number;
  streakLength: number;
  /** Wind push applied to a player inside the Downpour, m/s. */
  wind: number;
  /** Ambience and warning cue names. */
  ambience: string;
  soundWarn: string;
  soundEnter: string;
}

export const DOWNPOUR: DownpourDef = {
  name: "THE DOWNPOUR",
  palette: {
    wall: 0x5ab6e8,
    rim: 0xbfe9ff,
    rain: 0x9fd9f5,
    mist: 0xdff4ff,
    spray: 0xf2fbff,
    nextRing: 0xfff2a8,
    safeRing: 0x8fd8ff,
    skyTint: 0x486b86,
    vignette: 0x2f6fb0,
  },
  soakPerSecond: [0.9, 0.9, 1.4, 1.6, 2.6, 5.0, 8.5, 11.0],
  tickInterval: 1.0,
  wallOpacity: 0.42,
  rainDensity: 0.6,
  streakLength: 1.8,
  wind: 1.4,
  ambience: "downpour-loop",
  soundWarn: "downpour-warn",
  soundEnter: "downpour-enter",
};

/** Soak per second for a 1-indexed circle number. Clamps at both ends. */
export function downpourSoak(circle: number, def: DownpourDef = DOWNPOUR): number {
  const t = def.soakPerSecond;
  const i = clamp(Math.round(circle) - 1, 0, t.length - 1);
  return t[i];
}

/**
 * Seconds a player at this dryness survives outside the wall on this circle,
 * accounting for the fact that they cannot dry while in it. Bots use this to
 * decide whether a rotation is even possible; the HUD uses it for the warning.
 * `Infinity` when the circle does no meaningful damage.
 */
export function downpourSurvival(dryness: number, poncho: number, circle: number): number {
  const dps = downpourSoak(circle);
  if (dps <= 0) return Infinity;
  const effective = dryness + poncho / Math.max(0.001, DRYNESS.ponchoEfficiency);
  return effective / dps;
}

/* ------------------------------------------------------------------------ *
 * Strings — every player-facing label, in one table
 * ------------------------------------------------------------------------ */

export interface WaterStrings {
  /** Mode identity. */
  modeName: string;
  modeTagline: string;
  /** Feed + banner. `{name}` and `{by}` are substituted by the HUD. */
  eliminated: string;
  eliminatedFeed: string;
  eliminatedBy: string;
  knocked: string;
  knockedFeed: string;
  revived: string;
  selfSoak: string;
  /** Victory. */
  victory: string;
  victorySub: string;
  placement: string;
  /** Bars and counters. */
  drynessLabel: string;
  ponchoLabel: string;
  tankLabel: string;
  tankEmpty: string;
  refilling: string;
  aliveLabel: string;
  elimsLabel: string;
  /** Storm. */
  stormName: string;
  stormWarn: string;
  stormClosing: string;
  stormIn: string;
  stormSafe: string;
  /** Drying. */
  dryingOff: string;
  dryingBlocked: string;
  fullyDry: string;
  /** Glue. */
  glued: string;
  gluedTo: string;
  gluePrompt: string;
  glueSnapped: string;
  stumbled: string;
  /** Prompts. */
  pickUp: string;
  dunkPrompt: string;
  revivePrompt: string;
  /** Squad. */
  squadName: string;
  squadMates: readonly string[];
  /** Build materials, mirrored from `WATER_MATERIALS` for one-table HUD reads. */
  materials: Record<HarvestKind, string>;
  /** Dryness band labels, mirrored from `DRYNESS_BANDS`. */
  bands: Record<DrynessBand, string>;
}

export const STRINGS: WaterStrings = {
  modeName: "SOAKED",
  modeTagline: "Last one dry wins.",
  eliminated: "SOAKED!",
  eliminatedFeed: "{by} soaked {name}",
  eliminatedBy: "SOAKED BY {by}",
  knocked: "WATERLOGGED",
  knockedFeed: "{by} drenched {name}",
  revived: "TOWELLED OFF",
  selfSoak: "You soaked yourself",
  victory: "LAST ONE DRY",
  victorySub: "Not a drop on you.",
  placement: "#{n} DRIEST",
  drynessLabel: "DRY",
  ponchoLabel: "PONCHO",
  tankLabel: "TANK",
  tankEmpty: "TANK DRY",
  refilling: "REFILLING",
  aliveLabel: "STILL DRY",
  elimsLabel: "SOAKINGS",
  stormName: "THE DOWNPOUR",
  stormWarn: "THE DOWNPOUR IS CLOSING",
  stormClosing: "DOWNPOUR CLOSING IN {t}",
  stormIn: "YOU ARE IN THE DOWNPOUR",
  stormSafe: "DRY GROUND",
  dryingOff: "DRYING OFF",
  dryingBlocked: "TOO WET TO DRY",
  fullyDry: "BONE DRY",
  glued: "GLUED!",
  gluedTo: "GLUED TO {name}",
  gluePrompt: "MASH {key} TO PEEL OFF",
  glueSnapped: "GLUE SNAPPED",
  stumbled: "STUMBLED",
  pickUp: "HOLD E — {item}",
  dunkPrompt: "HOLD E — REFILL TANK",
  revivePrompt: "HOLD E — TOWEL OFF {name}",
  squadName: "SQUAD",
  squadMates: ["Jack", "Atlas", "Claude"],
  materials: {
    wood: WATER_MATERIALS.wood.name,
    stone: WATER_MATERIALS.stone.name,
    metal: WATER_MATERIALS.metal.name,
  },
  bands: {
    "bone-dry": "BONE DRY",
    damp: "DAMP",
    wet: "WET",
    drenched: "DRENCHED",
    soaked: "SOAKED THROUGH",
  },
};

/** Substitute `{token}` placeholders in a string from this table. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/* ------------------------------------------------------------------------ *
 * The aggregate other files import
 * ------------------------------------------------------------------------ */

/**
 * One import for consumers that want the whole table:
 *
 *     import { WATER } from "../mode/water";
 *     const soak = WATER.dryness.max;
 *
 * Named exports stay available for anyone who wants just one piece. Frozen
 * shallowly so a system cannot accidentally rebind a branch mid-match; the
 * leaf objects are plain data and are never written to.
 */
export const WATER = Object.freeze({
  strings: STRINGS,
  weapons: WATER_WEAPONS,
  balloon: WATER_BALLOON,
  glue: GLUE,
  dryness: DRYNESS,
  bands: DRYNESS_BANDS,
  towels: TOWELS,
  materials: WATER_MATERIALS,
  downpour: DOWNPOUR,
  rarityTint: RARITY_TINT,
  rarityOrder: RARITY_ORDER,
});

export type WaterMode = typeof WATER;
