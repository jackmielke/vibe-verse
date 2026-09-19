/**
 * The things that want you dead: oni, fire oni, and the yurei.
 *
 * All procedural, all one manager. An enemy has a kind, hit points, a
 * target (a point, the player, or a house) and a simple brain: walk at the
 * target, swing when close. What makes them interesting is not the brain
 * but what the *world* does to them, computed here from the same state
 * Vibey's spells write:
 *
 *  - fire oni die in rain, snow and storms (and in a flood)
 *  - everything on the ground is slowed by snow and drowned by a flood
 *  - a storm's lightning strikes one of them now and then
 *  - the yurei will not enter the glow of a lit lantern and loses you in fog
 *  - night makes the oni bolder (faster)
 */
import * as THREE from "three";
import { fireballsFizzle, lanternsOn, nightness, type WorldState } from "../state";

export type EnemyKind = "oni" | "fireoni" | "yurei";

export interface Enemy {
  id: number;
  kind: EnemyKind;
  group: THREE.Group;
  position: THREE.Vector3;
  hp: number;
  maxHp: number;
  speed: number;
  /** Where it wants to go. */
  target: THREE.Vector3 | null;
  /** What it is after: the player, or a house index. */
  targetKind: "player" | "house" | "point";
  targetIndex: number;
  /** Swing cooldown. */
  cooldown: number;
  dead: boolean;
  /** Seconds since death, for the fade. */
  deadFor: number;
  /** Radius for hits. */
  radius: number;
  takeHit(dmg: number): void;
}

export interface EnemyEvents {
  onDeath(e: Enemy, cause: "bolt" | "weather" | "lightning" | "flood" | "light"): void;
  /** The enemy swung at the player. */
  onPlayerHit(e: Enemy): void;
  /** The enemy swung at a house. */
  onHouseHit(e: Enemy, index: number): void;
}

export interface Enemies {
  group: THREE.Group;
  spawn(kind: EnemyKind, x: number, z: number): Enemy;
  all(): Enemy[];
  alive(): Enemy[];
  nearest(p: THREE.Vector3, maxDist?: number): Enemy | null;
  update(dt: number, time: number, ctx: {
    state: WorldState;
    player: THREE.Vector3;
    heightAt(x: number, z: number): number;
    houses: Array<{ x: number; z: number; alive: boolean }>;
    lanterns: Array<{ x: number; z: number }>;
    lightning: number;
    events: EnemyEvents;
  }): void;
  clear(): void;
  dispose(): void;
}

const oniSkin = new THREE.MeshStandardMaterial({ color: "#c43b2f", roughness: 0.8 });
const oniDark = new THREE.MeshStandardMaterial({ color: "#3a1d1d", roughness: 0.9 });
const horn = new THREE.MeshStandardMaterial({ color: "#f0e6c8", roughness: 0.6 });
const eyeMat = new THREE.MeshBasicMaterial({ color: "#ffe14a" });

function buildBody(kind: EnemyKind): { group: THREE.Group; anim: (t: number, moving: number, swing: number) => void; mats: THREE.Material[] } {
  const g = new THREE.Group();
  const mats: THREE.Material[] = [];
  if (kind === "yurei") {
    const sheet = new THREE.MeshStandardMaterial({ color: "#e8f0ff", transparent: true, opacity: 0.6, roughness: 0.9, emissive: "#8fb8ff", emissiveIntensity: 0.25 });
    mats.push(sheet);
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.2, 12, 1, true), sheet);
    body.rotation.x = Math.PI;
    body.position.y = 1.4;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), sheet);
    head.position.y = 2.4;
    const eg = new THREE.SphereGeometry(0.08, 6, 5);
    const em = new THREE.MeshBasicMaterial({ color: "#3a0b0b" });
    mats.push(em);
    const e1 = new THREE.Mesh(eg, em); e1.position.set(-0.17, 2.45, 0.44);
    const e2 = new THREE.Mesh(eg, em); e2.position.set(0.17, 2.45, 0.44);
    const light = new THREE.PointLight("#8fb8ff", 1.2, 8, 2);
    light.position.y = 2;
    g.add(body, head, e1, e2, light);
    return { group: g, mats, anim: (t) => { g.position.y = 0.4 + Math.sin(t * 1.7) * 0.25; body.rotation.z = Math.sin(t * 1.1) * 0.08; } };
  }
  const fire = kind === "fireoni";
  const skin = fire ? new THREE.MeshStandardMaterial({ color: "#ff7a1f", emissive: "#ff4a00", emissiveIntensity: 0.6, roughness: 0.7 }) : oniSkin;
  if (fire) mats.push(skin);
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.65, 1.3, 10), skin);
  torso.position.y = 1.35;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), skin);
  head.position.y = 2.3;
  const hg = new THREE.ConeGeometry(0.08, 0.35, 6);
  const h1 = new THREE.Mesh(hg, horn); h1.position.set(-0.2, 2.7, 0); h1.rotation.z = 0.3;
  const h2 = new THREE.Mesh(hg, horn); h2.position.set(0.2, 2.7, 0); h2.rotation.z = -0.3;
  const eg = new THREE.SphereGeometry(0.07, 6, 5);
  const e1 = new THREE.Mesh(eg, eyeMat); e1.position.set(-0.15, 2.35, 0.38);
  const e2 = new THREE.Mesh(eg, eyeMat); e2.position.set(0.15, 2.35, 0.38);
  const legG = new THREE.CylinderGeometry(0.16, 0.2, 0.8, 8);
  const l1 = new THREE.Mesh(legG, oniDark); l1.position.set(-0.28, 0.4, 0);
  const l2 = new THREE.Mesh(legG, oniDark); l2.position.set(0.28, 0.4, 0);
  const armG = new THREE.CylinderGeometry(0.12, 0.14, 1.0, 8);
  const a1 = new THREE.Mesh(armG, skin); a1.position.set(-0.7, 1.55, 0); a1.rotation.z = 0.3;
  const armR = new THREE.Group(); armR.position.set(0.7, 1.9, 0);
  const a2 = new THREE.Mesh(armG, skin); a2.position.y = -0.4; armR.add(a2);
  const club = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.22, 1.2, 8), oniDark); club.position.set(0, -0.9, 0.3); club.rotation.x = -0.5; armR.add(club);
  const belt = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.08, 6, 14), oniDark); belt.position.y = 0.85; belt.rotation.x = Math.PI / 2;
  for (const m of [torso, head, l1, l2, a1, a2, club]) m.castShadow = true;
  const light = fire ? new THREE.PointLight("#ff6a1f", 1.8, 9, 2) : null;
  if (light) { light.position.y = 1.6; g.add(light); }
  g.add(torso, head, h1, h2, e1, e2, l1, l2, a1, armR, belt);
  return {
    group: g,
    mats,
    anim: (t, moving, swing) => {
      l1.rotation.x = Math.sin(t * 8) * 0.6 * moving;
      l2.rotation.x = -Math.sin(t * 8) * 0.6 * moving;
      torso.position.y = 1.35 + Math.abs(Math.sin(t * 8)) * 0.06 * moving;
      armR.rotation.x = swing > 0 ? -1.6 + swing * 2.2 : Math.sin(t * 8) * 0.3 * moving;
      if (light) light.intensity = 1.5 + Math.sin(t * 20) * 0.5;
    },
  };
}

export function createEnemies(): Enemies {
  const group = new THREE.Group();
  const list: Array<Enemy & { anim: (t: number, m: number, s: number) => void; mats: THREE.Material[]; swing: number; wander: number; wanderA: number }> = [];
  let nextId = 1;
  const tmp = new THREE.Vector3();
  const boltFx = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3)),
    new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0 }),
  );
  boltFx.frustumCulled = false;
  group.add(boltFx);
  let boltFxAge = 99;

  return {
    group,
    spawn(kind, x, z) {
      const b = buildBody(kind);
      b.group.position.set(x, 0, z);
      group.add(b.group);
      const stats = kind === "yurei" ? { hp: 6, speed: 3.4, radius: 0.9 } : kind === "fireoni" ? { hp: 2, speed: 2.6, radius: 0.8 } : { hp: 3, speed: 2.1, radius: 0.85 };
      const e = {
        id: nextId++, kind, group: b.group, position: b.group.position, hp: stats.hp, maxHp: stats.hp, speed: stats.speed,
        target: null as THREE.Vector3 | null, targetKind: "player" as const, targetIndex: -1, cooldown: 1 + Math.random(), dead: false, deadFor: 0, radius: stats.radius,
        anim: b.anim, mats: b.mats, swing: 0, wander: 0, wanderA: Math.random() * Math.PI * 2,
        takeHit(dmg: number) { if (!e.dead) { e.hp -= dmg; e.group.position.y += 0.15; } },
      };
      list.push(e);
      return e;
    },
    all: () => list,
    alive: () => list.filter((e) => !e.dead),
    nearest(p, maxDist = Infinity) {
      let best: Enemy | null = null;
      let bd = maxDist;
      for (const e of list) {
        if (e.dead) continue;
        const d = e.position.distanceTo(p);
        if (d < bd) { bd = d; best = e; }
      }
      return best;
    },
    update(dt, time, ctx) {
      const s = ctx.state;
      const wet = fireballsFizzle(s);
      const snowSlow = s.weather === "snow" || s.season === "winter" ? 0.55 : 1;
      const nightBoost = 1 + nightness(s.timeOfDay) * 0.25;
      const fog = s.weather === "fog" || s.fog > 0.5;
      const lit = lanternsOn(s);
      boltFxAge += dt;
      (boltFx.material as THREE.LineBasicMaterial).opacity = Math.max(0, 1 - boltFxAge * 4);
      // Lightning: the storm picks one off now and then.
      if (ctx.lightning > 0.95) {
        const candidates = list.filter((e) => !e.dead && e.position.distanceTo(ctx.player) < 40);
        if (candidates.length && Math.random() < 0.7) {
          const e = candidates[Math.floor(Math.random() * candidates.length)];
          e.hp = 0;
          const arr = (boltFx.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
          arr.set([e.position.x + 3, e.position.y + 60, e.position.z - 4, e.position.x, e.position.y + 1, e.position.z]);
          (boltFx.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
          boltFxAge = 0;
          e.dead = true;
          ctx.events.onDeath(e, "lightning");
        }
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (e.dead) {
          e.deadFor += dt;
          e.group.scale.setScalar(Math.max(0.01, 1 - e.deadFor * 1.6));
          e.group.position.y -= dt * 0.8;
          if (e.deadFor > 0.7) { group.remove(e.group); disposeGroup(e.group, e.mats); list.splice(i, 1); }
          continue;
        }
        // Weather kills.
        if (e.kind === "fireoni" && wet) { e.dead = true; ctx.events.onDeath(e, "weather"); continue; }
        if (e.kind !== "yurei" && s.flood > 0.5) { e.dead = true; ctx.events.onDeath(e, "flood"); continue; }
        if (e.hp <= 0) { e.dead = true; ctx.events.onDeath(e, "bolt"); continue; }
        // Choose a target.
        let target: THREE.Vector3 | null = null;
        if (e.targetKind === "house") {
          const h = ctx.houses[e.targetIndex];
          if (!h || !h.alive) { e.targetKind = "player"; }
          else target = tmp.set(h.x, 0, h.z);
        }
        if (e.targetKind === "player") target = ctx.player;
        if (e.targetKind === "point" && e.target) target = e.target;
        if (!target) continue;
        // The yurei loses you in fog and will not enter lantern light.
        let speed = e.speed * (e.kind === "yurei" ? 1 : snowSlow * nightBoost);
        let dirx = target.x - e.position.x, dirz = target.z - e.position.z;
        const dist = Math.hypot(dirx, dirz);
        if (e.kind === "yurei") {
          if (fog && dist > 6) { e.wander += dt; if (e.wander > 2) { e.wander = 0; e.wanderA += (Math.random() - 0.5) * 2; } dirx = Math.cos(e.wanderA); dirz = Math.sin(e.wanderA); speed *= 0.5; }
          if (lit) {
            for (const l of ctx.lanterns) {
              const nx = e.position.x + (dirx / Math.max(0.001, Math.hypot(dirx, dirz))) * speed * dt;
              const nz = e.position.z + (dirz / Math.max(0.001, Math.hypot(dirx, dirz))) * speed * dt;
              if (Math.hypot(nx - l.x, nz - l.z) < 6) { dirx = e.position.x - l.x; dirz = e.position.z - l.z; break; }
            }
          }
        }
        const reach = e.kind === "yurei" ? 1.4 : e.targetKind === "house" ? 3.2 : 1.6;
        let moving = 0;
        if (dist > reach) {
          const n = Math.max(0.001, Math.hypot(dirx, dirz));
          e.position.x += (dirx / n) * speed * dt;
          e.position.z += (dirz / n) * speed * dt;
          moving = 1;
          e.group.rotation.y = Math.atan2(dirx, dirz);
        } else {
          e.cooldown -= dt;
          if (e.cooldown <= 0) {
            e.cooldown = e.kind === "yurei" ? 2.5 : 1.4;
            e.swing = 1;
            if (e.targetKind === "house") ctx.events.onHouseHit(e, e.targetIndex);
            else if (dist < reach + 0.4) ctx.events.onPlayerHit(e);
          }
        }
        e.swing = Math.max(0, e.swing - dt * 2.5);
        const ground = ctx.heightAt(e.position.x, e.position.z);
        e.position.y += (ground - e.position.y) * Math.min(1, dt * 8);
        e.anim(time + e.id, moving, e.swing);
      }
    },
    clear() {
      for (const e of list) { group.remove(e.group); disposeGroup(e.group, e.mats); }
      list.length = 0;
    },
    dispose() {
      this.clear();
      boltFx.geometry.dispose();
      (boltFx.material as THREE.Material).dispose();
    },
  };
}

function disposeGroup(g: THREE.Group, mats: THREE.Material[]) {
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
  for (const m of mats) m.dispose();
}
