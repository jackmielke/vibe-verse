import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { useGame, WORLD } from "./store";
import { AnimalCreature, PlantCreature } from "./Creature";
import { baseAnimal, basePlant } from "./mutations";

export function Allies() {
  const allies = useGame((s) => s.allies);
  const traits = useGame((s) => s.traits);
  const kind = useGame((s) => s.kind);
  const pos = useGame((s) => s.pos);
  const npcs = useGame((s) => s.npcs);
  const killNpc = useGame((s) => s.killNpc);
  const damageAlly = useGame((s) => s.damageAlly);
  const refs = useRef<Record<string, THREE.Group | null>>({});

  useFrame((_, dt) => {
    if (kind !== "animal") return; // plant allies are stationary
    for (const a of allies) {
      if (!a.alive) continue;
      // follow player at a loose distance
      const dx = pos[0] - a.pos[0];
      const dz = pos[2] - a.pos[2];
      const d = Math.hypot(dx, dz);
      let vx = a.vel[0];
      let vz = a.vel[1];
      const sp = Math.min(traits.speed * 0.9, 4);
      // Find nearest hostile if player has fangs
      let target: [number, number] | null = null;
      if (traits.carnivore >= 0.3) {
        let bd = 64;
        for (const n of npcs) {
          if (!n.alive) continue;
          if (n.kind === "predator" || n.kind === "apex") {
            const dd = (n.pos[0] - a.pos[0]) ** 2 + (n.pos[2] - a.pos[2]) ** 2;
            if (dd < bd) {
              bd = dd;
              target = [n.pos[0], n.pos[2]];
            }
          }
        }
      }
      if (target) {
        const tx = target[0] - a.pos[0];
        const tz = target[1] - a.pos[2];
        const td = Math.hypot(tx, tz) || 1;
        vx = (tx / td) * sp;
        vz = (tz / td) * sp;
      } else if (d > 4) {
        vx = (dx / (d || 1)) * sp;
        vz = (dz / (d || 1)) * sp;
      } else {
        vx *= 0.9;
        vz *= 0.9;
      }
      a.pos[0] += vx * dt;
      a.pos[2] += vz * dt;
      const lim = WORLD / 2 - 1;
      a.pos[0] = Math.max(-lim, Math.min(lim, a.pos[0]));
      a.pos[2] = Math.max(-lim, Math.min(lim, a.pos[2]));
      a.vel = [vx, vz];

      // Combat with adjacent hostiles
      for (const n of npcs) {
        if (!n.alive) continue;
        if (n.kind === "herbivore") continue;
        const ndx = n.pos[0] - a.pos[0];
        const ndz = n.pos[2] - a.pos[2];
        const nd2 = ndx * ndx + ndz * ndz;
        if (nd2 < 1.4) {
          if (traits.carnivore >= 0.3 && Math.random() < dt * 1.5) {
            killNpc(n.id);
          } else if (Math.random() < dt * 0.6) {
            damageAlly(a.id, n.kind === "apex" ? 1 : 0.6);
          }
        }
      }

      const ref = refs.current[a.id];
      if (ref) {
        ref.position.set(a.pos[0], 0.4, a.pos[2]);
        if (Math.hypot(vx, vz) > 0.05) {
          ref.rotation.y = Math.atan2(-vx, -vz);
        }
      }
    }
  });

  const allyAnimalTraits = { ...baseAnimal, ...traits, size: traits.size * 0.85, color: traits.color };
  const allyPlantTraits = { ...basePlant, ...traits, size: traits.size * 0.7 };

  return (
    <group>
      {allies.map((a) =>
        a.alive ? (
          <group
            key={a.id}
            ref={(el) => (refs.current[a.id] = el)}
            position={[a.pos[0], kind === "animal" ? 0.4 : 0, a.pos[2]]}
          >
            {kind === "animal" ? (
              <AnimalCreature traits={allyAnimalTraits} moving />
            ) : (
              <PlantCreature traits={allyPlantTraits} />
            )}
          </group>
        ) : null,
      )}
    </group>
  );
}
