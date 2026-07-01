import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { fireballs, MAX_FIREBALLS } from "./fireballState";
import { useGame } from "./store";

export function Fireballs() {
  const groupRef = useRef<THREE.Group>(null!);
  const slotRefs = useRef<THREE.Group[]>([]);
  const slots = useMemo(() => Array.from({ length: MAX_FIREBALLS }, (_, i) => i), []);

  useFrame((_, dt) => {
    const state = useGame.getState();
    if (state.mode !== "playing") {
      // hide all
      for (const g of slotRefs.current) if (g) g.visible = false;
      return;
    }

    // Update physics + lifetimes; remove dead
    for (let i = fireballs.length - 1; i >= 0; i--) {
      const f = fireballs[i];
      f.life -= dt;
      f.x += f.vx * dt;
      f.z += f.vz * dt;

      if (f.life <= 0) {
        fireballs.splice(i, 1);
        continue;
      }

      // Collide with NPCs
      let hit = false;
      for (const n of state.npcs) {
        if (!n.alive) continue;
        const dx = n.pos[0] - f.x;
        const dz = n.pos[2] - f.z;
        const r = n.size * (n.kind === "apex" ? 1.2 : 0.8) + 0.6;
        if (dx * dx + dz * dz < r * r) {
          // Fireballs do solid damage — herbivores/predators die instantly,
          // apex takes several hits via the existing hp model.
          state.killNpc(n.id);
          state.killNpc(n.id);
          hit = true;
          break;
        }
      }
      if (hit) fireballs.splice(i, 1);
    }

    // Sync to mesh pool
    for (let i = 0; i < MAX_FIREBALLS; i++) {
      const g = slotRefs.current[i];
      if (!g) continue;
      const f = fireballs[i];
      if (!f) {
        g.visible = false;
        continue;
      }
      g.visible = true;
      g.position.set(f.x, f.y, f.z);
      const t = 1 - Math.min(1, f.life / 1.5);
      const s = 0.5 + t * 0.6;
      g.scale.setScalar(s);
    }
  });

  return (
    <group ref={groupRef}>
      {slots.map((i) => (
        <group
          key={i}
          ref={(el) => {
            if (el) slotRefs.current[i] = el;
          }}
          visible={false}
        >
          <mesh>
            <sphereGeometry args={[0.35, 12, 12]} />
            <meshStandardMaterial
              color="#ff8a2a"
              emissive="#ff5500"
              emissiveIntensity={3}
              toneMapped={false}
            />
          </mesh>
          <pointLight color="#ff7733" intensity={3} distance={6} decay={2} />
          {/* trailing ember halo */}
          <mesh scale={1.6}>
            <sphereGeometry args={[0.35, 12, 12]} />
            <meshBasicMaterial color="#ffaa44" transparent opacity={0.25} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
