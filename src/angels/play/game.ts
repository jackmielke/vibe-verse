/**
 * The game on top of the flight.
 *
 * Three modes, and they are three different answers to "what is a flight sim
 * for":
 *
 *  - **Free flight.** Seattle, a jet, no clock. Most of the value of this
 *    world is here and the other two modes exist to teach you what to do with
 *    it.
 *  - **Ring rush.** A course, a clock, and a par time. Structure for people
 *    who want to be told where to go.
 *  - **The demo.** The thing this world is actually about: a called sequence
 *    of Blue Angels manoeuvres, scored on whether you flew them. The detector
 *    below is watching your accumulated roll, your accumulated pitch, your
 *    angle of attack and where you are relative to show centre, and it will
 *    know a Diamond Roll from a barrel roll.
 *
 * Underneath all three is the Easter-egg layer, which is a love letter to
 * Seattle disguised as an achievement list. Fly under the Aurora Bridge and
 * the Fremont Troll notices. Put the Needle in the middle of the windscreen
 * from Kerry Park and you get the postcard. The mountain is out.
 */
import * as THREE from "three";
import type { AngelsCtx, System, TerrainService } from "../types";
import type { FleetService } from "./fleet";
import type { CourseService } from "./courses";
import { KNOTS_PER_MPS, FEET_PER_METER } from "../flight/atmosphere";
import { SHOW_CENTRE, latToZ, lonToX } from "../world/geo";

export type GameMode = "free" | "course" | "demo";

export interface RadioMessage {
  from: string;
  text: string;
  /** Wall time it arrived, for the fade-out. */
  at: number;
  tone: "info" | "good" | "warn";
}

export interface Achievement {
  id: string;
  name: string;
  hint: string;
  earned: boolean;
}

export interface DemoElement {
  id: string;
  name: string;
  call: string;
  /** Seconds you get to fly it once it is called. */
  window: number;
}

export interface GameService {
  mode: GameMode;
  setMode(mode: GameMode): void;
  score: number;
  /** Course timing. */
  runTime: number;
  running: boolean;
  bestTimes: Record<string, number>;
  /** Demo state. */
  demoIndex: number;
  demoElement: DemoElement | null;
  demoRemaining: number;
  demoScores: Array<{ name: string; score: number }>;
  achievements: Achievement[];
  radio: RadioMessage[];
  say(from: string, text: string, tone?: RadioMessage["tone"]): void;
  /** Nearest named landmark, for the HUD's "you are here". */
  nearest: { name: string; distance: number } | null;
}

/** The demo, in the order the team flies it. */
const DEMO: DemoElement[] = [
  { id: "takeoff", name: "Run In", call: "Diamond, run in from the north — 300 knots, on the line.", window: 45 },
  { id: "lowpass", name: "Low Pass", call: "Show centre, low and fast. Under five hundred feet.", window: 40 },
  { id: "diamondroll", name: "Diamond Roll", call: "Roll... now. Smooth, all the way round.", window: 30 },
  { id: "loop", name: "Diamond Loop", call: "Coming up and over. Watch your speed at the top.", window: 40 },
  { id: "knifeedge", name: "Knife-Edge Pass", call: "Ninety degrees of bank down the show line.", window: 30 },
  { id: "highalpha", name: "High Alpha Pass", call: "Dirty her up. Gear down, nose up, walking pace.", window: 45 },
  { id: "vertical", name: "Vertical Roll", call: "Pull it vertical and roll all the way up.", window: 35 },
  { id: "sneak", name: "Sneak Pass", call: "In from behind the crowd. Give them everything.", window: 40 },
  { id: "break", name: "Delta Break", call: "Break! Smoke on, all six, straight up.", window: 30 },
];

const ACHIEVEMENTS: Array<{ id: string; name: string; hint: string }> = [
  { id: "troll", name: "The Troll Saw That", hint: "Fly under the Aurora Bridge." },
  { id: "cut", name: "Threading the Cut", hint: "Fly the Montlake Cut below 50 metres." },
  { id: "westseattle", name: "Duwamish Dive", hint: "Fly under the West Seattle Bridge." },
  { id: "i90", name: "Between the Pontoons", hint: "Fly under an I-90 floating bridge span." },
  { id: "boom", name: "Sound Barrier", hint: "Go supersonic. Not over the crowd, please." },
  { id: "cone", name: "Prandtl-Glauert", hint: "Pull a vapour cone." },
  { id: "kerry", name: "The Postcard", hint: "Line up the Space Needle over Kerry Park." },
  { id: "hawks", name: "Go Hawks", hint: "Low pass over Lumen Field." },
  { id: "dawgs", name: "Bow Down", hint: "Low pass over Husky Stadium." },
  { id: "pike", name: "Coffee Run", hint: "Low and slow over Pike Place Market." },
  { id: "mountain", name: "The Mountain Is Out", hint: "Climb above 6,000 metres." },
  { id: "roostertail", name: "Rooster Tail", hint: "Fly the hydro course below 20 metres." },
  { id: "eighteen", name: "Eighteen Inches", hint: "Hold the Diamond inside 8 metres for five seconds." },
  { id: "albert", name: "Bert's Turn", hint: "Fly Fat Albert." },
  { id: "roster", name: "The Whole Hangar", hint: "Fly all seven aircraft." },
  { id: "greaser", name: "Greaser", hint: "Land on a runway under 2 m/s of sink." },
  { id: "locks", name: "Salmon Run", hint: "Cross the Ballard Locks below 40 metres." },
  { id: "night", name: "Night Show", hint: "Fly the show line after dark." },
  { id: "loop", name: "Round the Top", hint: "Complete a loop." },
  { id: "inverted", name: "Double Farvel", hint: "Hold inverted flight for eight seconds." },
];

const STORE_KEY = "angels.progress";

interface Progress {
  earned: string[];
  best: Record<string, number>;
  flown: string[];
}

function loadProgress(): Progress {
  const empty: Progress = { earned: [], best: {}, flown: [] };
  if (typeof localStorage === "undefined") return empty;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as Partial<Progress>) } : empty;
  } catch {
    return empty;
  }
}

function saveProgress(p: Progress): void {
  try {
    localStorage?.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* nothing here is worth crashing a flight over */
  }
}

export function createGame(ctx: AngelsCtx): System {
  const fleet = ctx.services.fleet as FleetService | undefined;
  const courses = ctx.services.courses as CourseService | undefined;
  const terrain = ctx.services.terrain as TerrainService | undefined;
  if (!fleet) return {};

  const progress = loadProgress();
  const achievements: Achievement[] = ACHIEVEMENTS.map((a) => ({
    ...a,
    earned: progress.earned.includes(a.id),
  }));

  const showCentre = new THREE.Vector3(lonToX(SHOW_CENTRE[1]), 0, latToZ(SHOW_CENTRE[0]));

  let mode: GameMode = "free";
  let score = 0;
  let runTime = 0;
  let running = false;
  let demoIndex = -1;
  let demoRemaining = 0;
  const demoScores: Array<{ name: string; score: number }> = [];
  const radio: RadioMessage[] = [];

  // Manoeuvre detection accumulators.
  let rollAccum = 0;
  let pitchAccum = 0;
  let invertedFor = 0;
  let knifeFor = 0;
  let tightFor = 0;
  let elementProgress = 0;
  let lastBank = 0;

  const service: GameService = {
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = next;
      score = 0;
      runTime = 0;
      running = false;
      demoIndex = -1;
      demoScores.length = 0;
      if (next === "demo") {
        fleet.setFormation("diamond");
        fleet.respawn("show");
        startElement(0);
      } else if (next === "free") {
        courses?.load(null);
      }
      ctx.emit("angels:mode", next);
    },
    get score() {
      return Math.round(score);
    },
    get runTime() {
      return runTime;
    },
    get running() {
      return running;
    },
    bestTimes: progress.best,
    get demoIndex() {
      return demoIndex;
    },
    get demoElement() {
      return demoIndex >= 0 && demoIndex < DEMO.length ? DEMO[demoIndex] : null;
    },
    get demoRemaining() {
      return demoRemaining;
    },
    demoScores,
    achievements,
    radio,
    say,
    nearest: null,
  };
  ctx.services.game = service;

  function say(from: string, text: string, tone: RadioMessage["tone"] = "info"): void {
    radio.unshift({ from, text, at: ctx.elapsed, tone });
    if (radio.length > 6) radio.pop();
    ctx.emit("angels:radio", radio[0]);
  }

  function award(id: string): void {
    const a = achievements.find((x) => x.id === id);
    if (!a || a.earned) return;
    a.earned = true;
    progress.earned.push(id);
    saveProgress(progress);
    score += 500;
    say("SEAFAIR", a.name, "good");
    ctx.emit("angels:achievement", a);
  }

  function startElement(i: number): void {
    demoIndex = i;
    elementProgress = 0;
    rollAccum = 0;
    pitchAccum = 0;
    knifeFor = 0;
    if (i >= DEMO.length) {
      const total = demoScores.reduce((s, d) => s + d.score, 0);
      say("BOSS", `Demo complete. ${Math.round(total)} points. Knock it off.`, "good");
      ctx.emit("angels:demo-complete", { total, elements: demoScores.slice() });
      demoIndex = -1;
      return;
    }
    demoRemaining = DEMO[i].window;
    say("BOSS", DEMO[i].call);
  }

  function finishElement(quality: number): void {
    const el = DEMO[demoIndex];
    if (!el) return;
    const pts = Math.round(quality * 1000);
    score += pts;
    demoScores.push({ name: el.name, score: pts });
    say(
      "SLOT",
      quality > 0.8 ? "That was clean, Boss." : quality > 0.45 ? "Good enough." : "We'll take it.",
      quality > 0.8 ? "good" : "info",
    );
    startElement(demoIndex + 1);
  }

  // Course events.
  const offHoop = ctx.on(
    "angels:hoop",
    (e: { index: number; total: number; accuracy: number; label?: string; last: boolean }) => {
      score += 100 + Math.round(e.accuracy * 150);
      if (e.label) say("NAV", e.label, "info");
      if (e.last) {
        running = false;
        const course = courses?.active;
        if (course) {
          const best = progress.best[course.id];
          if (!best || runTime < best) {
            progress.best[course.id] = runTime;
            saveProgress(progress);
            say("NAV", `New best: ${runTime.toFixed(1)}s`, "good");
          } else {
            say("NAV", `${runTime.toFixed(1)}s — best is ${best.toFixed(1)}s`, "info");
          }
          if (runTime <= course.par) score += 1000;
        }
        ctx.emit("angels:course-complete", { time: runTime, score: Math.round(score) });
      }
    },
  );

  const offCourse = ctx.on("angels:course", (id: string | null) => {
    runTime = 0;
    running = !!id;
    score = 0;
    if (id) mode = "course";
  });

  const offJet = ctx.on("angels:jet", (id: string) => {
    if (!progress.flown.includes(id)) {
      progress.flown.push(id);
      saveProgress(progress);
    }
    if (id === "albert") award("albert");
    if (progress.flown.length >= 7) award("roster");
  });

  const _tmp = new THREE.Vector3();
  let sinceLandmarkCheck = 0;

  return {
    update(dt, c) {
      const player = fleet.player;
      const s = player.state;
      const pos = s.position;

      if (running) runTime += dt;

      // Radio messages age out of the HUD after twelve seconds.
      while (radio.length && c.elapsed - radio[radio.length - 1].at > 12) radio.pop();

      // ---- manoeuvre accumulators ---------------------------------------
      // Roll is integrated from the body rate rather than differenced from the
      // bank angle, because bank wraps at ±180° and a roll does not.
      rollAccum += s.rollRate * dt;
      pitchAccum += s.pitchRate * dt;
      lastBank = s.bank;

      const upDot = Math.cos(s.bank) * Math.cos(s.pitchAttitude);
      if (upDot < -0.55) invertedFor += dt;
      else invertedFor = 0;
      if (Math.abs(s.bank) > 1.25 && Math.abs(s.bank) < 1.9) knifeFor += dt;
      else knifeFor = 0;

      if (fleet.nearestSeparation < 8 && fleet.wingmanCount >= 3) tightFor += dt;
      else tightFor = 0;

      // ---- Easter eggs ----------------------------------------------------
      const agl = s.radarAltitude;
      const kts = s.airspeed * KNOTS_PER_MPS;

      if (s.mach > 1.0) award("boom");
      if (s.mach > 0.88 && agl < 3000 && s.liftDemand > 0.3) award("cone");
      if (Math.abs(pitchAccum) > Math.PI * 2) {
        award("loop");
        pitchAccum = 0;
      }
      if (invertedFor > 8) award("inverted");
      if (tightFor > 5) award("eighteen");
      if (s.altitude > 6000) award("mountain");

      // Location-triggered ones. Checked five times a second — a jet does not
      // cross a bridge in less than 200 ms even at Mach 1.
      sinceLandmarkCheck += dt;
      if (sinceLandmarkCheck > 0.2) {
        sinceLandmarkCheck = 0;
        // Horizontal range only: whether you are *over* a bridge is a question
        // about the map, and the altitude half of each test is separate.
        const near = (lat: number, lon: number, radius: number) =>
          Math.hypot(pos.x - lonToX(lon), pos.z - latToZ(lat)) < radius;

        if (near(47.6475, -122.3475, 130) && pos.y < 44) award("troll");
        if (near(47.647, -122.3, 400) && agl < 50) award("cut");
        if (near(47.5713, -122.3505, 200) && pos.y < 38) award("westseattle");
        if (near(47.5899, -122.27, 900) && pos.y < 12) award("i90");
        if (near(47.6294, -122.36, 400) && agl < 400) {
          // The postcard only counts if the Needle is actually in front of you.
          _tmp.set(lonToX(-122.34936), 120, latToZ(47.62042)).sub(pos).normalize();
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(s.orientation);
          if (_tmp.dot(fwd) > 0.85) award("kerry");
        }
        if (near(47.5952, -122.3316, 260) && agl < 220) award("hawks");
        if (near(47.6503, -122.3016, 260) && agl < 220) award("dawgs");
        if (near(47.60944, -122.34167, 220) && agl < 180 && kts < 320) award("pike");
        if (near(47.568, -122.262, 1400) && agl < 20) award("roostertail");
        if (near(47.66556, -122.39722, 200) && agl < 40) award("locks");

        const envSvc = c.services.env as { timeOfDay: number } | undefined;
        const night = envSvc ? envSvc.timeOfDay > 0.5 || envSvc.timeOfDay < 0.03 : false;
        if (night && near(SHOW_CENTRE[0], SHOW_CENTRE[1], 2000) && agl < 600) award("night");

        // "You are here" for the HUD.
        const landmarks = c.services.landmarks as
          | Array<{ name: string; position: THREE.Vector3 }>
          | undefined;
        if (landmarks) {
          let best: { name: string; distance: number } | null = null;
          for (const lm of landmarks) {
            const d = lm.position.distanceTo(pos);
            if (!best || d < best.distance) best = { name: lm.name, distance: d };
          }
          service.nearest = best && best.distance < 4500 ? best : null;
        }
      }

      // ---- the demo -------------------------------------------------------
      if (mode === "demo" && demoIndex >= 0) {
        demoRemaining -= dt;
        const el = DEMO[demoIndex];
        const rangeToCentre = Math.hypot(pos.x - showCentre.x, pos.z - showCentre.z);
        const inBox = rangeToCentre < 2600;

        switch (el.id) {
          case "takeoff":
            if (inBox && kts > 240 && agl > 60) elementProgress += dt;
            if (elementProgress > 3) finishElement(Math.min(1, 0.6 + elementProgress * 0.12));
            break;
          case "lowpass":
            if (inBox && agl < 160 && kts > 240) elementProgress += dt;
            if (elementProgress > 2.5) finishElement(Math.min(1, 0.55 + (200 - agl) / 200));
            break;
          case "diamondroll":
            if (Math.abs(rollAccum) > Math.PI * 1.9) {
              // Rolling on a straight line is the whole point; a roll that
              // wanders off heading is a barrel roll and scores as one.
              finishElement(inBox ? Math.max(0.35, 1 - Math.abs(s.gamma) * 1.4) : 0.4);
            }
            break;
          case "loop":
            if (Math.abs(pitchAccum) > Math.PI * 1.85) finishElement(inBox ? 0.9 : 0.55);
            break;
          case "knifeedge":
            if (knifeFor > 2.5) finishElement(inBox ? Math.min(1, 0.5 + knifeFor * 0.15) : 0.45);
            break;
          case "highalpha":
            if (kts < 165 && s.alpha > 0.28 && agl > 60) elementProgress += dt;
            if (elementProgress > 3) finishElement(Math.min(1, 0.5 + (0.5 - Math.min(kts, 165) / 330)));
            break;
          case "vertical":
            if (s.pitchAttitude > 1.05 && Math.abs(s.rollRate) > 1.2) elementProgress += dt;
            if (elementProgress > 2.2) finishElement(Math.min(1, 0.5 + s.altitude / 8000));
            break;
          case "sneak":
            if (inBox && agl < 90 && kts > 420) elementProgress += dt;
            if (elementProgress > 1.6) finishElement(Math.min(1, kts / 620));
            break;
          case "break":
            if (player.smoke && s.pitchAttitude > 0.85) elementProgress += dt;
            if (elementProgress > 2) finishElement(0.95);
            break;
        }

        if (demoRemaining <= 0) {
          say("SLOT", "Missed that one, Boss. Next.", "warn");
          demoScores.push({ name: el.name, score: 0 });
          startElement(demoIndex + 1);
        }
      }

      // ---- a good landing ---------------------------------------------------
      if (s.onGround && s.gearPos > 0.9 && Math.abs(s.climb) < 2 && kts > 60) {
        const runways = c.services.runways as Array<{ start: THREE.Vector3; end: THREE.Vector3 }> | undefined;
        if (runways) {
          for (const rw of runways) {
            const d = distanceToSegment(pos, rw.start, rw.end);
            if (d < 40) {
              award("greaser");
              break;
            }
          }
        }
      }

      // Terrain is the one thing that can end a flight, so it gets a warning.
      if (terrain && agl < 120 && s.climb < -12 && !s.onGround) {
        if (Math.random() < dt * 2) say("BITCHIN' BETTY", "PULL UP. PULL UP.", "warn");
      }
    },

    dispose() {
      offHoop();
      offCourse();
      offJet();
      if (ctx.services.game === service) delete ctx.services.game;
    },
  };
}

const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();

function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  _ab.subVectors(b, a);
  _ap.subVectors(p, a);
  const t = THREE.MathUtils.clamp(_ap.dot(_ab) / Math.max(1e-6, _ab.lengthSq()), 0, 1);
  return _ap.sub(_ab.multiplyScalar(t)).length();
}

export { DEMO, ACHIEVEMENTS, FEET_PER_METER };
