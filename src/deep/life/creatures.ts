/**
 * The Midnight Zone — who is out there.
 *
 * A depth-banded spawner. It keeps a small population alive in a shell around
 * the sub, retires anything that falls too far behind, and animates each one
 * with a motion appropriate to its body plan — jellies pulse, fish weave,
 * siphonophores undulate.
 *
 * Two decisions worth defending:
 *
 * **Creatures spawn behind the fog, never in front of it.** The spawn radius
 * is deliberately just past the distance at which the fog has swallowed
 * everything, so nothing is ever seen appearing. In a world where visibility
 * is the whole subject, one animal popping into existence at arm's length
 * costs more than ten that never spawned at all.
 *
 * **The population is small and the variety is per-depth.** Six to ten
 * creatures at a time is enough, because you can only ever see two or three of
 * them. Spending the budget on *which* animal rather than *how many* is what
 * makes 8 km of descent feel like five different places instead of one long
 * corridor.
 */
import * as THREE from "three";
import {
  depthOf,
  type CreatureInstance,
  type CreatureService,
  type DeepCtx,
  type SubService,
  type System,
} from "../types";
import { speciesAt, type Species } from "./species";

/** Where new life appears: past the fog, inside the far plane. */
const SPAWN_MIN = 26;
const SPAWN_MAX = 62;
/** Retire beyond this. Generous, so turning round does not empty the sea. */
const RETIRE = 105;

interface Live extends CreatureInstance {
  species: Species;
  /** Per-creature animation clock, offset so a pair never pulses in lockstep. */
  phase: number;
  /** Body-plan motion. */
  drift: THREE.Vector3;
  spin: number;
  bob: number;
}

export default function createCreatures(ctx: DeepCtx): System {
  const group = new THREE.Group();
  group.name = "creatures";
  ctx.scene.add(group);

  const live: Live[] = [];
  let nextId = 1;
  let spawnTimer = 0;

  const target = () =>
    ctx.quality === "low" ? 5 : ctx.quality === "medium" ? 7 : ctx.quality === "ultra" ? 12 : 9;

  function pick(depth: number): Species | null {
    const pool = speciesAt(depth);
    if (!pool.length) return null;
    let total = 0;
    for (const s of pool) total += s.weight;
    let r = ctx.rng() * total;
    for (const s of pool) {
      r -= s.weight;
      if (r <= 0) return s;
    }
    return pool[pool.length - 1];
  }

  function spawn(): void {
    const sub = ctx.services.sub as SubService | undefined;
    const origin = sub?.position ?? ctx.camera.position;
    const depth = depthOf(origin.y);
    const species = pick(depth);
    if (!species) return;

    let object: THREE.Object3D;
    try {
      object = species.build(ctx.rng);
    } catch (err) {
      // A malformed animal must not take the ocean with it.
      console.error(`[The Deep] could not build "${species.id}":`, err);
      return;
    }

    // Somewhere on a shell around the sub, biased below the horizon — you are
    // descending, so most of what you meet should be coming up to meet you.
    const theta = ctx.rng() * Math.PI * 2;
    const phi = Math.acos(2 * ctx.rng() - 1);
    const r = SPAWN_MIN + ctx.rng() * (SPAWN_MAX - SPAWN_MIN);
    object.position.set(
      origin.x + r * Math.sin(phi) * Math.cos(theta),
      origin.y + r * Math.cos(phi) * 0.55 - 6,
      origin.z + r * Math.sin(phi) * Math.sin(theta),
    );
    object.rotation.y = ctx.rng() * Math.PI * 2;
    group.add(object);

    live.push({
      id: nextId++,
      speciesId: species.id,
      species,
      object,
      position: object.position,
      size: species.size,
      scanned: false,
      phase: ctx.rng() * Math.PI * 2,
      drift: new THREE.Vector3(
        (ctx.rng() - 0.5) * 0.5,
        (ctx.rng() - 0.5) * 0.22,
        (ctx.rng() - 0.5) * 0.5,
      ),
      spin: (ctx.rng() - 0.5) * 0.22,
      bob: 0.3 + ctx.rng() * 0.7,
    });
  }

  function retire(i: number): void {
    const c = live[i];
    group.remove(c.object);
    c.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (mat) for (const one of Array.isArray(mat) ? mat : [mat]) one.dispose();
    });
    live.splice(i, 1);
  }

  /** Body-plan animation. Cheap, per-creature, and the thing that sells them. */
  function animate(c: Live, dt: number, t: number): void {
    const o = c.object;
    o.position.addScaledVector(c.drift, dt);

    switch (c.species.id) {
      case "moon-jelly":
      case "atolla": {
        // Jet propulsion: squash the bell, then coast. The asymmetry between
        // the fast contraction and the slow relaxation is the whole read.
        const beat = (Math.sin(t * 1.6 + c.phase) + 1) * 0.5;
        const pulse = Math.pow(beat, 2.4);
        o.scale.set(1 + pulse * 0.22, 1 - pulse * 0.3, 1 + pulse * 0.22);
        o.position.y += pulse * dt * 0.55;
        o.rotation.y += c.spin * dt;
        const alarm = o.getObjectByName("alarm");
        if (alarm) {
          const mat = (alarm as THREE.Mesh).material as THREE.MeshStandardMaterial;
          // The alarm ring chases round rather than blinking together.
          mat.emissiveIntensity = 3 + 4 * Math.pow((Math.sin(t * 3 + c.phase) + 1) * 0.5, 3);
        }
        break;
      }
      case "siphonophore": {
        // The colony travels as a wave down its own length.
        o.rotation.z = Math.sin(t * 0.5 + c.phase) * 0.16;
        o.rotation.x = Math.cos(t * 0.37 + c.phase) * 0.12;
        o.position.y += Math.sin(t * 0.9 + c.phase) * dt * 0.5;
        break;
      }
      case "anglerfish": {
        // She barely moves. The lure does the moving.
        o.rotation.y += c.spin * dt * 0.35;
        o.position.y += Math.sin(t * 0.55 + c.phase) * dt * 0.32;
        const esca = o.getObjectByName("esca");
        if (esca) {
          const mat = (esca as THREE.Mesh).material as THREE.MeshStandardMaterial;
          mat.emissiveIntensity = 6 + 4 * Math.sin(t * 1.9 + c.phase);
          esca.position.x = Math.sin(t * 1.1 + c.phase) * 0.05;
        }
        break;
      }
      case "dumbo": {
        // Ear-flap. Opposite phase per side or it looks like it is saluting.
        const flap = Math.sin(t * 2.4 + c.phase) * 0.42;
        const l = o.getObjectByName("earL");
        const r = o.getObjectByName("earR");
        if (l) l.rotation.z = -0.32 - flap;
        if (r) r.rotation.z = 0.32 + flap;
        o.position.y += Math.sin(t * 2.4 + c.phase) * dt * 0.7;
        o.rotation.y += c.spin * dt;
        break;
      }
      case "gulper-eel": {
        // Serpentine: each segment lags the one in front.
        for (let i = 0; i < 14; i++) {
          const seg = o.getObjectByName(`seg${i}`);
          if (seg) seg.position.x = Math.sin(t * 2 + c.phase - i * 0.45) * 0.06 * (i / 14);
        }
        o.rotation.y += c.spin * dt * 0.6;
        break;
      }
      case "lanternfish":
      case "sardine-school": {
        // Schools mill. A little yaw wander plus a bob is enough at distance.
        o.rotation.y += (c.spin + Math.sin(t * 0.6 + c.phase) * 0.3) * dt;
        o.position.y += Math.sin(t * 1.3 + c.phase) * dt * 0.5;
        break;
      }
      case "tripod-fish":
      case "sea-pig": {
        // Benthic: they sit on the floor and do almost nothing, which is the
        // most truthful animation in the file.
        o.rotation.y += c.spin * dt * 0.1;
        break;
      }
      default: {
        o.rotation.y += c.spin * dt;
        o.position.y += Math.sin(t * c.bob + c.phase) * dt * 0.4;
      }
    }
  }

  const service: CreatureService = {
    alive: () => live,
    nearest(from, range) {
      let best: Live | null = null;
      let bestD = range * range;
      for (const c of live) {
        const d = c.object.position.distanceToSquared(from);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    },
  };
  ctx.services.creatures = service;

  return {
    update(dt) {
      const sub = ctx.services.sub as SubService | undefined;
      const origin = sub?.position ?? ctx.camera.position;
      const t = ctx.elapsed;

      for (let i = live.length - 1; i >= 0; i--) {
        const c = live[i];
        animate(c, dt, t);
        if (c.object.position.distanceTo(origin) > RETIRE) retire(i);
      }

      // Spawn on a cadence rather than all at once, so the sea fills in as you
      // travel instead of materialising in a ring the instant you slow down.
      spawnTimer -= dt;
      if (spawnTimer <= 0 && live.length < target()) {
        spawnTimer = 0.35;
        spawn();
      }
    },

    dispose() {
      while (live.length) retire(live.length - 1);
      ctx.scene.remove(group);
      if (ctx.services.creatures === service) delete ctx.services.creatures;
    },
  };
}
