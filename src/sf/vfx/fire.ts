/**
 * vfx/fire.ts — persistent burning.
 *
 * An explosion is an event; a fire is a *place*. This module owns the second
 * kind: a pool of `FireSource` objects that sit in the world, emit flame and
 * smoke every frame, contribute light, spread to nearby flammables, and burn
 * out.
 *
 * ## What makes flame read as flame
 *
 * Four things, in order of importance:
 *
 *  1. **The colour ramp is non-linear.** White-yellow core → saturated orange →
 *     deep red → black smoke, with the *yellow shelf* held for a while. A
 *     linear white→red lerp always looks like a heat gradient in a spreadsheet.
 *     The ramp is baked into `fireRampTexture` and into the flipbook itself.
 *  2. **Upward acceleration, not upward velocity.** Hot gas accelerates as it
 *     rises (buoyancy is a force). Emitting flames with a constant upward
 *     velocity gives a fountain; emitting them with positive `gravity` gives a
 *     fire.
 *  3. **Y-locked billboards near the base.** Flame sheets that spin to face the
 *     camera about a *vertical* axis stay attached to the ground. Full camera
 *     billboards at the base of a fire visibly rotate under the ground plane.
 *  4. **The smoke column bends.** Fire smoke is the most reliable wind
 *     indicator in the world; a column that goes straight up in a 7 m/s
 *     onshore breeze reads as broken even to people who could not tell you why.
 *
 * ## Spread
 *
 * Flammables register themselves; a burning source periodically tests its
 * neighbourhood and ignites what it touches, with a delay proportional to
 * distance. That is enough to make a row of parked cars go one at a time,
 * which is the behaviour that actually matters.
 */
import * as THREE from "three";
import type { QualityTier } from "../config";
import { frame } from "../state/store";
import { clamp01, makeRng, smoothstep, type Rng } from "../math/rng";
import { walkableHeight } from "../geo/sfGeo";
import { Billboard, P, budget, particles, resetDesc, vfxRng } from "./particles";
import { Tile } from "./textures";
import { sootDecal } from "./decals";

/* ================================================================== *
 * Flammables registry
 * ================================================================== */

export interface Flammable {
  id: number;
  x: number; y: number; z: number;
  /** Ignition radius — how close a fire must be to light it. */
  radius: number;
  /** Seconds it burns once lit. */
  duration: number;
  /** 0..1 how readily it catches. Fuel is 1, a wooden fence is 0.4. */
  susceptibility: number;
  /** Fires this when it ignites — the owner detonates, sheds paint, etc. */
  onIgnite?: (f: Flammable) => void;
  burning: boolean;
  alive: boolean;
}

let flammableId = 1;
const flammables: Flammable[] = [];

/**
 * Register something that can catch fire. Returns an unregister function —
 * always call it when the object dies, or a destroyed car will keep attracting
 * flame for the rest of the session.
 */
export function registerFlammable(
  x: number, y: number, z: number,
  o: { radius?: number; duration?: number; susceptibility?: number; onIgnite?: (f: Flammable) => void } = {},
): () => void {
  const f: Flammable = {
    id: flammableId++,
    x, y, z,
    radius: o.radius ?? 3,
    duration: o.duration ?? 14,
    susceptibility: o.susceptibility ?? 0.7,
    onIgnite: o.onIgnite,
    burning: false,
    alive: true,
  };
  flammables.push(f);
  return () => {
    f.alive = false;
    const i = flammables.indexOf(f);
    if (i >= 0) {
      flammables[i] = flammables[flammables.length - 1];
      flammables.pop();
    }
  };
}

/* ================================================================== *
 * Fire sources
 * ================================================================== */

export interface FireOptions {
  /** Radius of the burning footprint, metres. */
  radius?: number;
  /** Seconds until it burns out. <= 0 burns until extinguished. */
  duration?: number;
  /** 0..1 — flame density and light. A gas fire is 1, embers are 0.15. */
  intensity?: number;
  /** Whether this fire can ignite registered flammables. */
  spread?: boolean;
  /** Optional smoke column multiplier — a fuel tank smokes far more than a bin. */
  smoke?: number;
  /** Attach the fire to a moving object by re-positioning it every frame. */
  followId?: number;
}

interface FireSource {
  active: boolean;
  x: number; y: number; z: number;
  radius: number;
  intensity: number;
  smoke: number;
  born: number;
  dies: number;
  spread: boolean;
  /** Fraction of full strength — ramps up at ignition, down at burnout. */
  strength: number;
  /** Accumulated emission budget so low frame rates do not starve the fire. */
  acc: number;
  smokeAcc: number;
  lightSlot: number;
  nextSpreadTest: number;
  followId: number;
  /** Distance to the camera last frame, for LOD. */
  dist: number;
}

const LIGHTS_BY_TIER: Record<QualityTier, number> = { low: 1, medium: 3, high: 5, ultra: 8 };
const SOURCES_BY_TIER: Record<QualityTier, number> = { low: 6, medium: 14, high: 28, ultra: 48 };

const _cam = new THREE.Vector3();

class FireSystem {
  readonly group = new THREE.Group();
  private sources: FireSource[] = [];
  private lights: THREE.PointLight[] = [];
  private lightOwner: number[] = [];
  private started = false;
  private tier: QualityTier = "high";
  private rng: Rng = makeRng("sf-vfx-fire");
  private pendingIgnitions: Array<{ at: number; f: Flammable }> = [];

  constructor() {
    this.group.name = "vfx-fire";
  }

  init(tier: QualityTier): void {
    if (this.started) return;
    this.tier = tier;
    const n = SOURCES_BY_TIER[tier] ?? 28;
    for (let i = 0; i < n; i++) {
      this.sources.push({
        active: false, x: 0, y: 0, z: 0, radius: 2, intensity: 1, smoke: 1,
        born: 0, dies: 0, spread: false, strength: 0, acc: 0, smokeAcc: 0,
        lightSlot: -1, nextSpreadTest: 0, followId: -1, dist: 0,
      });
    }
    const ln = LIGHTS_BY_TIER[tier] ?? 5;
    for (let i = 0; i < ln; i++) {
      const l = new THREE.PointLight(0xff7a26, 0, 40, 2);
      l.visible = false;
      l.castShadow = false;
      this.group.add(l);
      this.lights.push(l);
      this.lightOwner.push(-1);
    }
    this.started = true;
  }

  /** Light a fire. Returns its index, or -1 if the pool is full. */
  ignite(x: number, y: number, z: number, o: FireOptions = {}): number {
    if (!this.started) return -1;
    const radius = o.radius ?? 2;
    const now = frame.time;

    // Merge into an existing overlapping fire rather than stacking two — two
    // coincident fires cost twice the particles and look exactly the same.
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      if (!s.active) continue;
      const d = Math.hypot(s.x - x, s.y - y, s.z - z);
      if (d < Math.max(s.radius, radius) * 0.6) {
        s.radius = Math.max(s.radius, radius);
        s.intensity = Math.max(s.intensity, o.intensity ?? 1);
        s.smoke = Math.max(s.smoke, o.smoke ?? 1);
        const dur = o.duration ?? 12;
        if (dur > 0) s.dies = Math.max(s.dies, now + dur);
        return i;
      }
    }

    let slot = -1;
    for (let i = 0; i < this.sources.length; i++) {
      if (!this.sources[i].active) { slot = i; break; }
    }
    if (slot < 0) {
      // Full: replace the smallest, oldest fire. Big fires are the ones the
      // player is looking at.
      let worst = 0;
      let worstScore = Infinity;
      for (let i = 0; i < this.sources.length; i++) {
        const s = this.sources[i];
        const score = s.radius * s.intensity - (now - s.born) * 0.05;
        if (score < worstScore) { worstScore = score; worst = i; }
      }
      slot = worst;
      this.extinguishSlot(slot);
    }

    const s = this.sources[slot];
    s.active = true;
    s.x = x; s.y = y; s.z = z;
    s.radius = radius;
    s.intensity = o.intensity ?? 1;
    s.smoke = o.smoke ?? 1;
    s.born = now;
    const dur = o.duration ?? 12;
    s.dies = dur > 0 ? now + dur : Number.POSITIVE_INFINITY;
    s.spread = o.spread ?? false;
    s.strength = 0;
    s.acc = 0;
    s.smokeAcc = 0;
    s.nextSpreadTest = now + 0.7;
    s.followId = o.followId ?? -1;
    s.dist = 0;
    return slot;
  }

  /** Move a fire that is attached to something. */
  moveFire(slot: number, x: number, y: number, z: number): void {
    const s = this.sources[slot];
    if (!s || !s.active) return;
    s.x = x; s.y = y; s.z = z;
  }

  /** Put a fire out — a fire extinguisher, rain, or the object being destroyed. */
  extinguish(slot: number, leaveSoot = true): void {
    const s = this.sources[slot];
    if (!s || !s.active) return;
    if (leaveSoot) sootDecal(s.x, s.y + s.radius * 0.6, s.z, 0, 0, 1, s.radius * 1.2);
    this.extinguishSlot(slot);
  }

  private extinguishSlot(slot: number): void {
    const s = this.sources[slot];
    s.active = false;
    if (s.lightSlot >= 0) {
      this.lights[s.lightSlot].visible = false;
      this.lights[s.lightSlot].intensity = 0;
      this.lightOwner[s.lightSlot] = -1;
      s.lightSlot = -1;
    }
  }

  /** Is anything burning within `r` of a point? Used by AI and by the player. */
  isBurningNear(x: number, y: number, z: number, r: number): boolean {
    for (const s of this.sources) {
      if (!s.active) continue;
      const d = Math.hypot(s.x - x, s.y - y, s.z - z);
      if (d < r + s.radius) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  update(dt: number, camera: THREE.Camera): void {
    if (!this.started) return;
    const now = frame.time;
    camera.getWorldPosition(_cam);

    // --- delayed ignitions from spread ---
    for (let i = this.pendingIgnitions.length - 1; i >= 0; i--) {
      const p = this.pendingIgnitions[i];
      if (p.at > now) continue;
      this.pendingIgnitions[i] = this.pendingIgnitions[this.pendingIgnitions.length - 1];
      this.pendingIgnitions.pop();
      if (!p.f.alive || p.f.burning) continue;
      p.f.burning = true;
      this.ignite(p.f.x, p.f.y, p.f.z, {
        radius: p.f.radius * 0.7,
        duration: p.f.duration,
        intensity: 0.55 + p.f.susceptibility * 0.5,
        spread: true,
      });
      p.f.onIgnite?.(p.f);
    }

    // --- claim lights, biggest and nearest first ---
    for (let i = 0; i < this.lights.length; i++) this.lightOwner[i] = -1;
    const ranked: number[] = [];
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      if (!s.active) continue;
      s.dist = Math.hypot(s.x - _cam.x, s.y - _cam.y, s.z - _cam.z);
      s.lightSlot = -1;
      ranked.push(i);
    }
    ranked.sort((a, b) => {
      const sa = this.sources[a], sb = this.sources[b];
      return (sb.radius * sb.intensity) / (1 + sb.dist * 0.02) -
             (sa.radius * sa.intensity) / (1 + sa.dist * 0.02);
    });
    for (let k = 0; k < this.lights.length; k++) {
      if (k >= ranked.length) {
        this.lights[k].visible = false;
        this.lights[k].intensity = 0;
        continue;
      }
      const s = this.sources[ranked[k]];
      s.lightSlot = k;
      this.lightOwner[k] = ranked[k];
    }

    const wx = frame.windDirection.x;
    const wz = frame.windDirection.y;
    const wlen = Math.hypot(wx, wz) || 1;
    const windSpeed = frame.windSpeed;

    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      if (!s.active) continue;

      // Strength envelope: 0.4 s to catch, 1.5 s to die out.
      const remain = s.dies - now;
      const up = smoothstep(0, 0.4, now - s.born);
      const down = s.dies === Number.POSITIVE_INFINITY ? 1 : clamp01(remain / 1.5);
      s.strength = up * down * s.intensity;
      if (remain <= 0) {
        sootDecal(s.x, s.y + 0.05, s.z, 0, 1, 0, s.radius * 1.4);
        this.extinguishSlot(i);
        continue;
      }

      // Distance LOD. Beyond 260 m a fire is a smoke column and a glow; there
      // is no point paying for flame sheets nobody can resolve.
      const lod = s.dist > 320 ? 0 : s.dist > 150 ? 0.4 : 1;

      /* ---- flame sheets ---- */
      if (lod > 0) {
        // Emission rate scales with footprint area — a 6 m fire needs far more
        // than three times the flames of a 2 m one.
        const rate = (10 + s.radius * s.radius * 5.5) * s.strength * lod;
        s.acc += rate * dt;
        const n = Math.min(24, Math.floor(s.acc));
        s.acc -= n;
        for (let k = 0; k < n; k++) {
          const a = vfxRng.range(0, Math.PI * 2);
          const rr = s.radius * Math.sqrt(vfxRng.next()) * 0.85;
          const px = s.x + Math.cos(a) * rr;
          const pz = s.z + Math.sin(a) * rr;
          resetDesc();
          P.layer = "flame";
          P.x = px;
          P.y = s.y + vfxRng.range(0, s.radius * 0.25);
          P.z = pz;
          // Buoyancy as acceleration, plus a small inward pull so the flame
          // necks in above the base like a real diffusion flame.
          P.vx = (s.x - px) * 0.55 + vfxRng.gauss() * 0.4;
          P.vy = vfxRng.range(0.6, 2.0);
          P.vz = (s.z - pz) * 0.55 + vfxRng.gauss() * 0.4;
          P.drag = 1.5;
          P.gravity = 6.5 + s.radius * 0.5;
          P.turbulence = 1.5 + s.radius * 0.1;
          P.wind = 0.22;
          P.life = 0.42 + vfxRng.range(0, 0.4) + s.radius * 0.035;
          P.size0 = s.radius * vfxRng.range(0.4, 0.75);
          P.size1 = s.radius * vfxRng.range(0.9, 1.5);
          P.frames = 16;
          P.fps = vfxRng.range(20, 30);
          P.frame = vfxRng.int(0, 15);
          P.mode = Billboard.Axis;      // vertical-axis billboard: stays planted
          P.r0 = 2.4; P.g0 = 1.55; P.b0 = 0.75; P.a0 = 0.95;
          P.r1 = 1.05; P.g1 = 0.22; P.b1 = 0.035; P.a1 = 0;
          P.fadeIn = 0.12; P.fadeOut = 0.55;
          particles.emit(P);
        }

        // Embers lifting off the fire. Sparse, but they are the detail that
        // makes a static fire feel alive between flame frames.
        if (vfxRng.chance(dt * 6 * s.strength * lod)) {
          resetDesc();
          P.layer = "add";
          const a = vfxRng.range(0, Math.PI * 2);
          const rr = s.radius * Math.sqrt(vfxRng.next());
          P.x = s.x + Math.cos(a) * rr;
          P.y = s.y + s.radius * 0.4;
          P.z = s.z + Math.sin(a) * rr;
          P.vx = vfxRng.gauss() * 0.9;
          P.vy = vfxRng.range(1.5, 4.5);
          P.vz = vfxRng.gauss() * 0.9;
          P.drag = 1.1;
          P.gravity = 1.2;
          P.turbulence = 2.6;
          P.wind = 0.85;
          P.life = 2.2 + vfxRng.range(0, 2.5);
          P.size0 = 0.075; P.size1 = 0.015;
          P.frame = Tile.Ember;
          P.r0 = 2.4; P.g0 = 0.9; P.b0 = 0.22; P.a0 = 1;
          P.r1 = 0.9; P.g1 = 0.12; P.b1 = 0.02; P.a1 = 0;
          P.fadeIn = 0.05; P.fadeOut = 0.5;
          particles.emit(P);
        }
      }

      /* ---- smoke column ---- */
      // Always emitted, at every distance: the column is how a fire reads from
      // across the bay, and it is the cheapest thing here.
      const smokeRate = (1.1 + s.radius * 0.42) * s.strength * s.smoke;
      s.smokeAcc += smokeRate * dt;
      const sn = Math.min(6, Math.floor(s.smokeAcc));
      s.smokeAcc -= sn;
      for (let k = 0; k < sn; k++) {
        const a = vfxRng.range(0, Math.PI * 2);
        const rr = s.radius * Math.sqrt(vfxRng.next()) * 0.7;
        resetDesc();
        P.layer = "smoke";
        P.x = s.x + Math.cos(a) * rr;
        P.y = s.y + s.radius * vfxRng.range(0.5, 1.1);
        P.z = s.z + Math.sin(a) * rr;
        P.vx = (wx / wlen) * windSpeed * 0.2 + vfxRng.gauss() * 0.5;
        P.vy = vfxRng.range(1.2, 3.0);
        P.vz = (wz / wlen) * windSpeed * 0.2 + vfxRng.gauss() * 0.5;
        P.drag = 0.85;
        P.gravity = 2.2 + s.radius * 0.18;
        P.turbulence = 2.0;
        // Full wind coupling: this is what bends the column downwind and it is
        // the most-read cue in the whole system.
        P.wind = 0.95;
        P.life = 5.5 + s.radius * 0.7 + vfxRng.range(0, 4);
        P.size0 = s.radius * vfxRng.range(0.7, 1.2);
        P.size1 = s.radius * vfxRng.range(3.0, 5.5) * (1 + s.smoke * 0.3);
        P.frames = 16;
        P.fps = vfxRng.range(2.6, 4.2);
        P.frame = vfxRng.int(0, 3);
        P.rot = vfxRng.range(0, 6.283);
        P.rotSpeed = vfxRng.range(-0.3, 0.3);
        // Lit from below by the fire at birth, cold soot at death.
        P.r0 = 0.42; P.g0 = 0.26; P.b0 = 0.15; P.a0 = 0.8 * clamp01(0.5 + s.smoke * 0.5);
        P.r1 = 0.22; P.g1 = 0.215; P.b1 = 0.21; P.a1 = 0;
        P.fadeIn = 0.1; P.fadeOut = 0.45;
        particles.emit(P);
      }

      /* ---- light ---- */
      if (s.lightSlot >= 0) {
        const l = this.lights[s.lightSlot];
        l.visible = true;
        l.position.set(s.x, s.y + s.radius * 0.55, s.z);
        // Two incommensurable flicker frequencies — a single sine is a pulse,
        // and a pulse reads as a machine, not a fire.
        const f1 = Math.sin(now * 11.3 + i * 2.1);
        const f2 = Math.sin(now * 27.7 + i * 5.7);
        const flicker = 0.72 + 0.2 * f1 + 0.12 * f2 * f2;
        l.intensity = 40 * s.radius * s.radius * s.strength * flicker;
        l.distance = 8 + s.radius * 9;
        l.color.setRGB(1.0, 0.46 + 0.06 * f2, 0.16);
      }

      /* ---- spread ---- */
      if (s.spread && now >= s.nextSpreadTest) {
        s.nextSpreadTest = now + 0.8;
        for (const f of flammables) {
          if (!f.alive || f.burning) continue;
          const d = Math.hypot(f.x - s.x, f.y - s.y, f.z - s.z);
          const reach = s.radius + f.radius;
          if (d > reach) continue;
          // Closer + more susceptible = lights sooner. Everything catching at
          // once looks scripted; a stagger looks like fire.
          const p = f.susceptibility * (1 - d / reach) * s.strength;
          if (!vfxRng.chance(p * 0.55)) continue;
          f.burning = true;
          this.pendingIgnitions.push({
            at: now + vfxRng.range(0.25, 1.6) * (1 + d / Math.max(reach, 1e-3)),
            f,
          });
        }
      }
    }
  }

  get liveCount(): number {
    let n = 0;
    for (const s of this.sources) if (s.active) n++;
    return n;
  }

  clear(): void {
    for (let i = 0; i < this.sources.length; i++) if (this.sources[i].active) this.extinguishSlot(i);
    this.pendingIgnitions.length = 0;
    for (const f of flammables) f.burning = false;
  }

  dispose(): void {
    this.clear();
    for (const l of this.lights) {
      this.group.remove(l);
      l.dispose();
    }
    this.lights.length = 0;
    this.lightOwner.length = 0;
    this.sources.length = 0;
    this.started = false;
  }
}

export const fire = new FireSystem();

/* ================================================================== *
 * Public helpers
 * ================================================================== */

/** Light a fire at a point. The imperative entry point. */
export function igniteFire(x: number, y: number, z: number, o: FireOptions = {}): number {
  return fire.ignite(x, y, z, o);
}

/** Put a fire out. */
export function extinguishFire(slot: number, leaveSoot = true): void {
  fire.extinguish(slot, leaveSoot);
}

/** Is there fire near this point? */
export function isBurningNear(x: number, y: number, z: number, r = 2): boolean {
  return fire.isBurningNear(x, y, z, r);
}

/**
 * A small pilot flame — a burning fuel puddle, a lit fuse, a torched bin.
 * Cheap enough to place dozens of.
 */
export function spawnSmallFire(x: number, y: number, z: number, duration = 20): number {
  return igniteFire(x, y, z, { radius: 0.55, duration, intensity: 0.6, smoke: 0.5 });
}

/**
 * A burning vehicle: fire at the engine bay, heavy black smoke, and it takes
 * the neighbours with it.
 */
export function spawnVehicleFire(x: number, y: number, z: number): number {
  const gy = Math.max(y, walkableHeight(x, z) + 0.4);
  return igniteFire(x, gy, z, {
    radius: 1.5, duration: 26, intensity: 1.0, smoke: 2.0, spread: true,
  });
}

/**
 * The gas-fed roar of a ruptured fuel tank: tall, bright, and it does not go
 * out on its own.
 */
export function spawnFuelFire(x: number, y: number, z: number, radius = 4): number {
  return igniteFire(x, y, z, {
    radius, duration: 0, intensity: 1.3, smoke: 2.6, spread: true,
  });
}

/**
 * Emit a one-shot burst of flame without creating a persistent source — the
 * muzzle bloom of a flamethrower, or a backdraft out of a window.
 */
export function flameBurst(
  x: number, y: number, z: number,
  dx: number, dy: number, dz: number,
  power = 1,
): void {
  resetDesc();
  P.layer = "flame";
  P.x = x; P.y = y; P.z = z;
  P.drag = 2.2;
  P.gravity = 5.5;
  P.turbulence = 1.6;
  P.wind = 0.25;
  P.life = 0.45 + power * 0.25;
  P.size0 = 0.5 * power;
  P.size1 = 2.2 * power;
  P.frames = 16; P.fps = 28; P.frame = 0;
  P.mode = Billboard.Camera;
  P.r0 = 2.6; P.g0 = 1.7; P.b0 = 0.85; P.a0 = 1;
  P.r1 = 1.0; P.g1 = 0.2; P.b1 = 0.03; P.a1 = 0;
  P.fadeIn = 0.05; P.fadeOut = 0.5;
  const n = budget(Math.round(8 + power * 10));
  const len = Math.hypot(dx, dy, dz) || 1;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    resetDesc(P);
    P.layer = "flame";
    P.x = x + (dx / len) * t * 2.5 * power + vfxRng.gauss() * 0.2;
    P.y = y + (dy / len) * t * 2.5 * power + vfxRng.gauss() * 0.2;
    P.z = z + (dz / len) * t * 2.5 * power + vfxRng.gauss() * 0.2;
    const sp = (6 + t * 10) * power;
    P.vx = (dx / len) * sp + vfxRng.gauss() * 1.2;
    P.vy = (dy / len) * sp + vfxRng.gauss() * 1.2;
    P.vz = (dz / len) * sp + vfxRng.gauss() * 1.2;
    P.drag = 2.2; P.gravity = 5.5; P.turbulence = 1.6; P.wind = 0.25;
    P.life = 0.35 + vfxRng.range(0, 0.4) * power;
    P.size0 = 0.4 * power * vfxRng.range(0.7, 1.4);
    P.size1 = 2.0 * power * vfxRng.range(0.7, 1.4);
    P.frames = 16; P.fps = 28; P.frame = vfxRng.int(0, 15);
    P.r0 = 2.6; P.g0 = 1.7; P.b0 = 0.85; P.a0 = 1;
    P.r1 = 1.0; P.g1 = 0.2; P.b1 = 0.03; P.a1 = 0;
    P.fadeIn = 0.05; P.fadeOut = 0.5;
    particles.emit(P);
  }
}

/** Clear the flammable registry — level teardown only. */
export function clearFlammables(): void {
  flammables.length = 0;
}

/** Count of registered flammables, for the debug overlay. */
export function flammableCount(): number {
  return flammables.length;
}
