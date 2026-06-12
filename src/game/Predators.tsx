import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { useGame } from "./store";
import { clampToIsland, shoreDistance } from "./island";
import { ApexCreature, HerbivoreCreature, PredatorCreature } from "./Creature";
import type { Npc } from "./types";

function nearestTarget(
  n: Npc,
  player: [number, number, number],
  allies: { pos: [number, number, number]; alive: boolean }[],
  npcs: Npc[],
): [number, number] | null {
  if (n.kind === "herbivore") return null;
  const candidates: Array<[number, number]> = [[player[0], player[2]]];
  for (const a of allies) if (a.alive) candidates.push([a.pos[0], a.pos[2]]);
  if (n.kind === "apex") {
    for (const o of npcs) {
      if (!o.alive || o.id === n.id) continue;
      if (o.kind === "herbivore" || o.kind === "predator") candidates.push([o.pos[0], o.pos[2]]);
    }
  }
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = (c[0] - n.pos[0]) ** 2 + (c[1] - n.pos[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const sight = n.kind === "apex" ? 22 : 14;
  if (bestD > sight * sight) return null;
  return best;
}

function nearestThreat(n: Npc, npcs: Npc[]) {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const o of npcs) {
    if (!o.alive) continue;
    if (o.kind === "predator" || o.kind === "apex") {
      const d = (o.pos[0] - n.pos[0]) ** 2 + (o.pos[2] - n.pos[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = [o.pos[0], o.pos[2]];
      }
    }
  }
  if (bestD > 100) return null;
  return best;
}

export function Predators() {
  const npcs = useGame((s) => s.npcs);
  const pos = useGame((s) => s.pos);
  const allies = useGame((s) => s.allies);
  const refs = useRef<Record<string, THREE.Group | null>>({});

  useFrame((_, dt) => {
    for (const n of npcs) {
      if (!n.alive) continue;
      let vx = n.vel[0];
      let vz = n.vel[1];

      const target = nearestTarget(n, pos, allies, npcs);
      const flee = n.kind === "herbivore" ? nearestThreat(n, npcs) : null;

      const maxSpeed = n.kind === "apex" ? 4 : n.kind === "predator" ? 3.2 : 2.6;

      if (flee) {
        const dx = n.pos[0] - flee[0];
        const dz = n.pos[2] - flee[1];
        const d = Math.hypot(dx, dz) || 1;
        vx = (dx / d) * maxSpeed;
        vz = (dz / d) * maxSpeed;
      } else if (target && !n.seeded) {
        const dx = target[0] - n.pos[0];
        const dz = target[1] - n.pos[2];
        const d = Math.hypot(dx, dz) || 1;
        vx = (dx / d) * maxSpeed;
        vz = (dz / d) * maxSpeed;
      } else if (n.seeded) {
        // wander away to plant the seed
        vx += (Math.random() - 0.5) * 3 * dt;
        vz += (Math.random() - 0.5) * 3 * dt;
        const sp = Math.hypot(vx, vz);
        if (sp > 2) { vx = (vx / sp) * 2; vz = (vz / sp) * 2; }
      } else {
        vx += (Math.random() - 0.5) * 2 * dt;
        vz += (Math.random() - 0.5) * 2 * dt;
        const sp = Math.hypot(vx, vz);
        const max = 1.5;
        if (sp > max) {
          vx = (vx / sp) * max;
          vz = (vz / sp) * max;
        }
      }

      n.pos[0] += vx * dt;
      n.pos[2] += vz * dt;

      // Separation from other NPCs (prevents stacking / jittering on player)
      for (const o of npcs) {
        if (o === n || !o.alive) continue;
        const dx = n.pos[0] - o.pos[0];
        const dz = n.pos[2] - o.pos[2];
        const d2 = dx * dx + dz * dz;
        const rN = n.size * (n.kind === "apex" ? 1.1 : n.kind === "predator" ? 0.7 : 0.6);
        const rO = o.size * (o.kind === "apex" ? 1.1 : o.kind === "predator" ? 0.7 : 0.6);
        const sep = rN + rO;
        if (d2 > 1e-6 && d2 < sep * sep) {
          const d = Math.sqrt(d2);
          const push = (sep - d) * 0.5;
          const nx = dx / d;
          const nz = dz / d;
          n.pos[0] += nx * push;
          n.pos[2] += nz * push;
          o.pos[0] -= nx * push;
          o.pos[2] -= nz * push;
        }
      }

      // Keep NPCs on the island; turn back inland when reaching the beach
      if (shoreDistance(n.pos[0], n.pos[2]) < 3) {
        const [cx, cz] = clampToIsland(n.pos[0], n.pos[2], 3);
        n.pos[0] = cx;
        n.pos[2] = cz;
        // steer back toward the island center
        const d = Math.hypot(cx, cz) || 1;
        vx = (-cx / d) * Math.abs(vx || 1);
        vz = (-cz / d) * Math.abs(vz || 1);
      }
      n.vel = [vx, vz];

      const ref = refs.current[n.id];
      if (ref) {
        ref.position.set(n.pos[0], 0.4 * n.size, n.pos[2]);
        ref.scale.setScalar(n.size);
        const speed = Math.hypot(vx, vz);
        if (speed > 0.05) {
          ref.rotation.y = Math.atan2(-vx, -vz);
        }
      }
    }
  });

  return (
    <group>
      {npcs.map((n) =>
        n.alive ? (
          <group key={n.id} ref={(el) => (refs.current[n.id] = el)} position={[n.pos[0], 0.4 * n.size, n.pos[2]]}>
            {n.kind === "apex" && <ApexCreature moving />}
            {n.kind === "predator" && <PredatorCreature moving />}
            {n.kind === "herbivore" && <HerbivoreCreature moving />}
          </group>
        ) : null,
      )}
    </group>
  );
}
