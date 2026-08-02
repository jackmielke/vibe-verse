/**
 * The traps: what each one looks like armed, and what it does when it goes off.
 *
 * The design rule for all eight is **you must be able to see it from across the
 * room**. A trap you cannot see is a trap you cannot plan around, and the whole
 * back half of this game is planning: knowing the paint cans are hanging over
 * the stairs is what makes running *towards* the stairs a decision instead of
 * a panic. So every armed trap gets a shape and a colour that reads at ten
 * metres in the dark, and a soft marker light under it.
 *
 * Each also gets a firing animation of about a second — long enough to watch,
 * short enough that a burglar going down is not a cutscene you sit through
 * while his partner walks up behind you.
 */
import * as THREE from "three";
import { TRAPS, type TrapKind, type TrapSpot } from "./house";
import * as T from "./textures";

export interface TrapVisual {
  spot: TrapSpot;
  group: THREE.Group;
  /** The bit that swings, drops, flashes or scatters. */
  actor: THREE.Object3D | null;
  marker: THREE.PointLight;
  armed: boolean;
  /** Counts down from 1 while the trap is going off. */
  firing: number;
  spent: boolean;
}

export interface TrapRig {
  visuals: Map<TrapKind, TrapVisual>;
  arm(kind: TrapKind, on: boolean): void;
  /** Fire a trap and return its spot, or null if it was not armed. */
  fire(kind: TrapKind): TrapSpot | null;
  reset(): void;
  update(dt: number, t: number): void;
  dispose(): void;
}

export function buildTraps(parent: THREE.Object3D): TrapRig {
  const owned: Array<{ dispose(): void }> = [];
  const keep = <M extends THREE.Material | THREE.BufferGeometry>(m: M) => {
    owned.push(m);
    return m;
  };
  const BOX = keep(new THREE.BoxGeometry(1, 1, 1));
  const SPH = keep(new THREE.SphereGeometry(0.5, 10, 8));
  const mat = (color: number, opts: THREE.MeshStandardMaterialParameters = {}) =>
    keep(new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...opts }));
  const glow = (color: number) => keep(new THREE.MeshBasicMaterial({ color }));

  const visuals = new Map<TrapKind, TrapVisual>();

  const put = (
    g: THREE.Object3D,
    m: THREE.Material,
    geo: THREE.BufferGeometry,
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
  ) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.scale.set(sx, sy, sz);
    g.add(o);
    return o;
  };

  for (const spot of TRAPS) {
    const group = new THREE.Group();
    group.position.set(spot.x, spot.y, spot.z);
    group.visible = false;
    parent.add(group);

    let actor: THREE.Object3D | null = null;

    switch (spot.kind) {
      case "cars": {
        // A scatter of die-cast cars, all primary colours, all pointing wrong.
        const colours = [0xd6392f, 0x2f6fd6, 0xf2c53d, 0x3ea864, 0xe07a2f, 0xc84fc0];
        for (let i = 0; i < 22; i++) {
          const a = i * 2.4;
          const r = 0.25 + (i / 22) * 1.15;
          const c = new THREE.Group();
          c.position.set(Math.cos(a) * r, 0.035, Math.sin(a) * r);
          c.rotation.y = a * 3.1;
          put(c, mat(colours[i % colours.length], { metalness: 0.4, roughness: 0.35 }), BOX, 0, 0, 0, 0.15, 0.055, 0.08);
          put(c, mat(0x1a1a1e), BOX, 0, -0.02, 0, 0.16, 0.03, 0.09);
          group.add(c);
        }
        break;
      }
      case "tar": {
        // A black sheet down the steps, with one bright nail waiting in it.
        const sheet = put(group, mat(0x0b0b0d, { roughness: 0.12, metalness: 0.55 }), BOX, 0, 0.02, 0, 3.1, 0.03, 1.3);
        sheet.rotation.z = Math.atan2(2.95, 4.2) * 0.0;
        const nail = put(group, glow(0xd8d8e0), BOX, 0.3, 0.09, 0.1, 0.03, 0.14, 0.03);
        actor = nail;
        break;
      }
      case "iron": {
        // Hanging in the chute mouth on its cord, waiting.
        const cord = put(group, mat(0x8d7f6d), BOX, 0, 1.55, 0.28, 0.015, 0.9, 0.015);
        const iron = new THREE.Group();
        iron.position.set(0, 1.08, 0.28);
        put(iron, mat(0x9aa0a8, { metalness: 0.8, roughness: 0.3 }), BOX, 0, 0, 0, 0.16, 0.11, 0.3);
        put(iron, mat(0x2a2a30), BOX, 0, 0.09, -0.02, 0.07, 0.08, 0.22);
        group.add(iron);
        actor = iron;
        void cord;
        break;
      }
      case "torch": {
        const body = put(group, mat(0x3a4a3a, { metalness: 0.5 }), BOX, 0, 2.2, 0.16, 0.12, 0.3, 0.12);
        const flame = put(group, glow(0x3fa9ff), BOX, 0, 2.02, 0.16, 0.05, 0.16, 0.05);
        flame.visible = false;
        actor = flame;
        void body;
        break;
      }
      case "paint": {
        // Two cans on a rope at the top of the flight. The rope is the tell.
        const rope = put(group, mat(0x8d7f6d), BOX, 0, 1.35, 0, 0.014, 2.7, 0.014);
        const cans = new THREE.Group();
        cans.position.y = 1.3;
        for (const s of [-0.22, 0.22]) {
          const c = put(cans, mat(0xd8d4c4, { metalness: 0.55, roughness: 0.35 }), BOX, s, 0, 0, 0.26, 0.3, 0.26);
          put(cans, mat(0x8e1f28), BOX, s, 0.02, 0.132, 0.2, 0.13, 0.01);
          void c;
        }
        group.add(cans);
        actor = cans;
        void rope;
        break;
      }
      case "ornaments": {
        const colours = [0xd6392f, 0xf2c53d, 0x3ea864, 0x4f9ad6, 0xc84fc0];
        for (let i = 0; i < 26; i++) {
          const a = i * 1.7;
          const r = 0.2 + (i / 26) * 1.3;
          put(group, mat(colours[i % colours.length], { metalness: 0.75, roughness: 0.12 }), SPH,
            Math.cos(a) * r, 0.05, Math.sin(a) * r, 0.11, 0.11, 0.11);
        }
        break;
      }
      case "glue": {
        const pool = put(group, mat(0xe8e2c8, { roughness: 0.15, metalness: 0.2 }), BOX, 0, 0.015, 0, 1.5, 0.02, 1.1);
        const feathers = new THREE.Group();
        for (let i = 0; i < 30; i++) {
          const a = i * 2.2;
          const r = Math.sqrt(i / 30) * 0.7;
          const f = put(feathers, mat(0xf6f2e8), BOX, Math.cos(a) * r, 0.05 + (i % 4) * 0.02, Math.sin(a) * r, 0.09, 0.012, 0.03);
          f.rotation.y = a;
        }
        group.add(feathers);
        actor = feathers;
        void pool;
        break;
      }
      case "doorknob": {
        const knob = put(group, glow(0xff5a1e), SPH, 0, 1.05, 0.1, 0.13, 0.13, 0.13);
        actor = knob;
        break;
      }
    }

    const marker = new THREE.PointLight(0x6fe0ff, 0.9, 3.4, 2);
    marker.position.set(0, 0.5, 0);
    group.add(marker);

    visuals.set(spot.kind, { spot, group, actor, marker, armed: false, firing: 0, spent: false });
  }

  /* Sparks and glass shards, shared by every trap that needs a burst. */
  const BURST = 90;
  const burstPos = new Float32Array(BURST * 3);
  const burstVel = new Float32Array(BURST * 3);
  const burstGeo = keep(new THREE.BufferGeometry());
  burstGeo.setAttribute("position", new THREE.BufferAttribute(burstPos, 3));
  const burstMat = keep(
    new THREE.PointsMaterial({
      map: T.softDot(), size: 0.13, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  const burst = new THREE.Points(burstGeo, burstMat);
  burst.frustumCulled = false;
  parent.add(burst);
  let burstLife = 0;

  function spark(x: number, y: number, z: number, colour: number, spread = 2.6) {
    burstMat.color.setHex(colour);
    for (let i = 0; i < BURST; i++) {
      burstPos[i * 3] = x;
      burstPos[i * 3 + 1] = y;
      burstPos[i * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      burstVel[i * 3] = Math.cos(a) * spread * (0.3 + Math.random());
      burstVel[i * 3 + 1] = up * spread * 1.2;
      burstVel[i * 3 + 2] = Math.sin(a) * spread * (0.3 + Math.random());
    }
    burstGeo.attributes.position.needsUpdate = true;
    burstLife = 1;
  }

  const rig: TrapRig = {
    visuals,
    arm(kind, on) {
      const v = visuals.get(kind);
      if (!v || v.spent) return;
      v.armed = on;
      v.group.visible = on;
      v.marker.intensity = on ? 0.9 : 0;
    },
    fire(kind) {
      const v = visuals.get(kind);
      if (!v || !v.armed || v.spent || v.firing > 0) return null;
      v.firing = 1;
      v.marker.color.setHex(0xffa23a);
      const p = v.group.position;
      switch (kind) {
        case "cars": spark(p.x, p.y + 0.3, p.z, 0xffd9a0, 2.0); break;
        case "ornaments": spark(p.x, p.y + 0.3, p.z, 0xcfeaff, 2.4); break;
        case "torch": case "doorknob": spark(p.x, p.y + 1.4, p.z, 0xff7a28, 2.2); break;
        case "iron": spark(p.x, p.y + 1.2, p.z, 0xdfe6f0, 1.8); break;
        case "paint": spark(p.x, p.y + 1.2, p.z, 0xf2eee0, 2.6); break;
        case "glue": spark(p.x, p.y + 0.6, p.z, 0xfffaf0, 2.0); break;
        case "tar": spark(p.x, p.y + 0.4, p.z, 0x6fe0ff, 1.6); break;
      }
      return v.spot;
    },
    reset() {
      for (const v of visuals.values()) {
        v.armed = false;
        v.spent = false;
        v.firing = 0;
        v.group.visible = false;
        v.marker.color.setHex(0x6fe0ff);
        v.marker.intensity = 0;
        if (v.actor) {
          v.actor.position.y = v.spot.kind === "iron" ? 1.08 : v.spot.kind === "paint" ? 1.3 : v.actor.position.y;
          v.actor.rotation.set(0, 0, 0);
          v.actor.visible = v.spot.kind !== "torch";
        }
      }
      burstLife = 0;
      burstMat.opacity = 0;
    },
    update(dt, t) {
      for (const v of visuals.values()) {
        if (!v.group.visible) continue;
        // Armed idle: the marker breathes so a set trap is legible in the dark.
        if (v.armed && v.firing <= 0) {
          v.marker.intensity = 0.55 + Math.sin(t * 2.4 + v.spot.x) * 0.3;
          if (v.spot.kind === "paint" && v.actor) v.actor.rotation.z = Math.sin(t * 1.3) * 0.05;
          if (v.spot.kind === "iron" && v.actor) v.actor.rotation.x = Math.sin(t * 1.1) * 0.08;
          if (v.spot.kind === "doorknob" && v.actor) v.actor.scale.setScalar(0.13 * (1 + Math.sin(t * 5) * 0.08));
        }
        if (v.firing > 0) {
          v.firing = Math.max(0, v.firing - dt * 1.1);
          const f = 1 - v.firing; // 0 → 1 across the animation
          v.marker.intensity = v.firing * 5;
          const a = v.actor;
          if (a) {
            switch (v.spot.kind) {
              case "iron": a.position.y = 1.08 - f * 1.9; a.rotation.x = f * 6; break;
              case "paint": a.position.y = 1.3 - f * 1.15; a.rotation.z = f * 3.4; break;
              case "torch": a.visible = f < 0.75; a.scale.setScalar(1 + Math.sin(f * 30) * 0.4); break;
              case "doorknob": a.scale.setScalar(0.13 * (1 + f * 1.4)); break;
              case "glue": a.position.y = f * 0.8; a.rotation.y = f * 3; break;
              case "tar": a.position.y = 0.09 + f * 0.6; break;
            }
          }
          if (v.firing <= 0) {
            v.spent = true;
            v.armed = false;
            v.group.visible = false;
            v.marker.intensity = 0;
          }
        }
      }
      if (burstLife > 0) {
        burstLife = Math.max(0, burstLife - dt * 1.3);
        burstMat.opacity = burstLife * 0.9;
        for (let i = 0; i < BURST; i++) {
          burstVel[i * 3 + 1] -= 9.8 * dt;
          burstPos[i * 3] += burstVel[i * 3] * dt;
          burstPos[i * 3 + 1] += burstVel[i * 3 + 1] * dt;
          burstPos[i * 3 + 2] += burstVel[i * 3 + 2] * dt;
        }
        burstGeo.attributes.position.needsUpdate = true;
      }
    },
    dispose() {
      for (const o of owned) o.dispose();
    },
  };

  return rig;
}
