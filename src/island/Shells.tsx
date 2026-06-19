import { useMemo } from "react";
import * as THREE from "three";
import { heightAt, ISLAND_RADIUS } from "./heightmap";

export type Shell = { id: number; pos: THREE.Vector3; collected: boolean };

export function generateShells(): Shell[] {
  const out: Shell[] = [];
  let s = 1234;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  let id = 0;
  let attempts = 0;
  while (out.length < 8 && attempts < 500) {
    attempts++;
    const angle = rnd() * Math.PI * 2;
    const dist = ISLAND_RADIUS * (0.5 + rnd() * 0.45);
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const y = heightAt(x, z);
    if (y < 0 || y > 0.8) continue;
    out.push({ id: id++, pos: new THREE.Vector3(x, y + 0.2, z), collected: false });
  }
  return out;
}

export function ShellMesh({ shell }: { shell: Shell }) {
  const geom = useMemo(() => new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI), []);
  if (shell.collected) return null;
  return (
    <group position={shell.pos}>
      <mesh geometry={geom} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <meshStandardMaterial color="#fce4d6" roughness={0.4} metalness={0.1} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.18, 0]}>
        <ringGeometry args={[0.25, 0.45, 24]} />
        <meshBasicMaterial color="#ffd9a0" transparent opacity={0.35} />
      </mesh>
    </group>
  );
}
