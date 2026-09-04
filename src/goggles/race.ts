/**
 * The Half-Blind Triathlon: the race, as a state machine.
 *
 * September 6, 2025, Lake Chelan. Jack's first triathlon, Olympic distance,
 * agreed to with ten days' notice because Murph talked him into it. The
 * goggles fogged on the first stroke and stayed fogged. The bike had no top
 * gear and no brakes. The shoes had no cushion left. Expected three hours,
 * closer to four. Last in age group. Finished.
 *
 * Everything that decides what happens is here and nothing here draws. The
 * renderer feeds `step()` a `RaceInput` every frame and reads the state back;
 * the tests feed it a scripted swimmer and check the clock. Nothing kills you:
 * water in the lungs makes you slower, a full ankle makes you walk, gravel
 * makes you wobble, and the race always ends at the finish line.
 *
 * Time runs at two speeds. `elapsed` is real seconds; `raceSeconds` is the
 * clock on the bib, which ticks at a per-leg rate so that two minutes of
 * swimming reads as forty and the finish lands somewhere around four hours.
 */
import {
  BIKE_LENGTH,
  BUOY_X,
  KAYAK_X,
  REAL,
  RUN_LENGTH,
  RUN_TURN,
  SWIM_LENGTH,
  SWIM_TURN,
  bikeAt,
  bikeSectionAt,
  nextCorner,
} from "./course";

export type Leg = "swim" | "bike" | "run" | "finish";
export type Pace = 1 | 2 | 3;

export interface RaceInput {
  /** -1 left, +1 right. Steering in the water, lean on the bike. */
  steer: number;
  /** W or space held: stroke, pedal, or push on the run. */
  stroke: boolean;
  /** E pressed this tick (an edge, not a hold). */
  breathe: boolean;
  /** Q: stop and clear the goggles. */
  clear: boolean;
  /** 1 easy, 2 steady, 3 push. */
  pace: Pace;
}

export interface VoiceNote {
  km: number;
  text: string;
}

export interface RaceState {
  leg: Leg;
  /** Real seconds since the gun. */
  elapsed: number;
  /** Seconds on the bib clock. */
  raceSeconds: number;
  /** Progress along the current leg, sim metres. */
  s: number;
  /** Lateral position: drift in the water, line on the road. */
  x: number;
  speed: number;

  // Swim.
  fog: number;
  lake: number;
  breathPhase: number;
  /** The next beat is a wave. Breathe on it and you drink. */
  waveNext: boolean;
  /** Seconds since the last breath, for the HUD's air meter. */
  airHunger: number;
  clearing: boolean;
  clearProgress: number;
  clears: number;
  churn: number;
  inChurn: boolean;
  /** How close you are to the kayak line, 0..1. */
  splash: number;
  offMetres: number;
  /** The screen dip after a mouthful, 1 fading to 0. */
  dip: number;
  strokes: number;
  gulps: number;

  // Bike.
  grade: number;
  curvature: number;
  corner: { distance: number; dir: -1 | 1; curvature: number } | null;
  wobble: number;
  cornersWide: number;
  section: string;
  capped: boolean;
  climbFeet: number;

  // Run.
  pace: Pace;
  ankle: number;
  walking: boolean;
  walks: number;
  card: VoiceNote | null;
  cardUntil: number;
  km: number;

  /** A line of monologue and when it goes away. */
  note: string | null;
  noteUntil: number;
  finished: boolean;
  verdict: string;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Bib-clock seconds per real second, per leg. */
export const CLOCK_RATE: Record<Leg, number> = { swim: 20, bike: 40, run: 31, finish: 0 };
export const T1_SECONDS = 180;
export const T2_SECONDS = 120;
export const EXPECTED_SECONDS = 3 * 3600;

export const SWIM_SPEED = 13.5;
export const STROKE_PERIOD = 0.85;
export const FOG_PER_STROKE = 0.035;
export const CLEAR_SECONDS = 8;
export const BREATH_PERIOD = 2.2;
export const BREATH_WINDOW = 0.16;
export const WAVE_CHANCE = 0.28;
/** Skip one beat for a wave and you are fine. Skip two and you breathe anyway. */
export const MAX_AIR = BREATH_PERIOD * 2.4;
export const LANE_HALF = 5;
export const CHURN_X = -3.5;

export const BIKE_CAP = 20;
/** Gravity is exaggerated because the hills are short: it is the feel that is real. */
export const GRAVITY = 3.5;
export const BIKE_TERMINAL_DRAG = 0.0022;
export const ROAD_HALF = 4.5;
/** The most outward push a full lean can cancel, m/s. A hairpin at terminal beats it. */
export const LEAN_HOLD = 4.6;
/** How fast steering moves you across the road on a straight, m/s. */
export const STEER_DRIFT = 1.4;
export const CORNER_PUSH = 0.3;

export const RUN_SPEED: Record<Pace, number> = { 1: 5.0, 2: 6.6, 3: 8.6 };
export const WALK_SPEED = 2.5;
export const ANKLE_RATE: Record<Pace, number> = { 1: -1.0, 2: 1.5, 3: 6.0 };
export const WALK_RECOVERY = -6;

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** One per kilometre of the run, in the order they were recorded. */
export const VOICE_NOTES: VoiceNote[] = [
  { km: 1, text: "Swimming isn't my strongest discipline right now." },
  { km: 2, text: "I probably ingested a quarter of Lake Chelan." },
  { km: 3, text: "This has been awesome and reinforces that this is what life's about." },
  { km: 4, text: "Hard work beats talent when talent doesn't work hard." },
  { km: 5, text: "Halfway. Spirits remain high despite the physical discomfort." },
  { km: 6, text: "I tend to come out firing fast but want to build more consistency." },
  { km: 7, text: "New running shoes immediately after this race." },
  { km: 8, text: "Consider waterproof earbuds for future races, possibly bone conduction style." },
  { km: 9, text: "Expected this race to take 3 hours, likely finishing closer to 4 hours. Good learning for future pacing." },
];

export const AFTERWARDS = [
  "Goal to do 3-4 triathlons per year going forward.",
  "Escape from Alcatraz next summer, rated one of the hardest, $800 entry.",
  "Swim cap and goggles acquisition.",
  "Not interested in a swim cap yet, waiting until more serious.",
];

const LINES = {
  gun: "Murph talked me into this ten days ago. Olympic distance. Sure. Why not.",
  firstStroke: "First stroke. Goggles fogged. Okay. That's the swim now.",
  fogFull: "I am navigating by orange blob.",
  churnStart: "Somebody's foot. Somebody's whole foot.",
  gulp: [
    "That was a mouthful. That was a whole mouthful.",
    "Lake Chelan is glacial and I am drinking it.",
    "Breathed in a wave. Classic.",
    "It tastes like a boat.",
  ],
  kayak: "Kayaker says the buoys are that way. I thank her with my eyes.",
  clearStart: "Stopping. Goggles off. Oh. Oh, there's the buoy. It was right there.",
  turn: "Turn buoy. Halfway. Swimming isn't my strongest discipline right now.",
  beach: "Sand. Legs. Where did I leave the bike.",
  t1: "T1. Wetsuit off. The bike has no top gear and the brakes are decorative. Go.",
  capped: "That's it. That's the top gear. Spinning like a hamster in a wind tunnel.",
  climb: "Climb one of three. 1,700 feet today, apparently. Murph didn't mention that.",
  descent: "Descent. The brakes do nothing. I have decided to be at peace with it.",
  gravel: "Wide. Gravel. Wobble. Fine. Fine! Everything is fine.",
  smoke: "The smoke is softening the sun. Honestly? Nicer.",
  t2: "T2. Legs belong to somebody else. Shoes have no cushion left. Run anyway.",
  ankleFull: "Ankles. Walking for a bit. Spirits remain high despite the physical discomfort.",
  turnaround: "Turnaround. Five to go. The lake is right there and I am not getting back in it.",
  finish: "Finished. Closer to four than three. Last in my age group. Finished.",
};

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

export interface Race {
  state: RaceState;
  step(input: RaceInput, dt: number): void;
  /** Jump to a leg with a clean slate for it. For the page's restart buttons. */
  jump(leg: Leg): void;
}

export const NO_INPUT: RaceInput = { steer: 0, stroke: false, breathe: false, clear: false, pace: 2 };

export function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function verdictFor(state: RaceState): string {
  const t = state.raceSeconds;
  if (t < 3 * 3600 + 20 * 60) return "Faster than the plan. Suspicious. Somebody check those goggles for cheating.";
  if (t < 3 * 3600 + 50 * 60) return "Closer to three and a half than three. Good learning for future pacing.";
  if (t < 4 * 3600 + 15 * 60) return "Closer to four hours. Last in my age group. Finished. This is what life's about.";
  return "Well past four. The lake was in me and I was in the lake. Finished anyway, which is the whole point.";
}

export function createRace(seed = 1): Race {
  const rng = mulberry32(seed);

  const state: RaceState = {
    leg: "swim",
    elapsed: 0,
    raceSeconds: 0,
    s: 0,
    x: 1,
    speed: 0,
    fog: 0,
    lake: 0,
    breathPhase: 0,
    waveNext: false,
    airHunger: 0,
    clearing: false,
    clearProgress: 0,
    clears: 0,
    churn: 1,
    inChurn: false,
    splash: 0,
    offMetres: 0,
    dip: 0,
    strokes: 0,
    gulps: 0,
    grade: 0,
    curvature: 0,
    corner: null,
    wobble: 0,
    cornersWide: 0,
    section: "Shore road",
    capped: false,
    climbFeet: 0,
    pace: 2,
    ankle: 0,
    walking: false,
    walks: 0,
    card: null,
    cardUntil: 0,
    km: 0,
    note: null,
    noteUntil: 0,
    finished: false,
    verdict: "",
  };

  // Private timers.
  let strokeTimer = 0;
  let churnTimer = 0;
  let kayakStop = 0;
  let clearTimer = 0;
  let current = 0.6;
  let currentTimer = 0;
  let waveThisBeat = false;
  let nextCard = 0;
  let lastSection = "";
  const said = new Set<string>();

  const say = (text: string, seconds = 4.5) => {
    state.note = text;
    state.noteUntil = state.elapsed + seconds;
  };
  const sayOnce = (key: string, text: string, seconds = 4.5) => {
    if (said.has(key)) return;
    said.add(key);
    say(text, seconds);
  };

  const gulp = (amount: number, line?: string) => {
    state.lake = Math.min(100, state.lake + amount);
    state.dip = 1;
    state.gulps++;
    if (line) say(line, 3);
  };

  const enter = (leg: Leg) => {
    state.leg = leg;
    state.s = 0;
    state.speed = 0;
    state.x = leg === "swim" ? 1 : 0;
    state.wobble = 0;
    state.clearing = false;
    state.clearProgress = 0;
    if (leg === "swim") {
      state.fog = 0;
      state.churn = 1;
      state.breathPhase = 0;
      state.airHunger = 0;
      say(LINES.gun, 5);
    } else if (leg === "bike") {
      state.raceSeconds += T1_SECONDS;
      say(LINES.t1, 5);
    } else if (leg === "run") {
      state.raceSeconds += T2_SECONDS;
      state.ankle = 0;
      state.walking = false;
      nextCard = 0;
      say(LINES.t2, 5);
    } else {
      state.finished = true;
      state.verdict = verdictFor(state);
      say(LINES.finish, 12);
    }
  };

  // -------------------------------------------------------------------------

  const stepSwim = (input: RaceInput, dt: number) => {
    // Stroking.
    let target = 0;
    const stopped = state.clearing || kayakStop > 0;
    if (input.stroke && !stopped) {
      strokeTimer += dt;
      if (strokeTimer >= STROKE_PERIOD) {
        strokeTimer -= STROKE_PERIOD;
        state.strokes++;
        const before = state.fog;
        state.fog = Math.min(1, state.fog + FOG_PER_STROKE);
        if (state.strokes === 1) sayOnce("first", LINES.firstStroke, 4);
        if (before < 1 && state.fog >= 1) sayOnce("fogfull", LINES.fogFull, 3.5);
      }
      const lungs = 1 - 0.3 * Math.min(1, state.lake / 40);
      const crowd = state.inChurn ? 0.85 : 1;
      target = SWIM_SPEED * lungs * crowd;
    }
    state.speed += (target - state.speed) * Math.min(1, dt * (target > state.speed ? 2.5 : 1.2));

    // Clearing the goggles: stop, and the view snaps clear after a beat.
    if (input.clear && !state.clearing && kayakStop <= 0) {
      state.clearing = true;
      clearTimer = 0;
      state.clears++;
      state.speed = 0;
      say(LINES.clearStart, 4);
    }
    if (state.clearing) {
      clearTimer += dt;
      state.clearProgress = Math.min(1, clearTimer / CLEAR_SECONDS);
      if (clearTimer >= 1.5) state.fog = 0;
      if (clearTimer >= CLEAR_SECONDS) {
        state.clearing = false;
        state.clearProgress = 0;
      }
    }
    if (kayakStop > 0) kayakStop -= dt;

    // Drift. A current pushes you toward the kayaks; fog hides that it does.
    currentTimer -= dt;
    if (currentTimer <= 0) {
      currentTimer = 4 + rng() * 6;
      current = 0.3 + rng() * 0.9;
      if (rng() < 0.2) current = -current * 0.6;
    }
    const moving = state.speed > 1 ? 1 : 0.3;
    state.x += current * moving * dt;
    state.x += input.steer * 3.2 * moving * dt;

    // The crowd thins as the race spreads out. At the start it is everywhere.
    state.churn = Math.max(0.12, 1 - (state.s / SWIM_LENGTH) * 1.3);
    const churnEdge = state.s < 70 ? 6 : CHURN_X;
    state.inChurn = state.x < churnEdge && state.churn > 0.15;
    if (state.inChurn && state.speed > 1) {
      churnTimer += dt;
      if (churnTimer > 2.0) {
        churnTimer = 0;
        sayOnce("churn", LINES.churnStart, 3);
        gulp(0.7 * state.churn + 0.3);
      }
    } else churnTimer = 0;

    // The kayak line. Splash first, then a paddle across the bow.
    state.splash = Math.max(0, Math.min(1, (state.x - 6) / (KAYAK_X - 6)));
    if (state.x > KAYAK_X && kayakStop <= 0) {
      kayakStop = 2.5;
      state.speed = 0;
      state.x = KAYAK_X - 5;
      say(LINES.kayak, 3.5);
    }
    // And the buoy line on the other side: you cannot swim through a buoy.
    if (state.x < BUOY_X - 2) state.x = BUOY_X - 2;

    // Off the line is extra distance.
    const off = Math.abs(state.x - 1) - LANE_HALF;
    if (off > 0 && state.speed > 1) state.offMetres += state.speed * dt * Math.min(0.5, off / 12);

    // Breathing, on the beat.
    state.breathPhase += dt / BREATH_PERIOD;
    if (state.breathPhase >= 1) {
      state.breathPhase -= 1;
      waveThisBeat = state.waveNext;
      state.waveNext = rng() < WAVE_CHANCE;
    }
    state.airHunger += dt;
    if (input.breathe && !state.clearing) {
      const dist = Math.min(state.breathPhase, 1 - state.breathPhase);
      const onBeat = dist < BREATH_WINDOW;
      // Just before the beat counts as the coming beat's wave; just after, the last one's.
      const wave = state.breathPhase < 0.5 ? waveThisBeat : state.waveNext;
      if (onBeat && !wave) {
        state.airHunger = 0;
      } else {
        state.airHunger = 0;
        const amount = wave ? 1.3 : 0.8;
        gulp(amount + (state.inChurn ? 0.4 : 0), LINES.gulp[state.gulps % LINES.gulp.length]);
      }
    }
    if (state.airHunger > MAX_AIR && !state.clearing) {
      // You breathe whether you meant to or not.
      state.airHunger = 0;
      gulp(0.9, "Had to breathe. Got water.");
    }

    // Along the course.
    const wasOut = state.s < SWIM_TURN;
    state.s += state.speed * dt;
    if (wasOut && state.s >= SWIM_TURN) {
      say(LINES.turn, 4.5);
      state.x = Math.max(-2, Math.min(4, state.x));
    }
    if (state.s >= SWIM_LENGTH) {
      say(LINES.beach, 3);
      enter("bike");
    }
  };

  // -------------------------------------------------------------------------

  const stepBike = (input: RaceInput, dt: number) => {
    const here = bikeAt(state.s);
    state.grade = here.grade;
    state.curvature = here.curvature;
    state.section = bikeSectionAt(state.s);
    state.corner = nextCorner(state.s);
    if (state.section !== lastSection) {
      lastSection = state.section;
      if (state.section === "Climb one") sayOnce("climb", LINES.climb, 4);
      if (state.section === "Descent one") sayOnce("descent", LINES.descent, 4);
      if (state.section === "Orchards") sayOnce("smoke", LINES.smoke, 4);
    }

    // No top gear: the drive stops at the cap, whatever the road is doing.
    const g = state.grade;
    let target = BIKE_CAP;
    if (g > 0.005) target = BIKE_CAP / (1 + g * 10);
    const pedalling = input.stroke && state.wobble <= 0;
    // With gears you would spin up to the target and hold it; this is that,
    // with the target stuck where the missing top gear leaves it.
    const driving = pedalling && state.speed < target;
    if (driving) state.speed += (target - state.speed) * Math.min(1, dt * 0.9);
    state.capped = pedalling && state.speed >= target - 0.5 && g <= 0.005;
    if (state.capped) sayOnce("capped", LINES.capped, 3.5);
    // Gravity. The brakes are broken, so a descent is a descent: it takes
    // you past the cap and there is nothing to do about it but lean.
    let a = 0;
    if (g < 0 || !driving) a -= 9.8 * g * GRAVITY;
    // Drag and rolling resistance, once the gears have nothing left to give.
    if (!driving) {
      a -= BIKE_TERMINAL_DRAG * state.speed * state.speed;
      if (g >= -0.005 && state.speed > 0.1) a -= 0.4;
    }
    state.speed = Math.max(0, state.speed + a * dt);
    if (state.wobble > 0) {
      state.wobble -= dt;
      state.speed = Math.min(state.speed, 7);
    }

    // The line. `x` is metres right of the centre line. A right turn
    // (positive curvature) throws you outward, which is left; leaning right
    // (+steer) moves you right. Hold the lean through the corner or run wide.
    // Leaning into the corner holds the line, up to what a bike can hold;
    // past that the hairpin wins. Steering on a straight is a gentle drift.
    const inCorner = Math.abs(state.curvature) > 0.006;
    const push = state.wobble > 0 ? 0 : Math.abs(state.speed * state.speed * state.curvature * CORNER_PUSH);
    const outward = -Math.sign(state.curvature);
    const leaningIn = input.steer * outward < 0;
    if (inCorner && leaningIn) {
      // A lean is a lean, not a lane change: it cancels the push and no more.
      const held = Math.min(push, LEAN_HOLD * Math.abs(input.steer));
      state.x += outward * (push - held) * dt;
    } else {
      state.x += outward * push * dt;
      state.x += input.steer * STEER_DRIFT * dt * (state.wobble > 0 ? 0.3 : 1);
    }
    if (Math.abs(state.x) > ROAD_HALF) {
      state.cornersWide++;
      state.wobble = 2.2;
      state.speed = Math.max(6, state.speed * 0.4);
      state.x = Math.sign(state.x) * 2;
      say(LINES.gravel, 3);
    }

    if (g > 0.005 && state.speed > 0) state.climbFeet += state.speed * dt * g * REAL.climbFeet;

    state.s += state.speed * dt;
    if (state.s >= BIKE_LENGTH) enter("run");
  };

  // -------------------------------------------------------------------------

  const stepRun = (input: RaceInput, dt: number) => {
    state.pace = input.stroke ? 3 : input.pace;
    if (state.walking) {
      state.ankle = Math.max(0, state.ankle + WALK_RECOVERY * dt);
      if (state.ankle < 55) state.walking = false;
    } else {
      state.ankle = Math.max(0, Math.min(100, state.ankle + ANKLE_RATE[state.pace] * dt));
      if (state.ankle >= 100) {
        state.walking = true;
        state.walks++;
        say(LINES.ankleFull, 4.5);
      }
    }
    const target = state.walking ? WALK_SPEED : RUN_SPEED[state.pace] * (1 - 0.15 * Math.min(1, state.lake / 40));
    state.speed += (target - state.speed) * Math.min(1, dt * 3);

    const wasOut = state.s <= RUN_TURN;
    state.s += state.speed * dt;
    if (wasOut && state.s > RUN_TURN) say(LINES.turnaround, 4);
    state.km = state.s * REAL.runKm;

    // The voice notes, one per kilometre, in the order they were recorded.
    if (nextCard < VOICE_NOTES.length && state.km >= VOICE_NOTES[nextCard].km) {
      state.card = VOICE_NOTES[nextCard];
      state.cardUntil = state.elapsed + 6.5;
      nextCard++;
    }
    if (state.card && state.elapsed > state.cardUntil) state.card = null;

    if (state.s >= RUN_LENGTH) enter("finish");
  };

  // -------------------------------------------------------------------------

  const step = (input: RaceInput, dt: number) => {
    if (state.finished) return;
    dt = Math.max(0, Math.min(0.1, dt));
    state.elapsed += dt;
    state.raceSeconds += dt * CLOCK_RATE[state.leg];
    state.dip = Math.max(0, state.dip - dt * 1.6);
    if (state.leg === "swim") stepSwim(input, dt);
    else if (state.leg === "bike") stepBike(input, dt);
    else if (state.leg === "run") stepRun(input, dt);
    if (state.note && state.elapsed > state.noteUntil) state.note = null;
  };

  enter("swim");

  return {
    state,
    step,
    jump(leg) {
      state.finished = false;
      enter(leg);
    },
  };
}
