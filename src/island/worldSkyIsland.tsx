import { Sky, Cloud, Clouds, Environment, Sparkles } from "@react-three/drei";
import * as THREE from "three";
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { World } from "./world";

const ISLAND_RADIUS = 38;
const ISLAND_TOP_Y = 0;
const ISLAND_DEPTH = 28;

function islandFalloff(r: number): number {
  const t = THREE.MathUtils.clamp(1 - r / ISLAND_RADIUS, 0, 1);
  return Math.pow(t, 0.55);
}

function hill(x: number, z: number): number {
  return (
    Math.sin(x * 0.12) * Math.cos(z * 0.1) * 0.6 +
    Math.sin((x + z) * 0.07) * 0.4
  );
}

export function skyIslandHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r > ISLAND_RADIUS - 0.5) {
    return -200;
  }
  const f = islandFalloff(r);
  return ISLAND_TOP_Y + hill(x, z) * f * 0.6;
}

function GrassTop() {
  const geo = useMemo(() => {
    const g = new THREE.CircleGeometry(ISLAND_RADIUS, 96);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color("#6fa84a");
    const darkGrass = new THREE.Color("#3f7a36");
    const dirt = new THREE.Color("#8a6a44");
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const r = Math.hypot(x, z);
      const f = islandFalloff(r);
      const y = hill(x, z) * f * 0.6 + (f - 1) * 0.3;
      pos.setY(i, y);
      const edge = THREE.MathUtils.clamp((r - ISLAND_RADIUS * 0.85) / (ISLAND_RADIUS * 0.15), 0, 1);
      tmp.copy(grass).lerp(darkGrass, Math.abs(hill(x, z)) * 0.4);
      tmp.lerp(dirt, edge);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, []);
  return (
    <mesh geometry={geo} receiveShadow castShadow>
      <meshStandardMaterial vertexColors roughness={0.95} />
    </mesh>
  );
}

function IslandUnderside() {
  return (
    <group>
      <mesh position={[0, -1.4, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[ISLAND_RADIUS, ISLAND_RADIUS * 0.78, 2.8, 96, 1, true]} />
        <meshStandardMaterial color="#8a6646" roughness={1} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -ISLAND_DEPTH / 2 - 1.2, 0]} rotation={[Math.PI, 0, 0]} castShadow>
        <coneGeometry args={[ISLAND_RADIUS * 0.78, ISLAND_DEPTH, 32, 8]} />
        <meshStandardMaterial color="#6e4e34" roughness={1} />
      </mesh>
      {Array.from({ length: 18 }).map((_, i) => {
        const a = (i / 18) * Math.PI * 2;
        const r = ISLAND_RADIUS * 0.92;
        const len = 4 + ((i * 7) % 6);
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * r, -1 - len / 2, Math.sin(a) * r]}
          >
            <cylinderGeometry args={[0.06, 0.06, len, 5]} />
            <meshStandardMaterial color="#3f7a36" />
          </mesh>
        );
      })}
    </group>
  );
}

function Waterfall({ angle, width = 3 }: { angle: number; width?: number }) {
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  useFrame((s) => {
    if (matRef.current) {
      matRef.current.emissiveIntensity = 0.15 + Math.sin(s.clock.elapsedTime * 4) * 0.05;
    }
  });
  const x = Math.cos(angle) * (ISLAND_RADIUS - 0.5);
  const z = Math.sin(angle) * (ISLAND_RADIUS - 0.5);
  return (
    <group position={[x, -1, z]} rotation={[0, -angle + Math.PI / 2, 0]}>
      <mesh position={[0, -10, 0]}>
        <planeGeometry args={[width, 22]} />
        <meshStandardMaterial
          ref={matRef}
          color="#bfe9ff"
          emissive="#9fd8ff"
          emissiveIntensity={0.18}
          transparent
          opacity={0.85}
          side={THREE.DoubleSide}
        />
      </mesh>
      <Sparkles count={20} scale={[width * 1.5, 4, 2]} position={[0, -22, 0]} size={6} speed={0.4} color="#ffffff" />
    </group>
  );
}

function TuscanVilla({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 2.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[6, 4.8, 5]} />
        <meshStandardMaterial color="#e8c79a" roughness={0.9} />
      </mesh>
      <mesh position={[1.2, 6.0, 0]} castShadow receiveShadow>
        <boxGeometry args={[3.6, 2.4, 4.2]} />
        <meshStandardMaterial color="#dab982" roughness={0.9} />
      </mesh>
      <mesh position={[1.2, 7.6, 0]} rotation={[0, Math.PI / 2, 0]} castShadow>
        <coneGeometry args={[3.0, 1.2, 4]} />
        <meshStandardMaterial color="#a44a2a" roughness={0.85} />
      </mesh>
      <mesh position={[0, 5.0, 0]} rotation={[0, Math.PI / 2, 0]} castShadow>
        <coneGeometry args={[4.0, 1.0, 4]} />
        <meshStandardMaterial color="#a44a2a" roughness={0.85} />
      </mesh>
      {[-1.6, 0, 1.6].map((x, i) => (
        <mesh key={i} position={[x, 3.0, 2.51]}>
          <planeGeometry args={[0.7, 1.2]} />
          <meshStandardMaterial color="#5fb8d8" emissive="#ffc678" emissiveIntensity={0.5} />
        </mesh>
      ))}
      <mesh position={[0, 1.4, 2.51]}>
        <planeGeometry args={[1.0, 1.8]} />
        <meshStandardMaterial color="#3a2210" />
      </mesh>
      <mesh position={[2.4, 8.4, -1.2]} castShadow>
        <boxGeometry args={[0.5, 1.4, 0.5]} />
        <meshStandardMaterial color="#b06a4a" />
      </mesh>
    </group>
  );
}

function Cypress({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 2.6, 0]} castShadow>
        <coneGeometry args={[0.9, 5.4, 8]} />
        <meshStandardMaterial color="#2d5a2a" />
      </mesh>
      <mesh position={[0, 4.6, 0]} castShadow>
        <coneGeometry args={[0.55, 2.0, 8]} />
        <meshStandardMaterial color="#3a6e35" />
      </mesh>
    </group>
  );
}

function RoundTree({ position, color = "#5a8e44" }: { position: [number, number, number]; color?: string }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.8, 0]} castShadow>
        <cylinderGeometry args={[0.18, 0.22, 1.6, 6]} />
        <meshStandardMaterial color="#6a4a2a" />
      </mesh>
      <mesh position={[0, 2.2, 0]} castShadow>
        <sphereGeometry args={[1.4, 12, 10]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
    </group>
  );
}

function Bougainvillea({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.6, 0]} castShadow>
        <sphereGeometry args={[1.0, 10, 8]} />
        <meshStandardMaterial color="#3a6e35" roughness={0.9} />
      </mesh>
      <mesh position={[0.2, 1.0, 0.3]} castShadow>
        <sphereGeometry args={[0.7, 10, 8]} />
        <meshStandardMaterial color="#e63a8a" emissive="#c92070" emissiveIntensity={0.15} roughness={0.7} />
      </mesh>
      <mesh position={[-0.4, 0.8, -0.2]} castShadow>
        <sphereGeometry args={[0.55, 10, 8]} />
        <meshStandardMaterial color="#ff6fa8" emissive="#c92070" emissiveIntensity={0.15} roughness={0.7} />
      </mesh>
    </group>
  );
}

function StonePath() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 6]} receiveShadow>
      <planeGeometry args={[2.2, 14]} />
      <meshStandardMaterial color="#c8b88a" roughness={1} />
    </mesh>
  );
}

function Garden() {
  const items = useMemo(() => {
    let s = 1234;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    type Item =
      | { kind: "cypress"; pos: [number, number, number]; scale: number }
      | { kind: "round"; pos: [number, number, number]; color: string }
      | { kind: "boug"; pos: [number, number, number] };
    const out: Item[] = [];
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 4 + rnd() * (ISLAND_RADIUS - 8);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x - 0, z - (-6)) < 7) continue;
      if (Math.abs(x) < 1.6 && z > -1 && z < 13) continue;
      const y = hill(x, z) * islandFalloff(r) * 0.6;
      const roll = rnd();
      if (roll < 0.25) out.push({ kind: "cypress", pos: [x, y, z], scale: 0.85 + rnd() * 0.6 });
      else if (roll < 0.75) out.push({ kind: "round", pos: [x, y, z], color: rnd() < 0.5 ? "#5a8e44" : "#6fa84a" });
      else out.push({ kind: "boug", pos: [x, y, z] });
    }
    return out;
  }, []);
  return (
    <group>
      {items.map((it, i) => {
        if (it.kind === "cypress") return <Cypress key={i} position={it.pos} scale={it.scale} />;
        if (it.kind === "round") return <RoundTree key={i} position={it.pos} color={it.color} />;
        return <Bougainvillea key={i} position={it.pos} />;
      })}
    </group>
  );
}

function CloudSea() {
  const group = useRef<THREE.Group>(null);
  useFrame((s) => {
    if (group.current) {
      group.current.rotation.y = s.clock.elapsedTime * 0.01;
    }
  });
  return (
    <group ref={group} position={[0, -38, 0]}>
      <Clouds material={THREE.MeshBasicMaterial} limit={400}>
        {Array.from({ length: 14 }).map((_, i) => {
          const a = (i / 14) * Math.PI * 2;
          const r = 60 + (i % 3) * 18;
          return (
            <Cloud
              key={i}
              position={[Math.cos(a) * r, (i % 4) * 4 - 6, Math.sin(a) * r]}
              speed={0.1}
              opacity={0.85}
              segments={28}
              bounds={[28, 6, 28]}
              volume={20}
              color="#ffffff"
            />
          );
        })}
        {Array.from({ length: 6 }).map((_, i) => {
          const a = (i / 6) * Math.PI * 2;
          return (
            <Cloud
              key={`high-${i}`}
              position={[Math.cos(a) * 120, 30, Math.sin(a) * 120]}
              speed={0.05}
              opacity={0.55}
              segments={20}
              bounds={[40, 4, 40]}
              volume={18}
              color="#ffe9c8"
            />
          );
        })}
      </Clouds>
    </group>
  );
}

function DistantIslets() {
  return (
    <group>
      {[
        { p: [-90, -10, -60], s: 0.5 },
        { p: [110, -4, -80], s: 0.7 },
        { p: [-130, 6, 40], s: 0.45 },
        { p: [80, 14, 110], s: 0.55 },
      ].map((it, i) => (
        <group key={i} position={it.p as [number, number, number]} scale={it.s}>
          <mesh>
            <sphereGeometry args={[12, 16, 12]} />
            <meshStandardMaterial color="#6a4a2a" />
          </mesh>
          <mesh position={[0, 4, 0]}>
            <sphereGeometry args={[10, 16, 12]} />
            <meshStandardMaterial color="#5a8e44" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function SkyIslandScene() {
  const sunPos = useMemo(() => new THREE.Vector3(-80, 30, -50), []);
  return (
    <>
      <fog attach="fog" args={["#fde6c4", 90, 320]} />
      <color attach="background" args={["#fbe1bf"]} />
      <Sky
        distance={4500}
        sunPosition={[sunPos.x, sunPos.y, sunPos.z]}
        inclination={0.52}
        azimuth={0.25}
        turbidity={5}
        rayleigh={2}
        mieCoefficient={0.01}
        mieDirectionalG={0.88}
      />
      <Environment preset="sunset" />
      <ambientLight intensity={0.55} color="#ffe2b8" />
      <directionalLight
        position={[sunPos.x, sunPos.y, sunPos.z]}
        intensity={1.7}
        color="#ffd9a0"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-50}
        shadow-camera-right={50}
        shadow-camera-top={50}
        shadow-camera-bottom={-50}
        shadow-camera-near={1}
        shadow-camera-far={220}
      />
      <hemisphereLight args={["#ffe6c0", "#a08060", 0.4]} />

      <GrassTop />
      <IslandUnderside />

      <TuscanVilla position={[0, 0, -6]} rotation={Math.PI} />
      <StonePath />
      <Garden />

      <Waterfall angle={Math.PI * 0.25} width={3.5} />
      <Waterfall angle={Math.PI * 1.15} width={2.6} />
      <Waterfall angle={Math.PI * 1.7} width={3.0} />

      <CloudSea />
      <DistantIslets />

      <Sparkles count={80} scale={[ISLAND_RADIUS * 2.2, 14, ISLAND_RADIUS * 2.2]} position={[0, 6, 0]} size={3} speed={0.25} color="#ffd58a" />
    </>
  );
}

export const SKY_ISLAND_WORLD: World = {
  id: "skyisland",
  name: "Edge in the Clouds",
  tagline: "A floating Tuscan island adrift in a sea of clouds",
  description:
    "Inspired by the Edge Esmeralda dream: warm villas, cypress trees, bougainvillea, and waterfalls falling into the sky.",
  accent: "from-rose-400/40 to-amber-500/40",
  spawn: { x: 0, y: 2, z: 12, yaw: Math.PI },
  heightAt: skyIslandHeight,
  Scene: SkyIslandScene,
  hasShells: false,
  hudAccent: "rose",
};
