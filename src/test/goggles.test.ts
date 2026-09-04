/**
 * The Half-Blind Triathlon is a state machine, so it can be raced a hundred
 * times here without a lake. What is checked is that every race ends, that
 * the clock lands where the real one did, that the goggles cost what they
 * should, and that nothing in the water can kill you.
 */
import { describe, expect, it } from "vitest";
import {
  BIKE_CLIMB,
  BIKE_LENGTH,
  REAL,
  RUN_LENGTH,
  SWIM_LENGTH,
  bikeAt,
  nextCorner,
  runAt,
  swimAt,
} from "@/goggles/course";
import {
  AFTERWARDS,
  BREATH_WINDOW,
  VOICE_NOTES,
  createRace,
  fmtClock,
  mulberry32,
  type Pace,
  type RaceInput,
  type RaceState,
} from "@/goggles/race";

const DT = 1 / 60;
const MAX_REAL_SECONDS = 20 * 60;

type Brain = (s: RaceState, tick: number) => RaceInput;

/** Drive a race with a brain until it finishes or the clock runs out. */
function play(brain: Brain, seed = 1, until?: (s: RaceState) => boolean) {
  const race = createRace(seed);
  let tick = 0;
  const legTimes: Record<string, number> = {};
  let lastLeg = race.state.leg;
  while (!race.state.finished && race.state.elapsed < MAX_REAL_SECONDS) {
    race.step(brain(race.state, tick++), DT);
    if (race.state.leg !== lastLeg) {
      legTimes[lastLeg] = race.state.elapsed;
      lastLeg = race.state.leg;
    }
    if (until && until(race.state)) break;
  }
  return { state: race.state, legTimes };
}

/** A sensible athlete: on the line, on the beat, leaning into corners, steady. */
function sensible(opts: { clearAt?: number; lean?: boolean; pace?: Pace } = {}): Brain {
  const clearAt = opts.clearAt ?? 0.9;
  const lean = opts.lean ?? true;
  let breathedThisBeat = false;
  let lastPhase = 0;
  let easing = false;
  return (s) => {
    const input: RaceInput = { steer: 0, stroke: true, breathe: false, clear: false, pace: opts.pace ?? 2 };
    if (s.leg === "swim") {
      input.steer = Math.max(-1, Math.min(1, (1 - s.x) * 0.6));
      if (s.breathPhase < lastPhase) breathedThisBeat = false;
      lastPhase = s.breathPhase;
      const dist = Math.min(s.breathPhase, 1 - s.breathPhase);
      const upcomingWave = s.breathPhase > 0.5 ? s.waveNext : false;
      if (dist < BREATH_WINDOW * 0.5 && !breathedThisBeat && !upcomingWave && s.breathPhase > 0.5) {
        input.breathe = true;
        breathedThisBeat = true;
      }
      if (s.fog >= clearAt && !s.clearing) input.clear = true;
    } else if (s.leg === "bike") {
      const inCorner = Math.abs(s.curvature) > 0.006;
      const soon = s.corner && s.corner.distance < 6;
      if (!lean) input.steer = 0;
      else if (inCorner || soon) input.steer = inCorner ? Math.sign(s.curvature) : s.corner!.dir;
      else input.steer = Math.max(-1, Math.min(1, -s.x * 0.5));
    } else if (s.leg === "run") {
      input.stroke = false;
      if (s.ankle > 85) easing = true;
      if (s.ankle < 35) easing = false;
      input.pace = easing ? 1 : (opts.pace ?? 2);
    }
    return input;
  };
}

/** Somebody mashing every button, with a seed. */
function chaos(seed: number): Brain {
  const rng = mulberry32(seed);
  return () => ({
    steer: rng() * 2 - 1,
    stroke: rng() < 0.65,
    breathe: rng() < 0.06,
    clear: rng() < 0.002,
    pace: (1 + Math.floor(rng() * 3)) as Pace,
  });
}

describe("the courses", () => {
  it("scale to the numbers on the bib", () => {
    expect(SWIM_LENGTH * REAL.swimMetres).toBeCloseTo(1500);
    expect(BIKE_LENGTH * REAL.bikeKm).toBeCloseTo(40);
    expect(RUN_LENGTH * REAL.runKm).toBeCloseTo(10);
    expect(BIKE_CLIMB * REAL.climbFeet).toBeCloseTo(1700);
  });

  it("swim out and back on two lanes", () => {
    const a = swimAt(0, 0);
    const b = swimAt(700, 0);
    const c = swimAt(1400, 0);
    expect(b.z).toBeGreaterThan(a.z);
    expect(c.z).toBeLessThan(b.z);
    expect(Math.abs(c.x - a.x)).toBeGreaterThan(20);
  });

  it("bike loop is continuous and has corners on the descents", () => {
    let prev = bikeAt(0);
    for (let s = 2; s < BIKE_LENGTH; s += 2) {
      const p = bikeAt(s);
      expect(Math.hypot(p.x - prev.x, p.z - prev.z)).toBeLessThan(2.6);
      prev = p;
    }
    const corner = nextCorner(0);
    expect(corner).not.toBeNull();
    expect(corner!.distance).toBeGreaterThan(0);
    expect(bikeAt(BIKE_LENGTH).y).toBeGreaterThan(-20);
    expect(bikeAt(BIKE_LENGTH).y).toBeLessThan(30);
  });

  it("run turns around at the halfway cone", () => {
    const out = runAt(RUN_LENGTH / 2 - 10);
    const back = runAt(RUN_LENGTH / 2 + 10);
    expect(Math.hypot(out.x - back.x, out.z - back.z)).toBeLessThan(1);
    expect(Math.abs(out.heading - back.heading)).toBeCloseTo(Math.PI, 1);
  });
});

describe("the words", () => {
  it("has a voice note for every kilometre of the run, in order", () => {
    expect(VOICE_NOTES.map((n) => n.km)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(VOICE_NOTES[1].text).toBe("I probably ingested a quarter of Lake Chelan.");
    expect(AFTERWARDS.some((l) => l.includes("Alcatraz"))).toBe(true);
  });

  it("formats the clock like a bib", () => {
    expect(fmtClock(3 * 3600 + 47 * 60 + 5)).toBe("3:47:05");
  });
});

describe("a race", () => {
  it("is deterministic for a seed", () => {
    const a = play(sensible(), 7);
    const b = play(sensible(), 7);
    expect(a.state.raceSeconds).toBe(b.state.raceSeconds);
    expect(a.state.lake).toBe(b.state.lake);
    expect(a.state.offMetres).toBe(b.state.offMetres);
  });

  it("always finishes, for a sensible athlete and for chaos", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = play(sensible(), seed).state;
      expect(s.finished, `sensible seed ${seed}`).toBe(true);
      const c = play(chaos(seed), seed).state;
      expect(c.finished, `chaos seed ${seed}`).toBe(true);
    }
  });

  it("lands between 3:00 and 4:30 for a normal run at 1x", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { state, legTimes } = play(sensible(), seed);
      expect(state.raceSeconds, `seed ${seed}: ${fmtClock(state.raceSeconds)}`).toBeGreaterThan(3 * 3600);
      expect(state.raceSeconds, `seed ${seed}: ${fmtClock(state.raceSeconds)}`).toBeLessThan(4.5 * 3600);
      // And about two minutes a leg, give or take, of real time.
      expect(legTimes.swim).toBeGreaterThan(90);
      expect(legTimes.swim).toBeLessThan(200);
      expect(legTimes.bike - legTimes.swim).toBeGreaterThan(90);
      expect(legTimes.bike - legTimes.swim).toBeLessThan(220);
      expect(state.elapsed - legTimes.bike).toBeGreaterThan(90);
      expect(state.elapsed - legTimes.bike).toBeLessThan(220);
      expect(state.verdict.length).toBeGreaterThan(10);
    }
  });

  it("visits every leg in order and pops the voice notes in order", () => {
    const race = createRace(3);
    const brain = sensible();
    const legs: string[] = [];
    const cards: number[] = [];
    let tick = 0;
    while (!race.state.finished && race.state.elapsed < MAX_REAL_SECONDS) {
      race.step(brain(race.state, tick++), DT);
      if (legs[legs.length - 1] !== race.state.leg) legs.push(race.state.leg);
      if (race.state.card && cards[cards.length - 1] !== race.state.card.km) cards.push(race.state.card.km);
    }
    expect(legs).toEqual(["swim", "bike", "run", "finish"]);
    expect(cards).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("the swim", () => {
  it("fogs with every stroke and clearing costs time", () => {
    const never = play(sensible({ clearAt: 2 }), 5, (s) => s.leg !== "swim");
    const often = play(sensible({ clearAt: 0.5 }), 5, (s) => s.leg !== "swim");
    expect(never.state.clears).toBe(0);
    expect(often.state.clears).toBeGreaterThan(2);
    expect(often.state.elapsed).toBeGreaterThan(never.state.elapsed + often.state.clears * 6);
    expect(never.state.strokes).toBeGreaterThan(50);
  });

  it("goes clear when you stop, then fogs again from zero", () => {
    const race = createRace(2);
    const on: RaceInput = { steer: 0, stroke: true, breathe: false, clear: false, pace: 2 };
    for (let i = 0; i < 60 * 25; i++) race.step(on, DT);
    expect(race.state.fog).toBeGreaterThan(0.6);
    race.step({ ...on, clear: true }, DT);
    expect(race.state.clearing).toBe(true);
    for (let i = 0; i < 60 * 2; i++) race.step(on, DT);
    expect(race.state.fog).toBe(0);
    expect(race.state.speed).toBeLessThan(0.5);
    for (let i = 0; i < 60 * 7; i++) race.step(on, DT);
    expect(race.state.clearing).toBe(false);
    for (let i = 0; i < 60 * 5; i++) race.step(on, DT);
    expect(race.state.fog).toBeGreaterThan(0.05);
    expect(race.state.fog).toBeLessThan(0.4);
  });

  it("never kills you, however much of the lake you drink", () => {
    const race = createRace(9);
    const gulping: RaceInput = { steer: 0, stroke: true, breathe: true, clear: false, pace: 2 };
    let tick = 0;
    while (race.state.leg === "swim" && race.state.elapsed < MAX_REAL_SECONDS) {
      race.step(gulping, DT);
      tick++;
    }
    expect(race.state.leg).toBe("bike");
    expect(race.state.lake).toBeGreaterThan(20);
    expect(race.state.lake).toBeLessThanOrEqual(100);
    expect(race.state.gulps).toBeGreaterThan(30);
    // Slower, not dead: it took longer than a clean swim.
    const clean = play(sensible(), 9, (s) => s.leg !== "swim");
    expect(race.state.elapsed).toBeGreaterThan(clean.state.elapsed);
    expect(tick).toBeGreaterThan(0);
  });

  it("swims extra metres when it drifts off the line", () => {
    const race = createRace(4);
    const wide: RaceInput = { steer: 1, stroke: true, breathe: false, clear: false, pace: 2 };
    for (let i = 0; i < 60 * 30; i++) race.step(wide, DT);
    expect(race.state.offMetres).toBeGreaterThan(20);
    expect(race.state.x).toBeLessThan(16);
  });
});

describe("the bike", () => {
  it("has no top gear: pedalling past the cap does nothing", () => {
    const race = createRace(1);
    race.jump("bike");
    const pedal: RaceInput = { steer: 0, stroke: true, breathe: false, clear: false, pace: 2 };
    let max = 0;
    while (race.state.s < 150) {
      race.step(pedal, DT);
      max = Math.max(max, race.state.speed);
    }
    expect(max).toBeLessThanOrEqual(20.05);
    expect(race.state.capped).toBe(true);
  });

  it("runs wide without a lean and holds the road with one", () => {
    const stiff = play(sensible({ lean: false }), 2, (s) => s.leg === "run");
    const leaning = play(sensible({ lean: true }), 2, (s) => s.leg === "run");
    expect(stiff.state.cornersWide).toBeGreaterThan(0);
    expect(leaning.state.cornersWide).toBeLessThan(stiff.state.cornersWide);
  });

  it("gains speed on a descent and cannot shed it", () => {
    const race = createRace(1);
    race.jump("bike");
    const coast: RaceInput = { steer: 0, stroke: false, breathe: false, clear: false, pace: 2 };
    const pedal: RaceInput = { ...coast, stroke: true };
    // Pedal to the first crest, then coast the descent with the lean the brain would use.
    while (race.state.section !== "Descent one") race.step({ ...pedal, steer: -race.state.x * 0.5 }, DT);
    const atCrest = race.state.speed;
    let peak = atCrest;
    while (race.state.section === "Descent one") {
      race.step({ ...coast, steer: Math.sign(race.state.curvature) }, DT);
      peak = Math.max(peak, race.state.speed);
    }
    expect(peak).toBeGreaterThan(atCrest + 5);
    expect(peak).toBeGreaterThan(20);
  });
});

describe("the run", () => {
  it("fills the ankle faster on push and forces a walk when full", () => {
    const race = createRace(1);
    race.jump("run");
    const push: RaceInput = { steer: 0, stroke: false, breathe: false, clear: false, pace: 3 };
    let walked = false;
    for (let i = 0; i < 60 * 40 && !walked; i++) {
      race.step(push, DT);
      if (race.state.walking) walked = true;
    }
    expect(walked).toBe(true);
    expect(race.state.walks).toBe(1);
    expect(race.state.speed).toBeGreaterThan(0);
    const easy = createRace(1);
    easy.jump("run");
    for (let i = 0; i < 60 * 40; i++) easy.step({ ...push, pace: 1 }, DT);
    expect(easy.state.walking).toBe(false);
    expect(easy.state.ankle).toBe(0);
  });
});
