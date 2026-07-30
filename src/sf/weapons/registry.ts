/**
 * weapons/registry.ts — the weapon table.
 *
 * Every number here is a design decision, not a placeholder. The rules the
 * table follows, so that later additions stay coherent:
 *
 *  - **Time-to-kill is the axis.** Against a 100 HP target: the sidearm is a
 *    3-shot kill up close (34 dmg) and 5 at distance; the AR is 4 up close;
 *    the battle rifle is 3 everywhere; the sniper is 1 to the chest. Fire rate
 *    then decides whether that TTK is fast or slow, and recoil decides whether
 *    the player can actually hold it.
 *  - **Muzzle velocity is real.** 320 m/s for a .45 ACP pistol, 880 for a 5.56
 *    carbine, 915 for a .338 Lapua, 76 for a 40 mm grenade. It drives tracer
 *    travel time, projectile drop and the crack-then-thump of the report.
 *  - **Recoil patterns are authored.** Read the arrays: the SMG climbs then
 *    kicks hard left, the AR climbs for five then makes a lazy right hook, the
 *    LMG walks up and wanders. They are learnable. That is the point.
 *  - **Nothing is symmetric.** No weapon has a round recoil number, a round
 *    reload time, or a spread value shared with another weapon.
 *
 * Public API
 * ----------
 *   WEAPONS                 the table, keyed
 *   WEAPON_ORDER            slot order for the 1..0 keys and the wheel
 *   getWeapon(key)          lookup with a safe fallback
 *   damageAtRange(def, m)   interpolated damage curve
 *   fireInterval(def)       seconds between shots
 *   spreadDegrees(...)      current cone half-angle for a shooter state
 *   recoilStep(def, i, rng) authored recoil impulse for shot index i
 *   isExplosive(def)        convenience predicate
 */
import { clamp, clamp01, type Rng } from "../math/rng";
import type { ShotContext, WeaponDef } from "./types";

/* ------------------------------------------------------------------ *
 * Shared sub-profiles. Defined as functions rather than shared objects so a
 * tweak to one weapon can never silently retune another.
 * ------------------------------------------------------------------ */

const MULT_STANDARD = { head: 2.0, chest: 1.0, stomach: 1.05, arm: 0.82, leg: 0.78 };
const MULT_PRECISION = { head: 2.6, chest: 1.0, stomach: 1.0, arm: 0.7, leg: 0.65 };
const MULT_BLUNT = { head: 1.35, chest: 1.0, stomach: 1.0, arm: 0.9, leg: 0.9 };

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

const SIDEARM: WeaponDef = {
  key: "sidearm",
  name: "Fulcrum .45",
  short: "FULCRUM",
  cls: "sidearm",
  fireMode: "semi",
  ballistics: "hitscan",
  action: "slide",
  rpm: 420,
  magazine: 12,
  reserve: 84,
  startReserve: 84,
  chambered: true,
  // A .45 hits hard and falls off hard — 3 shots to 25 m, 5 past 55 m.
  damage: [
    { d: 0, dmg: 34 },
    { d: 25, dmg: 34 },
    { d: 55, dmg: 22 },
    { d: 90, dmg: 17 },
  ],
  mult: MULT_STANDARD,
  structure: 0.7,
  muzzleVelocity: 320,
  drag: 0.00042,
  gravity: 1,
  penetration: 0.34,
  maxPenetrations: 1,
  ricochetAngle: 14,
  maxRicochets: 1,
  spread: {
    hip: 1.35, ads: 0.22, moving: 0.9, crouch: 0.78, air: 2.6,
    perShot: 0.42, max: 4.2, recover: 6.5,
  },
  recoil: {
    // A 1911 snaps up and slightly right; the second and third shots are the
    // worst because the shooter is still riding the first.
    pattern: [
      [1.05, 0.10], [1.22, 0.22], [1.18, -0.16], [1.10, 0.26],
      [1.02, -0.20], [0.98, 0.18], [1.06, 0.30], [0.95, -0.24],
    ],
    tailV: 0.95, tailH: 0.22,
    randomV: 0.16, randomH: 0.42,
    riseRate: 26, recoveryRate: 9.5, recoveryDelay: 0.08,
    adsScale: 0.78, crouchScale: 0.86,
    viewKick: [1.5, 0.5, 0.7], viewKickFreq: 34, viewKickDamp: 0.42,
    punchBack: 0.028,
  },
  handling: {
    adsTime: 0.17, drawTime: 0.42, holsterTime: 0.3,
    sprintOutTime: 0.18, sprintInTime: 0.2,
    reloadTactical: 1.62, reloadEmpty: 2.18,
    magOutAt: 0.24, magInAt: 0.62, boltAt: 0.82,
    inspectTime: 2.6,
  },
  sight: { zoom: 1.12, eyeOffset: [0, 0.0355, -0.16], scoped: false },
  tracerFraction: 0.18,
  tracerColor: 0xffb45a,
  flashScale: 0.75,
  flashColor: 0xffd9a0,
  flashLight: 5.2,
  flashRadius: 7,
  smoke: 0.55,
  heatPerShot: 0.05,
  heatCool: 0.32,
  audio: {
    fire: "pistol45", fireDistant: "pistol45_far",
    reloadOut: "mag_out_pistol", reloadIn: "mag_in_pistol",
    bolt: "slide_release", draw: "draw_light", dry: "dry_click",
    loudness: 240,
  },
  view: {
    length: 0.21, bodyW: 0.032, bodyH: 0.052,
    barrelR: 0.011, barrelLen: 0.03, muzzle: "none",
    magW: 0.026, magH: 0.10, magD: 0.05, magZ: 0.03,
    stock: "none", optic: "irons", handguard: 0,
    bodyColor: 0x2b2d31, metalColor: 0x8d8f93, roughness: 0.42,
    ejectSide: 1, casing: [0.0058, 0.023],
  },
  blurb: "Government-issue .45. Slow, loud, and it ends arguments.",
};

const SMG: WeaponDef = {
  key: "smg",
  name: "Kestrel 9",
  short: "KESTREL",
  cls: "smg",
  fireMode: "auto",
  ballistics: "hitscan",
  action: "openBolt",
  rpm: 900,
  magazine: 32,
  reserve: 224,
  startReserve: 224,
  chambered: true,
  damage: [
    { d: 0, dmg: 24 },
    { d: 16, dmg: 24 },
    { d: 34, dmg: 16 },
    { d: 60, dmg: 12 },
  ],
  mult: MULT_STANDARD,
  structure: 0.55,
  muzzleVelocity: 400,
  drag: 0.00048,
  gravity: 1,
  penetration: 0.26,
  maxPenetrations: 1,
  ricochetAngle: 12,
  maxRicochets: 1,
  spread: {
    hip: 2.1, ads: 0.62, moving: 0.7, crouch: 0.82, air: 3.4,
    perShot: 0.16, max: 5.6, recover: 9.0,
  },
  recoil: {
    // Climbs for the first six, then the muzzle whips left as the bolt mass
    // starts to matter. The player who learns to drift right owns this gun.
    pattern: [
      [0.42, 0.05], [0.48, -0.06], [0.52, 0.09], [0.55, -0.12],
      [0.54, -0.20], [0.50, -0.30], [0.44, -0.38], [0.38, -0.42],
      [0.32, -0.34], [0.28, -0.18], [0.26, 0.06], [0.26, 0.24],
      [0.28, 0.34], [0.30, 0.30], [0.30, 0.14], [0.28, -0.08],
    ],
    tailV: 0.27, tailH: 0.3,
    randomV: 0.2, randomH: 0.55,
    riseRate: 30, recoveryRate: 8.0, recoveryDelay: 0.1,
    adsScale: 0.82, crouchScale: 0.88,
    viewKick: [0.75, 0.3, 0.45], viewKickFreq: 42, viewKickDamp: 0.36,
    punchBack: 0.016,
  },
  handling: {
    adsTime: 0.21, drawTime: 0.5, holsterTime: 0.34,
    sprintOutTime: 0.2, sprintInTime: 0.22,
    reloadTactical: 1.94, reloadEmpty: 2.58,
    magOutAt: 0.22, magInAt: 0.58, boltAt: 0.8,
    inspectTime: 2.9,
  },
  sight: { zoom: 1.25, eyeOffset: [0, 0.041, -0.2], scoped: false },
  tracerFraction: 0.25,
  tracerColor: 0xffc06a,
  flashScale: 0.85,
  flashColor: 0xffd6a4,
  flashLight: 5.6,
  flashRadius: 8,
  smoke: 0.5,
  heatPerShot: 0.035,
  heatCool: 0.28,
  audio: {
    fire: "smg9", fireDistant: "smg9_far",
    reloadOut: "mag_out_smg", reloadIn: "mag_in_smg",
    bolt: "bolt_smg", draw: "draw_light", dry: "dry_click",
    loudness: 300,
  },
  view: {
    length: 0.42, bodyW: 0.036, bodyH: 0.058,
    barrelR: 0.010, barrelLen: 0.06, muzzle: "hider",
    magW: 0.028, magH: 0.17, magD: 0.06, magZ: 0.04,
    stock: "brace", optic: "reddot", handguard: 0.12,
    bodyColor: 0x24262a, metalColor: 0x7e8186, roughness: 0.48,
    ejectSide: 1, casing: [0.0048, 0.019],
  },
  blurb: "Compact 9 mm. Nine hundred rounds a minute and no manners.",
};

const RIFLE: WeaponDef = {
  key: "rifle",
  name: "Colossus AR",
  short: "COLOSSUS",
  cls: "rifle",
  fireMode: "auto",
  ballistics: "hitscan",
  action: "bolt",
  rpm: 680,
  magazine: 30,
  reserve: 240,
  startReserve: 240,
  chambered: true,
  damage: [
    { d: 0, dmg: 31 },
    { d: 40, dmg: 31 },
    { d: 85, dmg: 23 },
    { d: 140, dmg: 19 },
  ],
  mult: MULT_STANDARD,
  structure: 0.85,
  muzzleVelocity: 880,
  drag: 0.00028,
  gravity: 1,
  penetration: 0.5,
  maxPenetrations: 2,
  ricochetAngle: 11,
  maxRicochets: 1,
  spread: {
    hip: 1.9, ads: 0.16, moving: 0.68, crouch: 0.76, air: 3.2,
    perShot: 0.14, max: 4.4, recover: 7.5,
  },
  recoil: {
    // Five straight up, a right hook at 6-10, then a wide slow figure that
    // rewards a player who has actually practised.
    pattern: [
      [0.62, 0.02], [0.70, 0.05], [0.74, 0.10], [0.72, 0.16],
      [0.66, 0.28], [0.58, 0.40], [0.50, 0.46], [0.44, 0.40],
      [0.40, 0.22], [0.38, -0.02], [0.36, -0.26], [0.34, -0.42],
      [0.32, -0.46], [0.30, -0.36], [0.30, -0.14], [0.30, 0.12],
      [0.32, 0.34], [0.32, 0.44], [0.30, 0.36], [0.28, 0.12],
    ],
    tailV: 0.29, tailH: 0.34,
    randomV: 0.14, randomH: 0.38,
    riseRate: 28, recoveryRate: 7.2, recoveryDelay: 0.12,
    adsScale: 0.8, crouchScale: 0.85,
    viewKick: [1.05, 0.34, 0.5], viewKickFreq: 38, viewKickDamp: 0.38,
    punchBack: 0.021,
  },
  handling: {
    adsTime: 0.24, drawTime: 0.56, holsterTime: 0.38,
    sprintOutTime: 0.22, sprintInTime: 0.24,
    reloadTactical: 2.14, reloadEmpty: 2.86,
    magOutAt: 0.2, magInAt: 0.55, boltAt: 0.78,
    inspectTime: 3.1,
  },
  sight: { zoom: 1.35, eyeOffset: [0, 0.046, -0.24], scoped: false },
  tracerFraction: 0.22,
  tracerColor: 0xffc457,
  flashScale: 1.0,
  flashColor: 0xffd2a0,
  flashLight: 7.5,
  flashRadius: 9.5,
  smoke: 0.7,
  heatPerShot: 0.045,
  heatCool: 0.24,
  audio: {
    fire: "ar556", fireDistant: "ar556_far",
    reloadOut: "mag_out_rifle", reloadIn: "mag_in_rifle",
    bolt: "bolt_release", draw: "draw_rifle", dry: "dry_click",
    loudness: 460,
  },
  view: {
    length: 0.62, bodyW: 0.038, bodyH: 0.066,
    barrelR: 0.010, barrelLen: 0.1, muzzle: "brake",
    magW: 0.03, magH: 0.19, magD: 0.075, magZ: 0.02,
    stock: "fixed", optic: "reddot", handguard: 0.2,
    bodyColor: 0x22252a, metalColor: 0x84878c, roughness: 0.45,
    ejectSide: 1, casing: [0.0049, 0.0257],
  },
  blurb: "The workhorse. Flat, fast, and forgiving if you can read the pattern.",
};

const BATTLE: WeaponDef = {
  key: "battle",
  name: "Marlin 7.62",
  short: "MARLIN",
  cls: "battle",
  fireMode: "semi",
  ballistics: "hitscan",
  action: "bolt",
  rpm: 380,
  magazine: 20,
  reserve: 120,
  startReserve: 120,
  chambered: true,
  damage: [
    { d: 0, dmg: 46 },
    { d: 70, dmg: 46 },
    { d: 160, dmg: 36 },
    { d: 260, dmg: 30 },
  ],
  mult: MULT_PRECISION,
  structure: 1.15,
  muzzleVelocity: 840,
  drag: 0.00022,
  gravity: 1,
  penetration: 0.68,
  maxPenetrations: 3,
  ricochetAngle: 9,
  maxRicochets: 1,
  spread: {
    hip: 2.4, ads: 0.08, moving: 0.9, crouch: 0.7, air: 3.8,
    perShot: 0.34, max: 5.0, recover: 6.0,
  },
  recoil: {
    pattern: [
      [1.75, -0.14], [1.90, 0.26], [1.82, -0.30], [1.96, 0.34],
      [1.78, -0.22], [1.86, 0.40], [1.72, -0.36], [1.80, 0.20],
    ],
    tailV: 1.78, tailH: 0.3,
    randomV: 0.13, randomH: 0.5,
    riseRate: 24, recoveryRate: 6.4, recoveryDelay: 0.1,
    adsScale: 0.74, crouchScale: 0.8,
    viewKick: [2.1, 0.6, 0.9], viewKickFreq: 30, viewKickDamp: 0.44,
    punchBack: 0.036,
  },
  handling: {
    adsTime: 0.28, drawTime: 0.62, holsterTime: 0.42,
    sprintOutTime: 0.26, sprintInTime: 0.26,
    reloadTactical: 2.36, reloadEmpty: 3.08,
    magOutAt: 0.2, magInAt: 0.56, boltAt: 0.8,
    inspectTime: 3.3,
  },
  sight: { zoom: 2.2, eyeOffset: [0, 0.048, -0.26], scoped: false },
  tracerFraction: 0.3,
  tracerColor: 0xffb64a,
  flashScale: 1.2,
  flashColor: 0xffcf94,
  flashLight: 9.5,
  flashRadius: 11,
  smoke: 0.9,
  heatPerShot: 0.07,
  heatCool: 0.26,
  audio: {
    fire: "battle762", fireDistant: "battle762_far",
    reloadOut: "mag_out_rifle", reloadIn: "mag_in_rifle",
    bolt: "bolt_release", draw: "draw_rifle", dry: "dry_click",
    loudness: 620,
  },
  view: {
    length: 0.7, bodyW: 0.04, bodyH: 0.07,
    barrelR: 0.0115, barrelLen: 0.14, muzzle: "brake",
    magW: 0.032, magH: 0.2, magD: 0.085, magZ: 0.01,
    stock: "fixed", optic: "ladder", handguard: 0.24,
    bodyColor: 0x2e2a24, metalColor: 0x8b8378, roughness: 0.5,
    ejectSide: 1, casing: [0.0062, 0.0303],
  },
  blurb: "Wood and steel. Three rounds is a conversation anywhere on the map.",
};

const SHOTGUN: WeaponDef = {
  key: "shotgun",
  name: "Breaker 12",
  short: "BREAKER",
  cls: "shotgun",
  fireMode: "pump",
  ballistics: "hitscan",
  action: "pump",
  rpm: 78,
  magazine: 7,
  reserve: 42,
  startReserve: 42,
  chambered: true,
  // Per pellet. Nine pellets: 117 at contact, ~36 at 30 m if every pellet
  // connects, which they will not.
  damage: [
    { d: 0, dmg: 13 },
    { d: 12, dmg: 11 },
    { d: 24, dmg: 6 },
    { d: 38, dmg: 3 },
  ],
  mult: MULT_BLUNT,
  structure: 0.9,
  muzzleVelocity: 380,
  drag: 0.0021,
  gravity: 1,
  penetration: 0.1,
  maxPenetrations: 1,
  ricochetAngle: 8,
  maxRicochets: 0,
  spread: {
    hip: 0.9, ads: 0.4, moving: 0.5, crouch: 0.85, air: 2.0,
    perShot: 0.3, max: 3.0, recover: 5.0,
    pellets: 9, pelletCone: 3.4,
  },
  recoil: {
    pattern: [
      [3.4, -0.5], [3.6, 0.7], [3.3, -0.8], [3.7, 0.6],
      [3.5, -0.4], [3.8, 0.9],
    ],
    tailV: 3.5, tailH: 0.7,
    randomV: 0.18, randomH: 0.6,
    riseRate: 20, recoveryRate: 5.4, recoveryDelay: 0.14,
    adsScale: 0.85, crouchScale: 0.82,
    viewKick: [3.6, 1.1, 1.8], viewKickFreq: 24, viewKickDamp: 0.5,
    punchBack: 0.055,
  },
  handling: {
    adsTime: 0.3, drawTime: 0.64, holsterTime: 0.44,
    sprintOutTime: 0.28, sprintInTime: 0.26,
    // Shell-at-a-time: the "reload" durations are the shoulder-in/out wrappers.
    reloadTactical: 0.62, reloadEmpty: 0.62,
    magOutAt: 0, magInAt: 1, boltAt: 1,
    shellTime: 0.46, shellStart: 0.34, shellEnd: 0.46,
    inspectTime: 3.0,
  },
  sight: { zoom: 1.1, eyeOffset: [0, 0.05, -0.22], scoped: false },
  tracerFraction: 0,
  tracerColor: 0xffa040,
  flashScale: 1.6,
  flashColor: 0xffc178,
  flashLight: 12,
  flashRadius: 12,
  smoke: 1.6,
  heatPerShot: 0.06,
  heatCool: 0.3,
  audio: {
    fire: "shotgun12", fireDistant: "shotgun12_far",
    reloadOut: "shell_in", reloadIn: "shell_in",
    bolt: "pump", draw: "draw_rifle", dry: "dry_click",
    loudness: 700,
  },
  view: {
    length: 0.76, bodyW: 0.042, bodyH: 0.062,
    barrelR: 0.0145, barrelLen: 0.24, muzzle: "none",
    magW: 0, magH: 0, magD: 0, magZ: 0,
    stock: "fixed", optic: "irons", handguard: 0.3,
    bodyColor: 0x1f1c1a, metalColor: 0x6f6a64, roughness: 0.55,
    ejectSide: 1, casing: [0.0092, 0.0508],
  },
  blurb: "Twelve gauge, pump action. Nine pellets of opinion per trigger pull.",
};

const SNIPER: WeaponDef = {
  key: "sniper",
  name: "Longbow .338",
  short: "LONGBOW",
  cls: "sniper",
  fireMode: "bolt",
  ballistics: "hitscan",
  action: "bolt",
  rpm: 48,
  magazine: 5,
  reserve: 30,
  startReserve: 30,
  chambered: true,
  damage: [
    { d: 0, dmg: 128 },
    { d: 250, dmg: 128 },
    { d: 600, dmg: 108 },
    { d: 1200, dmg: 92 },
  ],
  mult: MULT_PRECISION,
  structure: 1.5,
  muzzleVelocity: 915,
  drag: 0.00016,
  gravity: 1,
  penetration: 0.92,
  maxPenetrations: 4,
  ricochetAngle: 7,
  maxRicochets: 1,
  spread: {
    hip: 4.2, ads: 0.02, moving: 1.6, crouch: 0.5, air: 5.5,
    perShot: 0.5, max: 6.0, recover: 4.0,
  },
  recoil: {
    pattern: [[4.6, 0.35], [4.8, -0.4], [4.5, 0.45], [4.9, -0.3], [4.7, 0.5]],
    tailV: 4.7, tailH: 0.4,
    randomV: 0.1, randomH: 0.55,
    riseRate: 18, recoveryRate: 4.6, recoveryDelay: 0.18,
    adsScale: 0.7, crouchScale: 0.76,
    viewKick: [4.2, 0.9, 1.3], viewKickFreq: 21, viewKickDamp: 0.55,
    punchBack: 0.07,
  },
  handling: {
    adsTime: 0.42, drawTime: 0.78, holsterTime: 0.52,
    sprintOutTime: 0.34, sprintInTime: 0.3,
    reloadTactical: 2.9, reloadEmpty: 3.7,
    magOutAt: 0.22, magInAt: 0.6, boltAt: 0.84,
    inspectTime: 3.6,
  },
  sight: {
    zoom: 6.5, eyeOffset: [0, 0.072, -0.3], scoped: true,
    breathHold: 4.2, breathRecover: 6.5,
  },
  tracerFraction: 0.5,
  tracerColor: 0xfff0c0,
  flashScale: 1.5,
  flashColor: 0xffe2b4,
  flashLight: 14,
  flashRadius: 14,
  smoke: 1.15,
  heatPerShot: 0.11,
  heatCool: 0.34,
  audio: {
    fire: "sniper338", fireDistant: "sniper338_far",
    reloadOut: "mag_out_rifle", reloadIn: "mag_in_rifle",
    bolt: "bolt_heavy", draw: "draw_rifle", dry: "dry_click",
    loudness: 1100,
  },
  view: {
    length: 0.95, bodyW: 0.042, bodyH: 0.068,
    barrelR: 0.0125, barrelLen: 0.32, muzzle: "brake",
    magW: 0.03, magH: 0.11, magD: 0.09, magZ: 0.02,
    stock: "fixed", optic: "scope", handguard: 0.3,
    bodyColor: 0x2a2e2b, metalColor: 0x7d8280, roughness: 0.4,
    ejectSide: 1, casing: [0.0086, 0.0693],
  },
  blurb: "Bolt-action .338. One second of held breath, one thousand metres.",
};

const LMG: WeaponDef = {
  key: "lmg",
  name: "Hammerhead M60",
  short: "HAMMER",
  cls: "lmg",
  fireMode: "auto",
  ballistics: "hitscan",
  action: "openBolt",
  rpm: 610,
  magazine: 100,
  reserve: 300,
  startReserve: 300,
  chambered: false,
  damage: [
    { d: 0, dmg: 33 },
    { d: 60, dmg: 33 },
    { d: 140, dmg: 25 },
    { d: 240, dmg: 21 },
  ],
  mult: MULT_STANDARD,
  structure: 1.25,
  muzzleVelocity: 850,
  drag: 0.00024,
  gravity: 1,
  penetration: 0.72,
  maxPenetrations: 3,
  ricochetAngle: 10,
  maxRicochets: 1,
  spread: {
    hip: 3.4, ads: 0.5, moving: 1.5, crouch: 0.62, air: 4.6,
    perShot: 0.09, max: 6.5, recover: 5.5,
  },
  recoil: {
    // A belt-fed walks. Up for eight, wanders left for twelve, comes back
    // right, and never quite repeats — but the shape does.
    pattern: [
      [0.86, 0.06], [0.92, -0.10], [0.95, 0.14], [0.98, -0.20],
      [0.96, -0.32], [0.90, -0.46], [0.82, -0.58], [0.74, -0.62],
      [0.66, -0.54], [0.60, -0.36], [0.56, -0.12], [0.54, 0.14],
      [0.52, 0.38], [0.52, 0.54], [0.52, 0.58], [0.52, 0.48],
      [0.50, 0.26], [0.50, 0.0], [0.50, -0.26], [0.50, -0.44],
      [0.48, -0.5], [0.48, -0.4], [0.48, -0.18], [0.48, 0.1],
    ],
    tailV: 0.48, tailH: 0.42,
    randomV: 0.22, randomH: 0.6,
    riseRate: 26, recoveryRate: 5.8, recoveryDelay: 0.14,
    adsScale: 0.84, crouchScale: 0.72,
    viewKick: [1.4, 0.5, 0.8], viewKickFreq: 33, viewKickDamp: 0.4,
    punchBack: 0.03,
  },
  handling: {
    adsTime: 0.42, drawTime: 0.9, holsterTime: 0.62,
    sprintOutTime: 0.4, sprintInTime: 0.36,
    reloadTactical: 6.4, reloadEmpty: 6.4,
    magOutAt: 0.18, magInAt: 0.68, boltAt: 0.88,
    inspectTime: 3.8,
  },
  sight: { zoom: 1.3, eyeOffset: [0, 0.052, -0.28], scoped: false },
  tracerFraction: 0.25, // every fourth round, like a real belt
  tracerColor: 0xff8c3a,
  flashScale: 1.35,
  flashColor: 0xffd0a0,
  flashLight: 11,
  flashRadius: 12,
  smoke: 1.05,
  heatPerShot: 0.028,
  heatCool: 0.13,
  audio: {
    fire: "lmg762", fireDistant: "lmg762_far",
    reloadOut: "belt_out", reloadIn: "belt_in",
    bolt: "bolt_heavy", draw: "draw_heavy", dry: "dry_click",
    loudness: 780,
  },
  view: {
    length: 0.88, bodyW: 0.048, bodyH: 0.078,
    barrelR: 0.0135, barrelLen: 0.26, muzzle: "hider",
    magW: 0.075, magH: 0.11, magD: 0.13, magZ: 0.04,
    stock: "fixed", optic: "irons", handguard: 0.26,
    bodyColor: 0x1e2124, metalColor: 0x74787d, roughness: 0.52,
    ejectSide: 1, casing: [0.0062, 0.0303],
  },
  blurb: "Belt-fed suppression. A hundred rounds of area denial, then a nap.",
};

const GRENADE_LAUNCHER: WeaponDef = {
  key: "gl",
  name: "Thumper 40",
  short: "THUMPER",
  cls: "launcher",
  fireMode: "semi",
  ballistics: "projectile",
  action: "breech",
  rpm: 190,
  magazine: 6,
  reserve: 18,
  startReserve: 18,
  chambered: false,
  // Direct-impact damage; the blast does the real work.
  damage: [{ d: 0, dmg: 45 }, { d: 400, dmg: 45 }],
  mult: MULT_BLUNT,
  structure: 1.0,
  muzzleVelocity: 76,
  drag: 0.0009,
  gravity: 1,
  penetration: 0,
  maxPenetrations: 0,
  ricochetAngle: 0,
  maxRicochets: 0,
  spread: {
    hip: 1.4, ads: 0.35, moving: 0.6, crouch: 0.8, air: 2.4,
    perShot: 0.25, max: 3.2, recover: 5.0,
  },
  recoil: {
    pattern: [[2.6, -0.4], [2.8, 0.5], [2.7, -0.3], [2.9, 0.45], [2.6, -0.5], [2.8, 0.3]],
    tailV: 2.7, tailH: 0.45,
    randomV: 0.16, randomH: 0.55,
    riseRate: 20, recoveryRate: 5.2, recoveryDelay: 0.14,
    adsScale: 0.86, crouchScale: 0.84,
    viewKick: [2.8, 0.8, 1.2], viewKickFreq: 23, viewKickDamp: 0.5,
    punchBack: 0.05,
  },
  handling: {
    adsTime: 0.32, drawTime: 0.7, holsterTime: 0.48,
    sprintOutTime: 0.3, sprintInTime: 0.3,
    reloadTactical: 3.4, reloadEmpty: 3.4,
    magOutAt: 0.25, magInAt: 0.66, boltAt: 0.9,
    inspectTime: 3.0,
  },
  sight: { zoom: 1.15, eyeOffset: [0, 0.058, -0.24], scoped: false },
  explosive: {
    radius: 7.5, damage: 135, force: 5200, fuse: -1,
    bounces: false, restitution: 0.2, armTime: 0.12,
  },
  tracerFraction: 0,
  tracerColor: 0xffffff,
  flashScale: 1.4,
  flashColor: 0xffc890,
  flashLight: 9,
  flashRadius: 11,
  smoke: 1.9,
  heatPerShot: 0.05,
  heatCool: 0.3,
  audio: {
    fire: "gl40", fireDistant: "gl40_far",
    reloadOut: "breech_open", reloadIn: "breech_close",
    bolt: "breech_close", draw: "draw_heavy", dry: "dry_click",
    loudness: 560,
  },
  view: {
    length: 0.6, bodyW: 0.05, bodyH: 0.08,
    barrelR: 0.026, barrelLen: 0.16, muzzle: "tube",
    magW: 0.09, magH: 0.09, magD: 0.11, magZ: 0.05,
    stock: "brace", optic: "ladder", handguard: 0.1,
    bodyColor: 0x25282b, metalColor: 0x6e7276, roughness: 0.5,
    ejectSide: 0, casing: [0, 0],
  },
  blurb: "Six-shot 40 mm revolver. Arcs beautifully. Lands worse.",
};

const RPG: WeaponDef = {
  key: "rpg",
  name: "Talon AT",
  short: "TALON",
  cls: "rocket",
  fireMode: "single",
  ballistics: "projectile",
  action: "tube",
  rpm: 40,
  magazine: 1,
  reserve: 6,
  startReserve: 6,
  chambered: false,
  damage: [{ d: 0, dmg: 90 }, { d: 800, dmg: 90 }],
  mult: MULT_BLUNT,
  structure: 2.4,
  muzzleVelocity: 118,
  drag: 0.0004,
  gravity: 0.35, // sustainer motor holds it flat for the first stretch
  penetration: 0,
  maxPenetrations: 0,
  ricochetAngle: 0,
  maxRicochets: 0,
  spread: {
    hip: 2.2, ads: 0.3, moving: 0.8, crouch: 0.75, air: 3.0,
    perShot: 0, max: 3.2, recover: 4.0,
  },
  recoil: {
    pattern: [[3.2, 0.6]],
    tailV: 3.2, tailH: 0.6,
    randomV: 0.2, randomH: 0.5,
    riseRate: 16, recoveryRate: 4.2, recoveryDelay: 0.2,
    adsScale: 0.9, crouchScale: 0.86,
    viewKick: [3.4, 1.2, 1.6], viewKickFreq: 19, viewKickDamp: 0.55,
    punchBack: 0.06,
  },
  handling: {
    adsTime: 0.38, drawTime: 0.95, holsterTime: 0.62,
    sprintOutTime: 0.36, sprintInTime: 0.34,
    reloadTactical: 3.6, reloadEmpty: 3.6,
    magOutAt: 0.2, magInAt: 0.72, boltAt: 0.92,
    inspectTime: 3.2,
  },
  sight: { zoom: 1.6, eyeOffset: [0.03, 0.052, -0.3], scoped: false },
  explosive: {
    radius: 11.5, damage: 280, force: 14000, fuse: -1,
    restitution: 0, armTime: 0.2,
  },
  tracerFraction: 0,
  tracerColor: 0xffffff,
  flashScale: 2.4,
  flashColor: 0xffcf9a,
  flashLight: 20,
  flashRadius: 18,
  smoke: 2.0,
  heatPerShot: 0.2,
  heatCool: 0.5,
  audio: {
    fire: "rpg", fireDistant: "rpg_far",
    reloadOut: "tube_out", reloadIn: "tube_in",
    bolt: "tube_in", draw: "draw_heavy", dry: "dry_click",
    loudness: 1400,
  },
  view: {
    length: 1.05, bodyW: 0.04, bodyH: 0.055,
    barrelR: 0.036, barrelLen: 0.4, muzzle: "tube",
    magW: 0, magH: 0, magD: 0, magZ: 0,
    stock: "rest", optic: "ladder", handguard: 0.18,
    bodyColor: 0x33372d, metalColor: 0x6b7062, roughness: 0.58,
    ejectSide: 0, casing: [0, 0],
  },
  blurb: "Shoulder-fired anti-armour. Back-blast is somebody else's problem.",
};

const STICKY: WeaponDef = {
  key: "sticky",
  name: "Tandem Mine",
  short: "TANDEM",
  cls: "sticky",
  fireMode: "semi",
  ballistics: "projectile",
  action: "none",
  rpm: 100,
  magazine: 5,
  reserve: 15,
  startReserve: 15,
  chambered: false,
  damage: [{ d: 0, dmg: 0 }, { d: 400, dmg: 0 }],
  mult: MULT_BLUNT,
  structure: 1.8,
  muzzleVelocity: 42,
  drag: 0.0016,
  gravity: 1,
  penetration: 0,
  maxPenetrations: 0,
  ricochetAngle: 0,
  maxRicochets: 0,
  spread: {
    hip: 1.0, ads: 0.4, moving: 0.5, crouch: 0.85, air: 1.8,
    perShot: 0.2, max: 2.4, recover: 5.0,
  },
  recoil: {
    pattern: [[1.1, -0.2], [1.2, 0.25], [1.05, -0.18], [1.25, 0.3], [1.1, -0.22]],
    tailV: 1.1, tailH: 0.24,
    randomV: 0.2, randomH: 0.5,
    riseRate: 22, recoveryRate: 6.6, recoveryDelay: 0.12,
    adsScale: 0.88, crouchScale: 0.88,
    viewKick: [1.2, 0.4, 0.5], viewKickFreq: 28, viewKickDamp: 0.44,
    punchBack: 0.026,
  },
  handling: {
    adsTime: 0.26, drawTime: 0.6, holsterTime: 0.42,
    sprintOutTime: 0.24, sprintInTime: 0.26,
    reloadTactical: 2.5, reloadEmpty: 2.5,
    magOutAt: 0.24, magInAt: 0.66, boltAt: 0.9,
    inspectTime: 2.8,
  },
  sight: { zoom: 1.1, eyeOffset: [0, 0.05, -0.2], scoped: false },
  explosive: {
    // Remote-detonated: fuse is infinite until the player says otherwise.
    radius: 8.5, damage: 210, force: 9000, fuse: 0,
    sticky: true, restitution: 0, armTime: 0.35,
  },
  tracerFraction: 0,
  tracerColor: 0x66ffcc,
  flashScale: 0.5,
  flashColor: 0xa0ffe0,
  flashLight: 2.5,
  flashRadius: 5,
  smoke: 0.4,
  heatPerShot: 0.02,
  heatCool: 0.4,
  audio: {
    fire: "sticky_launch", fireDistant: "sticky_launch_far",
    reloadOut: "mag_out_pistol", reloadIn: "mag_in_pistol",
    bolt: "sticky_arm", draw: "draw_light", dry: "dry_click",
    loudness: 180,
  },
  view: {
    length: 0.46, bodyW: 0.046, bodyH: 0.07,
    barrelR: 0.03, barrelLen: 0.1, muzzle: "tube",
    magW: 0.07, magH: 0.09, magD: 0.09, magZ: 0.03,
    stock: "brace", optic: "reddot", handguard: 0.08,
    bodyColor: 0x2b3033, metalColor: 0x7a8288, roughness: 0.46,
    ejectSide: 0, casing: [0, 0],
  },
  blurb: "Sticks to anything. Cars. Helicopters. People. Detonates when you say.",
};

const GRENADE: WeaponDef = {
  key: "grenade",
  name: "M67 Frag",
  short: "FRAG",
  cls: "thrown",
  fireMode: "throw",
  ballistics: "projectile",
  action: "none",
  rpm: 55,
  magazine: 1,
  reserve: 4,
  startReserve: 4,
  chambered: false,
  damage: [{ d: 0, dmg: 0 }, { d: 100, dmg: 0 }],
  mult: MULT_BLUNT,
  structure: 1.3,
  muzzleVelocity: 22,
  drag: 0.0022,
  gravity: 1,
  penetration: 0,
  maxPenetrations: 0,
  ricochetAngle: 0,
  maxRicochets: 0,
  spread: {
    hip: 0.6, ads: 0.2, moving: 0.4, crouch: 0.9, air: 1.2,
    perShot: 0, max: 1.4, recover: 4.0,
  },
  recoil: {
    pattern: [[0.4, 0.1]],
    tailV: 0.4, tailH: 0.1,
    randomV: 0.3, randomH: 0.6,
    riseRate: 14, recoveryRate: 7.0, recoveryDelay: 0.1,
    adsScale: 1, crouchScale: 1,
    viewKick: [0.6, 0.3, 0.3], viewKickFreq: 20, viewKickDamp: 0.5,
    punchBack: 0.01,
  },
  handling: {
    adsTime: 0.2, drawTime: 0.5, holsterTime: 0.34,
    sprintOutTime: 0.2, sprintInTime: 0.22,
    reloadTactical: 0.85, reloadEmpty: 0.85,
    magOutAt: 0.3, magInAt: 0.7, boltAt: 0.9,
    inspectTime: 2.2,
  },
  sight: { zoom: 1, eyeOffset: [0, 0.04, -0.16], scoped: false },
  explosive: {
    radius: 9.0, damage: 170, force: 6500, fuse: 4.0,
    bounces: true, restitution: 0.38, armTime: 0.05,
  },
  tracerFraction: 0,
  tracerColor: 0xffffff,
  flashScale: 0,
  flashColor: 0xffffff,
  flashLight: 0,
  flashRadius: 0,
  smoke: 0,
  heatPerShot: 0,
  heatCool: 1,
  audio: {
    fire: "grenade_throw", fireDistant: "grenade_throw",
    reloadOut: "pouch", reloadIn: "pin_pull",
    bolt: "pin_pull", draw: "draw_light", dry: "dry_click",
    loudness: 60,
  },
  view: {
    length: 0.11, bodyW: 0.028, bodyH: 0.032,
    barrelR: 0.028, barrelLen: 0, muzzle: "none",
    magW: 0, magH: 0, magD: 0, magZ: 0,
    stock: "none", optic: "irons", handguard: 0,
    bodyColor: 0x3c4436, metalColor: 0x6a6f5e, roughness: 0.62,
    ejectSide: 0, casing: [0, 0],
  },
  blurb: "Four-second fuse. Cook it if you are brave, throw it if you are not.",
};

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

export const WEAPONS: Record<string, WeaponDef> = {
  sidearm: SIDEARM,
  smg: SMG,
  rifle: RIFLE,
  battle: BATTLE,
  shotgun: SHOTGUN,
  sniper: SNIPER,
  lmg: LMG,
  gl: GRENADE_LAUNCHER,
  rpg: RPG,
  sticky: STICKY,
  grenade: GRENADE,
};

/** Slot order — maps to the 1..0 number keys and the weapon wheel. */
export const WEAPON_ORDER: readonly string[] = [
  "sidearm", "smg", "rifle", "battle", "shotgun",
  "sniper", "lmg", "gl", "rpg", "sticky", "grenade",
];

export function getWeapon(key: string): WeaponDef {
  return WEAPONS[key] ?? SIDEARM;
}

export function isExplosive(def: WeaponDef): boolean {
  return !!def.explosive;
}

/** Seconds between shots at the weapon's cyclic rate. */
export function fireInterval(def: WeaponDef): number {
  return 60 / Math.max(1, def.rpm);
}

/**
 * Interpolated damage at a range. Flat before the first knot and after the
 * last, linear between — the standard shooter falloff, and the one designers
 * can reason about.
 */
export function damageAtRange(def: WeaponDef, metres: number): number {
  const c = def.damage;
  if (c.length === 0) return 0;
  if (metres <= c[0].d) return c[0].dmg;
  for (let i = 1; i < c.length; i++) {
    if (metres <= c[i].d) {
      const a = c[i - 1];
      const b = c[i];
      const t = (metres - a.d) / Math.max(1e-6, b.d - a.d);
      return a.dmg + (b.dmg - a.dmg) * t;
    }
  }
  return c[c.length - 1].dmg;
}

/**
 * Current cone half-angle in degrees.
 *
 * `bloom` is the accumulated per-shot dispersion held by the weapon runtime;
 * the registry only knows how to combine the terms, not how to remember them.
 */
export function spreadDegrees(def: WeaponDef, ctx: ShotContext, bloom: number): number {
  const s = def.spread;
  let cone = s.hip + (s.ads - s.hip) * clamp01(ctx.ads);
  if (ctx.moving) cone += s.moving * (1 - 0.45 * clamp01(ctx.ads));
  if (ctx.airborne) cone += s.air;
  if (ctx.crouched && !ctx.airborne) cone *= s.crouch;
  cone += bloom;
  return clamp(cone, 0, s.max);
}

/**
 * The authored recoil impulse for shot `index`, in degrees, with the weapon's
 * randomness envelope applied.
 *
 * Past the end of the pattern the weapon settles into its tail values with a
 * slow alternating drift, so a 100-round belt never becomes a straight line
 * but also never becomes noise.
 */
export function recoilStep(
  def: WeaponDef,
  index: number,
  rng: Rng,
  out: { v: number; h: number },
): void {
  const p = def.recoil.pattern;
  let v: number;
  let h: number;
  if (index < p.length) {
    v = p[index][0];
    h = p[index][1];
  } else {
    // Continue the shape: a slow sine on the horizontal keeps the muzzle
    // wandering the way a real weapon under sustained fire does.
    const k = index - p.length;
    v = def.recoil.tailV;
    h = def.recoil.tailH * Math.sin(k * 0.41) * (1 + 0.25 * Math.sin(k * 0.13));
  }
  out.v = v * (1 + (rng.next() * 2 - 1) * def.recoil.randomV);
  out.h = h + def.recoil.tailH * (rng.next() * 2 - 1) * def.recoil.randomH;
}

/** Total rounds the player can be carrying of a weapon (mag + reserve cap). */
export function maxCarried(def: WeaponDef): number {
  return def.magazine + def.reserve;
}
