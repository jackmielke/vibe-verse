/**
 * weapons/viewmodelAnim.ts — procedural first-person weapon animation.
 *
 * There are no authored animation clips in this game and there is not going to
 * be an animator, so every motion the gun makes is solved. That constraint is
 * not as limiting as it sounds: a first-person weapon is a single rigid object
 * with four moving parts (slide, bolt, magazine, shell), and what sells it is
 * *timing and secondary motion*, not skinning.
 *
 * What is solved here:
 *   - **Idle sway and weapon lag.** The gun trails the camera when you turn
 *     and overshoots back. This one effect does more for "the weapon has mass"
 *     than any amount of geometry detail.
 *   - **Movement bob**, on a proper two-phase cycle (the gun figure-eights, it
 *     does not bounce), with a landing dip driven by vertical velocity.
 *   - **Sprint carry**: the weapon rotates out of the aiming line and down, and
 *     — critically — you cannot fire until it comes back, which is what
 *     `sprintOutTime` in the handling profile is for.
 *   - **Two-stage reloads** with real key times: magazine out, magazine in,
 *     bolt release. Ammo is credited at `magInAt`, not at the end, so a reload
 *     cancelled after the mag seats still counts.
 *   - **Shell-at-a-time loading** for the shotgun, as a loop with its own
 *     shoulder-in/shoulder-out wrapper, interruptible at any shell.
 *   - **ADS with correct sight alignment**: the weapon translates so its
 *     authored sight point lands on the camera axis, rather than being nudged
 *     toward some hand-tuned position that only looks right for one gun.
 *
 * Every state transition emits an event; the audio system listens to those
 * rather than to a timer of its own, so sound and motion cannot drift apart.
 *
 * Public API
 * ----------
 *   ViewmodelPose, VmClip, VmEvent
 *   viewmodelAnimator      the singleton
 *   .play(clip, def)  .cancel()  .update(dt, def, ctx)  .onEvent(cb)
 */
import { clamp01, damp, smoothstep } from "../math/rng";
import { frame } from "../state/store";
import { recoilSystem } from "./recoil";
import type { WeaponDef } from "./types";

export type VmClip =
  | "idle"
  | "draw"
  | "holster"
  | "reloadTactical"
  | "reloadEmpty"
  | "shellStart"
  | "shellLoad"
  | "shellEnd"
  | "cycle"
  | "inspect";

export type VmEvent =
  | "fire"
  | "dryFire"
  | "magOut"
  | "magIn"
  | "bolt"
  | "shellIn"
  | "cycleOut"
  | "cycleIn"
  | "drawStart"
  | "drawEnd"
  | "holsterEnd"
  | "reloadEnd"
  | "inspectFlip";

export interface ViewmodelPose {
  /** Local offset from the camera, metres (right, up, forward is -z). */
  x: number;
  y: number;
  z: number;
  /** Local rotation, radians. */
  pitch: number;
  yaw: number;
  roll: number;
  /** 0..1 sight alignment blend. */
  adsT: number;
  /** 0..1 sprint carry blend. */
  sprintT: number;
  /** Moving parts, 0..1. */
  slide: number;
  bolt: number;
  mag: number;
  shell: number;
  /** 1 = fully holstered (invisible). */
  hide: number;
  /** Barrel heat, 0..1, for the shimmer and the glow. */
  heat: number;
}

type EventHandler = (e: VmEvent, def: WeaponDef) => void;

/** Rest pose in camera space — low right, the universal FPS carry. */
const HIP = { x: 0.115, y: -0.098, z: -0.245 };

export class ViewmodelAnimator {
  private clip: VmClip = "idle";
  private t = 0;
  private dur = 0;
  /** Key-time flags already fired this clip. */
  private fired = 0;
  private handlers: EventHandler[] = [];

  /** Shells still to be loaded in the current shotgun reload. */
  shellsToLoad = 0;
  /** Set true to break out of the shell loop at the next shell boundary. */
  interruptShells = false;

  private pose: ViewmodelPose = {
    x: HIP.x, y: HIP.y, z: HIP.z,
    pitch: 0, yaw: 0, roll: 0,
    adsT: 0, sprintT: 0,
    slide: 0, bolt: 0, mag: 0, shell: 0, hide: 0, heat: 0,
  };

  /* ---- continuous state ---- */
  private bobPhase = 0;
  private bobAmp = 0;
  private lagYaw = 0;
  private lagPitch = 0;
  private lagVelYaw = 0;
  private lagVelPitch = 0;
  private landDip = 0;
  private landVel = 0;
  private wasGrounded = true;
  private fireSlide = 0;
  private fireSlideVel = 0;
  private adsT = 0;
  private sprintT = 0;
  heat = 0;

  onEvent(cb: EventHandler): () => void {
    this.handlers.push(cb);
    return () => {
      const i = this.handlers.indexOf(cb);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  private emit(e: VmEvent, def: WeaponDef): void {
    for (let i = 0; i < this.handlers.length; i++) this.handlers[i](e, def);
  }

  get current(): VmClip {
    return this.clip;
  }

  /** Normalised progress through the current clip. */
  get progress(): number {
    return this.dur > 0 ? clamp01(this.t / this.dur) : 1;
  }

  /** True while an action owns the weapon and firing must be refused. */
  get busy(): boolean {
    return this.clip !== "idle" && this.clip !== "cycle";
  }

  /** True while the action is cycling — firing is refused but reloads queue. */
  get cycling(): boolean {
    return this.clip === "cycle";
  }

  play(clip: VmClip, def: WeaponDef, shells = 0): void {
    const h = def.handling;
    this.clip = clip;
    this.t = 0;
    this.fired = 0;
    switch (clip) {
      case "draw":
        this.dur = h.drawTime;
        this.emit("drawStart", def);
        break;
      case "holster":
        this.dur = h.holsterTime;
        break;
      case "reloadTactical":
        this.dur = h.reloadTactical;
        break;
      case "reloadEmpty":
        this.dur = h.reloadEmpty;
        break;
      case "shellStart":
        this.dur = h.shellStart ?? 0.3;
        this.shellsToLoad = shells;
        this.interruptShells = false;
        break;
      case "shellLoad":
        this.dur = h.shellTime ?? 0.45;
        break;
      case "shellEnd":
        this.dur = h.shellEnd ?? 0.4;
        break;
      case "cycle":
        this.dur = 60 / Math.max(1, def.rpm);
        break;
      case "inspect":
        this.dur = h.inspectTime;
        break;
      default:
        this.dur = 0;
    }
  }

  cancel(): void {
    this.clip = "idle";
    this.t = 0;
    this.dur = 0;
    this.shellsToLoad = 0;
  }

  /** Fire kick on the viewmodel: the slide slams and the muzzle flips. */
  onFire(def: WeaponDef): void {
    this.fireSlideVel = 26;
    this.heat = Math.min(1.4, this.heat + def.heatPerShot);
    this.emit("fire", def);
    if (def.action === "pump" || def.action === "bolt") {
      // Manual actions cycle *after* the shot, and the player feels the pause.
      if (def.fireMode === "pump" || def.fireMode === "bolt") this.play("cycle", def);
    }
  }

  onDryFire(def: WeaponDef): void {
    this.emit("dryFire", def);
    this.fireSlideVel = 5;
  }

  /**
   * Advance the state machine and solve the pose.
   *
   * `ctx.wantAds` is the *intent*; the actual blend is refused while sprinting
   * or mid-reload, which is why the ADS blend lives here and not in the input
   * layer.
   */
  update(
    dt: number,
    def: WeaponDef,
    ctx: {
      wantAds: boolean;
      sprinting: boolean;
      speed: number;
      grounded: boolean;
      verticalVelocity: number;
    },
  ): ViewmodelPose {
    const h = def.handling;

    /* ---------------- clip timing + key events ---------------- */
    if (this.dur > 0) {
      this.t += dt;
      const p = this.t / this.dur;
      if (this.clip === "reloadTactical" || this.clip === "reloadEmpty") {
        if (!(this.fired & 1) && p >= h.magOutAt) {
          this.fired |= 1;
          this.emit("magOut", def);
        }
        if (!(this.fired & 2) && p >= h.magInAt) {
          this.fired |= 2;
          this.emit("magIn", def);
        }
        if (this.clip === "reloadEmpty" && !(this.fired & 4) && p >= h.boltAt) {
          this.fired |= 4;
          this.emit("bolt", def);
        }
      } else if (this.clip === "shellLoad") {
        if (!(this.fired & 1) && p >= 0.55) {
          this.fired |= 1;
          this.emit("shellIn", def);
        }
      } else if (this.clip === "cycle") {
        if (!(this.fired & 1) && p >= 0.3) {
          this.fired |= 1;
          this.emit("cycleOut", def);
        }
        if (!(this.fired & 2) && p >= 0.72) {
          this.fired |= 2;
          this.emit("cycleIn", def);
        }
      } else if (this.clip === "inspect") {
        if (!(this.fired & 1) && p >= 0.35) {
          this.fired |= 1;
          this.emit("inspectFlip", def);
        }
      }

      if (this.t >= this.dur) {
        const finished = this.clip;
        this.t = 0;
        if (finished === "shellStart") {
          this.play(this.shellsToLoad > 0 ? "shellLoad" : "shellEnd", def);
        } else if (finished === "shellLoad") {
          this.shellsToLoad = Math.max(0, this.shellsToLoad - 1);
          if (this.shellsToLoad > 0 && !this.interruptShells) this.play("shellLoad", def);
          else this.play("shellEnd", def);
        } else if (finished === "shellEnd") {
          this.clip = "idle";
          this.dur = 0;
          this.emit("reloadEnd", def);
        } else if (finished === "draw") {
          this.clip = "idle";
          this.dur = 0;
          this.emit("drawEnd", def);
        } else if (finished === "holster") {
          this.clip = "idle";
          this.dur = 0;
          this.emit("holsterEnd", def);
        } else if (finished === "reloadTactical" || finished === "reloadEmpty") {
          this.clip = "idle";
          this.dur = 0;
          this.emit("reloadEnd", def);
        } else {
          this.clip = "idle";
          this.dur = 0;
        }
      }
    }

    const p = this.dur > 0 ? clamp01(this.t / this.dur) : 0;

    /* ---------------- blends ---------------- */
    const reloading =
      this.clip === "reloadTactical" || this.clip === "reloadEmpty" ||
      this.clip === "shellStart" || this.clip === "shellLoad" || this.clip === "shellEnd";
    const canAds = ctx.wantAds && !ctx.sprinting && !reloading && this.clip !== "inspect" &&
      this.clip !== "draw" && this.clip !== "holster";
    const adsRate = 1 / Math.max(0.04, h.adsTime);
    this.adsT = clamp01(this.adsT + (canAds ? adsRate : -adsRate * 1.35) * dt);

    const sprintRate = ctx.sprinting ? 1 / Math.max(0.04, h.sprintInTime) : -1 / Math.max(0.04, h.sprintOutTime);
    this.sprintT = clamp01(this.sprintT + sprintRate * dt);

    /* ---------------- weapon lag ---------------- */
    // The gun is heavy and the hands are not instant: a spring driven by the
    // player's look delta, overshooting slightly on the way back.
    const lookY = recoilSystem.lookDeltaYaw;
    const lookP = recoilSystem.lookDeltaPitch;
    const lagStiff = 130 + this.adsT * 220;
    const lagDampC = 17 + this.adsT * 14; // under critical (2√k ≈ 23) on purpose
    // The look delta is an *impulse* into the spring, not a target: that is
    // what makes a flick overshoot and settle rather than rubber-band.
    this.lagVelYaw += -lookY * 7.5;
    this.lagVelPitch += -lookP * 6.0;
    this.lagVelYaw += (-this.lagYaw * lagStiff - this.lagVelYaw * lagDampC) * dt;
    this.lagVelPitch += (-this.lagPitch * lagStiff - this.lagVelPitch * lagDampC) * dt;
    this.lagYaw += this.lagVelYaw * dt;
    this.lagPitch += this.lagVelPitch * dt;
    const lagClamp = 0.13;
    this.lagYaw = Math.max(-lagClamp, Math.min(lagClamp, this.lagYaw));
    this.lagPitch = Math.max(-lagClamp, Math.min(lagClamp, this.lagPitch));

    /* ---------------- bob ---------------- */
    const speed = ctx.speed;
    const targetAmp = ctx.grounded ? clamp01(speed / 8.6) : 0;
    this.bobAmp = damp(this.bobAmp, targetAmp, 6, dt);
    this.bobPhase += dt * (5.4 + speed * 0.72);
    const bobScale = (1 - this.adsT * 0.86) * this.bobAmp * (1 + this.sprintT * 0.6);
    // Figure-eight: the horizontal runs at half the vertical's rate.
    const bobX = Math.sin(this.bobPhase * 0.5) * 0.019 * bobScale;
    const bobY = -Math.abs(Math.sin(this.bobPhase)) * 0.014 * bobScale;
    const bobRoll = Math.sin(this.bobPhase * 0.5 + 0.4) * 0.035 * bobScale;

    /* ---------------- landing dip ---------------- */
    if (!this.wasGrounded && ctx.grounded) {
      this.landVel = -Math.min(3.4, Math.abs(ctx.verticalVelocity) * 0.055);
    }
    this.wasGrounded = ctx.grounded;
    this.landVel += (-this.landDip * 220 - this.landVel * 21) * dt;
    this.landDip += this.landVel * dt;

    /* ---------------- fire slide spring ---------------- */
    this.fireSlideVel += (-this.fireSlide * 1400 - this.fireSlideVel * 52) * dt;
    this.fireSlide += this.fireSlideVel * dt;
    this.fireSlide = Math.max(0, Math.min(1, this.fireSlide));

    /* ---------------- barrel heat ---------------- */
    this.heat = Math.max(0, this.heat - def.heatCool * dt);

    /* ---------------- clip-specific offsets ---------------- */
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let cPitch = 0;
    let cYaw = 0;
    let cRoll = 0;
    let mag = 0;
    let bolt = 0;
    let shell = 0;
    let hide = 0;

    switch (this.clip) {
      case "draw": {
        // Comes up from below and to the right, settling with a slight
        // over-rotation — the classic weapon raise.
        const e = 1 - (1 - p) * (1 - p);
        cy = -0.30 * (1 - e);
        cz = 0.06 * (1 - e);
        cPitch = -0.85 * (1 - e) + Math.sin(p * Math.PI) * 0.07;
        cRoll = 0.5 * (1 - e);
        hide = p < 0.04 ? 1 : 0;
        break;
      }
      case "holster": {
        const e = p * p;
        cy = -0.34 * e;
        cPitch = -0.95 * e;
        cRoll = 0.55 * e;
        hide = p > 0.96 ? 1 : 0;
        break;
      }
      case "reloadTactical":
      case "reloadEmpty": {
        // Weapon tips left and drops out of the sight line; the magazine
        // animation is keyed to the same normalised time as the events.
        const arc = Math.sin(p * Math.PI);
        cy = -0.075 * arc;
        cx = -0.035 * arc;
        cz = 0.03 * arc;
        cRoll = -0.55 * arc;
        cPitch = 0.24 * arc;
        cYaw = 0.18 * arc;
        const mo = h.magOutAt;
        const mi = h.magInAt;
        if (p < mo) mag = 0;
        else if (p < mi) mag = smoothstep(mo, mo + (mi - mo) * 0.55, p);
        else mag = 1 - smoothstep(mi, Math.min(1, mi + 0.16), p);
        if (this.clip === "reloadEmpty") {
          const b0 = h.boltAt;
          bolt = p < b0 ? 0 : 1 - smoothstep(b0, Math.min(1, b0 + 0.1), p);
        }
        break;
      }
      case "shellStart": {
        const e = smoothstep(0, 1, p);
        cx = -0.05 * e;
        cy = -0.055 * e;
        cRoll = -0.6 * e;
        cYaw = 0.28 * e;
        break;
      }
      case "shellLoad": {
        const arc = Math.sin(p * Math.PI);
        cx = -0.05 - 0.018 * arc;
        cy = -0.055 - 0.012 * arc;
        cRoll = -0.6 - 0.1 * arc;
        cYaw = 0.28;
        shell = arc;
        break;
      }
      case "shellEnd": {
        const e = 1 - smoothstep(0, 1, p);
        cx = -0.05 * e;
        cy = -0.055 * e;
        cRoll = -0.6 * e;
        cYaw = 0.28 * e;
        // Racking the pump at the end of a shotgun reload.
        bolt = Math.sin(p * Math.PI) * (p < 0.6 ? 1 : 0.4);
        break;
      }
      case "cycle": {
        // Manual action: the whole weapon rocks as the hand leaves the grip.
        const arc = Math.sin(p * Math.PI);
        bolt = arc;
        cz = 0.012 * arc;
        cRoll = -0.12 * arc;
        cPitch = 0.05 * arc;
        cx = -0.012 * arc;
        break;
      }
      case "inspect": {
        // Turn it over, look at the receiver, drop it back.
        const a = smoothstep(0, 0.3, p) * (1 - smoothstep(0.72, 1, p));
        cYaw = -0.95 * a;
        cRoll = 1.15 * a;
        cPitch = 0.32 * a;
        cx = -0.06 * a;
        cy = 0.035 * a;
        cz = 0.05 * a;
        break;
      }
      default:
        break;
    }

    /* ---------------- sprint carry ---------------- */
    const s = smoothstep(0, 1, this.sprintT);
    const sprintX = -0.06 * s;
    const sprintY = -0.055 * s;
    const sprintZ = 0.045 * s;
    const sprintYaw = 0.62 * s;
    const sprintRoll = -0.5 * s;
    const sprintPitch = 0.28 * s;
    // A sprinting player's weapon swings with the stride, wider and slower
    // than the walk bob.
    const sprintSwing = Math.sin(this.bobPhase * 0.5) * 0.045 * s;

    /* ---------------- ADS alignment ---------------- */
    const [ex, ey] = def.sight.eyeOffset;
    const a = smoothstep(0, 1, this.adsT);
    // Hip pose → sight-aligned pose. The sight point ends up on the camera
    // axis; nothing here is hand-tuned per weapon.
    const hipX = HIP.x + bobX + cx + sprintX + recoilSystem.swayX * 0.028;
    const hipY = HIP.y + bobY + cy + sprintY + recoilSystem.swayY * 0.022 + this.landDip * 0.05;
    const hipZ = HIP.z + cz + sprintZ - recoilSystem.punchBack;
    const adsX = -ex + cx * 0.35;
    const adsY = -ey + cy * 0.35 + this.landDip * 0.018;
    const adsZ = HIP.z + 0.055 + cz * 0.35 - recoilSystem.punchBack * 0.7;

    this.pose.x = hipX + (adsX - hipX) * a;
    this.pose.y = hipY + (adsY - hipY) * a;
    this.pose.z = hipZ + (adsZ - hipZ) * a;

    const lagMul = 1 - a * 0.72;
    this.pose.yaw =
      cYaw + sprintYaw + (this.lagYaw + sprintSwing) * lagMul + recoilSystem.swayX * 0.02 * lagMul;
    this.pose.pitch =
      cPitch + sprintPitch + this.lagPitch * lagMul + recoilSystem.swayY * 0.016 * lagMul +
      this.fireSlide * 0.16 + this.landDip * 0.6;
    this.pose.roll =
      cRoll + sprintRoll + (bobRoll + recoilSystem.swayRoll * 0.05) * lagMul - this.lagYaw * 0.55 * lagMul;

    this.pose.adsT = this.adsT;
    this.pose.sprintT = this.sprintT;
    this.pose.slide = Math.max(this.fireSlide, bolt * 0.9);
    this.pose.bolt = bolt;
    this.pose.mag = mag;
    this.pose.shell = shell;
    this.pose.hide = hide;
    this.pose.heat = Math.min(1, this.heat);
    return this.pose;
  }

  /** Current solved pose without advancing time. */
  get currentPose(): ViewmodelPose {
    return this.pose;
  }

  reset(): void {
    this.cancel();
    this.adsT = 0;
    this.sprintT = 0;
    this.heat = 0;
    this.lagYaw = this.lagPitch = 0;
    this.lagVelYaw = this.lagVelPitch = 0;
    this.landDip = this.landVel = 0;
    this.fireSlide = this.fireSlideVel = 0;
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.wasGrounded = frame.grounded;
  }
}

export const viewmodelAnimator = new ViewmodelAnimator();
