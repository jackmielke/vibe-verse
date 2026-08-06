/**
 * DROP ZERO — inventory.
 *
 * Publishes `InventoryService`. This is the smallest of the play systems and
 * the one with the least room to be wrong: building spends its materials,
 * weapons reads what is in the player's hands, loot pushes items into it, and
 * the HUD is drawn entirely from the events it emits. Every one of those is a
 * consumer, none of them are allowed to reach in and mutate state, and so the
 * whole surface has to be right the first time.
 *
 * ── The five decisions that matter ─────────────────────────────────────────
 *
 *  1. SLOT 0 IS SACRED. The pickaxe is not an item you happen to be carrying,
 *     it is a property of the character. It cannot be dropped, replaced or
 *     overwritten by a pickup, because the harvest loop is the economy and a
 *     player who lost the ability to gather has lost the game in a way they
 *     will never diagnose. `pickUp` and `dropActive` both refuse slot 0 up
 *     front rather than trusting every caller to remember.
 *
 *  2. AMMO IS PER CLASS, NOT PER GUN. Five pools — light, medium, heavy,
 *     shells, rockets — shared by every weapon that chambers them. That is
 *     what makes "do I pick up the second AR" an interesting question: the
 *     answer depends on what is in the pool, not on what is in the mag. Per-
 *     item ammo turns every gun into a disposable magazine and kills the
 *     whole decision.
 *
 *  3. AN EQUIP DELAY IS A BALANCE LEVER, NOT AN ANIMATION. Swapping costs
 *     real time during which you cannot fire. Without it, the correct play in
 *     every close fight is to carry three shotguns and alternate — the swap
 *     time is the only thing that prices that strategy. It lives here rather
 *     than in the weapon because it also gates consumables and throwables,
 *     and because "what is in my hands" is inventory's question to answer.
 *
 *  4. CONSUMABLES ARE CHANNELLED AND INTERRUPTIBLE. A shield potion is five
 *     seconds of standing still in the open. It is the single most tense
 *     non-combat action in a battle royale and it only works if the channel
 *     can be taken away from you: damage cancels it, sprinting cancels it,
 *     jumping cancels it, swapping cancels it. Progress goes out on
 *     `dz:consume` every frame so the HUD's ring is the honest truth about
 *     how much of that risk is left.
 *
 *  5. THE HUD IS EVENT-DRIVEN AND THIS MODULE IS ALLOCATION-LIGHT. One
 *     payload object and six slot-view objects are allocated at boot and
 *     mutated in place forever. `dz:inventory` fires immediately on any
 *     discrete change and is otherwise rate-limited, so a HUD that re-renders
 *     on every event is not re-rendering 120 times a second.
 *
 * ── Why there is geometry in an inventory module ───────────────────────────
 *
 * Two things nothing else in the boot list owns:
 *
 *  - **Throwables.** `InventoryItem.kind` includes `"throwable"` and no system
 *    in `boot.ts` flies one. An item class that can be looted, carried and
 *    counted but never used is worse than one that does not exist, so the
 *    grenade's ballistics, bounce and fuse live here. It is ~200 lines and
 *    one instanced draw call.
 *  - **Item icons.** Slot cards drawn as text are the tell that gives a web
 *    game away instantly. Every item gets a procedurally painted icon —
 *    rarity-graded background, a bevelled silhouette lit from the upper left,
 *    trim and vents and screw heads at the small scale, and a grain pass so
 *    no surface is a flat fill. Painted on one reused canvas, cached as data
 *    URLs, handed to the HUD through the service.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  RARITY_COLOR,
  type DamageSource,
  type HarvestKind,
  type InventoryItem,
  type InventoryService,
  type LootService,
  type MaterialsService,
  type QualityTier,
  type Rarity,
  type System,
  type SystemFactory,
  type WorldCtx,
  type WorldServices,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Contract shims
 *
 * `types.ts` is shared by every system booting right now and is not ours to
 * edit, so anything we need past the published interfaces is read
 * structurally, optionally, with a fallback that is correct when it is
 * missing. Nothing below is allowed to throw when the other module never
 * shipped the method.
 * ------------------------------------------------------------------------ */

/** The five reserve pools. Mirrors the weapon module's own `AmmoType`. */
export type AmmoClass = "light" | "medium" | "heavy" | "shells" | "rockets";

/**
 * The weapons module publishes onto `ctx.services.weapons`, which is not part
 * of `WorldServices`. We read it structurally for three things: the display
 * name of a gun at a tier, its ammo class and mag size, and its swap time.
 *
 * It also publishes its own reserve pool. That is a genuine overlap — the
 * assignment puts the pools here and weapons got there first — and two pools
 * that both call themselves the truth is the worst possible outcome, so when
 * weapons is present we treat *its* pool as the single authority and this
 * module becomes the front door onto it. When weapons failed to boot we fall
 * back to a local pool with identical numbers, and everything still works.
 */
interface WeaponDefLike {
  name?: string;
  short?: string;
  ammoType?: AmmoClass;
  magSize?: number;
  swapTime?: number;
}

interface WeaponsLike {
  def?(id: string): WeaponDefLike | null;
  displayName?(id: string, rarity: Rarity): string;
  ammo?(type: AmmoClass): number;
  addAmmo?(type: AmmoClass, amount: number): number;
}

/**
 * Loot's published `spawn(item, point)` has nowhere to put an impulse, and a
 * dropped gun that appears motionless at arm's length reads as a bug. If loot
 * exposes a `toss` we hand it the velocity; otherwise we spawn ahead of the
 * player along the throw arc and let it settle where loot puts it.
 */
type LootLike = LootService & {
  toss?(item: InventoryItem, point: THREE.Vector3, velocity: THREE.Vector3): void;
};

/** `ctx.services` plus the keys this module reads structurally. */
export type InventoryServices = WorldServices & { weapons?: WeaponsLike };

/** A system that wants deterministic stepping. Declared locally; see core.ts. */
interface FixedSystem extends System {
  fixed(dt: number, ctx: WorldCtx): void;
}

/* ------------------------------------------------------------------------ *
 * Tuning — materials
 * ------------------------------------------------------------------------ */

/**
 * The cap on every material. 999 is not arbitrary: it is the largest number
 * that fits the HUD's three-digit counter, and hitting it is a deliberate
 * signal that you are over-farming instead of fighting.
 */
const MATERIAL_CAP = 999;

/** How long the HUD's counter pulse lasts after a pickup, in seconds. */
const MATERIAL_FLASH = 0.42;

/** Material kinds in HUD order. Wood first — it is what you gather by default. */
const MATERIAL_KINDS: readonly HarvestKind[] = ["wood", "stone", "metal"];

/* ------------------------------------------------------------------------ *
 * Tuning — slots and equipping
 * ------------------------------------------------------------------------ */

/** Six slots. Slot 0 is the pickaxe; 1..5 are yours. */
const SLOT_COUNT = 6;

/**
 * Equip time by item class, in seconds. These are the balance numbers.
 *
 * The pickaxe comes up fast because it is the panic button — you swap to it
 * to move, and punishing that would make rotating feel bad. Guns take a real
 * beat, and a weapon that publishes its own `swapTime` overrides this (a
 * sniper should be slower to bring up than a pistol, and only the weapon
 * module knows which is which). Consumables are slowest: committing to a heal
 * is supposed to be a decision you can regret.
 */
const EQUIP_TIME: Record<InventoryItem["kind"], number> = {
  pickaxe: 0.18,
  weapon: 0.32,
  consumable: 0.42,
  throwable: 0.3,
};

/**
 * Swapping to a slot you are already holding is free. Swapping *away* from a
 * gun mid-reload has already cost you the reload, so it does not also cost
 * the full equip time — that double punishment is what makes players feel the
 * game is fighting them.
 */
const EQUIP_REPEAT_SCALE = 0.6;

/* ------------------------------------------------------------------------ *
 * Tuning — ammo
 * ------------------------------------------------------------------------ */

/**
 * What you drop out of the bus with. Not zero: a player who lands, finds a
 * gun and cannot fire it has had the first ten seconds of the match stolen
 * from them. Heavy and rockets start scarce because those weapons are the
 * ones the reserve is supposed to gate.
 */
const AMMO_START: Record<AmmoClass, number> = {
  light: 120,
  medium: 120,
  heavy: 12,
  shells: 24,
  rockets: 4,
};

/** Reserve ceilings. Same asymmetry, for the same reason. */
const AMMO_CAP: Record<AmmoClass, number> = {
  light: 999,
  medium: 999,
  heavy: 60,
  shells: 120,
  rockets: 12,
};

/** How much one ground ammo box gives, by class. */
const AMMO_BOX: Record<AmmoClass, number> = {
  light: 36,
  medium: 30,
  heavy: 8,
  shells: 12,
  rockets: 2,
};

const AMMO_CLASSES: readonly AmmoClass[] = ["light", "medium", "heavy", "shells", "rockets"];

/** Display names for ammo pickups, so the HUD toast reads properly. */
const AMMO_NAME: Record<AmmoClass, string> = {
  light: "Light Bullets",
  medium: "Medium Bullets",
  heavy: "Heavy Bullets",
  shells: "Shells",
  rockets: "Rockets",
};

/* ------------------------------------------------------------------------ *
 * Tuning — consumables
 * ------------------------------------------------------------------------ */

export interface ConsumableDef {
  id: string;
  name: string;
  /** Seconds of channel. The whole risk/reward of the item. */
  useTime: number;
  /** Health restored, and the ceiling it restores to. 0 = the player's max. */
  health: number;
  healthCap: number;
  /** Shield restored, and the ceiling it restores to. 0 = the player's max. */
  shield: number;
  shieldCap: number;
  /** How many fit in one slot. */
  stack: number;
  /** Fixed rarity — a mini is always uncommon, wherever it came from. */
  rarity: Rarity;
  /** Which icon silhouette to paint. */
  icon: IconShape;
  /** Audio cue played on completion. */
  sound: string;
}

/**
 * The heal table. The caps are the entire design: a mini shield tops you out
 * at 50, so the back half of your blue bar can only come from a big potion,
 * and bandages stop at 75 so the last quarter of health is always a medkit or
 * a fight you take hurt. Strip the caps and every item collapses into "press
 * button, become full", which is the version of this that is boring.
 */
const CONSUMABLES: readonly ConsumableDef[] = [
  {
    id: "shield-small",
    name: "Small Shield Potion",
    useTime: 2.0,
    health: 0,
    healthCap: 0,
    shield: 25,
    shieldCap: 50,
    stack: 6,
    rarity: "uncommon",
    icon: "potion-small",
    sound: "consume-shield",
  },
  {
    id: "shield-big",
    name: "Shield Potion",
    useTime: 5.0,
    health: 0,
    healthCap: 0,
    // 0 = the player's own maximum. Reading it off the player rather than
    // hard-coding 100 means a future max-shield modifier does not silently
    // break the only item that is supposed to fill the bar.
    shield: 50,
    shieldCap: 0,
    stack: 3,
    rarity: "rare",
    icon: "potion-big",
    sound: "consume-shield",
  },
  {
    id: "bandage",
    name: "Bandages",
    useTime: 4.0,
    health: 15,
    healthCap: 75,
    shield: 0,
    shieldCap: 0,
    stack: 15,
    rarity: "common",
    icon: "bandage",
    sound: "consume-health",
  },
  {
    id: "medkit",
    name: "Med Kit",
    useTime: 10.0,
    health: 100,
    healthCap: 0,
    shield: 0,
    shieldCap: 0,
    stack: 3,
    rarity: "uncommon",
    icon: "medkit",
    sound: "consume-health",
  },
];

const CONSUMABLE_BY_ID = new Map<string, ConsumableDef>(CONSUMABLES.map((c) => [c.id, c]));

/**
 * Speed above which a channel breaks, in m/s. Walk is 5.9 and sprint is 9.6,
 * so this lets you shuffle behind your wall while you drink and stops the
 * moment you commit to a rotation. Healing while walking is a real Fortnite
 * behaviour and removing it makes every heal feel like a stun.
 */
const CHANNEL_BREAK_SPEED = 6.8;

/** Player states that cancel a channel outright, whatever the speed is. */
const CHANNEL_BREAK_STATES = new Set(["air", "swim", "down", "dead", "skydive", "glide", "bus"]);

/* ------------------------------------------------------------------------ *
 * Tuning — throwables
 * ------------------------------------------------------------------------ */

export interface ThrowableDef {
  id: string;
  name: string;
  stack: number;
  rarity: Rarity;
  icon: IconShape;
  /** Seconds from leaving the hand to detonation. */
  fuse: number;
  /** Launch speed in m/s, and how much of it goes upward. */
  speed: number;
  lift: number;
  damage: number;
  radius: number;
  /** How much speed survives a bounce, and how much the surface scrubs. */
  restitution: number;
  friction: number;
  /** Seconds before you can throw again. */
  cooldown: number;
}

const THROWABLES: readonly ThrowableDef[] = [
  {
    id: "grenade",
    name: "Frag Grenade",
    stack: 6,
    rarity: "uncommon",
    icon: "grenade",
    // 2.6 s is long enough to bank one off a wall into a box fight and short
    // enough that the target cannot simply walk out of it. A cook timer would
    // be better still, but it needs an input bind this module does not own.
    fuse: 2.6,
    speed: 17,
    lift: 0.28,
    damage: 100,
    radius: 5.4,
    restitution: 0.34,
    friction: 0.7,
    cooldown: 0.55,
  },
];

const THROWABLE_BY_ID = new Map<string, ThrowableDef>(THROWABLES.map((t) => [t.id, t]));

/** Gravity for thrown objects. Heavier than the player's, so arcs read short. */
const THROW_GRAVITY = 24;
/** Air drag per second. Small — a grenade is dense. */
const THROW_DRAG = 0.12;
/** Below this speed a grounded grenade stops rolling and just sits ticking. */
const THROW_SLEEP_SPEED = 0.7;
/** Physical radius, for the bounce offset and the mesh. */
const THROW_RADIUS = 0.075;

/** Live grenades allowed at once, by tier. Six is already a generous ceiling. */
const THROW_POOL: Record<QualityTier, number> = { low: 4, medium: 6, high: 10, ultra: 12 };

/* ------------------------------------------------------------------------ *
 * Small maths helpers
 * ------------------------------------------------------------------------ */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Deterministic per-icon jitter, so a given item's wear never changes. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A tiny tiling value-noise `DataTexture`, used as a roughness map on the one
 * material this module might have to mint itself. Bilinear-filtered and
 * repeated, 32² is plenty for an object 7 cm across, and it costs 1 KB.
 */
function makeNoiseTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size);
  const rng = seededRng(0x9e3779b9);
  const coarse = new Float32Array(size * size);
  for (let i = 0; i < coarse.length; i++) coarse[i] = rng();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Two octaves: the fine one gives the grain, the coarse one gives the
      // patchiness that makes light sweep across the surface unevenly.
      const fine = coarse[y * size + x];
      const cx = (x >> 2) << 2;
      const cy = (y >> 2) << 2;
      const broad = coarse[(cy % size) * size + (cx % size)];
      const v = 0.38 + (fine * 0.35 + broad * 0.65) * 0.4;
      data[y * size + x] = Math.round(clamp01(v) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.repeat.set(2, 2);
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------------ *
 * Icon painting
 *
 * Every slot card in the HUD gets a real painted icon rather than a label.
 * The rules are the same ones the world is held to, applied at 128 px:
 *
 *   · nothing is a flat fill — every shape carries a gradient that implies a
 *     key light from the upper left and a cool bounce from below;
 *   · every silhouette has a bright top edge and a dark bottom edge, which is
 *     what a bevel looks like in two dimensions;
 *   · small-scale detail everywhere — vents, trim lines, screw heads, a
 *     magazine seam — because a clean shape at 128 px reads as clip art;
 *   · a grain pass over the whole tile, so no region is mathematically flat.
 *
 * Painted on one reused canvas and cached as a data URL per (def, rarity).
 * ------------------------------------------------------------------------ */

export type IconShape =
  | "pickaxe"
  | "rifle"
  | "smg"
  | "shotgun"
  | "shotgun-tac"
  | "sniper"
  | "pistol"
  | "launcher"
  | "minigun"
  | "potion-small"
  | "potion-big"
  | "bandage"
  | "medkit"
  | "grenade"
  | "ammo"
  | "generic";

/** Weapon id → silhouette. Falls back on the ammo class for unknown guns. */
const WEAPON_ICON: Record<string, IconShape> = {
  ar: "rifle",
  burst: "rifle",
  smg: "smg",
  pump: "shotgun",
  // Two shotguns that share a silhouette are two shotguns the player cannot
  // tell apart at a glance, and choosing between them is a real decision.
  tac: "shotgun-tac",
  sniper: "sniper",
  rocket: "launcher",
  pistol: "pistol",
  minigun: "minigun",
};

/** Mix two RGB integers. `t` = 0 gives `a`. */
function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

function css(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** Rounded rectangle path. Hand-rolled — `roundRect` is newer than our floor. */
function roundRectPath(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.arcTo(x + w, y, x + w, y + rr, rr);
  c.lineTo(x + w, y + h - rr);
  c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  c.lineTo(x + rr, y + h);
  c.arcTo(x, y + h, x, y + h - rr, rr);
  c.lineTo(x, y + rr);
  c.arcTo(x, y, x + rr, y, rr);
  c.closePath();
}

/**
 * One bevelled part: fill with a top-lit vertical gradient, bright line along
 * the top edge, dark line along the bottom. Three strokes is all it takes to
 * make a rectangle read as a machined object rather than a coloured box.
 */
function bevelRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  base: number,
  lift = 0.34,
): void {
  const g = c.createLinearGradient(x, y, x + w * 0.25, y + h);
  g.addColorStop(0, css(mixHex(base, 0xffffff, lift)));
  g.addColorStop(0.42, css(base));
  g.addColorStop(1, css(mixHex(base, 0x0a0d14, 0.55)));
  roundRectPath(c, x, y, w, h, r);
  c.fillStyle = g;
  c.fill();

  // Top bevel: a hairline of the key light catching the chamfer.
  c.save();
  c.clip();
  c.lineWidth = 1.6;
  c.strokeStyle = "rgba(255,255,255,0.42)";
  c.beginPath();
  c.moveTo(x + r * 0.6, y + 0.8);
  c.lineTo(x + w - r * 0.6, y + 0.8);
  c.stroke();
  c.strokeStyle = "rgba(0,0,0,0.45)";
  c.beginPath();
  c.moveTo(x + r * 0.6, y + h - 0.8);
  c.lineTo(x + w - r * 0.6, y + h - 0.8);
  c.stroke();
  c.restore();
}

/** A row of vents — the cheapest possible "this object was manufactured". */
function vents(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  count: number,
): void {
  const step = w / count;
  for (let i = 0; i < count; i++) {
    const vx = x + i * step + step * 0.22;
    c.fillStyle = "rgba(0,0,0,0.42)";
    c.fillRect(vx, y, step * 0.42, h);
    c.fillStyle = "rgba(255,255,255,0.16)";
    c.fillRect(vx, y + h, step * 0.42, 1);
  }
}

/** A screw head. Two arcs and a slot; unreadable individually, vital in bulk. */
function screw(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = "rgba(20,24,30,0.75)";
  c.fill();
  c.beginPath();
  c.arc(x, y - r * 0.18, r * 0.72, Math.PI * 0.9, Math.PI * 2.1);
  c.strokeStyle = "rgba(255,255,255,0.3)";
  c.lineWidth = Math.max(0.6, r * 0.34);
  c.stroke();
}

/**
 * The rarity-graded card behind the item. A radial hot spot behind where the
 * silhouette will sit, a diagonal sheen across the whole tile, then a vignette
 * so the corners fall away — the same three-part recipe as a Fortnite item
 * card, and the reason the icons read as a set instead of as clip art.
 */
function paintBackground(c: CanvasRenderingContext2D, size: number, rarity: Rarity): void {
  const base = RARITY_COLOR[rarity];
  const bright = mixHex(base, 0xffffff, 0.3);
  const deep = mixHex(base, 0x0b1018, 0.72);

  const g = c.createRadialGradient(size * 0.42, size * 0.34, 0, size * 0.5, size * 0.6, size * 0.86);
  g.addColorStop(0, css(bright));
  g.addColorStop(0.45, css(base));
  g.addColorStop(1, css(deep));
  roundRectPath(c, 0, 0, size, size, size * 0.14);
  c.fillStyle = g;
  c.fill();

  c.save();
  roundRectPath(c, 0, 0, size, size, size * 0.14);
  c.clip();

  // Diagonal sheen. Two soft bands, not one hard stripe — a single stripe
  // reads as a CSS gradient, two read as a curved surface catching a window.
  const sheen = c.createLinearGradient(0, size, size, 0);
  sheen.addColorStop(0.0, "rgba(255,255,255,0)");
  sheen.addColorStop(0.34, "rgba(255,255,255,0.1)");
  sheen.addColorStop(0.46, "rgba(255,255,255,0.02)");
  sheen.addColorStop(0.62, "rgba(255,255,255,0.14)");
  sheen.addColorStop(0.78, "rgba(255,255,255,0)");
  c.fillStyle = sheen;
  c.fillRect(0, 0, size, size);

  // Vignette: darkens the corners so the silhouette always wins the contrast
  // fight regardless of which rarity is behind it.
  const vig = c.createRadialGradient(
    size * 0.5,
    size * 0.5,
    size * 0.28,
    size * 0.5,
    size * 0.52,
    size * 0.78,
  );
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.46)");
  c.fillStyle = vig;
  c.fillRect(0, 0, size, size);
  c.restore();
}

/** Inner bevel + outer rim on the card itself. Reads as a physical tile. */
function paintCardEdge(c: CanvasRenderingContext2D, size: number): void {
  c.save();
  roundRectPath(c, 1.2, 1.2, size - 2.4, size - 2.4, size * 0.13);
  c.strokeStyle = "rgba(255,255,255,0.34)";
  c.lineWidth = 1.6;
  c.stroke();
  roundRectPath(c, 0.6, 0.6, size - 1.2, size - 1.2, size * 0.14);
  c.strokeStyle = "rgba(8,10,16,0.66)";
  c.lineWidth = 1.2;
  c.stroke();
  c.restore();
}

/** Grain + a few wear scratches. Deterministic per item, so it never crawls. */
function paintGrain(c: CanvasRenderingContext2D, size: number, rng: () => number): void {
  c.save();
  roundRectPath(c, 0, 0, size, size, size * 0.14);
  c.clip();

  const dots = Math.floor(size * 4.2);
  for (let i = 0; i < dots; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const a = 0.03 + rng() * 0.05;
    c.fillStyle = rng() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    c.fillRect(x, y, 1, 1);
  }

  // Contact wear: short scratches biased to the lower half, where a carried
  // object actually rubs.
  c.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    const x = size * 0.12 + rng() * size * 0.76;
    const y = size * 0.45 + rng() * size * 0.48;
    const len = 5 + rng() * 16;
    const ang = -0.4 + rng() * 0.8;
    c.strokeStyle = `rgba(255,255,255,${0.05 + rng() * 0.09})`;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    c.stroke();
  }
  c.restore();
}

/**
 * Draw the item silhouette. Everything is in a 0..1 space scaled to `size`, so
 * the same code paints a 96 px icon on `low` and a 160 px one on `ultra`.
 */
function paintShape(
  c: CanvasRenderingContext2D,
  size: number,
  shape: IconShape,
  rng: () => number,
): void {
  const S = (v: number): number => v * size;

  // A soft drop shadow under the whole silhouette. This is what separates the
  // item from its card; without it the icon looks printed on rather than in.
  c.save();
  c.shadowColor = "rgba(0,0,0,0.55)";
  c.shadowBlur = size * 0.09;
  c.shadowOffsetY = size * 0.035;

  // Deliberately lighter than a real gun's parkerised finish. An icon is read
  // at 48 CSS px against a saturated rarity card, and anything below about
  // 25 % luminance collapses into the card's own vignette — the silhouette
  // stops being a shape and becomes a smudge. Stylised beats accurate here for
  // exactly the same reason the world's roofs are, too.
  const steel = 0x77828f;
  const dark = 0x424c5b;
  const wood = 0x8a5f3c;

  // Weapons get a slight counter-clockwise tilt and a size bump. Every item
  // card in the genre does this: dead-horizontal reads as a technical diagram,
  // a few degrees of rake reads as a hero shot, and the extra 12 % is what
  // stops a rifle looking lost in the middle of its own tile.
  const gun =
    shape === "rifle" ||
    shape === "smg" ||
    shape === "shotgun" ||
    shape === "shotgun-tac" ||
    shape === "sniper" ||
    shape === "pistol" ||
    shape === "launcher" ||
    shape === "minigun";
  if (gun) {
    c.translate(S(0.5), S(0.5));
    c.rotate(-0.1);
    c.scale(1.12, 1.12);
    c.translate(S(-0.5), S(-0.5));
  }

  switch (shape) {
    case "pickaxe": {
      // Haft on the diagonal, head at the top left — reads instantly at 32 px.
      c.save();
      c.translate(S(0.5), S(0.52));
      c.rotate(-0.62);
      bevelRect(c, S(-0.05), S(-0.34), S(0.1), S(0.68), S(0.045), wood, 0.4);
      // Grip wrap: three bands of darker leather at the low end.
      for (let i = 0; i < 3; i++) {
        c.fillStyle = `rgba(28,20,14,${0.5 - i * 0.08})`;
        c.fillRect(S(-0.052), S(0.09 + i * 0.075), S(0.104), S(0.045));
      }
      c.restore();

      c.save();
      c.translate(S(0.36), S(0.3));
      c.rotate(-0.62);
      // The head: a swept blade, drawn as a path so the point is a point.
      c.beginPath();
      c.moveTo(S(-0.19), S(0.02));
      c.quadraticCurveTo(S(-0.08), S(-0.09), S(0.02), S(-0.055));
      c.lineTo(S(0.02), S(0.055));
      c.quadraticCurveTo(S(-0.08), S(0.09), S(-0.19), S(0.045));
      c.closePath();
      const hg = c.createLinearGradient(S(-0.19), S(-0.09), S(0.02), S(0.09));
      hg.addColorStop(0, css(mixHex(steel, 0xffffff, 0.55)));
      hg.addColorStop(0.5, css(steel));
      hg.addColorStop(1, css(mixHex(steel, 0x0a0d14, 0.5)));
      c.fillStyle = hg;
      c.fill();
      c.strokeStyle = "rgba(255,255,255,0.4)";
      c.lineWidth = 1.4;
      c.stroke();
      c.restore();
      screw(c, S(0.395), S(0.335), S(0.017));
      break;
    }

    case "rifle": {
      const y = S(0.5);
      bevelRect(c, S(0.12), y - S(0.045), S(0.62), S(0.085), S(0.02), dark, 0.3); // receiver
      bevelRect(c, S(0.62), y - S(0.022), S(0.28), S(0.042), S(0.014), steel, 0.4); // barrel
      bevelRect(c, S(0.06), y - S(0.03), S(0.12), S(0.07), S(0.024), wood, 0.36); // stock
      bevelRect(c, S(0.34), y + S(0.03), S(0.11), S(0.19), S(0.02), dark, 0.28); // mag
      vents(c, S(0.66), y - S(0.016), S(0.2), S(0.03), 5); // handguard slots
      bevelRect(c, S(0.3), y - S(0.09), S(0.2), S(0.03), S(0.01), steel, 0.45); // rail
      screw(c, S(0.24), y, S(0.016));
      screw(c, S(0.53), y - S(0.012), S(0.014));
      break;
    }

    case "smg": {
      const y = S(0.5);
      bevelRect(c, S(0.2), y - S(0.05), S(0.42), S(0.1), S(0.026), dark, 0.32);
      bevelRect(c, S(0.58), y - S(0.02), S(0.2), S(0.038), S(0.012), steel, 0.42);
      bevelRect(c, S(0.12), y - S(0.028), S(0.1), S(0.062), S(0.026), steel, 0.36); // folded stock
      bevelRect(c, S(0.36), y + S(0.04), S(0.1), S(0.22), S(0.024), dark, 0.26); // long mag
      vents(c, S(0.6), y - S(0.014), S(0.14), S(0.026), 4);
      bevelRect(c, S(0.28), y - S(0.082), S(0.16), S(0.028), S(0.01), steel, 0.44);
      screw(c, S(0.29), y + S(0.006), S(0.015));
      break;
    }

    case "shotgun": {
      const y = S(0.5);
      bevelRect(c, S(0.1), y - S(0.036), S(0.16), S(0.075), S(0.03), wood, 0.38); // stock
      bevelRect(c, S(0.24), y - S(0.048), S(0.34), S(0.096), S(0.022), dark, 0.3); // receiver
      bevelRect(c, S(0.56), y - S(0.03), S(0.34), S(0.058), S(0.018), steel, 0.42); // barrel
      bevelRect(c, S(0.6), y + S(0.028), S(0.24), S(0.048), S(0.02), wood, 0.34); // pump
      vents(c, S(0.62), y + S(0.036), S(0.2), S(0.03), 6);
      bevelRect(c, S(0.86), y - S(0.036), S(0.05), S(0.07), S(0.014), steel, 0.5); // choke
      screw(c, S(0.34), y - S(0.004), S(0.017));
      screw(c, S(0.5), y - S(0.004), S(0.015));
      break;
    }

    case "shotgun-tac": {
      // Tactical: shorter, no wood, a side saddle of spare shells and a
      // skeleton stock. Reads as "faster and meaner" at a glance.
      const y = S(0.5);
      bevelRect(c, S(0.08), y - S(0.03), S(0.16), S(0.062), S(0.026), steel, 0.4); // skeleton stock
      c.strokeStyle = "rgba(20,24,30,0.6)";
      c.lineWidth = 2;
      c.strokeRect(S(0.105), y - S(0.012), S(0.11), S(0.026));
      bevelRect(c, S(0.22), y - S(0.052), S(0.36), S(0.104), S(0.022), dark, 0.32); // receiver
      bevelRect(c, S(0.56), y - S(0.028), S(0.3), S(0.055), S(0.018), steel, 0.42); // barrel
      bevelRect(c, S(0.58), y + S(0.03), S(0.2), S(0.05), S(0.02), dark, 0.3); // pump
      vents(c, S(0.6), y + S(0.038), S(0.16), S(0.028), 5);
      // Side saddle: four shells on the receiver, the detail that names it.
      for (let i = 0; i < 4; i++) {
        const sx = S(0.26) + i * S(0.072);
        bevelRect(c, sx, y - S(0.044), S(0.05), S(0.03), S(0.008), 0xb3402f, 0.4);
        c.fillStyle = "rgba(210,180,110,0.9)";
        c.fillRect(sx + S(0.038), y - S(0.044), S(0.012), S(0.03));
      }
      bevelRect(c, S(0.83), y - S(0.042), S(0.06), S(0.082), S(0.016), steel, 0.5); // brake
      screw(c, S(0.34), y + S(0.014), S(0.016));
      break;
    }

    case "sniper": {
      const y = S(0.52);
      bevelRect(c, S(0.06), y - S(0.034), S(0.2), S(0.072), S(0.028), wood, 0.36);
      bevelRect(c, S(0.24), y - S(0.042), S(0.3), S(0.084), S(0.02), dark, 0.3);
      bevelRect(c, S(0.52), y - S(0.02), S(0.42), S(0.04), S(0.013), steel, 0.44);
      // Optic: the read at a glance. Tube plus two rings plus a blue lens.
      bevelRect(c, S(0.3), y - S(0.16), S(0.3), S(0.062), S(0.026), dark, 0.34);
      bevelRect(c, S(0.34), y - S(0.168), S(0.035), S(0.078), S(0.01), steel, 0.4);
      bevelRect(c, S(0.53), y - S(0.168), S(0.035), S(0.078), S(0.01), steel, 0.4);
      c.beginPath();
      c.ellipse(S(0.585), y - S(0.129), S(0.02), S(0.026), 0, 0, Math.PI * 2);
      const lens = c.createRadialGradient(S(0.58), y - S(0.14), 0, S(0.585), y - S(0.129), S(0.03));
      lens.addColorStop(0, "rgba(190,225,255,0.95)");
      lens.addColorStop(1, "rgba(28,74,140,0.9)");
      c.fillStyle = lens;
      c.fill();
      bevelRect(c, S(0.36), y + S(0.03), S(0.08), S(0.13), S(0.018), dark, 0.26);
      bevelRect(c, S(0.88), y - S(0.03), S(0.06), S(0.06), S(0.016), steel, 0.5); // brake
      break;
    }

    case "pistol": {
      const cx = S(0.46);
      const y = S(0.42);
      bevelRect(c, cx - S(0.2), y, S(0.46), S(0.09), S(0.022), dark, 0.34); // slide
      vents(c, cx - S(0.16), y + S(0.014), S(0.14), S(0.036), 4); // serrations
      bevelRect(c, cx - S(0.18), y + S(0.09), S(0.36), S(0.055), S(0.016), steel, 0.3); // frame
      c.save();
      c.translate(cx - S(0.06), y + S(0.14));
      c.rotate(0.28);
      bevelRect(c, S(-0.05), 0, S(0.11), S(0.26), S(0.024), dark, 0.28); // grip
      for (let i = 0; i < 4; i++) {
        c.fillStyle = "rgba(0,0,0,0.35)";
        c.fillRect(S(-0.048), S(0.05 + i * 0.05), S(0.106), S(0.018));
      }
      c.restore();
      bevelRect(c, cx + S(0.2), y + S(0.026), S(0.06), S(0.03), S(0.008), steel, 0.5); // muzzle
      break;
    }

    case "launcher": {
      const y = S(0.5);
      bevelRect(c, S(0.08), y - S(0.06), S(0.72), S(0.12), S(0.05), 0x3f4a3a, 0.32); // tube
      bevelRect(c, S(0.76), y - S(0.085), S(0.16), S(0.17), S(0.05), 0x3f4a3a, 0.36); // bell
      bevelRect(c, S(0.03), y - S(0.075), S(0.08), S(0.15), S(0.04), dark, 0.3); // breech
      bevelRect(c, S(0.28), y - S(0.13), S(0.24), S(0.055), S(0.02), dark, 0.34); // sight
      bevelRect(c, S(0.3), y + S(0.05), S(0.1), S(0.16), S(0.022), dark, 0.26); // grip
      // Warhead peeking out of the bell — the colour that says "explosive".
      c.beginPath();
      c.moveTo(S(0.9), y);
      c.lineTo(S(0.8), y - S(0.05));
      c.lineTo(S(0.8), y + S(0.05));
      c.closePath();
      c.fillStyle = css(0xc4552f);
      c.fill();
      vents(c, S(0.14), y - S(0.05), S(0.12), S(0.1), 3);
      screw(c, S(0.62), y - S(0.03), S(0.016));
      break;
    }

    case "minigun": {
      const y = S(0.5);
      bevelRect(c, S(0.08), y - S(0.08), S(0.34), S(0.17), S(0.03), dark, 0.3); // housing
      // Six barrels, drawn as stacked bars with alternating shading so the
      // cluster reads as round rather than as a grille.
      for (let i = 0; i < 5; i++) {
        const by = y - S(0.062) + S(0.031) * i;
        bevelRect(c, S(0.42), by, S(0.46), S(0.024), S(0.008), i % 2 ? steel : mixHex(steel, 0x000000, 0.3), 0.45);
      }
      bevelRect(c, S(0.84), y - S(0.075), S(0.07), S(0.15), S(0.02), steel, 0.42); // clamp
      bevelRect(c, S(0.14), y + S(0.07), S(0.16), S(0.18), S(0.024), 0x4a3f2e, 0.3); // drum
      vents(c, S(0.12), y - S(0.05), S(0.2), S(0.06), 4);
      screw(c, S(0.36), y - S(0.05), S(0.016));
      screw(c, S(0.36), y + S(0.04), S(0.016));
      break;
    }

    case "potion-small":
    case "potion-big": {
      const big = shape === "potion-big";
      const w = big ? 0.42 : 0.3;
      const h = big ? 0.56 : 0.42;
      const x = S(0.5 - w * 0.5);
      const y = S(0.72 - h);

      // Glass body. Two vertical gradients: the liquid, then a glass overlay
      // with a hard specular band — that band is the whole reason it reads as
      // glass and not as a coloured pill.
      roundRectPath(c, x, y, S(w), S(h), S(w * 0.3));
      const liquid = c.createLinearGradient(x, y, x, y + S(h));
      liquid.addColorStop(0, "rgba(120,200,255,0.92)");
      liquid.addColorStop(0.35, "rgba(52,150,240,0.95)");
      liquid.addColorStop(1, "rgba(18,64,150,0.98)");
      c.fillStyle = liquid;
      c.fill();

      c.save();
      c.clip();
      // Meniscus: the liquid does not reach the top of the bottle.
      c.fillStyle = "rgba(255,255,255,0.16)";
      c.fillRect(x, y, S(w), S(h * 0.16));
      c.fillStyle = "rgba(255,255,255,0.5)";
      c.fillRect(x, y + S(h * 0.16), S(w), 1.4);
      // Specular band down the left third.
      const spec = c.createLinearGradient(x, 0, x + S(w), 0);
      spec.addColorStop(0.06, "rgba(255,255,255,0)");
      spec.addColorStop(0.18, "rgba(255,255,255,0.62)");
      spec.addColorStop(0.3, "rgba(255,255,255,0)");
      spec.addColorStop(0.82, "rgba(255,255,255,0)");
      spec.addColorStop(0.93, "rgba(255,255,255,0.22)");
      c.fillStyle = spec;
      c.fillRect(x, y, S(w), S(h));
      // Bubbles.
      for (let i = 0; i < 7; i++) {
        const bx = x + S(w * 0.2) + rng() * S(w * 0.6);
        const by = y + S(h * 0.35) + rng() * S(h * 0.55);
        const br = S(0.008) + rng() * S(0.012);
        c.beginPath();
        c.arc(bx, by, br, 0, Math.PI * 2);
        c.fillStyle = "rgba(220,245,255,0.5)";
        c.fill();
      }
      c.restore();

      roundRectPath(c, x, y, S(w), S(h), S(w * 0.3));
      c.strokeStyle = "rgba(255,255,255,0.42)";
      c.lineWidth = 1.6;
      c.stroke();

      // Neck, cork and the label band.
      bevelRect(c, S(0.5 - w * 0.17), y - S(0.11), S(w * 0.34), S(0.12), S(0.014), 0x9fb4c4, 0.36);
      bevelRect(c, S(0.5 - w * 0.21), y - S(0.16), S(w * 0.42), S(0.06), S(0.016), 0x7d5a35, 0.4);
      c.fillStyle = "rgba(238,244,250,0.9)";
      c.fillRect(x, y + S(h * 0.52), S(w), S(0.08));
      c.fillStyle = "rgba(30,90,170,0.75)";
      c.fillRect(x, y + S(h * 0.52), S(w), 1.4);
      if (big) {
        // A "+" on the label so the two potions are distinguishable at 32 px.
        c.fillStyle = "rgba(40,110,190,0.9)";
        c.fillRect(S(0.5) - S(0.012), y + S(h * 0.545), S(0.024), S(0.03));
        c.fillRect(S(0.5) - S(0.03), y + S(h * 0.558), S(0.06), S(0.014));
      }
      break;
    }

    case "bandage": {
      // A rolled bandage seen slightly from the side: an outer roll, an inner
      // core, and a loose tail. The tail is what makes it read as cloth.
      c.save();
      c.translate(S(0.48), S(0.52));
      c.rotate(-0.2);
      roundRectPath(c, S(-0.26), S(-0.19), S(0.52), S(0.38), S(0.06));
      const cloth = c.createLinearGradient(S(-0.26), S(-0.19), S(0.1), S(0.19));
      cloth.addColorStop(0, "rgb(248,244,236)");
      cloth.addColorStop(0.5, "rgb(224,216,203)");
      cloth.addColorStop(1, "rgb(168,158,143)");
      c.fillStyle = cloth;
      c.fill();
      c.save();
      c.clip();
      // Weave: fine diagonal lines, the small-scale detail that stops it
      // looking like a white rectangle.
      c.strokeStyle = "rgba(150,140,124,0.4)";
      c.lineWidth = 1;
      for (let i = -12; i < 18; i++) {
        c.beginPath();
        c.moveTo(S(-0.28) + i * S(0.035), S(-0.2));
        c.lineTo(S(-0.28) + i * S(0.035) + S(0.14), S(0.2));
        c.stroke();
      }
      c.restore();
      roundRectPath(c, S(-0.26), S(-0.19), S(0.52), S(0.38), S(0.06));
      c.strokeStyle = "rgba(120,110,96,0.55)";
      c.lineWidth = 1.4;
      c.stroke();
      // Roll edge.
      roundRectPath(c, S(0.05), S(-0.19), S(0.21), S(0.38), S(0.06));
      c.fillStyle = "rgba(255,255,255,0.35)";
      c.fill();
      c.restore();

      // Red cross tab.
      bevelRect(c, S(0.55), S(0.6), S(0.2), S(0.16), S(0.03), 0xd8402f, 0.36);
      c.fillStyle = "rgba(255,255,255,0.92)";
      c.fillRect(S(0.632), S(0.628), S(0.036), S(0.104));
      c.fillRect(S(0.616), S(0.66), S(0.068), S(0.04));
      break;
    }

    case "medkit": {
      const x = S(0.14);
      const y = S(0.26);
      const w = S(0.72);
      const h = S(0.5);
      bevelRect(c, x, y, w, h, S(0.05), 0xe4e9ee, 0.3);
      // Lid seam + latch: the two details that make it a case, not a square.
      c.fillStyle = "rgba(90,100,112,0.45)";
      c.fillRect(x, y + h * 0.36, w, 2);
      c.fillStyle = "rgba(255,255,255,0.5)";
      c.fillRect(x, y + h * 0.36 + 2, w, 1);
      bevelRect(c, S(0.44), y + h * 0.3, S(0.12), S(0.12), S(0.018), 0x8e99a6, 0.4);
      screw(c, S(0.2), y + h * 0.72, S(0.017));
      screw(c, S(0.8), y + h * 0.72, S(0.017));
      // Handle.
      c.strokeStyle = "rgba(60,68,78,0.85)";
      c.lineWidth = S(0.035);
      c.beginPath();
      c.arc(S(0.5), y, S(0.13), Math.PI * 1.08, Math.PI * 1.92);
      c.stroke();
      // Cross.
      c.fillStyle = css(0xd8402f);
      c.fillRect(S(0.465), y + h * 0.48, S(0.07), S(0.26));
      c.fillRect(S(0.4), y + h * 0.62, S(0.2), S(0.09));
      c.fillStyle = "rgba(255,255,255,0.28)";
      c.fillRect(S(0.465), y + h * 0.48, S(0.07), 2);
      break;
    }

    case "grenade": {
      const cx = S(0.48);
      const cy = S(0.58);
      const r = S(0.22);
      const body = c.createRadialGradient(cx - r * 0.4, cy - r * 0.5, r * 0.1, cx, cy, r * 1.15);
      body.addColorStop(0, css(mixHex(0x5c6b45, 0xffffff, 0.5)));
      body.addColorStop(0.55, css(0x5c6b45));
      body.addColorStop(1, css(mixHex(0x5c6b45, 0x0a0d10, 0.7)));
      c.beginPath();
      c.ellipse(cx, cy, r * 0.92, r, 0, 0, Math.PI * 2);
      c.fillStyle = body;
      c.fill();
      // Ribs: three horizontal bands and two vertical, which is the shorthand
      // every player already reads as "fragmentation".
      c.save();
      c.beginPath();
      c.ellipse(cx, cy, r * 0.92, r, 0, 0, Math.PI * 2);
      c.clip();
      c.strokeStyle = "rgba(0,0,0,0.4)";
      c.lineWidth = 2;
      for (let i = -1; i <= 1; i++) {
        c.beginPath();
        c.moveTo(cx - r, cy + i * r * 0.42);
        c.lineTo(cx + r, cy + i * r * 0.42);
        c.stroke();
      }
      c.strokeStyle = "rgba(255,255,255,0.16)";
      for (let i = -1; i <= 1; i++) {
        c.beginPath();
        c.moveTo(cx - r, cy + i * r * 0.42 + 2);
        c.lineTo(cx + r, cy + i * r * 0.42 + 2);
        c.stroke();
      }
      c.strokeStyle = "rgba(0,0,0,0.28)";
      c.lineWidth = 1.6;
      for (let i = -1; i <= 1; i += 2) {
        c.beginPath();
        c.moveTo(cx + i * r * 0.34, cy - r);
        c.lineTo(cx + i * r * 0.34, cy + r);
        c.stroke();
      }
      c.restore();
      // Fuse assembly + lever + pin ring.
      bevelRect(c, cx - S(0.055), cy - r - S(0.09), S(0.11), S(0.1), S(0.02), 0x6e7460, 0.4);
      c.save();
      c.translate(cx + S(0.05), cy - r - S(0.05));
      c.rotate(0.24);
      bevelRect(c, 0, 0, S(0.045), S(0.24), S(0.014), 0x9aa08c, 0.44);
      c.restore();
      c.beginPath();
      c.arc(cx - S(0.1), cy - r - S(0.05), S(0.05), 0, Math.PI * 2);
      c.strokeStyle = "rgba(200,205,190,0.9)";
      c.lineWidth = S(0.018);
      c.stroke();
      break;
    }

    case "ammo": {
      // A stack of cartridges in a box. Brass reads instantly.
      bevelRect(c, S(0.16), S(0.44), S(0.68), S(0.3), S(0.04), 0x6b5638, 0.32);
      for (let i = 0; i < 4; i++) {
        const bx = S(0.22) + i * S(0.16);
        bevelRect(c, bx, S(0.22), S(0.1), S(0.24), S(0.012), 0xc79a3f, 0.45);
        // Bullet tip: a rounded cap in a duller alloy.
        c.beginPath();
        c.moveTo(bx, S(0.22));
        c.quadraticCurveTo(bx + S(0.05), S(0.12), bx + S(0.1), S(0.22));
        c.closePath();
        c.fillStyle = css(0x9a8354);
        c.fill();
        c.fillStyle = "rgba(255,255,255,0.28)";
        c.fillRect(bx + S(0.012), S(0.23), S(0.016), S(0.2));
      }
      c.fillStyle = "rgba(0,0,0,0.3)";
      c.fillRect(S(0.16), S(0.55), S(0.68), 2);
      screw(c, S(0.24), S(0.66), S(0.016));
      screw(c, S(0.76), S(0.66), S(0.016));
      break;
    }

    default: {
      bevelRect(c, S(0.24), S(0.28), S(0.52), S(0.44), S(0.06), steel, 0.34);
      vents(c, S(0.3), S(0.42), S(0.4), S(0.08), 4);
      break;
    }
  }
  c.restore();
}

/* ------------------------------------------------------------------------ *
 * HUD payload shapes
 * ------------------------------------------------------------------------ */

/** One slot as the HUD sees it. Mutated in place; never reallocated. */
export interface InventorySlotView {
  index: number;
  id: string | null;
  kind: InventoryItem["kind"] | null;
  def: string;
  name: string;
  rarity: Rarity;
  color: number;
  /** Rounds in the magazine, for weapons. */
  ammo: number;
  magSize: number;
  /** Reserve in this weapon's class. */
  reserve: number;
  ammoClass: AmmoClass | null;
  /** Stack size, for consumables and throwables. */
  count: number;
  /** Procedurally painted icon, as a data URL. */
  icon: string;
  active: boolean;
  /** Seconds of equip delay remaining, if this slot is coming up. */
  equip: number;
}

/** What `dz:inventory` carries. One object, reused forever. */
export interface InventoryHudPayload {
  slots: InventorySlotView[];
  activeSlot: number;
  wood: number;
  stone: number;
  metal: number;
  materialCap: number;
  /** 0..1 pulse per material, so the HUD counter can flash on a pickup. */
  flashWood: number;
  flashStone: number;
  flashMetal: number;
  /** 0..1 equip progress; 1 means the item is ready. */
  equip: number;
  /** True while the equip delay is blocking the trigger. */
  equipping: boolean;
  light: number;
  medium: number;
  heavy: number;
  shells: number;
  rockets: number;
  /** Live grenades in flight — the HUD dims the throw button while any is. */
  inFlight: number;
}

/** What `dz:consume` carries. Also reused. */
export interface ConsumeHudPayload {
  active: boolean;
  def: string;
  name: string;
  /** 0..1 completion. */
  t: number;
  remaining: number;
  total: number;
  /** Set on the frame the channel ends: "done" | "cancelled". */
  result: "" | "done" | "cancelled";
  reason: string;
}

/** What `dz:material` carries on a harvest/pickup, for the counter pulse. */
export interface MaterialHudPayload {
  kind: HarvestKind;
  amount: number;
  total: number;
  /** True when part of the pickup was thrown away against the cap. */
  capped: boolean;
}

/** The published service plus the extras this module owns. */
export interface InventoryServiceEx extends InventoryService {
  readonly materialCap: number;
  /** Reserve in a class. Delegates to the weapons module when it booted. */
  ammo(cls: AmmoClass): number;
  /** Add (or, with a negative amount, spend) reserve. Returns the new total. */
  addAmmo(cls: AmmoClass, amount: number): number;
  /** Draw up to `amount` from a pool. Returns what was actually available. */
  takeAmmo(cls: AmmoClass, amount: number): number;
  readonly ammoClasses: readonly AmmoClass[];
  /** True while a swap is still blocking the trigger. */
  readonly equipping: boolean;
  /** Seconds of equip delay left. */
  readonly equipT: number;
  /** The one question every consumer actually wants answered. */
  readonly canFire: boolean;
  /** The consumable being channelled, or null. */
  readonly consuming: ConsumableDef | null;
  /** 0..1 channel progress. */
  readonly consumeT: number;
  /** Start using the active consumable. Returns false if it cannot start. */
  use(): boolean;
  /** Cancel any channel in progress. */
  cancelUse(reason?: string): void;
  /** Throw the active throwable. Returns false if it cannot. */
  throwActive(): boolean;
  /** Mint a consumable/throwable/ammo item by def id — loot calls this. */
  makeItem(def: string, count?: number): InventoryItem | null;
  /** Data-URL icon for an item. Painted on demand, cached forever. */
  iconFor(item: InventoryItem): string;
  /** The consumable/throwable tables, for a HUD that wants tooltips. */
  readonly consumables: readonly ConsumableDef[];
  readonly throwables: readonly ThrowableDef[];
}

/* ------------------------------------------------------------------------ *
 * The system
 * ------------------------------------------------------------------------ */

/** Icon resolution by tier. The HUD draws them at ~64 CSS px. */
const ICON_SIZE: Record<QualityTier, number> = { low: 96, medium: 112, high: 128, ultra: 160 };

/** Scratch vectors. Module-level so no update path allocates. */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);

/** A grenade in flight. Pooled — never allocated after boot. */
interface Grenade {
  active: boolean;
  def: ThrowableDef;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  /** Tumble, integrated as an axis-angle rate so it never gimbal-locks. */
  spin: THREE.Vector3;
  quat: THREE.Quaternion;
  fuse: number;
  resting: boolean;
  source: DamageSource;
}

const createInventory: SystemFactory = (ctx: WorldCtx): System => {
  const services = ctx.services as InventoryServices;

  /* ---- state the service reads ----------------------------------------- */

  const slots: (InventoryItem | null)[] = new Array(SLOT_COUNT).fill(null);

  /**
   * Slot 0 is minted here, not looted. `kind: "pickaxe"` is what the build
   * system tests to decide whether the player can harvest, so this object
   * existing is the difference between a playable match and one where the
   * economy never starts.
   */
  const PICKAXE: InventoryItem = {
    id: "tool-pickaxe",
    kind: "pickaxe",
    def: "pickaxe",
    name: "Harvesting Tool",
    rarity: "common",
  };
  slots[0] = PICKAXE;

  let activeSlot = 0;
  let equipT = 0;
  let equipTotal = 0;

  const materials: Record<HarvestKind, number> = { wood: 0, stone: 0, metal: 0 };
  const flash: Record<HarvestKind, number> = { wood: 0, stone: 0, metal: 0 };

  /** Local reserve. Only authoritative when the weapons module did not boot. */
  const localAmmo: Record<AmmoClass, number> = { ...AMMO_START };

  let channelDef: ConsumableDef | null = null;
  let channelSlot = -1;
  let channelT = 0;
  let channelTotal = 0;
  /** Where to swap back to when a channel finishes and empties the stack. */
  let channelReturn = 0;

  let hudDirty = true;
  /** Separate rails: a heal ring at 20 Hz and the slot bar at 30 Hz. Sharing
   *  one accumulator between them meant whichever ticked first starved the
   *  other, and the symptom was a slot bar that froze while you drank. */
  let hudClock = 0;
  let consumeClock = 0;

  /**
   * Anything appearing in the inventory needs a stable, unique id, and the
   * world RNG is shared with worldgen — burning draws from it here would move
   * every tree on the island the moment loot behaved differently. A private
   * counter is both cheaper and deterministic.
   */
  let itemSerial = 0;
  const mintId = (def: string): string => `${def}-${(itemSerial++).toString(36)}`;

  /* ---- ammo ------------------------------------------------------------- */

  const weapons = (): WeaponsLike | undefined => services.weapons;

  function ammoOf(cls: AmmoClass): number {
    const w = weapons();
    if (w && typeof w.ammo === "function") return w.ammo(cls);
    return localAmmo[cls] ?? 0;
  }

  function addAmmoOf(cls: AmmoClass, amount: number): number {
    const w = weapons();
    if (w && typeof w.addAmmo === "function") {
      hudDirty = true;
      return w.addAmmo(cls, amount);
    }
    localAmmo[cls] = clamp((localAmmo[cls] ?? 0) + amount, 0, AMMO_CAP[cls] ?? 999);
    hudDirty = true;
    return localAmmo[cls];
  }

  /* ---- icons ------------------------------------------------------------ */

  const iconSize = ICON_SIZE[ctx.quality] ?? 128;
  const iconCache = new Map<string, string>();
  let iconCanvas: HTMLCanvasElement | null = null;
  let iconCtx: CanvasRenderingContext2D | null = null;

  function iconShapeFor(item: InventoryItem): IconShape {
    if (item.kind === "pickaxe") return "pickaxe";
    if (item.kind === "weapon") {
      const known = WEAPON_ICON[item.def];
      if (known) return known;
      // Unknown gun: fall back on the ammo class, which at least gets the
      // silhouette family right for anything the weapons module adds later.
      const cls = weapons()?.def?.(item.def)?.ammoType;
      if (cls === "shells") return "shotgun";
      if (cls === "heavy") return "sniper";
      if (cls === "rockets") return "launcher";
      if (cls === "light") return "smg";
      return "rifle";
    }
    if (item.def.startsWith("ammo-")) return "ammo";
    const con = CONSUMABLE_BY_ID.get(item.def);
    if (con) return con.icon;
    const thr = THROWABLE_BY_ID.get(item.def);
    if (thr) return thr.icon;
    return "generic";
  }

  function paintIcon(item: InventoryItem): string {
    if (typeof document === "undefined") return "";
    if (!iconCanvas) {
      iconCanvas = document.createElement("canvas");
      iconCanvas.width = iconSize;
      iconCanvas.height = iconSize;
      iconCtx = iconCanvas.getContext("2d");
    }
    const c = iconCtx;
    if (!c) return "";

    const shape = iconShapeFor(item);
    const rng = seededRng(hashString(`${item.def}|${item.rarity}|${shape}`));

    c.clearRect(0, 0, iconSize, iconSize);
    paintBackground(c, iconSize, item.rarity);
    paintShape(c, iconSize, shape, rng);
    paintGrain(c, iconSize, rng);
    paintCardEdge(c, iconSize);
    return iconCanvas.toDataURL("image/png");
  }

  function iconFor(item: InventoryItem): string {
    const key = `${item.def}|${item.rarity}`;
    let url = iconCache.get(key);
    if (url === undefined) {
      url = paintIcon(item);
      iconCache.set(key, url);
    }
    return url;
  }

  /* ---- item minting ----------------------------------------------------- */

  function makeItem(def: string, count?: number): InventoryItem | null {
    const con = CONSUMABLE_BY_ID.get(def);
    if (con) {
      return {
        id: mintId(def),
        kind: "consumable",
        def,
        name: con.name,
        rarity: con.rarity,
        count: clamp(count ?? 1, 1, con.stack),
      };
    }
    const thr = THROWABLE_BY_ID.get(def);
    if (thr) {
      return {
        id: mintId(def),
        kind: "throwable",
        def,
        name: thr.name,
        rarity: thr.rarity,
        count: clamp(count ?? 1, 1, thr.stack),
      };
    }
    // "ammo-light" and friends are not slot items — they are a grant wearing
    // an item's clothes so loot can spawn them through the same pipe. `pickUp`
    // recognises them and never gives them a slot.
    if (def.startsWith("ammo-")) {
      const cls = def.slice(5) as AmmoClass;
      if (!AMMO_CLASSES.includes(cls)) return null;
      return {
        id: mintId(def),
        kind: "consumable",
        def,
        name: AMMO_NAME[cls],
        rarity: "common",
        count: count ?? AMMO_BOX[cls],
      };
    }
    return null;
  }

  /** Max stack for an item def, or 1 for anything unstackable. */
  function stackLimit(item: InventoryItem): number {
    if (item.kind === "consumable") return CONSUMABLE_BY_ID.get(item.def)?.stack ?? 1;
    if (item.kind === "throwable") return THROWABLE_BY_ID.get(item.def)?.stack ?? 1;
    return 1;
  }

  const isStackable = (item: InventoryItem): boolean =>
    item.kind === "consumable" || item.kind === "throwable";

  /* ---- selection and equipping ------------------------------------------ */

  function equipTimeFor(item: InventoryItem | null, sameItem: boolean): number {
    if (!item) return 0;
    let t = EQUIP_TIME[item.kind] ?? 0.3;
    if (item.kind === "weapon") {
      // The weapon module knows a sniper takes longer to shoulder than a
      // pistol; trust it when it has an opinion.
      const swap = weapons()?.def?.(item.def)?.swapTime;
      if (typeof swap === "number" && swap > 0) t = swap;
    }
    return sameItem ? t * EQUIP_REPEAT_SCALE : t;
  }

  function select(slot: number, force = false): void {
    const i = Math.trunc(slot);
    if (i < 0 || i >= SLOT_COUNT) return;
    // Selecting an empty slot is a no-op rather than an error: fumbling 4 in a
    // fight should leave you holding your gun, not holding nothing.
    if (i !== 0 && !slots[i] && !force) return;
    if (i === activeSlot && equipT <= 0) return;

    const sameItem = i === activeSlot;
    if (channelDef) cancelUse("swap");
    activeSlot = i;
    equipTotal = equipTimeFor(slots[i], sameItem);
    equipT = equipTotal;
    hudDirty = true;
    if (equipTotal > 0) ctx.services.audio?.play("weapon-swap", { volume: 0.34 });
  }

  /** Next non-empty slot in a direction, wrapping. Slot 0 always counts. */
  function cycle(dir: number): void {
    for (let step = 1; step <= SLOT_COUNT; step++) {
      const i = (((activeSlot + dir * step) % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT;
      if (i === 0 || slots[i]) {
        select(i);
        return;
      }
    }
  }

  /** After a slot empties, land somewhere sensible instead of on nothing. */
  function selectAfterEmpty(from: number): void {
    for (let step = 1; step < SLOT_COUNT; step++) {
      const i = (from + step) % SLOT_COUNT;
      if (i !== 0 && slots[i]) {
        select(i);
        return;
      }
    }
    select(0, true);
  }

  /* ---- materials -------------------------------------------------------- */

  const materialPayload: MaterialHudPayload = { kind: "wood", amount: 0, total: 0, capped: false };

  function addMaterial(kind: HarvestKind, amount: number): void {
    if (!(kind in materials) || amount <= 0) return;
    const before = materials[kind];
    const after = Math.min(MATERIAL_CAP, before + Math.round(amount));
    if (after === before) {
      // Already capped. Still flash, faintly, so the player learns *why* the
      // counter stopped moving rather than assuming harvesting is broken.
      flash[kind] = Math.max(flash[kind], MATERIAL_FLASH * 0.4);
      hudDirty = true;
      return;
    }
    materials[kind] = after;
    flash[kind] = MATERIAL_FLASH;
    hudDirty = true;

    materialPayload.kind = kind;
    materialPayload.amount = after - before;
    materialPayload.total = after;
    materialPayload.capped = after - before < Math.round(amount);
    ctx.emit("dz:material", materialPayload);
  }

  function spendMaterial(kind: HarvestKind, amount: number): boolean {
    if (!(kind in materials) || amount <= 0) return amount <= 0;
    if (materials[kind] < amount) return false;
    materials[kind] -= amount;
    hudDirty = true;
    return true;
  }

  /* ---- consumables ------------------------------------------------------ */

  const consumePayload: ConsumeHudPayload = {
    active: false,
    def: "",
    name: "",
    t: 0,
    remaining: 0,
    total: 0,
    result: "",
    reason: "",
  };

  function emitConsume(result: "" | "done" | "cancelled", reason = ""): void {
    consumePayload.active = channelDef !== null;
    consumePayload.def = channelDef?.id ?? consumePayload.def;
    consumePayload.name = channelDef?.name ?? consumePayload.name;
    consumePayload.total = channelTotal;
    consumePayload.remaining = channelT;
    consumePayload.t = channelTotal > 0 ? clamp01(1 - channelT / channelTotal) : 0;
    consumePayload.result = result;
    consumePayload.reason = reason;
    ctx.emit("dz:consume", consumePayload);
  }

  /** How much this item would actually restore right now. Zero means refuse. */
  function healingFrom(def: ConsumableDef): { hp: number; shield: number } {
    const player = ctx.services.player;
    const hpNow = player?.health ?? 0;
    const hpMax = player?.maxHealth ?? 100;
    const shNow = player?.shield ?? 0;
    const shMax = player?.maxShield ?? 100;
    const hpCap = Math.min(def.healthCap > 0 ? def.healthCap : hpMax, hpMax);
    const shCap = Math.min(def.shieldCap > 0 ? def.shieldCap : shMax, shMax);
    return {
      hp: def.health > 0 ? Math.max(0, Math.min(def.health, hpCap - hpNow)) : 0,
      shield: def.shield > 0 ? Math.max(0, Math.min(def.shield, shCap - shNow)) : 0,
    };
  }

  function use(): boolean {
    if (channelDef) return false;
    if (equipT > 0) return false;
    const item = slots[activeSlot];
    if (!item || item.kind !== "consumable") return false;
    const def = CONSUMABLE_BY_ID.get(item.def);
    if (!def) return false;

    const player = ctx.services.player;
    if (player && !player.controllable) return false;
    if (player && CHANNEL_BREAK_STATES.has(player.state)) {
      ctx.services.audio?.play("inventory-deny", { volume: 0.3 });
      return false;
    }

    const gain = healingFrom(def);
    if (gain.hp <= 0 && gain.shield <= 0) {
      // Refusing to burn a big potion for nothing is a kindness, and the deny
      // sound teaches the cap without a tooltip.
      ctx.services.audio?.play("inventory-deny", { volume: 0.35 });
      emitConsume("cancelled", "full");
      return false;
    }

    channelDef = def;
    channelSlot = activeSlot;
    channelT = def.useTime;
    channelTotal = def.useTime;
    channelReturn = activeSlot;
    hudDirty = true;
    ctx.services.audio?.play(`${def.sound}-start`, { volume: 0.5 });
    emitConsume("");
    return true;
  }

  function cancelUse(reason = "cancelled"): void {
    if (!channelDef) return;
    channelT = channelTotal;
    emitConsume("cancelled", reason);
    channelDef = null;
    channelSlot = -1;
    channelT = 0;
    hudDirty = true;
    ctx.services.audio?.play("consume-cancel", { volume: 0.3 });
  }

  function finishUse(): void {
    const def = channelDef;
    if (!def) return;
    const gain = healingFrom(def);
    ctx.services.player?.heal(gain.hp, gain.shield);
    ctx.services.audio?.play(def.sound, { volume: 0.6 });

    emitConsume("done");
    channelDef = null;
    channelT = 0;

    const slot = channelSlot;
    channelSlot = -1;
    const item = slot >= 0 ? slots[slot] : null;
    if (item && item.def === def.id) {
      item.count = Math.max(0, (item.count ?? 1) - 1);
      if (item.count <= 0) {
        slots[slot] = null;
        // Out of potions: put a weapon back in their hands. Standing there
        // holding an empty hand after a heal is how players die.
        if (activeSlot === slot) selectAfterEmpty(channelReturn);
      }
    }
    hudDirty = true;
  }

  /* ---- pickup / drop ---------------------------------------------------- */

  /** The first empty slot in 1..5, or -1. */
  function firstEmpty(): number {
    for (let i = 1; i < SLOT_COUNT; i++) if (!slots[i]) return i;
    return -1;
  }

  /** Has the player got a gun already? Drives the auto-switch. */
  function hasWeapon(): boolean {
    for (let i = 1; i < SLOT_COUNT; i++) if (slots[i]?.kind === "weapon") return true;
    return false;
  }

  function pickUp(item: InventoryItem): boolean {
    if (!item) return false;

    // Ammo grants never occupy a slot. They arrive as items only because
    // `LootService.spawn` speaks items.
    if (item.def.startsWith("ammo-")) {
      const cls = item.def.slice(5) as AmmoClass;
      if (!AMMO_CLASSES.includes(cls)) return false;
      const before = ammoOf(cls);
      const after = addAmmoOf(cls, item.count ?? AMMO_BOX[cls]);
      ctx.services.audio?.play("ammo-pickup", { volume: 0.4 });
      ctx.emit("dz:pickup", { name: item.name, rarity: item.rarity, count: after - before });
      return after > before;
    }

    // The pickaxe is not a thing you can be given.
    if (item.kind === "pickaxe") return false;

    let took = false;

    if (isStackable(item)) {
      const limit = stackLimit(item);
      let remaining = item.count ?? 1;
      // Merge into existing stacks first, lowest slot up, so a pickup never
      // costs a slot it did not have to.
      for (let i = 1; i < SLOT_COUNT && remaining > 0; i++) {
        const s = slots[i];
        if (!s || s.def !== item.def) continue;
        const room = limit - (s.count ?? 1);
        if (room <= 0) continue;
        const move = Math.min(room, remaining);
        s.count = (s.count ?? 1) + move;
        remaining -= move;
        took = true;
      }
      if (remaining > 0) {
        const empty = firstEmpty();
        if (empty >= 0) {
          item.count = remaining;
          slots[empty] = item;
          remaining = 0;
          took = true;
          if (!hasWeapon() && activeSlot === 0) select(empty);
        }
      }
      if (remaining > 0 && !took) {
        // Full, nothing merged: fall through to the replace path so the player
        // can still swap a potion for a potion they want more.
        item.count = remaining;
      } else {
        if (took) {
          hudDirty = true;
          ctx.services.audio?.play("item-pickup", { volume: 0.45 });
          ctx.emit("dz:pickup", { name: item.name, rarity: item.rarity, count: item.count ?? 1 });
          if (remaining > 0) {
            // Partial merge — every stack topped out and there was no free
            // slot. Silently eating the remainder is the kind of loss a player
            // notices later and blames the game for, so it goes back on the
            // floor where they left it.
            item.count = remaining;
            returnToWorld(item);
          }
        }
        return took;
      }
    } else {
      const empty = firstEmpty();
      if (empty >= 0) {
        slots[empty] = item;
        hudDirty = true;
        ctx.services.audio?.play("item-pickup", { volume: 0.45 });
        ctx.emit("dz:pickup", { name: item.name, rarity: item.rarity, count: 1 });
        // The auto-switch. Landing, finding your first gun and still holding
        // the pickaxe when someone rounds the corner is the single worst
        // avoidable death in the game, so the first weapon comes up by itself.
        if (item.kind === "weapon" && activeSlot === 0) select(empty);
        return true;
      }
    }

    // Full. Replace whatever is in hand — except the pickaxe, which cannot be
    // replaced, so a full inventory on slot 0 swaps into slot 1 instead. That
    // is a deliberate choice: refusing the pickup entirely reads as the game
    // ignoring the input.
    const target = activeSlot === 0 ? 1 : activeSlot;
    const displaced = slots[target];
    if (displaced) dropItem(displaced, target);
    slots[target] = item;
    if (channelSlot === target) cancelUse("replaced");
    // A replace is a swap: pay the equip cost, do not hand them a free
    // instant-shotgun-swap by walking over loot.
    equipTotal = equipTimeFor(item, false);
    equipT = activeSlot === target ? equipTotal : 0;
    if (activeSlot !== target) select(target);
    hudDirty = true;
    ctx.services.audio?.play("item-pickup", { volume: 0.45 });
    ctx.emit("dz:pickup", { name: item.name, rarity: item.rarity, count: item.count ?? 1 });
    return true;
  }

  /**
   * Put an item back on the ground where the player is standing, with no
   * impulse. Used for the remainder of a stack that would not fit, which
   * should stay where it was rather than be flung across the room.
   */
  function returnToWorld(item: InventoryItem): void {
    const loot = ctx.services.loot;
    if (!loot) return;
    const player = ctx.services.player;
    if (player) _v1.copy(player.position).setY(player.position.y + 0.35);
    else _v1.set(0, 1, 0);
    loot.spawn(item, _v1.clone());
  }

  /** Hand an item back to the world with a forward toss. */
  function dropItem(item: InventoryItem, slot: number): void {
    const loot = ctx.services.loot as LootLike | undefined;
    const player = ctx.services.player;
    if (!loot) return;

    if (player) {
      player.eye(_v1);
      player.look(_v2);
      // Out of the hand and slightly up, far enough forward that it clears the
      // player capsule and cannot be re-collected on the same frame.
      _v1.addScaledVector(_v2, 1.35);
      _v1.y += 0.05;
      _v3.copy(_v2).multiplyScalar(6.2);
      _v3.y += 2.6;
      _v3.add(player.velocity); // inherit momentum, or it drops behind you
    } else {
      _v1.set(0, 1, 0);
      _v3.set(0, 2, 0);
    }

    if (typeof loot.toss === "function") loot.toss(item, _v1, _v3);
    else loot.spawn(item, _v1.clone());

    ctx.emit("dz:drop", { name: item.name, rarity: item.rarity, slot });
  }

  function dropActive(): void {
    // Slot 0 is not droppable. This is checked here as well as in `pickUp`
    // because "G while holding the pickaxe" is a thing players do constantly.
    if (activeSlot === 0) {
      ctx.services.audio?.play("inventory-deny", { volume: 0.3 });
      return;
    }
    const item = slots[activeSlot];
    if (!item) return;
    if (channelSlot === activeSlot) cancelUse("dropped");
    const slot = activeSlot;
    slots[slot] = null;
    dropItem(item, slot);
    selectAfterEmpty(slot);
    hudDirty = true;
    ctx.services.audio?.play("item-drop", { volume: 0.4 });
  }

  /* ---- the service, published before any expensive work ------------------ */

  const service: InventoryServiceEx = {
    get wood() {
      return materials.wood;
    },
    set wood(v: number) {
      materials.wood = clamp(Math.round(v), 0, MATERIAL_CAP);
      hudDirty = true;
    },
    get stone() {
      return materials.stone;
    },
    set stone(v: number) {
      materials.stone = clamp(Math.round(v), 0, MATERIAL_CAP);
      hudDirty = true;
    },
    get metal() {
      return materials.metal;
    },
    set metal(v: number) {
      materials.metal = clamp(Math.round(v), 0, MATERIAL_CAP);
      hudDirty = true;
    },
    slots,
    get activeSlot() {
      return activeSlot;
    },
    set activeSlot(v: number) {
      select(v);
    },
    get active() {
      return slots[activeSlot] ?? null;
    },
    materialCap: MATERIAL_CAP,
    addMaterial,
    spendMaterial,
    pickUp,
    dropActive,
    select(slot: number) {
      select(slot);
    },
    ammo: ammoOf,
    addAmmo: addAmmoOf,
    takeAmmo(cls, amount) {
      const have = ammoOf(cls);
      const take = Math.min(have, Math.max(0, amount));
      if (take > 0) addAmmoOf(cls, -take);
      return take;
    },
    ammoClasses: AMMO_CLASSES,
    get equipping() {
      return equipT > 0;
    },
    get equipT() {
      return equipT;
    },
    get canFire() {
      return equipT <= 0 && channelDef === null;
    },
    get consuming() {
      return channelDef;
    },
    get consumeT() {
      return channelTotal > 0 ? clamp01(1 - channelT / channelTotal) : 0;
    },
    use,
    cancelUse,
    throwActive: () => throwActive(),
    makeItem,
    iconFor,
    consumables: CONSUMABLES,
    throwables: THROWABLES,
  };
  ctx.services.inventory = service;

  /* ---------------------------------------------------------------------- *
   * Throwables
   *
   * Nothing else in the boot list flies a grenade, so the ballistics live
   * here. One pooled `InstancedMesh` for the bodies and one for the fuse LED;
   * both hide themselves entirely when nothing is in the air, so the whole
   * feature costs zero draw calls in the common case.
   * ---------------------------------------------------------------------- */

  const poolSize = THROW_POOL[ctx.quality] ?? 8;
  const grenades: Grenade[] = [];
  for (let i = 0; i < poolSize; i++) {
    grenades.push({
      active: false,
      def: THROWABLES[0],
      pos: new THREE.Vector3(),
      prev: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      fuse: 0,
      resting: false,
      source: { by: "player", name: "You", weapon: "grenade" },
    });
  }
  let liveGrenades = 0;
  let throwCooldown = 0;

  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];
  let grenadeMesh: THREE.InstancedMesh | null = null;
  let fuseMesh: THREE.InstancedMesh | null = null;

  /**
   * The grenade body. Not a sphere: a lathed ogive with three raised rib bands,
   * a chamfered fuse collar and a spoon. Every one of those exists for the same
   * reason the world's props have trim — a smooth primitive has exactly one
   * highlight and reads as plastic, while ribs give the key light four edges to
   * catch as it tumbles, which is what sells it as metal in flight.
   */
  function buildGrenadeGeometry(): THREE.BufferGeometry | null {
    const parts: THREE.BufferGeometry[] = [];
    const R = THROW_RADIUS;

    const profile: THREE.Vector2[] = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Ogive: wide at the waist, tucked at both poles, with a small flat at
      // the top for the collar to sit on.
      const y = (t - 0.5) * 2 * R * 1.12;
      const r = R * Math.pow(Math.cos((t - 0.5) * Math.PI * 0.92), 0.62);
      profile.push(new THREE.Vector2(Math.max(0.0012, r), y));
    }
    parts.push(new THREE.LatheGeometry(profile, 16));

    // Rib bands. Torus rings sunk just proud of the body.
    for (let i = -1; i <= 1; i++) {
      const ring = new THREE.TorusGeometry(R * 0.9, R * 0.09, 5, 16);
      ring.rotateX(Math.PI * 0.5);
      ring.translate(0, i * R * 0.44, 0);
      parts.push(ring);
    }

    // Fuse collar: a slightly tapered, chamfered cylinder. The taper is the
    // bevel — a straight cylinder here looks like a peg.
    const collar = new THREE.CylinderGeometry(R * 0.34, R * 0.42, R * 0.5, 10, 1);
    collar.translate(0, R * 1.22, 0);
    parts.push(collar);
    const cap = new THREE.CylinderGeometry(R * 0.28, R * 0.34, R * 0.14, 10, 1);
    cap.translate(0, R * 1.5, 0);
    parts.push(cap);

    // Spoon: a thin strip down one side, kicked out at the bottom.
    const spoon = new THREE.BoxGeometry(R * 0.22, R * 1.5, R * 0.09);
    spoon.translate(R * 0.5, R * 0.7, 0);
    spoon.rotateZ(-0.12);
    parts.push(spoon);

    // Pin ring.
    const ring = new THREE.TorusGeometry(R * 0.26, R * 0.055, 5, 12);
    ring.rotateY(Math.PI * 0.5);
    ring.translate(-R * 0.5, R * 1.3, 0);
    parts.push(ring);

    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (merged) merged.computeVertexNormals();
    return merged;
  }

  function buildThrowMeshes(): void {
    const geo = buildGrenadeGeometry();
    if (!geo) return;
    ownedGeometries.push(geo);

    // Olive drab from the shared library when it is there, so the grenade sits
    // in the same PBR grade as everything else on the island — including its
    // roughness variation, which is what stops it reading as plastic.
    const mats = ctx.services.materials as MaterialsService | undefined;
    let bodyMat: THREE.Material;
    if (mats) {
      bodyMat = mats.tinted("metalPanel", 0x5c6b45);
    } else {
      // No shared library: mint our own, but never with a constant roughness.
      // A single scalar roughness on a small metal object is the exact tell
      // that reads as injection-moulded plastic, so we bake a tiny value-noise
      // map and vary it between 0.38 and 0.78 across the shell.
      const noise = makeNoiseTexture(32);
      ownedTextures.push(noise);
      const std = new THREE.MeshStandardMaterial({
        color: 0x6f7f52,
        roughness: 0.72,
        // Deliberately low for a metal object: without the shared library
        // there is no environment map, and a high-metalness surface with
        // nothing to reflect renders as a black hole. Half the metallic look
        // comes back from the roughness map's specular breakup anyway.
        metalness: 0.22,
        roughnessMap: noise,
      });
      bodyMat = std;
      ownedMaterials.push(std);
    }

    grenadeMesh = new THREE.InstancedMesh(geo, bodyMat, poolSize);
    grenadeMesh.name = "dz-grenades";
    grenadeMesh.frustumCulled = false;
    grenadeMesh.castShadow = true;
    grenadeMesh.receiveShadow = false;
    grenadeMesh.count = poolSize;
    grenadeMesh.visible = false;
    grenadeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ctx.scene.add(grenadeMesh);

    // The fuse LED. Its own tiny mesh with an emissive material so it survives
    // tone mapping and stays legible against a bright sky.
    // Small enough to read as an indicator rather than a nose cone. It sits
    // proud of the collar, so anything larger silhouettes against the sky and
    // starts to look like part of the shape.
    const led = new THREE.IcosahedronGeometry(THROW_RADIUS * 0.17, 0);
    ownedGeometries.push(led);
    const ledMat = new THREE.MeshStandardMaterial({
      color: 0x3a0a06,
      emissive: new THREE.Color(0xff4322),
      emissiveIntensity: 3.2,
      roughness: 0.4,
      metalness: 0,
      toneMapped: false,
    });
    ownedMaterials.push(ledMat);
    fuseMesh = new THREE.InstancedMesh(led, ledMat, poolSize);
    fuseMesh.name = "dz-grenade-fuses";
    fuseMesh.frustumCulled = false;
    fuseMesh.count = poolSize;
    fuseMesh.visible = false;
    fuseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ctx.scene.add(fuseMesh);
  }

  function throwActive(): boolean {
    if (throwCooldown > 0 || equipT > 0 || channelDef) return false;
    const item = slots[activeSlot];
    if (!item || item.kind !== "throwable") return false;
    const def = THROWABLE_BY_ID.get(item.def);
    if (!def) return false;
    const player = ctx.services.player;
    if (player && !player.controllable) return false;

    let free = -1;
    for (let i = 0; i < grenades.length; i++) {
      if (!grenades[i].active) {
        free = i;
        break;
      }
    }
    if (free < 0) return false;

    const g = grenades[free];
    g.active = true;
    g.def = def;
    g.fuse = def.fuse;
    g.resting = false;
    if (player) {
      player.eye(g.pos);
      player.look(_v2);
      g.pos.addScaledVector(_v2, 0.55);
      g.vel.copy(_v2).multiplyScalar(def.speed);
      g.vel.y += def.speed * def.lift;
      g.vel.add(player.velocity);
    } else {
      g.pos.set(0, 2, 0);
      g.vel.set(0, def.speed * 0.6, -def.speed);
    }
    g.prev.copy(g.pos);
    // Tumble rate scaled off the throw so a lobbed grenade rolls lazily and a
    // hard throw spins.
    g.spin.set(
      (ctx.rng() - 0.5) * 14,
      (ctx.rng() - 0.5) * 9,
      (ctx.rng() - 0.5) * 14,
    );
    g.quat.identity();
    liveGrenades++;
    throwCooldown = def.cooldown;

    item.count = Math.max(0, (item.count ?? 1) - 1);
    if (item.count <= 0) {
      const slot = activeSlot;
      slots[slot] = null;
      selectAfterEmpty(slot);
    }
    hudDirty = true;
    ctx.services.audio?.play("grenade-throw", { volume: 0.5 });
    return true;
  }

  function detonate(g: Grenade): void {
    const combat = ctx.services.combat;
    if (combat) {
      combat.explode(g.pos, g.def.radius, g.def.damage, g.source);
    } else {
      // Combat failed to boot: at least make the grenade visibly do something.
      ctx.services.vfx?.explosion(g.pos.clone(), 1.3);
      ctx.services.audio?.play("explosion", { position: g.pos.clone(), volume: 0.9 });
    }
    g.active = false;
    liveGrenades = Math.max(0, liveGrenades - 1);
    hudDirty = true;
  }

  function stepGrenades(dt: number): void {
    if (liveGrenades <= 0) return;
    const collision = ctx.services.collision;
    const terrain = ctx.services.terrain;

    for (const g of grenades) {
      if (!g.active) continue;
      g.fuse -= dt;
      if (g.fuse <= 0) {
        detonate(g);
        continue;
      }
      if (g.resting) continue;

      g.prev.copy(g.pos);
      g.vel.y -= THROW_GRAVITY * dt;
      g.vel.multiplyScalar(Math.max(0, 1 - THROW_DRAG * dt));
      _v1.copy(g.vel).multiplyScalar(dt);
      const travel = _v1.length();

      if (collision && travel > 1e-5) {
        _v2.copy(_v1).divideScalar(travel);
        const hit = collision.raycast(g.prev, _v2, travel + THROW_RADIUS);
        if (hit && hit.distance <= travel + THROW_RADIUS) {
          // Land it on the surface, then reflect. Restitution is low and
          // friction is high because a grenade that bounces like a rubber ball
          // is unaimable — the whole point of the throw is that where it lands
          // is where you meant.
          g.pos.copy(hit.point).addScaledVector(hit.normal, THROW_RADIUS * 1.02);
          // Split the velocity into normal and tangent, scrub each by its own
          // coefficient, recombine. Allocation-free, and it is the only form
          // that stays stable when the surface is not axis-aligned.
          const vn = g.vel.dot(hit.normal);
          _v3.copy(hit.normal).multiplyScalar(vn);
          g.vel.sub(_v3).multiplyScalar(g.def.friction);
          g.vel.addScaledVector(hit.normal, -vn * g.def.restitution);
          g.spin.multiplyScalar(0.55);
          if (Math.abs(vn) > 1.6) {
            ctx.services.audio?.play("grenade-bounce", {
              position: g.pos.clone(),
              volume: clamp(Math.abs(vn) * 0.06, 0.1, 0.5),
              maxDistance: 40,
            });
          }
        } else {
          g.pos.add(_v1);
        }
      } else {
        g.pos.add(_v1);
      }

      // Terrain is not in the collider set, so the ground is its own test.
      if (terrain) {
        const h = terrain.heightAt(g.pos.x, g.pos.z) + THROW_RADIUS;
        if (g.pos.y < h) {
          g.pos.y = h;
          if (g.vel.y < 0) {
            const impact = -g.vel.y;
            g.vel.y = impact * g.def.restitution;
            g.vel.x *= g.def.friction;
            g.vel.z *= g.def.friction;
            g.spin.multiplyScalar(0.55);
            if (impact > 1.6) {
              ctx.services.audio?.play("grenade-bounce", {
                position: g.pos.clone(),
                volume: clamp(impact * 0.06, 0.1, 0.5),
                maxDistance: 40,
              });
            }
          }
          if (g.vel.lengthSq() < THROW_SLEEP_SPEED * THROW_SLEEP_SPEED) {
            g.vel.set(0, 0, 0);
            g.resting = true;
          }
        }
      }

      // Integrate the tumble as an incremental rotation about the spin axis.
      const spinLen = g.spin.length();
      if (spinLen > 1e-4) {
        _v3.copy(g.spin).divideScalar(spinLen);
        _quat.setFromAxisAngle(_v3, spinLen * dt);
        g.quat.premultiply(_quat).normalize();
      }
    }
  }

  /** Cosmetic: write the instance matrices and trail smoke. */
  function drawGrenades(dt: number): void {
    if (!grenadeMesh || !fuseMesh) return;
    const any = liveGrenades > 0;
    grenadeMesh.visible = any;
    fuseMesh.visible = any;
    if (!any) return;

    for (let i = 0; i < grenades.length; i++) {
      const g = grenades[i];
      if (!g.active) {
        _mat4.makeScale(0, 0, 0);
        grenadeMesh.setMatrixAt(i, _mat4);
        fuseMesh.setMatrixAt(i, _mat4);
        continue;
      }
      _scale.setScalar(1);
      _mat4.compose(g.pos, g.quat, _scale);
      grenadeMesh.setMatrixAt(i, _mat4);

      // The LED blinks faster as the fuse runs down — the read that tells you
      // whether to run or to keep shooting.
      const remaining = g.fuse / Math.max(0.001, g.def.fuse);
      const rate = 6 + (1 - remaining) * 22;
      const on = Math.sin(ctx.elapsed * rate) > -0.2;
      _v1.set(0, THROW_RADIUS * 1.62, 0).applyQuaternion(g.quat).add(g.pos);
      _scale.setScalar(on ? 1 : 0.0001);
      _mat4.compose(_v1, g.quat, _scale);
      fuseMesh.setMatrixAt(i, _mat4);

      // A wisp of smoke off the fuse, only while it is actually moving, so a
      // grenade sitting in a corner does not fog the room.
      if (!g.resting && ctx.quality !== "low" && Math.random() < dt * 26) {
        ctx.services.vfx?.smoke(_v1.clone(), 1);
      }
    }
    grenadeMesh.instanceMatrix.needsUpdate = true;
    fuseMesh.instanceMatrix.needsUpdate = true;
  }

  /* ---- HUD payload ------------------------------------------------------ */

  const slotViews: InventorySlotView[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    slotViews.push({
      index: i,
      id: null,
      kind: null,
      def: "",
      name: "",
      rarity: "common",
      color: RARITY_COLOR.common,
      ammo: 0,
      magSize: 0,
      reserve: 0,
      ammoClass: null,
      count: 0,
      icon: "",
      active: false,
      equip: 0,
    });
  }

  const hud: InventoryHudPayload = {
    slots: slotViews,
    activeSlot: 0,
    wood: 0,
    stone: 0,
    metal: 0,
    materialCap: MATERIAL_CAP,
    flashWood: 0,
    flashStone: 0,
    flashMetal: 0,
    equip: 1,
    equipping: false,
    light: 0,
    medium: 0,
    heavy: 0,
    shells: 0,
    rockets: 0,
    inFlight: 0,
  };

  function emitHud(): void {
    const w = weapons();
    for (let i = 0; i < SLOT_COUNT; i++) {
      const v = slotViews[i];
      const item = slots[i];
      v.active = i === activeSlot;
      v.equip = v.active ? equipT : 0;
      if (!item) {
        v.id = null;
        v.kind = null;
        v.def = "";
        v.name = "";
        v.rarity = "common";
        v.color = RARITY_COLOR.common;
        v.ammo = 0;
        v.magSize = 0;
        v.reserve = 0;
        v.ammoClass = null;
        v.count = 0;
        v.icon = "";
        continue;
      }
      v.id = item.id;
      v.kind = item.kind;
      v.def = item.def;
      v.rarity = item.rarity;
      v.color = RARITY_COLOR[item.rarity] ?? RARITY_COLOR.common;
      v.count = item.count ?? 0;
      v.icon = iconFor(item);
      if (item.kind === "weapon") {
        const def = w?.def?.(item.def) ?? null;
        v.name = w?.displayName?.(item.def, item.rarity) ?? item.name;
        v.ammo = item.ammo ?? 0;
        v.magSize = def?.magSize ?? 0;
        v.ammoClass = def?.ammoType ?? null;
        v.reserve = v.ammoClass ? ammoOf(v.ammoClass) : 0;
      } else {
        v.name = item.name;
        v.ammo = 0;
        v.magSize = 0;
        v.ammoClass = null;
        v.reserve = 0;
      }
    }

    hud.activeSlot = activeSlot;
    hud.wood = materials.wood;
    hud.stone = materials.stone;
    hud.metal = materials.metal;
    hud.flashWood = clamp01(flash.wood / MATERIAL_FLASH);
    hud.flashStone = clamp01(flash.stone / MATERIAL_FLASH);
    hud.flashMetal = clamp01(flash.metal / MATERIAL_FLASH);
    hud.equip = equipTotal > 0 ? clamp01(1 - equipT / equipTotal) : 1;
    hud.equipping = equipT > 0;
    hud.light = ammoOf("light");
    hud.medium = ammoOf("medium");
    hud.heavy = ammoOf("heavy");
    hud.shells = ammoOf("shells");
    hud.rockets = ammoOf("rockets");
    hud.inFlight = liveGrenades;
    ctx.emit("dz:inventory", hud);
  }

  /* ---- events ----------------------------------------------------------- */

  const unsubscribe: (() => void)[] = [];

  // Taking a hit breaks the channel. This is the rule that makes a big potion
  // a gamble rather than a formality, and it has to be event-driven — polling
  // health would miss a hit that a shield absorbed entirely.
  unsubscribe.push(
    ctx.on("dz:hit", () => {
      if (channelDef) cancelUse("damaged");
    }),
  );
  unsubscribe.push(
    ctx.on("dz:down", () => {
      if (channelDef) cancelUse("downed");
    }),
  );
  unsubscribe.push(
    ctx.on("dz:death", () => {
      if (channelDef) cancelUse("dead");
      // Everything in flight goes with you — a grenade detonating after the
      // owner is dead reads as a bug even when it is physically correct.
      for (const g of grenades) {
        if (g.active) {
          g.active = false;
          liveGrenades = Math.max(0, liveGrenades - 1);
        }
      }
      hudDirty = true;
    }),
  );

  /* ---- input ------------------------------------------------------------ */

  /**
   * Edge-triggered input is consumed in `fixed()` and latched, the same way
   * the build system does it. `update()` runs after every fixed step in a
   * frame, so consuming there costs a whole frame of latency on every slot
   * change; the latch is what keeps "consume in fixed" exactly-once when the
   * engine runs six sim steps back to back.
   */
  let edgesConsumed = false;
  let lastFire = false;

  function readInput(): void {
    if (edgesConsumed) return;
    edgesConsumed = true;
    const input = ctx.input;

    if (input.slot !== null) select(input.slot - 1);
    if (input.wheel !== 0) cycle(input.wheel > 0 ? 1 : -1);
    if (input.drop) dropActive();

    const fireEdge = input.fire && !lastFire;
    lastFire = input.fire;
    if (fireEdge && !input.buildKind) {
      const item = slots[activeSlot];
      if (item?.kind === "consumable" && !item.def.startsWith("ammo-")) use();
      else if (item?.kind === "throwable") throwActive();
    }
  }

  /* ---- channel stepping -------------------------------------------------- */

  function stepChannel(dt: number): void {
    if (!channelDef) return;
    const player = ctx.services.player;
    if (player) {
      if (!player.controllable || CHANNEL_BREAK_STATES.has(player.state)) {
        cancelUse("interrupted");
        return;
      }
      const speed = Math.hypot(player.velocity.x, player.velocity.z);
      if (speed > CHANNEL_BREAK_SPEED) {
        cancelUse("moved");
        return;
      }
    }
    // The item can vanish under the channel (dropped, replaced, thrown).
    const item = channelSlot >= 0 ? slots[channelSlot] : null;
    if (!item || item.def !== channelDef.id) {
      cancelUse("lost");
      return;
    }
    channelT -= dt;
    if (channelT <= 0) {
      channelT = 0;
      finishUse();
    }
  }

  /* ---- boot-time bake ---------------------------------------------------- */
  // Everything above this point is either a declaration or the service itself,
  // so a failure down here costs the grenade mesh and the prebaked icons and
  // nothing else. The service is already published.

  buildThrowMeshes();

  // Prebake the icons the player is guaranteed to see: the pickaxe, every
  // consumable and every throwable. Weapon icons are painted on first pickup —
  // a couple of milliseconds inside a pickup nobody feels, against nine
  // silhouettes × five tiers of boot time nobody should pay for.
  iconFor(PICKAXE);
  for (const c of CONSUMABLES) {
    const probe = makeItem(c.id, 1);
    if (probe) iconFor(probe);
  }
  for (const t of THROWABLES) {
    const probe = makeItem(t.id, 1);
    if (probe) iconFor(probe);
  }

  /* ---- system ------------------------------------------------------------ */

  const sys: FixedSystem = {
    name: "inventory",

    fixed(dt) {
      readInput();

      if (equipT > 0) {
        equipT = Math.max(0, equipT - dt);
        if (equipT === 0) hudDirty = true;
      }
      if (throwCooldown > 0) throwCooldown = Math.max(0, throwCooldown - dt);

      stepChannel(dt);
      stepGrenades(dt);
    },

    update(dt) {
      edgesConsumed = false;

      // Material flashes decay here rather than in `fixed` — they are purely a
      // HUD cosmetic and stepping them 120 times a second buys nothing.
      let flashing = false;
      for (const k of MATERIAL_KINDS) {
        if (flash[k] > 0) {
          flash[k] = Math.max(0, flash[k] - dt);
          flashing = true;
        }
      }

      drawGrenades(dt);

      // Channel progress is its own channel so the HUD's ring can be smooth
      // without a full inventory payload every frame. 20 Hz is under the
      // threshold where a CSS-animated ring looks stepped.
      if (channelDef) {
        consumeClock += dt;
        if (consumeClock >= 0.05) {
          consumeClock = 0;
          emitConsume("");
        }
      } else {
        consumeClock = 0;
      }

      // Discrete changes emit immediately; continuous ones (equip progress,
      // the material pulse, grenades in the air) ride a 30 Hz rail so a HUD
      // that re-renders per event is not re-rendering per frame.
      const animating = flashing || equipT > 0 || liveGrenades > 0;
      if (hudDirty) {
        hudDirty = false;
        hudClock = 0;
        emitHud();
      } else if (animating) {
        hudClock += dt;
        if (hudClock >= 1 / 30) {
          hudClock = 0;
          emitHud();
        }
      }
    },

    dispose() {
      for (const off of unsubscribe) off();
      unsubscribe.length = 0;

      if (grenadeMesh) {
        ctx.scene.remove(grenadeMesh);
        grenadeMesh.dispose();
        grenadeMesh = null;
      }
      if (fuseMesh) {
        ctx.scene.remove(fuseMesh);
        fuseMesh.dispose();
        fuseMesh = null;
      }
      for (const g of ownedGeometries) g.dispose();
      ownedGeometries.length = 0;
      // Only materials this module minted. Anything from the shared library is
      // cached and owned there — disposing it would take out every other
      // surface using the same tint.
      for (const m of ownedMaterials) m.dispose();
      ownedMaterials.length = 0;
      for (const t of ownedTextures) t.dispose();
      ownedTextures.length = 0;

      iconCache.clear();
      if (iconCanvas) {
        // Zeroing the backing store is what actually frees the pixels; letting
        // the element fall out of scope leaves them alive until a GC that may
        // never come while the next world is loading.
        iconCanvas.width = 0;
        iconCanvas.height = 0;
        iconCanvas = null;
        iconCtx = null;
      }

      if (ctx.services.inventory === service) delete ctx.services.inventory;
    },
  };

  return sys;
};

export default createInventory;
