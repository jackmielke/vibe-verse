import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { heightAt, ISLAND_RADIUS } from "./heightmap";

function seededRand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function PalmTree({ position, scale, rotation }: { position: [number, number, number]; scale: number; rotation: number }) {
  const leavesRef = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (leavesRef.current) {
      leavesRef.current.rotation.z = Math.sin(state.clock.elapsedTime * 0.8 + position[0]) * 0.04;
    }
  });
  return (
    <group position={position} scale={scale} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1.2, 0]} castShadow>
        <cylinderGeometry args={[0.18, 0.28, 2.4, 8]} />
        <meshStandardMaterial color="#6b4a2a" roughness={0.9} />
      </mesh>
      <mesh position={[0.1, 3.0, 0]} rotation={[0, 0, 0.15]} castShadow>
        <cylinderGeometry args={[0.14, 0.18, 1.4, 8]} />
        <meshStandardMaterial color="#785530" roughness={0.9} />
      </mesh>
      <mesh position={[0.18, 3.55, 0.05]} castShadow>
        <sphereGeometry args={[0.13, 8, 8]} />
        <meshStandardMaterial color="#3a2a1a" roughness={0.8} />
      </mesh>
      <mesh position={[0.0, 3.6, 0.18]} castShadow>
        <sphereGeometry args={[0.12, 8, 8]} />
        <meshStandardMaterial color="#3a2a1a" roughness={0.8} />
      </mesh>
      <group ref={leavesRef} position={[0.18, 3.7, 0]}>
        {Array.from({ length: 7 }).map((_, i) => {
          const angle = (i / 7) * Math.PI * 2;
          return (
            <mesh
              key={i}
              position={[Math.cos(angle) * 0.6, -0.05, Math.sin(angle) * 0.6]}
              rotation={[0, -angle, -0.55]}
              castShadow
            >
              <coneGeometry args={[0.35, 1.8, 4]} />
              <meshStandardMaterial color="#2d6b3a" roughness={0.8} side={THREE.DoubleSide} />
            </mesh>
          );
        })}
      </group>
    </group>
  );
}

export function Vegetation() {
  const palms = useMemo(() => {
    const r = seededRand(42);
    const items: { pos: [number, number, number]; scale: number; rot: number }[] = [];
    let attempts = 0;
    while (items.length < 28 && attempts < 800) {
      attempts++;
      const angle = r() * Math.PI * 2;
      const dist = 6 + r() * (ISLAND_RADIUS - 8);
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      const y = heightAt(x, z);
      if (y < 0.4 || y > 5) continue;
      if (items.some((p) => Math.hypot(p.pos[0] - x, p.pos[2] - z) < 3.5)) continue;
      items.push({ pos: [x, y - 0.05, z], scale: 0.9 + r() * 0.6, rot: r() * Math.PI * 2 });
    }
    return items;
  }, []);

  const rocksRef = useRef<THREE.InstancedMesh>(null);
  const rockCount = 60;
  const rockMatrices = useMemo(() => {
    const r = seededRand(99);
    const arr: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    let attempts = 0;
    while (arr.length < rockCount && attempts < 1500) {
      attempts++;
      const angle = r() * Math.PI * 2;
      const dist = r() * (ISLAND_RADIUS + 4);
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      const y = heightAt(x, z);
      if (y < -1.5 || y > 7) continue;
      const s = 0.3 + r() * 0.9;
      dummy.position.set(x, y - 0.05, z);
      dummy.rotation.set(r() * 0.5, r() * Math.PI * 2, r() * 0.5);
      dummy.scale.set(s, s * (0.6 + r() * 0.5), s);
      dummy.updateMatrix();
      arr.push(dummy.matrix.clone());
    }
    return arr;
  }, []);

  const grassCount = 400;
  const grassMatrices = useMemo(() => {
    const r = seededRand(7);
    const arr: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    let attempts = 0;
    while (arr.length < grassCount && attempts < 4000) {
      attempts++;
      const angle = r() * Math.PI * 2;
      const dist = r() * (ISLAND_RADIUS - 4);
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      const y = heightAt(x, z);
      if (y < 1.0 || y > 6) continue;
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, r() * Math.PI * 2, 0);
      const s = 0.25 + r() * 0.35;
      dummy.scale.set(s, s * 1.6, s);
      dummy.updateMatrix();
      arr.push(dummy.matrix.clone());
    }
    return arr;
  }, []);

  return (
    <group>
      {palms.map((p, i) => (
        <PalmTree key={i} position={p.pos} scale={p.scale} rotation={p.rot} />
      ))}

      <instancedMesh
        ref={rocksRef}
        args={[undefined as any, undefined as any, rockMatrices.length]}
        castShadow
        receiveShadow
        onUpdate={(self) => {
          rockMatrices.forEach((m, i) => self.setMatrixAt(i, m));
          self.instanceMatrix.needsUpdate = true;
        }}
      >
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color="#7a7060" roughness={0.95} />
      </instancedMesh>

      <instancedMesh
        args={[undefined as any, undefined as any, grassMatrices.length]}
        castShadow
        onUpdate={(self) => {
          grassMatrices.forEach((m, i) => self.setMatrixAt(i, m));
          self.instanceMatrix.needsUpdate = true;
        }}
      >
        <coneGeometry args={[0.3, 1, 4]} />
        <meshStandardMaterial color="#5d8a3a" roughness={0.9} side={THREE.DoubleSide} />
      </instancedMesh>
    </group>
  );
}
