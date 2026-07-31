/**
 * Vibe Kart — the race.
 *
 * Grid, lights, laps, positions, the flag. This module is the only thing in the
 * game that decides what "first place" means, when a lap counts, and when the
 * race is over. Everything else — physics, AI, HUD, music — reacts to what is
 * published here.
 *
 * Three decisions shape the whole file:
 *
 *   **Position is checkpoint-validated, never raw distance.** A racer's score is
 *   the number of checkpoints they have legitimately passed, in order, plus how
 *   far they are through the current one. Cutting a corner, driving backwards
 *   over the line, or being lifted across the map by a respawn cannot invent
 *   progress, because a checkpoint is only ever credited when it is the *next*
 *   one owed. That single rule replaces the pile of special cases every naive
 *   `lap + t` implementation eventually grows.
 *
 *   **The race clock is fixed-step.** Everything that has to be reproducible —
 *   the countdown, lap times, the rocket-start window — is measured in
 *   `fixedUpdate` at FIXED_DT, so the screenshot harness stepping at a fixed dt
 *   sees exactly the race a player sees at 60fps, and lap times are not a
 *   function of frame rate.
 *
 *   **`RacerState.finished` is a *physics* flag, not a result.** The drive model
 *   cuts the throttle of any racer whose `finished` is set, so raising it at the
 *   finish line would park eight karts on the pit straight the moment they
 *   crossed. So the flag goes up at the *end* of the cool-down lap, and
 *   `standings()` is the authority on who has actually finished and where.
 *
 * Nothing here imports another subsystem. Every service is read off
 * `ctx.services` and every one of them is allowed to be missing: with no
 * physics there is no field and the clock still runs; with no track the
 * checkpoints degrade to a single lap segment; with no audio the race is silent
 * and otherwise identical.
 */
import { TUNING, type AudioService, type KartCtx, type PhysicsService, type RacePhase, type RaceService, type RacerState, type Standing, type System, type TrackFrame, type TrackService } from "../types";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const RACE = {
  /** Beat on the grid before the lights start, so the world settles first. */
  gridHold: 1.5,
  /** Lights: 3 · 2 · 1 · GO, one second apart. */
  countdownFrom: 3,

  /**
   * Rocket start. Measured as *how long the throttle has been held without a
   * release at the instant the lights go out* — which is the only measurement
   * that cannot be gamed by mashing.
   *
   *   under `startMin`        you were late: nothing.
   *   `startMin`..`startLo`   early-ish or nearly-late: a half boost.
   *   `startLo`..`startHi`    the sweet spot: the full rocket.
   *   `startHi`..`startFlood` fading out again: a half boost.
   *   over `startFlood`       you flooded it: the engine bogs on the line.
   *
   * The sweet spot is a little over half a second wide. Wide enough that a
   * player who understands it lands it most of the time, tight enough that
   * "hold accelerate from the moment the lights appear" is punished — which is
   * the entire point of the mechanic.
   */
  startMin: 0.1,
  startLo: 0.2,
  startHi: 0.72,
  startFlood: 0.95,
  startBoost: 1.55,
  startBoostWeak: 0.7,
  /** How long a flooded engine bogs. Long enough to lose two places. */
  startStall: 1.0,
  /** Player throttle counts as "held" above this. */
  revThreshold: 0.55,
  /**
   * The rivals' throttle belongs to the physics system, so their start is read
   * off the one channel that *is* published: engine rpm, which climbs from idle
   * the moment they touch the gas even on a frozen grid. The reading lags the
   * press by about a damping constant, so it is paid back before grading.
   */
  rpmThreshold: 0.45,
  rpmLag: 0.06,

  /** Wrong-way: sustained travel against the tangent, and how it clears. */
  wrongDot: -0.35,
  wrongSpeed: 4.5,
  wrongOn: 0.55,
  wrongOff: 0.12,
  wrongDecay: 2.2,

  /** Celebration lap: how long a finisher keeps driving before rolling to a stop. */
  coolDown: 6,
  /** Once the player is home, the stragglers get this long to make it. */
  closeGrace: 14,
  /** A race nobody finishes still has to end. */
  hardTimeout: 15 * 60,
  /** Beat between the last car home and the results screen. */
  resultsDelay: 2.4,
} as const;

/** Bumped when the stored shape changes; an old key is simply ignored. */
const RECORD_KEY = "vibekart.timeTrial.v1";

export type RaceMode = "grandPrix" | "timeTrial";

export type StartGrade = "none" | "good" | "perfect" | "flooded";

export interface TimeTrialRecord {
  course: string;
  characterId: string;
  /** Best single lap, seconds. */
  bestLap: number;
  /** Best full run, seconds. */
  bestTotal: number;
  laps: number;
  /** Wall clock of the run, for a "set today" flourish in the UI. */
  at: number;
}

/**
 * The published handle. `RaceService` is the contract; everything below it is
 * additive and any consumer is free to ignore it. Declared here rather than in
 * `types.ts` because this module does not get to edit shared law.
 */
export interface KartRaceService extends RaceService {
  /** Seconds spent in the current phase — the UI animates transitions off this. */
  phaseTime: number;
  mode: RaceMode;
  setMode(mode: RaceMode): void;
  /** Frozen by the pause menu. Physics and music stop; the render loop does not. */
  paused: boolean;
  setPaused(paused: boolean): void;
  /** Let the grid roll on its own. A title screen sets this false and calls `start()`. */
  autoStart: boolean;

  /** True once the player is on the last lap. */
  finalLap: boolean;
  /** Laps *completed* by a racer (0-based, matching `RacerState.lap`). */
  lapOf(id: number): number;
  /** Validated progress in laps: completed laps plus the fraction of this one. */
  progressOf(id: number): number;
  /** Split times of every lap a racer has completed, seconds. */
  lapsOf(id: number): number[];
  /** Best lap so far, or 0. */
  bestLapOf(id: number): number;
  /** Estimated seconds behind the leader — HUD candy, not a stopwatch. */
  gapOf(id: number): number;
  /** Sustained travel against the racing direction. */
  wrongWay(id?: number): boolean;

  /** Live rocket-start state, for the countdown HUD and its smoke. */
  rocket: { hold: number; flooded: boolean; grade: StartGrade };
  /** Grade a racer's launch got, once the lights are out. */
  startGradeOf(id: number): StartGrade;

  /** Final order, or null until the flag. */
  results(): Standing[] | null;
  /** Persisted time-trial record for this course, or null. */
  record: TimeTrialRecord | null;
  /** Best lap and total of the run just completed, in time-trial mode. */
  lastRun: { lap: number; total: number } | null;
  /** Wipe the stored time-trial record for this course. */
  clearRecord(): void;
}

// ---------------------------------------------------------------------------
// Small maths — kept local so this module has no runtime imports at all
// ---------------------------------------------------------------------------

function wrap01(x: number): number {
  const v = x - Math.floor(x);
  return v < 0 ? v + 1 : v;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Deterministic per-racer noise. No Math.random anywhere in the race. */
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "course";
}

// ---------------------------------------------------------------------------
// Structural views of services this module does not own
// ---------------------------------------------------------------------------

/** Extras the physics system publishes beyond the contract. All optional. */
interface PhysicsExtras {
  arcOf?(id: number): number;
  /** Set to hand the player's kart to the AI for the cool-down lap. */
  playerAi?: boolean;
}
type Phys = PhysicsService & PhysicsExtras;

/** The two additive channels the physics racer carries that the race reads. */
interface RacerExtras {
  t?: number;
  respawning?: boolean;
}

interface StartLights {
  setStartLights?(n: number): void;
}

/** Per-racer race bookkeeping. Never leaves this module. */
interface Entry {
  racer: RacerState;
  id: number;
  /** Grid slot, kept so a restart puts everyone back where they started. */
  slot: number;

  /** Normalised arc position, refreshed every fixed step. */
  t: number;
  /** Projection hint for the fallback path when physics does not publish `t`. */
  hint: number;
  /** The checkpoint this racer owes next. */
  nextCp: number;
  /** Checkpoints validated since the race began — the ordering key. */
  chain: number;
  /** Checkpoints validated since the last lap was credited. */
  sinceLap: number;
  /** Validated progress in laps: `chain/N` plus the fraction of the segment. */
  progress: number;
  /** Laps completed. */
  lap: number;
  lapStart: number;
  lapTimes: number[];
  bestLap: number;

  /** Crossed the line for the last time. */
  done: boolean;
  place: number;
  finishTime: number;
  /** Counts the celebration lap down; at zero the throttle finally cuts. */
  coolDown: number;

  /** Rocket start. */
  hold: number;
  flooded: boolean;
  grade: StartGrade;

  wrongTimer: number;
  wrong: boolean;

  /** Time-trial parking: hidden and pinned to the grid. */
  parked: boolean;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadRecords(): Record<string, TimeTrialRecord> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(RECORD_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, TimeTrialRecord>;
  } catch {
    // Private browsing, a quota wall, a half-written value: a lost ghost time
    // is not a reason to fail to boot.
    return {};
  }
}

function saveRecords(all: Record<string, TimeTrialRecord>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(RECORD_KEY, JSON.stringify(all));
  } catch {
    /* see above */
  }
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export default function createRace(ctx: KartCtx): System {
  const physics = (): Phys | undefined => ctx.services.physics as Phys | undefined;
  const track = (): TrackService | undefined => ctx.services.track as TrackService | undefined;
  const audio = (): AudioService | undefined => ctx.services.audio as AudioService | undefined;

  const entries: Entry[] = [];
  const byId = new Map<number, Entry>();
  /** Everyone actually in this race, sorted; the source of `place`. */
  const order: Entry[] = [];

  let phase: RacePhase = "grid";
  let phaseTime = 0;
  let time = 0;
  let countdown = 0;
  /** Lowest light count already announced, so each beat fires exactly once. */
  let lightsShown = RACE.countdownFrom + 1;
  let closeTimer = 0;
  let resultsTimer = 0;
  let finishCount = 0;
  let finalLapAnnounced = false;
  let results: Standing[] | null = null;
  /** Bumped by every restart — salts the rivals' start reactions. */
  let generation = 0;

  let mutedByPause = false;
  /** The last pause-key edge we acted on, to swallow a repeat within a frame. */
  let pauseLatch = false;

  const records = loadRecords();
  let courseKey = "course";
  let lastRun: { lap: number; total: number } | null = null;

  /** Reused across every frame query — `frameAt` fills it rather than allocating. */
  let frameScratch: TrackFrame | null = null;
  const ZERO_CONTROLS = { accel: 0, brake: 0, steer: 0, drift: false };

  const checkpointCount = (): number => {
    const n = track()?.checkpointCount ?? 0;
    return n >= 2 ? n : 8;
  };

  // -------------------------------------------------------------------------
  // The published handle — synchronous, before anything can throw
  // -------------------------------------------------------------------------
  const service: KartRaceService = {
    phase: "grid",
    phaseTime: 0,
    time: 0,
    countdown: 0,
    totalLaps: 3,
    mode: "grandPrix",
    paused: false,
    autoStart: true,
    finalLap: false,
    rocket: { hold: 0, flooded: false, grade: "none" },
    record: null,
    lastRun: null,

    standings() {
      const out: Standing[] = [];
      for (const e of order) out.push(standingOf(e));
      return out;
    },

    playerStanding() {
      const e = playerEntry();
      return e ? standingOf(e) : { id: 0, name: "—", place: 1, finished: false, time, lap: 0, bestLap: 0 };
    },

    start() {
      if (phase === "grid") beginCountdown();
      else if (phase === "results" || phase === "finished") service.restart();
    },

    restart() {
      restart();
    },

    setMode(mode) {
      if (mode === service.mode) return;
      service.mode = mode;
      ctx.emit("race:mode", { mode });
      restart();
    },

    setPaused(next) {
      setPaused(next, true);
    },

    lapOf: (id) => byId.get(id)?.lap ?? 0,
    progressOf: (id) => byId.get(id)?.progress ?? 0,
    lapsOf: (id) => byId.get(id)?.lapTimes.slice() ?? [],
    bestLapOf: (id) => byId.get(id)?.bestLap ?? 0,

    gapOf(id) {
      const e = byId.get(id);
      const leader = order[0];
      if (!e || !leader || leader === e) return 0;
      const laps = Math.max(0.001, leader.progress - e.progress);
      const length = track()?.length ?? 1200;
      // Converted at the racer's own pace, floored well below a crawl so a
      // stationary kart reports a big number instead of an infinite one.
      const pace = Math.max(8, Math.abs(e.racer.speed));
      return (laps * length) / pace;
    },

    wrongWay(id) {
      if (id === undefined) return playerEntry()?.wrong ?? false;
      return byId.get(id)?.wrong ?? false;
    },

    startGradeOf: (id) => byId.get(id)?.grade ?? "none",

    results: () => results,

    clearRecord() {
      delete records[courseKey];
      saveRecords(records);
      service.record = null;
    },
  };

  ctx.services.race = service;

  // -------------------------------------------------------------------------
  // Field
  // -------------------------------------------------------------------------

  function playerEntry(): Entry | undefined {
    const phys = physics();
    const player = phys?.player;
    if (player) {
      const e = byId.get(player.id);
      if (e) return e;
    }
    for (const e of entries) if (e.racer.isPlayer) return e;
    return entries[0];
  }

  function makeEntry(racer: RacerState, slot: number): Entry {
    return {
      racer,
      id: racer.id,
      slot,
      t: 0,
      hint: 0,
      nextCp: 0,
      chain: 0,
      sinceLap: 0,
      progress: 0,
      lap: 0,
      lapStart: 0,
      lapTimes: [],
      bestLap: 0,
      done: false,
      place: slot + 1,
      finishTime: 0,
      coolDown: 0,
      hold: 0,
      flooded: false,
      grade: "none",
      wrongTimer: 0,
      wrong: false,
      parked: false,
    };
  }

  /**
   * Fill the grid. Physics fills it too, at boot, from the model roster — so in
   * the normal case this adopts what is already there and only re-places it.
   * The spawn path exists for the case where physics booted with no roster and
   * an empty field, which is a broken game but not a crashed one.
   */
  function buildField(): void {
    const phys = physics();
    entries.length = 0;
    byId.clear();
    order.length = 0;
    if (!phys) return;

    if (phys.racers.length === 0) {
      const roster = (ctx.services.models as { roster?: Array<{ id: string; name: string }> } | undefined)?.roster ?? [];
      const field = Math.max(1, TUNING.fieldSize);
      const playerSlot = Math.min(field - 1, 3);
      for (let i = 0; i < field; i++) {
        const preset = roster[i % Math.max(1, roster.length)];
        try {
          phys.spawn({
            id: i,
            name: preset?.name ?? (i === playerSlot ? "You" : `Racer ${i + 1}`),
            characterId: preset?.id ?? "",
            isPlayer: i === playerSlot,
            slot: i,
          });
        } catch (err) {
          console.error("[Vibe Kart/race] could not fill the grid:", err);
          break;
        }
      }
    }

    for (let i = 0; i < phys.racers.length; i++) {
      const e = makeEntry(phys.racers[i], i);
      entries.push(e);
      byId.set(e.id, e);
    }
  }

  /** Put every racer back on their grid slot and clear a race's worth of state. */
  function resetField(): void {
    const phys = physics();
    for (const e of entries) {
      const r = e.racer;
      // `spawn` on an existing id is the physics system's documented restart
      // path: same object identity, pose reset, timers cleared.
      try {
        phys?.spawn({ id: r.id, name: r.name, characterId: r.characterId, isPlayer: r.isPlayer, slot: e.slot });
      } catch {
        /* a racer that will not re-place still gets its race state cleared */
      }

      e.t = arcOf(e, true);
      // The grid sits behind the line, in the last segment: the checkpoint owed
      // is therefore the line itself, and crossing it starts lap 1 rather than
      // completing one.
      e.nextCp = ((track()?.checkpointOf(e.t) ?? 0) + 1) % checkpointCount();
      e.chain = 0;
      e.sinceLap = 0;
      e.progress = 0;
      e.lap = 0;
      e.lapStart = 0;
      e.lapTimes.length = 0;
      e.bestLap = 0;
      e.done = false;
      e.place = e.slot + 1;
      e.finishTime = 0;
      e.coolDown = 0;
      e.hold = 0;
      e.flooded = false;
      e.grade = "none";
      e.wrongTimer = 0;
      e.wrong = false;

      // Race bookkeeping on the shared racer is ours to clear. The inventory is
      // cleared too — nobody should line up on the grid holding a blue shell —
      // while the item system's own live projectiles are its business, and it
      // is told about the restart on the bus.
      r.progress = 0;
      r.lap = 0;
      r.checkpoint = track()?.checkpointOf(e.t) ?? 0;
      r.place = e.place;
      r.finished = false;
      r.finishTime = 0;
      r.lapTimes.length = 0;
      r.coins = 0;
      r.item = null;
      r.itemCount = 0;
      r.rolling = false;
    }
    applyMode();
    sortField();
  }

  // -------------------------------------------------------------------------
  // Arc position and checkpoints
  // -------------------------------------------------------------------------

  /**
   * Where a racer is around the lap. Physics already projects every kart onto
   * the centreline once per step and publishes the result as `t`; re-projecting
   * here would be the same search run twice. The hinted fallback only exists
   * for a physics build that does not publish it.
   */
  function arcOf(e: Entry, force = false): number {
    const r = e.racer as RacerState & RacerExtras;
    if (typeof r.t === "number" && Number.isFinite(r.t)) return wrap01(r.t);
    const phys = physics();
    if (phys?.arcOf) {
      const t = phys.arcOf(e.id);
      if (Number.isFinite(t)) return wrap01(t);
    }
    const trk = track();
    if (!trk) return force ? 0 : e.t;
    const projected = trk.project(r.position, e.hint);
    e.hint = projected.t;
    return wrap01(projected.t);
  }

  /**
   * Credit checkpoints and, on the way past the line, laps.
   *
   * The rule is deliberately narrow: a checkpoint counts only when it is the
   * one the racer owes, and a lap counts only when the whole chain has been
   * walked since the last one. So the dirt shortcut is legal (it rejoins the
   * ribbon in order), reversing over the line is not, and a respawn that drops
   * a kart back down the road simply leaves it owing the same checkpoint it
   * owed before.
   */
  function stepCheckpoints(e: Entry): void {
    const trk = track();
    const n = checkpointCount();
    const cp = trk ? trk.checkpointOf(e.t) : Math.min(n - 1, Math.floor(e.t * n));

    if (cp === e.nextCp) {
      if (e.nextCp === 0 && e.sinceLap >= n) creditLap(e);
      e.chain++;
      e.sinceLap++;
      e.nextCp = (e.nextCp + 1) % n;
      e.racer.checkpoint = cp;
    }

    // Fraction of the way from the last checkpoint to the one owed. Negative
    // while a racer is reversing back through the segment they came from, which
    // is exactly what should happen to their position on the board.
    const remaining = wrap01(e.nextCp / n - e.t);
    const sub = clamp(1 - remaining * n, -1, 1);
    e.progress = (e.chain + sub) / n;
    e.racer.progress = e.progress;
  }

  function creditLap(e: Entry): void {
    if (e.done) return;
    const lapTime = Math.max(0, time - e.lapStart);
    e.lapStart = time;
    e.lap++;
    e.sinceLap = 0;
    e.lapTimes.push(lapTime);
    e.racer.lapTimes.push(lapTime);
    e.racer.lap = e.lap;
    if (lapTime > 1 && (e.bestLap === 0 || lapTime < e.bestLap)) e.bestLap = lapTime;

    ctx.emit("race:lap", { racer: e.id, lap: e.lap, lapTime, best: e.bestLap, isPlayer: e.racer.isPlayer });

    if (e.lap >= service.totalLaps) {
      finish(e, true);
      return;
    }

    // Final lap. The fanfare is the player's, but the event fires for everyone
    // so a rival's HUD marker can flash too.
    if (e.lap === service.totalLaps - 1) {
      ctx.emit("race:finalLap", { racer: e.id, lap: e.lap, isPlayer: e.racer.isPlayer });
      if (e.racer.isPlayer && !finalLapAnnounced) {
        finalLapAnnounced = true;
        service.finalLap = true;
        audio()?.music("finalLap");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Standings
  // -------------------------------------------------------------------------

  function sortField(): void {
    // `order` is the field of this race: in a time trial the parked rivals are
    // not in it at all, so they cannot take a place on the board.
    order.length = 0;
    for (const e of entries) if (!e.parked) order.push(e);
    order.sort((a, b) => {
      // Anyone home is ahead of anyone still running, in the order they got here.
      if (a.done !== b.done) return a.done ? -1 : 1;
      if (a.done && b.done) return a.place - b.place;
      if (b.progress !== a.progress) return b.progress - a.progress;
      return a.id - b.id;
    });
    for (let i = 0; i < order.length; i++) {
      const e = order[i];
      if (!e.done) e.place = i + 1;
      e.racer.place = e.place;
    }
  }

  function standingOf(e: Entry): Standing {
    return {
      id: e.id,
      name: e.racer.name,
      place: e.place,
      finished: e.done,
      time: e.done ? e.finishTime : time,
      lap: e.lap,
      bestLap: e.bestLap,
    };
  }

  // -------------------------------------------------------------------------
  // Lights out
  // -------------------------------------------------------------------------

  function setPhase(next: RacePhase): void {
    if (phase === next) return;
    const previous = phase;
    phase = next;
    phaseTime = 0;
    service.phase = next;
    service.phaseTime = 0;
    ctx.emit("race:phase", { phase: next, previous });
  }

  /** Mirror of the mapping the scenery uses, so both paths light the same bulbs. */
  function lights(count: number): void {
    const rig = ctx.services.scenery as StartLights | undefined;
    if (!rig?.setStartLights) return;
    const map: Record<number, number> = { 3: 1, 2: 3, 1: 5, 0: 0 };
    try {
      rig.setStartLights(map[count] ?? 0);
    } catch {
      /* a broken gantry must not stop the race starting */
    }
  }

  function beginCountdown(): void {
    if (phase !== "grid") return;
    countdown = RACE.countdownFrom;
    lightsShown = RACE.countdownFrom + 1;
    setPhase("countdown");
    // The course music starts under the lights, not after them — the countdown
    // is part of the track, and silence on the grid reads as a bug.
    audio()?.music("race");
  }

  /**
   * Watch every throttle through the countdown.
   *
   * The player's is read straight off the input state. The rivals' is inferred
   * from engine rpm, which is the only throttle-shaped thing physics publishes;
   * their intent is then perturbed by a deterministic per-driver reaction error
   * so the grid does not launch as one machine. A field where all seven rivals
   * nail the rocket start is a worse race than one where five do, one bogs and
   * one is asleep.
   */
  function sampleThrottles(dt: number): void {
    const phys = physics();
    const aiDrivesPlayer = !!phys?.playerAi;
    for (const e of entries) {
      if (e.parked) continue;
      const human = e.racer.isPlayer && !aiDrivesPlayer;
      const on = human ? ctx.input.accel > RACE.revThreshold : e.racer.rpm > RACE.rpmThreshold;
      e.hold = on ? e.hold + dt : 0;
      if (!e.flooded && effectiveHold(e) >= RACE.startFlood) {
        // Flagged the instant it happens, not at the flag: the smoke pouring off
        // a flooded engine during the countdown is the feedback that teaches the
        // mechanic.
        e.flooded = true;
        e.grade = "flooded";
        ctx.emit("race:rocketStart", { racer: e.id, result: "flooded", stage: "countdown", isPlayer: e.racer.isPlayer });
      }
      if (human) {
        service.rocket.hold = e.hold;
        service.rocket.flooded = e.flooded;
      }
    }
  }

  function effectiveHold(e: Entry): number {
    if (e.racer.isPlayer && !physics()?.playerAi) return e.hold;
    if (e.hold <= 0) return 0;
    // Pay back the rpm damping, then add the driver's own reaction error: about
    // a fifth of a second either way, fixed per driver per race.
    const jitter = (hash01(e.id * 0x27d4eb2d + generation * 0x165667b1) - 0.42) * 0.5;
    return Math.max(0, e.hold - RACE.rpmLag + jitter);
  }

  function gradeStarts(): void {
    const phys = physics();
    for (const e of entries) {
      if (e.parked) {
        e.grade = "none";
        continue;
      }
      const held = effectiveHold(e);
      let grade: StartGrade;
      if (e.flooded || held >= RACE.startFlood) grade = "flooded";
      else if (held >= RACE.startLo && held <= RACE.startHi) grade = "perfect";
      else if (held >= RACE.startMin) grade = "good";
      else grade = "none";
      e.grade = grade;

      try {
        if (grade === "flooded") {
          // A "bump" is the one hit physics applies unconditionally, and its
          // only effect is to cut the throttle for a moment — which is exactly
          // what a flooded engine does. No spin, no lost boost, just a kart
          // sitting there while the field leaves.
          phys?.applyHit(e.id, "bump", RACE.startStall);
        } else if (grade === "perfect") {
          phys?.applyBoost(e.id, RACE.startBoost, "start");
        } else if (grade === "good") {
          phys?.applyBoost(e.id, RACE.startBoostWeak, "start");
        }
      } catch {
        /* a launch that cannot be applied is a slow launch, not a crash */
      }

      ctx.emit("race:rocketStart", { racer: e.id, result: grade, stage: "start", hold: held, isPlayer: e.racer.isPlayer });
      if (e.racer.isPlayer) service.rocket.grade = grade;
    }
  }

  function go(): void {
    countdown = 0;
    service.countdown = 0;
    lights(0);
    ctx.emit("race:countdown", { count: 0 });
    gradeStarts();
    time = 0;
    for (const e of entries) e.lapStart = 0;
    setPhase("racing");
    ctx.emit("race:start", { mode: service.mode, laps: service.totalLaps });
  }

  // -------------------------------------------------------------------------
  // The flag
  // -------------------------------------------------------------------------

  function finish(e: Entry, crossed: boolean): void {
    if (e.done) return;
    e.done = true;
    e.finishTime = time;
    e.place = ++finishCount;
    e.coolDown = RACE.coolDown;
    e.lap = service.totalLaps;
    e.racer.lap = e.lap;
    e.racer.finishTime = e.finishTime;
    e.racer.place = e.place;
    // Progress is pinned so a finisher cruising round the cool-down lap cannot
    // sort themselves back into the live field.
    e.progress = Math.max(e.progress, service.totalLaps);

    const phys = physics();
    if (e.racer.isPlayer && phys) {
      // Hand the wheel over: the player watches their kart cruise it in while
      // the results come up, which is the beat every kart game ends on.
      phys.playerAi = true;
    }

    ctx.emit("race:finish", {
      racer: e.id,
      place: e.place,
      total: entries.length,
      time: e.finishTime,
      bestLap: e.bestLap,
      crossed,
      isPlayer: e.racer.isPlayer,
    });

    if (e.racer.isPlayer) {
      closeTimer = RACE.closeGrace;
      setPhase("finished");
      if (service.mode === "timeTrial") recordRun(e);
    }
  }

  /** Everyone still out on the road when the clock runs out, in current order. */
  function finishStragglers(): void {
    const rest = order.filter((e) => !e.done);
    rest.sort((a, b) => b.progress - a.progress || a.id - b.id);
    for (const e of rest) finish(e, false);
  }

  function toResults(): void {
    if (phase === "results") return;
    // Only now does the throttle actually cut: `RacerState.finished` is what
    // the drive model reads to bring a kart to a stop.
    for (const e of order) {
      e.racer.finished = true;
      e.coolDown = 0;
    }
    sortField();
    results = service.standings();
    setPhase("results");
    audio()?.music("results");
    ctx.emit("race:results", { standings: results, mode: service.mode, course: track()?.name ?? "" });
  }

  // -------------------------------------------------------------------------
  // Time trial
  // -------------------------------------------------------------------------

  /**
   * One racer, three laps, a stopwatch. It costs almost nothing on top of the
   * grand prix: the rivals are parked on the grid with their controls pinned
   * shut and their rigs hidden, rather than torn down, so switching modes is a
   * restart and not a rebuild.
   */
  function applyMode(): void {
    const trial = service.mode === "timeTrial";
    for (const e of entries) {
      const park = trial && !e.racer.isPlayer;
      e.parked = park;
      const obj = e.racer.object;
      if (obj) obj.visible = !park;
    }
    service.record = records[courseKey] ?? null;
  }

  function recordRun(e: Entry): void {
    const total = e.finishTime;
    const best = e.bestLap;
    lastRun = { lap: best, total };
    service.lastRun = lastRun;

    const previous = records[courseKey];
    const improvedLap = best > 0 && (!previous || previous.bestLap <= 0 || best < previous.bestLap);
    const improvedTotal = total > 0 && (!previous || previous.bestTotal <= 0 || total < previous.bestTotal);
    if (improvedLap || improvedTotal) {
      records[courseKey] = {
        course: track()?.name ?? courseKey,
        characterId: e.racer.characterId,
        bestLap: improvedLap ? best : previous?.bestLap ?? best,
        bestTotal: improvedTotal ? total : previous?.bestTotal ?? total,
        laps: service.totalLaps,
        at: Date.now(),
      };
      saveRecords(records);
      service.record = records[courseKey];
    }
    ctx.emit("race:record", {
      lap: best,
      total,
      improvedLap,
      improvedTotal,
      record: service.record,
    });
  }

  // -------------------------------------------------------------------------
  // Wrong way
  // -------------------------------------------------------------------------

  function stepWrongWay(e: Entry, dt: number): void {
    const trk = track();
    const r = e.racer as RacerState & RacerExtras;
    let bad = false;
    if (trk && !r.respawning && e.racer.stun <= 0 && !e.done) {
      if (!frameScratch) frameScratch = trk.frameAt(0);
      const frame = trk.frameAt(e.t, frameScratch);
      const v = e.racer.velocity;
      const speed = v.length();
      if (speed > RACE.wrongSpeed) bad = v.dot(frame.forward) / speed < RACE.wrongDot;
    }
    e.wrongTimer = clamp(e.wrongTimer + (bad ? dt : -dt * RACE.wrongDecay), 0, 1.2);

    // Latched with hysteresis: a spin through a hairpin flicks the tangent test
    // for a moment and must not flash the warning.
    const next = e.wrong ? e.wrongTimer > RACE.wrongOff : e.wrongTimer >= RACE.wrongOn;
    if (next !== e.wrong) {
      e.wrong = next;
      ctx.emit("race:wrongWay", { racer: e.id, wrong: next, isPlayer: e.racer.isPlayer });
    }
  }

  // -------------------------------------------------------------------------
  // Pause
  // -------------------------------------------------------------------------

  function setPaused(next: boolean, announce: boolean): void {
    if (next === service.paused) return;
    service.paused = next;
    const snd = audio();
    if (next) {
      // The render loop keeps running — the pause menu is drawn over a live
      // frame — but the simulation and the music stop dead.
      if (snd && !snd.muted) {
        mutedByPause = true;
        snd.setMuted(true);
      }
      if (announce) ctx.emit("ui:pause");
    } else {
      if (snd && mutedByPause) snd.setMuted(false);
      mutedByPause = false;
      if (announce) ctx.emit("ui:resume");
    }
  }

  /** Physics is frozen by the pause menu and by every phase that is not a race. */
  function freezePhysics(): void {
    const phys = physics();
    if (!phys) return;
    phys.paused = service.paused || phase === "grid" || phase === "countdown";
  }

  const offPause = ctx.on("ui:pause", (() => setPaused(true, false)) as (p: never) => void);
  const offResume = ctx.on("ui:resume", (() => setPaused(false, false)) as (p: never) => void);

  // -------------------------------------------------------------------------
  // Restart
  // -------------------------------------------------------------------------

  function restart(): void {
    generation++;
    ctx.emit("race:restart", { mode: service.mode, generation });

    const phys = physics();
    if (phys) phys.playerAi = false;
    finishCount = 0;
    time = 0;
    countdown = 0;
    lightsShown = RACE.countdownFrom + 1;
    closeTimer = 0;
    resultsTimer = 0;
    finalLapAnnounced = false;
    results = null;
    lastRun = null;
    service.lastRun = null;
    service.finalLap = false;
    service.rocket.hold = 0;
    service.rocket.flooded = false;
    service.rocket.grade = "none";
    service.time = 0;
    service.countdown = 0;
    setPaused(false, false);

    if (entries.length === 0) buildField();
    resetField();
    lights(0);
    setPhase("grid");
    // A restart from the grid does not change phase, so the hold has to be
    // rewound by hand or the lights would start again instantly.
    phaseTime = 0;
    service.phaseTime = 0;
    freezePhysics();
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  {
    const trk = track();
    service.totalLaps = Math.max(1, trk?.laps ?? 3);
    courseKey = slug(trk?.name ?? "course");
    service.record = records[courseKey] ?? null;
    if (!trk) console.warn("[Vibe Kart/race] no track service; laps cannot be validated");
  }
  buildField();
  // Chalk the grid: every racer goes back on their slot through `physics.spawn`,
  // which is also the restart path, so the first race and the fourth start from
  // byte-identical state.
  resetField();
  // Held from the first fixed step: the grid does not roll away while the
  // loading bar is still on screen.
  freezePhysics();

  // -------------------------------------------------------------------------
  // The step
  // -------------------------------------------------------------------------

  function stepRacing(dt: number): void {
    time += dt;
    for (const e of entries) {
      if (e.parked) continue;
      e.t = arcOf(e);
      if (e.done) {
        // Home. Progress is pinned at the flag so a cool-down lap cannot sort a
        // finisher back into the live field, and the warning is never shown to
        // someone who has already won.
        if (e.coolDown > 0) {
          e.coolDown -= dt;
          if (e.coolDown <= 0) e.racer.finished = true;
        }
        continue;
      }
      stepCheckpoints(e);
      stepWrongWay(e, dt);
    }
    sortField();
  }

  function stepPhase(dt: number): void {
    phaseTime += dt;

    switch (phase) {
      case "grid": {
        if (service.autoStart && phaseTime >= RACE.gridHold) beginCountdown();
        break;
      }

      case "countdown": {
        countdown = Math.max(0, countdown - dt);
        sampleThrottles(dt);
        // 3 while the clock is in (2,3], 2 in (1,2], 1 in (0,1] — one beat each.
        const n = Math.max(0, Math.ceil(countdown - 1e-6));
        if (n < lightsShown && n > 0) {
          lightsShown = n;
          lights(n);
          ctx.emit("race:countdown", { count: n });
        }
        if (countdown <= 0) go();
        break;
      }

      case "racing": {
        stepRacing(dt);
        // Normally the phase turns on the player crossing the line. The other
        // two doors out are a field that has all finished without them (no
        // player at all, or an attract-mode grid) and a clock that has run out.
        if (order.length > 0 && order.every((e) => e.done)) {
          closeTimer = 0;
          setPhase("finished");
        } else if (time > RACE.hardTimeout) {
          finishStragglers();
          closeTimer = 0;
          setPhase("finished");
        }
        break;
      }

      case "finished": {
        stepRacing(dt);
        closeTimer -= dt;
        const allHome = order.every((e) => e.done);
        if (allHome || closeTimer <= 0) {
          if (!allHome) finishStragglers();
          resultsTimer += dt;
          if (resultsTimer >= RACE.resultsDelay) toResults();
        }
        break;
      }

      case "results":
        break;
    }
  }

  return {
    fixedUpdate(dt) {
      if (entries.length === 0) {
        // Physics may have filled the grid after this system booted (a hot
        // reload, or a slow roster). Adopt it the moment it appears.
        if (physics()?.racers.length) {
          buildField();
          resetField();
        }
      }

      if (!service.paused) stepPhase(dt);

      // Time trial: the rivals are parked. The race writes their controls after
      // the AI has written its own and before the next physics step, so the
      // last word is this one and they stay put. Their rigs are also re-hidden
      // here, because a model rig is built lazily and may not have existed when
      // the mode was set.
      if (service.mode === "timeTrial") {
        const phys = physics();
        for (const e of entries) {
          if (!e.parked) continue;
          phys?.setControls(e.id, ZERO_CONTROLS);
          const obj = e.racer.object;
          if (obj && obj.visible) obj.visible = false;
        }
      }

      freezePhysics();
      service.time = time;
      service.countdown = countdown;
      service.phaseTime = phaseTime;
    },

    update() {
      // The pause key belongs to the UI when there is one; without it, the race
      // is the only thing that can honour the button.
      const owned = !!ctx.services.ui;
      const pressed = ctx.input.pausePressed;
      if (!owned && pressed && !pauseLatch && (phase === "racing" || phase === "finished" || service.paused)) {
        setPaused(!service.paused, true);
      }
      pauseLatch = pressed;
    },

    dispose() {
      offPause();
      offResume();
      const phys = physics();
      if (phys) {
        phys.paused = false;
        phys.playerAi = false;
      }
      // Nothing here owns a geometry, a material or a texture: the race is
      // rules, and the only allocation to give back is the handle itself.
      for (const e of entries) {
        const obj = e.racer.object;
        if (obj) obj.visible = true;
      }
      entries.length = 0;
      order.length = 0;
      byId.clear();
      results = null;
      frameScratch = null;
      if (ctx.services.race === service) delete ctx.services.race;
    },
  };
}
