import { Sky, Environment, useTexture, Cloud, Clouds } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, SMAA, BrightnessContrast } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { World } from "./world";
import { EventsPortal } from "./EventsPortal";

const VILLAGE_RADIUS = 60;

function esmeraldaHeight(x: number, z: number): number {
  const dx = x;
  const dz = z + 14;
  const r = Math.sqrt(dx * dx + dz * dz);
  const mound = Math.max(0, 0.6 - r * 0.08);
  return mound;
}

function Ground() {
  const colorMap = useTexture("https://threejs.org/examples/textures/terrain/grasslight-big.jpg");
  colorMap.wrapS = colorMap.wrapT = THREE.RepeatWrapping;
  colorMap.repeat.set(40, 40);
  colorMap.anisotropy = 8;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <circleGeometry args={[VILLAGE_RADIUS + 40, 96]} />
      <meshStandardMaterial map={colorMap} roughness={0.95} metalness={0} color="#9eb87a" />
    </mesh>
  );
}

function Plaza() {
  const stone = useTexture("https://threejs.org/examples/textures/brick_diffuse.jpg");
  stone.wrapS = stone.wrapT = THREE.RepeatWrapping;
  stone.repeat.set(8, 8);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
        <circleGeometry args={[22, 64]} />
        <meshStandardMaterial map={stone} color="#c9b89a" roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} receiveShadow>
        <ringGeometry args={[8.4, 9.2, 64]} />
        <meshStandardMaterial color="#857560" roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} receiveShadow>
        <ringGeometry args={[21.6, 22, 64]} />
        <meshStandardMaterial color="#857560" roughness={0.95} />
      </mesh>
    </group>
  );
}

function Paths() {
  const stone = useTexture("https://threejs.org/examples/textures/brick_diffuse.jpg");
  stone.wrapS = stone.wrapT = THREE.RepeatWrapping;
  stone.repeat.set(4, 1);
  const paths = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const len = VILLAGE_RADIUS - 20;
    paths.push(
      <mesh
        key={i}
        rotation={[-Math.PI / 2, 0, -a]}
        position={[Math.cos(a) * (22 + len / 2), 0.04, Math.sin(a) * (22 + len / 2)]}
        receiveShadow
      >
        <planeGeometry args={[len, 2.6]} />
        <meshStandardMaterial map={stone} color="#c4ad88" roughness={0.95} />
      </mesh>
    );
  }
  return <group>{paths}</group>;
}

function GrassField({ count = 4000 }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const matrices = useMemo(() => {
    const m = new THREE.Matrix4();
    const arr: number[] = [];
    let s = 7777;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 24 + rnd() * (VILLAGE_RADIUS + 20);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x, z) < 23) continue;
      const sc = 0.6 + rnd() * 0.6;
      m.makeRotationY(rnd() * Math.PI * 2);
      m.scale(new THREE.Vector3(sc, sc, sc));
      m.setPosition(x, 0, z);
      arr.push(...m.toArray());
    }
    return arr;
  }, [count]);

  useFrame((state) => {
    if (!ref.current) return;
    const mat = ref.current.material as any;
    if (mat.userData.shader) {
      mat.userData.shader.uniforms.uTime.value = state.clock.elapsedTime;
    }
  });

  const blades = matrices.length / 16;

  const geom = useMemo(() => {
    const g = new THREE.PlaneGeometry(0.08, 0.5, 1, 1);
    g.translate(0, 0.25, 0);
    return g;
  }, []);

  return (
    <instancedMesh
      ref={(node) => {
        if (!node) return;
        ref.current = node;
        const tmp = new THREE.Matrix4();
        for (let i = 0; i < blades; i++) {
          tmp.fromArray(matrices, i * 16);
          node.setMatrixAt(i, tmp);
        }
        node.instanceMatrix.needsUpdate = true;
      }}
      args={[geom, undefined, blades]}
      receiveShadow
      castShadow={false}
    >
      <meshStandardMaterial
        ref={(mat) => {
          if (!mat) return;
          mat.onBeforeCompile = (shader) => {
            shader.uniforms.uTime = { value: 0 };
            shader.vertexShader = "uniform float uTime;\n" + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace(
              "#include <begin_vertex>",
              `#include <begin_vertex>
               float sway = sin(uTime * 2.0 + position.x * 5.0 + position.z * 5.0) * 0.05 * uv.y;
               transformed.x += sway;`
            );
            mat.userData.shader = shader;
          };
        }}
        color="#6a9a4a"
        side={THREE.DoubleSide}
        roughness={1}
      />
    </instancedMesh>
  );
}

function WaterTower() {
  const metal = useTexture("https://threejs.org/examples/textures/waternormals.jpg");
  return (
    <group position={[0, 0, -16]}>
      <mesh position={[0, 0.4, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[3.4, 3.8, 0.8, 24]} />
        <meshStandardMaterial color="#9b8d78" roughness={0.95} />
      </mesh>
      {[0, 1, 2, 3].map((i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        return (
          <group key={i} position={[Math.cos(a) * 1.8, 0, Math.sin(a) * 1.8]}>
            <mesh position={[0, 5, 0]} castShadow>
              <boxGeometry args={[0.32, 9, 0.32]} />
              <meshStandardMaterial
                color="#1f1f1f"
                roughness={0.6}
                metalness={0.85}
                normalMap={metal}
                normalScale={new THREE.Vector2(0.3, 0.3)}
              />
            </mesh>
          </group>
        );
      })}
      {[1, 3, 5, 7].map((h) => (
        <group key={h} position={[0, h, 0]}>
          {[0, 1, 2, 3].map((i) => {
            const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
            const ax = Math.cos(a) * 1.8;
            const az = Math.sin(a) * 1.8;
            const a2 = ((i + 1) / 4) * Math.PI * 2 + Math.PI / 4;
            const bx = Math.cos(a2) * 1.8;
            const bz = Math.sin(a2) * 1.8;
            const len = Math.hypot(bx - ax, bz - az);
            const angle = Math.atan2(bz - az, bx - ax);
            return (
              <mesh
                key={i}
                position={[(ax + bx) / 2, 0, (az + bz) / 2]}
                rotation={[0, -angle, 0]}
                castShadow
              >
                <boxGeometry args={[len, 0.12, 0.12]} />
                <meshStandardMaterial color="#1f1f1f" roughness={0.6} metalness={0.85} />
              </mesh>
            );
          })}
        </group>
      ))}
      <mesh position={[0, 10.5, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[3.0, 3.0, 4.0, 32]} />
        <meshStandardMaterial
          color="#6a6358"
          roughness={0.55}
          metalness={0.65}
          normalMap={metal}
          normalScale={new THREE.Vector2(0.5, 0.5)}
        />
      </mesh>
      <mesh position={[0, 10.5, 0]}>
        <cylinderGeometry args={[3.01, 3.01, 1.2, 32]} />
        <meshStandardMaterial color="#e9e2d2" roughness={0.85} />
      </mesh>
      <mesh position={[0, 13.2, 0]} castShadow>
        <sphereGeometry args={[3.0, 32, 24, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#2c5a3c" roughness={0.55} metalness={0.4} />
      </mesh>
      <mesh position={[0, 14.6, 0]} castShadow>
        <coneGeometry args={[0.18, 0.9, 12]} />
        <meshStandardMaterial color="#1a3a26" metalness={0.6} roughness={0.4} />
      </mesh>
    </group>
  );
}

function Gazebo() {
  const wood = useTexture("https://threejs.org/examples/textures/hardwood2_diffuse.jpg");
  wood.wrapS = wood.wrapT = THREE.RepeatWrapping;
  wood.repeat.set(2, 2);
  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 0.2, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[2.6, 2.6, 0.4, 16]} />
        <meshStandardMaterial map={wood} color="#a07a4a" roughness={0.85} />
      </mesh>
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const a = (i / 6) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * 2.2, 1.8, Math.sin(a) * 2.2]}
            castShadow
          >
            <cylinderGeometry args={[0.1, 0.12, 3.0, 12]} />
            <meshStandardMaterial map={wood} color="#5a3a22" roughness={0.85} />
          </mesh>
        );
      })}
      <mesh position={[0, 3.6, 0]} rotation={[0, Math.PI / 6, 0]} castShadow>
        <coneGeometry args={[3.0, 1.8, 6]} />
        <meshStandardMaterial color="#3a4a2a" roughness={0.7} metalness={0.1} />
      </mesh>
      <mesh position={[0, 4.7, 0]} castShadow>
        <coneGeometry args={[0.14, 0.6, 8]} />
        <meshStandardMaterial color="#1a2a14" metalness={0.5} />
      </mesh>
    </group>
  );
}

function AILab({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.15, 0]} receiveShadow castShadow>
        <boxGeometry args={[6, 0.3, 6]} />
        <meshStandardMaterial color="#999" roughness={0.9} />
      </mesh>
      {[
        [-2.4, -2.4],
        [2.4, -2.4],
        [-2.4, 2.4],
        [2.4, 2.4],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, 2.4, z]} castShadow>
          <boxGeometry args={[0.15, 4.5, 0.15]} />
          <meshStandardMaterial color="#1a1a1a" metalness={0.95} roughness={0.25} />
        </mesh>
      ))}
      {[-2.4, 2.4].map((z, i) => (
        <mesh key={i} position={[0, 4.6, z]} castShadow>
          <boxGeometry args={[5, 0.15, 0.15]} />
          <meshStandardMaterial color="#1a1a1a" metalness={0.95} roughness={0.25} />
        </mesh>
      ))}
      {[-2.4, 2.4].map((x, i) => (
        <mesh key={i} position={[x, 4.6, 0]} castShadow>
          <boxGeometry args={[0.15, 0.15, 5]} />
          <meshStandardMaterial color="#1a1a1a" metalness={0.95} roughness={0.25} />
        </mesh>
      ))}
      <mesh position={[0, 2.4, 2.4]} castShadow receiveShadow>
        <boxGeometry args={[4.8, 4.4, 0.05]} />
        <meshPhysicalMaterial
          color="#cce8f5"
          transmission={0.95}
          transparent
          opacity={1}
          roughness={0.05}
          metalness={0}
          ior={1.45}
          thickness={0.5}
          clearcoat={1}
          clearcoatRoughness={0.05}
        />
      </mesh>
      <mesh position={[0, 2.4, -2.4]} castShadow receiveShadow>
        <boxGeometry args={[4.8, 4.4, 0.05]} />
        <meshPhysicalMaterial
          color="#cce8f5"
          transmission={0.95}
          transparent
          opacity={1}
          roughness={0.05}
          ior={1.45}
          thickness={0.5}
        />
      </mesh>
      <mesh position={[2.4, 2.4, 0]} rotation={[0, Math.PI / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[4.8, 4.4, 0.05]} />
        <meshPhysicalMaterial
          color="#cce8f5"
          transmission={0.95}
          transparent
          opacity={1}
          roughness={0.05}
          ior={1.45}
          thickness={0.5}
        />
      </mesh>
      <mesh position={[-2.4, 2.4, 0]} rotation={[0, Math.PI / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[4.8, 4.4, 0.05]} />
        <meshPhysicalMaterial
          color="#cce8f5"
          transmission={0.95}
          transparent
          opacity={1}
          roughness={0.05}
          ior={1.45}
          thickness={0.5}
        />
      </mesh>
      <mesh position={[0, 4.7, 0]} castShadow>
        <boxGeometry args={[5, 0.25, 5]} />
        <meshStandardMaterial color="#222" roughness={0.6} metalness={0.4} />
      </mesh>
      <pointLight position={[0, 3, 0]} intensity={1.6} color="#ffd07a" distance={10} decay={2} />
      <mesh position={[0, 1.4, 2.46]}>
        <planeGeometry args={[2.2, 0.4]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.85} />
      </mesh>
    </group>
  );
}

function Cottage({
  position,
  rotation = 0,
  paint = "#d8c5a4",
  roof = "#5a3a2a",
}: {
  position: [number, number, number];
  rotation?: number;
  paint?: string;
  roof?: string;
}) {
  const wood = useTexture("https://threejs.org/examples/textures/hardwood2_diffuse.jpg");
  wood.wrapS = wood.wrapT = THREE.RepeatWrapping;
  wood.repeat.set(2, 2);
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[3.6, 2.6, 3.0]} />
        <meshStandardMaterial color={paint} roughness={0.9} />
      </mesh>
      <mesh position={[0, 3.2, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[2.7, 1.6, 4]} />
        <meshStandardMaterial color={roof} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.1, 1.7]} receiveShadow castShadow>
        <boxGeometry args={[3.6, 0.2, 0.6]} />
        <meshStandardMaterial map={wood} color="#7a5230" />
      </mesh>
      <mesh position={[0, 0.9, 1.51]}>
        <planeGeometry args={[0.7, 1.4]} />
        <meshStandardMaterial color="#3a2210" side={THREE.DoubleSide} />
      </mesh>
      {[-1.1, 1.1].map((x, i) => (
        <mesh key={i} position={[x, 1.5, 1.51]}>
          <planeGeometry args={[0.7, 0.6]} />
          <meshStandardMaterial color="#ffd07a" emissive="#ffaa44" emissiveIntensity={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function Stage({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  const wood = useTexture("https://threejs.org/examples/textures/hardwood2_diffuse.jpg");
  wood.wrapS = wood.wrapT = THREE.RepeatWrapping;
  wood.repeat.set(3, 1);
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
        <boxGeometry args={[8, 1.0, 5]} />
        <meshStandardMaterial map={wood} color="#5a4632" roughness={0.85} />
      </mesh>
      <mesh position={[0, 2.8, -2.0]} castShadow>
        <boxGeometry args={[6.4, 3.4, 0.25]} />
        <meshStandardMaterial
          color="#0a0a14"
          emissive="#7b3aff"
          emissiveIntensity={1.2}
          roughness={0.3}
          metalness={0.5}
        />
      </mesh>
      <pointLight position={[0, 2.8, -1.5]} intensity={1.2} color="#a07aff" distance={12} />
      {[-3.2, 3.2].map((x, i) => (
        <mesh key={i} position={[x, 1.8, -1.8]} castShadow>
          <boxGeometry args={[0.7, 1.8, 0.7]} />
          <meshStandardMaterial color="#1a1a1a" roughness={0.5} metalness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function Pavilion({
  position,
  rotation = 0,
  paint = "#d8c5a4",
  roof = "#3a4f78",
}: {
  position: [number, number, number];
  rotation?: number;
  paint?: string;
  roof?: string;
}) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[4.4, 2.6, 3.6]} />
        <meshStandardMaterial color={paint} roughness={0.9} />
      </mesh>
      <mesh position={[0, 3.3, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[3.2, 1.8, 4]} />
        <meshStandardMaterial color={roof} roughness={0.7} />
      </mesh>
      <mesh position={[0, 1.0, 1.81]}>
        <planeGeometry args={[0.8, 1.6]} />
        <meshStandardMaterial color="#3a2210" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[1.5, 1.6, 1.81]}>
        <planeGeometry args={[0.8, 0.6]} />
        <meshStandardMaterial color="#ffd07a" emissive="#ffaa44" emissiveIntensity={0.7} />
      </mesh>
      <mesh position={[-1.5, 1.6, 1.81]}>
        <planeGeometry args={[0.8, 0.6]} />
        <meshStandardMaterial color="#ffd07a" emissive="#ffaa44" emissiveIntensity={0.7} />
      </mesh>
    </group>
  );
}

function SaunaDeck({ position }: { position: [number, number, number] }) {
  const wood = useTexture("https://threejs.org/examples/textures/hardwood2_diffuse.jpg");
  wood.wrapS = wood.wrapT = THREE.RepeatWrapping;
  wood.repeat.set(3, 2);
  return (
    <group position={position}>
      <mesh position={[0, 0.15, 0]} receiveShadow castShadow>
        <boxGeometry args={[6.5, 0.3, 4.4]} />
        <meshStandardMaterial map={wood} color="#7a5230" roughness={0.8} />
      </mesh>
      <mesh position={[-1.6, 1.2, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.6, 2.0, 2.6]} />
        <meshStandardMaterial color="#5a3a22" roughness={0.9} />
      </mesh>
      <mesh position={[-1.6, 2.6, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[2.0, 1.0, 4]} />
        <meshStandardMaterial color="#2a1a10" roughness={0.7} />
      </mesh>
      <pointLight position={[-1.6, 2.0, 0]} intensity={0.6} color="#ffe8c8" distance={5} />
      <mesh position={[1.7, 0.32, 0]}>
        <cylinderGeometry args={[1.2, 1.2, 0.4, 32]} />
        <meshPhysicalMaterial
          color="#5fc8d8"
          transmission={0.7}
          transparent
          opacity={0.9}
          roughness={0.05}
          ior={1.33}
          thickness={0.4}
        />
      </mesh>
    </group>
  );
}

function SoccerField({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} receiveShadow>
        <planeGeometry args={[10, 6.5]} />
        <meshStandardMaterial color="#4a8a3a" roughness={1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
        <planeGeometry args={[0.12, 6.5]} />
        <meshStandardMaterial color="#fff" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
        <ringGeometry args={[0.85, 0.92, 32]} />
        <meshStandardMaterial color="#fff" side={THREE.DoubleSide} />
      </mesh>
      {[-4.9, 4.9].map((x, i) => (
        <group key={i} position={[x, 0, 0]}>
          <mesh position={[0, 0.5, -1]} castShadow>
            <boxGeometry args={[0.08, 1.0, 0.08]} />
            <meshStandardMaterial color="#fff" />
          </mesh>
          <mesh position={[0, 0.5, 1]} castShadow>
            <boxGeometry args={[0.08, 1.0, 0.08]} />
            <meshStandardMaterial color="#fff" />
          </mesh>
          <mesh position={[0, 1.0, 0]} castShadow>
            <boxGeometry args={[0.08, 0.08, 2]} />
            <meshStandardMaterial color="#fff" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Palm({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      {[0, 1, 2, 3, 4].map((i) => (
        <mesh
          key={i}
          position={[Math.sin(i * 0.4) * 0.08, 0.5 + i * 1.0, Math.cos(i * 0.4) * 0.05]}
          rotation={[0, 0, Math.sin(i * 0.4) * 0.08]}
          castShadow
        >
          <cylinderGeometry args={[0.2 - i * 0.02, 0.24 - i * 0.02, 1.05, 10]} />
          <meshStandardMaterial color="#7a5836" roughness={0.95} />
        </mesh>
      ))}
      {Array.from({ length: 9 }).map((_, i) => {
        const a = (i / 9) * Math.PI * 2;
        const tilt = -0.7 - (i % 2) * 0.2;
        return (
          <group key={i} position={[0, 5.4, 0]} rotation={[0, a, 0]}>
            <mesh position={[1.4, 0.1, 0]} rotation={[0, 0, tilt]} castShadow>
              <coneGeometry args={[0.4, 2.6, 6]} />
              <meshStandardMaterial color="#2f7a3f" roughness={0.85} side={THREE.DoubleSide} />
            </mesh>
          </group>
        );
      })}
      {[0, 1, 2].map((i) => (
        <mesh
          key={i}
          position={[Math.cos(i * 2) * 0.25, 5.2, Math.sin(i * 2) * 0.25]}
          castShadow
        >
          <sphereGeometry args={[0.16, 10, 10]} />
          <meshStandardMaterial color="#4a3220" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function OakTree({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 1.2, 0]} castShadow>
        <cylinderGeometry args={[0.28, 0.4, 2.4, 10]} />
        <meshStandardMaterial color="#5a3a22" roughness={0.95} />
      </mesh>
      <mesh position={[0, 3.1, 0]} castShadow>
        <sphereGeometry args={[1.6, 16, 12]} />
        <meshStandardMaterial color="#2f6a3a" roughness={0.9} />
      </mesh>
      <mesh position={[0.9, 3.4, 0.5]} castShadow>
        <sphereGeometry args={[1.1, 14, 10]} />
        <meshStandardMaterial color="#3a7a4a" roughness={0.9} />
      </mesh>
      <mesh position={[-0.8, 3.2, -0.6]} castShadow>
        <sphereGeometry args={[1.2, 14, 10]} />
        <meshStandardMaterial color="#356a3a" roughness={0.9} />
      </mesh>
      <mesh position={[0.2, 3.9, -0.7]} castShadow>
        <sphereGeometry args={[0.9, 14, 10]} />
        <meshStandardMaterial color="#4a8a4a" roughness={0.9} />
      </mesh>
    </group>
  );
}

function Vegetation() {
  const { palms, oaks } = useMemo(() => {
    let s = 4242;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    const palms: [number, number, number][] = [];
    const oaks: { pos: [number, number, number]; scale: number }[] = [];
    for (let i = 0; i < 80; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 26 + rnd() * 32;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const skip = DISTRICT_POSITIONS.some(
        ([dx, , dz]) => Math.hypot(x - dx, z - dz) < 8
      );
      if (skip) continue;
      if (rnd() < 0.3) palms.push([x, 0, z]);
      else oaks.push({ pos: [x, 0, z], scale: 0.85 + rnd() * 0.5 });
    }
    return { palms, oaks };
  }, []);
  return (
    <group>
      {palms.map((p, i) => (
        <Palm key={`p${i}`} position={p} />
      ))}
      {oaks.map((t, i) => (
        <OakTree key={`o${i}`} position={t.pos} scale={t.scale} />
      ))}
    </group>
  );
}

function Person({
  position,
  shirt,
  pant = "#2a2a3a",
}: {
  position: [number, number, number];
  shirt: string;
  pant?: string;
}) {
  const ref = useRef<THREE.Group>(null);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);
  useFrame((state) => {
    if (!ref.current) return;
    ref.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.5 + phase) * 0.2;
  });
  return (
    <group ref={ref} position={position}>
      <mesh position={[0, 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.18, 0.22, 0.9, 10]} />
        <meshStandardMaterial color={pant} roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.2, 0]} castShadow>
        <cylinderGeometry args={[0.24, 0.24, 0.55, 10]} />
        <meshStandardMaterial color={shirt} roughness={0.8} />
      </mesh>
      <mesh position={[0, 1.65, 0]} castShadow>
        <sphereGeometry args={[0.2, 14, 14]} />
        <meshStandardMaterial color="#e2b58a" roughness={0.8} />
      </mesh>
      <mesh position={[0, 1.78, -0.02]} castShadow>
        <sphereGeometry args={[0.21, 14, 14, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#3a2a18" roughness={0.85} />
      </mesh>
    </group>
  );
}

function Crowd() {
  const clusters = useMemo(() => {
    let s = 9999;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    const palette = ["#e94560", "#3aa5ff", "#f7b733", "#7a5fff", "#3ad29f", "#ff6b6b", "#ffa07a", "#9b6dff"];
    const out: { pos: [number, number, number]; shirt: string }[] = [];
    const centers: [number, number][] = [
      [0, 6], [-6, -2], [7, 2], [-18, 14], [16, -16], [-14, -14], [22, 8], [-22, 8], [0, 26],
    ];
    for (const [cx, cz] of centers) {
      const n = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const r = rnd() * 1.8;
        out.push({
          pos: [cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r],
          shirt: palette[Math.floor(rnd() * palette.length)],
        });
      }
    }
    return out;
  }, []);
  return (
    <group>
      {clusters.map((c, i) => (
        <Person key={i} position={c.pos} shirt={c.shirt} />
      ))}
    </group>
  );
}

type District = {
  label: string;
  sub: string;
  pos: [number, number, number];
  build: () => JSX.Element;
};

const DISTRICTS: District[] = [
  { label: "Innovate", sub: "AI Lab", pos: [-15, 0, -15], build: () => <AILab position={[-15, 0, -15]} /> },
  { label: "Events", sub: "Portal Arena", pos: [19, 0, -15], build: () => <EventsPortal position={[19, 0, -15]} rotation={-0.5} /> },
  { label: "Learn", sub: "Knowledge Hub", pos: [-24, 0, 9], build: () => <Pavilion position={[-24, 0, 9]} rotation={0.3} paint="#b88a5a" roof="#3a4f78" /> },
  { label: "Meditate", sub: "Wellness Garden", pos: [24, 0, 9], build: () => <Pavilion position={[24, 0, 9]} rotation={-0.3} paint="#d8c4a4" roof="#6a8a4a" /> },
  { label: "Sauna & Plunge", sub: "Recharge", pos: [28, 0, -3], build: () => <SaunaDeck position={[28, 0, -3]} /> },
  { label: "Kids", sub: "Creative Residency", pos: [-24, 0, 24], build: () => <Cottage position={[-24, 0, 24]} rotation={0.4} paint="#e8b984" roof="#7a3a2a" /> },
  { label: "Build", sub: "Maker District", pos: [24, 0, 24], build: () => <Cottage position={[24, 0, 24]} rotation={-0.4} paint="#9a8266" roof="#3a3a3a" /> },
  { label: "Field", sub: "For casual sports", pos: [0, 0, 28], build: () => <SoccerField position={[0, 0, 28]} /> },
  { label: "Gather", sub: "Community Plaza", pos: [0, 0, -6], build: () => <></> },
];

const DISTRICT_POSITIONS = DISTRICTS.map((d) => d.pos);

function Label({
  text,
  sub,
  pos,
}: {
  text: string;
  sub: string;
  pos: [number, number, number];
}) {
  const texture = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 192;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    const r = 40;
    const w = c.width - 16,
      h = c.height - 16,
      x = 8,
      y = 8;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#1a1a2e";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 64px system-ui, -apple-system, sans-serif";
    ctx.fillText(text, c.width / 2, 78);
    ctx.fillStyle = "#5a5a72";
    ctx.font = "32px system-ui, -apple-system, sans-serif";
    ctx.fillText(sub, c.width / 2, 138);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }, [text, sub]);
  return (
    <sprite position={pos} scale={[3.4, 1.3, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

function DistrictLabels() {
  return (
    <group>
      {DISTRICTS.map((d, i) => (
        <Label key={i} text={d.label} sub={d.sub} pos={[d.pos[0], 5.4, d.pos[2]]} />
      ))}
    </group>
  );
}

function DistantHills() {
  const hills = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const r = 130;
    hills.push(
      <mesh key={i} position={[Math.cos(a) * r, 6, Math.sin(a) * r]}>
        <coneGeometry args={[28, 14, 10]} />
        <meshStandardMaterial color="#4a6a4a" roughness={1} />
      </mesh>
    );
  }
  return <group>{hills}</group>;
}

function EsmeraldaPhotorealScene() {
  const sunPos = useMemo(() => new THREE.Vector3(35, 55, 25), []);
  return (
    <>
      <fog attach="fog" args={["#d6e6f4", 100, 240]} />
      <color attach="background" args={["#a8cef0"]} />
      <Sky
        distance={4500}
        sunPosition={[sunPos.x, sunPos.y, sunPos.z]}
        inclination={0.55}
        azimuth={0.25}
        turbidity={3}
        rayleigh={1.0}
        mieCoefficient={0.005}
        mieDirectionalG={0.85}
      />
      <Environment preset="park" />
      <ambientLight intensity={0.45} color="#fff5e0" />
      <directionalLight
        position={[sunPos.x, sunPos.y, sunPos.z]}
        intensity={2.2}
        color="#fff2d0"
        castShadow
        shadow-mapSize-width={4096}
        shadow-mapSize-height={4096}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-near={1}
        shadow-camera-far={250}
        shadow-bias={-0.0003}
      />
      <DistantHills />
      <Ground />
      <Plaza />
      <Paths />
      <GrassField count={2000} />
      <WaterTower />
      <Gazebo />
      {DISTRICTS.map((d, i) => (
        <group key={i}>{d.build()}</group>
      ))}
      <Vegetation />
      <Crowd />
      <DistrictLabels />

      <Clouds material={THREE.MeshBasicMaterial} limit={20}>
        <Cloud seed={1} segments={20} bounds={[12, 2, 12]} volume={6} position={[20, 28, -30]} color="#ffffff" opacity={0.7} />
        <Cloud seed={2} segments={20} bounds={[12, 2, 12]} volume={6} position={[-30, 32, -10]} color="#ffffff" opacity={0.7} />
        <Cloud seed={3} segments={20} bounds={[10, 2, 10]} volume={5} position={[10, 30, 30]} color="#ffffff" opacity={0.6} />
      </Clouds>

      <EffectComposer multisampling={0}>
        <SMAA />
        <Bloom
          intensity={0.5}
          luminanceThreshold={0.85}
          luminanceSmoothing={0.2}
          mipmapBlur
        />
        <BrightnessContrast brightness={0.02} contrast={0.06} />
        <Vignette eskil={false} offset={0.15} darkness={0.55} blendFunction={BlendFunction.NORMAL} />
      </EffectComposer>
    </>
  );
}

export const ESMERALDA_PHOTOREAL_WORLD: World = {
  id: "esmeralda",
  name: "Edge Esmeralda",
  tagline: "Photoreal pop-up village in Sonoma",
  description:
    "Real PBR materials, glass-and-steel AI lab, weathered water tower, instanced grass and rolling hills.",
  accent: "from-emerald-500/40 to-sky-700/40",
  spawn: { x: 0, y: 1, z: 16, yaw: 0 },
  heightAt: esmeraldaHeight,
  Scene: EsmeraldaPhotorealScene,
  hasShells: false,
  hudAccent: "emerald",
};
