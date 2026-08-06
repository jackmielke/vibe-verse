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
 * Everything is `pointer-events-none` except the buttons on the end cards.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Engine } from "../engine/core";
import { RARITY_COLOR, type Rarity } from "../types";

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

  // ---- prompts ----------------------------------------------------------
  promptHold: number;
  consumeT: number;

  // ---- minimap ----------------------------------------------------------
  mapView: number;
  mapCenterX: number;
  mapCenterZ: number;
  /** Rolling clock the minimap uses for dashes and pulses. */
  t: number;
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

    promptHold: 0,
    consumeT: 0,

    mapView: 1200,
    mapCenterX: 0,
    mapCenterZ: 0,
    t: 0,
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

export default function HUD({ engine, locked }: { engine: Engine; locked: boolean }) {
  const live = useRef<Live>(makeLive());
  const clock = useMemo(() => new HudClock(), []);
  const nextId = useRef(1);

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
  const [needsReload, setNeedsReload] = useState(false);
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

    // Signatures let a payload that fires every frame drive React state only
    // when the part React cares about actually changed.
    let slotSig = "";
    let stateSig = "";
    let phaseSig = "";
    let scopeSig = false;
    let stormSig = false;
    let promptSig = "";
    let consumeSig = "";
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
      l.stormTimerMax = 1;
      pushToast(
        bool(d.closing) ? "The storm is closing" : `Zone ${circle} incoming`,
        bool(d.closing) ? `Zone ${circle}` : "Move to the safe area",
        "urgent",
      );
    });

    on("dz:storm-warn", (p) => {
      const d = rec(p);
      const seconds = Math.round(num(d.seconds));
      if (seconds > 0 && seconds <= 30) {
        pushToast(`Storm closes in ${seconds}s`, "", "urgent");
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
        pushToast(`${victim} eliminated`, `${l.eliminations} elimination${l.eliminations === 1 ? "" : "s"}`, "elim");
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
      setEnding({
        kind: "victory",
        placement: 1,
        eliminations: Math.round(num(d.eliminations, l.eliminations)),
        matchTime: num(d.matchTime),
        lobby: Math.round(num(d.lobby, 100)),
        killer: "",
        weapon: "",
      });
    });

    on("dz:eliminated", (p) => {
      const d = rec(p);
      setEnding({
        kind: "eliminated",
        placement: Math.round(num(d.placement, l.alive)),
        eliminations: Math.round(num(d.eliminations, l.eliminations)),
        matchTime: num(d.matchTime),
        lobby: Math.round(num(d.lobby, 100)),
        killer: str(d.killer, "the storm"),
        weapon: str(d.weapon),
      });
    });

    on("dz:restart-available", (p) => {
      const d = rec(p);
      // The island, loot table and storm are baked once at boot; match.ts
      // says so in the payload. A rematch is a route reload, nothing clever.
      setNeedsReload(str(d.method, "reload") === "reload");
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

  const restart = useCallback(() => {
    if (needsReload) window.location.reload();
  }, [needsReload]);

  const dropping = phase === "warmup" || phase === "bus" || phase === "dropping";

  return (
    <>
      {/* The end card owns the screen: leaving a live HUD under a victory
          headline is the single cheapest-looking thing a BR can do. */}
      {locked && !ending && (
        <div className="pointer-events-none absolute inset-0 z-20 select-none font-body text-white">
          <Vignettes clock={clock} live={live} />
          <Crosshair clock={clock} live={live} />
          <HitMarker clock={clock} live={live} />
          <DamageArcs arcs={arcs} />
          <AnimatePresence>{scoped && <ScopeOverlay key="scope" />}</AnimatePresence>

          <div className="absolute bottom-6 left-6 flex flex-col gap-2">
            <Vitals clock={clock} live={live} />
          </div>

          <div className="absolute bottom-6 right-6 flex flex-col items-end gap-2">
            <ConsumeBar clock={clock} live={live} consume={consume} />
            <MaterialsRow clock={clock} live={live} />
            <InventoryBar clock={clock} live={live} slots={slots} />
          </div>

          <div className="absolute right-6 top-5 flex w-[236px] flex-col items-stretch gap-2">
            <Minimap clock={clock} live={live} map={map} />
            <StormPanel clock={clock} live={live} />
            <AliveBlock clock={clock} live={live} />
            <KillFeed feed={feed} />
          </div>

          <ToastStack toasts={toasts} />
          <PickupLog pickups={pickups} />
          <InteractPrompt clock={clock} live={live} prompt={prompt} />
          {dropping && <DropOverlay clock={clock} live={live} phase={phase} playerState={playerState} />}
          <StormBanner inStorm={inStorm} clock={clock} live={live} />
        </div>
      )}

      <AnimatePresence>
        {ending && (
          <EndCard key={ending.kind} ending={ending} canRestart={canRestart} onRestart={restart} />
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

function MaterialsRow({ clock, live }: PanelProps) {
  const kinds = ["wood", "stone", "metal"] as const;
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
        chip.style.boxShadow =
          f > 0 ? `${BEVEL}, 0 0 ${8 + f * 16}px ${rgba(parseInt(MAT_STYLE[k].bright.slice(1), 16), f * 0.7)}` : BEVEL;
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
        const Icon = MAT_ICON[k];
        const style = MAT_STYLE[k];
        return (
          <div
            key={k}
            ref={(el) => {
              chips.current[i] = el;
            }}
            className="relative flex h-[26px] w-[74px] items-center gap-1.5 rounded-[3px] px-1.5 transition-none"
            style={{
              ...plate,
              backgroundImage: `linear-gradient(180deg, ${rgba(parseInt(style.deep.slice(1), 16), 0.55)}, rgba(4,7,14,0.75))`,
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

function InventoryBar({ clock, live, slots }: PanelProps & { slots: SlotMeta[] }) {
  const mags = useRef<(HTMLSpanElement | null)[]>([]);
  const reserves = useRef<(HTMLSpanElement | null)[]>([]);
  const counts = useRef<(HTMLSpanElement | null)[]>([]);
  const progress = useRef<(HTMLDivElement | null)[]>([]);
  const tStore = useRef<string[]>([]);
  const wStore = useRef<number[]>([]);

  usePainter(clock, () => {
    const l = live.current;
    for (let i = 0; i < 6; i++) {
      const a = l.slotAmmo[i];
      setText(mags.current[i], `${a.ammo}`, tStore.current, i);
      setText(reserves.current[i], `${a.reserve}`, tStore.current, 6 + i);
      setText(counts.current[i], a.count > 1 ? `x${a.count}` : "", tStore.current, 12 + i);
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
                    background: "linear-gradient(180deg, rgba(4,7,14,0), rgba(4,7,14,0.9) 55%)",
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

            {/* Ammo, under the slot: mag big, reserve small — the shooter read */}
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
                  <span className="text-[9px] font-bold leading-none text-white/35">/</span>
                  <span
                    ref={(el) => {
                      reserves.current[s.index] = el;
                    }}
                    className="text-[10px] font-bold leading-none tabular-nums text-white/55"
                  />
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
 * Minimap
 * ------------------------------------------------------------------------ */

const MAP_SIZE = 236;

function Minimap({ clock, live, map }: PanelProps & { map: MapModel | null }) {
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
    drawMinimap(g, l, map, MAP_SIZE);
  });

  return (
    <div className="relative">
      {/* Compass strip */}
      <div
        className="relative mb-1 h-[16px] overflow-hidden rounded-[3px]"
        style={{ ...plate, background: "rgba(6,10,20,0.66)" }}
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
        style={{ ...plate, width: MAP_SIZE, height: MAP_SIZE, padding: 0 }}
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

function StormPanel({ clock, live }: PanelProps) {
  const circleText = useRef<HTMLSpanElement | null>(null);
  const timerText = useRef<HTMLSpanElement | null>(null);
  const label = useRef<HTMLSpanElement | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const dot = useRef<HTMLDivElement | null>(null);
  const tStore = useRef<string[]>(["", "", ""]);
  const wStore = useRef<number[]>([-1]);

  usePainter(clock, () => {
    const l = live.current;
    setText(circleText.current, `Zone ${l.circle}`, tStore.current, 0);
    setText(timerText.current, clockText(l.stormTimer), tStore.current, 1);
    setText(label.current, l.closing ? "Zone closing" : "Zone moving in", tStore.current, 2);
    setWidth(bar.current, (1 - clamp01(l.stormTimer / Math.max(1, l.stormTimerMax))) * 100, wStore.current, 0);
    const t = label.current;
    if (t) t.style.color = l.closing ? "#ff8a8a" : "rgba(255,255,255,0.6)";
    const d = dot.current;
    if (d) {
      // The bead pulses only while the wall is actually moving — a permanently
      // animated element stops carrying information.
      const pulse = l.closing ? 0.6 + 0.4 * Math.sin(l.t * 6.2) : 0.85;
      d.style.opacity = `${pulse}`;
      d.style.boxShadow = `0 0 ${l.closing ? 12 : 6}px ${rgba(0xa45cf0, 0.9)}`;
    }
  });

  return (
    <div className="rounded-[4px] px-2 py-1.5" style={plate}>
      <div className="flex items-center gap-2">
        <div
          ref={dot}
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: STORM_PURPLE, border: "1px solid rgba(255,255,255,0.5)" }}
        />
        <span
          ref={circleText}
          className="font-heading text-[11px] font-black uppercase tracking-[0.16em] text-violet-200"
        >
          Zone 1
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
          style={{ backgroundImage: `linear-gradient(90deg, ${STORM_PURPLE}, #e0a8ff)` }}
        />
      </div>
      <span ref={label} className="mt-1 block text-[9px] font-bold uppercase tracking-[0.2em] text-white/60">
        Zone moving in
      </span>
    </div>
  );
}

function AliveBlock({ clock, live }: PanelProps) {
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
      <div className="flex flex-1 items-center gap-2 rounded-[4px] px-2 py-1" style={plate}>
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 opacity-80">
          <circle cx="8" cy="4.6" r="2.9" fill="#dbe6f0" />
          <path d="M2.6 14c0-3 2.4-5.2 5.4-5.2S13.4 11 13.4 14z" fill="#dbe6f0" />
        </svg>
        <span ref={aliveNum} className="font-heading text-[19px] font-black leading-none tabular-nums text-white">
          100
        </span>
        <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-white/45">alive</span>
      </div>
      <div className="flex items-center gap-1.5 rounded-[4px] px-2 py-1" style={plate}>
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
          <path d="M3 2.4 7.2 8 3 13.6h2.4L13 3.6V2.4z" fill="#ffd479" />
          <path d="M13 13.6 8.8 8l1.4-1.9L13 10.2z" fill="#ffd479" />
        </svg>
        <span ref={elimNum} className="font-heading text-[15px] font-black leading-none tabular-nums text-amber-200">
          0
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Feeds
 * ------------------------------------------------------------------------ */

function KillFeed({ feed }: { feed: FeedEntry[] }) {
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
              ...plate,
              background: e.byPlayer
                ? "rgba(58,42,10,0.78)"
                : e.onPlayer
                  ? "rgba(70,12,12,0.78)"
                  : INK,
            }}
          >
            <span className={e.byPlayer ? "text-amber-200" : "text-white/80"}>{e.killer}</span>
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
            <span className={e.onPlayer ? "text-red-300" : "text-white/55"}>{e.victim}</span>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function ToastStack({ toasts }: { toasts: ToastEntry[] }) {
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
              ...plate,
              background:
                t.tone === "elim"
                  ? "rgba(52,36,6,0.8)"
                  : t.tone === "urgent"
                    ? "rgba(46,12,52,0.8)"
                    : INK_SOLID,
              borderColor:
                t.tone === "elim" ? "rgba(255,206,110,0.5)" : t.tone === "urgent" ? "rgba(200,120,255,0.45)" : EDGE,
            }}
          >
            <span
              className="font-heading text-[15px] font-black uppercase tracking-[0.08em]"
              style={{
                color: t.tone === "elim" ? "#ffd479" : t.tone === "urgent" ? "#e5b8ff" : "#fff",
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

function PickupLog({ pickups }: { pickups: PickupEntry[] }) {
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
              ...plate,
              borderColor: p.bad ? "rgba(255,120,120,0.5)" : rgba(rarityNum(p.rarity), 0.55),
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: p.bad ? "#ff7a7a" : hex(rarityNum(p.rarity)) }}
            />
            <span
              className="text-[11px] font-bold"
              style={{ color: p.bad ? "#ffb4b4" : hex(rarityNum(p.rarity)) }}
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

function HitMarker({ clock, live }: PanelProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const lines = useRef<(HTMLDivElement | null)[]>([]);
  const ringRef = useRef<HTMLDivElement | null>(null);

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
    const color = l.hitKind === "elim" ? "#ff4d4d" : l.hitKind === "shield" ? "#8ad4ff" : "#ffffff";
    for (const line of lines.current) if (line) line.style.background = color;
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
    </div>
  );
}

function DamageArcs({ arcs }: { arcs: DamageArc[] }) {
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
                  <stop offset="0%" stopColor="rgba(255,70,70,0.95)" />
                  <stop offset="100%" stopColor="rgba(255,70,70,0.15)" />
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
                style={{ filter: "drop-shadow(0 0 6px rgba(255,40,40,0.55))" }}
              />
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

function ScopeOverlay() {
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
        <circle cx="100" cy="100" r="1.1" fill="rgba(180,20,20,0.9)" />
        <circle cx="100" cy="100" r="46" fill="none" stroke="rgba(10,12,16,0.35)" strokeWidth="0.5" />
      </svg>
    </motion.div>
  );
}

/* ------------------------------------------------------------------------ *
 * Full-screen states
 * ------------------------------------------------------------------------ */

function Vignettes({ clock, live }: PanelProps) {
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
    const lowT = clamp01(1 - l.health / (l.maxHealth * 0.35));
    setOpacity(low.current, lowT * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(l.t * 6.5))), oStore.current, 1);
    setOpacity(flash.current, l.damageFlash * 0.55, oStore.current, 2);
    setOpacity(heal.current, l.healFlash * 0.3, oStore.current, 3);
  });

  return (
    <>
      <div
        ref={storm}
        className="absolute inset-0 opacity-0"
        style={{
          boxShadow: "inset 0 0 140px 40px rgba(150,60,220,0.55), inset 0 0 40px rgba(80,20,140,0.6)",
        }}
      />
      <div
        ref={low}
        className="absolute inset-0 opacity-0"
        style={{ boxShadow: "inset 0 0 160px 30px rgba(200,20,20,0.6)" }}
      />
      <div
        ref={flash}
        className="absolute inset-0 opacity-0"
        style={{ background: "radial-gradient(circle at 50% 50%, rgba(255,60,60,0) 35%, rgba(255,40,40,0.45))" }}
      />
      <div
        ref={heal}
        className="absolute inset-0 opacity-0"
        style={{ boxShadow: "inset 0 0 120px 20px rgba(90,220,140,0.5)" }}
      />
    </>
  );
}

function StormBanner({ inStorm, clock, live }: PanelProps & { inStorm: boolean }) {
  const dps = useRef<HTMLSpanElement | null>(null);
  const dist = useRef<HTMLSpanElement | null>(null);
  const tStore = useRef<string[]>(["", ""]);
  usePainter(clock, () => {
    const l = live.current;
    setText(dps.current, `-${l.dps.toFixed(0)} hp/s`, tStore.current, 0);
    setText(dist.current, `${Math.max(0, Math.round(l.distToSafe))} m to safety`, tStore.current, 1);
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
            style={{ ...plate, background: "rgba(46,12,66,0.82)", borderColor: "rgba(200,120,255,0.5)" }}
          >
            <span className="font-heading text-[13px] font-black uppercase tracking-[0.22em] text-violet-100">
              You are in the storm
            </span>
            <span ref={dps} className="font-heading text-[12px] font-black tabular-nums text-red-300" />
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

function EndCard({
  ending,
  canRestart,
  onRestart,
}: {
  ending: Ending;
  canRestart: boolean;
  onRestart: () => void;
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
        background: victory
          ? "radial-gradient(circle at 50% 38%, rgba(52,32,8,0.82), rgba(3,4,10,0.95) 62%)"
          : "radial-gradient(circle at 50% 40%, rgba(30,8,10,0.86), rgba(2,3,8,0.96) 65%)",
      }}
    >
      {victory && (
        <motion.div
          aria-hidden
          className="absolute left-1/2 top-[34%] h-[160vh] w-[160vh] -translate-x-1/2 -translate-y-1/2 opacity-[0.22]"
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 90, ease: "linear" }}
          style={{
            background:
              "conic-gradient(from 0deg, rgba(255,205,110,0.55) 0deg, rgba(255,205,110,0) 12deg, rgba(255,205,110,0) 30deg, rgba(255,205,110,0.4) 42deg, rgba(255,205,110,0) 60deg)",
            maskImage: "radial-gradient(circle, rgba(0,0,0,1) 10%, rgba(0,0,0,0) 65%)",
            WebkitMaskImage: "radial-gradient(circle, rgba(0,0,0,1) 10%, rgba(0,0,0,0) 65%)",
          }}
        />
      )}

      <motion.div
        initial={{ scale: 0.9, y: 16, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 26, delay: 0.12 }}
        className="relative flex flex-col items-center px-8 text-center"
      >
        {victory ? (
          <>
            <span className="text-[11px] font-bold uppercase tracking-[0.55em] text-amber-200/70">
              #1 of {ending.lobby}
            </span>
            <h1
              className="mt-2 font-heading text-6xl font-black uppercase leading-[0.95] tracking-tight sm:text-8xl"
              style={{
                backgroundImage: "linear-gradient(180deg,#fff7dd 8%,#ffd479 46%,#e08a1e 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                filter: "drop-shadow(0 6px 34px rgba(255,190,80,0.45))",
              }}
            >
              Victory
              <br />
              Royale
            </h1>
          </>
        ) : (
          <>
            <span className="text-[11px] font-bold uppercase tracking-[0.55em] text-red-200/60">Eliminated</span>
            <h1
              className="mt-1 font-heading text-7xl font-black leading-none tabular-nums tracking-tight sm:text-8xl"
              style={{
                backgroundImage: "linear-gradient(180deg,#ffffff 10%,#ff9d9d 60%,#b02020 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                filter: "drop-shadow(0 6px 30px rgba(255,60,60,0.35))",
              }}
            >
              #{ending.placement}
            </h1>
            <p className="mt-2 text-sm text-white/60">
              Taken out by <span className="font-bold text-white/90">{ending.killer}</span>
              {ending.weapon ? <span className="text-white/40"> · {ending.weapon}</span> : null}
            </p>
          </>
        )}

        <div
          className="mt-8 flex items-center gap-8 rounded-[6px] px-8 py-4"
          style={{ ...plate, background: "rgba(6,10,20,0.66)" }}
        >
          <Stat label="Eliminations" value={`${ending.eliminations}`} />
          <div className="h-9 w-px bg-white/10" />
          {victory ? (
            <Stat label="Placement" value={`#${ending.placement}`} />
          ) : (
            <Stat label="Outlived" value={`${Math.max(0, ending.lobby - ending.placement)}`} />
          )}
          <div className="h-9 w-px bg-white/10" />
          <Stat label="Time survived" value={clockText(ending.matchTime)} />
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
              backgroundImage: victory
                ? "linear-gradient(180deg,#ffe7a8,#f5b942)"
                : "linear-gradient(180deg,#dbe9f5,#8fb4d0)",
              boxShadow: "0 10px 34px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.7)",
            }}
          >
            Drop again
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

const hatchCache = new WeakMap<CanvasRenderingContext2D, CanvasPattern | null>();

/** Diagonal hatch inside the storm — the texture is what stops it reading flat. */
function stormHatch(g: CanvasRenderingContext2D): CanvasPattern | null {
  const cached = hatchCache.get(g);
  if (cached !== undefined) return cached;
  let pattern: CanvasPattern | null = null;
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  const h = c.getContext("2d");
  if (h) {
    h.strokeStyle = "rgba(232,190,255,0.20)";
    h.lineWidth = 1;
    h.beginPath();
    h.moveTo(-2, 6);
    h.lineTo(6, -2);
    h.moveTo(2, 10);
    h.lineTo(10, 2);
    h.stroke();
    pattern = g.createPattern(c, "repeat");
  }
  hatchCache.set(g, pattern);
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
    g.fillStyle = "rgba(122,40,196,0.36)";
    g.fill(outside, "evenodd");
    const hatch = stormHatch(g);
    if (hatch) {
      g.fillStyle = hatch;
      g.fill(outside, "evenodd");
    }

    g.save();
    g.strokeStyle = "rgba(244,220,255,0.95)";
    g.lineWidth = 1.6;
    g.shadowColor = "rgba(190,110,255,0.95)";
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
    g.strokeStyle = "rgba(255,255,255,0.8)";
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
