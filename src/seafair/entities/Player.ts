import * as THREE from "three";
import { bus } from "../core/EventBus";
import type { InputState } from "../core/Input";
import type { TerrainRig } from "../world/Terrain";

/**
 * First-person controller: capsule collide-and-slide against terrain and a
 * collider list, Halo-style shield regeneration, and a full procedural camera
 * rig (head bob, lean, landing dip, recoil, breathing sway).
 */

export interface Collider {
  /** Axis-aligned box in world space. */
  box: THREE.Box3;
  /** Solid geometry blocks movement; false = trigger volume only. */
  solid: boolean;
  name?: string;
}

export interface PlayerConfig {
  /** metres/second on flat ground */
  walkSpeed: number;
  sprintMultiplier: number;
  crouchMultiplier: number;
  jumpVelocity: number;
  /** how fast velocity converges to the desired direction, /s */
  acceleration: number;
  airControl: number;
  eyeHeight: number;
  crouchEyeHeight: number;
  radius: number;
  maxHealth: number;
  maxShield: number;
  /** seconds of no damage before the shield starts recharging */
  shieldDelay: number;
  /** shield points per second once recharging */
  shieldRate: number;
  mass: number;
}

export const CHARACTER_CONFIGS: Record<string, PlayerConfig> = {
  // Spartan: heavy, high shields, powerful jump, slow turn-on-a-dime
  spartan: {
    walkSpeed: 6.4,
    sprintMultiplier: 1.62,
    crouchMultiplier: 0.5,
    jumpVelocity: 7.4,
    acceleration: 11,
    airControl: 0.24,
    eyeHeight: 1.86,
    crouchEyeHeight: 1.1,
    radius: 0.42,
    maxHealth: 100,
    maxShield: 120,
    shieldDelay: 4.2,
    shieldRate: 42,
    mass: 420,
  },
  // Street operative: agile, low shields, fast, tight air control
  street: {
    walkSpeed: 7.1,
    sprintMultiplier: 1.78,
    crouchMultiplier: 0.55,
    jumpVelocity: 6.9,
    acceleration: 15,
    airControl: 0.4,
    eyeHeight: 1.72,
    crouchEyeHeight: 1.0,
    radius: 0.36,
    maxHealth: 130,
    maxShield: 45,
    shieldDelay: 5.5,
    shieldRate: 26,
    mass: 82,
  },
  // Toon: floaty, bouncy, forgiving — pure fun
  toon: {
    walkSpeed: 7.8,
    sprintMultiplier: 1.7,
    crouchMultiplier: 0.6,
    jumpVelocity: 9.2,
    acceleration: 18,
    airControl: 0.62,
    eyeHeight: 1.58,
    crouchEyeHeight: 0.95,
    radius: 0.4,
    maxHealth: 110,
    maxShield: 80,
    shieldDelay: 3.4,
    shieldRate: 48,
    mass: 60,
  },
};

const GRAVITY = -21.5;
const UP = new THREE.Vector3(0, 1, 0);

export class Player {
  readonly position = new THREE.Vector3(0, 4, 40);
  readonly velocity = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, -1);

  yaw = Math.PI;
  pitch = 0;

  health: number;
  shield: number;
  grounded = false;
  inWater = false;
  crouching = false;
  sprinting = false;
  dead = false;
  /** Debug/screenshot flag — disables gravity and collision. */
  noclip = false;

  config: PlayerConfig;
  colliders: Collider[] = [];

  /** Additive camera offsets driven by procedural animation. */
  readonly cameraOffset = new THREE.Vector3();
  readonly recoil = new THREE.Vector2();

  private bobPhase = 0;
  private landingDip = 0;
  private lean = 0;
  private shieldTimer = 0;
  private lastDamageDir = new THREE.Vector3();
  private stepTimer = 0;
  private terrain?: TerrainRig;
  private waterHeight: (x: number, z: number) => number = () => 0;

  onFootstep?: (surface: "grass" | "wood" | "metal" | "water") => void;

  constructor(config: PlayerConfig) {
    this.config = config;
    this.health = config.maxHealth;
    this.shield = config.maxShield;
  }

  setWorld(terrain: TerrainRig, waterHeight: (x: number, z: number) => number): void {
    this.terrain = terrain;
    this.waterHeight = waterHeight;
  }

  setCharacter(config: PlayerConfig): void {
    const healthPct = this.health / this.config.maxHealth;
    this.config = config;
    this.health = config.maxHealth * healthPct;
    this.shield = config.maxShield;
    this.emitVitals();
  }

  get eyeHeight(): number {
    return this.crouching ? this.config.crouchEyeHeight : this.config.eyeHeight;
  }

  emitVitals(): void {
    bus.emit("player:health", {
      health: this.health,
      shield: this.shield,
      maxHealth: this.config.maxHealth,
      maxShield: this.config.maxShield,
    });
  }

  damage(amount: number, fromDirection: THREE.Vector3): void {
    if (this.dead) return;
    this.shieldTimer = 0;
    this.lastDamageDir.copy(fromDirection).normalize();

    let remaining = amount;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
    }
    if (remaining > 0) this.health -= remaining;

    bus.emit("player:damaged", {
      amount,
      fromDirection: [this.lastDamageDir.x, this.lastDamageDir.y, this.lastDamageDir.z],
    });
    this.emitVitals();

    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      bus.emit("player:died", { killerName: "Covenant Remnant" });
      bus.emit("game:state", { state: "dead" });
    }
  }

  heal(amount: number): void {
    this.health = Math.min(this.config.maxHealth, this.health + amount);
    this.emitVitals();
  }

  respawn(at: THREE.Vector3): void {
    this.position.copy(at);
    this.velocity.set(0, 0, 0);
    this.health = this.config.maxHealth;
    this.shield = this.config.maxShield;
    this.dead = false;
    this.emitVitals();
    bus.emit("player:respawn", {});
    bus.emit("game:state", { state: "playing" });
  }

  addRecoil(vertical: number, horizontal: number): void {
    this.recoil.x += vertical;
    this.recoil.y += horizontal;
  }

  private groundHeight(x: number, z: number): number {
    let h = this.terrain ? this.terrain.height(x, z) : 0;
    // Platforms: stand on top of any solid collider we are horizontally inside
    for (const c of this.colliders) {
      if (!c.solid) continue;
      const b = c.box;
      if (x >= b.min.x - 0.3 && x <= b.max.x + 0.3 && z >= b.min.z - 0.3 && z <= b.max.z + 0.3) {
        if (b.max.y <= this.position.y + 0.65 && b.max.y > h) h = b.max.y;
      }
    }
    return h;
  }

  /** Push out of solid boxes horizontally (collide-and-slide, cheap AABB form). */
  private resolveHorizontal(): void {
    const r = this.config.radius;
    const feet = this.position.y;
    const head = this.position.y + this.eyeHeight;

    for (const c of this.colliders) {
      if (!c.solid) continue;
      const b = c.box;
      if (head < b.min.y || feet > b.max.y - 0.05) continue;
      // Skip if we're standing on top of it
      if (feet >= b.max.y - 0.4) continue;

      const cx = THREE.MathUtils.clamp(this.position.x, b.min.x, b.max.x);
      const cz = THREE.MathUtils.clamp(this.position.z, b.min.z, b.max.z);
      const dx = this.position.x - cx;
      const dz = this.position.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;

      const d = Math.sqrt(d2);
      if (d < 1e-4) {
        // Deep inside — eject along the shallowest axis
        const toMinX = Math.abs(this.position.x - b.min.x);
        const toMaxX = Math.abs(b.max.x - this.position.x);
        const toMinZ = Math.abs(this.position.z - b.min.z);
        const toMaxZ = Math.abs(b.max.z - this.position.z);
        const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
        if (m === toMinX) this.position.x = b.min.x - r;
        else if (m === toMaxX) this.position.x = b.max.x + r;
        else if (m === toMinZ) this.position.z = b.min.z - r;
        else this.position.z = b.max.z + r;
      } else {
        const push = (r - d) / d;
        this.position.x += dx * push;
        this.position.z += dz * push;
        // Kill velocity into the surface, keep the tangential component
        const nx = dx / d;
        const nz = dz / d;
        const into = this.velocity.x * nx + this.velocity.z * nz;
        if (into < 0) {
          this.velocity.x -= nx * into;
          this.velocity.z -= nz * into;
        }
      }
    }
  }

  update(dt: number, input: InputState, camera: THREE.PerspectiveCamera): void {
    const cfg = this.config;

    // --- look ---
    if (!this.dead) {
      this.yaw -= input.lookX;
      this.pitch -= input.lookY;
    }

    // recoil decays back toward zero, feeding the camera additively
    this.recoil.multiplyScalar(Math.max(0, 1 - dt * 7.5));
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.48, 1.48);

    // --- desired movement in world space ---
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    this.forward.set(-sinY, 0, -cosY);
    const right = new THREE.Vector3(cosY, 0, -sinY);

    this.crouching = input.crouch && this.grounded;
    this.sprinting = input.sprint && input.moveY > 0.2 && !this.crouching && !this.dead;

    let speed = cfg.walkSpeed;
    if (this.sprinting) speed *= cfg.sprintMultiplier;
    if (this.crouching) speed *= cfg.crouchMultiplier;
    if (this.inWater) speed *= 0.55;
    if (this.dead) speed = 0;

    const wish = new THREE.Vector3()
      .addScaledVector(this.forward, input.moveY)
      .addScaledVector(right, input.moveX);
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(speed);

    const accel = this.grounded ? cfg.acceleration : cfg.acceleration * cfg.airControl;
    const blend = 1 - Math.exp(-accel * dt);
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, wish.x, blend);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, wish.z, blend);

    // --- vertical ---
    if (input.jumpPressed && this.grounded && !this.dead) {
      this.velocity.y = cfg.jumpVelocity;
      this.grounded = false;
    }
    this.velocity.y += GRAVITY * dt * (this.inWater ? 0.28 : 1);
    if (this.inWater) {
      this.velocity.y = Math.max(this.velocity.y, -2.2);
      if (input.jump) this.velocity.y += 14 * dt;
    }

    if (this.noclip) {
      this.velocity.y = 0;
      this.position.addScaledVector(wish, dt);
      this.grounded = false;
      this.updateCamera(dt, camera, input);
      return;
    }

    // --- integrate ---
    this.position.addScaledVector(this.velocity, dt);
    this.resolveHorizontal();

    // --- ground ---
    const gh = this.groundHeight(this.position.x, this.position.z);
    const wh = this.waterHeight(this.position.x, this.position.z);
    this.inWater = this.position.y < wh - 0.35 && gh < wh;

    const wasGrounded = this.grounded;
    if (this.position.y <= gh + 0.02) {
      if (!wasGrounded && this.velocity.y < -5) {
        this.landingDip = THREE.MathUtils.clamp(-this.velocity.y * 0.021, 0, 0.4);
        // fall damage above terminal-ish speed
        if (this.velocity.y < -21) this.damage((-this.velocity.y - 21) * 3.4, UP);
      }
      this.position.y = gh;
      this.velocity.y = Math.max(0, this.velocity.y);
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // Float at the surface if swimming
    if (this.inWater && this.position.y < wh - 1.2) {
      this.position.y = THREE.MathUtils.lerp(this.position.y, wh - 1.1, dt * 2.5);
    }

    // --- shields ---
    this.shieldTimer += dt;
    if (!this.dead && this.shieldTimer > cfg.shieldDelay && this.shield < cfg.maxShield) {
      const before = this.shield;
      this.shield = Math.min(cfg.maxShield, this.shield + cfg.shieldRate * dt);
      if (Math.floor(before) !== Math.floor(this.shield)) this.emitVitals();
    }

    this.updateCamera(dt, camera, input);
  }

  private updateCamera(dt: number, camera: THREE.PerspectiveCamera, input: InputState): void {
    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const moving = this.grounded && horizSpeed > 0.6;

    // head bob — figure-8, amplitude scaled by speed
    const bobRate = this.sprinting ? 13.5 : 9.6;
    if (moving) this.bobPhase += dt * bobRate;
    const bobAmp = THREE.MathUtils.clamp(horizSpeed / this.config.walkSpeed, 0, 1.7) * (this.sprinting ? 0.055 : 0.036);
    const bobX = Math.cos(this.bobPhase) * bobAmp * 0.6;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * bobAmp;

    // footsteps at the bottom of each bob cycle
    if (moving) {
      this.stepTimer += dt * bobRate;
      if (this.stepTimer > Math.PI) {
        this.stepTimer -= Math.PI;
        this.onFootstep?.(this.inWater ? "water" : this.position.y > 2.0 ? "wood" : "grass");
      }
    }

    // breathing sway when still
    const breathe = Math.sin(performance.now() * 0.0011) * 0.006 * (moving ? 0.2 : 1);

    // lean into strafes
    const targetLean = -input.moveX * (this.sprinting ? 0.055 : 0.032);
    this.lean = THREE.MathUtils.lerp(this.lean, targetLean, dt * 6.5);

    // landing dip recovers with a spring
    this.landingDip = THREE.MathUtils.lerp(this.landingDip, 0, dt * 7.5);

    this.cameraOffset.set(bobX, bobY + breathe - this.landingDip, 0);

    camera.position.copy(this.position);
    camera.position.y += this.eyeHeight;
    camera.position.add(this.cameraOffset);

    const deathTilt = this.dead ? 1.15 : 0;
    camera.rotation.set(0, 0, 0);
    camera.rotateY(this.yaw + this.recoil.y * 0.4);
    camera.rotateX(this.pitch + this.recoil.x);
    camera.rotateZ(this.lean + deathTilt);

    if (this.dead) {
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, this.position.y + 0.4, dt * 3);
    }
  }
}
