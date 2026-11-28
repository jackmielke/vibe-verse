/**
 * collapse — buildings that take enough damage tip over, and take their
 * neighbours with them.
 *
 * Jack (Nov 28 2026): "if you do enough damage to a building, it can actually
 * tip over and smash into other buildings."
 *
 * The district draws every facade of one colour scheme as ONE merged mesh, and
 * every roof as another, with the rooftop clutter instanced. So there is no
 * building object to rotate. What there is, is a known run of vertices (and a
 * known run of instances) per building, and that is enough: when one falls,
 * those vertices are rotated about the base edge it falls over, every frame,
 * in place. The building that falls is the building you were looking at, with
 * its own windows, not a stand-in box.
 *
 * - Every building has health (`hpFor`). The police chopper's laser, rockets
 *   and cars blowing a facade all take some off. At zero it goes over, away
 *   from whatever did it.
 * - It swings down under gravity about its base edge. When it is about half
 *   way, anything standing in the strip it is falling across takes a heavy
 *   hit, which is usually enough to send that one over too, the same way.
 *   That is the chain.
 * - It lands in a line of dust and fire, lies there for a few seconds, then
 *   sinks into the street so the city does not fill up with rubble.
 * - Its collision goes the moment it starts to fall, so you can drive through
 *   where it stood. Being under it is not fatal: you get bowled over.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";

export type CollapsePart =
  | { kind: "geo"; mesh: THREE.Mesh; start: number; count: number }
  | { kind: "inst"; im: THREE.InstancedMesh; start: number; end: number };

export interface BuildingRec {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  boxes: WorldBox[];
  parts: CollapsePart[];
}

export type CollapseEvent =
  | { kind: "fall"; id: number; x: number; z: number; height: number }
  | { kind: "crash"; x: number; y: number; z: number; power: number }
  | { kind: "land"; x: number; z: number; dx: number; dz: number; length: number; width: number };

export interface Collapse {
  /** The building whose footprint holds (x, z), standing, or -1. */
  at(x: number, z: number, pad?: number): number;
  /** Standing buildings with any part within `r` of (x, z), nearest first. */
  near(x: number, z: number, r: number): number[];
  /** Where a building is: its centre, height and footprint. */
  info(id: number): { cx: number; cz: number; height: number; minX: number; maxX: number; minZ: number; maxZ: number; hp: number; standing: boolean } | null;
  /** Hurt it. Returns "topple" when that sent it over. */
  damage(id: number, dmg: number, fromX: number, fromZ: number): "none" | "hit" | "topple";
  /** Send it over now, toward (dx, dz). */
  topple(id: number, dx: number, dz: number): boolean;
  onEvent(cb: (e: CollapseEvent) => void): void;
  update(dt: number): void;
  debug(): { buildings: number; down: number; falling: number };
}

/** A building's health: tall ones take more. */
export function hpFor(height: number): number {
  return 110 + height * 1.6;
}

/**
 * One frame of the swing: angle and angular speed after `dt`, for a body of
 * height `h` falling over its base edge (a rod pivoting at one end). A small
 * floor on the push keeps it from balancing upright forever.
 */
export function swing(angle: number, speed: number, h: number, dt: number): [number, number] {
  const acc = (1.5 * 9.8 / Math.max(4, h)) * Math.max(0.12, Math.sin(angle));
  const s = speed + acc * dt;
  return [angle + s * dt, s];
}

/** Distance in the ground plane from a box to the segment a..b. */
export function boxSegmentDistance(
  b: { minX: number; maxX: number; minZ: number; maxZ: number },
  ax: number, az: number, bx: number, bz: number,
): number {
  let best = Infinity;
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const px = ax + (bx - ax) * t;
    const pz = az + (bz - az) * t;
    const dx = Math.max(b.minX - px, 0, px - b.maxX);
    const dz = Math.max(b.minZ - pz, 0, pz - b.maxZ);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

const REST = 1.42;
const LIE_FOR = 5;
const SINK_FOR = 5;

interface B extends BuildingRec {
  id: number;
  cx: number;
  cz: number;
  hp: number;
  state: "up" | "falling" | "lying" | "sinking" | "gone";
  angle: number;
  speed: number;
  t: number;
  dx: number;
  dz: number;
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  sinkTo: number;
  hitOthers: boolean;
  /** Width across the fall, for what it lands on. */
  across: number;
  orig: Array<Float32Array | THREE.Matrix4[] | null>;
  origN: Array<Float32Array | null>;
}

export function createCollapse(recs: BuildingRec[]): Collapse {
  const list: B[] = recs.map((r, id) => ({
    ...r,
    id,
    cx: (r.minX + r.maxX) / 2,
    cz: (r.minZ + r.maxZ) / 2,
    hp: hpFor(r.height),
    state: "up",
    angle: 0,
    speed: 0,
    t: 0,
    dx: 1,
    dz: 0,
    pivot: new THREE.Vector3(),
    axis: new THREE.Vector3(),
    sinkTo: 0,
    hitOthers: false,
    across: 0,
    orig: [],
    origN: [],
  }));
  const listeners: Array<(e: CollapseEvent) => void> = [];
  const emit = (e: CollapseEvent) => listeners.forEach((l) => l(e));
  const moving: B[] = [];
  let down = 0;

  const M = new THREE.Matrix4();
  const R = new THREE.Matrix4();
  const T = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const V = new THREE.Vector3();
  const IM = new THREE.Matrix4();
  const NM = new THREE.Matrix3();

  const pose = (b: B, sink: number) => {
    Q.setFromAxisAngle(b.axis, b.angle);
    R.makeRotationFromQuaternion(Q);
    T.makeTranslation(-b.pivot.x, -b.pivot.y, -b.pivot.z);
    M.makeTranslation(b.pivot.x, b.pivot.y - sink, b.pivot.z).multiply(R).multiply(T);
    NM.setFromMatrix4(R);
    b.parts.forEach((p, i) => {
      if (p.kind === "geo") {
        const pos = p.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
        const nor = p.mesh.geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
        const o = b.orig[i] as Float32Array;
        const on = b.origN[i];
        for (let k = 0; k < p.count; k++) {
          V.set(o[k * 3], o[k * 3 + 1], o[k * 3 + 2]).applyMatrix4(M);
          pos.setXYZ(p.start + k, V.x, V.y, V.z);
          if (nor && on) {
            V.set(on[k * 3], on[k * 3 + 1], on[k * 3 + 2]).applyMatrix3(NM);
            nor.setXYZ(p.start + k, V.x, V.y, V.z);
          }
        }
        pos.needsUpdate = true;
        if (nor) nor.needsUpdate = true;
      } else {
        const o = b.orig[i] as THREE.Matrix4[];
        for (let k = p.start; k < p.end; k++) {
          IM.multiplyMatrices(M, o[k - p.start]);
          p.im.setMatrixAt(k, IM);
        }
        p.im.instanceMatrix.needsUpdate = true;
      }
    });
  };

  const topple = (b: B, dx: number, dz: number) => {
    if (b.state !== "up") return false;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    b.state = "falling";
    b.dx = dx;
    b.dz = dz;
    b.angle = 0.02;
    b.speed = 0.12;
    b.t = 0;
    const hw = (b.maxX - b.minX) / 2;
    const hd = (b.maxZ - b.minZ) / 2;
    const along = Math.abs(dx) * hw + Math.abs(dz) * hd;
    b.across = Math.abs(dz) * hw * 2 + Math.abs(dx) * hd * 2;
    b.pivot.set(b.cx + dx * along, 0, b.cz + dz * along);
    // Rotating +y about (dz, 0, -dx) by a positive angle swings the top toward (dx, dz).
    b.axis.set(dz, 0, -dx).normalize();
    b.sinkTo = along * 2 + 3;
    // Snapshot what it looks like standing, so every frame is a fresh
    // transform of the original rather than an accumulating one.
    b.orig = b.parts.map((p) => {
      if (p.kind === "geo") {
        const pos = p.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
        return (pos.array as Float32Array).slice(p.start * 3, (p.start + p.count) * 3);
      }
      const out: THREE.Matrix4[] = [];
      for (let k = p.start; k < p.end; k++) {
        const m = new THREE.Matrix4();
        p.im.getMatrixAt(k, m);
        out.push(m);
      }
      return out;
    });
    b.origN = b.parts.map((p) => {
      if (p.kind !== "geo") return null;
      const nor = p.mesh.geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
      return nor ? (nor.array as Float32Array).slice(p.start * 3, (p.start + p.count) * 3) : null;
    });
    // Gone from the collision world straight away: the box is shared by
    // reference with everything that asks what is solid.
    for (const box of b.boxes) {
      box.base = -1;
      box.height = 0.02;
    }
    moving.push(b);
    emit({ kind: "fall", id: b.id, x: b.cx, z: b.cz, height: b.height });
    return true;
  };

  const damage = (b: B, dmg: number, fromX: number, fromZ: number): "none" | "hit" | "topple" => {
    if (b.state !== "up" || dmg <= 0) return "none";
    b.hp -= dmg;
    if (b.hp > 0) return "hit";
    let dx = b.cx - fromX;
    let dz = b.cz - fromZ;
    if (Math.hypot(dx, dz) < 0.5) {
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a);
      dz = Math.sin(a);
    }
    topple(b, dx, dz);
    return "topple";
  };

  return {
    at(x, z, pad = 0) {
      for (const b of list) {
        if (b.state !== "up") continue;
        if (x >= b.minX - pad && x <= b.maxX + pad && z >= b.minZ - pad && z <= b.maxZ + pad) return b.id;
      }
      return -1;
    },
    near(x, z, r) {
      const out: Array<[number, number]> = [];
      for (const b of list) {
        if (b.state !== "up") continue;
        const dx = Math.max(b.minX - x, 0, x - b.maxX);
        const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
        const d = Math.hypot(dx, dz);
        if (d <= r) out.push([d, b.id]);
      }
      return out.sort((a, b) => a[0] - b[0]).map((o) => o[1]);
    },
    info(id) {
      const b = list[id];
      return b
        ? { cx: b.cx, cz: b.cz, height: b.height, minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, hp: b.hp, standing: b.state === "up" }
        : null;
    },
    damage(id, dmg, fromX, fromZ) {
      const b = list[id];
      return b ? damage(b, dmg, fromX, fromZ) : "none";
    },
    topple(id, dx, dz) {
      const b = list[id];
      return b ? topple(b, dx, dz) : false;
    },
    onEvent(cb) {
      listeners.push(cb);
    },
    update(dt) {
      for (let i = moving.length - 1; i >= 0; i--) {
        const b = moving[i];
        b.t += dt;
        if (b.state === "falling") {
          [b.angle, b.speed] = swing(b.angle, b.speed, b.height, dt);
          // Half way down it reaches whatever it is falling onto.
          if (!b.hitOthers && b.angle > 0.75) {
            b.hitOthers = true;
            const ex = b.pivot.x + b.dx * b.height;
            const ez = b.pivot.z + b.dz * b.height;
            for (const o of list) {
              if (o === b || o.state !== "up") continue;
              if (boxSegmentDistance(o, b.pivot.x, b.pivot.z, ex, ez) > b.across / 2) continue;
              // How far along the fall it is decides how high up it gets hit.
              const along = Math.hypot(o.cx - b.pivot.x, o.cz - b.pivot.z);
              const y = Math.max(2, Math.min(o.height, Math.cos(0.75) * (b.height - along) + 4));
              emit({ kind: "crash", x: o.cx - b.dx * 2, y, z: o.cz - b.dz * 2, power: 1.4 + b.height / 60 });
              // The chain: a falling tower carries the next one over the same way.
              damage(o, 80 + b.height * 2.2, b.pivot.x - b.dx * 10, b.pivot.z - b.dz * 10);
            }
          }
          if (b.angle >= REST) {
            b.angle = REST;
            b.state = "lying";
            b.t = 0;
            emit({ kind: "land", x: b.pivot.x, z: b.pivot.z, dx: b.dx, dz: b.dz, length: b.height, width: b.across });
          }
          pose(b, 0);
        } else if (b.state === "lying") {
          if (b.t > LIE_FOR) {
            b.state = "sinking";
            b.t = 0;
          }
        } else if (b.state === "sinking") {
          const k = Math.min(1, b.t / SINK_FOR);
          pose(b, b.sinkTo * k * k);
          if (k >= 1) {
            b.state = "gone";
            down++;
            moving.splice(i, 1);
          }
        }
      }
    },
    debug() {
      return { buildings: list.length, down, falling: moving.length };
    },
  };
}
