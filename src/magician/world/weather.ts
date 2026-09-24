/**
 * Things in the air: rain, snow, petals, fireflies, and the lightning.
 *
 * Every particle system is one `Points` recycled inside a box that follows
 * the player, so the world can be any size and the cost is constant. Density
 * is a *target* the system eases toward: rain fades in over a couple of
 * seconds rather than switching on, which is the difference between weather
 * and a light switch.
 */
import * as THREE from "three";
import { makeSoftDot } from "./sky";

export interface Particles {
  object: THREE.Object3D;
  setDensity(d: number): void;
  update(dt: number, time: number, centre: THREE.Vector3, wind: number, windDir: number): void;
  dispose(): void;
}

interface Opts {
  count: number;
  color: string;
  size: number;
  /** m/s downward. */
  fall: number;
  /** How much the wind pushes, m/s at wind=1. */
  drift: number;
  /** Extra wobble for petals and snow. */
  flutter: number;
  box: number;
  height: number;
  additive?: boolean;
  /** Streaks: draw as short vertical lines instead of points. */
  streak?: number;
  opacity?: number;
}

function makeParticles(opts: Opts): Particles {
  const n = opts.count;
  const pos = new Float32Array(n * (opts.streak ? 6 : 3));
  const seeds = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    seeds[i * 2] = Math.random() * 10;
    seeds[i * 2 + 1] = Math.random() * 10;
  }
  const local = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    local[i * 3] = (Math.random() - 0.5) * opts.box;
    local[i * 3 + 1] = Math.random() * opts.height;
    local[i * 3 + 2] = (Math.random() - 0.5) * opts.box;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  let object: THREE.Object3D;
  let material: THREE.Material;
  const tex = opts.streak ? null : makeSoftDot(opts.color);
  if (opts.streak) {
    material = new THREE.LineBasicMaterial({ color: opts.color, transparent: true, opacity: 0, depthWrite: false });
    object = new THREE.LineSegments(geo, material);
  } else {
    material = new THREE.PointsMaterial({
      map: tex!, color: opts.color, size: opts.size, transparent: true, opacity: 0, depthWrite: false,
      sizeAttenuation: true, blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    object = new THREE.Points(geo, material);
  }
  object.frustumCulled = false;
  let density = 0;
  let shown = 0;
  const maxOpacity = opts.opacity ?? 0.9;
  return {
    object,
    setDensity(d) { density = Math.max(0, Math.min(1, d)); },
    update(dt, time, centre, wind, windDir) {
      shown += (density - shown) * Math.min(1, dt * 0.6);
      (material as THREE.PointsMaterial).opacity = shown * maxOpacity;
      object.visible = shown > 0.01;
      if (!object.visible) return;
      const active = Math.floor(n * Math.max(shown, 0.05));
      const wx = Math.sin(windDir) * wind * opts.drift;
      const wz = Math.cos(windDir) * wind * opts.drift;
      const half = opts.box / 2;
      for (let i = 0; i < n; i++) {
        const j = i * 3;
        if (i < active) {
          const s1 = seeds[i * 2], s2 = seeds[i * 2 + 1];
          local[j + 1] -= opts.fall * dt * (0.8 + (s1 % 1) * 0.4);
          local[j] += (wx + Math.sin(time * 1.3 + s1) * opts.flutter) * dt;
          local[j + 2] += (wz + Math.cos(time * 1.1 + s2) * opts.flutter) * dt;
          if (local[j + 1] < 0) { local[j + 1] += opts.height; local[j] = (Math.random() - 0.5) * opts.box; local[j + 2] = (Math.random() - 0.5) * opts.box; }
          // Wrap around the centre.
          let x = local[j] - (centre.x - Math.floor((local[j] + half) / opts.box) * 0) ;
          x = local[j];
          if (x > half) local[j] -= opts.box; else if (x < -half) local[j] += opts.box;
          if (local[j + 2] > half) local[j + 2] -= opts.box; else if (local[j + 2] < -half) local[j + 2] += opts.box;
        }
        const px = centre.x + local[j], py = centre.y - 2 + local[j + 1], pz = centre.z + local[j + 2];
        if (opts.streak) {
          const k = i * 6;
          const hide = i >= active ? -9999 : 0;
          pos[k] = px; pos[k + 1] = py + hide; pos[k + 2] = pz;
          pos[k + 3] = px + wx * 0.02; pos[k + 4] = py - opts.streak + hide; pos[k + 5] = pz + wz * 0.02;
        } else {
          // Anything within a metre and a half of the eye is hidden: a petal
          // at arm's length is drawn the size of a plate.
          const dx = px - centre.x, dy = py - centre.y, dz = pz - centre.z;
          const tooNear = dx * dx + dy * dy + dz * dz < 2.25;
          pos[j] = px; pos[j + 1] = i >= active || tooNear ? -9999 : py; pos[j + 2] = pz;
        }
      }
      (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    },
    dispose() { geo.dispose(); material.dispose(); tex?.dispose(); },
  };
}

export function createRain(): Particles {
  return makeParticles({ count: 1800, color: "#bcd4ea", size: 0.1, fall: 22, drift: 8, flutter: 0, box: 50, height: 28, streak: 0.55, opacity: 0.45 });
}

export function createSnow(): Particles {
  return makeParticles({ count: 1400, color: "#ffffff", size: 0.22, fall: 1.6, drift: 5, flutter: 0.6, box: 46, height: 24, opacity: 0.95 });
}

export function createPetals(color = "#ffc0dc"): Particles {
  return makeParticles({ count: 500, color, size: 0.18, fall: 0.9, drift: 6, flutter: 1.2, box: 44, height: 16, opacity: 0.9 });
}

export function createFireflies(): Particles {
  const p = makeParticles({ count: 220, color: "#d9ff6a", size: 0.16, fall: -0.15, drift: 0.8, flutter: 1.4, box: 60, height: 6, additive: true, opacity: 0.9 });
  const inner = p.update;
  const mat = ((p.object as THREE.Points).material as THREE.PointsMaterial);
  p.update = (dt, time, centre, wind, windDir) => {
    inner(dt, time, centre, wind, windDir);
    mat.size = 0.14 + Math.sin(time * 4) * 0.05;
  };
  return p;
}

/** Sky-wide flashes on a storm, with a callback for thunder. */
export interface Lightning {
  light: THREE.DirectionalLight;
  /** 0–1 flash intensity this frame, for whoever wants to react. */
  flash: number;
  update(dt: number, storm: boolean, onStrike: () => void): void;
}

export function createLightning(): Lightning {
  const light = new THREE.DirectionalLight("#dfe8ff", 0);
  light.position.set(30, 80, -40);
  let cooldown = 3;
  const l: Lightning = {
    light,
    flash: 0,
    update(dt, storm, onStrike) {
      cooldown -= dt;
      if (storm && cooldown <= 0) {
        l.flash = 1;
        cooldown = 4 + Math.random() * 9;
        setTimeout(onStrike, 300 + Math.random() * 1500);
      }
      l.flash = Math.max(0, l.flash - dt * 4);
      // Double-flicker.
      const f = l.flash > 0.75 ? l.flash : l.flash > 0.5 ? 0 : l.flash;
      light.intensity = f * 6;
    },
  };
  return l;
}

/** A momentary burst at a point: sparkles for a spell, smoke for a vanish. */
export interface Bursts {
  object: THREE.Object3D;
  spawn(kind: "sparkle" | "smoke", x: number, y: number, z: number): void;
  update(dt: number): void;
  dispose(): void;
}

export function createBursts(): Bursts {
  const group = new THREE.Group();
  const sparkTex = makeSoftDot("#fff4c2");
  const smokeTex = makeSoftDot("#b8b8c0");
  const live: Array<{ points: THREE.Points; vel: Float32Array; age: number; life: number; mat: THREE.PointsMaterial }> = [];
  return {
    object: group,
    spawn(kind, x, y, z) {
      const n = kind === "sparkle" ? 90 : 40;
      const pos = new Float32Array(n * 3);
      const vel = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = x; pos[i * 3 + 1] = y + 0.5; pos[i * 3 + 2] = z;
        const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI - Math.PI / 2;
        const s = kind === "sparkle" ? 3 + Math.random() * 4 : 0.8 + Math.random() * 1.2;
        vel[i * 3] = Math.cos(a) * Math.cos(e) * s;
        vel[i * 3 + 1] = Math.abs(Math.sin(e)) * s + (kind === "smoke" ? 1 : 1.5);
        vel[i * 3 + 2] = Math.sin(a) * Math.cos(e) * s;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        map: kind === "sparkle" ? sparkTex : smokeTex, color: kind === "sparkle" ? "#ffe7a0" : "#c9c9d2",
        size: kind === "sparkle" ? 0.1 : 0.9, transparent: true, depthWrite: false,
        blending: kind === "sparkle" ? THREE.AdditiveBlending : THREE.NormalBlending, opacity: 1,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      group.add(points);
      live.push({ points, vel, age: 0, life: kind === "sparkle" ? 1.4 : 2.2, mat });
    },
    update(dt) {
      for (let k = live.length - 1; k >= 0; k--) {
        const b = live[k];
        b.age += dt;
        const p = b.points.geometry.attributes.position as THREE.BufferAttribute;
        const arr = p.array as Float32Array;
        for (let i = 0; i < arr.length; i += 3) {
          arr[i] += b.vel[i] * dt; arr[i + 1] += b.vel[i + 1] * dt; arr[i + 2] += b.vel[i + 2] * dt;
          b.vel[i + 1] -= (b.life < 2 ? 4 : -0.4) * dt;
          b.vel[i] *= 0.98; b.vel[i + 2] *= 0.98;
        }
        p.needsUpdate = true;
        b.mat.opacity = Math.max(0, 1 - b.age / b.life);
        if (b.life > 2) b.mat.size += dt * 1.2;
        if (b.age >= b.life) {
          group.remove(b.points);
          b.points.geometry.dispose();
          b.mat.dispose();
          live.splice(k, 1);
        }
      }
    },
    dispose() {
      for (const b of live) { b.points.geometry.dispose(); b.mat.dispose(); }
      sparkTex.dispose();
      smokeTex.dispose();
    },
  };
}
