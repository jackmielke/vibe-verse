/**
 * The cloud city, as numbers.
 *
 * Pure: no three, no DOM, no clock. The renderer eases the scene toward this
 * state every frame and the page reads it a few times a second, so the whole
 * game runs in node for the tests and in headless Chromium with no GPU.
 *
 * One equation is doing the work. Every module has mass and some have lift;
 * lift scales with the local air density; so there is exactly one altitude
 * where the city floats. Build heavy and that altitude drops into air that is
 * hotter and thicker. Below 48 km the hull starts to cook, and a city that
 * cannot hold itself up falls to a surface at 462 °C, which is also the
 * cleanest possible end to a biology experiment.
 */
import {
  airAt, equilibriumAlt, liftFactor, BAND, FREEZE_ALT, HULL_STRESS_ALT, DESIGN_ALT,
  type Air,
} from "./atmosphere";
import {
  MODULES, hexKey, hexRing, neighbours, MAX_RING, type ModuleId, type ResourceId, type Hex,
} from "./modules";
import { EVENTS, type EventDef } from "./events";

export interface Tile extends Hex {
  id: ModuleId;
  /** Game seconds when it went up. */
  built: number;
  /** A serial, so the renderer can tell a rebuilt slot from the old one. */
  n: number;
  /** 1..3. Everything a module does scales with it, mass included. */
  level?: number;
  /** Being winched off: game time it is gone, and until then it still weighs. */
  leaving?: number;
}

/** How long a recycle takes. Cutting loose is instant; that is its whole point. */
export const RECYCLE_SECONDS = 25;

export const MAX_LEVEL = 3;
/** What the next level costs, as a multiple of the module's build cost. */
export const upgradeCostMul = (level: number) => 1.4 * level;

export interface VenusSave {
  version: 1;
  cityName: string;
  t: number;
  alt: number;
  integrity: number;
  trim: number;
  res: Record<ResourceId, number>;
  pop: number;
  pending: number;
  tiles: Tile[];
  serial: number;
  rng: number;
  nextEventAt: number;
  seen: Record<string, number>;
  milestones: string[];
  flags: Record<string, number>;
  stats: { arrivals: number; cutLoose: number; built: number; parties: number; dawns: number };
  fallen: boolean;
  won: boolean;
}

export interface Derived {
  air: Air;
  mass: number;
  lift: number;
  /** Where the city is heading. */
  eqAlt: number;
  /** 0..1 */
  sun: number;
  /** 0..1 around the planet. */
  dayPhase: number;
  earthDay: number;
  circuits: number;
  powerMake: number;
  powerUse: number;
  /** 0..1 — how much of the demand is being met. */
  powered: number;
  batteryCap: number;
  waterCap: number;
  housing: number;
  food: number;
  happiness: number;
  comfort: number;
  rates: Record<ResourceId, number>;
  arrivalRate: number;
  zone: "cook" | "hot" | "band" | "cold" | "freeze";
  utopia: number;
  /** Out of water: greenhouses at half. */
  dry: boolean;
}

export interface EventChoice { label: string; hint?: string; disabled?: boolean }
export interface ActiveEvent {
  id: string;
  from: string;
  title: string;
  body: string;
  choices: EventChoice[];
  /** Filled in after a choice, until dismissed. */
  outcome?: string;
  tile?: Hex;
}

export type SimFx =
  | { kind: "built"; tile: Tile }
  | { kind: "fell"; tile: Tile; reason: "cut" | "recycle" }
  | { kind: "arrival"; n: number }
  | { kind: "shipment" }
  | { kind: "party" }
  | { kind: "ballast" }
  | { kind: "dawn" }
  | { kind: "dusk" }
  | { kind: "milestone"; id: string; title: string; text: string }
  | { kind: "toast"; text: string; tone?: "good" | "warn" | "bad" }
  | { kind: "fallen" }
  | { kind: "won" };

/** One trip round the planet on the wind: 9 Earth days, 8 real minutes. */
export const REVOLUTION = 480;
const EARTH_DAYS_PER_REV = 9;
/** Water weighs this many tonnes a unit — it is the ballast. */
export const WATER_TONNES = 1;

export const VICTORY = { pop: 1000, culture: 1200, happiness: 0.7 } as const;
/**
 * At night the air in every envelope cools and contracts, so the whole city
 * loses a few percent of its lift and sags on the dark side. Real, and it
 * makes night a thing the altimeter shows rather than just a dark screen.
 */
export const NIGHT_SAG = 0.05;
/** Litres, abstractly: what a hundred people drink per second. */
const DRINK = 0.12;

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function freshSave(seed = 20410929, cityName = "Aphrodite"): VenusSave {
  return {
    version: 1,
    cityName,
    t: 0,
    alt: DESIGN_ALT,
    integrity: 1,
    trim: 0,
    res: { carbon: 90, water: 20, air: 60, power: 110, science: 0, culture: 0 },
    pop: 12,
    pending: 0,
    tiles: [{ q: 0, r: 0, id: "core", built: 0, n: 0 }],
    serial: 1,
    rng: seed,
    nextEventAt: 55,
    seen: {},
    milestones: [],
    flags: {},
    stats: { arrivals: 0, cutLoose: 0, built: 0, parties: 0, dawns: 0 },
    fallen: false,
    won: false,
  };
}

const RES_CAP: Record<ResourceId, number> = {
  carbon: 900, water: 60, air: 400, power: 0, science: 999, culture: 99999,
};

export class VenusSim {
  s: VenusSave;
  d!: Derived;
  event: ActiveEvent | null = null;
  private eventDef: EventDef | null = null;
  private rand: () => number;
  private fx: SimFx[] = [];
  private prevSun = 0;

  constructor(save?: VenusSave) {
    this.s = save ? structuredCloneSafe(save) : freshSave();
    this.rand = mulberry(this.s.rng);
    this.derive();
    this.prevSun = this.d.sun;
  }

  /* ---------------------------------------------------------- randomness */

  random(): number {
    const v = this.rand();
    // Keep the stream resumable from a save.
    this.s.rng = (this.s.rng + 0x9e3779b9) >>> 0;
    return v;
  }

  /* -------------------------------------------------------------- queries */

  tileAt(q: number, r: number): Tile | undefined {
    return this.s.tiles.find((t) => t.q === q && t.r === r);
  }

  count(id: ModuleId): number {
    let n = 0;
    for (const t of this.s.tiles) if (t.id === id) n++;
    return n;
  }

  /** Empty slots touching the city. */
  freeSlots(): Hex[] {
    const taken = new Set(this.s.tiles.map((t) => hexKey(t.q, t.r)));
    const out = new Map<string, Hex>();
    for (const t of this.s.tiles) {
      for (const n of neighbours(t.q, t.r)) {
        const k = hexKey(n.q, n.r);
        if (!taken.has(k) && hexRing(n.q, n.r) <= MAX_RING) out.set(k, n);
      }
    }
    return [...out.values()].sort((a, b) => hexRing(a.q, a.r) - hexRing(b.q, b.r));
  }

  canAfford(id: ModuleId): boolean {
    const def = MODULES[id];
    for (const [k, v] of Object.entries(def.cost) as [ResourceId, number][]) {
      if (this.s.res[k] < v) return false;
    }
    return true;
  }

  whyNot(id: ModuleId): string | null {
    const def = MODULES[id];
    if (this.s.fallen) return "The city is gone.";
    if (def.unlockPop && this.s.pop < def.unlockPop) return `Needs ${def.unlockPop} people`;
    for (const [k, v] of Object.entries(def.cost) as [ResourceId, number][]) {
      if (this.s.res[k] < v) return `Needs ${Math.ceil(v - this.s.res[k])} more ${k}`;
    }
    if (this.freeSlots().length === 0) return "No room left";
    return null;
  }

  upgradeCost(t: Tile): Partial<Record<ResourceId, number>> {
    const def = MODULES[t.id];
    const mul = upgradeCostMul(t.level ?? 1);
    const out: Partial<Record<ResourceId, number>> = {};
    for (const [k, v] of Object.entries(def.cost) as [ResourceId, number][]) out[k] = Math.ceil(v * mul);
    if (t.id === "core") out.carbon = 120 * (t.level ?? 1);
    return out;
  }

  whyNotUpgrade(q: number, r: number): string | null {
    const t = this.tileAt(q, r);
    if (!t) return "Nothing here";
    if (t.leaving) return "Being winched off";
    if ((t.level ?? 1) >= MAX_LEVEL) return "Fully grown";
    for (const [k, v] of Object.entries(this.upgradeCost(t)) as [ResourceId, number][]) {
      if (this.s.res[k] < v) return `Needs ${Math.ceil(v - this.s.res[k])} more ${k}`;
    }
    return null;
  }

  upgrade(q: number, r: number): boolean {
    if (this.whyNotUpgrade(q, r)) return false;
    const t = this.tileAt(q, r)!;
    for (const [k, v] of Object.entries(this.upgradeCost(t)) as [ResourceId, number][]) this.s.res[k] -= v;
    t.level = (t.level ?? 1) + 1;
    this.push({ kind: "built", tile: t });
    this.derive();
    this.checkMilestones();
    return true;
  }

  /* -------------------------------------------------------------- actions */

  build(id: ModuleId, q: number, r: number): boolean {
    if (this.whyNot(id)) return false;
    if (this.tileAt(q, r)) return false;
    if (!this.freeSlots().some((h) => h.q === q && h.r === r)) return false;
    const def = MODULES[id];
    for (const [k, v] of Object.entries(def.cost) as [ResourceId, number][]) this.s.res[k] -= v;
    const tile: Tile = { q, r, id, built: this.s.t, n: this.s.serial++ };
    this.s.tiles.push(tile);
    this.s.stats.built++;
    this.push({ kind: "built", tile });
    this.derive();
    this.checkMilestones();
    return true;
  }

  /** Drop it. No refund; the mass is gone at once. */
  cutLoose(q: number, r: number): Tile | null {
    const i = this.s.tiles.findIndex((t) => t.q === q && t.r === r);
    if (i < 0) return null;
    const tile = this.s.tiles[i];
    if (tile.id === "core") return null;
    this.s.tiles.splice(i, 1);
    // A module falling off the edge takes its people with it, into the next dome.
    this.s.stats.cutLoose++;
    this.push({ kind: "fell", tile, reason: "cut" });
    const n = this.s.stats.cutLoose;
    this.toast(`The ${MODULES[tile.id].name} falls fifty kilometres and is sterilised on arrival. Things the planet has cleaned up for you: ${n}.`, "warn");
    this.orphanCheck();
    this.derive();
    this.s.pop = Math.min(this.s.pop, this.d.housing);
    return tile;
  }

  /**
   * Take it apart properly: half the carbon back, but it is winched off over
   * twenty-five seconds and weighs the whole time. In an emergency, cut it.
   */
  recycle(q: number, r: number): Tile | null {
    const tile = this.tileAt(q, r);
    if (!tile || tile.id === "core" || tile.leaving) return null;
    tile.leaving = this.s.t + RECYCLE_SECONDS;
    this.toast(`Winching off the ${MODULES[tile.id].name}. It still weighs until it's gone.`, "warn");
    return tile;
  }

  private finishRecycle(tile: Tile) {
    const i = this.s.tiles.indexOf(tile);
    if (i < 0) return;
    this.s.tiles.splice(i, 1);
    const def = MODULES[tile.id];
    this.s.res.carbon = Math.min(RES_CAP.carbon, this.s.res.carbon + (def.cost.carbon ?? 0) * 0.5 * (tile.level ?? 1));
    this.push({ kind: "fell", tile, reason: "recycle" });
    this.orphanCheck();
    this.derive();
    this.s.pop = Math.min(this.s.pop, this.d.housing);
  }

  /** What would be left hanging if this tile went: shown before you do it. */
  wouldOrphan(q: number, r: number): number {
    const rest = this.s.tiles.filter((t) => !(t.q === q && t.r === r));
    const have = new Set(rest.map((t) => hexKey(t.q, t.r)));
    const seen = new Set<string>([hexKey(0, 0)]);
    const st: Hex[] = [{ q: 0, r: 0 }];
    while (st.length) {
      const h = st.pop()!;
      for (const n of neighbours(h.q, h.r)) {
        const k = hexKey(n.q, n.r);
        if (!seen.has(k) && have.has(k)) { seen.add(k); st.push(n); }
      }
    }
    return rest.filter((t) => !seen.has(hexKey(t.q, t.r))).length;
  }

  /** Where the city would settle with one more of these on it. */
  previewAlt(id: ModuleId): number {
    const m = MODULES[id];
    const night = 1 - NIGHT_SAG * (1 - this.d.sun);
    return equilibriumAlt((this.d.lift / night / (1 + this.s.trim) + m.lift) * (1 + this.s.trim) * night, this.d.mass + m.mass);
  }

  /** Nothing may float free of the keel: tiles cut off from the core go too. */
  private orphanCheck() {
    const seen = new Set<string>([hexKey(0, 0)]);
    const q: Hex[] = [{ q: 0, r: 0 }];
    const have = new Map(this.s.tiles.map((t) => [hexKey(t.q, t.r), t] as const));
    while (q.length) {
      const h = q.pop()!;
      for (const n of neighbours(h.q, h.r)) {
        const k = hexKey(n.q, n.r);
        if (!seen.has(k) && have.has(k)) { seen.add(k); q.push(n); }
      }
    }
    const orphans = this.s.tiles.filter((t) => !seen.has(hexKey(t.q, t.r)));
    for (const o of orphans) {
      this.s.tiles.splice(this.s.tiles.indexOf(o), 1);
      this.push({ kind: "fell", tile: o, reason: "cut" });
    }
  }

  /** Let the water go. It is most of what you can shed in a hurry. */
  dumpBallast(): number {
    const shed = Math.floor(this.s.res.water * 0.75);
    if (shed <= 0) return 0;
    this.s.res.water -= shed;
    this.push({ kind: "ballast" });
    this.derive();
    return shed;
  }

  /**
   * Pump air into, or vent it out of, every envelope at once. Going up costs
   * air — two units per percent — and venting is free, because the air is
   * simply let go.
   */
  setTrim(v: number): boolean {
    const target = Math.max(-0.25, Math.min(0.15, v));
    const delta = target - this.s.trim;
    if (delta > 0) {
      const cost = delta * 100 * 2;
      if (this.s.res.air < cost) return false;
      this.s.res.air -= cost;
    }
    this.s.trim = target;
    this.derive();
    return true;
  }

  /* --------------------------------------------------------------- events */

  /** Rewards shrink each time the same thing happens again. */
  private bonus = 1;

  choose(i: number) {
    if (!this.event || !this.eventDef || this.event.outcome) return;
    const c = this.eventDef.choices(this)[i];
    if (!c || c.disabled) return;
    const n = this.s.flags[`n:${this.eventDef.id}`] ?? 1;
    this.bonus = 1 / (1 + 0.35 * (n - 1));
    const outcome = c.run(this);
    this.bonus = 1;
    this.event.outcome = outcome;
    this.derive();
    this.checkMilestones();
  }

  dismiss() {
    if (this.event && !this.event.outcome) return;
    this.event = null;
    this.eventDef = null;
  }

  /** Open a specific event, for the tests and for `__venus.event(id)`. */
  open(id: string, tile?: Hex): boolean {
    const def = EVENTS.find((e) => e.id === id);
    if (!def) return false;
    this.present(def, tile);
    return true;
  }

  private present(def: EventDef, tile?: Hex) {
    this.eventDef = def;
    this.s.seen[def.id] = this.s.t;
    this.s.flags[`n:${def.id}`] = (this.s.flags[`n:${def.id}`] ?? 0) + 1;
    this.event = {
      id: def.id,
      from: typeof def.from === "function" ? def.from(this) : def.from,
      title: typeof def.title === "function" ? def.title(this, tile) : def.title,
      body: typeof def.body === "function" ? def.body(this, tile) : def.body,
      choices: def.choices(this, tile).map((c) => ({ label: c.label, hint: c.hint, disabled: c.disabled })),
      tile,
    };
    // Choices can close over the tile.
    const bound = def.choices;
    this.eventDef = { ...def, choices: (s) => bound(s, tile) };
  }

  private rollEvent() {
    const s = this.s;
    const pool = EVENTS.filter((e) => {
      if (e.trigger) return false;
      if (e.once && s.seen[e.id] !== undefined) return false;
      const last = s.seen[e.id];
      if (last !== undefined && s.t - last < (e.cooldown ?? 240)) return false;
      return e.when(this);
    });
    if (!pool.length) return;
    const total = pool.reduce((a, e) => a + (e.weight ?? 1), 0);
    let x = this.random() * total;
    for (const e of pool) {
      x -= e.weight ?? 1;
      if (x <= 0) { this.present(e); return; }
    }
    this.present(pool[pool.length - 1]);
  }

  /* ---------------------------------------------------------------- flow */

  push(f: SimFx) { this.fx.push(f); }

  toast(text: string, tone: "good" | "warn" | "bad" = "good") {
    this.push({ kind: "toast", text, tone });
  }

  /** Everything that happened since the last call. */
  drain(): SimFx[] {
    const out = this.fx;
    this.fx = [];
    return out;
  }

  /** Arrivals that will come in as housing allows. */
  sendPeople(n: number) {
    this.s.pending += Math.round(n * this.bonus);
  }

  give(res: Partial<Record<ResourceId, number>>) {
    for (const [k, v0] of Object.entries(res) as [ResourceId, number][]) {
      const v = v0 > 0 ? v0 * this.bonus : v0;
      const cap = k === "power" ? this.d.batteryCap : k === "water" ? this.d.waterCap : RES_CAP[k];
      this.s.res[k] = Math.max(0, Math.min(cap, this.s.res[k] + v));
    }
  }

  /* ---------------------------------------------------------------- derive */

  derive() {
    const s = this.s;
    let mass = 0, lift = 0, housing = 0, food = 0, powerMake = 0, powerUse = 0;
    let batteryCap = 0, waterCap = 0, arrivalsMul = 1, solar = 0;
    const make: Record<ResourceId, number> = { carbon: 0, water: 0, air: 0, power: 0, science: 0, culture: 0 };
    const use: Record<ResourceId, number> = { carbon: 0, water: 0, air: 0, power: 0, science: 0, culture: 0 };

    const dayPhase = ((s.t / REVOLUTION) + 0.07) % 1;
    const sunRaw = Math.sin(dayPhase * Math.PI * 2);
    const sun = smooth(-0.06, 0.18, sunRaw);

    for (const t of s.tiles) {
      const m = MODULES[t.id];
      const L = t.level ?? 1;
      mass += m.mass * L;
      lift += m.lift * L;
      housing += (m.housing ?? 0) * L;
      food += (m.food ?? 0) * L;
      if ((m.power ?? 0) > 0) powerMake += m.power! * L;
      else powerUse += -(m.power ?? 0) * L;
      solar += (m.solar ?? 0) * L;
      batteryCap += (m.battery ?? 0) * L;
      waterCap += (m.waterCap ?? 0) * L;
      if (m.arrivals) arrivalsMul = Math.max(arrivalsMul, m.arrivals + (L - 1));
      for (const [k, v] of Object.entries(m.makes ?? {}) as [ResourceId, number][]) make[k] += v * L;
      for (const [k, v] of Object.entries(m.uses ?? {}) as [ResourceId, number][]) use[k] += v * L;
    }
    powerMake += solar * sun;
    // Nanofab sludge, and anything else an event bolts on for a while.
    mass += s.flags.extraMass ?? 0;
    mass += s.res.water * WATER_TONNES;
    lift *= (1 + s.trim) * (1 - NIGHT_SAG * (1 - sun));
    // People drink, and greenhouses without water feed half as many.
    use.water += (s.pop / 100) * DRINK;
    const dry = s.res.water < 1 && make.water < use.water;
    if (dry) {
      for (const t of s.tiles) if (t.id === "greenhouse") food -= (MODULES.greenhouse.food ?? 0) * (t.level ?? 1) * 0.5;
    }

    const eqAlt = equilibriumAlt(lift, mass);
    const air = airAt(s.alt);

    const battery = s.res.power;
    const powered = powerUse <= 0 ? 1 : Math.min(1, (powerMake + (battery > 1 ? powerUse : 0)) / powerUse);

    const zone: Derived["zone"] =
      s.alt < HULL_STRESS_ALT ? "cook" :
      s.alt < BAND.low ? "hot" :
      s.alt <= BAND.high ? "band" :
      s.alt <= FREEZE_ALT ? "cold" : "freeze";

    const frozen = s.alt > FREEZE_ALT;
    if (frozen) {
      for (const t of s.tiles) if (t.id === "greenhouse") food -= (MODULES.greenhouse.food ?? 0) * (t.level ?? 1);
    }

    // Comfort: 1 in the band, falling off either side.
    const tC = air.tempC;
    const comfort = tC >= 14 && tC <= 40 ? 1 : tC > 40 ? Math.max(0, 1 - (tC - 40) / 40) : Math.max(0, 1 - (14 - tC) / 32);
    const culturePerHead = s.pop > 0 ? (make.culture * 100) / s.pop : 0;
    const cultureTerm = Math.min(1, 0.35 + culturePerHead * 1.4);
    const fed = s.pop <= 0 ? 1 : Math.min(1, food / s.pop);
    const happiness = clamp01(
      0.42 * comfort + 0.26 * cultureTerm + 0.2 * fed + 0.12 * powered + (s.flags.joy ?? 0),
    );

    const rates: Record<ResourceId, number> = { carbon: 0, water: 0, air: 0, power: 0, science: 0, culture: 0 };
    for (const k of Object.keys(rates) as ResourceId[]) rates[k] = make[k] * powered - use[k];
    rates.culture *= 0.6 + happiness * 0.6;
    rates.power = powerMake - powerUse;

    const room = Math.max(0, Math.min(housing, food) - s.pop);
    const baseArrivals = 0.14 * arrivalsMul * (0.3 + happiness);
    const arrivalRate = room > 0 ? baseArrivals + (s.pending > 0 ? 0.9 * arrivalsMul : 0) : 0;

    const utopia = clamp01(
      0.45 * Math.min(1, s.pop / VICTORY.pop) +
      0.35 * Math.min(1, s.res.culture / VICTORY.culture) +
      0.2 * Math.min(1, happiness / VICTORY.happiness),
    );

    this.d = {
      air, mass, lift, eqAlt, sun, dayPhase,
      earthDay: (s.t / REVOLUTION) * EARTH_DAYS_PER_REV,
      circuits: Math.floor(s.t / REVOLUTION),
      powerMake, powerUse, powered, batteryCap, waterCap,
      housing, food, happiness, comfort, rates, arrivalRate, zone, utopia, dry,
    };
  }

  /* ------------------------------------------------------------------ step */

  step(dt: number) {
    const s = this.s;
    if (s.fallen) {
      // Nothing to run. The renderer is playing the fall.
      s.alt = Math.max(0, s.alt - dt * 2.5);
      this.derive();
      return;
    }
    // Choices are made with the clock stopped.
    if (this.event) { this.derive(); return; }

    s.t += dt;
    this.derive();
    const d = this.d;

    // ---- altitude: ease toward equilibrium, with a speed limit.
    const gap = d.eqAlt - s.alt;
    const rate = Math.max(-0.35, Math.min(0.35, gap * 0.12));
    s.alt += rate * dt;

    // ---- hull
    if (s.alt < HULL_STRESS_ALT) {
      s.integrity -= (HULL_STRESS_ALT - s.alt) * 0.012 * dt;
    } else if (s.alt > BAND.low - 1) {
      s.integrity = Math.min(1, s.integrity + 0.01 * dt);
    }
    if (s.integrity <= 0) {
      s.integrity = 0;
      s.fallen = true;
      this.event = null;
      this.push({ kind: "fallen" });
      return;
    }

    // ---- power
    const net = d.powerMake - d.powerUse;
    s.res.power = Math.max(0, Math.min(d.batteryCap, s.res.power + net * dt));

    // ---- materials
    for (const k of ["carbon", "water", "air", "science", "culture"] as ResourceId[]) {
      const cap = k === "water" ? d.waterCap : RES_CAP[k];
      s.res[k] = Math.max(0, Math.min(cap, s.res[k] + d.rates[k] * dt));
    }

    // ---- people
    const cap = Math.min(d.housing, d.food);
    if (s.pop < cap) {
      const inflow = Math.min(cap - s.pop, d.arrivalRate * dt);
      if (inflow > 0) {
        s.pop += inflow;
        s.stats.arrivals += inflow;
        if (s.pending > 0) s.pending = Math.max(0, s.pending - inflow);
        const before = Math.floor(s.pop - inflow);
        if (Math.floor(s.pop / 10) > Math.floor(before / 10)) this.push({ kind: "arrival", n: 10 });
      }
    } else if (s.pop > cap + 0.5) {
      s.pop = Math.max(cap, s.pop - 0.4 * dt);
    }
    if (d.happiness < 0.3 && s.pop > 12) s.pop -= 0.05 * dt;

    // ---- winches
    for (const t of [...s.tiles]) if (t.leaving && s.t >= t.leaving) this.finishRecycle(t);

    // ---- timers on flags
    if (s.flags.extraMassUntil && s.t > s.flags.extraMassUntil) {
      delete s.flags.extraMass;
      delete s.flags.extraMassUntil;
      this.toast("The sludge has set, and been winched off. Weight back to normal.");
    }
    if (s.flags.joyUntil && s.t > s.flags.joyUntil) {
      delete s.flags.joy;
      delete s.flags.joyUntil;
    }

    // ---- dawn and dusk
    if (this.prevSun < 0.5 && d.sun >= 0.5) {
      s.stats.dawns++;
      this.push({ kind: "dawn" });
    } else if (this.prevSun >= 0.5 && d.sun < 0.5) {
      this.push({ kind: "dusk" });
    }
    this.prevSun = d.sun;

    // ---- things getting out of hand
    for (const t of s.tiles) {
      const risk = MODULES[t.id].risk;
      if (!risk || s.t - t.built < 40) continue;
      if (this.random() < risk * dt) {
        const def = EVENTS.find((e) => e.trigger === t.id);
        if (def) { this.present(def, { q: t.q, r: t.r }); return; }
      }
    }

    // ---- the post
    if (s.t >= s.nextEventAt) {
      s.nextEventAt = s.t + 55 + this.random() * 40;
      this.rollEvent();
    }

    this.checkMilestones();
  }

  /* ------------------------------------------------------------ milestones */

  private checkMilestones() {
    const s = this.s;
    const d = this.d;
    const hit = (id: string, title: string, text: string, ok: boolean) => {
      if (!ok || s.milestones.includes(id)) return;
      s.milestones.push(id);
      this.push({ kind: "milestone", id, title, text });
    };
    hit("first-dome", "First Breath",
      "Your first dome is up, and it is holding itself up. Nobody on Mars has ever gone outside without a pressure suit.",
      this.count("dome") >= 1);
    hit("self-made", "Made of Sky",
      "Carbon, water and air, all pulled out of the clouds. The city is building itself out of the planet it floats on.",
      d.rates.carbon > 0 && d.rates.water > 0 && d.rates.air > 0);
    hit("hundred", "A Hundred Souls",
      "A hundred people live at fifty-four kilometres. The Moon base has nineteen.",
      s.pop >= 100);
    hit("dawn", "The Long Night",
      "You rode the wind all the way round the dark side and came out into the sun. Nine Earth days a lap.",
      s.stats.dawns >= 1);
    hit("culture", "Something Worth Staying For",
      "Fifty points of culture. People are not just surviving up here. They are showing off.",
      s.res.culture >= 50);
    hit("five-hundred", "Five Hundred",
      "Five hundred people. Earth has started to wonder where they all went.",
      s.pop >= 500);
    hit("thousand", "The Thousand",
      "A thousand people in the clouds of Venus. Mars has 212, and a waiting list to leave.",
      s.pop >= 1000);
    if (!s.won && s.pop >= VICTORY.pop && s.res.culture >= VICTORY.culture && d.happiness >= VICTORY.happiness) {
      s.won = true;
      this.push({ kind: "won" });
    }
  }

  snapshot(): VenusSave {
    return structuredCloneSafe(this.s);
  }
}

/* ------------------------------------------------------------------ helpers */

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function structuredCloneSafe<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

export { liftFactor };

/* --------------------------------------------------------------------- save */

const SAVE_KEY = "venus.save.v1";

export function loadSave(): VenusSave | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as VenusSave;
    if (s?.version !== 1 || !Array.isArray(s.tiles)) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeSave(s: VenusSave) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}
