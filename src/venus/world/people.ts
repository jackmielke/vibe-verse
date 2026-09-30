/**
 * The people on deck.
 *
 * A city you can only see from four hundred metres is a diorama. These are
 * the colonists, one figure for every few residents, walking between plates
 * in wetsuits and goggles, stopping to look over the rail, going indoors.
 * Two instanced meshes (bodies and heads), so two draw calls for all of them.
 */
import * as THREE from "three";
import { hexToWorld, SLOT } from "../modules";
import type { Tile } from "../sim";

const MAX = 240;

interface Walker {
  x: number; z: number;
  tx: number; tz: number;
  speed: number;
  wait: number;
  phase: number;
  on: boolean;
}

const SUITS = [0x1f4a52, 0x2a2a30, 0x8a4a2a, 0xd8cbb4, 0x3a5a8a, 0x6a2a4a, 0xe0a040, 0xf2efe8];
const SKIN = [0xf1c9a5, 0xd9a47c, 0xa8704a, 0x7a4a2a, 0x5a3420, 0xe8b894];

export class People {
  group = new THREE.Group();
  private bodies: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private visors: THREE.InstancedMesh;
  private w: Walker[] = [];
  private tiles: Array<{ x: number; z: number }> = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private want = 0;

  constructor() {
    const body = new THREE.CapsuleGeometry(0.32, 1.0, 3, 8);
    body.translate(0, 0.82, 0);
    const head = new THREE.SphereGeometry(0.24, 10, 8);
    head.translate(0, 1.72, 0);
    const visor = new THREE.BoxGeometry(0.34, 0.1, 0.12);
    visor.translate(0, 1.76, 0.2);
    this.bodies = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 }), MAX);
    this.heads = new THREE.InstancedMesh(head, new THREE.MeshStandardMaterial({ roughness: 0.7 }), MAX);
    this.visors = new THREE.InstancedMesh(visor, new THREE.MeshStandardMaterial({ color: 0x9fe8ff, roughness: 0.1, metalness: 0.9, emissive: 0x16404a }), MAX);
    const c = new THREE.Color();
    for (let i = 0; i < MAX; i++) {
      this.bodies.setColorAt(i, c.setHex(SUITS[i % SUITS.length]));
      this.heads.setColorAt(i, c.setHex(SKIN[(i * 7) % SKIN.length]));
      this.w.push({ x: 0, z: 0, tx: 0, tz: 0, speed: 1 + Math.random() * 0.8, wait: Math.random() * 4, phase: Math.random() * 10, on: false });
    }
    for (const m of [this.bodies, this.heads, this.visors]) {
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  /** Where people can be, and how many of them to show. */
  sync(tiles: Tile[], pop: number) {
    this.tiles = tiles.map((t) => hexToWorld(t.q, t.r));
    this.want = Math.min(MAX, Math.max(3, Math.round(pop / 4)));
  }

  private spot(near?: { x: number; z: number }): { x: number; z: number } {
    const pool = this.tiles;
    if (!pool.length) return { x: 0, z: 0 };
    let t = pool[Math.floor(Math.random() * pool.length)];
    if (near && Math.random() < 0.7) {
      // Mostly wander next door.
      const close = pool.filter((p) => Math.hypot(p.x - near.x, p.z - near.z) < SLOT * 2.2);
      if (close.length) t = close[Math.floor(Math.random() * close.length)];
    }
    const a = Math.random() * Math.PI * 2;
    const r = SLOT * (0.35 + Math.random() * 0.5);
    return { x: t.x + Math.cos(a) * r, z: t.z + Math.sin(a) * r };
  }

  update(dt: number, time: number) {
    const n = this.want;
    for (let i = 0; i < n; i++) {
      const w = this.w[i];
      if (!w.on) {
        const s = this.spot();
        w.x = s.x; w.z = s.z; w.tx = s.x; w.tz = s.z;
        w.on = true;
      }
      const dx = w.tx - w.x, dz = w.tz - w.z;
      const d = Math.hypot(dx, dz);
      let moving = false;
      if (w.wait > 0) w.wait -= dt;
      else if (d < 0.3) {
        w.wait = 1 + Math.random() * 6;
        const s = this.spot({ x: w.x, z: w.z });
        w.tx = s.x; w.tz = s.z;
      } else {
        const k = Math.min(1, (w.speed * dt) / d);
        w.x += dx * k;
        w.z += dz * k;
        moving = true;
      }
      const heading = Math.atan2(w.tx - w.x, w.tz - w.z);
      const bob = moving ? Math.abs(Math.sin(time * 7 * w.speed + w.phase)) * 0.06 : 0;
      this.q.setFromAxisAngle(UP, heading);
      this.p.set(w.x, 0.12 + bob, w.z);
      this.m.compose(this.p, this.q, this.s);
      this.bodies.setMatrixAt(i, this.m);
      this.heads.setMatrixAt(i, this.m);
      this.visors.setMatrixAt(i, this.m);
    }
    for (let i = n; i < MAX && this.w[i].on; i++) this.w[i].on = false;
    for (const m of [this.bodies, this.heads, this.visors]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = false;
  }

  dispose() {
    for (const m of [this.bodies, this.heads, this.visors]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0);
