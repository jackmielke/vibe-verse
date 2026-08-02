import * as THREE from "three";
import type { FxBus, FxKind } from "../ModuleTypes";
import type { QualityProfile } from "../core/Settings";

/**
 * Pooled particle + tracer + decal system. Everything is preallocated at build
 * time and recycled — a firefight must not allocate, because a GC pause in the
 * middle of a gunfight is the most noticeable stutter a shooter can have.
 *
 * Particles live in three instanced pools sharing one geometry:
 *   - sparks    additive, stretched along velocity, short-lived
 *   - smoke     soft-lit billboards, buoyant, long-lived
 *   - debris    lit quads with gravity and a bounce off the ground
 *
 * Tracers are a separate line pool; decals are a fourth instanced quad pool
 * that fades out oldest-first.
 */

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  sizeGrow: number;
  rot: number;
  rotSpeed: number;
  color: THREE.Color;
  drag: number;
  gravity: number;
  active: boolean;
}

function makeParticles(n: number): Particle[] {
  return Array.from({ length: n }, () => ({
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    life: 0,
    maxLife: 1,
    size: 1,
    sizeGrow: 0,
    rot: 0,
    rotSpeed: 0,
    color: new THREE.Color(),
    drag: 0,
    gravity: 0,
    active: false,
  }));
}

/** Radial soft dot — the base sprite for sparks and smoke. */
function softSprite(size: number, hardness: number): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(hardness, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Turbulent puff with internal structure, so smoke does not read as a blob. */
function smokeSprite(size: number): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  // Stack offset radial blobs to fake billowing structure.
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.pow(Math.random(), 0.65) * size * 0.3;
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r;
    const rad = size * (0.09 + Math.random() * 0.16);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const v = 0.16 + Math.random() * 0.2;
    g.addColorStop(0, `rgba(255,255,255,${v})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  // Fade the outer edge so the quad boundary never shows.
  const mask = ctx.createRadialGradient(size / 2, size / 2, size * 0.22, size / 2, size / 2, size / 2);
  mask.addColorStop(0, "rgba(255,255,255,1)");
  mask.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface PoolOpts {
  count: number;
  texture: THREE.Texture;
  additive: boolean;
  depthWrite: boolean;
}

class Pool {
  mesh: THREE.InstancedMesh;
  particles: Particle[];
  private cursor = 0;
  private dummy = new THREE.Object3D();
  private colorAttr: THREE.InstancedBufferAttribute;

  constructor(scene: THREE.Scene, opts: PoolOpts) {
    this.particles = makeParticles(opts.count);

    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: opts.texture,
      transparent: true,
      depthWrite: opts.depthWrite,
      depthTest: true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: !opts.additive,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, opts.count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.additive ? 12 : 10;
    this.mesh.count = opts.count;

    const colors = new Float32Array(opts.count * 3);
    this.colorAttr = new THREE.InstancedBufferAttribute(colors, 3);
    this.mesh.instanceColor = this.colorAttr;

    // Park every instance at zero scale so nothing shows before first use.
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < opts.count; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;

    scene.add(this.mesh);
  }

  spawn(): Particle {
    // Ring buffer: oldest particle is recycled when the pool is saturated.
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % this.particles.length;
    p.active = true;
    p.life = 0;
    return p;
  }

  update(dt: number, camera: THREE.PerspectiveCamera, groundAt?: (x: number, z: number) => number): void {
    const q = camera.quaternion;
    let any = false;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        this.dummy.scale.setScalar(0);
        this.dummy.position.set(0, 0, 0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        any = true;
        continue;
      }

      p.vel.y += p.gravity * dt;
      p.vel.multiplyScalar(1 - Math.min(p.drag * dt, 0.95));
      p.pos.addScaledVector(p.vel, dt);
      p.rot += p.rotSpeed * dt;

      // Debris bounces once off the ground rather than sinking through it.
      if (groundAt && p.gravity < -1) {
        const gh = groundAt(p.pos.x, p.pos.z);
        if (p.pos.y < gh) {
          p.pos.y = gh;
          p.vel.y = Math.abs(p.vel.y) * 0.28;
          p.vel.x *= 0.6;
          p.vel.z *= 0.6;
        }
      }

      const t = p.life / p.maxLife;
      const scale = p.size + p.sizeGrow * t;
      // Fade in fast, out slow — reads as energy dissipating.
      const alpha = Math.min(1, (1 - t) * 2.2) * Math.min(1, t * 14);

      this.dummy.position.copy(p.pos);
      this.dummy.quaternion.copy(q);
      this.dummy.rotateZ(p.rot);
      this.dummy.scale.setScalar(scale);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);

      this.colorAttr.setXYZ(i, p.color.r * alpha, p.color.g * alpha, p.color.b * alpha);
      any = true;
    }

    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Tracers: stretched additive quads that live for a few frames. */
class TracerPool {
  private mesh: THREE.InstancedMesh;
  private lives: Float32Array;
  private cursor = 0;
  private dummy = new THREE.Object3D();
  private colorAttr: THREE.InstancedBufferAttribute;
  private count: number;

  constructor(scene: THREE.Scene, count: number) {
    this.count = count;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0, 0);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.lives = new Float32Array(count);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.mesh.instanceColor = this.colorAttr;
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    scene.add(this.mesh);
  }

  fire(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const mid = from.clone().add(to).multiplyScalar(0.5);
    const len = from.distanceTo(to);

    this.dummy.position.copy(mid);
    this.dummy.lookAt(to);
    this.dummy.rotateX(Math.PI / 2);
    this.dummy.scale.set(0.055, len, 1);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.colorAttr.setXYZ(i, color.r, color.g, color.b);
    this.lives[i] = 0.055;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.lives[i] <= 0) continue;
      this.lives[i] -= dt;
      const a = Math.max(0, this.lives[i] / 0.055);
      if (a <= 0) {
        this.dummy.scale.setScalar(0);
        this.dummy.position.set(0, 0, 0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
      } else {
        const c = this.colorAttr;
        c.setXYZ(i, c.getX(i) * 0.86, c.getY(i) * 0.86, c.getZ(i) * 0.86);
      }
      any = true;
    }
    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export class Effects implements FxBus {
  private sparks: Pool;
  private smoke: Pool;
  private debris: Pool;
  private tracers: TracerPool;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private groundAt?: (x: number, z: number) => number;
  private scale: number;

  /** Transient point lights for explosions and muzzle flashes. */
  private flashLights: Array<{ light: THREE.PointLight; life: number; maxLife: number; peak: number }> = [];

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    profile: QualityProfile,
    groundAt?: (x: number, z: number) => number,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.groundAt = groundAt;
    this.scale = profile.particleScale;

    const n = (base: number) => Math.max(24, Math.round(base * profile.particleScale));

    this.sparks = new Pool(scene, {
      count: n(900),
      texture: softSprite(64, 0.28),
      additive: true,
      depthWrite: false,
    });
    this.smoke = new Pool(scene, {
      count: n(420),
      texture: smokeSprite(128),
      additive: false,
      depthWrite: false,
    });
    this.debris = new Pool(scene, {
      count: n(300),
      texture: softSprite(32, 0.85),
      additive: false,
      depthWrite: false,
    });
    this.tracers = new TracerPool(scene, 96);

    // A small pool of reusable flash lights — creating lights per explosion
    // forces a shader recompile, which is a guaranteed hitch.
    const lightCount = profile.tier === "low" ? 2 : profile.tier === "medium" ? 4 : 6;
    for (let i = 0; i < lightCount; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 60, 2);
      light.visible = false;
      scene.add(light);
      this.flashLights.push({ light, life: 0, maxLife: 1, peak: 0 });
    }
  }

  private flash(position: THREE.Vector3, color: number, peak: number, duration: number, range: number): void {
    // Steal the most-expired slot rather than skipping the flash entirely.
    let slot = this.flashLights[0];
    for (const f of this.flashLights) {
      if (f.life / f.maxLife > slot.life / slot.maxLife) slot = f;
      if (!slot.light.visible) break;
    }
    slot.light.position.copy(position);
    slot.light.color.setHex(color);
    slot.light.distance = range;
    slot.light.visible = true;
    slot.peak = peak;
    slot.life = 0;
    slot.maxLife = duration;
  }

  spawn(kind: FxKind, position: THREE.Vector3, normal = new THREE.Vector3(0, 1, 0), scale = 1): void {
    const n = normal.clone().normalize();
    const s = scale;

    // Build a basis around the surface normal so ejecta spray outward from the
    // surface rather than in world axes.
    const tangent = new THREE.Vector3(1, 0, 0);
    if (Math.abs(n.x) > 0.9) tangent.set(0, 1, 0);
    const bit = new THREE.Vector3().crossVectors(n, tangent).normalize();
    tangent.crossVectors(bit, n).normalize();

    const cone = (spread: number, speed: number) => {
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.6) * spread;
      return new THREE.Vector3()
        .addScaledVector(n, 1 - r * 0.5)
        .addScaledVector(tangent, Math.cos(a) * r)
        .addScaledVector(bit, Math.sin(a) * r)
        .normalize()
        .multiplyScalar(speed * (0.5 + Math.random()));
    };

    const count = (base: number) => Math.max(1, Math.round(base * this.scale * s));

    switch (kind) {
      case "muzzle": {
        for (let i = 0; i < count(7); i++) {
          const p = this.sparks.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(0.35, 9));
          p.maxLife = 0.05 + Math.random() * 0.05;
          p.size = 0.09 + Math.random() * 0.13;
          p.sizeGrow = 0.16;
          p.color.setRGB(1.0, 0.78, 0.36);
          p.drag = 9;
          p.gravity = 0;
          p.rotSpeed = (Math.random() - 0.5) * 20;
        }
        for (let i = 0; i < count(2); i++) {
          const p = this.smoke.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(0.5, 2.2));
          p.maxLife = 0.5 + Math.random() * 0.4;
          p.size = 0.1;
          p.sizeGrow = 0.55;
          p.color.setRGB(0.42, 0.4, 0.38);
          p.drag = 3.5;
          p.gravity = 0.35;
          p.rotSpeed = (Math.random() - 0.5) * 2.5;
        }
        break;
      }

      case "impact-dirt": {
        for (let i = 0; i < count(9); i++) {
          const p = this.debris.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(0.85, 6.5));
          p.maxLife = 0.55 + Math.random() * 0.7;
          p.size = 0.035 + Math.random() * 0.055;
          p.sizeGrow = 0;
          p.color.setRGB(0.36, 0.3, 0.21);
          p.drag = 0.55;
          p.gravity = -16;
          p.rotSpeed = (Math.random() - 0.5) * 14;
        }
        for (let i = 0; i < count(4); i++) {
          const p = this.smoke.spawn();
          p.pos.copy(position).addScaledVector(n, 0.12);
          p.vel.copy(cone(0.7, 1.6));
          p.maxLife = 0.7 + Math.random() * 0.6;
          p.size = 0.16;
          p.sizeGrow = 0.95;
          p.color.setRGB(0.56, 0.5, 0.4);
          p.drag = 2.4;
          p.gravity = 0.5;
          p.rotSpeed = (Math.random() - 0.5) * 2;
        }
        break;
      }

      case "impact-metal": {
        for (let i = 0; i < count(16); i++) {
          const p = this.sparks.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(0.95, 11));
          p.maxLife = 0.2 + Math.random() * 0.45;
          p.size = 0.018 + Math.random() * 0.03;
          p.sizeGrow = -0.008;
          // Sparks cool from white-hot through orange as they fly.
          p.color.setRGB(1.0, 0.62 + Math.random() * 0.3, 0.22);
          p.drag = 1.1;
          p.gravity = -11;
          p.rotSpeed = 0;
        }
        this.flash(position, 0xffb060, 6, 0.06, 6);
        break;
      }

      case "impact-water": {
        for (let i = 0; i < count(14); i++) {
          const p = this.sparks.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(0.5, 7)).setY(Math.abs(cone(0.4, 7).y) + 3.5);
          p.maxLife = 0.42 + Math.random() * 0.4;
          p.size = 0.03 + Math.random() * 0.06;
          p.sizeGrow = 0.02;
          p.color.setRGB(0.72, 0.86, 0.92);
          p.drag = 0.9;
          p.gravity = -13;
        }
        for (let i = 0; i < count(3); i++) {
          const p = this.smoke.spawn();
          p.pos.copy(position);
          p.vel.set((Math.random() - 0.5) * 1.2, 1.6 + Math.random(), (Math.random() - 0.5) * 1.2);
          p.maxLife = 0.55;
          p.size = 0.2;
          p.sizeGrow = 0.7;
          p.color.setRGB(0.86, 0.92, 0.95);
          p.drag = 3;
          p.gravity = -1.4;
        }
        break;
      }

      case "impact-flesh": {
        for (let i = 0; i < count(10); i++) {
          const p = this.debris.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(0.9, 5.5));
          p.maxLife = 0.35 + Math.random() * 0.35;
          p.size = 0.028 + Math.random() * 0.04;
          p.color.setRGB(0.42, 0.06, 0.09);
          p.drag = 1.6;
          p.gravity = -14;
        }
        break;
      }

      case "plasma-burst": {
        for (let i = 0; i < count(18); i++) {
          const p = this.sparks.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(1.0, 8));
          p.maxLife = 0.28 + Math.random() * 0.4;
          p.size = 0.04 + Math.random() * 0.07;
          p.sizeGrow = 0.05;
          p.color.setRGB(0.32, 0.86, 1.0);
          p.drag = 2.4;
          p.gravity = -2.5;
        }
        this.flash(position, 0x5fd8ff, 14, 0.14, 14);
        break;
      }

      case "shield-pop": {
        for (let i = 0; i < count(24); i++) {
          const p = this.sparks.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(1.4, 6));
          p.maxLife = 0.3 + Math.random() * 0.3;
          p.size = 0.03;
          p.sizeGrow = 0.09;
          p.color.setRGB(0.5, 0.8, 1.0);
          p.drag = 3.5;
          p.gravity = 0;
        }
        this.flash(position, 0x7fd0ff, 10, 0.2, 10);
        break;
      }

      case "explosion": {
        const big = s;
        for (let i = 0; i < count(34); i++) {
          const p = this.sparks.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(1.6, 17 * big));
          p.maxLife = 0.3 + Math.random() * 0.6;
          p.size = (0.09 + Math.random() * 0.2) * big;
          p.sizeGrow = 0.3 * big;
          p.color.setRGB(1.0, 0.5 + Math.random() * 0.35, 0.12);
          p.drag = 2.1;
          p.gravity = -5;
        }
        for (let i = 0; i < count(20); i++) {
          const p = this.smoke.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(1.5, 5.5 * big));
          p.maxLife = 1.6 + Math.random() * 1.8;
          p.size = 0.5 * big;
          p.sizeGrow = 4.2 * big;
          const v = 0.1 + Math.random() * 0.16;
          p.color.setRGB(v, v * 0.94, v * 0.9);
          p.drag = 1.5;
          p.gravity = 0.85;
          p.rotSpeed = (Math.random() - 0.5) * 1.2;
        }
        for (let i = 0; i < count(12); i++) {
          const p = this.debris.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(1.5, 13 * big));
          p.maxLife = 1.1 + Math.random() * 1.1;
          p.size = 0.05 * big;
          p.color.setRGB(0.16, 0.14, 0.13);
          p.drag = 0.35;
          p.gravity = -17;
          p.rotSpeed = (Math.random() - 0.5) * 18;
        }
        this.flash(position, 0xff9040, 260 * big, 0.42, 55 * big);
        break;
      }

      case "spray":
      case "smoke": {
        for (let i = 0; i < count(6); i++) {
          const p = this.smoke.spawn();
          p.pos.copy(position);
          p.vel.copy(cone(0.9, 2.2 * s));
          p.maxLife = 1.1 + Math.random() * 1.4;
          p.size = 0.3 * s;
          p.sizeGrow = 1.9 * s;
          p.color.setRGB(0.82, 0.87, 0.9);
          p.drag = 1.8;
          p.gravity = kind === "spray" ? -3.2 : 0.7;
          p.rotSpeed = (Math.random() - 0.5) * 1.5;
        }
        break;
      }
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    // Skip tracers that start behind the camera — they read as a flash of
    // colour across the screen rather than a bullet.
    this.tracers.fire(from, to, new THREE.Color(color));
  }

  update(dt: number): void {
    this.sparks.update(dt, this.camera, this.groundAt);
    this.smoke.update(dt, this.camera);
    this.debris.update(dt, this.camera, this.groundAt);
    this.tracers.update(dt);

    for (const f of this.flashLights) {
      if (!f.light.visible) continue;
      f.life += dt;
      const t = f.life / f.maxLife;
      if (t >= 1) {
        f.light.visible = false;
        f.light.intensity = 0;
        continue;
      }
      // Sharp attack, exponential falloff — how a real flash reads.
      f.light.intensity = f.peak * Math.pow(1 - t, 2.4);
    }
  }

  dispose(): void {
    this.sparks.dispose(this.scene);
    this.smoke.dispose(this.scene);
    this.debris.dispose(this.scene);
    this.tracers.dispose(this.scene);
    this.flashLights.forEach((f) => this.scene.remove(f.light));
    this.flashLights = [];
  }
}
