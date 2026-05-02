import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import {
  ISLAND_RADIUS,
  SEA_LEVEL,
  heightAt,
  seededRandom,
  slopeAt,
} from "./terrain";

interface PalmSpec {
  position: [number, number, number];
  scale: number;
  rotation: number;
  lean: number;
  leanAxis: number;
  swayPhase: number;
}

interface RockSpec {
  position: [number, number, number];
  scale: [number, number, number];
  rotation: [number, number, number];
}

const PALM_TRUNK_COLOR = new THREE.Color("#6b4a2b");
const PALM_FROND_COLOR = new THREE.Color("#3f7a3a");
const PALM_FROND_TIP = new THREE.Color("#7bbf5d");
const ROCK_COLOR = new THREE.Color("#736a60");

function placeCandidate(
  rand: () => number,
  minR: number,
  maxR: number,
): [number, number, number] | null {
  const r = minR + rand() * (maxR - minR);
  const a = rand() * Math.PI * 2;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  const y = heightAt(x, z);
  if (y < SEA_LEVEL + 0.5) return null;
  if (slopeAt(x, z) > 0.55) return null;
  return [x, y, z];
}

export function Foliage() {
  const palms = useMemo<PalmSpec[]>(() => {
    const rand = seededRandom(20260502);
    const specs: PalmSpec[] = [];
    let attempts = 0;
    while (specs.length < 14 && attempts < 400) {
      attempts++;
      const p = placeCandidate(rand, 6, ISLAND_RADIUS - 8);
      if (!p) continue;
      // Avoid clustering
      const tooClose = specs.some(
        (s) =>
          (s.position[0] - p[0]) ** 2 + (s.position[2] - p[2]) ** 2 < 36,
      );
      if (tooClose) continue;
      specs.push({
        position: p,
        scale: 0.85 + rand() * 0.6,
        rotation: rand() * Math.PI * 2,
        lean: 0.04 + rand() * 0.12,
        leanAxis: rand() * Math.PI * 2,
        swayPhase: rand() * Math.PI * 2,
      });
    }
    return specs;
  }, []);

  const rocks = useMemo<RockSpec[]>(() => {
    const rand = seededRandom(11235);
    const specs: RockSpec[] = [];
    let attempts = 0;
    while (specs.length < 28 && attempts < 600) {
      attempts++;
      const p = placeCandidate(rand, 3, ISLAND_RADIUS - 2);
      if (!p) continue;
      const sx = 0.6 + rand() * 1.4;
      const sy = 0.45 + rand() * 1.0;
      const sz = 0.6 + rand() * 1.4;
      specs.push({
        position: [p[0], p[1] - 0.15, p[2]],
        scale: [sx, sy, sz],
        rotation: [rand() * 0.5, rand() * Math.PI * 2, rand() * 0.5],
      });
    }
    return specs;
  }, []);

  return (
    <group>
      {palms.map((spec, i) => (
        <PalmTree key={`palm-${i}`} spec={spec} />
      ))}
      <Rocks specs={rocks} />
    </group>
  );
}

function PalmTree({ spec }: { spec: PalmSpec }) {
  const swayRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    const g = swayRef.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    g.rotation.z = Math.sin(t * 0.9 + spec.swayPhase) * 0.02;
    g.rotation.x = Math.cos(t * 0.7 + spec.swayPhase) * 0.015;
  });

  const trunkHeight = 5.5 * spec.scale;
  const trunkRadius = 0.22 * spec.scale;

  return (
    <group position={spec.position} rotation={[0, spec.rotation, 0]}>
      <group rotation={[0, spec.leanAxis, spec.lean]}>
        <group ref={swayRef}>
          {/* Trunk — tapered, slightly bent feel via stacked cones */}
          <mesh
            position={[0, trunkHeight / 2, 0]}
            castShadow
            receiveShadow
          >
            <cylinderGeometry
              args={[trunkRadius * 0.7, trunkRadius, trunkHeight, 10, 6]}
            />
            <meshStandardMaterial
              color={PALM_TRUNK_COLOR}
              roughness={0.9}
            />
          </mesh>
          {/* Fronds — six flattened paraboloids in a starburst */}
          <group position={[0, trunkHeight, 0]}>
            {Array.from({ length: 7 }).map((_, j) => {
              const a = (j / 7) * Math.PI * 2;
              const tilt = -0.55 - (j % 2) * 0.08;
              return (
                <mesh
                  key={j}
                  rotation={[tilt, a, 0]}
                  position={[
                    Math.cos(a) * 0.15,
                    0.05,
                    Math.sin(a) * 0.15,
                  ]}
                  castShadow
                >
                  <coneGeometry args={[0.55 * spec.scale, 3.2 * spec.scale, 5, 1, true]} />
                  <meshStandardMaterial
                    color={PALM_FROND_COLOR}
                    emissive={PALM_FROND_TIP}
                    emissiveIntensity={0.04}
                    roughness={0.7}
                    side={THREE.DoubleSide}
                  />
                </mesh>
              );
            })}
            {/* Coconut cluster */}
            <mesh position={[0, -0.15, 0]} castShadow>
              <icosahedronGeometry args={[0.32 * spec.scale, 0]} />
              <meshStandardMaterial
                color="#3a2618"
                roughness={0.85}
              />
            </mesh>
          </group>
        </group>
      </group>
    </group>
  );
}

function Rocks({ specs }: { specs: RockSpec[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = specs.length;

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    const dummy = new THREE.Object3D();
    specs.forEach((s, i) => {
      dummy.position.set(...s.position);
      dummy.rotation.set(...s.rotation);
      dummy.scale.set(...s.scale);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [specs]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, count]}
      castShadow
      receiveShadow
    >
      <icosahedronGeometry args={[0.7, 0]} />
      <meshStandardMaterial color={ROCK_COLOR} roughness={0.95} flatShading />
    </instancedMesh>
  );
}
