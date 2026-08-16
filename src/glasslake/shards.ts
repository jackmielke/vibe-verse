/**
 * Aurora shards — the twelve reasons to cross the lake.
 *
 * Each one is a piece of the sky that fell. Taking one does not add to a
 * counter somewhere off-screen; it feeds `energy`, and energy is what the
 * aurora shader is drawing. Twelve times over, the sky gets deeper, climbs
 * higher and turns from green to violet. The reward for exploring the world
 * is the world — no menu, no upgrade tree, no number going up.
 */
import * as THREE from "three";

export interface ShardsHandle {
  group: THREE.Group;
  readonly taken: number;
  readonly total: number;
  /** Distance to the nearest shard still out there, or Infinity. */
  nearest(from: THREE.Vector3): number;
  /** Returns the number collected this tick. */
  update(dt: number, time: number, player: THREE.Vector3): number;
  reset(): void;
  dispose(): void;
}

interface Shard {
  core: THREE.Mesh;
  halo: THREE.Mesh;
  ring: THREE.Mesh;
  home: THREE.Vector3;
  phase: number;
  taken: boolean;
  /** Seconds since collection, for the burst. */
  burst: number;
}

const PICKUP_R = 2.6;

export function buildShards(lakeRadius: number, count: number): ShardsHandle {
  const group = new THREE.Group();
  const owned: Array<THREE.BufferGeometry | THREE.Material> = [];
  const keep = <T extends THREE.BufferGeometry | THREE.Material>(x: T): T => {
    owned.push(x);
    return x;
  };

  const coreGeo = keep(new THREE.OctahedronGeometry(0.55, 0));
  const haloGeo = keep(new THREE.OctahedronGeometry(1.15, 0));
  const ringGeo = keep(new THREE.TorusGeometry(1, 0.05, 8, 40));

  const shards: Shard[] = [];
  for (let i = 0; i < count; i++) {
    // A golden-angle spiral: no two shards ever end up in the same place,
    // and none of them lands in the middle of the ring of the others.
    const a = i * 2.399963;
    const r = lakeRadius * 0.22 + (i / count) * lakeRadius * 0.66;
    const home = new THREE.Vector3(Math.cos(a) * r, 1.5, Math.sin(a) * r);

    const core = new THREE.Mesh(
      coreGeo,
      keep(new THREE.MeshBasicMaterial({ color: "#eafff6" })),
    );
    const halo = new THREE.Mesh(
      haloGeo,
      keep(
        new THREE.MeshBasicMaterial({
          color: "#5cf0c0",
          transparent: true,
          opacity: 0.28,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.BackSide,
        }),
      ),
    );
    const ring = new THREE.Mesh(
      ringGeo,
      keep(
        new THREE.MeshBasicMaterial({
          color: "#9df6ff",
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;

    core.name = "shard-core";
    core.position.copy(home);
    halo.position.copy(home);
    ring.position.set(home.x, 0.06, home.z);
    group.add(core, halo, ring);
    shards.push({ core, halo, ring, home, phase: i * 1.7, taken: false, burst: 0 });
  }

  let taken = 0;

  return {
    group,
    get taken() {
      return taken;
    },
    get total() {
      return count;
    },

    nearest(from) {
      let best = Infinity;
      for (const s of shards) {
        if (s.taken) continue;
        best = Math.min(best, from.distanceTo(s.core.position));
      }
      return best;
    },

    update(dt, time, player) {
      let got = 0;
      for (const s of shards) {
        if (s.taken) {
          if (s.burst > 0) {
            // The shockwave: a ring on the ice that opens and fades.
            s.burst = Math.max(0, s.burst - dt);
            const t = 1 - s.burst / 0.9;
            s.ring.visible = true;
            s.ring.scale.setScalar(0.6 + t * 9);
            (s.ring.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.8;
            if (s.burst === 0) s.ring.visible = false;
          }
          continue;
        }

        const bob = Math.sin(time * 1.3 + s.phase) * 0.35;
        s.core.position.set(s.home.x, s.home.y + bob, s.home.z);
        s.core.rotation.y = time * 0.9 + s.phase;
        s.core.rotation.x = time * 0.45;
        s.halo.position.copy(s.core.position);
        s.halo.rotation.y = -time * 0.5;
        const pulse = 1 + Math.sin(time * 2.2 + s.phase) * 0.09;
        s.halo.scale.setScalar(pulse);
        (s.halo.material as THREE.MeshBasicMaterial).opacity = 0.22 + 0.12 * Math.sin(time * 2.2 + s.phase);

        if (player.distanceTo(s.core.position) < PICKUP_R) {
          s.taken = true;
          s.burst = 0.9;
          s.core.visible = false;
          s.halo.visible = false;
          taken++;
          got++;
        }
      }
      return got;
    },

    reset() {
      taken = 0;
      for (const s of shards) {
        s.taken = false;
        s.burst = 0;
        s.core.visible = true;
        s.halo.visible = true;
        s.ring.visible = false;
      }
    },

    dispose() {
      owned.forEach((o) => o.dispose());
    },
  };
}
