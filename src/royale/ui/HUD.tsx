/**
 * DROP ZERO — the HUD.
 *
 * Everything the player reads while they are alive: vitals, inventory,
 * materials, the minimap and storm block, the crosshair, the feeds, the drop
 * sequence and the two endings.
 *
 * ## How this thing is wired
 *
 * The HUD subscribes to engine events and *only* engine events — it never
 * touches `engine.ctx.services`. Systems come up in boot order and any of
 * them may have failed; an event that never fires just leaves its panel at
 * its initial value, which is the correct failure mode for an overlay.
 *
 * ## Why so much of this is imperative
 *
 * Half of these values change every single frame: health while the storm is
 * eating you, crosshair bloom while you hold the trigger, the storm timer,
 * the minimap. Running React reconciliation at 120 Hz next to a renderer
 * that wants the whole frame budget is how a HUD costs 4 ms.
 *
 * So there are two channels:
 *
 *  - **The live model** (`live.current`) is a plain mutable object that event
 *    handlers write into. A single rAF loop steps its animation state
 *    (bar catch-up, hit-marker decay, map zoom easing) and then calls every
 *    registered painter, which writes straight into DOM nodes it owns via
 *    refs — `style.width`, `style.transform`, `textContent`. No re-render.
 *  - **React state** carries only structural change: which items are in which
 *    slot, feed lines, toasts, the interact prompt, the end cards. Those
 *    change a few times a second at most, and framer-motion animates them.
 *
 * The rule of thumb when adding to this file: if it changes on a timer, it
 * belongs in the live model and a painter. If it changes when the *player
 * does something*, it can be React state.
 *
 * Everything is `pointer-events-none` except the buttons on the end cards
 * and, in water mode, the chat input.
 *
 * ## SPLASH ROYALE (`engine.ctx.mode === "water"`)
 *
 * The same HUD, re-lettered. Health becomes DRYNESS, shield becomes the
 * PONCHO, the magazine becomes a TANK, "eliminated" becomes "soaked" — and
 * three panels appear that classic has no use for: the squad list, the chat
 * box and the room code. Every water label is read from `WATER.strings`;
 * there are no water literals in this file, so re-wording the mode is a
 * one-table edit and not a grep.
 *
 * The mode flag is the only branch. `classic` renders byte-for-byte what it
 * rendered before — every water addition is behind `water &&`, and every
 * shared panel takes `water` as a prop and returns early on the classic path.
 *
 * Two documented exceptions to "engine events only":
 *
 *  - `engine.ctx.mode`, which is a boot-time constant rather than a service.
 *  - `engine.ctx.services.net`, for the squad list and chat. Peer poses move
 *    every frame, so routing them through events would mean an event per
 *    peer per frame. It is null-checked everywhere and the panels simply do
 *    not render when the transport never booted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Engine } from "../engine/core";
import { RARITY_COLOR, type Rarity } from "../types";
import { WATER, drynessBand, fmt } from "../mode/water";
// Type-only, but it also carries the module augmentation that puts `net` on
// `WorldServices` — without this import `ctx.services.net` does not typecheck.
import type { ChatLine, PeerState } from "../net/types";

/* ------------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------------ */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Frame-rate independent exponential approach — the only easing used here. */
const damp = (a: number, b: number, rate: number, dt: number): number =>
  b + (a - b) * Math.exp(-rate * dt);

/**
 * Event payloads arrive as `unknown` and are written by twelve other modules.
 * Every read goes through these so a renamed field degrades to a default
 * instead of throwing inside a listener and killing the whole HUD.
 */
const EMPTY_REC: Record<string, unknown> = {};
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : EMPTY_REC;
const num = (v: unknown, d = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const bool = (v: unknown): boolean => v === true;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const hex = (n: number): string => `#${(n >>> 0).toString(16).padStart(6, "0")}`;
const rgba = (n: number, a: number): string =>
  `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;

const RARITIES: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];
const asRarity = (v: unknown): Rarity => {
  const s = str(v, "common");
  return (RARITIES as string[]).includes(s) ? (s as Rarity) : "common";
};
const rarityNum = (r: Rarity): number => RARITY_COLOR[r] ?? RARITY_COLOR.common;

/** m:ss. Used by the storm timer, the bus clock and the end cards. */
const clockText = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------------ *
 * Palette
 *
 * Deliberately not Tailwind tokens: this HUD sits on top of a saturated
 * outdoor render and needs its own dark, slightly cool neutral so it reads
 * against grass, sand and sky alike.
 * ------------------------------------------------------------------------ */

const INK = "rgba(6,10,20,0.72)";
const INK_SOLID = "rgba(6,10,20,0.9)";
const EDGE = "rgba(255,255,255,0.14)";
/** The 1px light line along the top of every plate — cheap fake bevel. */
const BEVEL = "inset 0 1px 0 rgba(255,255,255,0.16), 0 2px 10px rgba(0,0,0,0.5)";

const HEALTH_A = "#5be36a";
const HEALTH_B = "#2fae43";
const SHIELD_A = "#66ccff";
const SHIELD_B = "#2b8fe0";
const STORM_PURPLE = "#a45cf0";

interface MaterialStyle {
  label: string;
  bright: string;
  deep: string;
}

const MAT_STYLE: Record<"wood" | "stone" | "metal", MaterialStyle> = {
  wood: { label: "Wood", bright: "#d79a56", deep: "#79451e" },
  stone: { label: "Stone", bright: "#cdd3d8", deep: "#6c747b" },
  metal: { label: "Metal", bright: "#9fd8f5", deep: "#4d6f85" },
};

/* ------------------------------------------------------------------------ *
 * SPLASH ROYALE palette
 *
 * Everything here is derived from `mode/water.ts` rather than picked by eye,
 * so the bar, the map ring and the built wall in the world are all the same
 * blue. The one thing invented locally is the *plate*: SPLASH ROYALE's overlay sits
 * on a sunnier render than Drop Zero's, so the panels lighten and pick up a
 * cyan rim instead of the cold near-black.
 * ------------------------------------------------------------------------ */

const W = WATER.strings;
const DOWN = WATER.downpour.palette;

/**
 * The two dryness bands the *screen* effects speak in — the wet rim, the splash
 * arc, the hit marker. Looked up by key rather than by index so re-ordering
 * `DRYNESS_BANDS` can never silently repaint the edge of the frame.
 */
const BAND_DRENCHED = WATER.bands.find((b) => b.key === "drenched")?.color ?? 0x4c9fe0;
const BAND_SOAKED = WATER.bands.find((b) => b.key === "soaked")?.color ?? 0x2a5f96;

const W_INK = "rgba(8,26,44,0.62)";
const W_INK_SOLID = "rgba(8,26,44,0.88)";
const W_EDGE = "rgba(186,236,255,0.26)";
const W_BEVEL =
  "inset 0 1px 0 rgba(255,255,255,0.3), 0 2px 12px rgba(0,24,44,0.45)";

/** The water plate. Same job as `plate`, one shade brighter and cyan-rimmed. */
const wPlate: CSSProperties = {
  background: W_INK,
  border: `1px solid ${W_EDGE}`,
  boxShadow: W_BEVEL,
  backdropFilter: "blur(3px)",
};

/** Pick the plate for the mode. Saves a ternary at twenty call sites. */
const modePlate = (water: boolean): CSSProperties => (water ? wPlate : plate);

/**
 * Squad colours. Bright beach-towel hues, deliberately far apart in hue so
 * three names in a list are told apart at a glance and by the same colour on
 * the map. Assigned by hashing a stable key, so a teammate keeps their colour
 * for the whole match without anyone having to allocate one.
 */
const TEAM_COLORS = [0x5ecfff, 0xffe45e, 0xff5fa2, 0x8affc1, 0xff9f43, 0xc08aff];

/**
 * Mix a colour toward white until it clears a luminance floor.
 *
 * The dryness bands run from cream down to a deep blue, which is exactly
 * right for a *fill* and unreadable as *text* on a dark plate. Every band
 * label goes through this, so "SOAKED THROUGH" stays legible without the
 * band table having to carry a second, UI-only colour.
 */
function lift(c: number, min = 0.66): number {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum >= min) return c;
  const t = (min - lum) / (1 - lum);
  const m = (v: number): number => Math.round(v + (255 - v) * t);
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

function teamColor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TEAM_COLORS[h % TEAM_COLORS.length];
}

/** Material chip styling for water, mirrored straight off `WATER.materials`. */
const W_MAT_STYLE: Record<"wood" | "stone" | "metal", MaterialStyle> = {
  wood: {
    label: W.materials.wood,
    bright: hex(WATER.materials.wood.accent),
    deep: hex(WATER.materials.wood.color),
  },
  stone: {
    label: W.materials.stone,
    bright: hex(WATER.materials.stone.accent),
    deep: hex(WATER.materials.stone.color),
  },
  metal: {
    label: W.materials.metal,
    bright: hex(WATER.materials.metal.accent),
    deep: hex(WATER.materials.metal.color),
  },
};

/* ------------------------------------------------------------------------ *
 * The live model
 * ------------------------------------------------------------------------ */

interface SlotAmmo {
  ammo: number;
  magSize: number;
  reserve: number;
  count: number;
}

interface MaterialGain {
  amount: number;
  /** Seconds of life left on the floating "+N". */
  t: number;
}

interface Live {
  // ---- player (dz:hud) --------------------------------------------------
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  state: string;
  down: number;
  speed: number;
  altitude: number;
  glider: boolean;
  aiming: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;

  // ---- bar catch-up -----------------------------------------------------
  prevHealth: number;
  prevShield: number;
  ghostHealth: number;
  ghostShield: number;
  ghostHoldH: number;
  ghostHoldS: number;

  // ---- weapon / crosshair ----------------------------------------------
  spread: number;
  ads: number;
  scoped: boolean;
  crossHidden: boolean;
  fireKick: number;
  reloading: boolean;
  reloadProgress: number;
  equip: number;

  // ---- feedback ---------------------------------------------------------
  hitT: number;
  hitKind: "hit" | "shield" | "elim";
  hitHead: boolean;
  damageFlash: number;
  healFlash: number;

  // ---- inventory --------------------------------------------------------
  wood: number;
  stone: number;
  metal: number;
  flash: { wood: number; stone: number; metal: number };
  gain: { wood: MaterialGain; stone: MaterialGain; metal: MaterialGain };
  slotAmmo: SlotAmmo[];

  // ---- storm ------------------------------------------------------------
  circle: number;
  stormTimer: number;
  /** Longest timer seen this phase — the only way to get a phase progress. */
  stormTimerMax: number;
  closing: boolean;
  dps: number;
  radius: number;
  nextRadius: number;
  centerX: number;
  centerZ: number;
  nextX: number;
  nextZ: number;
  distToSafe: number;
  inStorm: boolean;
  stormIntensity: number;
  stormVeil: number;

  // ---- match / bus ------------------------------------------------------
  phase: string;
  alive: number;
  eliminations: number;
  busT: number;
  busSecondsLeft: number;
  busX: number;
  busZ: number;
  canJump: boolean;
  jumped: boolean;
  /** Two samples of the bus are enough to reconstruct the whole route line. */
  busSampleT: number;
  busSampleX: number;
  busSampleZ: number;
  busRouteValid: boolean;
  busFromX: number;
  busFromZ: number;
  busToX: number;
  busToZ: number;

  // ---- end-card tallies -------------------------------------------------
  /**
   * The two numbers on the end card that nothing else in the game keeps.
   *
   * `match.ts` is the witness for placement, soakings and time; these two are
   * only ever visible as a stream of events passing through here, so the HUD
   * is the only place that can add them up. Both live in the mutable model
   * rather than in React state because `dz:material` and `dz:damage` fire
   * several times a second in a firefight and neither is drawn until the
   * match is over.
   */
  harvested: number;
  /** Metres to the furthest hit the local player has landed this match. */
  longestShot: number;

  // ---- prompts ----------------------------------------------------------
  promptHold: number;
  consumeT: number;

  // ---- minimap ----------------------------------------------------------
  mapView: number;
  mapCenterX: number;
  mapCenterZ: number;
  /** Rolling clock the minimap uses for dashes and pulses. */
  t: number;

  // ---- SPLASH ROYALE -----------------------------------------------------------
  /**
   * Dryness and poncho, 0..max. These default to `health`/`shield` because
   * the water player rides the same `PlayerService` and publishes the same
   * `dz:hud` payload — the explicit `dry`/`poncho` fields are an override for
   * a system that wants to report them separately, not a requirement.
   */
  dry: number;
  dryMax: number;
  poncho: number;
  ponchoMax: number;
  ghostDry: number;
  ghostPoncho: number;
  ghostHoldD: number;
  ghostHoldP: number;
  /** True while natural drying is actually ticking up. */
  drying: boolean;
  /** True while standing in the Downpour, in the sea, or in a puddle. */
  tooWetToDry: boolean;
  /** A refillable water source is in reach. */
  nearWater: boolean;
  /** Glue strand state, for the struggle prompt. */
  gluedTo: string;
  struggle: number;
}

function makeLive(): Live {
  const slotAmmo: SlotAmmo[] = [];
  for (let i = 0; i < 6; i++) slotAmmo.push({ ammo: 0, magSize: 0, reserve: 0, count: 0 });
  return {
    health: 100,
    maxHealth: 100,
    shield: 0,
    maxShield: 100,
    state: "bus",
    down: 0,
    speed: 0,
    altitude: 0,
    glider: false,
    aiming: false,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,

    prevHealth: 100,
    prevShield: 0,
    ghostHealth: 100,
    ghostShield: 0,
    ghostHoldH: 0,
    ghostHoldS: 0,

    spread: 0,
    ads: 0,
    scoped: false,
    crossHidden: false,
    fireKick: 0,
    reloading: false,
    reloadProgress: 0,
    equip: 1,

    hitT: 0,
    hitKind: "hit",
    hitHead: false,
    damageFlash: 0,
    healFlash: 0,

    wood: 0,
    stone: 0,
    metal: 0,
    flash: { wood: 0, stone: 0, metal: 0 },
    gain: {
      wood: { amount: 0, t: 0 },
      stone: { amount: 0, t: 0 },
      metal: { amount: 0, t: 0 },
    },
    slotAmmo,

    circle: 1,
    stormTimer: 0,
    stormTimerMax: 1,
    closing: false,
    dps: 1,
    radius: 0,
    nextRadius: 0,
    centerX: 0,
    centerZ: 0,
    nextX: 0,
    nextZ: 0,
    distToSafe: -1,
    inStorm: false,
    stormIntensity: 0,
    stormVeil: 0,

    phase: "warmup",
    alive: 100,
    eliminations: 0,
    busT: 0,
    busSecondsLeft: 0,
    busX: 0,
    busZ: 0,
    canJump: false,
    jumped: false,
    busSampleT: -1,
    busSampleX: 0,
    busSampleZ: 0,
    busRouteValid: false,
    busFromX: 0,
    busFromZ: 0,
    busToX: 0,
    busToZ: 0,

    harvested: 0,
    longestShot: 0,

    promptHold: 0,
    consumeT: 0,

    mapView: 1200,
    mapCenterX: 0,
    mapCenterZ: 0,
    t: 0,

    dry: WATER.dryness.max,
    dryMax: WATER.dryness.max,
    poncho: 0,
    ponchoMax: WATER.dryness.ponchoMax,
    ghostDry: WATER.dryness.max,
    ghostPoncho: 0,
    ghostHoldD: 0,
    ghostHoldP: 0,
    drying: false,
    tooWetToDry: false,
    nearWater: false,
    gluedTo: "",
    struggle: 0,
  };
}

/** Seconds the damage ghost sits still before it starts chasing the bar. */
const GHOST_HOLD = 0.32;
/** Ghost drain, in fractions of the full bar per second. */
const GHOST_RATE = 0.55;

/** One step of everything in the live model that animates on its own. */
function stepLive(l: Live, dt: number): void {
  l.t += dt;

  // Vitals catch-up. The bar itself is instant — you must see the damage the
  // frame it lands — and the paler ghost behind it is what tells you *how
  // much* you just lost.
  if (l.health < l.prevHealth) l.ghostHoldH = GHOST_HOLD;
  if (l.shield < l.prevShield) l.ghostHoldS = GHOST_HOLD;
  l.prevHealth = l.health;
  l.prevShield = l.shield;

  if (l.ghostHealth > l.health) {
    if (l.ghostHoldH > 0) l.ghostHoldH -= dt;
    else l.ghostHealth = Math.max(l.health, l.ghostHealth - dt * GHOST_RATE * l.maxHealth);
  } else l.ghostHealth = l.health;

  if (l.ghostShield > l.shield) {
    if (l.ghostHoldS > 0) l.ghostHoldS -= dt;
    else l.ghostShield = Math.max(l.shield, l.ghostShield - dt * GHOST_RATE * l.maxShield);
  } else l.ghostShield = l.shield;

  // The dryness pair runs the same catch-up. It is stepped unconditionally
  // rather than behind a mode check because it costs eight comparisons and a
  // mode branch in the hot loop would cost about the same.
  if (l.ghostDry > l.dry) {
    if (l.ghostHoldD > 0) l.ghostHoldD -= dt;
    else l.ghostDry = Math.max(l.dry, l.ghostDry - dt * GHOST_RATE * l.dryMax);
  } else {
    // Caught up (or drying back off). Re-prime the hold here rather than
    // tracking a `prevDry`, so the next soak still gets its full pause.
    l.ghostDry = l.dry;
    l.ghostHoldD = GHOST_HOLD;
  }
  if (l.ghostPoncho > l.poncho) {
    if (l.ghostHoldP > 0) l.ghostHoldP -= dt;
    else l.ghostPoncho = Math.max(l.poncho, l.ghostPoncho - dt * GHOST_RATE * l.ponchoMax);
  } else l.ghostPoncho = l.poncho;

  // Firing bloom decays faster than it builds so the crosshair snaps shut the
  // instant you stop — a slow close reads as input lag.
  l.fireKick = Math.max(0, l.fireKick - dt * 3.4);
  l.hitT = Math.max(0, l.hitT - dt * 2.6);
  l.damageFlash = Math.max(0, l.damageFlash - dt * 2.2);
  l.healFlash = Math.max(0, l.healFlash - dt * 1.6);

  for (const k of ["wood", "stone", "metal"] as const) {
    l.flash[k] = Math.max(0, l.flash[k] - dt * 2.2);
    if (l.gain[k].t > 0) l.gain[k].t = Math.max(0, l.gain[k].t - dt);
  }

  // The purple veil eases both ways; a hard cut on the storm edge looks like
  // a bug and you cross that edge constantly.
  l.stormVeil = damp(l.stormVeil, l.inStorm ? clamp01(0.35 + l.stormIntensity) : 0, 3.4, dt);

  // Minimap framing: the whole island while you are choosing where to drop,
  // a local window once you are on the ground and reading fights.
  const wide = l.phase === "warmup" || l.phase === "bus" || l.phase === "dropping";
  const targetView = wide ? 1250 : 560;
  l.mapView = damp(l.mapView, targetView, 2.2, dt);
  const targetX = wide ? 0 : l.x;
  const targetZ = wide ? 0 : l.z;
  l.mapCenterX = damp(l.mapCenterX, targetX, 9, dt);
  l.mapCenterZ = damp(l.mapCenterZ, targetZ, 9, dt);
}

/* ------------------------------------------------------------------------ *
 * Painter registry
 * ------------------------------------------------------------------------ */

type Painter = (dt: number) => void;

/**
 * One rAF loop for the whole HUD. Panels register a painter on mount and drop
 * it on unmount; a painter that throws is removed rather than allowed to take
 * the frame down with it.
 */
class HudClock {
  private painters = new Set<Painter>();

  add(p: Painter): () => void {
    this.painters.add(p);
    return () => {
      this.painters.delete(p);
    };
  }

  tick(dt: number): void {
    for (const p of [...this.painters]) {
      try {
        p(dt);
      } catch (err) {
        console.error("[Drop Zero] HUD painter failed; dropping it", err);
        this.painters.delete(p);
      }
    }
  }
}

/** Register a painter for the lifetime of a component. */
function usePainter(clock: HudClock, paint: Painter): void {
  const ref = useRef(paint);
  ref.current = paint;
  useEffect(() => clock.add((dt) => ref.current(dt)), [clock]);
}

/* ------------------------------------------------------------------------ *
 * React-side state shapes
 * ------------------------------------------------------------------------ */

interface SlotMeta {
  index: number;
  hasItem: boolean;
  name: string;
  rarity: Rarity;
  color: number;
  icon: string;
  kind: string;
  active: boolean;
  isWeapon: boolean;
}

interface FeedEntry {
  id: number;
  killer: string;
  victim: string;
  weapon: string;
  byPlayer: boolean;
  onPlayer: boolean;
  environmental: boolean;
  born: number;
}

interface ToastEntry {
  id: number;
  text: string;
  sub: string;
  tone: "info" | "urgent" | "elim";
  born: number;
}

interface PickupEntry {
  id: number;
  name: string;
  rarity: Rarity;
  count: number;
  bad: boolean;
  born: number;
}

interface DamageArc {
  id: number;
  /** Bearing to the shooter relative to the look direction, radians. */
  angle: number;
  amount: number;
  born: number;
}

interface PromptState {
  kind: string;
  name: string;
  action: string;
  rarity: Rarity;
  hold: boolean;
}

interface Ending {
  kind: "victory" | "eliminated";
  placement: number;
  eliminations: number;
  matchTime: number;
  lobby: number;
  killer: string;
  weapon: string;
  /** True when it was the Downpour/the storm and there is nobody to name. */
  environmental: boolean;
  /** How many were still in it when the player let go of the bus. */
  aliveAtDrop: number;
  /** Metres to the furthest hit the player landed. 0 = they never hit anyone. */
  longestShot: number;
  /** Every unit of wood/stone/metal they swung a pickaxe for. */
  harvested: number;
}

interface MapPad {
  name: string;
  x: number;
  z: number;
}

interface MapModel {
  worldSize: number;
  pads: MapPad[];
  islandR: number;
  /** Coast radius per angular bin, world metres. */
  coast: Float32Array;
  /** Road-ish links between pads, as index pairs. */
  links: [number, number][];
}

const emptySlots = (): SlotMeta[] => {
  const out: SlotMeta[] = [];
  for (let i = 0; i < 6; i++) {
    out.push({
      index: i,
      hasItem: i === 0,
      name: i === 0 ? "Pickaxe" : "",
      rarity: "common",
      color: RARITY_COLOR.common,
      icon: "",
      kind: i === 0 ? "pickaxe" : "",
      active: i === 0,
      isWeapon: false,
    });
  }
  return out;
};

/* ------------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------------ */

/** A squadmate as the panel needs them — identity only; numbers are painted. */
interface SquadMate {
  id: string;
  name: string;
  agent: boolean;
  color: number;
}

export default function HUD({ engine, locked }: { engine: Engine; locked: boolean }) {
  const live = useRef<Live>(makeLive());
  const clock = useMemo(() => new HudClock(), []);
  const nextId = useRef(1);

  /** SPLASH ROYALE or Drop Zero. Fixed at boot, so it is safe to read once. */
  const water = engine.ctx.mode === "water";

  const [slots, setSlots] = useState<SlotMeta[]>(emptySlots);
  const [phase, setPhase] = useState("warmup");
  const [playerState, setPlayerState] = useState("bus");
  const [scoped, setScoped] = useState(false);
  const [inStorm, setInStorm] = useState(false);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [pickups, setPickups] = useState<PickupEntry[]>([]);
  const [arcs, setArcs] = useState<DamageArc[]>([]);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [consume, setConsume] = useState<{ name: string } | null>(null);
  const [ending, setEnding] = useState<Ending | null>(null);
  const [canRestart, setCanRestart] = useState(false);
  const [map, setMap] = useState<MapModel | null>(null);


  /* ---- the frame loop -------------------------------------------------- */

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // Same clamp the engine uses: a backgrounded tab must not deliver a
      // ten-second dt and snap every eased value to its target at once.
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      stepLive(live.current, dt);
      clock.tick(dt);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  /* ---- expiry sweep ---------------------------------------------------- */

  useEffect(() => {
    // One timer for every transient list. Each sweep only calls setState when
    // something actually left, so an idle HUD re-renders zero times a second.
    const id = window.setInterval(() => {
      const now = performance.now();
      setFeed((f) => (f.some((e) => now - e.born > 7000) ? f.filter((e) => now - e.born <= 7000) : f));
      setToasts((t) => (t.some((e) => now - e.born > 3400) ? t.filter((e) => now - e.born <= 3400) : t));
      setPickups((p) => (p.some((e) => now - e.born > 3800) ? p.filter((e) => now - e.born <= 3800) : p));
      setArcs((a) => (a.some((e) => now - e.born > 1400) ? a.filter((e) => now - e.born <= 1400) : a));
    }, 300);
    return () => window.clearInterval(id);
  }, []);

  /* ---- engine subscriptions -------------------------------------------- */

  useEffect(() => {
    const l = live.current;
    const offs: (() => void)[] = [];
    const on = (event: string, fn: (p: unknown) => void) => offs.push(engine.on(event, fn));
    // Read once here rather than closing over the render-scope `water`, so
    // this effect keeps `[engine]` as its only dependency.
    const isWater = engine.ctx.mode === "water";

    // Signatures let a payload that fires every frame drive React state only
    // when the part React cares about actually changed.
    let slotSig = "";
    let stateSig = "";
    let phaseSig = "";
    let scopeSig = false;
    let stormSig = false;
    let promptSig = "";
    let consumeSig = "";
    let glueSig = false;
    let lastPickup = { name: "", at: 0 };

    on("dz:hud", (p) => {
      const d = rec(p);
      l.health = num(d.health, l.health);
      l.maxHealth = Math.max(1, num(d.maxHealth, l.maxHealth));
      l.shield = num(d.shield, l.shield);
      l.maxShield = Math.max(1, num(d.maxShield, l.maxShield));
      l.down = num(d.down, 0);
      l.speed = num(d.speed, 0);
      l.altitude = num(d.altitude, 0);
      l.glider = bool(d.glider);
      l.aiming = bool(d.aiming);
      l.x = num(d.x, l.x);
      l.y = num(d.y, l.y);
      l.z = num(d.z, l.z);
      l.yaw = num(d.yaw, l.yaw);
      const s = str(d.state, l.state);
      l.state = s;
      if (s !== stateSig) {
        stateSig = s;
        setPlayerState(s);
      }
      // Water vitals. Defaulting off health/shield means the dryness meter is
      // live the moment SPLASH ROYALE boots, whether or not the player system has
      // started publishing the water-specific fields yet.
      l.dry = num(d.dry, l.health);
      l.dryMax = Math.max(1, num(d.maxDry, l.maxHealth));
      l.poncho = num(d.poncho, l.shield);
      l.ponchoMax = Math.max(1, num(d.maxPoncho, l.maxShield));
      l.drying = bool(d.drying);
      l.tooWetToDry = bool(d.tooWetToDry) || bool(d.inRain);
      l.nearWater = bool(d.nearWater);
    });

    on("dz:inventory", (p) => {
      const d = rec(p);
      l.wood = num(d.wood, l.wood);
      l.stone = num(d.stone, l.stone);
      l.metal = num(d.metal, l.metal);
      l.flash.wood = Math.max(l.flash.wood, num(d.flashWood));
      l.flash.stone = Math.max(l.flash.stone, num(d.flashStone));
      l.flash.metal = Math.max(l.flash.metal, num(d.flashMetal));
      l.equip = num(d.equip, 1);

      const raw = list(d.slots);
      const active = Math.round(num(d.activeSlot, 0));
      let sig = `${active}`;
      const metas: SlotMeta[] = [];
      for (let i = 0; i < 6; i++) {
        const v = rec(raw[i]);
        const ammo = l.slotAmmo[i];
        ammo.ammo = Math.round(num(v.ammo));
        ammo.magSize = Math.round(num(v.magSize));
        ammo.reserve = Math.round(num(v.reserve));
        ammo.count = Math.round(num(v.count));
        const kind = str(v.kind);
        const hasItem = kind !== "" || i === 0;
        const rarity = asRarity(v.rarity);
        const name = str(v.name, i === 0 ? "Pickaxe" : "");
        metas.push({
          index: i,
          hasItem,
          name,
          rarity,
          // A payload that forgot its colour still gets the canonical one —
          // a black slot background reads as a bug, not as "common".
          color: Math.round(num(v.color, 0)) || rarityNum(rarity),
          icon: str(v.icon),
          kind: kind || (i === 0 ? "pickaxe" : ""),
          active: i === active,
          isWeapon: kind === "weapon",
        });
        sig += `|${kind}:${name}:${rarity}:${str(v.icon).length}`;
      }
      if (sig !== slotSig) {
        slotSig = sig;
        setSlots(metas);
      }
    });

    on("dz:material", (p) => {
      const d = rec(p);
      const kind = str(d.kind, "wood");
      if (kind !== "wood" && kind !== "stone" && kind !== "metal") return;
      const amount = Math.round(num(d.amount));
      if (amount <= 0) return;
      l.wood = kind === "wood" ? num(d.total, l.wood) : l.wood;
      l.stone = kind === "stone" ? num(d.total, l.stone) : l.stone;
      l.metal = kind === "metal" ? num(d.total, l.metal) : l.metal;
      l.flash[kind] = 1;
      l.harvested += amount;
      // Stack rapid harvest ticks into one floating number instead of racing
      // two "+15"s past each other — a pickaxe swing lands three of these.
      const gain = l.gain[kind];
      gain.amount = gain.t > 0.45 ? gain.amount + amount : amount;
      gain.t = 0.9;
    });

    on("dz:weapon", (p) => {
      const d = rec(p);
      l.reloading = bool(d.reloading);
      l.reloadProgress = clamp01(num(d.reloadProgress));
    });

    on("dz:crosshair", (p) => {
      const d = rec(p);
      l.spread = clamp01(num(d.spread));
      l.ads = clamp01(num(d.ads));
      l.crossHidden = bool(d.hidden);
      const sc = bool(d.scoped);
      l.scoped = sc;
      if (sc !== scopeSig) {
        scopeSig = sc;
        setScoped(sc);
      }
    });

    on("dz:shot", () => {
      // Bloom kick is capped: full-auto must not park the crosshair wide open
      // for as long as you hold the trigger, or it stops meaning anything.
      l.fireKick = Math.min(1, l.fireKick + 0.4);
    });

    on("dz:hitmarker", (p) => {
      const d = rec(p);
      const kind = str(d.kind, "hit");
      l.hitKind = kind === "elim" ? "elim" : kind === "shield" ? "shield" : "hit";
      l.hitHead = bool(d.headshot);
      l.hitT = 1;
    });

    on("dz:hit", (p) => {
      const d = rec(p);
      const amount = num(d.amount);
      l.damageFlash = Math.min(1, l.damageFlash + clamp01(amount / 45));
      setArcs((a) => {
        const next = a.slice(-4);
        next.push({ id: nextId.current++, angle: num(d.angle), amount, born: performance.now() });
        return next;
      });
    });

    on("dz:heal", () => {
      l.healFlash = 1;
    });

    /*
     * Longest shot.
     *
     * `dz:damage` is fired for EVERY routed hit in the match — bots shooting
     * each other included — and carries the impact point plus who fired, so
     * the `by === "player"` filter is not optional; without it the end card
     * would proudly report the longest shot somebody else took.
     *
     * The range is measured from the position `dz:hud` last published, which
     * is the same frame's player position: both events are emitted inside one
     * fixed step, so the two are never more than one step apart. The 1200 m
     * ceiling is a sanity guard, not a rule — the island is 3 km across, so a
     * larger number means a payload arrived without coordinates and we are
     * measuring the distance from the player to the world origin.
     */
    on("dz:damage", (p) => {
      const d = rec(p);
      if (str(d.by) !== "player") return;
      const dist = Math.hypot(num(d.x) - l.x, num(d.y) - l.y, num(d.z) - l.z);
      if (dist > l.longestShot && dist < 1200) l.longestShot = dist;
    });

    on("dz:storm", (p) => {
      const d = rec(p);
      const circle = Math.round(num(d.circle, l.circle));
      const closing = bool(d.closing);
      const timer = num(d.timer);
      if (circle !== l.circle || closing !== l.closing) l.stormTimerMax = Math.max(1, timer);
      l.stormTimerMax = Math.max(l.stormTimerMax, timer);
      l.circle = circle;
      l.closing = closing;
      l.stormTimer = timer;
      l.dps = num(d.dps, l.dps);
      l.radius = num(d.radius, l.radius);
      l.nextRadius = num(d.nextRadius, l.nextRadius);
      l.centerX = num(d.centerX, l.centerX);
      l.centerZ = num(d.centerZ, l.centerZ);
      l.nextX = num(d.nextX, l.nextX);
      l.nextZ = num(d.nextZ, l.nextZ);
      l.distToSafe = num(d.distToSafe, l.distToSafe);
      l.stormIntensity = clamp01(num(d.intensity));
      const now = bool(d.inStorm);
      l.inStorm = now;
      if (now !== stormSig) {
        stormSig = now;
        setInStorm(now);
      }
    });

    on("dz:storm-phase", (p) => {
      const d = rec(p);
      const circle = Math.round(num(d.circle, 1));
      const closing = bool(d.closing);
      l.stormTimerMax = 1;
      if (isWater) {
        pushToast(
          closing ? W.stormWarn : `${W.stormName} ${circle}`,
          closing ? `${W.stormName} ${circle}` : W.stormSafe,
          "urgent",
        );
      } else {
        pushToast(
          closing ? "The storm is closing" : `Zone ${circle} incoming`,
          closing ? `Zone ${circle}` : "Move to the safe area",
          "urgent",
        );
      }
    });

    on("dz:storm-warn", (p) => {
      const d = rec(p);
      const seconds = Math.round(num(d.seconds));
      if (seconds > 0 && seconds <= 30) {
        pushToast(
          isWater ? fmt(W.stormClosing, { t: `${seconds}s` }) : `Storm closes in ${seconds}s`,
          "",
          "urgent",
        );
      }
    });

    on("dz:in-storm", (p) => {
      const d = rec(p);
      l.dps = num(d.dps, l.dps);
    });

    on("dz:match", (p) => {
      const d = rec(p);
      l.alive = Math.round(num(d.alive, l.alive));
      l.eliminations = Math.round(num(d.eliminations, l.eliminations));
      const ph = str(d.phase, l.phase);
      l.phase = ph;
      if (ph !== phaseSig) {
        phaseSig = ph;
        setPhase(ph);
      }
    });

    on("dz:bus", (p) => {
      const d = rec(p);
      l.busT = clamp01(num(d.t));
      l.busSecondsLeft = num(d.secondsLeft);
      l.busX = num(d.x, l.busX);
      l.busZ = num(d.z, l.busZ);
      l.canJump = bool(d.canJump);
      l.jumped = bool(d.jumped);
      l.alive = Math.round(num(d.alive, l.alive));
      const ph = str(d.phase, l.phase);
      l.phase = ph;
      if (ph !== phaseSig) {
        phaseSig = ph;
        setPhase(ph);
      }
      // The bus route is never published as a service the HUD may read, but
      // two samples of a straight line define it — take the first and one a
      // decent distance later, then extrapolate to t=0 and t=1 for the map.
      if (l.busSampleT < 0 && l.busT >= 0) {
        l.busSampleT = l.busT;
        l.busSampleX = l.busX;
        l.busSampleZ = l.busZ;
      } else if (!l.busRouteValid && l.busT - l.busSampleT > 0.05) {
        const span = l.busT - l.busSampleT;
        const dx = (l.busX - l.busSampleX) / span;
        const dz = (l.busZ - l.busSampleZ) / span;
        l.busFromX = l.busSampleX - dx * l.busSampleT;
        l.busFromZ = l.busSampleZ - dz * l.busSampleT;
        l.busToX = l.busFromX + dx;
        l.busToZ = l.busFromZ + dz;
        l.busRouteValid = true;
      }
    });

    on("dz:announce", (p) => {
      const d = rec(p);
      const text = str(d.text);
      if (text) pushToast(text, "", str(d.tone) === "urgent" ? "urgent" : "info");
    });

    on("dz:eliminate", (p) => {
      const d = rec(p);
      const killer = str(d.killer, str(d.byName, str(d.by, "Someone")));
      const victim = str(d.victim, str(d.victimName, "Someone"));
      const byPlayer = bool(d.byPlayer);
      const onPlayer = bool(d.onPlayer);
      const alive = num(d.alive, l.alive);
      if (alive > 0) l.alive = Math.round(alive);
      setFeed((f) => {
        const next = f.slice(-4);
        next.push({
          id: nextId.current++,
          killer: byPlayer ? "You" : killer,
          victim: onPlayer ? "You" : victim,
          weapon: str(d.weapon),
          byPlayer,
          onPlayer,
          environmental: bool(d.environmental),
          born: performance.now(),
        });
        return next;
      });
      if (byPlayer && !onPlayer) {
        l.eliminations += 1;
        if (isWater) {
          pushToast(
            fmt(W.eliminatedFeed, { by: "You", name: victim }),
            `${l.eliminations} ${W.elimsLabel}`,
            "elim",
          );
        } else {
          pushToast(
            `${victim} eliminated`,
            `${l.eliminations} elimination${l.eliminations === 1 ? "" : "s"}`,
            "elim",
          );
        }
      }
    });

    on("dz:pickup", (p) => {
      const d = rec(p);
      pushPickup(str(d.name), asRarity(d.rarity), Math.round(num(d.count, 1)), false);
    });

    on("dz:loot-pickup", (p) => {
      const d = rec(p);
      pushPickup(str(d.name), asRarity(d.rarity), Math.round(num(d.count, 1)), false);
    });

    on("dz:loot-full", (p) => {
      const d = rec(p);
      pushPickup(str(d.name, "Inventory"), "common", 1, true);
    });

    on("dz:loot-prompt", (p) => {
      if (p === null || p === undefined) {
        l.promptHold = 0;
        if (promptSig !== "") {
          promptSig = "";
          setPrompt(null);
        }
        return;
      }
      const d = rec(p);
      l.promptHold = clamp01(num(d.hold));
      const kind = str(d.kind, "item");
      const name = str(d.name);
      const action = str(d.action, "Take");
      const sig = `${kind}|${name}|${action}`;
      if (sig !== promptSig) {
        promptSig = sig;
        setPrompt({
          kind,
          name,
          action,
          rarity: asRarity(d.rarity),
          hold: num(d.holdTime) > 0.05,
        });
      }
    });

    on("dz:consume", (p) => {
      const d = rec(p);
      l.consumeT = clamp01(num(d.t));
      const active = bool(d.active);
      const name = active ? str(d.name) : "";
      if (name !== consumeSig) {
        consumeSig = name;
        setConsume(name ? { name } : null);
      }
    });

    on("dz:victory", (p) => {
      const d = rec(p);
      const lobby = Math.round(num(d.lobby, 100));
      setEnding({
        kind: "victory",
        placement: 1,
        eliminations: Math.round(num(d.eliminations, l.eliminations)),
        matchTime: num(d.matchTime),
        lobby,
        killer: "",
        weapon: "",
        environmental: false,
        aliveAtDrop: Math.round(num(d.aliveAtDrop, lobby)),
        longestShot: l.longestShot,
        harvested: l.harvested,
      });
    });

    on("dz:eliminated", (p) => {
      const d = rec(p);
      const lobby = Math.round(num(d.lobby, 100));
      setEnding({
        kind: "eliminated",
        placement: Math.round(num(d.placement, l.alive)),
        eliminations: Math.round(num(d.eliminations, l.eliminations)),
        matchTime: num(d.matchTime),
        lobby,
        killer: str(d.killer, "the storm"),
        weapon: str(d.weapon),
        // Absent payload means an older `match.ts`; "no named killer" is the
        // safer read, because naming the storm as a person is the worse miss.
        environmental: d.environmental === undefined ? !str(d.killer) : bool(d.environmental),
        aliveAtDrop: Math.round(num(d.aliveAtDrop, lobby)),
        longestShot: l.longestShot,
        harvested: l.harvested,
      });
    });

    on("dz:restart-available", () => {
      // The island, loot table and storm are baked once at boot; match.ts
      // says so in the payload. A rematch is a route reload, nothing clever —
      // and the button reloads whatever the method field says, so an
      // unrecognised method can never leave the card with a dead control.
      setCanRestart(true);
    });

    on("dz:terrain-ready", (p) => {
      const d = rec(p);
      const pads: MapPad[] = [];
      for (const raw of list(d.pads)) {
        const pd = rec(raw);
        const name = str(pd.name);
        if (!name) continue;
        pads.push({ name, x: num(pd.x), z: num(pd.z) });
      }
      setMap(buildMapModel(num(d.worldSize, 1500), pads));
    });

    // ---- SPLASH ROYALE ---------------------------------------------------------
    // Dormant in classic: `dz:glue` is never emitted there, so the prompt
    // never mounts and this handler never runs.
    on("dz:glue", (p) => {
      const d = rec(p);
      const active = bool(d.active);
      l.gluedTo = active ? str(d.name, "?") : "";
      l.struggle = clamp01(num(d.struggle, num(d.progress)));
      // `dz:glue` may well fire every frame while the strand is live; only
      // the edge into "glued" is worth a toast.
      if (active !== glueSig) {
        glueSig = active;
        if (active) pushToast(W.glued, fmt(W.gluePrompt, { key: WATER.glue.struggleKey }), "urgent");
      }
    });

    on("dz:stumble", () => {
      if (isWater) pushToast(W.stumbled, "", "urgent");
    });

    function pushToast(text: string, sub: string, tone: "info" | "urgent" | "elim"): void {
      setToasts((t) => {
        const next = t.slice(-2);
        next.push({ id: nextId.current++, text, sub, tone, born: performance.now() });
        return next;
      });
    }

    function pushPickup(name: string, rarity: Rarity, count: number, bad: boolean): void {
      if (!name) return;
      const now = performance.now();
      // Ground loot fires both `dz:loot-pickup` (the world lost an item) and
      // `dz:pickup` (the bag gained one). One line, not two.
      if (lastPickup.name === name && now - lastPickup.at < 300) return;
      lastPickup = { name, at: now };
      setPickups((p) => {
        const next = p.slice(-3);
        next.push({ id: nextId.current++, name, rarity, count, bad, born: now });
        return next;
      });
    }

    return () => {
      for (const off of offs) off();
    };
  }, [engine]);

  /*
   * "Drop again".
   *
   * There is no in-place rematch — `match.ts` says so in the payload and
   * explains why: the island, the loot table and the storm are all built once
   * at boot, and reloading the route rebuilds them in about a second. So this
   * reloads, and it does it UNCONDITIONALLY.
   *
   * The previous version was `if (needsReload) window.location.reload()`,
   * which meant the one interactive control on the end card silently did
   * nothing for any restart method other than "reload" — including the case
   * where the payload arrived without a method at all. A button that no-ops
   * is worse than one that is not there: the player presses it twice and then
   * goes and closes the tab. Reload is the fallback for everything; a real
   * in-place restart, when there is one, gets its own branch above it.
   */
  const restart = useCallback(() => {
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  const dropping = phase === "warmup" || phase === "bus" || phase === "dropping";

  return (
    <>
      {/* The end card owns the screen: leaving a live HUD under a victory
          headline is the single cheapest-looking thing a BR can do. */}
      {locked && !ending && (
        <div className="pointer-events-none absolute inset-0 z-20 select-none font-body text-white">
          <Vignettes clock={clock} live={live} water={water} />
          <Crosshair clock={clock} live={live} />
          <HitMarker clock={clock} live={live} water={water} />
          <DamageArcs arcs={arcs} water={water} />
          <AnimatePresence>{scoped && <ScopeOverlay key="scope" water={water} />}</AnimatePresence>

          <div className="absolute bottom-6 left-6 flex flex-col gap-2">
            {water ? (
              <DrynessMeter clock={clock} live={live} />
            ) : (
              <Vitals clock={clock} live={live} />
            )}
          </div>

          <div className="absolute bottom-6 right-6 flex flex-col items-end gap-2">
            <ConsumeBar clock={clock} live={live} consume={consume} />
            {water && <TankStatus clock={clock} live={live} slots={slots} />}
            <MaterialsRow clock={clock} live={live} water={water} />
            <InventoryBar clock={clock} live={live} slots={slots} water={water} />
          </div>

          <div className="absolute right-6 top-5 flex w-[236px] flex-col items-stretch gap-2">
            <Minimap clock={clock} live={live} map={map} water={water} />
            <StormPanel clock={clock} live={live} water={water} />
            <AliveBlock clock={clock} live={live} water={water} />
            <KillFeed feed={feed} water={water} />
          </div>

          {/* Clear of the app's HomeButton, which is pinned at left-3 top-3
              and is 40 px tall — the one piece of global chrome a chromeless
              world still gets. */}
          {water && (
            <div className="absolute left-6 top-[58px] flex w-[228px] flex-col items-stretch gap-2">
              <RoomCode engine={engine} />
              <SquadPanel clock={clock} live={live} engine={engine} />
            </div>
          )}

          <ToastStack toasts={toasts} water={water} />
          <PickupLog pickups={pickups} water={water} />
          <InteractPrompt clock={clock} live={live} prompt={prompt} />
          {water && <GluePrompt clock={clock} live={live} />}
          {dropping && <DropOverlay clock={clock} live={live} phase={phase} playerState={playerState} />}
          <StormBanner inStorm={inStorm} clock={clock} live={live} water={water} />
        </div>
      )}

      {/* Chat lives OUTSIDE the `locked` gate on purpose. The page unmounts
          the rest of the HUD the moment pointer lock drops, and a chat box
          that vanishes when you look away from the game is not a chat box. */}
      {water && !ending && <ChatPanel engine={engine} />}

      <AnimatePresence>
        {ending && (
          <EndCard
            key={ending.kind}
            ending={ending}
            canRestart={canRestart}
            onRestart={restart}
            water={water}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/* ------------------------------------------------------------------------ *
 * Shared panel props + tiny DOM helpers
 * ------------------------------------------------------------------------ */

interface PanelProps {
  clock: HudClock;
  live: { current: Live };
}

/** Write a width only when the quantised value actually moved. */
function setWidth(el: HTMLElement | null, pct: number, store: number[], i: number): void {
  if (!el) return;
  const q = Math.round(clamp(pct, 0, 100) * 4) / 4;
  if (q === store[i]) return;
  store[i] = q;
  el.style.width = `${q}%`;
}

function setText(el: HTMLElement | null, text: string, store: string[], i: number): void {
  if (!el) return;
  if (text === store[i]) return;
  store[i] = text;
  el.textContent = text;
}

function setOpacity(el: HTMLElement | null, v: number, store: number[], i: number): void {
  if (!el) return;
  const q = Math.round(clamp01(v) * 100) / 100;
  if (q === store[i]) return;
  store[i] = q;
  el.style.opacity = `${q}`;
}

/** The plate every HUD block sits on: dark, bevelled, one hairline edge. */
const plate: CSSProperties = {
  background: INK,
  border: `1px solid ${EDGE}`,
  boxShadow: BEVEL,
  backdropFilter: "blur(3px)",
};

/* ------------------------------------------------------------------------ *
 * Vitals — shield over health, with the damage ghost
 * ------------------------------------------------------------------------ */

/** Ticks drawn as one gradient rather than N nodes — same look, no layout. */
const tickOverlay = (step: number): CSSProperties => ({
  backgroundImage: `repeating-linear-gradient(90deg, rgba(0,0,0,0) 0 calc(${step}% - 1px), rgba(0,0,0,0.55) calc(${step}% - 1px) ${step}%, rgba(255,255,255,0.10) ${step}% calc(${step}% + 1px))`,
});

const barGloss: CSSProperties = {
  backgroundImage:
    "linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.02) 46%, rgba(0,0,0,0.28))",
};

function Vitals({ clock, live }: PanelProps) {
  const hFill = useRef<HTMLDivElement | null>(null);
  const hGhost = useRef<HTMLDivElement | null>(null);
  const sFill = useRef<HTMLDivElement | null>(null);
  const sGhost = useRef<HTMLDivElement | null>(null);
  const hNum = useRef<HTMLSpanElement | null>(null);
  const sNum = useRef<HTMLSpanElement | null>(null);
  const shieldRow = useRef<HTMLDivElement | null>(null);
  const lowGlow = useRef<HTMLDivElement | null>(null);
  const knocked = useRef<HTMLDivElement | null>(null);
  const knockedNum = useRef<HTMLSpanElement | null>(null);

  const wStore = useRef<number[]>([-1, -1, -1, -1]);
  const tStore = useRef<string[]>(["", "", ""]);
  const oStore = useRef<number[]>([-1, -1, -1]);

  usePainter(clock, () => {
    const l = live.current;
    const hp = clamp01(l.health / l.maxHealth) * 100;
    const gh = clamp01(l.ghostHealth / l.maxHealth) * 100;
    const sh = clamp01(l.shield / l.maxShield) * 100;
    const gs = clamp01(l.ghostShield / l.maxShield) * 100;
    setWidth(hFill.current, hp, wStore.current, 0);
    setWidth(hGhost.current, gh, wStore.current, 1);
    setWidth(sFill.current, sh, wStore.current, 2);
    setWidth(sGhost.current, gs, wStore.current, 3);
    setText(hNum.current, `${Math.ceil(l.health)}`, tStore.current, 0);
    setText(sNum.current, `${Math.ceil(l.shield)}`, tStore.current, 1);
    // Shield fades out entirely at zero rather than sitting there empty —
    // an empty blue bar reads as "broken UI", a missing one reads as "no
    // shield", which is the truth.
    setOpacity(shieldRow.current, l.shield > 0 ? 1 : 0.34, oStore.current, 0);
    // Under a third of a bar the whole block breathes red.
    const low = clamp01(1 - l.health / (l.maxHealth * 0.34));
    setOpacity(lowGlow.current, low * (0.55 + 0.45 * Math.sin(l.t * 7)), oStore.current, 1);
    const down = l.down > 0;
    setOpacity(knocked.current, down ? 1 : 0, oStore.current, 2);
    if (down) setText(knockedNum.current, clockText(l.down), tStore.current, 2);
  });

  return (
    <div className="relative w-[312px]">
      <div
        ref={lowGlow}
        className="pointer-events-none absolute -inset-3 rounded-lg opacity-0"
        style={{ boxShadow: "0 0 26px 6px rgba(255,60,60,0.35)", background: "rgba(255,40,40,0.06)" }}
      />

      <div
        ref={knocked}
        className="mb-1.5 flex w-fit items-center gap-2 rounded-[3px] px-2 py-0.5 opacity-0"
        style={{ ...plate, background: "rgba(120,10,10,0.72)" }}
      >
        <span className="font-heading text-[10px] font-black uppercase tracking-[0.22em] text-red-200">
          Knocked
        </span>
        <span ref={knockedNum} className="font-heading text-[12px] font-black tabular-nums text-white">
          0:00
        </span>
      </div>

      {/* Shield */}
      <div ref={shieldRow} className="mb-1.5 flex items-center gap-2">
        <div
          className="flex h-[15px] w-[46px] items-center justify-end rounded-[3px] px-1.5 font-heading text-[12px] font-black tabular-nums text-sky-100"
          style={plate}
        >
          <span ref={sNum}>0</span>
        </div>
        <div
          className="relative h-[15px] flex-1 overflow-hidden rounded-[3px]"
          style={{ background: "rgba(0,0,0,0.55)", border: `1px solid ${EDGE}`, boxShadow: BEVEL }}
        >
          <div ref={sGhost} className="absolute inset-y-0 left-0 w-0" style={{ background: "rgba(200,235,255,0.42)" }} />
          <div
            ref={sFill}
            className="absolute inset-y-0 left-0 w-0"
            style={{
              backgroundImage: `linear-gradient(180deg, ${SHIELD_A}, ${SHIELD_B})`,
              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.5), 0 0 10px ${rgba(0x2b8fe0, 0.55)}`,
            }}
          />
          <div className="absolute inset-0" style={tickOverlay(20)} />
          <div className="absolute inset-0" style={barGloss} />
        </div>
      </div>

      {/* Health */}
      <div className="flex items-center gap-2">
        <div
          className="flex h-[19px] w-[46px] items-center justify-end rounded-[3px] px-1.5 font-heading text-[15px] font-black tabular-nums text-emerald-50"
          style={plate}
        >
          <span ref={hNum}>100</span>
        </div>
        <div
          className="relative h-[19px] flex-1 overflow-hidden rounded-[3px]"
          style={{ background: "rgba(0,0,0,0.55)", border: `1px solid ${EDGE}`, boxShadow: BEVEL }}
        >
          <div ref={hGhost} className="absolute inset-y-0 left-0 w-0" style={{ background: "rgba(255,236,190,0.5)" }} />
          <div
            ref={hFill}
            className="absolute inset-y-0 left-0 w-0"
            style={{
              backgroundImage: `linear-gradient(180deg, ${HEALTH_A}, ${HEALTH_B})`,
              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.45), 0 0 10px ${rgba(0x2fae43, 0.5)}`,
            }}
          />
          <div className="absolute inset-0" style={tickOverlay(20)} />
          <div className="absolute inset-0" style={barGloss} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * SPLASH ROYALE — dryness + poncho
 *
 * The health bar, restated. Three things make it a *water* bar rather than a
 * recoloured one:
 *
 *  - It is bright. Dryness is the good state, so a full bar is warm sand and
 *    sunlight; getting wet drags it down through the `DRYNESS_BANDS` blues.
 *    The colour is read from the band, never picked here.
 *  - It drips. Under half a bar, droplets start running off the bottom edge
 *    and the whole plate picks up a cyan glow that quickens as you go. That
 *    is the urgency signal — not a red vignette. Nobody is dying.
 *  - It says what you *are*. "DAMP", "DRENCHED", "SOAKED THROUGH" is a squad
 *    callout you can shout at Claude, which is the point of naming the bands.
 * ------------------------------------------------------------------------ */

/** Droplets running off the bottom of the bar. Phase-offset so they scatter. */
const DRIPS = [0.12, 0.28, 0.41, 0.56, 0.68, 0.83, 0.94];

function DrynessMeter({ clock, live }: PanelProps) {
  const dFill = useRef<HTMLDivElement | null>(null);
  const dGhost = useRef<HTMLDivElement | null>(null);
  const pFill = useRef<HTMLDivElement | null>(null);
  const pGhost = useRef<HTMLDivElement | null>(null);
  const dNum = useRef<HTMLSpanElement | null>(null);
  const pNum = useRef<HTMLSpanElement | null>(null);
  const bandLabel = useRef<HTMLSpanElement | null>(null);
  const ponchoRow = useRef<HTMLDivElement | null>(null);
  const wetGlow = useRef<HTMLDivElement | null>(null);
  const dryPill = useRef<HTMLDivElement | null>(null);
  const dryPillText = useRef<HTMLSpanElement | null>(null);
  const drips = useRef<(HTMLDivElement | null)[]>([]);

  const wStore = useRef<number[]>([-1, -1, -1, -1]);
  const tStore = useRef<string[]>(["", "", "", ""]);
  const oStore = useRef<number[]>([-1, -1, -1]);
  const lastBand = useRef("");

  usePainter(clock, () => {
    const l = live.current;
    const pct = clamp01(l.dry / l.dryMax) * 100;
    const band = drynessBand(pct);

    setWidth(dFill.current, pct, wStore.current, 0);
    setWidth(dGhost.current, clamp01(l.ghostDry / l.dryMax) * 100, wStore.current, 1);
    setWidth(pFill.current, clamp01(l.poncho / l.ponchoMax) * 100, wStore.current, 2);
    setWidth(pGhost.current, clamp01(l.ghostPoncho / l.ponchoMax) * 100, wStore.current, 3);
    setText(dNum.current, `${Math.ceil(l.dry)}`, tStore.current, 0);
    setText(pNum.current, `${Math.ceil(l.poncho)}`, tStore.current, 1);
    setText(bandLabel.current, W.bands[band.key], tStore.current, 2);
    setOpacity(ponchoRow.current, l.poncho > 0 ? 1 : 0.34, oStore.current, 0);

    if (lastBand.current !== band.key) {
      lastBand.current = band.key;
      const fill = dFill.current;
      if (fill) {
        // Band colour drives the bar; the lighter stop is the same hue lifted
        // toward white, which is what gives it the wet-highlight look.
        fill.style.backgroundImage = `linear-gradient(180deg, ${rgba(band.color, 1)}, ${rgba(band.color, 0.72)} 55%, rgba(255,255,255,0.22))`;
        fill.style.boxShadow = `inset 0 1px 0 rgba(255,255,255,0.65), 0 0 12px ${rgba(band.color, 0.6)}`;
      }
      const lbl = bandLabel.current;
      if (lbl) lbl.style.color = hex(lift(band.color));
    }

    // Urgency: a cyan breathing glow from "wet" downward, quickening as the
    // bar empties. Funny-tense, not grim — this is the "you're about to lose
    // a water fight" feeling, not a death rattle.
    const wet = clamp01(1 - pct / 55);
    const beat = 0.55 + 0.45 * Math.sin(l.t * (4 + wet * 7));
    setOpacity(wetGlow.current, wet * beat * 0.9, oStore.current, 1);

    // Drips. Each one falls, fades, and restarts on its own phase; the whole
    // set is off while you are dry so it stays information, not decoration.
    for (let i = 0; i < DRIPS.length; i++) {
      const el = drips.current[i];
      if (!el) continue;
      if (wet <= 0.02) {
        if (el.style.opacity !== "0") el.style.opacity = "0";
        continue;
      }
      const speed = 0.7 + wet * 0.8;
      const u = (l.t * speed + DRIPS[i] * 3.1) % 1;
      el.style.opacity = `${(1 - u) * wet * 0.95}`;
      el.style.transform = `translate(-50%, ${u * 16}px) scaleY(${1 + u * 0.9})`;
    }

    // Drying status. Two states worth showing and one worth staying quiet
    // about: a full bar needs no caption.
    const showDry = l.tooWetToDry || l.drying || pct >= 99.5;
    setOpacity(dryPill.current, showDry ? 1 : 0, oStore.current, 2);
    if (showDry) {
      setText(
        dryPillText.current,
        l.tooWetToDry ? W.dryingBlocked : pct >= 99.5 ? W.fullyDry : W.dryingOff,
        tStore.current,
        3,
      );
      const t = dryPillText.current;
      if (t) t.style.color = l.tooWetToDry ? hex(DOWN.rain) : "#ffe9a8";
    }
  });

  return (
    <div className="relative w-[320px]">
      <div
        ref={wetGlow}
        className="pointer-events-none absolute -inset-3 rounded-lg opacity-0"
        style={{
          boxShadow: `0 0 30px 8px ${rgba(DOWN.wall, 0.42)}`,
          background: `${rgba(DOWN.rain, 0.07)}`,
        }}
      />

      {/* Drying status */}
      <div ref={dryPill} className="mb-1.5 flex w-fit items-center gap-1.5 rounded-[3px] px-2 py-0.5 opacity-0" style={wPlate}>
        <svg viewBox="0 0 16 16" className="h-3 w-3">
          <path d="M8 1.6c2.6 3 4.4 5.1 4.4 7.2A4.4 4.4 0 0 1 8 13.2 4.4 4.4 0 0 1 3.6 8.8c0-2.1 1.8-4.2 4.4-7.2z" fill={hex(DOWN.rain)} />
          <path d="M6.4 4.6c-1 1.4-1.6 2.6-1.6 3.6" stroke="rgba(255,255,255,0.8)" strokeWidth="1" fill="none" strokeLinecap="round" />
        </svg>
        <span
          ref={dryPillText}
          className="font-heading text-[9px] font-black uppercase tracking-[0.22em] text-amber-100"
        >
          {W.dryingOff}
        </span>
      </div>

      {/* Poncho — the shield, worn on top */}
      <div ref={ponchoRow} className="mb-1.5 flex items-center gap-2">
        <div
          className="flex h-[15px] w-[46px] items-center justify-end rounded-[3px] px-1.5 font-heading text-[12px] font-black tabular-nums"
          style={{ ...wPlate, color: "#eafaff" }}
        >
          <span ref={pNum}>0</span>
        </div>
        <div
          className="relative h-[15px] flex-1 overflow-hidden rounded-[3px]"
          style={{ background: "rgba(2,18,32,0.6)", border: `1px solid ${W_EDGE}`, boxShadow: W_BEVEL }}
        >
          <div ref={pGhost} className="absolute inset-y-0 left-0 w-0" style={{ background: "rgba(214,246,255,0.4)" }} />
          <div
            ref={pFill}
            className="absolute inset-y-0 left-0 w-0"
            style={{
              // Translucent, glossy, faintly striped — a plastic poncho, not
              // a second health bar. It reads as something you are wearing.
              backgroundImage: `linear-gradient(180deg, rgba(255,255,255,0.85), ${rgba(0x9be8ff, 0.75)} 52%, ${rgba(0x4fc3f7, 0.8)})`,
              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.75), 0 0 10px ${rgba(0x7fd7ff, 0.5)}`,
            }}
          />
          <div className="absolute inset-0" style={tickOverlay(20)} />
          <div className="absolute inset-0" style={barGloss} />
        </div>
        <span className="w-[54px] text-[8px] font-bold uppercase tracking-[0.14em] text-sky-100/45">
          {W.ponchoLabel}
        </span>
      </div>

      {/* Dryness */}
      <div className="flex items-center gap-2">
        <div
          className="flex h-[22px] w-[46px] items-center justify-end rounded-[3px] px-1.5 font-heading text-[16px] font-black tabular-nums"
          style={{ ...wPlate, color: "#fff8e6" }}
        >
          <span ref={dNum}>100</span>
        </div>
        <div className="relative flex-1">
          <div
            className="relative h-[22px] overflow-hidden rounded-[3px]"
            style={{ background: "rgba(2,18,32,0.62)", border: `1px solid ${W_EDGE}`, boxShadow: W_BEVEL }}
          >
            <div ref={dGhost} className="absolute inset-y-0 left-0 w-0" style={{ background: "rgba(255,244,214,0.45)" }} />
            <div ref={dFill} className="absolute inset-y-0 left-0 w-0" />
            <div className="absolute inset-0" style={tickOverlay(20)} />
            <div className="absolute inset-0" style={barGloss} />
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[8.5px] font-bold uppercase tracking-[0.24em] text-black/45">
              {W.drynessLabel}
            </span>
          </div>
          {/* Drips hang off the bottom edge of the bar itself. */}
          <div className="pointer-events-none absolute inset-x-0 top-full h-5 overflow-hidden">
            {DRIPS.map((d, i) => (
              <div
                key={d}
                ref={(el) => {
                  drips.current[i] = el;
                }}
                className="absolute top-0 h-[5px] w-[3px] rounded-full opacity-0 will-change-transform"
                style={{
                  left: `${d * 100}%`,
                  background: `linear-gradient(180deg, ${rgba(0xdff4ff, 0.95)}, ${rgba(0x4fc3f7, 0.35)})`,
                  boxShadow: `0 0 4px ${rgba(0x9be8ff, 0.7)}`,
                }}
              />
            ))}
          </div>
        </div>
        <span
          ref={bandLabel}
          className="w-[54px] font-heading text-[8px] font-black uppercase leading-[1.1] tracking-[0.05em]"
          style={{ color: hex(lift(WATER.bands[0].color)), textShadow: "0 1px 4px rgba(0,0,0,0.95)" }}
        >
          {W.bands["bone-dry"]}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------------ */

function WoodIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-[15px] w-[15px]">
      <rect x="1" y="4" width="14" height="4.4" rx="1.4" fill="#8c5629" />
      <rect x="1" y="4" width="14" height="1.4" rx="0.7" fill="#c1873f" />
      <rect x="2.6" y="9.4" width="14" height="4.4" rx="1.4" fill="#734622" transform="translate(-1.6 0)" />
      <ellipse cx="13.6" cy="6.2" rx="1.4" ry="2.2" fill="#d79a56" />
      <ellipse cx="13.6" cy="6.2" rx="0.6" ry="1" fill="#8c5629" />
      <ellipse cx="12.1" cy="11.6" rx="1.4" ry="2.2" fill="#c1873f" />
    </svg>
  );
}

function StoneIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-[15px] w-[15px]">
      <path d="M2.2 9.6 4.8 3.4l6.6-1.1 3.2 4.9-1.6 5.6-7.8 1z" fill="#767d84" />
      <path d="M4.8 3.4 11.4 2.3l1.1 4.6-6.3 1.6z" fill="#a9b1b7" />
      <path d="M6.2 8.5 12.5 6.9l1.5-.7-1.9 6.6-7.8 1z" fill="#5c6369" />
      <path d="M4.8 3.4 6.2 8.5l-4 1.1z" fill="#8d959b" />
    </svg>
  );
}

function MetalIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-[15px] w-[15px]">
      <path d="M2 3.2h12v2.4H9.4v4.8H14V13H2v-2.6h4.4V5.6H2z" fill="#6d8797" />
      <path d="M2 3.2h12v1H2zM2 10.4h12v1H2z" fill="#b8dcef" opacity="0.8" />
      <circle cx="3.6" cy="4.4" r="0.6" fill="#22333c" />
      <circle cx="12.4" cy="4.4" r="0.6" fill="#22333c" />
      <circle cx="3.6" cy="11.6" r="0.6" fill="#22333c" />
      <circle cx="12.4" cy="11.6" r="0.6" fill="#22333c" />
    </svg>
  );
}

const MAT_ICON: Record<"wood" | "stone" | "metal", () => ReactElement> = {
  wood: WoodIcon,
  stone: StoneIcon,
  metal: MetalIcon,
};

/* ---- SPLASH ROYALE build materials: pool noodles, deck planks, corrugated tarp -- */

function NoodleIcon() {
  const c = WATER.materials.wood;
  return (
    <svg viewBox="0 0 16 16" className="h-[15px] w-[15px]">
      <rect x="1" y="3.4" width="14" height="4" rx="2" fill={hex(c.color)} />
      <rect x="1" y="3.4" width="14" height="1.4" rx="0.7" fill={hex(c.accent)} />
      <circle cx="14.1" cy="5.4" r="1.1" fill="#8a4a12" />
      <rect x="1" y="8.8" width="14" height="4" rx="2" fill="#f07a2b" />
      <rect x="1" y="8.8" width="14" height="1.3" rx="0.65" fill={hex(c.accent)} opacity="0.8" />
      <circle cx="2.2" cy="10.8" r="1.1" fill="#8a4a12" />
    </svg>
  );
}

function PlankIcon() {
  const c = WATER.materials.stone;
  return (
    <svg viewBox="0 0 16 16" className="h-[15px] w-[15px]">
      <rect x="1" y="3" width="14" height="3.6" rx="0.7" fill={hex(c.color)} />
      <rect x="1" y="3" width="14" height="1" rx="0.5" fill={hex(c.accent)} />
      <rect x="1" y="7.4" width="14" height="3.6" rx="0.7" fill="#c4ab7e" />
      <rect x="1" y="7.4" width="14" height="1" rx="0.5" fill={hex(c.accent)} opacity="0.75" />
      <rect x="1" y="11.8" width="14" height="2.4" rx="0.7" fill="#a98f63" />
      <circle cx="3.2" cy="4.8" r="0.5" fill="#6f5a37" />
      <circle cx="12.6" cy="9.2" r="0.5" fill="#6f5a37" />
    </svg>
  );
}

function TarpIcon() {
  const c = WATER.materials.metal;
  return (
    <svg viewBox="0 0 16 16" className="h-[15px] w-[15px]">
      <path d="M1.4 4.4c1.6-1.2 3.2 1.2 4.8 0s3.2 1.2 4.8 0 2.4-.6 3.6.2v7.4c-1.2-.8-2-1-3.6.2s-3.2-1.2-4.8 0-3.2 1.2-4.8 0z" fill={hex(c.color)} />
      <path d="M1.4 4.4c1.6-1.2 3.2 1.2 4.8 0s3.2 1.2 4.8 0 2.4-.6 3.6.2v1.6c-1.2-.8-2-1-3.6.2s-3.2-1.2-4.8 0-3.2 1.2-4.8 0z" fill={hex(c.accent)} />
      <circle cx="2.4" cy="5.6" r="0.7" fill="#2b6478" />
      <circle cx="13.6" cy="6.2" r="0.7" fill="#2b6478" />
    </svg>
  );
}

const W_MAT_ICON: Record<"wood" | "stone" | "metal", () => ReactElement> = {
  wood: NoodleIcon,
  stone: PlankIcon,
  metal: TarpIcon,
};

function MaterialsRow({ clock, live, water = false }: PanelProps & { water?: boolean }) {
  const kinds = ["wood", "stone", "metal"] as const;
  const style0 = water ? W_MAT_STYLE : MAT_STYLE;
  const icons = water ? W_MAT_ICON : MAT_ICON;
  const chips = useRef<(HTMLDivElement | null)[]>([]);
  const nums = useRef<(HTMLSpanElement | null)[]>([]);
  const gains = useRef<(HTMLSpanElement | null)[]>([]);
  const tStore = useRef<string[]>(["", "", "", "", "", ""]);

  usePainter(clock, () => {
    const l = live.current;
    for (let i = 0; i < kinds.length; i++) {
      const k = kinds[i];
      const value = k === "wood" ? l.wood : k === "stone" ? l.stone : l.metal;
      setText(nums.current[i], `${Math.round(value)}`, tStore.current, i);
      const f = l.flash[k];
      const chip = chips.current[i];
      if (chip) {
        // A tick-up punches the chip 8% larger and lights its rim. Short, and
        // on the pickaxe's rhythm, so harvesting feels like it pays out.
        chip.style.transform = f > 0 ? `scale(${1 + f * 0.09})` : "";
        const bevel = water ? W_BEVEL : BEVEL;
        chip.style.boxShadow =
          f > 0 ? `${bevel}, 0 0 ${8 + f * 16}px ${rgba(parseInt(style0[k].bright.slice(1), 16), f * 0.7)}` : bevel;
      }
      const g = gains.current[i];
      const gain = l.gain[k];
      if (g) {
        if (gain.t > 0) {
          const t = 1 - gain.t / 0.9;
          g.style.opacity = `${clamp01(1 - t) * 0.95}`;
          g.style.transform = `translateY(${-10 - t * 12}px)`;
          setText(g, `+${gain.amount}`, tStore.current, 3 + i);
        } else if (g.style.opacity !== "0") {
          g.style.opacity = "0";
        }
      }
    }
  });

  return (
    <div className="flex items-end gap-1.5">
      {kinds.map((k, i) => {
        const Icon = icons[k];
        const style = style0[k];
        return (
          <div
            key={k}
            ref={(el) => {
              chips.current[i] = el;
            }}
            className="relative flex h-[26px] w-[74px] items-center gap-1.5 rounded-[3px] px-1.5 transition-none"
            style={{
              ...modePlate(water),
              backgroundImage: `linear-gradient(180deg, ${rgba(parseInt(style.deep.slice(1), 16), 0.55)}, ${water ? "rgba(6,26,44,0.72)" : "rgba(4,7,14,0.75)"})`,
              transformOrigin: "50% 100%",
            }}
          >
            <Icon />
            <span
              className="ml-auto font-heading text-[13px] font-black tabular-nums"
              style={{ color: style.bright, textShadow: "0 1px 2px rgba(0,0,0,0.8)" }}
            >
              <span
                ref={(el) => {
                  nums.current[i] = el;
                }}
              >
                0
              </span>
            </span>
            <span
              ref={(el) => {
                gains.current[i] = el;
              }}
              className="pointer-events-none absolute right-1.5 top-0 font-heading text-[11px] font-black tabular-nums opacity-0"
              style={{ color: style.bright, textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Inventory
 * ------------------------------------------------------------------------ */

/** Fallback glyph for a slot whose system never painted an icon. */
function SlotGlyph({ kind }: { kind: string }) {
  if (kind === "pickaxe") {
    return (
      <svg viewBox="0 0 32 32" className="h-9 w-9">
        <path d="M4 9c6-4 18-4 24 0-6 1-10 2-12 4-2-2-6-3-12-4z" fill="#c9d3da" />
        <path d="M4 9c6-4 18-4 24 0-7-1-17-1-24 0z" fill="#eef4f8" />
        <rect x="14.6" y="12" width="2.8" height="16" rx="1.2" fill="#8a5a2b" />
        <rect x="14.6" y="12" width="1.2" height="16" fill="#c1873f" />
      </svg>
    );
  }
  if (kind === "consumable") {
    return (
      <svg viewBox="0 0 32 32" className="h-9 w-9">
        <rect x="10" y="6" width="12" height="20" rx="3" fill="#2f7fc4" />
        <rect x="10" y="6" width="4" height="20" rx="2" fill="#7dc4f2" opacity="0.7" />
        <rect x="12" y="3" width="8" height="4" rx="1.4" fill="#c9d3da" />
      </svg>
    );
  }
  if (kind === "throwable") {
    return (
      <svg viewBox="0 0 32 32" className="h-9 w-9">
        <circle cx="16" cy="19" r="8" fill="#4b6a3c" />
        <circle cx="13" cy="16" r="3" fill="#6d9455" opacity="0.7" />
        <rect x="14" y="6" width="4" height="5" rx="1" fill="#9aa2a8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" className="h-9 w-9">
      <rect x="4" y="14" width="22" height="4" rx="1.2" fill="#8f9aa3" />
      <rect x="4" y="14" width="22" height="1.4" rx="0.7" fill="#cfd8de" />
      <rect x="9" y="18" width="5" height="7" rx="1.4" fill="#5f6a72" />
      <rect x="24" y="12" width="6" height="3" rx="1" fill="#5f6a72" />
    </svg>
  );
}

function InventoryBar({
  clock,
  live,
  slots,
  water = false,
}: PanelProps & { slots: SlotMeta[]; water?: boolean }) {
  const mags = useRef<(HTMLSpanElement | null)[]>([]);
  const reserves = useRef<(HTMLSpanElement | null)[]>([]);
  const counts = useRef<(HTMLSpanElement | null)[]>([]);
  const progress = useRef<(HTMLDivElement | null)[]>([]);
  const tanks = useRef<(HTMLDivElement | null)[]>([]);
  const tStore = useRef<string[]>([]);
  const wStore = useRef<number[]>([]);
  const hStore = useRef<number[]>([]);

  usePainter(clock, () => {
    const l = live.current;
    for (let i = 0; i < 6; i++) {
      const a = l.slotAmmo[i];
      setText(mags.current[i], `${a.ammo}`, tStore.current, i);
      setText(reserves.current[i], `${a.reserve}`, tStore.current, 6 + i);
      setText(counts.current[i], a.count > 1 ? `x${a.count}` : "", tStore.current, 12 + i);

      // SPLASH ROYALE: the slot itself is the tank. Water fills it from the bottom,
      // so a glance across the bar tells you which gun still has a shot in it
      // without reading a single number.
      const tank = tanks.current[i];
      if (tank) {
        const level = a.magSize > 0 ? clamp01(a.ammo / a.magSize) : 0;
        const q = Math.round(level * 400) / 4;
        if (q !== hStore.current[i]) {
          hStore.current[i] = q;
          tank.style.height = `${q}%`;
          tank.style.opacity = level > 0 ? "1" : "0";
        }
      }
      // One bar does double duty: reload on the active weapon, equip delay on
      // whatever slot is coming up. They can never overlap.
      const bar = progress.current[i];
      if (!bar) continue;
      const active = slots[i]?.active === true;
      const p = active ? (l.reloading ? l.reloadProgress : l.equip < 1 ? l.equip : 0) : 0;
      setWidth(bar, p * 100, wStore.current, i);
      const want = p > 0 && p < 1 ? 1 : 0;
      if (bar.style.opacity !== `${want}`) bar.style.opacity = `${want}`;
    }
  });

  return (
    <div className="flex items-end gap-1.5">
      {slots.map((s) => {
        const c = s.color;
        const showAmmo = s.isWeapon;
        return (
          <div
            key={s.index}
            className="relative transition-transform duration-150"
            style={{ transform: s.active ? "translateY(-7px)" : "none" }}
          >
            <div
              className="relative h-[64px] w-[68px] overflow-hidden rounded-[4px]"
              style={{
                border: s.hasItem ? `1px solid ${rgba(c, 0.85)}` : "1px dashed rgba(255,255,255,0.16)",
                backgroundImage: s.hasItem
                  ? `radial-gradient(120% 90% at 50% 118%, ${rgba(c, 0.62)}, ${rgba(c, 0.14)} 58%, rgba(4,7,14,0.86) 100%)`
                  : "linear-gradient(180deg, rgba(10,14,24,0.55), rgba(4,7,14,0.7))",
                boxShadow: s.active
                  ? `${BEVEL}, 0 0 0 2px rgba(255,255,255,0.9), 0 0 18px ${rgba(c, 0.6)}`
                  : BEVEL,
                backdropFilter: "blur(3px)",
              }}
            >
              {/* Tank water level (SPLASH ROYALE only) — behind the item art. */}
              {water && s.isWeapon && (
                <div
                  ref={(el) => {
                    tanks.current[s.index] = el;
                  }}
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-0 opacity-0"
                  style={{
                    background: `linear-gradient(180deg, ${rgba(0x9be8ff, 0.72)}, ${rgba(0x2f9fe0, 0.6)})`,
                    // The bright meniscus is what makes it read as a *level*
                    // rather than as a coloured slot, and it is the part that
                    // has to survive the name plate's gradient at the bottom.
                    borderTop: `2px solid ${rgba(0xf2fbff, 0.95)}`,
                    boxShadow: `0 -5px 14px ${rgba(0x4fc3f7, 0.65)} inset, 0 0 8px ${rgba(0x9be8ff, 0.55)}`,
                  }}
                />
              )}

              {/* Slot key */}
              <span className="absolute left-1 top-0.5 font-heading text-[9px] font-black text-white/45">
                {s.index + 1}
              </span>

              {/* Item */}
              <div className="flex h-full w-full items-center justify-center pb-3.5">
                {s.hasItem &&
                  (s.icon ? (
                    <img
                      src={s.icon}
                      alt=""
                      className="h-10 w-10 object-contain"
                      style={{ filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.65))" }}
                    />
                  ) : (
                    <SlotGlyph kind={s.kind} />
                  ))}
              </div>

              {/* Name plate */}
              {s.hasItem && (
                <div
                  className="absolute inset-x-0 bottom-0 truncate px-1 pb-[2px] pt-[3px] text-center text-[8px] font-bold uppercase tracking-[0.04em]"
                  style={{
                    // Lighter and later in water mode so the tank level under
                    // it stays visible; the name still reads because it keeps
                    // its own shadow.
                    background: water
                      ? "linear-gradient(180deg, rgba(4,18,32,0), rgba(4,18,32,0.72) 68%)"
                      : "linear-gradient(180deg, rgba(4,7,14,0), rgba(4,7,14,0.9) 55%)",
                    color: rgba(c, 1),
                    textShadow: "0 1px 2px rgba(0,0,0,0.9)",
                  }}
                >
                  {s.name}
                </div>
              )}

              {/* Stack count */}
              <span
                ref={(el) => {
                  counts.current[s.index] = el;
                }}
                className="absolute right-1 top-0.5 font-heading text-[11px] font-black tabular-nums text-white/90"
                style={{ textShadow: "0 1px 2px rgba(0,0,0,0.9)" }}
              />

              {/* Reload / equip */}
              <div
                ref={(el) => {
                  progress.current[s.index] = el;
                }}
                className="absolute bottom-0 left-0 h-[3px] w-0 opacity-0"
                style={{ background: "linear-gradient(90deg, #ffe08a, #fff)" }}
              />
            </div>

            {/* Ammo, under the slot: mag big, reserve small — the shooter read.
                In SPLASH ROYALE there is no reserve; a tank is topped up, not swapped,
                so the second number would always be a lie. */}
            <div className="mt-1 flex h-[15px] items-baseline justify-center gap-1">
              {showAmmo && (
                <>
                  <span
                    ref={(el) => {
                      mags.current[s.index] = el;
                    }}
                    className="font-heading text-[15px] font-black leading-none tabular-nums text-white"
                    style={{ textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}
                  />
                  {water ? (
                    <span className="text-[8px] font-bold uppercase leading-none tracking-[0.14em] text-sky-200/55">
                      {W.tankLabel}
                    </span>
                  ) : (
                    <>
                      <span className="text-[9px] font-bold leading-none text-white/35">/</span>
                      <span
                        ref={(el) => {
                          reserves.current[s.index] = el;
                        }}
                        className="text-[10px] font-bold leading-none tabular-nums text-white/55"
                      />
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Consumable channel
 * ------------------------------------------------------------------------ */

function ConsumeBar({ clock, live, consume }: PanelProps & { consume: { name: string } | null }) {
  const fill = useRef<HTMLDivElement | null>(null);
  const wStore = useRef<number[]>([-1]);
  usePainter(clock, () => {
    setWidth(fill.current, live.current.consumeT * 100, wStore.current, 0);
  });

  return (
    <AnimatePresence>
      {consume && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className="w-[224px] rounded-[3px] px-2 py-1"
          style={plate}
        >
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-white/60">Using</span>
            <span className="font-heading text-[11px] font-black text-sky-200">{consume.name}</span>
          </div>
          <div className="h-[5px] overflow-hidden rounded-full bg-black/60">
            <div
              ref={fill}
              className="h-full w-0 rounded-full"
              style={{ backgroundImage: "linear-gradient(90deg, #7dd3fc, #38bdf8)" }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------------ *
 * SPLASH ROYALE — tank readout
 *
 * The magazine counter, restated. It reads as a water level rather than a
 * number pair because that is what it is: the tank is topped up continuously
 * (see `refillRate` in mode/water.ts), so "how full am I" is the question and
 * "how many mags do I have left" is not a question at all.
 * ------------------------------------------------------------------------ */

function TankStatus({ clock, live, slots }: PanelProps & { slots: SlotMeta[] }) {
  const fill = useRef<HTMLDivElement | null>(null);
  const refill = useRef<HTMLDivElement | null>(null);
  const status = useRef<HTMLSpanElement | null>(null);
  const numText = useRef<HTMLSpanElement | null>(null);
  const wStore = useRef<number[]>([-1, -1]);
  const tStore = useRef<string[]>(["", ""]);

  const active = slots.find((s) => s.active);
  const index = active?.index ?? 0;
  const isWeapon = active?.isWeapon === true;

  usePainter(clock, () => {
    if (!isWeapon) return;
    const l = live.current;
    const a = l.slotAmmo[index];
    const level = a.magSize > 0 ? clamp01(a.ammo / a.magSize) : 0;
    setWidth(fill.current, level * 100, wStore.current, 0);
    setWidth(refill.current, l.reloading ? l.reloadProgress * 100 : 0, wStore.current, 1);
    setText(numText.current, `${a.ammo}`, tStore.current, 0);
    // Priority: what you can do about it beats what is wrong with it. A
    // source in reach is always the more useful thing to say.
    const text = l.nearWater
      ? W.dunkPrompt
      : l.reloading
        ? W.refilling
        : a.ammo <= 0
          ? W.tankEmpty
          : "";
    setText(status.current, text, tStore.current, 1);
    const el = status.current;
    if (el) {
      el.style.color = l.nearWater ? "#bff7c8" : l.reloading ? "#cdeef8" : a.ammo <= 0 ? "#ffc9a8" : "transparent";
      // Empty and no source nearby is the one genuinely bad state, so that is
      // the only one that pulses.
      el.style.opacity = `${a.ammo <= 0 && !l.nearWater && !l.reloading ? 0.6 + 0.4 * Math.sin(l.t * 7) : 1}`;
    }
  });

  if (!isWeapon) return null;

  return (
    <div className="w-[224px] rounded-[3px] px-2 py-1" style={wPlate}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[8.5px] font-bold uppercase tracking-[0.24em] text-sky-100/55">
          {W.tankLabel}
        </span>
        <span ref={status} className="text-[8.5px] font-black uppercase tracking-[0.16em]" />
        <span
          ref={numText}
          className="font-heading text-[13px] font-black tabular-nums text-white"
          style={{ textShadow: "0 1px 3px rgba(0,0,0,0.85)" }}
        >
          0
        </span>
      </div>
      <div
        className="relative h-[9px] overflow-hidden rounded-full"
        style={{ background: "rgba(2,18,32,0.66)", border: `1px solid ${W_EDGE}` }}
      >
        <div
          ref={fill}
          className="absolute inset-y-0 left-0 w-0 rounded-full"
          style={{
            backgroundImage: `linear-gradient(180deg, rgba(255,255,255,0.6), ${rgba(0x4fc3f7, 0.95)} 45%, ${rgba(0x2f9fe0, 1)})`,
            boxShadow: `0 0 10px ${rgba(0x7fd7ff, 0.6)}`,
          }}
        />
        {/* The refill sweep rides over the level so a partial top-up reads as
            water arriving rather than as a second, competing bar. */}
        <div
          ref={refill}
          className="absolute inset-y-0 left-0 w-0"
          style={{ background: "rgba(223,244,255,0.32)" }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * SPLASH ROYALE — multiplayer panels
 *
 * The three things a water fight with friends needs that a solo BR does not:
 * a code you can read out loud, a list of who is on your side and how wet
 * they are, and a way to talk to them. Claude, the AI teammate, is a peer
 * like any other — it shows up in the squad list and it talks in the chat,
 * because the moment it needs its own panel it stops feeling like a teammate.
 *
 * All three read `ctx.services.net` directly (see the file header). The
 * transport is optional by design: absent or offline, `RoomCode` and
 * `SquadPanel` render nothing and `ChatPanel` still echoes your own lines,
 * which is exactly what `net.chat()` promises offline.
 * ------------------------------------------------------------------------ */

function RoomCode({ engine }: { engine: Engine }) {
  const [net, setNet] = useState({ code: "", online: false, peers: 0 });

  useEffect(() => {
    const off = engine.on("soaked:net", (p) => {
      const d = rec(p);
      setNet({
        code: str(d.roomCode),
        online: bool(d.online),
        peers: Math.round(num(d.peers)),
      });
    });
    // `soaked:net` only fires on change, so seed from the service in case the
    // room was already joined (a `?room=` link) before this panel mounted.
    const s = engine.ctx.services.net;
    if (s?.roomCode) setNet({ code: s.roomCode, online: s.online, peers: s.peers.size });
    return off;
  }, [engine]);

  // Solo is the default and needs no chrome. The code only appears once there
  // is actually a room to share.
  if (!net.code) return null;

  return (
    <div className="flex items-center gap-2 self-start rounded-[3px] px-2 py-1" style={wPlate}>
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          background: net.online ? "#8affc1" : "#ff9f43",
          boxShadow: `0 0 6px ${net.online ? "rgba(138,255,193,0.9)" : "rgba(255,159,67,0.9)"}`,
        }}
      />
      <span className="text-[8px] font-bold uppercase tracking-[0.24em] text-sky-100/45">room</span>
      <span
        className="font-heading text-[12px] font-black tracking-[0.12em] text-white"
        style={{ textShadow: "0 1px 3px rgba(0,0,0,0.85)" }}
      >
        {net.code}
      </span>
      <span className="ml-auto font-heading text-[10px] font-black tabular-nums text-sky-200/70">
        {net.peers + 1}
      </span>
    </div>
  );
}

/** One row's mutable DOM handles, so the painter never touches React. */
interface SquadRow {
  bar: HTMLDivElement | null;
  dist: HTMLSpanElement | null;
  arrow: HTMLDivElement | null;
  band: HTMLSpanElement | null;
  root: HTMLDivElement | null;
}

/** Roster refresh cadence. Names and joins are not worth a per-frame rebuild. */
const SQUAD_POLL = 0.25;
/** Rows shown. A squad is three; the fourth slot is slack, not a design. */
const SQUAD_MAX = 4;

function SquadPanel({ clock, live, engine }: PanelProps & { engine: Engine }) {
  const [mates, setMates] = useState<SquadMate[]>([]);
  const matesRef = useRef<SquadMate[]>(mates);
  matesRef.current = mates;
  const rows = useRef<SquadRow[]>([]);
  const acc = useRef(SQUAD_POLL);
  const sig = useRef("");
  const tStore = useRef<string[]>([]);
  const wStore = useRef<number[]>([]);
  /**
   * Our own squad id, when anything has told us one. Until then every peer is
   * treated as a teammate — which is right for the case this panel exists to
   * serve, three friends and Claude in a private room.
   */
  const myTeam = useRef<string | null>(null);

  useEffect(() => {
    const off = engine.on("soaked:net", (p) => {
      const t = str(rec(p).team);
      if (t) myTeam.current = t;
    });
    return off;
  }, [engine]);

  usePainter(clock, (dt) => {
    const net = engine.ctx.services.net;
    const l = live.current;

    acc.current += dt;
    if (acc.current >= SQUAD_POLL) {
      acc.current = 0;
      const next: SquadMate[] = [];
      if (net) {
        const team = myTeam.current;
        for (const p of net.peers.values()) {
          if (team && p.team && p.team !== team) continue;
          // Keyed on the peer id, not the team: everyone in a squad shares a
          // team string, and three teammates in the same colour is a list you
          // have to read instead of glance at.
          next.push({ id: p.id, name: p.name, agent: p.agent, color: teamColor(p.id) });
        }
        // Humans first, then the AI: a stable order matters more than a clever
        // one, because you learn where each name sits and stop reading them.
        next.sort((a, b) => (a.agent ? 1 : 0) - (b.agent ? 1 : 0) || a.name.localeCompare(b.name));
        next.length = Math.min(next.length, SQUAD_MAX);
      }
      const s = next.map((m) => `${m.id}:${m.name}:${m.agent ? 1 : 0}`).join("|");
      if (s !== sig.current) {
        sig.current = s;
        setMates(next);
      }
    }

    if (!net) return;
    const list = matesRef.current;
    // Look basis: forward is (-sin yaw, -cos yaw) in this engine, so right is
    // (cos yaw, -sin yaw). The arrow turns clockwise for a teammate on your
    // right, which is the only convention anyone reads correctly.
    const fx = -Math.sin(l.yaw);
    const fz = -Math.cos(l.yaw);
    const rx = Math.cos(l.yaw);
    const rz = -Math.sin(l.yaw);

    for (let i = 0; i < list.length; i++) {
      const row = rows.current[i];
      const peer = net.peers.get(list[i].id) as PeerState | undefined;
      if (!row) continue;
      if (!peer) {
        if (row.root) row.root.style.opacity = "0.35";
        continue;
      }
      const band = drynessBand(peer.dry);
      setWidth(row.bar, clamp01(peer.dry / 100) * 100, wStore.current, i);
      const bar = row.bar;
      if (bar) bar.style.background = hex(band.color);
      setText(row.band, W.bands[band.key], tStore.current, i);
      const lbl = row.band;
      if (lbl) lbl.style.color = hex(lift(band.color));

      if (!peer.posed) {
        setText(row.dist, "—", tStore.current, SQUAD_MAX + i);
        if (row.arrow) row.arrow.style.opacity = "0";
      } else {
        const dx = peer.x - l.x;
        const dz = peer.z - l.z;
        const d = Math.hypot(dx, dz);
        setText(
          row.dist,
          d >= 1000 ? `${(d / 1000).toFixed(1)}km` : `${Math.round(d)}m`,
          tStore.current,
          SQUAD_MAX + i,
        );
        const a = (Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) * 180) / Math.PI;
        if (row.arrow) {
          row.arrow.style.opacity = "1";
          row.arrow.style.transform = `rotate(${a.toFixed(1)}deg)`;
        }
      }
      // A soaked-out teammate greys out rather than disappearing — you still
      // want to know they were there and roughly where they went down.
      if (row.root) row.root.style.opacity = peer.dry <= 0 ? "0.4" : "1";
    }
  });

  if (mates.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 rounded-[4px] px-1.5 py-1.5" style={wPlate}>
      <span className="px-0.5 text-[8px] font-bold uppercase tracking-[0.28em] text-sky-100/45">
        {W.squadName}
      </span>
      {mates.map((m, i) => (
        <div
          key={m.id}
          ref={(el) => {
            rows.current[i] = { ...(rows.current[i] ?? ({} as SquadRow)), root: el };
          }}
          className="flex items-center gap-1.5 overflow-hidden rounded-[3px] px-1 py-[3px]"
          style={{ background: rgba(m.color, 0.1), borderLeft: `2px solid ${hex(m.color)}` }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <div className="flex min-w-0 items-baseline gap-1">
              <span
                className="truncate text-[10px] font-bold leading-none"
                style={{ color: hex(m.color), textShadow: "0 1px 2px rgba(0,0,0,0.85)" }}
              >
                {m.name}
              </span>
              {m.agent && (
                // Claude. Badged, not hidden: knowing which teammate is the AI
                // changes how you talk to it, and pretending otherwise would
                // be the one dishonest pixel on this HUD.
                <span
                  className="shrink-0 rounded-[2px] px-[3px] py-[1px] text-[7px] font-black uppercase leading-none tracking-[0.14em]"
                  style={{ background: rgba(0xd8f36b, 0.22), color: "#eaffb0" }}
                >
                  AI
                </span>
              )}
              <span
                ref={(el) => {
                  rows.current[i] = { ...(rows.current[i] ?? ({} as SquadRow)), band: el };
                }}
                className="ml-auto max-w-[78px] shrink-0 truncate text-[7px] font-black uppercase leading-none tracking-[0.08em]"
              />
            </div>
            <div className="h-[4px] overflow-hidden rounded-full" style={{ background: "rgba(2,18,32,0.7)" }}>
              <div
                ref={(el) => {
                  rows.current[i] = { ...(rows.current[i] ?? ({} as SquadRow)), bar: el };
                }}
                className="h-full w-0"
              />
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-center gap-[2px]">
            <div
              ref={(el) => {
                rows.current[i] = { ...(rows.current[i] ?? ({} as SquadRow)), arrow: el };
              }}
              className="h-3 w-3 opacity-0 will-change-transform"
            >
              <svg viewBox="0 0 12 12" className="h-3 w-3">
                <path d="M6 1 10 10 6 8 2 10z" fill={hex(m.color)} stroke="rgba(0,0,0,0.7)" strokeWidth="0.7" />
              </svg>
            </div>
            <span
              ref={(el) => {
                rows.current[i] = { ...(rows.current[i] ?? ({} as SquadRow)), dist: el };
              }}
              className="font-heading text-[8px] font-black tabular-nums leading-none text-white/70"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The glue strand prompt. Always mounted, painted to zero opacity when there
 * is no strand — a strand lands and breaks several times a minute and none of
 * that should cost a React render.
 */
function GluePrompt({ clock, live }: PanelProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const who = useRef<HTMLSpanElement | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const tStore = useRef<string[]>([""]);
  const wStore = useRef<number[]>([-1]);
  const oStore = useRef<number[]>([-1]);

  usePainter(clock, () => {
    const l = live.current;
    const on = l.gluedTo !== "";
    setOpacity(root.current, on ? 1 : 0, oStore.current, 0);
    if (!on) return;
    setText(who.current, fmt(W.gluedTo, { name: l.gluedTo }), tStore.current, 0);
    setWidth(bar.current, l.struggle * 100, wStore.current, 0);
    const el = root.current;
    if (el) el.style.transform = `translateX(${Math.sin(l.t * 26) * (1 - l.struggle) * 2.5}px)`;
  });

  return (
    <div
      ref={root}
      className="absolute inset-x-0 bottom-[32%] flex justify-center opacity-0 will-change-transform"
    >
      <div
        className="flex flex-col items-center gap-1 rounded-[4px] px-4 py-1.5"
        style={{ ...wPlate, background: "rgba(46,58,10,0.8)", borderColor: rgba(WATER.glue.color, 0.6) }}
      >
        <span
          ref={who}
          className="font-heading text-[13px] font-black uppercase tracking-[0.18em]"
          style={{ color: hex(WATER.glue.glowColor), textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}
        />
        <div className="h-[4px] w-[180px] overflow-hidden rounded-full bg-black/60">
          <div
            ref={bar}
            className="h-full w-0"
            style={{ backgroundImage: `linear-gradient(90deg, ${hex(WATER.glue.color)}, #ffffff)` }}
          />
        </div>
        <span className="text-[8.5px] font-bold uppercase tracking-[0.22em] text-lime-100/70">
          {fmt(W.gluePrompt, { key: WATER.glue.struggleKey })}
        </span>
      </div>
    </div>
  );
}

/**
 * Chat.
 *
 * This is how you talk to Claude mid-match, so the bar for "usable" is higher
 * than for a cosmetic log. Three things it has to get right:
 *
 *  - **It never eats the crosshair.** Bottom-left, above the dryness meter,
 *    and only the input is `pointer-events-auto`.
 *  - **It survives losing pointer lock.** The page unmounts the rest of the
 *    HUD when the pointer unlocks; this panel is rendered outside that gate.
 *  - **Typing must not play the game.** The engine's key handler is on
 *    `window` and does *not* check the lock, so a keystroke that reaches it
 *    while you type "on my left" walks you off a roof. Every key event is
 *    stopped at the input, and while the box is open a capture-phase shield
 *    swallows mouse look, fire and wheel so the match is genuinely paused for
 *    you rather than merely unread.
 *
 * On pointer lock: the honest version of "release it while typing" would be
 * `exitPointerLock()`, and that is what this did first. It is wrong here —
 * unlocking raises the page's pause veil over the very box you are typing
 * into. So the lock is left alone and control is released instead, which is
 * indistinguishable from the player's side; and if the lock has been lost by
 * then (Escape, or a click), closing the box asks for it back.
 */
const CHAT_LINES = 6;

function ChatPanel({ engine }: { engine: Engine }) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    const off = engine.on("soaked:chat", (p) => {
      const d = rec(p);
      const body = str(d.text);
      if (!body) return;
      const line: ChatLine = {
        id: str(d.id, `${str(d.from)}-${body.length}-${num(d.t).toFixed(3)}`),
        from: str(d.from),
        name: str(d.name, "player"),
        text: body,
        t: num(d.t),
        self: bool(d.self),
        agent: bool(d.agent),
      };
      setLines((prev) => [...prev.slice(-(CHAT_LINES * 4)), line]);
    });
    // Seed from the backlog: a player who joined before the HUD mounted, or
    // reopened it, should not lose what Claude already said.
    const s = engine.ctx.services.net;
    if (s && s.messages.length > 0) setLines(s.messages.slice(-CHAT_LINES * 4));
    return off;
  }, [engine]);

  const close = useCallback(
    (restoreLock: boolean) => {
      setOpen(false);
      setText("");
      inputRef.current?.blur();
      if (!restoreLock) return;
      const canvas = engine.ctx.renderer.domElement;
      if (document.pointerLockElement === canvas) return;
      try {
        // Chromium returns a promise here and rejects it if the lock was
        // released too recently. Losing the lock is survivable; an unhandled
        // rejection in the console is noise.
        const r = canvas.requestPointerLock?.() as unknown;
        if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
      } catch {
        /* no lock available — the player can click back in. */
      }
    },
    [engine],
  );

  // Enter opens the box. It is not bound to anything in `input.ts`, so this
  // costs the game nothing; while the box is open the input's own handler owns
  // the key and this listener never sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (openRef.current) return;
      if (e.code !== "Enter" && e.code !== "NumpadEnter") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // The mouse shield. Capture phase on `window`, so it fires before the
  // engine's own listeners and before the event reaches anything else. Only
  // while the pointer is actually locked: if it is not, the cursor is real and
  // the player may well be trying to click into this box.
  useEffect(() => {
    if (!open) return;
    const swallow = (e: Event) => {
      if (!document.pointerLockElement) return;
      e.stopPropagation();
    };
    const kinds = ["mousedown", "mouseup", "mousemove", "wheel", "contextmenu"] as const;
    for (const k of kinds) window.addEventListener(k, swallow, true);
    return () => {
      for (const k of kinds) window.removeEventListener(k, swallow, true);
    };
  }, [open]);

  const submit = useCallback(() => {
    const body = text.trim();
    // Offline is not an error: `net.chat()` echoes locally either way, and a
    // player talking to nobody still sees their own words.
    if (body) engine.ctx.services.net?.chat(body);
    close(true);
  }, [text, engine, close]);

  const visible = lines.slice(-CHAT_LINES);
  if (visible.length === 0 && !open) return null;

  return (
    <div className="pointer-events-none absolute bottom-[124px] left-6 z-[35] w-[336px] select-none font-body">
      <div className="flex flex-col gap-[3px]" style={{ opacity: open ? 1 : 0.78 }}>
        {visible.map((line) => (
          <div
            key={line.id}
            className="flex w-fit max-w-full items-baseline gap-1.5 rounded-[3px] px-1.5 py-[2px]"
            // Opaque enough to read against open sea, which is the brightest,
            // busiest thing this corner ever sits on.
            style={{ background: "rgba(4,20,36,0.72)", backdropFilter: "blur(2px)" }}
          >
            <span
              className="shrink-0 text-[10px] font-black leading-tight"
              style={{
                color: line.self ? "#ffffff" : line.agent ? hex(WATER.glue.color) : hex(teamColor(line.from)),
                textShadow: "0 1px 3px rgba(0,0,0,0.9)",
              }}
            >
              {line.name}
            </span>
            <span
              className="min-w-0 break-words text-[10.5px] leading-tight text-white/95"
              style={{ textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}
            >
              {line.text}
            </span>
          </div>
        ))}
      </div>

      {open && (
        <div
          className="mt-1 flex items-center gap-2 rounded-[3px] px-2 py-1"
          style={{ ...wPlate, background: W_INK_SOLID }}
        >
          <span className="shrink-0 text-[8px] font-bold uppercase tracking-[0.24em] text-sky-100/50">
            {W.squadName}
          </span>
          <input
            ref={inputRef}
            value={text}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            placeholder="say something…"
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              // Refuse to quietly become a dead box: if focus wanders while
              // the player is mid-sentence, take it straight back.
              if (openRef.current) requestAnimationFrame(() => inputRef.current?.focus());
            }}
            onKeyUp={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // The single most important line in this component: without it
              // "was" is a W, an A and an S, and you have just walked into the
              // Downpour explaining that you are in the Downpour.
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                close(true);
              }
            }}
            className="pointer-events-auto min-w-0 flex-1 bg-transparent text-[11px] text-white outline-none placeholder:text-white/25"
          />
          <span className="shrink-0 text-[8px] font-bold uppercase tracking-[0.18em] text-white/25">
            enter
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Minimap
 * ------------------------------------------------------------------------ */

const MAP_SIZE = 236;

function Minimap({
  clock,
  live,
  map,
  water = false,
}: PanelProps & { map: MapModel | null; water?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compass = useRef<HTMLDivElement | null>(null);
  const acc = useRef(0);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(MAP_SIZE * dpr);
    cv.height = Math.round(MAP_SIZE * dpr);
    const g = cv.getContext("2d");
    // Draw in CSS pixels; the backing store carries the device ratio so the
    // POI labels stay crisp on a retina panel.
    if (g) g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  usePainter(clock, (dt) => {
    const l = live.current;
    // The compass tracks the head, so it gets every frame; the map itself has
    // nothing in it that moves faster than a walk and redraws at 30 Hz.
    const el = compass.current;
    if (el) {
      const heading = ((-l.yaw * 180) / Math.PI + 720) % 360;
      el.style.transform = `translateX(${-heading * COMPASS_PX_PER_DEG}px)`;
    }
    acc.current += dt;
    if (acc.current < 1 / 30) return;
    acc.current = 0;
    const cv = canvasRef.current;
    if (!cv) return;
    const g = cv.getContext("2d");
    if (!g) return;
    drawMinimap(g, l, map, MAP_SIZE, water);
  });

  return (
    <div className="relative">
      {/* Compass strip */}
      <div
        className="relative mb-1 h-[16px] overflow-hidden rounded-[3px]"
        style={{ ...modePlate(water), background: water ? "rgba(8,26,44,0.66)" : "rgba(6,10,20,0.66)" }}
      >
        <div ref={compass} className="absolute left-1/2 top-0 flex h-full items-center will-change-transform">
          {COMPASS_MARKS.map((m) => (
            <span
              key={m.key}
              className="absolute -translate-x-1/2 font-heading text-[9px] font-black uppercase tracking-[0.1em]"
              style={{
                left: m.deg * COMPASS_PX_PER_DEG,
                color: m.major ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.42)",
              }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, rgba(6,10,20,0.95), rgba(6,10,20,0) 22%, rgba(6,10,20,0) 78%, rgba(6,10,20,0.95))",
          }}
        />
        <div className="absolute left-1/2 top-0 h-full w-[1px] -translate-x-1/2 bg-white/70" />
      </div>

      {/* The map */}
      <div
        className="relative overflow-hidden rounded-[5px]"
        style={{ ...modePlate(water), width: MAP_SIZE, height: MAP_SIZE, padding: 0 }}
      >
        <canvas ref={canvasRef} style={{ width: MAP_SIZE, height: MAP_SIZE, display: "block" }} />
        {/* Inner shading + corner ticks: the frame is what makes a canvas read
            as an instrument rather than a screenshot. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ boxShadow: "inset 0 0 24px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.14)" }}
        />
        {[
          "left-1 top-1 border-l border-t",
          "right-1 top-1 border-r border-t",
          "left-1 bottom-1 border-b border-l",
          "right-1 bottom-1 border-b border-r",
        ].map((cls) => (
          <div key={cls} className={`pointer-events-none absolute h-2.5 w-2.5 border-white/40 ${cls}`} />
        ))}
      </div>
    </div>
  );
}

const COMPASS_PX_PER_DEG = MAP_SIZE / 150;
const COMPASS_MARKS = (() => {
  const out: { key: string; label: string; deg: number; major: boolean }[] = [];
  const names: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
  // Three copies so the strip never runs out of marks while it scrolls.
  for (let rep = -1; rep <= 1; rep++) {
    for (const key of Object.keys(names)) {
      const deg = Number(key);
      out.push({
        key: `${rep}:${deg}`,
        label: names[deg],
        deg: deg + rep * 360,
        major: deg % 90 === 0,
      });
    }
  }
  return out;
})();

/* ------------------------------------------------------------------------ *
 * Storm timer + alive count
 * ------------------------------------------------------------------------ */

function StormPanel({ clock, live, water = false }: PanelProps & { water?: boolean }) {
  const circleText = useRef<HTMLSpanElement | null>(null);
  const timerText = useRef<HTMLSpanElement | null>(null);
  const label = useRef<HTMLSpanElement | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const dot = useRef<HTMLDivElement | null>(null);
  const tStore = useRef<string[]>(["", "", ""]);
  const wStore = useRef<number[]>([-1]);

  const beadColor = water ? DOWN.wall : 0xa45cf0;

  usePainter(clock, () => {
    const l = live.current;
    setText(
      circleText.current,
      water ? `${W.stormName} ${l.circle}` : `Zone ${l.circle}`,
      tStore.current,
      0,
    );
    setText(timerText.current, clockText(l.stormTimer), tStore.current, 1);
    setText(
      label.current,
      water
        ? l.closing
          ? W.stormWarn
          : W.stormSafe
        : l.closing
          ? "Zone closing"
          : "Zone moving in",
      tStore.current,
      2,
    );
    setWidth(bar.current, (1 - clamp01(l.stormTimer / Math.max(1, l.stormTimerMax))) * 100, wStore.current, 0);
    const t = label.current;
    if (t) t.style.color = l.closing ? (water ? hex(DOWN.rim) : "#ff8a8a") : "rgba(255,255,255,0.6)";
    const d = dot.current;
    if (d) {
      // The bead pulses only while the wall is actually moving — a permanently
      // animated element stops carrying information.
      const pulse = l.closing ? 0.6 + 0.4 * Math.sin(l.t * 6.2) : 0.85;
      d.style.opacity = `${pulse}`;
      d.style.boxShadow = `0 0 ${l.closing ? 12 : 6}px ${rgba(beadColor, 0.9)}`;
    }
  });

  return (
    <div className="rounded-[4px] px-2 py-1.5" style={modePlate(water)}>
      <div className="flex items-center gap-2">
        <div
          ref={dot}
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: water ? hex(DOWN.wall) : STORM_PURPLE, border: "1px solid rgba(255,255,255,0.5)" }}
        />
        <span
          ref={circleText}
          className="font-heading text-[11px] font-black uppercase tracking-[0.16em]"
          style={{ color: water ? hex(DOWN.rim) : "#ddd6fe" }}
        >
          {water ? W.stormName : "Zone 1"}
        </span>
        <span
          ref={timerText}
          className="ml-auto font-heading text-[19px] font-black leading-none tabular-nums text-white"
          style={{ textShadow: "0 1px 4px rgba(0,0,0,0.8)" }}
        >
          0:00
        </span>
      </div>
      <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-black/60">
        <div
          ref={bar}
          className="h-full w-0"
          style={{
            backgroundImage: water
              ? `linear-gradient(90deg, ${hex(DOWN.wall)}, ${hex(DOWN.rim)})`
              : `linear-gradient(90deg, ${STORM_PURPLE}, #e0a8ff)`,
          }}
        />
      </div>
      <span ref={label} className="mt-1 block text-[9px] font-bold uppercase tracking-[0.2em] text-white/60">
        {water ? W.stormSafe : "Zone moving in"}
      </span>
    </div>
  );
}

function AliveBlock({ clock, live, water = false }: PanelProps & { water?: boolean }) {
  const aliveNum = useRef<HTMLSpanElement | null>(null);
  const elimNum = useRef<HTMLSpanElement | null>(null);
  const tStore = useRef<string[]>(["", ""]);
  usePainter(clock, () => {
    const l = live.current;
    setText(aliveNum.current, `${Math.max(0, Math.round(l.alive))}`, tStore.current, 0);
    setText(elimNum.current, `${Math.round(l.eliminations)}`, tStore.current, 1);
  });

  return (
    <div className="flex items-stretch gap-1.5">
      <div className="flex flex-1 items-center gap-2 rounded-[4px] px-2 py-1" style={modePlate(water)}>
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 opacity-80">
          <circle cx="8" cy="4.6" r="2.9" fill="#dbe6f0" />
          <path d="M2.6 14c0-3 2.4-5.2 5.4-5.2S13.4 11 13.4 14z" fill="#dbe6f0" />
        </svg>
        <span ref={aliveNum} className="font-heading text-[19px] font-black leading-none tabular-nums text-white">
          100
        </span>
        <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-white/45">
          {water ? W.aliveLabel : "alive"}
        </span>
      </div>
      <div className="flex items-center gap-1.5 rounded-[4px] px-2 py-1" style={modePlate(water)}>
        {water ? (
          // A droplet, not a chevron: the counter is soakings, and the icon
          // has to agree with the word or the block reads as two counters.
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
            <path d="M8 1.6c2.6 3 4.4 5.1 4.4 7.2A4.4 4.4 0 0 1 8 13.2 4.4 4.4 0 0 1 3.6 8.8c0-2.1 1.8-4.2 4.4-7.2z" fill="#8fe0ff" />
            <path d="M6.4 4.8c-.9 1.3-1.5 2.5-1.5 3.5" stroke="rgba(255,255,255,0.85)" strokeWidth="1" fill="none" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
            <path d="M3 2.4 7.2 8 3 13.6h2.4L13 3.6V2.4z" fill="#ffd479" />
            <path d="M13 13.6 8.8 8l1.4-1.9L13 10.2z" fill="#ffd479" />
          </svg>
        )}
        <span
          className="font-heading text-[15px] font-black leading-none tabular-nums"
          style={{ color: water ? "#bfeaff" : "#fde68a" }}
        >
          <span ref={elimNum}>0</span>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Feeds
 * ------------------------------------------------------------------------ */

/**
 * The elimination feed. In SPLASH ROYALE nobody is eliminated — they are SOAKED, and
 * the line says so in words rather than leaving a gun icon to imply it. The
 * verb comes out of `eliminatedFeed` so the whole feed re-words from one table
 * entry.
 */
function KillFeed({ feed, water = false }: { feed: FeedEntry[]; water?: boolean }) {
  // "{by} soaked {name}" → "soaked". Split once here rather than formatting a
  // whole sentence, because the two names need their own colours.
  const verb = water ? (/\}\s*(.+?)\s*\{/.exec(W.eliminatedFeed)?.[1] ?? "soaked") : "";
  return (
    <ul className="flex flex-col items-end gap-1">
      <AnimatePresence initial={false}>
        {feed.map((e) => (
          <motion.li
            key={e.id}
            layout
            initial={{ opacity: 0, x: 26 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 14, transition: { duration: 0.25 } }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="flex max-w-[236px] items-center gap-1.5 rounded-[3px] px-1.5 py-[3px] text-[10px] font-bold"
            style={{
              ...modePlate(water),
              background: water
                ? e.byPlayer
                  ? "rgba(10,64,92,0.8)"
                  : e.onPlayer
                    ? "rgba(16,44,88,0.8)"
                    : W_INK
                : e.byPlayer
                  ? "rgba(58,42,10,0.78)"
                  : e.onPlayer
                    ? "rgba(70,12,12,0.78)"
                    : INK,
            }}
          >
            <span className={e.byPlayer ? (water ? "text-cyan-200" : "text-amber-200") : "text-white/80"}>
              {e.killer}
            </span>
            {water ? (
              <span
                className="shrink-0 text-[9px] font-black uppercase tracking-[0.12em]"
                style={{ color: e.environmental ? hex(DOWN.rim) : "#9be8ff" }}
              >
                {verb}
              </span>
            ) : (
              <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 opacity-70">
                {e.environmental ? (
                  <circle cx="8" cy="8" r="5" fill={STORM_PURPLE} />
                ) : (
                  <>
                    <rect x="2" y="7" width="11" height="2" rx="0.8" fill="#dfe7ee" />
                    <rect x="5" y="9" width="3" height="4" rx="1" fill="#9fb0bd" />
                  </>
                )}
              </svg>
            )}
            <span className={e.onPlayer ? (water ? "text-sky-200" : "text-red-300") : "text-white/55"}>
              {e.victim}
            </span>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function ToastStack({ toasts, water = false }: { toasts: ToastEntry[]; water?: boolean }) {
  return (
    <div className="absolute inset-x-0 top-[16%] flex flex-col items-center gap-1.5">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, scale: 0.86, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -10, transition: { duration: 0.3 } }}
            transition={{ type: "spring", stiffness: 520, damping: 30 }}
            className="flex flex-col items-center rounded-[4px] px-4 py-1.5"
            style={{
              ...modePlate(water),
              background: water
                ? t.tone === "elim"
                  ? "rgba(10,64,92,0.84)"
                  : t.tone === "urgent"
                    ? "rgba(14,46,80,0.84)"
                    : W_INK_SOLID
                : t.tone === "elim"
                  ? "rgba(52,36,6,0.8)"
                  : t.tone === "urgent"
                    ? "rgba(46,12,52,0.8)"
                    : INK_SOLID,
              borderColor: water
                ? t.tone === "elim"
                  ? "rgba(155,232,255,0.55)"
                  : t.tone === "urgent"
                    ? rgba(DOWN.rim, 0.5)
                    : W_EDGE
                : t.tone === "elim"
                  ? "rgba(255,206,110,0.5)"
                  : t.tone === "urgent"
                    ? "rgba(200,120,255,0.45)"
                    : EDGE,
            }}
          >
            <span
              className="font-heading text-[15px] font-black uppercase tracking-[0.08em]"
              style={{
                color: water
                  ? t.tone === "elim"
                    ? "#9be8ff"
                    : t.tone === "urgent"
                      ? hex(DOWN.rim)
                      : "#fff"
                  : t.tone === "elim"
                    ? "#ffd479"
                    : t.tone === "urgent"
                      ? "#e5b8ff"
                      : "#fff",
                textShadow: "0 2px 8px rgba(0,0,0,0.8)",
              }}
            >
              {t.text}
            </span>
            {t.sub && (
              <span className="text-[9px] font-bold uppercase tracking-[0.24em] text-white/55">{t.sub}</span>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function PickupLog({ pickups, water = false }: { pickups: PickupEntry[]; water?: boolean }) {
  return (
    <div className="absolute inset-x-0 bottom-[16%] flex flex-col items-center gap-1">
      <AnimatePresence initial={false}>
        {pickups.map((p) => (
          <motion.div
            key={p.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.3 } }}
            transition={{ type: "spring", stiffness: 480, damping: 32 }}
            className="flex items-center gap-2 rounded-[3px] px-2.5 py-1"
            style={{
              ...modePlate(water),
              // "No room" is the one thing this panel refuses, and classic says
              // so in red. In water it says so in the SOAKED blue instead: this
              // mode has no red anywhere, including on the boring lines.
              borderColor: p.bad
                ? water
                  ? rgba(BAND_DRENCHED, 0.55)
                  : "rgba(255,120,120,0.5)"
                : rgba(rarityNum(p.rarity), 0.55),
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: p.bad
                  ? water
                    ? hex(BAND_SOAKED)
                    : "#ff7a7a"
                  : hex(rarityNum(p.rarity)),
              }}
            />
            <span
              className="text-[11px] font-bold"
              style={{
                color: p.bad
                  ? water
                    ? hex(DOWN.rain)
                    : "#ffb4b4"
                  : hex(rarityNum(p.rarity)),
              }}
            >
              {p.bad ? `No room — ${p.name}` : p.name}
            </span>
            {!p.bad && p.count > 1 && (
              <span className="font-heading text-[11px] font-black tabular-nums text-white/70">x{p.count}</span>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function InteractPrompt({ clock, live, prompt }: PanelProps & { prompt: PromptState | null }) {
  const ring = useRef<SVGCircleElement | null>(null);
  const R = 15;
  const CIRC = 2 * Math.PI * R;

  usePainter(clock, () => {
    const el = ring.current;
    if (!el) return;
    el.style.strokeDashoffset = `${CIRC * (1 - clamp01(live.current.promptHold))}`;
  });

  return (
    <AnimatePresence>
      {prompt && (
        <motion.div
          initial={{ opacity: 0, y: 10, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.96, transition: { duration: 0.16 } }}
          className="absolute inset-x-0 bottom-[24%] flex justify-center"
        >
          <div
            className="flex items-center gap-2.5 rounded-[4px] py-1.5 pl-1.5 pr-3.5"
            style={{ ...plate, borderColor: rgba(rarityNum(prompt.rarity), 0.55) }}
          >
            <div className="relative h-9 w-9">
              <svg viewBox="0 0 36 36" className="absolute inset-0 h-9 w-9 -rotate-90">
                <circle cx="18" cy="18" r={R} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="3" />
                <circle
                  ref={ring}
                  cx="18"
                  cy="18"
                  r={R}
                  fill="none"
                  stroke={hex(rarityNum(prompt.rarity))}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={CIRC}
                  strokeDashoffset={CIRC}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center font-heading text-[13px] font-black text-white">
                E
              </span>
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[9px] font-bold uppercase tracking-[0.22em] text-white/50">
                {prompt.hold ? "Hold" : "Press"} E — {prompt.action}
              </span>
              <span
                className="font-heading text-[13px] font-black"
                style={{ color: hex(rarityNum(prompt.rarity)) }}
              >
                {prompt.name}
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------------ *
 * Crosshair, hit marker, damage arcs, scope
 * ------------------------------------------------------------------------ */

/** Bloom in pixels at full spread. Tuned against the AR's hip-fire cone. */
const CROSS_MAX_GAP = 22;
const CROSS_LEN = 10;

function Crosshair({ clock, live }: PanelProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const dot = useRef<HTMLDivElement | null>(null);
  const ring = useRef<SVGCircleElement | null>(null);
  const ringWrap = useRef<HTMLDivElement | null>(null);
  const R = 21;
  const CIRC = 2 * Math.PI * R;
  const oStore = useRef<number[]>([-1, -1, -1]);
  const lastGap = useRef(-1);

  usePainter(clock, () => {
    const l = live.current;
    // Scoped weapons hide the crosshair entirely — the scope overlay carries
    // the reticle instead, exactly like every BR that ships a sniper.
    setOpacity(root.current, l.crossHidden || l.scoped ? 0 : 1, oStore.current, 0);

    const gap = 4 + l.spread * CROSS_MAX_GAP + l.fireKick * 7 - l.ads * 4.5;
    if (Math.abs(gap - lastGap.current) > 0.15) {
      lastGap.current = gap;
      const g = Math.max(1.5, gap);
      const top = bars.current[0];
      const bottom = bars.current[1];
      const left = bars.current[2];
      const right = bars.current[3];
      if (top) top.style.transform = `translate(-1px, ${-(g + CROSS_LEN)}px)`;
      if (bottom) bottom.style.transform = `translate(-1px, ${g}px)`;
      if (left) left.style.transform = `translate(${-(g + CROSS_LEN)}px, -1px)`;
      if (right) right.style.transform = `translate(${g}px, -1px)`;
    }
    setOpacity(dot.current, 0.35 + l.ads * 0.5, oStore.current, 1);
    setOpacity(ringWrap.current, l.reloading ? 1 : 0, oStore.current, 2);
    const rc = ring.current;
    if (rc && l.reloading) rc.style.strokeDashoffset = `${CIRC * (1 - l.reloadProgress)}`;
  });

  const barBase =
    "absolute left-1/2 top-1/2 rounded-[1px] bg-white will-change-transform";
  const barShadow = { boxShadow: "0 0 2px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.5)" };

  return (
    <div ref={root} className="absolute left-1/2 top-1/2 h-0 w-0">
      <div
        ref={(el) => {
          bars.current[0] = el;
        }}
        className={`${barBase} h-[10px] w-[2px]`}
        style={barShadow}
      />
      <div
        ref={(el) => {
          bars.current[1] = el;
        }}
        className={`${barBase} h-[10px] w-[2px]`}
        style={barShadow}
      />
      <div
        ref={(el) => {
          bars.current[2] = el;
        }}
        className={`${barBase} h-[2px] w-[10px]`}
        style={barShadow}
      />
      <div
        ref={(el) => {
          bars.current[3] = el;
        }}
        className={`${barBase} h-[2px] w-[10px]`}
        style={barShadow}
      />
      <div
        ref={dot}
        className="absolute left-1/2 top-1/2 h-[2px] w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
        style={barShadow}
      />
      <div ref={ringWrap} className="absolute left-1/2 top-1/2 h-0 w-0 opacity-0">
        <svg viewBox="0 0 48 48" className="absolute h-12 w-12 -translate-x-1/2 -translate-y-1/2 -rotate-90">
          <circle cx="24" cy="24" r={R} fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="2.5" />
          <circle
            ref={ring}
            cx="24"
            cy="24"
            r={R}
            fill="none"
            stroke="#ffe08a"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC}
          />
        </svg>
      </div>
    </div>
  );
}

/** The elimination splash: eight droplets thrown outward, at mixed radii. */
const SPLASH_SPOKES = [0, 42, 88, 133, 180, 224, 268, 313];

function HitMarker({ clock, live, water = false }: PanelProps & { water?: boolean }) {
  const root = useRef<HTMLDivElement | null>(null);
  const lines = useRef<(HTMLDivElement | null)[]>([]);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const splash = useRef<SVGSVGElement | null>(null);

  usePainter(clock, () => {
    const l = live.current;
    const el = root.current;
    if (!el) return;
    if (l.hitT <= 0) {
      if (el.style.opacity !== "0") el.style.opacity = "0";
      return;
    }
    // Punch out from 1.45 and settle: the scale ramp is what makes the marker
    // read at the exact frame of the hit rather than a blink later.
    const t = 1 - l.hitT;
    el.style.opacity = `${clamp01(l.hitT * 1.6)}`;
    el.style.transform = `translate(-50%,-50%) scale(${lerp(1.45, 1, Math.min(1, t * 3))})`;
    // A confirmed soaking is not an X. Classic's cross means "you put a hole in
    // someone"; here the elimination is a burst of water thrown outward, and
    // the four arms step aside so the shape itself carries the difference —
    // colour alone would still read as a shooter's kill marker.
    const burst = water && l.hitKind === "elim";
    const color = water
      ? l.hitKind === "elim"
        ? hex(DOWN.spray)
        : l.hitKind === "shield"
          ? hex(WATER.balloon.colors[2])
          : "#ffffff"
      : l.hitKind === "elim"
        ? "#ff4d4d"
        : l.hitKind === "shield"
          ? "#8ad4ff"
          : "#ffffff";
    for (const line of lines.current) {
      if (!line) continue;
      line.style.background = color;
      line.style.opacity = burst ? "0" : "1";
    }
    const sp = splash.current;
    if (sp) {
      sp.style.opacity = burst ? `${clamp01(l.hitT * 1.5)}` : "0";
      // Expands past its rest size as it fades — a splash keeps going after the
      // hit lands, which is the whole difference between water and a bullet.
      sp.style.transform =
        `translate(-50%,-50%) scale(${lerp(0.5, 1.45, Math.min(1, t * 1.7)).toFixed(3)})`;
    }
    const r = ringRef.current;
    if (r) r.style.opacity = l.hitHead ? `${clamp01(l.hitT)}` : "0";
  });

  const arm = "absolute left-1/2 top-1/2 h-[2px] w-[11px] rounded-full";
  const offsets = [
    { rot: 45, x: 7, y: 7 },
    { rot: -45, x: 7, y: -7 },
    { rot: 45, x: -7, y: -7 },
    { rot: -45, x: -7, y: 7 },
  ];

  return (
    <div
      ref={root}
      className="absolute left-1/2 top-1/2 h-0 w-0 opacity-0"
      style={{ transform: "translate(-50%,-50%)" }}
    >
      {offsets.map((o, i) => (
        <div
          key={i}
          ref={(el) => {
            lines.current[i] = el;
          }}
          className={arm}
          style={{
            transform: `translate(calc(-50% + ${o.x}px), calc(-50% + ${o.y}px)) rotate(${o.rot}deg)`,
            boxShadow: "0 0 3px rgba(0,0,0,0.9)",
          }}
        />
      ))}
      <div
        ref={ringRef}
        className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0"
        style={{ border: "1.5px solid rgba(255,255,255,0.75)" }}
      />
      {/* The elimination splash. Mounted in both modes and simply never shown
          in classic — one static subtree costs less than a branch that mounts
          and unmounts an SVG in the middle of a fight. */}
      {water && (
        <svg
          ref={splash}
          viewBox="0 0 64 64"
          className="absolute left-1/2 top-1/2 h-16 w-16 opacity-0 will-change-transform"
          style={{ filter: `drop-shadow(0 0 5px ${rgba(DOWN.wall, 0.9)})` }}
        >
          {/* The crown: a broken ring, the way a drop's rim opens when it lands. */}
          <circle
            cx="32"
            cy="32"
            r="11"
            fill="none"
            stroke={hex(DOWN.rim)}
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeDasharray="9 5"
            opacity="0.95"
          />
          {SPLASH_SPOKES.map((deg, i) => {
            const a = (deg * Math.PI) / 180;
            // Alternating throw distances and bead sizes: an even ring of even
            // dots reads as a UI element, an uneven one reads as water.
            const rr = i % 2 ? 25 : 20.5;
            const size = i % 3 === 0 ? 3.1 : 2.2;
            return (
              <circle
                key={deg}
                cx={(32 + Math.cos(a) * rr).toFixed(2)}
                cy={(32 + Math.sin(a) * rr).toFixed(2)}
                r={size}
                fill={i % 2 ? hex(DOWN.spray) : hex(DOWN.mist)}
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}

/**
 * Droplets thrown off the splash arc: angle offset from the arc's centre in
 * radians, radius offset in px from the arc radius, and a bead size. Authored
 * asymmetrically on purpose — a symmetrical spray reads as a graphic.
 */
const ARC_SPRAY: readonly [number, number, number][] = [
  [-0.29, 13, 2.6],
  [-0.19, 22, 1.8],
  [-0.08, 16, 3.2],
  [0.02, 27, 2.1],
  [0.12, 14, 2.4],
  [0.22, 24, 1.7],
  [0.31, 18, 2.9],
];

function DamageArcs({ arcs, water = false }: { arcs: DamageArc[]; water?: boolean }) {
  // Water reads off the Downpour palette rather than a hand-picked cyan, so the
  // wedge at the edge of the frame is the same blue as the wall in the world.
  const near = water ? rgba(DOWN.rim, 0.95) : "rgba(255,70,70,0.95)";
  const far = water ? rgba(DOWN.wall, 0.15) : "rgba(255,70,70,0.15)";
  const glow = water
    ? `drop-shadow(0 0 6px ${rgba(BAND_DRENCHED, 0.7)})`
    : "drop-shadow(0 0 6px rgba(255,40,40,0.55))";
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <AnimatePresence>
        {arcs.map((a) => (
          // Rotation goes through motion's own transform channel (`style.rotate`)
          // rather than a CSS transform string, which motion would overwrite
          // the moment it animates scale. Yaw grows counter-clockwise in this
          // engine (forward is (-sin y, -cos y)), so a positive bearing is to
          // the player's left and the wedge turns the other way on screen.
          <motion.div
            key={a.id}
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.06, transition: { duration: 0.45 } }}
            transition={{ duration: 0.12 }}
            className="absolute left-1/2 top-1/2"
            style={{ x: "-50%", y: "-50%", rotate: (-a.angle * 180) / Math.PI }}
          >
            <svg width="420" height="420" viewBox="0 0 420 420" className="block">
              <defs>
                <linearGradient id={`dmg${a.id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={near} />
                  <stop offset="100%" stopColor={far} />
                </linearGradient>
              </defs>
              <path
                d={arcPath(210, 210, 152, -Math.PI / 2 - 0.3, -Math.PI / 2 + 0.3)}
                fill="none"
                stroke={`url(#dmg${a.id})`}
                // Thickness carries the size of the hit, but a fat wedge stops
                // reading as a *direction*, so it caps early.
                strokeWidth={Math.min(9, 4 + a.amount * 0.11)}
                strokeLinecap="round"
                style={{ filter: glow }}
              />
              {/* Spray thrown inward off the arc. This is what turns a wedge
                  into "someone just threw water at you from over there" — the
                  arc alone, however blue, still reads as a wound. */}
              {water &&
                ARC_SPRAY.map(([da, dr, s]) => {
                  const ang = -Math.PI / 2 + da;
                  return (
                    <circle
                      key={da}
                      cx={(210 + Math.cos(ang) * (152 - dr)).toFixed(2)}
                      cy={(210 + Math.sin(ang) * (152 - dr)).toFixed(2)}
                      r={s}
                      fill={rgba(DOWN.spray, 0.85)}
                      style={{ filter: glow }}
                    />
                  );
                })}
            </svg>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** SVG arc between two angles — used by the directional damage indicator. */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const x0 = cx + Math.cos(a0) * r;
  const y0 = cy + Math.sin(a0) * r;
  const x1 = cx + Math.cos(a1) * r;
  const y1 = cy + Math.sin(a1) * r;
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function ScopeOverlay({ water = false }: { water?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.08 }}
      className="absolute inset-0"
    >
      {/* Body of the scope: everything outside the eyepiece goes black, with a
          soft edge so it reads as glass rather than a mask. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0 30vh, rgba(0,0,0,0.55) 30.6vh, rgba(0,0,0,0.98) 33vh 100%)",
        }}
      />
      {/* Lens tint + chromatic rim */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: "60vh",
          height: "60vh",
          boxShadow:
            "inset 0 0 60px rgba(0,0,0,0.8), inset 0 0 3px rgba(140,200,255,0.55), 0 0 2px rgba(255,190,120,0.35)",
          background:
            "radial-gradient(circle at 38% 32%, rgba(190,225,255,0.07), rgba(0,0,0,0) 45%)",
        }}
      />
      {/* Reticle: fine cross, mil ladder, centre gap */}
      <svg
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ width: "60vh", height: "60vh" }}
        viewBox="0 0 200 200"
      >
        <line x1="100" y1="6" x2="100" y2="88" stroke="rgba(10,12,16,0.85)" strokeWidth="0.8" />
        <line x1="100" y1="112" x2="100" y2="194" stroke="rgba(10,12,16,0.85)" strokeWidth="0.8" />
        <line x1="6" y1="100" x2="88" y2="100" stroke="rgba(10,12,16,0.85)" strokeWidth="0.8" />
        <line x1="112" y1="100" x2="194" y2="100" stroke="rgba(10,12,16,0.85)" strokeWidth="0.8" />
        {[118, 130, 142, 154].map((y) => (
          <line key={y} x1="94" y1={y} x2="106" y2={y} stroke="rgba(10,12,16,0.8)" strokeWidth="0.7" />
        ))}
        {/* The aiming pip. Every scope in every shooter puts a red dot here;
            the Hydro Lance puts a blue one, because nothing in SPLASH ROYALE
            gets to be red — not even two pixels of it. */}
        <circle
          cx="100"
          cy="100"
          r="1.1"
          fill={water ? rgba(DOWN.wall, 0.95) : "rgba(180,20,20,0.9)"}
        />
        <circle cx="100" cy="100" r="46" fill="none" stroke="rgba(10,12,16,0.35)" strokeWidth="0.5" />
      </svg>
    </motion.div>
  );
}

/* ------------------------------------------------------------------------ *
 * Full-screen states
 * ------------------------------------------------------------------------ */

/**
 * Where the water sits on the glass, and where it runs.
 *
 * Authored rather than random, and deliberately hugging the frame: the middle
 * of the screen is where the person soaking you is standing, and a bead parked
 * over them is a bug however pretty it looks. Each entry carries its own phase
 * so no two drops ever cling, slip or run together.
 *
 * BEADS:    x%, y%, radius px, phase.
 * RIVULETS: x%, length px, speed, phase.
 */
const BEADS: readonly [number, number, number, number][] = [
  [4, 13, 8, 0.13],
  [9, 37, 5, 0.61],
  [3, 62, 10, 0.29],
  [12, 81, 6, 0.84],
  [18, 7, 5, 0.72],
  [24, 93, 4, 0.05],
  [37, 4, 6, 0.38],
  [45, 96, 5, 0.66],
  [63, 5, 4, 0.91],
  [72, 94, 6, 0.22],
  [81, 15, 9, 0.11],
  [88, 39, 5, 0.44],
  [96, 63, 7, 0.67],
  [91, 85, 5, 0.33],
];

const RIVULETS: readonly [number, number, number, number][] = [
  [3, 96, 0.42, 0.1],
  [8, 132, 0.3, 0.55],
  [15, 72, 0.5, 0.83],
  [26, 62, 0.55, 0.71],
  [75, 68, 0.5, 0.4],
  [86, 112, 0.36, 0.27],
  [93, 82, 0.46, 0.62],
  [98, 140, 0.28, 0.05],
];

/**
 * SPLASH ROYALE — the wet screen.
 *
 * Drop Zero answers a nearly-empty health bar with a red edge pulse, which is
 * the language of bleeding out. Here the same channel has to say "you are
 * nearly soaked", so it is water ON THE LENS instead: beads clinging to the
 * glass, rivulets running off the bottom of them, and the frame going blue and
 * out of focus from the rim inward as you lose the argument. At 10% dry it
 * should read as a faceful of water, not as a wound.
 *
 * Costs nothing while you are dry. Every layer is `opacity: 0` above 60%
 * dryness and the whole tree short-circuits on the first line of the painter,
 * so a bone-dry player pays for a handful of composited nodes and no work.
 *
 * Like everything else here it animates from ONE painter writing `transform`
 * and `opacity` on nodes it owns — no React state, no per-drop component, and
 * no re-render at 120 Hz next to a renderer that wants the whole frame.
 */
function WetScreen({ clock, live }: PanelProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const glass = useRef<HTMLDivElement | null>(null);
  const beads = useRef<(HTMLDivElement | null)[]>([]);
  const rivs = useRef<(HTMLDivElement | null)[]>([]);
  const oStore = useRef<number[]>([-1, -1]);
  /** Last blur radius actually written, in whole px — see below. */
  const lastBlur = useRef(-1);

  usePainter(clock, () => {
    const l = live.current;
    const el = root.current;
    if (!el) return;

    // Soaked-ness, not health. Nothing at all above 60% dry; full by 10%,
    // which is the number the brief names.
    const soak = clamp01((0.6 - l.dry / l.dryMax) / 0.5);
    // A fresh hit throws water at the glass on top of whatever is already
    // clinging to it, so a single big splash still registers while you are dry.
    const wet = clamp01(soak + l.damageFlash * 0.5);
    setOpacity(el, wet > 0.004 ? 1 : 0, oStore.current, 0);
    if (wet <= 0.004) return;

    const g = glass.current;
    if (g) {
      setOpacity(g, wet, oStore.current, 1);
      // `backdropFilter` is a string, and rebuilding it every frame would
      // allocate one per frame for no visible gain. Quantised to whole pixels,
      // it changes about a dozen times over the whole ramp.
      const px = Math.round(wet * 7);
      if (px !== lastBlur.current) {
        lastBlur.current = px;
        g.style.backdropFilter = `blur(${px}px) saturate(0.82)`;
      }
    }

    for (let i = 0; i < BEADS.length; i++) {
      const b = beads.current[i];
      if (!b) continue;
      const ph = BEADS[i][3];
      // A bead clings, loses its grip, then slides. Per-bead cycles mean the
      // glass is never busy all at once, which is what stops it reading as an
      // animated texture rather than as water.
      const u = (l.t * (0.11 + ph * 0.09) + ph) % 1;
      const slip = u < 0.74 ? 0 : (u - 0.74) / 0.26;
      b.style.transform =
        `translate(-50%,-50%) translateY(${(slip * slip * 30).toFixed(1)}px) ` +
        `scale(${(0.55 + wet * 0.65).toFixed(2)})`;
      b.style.opacity = `${(wet * 0.88 * (1 - slip * 0.9)).toFixed(2)}`;
    }

    for (let i = 0; i < RIVULETS.length; i++) {
      const r = rivs.current[i];
      if (!r) continue;
      const [, , speed, ph] = RIVULETS[i];
      // Rivulets run faster the wetter you are — the glass stops being able to
      // hold it, which is the whole feeling the effect is after.
      const u = (l.t * speed * (0.45 + wet) + ph) % 1;
      r.style.transform = `translate(-50%, ${(u * 118 - 18).toFixed(1)}vh)`;
      r.style.opacity = `${(wet * (1 - u) * 0.8).toFixed(2)}`;
    }
  });

  return (
    <div ref={root} className="absolute inset-0 overflow-hidden opacity-0">
      {/* The rim going blue and soft. `backdrop-filter` does the defocus, the
          mask keeps it off the centre third, and the wash is the Downpour's
          own blue so the screen and the world agree about what water is. */}
      <div
        ref={glass}
        className="absolute inset-0 opacity-0"
        style={{
          background:
            `radial-gradient(ellipse at 50% 50%, ${rgba(DOWN.wall, 0)} 40%, ` +
            `${rgba(DOWN.wall, 0.2)} 76%, ${rgba(DOWN.vignette, 0.44)})`,
          maskImage:
            "radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 38%, rgba(0,0,0,1) 84%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 38%, rgba(0,0,0,1) 84%)",
        }}
      />

      {RIVULETS.map(([x, len], i) => (
        <div
          key={`riv${x}`}
          ref={(el) => {
            rivs.current[i] = el;
          }}
          className="absolute top-0 w-[3px] rounded-full opacity-0 will-change-transform"
          style={{
            left: `${x}%`,
            height: `${len}px`,
            background:
              `linear-gradient(180deg, ${rgba(DOWN.mist, 0)}, ${rgba(DOWN.mist, 0.55)} 60%, ` +
              `${rgba(DOWN.spray, 0.95)})`,
            boxShadow: `0 0 6px ${rgba(DOWN.rim, 0.7)}`,
          }}
        />
      ))}

      {BEADS.map(([x, y, r], i) => (
        <div
          key={`bead${x}-${y}`}
          ref={(el) => {
            beads.current[i] = el;
          }}
          className="absolute rounded-full opacity-0 will-change-transform"
          style={{
            left: `${x}%`,
            top: `${y}%`,
            width: `${r * 2}px`,
            height: `${r * 2.25}px`,
            // A drop is a lens, and the centre of a lens is CLEAR — you can see
            // the world through it. All the colour lives in the specular
            // highlight and the rim; fill the middle in and it stops being
            // water and becomes a ball bearing, which is what the first
            // capture of this looked like.
            background:
              `radial-gradient(circle at 34% 26%, rgba(255,255,255,0.9) 0%, ` +
              `rgba(255,255,255,0.16) 20%, ${rgba(DOWN.mist, 0.12)} 46%, ` +
              `${rgba(DOWN.wall, 0.24)} 76%, ${rgba(DOWN.rim, 0.5)})`,
            boxShadow:
              `inset 0 1px 2px rgba(255,255,255,0.55), ` +
              `inset 0 -2px 3px ${rgba(DOWN.rim, 0.55)}, 0 2px 4px rgba(0,18,38,0.4)`,
          }}
        />
      ))}
    </div>
  );
}

function Vignettes({ clock, live, water = false }: PanelProps & { water?: boolean }) {
  const storm = useRef<HTMLDivElement | null>(null);
  const low = useRef<HTMLDivElement | null>(null);
  const flash = useRef<HTMLDivElement | null>(null);
  const heal = useRef<HTMLDivElement | null>(null);
  const oStore = useRef<number[]>([-1, -1, -1, -1]);

  usePainter(clock, () => {
    const l = live.current;
    setOpacity(storm.current, l.stormVeil, oStore.current, 0);
    // Low health is a heartbeat, not a constant tint: it has to be noticeable
    // in peripheral vision while you are looking at someone else's crosshair.
    // In SPLASH ROYALE the same channel carries "nearly soaked", and it is
    // dialled back hard — the wet glass above it is doing the work now, and two
    // full-strength edge treatments stacked would close the frame right down.
    const lowT = water
      ? clamp01(1 - l.dry / (l.dryMax * 0.3)) * 0.5
      : clamp01(1 - l.health / (l.maxHealth * 0.35));
    setOpacity(low.current, lowT * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(l.t * 6.5))), oStore.current, 1);
    setOpacity(flash.current, l.damageFlash * (water ? 0.7 : 0.55), oStore.current, 2);
    setOpacity(heal.current, l.healFlash * 0.3, oStore.current, 3);
  });

  return (
    <>
      <div
        ref={storm}
        className="absolute inset-0 opacity-0"
        style={{
          boxShadow: water
            ? `inset 0 0 150px 45px ${rgba(DOWN.vignette, 0.5)}, inset 0 0 45px ${rgba(DOWN.wall, 0.55)}`
            : "inset 0 0 140px 40px rgba(150,60,220,0.55), inset 0 0 40px rgba(80,20,140,0.6)",
        }}
      />
      <div
        ref={low}
        className="absolute inset-0 opacity-0"
        style={{
          // The breathing rim. Classic: arterial red. Water: the SOAKED band's
          // deep blue over the Downpour's rim, so the screen edge, the dryness
          // bar and the world all name the same colour for "you are done".
          boxShadow: water
            ? `inset 0 0 170px 34px ${rgba(BAND_SOAKED, 0.5)}, ` +
              `inset 0 0 60px ${rgba(DOWN.wall, 0.4)}`
            : "inset 0 0 160px 30px rgba(200,20,20,0.6)",
        }}
      />
      <div
        ref={flash}
        className="absolute inset-0 opacity-0"
        style={{
          // Getting hit is a splash across the lens: a bright rim of water
          // rather than a red wash. It flashes *lighter*, which is the whole
          // tonal difference between the two modes in one property.
          background: water
            ? `radial-gradient(circle at 50% 50%, rgba(223,244,255,0) 30%, ${rgba(0xdff4ff, 0.34)} 76%, ${rgba(0x4fc3f7, 0.5)})`
            : "radial-gradient(circle at 50% 50%, rgba(255,60,60,0) 35%, rgba(255,40,40,0.45))",
        }}
      />
      <div
        ref={heal}
        className="absolute inset-0 opacity-0"
        style={{
          boxShadow: water
            ? "inset 0 0 120px 20px rgba(255,233,168,0.55)"
            : "inset 0 0 120px 20px rgba(90,220,140,0.5)",
        }}
      />
      {/* Last, so the beads sit on top of every wash behind them — water is on
          the glass, not in the image. */}
      {water && <WetScreen clock={clock} live={live} />}
    </>
  );
}

function StormBanner({
  inStorm,
  clock,
  live,
  water = false,
}: PanelProps & { inStorm: boolean; water?: boolean }) {
  const dps = useRef<HTMLSpanElement | null>(null);
  const dist = useRef<HTMLSpanElement | null>(null);
  const tStore = useRef<string[]>(["", ""]);
  usePainter(clock, () => {
    const l = live.current;
    setText(
      dps.current,
      water ? `-${l.dps.toFixed(1)} ${W.drynessLabel.toLowerCase()}/s` : `-${l.dps.toFixed(0)} hp/s`,
      tStore.current,
      0,
    );
    setText(
      dist.current,
      water
        ? `${Math.max(0, Math.round(l.distToSafe))} m to ${W.stormSafe.toLowerCase()}`
        : `${Math.max(0, Math.round(l.distToSafe))} m to safety`,
      tStore.current,
      1,
    );
  });

  return (
    <AnimatePresence>
      {inStorm && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="absolute inset-x-0 top-[8%] flex justify-center"
        >
          <div
            className="flex items-center gap-3 rounded-[4px] px-4 py-1.5"
            style={{
              ...modePlate(water),
              background: water ? "rgba(12,44,74,0.86)" : "rgba(46,12,66,0.82)",
              borderColor: water ? rgba(DOWN.rim, 0.55) : "rgba(200,120,255,0.5)",
            }}
          >
            <span
              className="font-heading text-[13px] font-black uppercase tracking-[0.22em]"
              style={{ color: water ? hex(DOWN.mist) : "#ede9fe" }}
            >
              {water ? W.stormIn : "You are in the storm"}
            </span>
            <span
              ref={dps}
              className="font-heading text-[12px] font-black tabular-nums"
              style={{ color: water ? hex(DOWN.rain) : "#fca5a5" }}
            />
            <span ref={dist} className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/55" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DropOverlay({
  clock,
  live,
  phase,
  playerState,
}: PanelProps & { phase: string; playerState: string }) {
  const busClock = useRef<HTMLSpanElement | null>(null);
  const busBar = useRef<HTMLDivElement | null>(null);
  const altNum = useRef<HTMLSpanElement | null>(null);
  const groundNum = useRef<HTMLSpanElement | null>(null);
  const speedNum = useRef<HTMLSpanElement | null>(null);
  const tStore = useRef<string[]>(["", "", "", ""]);
  const wStore = useRef<number[]>([-1]);

  usePainter(clock, () => {
    const l = live.current;
    setText(busClock.current, clockText(l.busSecondsLeft), tStore.current, 0);
    setWidth(busBar.current, l.busT * 100, wStore.current, 0);
    setText(altNum.current, `${Math.max(0, Math.round(l.y))}`, tStore.current, 1);
    setText(groundNum.current, `${Math.max(0, Math.round(l.altitude))}`, tStore.current, 2);
    setText(speedNum.current, `${Math.round(l.speed * 3.6)}`, tStore.current, 3);
  });

  const onBus = phase === "bus" || phase === "warmup";
  const falling = playerState === "skydive" || playerState === "glide";

  return (
    <>
      {onBus && (
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute inset-x-0 top-[30%] flex flex-col items-center gap-2"
        >
          <motion.div
            animate={{ scale: [1, 1.04, 1] }}
            transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
            className="flex items-center gap-3 rounded-[4px] px-5 py-2"
            style={{ ...plate, background: INK_SOLID }}
          >
            <span
              className="rounded-[3px] px-2 py-0.5 font-heading text-[11px] font-black uppercase tracking-[0.18em] text-slate-900"
              style={{ background: "linear-gradient(180deg,#fff,#bcd0e0)" }}
            >
              Space
            </span>
            <span className="font-heading text-[15px] font-black uppercase tracking-[0.16em] text-white">
              Drop
            </span>
          </motion.div>
          <div className="flex w-[280px] flex-col gap-1">
            <div className="h-[4px] overflow-hidden rounded-full bg-black/60" style={{ border: `1px solid ${EDGE}` }}>
              <div
                ref={busBar}
                className="h-full w-0"
                style={{ backgroundImage: "linear-gradient(90deg,#7dd3fc,#f0abfc)" }}
              />
            </div>
            <div className="flex justify-between text-[9px] font-bold uppercase tracking-[0.2em] text-white/45">
              <span>Battle bus</span>
              <span ref={busClock} className="tabular-nums text-white/70">
                0:00
              </span>
            </div>
          </div>
        </motion.div>
      )}

      {falling && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute inset-x-0 bottom-[31%] flex flex-col items-center gap-2"
        >
          <div className="flex items-end gap-6 rounded-[4px] px-5 py-2" style={{ ...plate, background: INK_SOLID }}>
            <Readout label="Altitude" unit="m" numRef={altNum} />
            <Readout label="To ground" unit="m" numRef={groundNum} accent="#7dd3fc" />
            <Readout label="Speed" unit="km/h" numRef={speedNum} />
          </div>
          {playerState === "skydive" ? (
            <motion.span
              animate={{ opacity: [0.45, 1, 0.45] }}
              transition={{ repeat: Infinity, duration: 1.2 }}
              className="rounded-[3px] px-2 py-0.5 font-heading text-[11px] font-black uppercase tracking-[0.26em] text-sky-200"
              style={{ background: "rgba(6,10,20,0.6)", textShadow: "0 1px 4px rgba(0,0,0,0.95)" }}
            >
              Space — deploy glider
            </motion.span>
          ) : (
            <span
              className="rounded-[3px] px-2 py-0.5 font-heading text-[11px] font-black uppercase tracking-[0.26em] text-emerald-200"
              style={{ background: "rgba(6,10,20,0.6)", textShadow: "0 1px 4px rgba(0,0,0,0.95)" }}
            >
              Glider deployed
            </span>
          )}
        </motion.div>
      )}
    </>
  );
}

function Readout({
  label,
  unit,
  numRef,
  accent,
}: {
  label: string;
  unit: string;
  numRef: { current: HTMLSpanElement | null };
  accent?: string;
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[8.5px] font-bold uppercase tracking-[0.22em] text-white/45">{label}</span>
      <span className="flex items-baseline gap-1">
        <span
          ref={numRef}
          className="font-heading text-[26px] font-black leading-none tabular-nums"
          style={{ color: accent ?? "#fff", textShadow: "0 2px 8px rgba(0,0,0,0.75)" }}
        >
          0
        </span>
        <span className="text-[9px] font-bold uppercase text-white/40">{unit}</span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * End cards
 * ------------------------------------------------------------------------ */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-[104px] flex-col items-center">
      <span className="font-heading text-[30px] font-black leading-none tabular-nums text-white">{value}</span>
      <span className="mt-1 text-[9px] font-bold uppercase tracking-[0.28em] text-white/45">{label}</span>
    </div>
  );
}

/**
 * Deterministic scatter.
 *
 * The confetti has to hold still across re-renders — the end card re-renders
 * when the restart offer lands, and forty droplets that teleport at that
 * moment look like a glitch, not like weather. So the layout comes from an
 * integer hash of the droplet's own index rather than from `Math.random()`,
 * and a `useMemo` would be redundant on top of it.
 *
 * It is murmur3's finalizer and not a one-multiply LCG for a reason that only
 * shows up on screen: a single multiply leaves consecutive `i` on an
 * arithmetic progression, so two axes drawn from it with different salts differ
 * by a constant and every droplet lands on the same diagonal. The avalanche
 * steps are what make x and y independent.
 */
function scatter(i: number, salt: number): number {
  let h = Math.imul(i + 1, 0x27d4eb2d) ^ Math.imul(salt + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Confetti of droplets.
 *
 * The premise of this whole mode is that nobody gets hurt, they get drenched,
 * so the winner gets thrown water rather than thrown ticker tape. Each drop is
 * a stretched ellipse in the balloon palette with a highlight on its shoulder,
 * falling and drifting on its own clock.
 *
 * **Every drop is placed across the full height at rest, not queued above the
 * top edge.** That is not a style choice: the capture harness screenshots with
 * `animations: "disabled"`, which pins every animation at its first frame, so
 * confetti authored as "start off-screen, fall in" photographs as an empty
 * card — and an empty card is indistinguishable from a broken one. Spread at
 * rest, the frame is honest whether or not the animation ever ran.
 */
function Droplets({ count, tone }: { count: number; tone: "victory" | "loss" }) {
  // The five balloon skins, which are the same five the ammunition is tinted
  // with. Read from the table so a repaint of the balloons repaints the
  // confetti with them.
  const palette = WATER.balloon.colors;
  const drops: ReactElement[] = [];
  for (let i = 0; i < count; i++) {
    const x = scatter(i, 1) * 100;
    const y = scatter(i, 2) * 108 - 4;
    const size = 5 + scatter(i, 3) * 9;
    const color = palette[i % palette.length];
    const dur = (tone === "victory" ? 3.6 : 5.4) + scatter(i, 4) * 3.2;
    const drift = (scatter(i, 5) * 2 - 1) * 5;
    drops.push(
      <motion.span
        key={i}
        aria-hidden
        className="absolute block"
        style={{
          left: `${x}%`,
          top: `${y}%`,
          width: size,
          height: size * 1.55,
          borderRadius: "50%",
          background: `linear-gradient(155deg, rgba(255,255,255,0.92), ${rgba(color, 0.85)} 46%, ${rgba(color, 0.35)})`,
          boxShadow: `0 0 ${size}px ${rgba(color, 0.45)}`,
        }}
        initial={{ opacity: tone === "victory" ? 0.9 : 0.5 }}
        // Viewport units, not percentages: a percentage `y` on a transform is
        // a percentage of the ELEMENT's own height, and these elements are
        // fifteen pixels tall — the drops would twitch a couple of centimetres
        // and loop. `vh` is the distance that actually crosses the card.
        animate={{
          y: ["0vh", "112vh"],
          x: ["0vw", `${drift}vw`],
          opacity: tone === "victory" ? [0.9, 0.9, 0] : [0.5, 0.5, 0],
        }}
        transition={{ duration: dur, repeat: Infinity, ease: "linear" }}
      />,
    );
  }
  return <div className="pointer-events-none absolute inset-0 overflow-hidden">{drops}</div>;
}

/**
 * The rainbow, and the sun coming out behind it.
 *
 * Seven stroked arcs of one circle rather than a single conic gradient: a
 * conic band cannot be feathered on both edges, and a rainbow with a hard
 * outer edge reads as a logo. Drawn wider than the viewport and cropped by the
 * card, so on any aspect ratio you get the top of a very large arc rather than
 * a small complete one sitting in the middle of the screen like a sticker.
 */
const RAINBOW = ["#ff6b6b", "#ff9f43", "#ffe45e", "#8affc1", "#5ecfff", "#7c9bff", "#c08aff"];

function Rainbow() {
  return (
    <motion.svg
      aria-hidden
      viewBox="0 0 200 100"
      preserveAspectRatio="xMidYMax meet"
      className="pointer-events-none absolute left-1/2 top-[6%] h-[92vh] w-[190vh] -translate-x-1/2"
      // Blooms in, but NEVER from zero — same lesson the confetti carries. A
      // capture taken with animations frozen sits on the initial frame, and a
      // rainbow authored as `opacity: 0 → 0.42` photographs as no rainbow at
      // all. That is exactly what the first capture of this card came back as.
      initial={{ opacity: 0.26, scale: 1.05 }}
      animate={{ opacity: 0.46, scale: 1 }}
      transition={{ duration: 1.6, delay: 0.35, ease: "easeOut" }}
    >
      <defs>
        {/* Fade the arc out at both feet — a rainbow that stops dead where it
            meets the ground is the tell that it was drawn rather than seen. */}
        <linearGradient id="dz-bow-fade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="26%" stopColor="#fff" stopOpacity="1" />
          <stop offset="74%" stopColor="#fff" stopOpacity="1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="dz-bow-mask">
          <rect x="0" y="0" width="200" height="100" fill="url(#dz-bow-fade)" />
        </mask>
      </defs>
      <g mask="url(#dz-bow-mask)" fill="none" strokeLinecap="round">
        {RAINBOW.map((c, i) => (
          <path
            key={c}
            d={`M ${14 + i * 2.6} 100 A ${86 - i * 2.6} ${86 - i * 2.6} 0 0 1 ${186 - i * 2.6} 100`}
            stroke={c}
            strokeWidth={2.8}
            opacity={0.85 - i * 0.03}
            style={{ filter: "blur(1.1px)" }}
          />
        ))}
      </g>
    </motion.svg>
  );
}

function EndCard({
  ending,
  canRestart,
  onRestart,
  water = false,
}: {
  ending: Ending;
  canRestart: boolean;
  onRestart: () => void;
  water?: boolean;
}) {
  const victory = ending.kind === "victory";
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
      className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center overflow-hidden font-body"
      style={{
        background: water
          ? // Sunny, not solemn: the water end cards keep a lit sky at the top
            // of the frame instead of closing to black, because losing a water
            // fight is funny and winning one is a pool party.
            victory
            ? "radial-gradient(circle at 50% 34%, rgba(96,198,236,0.6), rgba(20,74,116,0.9) 46%, rgba(5,22,42,0.95) 72%)"
            : "radial-gradient(circle at 50% 36%, rgba(52,126,170,0.6), rgba(14,52,90,0.9) 48%, rgba(4,16,32,0.96) 74%)"
          : victory
            ? "radial-gradient(circle at 50% 38%, rgba(52,32,8,0.82), rgba(3,4,10,0.95) 62%)"
            : "radial-gradient(circle at 50% 40%, rgba(30,8,10,0.86), rgba(2,3,8,0.96) 65%)",
      }}
    >
      {/* The sun coming out. It blooms in over a second and a half rather
          than being there from frame one, so the card has an arc: the water
          clears, then the light arrives. Victory only — losing gets the same
          lit sky the palette already carries, but not the fanfare. */}
      {victory && water && (
        <motion.div
          aria-hidden
          className="absolute left-1/2 top-[22%] h-[120vh] w-[120vh] -translate-x-1/2 -translate-y-1/2"
          initial={{ opacity: 0.5, scale: 0.82 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.5, delay: 0.25, ease: "easeOut" }}
          style={{
            background:
              "radial-gradient(circle, rgba(255,244,200,0.55) 0%, rgba(255,214,120,0.28) 22%, rgba(255,190,90,0) 58%)",
          }}
        />
      )}

      {victory && water && <Rainbow />}

      {victory && (
        <motion.div
          aria-hidden
          className="absolute left-1/2 top-[34%] h-[160vh] w-[160vh] -translate-x-1/2 -translate-y-1/2 opacity-[0.22]"
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 90, ease: "linear" }}
          style={{
            background: water
              ? "conic-gradient(from 0deg, rgba(155,232,255,0.55) 0deg, rgba(155,232,255,0) 12deg, rgba(155,232,255,0) 30deg, rgba(255,228,94,0.4) 42deg, rgba(155,232,255,0) 60deg)"
              : "conic-gradient(from 0deg, rgba(255,205,110,0.55) 0deg, rgba(255,205,110,0) 12deg, rgba(255,205,110,0) 30deg, rgba(255,205,110,0.4) 42deg, rgba(255,205,110,0) 60deg)",
            maskImage: "radial-gradient(circle, rgba(0,0,0,1) 10%, rgba(0,0,0,0) 65%)",
            WebkitMaskImage: "radial-gradient(circle, rgba(0,0,0,1) 10%, rgba(0,0,0,0) 65%)",
          }}
        />
      )}

      {/* Water falls on both cards. Far more people will see the losing one,
          and a defeat screen with a little water still drifting past it says
          "that was a water fight" where a still, dark one says "you died". */}
      {water && <Droplets count={victory ? 46 : 20} tone={victory ? "victory" : "loss"} />}

      <motion.div
        initial={{ scale: 0.9, y: 16, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 26, delay: 0.12 }}
        className="relative flex flex-col items-center px-8 text-center"
      >
        {/*
          A scrim under the type.

          The card sits over a live render of a sunlit town, and the first
          capture of this one put the eyebrow — 11 px, letter-spaced half an em,
          70% white — across a lit stucco wall, where it was simply not there.
          Everything else on the card is either huge or on a plate; this line
          and the sub are the only bare small type, so they get their own soft
          ground rather than the whole card getting darker and losing the sun.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-24 -inset-y-14 -z-10"
          style={{
            background:
              "radial-gradient(ellipse at 50% 42%, rgba(3,16,32,0.62) 0%, rgba(3,16,32,0.34) 46%, rgba(3,16,32,0) 76%)",
          }}
        />
        {victory ? (
          <>
            <span
              className="text-[11px] font-bold uppercase tracking-[0.55em]"
              style={{
                color: water ? "rgba(198,242,255,0.95)" : "rgba(253,230,138,0.9)",
                textShadow: "0 1px 10px rgba(2,12,26,0.9)",
              }}
            >
              #1 of {ending.lobby}
            </span>
            <h1
              className="mt-2 font-heading text-6xl font-black uppercase leading-[0.95] tracking-tight sm:text-8xl"
              style={{
                backgroundImage: water
                  ? "linear-gradient(180deg,#ffffff 8%,#bff0ff 44%,#3aa9e8 100%)"
                  : "linear-gradient(180deg,#fff7dd 8%,#ffd479 46%,#e08a1e 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                filter: water
                  ? "drop-shadow(0 6px 34px rgba(120,215,255,0.5))"
                  : "drop-shadow(0 6px 34px rgba(255,190,80,0.45))",
              }}
            >
              {water ? (
                W.victory
              ) : (
                <>
                  Victory
                  <br />
                  Royale
                </>
              )}
            </h1>
            {water && (
              <p
                className="mt-3 text-sm text-sky-50/85"
                style={{ textShadow: "0 1px 10px rgba(2,12,26,0.9)" }}
              >
                {W.victorySub}
              </p>
            )}
            {/* The lobby, said out loud. "#1 of 100" is a rank; "you dropped
                with 99 other people and none of them got you" is a story, and
                it is the line that makes the screenshot worth posting. */}
            {ending.aliveAtDrop > 1 && (
              <motion.p
                className="mt-1 text-[11px] font-bold uppercase tracking-[0.3em] text-white/60"
                style={{ textShadow: "0 1px 10px rgba(2,12,26,0.9)" }}
                initial={{ opacity: 0.55 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.8, duration: 0.6 }}
              >
                {ending.aliveAtDrop} dropped · one walked home dry
              </motion.p>
            )}
          </>
        ) : (
          <>
            <span
              className="text-[11px] font-bold uppercase tracking-[0.55em]"
              style={{
                color: water ? "rgba(198,242,255,0.92)" : "rgba(254,202,202,0.85)",
                textShadow: "0 1px 10px rgba(2,12,26,0.9)",
              }}
            >
              {water ? W.eliminated : "Eliminated"}
            </span>
            <h1
              className="mt-1 font-heading text-7xl font-black uppercase leading-none tabular-nums tracking-tight sm:text-8xl"
              style={{
                backgroundImage: water
                  ? "linear-gradient(180deg,#ffffff 10%,#9be8ff 58%,#2a5f96 100%)"
                  : "linear-gradient(180deg,#ffffff 10%,#ff9d9d 60%,#b02020 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                filter: water
                  ? "drop-shadow(0 6px 30px rgba(90,182,232,0.4))"
                  : "drop-shadow(0 6px 30px rgba(255,60,60,0.35))",
              }}
            >
              {water ? fmt(W.placement, { n: ending.placement }) : `#${ending.placement}`}
            </h1>
            {/*
              Who did it, and with what. This one line is the whole reason a
              player presses the button again — "soaked by OnyxSentry42 with a
              Pump Blaster" is an opponent and a grudge, where "eliminated" is
              a status. The Downpour gets its own name rather than being fed
              through the "by {name}" template as if the weather were a rival.
            */}
            <p
              className="mt-2 text-sm text-white/75"
              style={{ textShadow: "0 1px 10px rgba(2,12,26,0.9)" }}
            >
              {water ? (
                <span className="font-bold text-white/90">
                  {fmt(W.eliminatedBy, { by: ending.environmental ? W.stormName : ending.killer })}
                </span>
              ) : (
                <>
                  Taken out by <span className="font-bold text-white/90">{ending.killer}</span>
                </>
              )}
              {ending.weapon && !ending.environmental ? (
                <span className="text-white/40"> · {ending.weapon}</span>
              ) : null}
            </p>
          </>
        )}

        {/*
          The numbers that make it personal.

          Four, not three, and the two new ones are the two the game already
          knew and never told anybody: how far the best shot you landed was,
          and how much you swung a pickaxe for. Both are tallied in the HUD's
          own live model off events it was already receiving — nothing new
          crosses the engine boundary for them.
        */}
        <div
          className="mt-8 flex flex-wrap items-center justify-center gap-x-7 gap-y-4 rounded-[6px] px-8 py-4"
          style={{ ...modePlate(water), background: water ? "rgba(8,26,44,0.66)" : "rgba(6,10,20,0.66)" }}
        >
          <Stat label={water ? W.elimsLabel : "Eliminations"} value={`${ending.eliminations}`} />
          <div className="h-9 w-px bg-white/10" />
          {victory ? (
            <Stat label="Placement" value={`#${ending.placement}`} />
          ) : (
            <Stat
              label={water ? "Out-dried" : "Outlived"}
              value={`${Math.max(0, ending.lobby - ending.placement)}`}
            />
          )}
          <div className="h-9 w-px bg-white/10" />
          <Stat label={water ? "Time dry" : "Time survived"} value={clockText(ending.matchTime)} />
          <div className="h-9 w-px bg-white/10" />
          <Stat
            label="Longest shot"
            // An em dash, not "0 m". A player who never landed a hit knows it
            // already and does not need a zero to confirm it on their card.
            value={ending.longestShot >= 1 ? `${Math.round(ending.longestShot)} m` : "—"}
          />
          <div className="h-9 w-px bg-white/10" />
          <Stat label="Harvested" value={`${Math.round(ending.harvested)}`} />
        </div>

        <div className="mt-8 flex items-center gap-3">
          <motion.button
            type="button"
            onClick={onRestart}
            disabled={!canRestart}
            initial={{ opacity: 0 }}
            animate={{ opacity: canRestart ? 1 : 0.35 }}
            whileHover={canRestart ? { scale: 1.04 } : undefined}
            whileTap={canRestart ? { scale: 0.97 } : undefined}
            className="pointer-events-auto rounded-full px-9 py-3 font-heading text-[13px] font-black uppercase tracking-[0.24em] text-slate-900 disabled:cursor-default"
            style={{
              backgroundImage: water
                ? victory
                  ? "linear-gradient(180deg,#e8fbff,#5ecfff)"
                  : "linear-gradient(180deg,#dbe9f5,#8fb4d0)"
                : victory
                  ? "linear-gradient(180deg,#ffe7a8,#f5b942)"
                  : "linear-gradient(180deg,#dbe9f5,#8fb4d0)",
              boxShadow: "0 10px 34px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.7)",
            }}
          >
            {water ? "Get wet again" : "Drop again"}
          </motion.button>
          <a
            href="/"
            className="pointer-events-auto rounded-full border border-white/15 px-6 py-3 text-[11px] font-bold uppercase tracking-[0.24em] text-white/55 transition hover:text-white"
          >
            Back to the vibeverse
          </a>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------------ *
 * Minimap model + drawing
 * ------------------------------------------------------------------------ */

const TAU = Math.PI * 2;
const COAST_BINS = 96;

/**
 * The HUD is not allowed to read the terrain service, and `dz:terrain-ready`
 * carries the POI pads but not the coastline. So the coast is *inferred*: a
 * three-octave wobble around a radius that must contain every pad, squashed
 * north-south the way the island itself is. It is not the exact shoreline —
 * it is a map-maker's shoreline, which is what a minimap wants anyway.
 */
function buildMapModel(worldSize: number, pads: MapPad[]): MapModel {
  let maxDist = 0;
  for (const p of pads) maxDist = Math.max(maxDist, Math.hypot(p.x, p.z));
  const islandR = clamp(maxDist + 240, worldSize * 0.55, worldSize * 0.82);

  const coast = new Float32Array(COAST_BINS);
  for (let i = 0; i < COAST_BINS; i++) {
    const a = (i / COAST_BINS) * TAU;
    let r =
      islandR *
      (1 + 0.055 * Math.sin(3 * a + 1.1) + 0.036 * Math.sin(5 * a + 2.4) + 0.02 * Math.sin(8 * a + 0.4));
    // The terrain squashes the isle ~6% north-south; match it or the map and
    // the world disagree about where the beach is.
    r *= 1 - 0.055 * Math.sin(a) * Math.sin(a);
    coast[i] = r;
  }
  for (const p of pads) {
    const d = Math.hypot(p.x, p.z);
    const a = (Math.atan2(p.z, p.x) + TAU) % TAU;
    const bin = Math.round((a / TAU) * COAST_BINS) % COAST_BINS;
    for (let k = -3; k <= 3; k++) {
      const i = (bin + k + COAST_BINS) % COAST_BINS;
      const want = d + 170 - Math.abs(k) * 22;
      if (coast[i] < want) coast[i] = want;
    }
  }

  // Roads: every POI to its two nearest neighbours. The real road graph is
  // built by the POI system and never published, but "nearest two" reproduces
  // the shape of it closely enough to be a useful navigation hint.
  const links: [number, number][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < pads.length; i++) {
    const order: { j: number; d: number }[] = [];
    for (let j = 0; j < pads.length; j++) {
      if (j === i) continue;
      order.push({ j, d: Math.hypot(pads[j].x - pads[i].x, pads[j].z - pads[i].z) });
    }
    order.sort((a, b) => a.d - b.d);
    for (const o of order.slice(0, 2)) {
      const key = i < o.j ? `${i}-${o.j}` : `${o.j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push([i, o.j]);
    }
  }

  return { worldSize, pads, islandR, coast, links };
}

/** Coast radius at an arbitrary angle, linearly interpolated between bins. */
function coastAt(model: MapModel, a: number): number {
  const t = (((a % TAU) + TAU) % TAU) / TAU * COAST_BINS;
  const i = Math.floor(t);
  const f = t - i;
  const r0 = model.coast[i % COAST_BINS];
  const r1 = model.coast[(i + 1) % COAST_BINS];
  return lerp(r0, r1, f);
}

const hatchCache = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasPattern | null>>();

/**
 * Diagonal hatch inside the storm — the texture is what stops it reading flat.
 * Keyed by colour as well as context so the Downpour's rain streaks and the
 * classic storm's violet can coexist without rebuilding a pattern per frame.
 */
function stormHatch(g: CanvasRenderingContext2D, stroke: string): CanvasPattern | null {
  let byColor = hatchCache.get(g);
  if (!byColor) {
    byColor = new Map();
    hatchCache.set(g, byColor);
  }
  const cached = byColor.get(stroke);
  if (cached !== undefined) return cached;
  let pattern: CanvasPattern | null = null;
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  const h = c.getContext("2d");
  if (h) {
    h.strokeStyle = stroke;
    h.lineWidth = 1;
    h.beginPath();
    h.moveTo(-2, 6);
    h.lineTo(6, -2);
    h.moveTo(2, 10);
    h.lineTo(10, 2);
    h.stroke();
    pattern = g.createPattern(c, "repeat");
  }
  byColor.set(stroke, pattern);
  return pattern;
}

function landPath(model: MapModel, scale: number, px: (v: number) => number, py: (v: number) => number): Path2D {
  const path = new Path2D();
  for (let i = 0; i <= COAST_BINS; i++) {
    const a = (i / COAST_BINS) * TAU;
    const r = coastAt(model, a) * scale;
    const x = px(Math.cos(a) * r);
    const y = py(Math.sin(a) * r);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  path.closePath();
  return path;
}

function drawMinimap(
  g: CanvasRenderingContext2D,
  l: Live,
  model: MapModel | null,
  size: number,
  water = false,
): void {
  const half = size / 2;
  const s = size / (2 * Math.max(60, l.mapView));
  const px = (wx: number): number => (wx - l.mapCenterX) * s + half;
  const py = (wz: number): number => (wz - l.mapCenterZ) * s + half;

  g.save();
  g.clearRect(0, 0, size, size);

  // ---- sea --------------------------------------------------------------
  const sea = g.createLinearGradient(0, 0, 0, size);
  sea.addColorStop(0, "#0d3355");
  sea.addColorStop(1, "#061a2e");
  g.fillStyle = sea;
  g.fillRect(0, 0, size, size);

  if (model) {
    // ---- shelf + beach --------------------------------------------------
    g.save();
    g.shadowColor = "rgba(0,0,0,0.55)";
    g.shadowBlur = 10;
    g.fillStyle = "#3d7fa8";
    g.fill(landPath(model, 1.035, px, py));
    g.restore();

    g.fillStyle = "#dcc590";
    g.fill(landPath(model, 1.0, px, py));

    // ---- land -----------------------------------------------------------
    const land = landPath(model, 0.965, px, py);
    const grass = g.createLinearGradient(0, 0, 0, size);
    grass.addColorStop(0, "#5a9448");
    grass.addColorStop(1, "#3d7038");
    g.fillStyle = grass;
    g.fill(land);

    // Forest/relief mottling, clipped to the land. Deterministic offsets so
    // the map does not shimmer between frames.
    g.save();
    g.clip(land);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + 0.6;
      const rr = model.islandR * (0.28 + 0.42 * ((i * 7919) % 11) / 11);
      const bx = px(Math.cos(a) * rr);
      const by = py(Math.sin(a) * rr);
      const rad = model.islandR * 0.3 * s;
      const blob = g.createRadialGradient(bx, by, 0, bx, by, Math.max(4, rad));
      blob.addColorStop(0, i % 2 ? "rgba(40,84,42,0.45)" : "rgba(122,150,88,0.35)");
      blob.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = blob;
      g.fillRect(bx - rad, by - rad, rad * 2, rad * 2);
    }

    // ---- roads ----------------------------------------------------------
    g.strokeStyle = "rgba(232,220,186,0.32)";
    g.lineWidth = Math.max(1, 2.6 * Math.min(1, s * 260));
    g.lineCap = "round";
    for (const [i, j] of model.links) {
      const a = model.pads[i];
      const b = model.pads[j];
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      // Bow the link the way the POI system bows its roads.
      const nx = -(b.z - a.z) * 0.09;
      const nz = (b.x - a.x) * 0.09;
      g.beginPath();
      g.moveTo(px(a.x), py(a.z));
      g.quadraticCurveTo(px(mx + nx), py(mz + nz), px(b.x), py(b.z));
      g.stroke();
    }
    g.restore();

    // ---- POIs -----------------------------------------------------------
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "700 8.5px ui-sans-serif, system-ui, sans-serif";
    for (const p of model.pads) {
      const x = px(p.x);
      const y = py(p.z);
      if (x < -40 || y < -40 || x > size + 40 || y > size + 40) continue;
      g.save();
      g.translate(x, y);
      g.rotate(Math.PI / 4);
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.fillRect(-2, -2, 4, 4);
      g.strokeStyle = "rgba(0,0,0,0.6)";
      g.lineWidth = 1;
      g.strokeRect(-2, -2, 4, 4);
      g.restore();

      g.shadowColor = "rgba(0,0,0,0.9)";
      g.shadowBlur = 3;
      g.fillStyle = "rgba(255,255,255,0.92)";
      // Nudge the label back inside the frame rather than letting it run off
      // the edge — half a POI name is worse than a slightly offset one.
      const label = p.name.toUpperCase();
      const halfW = g.measureText(label).width / 2 + 3;
      g.fillText(label, clamp(x, halfW, size - halfW), y - 8);
      g.shadowBlur = 0;
    }
  }

  // ---- storm ------------------------------------------------------------
  const scx = px(l.centerX);
  const scy = py(l.centerZ);
  const sr = l.radius * s;
  if (sr > 1) {
    const outside = new Path2D();
    outside.rect(0, 0, size, size);
    outside.moveTo(scx + sr, scy);
    outside.arc(scx, scy, sr, 0, TAU);
    g.fillStyle = water ? rgba(DOWN.wall, 0.34) : "rgba(122,40,196,0.36)";
    g.fill(outside, "evenodd");
    const hatch = stormHatch(g, water ? rgba(DOWN.rain, 0.26) : "rgba(232,190,255,0.20)");
    if (hatch) {
      g.fillStyle = hatch;
      g.fill(outside, "evenodd");
    }

    g.save();
    g.strokeStyle = water ? rgba(DOWN.rim, 0.95) : "rgba(244,220,255,0.95)";
    g.lineWidth = 1.6;
    g.shadowColor = water ? rgba(DOWN.wall, 0.95) : "rgba(190,110,255,0.95)";
    g.shadowBlur = 8;
    g.beginPath();
    g.arc(scx, scy, sr, 0, TAU);
    g.stroke();
    g.restore();
  }

  // Next circle: dashed, drifting, so it never reads as the live wall.
  if (l.nextRadius > 1) {
    g.save();
    g.setLineDash([5, 4]);
    g.lineDashOffset = -l.t * 10;
    g.strokeStyle = water ? rgba(DOWN.nextRing, 0.9) : "rgba(255,255,255,0.8)";
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(px(l.nextX), py(l.nextZ), l.nextRadius * s, 0, TAU);
    g.stroke();
    g.restore();
  }

  // ---- bus route --------------------------------------------------------
  const dropping = l.phase === "warmup" || l.phase === "bus" || l.phase === "dropping";
  if (dropping && l.busRouteValid) {
    g.save();
    g.setLineDash([7, 6]);
    g.lineDashOffset = -l.t * 22;
    g.strokeStyle = "rgba(255,255,255,0.6)";
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(px(l.busFromX), py(l.busFromZ));
    g.lineTo(px(l.busToX), py(l.busToZ));
    g.stroke();
    g.restore();

    const bx = px(l.busX);
    const by = py(l.busZ);
    const ang = Math.atan2(l.busToZ - l.busFromZ, l.busToX - l.busFromX);
    g.save();
    g.translate(bx, by);
    g.rotate(ang);
    g.fillStyle = "#ffe08a";
    g.strokeStyle = "rgba(0,0,0,0.8)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(6, 0);
    g.lineTo(-4, 4);
    g.lineTo(-2, 0);
    g.lineTo(-4, -4);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  // ---- player -----------------------------------------------------------
  const pxp = px(l.x);
  const pyp = py(l.z);
  g.save();
  g.translate(pxp, pyp);
  g.rotate(-l.yaw);
  const cone = g.createRadialGradient(0, 0, 2, 0, 0, 44);
  cone.addColorStop(0, "rgba(255,255,255,0.34)");
  cone.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = cone;
  g.beginPath();
  g.moveTo(0, 0);
  g.arc(0, 0, 44, -Math.PI / 2 - 0.52, -Math.PI / 2 + 0.52);
  g.closePath();
  g.fill();

  g.beginPath();
  g.moveTo(0, -7.5);
  g.lineTo(5.5, 6.5);
  g.lineTo(0, 3.2);
  g.lineTo(-5.5, 6.5);
  g.closePath();
  g.fillStyle = "#ffffff";
  g.strokeStyle = "rgba(0,0,0,0.85)";
  g.lineWidth = 1.4;
  g.stroke();
  g.fill();
  g.restore();

  // ---- glass ------------------------------------------------------------
  const vig = g.createRadialGradient(half, half, size * 0.28, half, half, size * 0.72);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.42)");
  g.fillStyle = vig;
  g.fillRect(0, 0, size, size);

  g.restore();
}
