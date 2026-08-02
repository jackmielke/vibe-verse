/**
 * The flight, as a game.
 *
 * Phases, the nerve meter, who has the controls, and what the tower says next.
 * Everything here is orchestration — the flying is in `flight/`, the writing is
 * in `script.ts`, the cabin is in `cabin.ts` — and the only real design in this
 * file is the answer to one question: **what makes this hard?**
 *
 * Not the flying. A 707 on autopilot flies itself, and a coupled ILS lands
 * itself, and if either of those were the challenge the correct move would be
 * to leave Otto switched on and go and read a book. What makes it hard is that
 * you are the only person on the aeroplane who can do any of it, and there are
 * a hundred and eighty-seven other people who all need something from you
 * *right now*, and every one of those needs costs the one resource this game
 * actually meters: attention.
 *
 * So the two systems that matter are:
 *
 * **Nerve.** It drains whenever the aeroplane is somewhere it should not be —
 * off the glideslope, near the stall, wings not level, too fast, too low — and
 * refills when you handle the cabin well or Rumack talks to you. At zero it
 * does not kill you. It takes the aeroplane away for six seconds while Striker
 * has a flashback, which at nine thousand feet is a joke and at four hundred
 * feet is the whole ending.
 *
 * **Otto.** He is the difficulty dial and he is on a timer. He starts flying,
 * he leaks, and somewhere over Illinois he goes flat — and from then on the
 * aeroplane goes where you put it and nowhere else.
 */
import * as THREE from "three";
import { FLIGHT } from "../flight/airframe";
import { HARD_LANDING_VS } from "../flight/dynamics";
import {
  APPROACH_ALTITUDE,
  APPROACH_SPEED,
  APPROACH_START,
  CRUISE_START,
  FIELD_ELEVATION,
  ILS,
  RUNWAY,
  onRunway,
} from "../flight/nav";
import {
  BREAKOUT,
  CHATTER,
  CONFIGURE,
  DESCENT,
  FIRST_CONTACT,
  FLASHBACKS,
  INTERCEPT,
  JOHNNY_LINES,
  KRAMER_ARRIVES,
  OPENING,
  OTTO_DEFLATING,
  OTTO_GONE,
  OTTO_ON,
  Radio,
  RUMACK_STEADY,
  SHORT_FINAL,
  TAKE_SEAT,
  TOUCHDOWN_GOOD,
  TOUCHDOWN_ROUGH,
  type Line,
} from "./script";
import type { CabinService } from "./cabin";
import type { AircraftService } from "./aircraft";
import { KT, toFeet, toKnots, type PlaneCtx, type System } from "../types";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);

export type Phase =
  | "menu"
  | "opening"
  | "seat"
  | "cruise"
  | "descent"
  | "approach"
  | "final"
  | "rollout"
  | "over";

export interface Result {
  landed: boolean;
  crashed: boolean;
  crashReason: string;
  /** Metres from the threshold where the wheels touched. */
  touchdownX: number;
  /** Metres from the centreline. */
  touchdownOffset: number;
  /** Feet per minute at touchdown, negative down. */
  touchdownFpm: number;
  stoppedOnRunway: boolean;
  soulsCalm: number;
  crisesHandled: number;
  crisesHandledWell: number;
  nerve: number;
  flashbacks: number;
  /** 0..100. */
  score: number;
  grade: string;
  notes: string[];
}

export interface GameService {
  phase: Phase;
  /** Bumped on any state change the UI needs to see. */
  revision: number;
  radio: Radio;
  /** 0..1. Striker's composure. */
  nerve: number;
  /** True while a flashback has the aeroplane. */
  inFlashback: boolean;
  flashbacks: number;
  elapsed: number;
  /** What the player is supposed to be doing, in six words. */
  objective: string;
  result: Result | null;
  begin(): void;
  /** Skip to the approach — for anyone who has flown the cruise once. */
  beginAtApproach(): void;
  restart(): void;
  paused: boolean;
  setPaused(v: boolean): void;
}

/** How fast nerve chases its target downwards, and how much more slowly back up. */
const NERVE_DRAIN = 0.30;
const NERVE_RECOVER = 0.085;

export function createGame(ctx: PlaneCtx): System {
  const radio = new Radio();
  let phase: Phase = "menu";
  let phaseTime = 0;
  let elapsed = 0;
  let nerve = 1;
  let flashbackTimer = 0;
  let flashbacks = 0;
  let nextCrisis = 22;
  let nextChatter = 14;
  let ottoLeak = 0;
  let steadyCooldown = 0;
  let johnnyFired = false;
  const said = new Set<string>();

  /** Everything that has to go back to its opening value between flights. */
  function resetRun(): void {
    nerve = 1;
    flashbacks = 0;
    flashbackTimer = 0;
    nextCrisis = 22;
    nextChatter = 14;
    ottoLeak = 0;
    steadyCooldown = 0;
    elapsed = 0;
    johnnyFired = false;
    said.clear();
    radio.clear();
    service.result = null;
    service.nerve = 1;
    service.flashbacks = 0;
    service.inFlashback = false;
    const cabin = ctx.services.crises as CabinService | undefined;
    if (cabin) {
      cabin.active = null;
      cabin.calm = 0.75;
      cabin.handled = 0;
      cabin.handledWell = 0;
      cabin.closed = false;
      cabin.revision++;
    }
  }

  const service: GameService = {
    phase,
    revision: 0,
    radio,
    nerve: 1,
    inFlashback: false,
    flashbacks: 0,
    elapsed: 0,
    objective: "",
    result: null,
    paused: false,
    begin() {
      resetRun();
      setPhase("opening");
      resetFlight(CRUISE_START, 138, 0, false);
    },
    beginAtApproach() {
      resetRun();
      setPhase("approach");
      resetFlight(APPROACH_START, APPROACH_SPEED, 2, false);
      const air = ctx.services.flight as AircraftService | undefined;
      if (air) {
        air.playerHasControls = true;
        // Otto is soft but still working. The first draft of this shortcut
        // handed the player a dead autopilot 22 km out at five thousand feet
        // and expected them to hand-fly an intercept they had never seen — a
        // shortcut that is harder than the thing it is a shortcut past.
        air.ap.state.inflation = 0.6;
        air.ap.disengage();
      }
      said.add("kramer");
      said.add("descent");
      radio.say(KRAMER_ARRIVES, { priority: true });
      radio.say(CONFIGURE);
    },
    restart() {
      resetRun();
      setPhase("menu");
    },
    setPaused(v: boolean) {
      service.paused = v;
      service.revision++;
    },
  };
  ctx.services.game = service;

  const bump = () => {
    service.revision++;
  };

  function setPhase(next: Phase): void {
    phase = next;
    service.phase = next;
    phaseTime = 0;

    // Hand Otto the clearance the tower just read out.
    //
    // This is the bit that was missing and that no amount of staring at the
    // phase machine revealed: the tower said "descend and maintain five
    // thousand", the objective line said "descend to 5,000", and nothing
    // anywhere actually changed the autopilot's target — so Otto held 12,000
    // feet, for ever, while the phase waited for an altitude it was never
    // going to see. An instruction the game gives you has to be an instruction
    // the game's own autopilot can follow.
    const air = ctx.services.flight as AircraftService | undefined;
    if (air?.ap.state.engaged) {
      if (next === "descent") {
        air.ap.state.targetAltitude = APPROACH_ALTITUDE;
        air.ap.state.targetIas = 108;
        air.ap.state.approachMode = true;
      } else if (next === "approach") {
        // Still 180 knots. Slowing to Vref at fifteen miles is what makes an
        // approach take four minutes longer than it should and puts the
        // aeroplane behind the drag curve for all of them.
        air.ap.state.approachMode = true;
        air.ap.state.targetIas = 93;
      } else if (next === "final") {
        // Vref plus three knots. The book number, not the +8 the first version
        // used — eight knots of extra speed is four hundred metres of float in
        // ground effect, and it arrives at the flare with energy the flare then
        // has to get rid of before the wheels can touch.
        air.ap.state.approachMode = true;
        air.ap.state.targetIas = air.vref() + 1.5;
      }
    }

    bump();
    ctx.emit("phase", { phase: next });
  }

  function resetFlight(
    position: THREE.Vector3,
    ias: number,
    flapIndex: number,
    gearDown: boolean,
  ): void {
    const air = ctx.services.flight as AircraftService | undefined;
    if (!air) return;
    air.model.state.fuel = 9000;
    air.model.state.engineOut = [false, false, false, false];
    air.model.state.damage = 0;
    air.ap.state.inflation = 1;
    air.place({ position: position.clone(), heading: RUNWAY.heading, ias, flapIndex, gearDown });
    air.playerHasControls = false;
    ctx.services.camera?.setMode("cockpit", { snap: true });
  }

  /** Say a block once and only once. */
  function once(key: string, lines: Line[], priority = false): void {
    if (said.has(key)) return;
    said.add(key);
    radio.say(lines, { priority });
  }

  // The cabin hands nerve back through an event, so neither system has to know
  // the other exists.
  const offCrisis = ctx.on("crisisResolved", (payload: never) => {
    const p = payload as { nerve: number; outcome: Line[] };
    nerve = clamp01(nerve + p.nerve);
    radio.say(p.outcome);
    bump();
  });

  const offLightning = ctx.on("lightning", (payload: never) => {
    const p = payload as { intensity: number };
    ctx.services.camera?.shake(p.intensity * 0.3);
  });

  return {
    update(dt, c) {
      radio.update(dt);
      if (c.input.actionPressed) radio.answer();

      const air = c.services.flight as AircraftService | undefined;
      const cabin = c.services.crises as CabinService | undefined;
      const sky = c.services.sky;
      if (!air || phase === "menu" || phase === "over") return;
      const s = air.state;

      phaseTime += dt;
      elapsed += dt;
      service.elapsed = elapsed;

      // ---------------------------------------------------------------------
      // Nerve
      // ---------------------------------------------------------------------
      // Stress is not one number somebody picked — it is the sum of the ways
      // the aeroplane is currently wrong, each weighted by how much a pilot
      // would actually care. Two hundred feet high at ten miles is nothing;
      // two hundred feet high at one mile is the approach.
      let stress = 0;
      if (s.stallMargin < 0.2) stress += (0.2 - s.stallMargin) * 5;
      if (s.overspeed) stress += 0.8;
      stress += clamp(Math.abs(s.bankAngle) - 0.35, 0, 1) * 1.5;
      stress += clamp(Math.abs(s.pitchAngle) - 0.25, 0, 1) * 2;
      stress += air.buffet * 0.22;
      if (air.ils.valid && phase === "final") {
        stress += clamp(Math.abs(air.ils.gsNeedle) - 0.4, 0, 1) * 1.2;
        stress += clamp(Math.abs(air.ils.locNeedle) - 0.4, 0, 1) * 1.2;
      }
      if (s.radarAltitude < 250 && s.vs < -6) stress += 1.5;
      if (cabin?.active && cabin.active.chosen < 0) stress += 0.35;

      // Nerve settles towards a level *set by* the current stress rather than
      // draining whenever stress is non-zero. That distinction is the whole
      // mechanic: in a thunderstorm on an ILS approach the stress is never
      // zero, so the first version — drain above a threshold, recover below it
      // — was a one-way ratchet that emptied the meter twelve times in a single
      // approach no matter how well the aeroplane was flown. Now moderate,
      // sustained stress holds you at two thirds and *only* genuinely bad
      // flying takes you to the floor.
      const target = clamp01(1 - stress * 0.75);
      const rate = target < nerve ? NERVE_DRAIN : NERVE_RECOVER;
      nerve = clamp01(nerve + (target - nerve) * rate * dt);
      service.nerve = nerve;

      steadyCooldown -= dt;
      if (nerve > 0.55 && steadyCooldown <= 0 && flashbacks > 0 && radio.idle) {
        steadyCooldown = 45;
        radio.say(RUMACK_STEADY);
      }

      // ---------------------------------------------------------------------
      // Flashbacks
      // ---------------------------------------------------------------------
      if (flashbackTimer > 0) {
        flashbackTimer -= dt;
        air.playerHasControls = false;
        service.inFlashback = true;
        if (flashbackTimer <= 0) {
          service.inFlashback = false;
          air.playerHasControls = phase !== "opening" && phase !== "seat";
          bump();
        }
      } else if (nerve <= 0.001 && phase !== "opening" && phase !== "seat") {
        // Not a death. Six seconds of an aeroplane nobody is flying, which at
        // altitude is a joke and on short final is the ending.
        flashbackTimer = 6;
        flashbacks++;
        service.flashbacks = flashbacks;
        nerve = 0.34;
        radio.say(FLASHBACKS[(flashbacks - 1) % FLASHBACKS.length], { priority: true });
        ctx.services.camera?.shake(0.5);
        c.emit("flashback", { count: flashbacks });
        bump();
      }

      // ---------------------------------------------------------------------
      // Otto's slow leak
      // ---------------------------------------------------------------------
      if (phase === "cruise" || phase === "descent") {
        ottoLeak += dt;
        if (ottoLeak > 55 && air.ap.state.inflation > 0.36) {
          air.ap.deflate(dt * 0.055);
          if (air.ap.state.inflation < 0.7) once("ottoLeak", OTTO_DEFLATING, true);
        }
        if (air.ap.state.inflation <= 0.36 && !said.has("ottoGone")) {
          once("ottoGone", OTTO_GONE, true);
          air.playerHasControls = true;
          bump();
        }
      }

      // ---------------------------------------------------------------------
      // Ambience: the cabin, and the tower being no help
      // ---------------------------------------------------------------------
      if (phase === "cruise" || phase === "descent" || phase === "approach") {
        nextCrisis -= dt;
        if (nextCrisis <= 0 && cabin && !cabin.active) {
          nextCrisis = 34 + ctx.rng.range(0, 22);
          cabin.raise();
        }
        nextChatter -= dt;
        if (nextChatter <= 0 && radio.idle) {
          nextChatter = 24 + ctx.rng.range(0, 22);
          radio.say(ctx.rng.pick(CHATTER));
        }
        if (!johnnyFired && elapsed > 95 && radio.idle) {
          johnnyFired = true;
          radio.say(JOHNNY_LINES);
        }
      }

      // The storm builds all the way down, which is both what a Chicago
      // thunderstorm does and the reason the last two minutes are the hardest.
      if (sky) {
        const target = phase === "cruise" ? 0.5 : phase === "descent" ? 0.72 : 0.92;
        sky.setStorm(sky.storm + clamp(target - sky.storm, -dt * 0.05, dt * 0.05));
      }

      // ---------------------------------------------------------------------
      // The phases
      // ---------------------------------------------------------------------
      switch (phase) {
        case "opening":
          service.objective = "";
          once("opening", OPENING);
          if (radio.idle && phaseTime > 2) setPhase("seat");
          break;

        case "seat":
          service.objective = "Take the seat";
          once("seat", TAKE_SEAT);
          once("otto", OTTO_ON);
          if (radio.idle) {
            air.ap.engage(s);
            air.ap.state.targetAltitude = s.altitude;
            air.playerHasControls = true;
            setPhase("cruise");
            radio.say(FIRST_CONTACT, { priority: true });
          }
          break;

        case "cruise":
          service.objective = air.ap.state.engaged
            ? "Otto has it — mind the cabin"
            : "Fly the aeroplane";
          if (phaseTime > 32) once("kramer", KRAMER_ARRIVES, true);
          if (phaseTime > 62 && said.has("kramer")) {
            once("descent", DESCENT, true);
            setPhase("descent");
          }
          break;

        case "descent": {
          const ft = toFeet(s.altitude);
          service.objective = `Descend to 5,000 · now ${Math.round(ft / 100) * 100} ft`;
          if (ft < 7000) {
            once("configure", CONFIGURE, true);
            setPhase("approach");
          }
          break;
        }

        case "approach": {
          const kt = toKnots(s.ias);
          service.objective =
            s.flapIndex < 3
              ? "Flaps 30 · slow to 160 kt"
              : !s.gear.down
                ? "Gear down"
                : "Intercept the localizer";
          if (air.ils.valid) once("intercept", INTERCEPT, true);
          if (air.ils.valid && air.ils.distance < 15000) {
            setPhase("final");
            radio.say(SHORT_FINAL, { priority: true });
          }
          if (phaseTime > 60 && kt > 200 && !said.has("slowDown")) {
            said.add("slowDown");
            radio.say(
              [
                {
                  who: "KRAMER",
                  text: "Two-oh-nine, you are far too fast. Levers back, flaps out.",
                  radio: true,
                },
              ],
              { priority: true },
            );
          }
          break;
        }

        case "final": {
          const agl = s.radarAltitude;
          service.objective =
            agl > 400
              ? "Fly the beam · gear down, flaps 40"
              : agl > 60
                ? "Runway in sight — fly the lights"
                : "Flare · close the throttles";
          if (agl < 340) once("breakout", BREAKOUT, true);
          if (s.landed || s.onGround || s.crashed) setPhase("rollout");
          break;
        }

        case "rollout": {
          service.objective = s.crashed ? "" : "Brakes";
          if (cabin) cabin.closed = true;
          if (!said.has("touchdown")) {
            said.add("touchdown");
            if (!s.crashed) {
              radio.say(
                s.touchdownVs > HARD_LANDING_VS && Math.abs(s.touchdownOffset) < 18
                  ? TOUCHDOWN_GOOD
                  : TOUCHDOWN_ROUGH,
                { priority: true },
              );
            }
          }
          const stopped = s.groundSpeed < 2.5 && s.onGround;
          if (stopped || s.crashed || phaseTime > 90) {
            service.result = score(air, cabin, nerve, flashbacks);
            setPhase("over");
            c.services.camera?.setMode(s.crashed ? "tower" : "chase");
            c.emit("finished", service.result);
          }
          break;
        }
      }

      bump();
    },

    dispose() {
      offCrisis();
      offLightning();
      delete ctx.services.game;
    },
  };
}

/**
 * The scoring.
 *
 * Weighted the way an airline would weight it, which is not the way a game
 * usually does: **where and how gently the wheels touched is most of it** and
 * everything else is a modifier. A pilot who arrives with a full nerve meter
 * and puts the aeroplane down at 900 feet a minute a hundred metres left of
 * the centreline has not had a good night.
 */
function score(
  air: AircraftService,
  cabin: CabinService | undefined,
  nerve: number,
  flashbacks: number,
): Result {
  const s = air.state;
  const notes: string[] = [];
  const fpm = (s.touchdownVs / 0.3048) * 60;
  const stoppedOnRunway = !s.crashed && onRunway(s.position) && s.groundSpeed < 3;

  let points = 0;

  if (s.crashed) {
    notes.push(`You ${s.crashReason}.`);
  } else if (s.landed) {
    // 300 m is the aiming point; the touchdown zone runs to 900 m and anything
    // past that is a long landing.
    const from = s.touchdownX;
    points += clamp01(1 - Math.abs(from - RUNWAY.aimPoint) / 700) * 32;
    if (from < 0) notes.push("You landed short of the threshold.");
    else if (from > 900) notes.push(`Long landing — ${Math.round(from)} m in.`);
    else notes.push(`Touchdown ${Math.round(from)} m in. In the zone.`);

    // −60 fpm is a greaser, −600 is firm, −1,000 is a maintenance write-up and
    // a very quiet walk back through the cabin.
    points += clamp01(1 - Math.abs(fpm) / 900) * 28;
    if (fpm > -120) notes.push("Barely felt it.");
    else if (fpm > -400) notes.push(`${Math.round(-fpm)} fpm. A normal landing.`);
    else notes.push(`${Math.round(-fpm)} fpm. They felt that in the back.`);

    points += clamp01(1 - Math.abs(s.touchdownOffset) / 25) * 14;
    if (Math.abs(s.touchdownOffset) > 20) notes.push("Well off the centreline.");

    if (s.podStrike) {
      points -= 18;
      notes.push("You dragged an outboard engine pod down the runway.");
    }

    if (stoppedOnRunway) {
      points += 8;
      notes.push("Stopped on the runway.");
    } else {
      notes.push("You did not stop on the paved surface.");
    }
  }

  const calm = cabin?.calm ?? 0.5;
  points += calm * 10;
  const handledWell = cabin?.handledWell ?? 0;
  const handled = cabin?.handled ?? 0;
  if (handled > 0) {
    points += (handledWell / handled) * 4;
    notes.push(`${handledWell} of ${handled} cabin situations handled well.`);
  }
  points += nerve * 4;
  points -= flashbacks * 5;
  if (flashbacks > 0) {
    notes.push(`${flashbacks} flashback${flashbacks > 1 ? "s" : ""}. Macho Grande.`);
  }
  if (s.damage > 0.2) notes.push("The airframe took damage on the way down.");

  const total = clamp(Math.round(points), 0, 100);
  const grade = s.crashed
    ? "LOST"
    : !s.landed
      ? "INCOMPLETE"
      : total >= 88
        ? "AIRLINE CAPTAIN"
        : total >= 72
          ? "GOOD LANDING"
          : total >= 55
            ? "SURVIVABLE"
            : total >= 35
              ? "ONE OF THE WORST LANDINGS IN THE HISTORY OF THIS AIRPORT"
              : "BUT SOME OF US LIKE IT THAT WAY";

  return {
    landed: s.landed && !s.crashed,
    crashed: s.crashed,
    crashReason: s.crashReason,
    touchdownX: s.touchdownX,
    touchdownOffset: s.touchdownOffset,
    touchdownFpm: fpm,
    stoppedOnRunway,
    soulsCalm: Math.round(calm * FLIGHT.souls),
    crisesHandled: handled,
    crisesHandledWell: handledWell,
    nerve,
    flashbacks,
    score: total,
    grade,
    notes,
  };
}

/** The numbers the checklist quotes, kept in one place. */
export const TARGETS = {
  approachSpeed: 128 * KT,
  decisionHeight: ILS.decisionHeight,
  fieldElevation: FIELD_ELEVATION,
  gearBy: 10000,
  flapsBy: 14000,
};
