/**
 * Flow Phangan: one day, as a state machine.
 *
 * Four in the afternoon to half past eight, in eight real minutes. The sun
 * goes into the sea, the rain comes in from the east, the guests tell their
 * stories on the back of the scooter, and at 8:30 there is Muay Thai whether
 * you are ready or not. Everything that decides what happened is here and is
 * pure; the engine feeds it the scooter's position and reads back what to say.
 */
import { GUEST_POOL, SECRET_PLACES, MUAY_THAI_MOVES, NARRATION, readyLine, deliveredLine, type GuestDef, type PlaceDef } from "./dialogue";
import {
  CHALOKLUM,
  HAAD_SALAD,
  PAD_THAI_STOPS,
  PIN_SPOTS,
  THONG_SALA,
  VILLA,
  WATERFALL,
  dist2,
  type Landmark,
  type Vec2,
} from "./island";

export const DAY_SECONDS = 480;
export const CLOCK_START = 16 * 60;
export const CLOCK_END = 20 * 60 + 30;
export const MINUTES_PER_SECOND = (CLOCK_END - CLOCK_START) / DAY_SECONDS;
export const SUNSET_MINUTE = 18 * 60 + 35;
export const DARK_MINUTE = 19 * 60 + 25;
/** Seconds of riding between story lines. */
export const LINE_GAP = 7;
export const PICKUP_RADIUS = 10;
export const DROP_RADIUS = 18;
export const PAD_THAI_RADIUS = 9;
export const GUESTS_PER_DAY = 6;
/** The rain wall takes this long to cross the island once it starts. */
export const RAIN_CROSSING = 40;

/** Deterministic, tiny, good enough. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type GuestPhase = "waiting" | "riding" | "delivered";

export interface Guest {
  id: number;
  def: GuestDef;
  pos: Vec2;
  spot: string;
  phase: GuestPhase;
  /** How many story lines have landed. */
  lineIndex: number;
  lineClock: number;
  /** Every road line landed before they got off at the meetup. */
  heardInFull: boolean;
  /** Delivered before the story ran out: the bonus. */
  fast: boolean;
  deliveredAt: number | null;
}

export interface Bubble {
  name: string;
  colour: string;
  text: string;
  until: number;
}

export interface Place extends PlaceDef {
  pos: Vec2;
}

export type DayPhase = "ride" | "muaythai" | "done";

export interface Beat {
  at: number;
  move: string;
  result: "pending" | "perfect" | "good" | "miss";
}

export interface Rhythm {
  beats: Beat[];
  /** Seconds since the bell. */
  t: number;
  done: boolean;
}

export interface Day {
  seed: number;
  phase: DayPhase;
  /** Real seconds elapsed. */
  t: number;
  /** Game clock, minutes since midnight. */
  minute: number;
  place: Place;
  guests: Guest[];
  riding: number | null;
  energy: number;
  padThai: number;
  rainAt: number;
  raining: boolean;
  sunset: boolean;
  dark: boolean;
  checkpointStops: number;
  swerves: number;
  dogBumps: number;
  heldUntil: number;
  bubble: Bubble | null;
  notes: string[];
  padThaiCooldown: number[];
  rhythm: Rhythm | null;
  /** Whether a warning was said once. */
  said: Set<string>;
}

const placePos = (key: PlaceDef["key"]): Vec2 => {
  const table: Record<PlaceDef["key"], Landmark> = {
    "haad-salad": HAAD_SALAD,
    "thong-sala": THONG_SALA,
    waterfall: WATERFALL,
    villa: VILLA,
    chaloklum: CHALOKLUM,
  };
  return table[key].pos;
};

export const PLACES: Place[] = SECRET_PLACES.map((p) => ({ ...p, pos: placePos(p.key) }));

function pick<T>(rng: () => number, from: T[], n: number): T[] {
  const pool = [...from];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

export function newDay(seed: number): Day {
  const rng = mulberry32(seed);
  const place = PLACES[Math.floor(rng() * PLACES.length)];
  // Guests wait somewhere that is not the meetup itself, or the ride is a formality.
  const spots = pick(
    rng,
    PIN_SPOTS.filter((s) => dist2(s.pos, place.pos) > 60),
    GUESTS_PER_DAY,
  );
  const defs = pick(rng, GUEST_POOL, GUESTS_PER_DAY);
  const guests: Guest[] = defs.map((def, i) => ({
    id: i,
    def,
    pos: { x: spots[i].pos.x, z: spots[i].pos.z },
    spot: spots[i].name,
    phase: "waiting",
    lineIndex: 0,
    lineClock: 0,
    heardInFull: false,
    fast: false,
    deliveredAt: null,
  }));
  // Rain between 17:30 and 19:45 game time: always before the bell, never before you have found your feet.
  const rainAt = 160 + rng() * 240;
  return {
    seed,
    phase: "ride",
    t: 0,
    minute: CLOCK_START,
    place,
    guests,
    riding: null,
    energy: 100,
    padThai: 0,
    rainAt,
    raining: false,
    sunset: false,
    dark: false,
    checkpointStops: 0,
    swerves: 0,
    dogBumps: 0,
    heldUntil: 0,
    bubble: null,
    notes: [NARRATION.open, place.pin],
    padThaiCooldown: PAD_THAI_STOPS.map(() => 0),
    rhythm: null,
    said: new Set(),
  };
}

export function clockLabel(minute: number): string {
  const h24 = Math.floor(minute / 60);
  const m = Math.floor(minute % 60);
  const h = ((h24 + 11) % 12) + 1;
  return `${h}:${m.toString().padStart(2, "0")} ${h24 >= 12 ? "pm" : "am"}`;
}

/** Fraction of the day gone, 0..1. */
export const dayProgress = (day: Day) => Math.min(1, day.t / DAY_SECONDS);

/** How far the rain wall has crossed the island: 0 still out east, 1 everywhere. */
export function rainFront(day: Day): number {
  if (day.t < day.rainAt - RAIN_CROSSING) return 0;
  return Math.min(1, (day.t - (day.rainAt - RAIN_CROSSING)) / RAIN_CROSSING);
}

export interface RideContext {
  /** Positive uphill grade in the direction of travel. */
  climb: number;
  boosting: boolean;
  /** Speed in m/s, so a parked scooter drains nothing. */
  speed: number;
}

const say = (day: Day, text: string, once?: string) => {
  if (once) {
    if (day.said.has(once)) return;
    day.said.add(once);
  }
  day.notes.push(text);
};

export function tick(day: Day, dt: number, ctx: RideContext): void {
  if (day.phase === "done") return;
  day.t += dt;
  if (day.phase === "muaythai") {
    tickRhythm(day, dt);
    return;
  }
  day.minute = CLOCK_START + day.t * MINUTES_PER_SECOND;

  const moving = Math.abs(ctx.speed) > 0.5;
  let drain = 0;
  if (moving) drain += 0.55 + Math.max(0, ctx.climb) * 26;
  if (moving && day.raining) drain += 1.1;
  if (ctx.boosting && moving) drain += 5.5;
  day.energy = Math.max(0, day.energy - drain * dt);
  if (day.energy <= 0) say(day, NARRATION.tired, "tired");
  if (day.energy > 30) day.said.delete("tired");
  for (let i = 0; i < day.padThaiCooldown.length; i++) day.padThaiCooldown[i] = Math.max(0, day.padThaiCooldown[i] - dt);

  if (!day.raining) {
    if (rainFront(day) > 0) say(day, NARRATION.rainWall, "rainWall");
    if (day.t >= day.rainAt) {
      day.raining = true;
      say(day, NARRATION.rain);
    }
  }
  if (!day.sunset && day.minute >= SUNSET_MINUTE) {
    day.sunset = true;
    say(day, NARRATION.sunset);
  }
  if (!day.dark && day.minute >= DARK_MINUTE) {
    day.dark = true;
    say(day, NARRATION.dark);
  }

  // The passenger talks.
  if (day.riding !== null) {
    const g = day.guests[day.riding];
    if (g.lineIndex < g.def.story.length) {
      g.lineClock += dt;
      if (g.lineClock >= LINE_GAP) {
        g.lineClock = 0;
        speak(day, g, g.def.story[g.lineIndex], 6.5);
        g.lineIndex++;
      }
    }
  }
  if (day.bubble && day.t > day.bubble.until) day.bubble = null;

  if (day.minute >= CLOCK_END) {
    day.minute = CLOCK_END;
    ringBell(day);
  }
}

function speak(day: Day, g: Guest, text: string, seconds: number) {
  day.bubble = { name: g.def.name, colour: g.def.colour, text, until: day.t + seconds };
}

/** Nearest waiting guest in reach, or null. */
export function guestInReach(day: Day, pos: Vec2): Guest | null {
  let best: Guest | null = null;
  let bestD = PICKUP_RADIUS;
  for (const g of day.guests) {
    if (g.phase !== "waiting") continue;
    const d = dist2(g.pos, pos);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}

export const atMeetup = (day: Day, pos: Vec2) => dist2(day.place.pos, pos) <= DROP_RADIUS;

export type ActionResult = "picked" | "delivered" | "dropped" | "nothing";

/** E: pick up if somebody is here, otherwise let the passenger off. */
export function action(day: Day, pos: Vec2): ActionResult {
  if (day.phase !== "ride") return "nothing";
  if (day.riding === null) {
    const g = guestInReach(day, pos);
    if (!g) return "nothing";
    g.phase = "riding";
    day.riding = g.id;
    // The first line lands soon after they settle on the seat.
    g.lineClock = LINE_GAP - 2.5;
    speak(day, g, g.def.hop, 5);
    return "picked";
  }
  const g = day.guests[day.riding];
  day.riding = null;
  if (atMeetup(day, pos)) {
    g.phase = "delivered";
    g.deliveredAt = day.t;
    g.heardInFull = g.lineIndex >= g.def.story.length;
    g.fast = !g.heardInFull;
    speak(day, g, g.heardInFull ? g.def.arrival : g.def.early, 6.5);
    if (day.guests.every((x) => x.phase === "delivered")) say(day, "Everybody is here. " + day.place.arrive);
    else if (!day.said.has("arrive")) say(day, day.place.arrive, "arrive");
    return "delivered";
  }
  g.phase = "waiting";
  g.pos = { x: pos.x + 2, z: pos.z + 2 };
  g.lineClock = 0;
  speak(day, g, "Here? Okay. I will wait. Come back for me.", 4);
  return "dropped";
}

/** Riding into a pad thai stop. Returns true if you ate. */
export function padThai(day: Day, pos: Vec2): boolean {
  if (day.phase !== "ride") return false;
  for (let i = 0; i < PAD_THAI_STOPS.length; i++) {
    if (dist2(PAD_THAI_STOPS[i].pos, pos) > PAD_THAI_RADIUS) continue;
    if (day.padThaiCooldown[i] > 0) return false;
    if (day.energy > 85) {
      say(day, NARRATION.padThaiFull, "full");
      return false;
    }
    day.padThaiCooldown[i] = 45;
    day.padThai++;
    day.energy = 100;
    day.said.delete("full");
    say(day, NARRATION.padThai);
    return true;
  }
  return false;
}

/** Passing the checkpoint with a guest on the back. */
export function checkpoint(day: Day): boolean {
  if (day.phase !== "ride" || day.riding === null) return false;
  if (day.checkpointStops > 0 && day.t < day.heldUntil + 25) return false;
  day.checkpointStops++;
  day.heldUntil = day.t + 4.5;
  say(day, NARRATION.checkpoint);
  return true;
}

export function swerve(day: Day): void {
  if (day.phase !== "ride") return;
  day.swerves++;
  say(day, NARRATION.swerve);
}

export function dogBump(day: Day): void {
  if (day.phase !== "ride") return;
  day.dogBumps++;
  say(day, NARRATION.dogBump);
}

export const isHeld = (day: Day) => day.t < day.heldUntil;

// ---------------------------------------------------------------------------
// 8:30. Muay Thai.
// ---------------------------------------------------------------------------

export const BEAT_INTERVAL = 0.62;
export const BEAT_LEAD = 2.4;
export const BEATS = 10;
export const PERFECT_WINDOW = 0.1;
export const GOOD_WINDOW = 0.22;

export function makeRhythm(seed: number): Rhythm {
  const rng = mulberry32(seed * 7 + 3);
  const beats: Beat[] = [];
  let t = BEAT_LEAD;
  for (let i = 0; i < BEATS; i++) {
    // Mostly on the beat, with the odd half-beat so it is not a metronome.
    t += i > 0 && rng() < 0.25 ? BEAT_INTERVAL * 0.5 : BEAT_INTERVAL;
    beats.push({ at: t, move: MUAY_THAI_MOVES[i % MUAY_THAI_MOVES.length], result: "pending" });
  }
  return { beats, t: 0, done: false };
}

function ringBell(day: Day) {
  if (day.phase !== "ride") return;
  if (day.riding !== null) {
    const g = day.guests[day.riding];
    g.phase = "waiting";
    day.riding = null;
  }
  day.bubble = null;
  day.phase = "muaythai";
  day.rhythm = makeRhythm(day.seed);
  say(day, NARRATION.bell);
}

export function tickRhythm(day: Day, dt: number): void {
  const r = day.rhythm;
  if (!r || r.done) return;
  r.t += dt;
  for (const b of r.beats) {
    if (b.result === "pending" && r.t > b.at + GOOD_WINDOW) b.result = "miss";
  }
  const last = r.beats[r.beats.length - 1];
  if (r.t > last.at + 1.2) {
    r.done = true;
    day.phase = "done";
  }
}

export type HitResult = "perfect" | "good" | "miss";

/** A hit at the current moment. Returns what it scored, or null if there was nothing to hit. */
export function hit(day: Day): HitResult | null {
  const r = day.rhythm;
  if (!r || r.done) return null;
  let best: Beat | null = null;
  let bestD = Infinity;
  for (const b of r.beats) {
    if (b.result !== "pending") continue;
    const d = Math.abs(r.t - b.at);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  if (!best || bestD > 0.4) return null;
  best.result = bestD <= PERFECT_WINDOW ? "perfect" : bestD <= GOOD_WINDOW ? "good" : "miss";
  return best.result;
}

export function muayThaiScore(r: Rhythm | null): number {
  if (!r) return 0;
  let s = 0;
  for (const b of r.beats) s += b.result === "perfect" ? 1 : b.result === "good" ? 0.5 : 0;
  return s;
}

/** Skip straight to the bell. For the restart button and the tests. */
export function endDay(day: Day): void {
  day.t = Math.max(day.t, DAY_SECONDS);
  day.minute = CLOCK_END;
  ringBell(day);
}

// ---------------------------------------------------------------------------
// The end card
// ---------------------------------------------------------------------------

export interface Summary {
  delivered: number;
  total: number;
  fullStories: number;
  fastRides: number;
  padThai: number;
  dollars: number;
  beatRain: boolean;
  muayThai: number;
  ready: string;
  checkpointStops: number;
  swerves: number;
  line: string;
  outro: string;
  place: string;
}

export function summary(day: Day): Summary {
  const delivered = day.guests.filter((g) => g.phase === "delivered");
  const beatRain = delivered.length === day.guests.length && delivered.every((g) => (g.deliveredAt ?? Infinity) < day.rainAt);
  const mt = muayThaiScore(day.rhythm);
  return {
    delivered: delivered.length,
    total: day.guests.length,
    fullStories: delivered.filter((g) => g.heardInFull).length,
    fastRides: delivered.filter((g) => g.fast).length,
    padThai: day.padThai,
    dollars: day.padThai * 3,
    beatRain,
    muayThai: mt,
    ready: readyLine(mt),
    checkpointStops: day.checkpointStops,
    swerves: day.swerves,
    line: deliveredLine(delivered.length, day.guests.length),
    outro: NARRATION.outro,
    place: day.place.name,
  };
}
