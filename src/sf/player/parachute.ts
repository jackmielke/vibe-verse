/**
 * parachute.ts — the canopy.
 *
 * The parachute is not a slower wingsuit. It is the *safety* verb: it exists
 * so that any fall can be survived, any rooftop can be landed on precisely,
 * and any botched flight has an out. So it is modelled as a velocity target
 * rather than as aerodynamics — under canopy you go forward at a known speed
 * and down at a known rate, and the only interesting dynamics are the opening
 * shock and the flare.
 *
 * Three details do all the work of making it feel real:
 *
 *  • **Opening shock.** Between deploy and full inflation the canopy hauls on
 *    you hard, and the harder you were falling the harder it hauls. That one
 *    spike is what makes deploying at terminal velocity feel like an event.
 *
 *  • **A flare has a budget.** Pulling both toggles converts forward speed
 *    into a momentary arrest — that is how you land on a roof instead of into
 *    it — but hold it and the canopy stalls and drops you. Free braking would
 *    make every landing identical.
 *
 *  • **Cutaway goes somewhere.** Cutting away with the wingsuit input drops
 *    you straight back into flight, so the traversal chain never has a dead
 *    end where you have to land and start again.
 *
 * Public API
 * ----------
 *   parachute                   the singleton
 *   .deploy() / .cutaway() / .canDeploy()
 *   .update(dt, steerX, steerZ, flare)
 *   .active .inflation .bankRoll .flare .stalled .sinkRate
 */
import { PARACHUTE, PLAYER } from "../config";
import { frame } from "../state/store";
import { WORLD } from "../geo/sfGeo";
import { clamp, clamp01, damp, smoothstep } from "../math/rng";

/** Seconds of full flare before the canopy stalls. */
const FLARE_BUDGET = 1.35;
/** How long a stalled canopy stays collapsed once you release. */
const STALL_RECOVERY = 1.1;
/** Vertical speed while stalled, m/s (negative is down). */
const STALL_SINK = -13;
/** Lowest AGL at which deploying still saves you. Below this it is decoration. */
const MIN_DEPLOY_AGL = 3;

class ParachuteSystem {
  active = false;
  /** 0..1 canopy inflation. The renderer reads this directly. */
  inflation = 0;
  /** Bank angle from steering, radians. */
  bankRoll = 0;
  /** 0..1 flare input actually being applied. */
  flare = 0;
  /** True when the canopy has been held in a flare past its budget. */
  stalled = false;
  /** Descent rate this frame, m/s (positive number). */
  sinkRate = 0;
  /** 0..1 opening-shock envelope; drives the camera dip and the audio hit. */
  shock = 0;

  private flareTime = 0;
  private stallTimer = 0;
  private deployT = 0;

  canDeploy(): boolean {
    if (this.active) return false;
    if (frame.grounded) return false;
    if (frame.position.y < WORLD.seaLevel + 0.5) return false;
    return frame.altitudeAGL > MIN_DEPLOY_AGL;
  }

  deploy(): boolean {
    if (!this.canDeploy()) return false;
    this.active = true;
    this.inflation = 0;
    this.deployT = 0;
    this.flareTime = 0;
    this.stalled = false;
    this.stallTimer = 0;
    // Opening shock scales with how fast you were falling. At terminal it is
    // violent; stepping off a kerb it is nothing.
    this.shock = clamp01(-frame.velocity.y / PLAYER.terminalVelocity);
    return true;
  }

  /** Cut away. The controller decides what state you land in. */
  cutaway(): void {
    this.active = false;
    this.inflation = 0;
    this.flare = 0;
    this.stalled = false;
    this.bankRoll = 0;
    this.shock = 0;
  }

  /**
   * One frame under canopy.
   *
   * `steerX` is -1..1 turn, `steerZ` is -1..1 fore/aft (pulling back trades
   * speed for a slower descent), `flare` is 0..1.
   */
  update(dt: number, steerX: number, steerZ: number, flareInput: number): void {
    if (!this.active) {
      this.inflation = damp(this.inflation, 0, 10, dt);
      this.shock = damp(this.shock, 0, 8, dt);
      return;
    }
    this.deployT += dt;

    /* ---- inflation + opening shock ---------------------------------- */
    const t = clamp01(this.deployT / PARACHUTE.deployTime);
    // Overshoot slightly then settle: real canopies snap open and breathe.
    this.inflation = smoothstep(0, 1, t) * (1 + 0.18 * Math.sin(t * Math.PI) * (1 - t));
    const opening = 1 - t;

    if (opening > 0) {
      // The shock is a strong drag applied only during inflation. Applying it
      // as a velocity multiplier keeps it stable at any frame rate.
      const k = 1 - Math.exp(-(5.5 + 16 * this.shock) * opening * dt);
      frame.velocity.x -= frame.velocity.x * k;
      frame.velocity.z -= frame.velocity.z * k;
      frame.velocity.y -= (frame.velocity.y + PARACHUTE.descentRate * -1) * k;
    }
    this.shock = damp(this.shock, 0, 3.5, dt);

    /* ---- flare ------------------------------------------------------- */
    const wantFlare = clamp01(flareInput + Math.max(0, -steerZ) * 0.75);
    if (this.stalled) {
      this.stallTimer -= dt;
      if (this.stallTimer <= 0 && wantFlare < 0.2) {
        this.stalled = false;
        this.flareTime = 0;
      }
      this.flare = damp(this.flare, 0, 6, dt);
    } else {
      this.flare = damp(this.flare, wantFlare, 9, dt);
      if (this.flare > 0.6) {
        this.flareTime += dt;
        if (this.flareTime > FLARE_BUDGET) {
          this.stalled = true;
          this.stallTimer = STALL_RECOVERY;
        }
      } else {
        this.flareTime = Math.max(0, this.flareTime - dt * 0.8);
      }
    }

    /* ---- steering ---------------------------------------------------- */
    const turn = clamp(steerX, -1, 1);
    // A canopy turns by pulling a riser, so it banks into the turn and loses a
    // little height doing it.
    this.bankRoll = damp(this.bankRoll, turn * 0.34, 4.5, dt);
    frame.yaw -= turn * PARACHUTE.turnRate * dt * (this.stalled ? 0.3 : 1) * this.inflation;

    /* ---- velocity target --------------------------------------------- */
    const infl = clamp01(this.inflation);
    const forwardSpeed =
      PARACHUTE.forwardSpeed *
      infl *
      (1 - this.flare * 0.82) *
      (this.stalled ? 0.25 : 1) *
      (1 + clamp(steerZ, 0, 1) * 0.28);

    let sink: number;
    if (this.stalled) {
      sink = STALL_SINK;
    } else {
      // The flare converts forward speed into a temporary arrest. Multiplying
      // the descent rate by flareStrength gives the brief float that lets you
      // put your feet down instead of your face.
      sink = -PARACHUTE.descentRate * (1 - this.flare * (1 - PARACHUTE.flareStrength));
      // Turning costs height, and a hard bank costs more.
      sink -= Math.abs(this.bankRoll) * 2.2;
    }
    sink *= infl;
    // Before the canopy is open you are still falling; blend in the target.
    if (infl < 1) sink += frame.velocity.y * (1 - infl) * 0.35;
    this.sinkRate = -sink;

    // Horizontal target follows the look direction, flattened.
    const fx = frame.forward.x;
    const fz = frame.forward.z;
    const fl = Math.hypot(fx, fz) || 1;
    const tx = (fx / fl) * forwardSpeed;
    const tz = (fz / fl) * forwardSpeed;

    // Chase the target rather than snapping: momentum under canopy is real,
    // and it is what makes a fast approach still overshoot the rooftop.
    const chase = 1 - Math.exp(-3.6 * infl * dt);
    frame.velocity.x += (tx - frame.velocity.x) * chase;
    frame.velocity.z += (tz - frame.velocity.z) * chase;
    const vchase = 1 - Math.exp(-(this.stalled ? 3.0 : 6.5) * dt);
    frame.velocity.y += (sink - frame.velocity.y) * vchase;
  }
}

/** The one parachute. */
export const parachute = new ParachuteSystem();
export type { ParachuteSystem };
