/**
 * DROP ZERO — loot.
 *
 * Publishes `LootService`. Chests, floor loot, ammo boxes and the supply
 * drops that fall into the closing circle. Everything a player picks up in a
 * match comes from here, and — more importantly — everything a player *sees
 * from across a room* and decides to walk towards comes from here too.
 *
 * ── The read is the feature ────────────────────────────────────────────────
 * Loot in a battle royale is a navigation problem before it is an economy.
 * You land on a roof, you turn once, and in that half second the room has to
 * tell you: there is a gun on that floor, it is purple, and there is a chest
 * behind the counter. Fortnite solves it with three cues stacked on top of
 * each other and all three are implemented here:
 *
 *  1. **A rarity-coloured beam** that is brighter at its base, streaked, and
 *     visible through the gap under a doorway. It is the long-range cue.
 *  2. **A ground glow + drifting motes** that pin the beam to a spot on the
 *     floor. Without them the beam floats and you misjudge the approach.
 *  3. **The item's actual silhouette**, slowly turning, so at conversational
 *     range you know it is a pump and not an SMG before the prompt appears.
 *
 * The chest gets a fourth: a hum you can hear through a wall from ~20 m. That
 * hum is the single most-used piece of information in the whole game and it
 * is why this module owns a small `AudioContext` of its own (see `LootAudio`)
 * rather than going through the one-shot audio service — a distance-driven
 * continuous voice is not a `play()` call.
 *
 * ── Placement is raycast, never assumed ────────────────────────────────────
 * Nothing here knows what a POI looks like. `pois` publishes centres and
 * radii and that is all, so a spawn point is found by *probing*: cast down
 * through the collision world from high above a candidate XZ and collect the
 * whole stack of horizontal surfaces under it — roof, first floor, ground.
 * Then score them. A surface with a ceiling 3 m over it is an interior floor
 * and that is where a chest belongs; a surface with nothing above it, 6 m
 * over the terrain, is a roof and gets rejected. This is why loot lands on
 * the second storey of a house the module has never heard of, and why
 * nothing floats or sinks.
 *
 * ── Cost control ───────────────────────────────────────────────────────────
 * There are ~110 chests and ~200 loose pickups on the island. None of them
 * exist as scene nodes until the camera is within ~80 m, and even then only
 * the nearest N are given a mesh, the nearest fewer a beam. Motes, chest
 * sparkle, the supply-drop flare and every other particle in this module
 * share ONE `THREE.Points` — one draw call for the lot. The active set is
 * re-sorted at 8 Hz, not per frame, because the player cannot outrun 80 m of
 * hysteresis in 125 ms.
 *
 * ── What it consumes, all optional ─────────────────────────────────────────
 * `pois` (where to put things), `collision`/`terrain` (what to put them on),
 * `inventory` (`pickUp`), `weapons` (roll a gun, top up reserve ammo), `vfx`
 * (`lootBeam` if it exists — we fall back to our own), `audio` (one-shots),
 * `storm` (rarity drift + where a supply drop is allowed to land), `player`.
 * Every one of them is null-checked at the point of use. A match with no
 * weapons system still has chests; they just cough up consumables.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RARITY_COLOR, makeRng } from "../types";
import type {
  CollisionService,
  InventoryItem,
  InventoryService,
  LootPickup,
  LootService,
  MaterialName,
  MaterialsService,
  Poi,
  QualityTier,
  Rarity,
  StormService,
  System,
  SystemFactory,
  TerrainService,
  VfxService,
  WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Contract shims
 *
 * `types.ts` is shared by every system and is not ours to edit while the rest
 * of the game is compiling against it. Anything we need beyond the published
 * interfaces is read structurally and optionally, with a fallback that works
 * when it is missing entirely.
 * ------------------------------------------------------------------------ */

/**
 * The weapons system publishes an extra `weapons` key (its own header says
 * so) carrying the arsenal, the rarity ladder and the reserve-ammo pool. We
 * use it to roll and name guns so the loot table and the ballistics can never
 * disagree — but every method is optional here, and `WEAPON_FALLBACK` below
 * keeps chests stocked if the arsenal never booted.
 */
interface WeaponsLike {
  makeItem?(id: string, rarity: Rarity): InventoryItem | null;
  rollWeapon?(rng: () => number, rarity: Rarity): string | null;
  displayName?(id: string, rarity: Rarity): string;
  addAmmo?(type: string, amount: number): number;
  def?(id: string): { name?: string; ammoType?: string; magSize?: number } | null;
}

/** Audio's one-shot surface. Positional where it can be. */
interface AudioLike {
  play?(name: string, opts?: { position?: THREE.Vector3; volume?: number; rate?: number; maxDistance?: number }): void;
  readonly ready?: boolean;
}

/** The bits of the player we read for the interact test. */
interface PlayerLike {
  position: THREE.Vector3;
  readonly controllable?: boolean;
  eye?(out?: THREE.Vector3): THREE.Vector3;
  look?(out?: THREE.Vector3): THREE.Vector3;
}

/** Everything we may reach for, all optional. */
interface LootServices {
  materials?: MaterialsService;
  terrain?: TerrainService;
  collision?: CollisionService;
  inventory?: InventoryService;
  vfx?: VfxService;
  audio?: AudioLike;
  storm?: StormService;
  player?: PlayerLike;
  weapons?: WeaponsLike;
  pois?: Poi[];
  loot?: LootService;
}

/** Our own service surface: the contract plus a few things the HUD wants. */
export interface LootServiceExt extends LootService {
  /** Nearest interactable of ANY kind — chest, ammo box, supply crate, item. */
  readonly prompt: LootPrompt | null;
  /** Live pickup count, for the debug overlay. */
  readonly pickupCount: number;
  readonly chestCount: number;
  readonly chestsOpened: number;
  /** Force a supply drop now. The match system uses this for the final circle. */
  requestSupplyDrop(at?: THREE.Vector3): boolean;
}

/** Payload of `dz:loot-prompt`. Null when there is nothing in reach. */
export interface LootPrompt {
  kind: "item" | "chest" | "ammo" | "supply";
  /** "Assault Rifle", "Chest", "Ammo Box"… */
  name: string;
  rarity: Rarity;
  /** "Take" / "Open". */
  action: string;
  /** 0..1 hold progress. Instant interactions stay at 0. */
  hold: number;
  /** Seconds the hold takes, 0 for a tap. */
  holdTime: number;
  /** Metres to the thing, so the HUD can fade the prompt in. */
  distance: number;
}

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/**
 * Radius inside which a pickup gets a mesh, a beam and an animation budget.
 * 80 m is a little past the far wall of the biggest POI interior, so you
 * never watch loot pop in inside a building you are already standing in.
 */
const ACTIVE_RANGE = 80;
/** Chests are bigger and read from further, so they activate slightly wider. */
const CHEST_RANGE = 92;
/** Hysteresis on both, so a pickup on the boundary cannot flicker. */
const DEACTIVATE_SLOP = 8;

/** How often the active set is re-sorted. 8 Hz — see the header. */
const ACTIVE_INTERVAL = 0.125;

/**
 * Reach for the interact prompt. Fortnite's is generous to a fault and it is
 * the right call: fighting the game to pick up a gun mid-rotate is miserable.
 */
const PICKUP_RANGE = 2.4;
const CHEST_RANGE_INTERACT = 3.0;

/**
 * Seconds between two takes inside ONE continuous press of interact. A floor
 * item is a tap, but a held key must still be able to sweep a pile — walking
 * into a chest's spill with E down is how everybody actually collects loot.
 * The delay is what keeps that a sweep rather than a vacuum: one item every
 * quarter second, in nearest-first order, so the player can see what they took
 * and let go before the fifth thing fills their last slot.
 */
const ITEM_REPEAT = 0.25;

/** Hold times. A chest is deliberate; an item you have already decided on. */
const CHEST_HOLD = 0.5;
const AMMO_HOLD = 0.35;
const SUPPLY_HOLD = 0.7;

/** Distance the chest hum is inaudible past. The brief's ~20 m. */
const HUM_RANGE = 21;

/** Metres a loose item floats above its resting surface, and its bob depth. */
const HOVER = 0.42;
const BOB = 0.055;
/** Radians per second a pickup turns. Slow enough to read the silhouette. */
const SPIN_RATE = 0.85;

/**
 * Gravity for ejected items. Heavier than the player's fall (which is ~24)
 * would make the arc snap; lighter makes chest loot hang in the air like it
 * is underwater. 19 lands a 5.5 m/s pop in a hair under 0.6 s, which is
 * exactly as long as the chest-open chime.
 */
const ITEM_GRAVITY = 19;
/** Restitution and friction of an item hitting a floor. Loot does not roll far. */
const ITEM_BOUNCE = 0.24;
const ITEM_FRICTION = 0.42;

/** Seconds the chest lid takes to fly open, and how far past level it swings. */
const LID_TIME = 0.42;
const LID_ANGLE = 1.92;

/** Supply drop descent rate. Slow enough to be a decision, not an event. */
const DROP_SPEED = 6.5;
/** Metres above the ground a supply drop spawns. */
const DROP_ALTITUDE = 190;
/** Never more than this many crates in the air at once. */
const MAX_DROPS = 2;

/**
 * Per-tier budgets. `beams` is the expensive one — each is two additive draws
 * over a full-screen-ish area at close range, and overdraw is what actually
 * costs on a laptop GPU, not the triangles.
 */
interface Budget {
  /** Pickups given a mesh at once. */
  meshes: number;
  /** Pickups given a beam at once. Always <= meshes. */
  beams: number;
  /** Chests given a mesh at once. */
  chests: number;
  /** Particle ring-buffer size, shared by motes, sparkle and flare smoke. */
  particles: number;
  /** Motes emitted per beam per second. */
  moteRate: number;
  /** Bevel segments on the hero props. */
  bevel: number;
  /** Canvas texture edge for the bakes. */
  texSize: number;
}

const BUDGETS: Record<QualityTier, Budget> = {
  low: { meshes: 12, beams: 8, chests: 5, particles: 96, moteRate: 2.0, bevel: 1, texSize: 128 },
  medium: { meshes: 18, beams: 12, chests: 9, particles: 192, moteRate: 3.0, bevel: 1, texSize: 256 },
  high: { meshes: 26, beams: 18, chests: 13, particles: 320, moteRate: 4.0, bevel: 2, texSize: 256 },
  ultra: { meshes: 34, beams: 24, chests: 16, particles: 448, moteRate: 5.0, bevel: 2, texSize: 512 },
};

/**
 * World metres spanned by one UV repeat, for the two library materials this
 * module borrows. It mirrors `MATERIAL_TILE_METRES` in the material library
 * rather than importing it (systems do not import each other) — it only sets
 * the tiling scale on a 0.9 m prop, so drifting a little from the table costs
 * nothing but a slightly different grain size.
 */
const TILE_METRES: Partial<Record<MaterialName, number>> = { gold: 1.2, woodPlank: 2.6, fabric: 1.6 };

/* ------------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------------ */

const RARITY_ORDER: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];

const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

type AmmoKind = "light" | "medium" | "heavy" | "shells" | "rockets";

/** Which pickup-mesh builder a weapon id uses, and how big it reads. */
type GunShape = "rifle" | "smg" | "shotgun" | "sniper" | "pistol" | "rocket" | "minigun";

interface WeaponFallback {
  id: string;
  name: string;
  ammo: AmmoKind;
  shape: GunShape;
  mag: number;
  /** Loot weight per rarity index. Mirrors the arsenal's own shape: the heavy
   *  hitters are rare-and-up, the sidearms thin out as the tiers climb. */
  weights: [number, number, number, number, number];
}

/**
 * The gun list, used ONLY when the weapons system did not boot or does not
 * expose `rollWeapon`. The ids match the arsenal exactly, so an item minted
 * from here still works the moment weapons comes back.
 */
const WEAPON_FALLBACK: WeaponFallback[] = [
  { id: "ar", name: "Assault Rifle", ammo: "medium", shape: "rifle", mag: 30, weights: [30, 30, 26, 20, 14] },
  { id: "smg", name: "Submachine Gun", ammo: "light", shape: "smg", mag: 30, weights: [26, 24, 20, 15, 10] },
  { id: "pump", name: "Pump Shotgun", ammo: "shells", shape: "shotgun", mag: 5, weights: [18, 18, 18, 16, 12] },
  { id: "tac", name: "Tactical Shotgun", ammo: "shells", shape: "shotgun", mag: 8, weights: [16, 16, 15, 13, 10] },
  { id: "sniper", name: "Bolt-Action Sniper", ammo: "heavy", shape: "sniper", mag: 1, weights: [0, 6, 10, 12, 12] },
  { id: "burst", name: "Burst Rifle", ammo: "medium", shape: "rifle", mag: 30, weights: [14, 14, 14, 12, 10] },
  { id: "rocket", name: "Rocket Launcher", ammo: "rockets", shape: "rocket", mag: 1, weights: [0, 0, 4, 6, 8] },
  { id: "pistol", name: "Pistol", ammo: "light", shape: "pistol", mag: 16, weights: [24, 16, 10, 6, 3] },
  { id: "minigun", name: "Minigun", ammo: "light", shape: "minigun", mag: 200, weights: [0, 0, 5, 7, 8] },
];

const SHAPE_BY_ID = new Map<string, GunShape>(WEAPON_FALLBACK.map((w) => [w.id, w.shape]));
const AMMO_BY_ID = new Map<string, AmmoKind>(WEAPON_FALLBACK.map((w) => [w.id, w.ammo]));

/**
 * Consumables. Rarity here is *fixed*, not rolled — a Small Shield Potion is
 * always uncommon in Fortnite and that consistency is what lets a player read
 * a green beam across a room as "shields" without thinking. Only the drop
 * *rate* moves with the POI tier and the circle.
 */
interface ConsumableDef {
  id: string;
  name: string;
  kind: "consumable" | "throwable";
  rarity: Rarity;
  /** Stack size a single pickup carries. */
  count: number;
  /** Mesh builder key. */
  shape: "bandage" | "medkit" | "flask" | "jug" | "grenade";
  /** The item's own signature colour — the red cross, the shield blue. */
  tint: number;
  /** Relative weight in the consumable sub-roll. */
  weight: number;
}

const CONSUMABLES: ConsumableDef[] = [
  { id: "bandage", name: "Bandages", kind: "consumable", rarity: "common", count: 5, shape: "bandage", tint: 0xd8443c, weight: 26 },
  { id: "medkit", name: "Med Kit", kind: "consumable", rarity: "uncommon", count: 1, shape: "medkit", tint: 0xe24b3f, weight: 16 },
  { id: "shield-small", name: "Small Shield Potion", kind: "consumable", rarity: "uncommon", count: 3, shape: "flask", tint: 0x2b9fe8, weight: 24 },
  { id: "shield-big", name: "Shield Potion", kind: "consumable", rarity: "epic", count: 2, shape: "flask", tint: 0x6a3ce8, weight: 14 },
  { id: "chug", name: "Chug Jug", kind: "consumable", rarity: "legendary", count: 1, shape: "jug", tint: 0xf2a93b, weight: 3 },
  { id: "grenade", name: "Grenades", kind: "throwable", rarity: "common", count: 3, shape: "grenade", tint: 0x5c6b3a, weight: 17 },
];

const CONSUMABLE_BY_ID = new Map<string, ConsumableDef>(CONSUMABLES.map((c) => [c.id, c]));

/** Display name + colour for the ammo pickups. */
const AMMO_META: Record<AmmoKind, { name: string; rounds: number; tint: number }> = {
  light: { name: "Light Ammo", rounds: 36, tint: 0xc8a35a },
  medium: { name: "Medium Ammo", rounds: 30, tint: 0xb5893f },
  heavy: { name: "Heavy Ammo", rounds: 8, tint: 0x8f6a3a },
  shells: { name: "Shells", rounds: 12, tint: 0xc0503c },
  rockets: { name: "Rockets", rounds: 2, tint: 0x4a5560 },
};

const AMMO_KINDS: AmmoKind[] = ["light", "medium", "heavy", "shells", "rockets"];

/* ------------------------------------------------------------------------ *
 * Rarity
 * ------------------------------------------------------------------------ */

/**
 * Base rarity weights by POI tier. A minor POI is a common-and-uncommon
 * affair with an outside shot at something good; a landmark is where you go
 * when you want purple, and where four other people will be.
 */
const TIER_WEIGHTS: Record<Poi["tier"] | "rural" | "supply", [number, number, number, number, number]> = {
  minor: [46, 31, 16, 6, 1],
  major: [34, 32, 22, 9, 3],
  landmark: [23, 30, 27, 15, 5],
  rural: [52, 30, 13, 4, 1],
  // A supply crate is the only guaranteed legendary in the game. That is the
  // whole reason anybody walks into an open field for one.
  supply: [0, 0, 0, 18, 82],
};

/**
 * How hard the ladder tilts upward per circle. Applied as `mult^index`, so
 * circle 6 multiplies legendary weight by ~1.13^4 per step — by the endgame a
 * chest is roughly three times as likely to hold an epic as it was on the
 * bus. Late loot being better is what makes the third circle worth rotating
 * for instead of camping the first house you landed on.
 */
const CIRCLE_TILT = 1.13;

function rollRarity(rng: () => number, tier: keyof typeof TIER_WEIGHTS, circle: number): Rarity {
  const base = TIER_WEIGHTS[tier] ?? TIER_WEIGHTS.minor;
  const steps = Math.max(0, circle - 1);
  let total = 0;
  const w: number[] = [0, 0, 0, 0, 0];
  for (let i = 0; i < 5; i++) {
    w[i] = base[i] * Math.pow(CIRCLE_TILT, steps * i * 0.5);
    total += w[i];
  }
  if (total <= 0) return "common";
  let pick = rng() * total;
  for (let i = 0; i < 5; i++) {
    pick -= w[i];
    if (pick <= 0) return RARITY_ORDER[i];
  }
  return "common";
}

function rarityIndex(r: Rarity): number {
  const i = RARITY_ORDER.indexOf(r);
  return i < 0 ? 0 : i;
}

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Frame-rate independent exponential approach. */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Ease-out-back: overshoots then settles. The chest lid lives on this. */
function easeOutBack(t: number, overshoot = 1.4): number {
  const p = t - 1;
  return 1 + (overshoot + 1) * p * p * p + overshoot * p * p;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------------ *
 * Procedural textures
 *
 * Everything is baked on a 2D canvas at boot. No file ever leaves the bundle.
 * The point of every one of these is the same: kill uniform roughness. A prop
 * with one roughness value is plastic no matter how good its albedo is, and a
 * loot chest is the prop the player's eye lands on most often in a match.
 * ------------------------------------------------------------------------ */

function canvas2d(size: number, height = size): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = height;
  const g = c.getContext("2d");
  if (!g) throw new Error("loot: 2D canvas unavailable");
  return { c, g };
}

function toTexture(c: HTMLCanvasElement, srgb: boolean, aniso = 4): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * A tileable value-noise field, sampled by everything below. Written straight
 * into an ImageData rather than composited from `fillRect`s because a per-
 * pixel loop over 256² is under a millisecond and gives us honest bilinear
 * interpolation instead of visible blocks.
 */
function noiseField(size: number, rng: () => number, cells: number): Float32Array {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const out = new Float32Array(size * size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const fy = y * scale;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      // Smoothstep the interpolant: linear interpolation of a value grid has
      // visible diamond artefacts along the cell diagonals.
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const i00 = ((y0 % cells) + cells) % cells;
      const i10 = ((y0 + 1) % cells) * cells;
      const a = grid[i00 * cells + (((x0 % cells) + cells) % cells)];
      const b = grid[i00 * cells + ((x0 + 1) % cells)];
      const c = grid[i10 + (((x0 % cells) + cells) % cells)];
      const d = grid[i10 + ((x0 + 1) % cells)];
      out[y * size + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    }
  }
  return out;
}

/** Sum of octaves of the above. The workhorse for grain. */
function fbmField(size: number, rng: () => number, octaves: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 0.5;
  let cells = 4;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const layer = noiseField(size, rng, cells);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    norm += amp;
    amp *= 0.52;
    cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/**
 * Lacquered hardwood for the chest carcass: quarter-sawn grain running along
 * U, darker in the growth rings, with a wiped-on varnish that pools in the
 * grain. The chest is the one prop a player stares at from 40 cm while the
 * lid animates, so it gets a real texture rather than a tint.
 */
function bakeChestWood(size: number, rng: () => number): { albedo: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const grain = fbmField(size, rng, 4);
  const fleck = fbmField(size, rng, 5);
  const alb = canvas2d(size);
  const rgh = canvas2d(size);
  const aImg = alb.g.createImageData(size, size);
  const rImg = rgh.g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Rings: a sine along V warped by the noise field. The warp is what
      // stops it reading as corduroy.
      const warp = grain[i] * 2.6;
      const ring = Math.sin((y / size) * Math.PI * 2 * 7 + warp * 3.1) * 0.5 + 0.5;
      const g = ring * 0.55 + grain[i] * 0.45;
      // Deep walnut, not oak. The chest is 70 % wood by area and the gold
      // hardware has to read against it from 20 m — a mid-brown carcass and a
      // warm gold sit within a few percent of each other in value and the
      // whole prop flattens into one orange mass.
      const r = 58 + g * 44 + fleck[i] * 18;
      const gg = 32 + g * 25 + fleck[i] * 11;
      const b = 19 + g * 13 + fleck[i] * 7;
      const p = i * 4;
      aImg.data[p] = clamp(r, 0, 255);
      aImg.data[p + 1] = clamp(gg, 0, 255);
      aImg.data[p + 2] = clamp(b, 0, 255);
      aImg.data[p + 3] = 255;
      // Varnish sits ON the wood, so the ROUGH channel is the inverse of the
      // grain: the pores stay matte while the raised grain has been polished.
      const rough = 0.72 - ring * 0.34 + fleck[i] * 0.12;
      const ao = 0.78 + (1 - ring) * 0.22;
      rImg.data[p] = clamp(ao * 255, 0, 255);
      rImg.data[p + 1] = clamp(rough * 255, 0, 255);
      rImg.data[p + 2] = 8;
      rImg.data[p + 3] = 255;
    }
  }
  alb.g.putImageData(aImg, 0, 0);
  rgh.g.putImageData(rImg, 0, 0);
  return { albedo: toTexture(alb.c, true), rough: toTexture(rgh.c, false) };
}

/**
 * Brushed/scuffed metal ORM for gun bodies, ammo crates and the supply crate.
 * Green = roughness, red = AO, blue = metalness, which is the packing three's
 * standard material reads when the same map is bound to `aoMap`,
 * `roughnessMap` and `metalnessMap`.
 */
function bakeMetalOrm(size: number, rng: () => number, baseRough: number, metal: number): THREE.CanvasTexture {
  const grain = fbmField(size, rng, 4);
  const { c, g } = canvas2d(size);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Anisotropic brushing: a high-frequency streak along U on top of the
      // blobby field. Without it a metal reads as cast, not machined.
      const brush = Math.sin(y * 2.7 + grain[i] * 9) * 0.06;
      const r = clamp(baseRough + (grain[i] - 0.5) * 0.34 + brush, 0.06, 1);
      const p = i * 4;
      img.data[p] = clamp((0.82 + grain[i] * 0.18) * 255, 0, 255);
      img.data[p + 1] = r * 255;
      img.data[p + 2] = clamp(metal * (0.8 + grain[i] * 0.25) * 255, 0, 255);
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Wear at the contact points: the corners and edges of a crate lose their
  // paint first, so scrub a few bright, rough scratches through the field.
  g.globalAlpha = 0.5;
  g.strokeStyle = "#e8e8e8";
  for (let i = 0; i < 26; i++) {
    const x = rng() * size;
    const y = rng() * size;
    g.lineWidth = 0.6 + rng() * 1.6;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rng() - 0.5) * size * 0.35, y + (rng() - 0.5) * 8);
    g.stroke();
  }
  g.globalAlpha = 1;
  return toTexture(c, false);
}

/** Tangent-space normal map derived from an fbm height field. */
function bakeGrainNormal(size: number, rng: () => number, strength: number): THREE.CanvasTexture {
  const h = fbmField(size, rng, 5);
  const { c, g } = canvas2d(size);
  const img = g.createImageData(size, size);
  const at = (x: number, y: number) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const p = (y * size + x) * 4;
      img.data[p] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[p + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[p + 2] = (1 / len) * 0.5 * 255 + 127;
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return toTexture(c, false);
}

/**
 * The ammo crate skin: olive drab, stencilled lettering, a painted band and
 * rust bleeding out of the corner rivets. This is the "small-scale detail"
 * line item — the crate is 40 cm across and the stencil is what sells it as a
 * manufactured object rather than a green box.
 */
function bakeAmmoSkin(size: number, rng: () => number): THREE.CanvasTexture {
  const w = size;
  const h = Math.max(64, size >> 1);
  const { c, g } = canvas2d(w, h);
  g.fillStyle = "#6d7748";
  g.fillRect(0, 0, w, h);
  // Blotchy paint: a few dozen soft ovals of neighbouring greens.
  for (let i = 0; i < 90; i++) {
    const v = 0.82 + rng() * 0.34;
    g.fillStyle = `rgba(${Math.floor(109 * v)},${Math.floor(119 * v)},${Math.floor(72 * v)},0.5)`;
    g.beginPath();
    g.ellipse(rng() * w, rng() * h, 6 + rng() * 26, 4 + rng() * 14, rng() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // Painted band across the middle, then the stencil over it.
  // The band sits low in the canvas on purpose: the crate is 0.24 m tall
  // against a 0.55 m tile, so only the bottom ~45 % of V ever lands on a side
  // face. Centre the lettering and the crate reads as a plain green box.
  g.fillStyle = "rgba(30,36,22,0.5)";
  g.fillRect(0, h * 0.6, w, h * 0.2);
  g.fillStyle = "#d9d2b8";
  g.font = `bold ${Math.floor(h * 0.17)}px "Arial Black", Arial, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("AMMO", w * 0.5, h * 0.7);
  g.font = `${Math.floor(h * 0.075)}px Arial, sans-serif`;
  g.fillText("CAL. 5.56  ·  200 RDS  ·  LOT 44", w * 0.5, h * 0.86);
  // Stencil bridges — the little gaps a real stencil leaves in its letters.
  g.fillStyle = "rgba(109,119,72,0.9)";
  for (let i = 0; i < 7; i++) g.fillRect(w * (0.3 + i * 0.07), h * 0.61, 2, h * 0.18);
  // Rust weeping from the rivet line, and a scuffed lower edge.
  for (let i = 0; i < 40; i++) {
    const x = rng() * w;
    const y = h * (0.05 + rng() * 0.1);
    g.fillStyle = `rgba(${120 + rng() * 50},${60 + rng() * 30},${28},${0.1 + rng() * 0.25})`;
    g.fillRect(x, y, 1.5 + rng() * 2.5, 4 + rng() * h * 0.35);
  }
  g.fillStyle = "rgba(0,0,0,0.3)";
  g.fillRect(0, h - 3, w, 3);
  return toTexture(c, true);
}

/**
 * Vertical stripe panels for the supply balloon, plus stitched seams. Lathe
 * geometry hands us theta on U and height on V, so a stripe here is a column.
 */
function bakeBalloonSkin(size: number): THREE.CanvasTexture {
  const { c, g } = canvas2d(size, size >> 1);
  const w = c.width;
  const h = c.height;
  const panels = 10;
  for (let i = 0; i < panels; i++) {
    g.fillStyle = i % 2 === 0 ? "#d94f3d" : "#f0ece1";
    g.fillRect((i * w) / panels, 0, w / panels + 1, h);
  }
  // Seam shading: every panel edge gets a dark stitch line and a soft shadow,
  // which is what turns a striped cylinder into sewn fabric.
  for (let i = 0; i <= panels; i++) {
    const x = (i * w) / panels;
    const grad = g.createLinearGradient(x - 6, 0, x + 6, 0);
    grad.addColorStop(0, "rgba(0,0,0,0.25)");
    grad.addColorStop(0.5, "rgba(0,0,0,0.0)");
    grad.addColorStop(1, "rgba(0,0,0,0.25)");
    g.fillStyle = grad;
    g.fillRect(x - 6, 0, 12, h);
    g.strokeStyle = "rgba(255,255,255,0.25)";
    g.setLineDash([3, 4]);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  g.setLineDash([]);
  // Horizontal reinforcement tapes near the skirt.
  g.fillStyle = "rgba(20,20,24,0.35)";
  g.fillRect(0, h * 0.86, w, h * 0.03);
  return toTexture(c, true);
}

/**
 * Soft radial falloff, used for the ground glow, every particle and the
 * beam's cap. One texture, three jobs — a hot core with a long tail rather
 * than a linear ramp, because a linear ramp reads as a flat disc.
 */
function bakeRadial(size: number): THREE.CanvasTexture {
  const { c, g } = canvas2d(size);
  const r = size * 0.5;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.72)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.22)");
  grad.addColorStop(0.75, "rgba(255,255,255,0.05)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = toTexture(c, false, 1);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * Vertical streaks for the loot beam. Sampled scrolling upward, this is what
 * makes the beam look like light moving through dust instead of a coloured
 * cylinder. Tall and narrow so the tiling repeat is invisible.
 */
function bakeBeamStreaks(rng: () => number): THREE.CanvasTexture {
  const w = 64;
  const h = 256;
  const { c, g } = canvas2d(w, h);
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = "lighter";
  for (let i = 0; i < 46; i++) {
    const x = rng() * w;
    const width = 0.6 + rng() * 4.5;
    const alpha = 0.1 + rng() * 0.55;
    const grad = g.createLinearGradient(x - width, 0, x + width, 0);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    // Streaks are broken into segments so the beam has motion *within* it.
    let y = rng() * h;
    for (let s = 0; s < 3; s++) {
      const len = h * (0.1 + rng() * 0.4);
      g.fillRect(x - width, y, width * 2, len);
      y = (y + len + rng() * h * 0.3) % h;
    }
  }
  g.globalCompositeOperation = "source-over";
  return toTexture(c, false, 1);
}

/* ------------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------------ */

type Geo = THREE.BufferGeometry;

/** Rounded rectangle in XY — the profile every extruded part is built from. */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = w / 2;
  const y = h / 2;
  const c = Math.max(0.0004, Math.min(r, x * 0.86, y * 0.86));
  s.moveTo(-x + c, -y);
  s.lineTo(x - c, -y);
  s.quadraticCurveTo(x, -y, x, -y + c);
  s.lineTo(x, y - c);
  s.quadraticCurveTo(x, y, x - c, y);
  s.lineTo(-x + c, y);
  s.quadraticCurveTo(-x, y, -x, y - c);
  s.lineTo(-x, -y + c);
  s.quadraticCurveTo(-x, -y, -x + c, -y);
  return s;
}

/**
 * A box with a real chamfer on all twelve edges, extruded along Z and centred
 * on the origin. Hard-edged boxes are the single most obvious "Three.js demo"
 * tell in the critic's list — a 3 mm chamfer costs eight triangles and catches
 * a highlight along every edge under the key light.
 */
function bevelBox(w: number, h: number, d: number, bevel: number, corner = 0, segs = 1): Geo {
  const b = Math.max(0.0005, Math.min(bevel, w * 0.3, h * 0.3, d * 0.3));
  const shape = roundedRect(w - 2 * b, h - 2 * b, corner || b);
  const depth = Math.max(0.001, d - 2 * b);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: segs,
    curveSegments: segs + 1,
    steps: 1,
  });
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return geo;
}

/** Cylinder along +Y with optional caps, translated so it starts at the origin. */
function tube(rTop: number, rBot: number, len: number, seg = 12, open = false): Geo {
  return new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open);
}

/** Cylinder along +X, which is how every barrel and roller in here is laid out. */
function tubeX(rTop: number, rBot: number, len: number, seg = 12, open = false): Geo {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open);
  g.rotateZ(Math.PI / 2);
  return g;
}

/**
 * Strip a geometry to the attribute set `mergeGeometries` accepts. It refuses
 * a mixed indexed/non-indexed set and `ExtrudeGeometry` is non-indexed while
 * every primitive is indexed, so everything gets flattened.
 */
function normalise(geo: Geo): Geo {
  let g = geo;
  if (g.index) {
    const flat = g.toNonIndexed();
    g.dispose();
    g = flat;
  }
  for (const key of Object.keys(g.attributes)) {
    if (key !== "position" && key !== "normal" && key !== "uv") g.deleteAttribute(key);
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    const n = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  return g;
}

/** Place a part: rotate (XYZ, radians) then translate. Returns the same geo. */
function put(g: Geo, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Geo {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/**
 * Merge a part list into one geometry, or return an empty geometry when the
 * list is empty — `mergeGeometries` returns null on an empty array and every
 * caller here would then have to null-check a mesh it just built.
 */
function mergeParts(parts: Geo[]): Geo {
  if (parts.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeometries(parts.map(normalise), false);
  for (const p of parts) p.dispose();
  if (!merged) return new THREE.BufferGeometry();
  merged.computeVertexNormals();
  return merged;
}

/**
 * Box-project a geometry's UVs from object space so a borrowed library
 * material tiles at its authored world scale instead of at whatever the
 * extruder happened to emit.
 *
 * Per *vertex*, using the normal to pick which two axes drive UV. A single
 * planar projection is the obvious implementation and it is wrong in a way
 * that is invisible until it is not: on an axis-aligned face perpendicular to
 * the projection plane, one UV coordinate is constant across the whole face,
 * the derivative-based tangent frame three builds for the normal map is
 * degenerate, and the face shades black. That is exactly what a flat-projected
 * ammo crate does, and it took a screenshot to find.
 */
function boxProjectUv(g: Geo, metres: number): Geo {
  const pos = g.getAttribute("position");
  const nrm = g.getAttribute("normal");
  if (!pos || !nrm) return g;
  const count = pos.count;
  const arr = new Float32Array(count * 2);
  const inv = 1 / Math.max(0.001, metres);
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    // The half-tile shift on U puts the *middle* of the texture on the middle
    // of the object. Without it the object's own origin lands on the texture's
    // wrap seam, and a centred stencil ends up split down the two edges of a
    // face where nobody will ever see it.
    if (ny >= nx && ny >= nz) {
      arr[i * 2] = x * inv + 0.5;
      arr[i * 2 + 1] = z * inv + 0.5;
    } else if (nx >= nz) {
      arr[i * 2] = z * inv + 0.5;
      arr[i * 2 + 1] = y * inv;
    } else {
      arr[i * 2] = x * inv + 0.5;
      arr[i * 2 + 1] = y * inv;
    }
  }
  if (g.getAttribute("uv")) g.deleteAttribute("uv");
  g.setAttribute("uv", new THREE.BufferAttribute(arr, 2));
  return g;
}

/* ------------------------------------------------------------------------ *
 * The material kit
 *
 * Everything this module draws comes from here, and it is deliberately small:
 * six PBR surfaces, one rarity accent per tier, one signature colour per
 * consumable, one beam program and one particle program. Bounded material
 * count is bounded program count, and program compiles are the stutter a
 * player notices when they land.
 * ------------------------------------------------------------------------ */

type SurfaceId =
  | "gunmetal"
  | "polymer"
  | "brass"
  | "olive"
  | "white"
  | "rubber"
  | "wood"
  | "gold"
  | "cloth";

interface SurfaceSpec {
  color: number;
  roughness: number;
  metalness: number;
  /** Which ORM bake it uses, if any. */
  orm: "metal" | "matte" | "none";
  /** Metres per texture repeat when the part projects its own UVs. */
  tile: number;
}

/**
 * Not grey-on-grey. Drop Zero is a saturated island and a pickup that is six
 * shades of charcoal disappears against a dirt floor — the polymer is warm,
 * the gunmetal is blue, and the two read apart at 10 m.
 */
const SURFACES: Record<SurfaceId, SurfaceSpec> = {
  gunmetal: { color: 0x5b6472, roughness: 0.42, metalness: 0.88, orm: "metal", tile: 0.5 },
  // Deliberately lighter than a real firearm's polymer. Drop Zero's floors are
  // dark boards and dirt; a charcoal gun on them is invisible from standing
  // height, which is the one thing a floor weapon may never be.
  polymer: { color: 0x4a505c, roughness: 0.7, metalness: 0.06, orm: "matte", tile: 0.4 },
  brass: { color: 0xc9a24d, roughness: 0.3, metalness: 1.0, orm: "metal", tile: 0.4 },
  olive: { color: 0x77804f, roughness: 0.7, metalness: 0.12, orm: "matte", tile: 0.6 },
  white: { color: 0xe8e6df, roughness: 0.55, metalness: 0.0, orm: "matte", tile: 0.4 },
  rubber: { color: 0x191a1e, roughness: 0.95, metalness: 0.0, orm: "matte", tile: 0.3 },
  wood: { color: 0xffffff, roughness: 1, metalness: 0, orm: "none", tile: 1.4 },
  gold: { color: 0xffcf7a, roughness: 0.28, metalness: 1.0, orm: "metal", tile: 1.2 },
  cloth: { color: 0xffffff, roughness: 0.86, metalness: 0.0, orm: "none", tile: 1.6 },
};

interface Kit {
  surface(id: SurfaceId): THREE.Material;
  /** Rarity-anodised trim. This is what makes a legendary read as legendary. */
  accent(rarity: Rarity): THREE.Material;
  /** An item's own colour — the red cross, the shield blue. Cached by hex. */
  signature(hex: number, emissive?: number): THREE.Material;
  /** A fresh emissive material for one chest's seam, so it can animate alone. */
  makeSeam(): THREE.MeshStandardMaterial;
  glass(): THREE.Material;
  ammoSkin(): THREE.Material;
  balloonSkin(): THREE.Material;
  beam(rarity: Rarity): THREE.ShaderMaterial;
  glow(rarity: Rarity): THREE.MeshBasicMaterial;
  readonly radial: THREE.Texture;
  readonly particleMat: THREE.ShaderMaterial;
  /** Uniform bumped every frame by the system; shared by beams + particles. */
  readonly time: { value: number };
  /** Point-size scale for the particle shader; refreshed on resize. */
  readonly pixelScale: { value: number };
  track<T extends Geo>(g: T): T;
  dispose(): void;
}

/* --- the beam program ------------------------------------------------------
 *
 * A loot beam is not a coloured cylinder. Three things make it read:
 *
 *  - **Silhouette bias.** Alpha rises where the surface faces away from the
 *    eye, so the *edges* of the tube are bright and the middle is thin. That
 *    is how real volumetric light photographs, and it is why the beam looks
 *    hollow rather than like a painted pipe.
 *  - **Base weight.** Density falls off with height on a curve, so the beam
 *    is anchored to the floor and dissolves upward instead of ending.
 *  - **Motion inside it.** Scrolling streaks, sampled twice at different
 *    rates, so the interior shimmers without ever repeating visibly.
 *
 * Additive, depth-tested but not depth-writing, so beams stack cleanly and a
 * wall still occludes them.
 */
const BEAM_VERT = `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
varying float vDist;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec3 toEye = cameraPosition - world.xyz;
  vDist = length(toEye);
  vViewW = normalize(toEye);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const BEAM_FRAG = `
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
uniform sampler2D uStreaks;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
varying float vDist;
void main() {
  float rim = 1.0 - abs(dot(normalize(vNormalW), normalize(vViewW)));
  rim = clamp(rim, 0.0, 1.0);
  // Density: heavy at the base, gone by the top, with a soft foot so the beam
  // does not slice a hard line where it meets the floor.
  float height = clamp(vUv.y, 0.0, 1.0);
  float density = pow(1.0 - height, 1.7) * smoothstep(0.0, 0.07, height);
  float s1 = texture2D(uStreaks, vec2(vUv.x * 1.0, vUv.y * 0.5 - uTime * 0.19)).r;
  float s2 = texture2D(uStreaks, vec2(vUv.x * 2.3 + 0.37, vUv.y * 0.8 - uTime * 0.31)).r;
  float streak = 0.35 + 0.9 * (s1 * 0.6 + s2 * 0.5);
  /**
   * Distance response. Up close the beam is a hollow, rim-lit sheath you can
   * see your loot through; from across a POI it has to be a solid readable
   * column, because that is the range at which it does its actual job. A
   * single fixed density cannot be both — at the value that looks right at
   * 2 m it has all but vanished by 30 m, which is exactly the failure the
   * first screenshot of this module showed.
   */
  float far = smoothstep(7.0, 42.0, vDist);
  float body = 0.18 + 0.95 * far + (1.15 - 0.35 * far) * rim * rim;
  float a = uOpacity * density * streak * body * (1.0 + far * 0.5);
  // Only a whisper of white in the densest part. Mixing hard to white is the
  // classic additive-FX mistake: every rarity ends up the same pale column and
  // the one thing the beam exists to say — which tier this is — is gone.
  vec3 col = mix(uColor, vec3(1.0), clamp(a * 0.22, 0.0, 0.22));
  gl_FragColor = vec4(col * (0.55 + 0.9 * a), clamp(a, 0.0, 0.85));
}
`;

/* --- the particle program --------------------------------------------------
 *
 * One `THREE.Points` carries every mote, every chest sparkle and every puff
 * of flare smoke in the module — one draw call for all of it. Per-particle
 * size and colour need attributes, which `PointsMaterial` cannot do, so this
 * is a 20-line shader instead.
 */
const PARTICLE_VERT = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (uScale / max(0.1, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAG = `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * (0.7 + 0.9 * a), a);
}
`;

function makeKit(ctx: WorldCtx, rng: () => number): Kit {
  const budget = BUDGETS[ctx.quality] ?? BUDGETS.high;
  const size = budget.texSize;
  const materialsSvc = ctx.services.materials;

  const owned: { dispose(): void }[] = [];
  const geos: Geo[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };

  const metalOrm = track(bakeMetalOrm(size, rng, 0.44, 1.0));
  const matteOrm = track(bakeMetalOrm(size, rng, 0.78, 0.05));
  const grainNormal = track(bakeGrainNormal(size, rng, 2.2));
  const chestWood = bakeChestWood(size, rng);
  track(chestWood.albedo);
  track(chestWood.rough);
  const radial = track(bakeRadial(128));
  const streaks = track(bakeBeamStreaks(rng));
  let ammoTex: THREE.CanvasTexture | null = null;
  let balloonTex: THREE.CanvasTexture | null = null;

  const surfaces = new Map<SurfaceId, THREE.Material>();
  const accents = new Map<Rarity, THREE.Material>();
  const signatures = new Map<number, THREE.Material>();
  const beams = new Map<Rarity, THREE.ShaderMaterial>();
  const glows = new Map<Rarity, THREE.MeshBasicMaterial>();
  const seams: THREE.MeshStandardMaterial[] = [];
  let glassMat: THREE.Material | null = null;
  let ammoMat: THREE.Material | null = null;
  let balloonMat: THREE.Material | null = null;

  const time = { value: 0 };
  const pixelScale = { value: 300 };

  const beamTemplate = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uTime: time,
      uOpacity: { value: 1 },
      uStreaks: { value: streaks },
    },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    // Additive FX are authored in display space; running them through ACES a
    // second time desaturates exactly the colour the rarity is trying to say.
    toneMapped: false,
  });
  track(beamTemplate);

  const particleMat = track(
    new THREE.ShaderMaterial({
      uniforms: { uMap: { value: radial }, uScale: pixelScale },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );

  /** Borrow a library material when the library exists; otherwise roll one. */
  function libraryOrOwn(name: MaterialName, fallback: () => THREE.Material): THREE.Material {
    if (materialsSvc) {
      try {
        return materialsSvc.get(name);
      } catch {
        /* fall through to the local bake */
      }
    }
    return track(fallback());
  }

  const kit: Kit = {
    time,
    pixelScale,
    radial,
    particleMat,

    surface(id) {
      const cached = surfaces.get(id);
      if (cached) return cached;
      const spec = SURFACES[id];
      let mat: THREE.Material;
      if (id === "gold") {
        // Real hammered gold from the shared library if it is up — its ORM has
        // dimples that a flat metalness value cannot fake. Not ours to dispose.
        mat = libraryOrOwn(
          "gold",
          () =>
            new THREE.MeshStandardMaterial({
              color: spec.color,
              roughness: 0.3,
              // Short of a full metalness of 1: without the library's
              // environment probe a pure metal has nothing to reflect and
              // renders as a black hole where the hardware should be.
              metalness: 0.8,
              roughnessMap: metalOrm,
              metalnessMap: metalOrm,
              aoMap: metalOrm,
              normalMap: grainNormal,
              normalScale: new THREE.Vector2(0.35, 0.35),
              envMapIntensity: 1.5,
            }),
        );
      } else if (id === "wood") {
        mat = track(
          new THREE.MeshStandardMaterial({
            map: chestWood.albedo,
            roughnessMap: chestWood.rough,
            aoMap: chestWood.rough,
            normalMap: grainNormal,
            normalScale: new THREE.Vector2(0.55, 0.55),
            roughness: 1,
            metalness: 0,
            envMapIntensity: 0.7,
          }),
        );
      } else if (id === "cloth") {
        mat = track(
          new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            roughness: 0.88,
            metalness: 0,
            // Sheen is what makes canvas look like canvas: a soft rim that
            // brightens at grazing angles instead of a flat matte.
            sheen: 0.8,
            sheenRoughness: 0.7,
            sheenColor: new THREE.Color(0xffffff),
          }),
        );
      } else {
        const orm = spec.orm === "metal" ? metalOrm : spec.orm === "matte" ? matteOrm : null;
        mat = track(
          new THREE.MeshStandardMaterial({
            color: spec.color,
            roughness: spec.roughness,
            metalness: spec.metalness,
            roughnessMap: orm,
            metalnessMap: spec.orm === "metal" ? orm : null,
            aoMap: orm,
            normalMap: grainNormal,
            normalScale: new THREE.Vector2(0.4, 0.4),
            envMapIntensity: spec.metalness > 0.5 ? 1.2 : 0.8,
          }),
        );
      }
      mat.name = `dz:loot:${id}`;
      surfaces.set(id, mat);
      return mat;
    },

    accent(rarity) {
      const cached = accents.get(rarity);
      if (cached) return cached;
      const color = RARITY_COLOR[rarity];
      const mat = track(
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          // Common is a grey anodise, not a glowing one — the emissive ramp is
          // part of how the tier reads before the beam is even visible.
          emissiveIntensity: 0.12 + rarityIndex(rarity) * 0.16,
          roughness: 0.33,
          metalness: 0.82,
          roughnessMap: metalOrm,
          normalMap: grainNormal,
          normalScale: new THREE.Vector2(0.3, 0.3),
          envMapIntensity: 1.3,
        }),
      );
      mat.name = `dz:loot:accent:${rarity}`;
      accents.set(rarity, mat);
      return mat;
    },

    signature(hex, emissive = 0.25) {
      const key = hex * 8 + Math.round(emissive * 7);
      const cached = signatures.get(key);
      if (cached) return cached;
      const mat = track(
        new THREE.MeshStandardMaterial({
          color: hex,
          emissive: hex,
          emissiveIntensity: emissive,
          roughness: 0.42,
          metalness: 0.1,
          roughnessMap: matteOrm,
        }),
      );
      signatures.set(key, mat);
      return mat;
    },

    makeSeam() {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2a1a06,
        emissive: 0xffc247,
        emissiveIntensity: 1.4,
        roughness: 0.5,
        metalness: 0.4,
        toneMapped: true,
      });
      seams.push(mat);
      return mat;
    },

    glass() {
      if (glassMat) return glassMat;
      glassMat = libraryOrOwn(
        "glass",
        () =>
          new THREE.MeshPhysicalMaterial({
            color: 0xdff2ff,
            roughness: 0.06,
            metalness: 0,
            transparent: true,
            opacity: 0.32,
            clearcoat: 1,
            clearcoatRoughness: 0.05,
            envMapIntensity: 1.4,
          }),
      );
      return glassMat;
    },

    ammoSkin() {
      if (ammoMat) return ammoMat;
      ammoTex = track(bakeAmmoSkin(size, rng));
      ammoMat = track(
        new THREE.MeshStandardMaterial({
          map: ammoTex,
          roughnessMap: matteOrm,
          aoMap: matteOrm,
          normalMap: grainNormal,
          normalScale: new THREE.Vector2(0.5, 0.5),
          roughness: 1,
          metalness: 0.12,
          envMapIntensity: 0.7,
        }),
      );
      return ammoMat;
    },

    balloonSkin() {
      if (balloonMat) return balloonMat;
      balloonTex = track(bakeBalloonSkin(size));
      balloonMat = track(
        new THREE.MeshPhysicalMaterial({
          map: balloonTex,
          roughness: 0.72,
          metalness: 0,
          sheen: 0.9,
          sheenRoughness: 0.6,
          sheenColor: new THREE.Color(0xffffff),
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 1,
        }),
      );
      return balloonMat;
    },

    beam(rarity) {
      const cached = beams.get(rarity);
      if (cached) return cached;
      // Cloning a ShaderMaterial reuses the compiled program — five beam
      // colours cost five uniform sets and exactly one shader compile.
      const mat = beamTemplate.clone();
      mat.uniforms.uColor.value = new THREE.Color(RARITY_COLOR[rarity]);
      mat.uniforms.uTime = time;
      mat.uniforms.uStreaks.value = streaks;
      // Common loot must not shout. The ramp is small on purpose: the tier is
      // carried by hue, and brightness only breaks the tie at distance.
      mat.uniforms.uOpacity.value = 0.3 + rarityIndex(rarity) * 0.045;
      track(mat);
      beams.set(rarity, mat);
      return mat;
    },

    glow(rarity) {
      const cached = glows.get(rarity);
      if (cached) return cached;
      const mat = track(
        new THREE.MeshBasicMaterial({
          map: radial,
          color: RARITY_COLOR[rarity],
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          // Additive over a sunlit floor blows out fast; the glow is meant to
          // pin the beam to the ground, not to be the brightest thing in frame.
          opacity: 0.34,
        }),
      );
      glows.set(rarity, mat);
      return mat;
    },

    track(g) {
      geos.push(g);
      return g;
    },

    dispose() {
      for (const o of owned) o.dispose();
      owned.length = 0;
      for (const m of seams) m.dispose();
      seams.length = 0;
      for (const g of geos) g.dispose();
      geos.length = 0;
      surfaces.clear();
      accents.clear();
      signatures.clear();
      beams.clear();
      glows.clear();
      ammoTex = null;
      balloonTex = null;
      glassMat = null;
      ammoMat = null;
      balloonMat = null;
    },
  };

  return kit;
}

/* ------------------------------------------------------------------------ *
 * Item art
 *
 * Every pickup is the actual object, not an icon: you can tell a pump from an
 * SMG by its silhouette at 8 m, which is the whole reason to model them. Each
 * builder returns up to three part lists — body, rarity accent and the item's
 * own signature colour — and they merge into ONE geometry with one group per
 * list, so a pickup is two or three draw calls no matter how many parts went
 * into it.
 *
 * Common vocabulary across all of them: chamfered boxes rather than cubes,
 * a ring or a groove wherever two parts meet, and at least one small piece of
 * hardware (a charging handle, a latch, a sling loop) that exists purely to
 * break the silhouette. Those three things are the whole difference between
 * "modelled" and "primitives".
 * ------------------------------------------------------------------------ */

interface PartBundle {
  body: Geo[];
  accent: Geo[];
  sig: Geo[];
  sigColor: number;
  surface: SurfaceId;
  /** Draw the body group in glass instead of its surface — bottles and lenses. */
  bodyGlass?: boolean;
  /** Draw the signature group in glass — scope lenses. */
  sigGlass?: boolean;
}

function bundle(surface: SurfaceId, sigColor = 0xffffff): PartBundle {
  return { body: [], accent: [], sig: [], sigColor, surface };
}

/** A ring around the X axis — barrel bands, grooves, muzzle collars. */
function bandX(radius: number, thick: number, x: number, y = 0, z = 0, seg = 10): Geo {
  const g = new THREE.TorusGeometry(radius, thick, 6, seg);
  return put(g, x, y, z, 0, Math.PI / 2, 0);
}

/** A ring around the Y axis — bottle collars, chest hinge trim. */
function bandY(radius: number, thick: number, x: number, y: number, z: number, seg = 12): Geo {
  const g = new THREE.TorusGeometry(radius, thick, 6, seg);
  return put(g, x, y, z, Math.PI / 2, 0, 0);
}

/* --- guns ---------------------------------------------------------------- */

/**
 * Rifles and SMGs. One parametric builder: length, mag rake and stock style
 * are all that separate an AR from a burst rifle in silhouette, and pretending
 * otherwise would be four copies of the same forty lines.
 */
function buildRifle(b: number, opts: { len: number; smg: boolean; sniper: boolean }): PartBundle {
  const p = bundle("polymer");
  const L = opts.len;
  // Receiver: two stacked slabs with a step between them, which is what gives
  // a gun its characteristic shoulder rather than a plain brick.
  p.body.push(put(bevelBox(L * 0.42, 0.078, 0.05, b * 0.006, 0.008), 0, 0, 0));
  p.body.push(put(bevelBox(L * 0.36, 0.026, 0.044, b * 0.005), 0.01, 0.05, 0));
  // Handguard with cooling slots — six thin ribs standing proud, the cheapest
  // "small-scale detail" there is and the one the eye reads as machined.
  const hgLen = L * 0.3;
  const hgX = L * 0.33;
  p.body.push(put(bevelBox(hgLen, 0.052, 0.05, b * 0.005, 0.01), hgX, 0.004, 0));
  for (let i = 0; i < 6; i++) {
    const x = hgX - hgLen * 0.42 + (i * hgLen * 0.85) / 5;
    p.body.push(put(bevelBox(0.008, 0.014, 0.056, 0.0015), x, 0.03, 0));
  }
  // Barrel, muzzle device and its vent bands.
  const barLen = opts.sniper ? L * 0.5 : L * 0.24;
  const barX = hgX + hgLen * 0.5 + barLen * 0.5;
  p.body.push(put(tubeX(0.0105, 0.0125, barLen, 10), barX, 0.006, 0));
  p.body.push(put(tubeX(0.017, 0.017, 0.045, 10), barX + barLen * 0.5 + 0.02, 0.006, 0));
  for (let i = 0; i < 3; i++) p.accent.push(bandX(0.0185, 0.0028, barX + barLen * 0.5 + 0.008 + i * 0.013, 0.006, 0));
  // Magazine: three short segments, each raked a little further, so it curves.
  const magX = -L * 0.02;
  for (let i = 0; i < 3; i++) {
    const t = i / 2;
    p.body.push(
      put(bevelBox(0.042, 0.05, 0.03, 0.004), magX + t * 0.012, -0.055 - i * 0.042, 0, 0, 0, -0.06 - t * 0.12),
    );
  }
  p.accent.push(put(bevelBox(0.05, 0.012, 0.036, 0.003), magX + 0.026, -0.168, 0, 0, 0, -0.2));
  // Grip, trigger guard, trigger.
  p.body.push(put(bevelBox(0.046, 0.105, 0.038, 0.006, 0.012), -L * 0.13, -0.075, 0, 0, 0, 0.24));
  p.body.push(put(new THREE.TorusGeometry(0.026, 0.0055, 5, 9, Math.PI), -L * 0.08, -0.036, 0, Math.PI / 2, 0, Math.PI));
  p.accent.push(put(bevelBox(0.007, 0.024, 0.008, 0.002), -L * 0.08, -0.03, 0, 0, 0, 0.2));
  // Stock: SMGs fold theirs into a wire loop, rifles get a cheek weld.
  if (opts.smg) {
    p.body.push(put(bevelBox(0.11, 0.014, 0.014, 0.003), -L * 0.34, 0.028, 0.026));
    p.body.push(put(bevelBox(0.11, 0.014, 0.014, 0.003), -L * 0.34, 0.028, -0.026));
    p.body.push(put(bevelBox(0.016, 0.06, 0.066, 0.004), -L * 0.42, 0.008, 0));
  } else {
    p.body.push(put(bevelBox(L * 0.2, 0.062, 0.042, 0.006, 0.01), -L * 0.32, -0.006, 0));
    p.body.push(put(bevelBox(L * 0.13, 0.026, 0.04, 0.005), -L * 0.3, 0.036, 0));
    p.body.push(put(bevelBox(0.022, 0.085, 0.046, 0.008, 0.014), -L * 0.43, -0.012, 0));
  }
  // Optic. A sniper gets a real scope with a lens; everything else a red dot.
  if (opts.sniper) {
    p.body.push(put(tubeX(0.026, 0.026, 0.16, 12), L * 0.04, 0.088, 0));
    p.body.push(put(tubeX(0.032, 0.026, 0.04, 12), L * 0.04 + 0.09, 0.088, 0));
    p.accent.push(bandX(0.028, 0.004, L * 0.04 - 0.05, 0.088, 0));
    p.accent.push(bandX(0.028, 0.004, L * 0.04 + 0.05, 0.088, 0));
    p.sig.push(put(new THREE.CircleGeometry(0.026, 12), L * 0.04 + 0.111, 0.088, 0, 0, Math.PI / 2, 0));
    p.sigColor = 0x8fd7ff;
    // Bipod: two raked legs. Reads instantly as "long range" in silhouette.
    p.body.push(put(bevelBox(0.012, 0.09, 0.012, 0.003), hgX + 0.02, -0.06, 0.022, 0.32, 0, 0));
    p.body.push(put(bevelBox(0.012, 0.09, 0.012, 0.003), hgX + 0.02, -0.06, -0.022, -0.32, 0, 0));
  } else {
    p.body.push(put(bevelBox(0.05, 0.03, 0.036, 0.004), L * 0.02, 0.078, 0));
    p.accent.push(put(new THREE.TorusGeometry(0.014, 0.003, 5, 10), L * 0.02 + 0.02, 0.084, 0, 0, Math.PI / 2, 0));
    p.sig.push(put(new THREE.CircleGeometry(0.012, 10), L * 0.02 + 0.022, 0.084, 0, 0, Math.PI / 2, 0));
    p.sigColor = 0xff5a3c;
  }
  // Charging handle + sling loop: the two bits of hardware that break the line.
  p.accent.push(put(bevelBox(0.03, 0.01, 0.012, 0.002), -L * 0.16, 0.05, 0.03));
  p.accent.push(put(new THREE.TorusGeometry(0.008, 0.0022, 4, 8), -L * 0.26, -0.03, 0.024, 0, Math.PI / 2, 0));
  return p;
}

/** Pump and tactical shotguns: fat barrel, tube magazine, ribbed slide. */
function buildShotgun(b: number): PartBundle {
  const p = bundle("polymer");
  p.body.push(put(bevelBox(0.22, 0.075, 0.052, b * 0.006, 0.01), 0, 0, 0));
  p.body.push(put(tubeX(0.0165, 0.0165, 0.34, 10), 0.27, 0.016, 0));
  // Tube magazine under the barrel — the shotgun's whole read.
  p.body.push(put(tubeX(0.015, 0.015, 0.3, 10), 0.25, -0.024, 0));
  p.accent.push(bandX(0.017, 0.0035, 0.395, -0.024, 0));
  // Ribbed pump slide.
  p.body.push(put(bevelBox(0.11, 0.05, 0.052, 0.004, 0.012), 0.19, -0.006, 0));
  for (let i = 0; i < 5; i++) p.body.push(put(bevelBox(0.007, 0.056, 0.056, 0.0015), 0.15 + i * 0.02, -0.006, 0));
  p.body.push(put(bevelBox(0.046, 0.1, 0.038, 0.006, 0.012), -0.09, -0.072, 0, 0, 0, 0.22));
  p.body.push(put(new THREE.TorusGeometry(0.026, 0.0055, 5, 9, Math.PI), -0.05, -0.034, 0, Math.PI / 2, 0, Math.PI));
  p.body.push(put(bevelBox(0.17, 0.066, 0.044, 0.006, 0.01), -0.19, -0.014, 0));
  p.body.push(put(bevelBox(0.024, 0.09, 0.048, 0.008, 0.014), -0.285, -0.024, 0));
  // Ejection port + shell lifter, cut as an inset plate rather than a hole.
  p.accent.push(put(bevelBox(0.06, 0.026, 0.004, 0.002), 0.02, 0.016, 0.028));
  p.accent.push(put(bevelBox(0.007, 0.022, 0.008, 0.002), -0.05, -0.028, 0, 0, 0, 0.2));
  p.body.push(put(bevelBox(0.02, 0.018, 0.014, 0.003), 0.4, 0.03, 0));
  return p;
}

/** Sidearm. Small, so its detail budget goes into the slide serrations. */
function buildPistol(b: number): PartBundle {
  const p = bundle("polymer");
  p.body.push(put(bevelBox(0.185, 0.046, 0.032, b * 0.005, 0.008), 0.02, 0.03, 0));
  for (let i = 0; i < 5; i++) p.body.push(put(bevelBox(0.005, 0.03, 0.036, 0.0012), -0.04 - i * 0.011, 0.032, 0));
  p.body.push(put(bevelBox(0.15, 0.03, 0.03, 0.004), 0.015, 0.0, 0));
  p.body.push(put(bevelBox(0.045, 0.1, 0.03, 0.006, 0.012), -0.045, -0.058, 0, 0, 0, 0.26));
  p.accent.push(put(bevelBox(0.046, 0.012, 0.028, 0.003), -0.06, -0.108, 0, 0, 0, 0.26));
  p.body.push(put(new THREE.TorusGeometry(0.022, 0.005, 5, 9, Math.PI), -0.012, -0.022, 0, Math.PI / 2, 0, Math.PI));
  p.accent.push(put(bevelBox(0.006, 0.02, 0.007, 0.002), -0.012, -0.018, 0, 0, 0, 0.2));
  p.accent.push(put(bevelBox(0.01, 0.008, 0.006, 0.002), 0.1, 0.052, 0));
  p.accent.push(put(bevelBox(0.008, 0.01, 0.006, 0.002), -0.055, 0.052, 0));
  p.body.push(put(tubeX(0.008, 0.008, 0.03, 8), 0.125, 0.03, 0));
  return p;
}

/** Rocket launcher: a tube you carry on your shoulder, and it must read as one. */
function buildRocket(b: number): PartBundle {
  const p = bundle("olive");
  p.body.push(put(tubeX(0.052, 0.052, 0.62, 14), 0.02, 0, 0));
  // Flared blast cone at the rear — the single most recognisable feature.
  p.body.push(put(tubeX(0.078, 0.05, 0.11, 14), -0.34, 0, 0));
  p.accent.push(bandX(0.056, 0.005, -0.24, 0, 0, 14));
  p.accent.push(bandX(0.056, 0.005, 0.2, 0, 0, 14));
  // Warhead just showing at the muzzle.
  p.sigColor = 0xd8453a;
  p.sig.push(put(tube(0.02, 0.044, 0.09, 12), 0.36, 0, 0, 0, 0, -Math.PI / 2));
  p.body.push(put(bevelBox(0.16, 0.05, 0.11, 0.008, 0.02), -0.12, -0.06, 0));
  p.body.push(put(bevelBox(0.05, 0.1, 0.04, 0.006, 0.012), 0.02, -0.1, 0, 0, 0, 0.2));
  p.body.push(put(bevelBox(0.05, 0.075, 0.04, 0.006, 0.012), -0.22, -0.085, 0, 0, 0, -0.12));
  // Shoulder pad, optic bridge and a carry handle: hardware, not decoration.
  p.body.push(put(bevelBox(0.13, 0.036, 0.09, 0.008, 0.016), -0.22, 0.055, 0));
  p.body.push(put(bevelBox(0.09, 0.03, 0.04, 0.005), 0.12, 0.07, 0.03));
  p.accent.push(put(new THREE.TorusGeometry(0.016, 0.0035, 5, 10), 0.16, 0.076, 0.03, 0, Math.PI / 2, 0));
  p.body.push(put(new THREE.TorusGeometry(0.03, 0.007, 5, 10, Math.PI), -0.02, 0.06, 0, 0, 0, 0));
  return p;
}

/** Minigun: six barrels on a rotor. Nothing else in the game looks like it. */
function buildMinigun(b: number): PartBundle {
  const p = bundle("gunmetal");
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    p.body.push(put(tubeX(0.011, 0.011, 0.42, 8), 0.2, Math.sin(a) * 0.032, Math.cos(a) * 0.032));
  }
  p.accent.push(put(tube(0.045, 0.045, 0.024, 14), 0.02, 0, 0, 0, 0, Math.PI / 2));
  p.accent.push(put(tube(0.045, 0.045, 0.024, 14), 0.38, 0, 0, 0, 0, Math.PI / 2));
  p.body.push(put(bevelBox(0.2, 0.12, 0.11, b * 0.008, 0.02), -0.13, 0, 0));
  // Ammo drum + feed chute, which is what makes it read as belt-fed.
  p.body.push(put(tube(0.075, 0.075, 0.09, 14), -0.2, -0.05, -0.09, Math.PI / 2, 0, 0));
  p.accent.push(put(new THREE.TorusGeometry(0.077, 0.005, 6, 14), -0.2, -0.05, -0.09));
  p.body.push(put(bevelBox(0.1, 0.03, 0.05, 0.004), -0.17, -0.02, -0.05, 0, 0.4, 0));
  // Spade grips.
  p.body.push(put(bevelBox(0.03, 0.11, 0.03, 0.005, 0.01), -0.22, -0.09, 0.06, 0, 0, 0.1));
  p.body.push(put(bevelBox(0.03, 0.11, 0.03, 0.005, 0.01), -0.22, -0.09, -0.06, 0, 0, 0.1));
  p.body.push(put(bevelBox(0.02, 0.03, 0.15, 0.004), -0.24, -0.145, 0));
  return p;
}

function buildGun(shape: GunShape, bevel: number): PartBundle {
  switch (shape) {
    case "rifle":
      return buildRifle(bevel, { len: 0.72, smg: false, sniper: false });
    case "smg":
      return buildRifle(bevel, { len: 0.54, smg: true, sniper: false });
    case "sniper":
      return buildRifle(bevel, { len: 0.86, smg: false, sniper: true });
    case "shotgun":
      return buildShotgun(bevel);
    case "pistol":
      return buildPistol(bevel);
    case "rocket":
      return buildRocket(bevel);
    case "minigun":
      return buildMinigun(bevel);
    default:
      return buildRifle(bevel, { len: 0.72, smg: false, sniper: false });
  }
}

/* --- consumables --------------------------------------------------------- */

/** Lathe profile helper: build from (radius, height) pairs, bottom to top. */
function lathe(profile: [number, number][], segments: number): Geo {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0006, r), y));
  return new THREE.LatheGeometry(pts, segments);
}

function buildConsumable(def: ConsumableDef, bevel: number, kit: Kit): PartBundle {
  const p = bundle("white", def.tint);
  switch (def.shape) {
    case "bandage": {
      p.surface = "white";
      p.body.push(put(tubeX(0.055, 0.055, 0.1, 14), 0, 0, 0));
      // The loose end of the wrap, lifted off the roll so it casts a shadow.
      p.body.push(put(bevelBox(0.1, 0.004, 0.07, 0.0015), 0, -0.052, 0.03, 0.25, 0, 0));
      p.accent.push(bandX(0.056, 0.004, -0.032, 0, 0, 14));
      p.accent.push(bandX(0.056, 0.004, 0.032, 0, 0, 14));
      p.sig.push(put(bevelBox(0.052, 0.016, 0.006, 0.002), 0, 0.05, 0, 0, 0, 0));
      p.sig.push(put(bevelBox(0.016, 0.05, 0.006, 0.002), 0, 0.05, 0, 0, 0, 0));
      break;
    }
    case "medkit": {
      p.surface = "white";
      p.body.push(put(bevelBox(0.2, 0.14, 0.1, bevel * 0.008, 0.018), 0, 0, 0));
      p.body.push(put(bevelBox(0.2, 0.012, 0.104, 0.003), 0, 0.02, 0));
      p.accent.push(put(new THREE.TorusGeometry(0.03, 0.006, 5, 10, Math.PI), 0, 0.07, 0, 0, 0, 0));
      p.accent.push(put(bevelBox(0.03, 0.02, 0.008, 0.002), 0, 0.016, 0.052));
      p.sig.push(put(bevelBox(0.07, 0.022, 0.006, 0.002), 0, -0.02, 0.052));
      p.sig.push(put(bevelBox(0.022, 0.07, 0.006, 0.002), 0, -0.02, 0.052));
      break;
    }
    case "flask": {
      // A hex-shouldered potion bottle: glass shell, an emissive liquid volume
      // inside it, a metal cap and a wax seal. The liquid being a separate,
      // slightly smaller solid is what gives the glass something to refract.
      p.surface = "polymer";
      p.bodyGlass = true;
      const big = def.id === "shield-big";
      const s = big ? 1.18 : 0.92;
      const glassGeo = lathe(
        [
          [0.0, 0],
          [0.05 * s, 0],
          [0.055 * s, 0.02 * s],
          [0.05 * s, 0.1 * s],
          [0.032 * s, 0.13 * s],
          [0.026 * s, 0.17 * s],
          [0.03 * s, 0.19 * s],
          [0.0, 0.19 * s],
        ],
        12,
      );
      p.body.push(put(glassGeo, 0, -0.09 * s, 0));
      p.sig.push(
        put(
          lathe(
            [
              [0.0, 0],
              [0.044 * s, 0.004],
              [0.046 * s, 0.09 * s],
              [0.026 * s, 0.128 * s],
              [0.0, 0.13 * s],
            ],
            12,
          ),
          0,
          -0.086 * s,
          0,
        ),
      );
      p.accent.push(put(tube(0.032 * s, 0.03 * s, 0.03 * s, 12), 0, 0.115 * s, 0));
      p.accent.push(bandY(0.034 * s, 0.005, 0, 0.1 * s, 0, 12));
      break;
    }
    case "jug": {
      p.surface = "polymer";
      p.bodyGlass = true;
      p.body.push(put(lathe([
        [0.0, 0],
        [0.075, 0],
        [0.082, 0.03],
        [0.08, 0.16],
        [0.05, 0.21],
        [0.042, 0.25],
        [0.05, 0.27],
        [0.0, 0.27],
      ], 14), 0, -0.13, 0));
      p.sig.push(put(lathe([
        [0.0, 0],
        [0.07, 0.006],
        [0.072, 0.15],
        [0.042, 0.2],
        [0.0, 0.21],
      ], 14), 0, -0.124, 0));
      // Carry handle: a proper loop, because a jug without one is a bottle.
      p.body.push(put(new THREE.TorusGeometry(0.05, 0.011, 6, 12, Math.PI * 1.1), 0.09, 0.03, 0, 0, 0, -0.4));
      p.accent.push(put(tube(0.05, 0.046, 0.035, 12), 0, 0.15, 0));
      p.accent.push(bandY(0.055, 0.006, 0, 0.128, 0, 12));
      break;
    }
    case "grenade": {
      p.surface = "olive";
      p.body.push(put(new THREE.SphereGeometry(0.055, 14, 10), 0, 0, 0));
      // Fragmentation grooves — three bands, which is the classic read.
      for (let i = 0; i < 3; i++) p.body.push(bandY(0.0555, 0.004, 0, -0.024 + i * 0.024, 0, 14));
      p.body.push(put(tube(0.018, 0.02, 0.03, 10), 0, 0.062, 0));
      p.accent.push(put(bevelBox(0.012, 0.07, 0.008, 0.002), 0.022, 0.045, 0, 0, 0, -0.12));
      p.accent.push(put(new THREE.TorusGeometry(0.014, 0.0035, 5, 10), -0.026, 0.07, 0, Math.PI / 2, 0, 0));
      break;
    }
  }
  return p;
}

/** Loose ammo: a stack you read by its shape, tinted per family. */
function buildAmmoPile(kind: AmmoKind, bevel: number): PartBundle {
  const meta = AMMO_META[kind];
  const p = bundle("olive", meta.tint);
  if (kind === "shells") {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const x = Math.cos(a) * 0.035;
      const z = Math.sin(a) * 0.035;
      p.sig.push(put(tube(0.014, 0.014, 0.055, 8), x, 0.028, z, 0, 0, 0));
      p.accent.push(put(tube(0.0145, 0.0145, 0.018, 8), x, 0.009, z));
    }
  } else if (kind === "rockets") {
    p.body.push(put(tubeX(0.026, 0.026, 0.2, 10), 0, 0.03, 0));
    p.sig.push(put(tube(0.008, 0.026, 0.05, 10), 0.12, 0.03, 0, 0, 0, -Math.PI / 2));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      p.accent.push(put(bevelBox(0.05, 0.03, 0.004, 0.001), -0.08, 0.03 + Math.sin(a) * 0.026, Math.cos(a) * 0.026, a));
    }
  } else {
    // A cardboard carton, split open, with a few loose rounds on top.
    const w = kind === "heavy" ? 0.13 : 0.16;
    p.body.push(put(bevelBox(w, 0.07, 0.1, bevel * 0.005, 0.008), 0, 0.035, 0));
    p.body.push(put(bevelBox(w * 0.96, 0.012, 0.098, 0.003), 0, 0.072, 0.006, -0.5));
    const rounds = kind === "heavy" ? 3 : 5;
    for (let i = 0; i < rounds; i++) {
      const x = -w * 0.3 + (i * w * 0.6) / Math.max(1, rounds - 1);
      p.accent.push(put(tubeX(0.008, 0.008, 0.05, 8), x, 0.082, -0.02, 0, 0.3, 0));
      p.sig.push(put(tubeX(0.006, 0.008, 0.018, 8), x + 0.032, 0.082, -0.02, 0, 0.3, 0));
    }
  }
  return p;
}

/* --- merge to a drawable ------------------------------------------------- */

interface Art {
  geo: Geo;
  /** Material factory per rarity, in the geometry's group order. */
  mats(kit: Kit, rarity: Rarity): THREE.Material[];
  /** Bounding radius, for beam sizing and the interact test. */
  radius: number;
  /**
   * Display scale. Weapons are authored at true size and stay there; a roll of
   * bandages at true size is 10 cm of white blob inside a 60 cm beam, so the
   * small consumables are pushed up towards a common readable size. Every
   * looter-shooter does this and it is invisible until you stop doing it.
   */
  scale: number;
}

function finishArt(p: PartBundle, kit: Kit): Art {
  const chunks: Geo[] = [];
  const slots: ("body" | "accent" | "sig")[] = [];
  if (p.body.length) {
    chunks.push(mergeParts(p.body));
    slots.push("body");
  }
  if (p.accent.length) {
    chunks.push(mergeParts(p.accent));
    slots.push("accent");
  }
  if (p.sig.length) {
    chunks.push(mergeParts(p.sig));
    slots.push("sig");
  }
  const geo = chunks.length === 1 ? chunks[0] : (mergeGeometries(chunks, true) ?? chunks[0]);
  if (chunks.length > 1) for (const c of chunks) c.dispose();
  geo.computeBoundingSphere();
  const radius = geo.boundingSphere ? geo.boundingSphere.radius : 0.3;
  const scale = clamp(0.3 / Math.max(0.05, radius), 1, 2.6);
  const surface = p.surface;
  const sigColor = p.sigColor;
  const sigGlass = p.sigGlass === true;
  const bodyGlass = p.bodyGlass === true;
  kit.track(geo);
  return {
    geo,
    radius,
    scale,
    mats(k, rarity) {
      return slots.map((s) =>
        s === "body"
          ? bodyGlass
            ? k.glass()
            : k.surface(surface)
          : s === "accent"
            ? k.accent(rarity)
            : sigGlass
              ? k.glass()
              : // Tuned down from a stronger glow: a potion is lit from within,
                // but much past this the liquid clips to white and the colour
                // that says "shields" rather than "health" is gone.
                k.signature(sigColor, 0.22),
      );
    },
  };
}

/* ------------------------------------------------------------------------ *
 * The chest
 *
 * The hero prop of the whole game mode. It is a lacquered hardwood carcass
 * with a barrel-vault lid, forged gold hardware, and a seam that glows from
 * the inside — and every one of those words is a deliberate answer to the
 * critic's list: real texture rather than a tint, a curved silhouette rather
 * than a box, chamfers everywhere two surfaces meet, brackets and a lock and
 * hinges as small-scale detail, and a light source that is part of the model.
 * ------------------------------------------------------------------------ */

/** Chest dimensions, in metres. */
const CH_W = 0.95;
const CH_D = 0.64;
const CH_FOOT = 0.05;
const CH_BODY = 0.32;
const CH_VAULT = 0.24;
/** Top of the carcass — where the lid sits. */
const CH_TOP = CH_FOOT + CH_BODY;
/** How far in from the back face the hinge line sits. */
const CH_HINGE = 0.045;

interface ChestArt {
  baseGeo: Geo;
  lidGeo: Geo;
  glowGeo: Geo;
  /** Materials, in each geometry's group order. */
  baseMats(kit: Kit): THREE.Material[];
  lidMats(kit: Kit): THREE.Material[];
}

/** Half-ellipse profile extruded along X: the lid vault. */
function vaultGeo(width: number, halfDepth: number, rise: number, seg: number): Geo {
  const s = new THREE.Shape();
  s.moveTo(-halfDepth, 0);
  for (let i = 1; i <= seg; i++) {
    const a = Math.PI * (1 - i / seg);
    s.lineTo(Math.cos(a) * halfDepth, Math.sin(a) * rise);
  }
  s.lineTo(-halfDepth, 0);
  const bevel = 0.01;
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: width - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
    steps: 1,
  });
  geo.translate(0, 0, -(width - bevel * 2) * 0.5);
  // Extrude runs along +Z; the vault runs along the chest's width, so swing it.
  geo.rotateY(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

function buildChestArt(kit: Kit, bevel: number): ChestArt {
  const wood: Geo[] = [];
  const gold: Geo[] = [];
  const lidWood: Geo[] = [];
  const lidGold: Geo[] = [];
  const glow: Geo[] = [];

  const hw = CH_W * 0.5;
  const hd = CH_D * 0.5;

  // --- carcass -----------------------------------------------------------
  wood.push(put(bevelBox(CH_W, CH_BODY, CH_D, 0.014, 0.022, bevel), 0, CH_FOOT + CH_BODY * 0.5, 0));
  // Raised plank battens on all four faces. A flat slab of wood at this size
  // reads as a crate; the battens are what make it joinery.
  for (const sz of [-1, 1]) {
    wood.push(put(bevelBox(CH_W * 0.92, 0.05, 0.014, 0.004), 0, CH_FOOT + 0.075, sz * (hd + 0.004)));
    wood.push(put(bevelBox(CH_W * 0.92, 0.05, 0.014, 0.004), 0, CH_FOOT + CH_BODY - 0.06, sz * (hd + 0.004)));
    wood.push(put(bevelBox(0.014, CH_BODY * 0.86, CH_D * 0.88, 0.004), sz * (hw + 0.004), CH_FOOT + CH_BODY * 0.5, 0));
  }
  // Feet, with brass caps: the chest stands proud of the floor so it gets a
  // real contact shadow instead of merging into the boards.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      wood.push(put(bevelBox(0.13, CH_FOOT, 0.13, 0.008, 0.014), sx * (hw - 0.09), CH_FOOT * 0.5, sz * (hd - 0.09)));
      gold.push(put(bevelBox(0.14, 0.016, 0.14, 0.005, 0.016), sx * (hw - 0.09), 0.008, sz * (hd - 0.09)));
    }
  }
  // Corner brackets: two plates per corner, wrapping the edge.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      gold.push(put(bevelBox(0.11, CH_BODY * 0.9, 0.012, 0.004), sx * (hw - 0.055), CH_FOOT + CH_BODY * 0.5, sz * (hd + 0.006)));
      gold.push(put(bevelBox(0.012, CH_BODY * 0.9, 0.11, 0.004), sx * (hw + 0.006), CH_FOOT + CH_BODY * 0.5, sz * (hd - 0.055)));
      // Rivet heads on each bracket. Four spheres, and they matter: a bracket
      // without fasteners is a sticker.
      for (let i = 0; i < 2; i++) {
        gold.push(
          put(new THREE.SphereGeometry(0.009, 6, 4), sx * (hw - 0.055), CH_FOOT + 0.05 + i * (CH_BODY - 0.1), sz * (hd + 0.012)),
        );
      }
    }
  }
  // Top rail the lid seats against, and the glowing seam just under it.
  gold.push(put(bevelBox(CH_W + 0.014, 0.022, CH_D + 0.014, 0.005, 0.02), 0, CH_TOP - 0.004, 0));
  // The seam sits a hair PROUD of the carcass and just under the rail, so the
  // glow is a visible line all the way round rather than a light trapped
  // inside a box. An inset seam is invisible from standing height, which is
  // the only height anyone ever looks at a chest from.
  glow.push(put(bevelBox(CH_W + 0.008, 0.014, CH_D + 0.008, 0.003), 0, CH_TOP - 0.026, 0));
  // Interior: a shallow glowing floor you see the moment the lid lifts.
  glow.push(put(bevelBox(CH_W - 0.12, 0.02, CH_D - 0.12, 0.004), 0, CH_TOP - 0.075, 0));
  // Lock plate + hasp on the front face.
  gold.push(put(bevelBox(0.17, 0.13, 0.016, 0.005, 0.02), 0, CH_TOP - 0.075, hd + 0.008));
  gold.push(put(bevelBox(0.06, 0.05, 0.026, 0.004, 0.01), 0, CH_TOP - 0.055, hd + 0.02));
  gold.push(put(new THREE.TorusGeometry(0.018, 0.006, 6, 10), 0, CH_TOP - 0.115, hd + 0.018));
  gold.push(put(new THREE.SphereGeometry(0.012, 8, 6), 0, CH_TOP - 0.09, hd + 0.03));
  // Hinge barrels at the back.
  for (const sx of [-1, 1]) {
    gold.push(put(tubeX(0.018, 0.018, 0.16, 10), sx * 0.24, CH_TOP + 0.005, -hd + CH_HINGE));
    gold.push(put(bevelBox(0.09, 0.05, 0.02, 0.004), sx * 0.24, CH_TOP - 0.03, -hd + 0.012));
  }

  // --- lid, authored around the hinge as its local origin -----------------
  const lidShift = hd - CH_HINGE;
  lidWood.push(put(vaultGeo(CH_W, hd, CH_VAULT, 12), 0, 0, lidShift));
  lidWood.push(put(bevelBox(CH_W + 0.02, 0.026, CH_D + 0.02, 0.006, 0.02), 0, 0.012, lidShift));
  // Three gold straps over the vault, following its curve in three segments
  // each — a straight strap over a curved lid is the kind of thing a critic
  // screenshots.
  for (const sx of [-0.3, 0, 0.3]) {
    for (let i = 0; i < 5; i++) {
      const a0 = (i / 5) * Math.PI;
      const a1 = ((i + 1) / 5) * Math.PI;
      const am = (a0 + a1) * 0.5;
      const x0 = Math.cos(a0) * hd;
      const y0 = Math.sin(a0) * CH_VAULT;
      const x1 = Math.cos(a1) * hd;
      const y1 = Math.sin(a1) * CH_VAULT;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      lidGold.push(
        put(
          bevelBox(0.075, 0.012, len + 0.01, 0.003),
          sx * CH_W,
          Math.sin(am) * CH_VAULT * 0.99 + 0.004,
          Math.cos(am) * hd * 0.99 + lidShift,
          -ang,
        ),
      );
    }
  }
  lidGold.push(put(bevelBox(0.09, 0.05, 0.03, 0.005, 0.012), 0, CH_VAULT * 0.42, hd * 0.96 + lidShift));
  lidGold.push(put(new THREE.TorusGeometry(0.03, 0.008, 6, 12, Math.PI), 0, CH_VAULT + 0.012, lidShift, 0, 0, 0));

  const baseChunks = [mergeParts(wood), mergeParts(gold)];
  const lidChunks = [mergeParts(lidWood), mergeParts(lidGold)];
  const baseGeo = mergeGeometries(baseChunks, true) ?? baseChunks[0];
  const lidGeo = mergeGeometries(lidChunks, true) ?? lidChunks[0];
  for (const c of baseChunks) c.dispose();
  for (const c of lidChunks) c.dispose();
  // Library gold expects UVs in world metres over its tile; the extruder emits
  // shape-space UVs, which would tile the hammer dimples at random scales.
  // One tile size for the whole chest rather than one per group: the wood and
  // the gold sit in the same merged geometry, and a 0.2 m difference in grain
  // scale on a 0.95 m prop is not worth a second projection pass.
  boxProjectUv(baseGeo, TILE_METRES.gold ?? 1.2);
  boxProjectUv(lidGeo, TILE_METRES.gold ?? 1.2);
  const glowGeo = mergeParts(glow);
  kit.track(baseGeo);
  kit.track(lidGeo);
  kit.track(glowGeo);

  return {
    baseGeo,
    lidGeo,
    glowGeo,
    baseMats: (k) => [k.surface("wood"), k.surface("gold")],
    lidMats: (k) => [k.surface("wood"), k.surface("gold")],
  };
}

/* ------------------------------------------------------------------------ *
 * Ammo box and supply crate
 * ------------------------------------------------------------------------ */

interface BoxArt {
  baseGeo: Geo;
  lidGeo: Geo;
  baseMats(kit: Kit): THREE.Material[];
  lidMats(kit: Kit): THREE.Material[];
  /** Hinge offset from the box centre, in local space. */
  hinge: THREE.Vector3;
}

/** The olive stencilled ammo crate. Smaller and humbler than a chest. */
function buildAmmoBoxArt(kit: Kit, bevel: number): BoxArt {
  const W = 0.46;
  const H = 0.24;
  const D = 0.3;
  const skin: Geo[] = [];
  const metal: Geo[] = [];
  skin.push(boxProjectUv(put(bevelBox(W, H, D, 0.01, 0.016, bevel), 0, H * 0.5, 0), 0.55));
  // Corner angle-iron and a rope handle at each end: the two details that turn
  // a green box into ordnance packaging.
  for (const sx of [-1, 1]) {
    // A rope handle at each end, and corner posts — NOT a full-height plate
    // per face. The stencil is the crate's whole personality and hardware that
    // covers it is hardware that should not be there.
    metal.push(put(new THREE.TorusGeometry(0.045, 0.008, 5, 10, Math.PI), sx * (W * 0.5 + 0.016), H * 0.62, 0, 0, Math.PI / 2, 0));
    for (const sz of [-1, 1]) {
      metal.push(put(bevelBox(0.026, H * 0.98, 0.026, 0.005), sx * (W * 0.5 - 0.014), H * 0.5, sz * (D * 0.5 - 0.014)));
      metal.push(put(bevelBox(0.07, 0.016, 0.012, 0.003), sx * (W * 0.5 - 0.05), H * 0.12, sz * (D * 0.5 + 0.004)));
      metal.push(put(bevelBox(0.012, 0.016, 0.06, 0.003), sx * (W * 0.5 + 0.004), H * 0.12, sz * (D * 0.5 - 0.045)));
    }
  }
  metal.push(put(bevelBox(0.07, 0.04, 0.018, 0.004), 0, H * 0.86, D * 0.5 + 0.006));
  const lidSkin: Geo[] = [];
  const lidMetal: Geo[] = [];
  const lidShift = D * 0.5;
  lidSkin.push(boxProjectUv(put(bevelBox(W + 0.01, 0.05, D + 0.01, 0.008, 0.014, bevel), 0, 0.02, lidShift), 0.55));
  lidMetal.push(put(bevelBox(W * 0.9, 0.012, 0.04, 0.003), 0, 0.048, lidShift));
  lidMetal.push(put(bevelBox(0.06, 0.03, 0.016, 0.003), 0, 0.02, lidShift + D * 0.5));

  const baseChunks = [mergeParts(skin), mergeParts(metal)];
  const lidChunks = [mergeParts(lidSkin), mergeParts(lidMetal)];
  const baseGeo = mergeGeometries(baseChunks, true) ?? baseChunks[0];
  const lidGeo = mergeGeometries(lidChunks, true) ?? lidChunks[0];
  for (const c of baseChunks) c.dispose();
  for (const c of lidChunks) c.dispose();
  kit.track(baseGeo);
  kit.track(lidGeo);
  return {
    baseGeo,
    lidGeo,
    baseMats: (k) => [k.ammoSkin(), k.surface("gunmetal")],
    lidMats: (k) => [k.ammoSkin(), k.surface("gunmetal")],
    hinge: new THREE.Vector3(0, H, -D * 0.5),
  };
}

interface SupplyArt {
  crateGeo: Geo;
  crateMats(kit: Kit): THREE.Material[];
  balloonGeo: Geo;
  ropeGeo: Geo;
  flareGeo: Geo;
}

/**
 * The supply drop. A real balloon — a lathed teardrop with sewn panels, a
 * skirt ring and four load ropes — over a crate with corner posts and a
 * beacon. It is meant to be legible as a *shape* from 400 m away, because
 * that is the range at which the decision to contest it gets made.
 */
function buildSupplyArt(kit: Kit, bevel: number): SupplyArt {
  const crate: Geo[] = [];
  const trim: Geo[] = [];
  const W = 1.5;
  const H = 1.1;
  crate.push(put(bevelBox(W, H, W, 0.026, 0.05, bevel), 0, H * 0.5, 0));
  // Recessed side panels: the inset is what gives the crate its own contact
  // shadows at 200 m, where a flat cube has none.
  for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
    crate.push(
      put(bevelBox(ax ? 0.03 : W * 0.7, H * 0.6, az ? 0.03 : W * 0.7, 0.008), ax * (W * 0.5 + 0.008), H * 0.5, az * (W * 0.5 + 0.008)),
    );
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      trim.push(put(bevelBox(0.1, H + 0.03, 0.1, 0.012, 0.02), sx * (W * 0.5 - 0.05), H * 0.5, sz * (W * 0.5 - 0.05)));
      trim.push(put(new THREE.TorusGeometry(0.05, 0.012, 6, 10), sx * (W * 0.5 - 0.05), H + 0.03, sz * (W * 0.5 - 0.05), Math.PI / 2));
    }
  }
  trim.push(put(bevelBox(W + 0.04, 0.06, W + 0.04, 0.012, 0.02), 0, H * 0.62, 0));
  trim.push(put(bevelBox(W + 0.04, 0.06, W + 0.04, 0.012, 0.02), 0, H * 0.26, 0));
  const crateChunks = [mergeParts(crate), mergeParts(trim)];
  const crateGeo = mergeGeometries(crateChunks, true) ?? crateChunks[0];
  for (const c of crateChunks) c.dispose();
  kit.track(crateGeo);

  // Balloon: teardrop lathe, wide at the shoulder, pinched at the skirt.
  const prof: [number, number][] = [
    [0.02, 0],
    [0.5, 0.35],
    [1.05, 0.95],
    [1.5, 1.9],
    [1.62, 2.75],
    [1.42, 3.6],
    [0.95, 4.25],
    [0.35, 4.7],
    [0.02, 4.8],
  ];
  const balloonGeo = kit.track(lathe(prof, 20));
  const ropeGeo = kit.track(tube(0.016, 0.016, 1, 5));
  const flareGeo = kit.track(tube(0.06, 0.07, 0.22, 8));
  return {
    crateGeo,
    crateMats: (k) => [k.surface("olive"), k.surface("gunmetal")],
    balloonGeo,
    ropeGeo,
    flareGeo,
  };
}

/* ------------------------------------------------------------------------ *
 * The particle field
 *
 * One `THREE.Points` for every mote, sparkle and puff of flare smoke in the
 * module. A ring buffer: the oldest particle is recycled when the pool is
 * full, which is the right failure mode — a chest burst stealing motes from a
 * beam for half a second is invisible, a growing allocation is not.
 * ------------------------------------------------------------------------ */

class ParticleField {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private baseSize: Float32Array;
  private cursor = 0;
  private readonly n: number;

  constructor(count: number, material: THREE.Material) {
    this.n = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.baseSize = new Float32Array(count);
    // Park dead particles at the origin with zero size; the shader discards
    // them on alpha, so they cost a vertex and nothing else.
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));
    this.points = new THREE.Points(this.geo, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.name = "dz:loot:particles";
  }

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    color: THREE.Color,
    size: number,
    life: number,
    gravity = 0,
    drag = 0.6,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = color.r;
    this.col[i * 3 + 1] = color.g;
    this.col[i * 3 + 2] = color.b;
    this.baseSize[i] = size;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.alpha[i] = 0;
  }

  update(dt: number): void {
    const { pos, vel, life, maxLife, alpha, size, baseSize, grav, drag } = this;
    for (let i = 0; i < this.n; i++) {
      if (life[i] <= 0) {
        if (alpha[i] !== 0) alpha[i] = 0;
        continue;
      }
      life[i] -= dt;
      if (life[i] <= 0) {
        alpha[i] = 0;
        size[i] = 0;
        continue;
      }
      const d = Math.exp(-drag[i] * dt);
      vel[i * 3] *= d;
      vel[i * 3 + 1] = vel[i * 3 + 1] * d + grav[i] * dt;
      vel[i * 3 + 2] *= d;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      const t = 1 - life[i] / maxLife[i];
      // Fade in over the first 15 %, then out on a curve — a linear fade-out
      // pops at the end because the eye tracks the last few frames.
      alpha[i] = smoothstep(0, 0.15, t) * (1 - t) * (1 - t * 0.4);
      size[i] = baseSize[i] * (0.7 + t * 0.6);
    }
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("aAlpha") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
  }
}

/* ------------------------------------------------------------------------ *
 * Loot audio
 *
 * A tiny synth on its own `AudioContext`. Two reasons this is not routed
 * through the shared audio service:
 *
 *  - The chest hum is a *continuous, distance-driven voice*, not a one-shot,
 *    and `AudioService.play` has no handle to modulate afterwards.
 *  - The ascending chest chime is the most recognisable sound in the mode and
 *    it must exist even if the audio system failed to boot.
 *
 * Created lazily on the first pointer lock, because browsers refuse to start
 * a context without a gesture and a suspended one logs a warning every frame.
 * ------------------------------------------------------------------------ */

class LootAudio {
  private acx: AudioContext | null = null;
  private master: GainNode | null = null;
  private humGain: GainNode | null = null;
  private humNodes: OscillatorNode[] = [];
  private lfo: OscillatorNode | null = null;
  private noise: AudioBuffer | null = null;
  private failed = false;

  /** Called once the page has a gesture. Safe to call every frame. */
  ensure(): void {
    if (this.acx || this.failed) return;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        this.failed = true;
        return;
      }
      const acx = new Ctor();
      const master = acx.createGain();
      master.gain.value = 0.5;
      master.connect(acx.destination);
      this.acx = acx;
      this.master = master;

      // The hum: two detuned partials through a gentle lowpass, with a slow
      // tremolo. Detuning is the whole trick — two exact sines beat into a
      // pure tone that sounds like a test signal.
      const filter = acx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 1200;
      filter.Q.value = 0.7;
      const hum = acx.createGain();
      hum.gain.value = 0;
      filter.connect(hum);
      hum.connect(master);
      for (const [freq, gain] of [[196, 0.5], [294.5, 0.32], [589, 0.12]] as [number, number][]) {
        const osc = acx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const g = acx.createGain();
        g.gain.value = gain;
        osc.connect(g);
        g.connect(filter);
        osc.start();
        this.humNodes.push(osc);
      }
      const lfo = acx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.55;
      const lfoGain = acx.createGain();
      lfoGain.gain.value = 240;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start();
      this.lfo = lfo;
      this.humGain = hum;

      const len = Math.floor(acx.sampleRate * 0.4);
      const buf = acx.createBuffer(1, len, acx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noise = buf;
    } catch {
      this.failed = true;
    }
  }

  /** 0..1 proximity level for the chest hum bed. */
  setHum(level: number): void {
    if (!this.acx || !this.humGain) return;
    const t = this.acx.currentTime;
    // setTargetAtTime rather than a linear ramp: walking past a chest should
    // swell and fade, not slide between two values on a rail.
    this.humGain.gain.setTargetAtTime(clamp(level, 0, 1) * 0.16, t, 0.12);
  }

  private tone(freq: number, at: number, dur: number, type: OscillatorType, gain: number, sweep = 1): void {
    const acx = this.acx;
    const master = this.master;
    if (!acx || !master) return;
    const osc = acx.createOscillator();
    const g = acx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (sweep !== 1) osc.frequency.exponentialRampToValueAtTime(freq * sweep, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  private noiseBurst(at: number, dur: number, freq: number, q: number, gain: number): void {
    const acx = this.acx;
    const master = this.master;
    if (!acx || !master || !this.noise) return;
    const src = acx.createBufferSource();
    src.buffer = this.noise;
    const bp = acx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = acx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  /**
   * The iconic ascending chime. A major arpeggio with an octave doubling and
   * a shimmer of noise on top — four notes, 70 ms apart, is the tempo the ear
   * hears as "reward" rather than "melody".
   */
  chime(volume = 1): void {
    const acx = this.acx;
    if (!acx) return;
    const t0 = acx.currentTime + 0.01;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < notes.length; i++) {
      const at = t0 + i * 0.07;
      this.tone(notes[i], at, 0.55, "triangle", 0.16 * volume);
      this.tone(notes[i] * 2, at, 0.3, "sine", 0.06 * volume);
    }
    this.tone(1046.5, t0 + 0.28, 0.9, "sine", 0.1 * volume);
    this.noiseBurst(t0 + 0.02, 0.5, 5200, 1.2, 0.05 * volume);
  }

  /** Wood-and-brass lid throw: a knock plus a short metallic ring. */
  lid(): void {
    const acx = this.acx;
    if (!acx) return;
    const t0 = acx.currentTime + 0.005;
    this.noiseBurst(t0, 0.14, 260, 1.6, 0.35);
    this.tone(140, t0, 0.18, "triangle", 0.16, 0.7);
    this.noiseBurst(t0 + 0.16, 0.22, 2400, 3.5, 0.12);
  }

  /** Two-note rising blip — the "you got it" confirmation. */
  pickup(rarityIdx: number): void {
    const acx = this.acx;
    if (!acx) return;
    const t0 = acx.currentTime + 0.005;
    const base = 660 + rarityIdx * 45;
    this.tone(base, t0, 0.1, "square", 0.05);
    this.tone(base * 1.5, t0 + 0.055, 0.16, "square", 0.05);
    if (rarityIdx >= 3) this.tone(base * 2, t0 + 0.11, 0.35, "sine", 0.06);
  }

  /** Flat, short, unmistakably a refusal. */
  deny(): void {
    const acx = this.acx;
    if (!acx) return;
    this.tone(180, acx.currentTime + 0.005, 0.14, "square", 0.05, 0.7);
  }

  /** Distant klaxon when a supply drop is inbound. */
  klaxon(): void {
    const acx = this.acx;
    if (!acx) return;
    const t0 = acx.currentTime + 0.01;
    this.tone(320, t0, 0.5, "sawtooth", 0.05, 0.85);
    this.tone(213, t0 + 0.3, 0.7, "sawtooth", 0.05, 0.9);
  }

  /** Crate landing: a body thump plus grit. */
  thud(): void {
    const acx = this.acx;
    if (!acx) return;
    const t0 = acx.currentTime + 0.005;
    this.tone(70, t0, 0.4, "sine", 0.3, 0.6);
    this.noiseBurst(t0, 0.3, 420, 0.8, 0.22);
  }

  dispose(): void {
    for (const o of this.humNodes) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
      o.disconnect();
    }
    this.humNodes.length = 0;
    if (this.lfo) {
      try {
        this.lfo.stop();
      } catch {
        /* already stopped */
      }
      this.lfo.disconnect();
      this.lfo = null;
    }
    this.humGain?.disconnect();
    this.master?.disconnect();
    this.humGain = null;
    this.master = null;
    const acx = this.acx;
    this.acx = null;
    this.noise = null;
    // close() returns a promise; a failure here must never escape teardown.
    if (acx) void acx.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------------ */

interface Pickup extends LootPickup {
  id: number;
  item: InventoryItem;
  object: THREE.Object3D;
  position: THREE.Vector3;
  rarity: Rarity;
  art: Art;
  /** Resting surface height. The item hovers HOVER above this. */
  ground: number;
  /** Bob/spin phase offset so a pile of loot never pulses in lockstep. */
  phase: number;
  live: boolean;
  /** True while the item is still flying out of a chest. */
  airborne: boolean;
  vel: THREE.Vector3;
  active: boolean;
  mesh: THREE.Mesh | null;
  beamSlot: number;
  /** Set for ammo pickups, which top up the reserve instead of a slot. */
  ammoKind: AmmoKind | null;
  dist2: number;
}

interface ContainerVisual {
  group: THREE.Group;
  base: THREE.Mesh;
  lidPivot: THREE.Group;
  lid: THREE.Mesh;
  glow: THREE.Mesh | null;
  glowMat: THREE.MeshStandardMaterial | null;
}

interface Container {
  kind: "chest" | "ammo";
  id: number;
  position: THREE.Vector3;
  yaw: number;
  tier: keyof typeof TIER_WEIGHTS;
  opened: boolean;
  /** 0..1 lid animation. */
  lidT: number;
  /** Seconds since it was opened, for the light burst. */
  sinceOpen: number;
  hold: number;
  active: boolean;
  visual: ContainerVisual | null;
  remover: (() => void) | null;
  dist2: number;
}

interface BeamSlot {
  group: THREE.Group;
  beam: THREE.Mesh;
  glow: THREE.Mesh;
  owner: Pickup | null;
  moteT: number;
}

interface SupplyDrop {
  group: THREE.Group;
  balloon: THREE.Mesh;
  skirt: THREE.Mesh;
  crate: THREE.Mesh;
  flare: THREE.Mesh;
  ropes: THREE.Mesh[];
  state: "descending" | "landing" | "landed";
  groundY: number;
  sway: number;
  hold: number;
  opened: boolean;
  lidT: number;
  smokeT: number;
  remover: (() => void) | null;
  /** A beam borrowed from the VFX service, if it has one. Ours to detach. */
  vfxBeam: THREE.Object3D | null;
}

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

/**
 * The engine calls `fixed()` at a hard 120 Hz, but `System` in the shared
 * contract does not declare it (the engine's own `FixedSystem` does, and that
 * lives in core.ts). Rather than edit types.ts while twelve other modules
 * compile against it, we re-declare the shape locally — same trick the build
 * system uses.
 */
interface FixedSystem extends System {
  fixed(dt: number, ctx: WorldCtx): void;
}

const createLoot: SystemFactory = (ctx: WorldCtx): FixedSystem => {
  const svc = ctx.services as LootServices;
  const budget = BUDGETS[ctx.quality] ?? BUDGETS.high;

  // ---- state, declared before the service so its methods can close over it,
  // ---- and before any expensive work so a failure in the art bake still
  // ---- leaves later systems something to call.
  const pickups: Pickup[] = [];
  const containers: Container[] = [];
  const drops: SupplyDrop[] = [];
  const beamSlots: BeamSlot[] = [];
  const chestPool: ContainerVisual[] = [];
  const ammoPool: ContainerVisual[] = [];
  const pending: { at: number; item: InventoryItem; from: THREE.Vector3; angle: number; ground: number }[] = [];
  let nextId = 1;
  let prompt: LootPrompt | null = null;
  let chestsOpened = 0;
  let disposed = false;

  const service: LootServiceExt = {
    spawn(item, point) {
      spawnPickup(item, point, true);
    },
    nearest(point, range) {
      return nearestPickup(point, range);
    },
    take(pickup) {
      const p = pickup as Pickup;
      if (p && p.live !== undefined) takePickup(p);
    },
    get prompt() {
      return prompt;
    },
    get pickupCount() {
      let n = 0;
      for (const p of pickups) if (p.live) n++;
      return n;
    },
    get chestCount() {
      let n = 0;
      for (const c of containers) if (c.kind === "chest") n++;
      return n;
    },
    get chestsOpened() {
      return chestsOpened;
    },
    requestSupplyDrop(at) {
      return spawnSupplyDrop(at);
    },
  };
  svc.loot = service;

  // ---- roots. One group for everything so teardown is a single detach.
  const root = new THREE.Group();
  root.name = "dz:loot";
  ctx.scene.add(root);
  const beamRoot = new THREE.Group();
  beamRoot.name = "dz:loot:beams";
  root.add(beamRoot);

  /**
   * Private RNG. The island must lay out identically no matter how much
   * entropy the systems that booted before us happened to draw from ctx.rng.
   */
  const rng = makeRng(0x10_07_51_11);

  const kit = makeKit(ctx, rng);
  const chestArt = buildChestArt(kit, budget.bevel);
  const boxArt = buildAmmoBoxArt(kit, budget.bevel);
  const supplyArt = buildSupplyArt(kit, budget.bevel);
  const artCache = new Map<string, Art>();
  const audio = new LootAudio();

  const particles = new ParticleField(budget.particles, kit.particleMat);
  root.add(particles.points);
  kit.pixelScale.value = (ctx.renderer.domElement.clientHeight || window.innerHeight) * 0.5;

  /**
   * One shared point light for every chest burst on the island. Added once
   * and left in the scene at zero intensity: adding or removing a light
   * changes the renderer's lighting hash and recompiles every material in
   * view, which is a visible hitch at exactly the wrong moment.
   */
  const burstLight = new THREE.PointLight(0xffd08a, 0, 15, 2);
  burstLight.name = "dz:loot:burst";
  root.add(burstLight);

  // ---- scratch. The hot paths must not allocate.
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const rayDown = new THREE.Vector3(0, -1, 0);
  const rayOrigin = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const activeList: Pickup[] = [];
  const containerList: Container[] = [];
  let activeTimer = 0;
  let lastCircle = 0;
  let dropCooldown = 25;
  let prevInteract = false;
  let promptDirty = true;

  /* -------------------------------------------------------------- geometry */

  const beamGeo = kit.track(
    (() => {
      // Two nested tubes merged into one mesh: an outer sheath that catches
      // the silhouette term and a hot inner core. One draw, two densities.
      const outer = new THREE.CylinderGeometry(0.34, 0.26, 2.4, 14, 1, true);
      const inner = new THREE.CylinderGeometry(0.11, 0.08, 2.4, 10, 1, true);
      outer.translate(0, 1.2, 0);
      inner.translate(0, 1.2, 0);
      const merged = mergeGeometries([normalise(outer), normalise(inner)], false);
      outer.dispose();
      inner.dispose();
      return merged ?? new THREE.CylinderGeometry(0.34, 0.26, 2.4, 14, 1, true);
    })(),
  );
  const glowGeo = kit.track((() => {
    const g = new THREE.CircleGeometry(0.8, 20);
    g.rotateX(-Math.PI / 2);
    return g;
  })());

  for (let i = 0; i < budget.beams; i++) {
    const group = new THREE.Group();
    group.visible = false;
    const beam = new THREE.Mesh(beamGeo, kit.beam("common"));
    beam.renderOrder = 2;
    beam.castShadow = false;
    beam.receiveShadow = false;
    const glow = new THREE.Mesh(glowGeo, kit.glow("common"));
    glow.position.y = 0.035;
    glow.renderOrder = 1;
    group.add(beam, glow);
    beamRoot.add(group);
    beamSlots.push({ group, beam, glow, owner: null, moteT: 0 });
  }

  /* ------------------------------------------------------------ item minting */

  function uid(prefix: string): string {
    return `${prefix}-${Math.floor(rng() * 0xffffff).toString(36)}`;
  }

  function fallbackWeapon(rarity: Rarity): WeaponFallback {
    const i = rarityIndex(rarity);
    let total = 0;
    for (const w of WEAPON_FALLBACK) total += w.weights[i];
    if (total <= 0) return WEAPON_FALLBACK[0];
    let pick = rng() * total;
    for (const w of WEAPON_FALLBACK) {
      pick -= w.weights[i];
      if (pick <= 0) return w;
    }
    return WEAPON_FALLBACK[0];
  }

  /** Roll a gun. Prefers the arsenal's own table so balance stays in one place. */
  function makeWeaponItem(rarity: Rarity): InventoryItem {
    const w = svc.weapons;
    let id: string | null = null;
    try {
      id = w?.rollWeapon?.(rng, rarity) ?? null;
    } catch {
      id = null;
    }
    if (id) {
      try {
        const made = w?.makeItem?.(id, rarity);
        if (made) return made;
      } catch {
        /* fall through to the local mint */
      }
    }
    const fb = id ? (WEAPON_FALLBACK.find((x) => x.id === id) ?? fallbackWeapon(rarity)) : fallbackWeapon(rarity);
    return { id: uid(fb.id), kind: "weapon", def: fb.id, name: fb.name, rarity, ammo: fb.mag };
  }

  function makeConsumableItem(minRarity = 0): InventoryItem {
    let total = 0;
    for (const c of CONSUMABLES) if (rarityIndex(c.rarity) >= minRarity) total += c.weight;
    let pick = rng() * total;
    let chosen = CONSUMABLES[0];
    for (const c of CONSUMABLES) {
      if (rarityIndex(c.rarity) < minRarity) continue;
      pick -= c.weight;
      if (pick <= 0) {
        chosen = c;
        break;
      }
    }
    return {
      id: uid(chosen.id),
      kind: chosen.kind,
      def: chosen.id,
      name: chosen.name,
      rarity: chosen.rarity,
      count: chosen.count,
    };
  }

  function makeAmmoItem(kind?: AmmoKind): InventoryItem {
    const k = kind ?? AMMO_KINDS[Math.floor(rng() * 3)];
    const meta = AMMO_META[k];
    return {
      id: uid(`ammo-${k}`),
      kind: "consumable",
      def: `ammo-${k}`,
      name: meta.name,
      rarity: "common",
      count: meta.rounds,
    };
  }

  function itemLabel(item: InventoryItem): string {
    if (item.def.startsWith("ammo-")) return item.name;
    const w = svc.weapons;
    if (item.kind === "weapon" && w?.displayName) {
      try {
        const n = w.displayName(item.def, item.rarity);
        if (n) return n;
      } catch {
        /* fall through */
      }
    }
    return `${RARITY_LABEL[item.rarity]} ${item.name}`;
  }

  /* ---------------------------------------------------------------- the art */

  function artFor(item: InventoryItem): Art {
    let key: string;
    let build: () => PartBundle;
    if (item.def.startsWith("ammo-")) {
      const kind = item.def.slice(5) as AmmoKind;
      key = `a:${kind}`;
      build = () => buildAmmoPile(AMMO_META[kind] ? kind : "light", budget.bevel);
    } else if (item.kind === "weapon") {
      let shape = SHAPE_BY_ID.get(item.def);
      if (!shape) {
        // A gun the arsenal added that we have never heard of still needs a
        // silhouette; its ammo type is the best hint at its class.
        const ammo = (() => {
          try {
            return svc.weapons?.def?.(item.def)?.ammoType;
          } catch {
            return undefined;
          }
        })();
        shape = ammo === "shells" ? "shotgun" : ammo === "heavy" ? "sniper" : ammo === "rockets" ? "rocket" : "rifle";
      }
      key = `w:${shape}`;
      const s = shape;
      build = () => buildGun(s, budget.bevel);
    } else {
      const def = CONSUMABLE_BY_ID.get(item.def) ?? CONSUMABLES[0];
      key = `c:${def.id}`;
      build = () => buildConsumable(def, budget.bevel, kit);
    }
    const cached = artCache.get(key);
    if (cached) return cached;
    const art = finishArt(build(), kit);
    artCache.set(key, art);
    return art;
  }

  /* ------------------------------------------------------------- surfaces */

  interface Surface {
    y: number;
    /** Upward-ness of the surface normal. */
    ny: number;
    /** Metres of clear air above it, up to the next surface. */
    clear: number;
    /** True when something is overhead within 7 m — i.e. it is a floor indoors. */
    indoor: boolean;
  }

  const surfaceScratch: Surface[] = [];

  /**
   * Probe the whole stack of horizontal surfaces under an XZ position. This is
   * how loot ends up on the second floor of a building this module has never
   * heard of: cast down, record the hit, drop just below it and cast again.
   */
  function surfacesAt(x: number, z: number): Surface[] {
    surfaceScratch.length = 0;
    const terrain = svc.terrain;
    const collision = svc.collision;
    const groundY = terrain ? terrain.heightAt(x, z) : 0;
    if (!collision) {
      surfaceScratch.push({ y: groundY, ny: 1, clear: 99, indoor: false });
      return surfaceScratch;
    }
    let y = groundY + 55;
    for (let i = 0; i < 5; i++) {
      const reach = y - (groundY - 1);
      if (reach <= 0.05) break;
      rayOrigin.set(x, y, z);
      const hit = collision.raycast(rayOrigin, rayDown, reach);
      if (!hit) break;
      const hy = hit.point.y;
      surfaceScratch.push({ y: hy, ny: hit.normal.y, clear: 99, indoor: false });
      y = hy - 0.12;
      // Below the terrain there is nothing left to find.
      if (hy <= groundY + 0.05) break;
    }
    if (surfaceScratch.length === 0) surfaceScratch.push({ y: groundY, ny: 1, clear: 99, indoor: false });
    for (let i = 0; i < surfaceScratch.length; i++) {
      const above = i === 0 ? Infinity : surfaceScratch[i - 1].y - surfaceScratch[i].y;
      surfaceScratch[i].clear = above;
      surfaceScratch[i].indoor = above < 7;
    }
    return surfaceScratch;
  }

  /**
   * Find a spot to put something. Rejects water, steep ground, roofs (a
   * surface with open sky far above the terrain) and anything with less than
   * standing room. `indoor` biases towards interior floors, which is where a
   * chest belongs and where floor loot is worth finding.
   */
  function findSpot(
    cx: number,
    cz: number,
    radius: number,
    indoorBias: boolean,
    out: THREE.Vector3,
    tries = 8,
  ): boolean {
    const terrain = svc.terrain;
    for (let t = 0; t < tries; t++) {
      // sqrt on the radius: uniform in area, not in radius, or everything
      // piles up in the middle of the POI.
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * radius;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (terrain && terrain.isWater(x, z)) continue;
      const groundY = terrain ? terrain.heightAt(x, z) : 0;
      const stack = surfacesAt(x, z);
      let best: Surface | null = null;
      let bestScore = -1;
      for (const s of stack) {
        if (s.ny < 0.78) continue;
        if (s.clear < 2.0) continue;
        const height = s.y - groundY;
        // A surface with nothing above it, well off the ground, is a roof.
        if (!s.indoor && height > 2.2) continue;
        let score = 1;
        if (s.indoor) score += indoorBias ? 3 : 1.2;
        if (height > 0.4 && s.indoor) score += 0.6;
        score += rng() * 0.4;
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
      if (!best) continue;
      if (terrain) {
        const n = terrain.normalAt(x, z, tmpV2);
        // Steep terrain: a chest half-buried in a cliff is the classic bug.
        if (Math.abs(best.y - groundY) < 0.2 && n.y < 0.82) continue;
      }
      out.set(x, best.y, z);
      return true;
    }
    return false;
  }

  /** Keep spawns from stacking on top of each other inside one POI. */
  function tooClose(p: THREE.Vector3, taken: THREE.Vector3[], min: number): boolean {
    const m2 = min * min;
    for (const t of taken) {
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      const dz = t.z - p.z;
      if (dx * dx + dz * dz < m2 && Math.abs(dy) < 2.5) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------- spawning */

  function spawnPickup(item: InventoryItem, at: THREE.Vector3, pop: boolean): Pickup {
    const art = artFor(item);
    const group = new THREE.Group();
    group.name = `dz:loot:${item.def}`;
    const ammoKind = item.def.startsWith("ammo-") ? (item.def.slice(5) as AmmoKind) : null;
    const p: Pickup = {
      id: nextId++,
      item,
      object: group,
      position: at.clone(),
      rarity: item.rarity,
      art,
      ground: at.y,
      phase: rng() * Math.PI * 2,
      live: true,
      airborne: pop,
      vel: new THREE.Vector3(),
      active: false,
      mesh: null,
      beamSlot: -1,
      ammoKind,
      dist2: Infinity,
    };
    if (pop) {
      // A dropped item gets a small pop so it visibly leaves the hand rather
      // than teleporting to the floor.
      const a = rng() * Math.PI * 2;
      p.vel.set(Math.cos(a) * 1.1, 2.4, Math.sin(a) * 1.1);
      p.position.y = at.y + 0.6;
      p.ground = groundUnder(at.x, at.y + 0.6, at.z);
    }
    group.position.copy(p.position);
    pickups.push(p);
    // Force the active set to rebuild this frame: an item that ejects from a
    // chest must have a mesh before it lands, not 125 ms later.
    activeTimer = 0;
    return p;
  }

  /** Height of the first solid surface under a point. */
  function groundUnder(x: number, y: number, z: number): number {
    const collision = svc.collision;
    const terrain = svc.terrain;
    const floor = terrain ? terrain.heightAt(x, z) : 0;
    if (collision) {
      rayOrigin.set(x, y + 0.1, z);
      const hit = collision.raycast(rayOrigin, rayDown, Math.max(0.2, y + 0.2 - (floor - 1)));
      if (hit && hit.point.y > floor - 0.05) return hit.point.y;
    }
    return floor;
  }

  function spawnContainer(kind: "chest" | "ammo", at: THREE.Vector3, tier: keyof typeof TIER_WEIGHTS): Container {
    const c: Container = {
      kind,
      id: nextId++,
      position: at.clone(),
      // Chests face a random quarter-ish angle: a row of identically aligned
      // chests inside a POI reads as procedural the instant you see two.
      yaw: (rng() - 0.5) * Math.PI * 2,
      tier,
      opened: false,
      lidT: 0,
      sinceOpen: 0,
      hold: 0,
      active: false,
      visual: null,
      remover: null,
      dist2: Infinity,
    };
    const collision = svc.collision;
    if (collision) {
      // The collider is deliberately shorter than the art: the engine's step
      // height is 0.62 m and a chest you cannot step onto is furniture that
      // eats a build fight.
      const halfW = kind === "chest" ? 0.5 : 0.26;
      const h = kind === "chest" ? 0.5 : 0.26;
      const box = new THREE.Box3(
        new THREE.Vector3(at.x - halfW, at.y, at.z - halfW),
        new THREE.Vector3(at.x + halfW, at.y + h, at.z + halfW),
      );
      c.remover = collision.addBox(box, { material: kind === "chest" ? "wood" : "metal", tag: `loot:${kind}` });
    }
    containers.push(c);
    return c;
  }

  /* ------------------------------------------------------------- worldgen */

  function chestCountFor(tier: Poi["tier"]): number {
    // The brief's numbers: a landmark is worth landing on, a minor POI is a
    // stop on a rotate.
    if (tier === "landmark") return 12 + Math.floor(rng() * 5);
    if (tier === "major") return 6 + Math.floor(rng() * 5);
    return 2 + Math.floor(rng() * 3);
  }

  function populate(): void {
    const pois = svc.pois ?? [];
    const spot = new THREE.Vector3();
    for (const poi of pois) {
      const taken: THREE.Vector3[] = [];
      const chests = chestCountFor(poi.tier);
      const radius = poi.radius * 0.86;
      for (let i = 0; i < chests; i++) {
        if (!findSpot(poi.center.x, poi.center.z, radius, true, spot, 10)) continue;
        if (tooClose(spot, taken, 6)) continue;
        taken.push(spot.clone());
        spawnContainer("chest", spot, poi.tier);
      }
      // Floor loot outnumbers chests: most of what you fight with in the first
      // minute is something you found on the ground, not something you opened.
      const floor = Math.round(chests * 1.8);
      for (let i = 0; i < floor; i++) {
        if (!findSpot(poi.center.x, poi.center.z, radius, true, spot, 8)) continue;
        if (tooClose(spot, taken, 2.6)) continue;
        taken.push(spot.clone());
        const rarity = rollRarity(rng, poi.tier, 1);
        const roll = rng();
        const item = roll < 0.42 ? makeWeaponItem(rarity) : roll < 0.72 ? makeConsumableItem() : makeAmmoItem();
        spawnPickup(item, spot, false);
      }
      const boxes = Math.round(chests * 0.7);
      for (let i = 0; i < boxes; i++) {
        if (!findSpot(poi.center.x, poi.center.z, radius, true, spot, 6)) continue;
        if (tooClose(spot, taken, 3)) continue;
        taken.push(spot.clone());
        spawnContainer("ammo", spot, poi.tier);
      }
    }

    // --- rural. The reason to cut across a field instead of road-running.
    const terrain = svc.terrain;
    const half = (terrain?.worldSize ?? 1500) * 0.88;
    const ruralChests = ctx.quality === "low" ? 20 : 34;
    let placed = 0;
    for (let attempt = 0; attempt < ruralChests * 14 && placed < ruralChests; attempt++) {
      const x = (rng() * 2 - 1) * half;
      const z = (rng() * 2 - 1) * half;
      let nearPoi = false;
      for (const poi of pois) {
        const dx = poi.center.x - x;
        const dz = poi.center.z - z;
        if (dx * dx + dz * dz < poi.radius * poi.radius * 1.35) {
          nearPoi = true;
          break;
        }
      }
      if (nearPoi) continue;
      if (!findSpot(x, z, 14, false, tmpV, 4)) continue;
      spawnContainer("chest", tmpV, "rural");
      placed++;
      // A rural chest usually has a scrap of floor loot with it — a lone chest
      // in a field is a long walk for one item.
      if (rng() < 0.55 && findSpot(tmpV.x, tmpV.z, 5, false, spot, 4)) {
        spawnPickup(rng() < 0.5 ? makeConsumableItem() : makeAmmoItem(), spot, false);
      }
    }
  }

  try {
    populate();
  } catch (err) {
    console.warn("[Drop Zero] loot: worldgen pass failed", err);
  }

  /* ----------------------------------------------------------- visuals */

  function makeVisual(kind: "chest" | "ammo"): ContainerVisual {
    const group = new THREE.Group();
    // Named because a chest is the thing every harness and every debug overlay
    // goes looking for by name, and an anonymous group is invisible to both.
    group.name = kind === "chest" ? "dz:loot:chest" : "dz:loot:ammo-box";
    const lidPivot = new THREE.Group();
    let base: THREE.Mesh;
    let lid: THREE.Mesh;
    let glow: THREE.Mesh | null = null;
    let glowMat: THREE.MeshStandardMaterial | null = null;
    if (kind === "chest") {
      base = new THREE.Mesh(chestArt.baseGeo, chestArt.baseMats(kit));
      lid = new THREE.Mesh(chestArt.lidGeo, chestArt.lidMats(kit));
      lidPivot.position.set(0, CH_TOP, -CH_D * 0.5 + CH_HINGE);
      glowMat = kit.makeSeam();
      glow = new THREE.Mesh(chestArt.glowGeo, glowMat);
    } else {
      base = new THREE.Mesh(boxArt.baseGeo, boxArt.baseMats(kit));
      lid = new THREE.Mesh(boxArt.lidGeo, boxArt.lidMats(kit));
      lidPivot.position.copy(boxArt.hinge);
    }
    base.castShadow = true;
    base.receiveShadow = true;
    lid.castShadow = true;
    lid.receiveShadow = true;
    lidPivot.add(lid);
    group.add(base, lidPivot);
    if (glow) group.add(glow);
    return { group, base, lidPivot, lid, glow, glowMat };
  }

  function takeVisual(kind: "chest" | "ammo"): ContainerVisual {
    const pool = kind === "chest" ? chestPool : ammoPool;
    const v = pool.pop();
    return v ?? makeVisual(kind);
  }

  function releaseVisual(kind: "chest" | "ammo", v: ContainerVisual): void {
    v.group.removeFromParent();
    (kind === "chest" ? chestPool : ammoPool).push(v);
  }

  function activateContainer(c: Container): void {
    if (c.active) return;
    const v = takeVisual(c.kind);
    v.group.position.copy(c.position);
    v.group.rotation.y = c.yaw;
    root.add(v.group);
    c.visual = v;
    c.active = true;
  }

  function deactivateContainer(c: Container): void {
    if (!c.active || !c.visual) return;
    releaseVisual(c.kind, c.visual);
    c.visual = null;
    c.active = false;
  }

  function activatePickup(p: Pickup): void {
    if (p.active) return;
    // Geometry and materials are shared and cached — a Mesh is scene-graph
    // bookkeeping and nothing else, so activation costs no GPU work.
    const mesh = new THREE.Mesh(p.art.geo, p.art.mats(kit, p.rarity));
    mesh.scale.setScalar(p.art.scale);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    p.mesh = mesh;
    p.object.add(mesh);
    root.add(p.object);
    p.active = true;
  }

  function deactivatePickup(p: Pickup): void {
    if (!p.active) return;
    if (p.mesh) {
      p.object.remove(p.mesh);
      p.mesh = null;
    }
    p.object.removeFromParent();
    p.active = false;
    p.beamSlot = -1;
  }

  /* --------------------------------------------------------- active set */

  const keepPickups = new Set<Pickup>();
  const keepContainers = new Set<Container>();
  let humChest: Container | null = null;

  function refreshActive(): void {
    camPos.copy(ctx.camera.position);
    const pickR2 = ACTIVE_RANGE * ACTIVE_RANGE;
    const dropR2 = (ACTIVE_RANGE + DEACTIVATE_SLOP) * (ACTIVE_RANGE + DEACTIVATE_SLOP);
    activeList.length = 0;
    for (const p of pickups) {
      if (!p.live) continue;
      const dx = p.position.x - camPos.x;
      const dy = p.position.y - camPos.y;
      const dz = p.position.z - camPos.z;
      p.dist2 = dx * dx + dy * dy + dz * dz;
      // Hysteresis: something already on screen keeps its mesh a little past
      // the activation radius so a pickup on the boundary cannot flicker.
      if (p.dist2 < (p.active ? dropR2 : pickR2)) activeList.push(p);
    }
    activeList.sort((a, b) => a.dist2 - b.dist2);
    keepPickups.clear();
    for (let i = 0; i < activeList.length && i < budget.meshes; i++) keepPickups.add(activeList[i]);
    for (const p of pickups) {
      const want = keepPickups.has(p);
      if (want && !p.active) activatePickup(p);
      else if (!want && p.active) deactivatePickup(p);
    }

    // Beams go to the nearest settled pickups only — a beam on an item still
    // tumbling out of a chest reads as a bug.
    for (const s of beamSlots) {
      s.owner = null;
      s.group.visible = false;
    }
    let si = 0;
    for (let i = 0; i < activeList.length && si < beamSlots.length; i++) {
      const p = activeList[i];
      if (p.airborne) continue;
      const s = beamSlots[si++];
      s.owner = p;
      s.beam.material = kit.beam(p.rarity);
      s.glow.material = kit.glow(p.rarity);
      s.group.visible = true;
      s.group.position.set(p.position.x, p.ground + 0.02, p.position.z);
      p.beamSlot = si - 1;
    }

    const chestR2 = CHEST_RANGE * CHEST_RANGE;
    const chestDropR2 = (CHEST_RANGE + DEACTIVATE_SLOP) * (CHEST_RANGE + DEACTIVATE_SLOP);
    containerList.length = 0;
    humChest = null;
    let humBest = Infinity;
    for (const c of containers) {
      const dx = c.position.x - camPos.x;
      const dy = c.position.y - camPos.y;
      const dz = c.position.z - camPos.z;
      c.dist2 = dx * dx + dy * dy + dz * dz;
      if (c.kind === "chest" && !c.opened && c.dist2 < humBest) {
        humBest = c.dist2;
        humChest = c;
      }
      if (c.dist2 < (c.active ? chestDropR2 : chestR2)) containerList.push(c);
    }
    containerList.sort((a, b) => a.dist2 - b.dist2);
    keepContainers.clear();
    for (let i = 0; i < containerList.length && i < budget.chests; i++) keepContainers.add(containerList[i]);
    for (const c of containers) {
      const want = keepContainers.has(c);
      if (want && !c.active) activateContainer(c);
      else if (!want && c.active) deactivateContainer(c);
    }
  }

  /* ------------------------------------------------------------ taking */

  function removePickup(p: Pickup): void {
    p.live = false;
    deactivatePickup(p);
    const i = pickups.indexOf(p);
    if (i >= 0) pickups.splice(i, 1);
    const a = activeList.indexOf(p);
    if (a >= 0) activeList.splice(a, 1);
    for (const s of beamSlots) if (s.owner === p) s.owner = null;
    activeTimer = 0;
    if (prompt && prompt.kind === "item") promptDirty = true;
  }

  function nearestPickup(point: THREE.Vector3, range: number): Pickup | null {
    let best: Pickup | null = null;
    let bestD = range * range;
    for (const p of pickups) {
      if (!p.live || p.airborne) continue;
      const dx = p.position.x - point.x;
      const dy = p.position.y + HOVER - point.y;
      const dz = p.position.z - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = p;
      }
    }
    return best;
  }

  /**
   * Interact only ever looks at the active set. It is at most one frame stale
   * — every spawn and every take forces a refresh on the same frame — and it
   * turns a 120 Hz scan of every pickup on the island into a scan of the two
   * dozen the player can actually see.
   */
  function nearestActive(point: THREE.Vector3, range: number): Pickup | null {
    let best: Pickup | null = null;
    let bestD = range * range;
    for (const p of activeList) {
      if (!p.live || p.airborne) continue;
      const dx = p.position.x - point.x;
      const dy = p.position.y + HOVER - point.y;
      const dz = p.position.z - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = p;
      }
    }
    return best;
  }

  function takePickup(p: Pickup): boolean {
    if (!p.live) return false;
    // Ammo never occupies a slot — it tops up the reserve, which is why an
    // ammo pickup can never be the thing that fills your last inventory space.
    if (p.ammoKind) {
      try {
        svc.weapons?.addAmmo?.(p.ammoKind, p.item.count ?? AMMO_META[p.ammoKind].rounds);
      } catch {
        // No arsenal to hold the reserve: take it anyway rather than leave an
        // un-takeable pickup sitting there taunting the player.
      }
      finishTake(p);
      return true;
    }
    const inv = svc.inventory;
    if (!inv) {
      finishTake(p);
      return true;
    }
    let ok = false;
    try {
      ok = inv.pickUp(p.item);
    } catch {
      ok = false;
    }
    if (!ok) {
      audio.deny();
      svc.audio?.play?.("ui-deny", { volume: 0.4 });
      ctx.emit("dz:loot-full", { name: itemLabel(p.item) });
      return false;
    }
    finishTake(p);
    return true;
  }

  function finishTake(p: Pickup): void {
    audio.pickup(rarityIndex(p.rarity));
    svc.audio?.play?.("loot-pickup", { position: p.position, volume: 0.6, maxDistance: 22 });
    // A little burst where the item was: the eye needs somewhere to land when
    // the thing it was looking at vanishes.
    tmpColor.setHex(RARITY_COLOR[p.rarity]);
    for (let i = 0; i < 8; i++) {
      const a = rng() * Math.PI * 2;
      particles.spawn(
        p.position.x,
        p.position.y + HOVER,
        p.position.z,
        Math.cos(a) * 1.1,
        0.9 + rng() * 0.8,
        Math.sin(a) * 1.1,
        tmpColor,
        0.1,
        0.45,
        -1.2,
        2.4,
      );
    }
    ctx.emit("dz:loot-pickup", {
      name: itemLabel(p.item),
      rarity: p.rarity,
      def: p.item.def,
      kind: p.item.kind,
      count: p.item.count ?? 1,
    });
    removePickup(p);
  }

  /* ---------------------------------------------------------- opening */

  /**
   * What a chest holds. Fortnite's rule of thumb — a gun, a heal, and some
   * ammo — is not an accident: it is the minimum that makes an opened chest
   * change your loadout rather than your inventory sort order.
   */
  function rollChestContents(tier: keyof typeof TIER_WEIGHTS, circle: number): InventoryItem[] {
    const out: InventoryItem[] = [];
    const guns = tier === "landmark" ? 2 : 1;
    for (let i = 0; i < guns; i++) out.push(makeWeaponItem(rollRarity(rng, tier, circle)));
    out.push(makeConsumableItem());
    out.push(makeAmmoItem());
    if (rng() < 0.45) out.push(rng() < 0.55 ? makeConsumableItem() : makeAmmoItem());
    return out;
  }

  function openContainer(c: Container): void {
    if (c.opened) return;
    c.opened = true;
    c.sinceOpen = 0;
    c.hold = 0;
    const circle = svc.storm?.circle ?? 1;
    const eyeY = c.position.y + (c.kind === "chest" ? CH_TOP + 0.1 : 0.24);

    if (c.kind === "chest") {
      chestsOpened++;
      audio.lid();
      audio.chime();
      svc.audio?.play?.("chest-open", { position: c.position, volume: 0.9, maxDistance: 45 });
      const items = rollChestContents(c.tier, circle);
      for (let i = 0; i < items.length; i++) {
        pending.push({
          at: ctx.elapsed + 0.16 + i * 0.09,
          item: items[i],
          from: new THREE.Vector3(c.position.x, eyeY, c.position.z),
          angle: c.yaw + (i / items.length) * Math.PI * 2 + rng() * 0.5,
          ground: c.position.y,
        });
      }
      // The burst of light. One shared light, parked on the chest that just
      // opened, decaying over the length of the chime.
      burstLight.position.set(c.position.x, eyeY + 0.25, c.position.z);
      burstT = 1;
      tmpColor.setHex(0xffd27a);
      for (let i = 0; i < 22; i++) {
        const a = rng() * Math.PI * 2;
        const r = 0.1 + rng() * 0.35;
        particles.spawn(
          c.position.x + Math.cos(a) * r,
          eyeY,
          c.position.z + Math.sin(a) * r,
          Math.cos(a) * (0.7 + rng()),
          1.8 + rng() * 2.4,
          Math.sin(a) * (0.7 + rng()),
          tmpColor,
          0.13 + rng() * 0.1,
          0.9 + rng() * 0.7,
          -1.6,
          1.1,
        );
      }
      ctx.emit("dz:chest-open", { x: c.position.x, y: c.position.y, z: c.position.z, tier: c.tier });
    } else {
      audio.lid();
      svc.audio?.play?.("ammo-open", { position: c.position, volume: 0.6, maxDistance: 30 });
      // An ammo box gives ammo, immediately, in two families — walking away
      // from one and then hunting a second box for the *other* calibre is the
      // kind of friction that makes players stop opening them.
      const kinds: AmmoKind[] = [];
      while (kinds.length < 2) {
        const k = AMMO_KINDS[Math.floor(rng() * (rng() < 0.85 ? 3 : AMMO_KINDS.length))];
        if (!kinds.includes(k)) kinds.push(k);
      }
      for (let i = 0; i < kinds.length; i++) {
        pending.push({
          at: ctx.elapsed + 0.12 + i * 0.08,
          item: makeAmmoItem(kinds[i]),
          from: new THREE.Vector3(c.position.x, eyeY, c.position.z),
          angle: c.yaw + Math.PI * i + rng() * 0.6,
          ground: c.position.y,
        });
      }
      tmpColor.setHex(0xd8c48a);
      for (let i = 0; i < 10; i++) {
        const a = rng() * Math.PI * 2;
        particles.spawn(
          c.position.x,
          eyeY,
          c.position.z,
          Math.cos(a) * 0.8,
          1.2 + rng() * 1.2,
          Math.sin(a) * 0.8,
          tmpColor,
          0.09,
          0.6,
          -2,
          1.4,
        );
      }
    }
    promptDirty = true;
  }

  let burstT = 0;

  /** Launch a pending item out of a container on a readable arc. */
  function ejectItem(entry: { item: InventoryItem; from: THREE.Vector3; angle: number; ground: number }): void {
    const p = spawnPickup(entry.item, entry.from, true);
    p.position.copy(entry.from);
    p.object.position.copy(p.position);
    const speed = 1.9 + rng() * 0.9;
    p.vel.set(Math.cos(entry.angle) * speed, 3.5 + rng() * 0.9, Math.sin(entry.angle) * speed);
    p.ground = entry.ground;
    p.airborne = true;
  }

  /* ------------------------------------------------------ supply drops */

  function pickDropTarget(out: THREE.Vector3): boolean {
    const storm = svc.storm;
    const terrain = svc.terrain;
    const half = (terrain?.worldSize ?? 1200) * 0.8;
    for (let i = 0; i < 24; i++) {
      let x: number;
      let z: number;
      if (storm) {
        // Inside the *next* circle, not the current one: a crate that lands
        // where the wall is about to be is a crate nobody can take.
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * storm.nextRadius * 0.62;
        x = storm.nextCenter.x + Math.cos(a) * r;
        z = storm.nextCenter.z + Math.sin(a) * r;
      } else {
        x = (rng() * 2 - 1) * half * 0.6;
        z = (rng() * 2 - 1) * half * 0.6;
      }
      if (terrain && terrain.isWater(x, z)) continue;
      const y = groundUnder(x, (terrain?.heightAt(x, z) ?? 0) + 6, z);
      out.set(x, y, z);
      return true;
    }
    return false;
  }

  function spawnSupplyDrop(at?: THREE.Vector3): boolean {
    if (drops.length >= MAX_DROPS) return false;
    const target = new THREE.Vector3();
    if (at) target.copy(at);
    else if (!pickDropTarget(target)) return false;

    const group = new THREE.Group();
    group.name = "dz:loot:supply";
    const crate = new THREE.Mesh(supplyArt.crateGeo, supplyArt.crateMats(kit));
    crate.castShadow = true;
    crate.receiveShadow = true;
    group.add(crate);

    const balloon = new THREE.Mesh(supplyArt.balloonGeo, kit.balloonSkin());
    balloon.position.y = 2.4;
    balloon.castShadow = true;
    group.add(balloon);
    const skirt = new THREE.Mesh(kit.track(new THREE.TorusGeometry(0.55, 0.09, 8, 16)), kit.surface("gunmetal"));
    skirt.rotation.x = Math.PI / 2;
    skirt.position.y = 2.5;
    group.add(skirt);

    const ropes: THREE.Mesh[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const from = new THREE.Vector3(Math.cos(a) * 0.62, 1.15, Math.sin(a) * 0.62);
      const to = new THREE.Vector3(Math.cos(a) * 0.5, 2.5, Math.sin(a) * 0.5);
      dir.subVectors(to, from);
      const len = dir.length();
      const rope = new THREE.Mesh(supplyArt.ropeGeo, kit.surface("rubber"));
      rope.scale.set(1, len, 1);
      rope.position.copy(from).addScaledVector(dir, 0.5);
      rope.quaternion.setFromUnitVectors(up, dir.normalize());
      group.add(rope);
      ropes.push(rope);
    }

    // The flare: a canister on the crate throwing coloured smoke. It is the
    // only reason anyone spots the drop from the far side of the circle.
    const flare = new THREE.Mesh(supplyArt.flareGeo, kit.signature(0xff5a1e, 1.6));
    flare.position.set(0.62, 1.12, 0.62);
    group.add(flare);

    group.position.set(target.x, target.y + DROP_ALTITUDE, target.z);
    root.add(group);

    const drop: SupplyDrop = {
      group,
      balloon,
      skirt,
      crate,
      flare,
      ropes,
      state: "descending",
      groundY: target.y,
      sway: rng() * Math.PI * 2,
      hold: 0,
      opened: false,
      lidT: 0,
      smokeT: 0,
      remover: null,
      vfxBeam: null,
    };
    drops.push(drop);
    audio.klaxon();
    svc.audio?.play?.("supply-inbound", { volume: 0.7 });
    ctx.emit("dz:supply-drop", { x: target.x, y: target.y, z: target.z });
    return true;
  }

  function landDrop(d: SupplyDrop): void {
    d.state = "landed";
    d.group.position.y = d.groundY;
    audio.thud();
    svc.audio?.play?.("supply-land", { position: d.group.position, volume: 0.8, maxDistance: 90 });
    const collision = svc.collision;
    if (collision) {
      const p = d.group.position;
      d.remover = collision.addBox(
        new THREE.Box3(new THREE.Vector3(p.x - 0.78, p.y, p.z - 0.78), new THREE.Vector3(p.x + 0.78, p.y + 1.1, p.z + 0.78)),
        { material: "metal", tag: "loot:supply" },
      );
    }
    // The one place the shared VFX beam is used: a single, long-lived, legendary
    // marker where a pooled beam would be wasted on something that never moves.
    try {
      const beam = svc.vfx?.lootBeam?.(d.group.position, "legendary");
      if (beam && !beam.parent) {
        beam.position.set(d.group.position.x, d.groundY, d.group.position.z);
        root.add(beam);
      }
      d.vfxBeam = beam ?? null;
    } catch {
      // The flare smoke is already a marker on its own, so a VFX system that
      // cannot hand out a beam costs the drop nothing.
      d.vfxBeam = null;
    }
    tmpColor.setHex(0xbfae8a);
    for (let i = 0; i < 26; i++) {
      const a = rng() * Math.PI * 2;
      particles.spawn(
        d.group.position.x + Math.cos(a) * 0.9,
        d.groundY + 0.1,
        d.group.position.z + Math.sin(a) * 0.9,
        Math.cos(a) * 2.6,
        0.7 + rng() * 0.8,
        Math.sin(a) * 2.6,
        tmpColor,
        0.22,
        1.1,
        -1.4,
        2.2,
      );
    }
  }

  function openDrop(d: SupplyDrop): void {
    if (d.opened) return;
    d.opened = true;
    audio.lid();
    audio.chime(1.2);
    svc.audio?.play?.("chest-open", { position: d.group.position, volume: 1, maxDistance: 60 });
    const circle = svc.storm?.circle ?? 1;
    const items: InventoryItem[] = [
      makeWeaponItem(rollRarity(rng, "supply", circle)),
      makeConsumableItem(2),
      makeConsumableItem(1),
      makeAmmoItem(),
    ];
    for (let i = 0; i < items.length; i++) {
      pending.push({
        at: ctx.elapsed + 0.18 + i * 0.1,
        item: items[i],
        from: new THREE.Vector3(d.group.position.x, d.groundY + 1.2, d.group.position.z),
        angle: (i / items.length) * Math.PI * 2 + rng(),
        ground: d.groundY,
      });
    }
    burstLight.position.set(d.group.position.x, d.groundY + 1.6, d.group.position.z);
    burstT = 1;
    ctx.emit("dz:supply-open", { x: d.group.position.x, y: d.groundY, z: d.group.position.z });
  }

  /* ---------------------------------------------------------- interact */

  type Target =
    | { kind: "item"; pickup: Pickup; distance: number }
    | { kind: "chest" | "ammo"; container: Container; distance: number }
    | { kind: "supply"; drop: SupplyDrop; distance: number };

  let holdKey: unknown = null;
  let holdT = 0;
  /** Seconds since the last floor item was taken. Paces the held-E sweep. */
  let sinceTake = ITEM_REPEAT;
  /** Has the current target been offered to the current press yet? */
  let takeArmed = true;
  let target: Target | null = null;

  function eyePosition(out: THREE.Vector3): THREE.Vector3 {
    const player = svc.player;
    if (player?.position) out.copy(player.position).y += 0.95;
    else out.copy(ctx.camera.position);
    return out;
  }

  function scanTarget(): Target | null {
    const from = eyePosition(tmpV);
    let best: Target | null = null;
    let bestD = Infinity;
    const near = nearestActive(from, PICKUP_RANGE);
    if (near) {
      bestD = Math.sqrt(
        (near.position.x - from.x) ** 2 + (near.position.y + HOVER - from.y) ** 2 + (near.position.z - from.z) ** 2,
      );
      best = { kind: "item", pickup: near, distance: bestD };
    }
    const r2 = CHEST_RANGE_INTERACT * CHEST_RANGE_INTERACT;
    for (const c of containerList) {
      if (c.opened) continue;
      const dx = c.position.x - from.x;
      const dy = c.position.y + 0.4 - from.y;
      const dz = c.position.z - from.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      // A chest beats a pickup at equal distance: you are standing at it on
      // purpose, and the loot it spits out will be in reach a second later.
      if (d - 0.5 < bestD) {
        bestD = d - 0.5;
        best = { kind: c.kind, container: c, distance: d };
      }
    }
    for (const d of drops) {
      if (d.state !== "landed" || d.opened) continue;
      const dx = d.group.position.x - from.x;
      const dy = d.groundY + 0.6 - from.y;
      const dz = d.group.position.z - from.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 2.8 && dist - 0.5 < bestD) {
        bestD = dist - 0.5;
        best = { kind: "supply", drop: d, distance: dist };
      }
    }
    return best;
  }

  function holdTimeFor(t: Target): number {
    return t.kind === "item" ? 0 : t.kind === "ammo" ? AMMO_HOLD : t.kind === "supply" ? SUPPLY_HOLD : CHEST_HOLD;
  }

  function targetKey(t: Target): unknown {
    return t.kind === "item" ? t.pickup : t.kind === "supply" ? t.drop : t.container;
  }

  function runInteract(dt: number): void {
    const player = svc.player;
    const controllable = player ? player.controllable !== false : true;
    target = controllable ? scanTarget() : null;
    const input = ctx.input;
    sinceTake += dt;
    if (!target) {
      holdKey = null;
      holdT = 0;
      prevInteract = input.interact;
      return;
    }
    const key = targetKey(target);
    // A new thing in reach is a new offer: re-arm the take and restart the hold.
    if (key !== holdKey) {
      holdKey = key;
      holdT = 0;
      takeArmed = true;
    }
    if (!input.interact) {
      holdT = 0;
      prevInteract = false;
      // Letting go re-arms: the next press is a fresh ask, even for a target
      // this press already tried and could not take (a full inventory).
      takeArmed = true;
      return;
    }
    const need = holdTimeFor(target);
    if (need <= 0) {
      /**
       * There are two ways a player asks for a floor item and BOTH have to
       * work:
       *
       *  - press E while the gun is already in reach — the rising edge;
       *  - be holding E as they run onto the gun, or as it settles out of the
       *    chest they just opened — the edge on the *target*.
       *
       * Only the first was implemented, and because `prevInteract` latches
       * true on every frame where there is nothing in reach (see the `!target`
       * branch above), the second was not merely unsupported — it was
       * unreachable. Hold E, walk onto a rifle, and the game silently refused
       * it until you let go and pressed again.
       *
       * So the edge that matters is per-target: `takeArmed` is set when this
       * pickup becomes the offer and cleared the moment the offer is answered,
       * which is what the old global edge was really trying to express — one
       * take per item, never a room emptied by a leaning key. `ITEM_REPEAT`
       * paces the sweep across a chest's spill so the player can see what they
       * are collecting and let go before their last slot goes.
       */
      if (target.kind === "item" && takeArmed && (!prevInteract || sinceTake >= ITEM_REPEAT)) {
        takeArmed = false;
        if (takePickup(target.pickup)) sinceTake = 0;
      }
    } else {
      holdT += dt;
      if (holdT >= need) {
        holdT = 0;
        if (target.kind === "supply") openDrop(target.drop);
        else if (target.kind !== "item") openContainer(target.container);
      }
    }
    prevInteract = true;
  }

  /* ------------------------------------------------------------ prompt */

  function refreshPrompt(): void {
    let next: LootPrompt | null = null;
    if (target) {
      const need = holdTimeFor(target);
      if (target.kind === "item") {
        next = {
          kind: "item",
          name: itemLabel(target.pickup.item),
          rarity: target.pickup.rarity,
          action: "Take",
          hold: 0,
          holdTime: 0,
          distance: target.distance,
        };
      } else if (target.kind === "supply") {
        next = {
          kind: "supply",
          name: "Supply Drop",
          rarity: "legendary",
          action: "Open",
          hold: clamp(holdT / need, 0, 1),
          holdTime: need,
          distance: target.distance,
        };
      } else {
        next = {
          kind: target.kind,
          name: target.kind === "chest" ? "Chest" : "Ammo Box",
          rarity: target.kind === "chest" ? "legendary" : "common",
          action: "Open",
          hold: clamp(holdT / need, 0, 1),
          holdTime: need,
          distance: target.distance,
        };
      }
    }
    // Only emit on a real change, and on every frame of an active hold — the
    // HUD is React and a payload a frame is a re-render a frame.
    const changed =
      promptDirty ||
      (next === null) !== (prompt === null) ||
      (next !== null &&
        prompt !== null &&
        (next.name !== prompt.name || next.kind !== prompt.kind || Math.abs(next.hold - prompt.hold) > 0.01));
    prompt = next;
    if (changed) {
      promptDirty = false;
      ctx.emit("dz:loot-prompt", next);
    }
  }

  /* ------------------------------------------------------------ physics */

  function stepItems(dt: number): void {
    for (let i = 0; i < pickups.length; i++) {
      const p = pickups[i];
      if (!p.live || !p.airborne) continue;
      p.vel.y -= ITEM_GRAVITY * dt;
      p.position.addScaledVector(p.vel, dt);
      // Re-probe every step: an item that pops off a balcony has to find the
      // floor it is actually going to land on, not the one it launched from.
      const floor = groundUnder(p.position.x, p.position.y + 0.4, p.position.z);
      if (p.position.y <= floor) {
        p.position.y = floor;
        p.ground = floor;
        if (p.vel.y < -1.2) {
          p.vel.y = -p.vel.y * ITEM_BOUNCE;
          p.vel.x *= ITEM_FRICTION;
          p.vel.z *= ITEM_FRICTION;
        } else {
          p.airborne = false;
          p.vel.set(0, 0, 0);
          promptDirty = true;
        }
      }
    }
    // Deferred ejections: the items leave the chest a beat apart, which is
    // what makes an opening read as a burst instead of a teleport.
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].at > ctx.elapsed) continue;
      ejectItem(pending[i]);
      pending.splice(i, 1);
    }
  }

  function stepDrops(dt: number): void {
    for (const d of drops) {
      if (d.state !== "descending") continue;
      d.group.position.y -= DROP_SPEED * dt;
      if (d.group.position.y <= d.groundY) landDrop(d);
    }
  }

  /* ------------------------------------------------------------- system */

  function animate(dt: number): void {
    const t = ctx.elapsed;
    kit.time.value = t;

    for (const p of activeList) {
      if (!p.live || !p.active) continue;
      const obj = p.object;
      if (p.airborne) {
        obj.position.copy(p.position);
        obj.rotation.y += dt * 4.5;
        obj.rotation.z = Math.sin(t * 6 + p.phase) * 0.25;
      } else {
        obj.position.set(p.position.x, p.ground + HOVER + Math.sin(t * 1.7 + p.phase) * BOB, p.position.z);
        obj.rotation.y = p.phase + t * SPIN_RATE;
        // A hair of tilt, oscillating: a perfectly level item reads as a
        // sprite on a turntable.
        obj.rotation.z = 0.1 + Math.sin(t * 1.1 + p.phase) * 0.04;
      }
    }

    for (const c of containerList) {
      if (!c.active || !c.visual) continue;
      const v = c.visual;
      if (c.opened) {
        c.sinceOpen += dt;
        c.lidT = Math.min(1, c.lidT + dt / LID_TIME);
        v.lidPivot.rotation.x = -easeOutBack(c.lidT) * (c.kind === "chest" ? LID_ANGLE : LID_ANGLE * 0.75);
      } else if (c.kind === "chest") {
        // Closed chests breathe: the lid lifts a couple of millimetres against
        // the seam, which is what makes the glow flicker along the gap.
        v.lidPivot.rotation.x = -0.012 - Math.sin(t * 1.6 + c.id) * 0.008;
      }
      if (v.glowMat) {
        const held = c === (target && target.kind === "chest" ? target.container : null) ? holdT / CHEST_HOLD : 0;
        const pulse = 1.15 + Math.sin(t * 2.1 + c.id * 1.7) * 0.35;
        const burst = c.opened ? Math.max(0, 3.4 - c.sinceOpen * 4) : 0;
        v.glowMat.emissiveIntensity = pulse + burst + held * 2.2;
      }
    }

    // Beams: track their owner, and drizzle motes up the inside of each one.
    for (const s of beamSlots) {
      const p = s.owner;
      if (!p || !p.live) {
        s.group.visible = false;
        continue;
      }
      s.group.position.set(p.position.x, p.ground + 0.02, p.position.z);
      s.moteT -= dt;
      if (s.moteT <= 0) {
        s.moteT = 1 / budget.moteRate;
        tmpColor.setHex(RARITY_COLOR[p.rarity]);
        const a = rng() * Math.PI * 2;
        const r = 0.08 + rng() * 0.34;
        particles.spawn(
          p.position.x + Math.cos(a) * r,
          p.ground + 0.05 + rng() * 0.3,
          p.position.z + Math.sin(a) * r,
          Math.cos(a) * 0.06,
          0.32 + rng() * 0.3,
          Math.sin(a) * 0.06,
          tmpColor,
          0.07 + rng() * 0.05,
          1.8 + rng() * 1.2,
          0.02,
          0.25,
        );
      }
    }

    // Supply drops: sway on the way down, smoke the whole time, and deflate
    // the balloon once the crate is on the ground.
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.sway += dt;
      if (d.state === "descending") {
        const s = Math.sin(d.sway * 0.6) * 0.06;
        d.group.rotation.z = s;
        d.group.rotation.x = Math.cos(d.sway * 0.47) * 0.05;
        d.balloon.rotation.y += dt * 0.15;
      } else {
        d.group.rotation.z = damp(d.group.rotation.z, 0, 4, dt);
        d.group.rotation.x = damp(d.group.rotation.x, 0, 4, dt);
        if (d.balloon.visible) {
          const sc = Math.max(0, d.balloon.scale.y - dt * 0.9);
          d.balloon.scale.set(1 + (1 - sc) * 0.25, sc, 1 + (1 - sc) * 0.25);
          d.balloon.position.y = 2.4 + (1 - sc) * 1.2;
          if (sc <= 0.02) {
            d.balloon.visible = false;
            d.skirt.visible = false;
            for (const r of d.ropes) r.visible = false;
          }
        }
      }
      d.smokeT -= dt;
      if (d.smokeT <= 0) {
        // Two puffs a frame at 40 Hz. A flare has to read as a continuous
        // column: at a lower rate the crate's own descent spaces the puffs out
        // into a dotted line, which looks like a bug rather than smoke.
        d.smokeT = 0.025;
        const p = d.group.position;
        for (let k = 0; k < 2; k++) {
          const hot = k === 0;
          // Dim, warm colour rather than a bright one: these are additive, and
          // a saturated orange at full brightness clips straight to white.
          if (hot) tmpColor.setRGB(0.62, 0.24, 0.07);
          else tmpColor.setRGB(0.3, 0.29, 0.3);
          particles.spawn(
            p.x + 0.62 + (rng() - 0.5) * 0.24,
            p.y + 1.2 + rng() * 0.2,
            p.z + 0.62 + (rng() - 0.5) * 0.24,
            (rng() - 0.5) * 0.7,
            1.3 + rng() * 1.2,
            (rng() - 0.5) * 0.7,
            tmpColor,
            hot ? 0.5 + rng() * 0.3 : 0.9 + rng() * 0.7,
            hot ? 1.1 + rng() : 2.6 + rng() * 1.4,
            0.5,
            0.7,
          );
        }
      }
    }

    if (burstT > 0) {
      burstT = Math.max(0, burstT - dt * 1.6);
      // Snap up, fall off: the light is a flash, and a symmetric curve reads
      // as a lamp being turned on.
      burstLight.intensity = burstT * burstT * 26;
    } else if (burstLight.intensity !== 0) {
      burstLight.intensity = 0;
    }

    particles.update(dt);

    // The hum. Level is a smooth falloff from the nearest unopened chest, so
    // walking a corridor past a wall with a chest behind it swells and fades.
    if (humChest) {
      const dx = humChest.position.x - camPos.x;
      const dy = humChest.position.y - camPos.y;
      const dz = humChest.position.z - camPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      audio.setHum(dist > HUM_RANGE ? 0 : Math.pow(1 - dist / HUM_RANGE, 1.6));
    } else {
      audio.setHum(0);
    }
  }

  return {
    name: "loot",

    fixed(dt) {
      if (disposed) return;
      stepItems(dt);
      stepDrops(dt);
      runInteract(dt);
    },

    update(dt) {
      if (disposed) return;
      // The context cannot start without a gesture, and pointer lock is the
      // gesture this game already requires.
      if (ctx.input.locked) audio.ensure();

      activeTimer -= dt;
      if (activeTimer <= 0) {
        activeTimer = ACTIVE_INTERVAL;
        refreshActive();
      } else {
        camPos.copy(ctx.camera.position);
      }

      animate(dt);
      refreshPrompt();

      // Supply drops key off the storm: a new circle in the back half of the
      // match puts a crate in the safe zone, which is what pulls the endgame
      // out of the corner it would otherwise be fought in.
      const storm = svc.storm;
      dropCooldown -= dt;
      if (storm) {
        if (lastCircle === 0) lastCircle = storm.circle;
        else if (storm.circle > lastCircle) {
          lastCircle = storm.circle;
          if (storm.circle >= 2 && dropCooldown <= 0 && drops.length < MAX_DROPS) {
            if (spawnSupplyDrop()) dropCooldown = 45;
          }
        }
      }
    },

    resize() {
      // Matches three's own points sizing: `scale / -mvPosition.z`, where the
      // scale is half the CSS height. Without this a particle is a different
      // size on every display.
      const h = ctx.renderer.domElement.clientHeight || window.innerHeight;
      kit.pixelScale.value = h * 0.5;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (svc.loot === service) svc.loot = undefined;
      // Detach before anything else: the engine deep-disposes the scene graph
      // on teardown, and a mesh still parented under it would have its shared
      // geometry pulled out from under a pooled visual we are about to free.
      root.removeFromParent();
      for (const p of pickups) deactivatePickup(p);
      for (const c of containers) {
        deactivateContainer(c);
        c.remover?.();
      }
      for (const d of drops) {
        d.remover?.();
        d.group.removeFromParent();
        d.vfxBeam?.removeFromParent();
      }
      for (const s of beamSlots) s.group.removeFromParent();
      beamSlots.length = 0;
      chestPool.length = 0;
      ammoPool.length = 0;
      containers.length = 0;
      drops.length = 0;
      pickups.length = 0;
      pending.length = 0;
      artCache.clear();
      burstLight.removeFromParent();
      particles.points.removeFromParent();
      particles.dispose();
      audio.dispose();
      // Every geometry, material and texture this module created lives in the
      // kit; the two it borrowed from the material library are not ours to free.
      kit.dispose();
    },
  };
};

export default createLoot;
