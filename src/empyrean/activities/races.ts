/**
 * RING RACES — four courses, laid out by hand against the plan.
 *
 * ## Why the gates are polar and why they are hand-placed
 *
 * The city is radial, so a course is written the way a pilot would describe
 * one: an angle, a radius and a height. Every gate below was chosen against
 * something real in `cityplan.ts` or in the keel's own profile, and
 * `src/test/empyreanActivities.test.ts` re-checks every one of them against
 * the lot polygons, the landmark cylinders and the rock envelope on every run.
 * A race line through a tower is the failure mode here and it is not one you
 * find by flying — you find it by flying *that one corner*, at speed, once.
 *
 * The three corridors a course may use, and nothing else:
 *
 *  - **The avenues**, 8 m of carriageway and 5.5 m of pavement either side of
 *    eight radial centrelines, clear from the Halo's apron out to the rim at
 *    every height. A 10 m gate on the centreline leaves four metres of wall
 *    each side, which is the whole point of the sprint.
 *  - **The Halo**, everything inside r = 56, empty but for the Beacon at the
 *    axis and the Cistern off to one side. It is the only place in the city
 *    you can turn a jetpack around at speed.
 *  - **Outside the island**, past r = 340 at deck height and outside the rock
 *    below it. `keelBlocked` is the arbiter there; see `common.ts` for why it
 *    is drawn so pessimistically.
 *
 * ## The four
 *
 * They are different *shapes*, not different lengths of the same shape. The
 * sprint is flat and fast and asks nothing but nerve. The climb is vertical
 * and asks you to hold the jets down for forty seconds in a shaft eighteen
 * metres wide. The slalom is a plan-view zigzag that never leaves the deck's
 * airspace and is all braking and turning. The circuit leaves the city
 * altogether, falls half a kilometre down the outside of the rock and comes
 * back up under it.
 */
import * as THREE from "three";
import type { FrameContext } from "../types";
import { ISLAND_Y } from "../config";
import { LANDMARKS } from "../cityplan";
import {
  buildGateField,
  buildPillar,
  buildRouteLine,
  clamp,
  DEG,
  formatTime,
  readStore,
  writeStore,
  type GateField,
  type Pillar,
  type RouteLine,
} from "./common";

/* -------------------------------------------------------------------------
 * The courses
 * ---------------------------------------------------------------------- */

/** One gate, in the island's polar frame: angle in degrees, radius, height. */
export interface Gate {
  a: number;
  r: number;
  y: number;
}

export interface Course {
  id: string;
  name: string;
  /** One line, said the way somebody at the start line would say it. */
  blurb: string;
  /** Where the "fly this" prompt stands. */
  startAt: { x: number; y: number; z: number };
  gates: Gate[];
  /** Gate radius, metres. Tight courses get small hoops. */
  radius: number;
  /** The time the payout is scaled around. */
  par: number;
  /** Coins at par. */
  base: number;
}

const g = (a: number, r: number, y: number): Gate => ({ a, r, y });

const launch = LANDMARKS.find((l) => l.id === "launch")!;
const observatory = LANDMARKS.find((l) => l.id === "observatory")!;
const tram = LANDMARKS.find((l) => l.id === "tram-halo")!;
const cistern = LANDMARKS.find((l) => l.id === "fountain")!;

export const COURSES: Course[] = [
  {
    id: "sprint",
    name: "The Avenue Sprint",
    blurb: "Down 45th, across the Halo, out the other side. Sixteen metres up, all of it.",
    startAt: { x: launch.x, y: ISLAND_Y + 1.2, z: launch.z },
    radius: 10,
    par: 32,
    base: 22,
    /* Straight down the avenue at 45°, which is the one the Launch Terrace
     * stands on, through the plaza past the Beacon, and out along 315°. Every
     * gate sits on a carriageway centreline or inside the Halo, sixteen to
     * twenty-two metres over the roadway — above the lamps and the tram wires
     * and below the third floor of everything either side. */
    gates: [
      g(45, 300, 638),
      g(45, 250, 636),
      g(45, 200, 636),
      g(45, 150, 636),
      g(45, 100, 638),
      g(20, 50, 642),
      g(-15, 50, 642),
      g(-45, 100, 638),
      g(-45, 160, 636),
      g(-45, 230, 636),
      g(-45, 300, 638),
    ],
  },
  {
    id: "climb",
    name: "The Beacon Climb",
    blurb: "Up the shaft, round the glass, out over the roofs. Do not stop holding the jets.",
    startAt: { x: cistern.x, y: ISLAND_Y + 1.2, z: cistern.z },
    radius: 9,
    par: 58,
    base: 30,
    /* A helix in the well between the Beacon's skin (26 m of clearance) and
     * the first ring of towers (which start at r = 66). That leaves a shaft
     * about eighteen metres wide, and the gates sit in the middle of it at
     * r = 48 until the towers are underneath — the tallest is 341 m, topping
     * out at y = 961 — after which the helix opens out and finishes wide and
     * high over the whole skyline. */
    gates: [
      g(90, 48, 654),
      g(10, 48, 700),
      g(-70, 48, 748),
      g(-150, 48, 796),
      g(-230, 48, 844),
      g(-310, 48, 892),
      g(-390, 48, 940),
      g(-470, 60, 992),
      g(-550, 90, 1040),
      g(-630, 120, 1088),
      g(-710, 130, 1136),
    ],
  },
  {
    id: "slalom",
    name: "The Spire Slalom",
    blurb: "In to the Beacon, out to the ring road, in again. Brakes are a control.",
    startAt: { x: tram.x, y: ISLAND_Y + 1.2, z: tram.z },
    radius: 8,
    par: 46,
    base: 28,
    /* Two petals. Each one runs an avenue inward from the ring road at r = 138
     * to the Halo, curls round the Beacon inside the plaza, and runs the next
     * avenue back out. The hop between petals is along the ring road itself,
     * which is the only tangential corridor in the core that is clear at every
     * height. Nothing here is more than forty metres over the pavement — it is
     * the one course you fly *inside* the city rather than above it. */
    gates: [
      g(180, 138, 646),
      g(180, 98, 646),
      g(168, 58, 650),
      g(147, 46, 652),
      g(135, 98, 646),
      g(135, 138, 648),
      g(112, 140, 650),
      g(90, 138, 648),
      g(90, 98, 646),
      g(78, 58, 650),
      g(57, 46, 652),
      g(45, 98, 646),
      g(45, 138, 648),
    ],
  },
  {
    id: "circuit",
    name: "The Long Way Under",
    blurb: "Off the Observatory, down the outside, once around under the keel, and back up.",
    startAt: { x: observatory.x, y: ISLAND_Y + 1.2, z: observatory.z },
    radius: 12,
    par: 115,
    base: 48,
    /* One full turn of the island, and the only course that leaves it.
     *
     * The descent stays outside the rock, which is 400 m wide where it meets
     * the lowest terrace and narrows to nothing at the tip — so the first
     * three gates are further out than they look, and the fourth is where the
     * rock has pulled in enough to come close. Below y = 440 the stalactites
     * start, and they can reach out to r = 336 at any depth, so the whole
     * plunge from 440 m down to 110 m runs in the clear annulus outside them:
     * you fall past the fringe with the teeth beside you and the ice coming
     * up, and then climb the far side. */
    gates: [
      g(270, 360, 630),
      g(242, 460, 565),
      g(214, 520, 500),
      g(187, 460, 450),
      g(159, 380, 440),
      g(131, 372, 380),
      g(104, 372, 300),
      g(76, 374, 200),
      g(49, 378, 110),
      g(21, 386, 170),
      g(-6, 392, 280),
      g(-34, 400, 390),
      g(-62, 430, 470),
      g(-90, 470, 560),
      g(-90, 345, 646),
    ],
  },
];

export function courseById(id: string): Course | undefined {
  return COURSES.find((c) => c.id === id);
}

/** World-space centres of a course's gates. Pure; the test uses it too. */
export function gatePoints(course: Course): THREE.Vector3[] {
  return course.gates.map((gate) =>
    new THREE.Vector3(
      Math.cos(gate.a * DEG) * gate.r,
      gate.y,
      Math.sin(gate.a * DEG) * gate.r,
    ),
  );
}

/**
 * Which way each gate faces.
 *
 * The chord through the gate before and the gate after, which is the direction
 * you are actually travelling as you pass through it. The first and last take
 * the one chord they have. Getting this wrong does not break the pass test —
 * that is a plane crossing and works either way round — but it makes the hoops
 * face the wrong way, and a gate you cannot see the front of is a gate you
 * miss.
 */
export function gateNormals(points: THREE.Vector3[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const n = new THREE.Vector3().subVectors(next, prev);
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
    out.push(n.normalize());
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Records
 * ---------------------------------------------------------------------- */

export const RACE_KEY = "empyrean.races.v1";

export interface RaceRecord {
  /** Best total, seconds. */
  best: number;
  /** Elapsed at each gate on the best run — the ghost you are chasing. */
  splits: number[];
  runs: number;
}

type RaceBook = Record<string, RaceRecord>;

export function readRaces(): RaceBook {
  return readStore<RaceBook>(RACE_KEY, {});
}

/**
 * The payout.
 *
 * Scaled by how far inside par you finished and floored well above zero: this
 * is a beautiful place and nobody should be punished for taking the scenic
 * line through it. A first finish and a new personal best each pay a little
 * extra, because the second-best moment in a racing game is beating yourself.
 */
export function racePayout(course: Course, time: number, first: boolean, pb: boolean): number {
  const ratio = clamp(course.par / Math.max(time, 1), 0.55, 1.6);
  let coins = Math.round(course.base * ratio);
  if (first) coins += 10;
  if (pb) coins += 12;
  return coins;
}

/* -------------------------------------------------------------------------
 * The runner
 * ---------------------------------------------------------------------- */

export interface RaceHooks {
  toast(text: string, tone?: "info" | "good" | "warn"): void;
  pay(coins: number): void;
  /** Fired when the race ends for any reason, so the shell can clear itself. */
  ended(): void;
  chime(freq: number, dur?: number, gain?: number): void;
}

type Phase = "idle" | "countdown" | "running" | "done";

export interface RaceRunner {
  group: THREE.Object3D;
  start(courseId: string, time: number): boolean;
  abort(reason: "recall" | "player"): void;
  running(): boolean;
  current(): Course | null;
  update(ctx: FrameContext): void;
  view(): { title: string; lines: string[]; progress?: number } | null;
  dispose(): void;
}

const COUNTDOWN = 3.2;

export function buildRaces(hooks: RaceHooks): RaceRunner {
  const group = new THREE.Group();
  group.name = "empyrean-races";
  group.visible = false;

  const maxGates = COURSES.reduce((m, c) => Math.max(m, c.gates.length), 0);
  const gates: GateField = buildGateField(maxGates);
  const pillar: Pillar = buildPillar();
  const route: RouteLine = buildRouteLine(maxGates + 2);
  group.add(gates.group, pillar.object, route.object);

  /* Everything below is preallocated. `update` runs sixty times a second in a
   * world with a dozen other systems in it and must not make garbage. */
  const points: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const prevPos = new THREE.Vector3();
  const toGate = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const step = new THREE.Vector3();
  const lines: string[] = ["", "", ""];

  let course: Course | null = null;
  let phase: Phase = "idle";
  let startedAt = 0;
  let elapsed = 0;
  let index = 0;
  let splits: number[] = [];
  let book: RaceBook = readRaces();
  let lastSide = 0;
  let havePrev = false;
  /** The frame clock, remembered so `view()` can read it without a context. */
  let now = 0;

  function clearVisuals(): void {
    gates.layout(EMPTY_POINTS, EMPTY_POINTS, 1);
    pillar.hide();
    route.hide();
    group.visible = false;
  }

  function aimAtCurrent(): void {
    if (!course) return;
    for (let i = 0; i < points.length; i++) gates.setState(i, i < index ? 2 : i === index ? 1 : 0);
    if (index < points.length) {
      const p = points[index];
      pillar.set(p.x, p.y, p.z, 0xffd28a);
      route.set(points, index, prevPos);
    } else {
      pillar.hide();
      route.hide();
    }
  }

  function finish(): void {
    if (!course) return;
    const rec = book[course.id];
    const first = !rec;
    const pb = !rec || elapsed < rec.best;
    const coins = racePayout(course, elapsed, first, pb);
    hooks.pay(coins);
    hooks.toast(
      `${course.name} · ${formatTime(elapsed)}${pb ? " · new best" : ""} · +${coins} ✦`,
      "good",
      5,
    );
    hooks.chime(880, 0.5, 0.05);
    book = { ...book, [course.id]: { best: pb ? elapsed : rec.best, splits: pb ? splits.slice() : rec.splits, runs: (rec?.runs ?? 0) + 1 } };
    writeStore(RACE_KEY, book);
    phase = "done";
    course = null;
    clearVisuals();
    hooks.ended();
  }

  return {
    group,

    start(courseId, time) {
      const next = courseById(courseId);
      if (!next) return false;
      course = next;
      phase = "countdown";
      startedAt = time;
      elapsed = 0;
      index = 0;
      splits = [];
      havePrev = false;
      lastSide = 0;

      points.length = 0;
      normals.length = 0;
      for (const p of gatePoints(next)) points.push(p);
      for (const n of gateNormals(points)) normals.push(n);
      gates.layout(points, normals, next.radius);
      group.visible = true;
      aimAtCurrent();
      hooks.toast(`${next.name} — ${next.blurb}`, "info", 5);
      return true;
    },

    abort(reason) {
      if (!course) return;
      const cleared = index;
      const name = course.name;
      // No fail state: you are paid for what you flew and told what you did.
      const coins = Math.round(cleared * 2);
      if (coins > 0) hooks.pay(coins);
      hooks.toast(
        reason === "recall"
          ? `${name} called off — ${cleared} gate${cleared === 1 ? "" : "s"}${coins ? ` · +${coins} ✦` : ""}`
          : `${name} left for another day${coins ? ` · +${coins} ✦` : ""}`,
        "info",
      );
      course = null;
      phase = "idle";
      clearVisuals();
      hooks.ended();
    },

    running() {
      return phase === "countdown" || phase === "running";
    },

    current() {
      return course;
    },

    update(ctx) {
      now = ctx.time;
      gates.update(ctx.time);
      pillar.update(ctx.time);
      if (!course) return;

      const p = ctx.player.position;

      if (phase === "countdown") {
        const left = COUNTDOWN - (ctx.time - startedAt);
        if (left <= 0) {
          phase = "running";
          startedAt = ctx.time;
          hooks.toast("Go", "good", 1.4);
          hooks.chime(660, 0.35, 0.05);
        }
        prevPos.copy(p);
        havePrev = true;
        return;
      }

      elapsed = ctx.time - startedAt;
      route.setHead(p.x, p.y, p.z);

      if (index >= points.length) return;
      const target = points[index];
      const normal = normals[index];

      if (!havePrev) {
        prevPos.copy(p);
        havePrev = true;
        lastSide = 0;
        return;
      }

      /* A gate is passed when the segment the player moved along this frame
       * crosses the gate's plane inside the hoop — which is the same test at
       * 3 m/s and at 34, and does not care about the frame rate. The second
       * clause is for anybody who drifts up to a gate and stops: touching it
       * counts. Generous on purpose. */
      toGate.subVectors(p, target);
      const side = toGate.dot(normal);
      step.subVectors(p, prevPos);
      const moved = step.length();
      let hit = false;

      if (lastSide !== 0 && Math.sign(side) !== Math.sign(lastSide) && moved > 1e-4) {
        // Where the segment met the plane, and how far that is off centre.
        const t = clamp(lastSide / (lastSide - side), 0, 1);
        cross.copy(prevPos).addScaledVector(step, t).sub(target);
        const along = cross.dot(normal);
        cross.addScaledVector(normal, -along);
        if (cross.length() <= course.radius * 1.05) hit = true;
      }
      if (!hit && toGate.length() < course.radius * 0.55) hit = true;

      prevPos.copy(p);
      lastSide = side;

      if (!hit) return;

      splits.push(elapsed);
      const rec = book[course.id];
      const ghost = rec?.splits?.[index];
      const delta = ghost !== undefined ? elapsed - ghost : null;
      index++;
      lastSide = 0;
      hooks.chime(520 + index * 26, 0.22, 0.04);

      if (index >= points.length) {
        finish();
        return;
      }
      hooks.toast(
        `Gate ${index} of ${points.length} · ${formatTime(elapsed)}` +
          (delta === null ? "" : ` · ${delta <= 0 ? "−" : "+"}${Math.abs(delta).toFixed(1)}s`),
        delta !== null && delta <= 0 ? "good" : "info",
        2.4,
      );
      aimAtCurrent();
    },

    view() {
      if (!course) return null;
      const rec = book[course.id];
      if (phase === "countdown") {
        const left = Math.max(0, COUNTDOWN - (now - startedAt));
        lines[0] = left > 0.1 ? `Starting in ${left.toFixed(1)}` : "Go";
        lines[1] = `${course.gates.length} gates · par ${formatTime(course.par)}`;
        lines[2] = rec ? `Your best ${formatTime(rec.best)}` : "No time set";
        return { title: course.name, lines, progress: 1 - left / COUNTDOWN };
      }
      lines[0] = formatTime(elapsed);
      lines[1] = `Gate ${Math.min(index + 1, points.length)} of ${points.length}`;
      const ghost = rec?.splits?.[index];
      lines[2] =
        ghost !== undefined
          ? `Ghost ${formatTime(ghost)} · ${elapsed <= ghost ? "ahead" : "behind"}`
          : rec
            ? `Your best ${formatTime(rec.best)}`
            : `Par ${formatTime(course.par)}`;
      return { title: course.name, lines, progress: index / points.length };
    },

    dispose() {
      gates.dispose();
      pillar.dispose();
      route.dispose();
      group.clear();
    },
  };
}

const EMPTY_POINTS: THREE.Vector3[] = [];
