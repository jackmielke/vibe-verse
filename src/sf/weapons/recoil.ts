/**
 * weapons/recoil.ts — the feel layer.
 *
 * Recoil in a modern shooter is three separate things that amateur
 * implementations collapse into one, and the collapse is why they feel wrong:
 *
 *   1. **Aim punch.** The crosshair actually moves. Rounds go where the
 *      crosshair is, so this is the only part that affects accuracy. It
 *      follows an *authored pattern* (see registry.ts) and it *recovers* — the
 *      view returns to the pre-fire aim point, which is the contract every
 *      player has had trained into them since Modern Warfare.
 *   2. **Visual kick.** The camera jolts, the world shakes, and none of it
 *      changes where the bullets go. This is a damped spring, it is allowed to
 *      be violent, and it is what makes a shotgun feel like a shotgun.
 *   3. **Viewmodel motion.** The gun itself rocks back, tips up and settles.
 *      Handled in viewmodelAnim.ts, driven by state we publish here.
 *
 * The subtle piece is **compensation eating**. If the player pulls down while
 * the weapon is climbing, a naive implementation adds their input to a punch
 * that is still going to be refunded, and the view ends up below where they
 * started — the classic "my gun overcorrects" complaint. So we watch the
 * player's own look delta between frames and let downward input *cancel* the
 * outstanding punch instead of stacking with it. Pull down exactly as much as
 * the gun kicked up and the view is rock steady, with nothing to refund.
 *
 * Public API
 * ----------
 *   recoilSystem            the singleton
 *   .onShot(def, ctx)       fire one round's worth of recoil
 *   .update(dt, def, ctx)   integrate; writes frame.yaw/pitch/recoil/viewKick
 *   .applyToCamera(cam)     additive visual kick, after the controller has set
 *                           the camera from yaw/pitch
 *   .bloom / .breath / .sway…   read by the HUD and the viewmodel
 */
import type * as THREE from "three";
import { frame } from "../state/store";
import { WORLD_SEED } from "../config";
import { clamp, clamp01, damp, makeRng, type Rng } from "../math/rng";
import { recoilStep, spreadDegrees } from "./registry";
import type { ShotContext, WeaponDef } from "./types";

const DEG = Math.PI / 180;
const MAX_PITCH = 1.5533; // 89°

const _step = { v: 0, h: 0 };

export class RecoilSystem {
  /** Deterministic — the harness must reproduce a firefight frame for frame. */
  private rng: Rng = makeRng(`${WORLD_SEED}:recoil`);

  /* ---- aim punch, degrees ---- */
  private punchV = 0;
  private punchH = 0;
  private targetV = 0;
  private targetH = 0;
  /** Punch already pushed into frame.yaw/pitch. */
  private appliedV = 0;
  private appliedH = 0;

  /* ---- player look tracking, for compensation eating and weapon lag ---- */
  private prevYaw = 0;
  private prevPitch = 0;
  /** Player-authored look delta this frame, radians. Read by the viewmodel. */
  lookDeltaYaw = 0;
  lookDeltaPitch = 0;

  /* ---- visual kick, radians ---- */
  private kPitch = 0;
  private kYaw = 0;
  private kRoll = 0;
  private kvPitch = 0;
  private kvYaw = 0;
  private kvRoll = 0;

  /* ---- dispersion bloom, degrees ---- */
  bloom = 0;
  /** Cone half-angle the last `update` computed, degrees — the HUD reads this. */
  cone = 0;

  /* ---- sway (viewmodel space) ---- */
  swayX = 0;
  swayY = 0;
  swayRoll = 0;

  /* ---- breath ---- */
  /** 1 = full lungs. */
  breath = 1;
  holdingBreath = false;
  /** Scope wobble in radians, applied to aim while scoped. */
  private breathYaw = 0;
  private breathPitch = 0;
  private appliedBreathYaw = 0;
  private appliedBreathPitch = 0;

  /** Shot index within the current burst — the pattern cursor. */
  shotIndex = 0;
  private lastShotTime = -100;

  /** Viewmodel push-back, metres, published for the animator. */
  punchBack = 0;
  private punchBackVel = 0;

  reset(): void {
    this.punchV = this.punchH = 0;
    this.targetV = this.targetH = 0;
    this.appliedV = this.appliedH = 0;
    this.kPitch = this.kYaw = this.kRoll = 0;
    this.kvPitch = this.kvYaw = this.kvRoll = 0;
    this.bloom = 0;
    this.shotIndex = 0;
    this.punchBack = 0;
    this.punchBackVel = 0;
    this.breath = 1;
    this.appliedBreathYaw = this.appliedBreathPitch = 0;
    frame.recoil.set(0, 0);
    frame.viewKick.set(0, 0);
  }

  /** Called on weapon switch: the pattern restarts, the punch does not vanish. */
  resetPattern(): void {
    this.shotIndex = 0;
    this.bloom = 0;
  }

  /**
   * One round's recoil.
   *
   * `ctx.ads` and the crouch flag scale the whole thing; the authored pattern
   * keeps its shape either way, because a weapon that recoils differently in a
   * different stance is a weapon nobody can learn.
   */
  onShot(def: WeaponDef, ctx: ShotContext): void {
    recoilStep(def, this.shotIndex, this.rng, _step);
    const r = def.recoil;
    let scale = 1;
    scale *= 1 + (r.adsScale - 1) * clamp01(ctx.ads);
    if (ctx.crouched && !ctx.airborne) scale *= r.crouchScale;
    if (ctx.airborne) scale *= 1.45;
    if (ctx.moving) scale *= 1.08;

    this.targetV += _step.v * scale;
    this.targetH += _step.h * scale;

    // Visual kick: an impulse into the spring's velocity, not its position —
    // that is what gives the snap-then-settle rather than a lerp.
    const [kp, ky, kr] = r.viewKick;
    const sign = this.rng.next() < 0.5 ? -1 : 1;
    this.kvPitch += kp * DEG * r.viewKickFreq * scale * (0.85 + this.rng.next() * 0.3);
    this.kvYaw += ky * DEG * r.viewKickFreq * scale * sign * (0.6 + this.rng.next() * 0.8);
    this.kvRoll += kr * DEG * r.viewKickFreq * scale * sign * (0.7 + this.rng.next() * 0.6);

    this.punchBackVel += r.punchBack * 34 * scale;

    this.bloom = Math.min(def.spread.max, this.bloom + def.spread.perShot);
    this.shotIndex++;
    this.lastShotTime = frame.time;
  }

  /** Trigger released / weapon idle long enough — walk the pattern back. */
  private decayPattern(dt: number, def: WeaponDef): void {
    const idle = frame.time - this.lastShotTime;
    if (idle > 0.28) {
      // The cursor rewinds rather than snapping to zero, so tap-firing an AR
      // never resets you to the easy first-shot recoil for free.
      const rewind = Math.max(1, def.rpm / 60) * (idle - 0.28) * 1.4;
      this.shotIndex = Math.max(0, this.shotIndex - rewind * dt * 8);
    }
  }

  /**
   * Integrate one frame.
   *
   * Order matters: read the player's delta *before* writing our own, or the
   * compensation detector sees its own output and the aim locks up.
   */
  update(dt: number, def: WeaponDef, ctx: ShotContext, canFire: boolean): void {
    if (dt <= 0) return;

    /* ---- 1. what did the player do since our last write? ---- */
    let dYaw = frame.yaw - this.prevYaw;
    let dPitch = frame.pitch - this.prevPitch;
    // Wrap: crossing ±π must not read as a 6-radian flick.
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.lookDeltaYaw = dYaw;
    this.lookDeltaPitch = dPitch;

    /* ---- 2. compensation eating ---- */
    // Pulling down (negative pitch delta) against an outstanding upward punch
    // cancels it instead of stacking with the eventual recovery.
    if (this.punchV > 0 && dPitch < 0) {
      const eat = Math.min(this.punchV, -dPitch / DEG);
      this.punchV -= eat;
      this.targetV = Math.max(0, this.targetV - eat);
      this.appliedV -= eat;
    }
    if (Math.abs(this.punchH) > 0.001) {
      // Horizontal: the same idea, but signed — countering left drift with a
      // rightward flick eats the left punch.
      const punchYawRad = -this.punchH * DEG;
      if (Math.sign(dYaw) === -Math.sign(punchYawRad) && Math.abs(dYaw) > 1e-5) {
        const eat = Math.min(Math.abs(this.punchH), Math.abs(dYaw) / DEG);
        const s = Math.sign(this.punchH);
        this.punchH -= s * eat;
        this.targetH -= s * Math.min(Math.abs(this.targetH), eat) * Math.sign(this.targetH || s);
        this.appliedH -= s * eat;
      }
    }

    /* ---- 3. recovery ---- */
    const r = def.recoil;
    const idle = frame.time - this.lastShotTime;
    if (idle > r.recoveryDelay) {
      this.targetV = damp(this.targetV, 0, r.recoveryRate, dt);
      this.targetH = damp(this.targetH, 0, r.recoveryRate * 0.85, dt);
    }

    /* ---- 4. spring the punch toward the target ---- */
    const riseV = this.targetV > this.punchV ? r.riseRate : r.recoveryRate;
    const riseH = Math.abs(this.targetH) > Math.abs(this.punchH) ? r.riseRate : r.recoveryRate;
    this.punchV = damp(this.punchV, this.targetV, riseV, dt);
    this.punchH = damp(this.punchH, this.targetH, riseH, dt);

    /* ---- 5. breath / scope wobble ---- */
    this.updateBreath(dt, def, ctx);

    /* ---- 6. push the delta into the actual aim ---- */
    const dv = this.punchV - this.appliedV;
    const dh = this.punchH - this.appliedH;
    frame.pitch = clamp(frame.pitch + dv * DEG, -MAX_PITCH, MAX_PITCH);
    // +yaw turns left in this coordinate frame, so positive horizontal recoil
    // (which means "to the right") subtracts.
    frame.yaw -= dh * DEG;
    this.appliedV = this.punchV;
    this.appliedH = this.punchH;

    const bYaw = this.breathYaw - this.appliedBreathYaw;
    const bPitch = this.breathPitch - this.appliedBreathPitch;
    if (bYaw !== 0 || bPitch !== 0) {
      frame.yaw += bYaw;
      frame.pitch = clamp(frame.pitch + bPitch, -MAX_PITCH, MAX_PITCH);
      this.appliedBreathYaw = this.breathYaw;
      this.appliedBreathPitch = this.breathPitch;
    }

    this.prevYaw = frame.yaw;
    this.prevPitch = frame.pitch;

    /* ---- 7. visual kick spring ---- */
    this.springKick(dt, r.viewKickFreq, r.viewKickDamp);

    /* ---- 8. viewmodel push-back ---- */
    this.punchBackVel += (-this.punchBack * 900 - this.punchBackVel * 34) * dt;
    this.punchBack += this.punchBackVel * dt;

    /* ---- 9. bloom + sway ---- */
    this.bloom = Math.max(0, this.bloom - def.spread.recover * dt);
    this.decayPattern(dt, def);
    this.cone = canFire ? spreadDegrees(def, ctx, this.bloom) : this.cone;
    this.updateSway(dt, ctx);

    /* ---- 10. publish ---- */
    frame.recoil.set(-this.punchH * DEG, this.punchV * DEG);
    frame.viewKick.set(this.kYaw, this.kPitch);
  }

  private springKick(dt: number, freq: number, zeta: number): void {
    const w = freq;
    const k = w * w;
    const c = 2 * zeta * w;
    // Semi-implicit Euler: stable at these stiffnesses and one line each.
    this.kvPitch += (-k * this.kPitch - c * this.kvPitch) * dt;
    this.kvYaw += (-k * this.kYaw - c * this.kvYaw) * dt;
    this.kvRoll += (-k * this.kRoll - c * this.kvRoll) * dt;
    this.kPitch += this.kvPitch * dt;
    this.kYaw += this.kvYaw * dt;
    this.kRoll += this.kvRoll * dt;
  }

  /**
   * Weapon sway.
   *
   * Three incommensurate sines rather than noise: noise reads as jitter, and a
   * hand holding a rifle does not jitter, it drifts. Amplitude falls with ADS
   * (you are braced) and rises with movement.
   */
  private updateSway(dt: number, ctx: ShotContext): void {
    const t = frame.time;
    const moveAmp = clamp01(frame.speed / 8) * 0.6;
    const amp = (1 - clamp01(ctx.ads) * 0.82) * (0.35 + moveAmp);
    const targetX =
      (Math.sin(t * 0.9) * 0.6 + Math.sin(t * 1.7 + 1.3) * 0.3 + Math.sin(t * 3.1) * 0.1) * amp;
    const targetY =
      (Math.sin(t * 1.1 + 0.7) * 0.5 + Math.sin(t * 2.3) * 0.28 + Math.sin(t * 4.7 + 2) * 0.09) * amp;
    this.swayX = damp(this.swayX, targetX, 6, dt);
    this.swayY = damp(this.swayY, targetY, 6, dt);
    this.swayRoll = damp(this.swayRoll, targetX * 0.4, 5, dt);
  }

  /**
   * Breath, for scoped weapons.
   *
   * Two-frequency wobble (a slow chest rise and a fast pulse), held flat while
   * the player holds their breath, and punished with an exhale surge when the
   * meter empties. The wobble is applied to *aim*, not just the viewmodel —
   * a scope that wobbles visually but shoots dead centre is a lie.
   */
  private updateBreath(dt: number, def: WeaponDef, ctx: ShotContext): void {
    const scoped = def.sight.scoped && ctx.ads > 0.85;
    if (!scoped) {
      this.breath = clamp01(this.breath + dt / (def.sight.breathRecover ?? 6));
      this.holdingBreath = false;
      this.breathYaw = damp(this.breathYaw, 0, 8, dt);
      this.breathPitch = damp(this.breathPitch, 0, 8, dt);
      return;
    }
    const hold = this.holdingBreath && this.breath > 0;
    if (hold) {
      this.breath = clamp01(this.breath - dt / (def.sight.breathHold ?? 4));
    } else {
      this.breath = clamp01(this.breath + dt / (def.sight.breathRecover ?? 6));
    }
    const t = frame.time;
    // Steadiness: full while holding, worst just after the meter empties.
    const empty = this.breath <= 0.001 ? 1 : 0;
    const amp = (hold ? 0.06 : 1) * (1 + empty * 1.9) * 0.00085 * (1 / Math.max(1, def.sight.zoom * 0.22));
    this.breathYaw = Math.sin(t * 0.83) * amp + Math.sin(t * 2.7 + 1.1) * amp * 0.35;
    this.breathPitch =
      Math.sin(t * 0.62 + 0.4) * amp * 1.25 + Math.sin(t * 3.3) * amp * 0.28;
  }

  /** Player pressed the hold-breath key (typically shift while scoped). */
  setBreathHold(on: boolean): void {
    this.holdingBreath = on;
  }

  /**
   * Add the visual kick to the camera, after the player controller has set it
   * from yaw/pitch. This never feeds back into aim — that is the entire point
   * of keeping it out of `frame.yaw`.
   */
  applyToCamera(camera: THREE.Object3D): void {
    if (this.kPitch === 0 && this.kYaw === 0 && this.kRoll === 0) return;
    camera.rotateX(this.kPitch);
    camera.rotateY(this.kYaw);
    camera.rotateZ(this.kRoll);
  }

  /** Visual kick, for a HUD or a camera-shake mixer that wants to blend it. */
  get viewKickPitch(): number {
    return this.kPitch;
  }
  get viewKickYaw(): number {
    return this.kYaw;
  }
  get viewKickRoll(): number {
    return this.kRoll;
  }
}

export const recoilSystem = new RecoilSystem();
