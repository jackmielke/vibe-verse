import { Sky } from "@react-three/drei";
import * as THREE from "three";
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { World } from "./world";
import { EventsPortal } from "./EventsPortal";

const VILLAGE_RADIUS = 55;

function esmeraldaHeight(x: number, z: number): number {
  const dx = x - 0;
  const dz = z + 14;
  const r = Math.sqrt(dx * dx + dz * dz);
  const mound = Math.max(0, 1.2 - r * 0.18);
  return mound;
}

function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <circleGeometry args={[VILLAGE_RADIUS + 20, 64]} />
      <meshStandardMaterial color="#7cbf6a" roughness={1} />
    </mesh>
  );
}

function Plaza() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} receiveShadow>
        <circleGeometry args={[20, 48]} />
        <meshStandardMaterial color="#cbb89a" roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
        <ringGeometry args={[8, 8.6, 48]} />
        <meshStandardMaterial color="#a89578" roughness={1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
        <ringGeometry args={[19.4, 20, 48]} />
        <meshStandardMaterial color="#a89578" roughness={1} />
      </mesh>
    </group>
  );
}

function Paths() {
  const paths = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const len = VILLAGE_RADIUS - 18;
    paths.push(
      <mesh
        key={i}
        rotation={[-Math.PI / 2, 0, -a]}
        position={[Math.cos(a) * (20 + len / 2), 0.015, Math.sin(a) * (20 + len / 2)]}
        receiveShadow
      >
        <planeGeometry args={[len, 2.4]} />
        <meshStandardMaterial color="#bda980" roughness={1} />
      </mesh>
    );
  }
  return <group>{paths}</group>;
}

function WaterTower() {
  return (
    <group position={[0, 0, -14]}>
      <mesh position={[0, 0.6, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[3.2, 3.6, 1.2, 16]} />
        <meshStandardMaterial color="#8a7a64" roughness={1} />
      </mesh>
      {[0, 1, 2, 3].map((i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * 1.6, 4.5, Math.sin(a) * 1.6]}
            castShadow
          >
            <boxGeometry args={[0.35, 8, 0.35]} />
            <meshStandardMaterial color="#3b3b3b" roughness={0.9} />
          </mesh>
        );
      })}
      <mesh position={[0, 9.2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[2.8, 2.8, 3.6, 24]} />
        <meshStandardMaterial color="#5a5a5a" roughness={0.85} />
      </mesh>
      <mesh position={[0, 9.2, 0]} castShadow>
        <cylinderGeometry args={[2.81, 2.81, 1.0, 24]} />
        <meshStandardMaterial color="#e8e1d3" roughness={0.9} />
      </mesh>
      <mesh position={[0, 11.6, 0]} castShadow>
        <sphereGeometry args={[2.8, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#2f5d3f" roughness={0.7} />
      </mesh>
      <mesh position={[0, 12.8, 0]} castShadow>
        <coneGeometry args={[0.18, 0.7, 8]} />
        <meshStandardMaterial color="#1f3d2a" />
      </mesh>
    </group>
  );
}

function Gazebo() {
  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 0.15, 0]} receiveShadow>
        <cylinderGeometry args={[2.4, 2.4, 0.3, 16]} />
        <meshStandardMaterial color="#d8c79a" />
      </mesh>
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const a = (i / 6) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * 2.0, 1.6, Math.sin(a) * 2.0]}
            castShadow
          >
            <cylinderGeometry args={[0.08, 0.08, 2.6, 8]} />
            <meshStandardMaterial color="#6a4a2a" />
          </mesh>
        );
      })}
      <mesh position={[0, 3.3, 0]} castShadow>
        <coneGeometry args={[2.8, 1.8, 6]} />
        <meshStandardMaterial color="#3f5e3a" roughness={0.8} />
      </mesh>
    </group>
  );
}

function Cottage({
  position,
  rotation = 0,
  color = "#d2a374",
  roof = "#7a3a2a",
}: {
  position: [number, number, number];
  rotation?: number;
  color?: string;
  roof?: string;
}) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1.1, 0]} castShadow receiveShadow>
        <boxGeometry args={[3.2, 2.2, 2.6]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      <mesh position={[0, 2.7, 0]} castShadow rotation={[0, Math.PI / 2, 0]}>
        <coneGeometry args={[2.3, 1.4, 4]} />
        <meshStandardMaterial color={roof} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.7, 1.31]}>
        <planeGeometry args={[0.6, 1.2]} />
        <meshStandardMaterial color="#3a2210" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[1.0, 1.3, 1.31]}>
        <planeGeometry args={[0.6, 0.5]} />
        <meshStandardMaterial color="#ffd07a" emissive="#ffb24a" emissiveIntensity={0.6} />
      </mesh>
      <mesh position={[-1.0, 1.3, 1.31]}>
        <planeGeometry args={[0.6, 0.5]} />
        <meshStandardMaterial color="#ffd07a" emissive="#ffb24a" emissiveIntensity={0.6} />
      </mesh>
    </group>
  );
}

function GlassCube({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.1, 0]} receiveShadow>
        <boxGeometry args={[5, 0.2, 5]} />
        <meshStandardMaterial color="#888" />
      </mesh>
      <mesh position={[0, 1.8, 0]} castShadow receiveShadow>
        <boxGeometry args={[4, 3.4, 4]} />
        <meshPhysicalMaterial
          color="#9adfff"
          transmission={0.6}
          transparent
          opacity={0.55}
          roughness={0.1}
          metalness={0.1}
          emissive="#5fb8ff"
          emissiveIntensity={0.25}
        />
      </mesh>
      {[
        [-2, 0.1, -2],
        [2, 0.1, -2],
        [-2, 0.1, 2],
        [2, 0.1, 2],
      ].map((p, i) => (
        <mesh key={i} position={[p[0], 1.85, p[2]]} castShadow>
          <boxGeometry args={[0.12, 3.5, 0.12]} />
          <meshStandardMaterial color="#222" />
        </mesh>
      ))}
    </group>
  );
}

function Pavilion({
  position,
  rotation = 0,
  color = "#c9a06b",
  roof = "#3f5e3a",
}: {
  position: [number, number, number];
  rotation?: number;
  color?: string;
  roof?: string;
}) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1.1, 0]} castShadow receiveShadow>
        <boxGeometry args={[4, 2.2, 3.2]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      <mesh position={[0, 2.7, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[2.8, 1.6, 4]} />
        <meshStandardMaterial color={roof} roughness={0.8} />
      </mesh>
    </group>
  );
}

function SaunaDeck({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.1, 0]} receiveShadow>
        <boxGeometry args={[6, 0.2, 4]} />
        <meshStandardMaterial color="#8a6a44" />
      </mesh>
      <mesh position={[-1.5, 1.0, 0]} castShadow>
        <boxGeometry args={[2.4, 1.8, 2.4]} />
        <meshStandardMaterial color="#6a4a2a" />
      </mesh>
      <mesh position={[-1.5, 2.2, 0]} castShadow>
        <coneGeometry args={[1.8, 0.8, 4]} />
        <meshStandardMaterial color="#3a2a1a" />
      </mesh>
      <mesh position={[1.6, 0.25, 0]}>
        <cylinderGeometry args={[1.1, 1.1, 0.3, 24]} />
        <meshPhysicalMaterial
          color="#5fc8d8"
          transmission={0.4}
          transparent
          opacity={0.85}
          roughness={0.1}
        />
      </mesh>
    </group>
  );
}

function SoccerField({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
        <planeGeometry args={[8, 5]} />
        <meshStandardMaterial color="#5fa64a" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <planeGeometry args={[0.1, 5]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[0.7, 0.78, 24]} />
        <meshStandardMaterial color="#ffffff" side={THREE.DoubleSide} />
      </mesh>
      {[-3.9, 3.9].map((x, i) => (
        <mesh key={i} position={[x, 0.4, 0]} castShadow>
          <boxGeometry args={[0.1, 0.8, 1.6]} />
          <meshStandardMaterial color="#ffffff" />
        </mesh>
      ))}
    </group>
  );
}

function Palm({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 2.2, 0]} castShadow>
        <cylinderGeometry args={[0.18, 0.25, 4.4, 8]} />
        <meshStandardMaterial color="#7a5230" />
      </mesh>
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * 0.9, 4.4, Math.sin(a) * 0.9]}
            rotation={[0, -a, -0.6]}
            castShadow
          >
            <coneGeometry args={[0.4, 2.2, 4]} />
            <meshStandardMaterial color="#3f8a3f" />
          </mesh>
        );
      })}
    </group>
  );
}

function Tree({ position, color = "#3a7a3a" }: { position: [number, number, number]; color?: string }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.9, 0]} castShadow>
        <cylinderGeometry args={[0.18, 0.22, 1.8, 6]} />
        <meshStandardMaterial color="#5a3a22" />
      </mesh>
      <mesh position={[0, 2.3, 0]} castShadow>
        <coneGeometry args={[1.1, 2.4, 6]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </group>
  );
}

function Vegetation() {
  const { palms, trees } = useMemo(() => {
    let s = 4242;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    const palms: [number, number, number][] = [];
    const trees: [number, number, number, string][] = [];
    for (let i = 0; i < 60; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 24 + rnd() * 28;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const skip = DISTRICT_POSITIONS.some(
        ([dx, , dz]) => Math.hypot(x - dx, z - dz) < 7
      );
      if (skip) continue;
      if (rnd() < 0.35) palms.push([x, 0, z]);
      else trees.push([x, 0, z, rnd() < 0.5 ? "#3a7a3a" : "#4a8a4a"]);
    }
    return { palms, trees };
  }, []);
  return (
    <group>
      {palms.map((p, i) => (
        <Palm key={`p${i}`} position={p} />
      ))}
      {trees.map((t, i) => (
        <Tree key={`t${i}`} position={[t[0], t[1], t[2]]} color={t[3]} />
      ))}
    </group>
  );
}

function Person({
  position,
  color,
  pant = "#333",
}: {
  position: [number, number, number];
  color: string;
  pant?: string;
}) {
  const ref = useRef<THREE.Group>(null);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);
  useFrame((state) => {
    if (!ref.current) return;
    ref.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.6 + phase) * 0.15;
  });
  return (
    <group ref={ref} position={position}>
      <mesh position={[0, 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.18, 0.2, 0.7, 8]} />
        <meshStandardMaterial color={pant} />
      </mesh>
      <mesh position={[0, 1.05, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.22, 0.5, 8]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[0, 1.45, 0]} castShadow>
        <sphereGeometry args={[0.18, 12, 12]} />
        <meshStandardMaterial color="#e2b58a" />
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
    const palette = ["#e94560", "#3aa5ff", "#f7b733", "#7a5fff", "#3ad29f", "#ff6b6b"];
    const out: { pos: [number, number, number]; color: string }[] = [];
    const centers: [number, number][] = [
      [0, 6],
      [-6, -2],
      [7, 2],
      [-18, 14],
      [16, -16],
      [-14, -14],
    ];
    for (const [cx, cz] of centers) {
      const n = 4 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const r = rnd() * 1.6;
        out.push({
          pos: [cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r],
          color: palette[Math.floor(rnd() * palette.length)],
        });
      }
    }
    return out;
  }, []);
  return (
    <group>
      {clusters.map((c, i) => (
        <Person key={i} position={c.pos} color={c.color} />
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
  {
    label: "Innovate",
    sub: "AI Lab",
    pos: [-14, 0, -14],
    build: () => <GlassCube position={[-14, 0, -14]} />,
  },
  {
    label: "Events",
    sub: "Stage",
    pos: [18, 0, -14],
    build: () => <EventsPortal position={[18, 0, -14]} rotation={-0.5} />,
  },
  {
    label: "Learn",
    sub: "Knowledge Hub",
    pos: [-22, 0, 8],
    build: () => (
      <Pavilion position={[-22, 0, 8]} rotation={0.3} color="#b88a5a" roof="#3a4f78" />
    ),
  },
  {
    label: "Meditate",
    sub: "Wellness Garden",
    pos: [22, 0, 8],
    build: () => (
      <Pavilion position={[22, 0, 8]} rotation={-0.3} color="#d8c4a4" roof="#6a8a4a" />
    ),
  },
  {
    label: "Sauna & Plunge",
    sub: "Recharge",
    pos: [26, 0, -2],
    build: () => <SaunaDeck position={[26, 0, -2]} />,
  },
  {
    label: "Kids",
    sub: "Creative Residency",
    pos: [-22, 0, 22],
    build: () => (
      <Cottage position={[-22, 0, 22]} rotation={0.4} color="#e8b984" roof="#7a3a2a" />
    ),
  },
  {
    label: "Build",
    sub: "Maker District",
    pos: [22, 0, 22],
    build: () => (
      <Cottage position={[22, 0, 22]} rotation={-0.4} color="#a98266" roof="#3a3a3a" />
    ),
  },
  {
    label: "Field",
    sub: "For casual sports",
    pos: [0, 0, 26],
    build: () => <SoccerField position={[0, 0, 26]} />,
  },
  {
    label: "Gather",
    sub: "Community Plaza",
    pos: [0, 0, -6],
    build: () => <></>,
  },
];

const DISTRICT_POSITIONS = DISTRICTS.map((d) => d.pos);

function DistrictLabels() {
  return (
    <group>
      {DISTRICTS.map((d, i) => (
        <Label key={i} text={d.label} sub={d.sub} pos={[d.pos[0], 4.2, d.pos[2]]} />
      ))}
    </group>
  );
}

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
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    const r = 36;
    const w = c.width - 16;
    const h = c.height - 16;
    const x = 8,
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
    <sprite position={pos} scale={[3.2, 1.2, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

function EsmeraldaScene() {
  const sunPos = useMemo(() => new THREE.Vector3(40, 60, 30), []);
  return (
    <>
      <fog attach="fog" args={["#cfe7ff", 80, 220]} />
      <color attach="background" args={["#bfe1ff"]} />
      <Sky
        distance={4500}
        sunPosition={[sunPos.x, sunPos.y, sunPos.z]}
        inclination={0.55}
        azimuth={0.25}
        turbidity={2}
        rayleigh={1.2}
        mieCoefficient={0.005}
        mieDirectionalG={0.8}
      />
      <ambientLight intensity={0.55} color="#fff5e0" />
      <directionalLight
        position={[sunPos.x, sunPos.y, sunPos.z]}
        intensity={1.4}
        color="#fff2cc"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-50}
        shadow-camera-right={50}
        shadow-camera-top={50}
        shadow-camera-bottom={-50}
        shadow-camera-near={1}
        shadow-camera-far={200}
      />
      <Ground />
      <Plaza />
      <Paths />
      <WaterTower />
      <Gazebo />
      {DISTRICTS.map((d, i) => (
        <group key={i}>{d.build()}</group>
      ))}
      <Vegetation />
      <Crowd />
      <DistrictLabels />
    </>
  );
}

export const ESMERALDA_WORLD: World = {
  id: "esmeralda",
  name: "Edge Esmeralda",
  tagline: "A pop-up village for ideas, creativity & community",
  description:
    "Wander a stylized low-poly village. Find the gazebo, the AI lab, the events stage and more.",
  accent: "from-sky-400/40 to-emerald-600/40",
  spawn: { x: 0, y: 1, z: 14, yaw: 0 },
  heightAt: esmeraldaHeight,
  Scene: EsmeraldaScene,
  hasShells: false,
  hudAccent: "sky",
};
