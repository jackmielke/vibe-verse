/**
 * Otto.
 *
 * The autopilot is an inflatable man in the left seat, and he flies the
 * aeroplane through the same yoke and thrust levers you do — which is not a
 * joke about the film so much as the reason the mechanic works. Otto is not a
 * cheat button that freezes the simulation; he is a set of control loops with
 * gains, and the gains are scaled by how inflated he is. A soft Otto holds
 * altitude badly, wanders in heading, and eventually stops holding anything,
 * and every one of those failures is legible from the instruments because they
 * are the same instruments you were reading a moment ago.
 *
 * Cascaded loops throughout, outer loop commanding the inner one's target:
 *
 *     altitude → vertical speed → pitch attitude → elevator
 *     heading  → bank angle     → aileron
 *     airspeed → thrust levers
 *
 * That structure is not decoration either. A single-loop autopilot that drives
 * the elevator straight from altitude error is an undamped second-order system
 * with a 90-tonne aeroplane in the middle of it: it porpoises, forever, and no
 * amount of gain tuning fixes it because the problem is the missing inner
 * loop.
 */
import * as THREE from "three";
import { headingError, standardRates } from "./dynamics";
import type { ControlInput } from "./dynamics";
import { ILS, RUNWAY } from "./nav";
import type { IlsFix } from "./nav";
import type { AutopilotState, FlightState } from "../types";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function makeAutopilot(): AutopilotState {
  return {
    engaged: false,
    targetAltitude: 8800,
    targetHeading: Math.PI / 2,
    targetIas: 128,
    approachMode: false,
    inflation: 1,
  };
}

/** Gains. Named, because a bare number in a control law is unmaintainable. */
const GAIN = {
  /** Altitude error (m) → commanded vertical speed (m/s). */
  altToVs: 0.055,
  vsLimit: 11,
  pitchLimit: 0.24,
  pitchDown: -0.16,
  /** Pitch attitude error → elevator, and the rate term that damps it. */
  pitchP: 4.2,
  pitchD: 3.4,

  /** Heading error (rad) → commanded bank (rad). */
  hdgToBank: 1.7,
  bankLimit: 0.44,
  bankP: 1.7,
  bankD: 1.0,

  /** Sideslip → rudder. Otto keeps the ball centred; he is very tidy. */
  slipToRudder: 2.6,

  /** Specific energy rate error (m/s) → thrust lever. */
  energyP: 0.045,
  /** Integral on speed alone, which is what trims out a steady thrust bias. */
  iasI: 0.010,
  /** Seconds allowed to correct a speed error. Longer is gentler. */
  speedTau: 6,

  /**
   * Localizer: lateral offset (m) and closure rate (m/s) → heading correction.
   *
   * `locD` is small on purpose. The heading loop underneath already has ten
   * seconds of lag in it — roll in, turn, roll out — and a rate term large
   * enough to look well damped on paper turns that lag into a phase margin
   * problem: the aeroplane arrives at the correction the situation needed
   * fifteen seconds ago and swings straight through the centreline. The first
   * version of this used 0.075 and S-turned the entire approach.
   */
  locP: 0.0011,
  locD: 0.012,
  /**
   * And an integral, because tonight there is a crosswind.
   *
   * A proportional-only tracker cannot sit on a line in a crosswind: holding
   * the crab angle *requires* a non-zero output, and the only way a P term
   * produces one is to keep a standing offset. With the wind on runway 09 that
   * offset works out at about sixty metres, which is most of a runway width
   * and exactly what the first version put the wheels down at.
   */
  locI: 0.00006,
  /**
   * …and a hard cap on how much of the correction the integral may own.
   *
   * Six degrees is a generous crab for a fifteen-knot crosswind and nothing
   * else has any business coming out of an integrator. Without this cap the
   * term can reach twenty degrees, which is not a wind correction — it is
   * classic integral windup, and it S-turns the last two kilometres by a
   * hundred metres either side while it unwinds.
   */
  locILimit: 0.105,
  locLimit: 0.42,
  /** Glideslope: height error (m) → vertical-speed correction (m/s). */
  gsP: 0.10,
  /**
   * And an integral, for the same reason the localizer needs one.
   *
   * Proportional-only tracking of a *moving* target settles at a standing
   * error, and here the target is descending — so a small persistent gap
   * between the commanded and achieved sink rate (turbulence, thrust lag, the
   * flaps still running out) parks the aeroplane twenty metres under the beam.
   * Twenty metres under a 3° slope is three hundred and eighty metres of
   * runway, and the wheels touch in the grass short of the threshold.
   */
  gsI: 0.0012,
  gsILimit: 1.5,
} as const;

const _fwd = new THREE.Vector3();

export class Autopilot {
  readonly state = makeAutopilot();
  private iasIntegral = 0;
  private locIntegral = 0;
  private gsIntegral = 0;
  private offsetRate = 0;
  /** How long Otto has been disconnected, so he does not chatter back on. */
  private wobblePhase = 0;

  /** True when Otto is soft enough that he has given up. */
  get failed(): boolean {
    return this.state.inflation < 0.35;
  }

  engage(flight: FlightState): void {
    if (this.failed) return;
    const s = this.state;
    s.engaged = true;
    // Otto takes the aeroplane where it already is, not where it was last time
    // he was on. An autopilot that snaps to a stale target the instant you
    // press the button is the single most alarming thing an autopilot can do.
    s.targetAltitude = Math.round(flight.altitude / 30.48) * 30.48;
    s.targetHeading = flight.heading;
    s.targetIas = Math.max(flight.ias, 70);
    this.iasIntegral = 0;
    this.locIntegral = 0;
    this.gsIntegral = 0;
  }

  disengage(): void {
    this.state.engaged = false;
  }

  /**
   * Fly for one step, writing into the same `ControlInput` the pilot uses.
   *
   * Returns false when Otto is not flying, so the caller knows to leave the
   * player's own inputs alone.
   */
  step(dt: number, flight: FlightState, ils: IlsFix, controls: ControlInput): boolean {
    const s = this.state;
    if (!s.engaged) return false;
    if (this.failed) {
      s.engaged = false;
      return false;
    }

    // A soft Otto is a sloppy Otto: gains fall off and a slow wander creeps in.
    // 1.0 at full inflation, about 0.3 by the time he is visibly sagging.
    const health = clamp((s.inflation - 0.3) / 0.7, 0, 1);
    const sloppy = 0.35 + 0.65 * health;
    this.wobblePhase += dt;
    const wander = (1 - health) * 0.12 * Math.sin(this.wobblePhase * 0.55);

    const { p: rollRate, q: pitchRate } = standardRates(flight.omega);

    // --- lateral ------------------------------------------------------------
    let targetHeading = s.targetHeading;
    if (s.approachMode && ils.valid) {
      // Chase the extended centreline, not the needle. The needle is angular
      // and its gain rises as you close in, which is exactly the wrong thing
      // to put inside a feedback loop — it turns a stable capture at ten miles
      // into an oscillation at one.
      //
      // The rate term is the aeroplane's own north–south velocity, not a
      // differentiated offset. They are the same quantity, but one of them is
      // exact and the other is a difference of two large numbers divided by
      // 1/120 s, which on the first frame alone reads several thousand metres
      // per second and then takes a second to filter out.
      const offset = ils.lateralOffset;
      this.offsetRate = flight.velocity.z;
      // Only wind the integral up once the beam is actually captured, or a
      // thirty-degree intercept from two kilometres out fills it before the
      // aeroplane has turned and then flies straight through the centreline.
      if (Math.abs(offset) < 400) {
        // Anti-windup: the integrator is clamped to exactly the range its own
        // output limit can use, and not one unit further. Letting it run to
        // ±6000 while only ±1750 of that ever reaches the output means the
        // term stops responding to the aeroplane entirely and instead spends
        // the next minute unwinding a number nobody can see — which shows up
        // as a ten-second S-turn all the way down the approach that no amount
        // of gain tuning touches, because the gains were never the problem.
        const windupLimit = GAIN.locILimit / GAIN.locI;
        this.locIntegral = clamp(this.locIntegral + offset * dt, -windupLimit, windupLimit);
      } else {
        this.locIntegral = 0;
      }
      const wind = clamp(this.locIntegral * GAIN.locI, -GAIN.locILimit, GAIN.locILimit);
      const correction = clamp(
        -(offset * GAIN.locP + this.offsetRate * GAIN.locD + wind),
        -GAIN.locLimit,
        GAIN.locLimit,
      );
      targetHeading = RUNWAY.heading + correction;
    } else {
      this.locIntegral = 0;
    }

    const hdgErr = headingError(targetHeading + wander, flight.heading);
    const targetBank = clamp(hdgErr * GAIN.hdgToBank, -GAIN.bankLimit, GAIN.bankLimit);
    controls.roll = clamp(
      ((targetBank - flight.bankAngle) * GAIN.bankP - rollRate * GAIN.bankD) * sloppy,
      -1,
      1,
    );
    // Keep the ball centred. Otto is very tidy about this.
    //
    // The sign is the one thing in this file that must not be guessed. Beta is
    // positive when the aeroplane is moving towards its right wing — the nose
    // is *left* of the relative wind — so zeroing it needs right rudder, which
    // is positive. Getting it backwards produces a loop that drives the nose
    // further from the wind, and since a swept wing rolls away from sideslip,
    // the aeroplane then rolls the opposite way to the aileron and wins. It
    // looks perfectly stable in level flight and departs the first time Otto
    // is asked to turn.
    controls.yaw = clamp(flight.beta * GAIN.slipToRudder * sloppy, -0.6, 0.6);

    // --- vertical -----------------------------------------------------------
    let targetVs: number;
    if (s.approachMode && ils.valid && ils.distance < 26000) {
      // Fly the geometric slope, corrected by how far off the beam we are.
      //
      // The descent rate for a 3° path comes from **ground speed**, not true
      // airspeed. It is a geometric relationship between how fast the aeroplane
      // is closing on the runway and how fast it must come down, and the air it
      // is flying through has nothing to do with it. Tonight's headwind on 09
      // is fifteen knots, so using TAS asks for about eighty feet a minute too
      // much — which is invisible for the first minute and puts the wheels four
      // hundred metres short of the threshold by the last one. This is exactly
      // why the descent-rate table in every approach plate is indexed by
      // groundspeed.
      const groundSpeed = Math.hypot(flight.velocity.x, flight.velocity.z);
      const nominal = -groundSpeed * Math.tan(ILS.glideslope);
      // Only integrate once the beam is captured; otherwise a two-hundred-metre
      // intercept from above fills the integrator and flies straight through.
      if (Math.abs(ils.heightError) < 120) {
        // Same anti-windup as the localizer, and it matters more here: a
        // saturated glideslope integrator commands two and a half metres a
        // second of extra descent on top of the nominal, which is thirteen
        // hundred feet a minute on a three-degree slope, and it arrives at the
        // flare with a rate of descent no flare can absorb.
        const windupLimit = GAIN.gsILimit / GAIN.gsI;
        this.gsIntegral = clamp(this.gsIntegral + ils.heightError * dt, -windupLimit, windupLimit);
      } else {
        this.gsIntegral = 0;
      }
      const gsCorrection =
        ils.heightError * GAIN.gsP +
        clamp(this.gsIntegral * GAIN.gsI, -GAIN.gsILimit, GAIN.gsILimit);
      targetVs = clamp(nominal - gsCorrection, -9, 4);
    } else {
      targetVs = clamp(
        (s.targetAltitude - flight.altitude) * GAIN.altToVs,
        -GAIN.vsLimit,
        GAIN.vsLimit,
      );
    }

    // Flight-path angle the aeroplane is actually holding, plus the angle of
    // attack, is the pitch attitude that would produce it. Commanding pitch
    // relative to *that* rather than to zero is what stops the loop needing a
    // steady-state error to hold a climb.
    // Pitch commands the *flight path*, and nothing else.
    //
    // Adding the current angle of attack to the wanted climb angle gives the
    // attitude that would fly it, and because θ = γ + α the whole expression
    // collapses to a flight-path-angle error — which is what makes this one
    // line rather than a table. What must *not* be added on top is a second
    // proportional term on vertical-speed error: it is the same quantity
    // measured twice, it doubles the loop gain, and the result is a
    // twenty-second phugoid in which the aeroplane trades two thousand feet a
    // minute against twenty knots all the way down the approach.
    const gamma = Math.asin(clamp(targetVs / Math.max(flight.tas, 30), -0.4, 0.4));
    const targetPitch = clamp(gamma + flight.alpha, GAIN.pitchDown, GAIN.pitchLimit);
    const pitchCmd =
      (targetPitch - flight.pitchAngle) * GAIN.pitchP - pitchRate * GAIN.pitchD;
    controls.pitch = clamp(pitchCmd * sloppy, -0.75, 0.75);


    // --- autothrottle, on total energy --------------------------------------
    //
    // The thrust levers answer one question: **does the aeroplane have enough
    // energy?** Not "is it fast enough" and not "is it sinking" — either of
    // those alone gets the phugoid exactly wrong, because in a phugoid the two
    // are ninety degrees out of phase. At the bottom of one the aeroplane is
    // sinking *and* fast; a sink-rate loop adds thrust, a speed loop takes it
    // away, and the version of this file that had both terms separately
    // rewarded whichever gain happened to be larger and oscillated for the
    // entire approach.
    //
    // Specific energy is h + V²/2g, so its rate is `vs + V·V̇/g`. Written as an
    // error against the target that is the line below — and it has the property
    // that matters: in a pure phugoid, where energy is conserved and speed and
    // height merely trade, the two terms cancel and the levers correctly do
    // nothing at all.
    const iasErr = s.targetIas - flight.ias;
    const vsErr = targetVs - flight.vs;
    const energyErr = vsErr + (flight.tas / 9.80665) * (iasErr / GAIN.speedTau);
    this.iasIntegral = clamp(this.iasIntegral + iasErr * dt, -80, 80);
    controls.throttle = clamp(
      0.40 +
        energyErr * GAIN.energyP +
        this.iasIntegral * GAIN.iasI +
        Math.max(0, gamma) * 1.6,
      0.06,
      1,
    );

    // And the boards, when the levers have run out of authority.
    //
    // A clean jet in a descent cannot slow down: at idle it is still gaining
    // energy from the height it is giving away, which is why the speedbrake
    // exists and why an approach flown without one arrives at the flap limit
    // doing two hundred and fifty knots. Otto uses it exactly when a crew
    // would — fast, levers already closed, still going down.
    const wantBoards = controls.throttle < 0.12 && iasErr < -5 && flight.vs < -1;
    const boards = wantBoards ? clamp(-iasErr / 14, 0, 1) : 0;
    controls.speedbrake += clamp(boards - controls.speedbrake, -dt * 0.7, dt * 0.7);

    return true;
  }

  /** Otto loses air over time once he has been holed. */
  deflate(amount: number): void {
    this.state.inflation = clamp(this.state.inflation - amount, 0, 1);
    if (this.failed) this.state.engaged = false;
  }

  inflate(amount: number): void {
    this.state.inflation = clamp(this.state.inflation + amount, 0, 1);
  }
}

/**
 * The heading you need to hold to track a course in a crosswind.
 *
 * Used by the tower when it tells you to fly a heading, so that the number it
 * gives you is the number that actually works. Nothing is more corrosive to
 * trust in a game than an instruction that is wrong.
 */
export function windCorrectedHeading(
  course: number,
  tas: number,
  wind: THREE.Vector3,
): number {
  if (tas < 1) return course;
  _fwd.set(Math.sin(course), 0, -Math.cos(course));
  // Crosswind component, positive from the right.
  const cross = wind.x * -_fwd.z + wind.z * _fwd.x;
  return course + Math.asin(clamp(-cross / tas, -0.5, 0.5));
}
