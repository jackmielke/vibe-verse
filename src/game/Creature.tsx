import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Traits } from "./types";

interface AnimalProps {
  traits: Traits;
  moving?: boolean;
  hostile?: boolean;
  isPlayer?: boolean;
}

/**
 * Procedural animated animal: capsule body, swinging legs, bobbing head,
 * blinking eyes, breathing. Morphs with traits (size, fangs, fur, armor).
 */
export function AnimalCreature({ traits, moving = false, hostile = false, isPlayer = false }: AnimalProps) {
  const group = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Mesh>(null!);
  const head = useRef<THREE.Group>(null!);
  const tail = useRef<THREE.Group>(null!);
  const legs = useRef<(THREE.Group | null)[]>([]);
  const lids = useRef<(THREE.Mesh | null)[]>([]);
  const t0 = useRef(Math.random() * 10);

  const bodyColor = useMemo(
    () =>
      hostile
        ? new THREE.Color("#c13a3a")
        : new THREE.Color(traits.color[0], traits.color[1], traits.color[2]),
    [traits.color, hostile],
  );
  const darkColor = useMemo(() => bodyColor.clone().multiplyScalar(0.55), [bodyColor]);

  useFrame((_, dt) => {
    t0.current += dt;
    const t = t0.current;
    const gait = moving ? 9 : 2.2;
    const amp = moving ? 0.55 : 0.08;

    legs.current.forEach((leg, i) => {
      if (!leg) return;
      const phase = i % 2 === 0 ? 0 : Math.PI;
      const front = i < 2 ? 0 : Math.PI; // offset front vs back
      leg.rotation.x = Math.sin(t * gait + phase + front) * amp;
    });

    if (body.current) {
      const breathe = 1 + Math.sin(t * 2.4) * 0.04;
      body.current.scale.set(1, breathe, 1);
      body.current.position.y = 0.55 + (moving ? Math.abs(Math.sin(t * gait * 2)) * 0.05 : 0);
    }
    if (head.current) {
      head.current.rotation.x = Math.sin(t * 1.6) * 0.06 + (moving ? -0.05 : 0);
      head.current.rotation.y = Math.sin(t * 0.7) * 0.12;
    }
    if (tail.current) {
      tail.current.rotation.y = Math.sin(t * (moving ? 6 : 1.5)) * (moving ? 0.6 : 0.25);
    }
    // Blink
    const blink = Math.sin(t * 0.9) > 0.985 ? 0.05 : 1;
    lids.current.forEach((l) => l && l.scale.set(1, blink, 1));
  });

  const legPositions: [number, number][] = [
    [0.32, -0.45],
    [-0.32, -0.45],
    [0.32, 0.45],
    [-0.32, 0.45],
  ];

  return (
    <group ref={group}>
      {/* shadow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.7, 16]} />
        <meshBasicMaterial color="#000" transparent opacity={0.22} />
      </mesh>

      {/* player aura ring */}
      {isPlayer && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
            <ringGeometry args={[0.78, 0.92, 32]} />
            <meshBasicMaterial color="#4ade80" transparent opacity={0.55} />
          </mesh>
          <pointLight position={[0, 0.8, 0]} color="#a7f3d0" intensity={0.6} distance={4} />
        </>
      )}


      {/* legs */}
      {legPositions.map(([lx, lz], i) => (
        <group
          key={i}
          ref={(el) => (legs.current[i] = el)}
          position={[lx, 0.3, lz]}
        >
          <mesh castShadow position={[0, -0.18, 0]}>
            <capsuleGeometry args={[0.09, 0.28, 4, 8]} />
            <meshStandardMaterial color={darkColor} flatShading />
          </mesh>
        </group>
      ))}

      {/* body */}
      <mesh ref={body} castShadow position={[0, 0.55, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <capsuleGeometry args={[0.42, 0.7, 6, 12]} />
        <meshStandardMaterial color={bodyColor} flatShading />
      </mesh>

      {/* head group */}
      <group ref={head} position={[0, 0.7, -0.7]}>
        <mesh castShadow>
          <sphereGeometry args={[0.36, 12, 10]} />
          <meshStandardMaterial color={bodyColor} flatShading />
        </mesh>
        {/* snout */}
        <mesh castShadow position={[0, -0.08, -0.28]}>
          <sphereGeometry args={[0.18, 10, 8]} />
          <meshStandardMaterial color={darkColor} flatShading />
        </mesh>
        {/* ears */}
        <mesh castShadow position={[0.2, 0.3, 0.05]} rotation={[0, 0, 0.3]}>
          <coneGeometry args={[0.09, 0.25, 6]} />
          <meshStandardMaterial color={darkColor} flatShading />
        </mesh>
        <mesh castShadow position={[-0.2, 0.3, 0.05]} rotation={[0, 0, -0.3]}>
          <coneGeometry args={[0.09, 0.25, 6]} />
          <meshStandardMaterial color={darkColor} flatShading />
        </mesh>
        {/* eyes (white + pupil + lid) */}
        {[0.15, -0.15].map((ex, i) => (
          <group key={i} position={[ex, 0.05, -0.27]}>
            <mesh>
              <sphereGeometry args={[0.09 + traits.sight * 0.004, 10, 8]} />
              <meshStandardMaterial color="#fff" />
            </mesh>
            <mesh position={[0, 0, -0.07]}>
              <sphereGeometry args={[0.045, 8, 6]} />
              <meshStandardMaterial color={hostile ? "#ffeb3b" : "#1a1a1a"} emissive={hostile ? "#ffeb3b" : "#000"} emissiveIntensity={hostile ? 0.7 : 0} />
            </mesh>
            <mesh ref={(el) => (lids.current[i] = el)} position={[0, 0, -0.075]}>
              <sphereGeometry args={[0.095, 8, 6]} />
              <meshStandardMaterial color={bodyColor} />
            </mesh>
          </group>
        ))}
        {/* fangs */}
        {traits.carnivore > 0.3 && (
          <>
            <mesh position={[0.07, -0.18, -0.4]} rotation={[Math.PI, 0, 0]}>
              <coneGeometry args={[0.04, 0.18, 4]} />
              <meshStandardMaterial color="#fff" />
            </mesh>
            <mesh position={[-0.07, -0.18, -0.4]} rotation={[Math.PI, 0, 0]}>
              <coneGeometry args={[0.04, 0.18, 4]} />
              <meshStandardMaterial color="#fff" />
            </mesh>
          </>
        )}
      </group>

      {/* tail */}
      <group ref={tail} position={[0, 0.6, 0.55]}>
        <mesh castShadow position={[0, 0.05, 0.25]} rotation={[0.6, 0, 0]}>
          <capsuleGeometry args={[0.08, 0.4, 4, 8]} />
          <meshStandardMaterial color={darkColor} flatShading />
        </mesh>
      </group>

      {/* fur tufts */}
      {traits.coldResist > 0 &&
        Array.from({ length: 8 }).map((_, i) => {
          const a = (i / 8) * Math.PI * 2;
          return (
            <mesh
              key={`f${i}`}
              position={[Math.cos(a) * 0.4, 0.75 + (i % 2) * 0.1, Math.sin(a) * 0.45]}
              rotation={[0, -a, 0]}
            >
              <coneGeometry args={[0.07, 0.22, 4]} />
              <meshStandardMaterial color="#e8d6a8" flatShading />
            </mesh>
          );
        })}

      {/* armor plates */}
      {traits.defense > 0 &&
        Array.from({ length: Math.min(4, traits.defense) }).map((_, i) => (
          <mesh key={`a${i}`} castShadow position={[0, 0.95, -0.3 + i * 0.3]} rotation={[0.2, 0, 0]}>
            <boxGeometry args={[0.85, 0.08, 0.22]} />
            <meshStandardMaterial color="#6a6a78" flatShading metalness={0.3} roughness={0.6} />
          </mesh>
        ))}
    </group>
  );
}

interface PlantProps {
  traits: Traits;
}

export function PlantCreature({ traits }: PlantProps) {
  const stem = useRef<THREE.Group>(null!);
  const canopy = useRef<THREE.Mesh>(null!);
  const t0 = useRef(Math.random() * 10);

  const color = useMemo(
    () => new THREE.Color(traits.color[0], traits.color[1], traits.color[2]),
    [traits.color],
  );

  useFrame((_, dt) => {
    t0.current += dt;
    const t = t0.current;
    if (stem.current) {
      stem.current.rotation.z = Math.sin(t * 1.2) * 0.06;
      stem.current.rotation.x = Math.cos(t * 0.9) * 0.04;
    }
    if (canopy.current) {
      const s = 1 + Math.sin(t * 2) * 0.03;
      canopy.current.scale.setScalar(s);
    }
  });

  const leafCount = 3 + Math.floor(traits.leaves);

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.7, 16]} />
        <meshBasicMaterial color="#000" transparent opacity={0.22} />
      </mesh>
      <group ref={stem}>
        {/* roots bulge */}
        <mesh castShadow position={[0, 0.1, 0]}>
          <sphereGeometry args={[0.35 + traits.roots * 0.05, 8, 6]} />
          <meshStandardMaterial color="#5b3a1e" flatShading />
        </mesh>
        {/* stem */}
        <mesh castShadow position={[0, 0.75, 0]}>
          <cylinderGeometry args={[0.13, 0.2, 1.4, 6]} />
          <meshStandardMaterial color="#5b3a1e" flatShading />
        </mesh>
        {/* leaves */}
        {Array.from({ length: leafCount }).map((_, i) => {
          const a = (i / leafCount) * Math.PI * 2;
          const h = 0.9 + (i % 2) * 0.2;
          return (
            <group key={i} position={[0, h, 0]} rotation={[0, -a, 0]}>
              <mesh castShadow position={[0.5, 0, 0]} rotation={[0, 0, 0.3]}>
                <coneGeometry args={[0.35, 0.7, 4]} />
                <meshStandardMaterial color={color} flatShading />
              </mesh>
            </group>
          );
        })}
        {/* canopy */}
        <mesh ref={canopy} castShadow position={[0, 1.6, 0]}>
          <icosahedronGeometry args={[0.55, 0]} />
          <meshStandardMaterial color={color} flatShading emissive={color} emissiveIntensity={0.12} />
        </mesh>
        {/* thorns */}
        {traits.defense > 0 &&
          Array.from({ length: Math.min(10, traits.defense * 4) }).map((_, i) => {
            const a = (i / 10) * Math.PI * 2;
            const h = 0.5 + (i % 3) * 0.3;
            return (
              <mesh
                key={`t${i}`}
                position={[Math.cos(a) * 0.22, h, Math.sin(a) * 0.22]}
                rotation={[0, -a, Math.PI / 2]}
              >
                <coneGeometry args={[0.05, 0.28, 4]} />
                <meshStandardMaterial color="#fafafa" flatShading />
              </mesh>
            );
          })}
      </group>
    </group>
  );
}

/* =========================================================
 * PREDATOR — wolf/big-cat: lean, muscular, real animal threat.
 * ========================================================= */
export function PredatorCreature({ moving = true }: { moving?: boolean }) {
  const group = useRef<THREE.Group>(null!);
  const head = useRef<THREE.Group>(null!);
  const jaw = useRef<THREE.Group>(null!);
  const tail = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Mesh>(null!);
  const legs = useRef<(THREE.Group | null)[]>([]);
  const t0 = useRef(Math.random() * 10);

  useFrame((_, dt) => {
    t0.current += dt;
    const t = t0.current;
    const gait = moving ? 10 : 2;
    legs.current.forEach((leg, i) => {
      if (!leg) return;
      const phase = i % 2 === 0 ? 0 : Math.PI;
      const front = i < 2 ? 0 : Math.PI;
      leg.rotation.x = Math.sin(t * gait + phase + front) * (moving ? 0.85 : 0.08);
    });
    if (body.current) {
      body.current.position.y = 0.55 + (moving ? Math.abs(Math.sin(t * gait * 2)) * 0.06 : 0);
    }
    if (head.current) {
      head.current.rotation.x = -0.1 + Math.sin(t * 2) * 0.04;
      head.current.position.y = 0.6 + (moving ? Math.abs(Math.sin(t * gait * 2)) * 0.05 : 0);
    }
    if (jaw.current) jaw.current.rotation.x = 0.08 + Math.abs(Math.sin(t * 3.2)) * 0.18;
    if (tail.current) tail.current.rotation.y = Math.sin(t * 4) * 0.35;
  });

  const fur = new THREE.Color("#3a2a1c");
  const furDark = new THREE.Color("#1f1610");
  const belly = new THREE.Color("#8a6d4a");
  const claw = "#1a1208";
  const tooth = "#f0e6cf";

  return (
    <group ref={group}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.7, 16]} />
        <meshBasicMaterial color="#000" transparent opacity={0.3} />
      </mesh>

      {/* muscular legs */}
      {[
        [0.28, -0.45],
        [-0.28, -0.45],
        [0.28, 0.4],
        [-0.28, 0.4],
      ].map(([lx, lz], i) => (
        <group key={i} ref={(el) => (legs.current[i] = el)} position={[lx, 0.32, lz]}>
          {/* upper haunch */}
          <mesh castShadow position={[0, -0.05, 0]}>
            <sphereGeometry args={[0.14, 8, 6]} />
            <meshStandardMaterial color={fur} flatShading roughness={0.95} />
          </mesh>
          {/* lower leg */}
          <mesh castShadow position={[0, -0.22, 0]}>
            <capsuleGeometry args={[0.08, 0.28, 4, 8]} />
            <meshStandardMaterial color={furDark} flatShading roughness={0.95} />
          </mesh>
          {/* paw */}
          <mesh castShadow position={[0, -0.4, -0.04]}>
            <boxGeometry args={[0.16, 0.08, 0.2]} />
            <meshStandardMaterial color={furDark} flatShading />
          </mesh>
          {/* claws */}
          {[-0.05, 0, 0.05].map((cx, ci) => (
            <mesh key={ci} position={[cx, -0.44, -0.13]} rotation={[Math.PI / 2 + 0.3, 0, 0]}>
              <coneGeometry args={[0.018, 0.07, 4]} />
              <meshStandardMaterial color={claw} flatShading />
            </mesh>
          ))}
        </group>
      ))}

      {/* lean muscular body */}
      <mesh ref={body} castShadow position={[0, 0.55, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <capsuleGeometry args={[0.38, 0.9, 6, 12]} />
        <meshStandardMaterial color={fur} flatShading roughness={0.95} />
      </mesh>
      {/* shoulder hump */}
      <mesh castShadow position={[0, 0.78, -0.4]}>
        <sphereGeometry args={[0.3, 10, 8]} />
        <meshStandardMaterial color={fur} flatShading roughness={0.95} />
      </mesh>
      {/* lighter belly */}
      <mesh position={[0, 0.4, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <capsuleGeometry args={[0.26, 0.7, 4, 8]} />
        <meshStandardMaterial color={belly} flatShading roughness={1} />
      </mesh>

      {/* head — wolf snout */}
      <group ref={head} position={[0, 0.6, -0.85]}>
        <mesh castShadow>
          <sphereGeometry args={[0.3, 12, 10]} />
          <meshStandardMaterial color={fur} flatShading />
        </mesh>
        {/* snout */}
        <mesh castShadow position={[0, -0.08, -0.28]}>
          <boxGeometry args={[0.24, 0.18, 0.36]} />
          <meshStandardMaterial color={furDark} flatShading />
        </mesh>
        {/* nose */}
        <mesh position={[0, -0.04, -0.47]}>
          <sphereGeometry args={[0.05, 8, 6]} />
          <meshStandardMaterial color="#0a0606" />
        </mesh>
        {/* ears — pricked back */}
        <mesh castShadow position={[0.16, 0.22, 0.05]} rotation={[-0.2, 0, 0.4]}>
          <coneGeometry args={[0.08, 0.2, 4]} />
          <meshStandardMaterial color={furDark} flatShading />
        </mesh>
        <mesh castShadow position={[-0.16, 0.22, 0.05]} rotation={[-0.2, 0, -0.4]}>
          <coneGeometry args={[0.08, 0.2, 4]} />
          <meshStandardMaterial color={furDark} flatShading />
        </mesh>
        {/* amber eyes — intense but natural */}
        {[0.11, -0.11].map((ex, i) => (
          <mesh key={i} position={[ex, 0.05, -0.22]}>
            <sphereGeometry args={[0.045, 8, 6]} />
            <meshStandardMaterial color="#d9a23a" emissive="#3a2200" emissiveIntensity={0.4} />
          </mesh>
        ))}
        {/* upper fangs visible */}
        {[0.07, -0.07].map((fx, i) => (
          <mesh key={`uf${i}`} position={[fx, -0.18, -0.4]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.025, 0.1, 4]} />
            <meshStandardMaterial color={tooth} />
          </mesh>
        ))}
        {/* jaw */}
        <group ref={jaw} position={[0, -0.14, -0.18]}>
          <mesh castShadow position={[0, -0.04, -0.12]}>
            <boxGeometry args={[0.22, 0.08, 0.28]} />
            <meshStandardMaterial color={furDark} flatShading />
          </mesh>
          {[0.05, -0.05].map((fx, i) => (
            <mesh key={i} position={[fx, 0.0, -0.22]}>
              <coneGeometry args={[0.022, 0.09, 4]} />
              <meshStandardMaterial color={tooth} />
            </mesh>
          ))}
        </group>
      </group>

      {/* tail — bushy */}
      <group ref={tail} position={[0, 0.55, 0.55]}>
        <mesh castShadow position={[0, 0.05, 0.3]} rotation={[1.0, 0, 0]}>
          <capsuleGeometry args={[0.1, 0.45, 4, 8]} />
          <meshStandardMaterial color={fur} flatShading />
        </mesh>
        <mesh castShadow position={[0, -0.1, 0.55]}>
          <sphereGeometry args={[0.12, 8, 6]} />
          <meshStandardMaterial color={furDark} flatShading />
        </mesh>
      </group>
    </group>
  );
}

/* =========================================================
 * APEX — grizzly bear: massive, brown, muscular, charging.
 * ========================================================= */
export function ApexCreature({ moving = true }: { moving?: boolean }) {
  const group = useRef<THREE.Group>(null!);
  const head = useRef<THREE.Group>(null!);
  const jaw = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Mesh>(null!);
  const legs = useRef<(THREE.Group | null)[]>([]);
  const t0 = useRef(Math.random() * 10);

  useFrame((_, dt) => {
    t0.current += dt;
    const t = t0.current;
    const gait = moving ? 5.5 : 1.3;
    legs.current.forEach((leg, i) => {
      if (!leg) return;
      const phase = i % 2 === 0 ? 0 : Math.PI;
      const front = i < 2 ? 0 : Math.PI;
      leg.rotation.x = Math.sin(t * gait + phase + front) * (moving ? 0.55 : 0.07);
    });
    if (body.current) {
      body.current.position.y = 1.0 + (moving ? Math.abs(Math.sin(t * gait * 2)) * 0.08 : 0);
    }
    if (head.current) {
      head.current.rotation.y = Math.sin(t * 0.8) * 0.18;
      head.current.rotation.x = -0.05 + Math.sin(t * 1.5) * 0.05;
    }
    if (jaw.current) jaw.current.rotation.x = 0.1 + Math.abs(Math.sin(t * 2.2)) * 0.28;
  });

  const fur = new THREE.Color("#4a3220");
  const furDark = new THREE.Color("#2a1c10");
  const furLight = new THREE.Color("#6b4a30");
  const claw = "#2a1a08";
  const tooth = "#ece0c2";

  return (
    <group ref={group}>
      {/* big shadow */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[1.4, 24]} />
        <meshBasicMaterial color="#000" transparent opacity={0.45} />
      </mesh>

      {/* 4 thick legs */}
      {[
        [0.55, -0.7],
        [-0.55, -0.7],
        [0.55, 0.6],
        [-0.55, 0.6],
      ].map(([lx, lz], i) => (
        <group key={i} ref={(el) => (legs.current[i] = el)} position={[lx, 0.6, lz]}>
          {/* haunch */}
          <mesh castShadow position={[0, 0, 0]}>
            <sphereGeometry args={[0.3, 10, 8]} />
            <meshStandardMaterial color={fur} flatShading roughness={1} />
          </mesh>
          {/* lower leg */}
          <mesh castShadow position={[0, -0.38, 0]}>
            <capsuleGeometry args={[0.18, 0.45, 4, 8]} />
            <meshStandardMaterial color={furDark} flatShading roughness={1} />
          </mesh>
          {/* paw */}
          <mesh castShadow position={[0, -0.68, -0.05]}>
            <boxGeometry args={[0.32, 0.14, 0.4]} />
            <meshStandardMaterial color={furDark} flatShading />
          </mesh>
          {/* big claws */}
          {[-0.1, 0, 0.1].map((cx, ci) => (
            <mesh key={ci} position={[cx, -0.72, -0.24]} rotation={[Math.PI / 2 + 0.4, 0, 0]}>
              <coneGeometry args={[0.035, 0.18, 4]} />
              <meshStandardMaterial color={claw} flatShading />
            </mesh>
          ))}
        </group>
      ))}

      {/* massive body */}
      <mesh ref={body} castShadow position={[0, 1.0, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <capsuleGeometry args={[0.78, 1.4, 8, 14]} />
        <meshStandardMaterial color={fur} flatShading roughness={1} />
      </mesh>

      {/* iconic grizzly shoulder hump */}
      <mesh castShadow position={[0, 1.6, -0.45]}>
        <sphereGeometry args={[0.55, 12, 10]} />
        <meshStandardMaterial color={furLight} flatShading roughness={1} />
      </mesh>

      {/* lighter underside */}
      <mesh position={[0, 0.7, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <capsuleGeometry args={[0.55, 1.1, 4, 10]} />
        <meshStandardMaterial color={furLight} flatShading roughness={1} />
      </mesh>

      {/* massive bear head */}
      <group ref={head} position={[0, 1.25, -1.25]}>
        <mesh castShadow>
          <sphereGeometry args={[0.5, 14, 12]} />
          <meshStandardMaterial color={fur} flatShading roughness={1} />
        </mesh>
        {/* snout */}
        <mesh castShadow position={[0, -0.12, -0.4]}>
          <boxGeometry args={[0.4, 0.32, 0.5]} />
          <meshStandardMaterial color={furDark} flatShading />
        </mesh>
        {/* nose */}
        <mesh position={[0, -0.05, -0.68]}>
          <sphereGeometry args={[0.1, 10, 8]} />
          <meshStandardMaterial color="#0a0606" />
        </mesh>
        {/* small round ears */}
        <mesh castShadow position={[0.3, 0.32, 0.05]}>
          <sphereGeometry args={[0.13, 8, 6]} />
          <meshStandardMaterial color={furDark} flatShading />
        </mesh>
        <mesh castShadow position={[-0.3, 0.32, 0.05]}>
          <sphereGeometry args={[0.13, 8, 6]} />
          <meshStandardMaterial color={furDark} flatShading />
        </mesh>
        {/* dark eyes — small and mean */}
        {[0.18, -0.18].map((ex, i) => (
          <mesh key={i} position={[ex, 0.08, -0.36]}>
            <sphereGeometry args={[0.05, 8, 6]} />
            <meshStandardMaterial color="#1a0a04" />
          </mesh>
        ))}
        {/* upper fangs */}
        {[0.1, -0.1].map((fx, i) => (
          <mesh key={`uf${i}`} position={[fx, -0.28, -0.62]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.035, 0.14, 4]} />
            <meshStandardMaterial color={tooth} />
          </mesh>
        ))}
        {/* jaw with teeth */}
        <group ref={jaw} position={[0, -0.22, -0.3]}>
          <mesh castShadow position={[0, -0.08, -0.18]}>
            <boxGeometry args={[0.36, 0.14, 0.4]} />
            <meshStandardMaterial color={furDark} flatShading />
          </mesh>
          {[0.1, -0.1, 0.03, -0.03].map((fx, i) => (
            <mesh key={i} position={[fx, -0.02, -0.34]}>
              <coneGeometry args={[0.028, 0.12, 4]} />
              <meshStandardMaterial color={tooth} />
            </mesh>
          ))}
        </group>
      </group>

      {/* stubby tail */}
      <mesh castShadow position={[0, 1.05, 0.85]}>
        <sphereGeometry args={[0.13, 8, 6]} />
        <meshStandardMaterial color={fur} flatShading />
      </mesh>
    </group>
  );
}

/* =========================================================
 * HERBIVORE — soft, rounded, deer-like, big eyes, antlers.
 * ========================================================= */
export function HerbivoreCreature({ moving = true }: { moving?: boolean }) {
  const head = useRef<THREE.Group>(null!);
  const tail = useRef<THREE.Group>(null!);
  const legs = useRef<(THREE.Group | null)[]>([]);
  const t0 = useRef(Math.random() * 10);

  useFrame((_, dt) => {
    t0.current += dt;
    const t = t0.current;
    legs.current.forEach((leg, i) => {
      if (!leg) return;
      const phase = i % 2 === 0 ? 0 : Math.PI;
      const front = i < 2 ? 0 : Math.PI;
      leg.rotation.x = Math.sin(t * (moving ? 10 : 1.5) + phase + front) * (moving ? 0.5 : 0.06);
    });
    if (head.current) {
      head.current.rotation.x = Math.sin(t * 1.2) * 0.1 - 0.1;
      head.current.rotation.y = Math.sin(t * 0.6) * 0.2;
    }
    if (tail.current) tail.current.rotation.x = Math.sin(t * 4) * 0.4 - 0.2;
  });

  const body = new THREE.Color("#d4b87a");
  const dark = new THREE.Color("#8a6f3e");
  const white = "#f6efdc";

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.55, 16]} />
        <meshBasicMaterial color="#000" transparent opacity={0.2} />
      </mesh>

      {/* slender legs */}
      {[
        [0.22, -0.35],
        [-0.22, -0.35],
        [0.22, 0.35],
        [-0.22, 0.35],
      ].map(([lx, lz], i) => (
        <group key={i} ref={(el) => (legs.current[i] = el)} position={[lx, 0.35, lz]}>
          <mesh castShadow position={[0, -0.22, 0]}>
            <cylinderGeometry args={[0.045, 0.06, 0.45, 6]} />
            <meshStandardMaterial color={dark} flatShading />
          </mesh>
        </group>
      ))}

      {/* rounded body */}
      <mesh castShadow position={[0, 0.55, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <capsuleGeometry args={[0.3, 0.5, 6, 12]} />
        <meshStandardMaterial color={body} flatShading />
      </mesh>

      {/* white belly */}
      <mesh position={[0, 0.4, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <capsuleGeometry args={[0.22, 0.4, 4, 8]} />
        <meshStandardMaterial color={white} flatShading />
      </mesh>

      {/* head */}
      <group ref={head} position={[0, 0.75, -0.5]}>
        <mesh castShadow>
          <sphereGeometry args={[0.22, 12, 10]} />
          <meshStandardMaterial color={body} flatShading />
        </mesh>
        {/* muzzle */}
        <mesh castShadow position={[0, -0.05, -0.2]}>
          <sphereGeometry args={[0.13, 10, 8]} />
          <meshStandardMaterial color={white} flatShading />
        </mesh>
        {/* antlers — small */}
        <mesh castShadow position={[0.1, 0.2, 0.05]} rotation={[-0.3, 0, 0.4]}>
          <coneGeometry args={[0.03, 0.25, 4]} />
          <meshStandardMaterial color={dark} flatShading />
        </mesh>
        <mesh castShadow position={[-0.1, 0.2, 0.05]} rotation={[-0.3, 0, -0.4]}>
          <coneGeometry args={[0.03, 0.25, 4]} />
          <meshStandardMaterial color={dark} flatShading />
        </mesh>
        {/* big innocent eyes */}
        {[0.1, -0.1].map((ex, i) => (
          <group key={i} position={[ex, 0.04, -0.18]}>
            <mesh>
              <sphereGeometry args={[0.07, 10, 8]} />
              <meshStandardMaterial color="#fff" />
            </mesh>
            <mesh position={[0, 0, -0.05]}>
              <sphereGeometry args={[0.045, 8, 6]} />
              <meshStandardMaterial color="#1a0e02" />
            </mesh>
          </group>
        ))}
        {/* ears */}
        <mesh castShadow position={[0.16, 0.18, 0.08]} rotation={[0, 0, 0.5]}>
          <coneGeometry args={[0.06, 0.18, 5]} />
          <meshStandardMaterial color={dark} flatShading />
        </mesh>
        <mesh castShadow position={[-0.16, 0.18, 0.08]} rotation={[0, 0, -0.5]}>
          <coneGeometry args={[0.06, 0.18, 5]} />
          <meshStandardMaterial color={dark} flatShading />
        </mesh>
      </group>

      {/* puff tail */}
      <group ref={tail} position={[0, 0.6, 0.35]}>
        <mesh castShadow position={[0, 0.05, 0.1]}>
          <sphereGeometry args={[0.1, 8, 6]} />
          <meshStandardMaterial color={white} flatShading />
        </mesh>
      </group>
    </group>
  );
}


/* =========================================================
 * DRAGON — winged, scaled, fire-breathing menace.
 * ========================================================= */
export function DragonCreature({ moving = true }: { moving?: boolean }) {
  const wingL = useRef<THREE.Group>(null!);
  const wingR = useRef<THREE.Group>(null!);
  const head = useRef<THREE.Group>(null!);
  const jaw = useRef<THREE.Group>(null!);
  const tail = useRef<THREE.Group>(null!);
  const t0 = useRef(Math.random() * 10);

  useFrame((_, dt) => {
    t0.current += dt;
    const t = t0.current;
    const flap = Math.sin(t * (moving ? 6 : 2)) * (moving ? 0.9 : 0.3);
    if (wingL.current) wingL.current.rotation.z = 0.2 + flap;
    if (wingR.current) wingR.current.rotation.z = -0.2 - flap;
    if (head.current) head.current.rotation.y = Math.sin(t * 0.8) * 0.2;
    if (jaw.current) jaw.current.rotation.x = 0.1 + Math.abs(Math.sin(t * 2)) * 0.3;
    if (tail.current) tail.current.rotation.y = Math.sin(t * 2) * 0.5;
  });

  const scale = new THREE.Color("#2d4a2a");
  const scaleDark = new THREE.Color("#152812");
  const belly = new THREE.Color("#c9a23a");
  const horn = "#1a0e08";

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[1.1, 20]} />
        <meshBasicMaterial color="#000" transparent opacity={0.35} />
      </mesh>

      {/* body */}
      <mesh castShadow position={[0, 0.85, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <capsuleGeometry args={[0.55, 1.2, 8, 14]} />
        <meshStandardMaterial color={scale} flatShading roughness={0.6} metalness={0.2} />
      </mesh>
      {/* belly */}
      <mesh position={[0, 0.6, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <capsuleGeometry args={[0.4, 1.0, 4, 10]} />
        <meshStandardMaterial color={belly} flatShading />
      </mesh>

      {/* legs */}
      {[
        [0.4, -0.5],
        [-0.4, -0.5],
        [0.4, 0.45],
        [-0.4, 0.45],
      ].map(([lx, lz], i) => (
        <group key={i} position={[lx, 0.45, lz]}>
          <mesh castShadow position={[0, -0.22, 0]}>
            <capsuleGeometry args={[0.12, 0.3, 4, 8]} />
            <meshStandardMaterial color={scaleDark} flatShading />
          </mesh>
          {[-0.07, 0, 0.07].map((cx, ci) => (
            <mesh key={ci} position={[cx, -0.4, -0.1]} rotation={[Math.PI / 2 + 0.3, 0, 0]}>
              <coneGeometry args={[0.03, 0.12, 4]} />
              <meshStandardMaterial color={horn} flatShading />
            </mesh>
          ))}
        </group>
      ))}

      {/* wings */}
      <group ref={wingL} position={[0.4, 1.15, 0]}>
        <mesh castShadow position={[0.7, 0.2, 0]} rotation={[0, 0, 0.3]}>
          <boxGeometry args={[1.4, 0.05, 0.9]} />
          <meshStandardMaterial color={scaleDark} flatShading side={THREE.DoubleSide} transparent opacity={0.85} />
        </mesh>
      </group>
      <group ref={wingR} position={[-0.4, 1.15, 0]}>
        <mesh castShadow position={[-0.7, 0.2, 0]} rotation={[0, 0, -0.3]}>
          <boxGeometry args={[1.4, 0.05, 0.9]} />
          <meshStandardMaterial color={scaleDark} flatShading side={THREE.DoubleSide} transparent opacity={0.85} />
        </mesh>
      </group>

      {/* spine spikes */}
      {Array.from({ length: 6 }).map((_, i) => (
        <mesh key={i} castShadow position={[0, 1.3, -0.6 + i * 0.25]}>
          <coneGeometry args={[0.09, 0.3, 4]} />
          <meshStandardMaterial color={horn} flatShading />
        </mesh>
      ))}

      {/* head */}
      <group ref={head} position={[0, 1.05, -1.1]}>
        <mesh castShadow>
          <boxGeometry args={[0.5, 0.45, 0.7]} />
          <meshStandardMaterial color={scale} flatShading />
        </mesh>
        {/* horns */}
        <mesh castShadow position={[0.18, 0.3, 0.1]} rotation={[-0.4, 0, 0.3]}>
          <coneGeometry args={[0.06, 0.4, 4]} />
          <meshStandardMaterial color={horn} flatShading />
        </mesh>
        <mesh castShadow position={[-0.18, 0.3, 0.1]} rotation={[-0.4, 0, -0.3]}>
          <coneGeometry args={[0.06, 0.4, 4]} />
          <meshStandardMaterial color={horn} flatShading />
        </mesh>
        {/* glowing eyes */}
        {[0.15, -0.15].map((ex, i) => (
          <mesh key={i} position={[ex, 0.05, -0.32]}>
            <sphereGeometry args={[0.05, 8, 6]} />
            <meshStandardMaterial color="#ffaa00" emissive="#ff6600" emissiveIntensity={1.5} />
          </mesh>
        ))}
        {/* upper teeth */}
        {[0.1, -0.1, 0.04, -0.04].map((fx, i) => (
          <mesh key={`uf${i}`} position={[fx, -0.18, -0.34]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.025, 0.1, 4]} />
            <meshStandardMaterial color="#f0e6cf" />
          </mesh>
        ))}
        {/* jaw */}
        <group ref={jaw} position={[0, -0.18, -0.15]}>
          <mesh castShadow position={[0, -0.05, -0.15]}>
            <boxGeometry args={[0.42, 0.12, 0.4]} />
            <meshStandardMaterial color={scaleDark} flatShading />
          </mesh>
          {/* glowing throat */}
          <mesh position={[0, 0, -0.2]}>
            <sphereGeometry args={[0.08, 8, 6]} />
            <meshStandardMaterial color="#ff5500" emissive="#ff3300" emissiveIntensity={2} />
          </mesh>
        </group>
      </group>

      {/* tail */}
      <group ref={tail} position={[0, 0.85, 0.8]}>
        <mesh castShadow position={[0, 0, 0.5]} rotation={[1.2, 0, 0]}>
          <coneGeometry args={[0.18, 1.2, 6]} />
          <meshStandardMaterial color={scale} flatShading />
        </mesh>
        {/* tail fin */}
        <mesh position={[0, -0.5, 0.95]} rotation={[0.5, 0, 0]}>
          <coneGeometry args={[0.2, 0.35, 4]} />
          <meshStandardMaterial color={scaleDark} flatShading />
        </mesh>
      </group>
    </group>
  );
}

/* =========================================================
 * GOAT — sturdy, horned, mountain herbivore.
 * ========================================================= */
export function GoatCreature({ moving = true }: { moving?: boolean }) {
  const head = useRef<THREE.Group>(null!);
  const tail = useRef<THREE.Group>(null!);
  const legs = useRef<(THREE.Group | null)[]>([]);
  const t0 = useRef(Math.random() * 10);

  useFrame((_, dt) => {
    t0.current += dt;
    const t = t0.current;
    legs.current.forEach((leg, i) => {
      if (!leg) return;
      const phase = i % 2 === 0 ? 0 : Math.PI;
      const front = i < 2 ? 0 : Math.PI;
      leg.rotation.x = Math.sin(t * (moving ? 9 : 1.5) + phase + front) * (moving ? 0.45 : 0.06);
    });
    if (head.current) {
      head.current.rotation.x = Math.sin(t * 1.4) * 0.08 - 0.1;
      head.current.rotation.y = Math.sin(t * 0.5) * 0.15;
    }
    if (tail.current) tail.current.rotation.x = Math.sin(t * 5) * 0.5;
  });

  const fur = new THREE.Color("#e8e0d0");
  const dark = new THREE.Color("#5a4a38");
  const horn = "#3a2a18";

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.65, 16]} />
        <meshBasicMaterial color="#000" transparent opacity={0.22} />
      </mesh>

      {/* legs */}
      {[
        [0.22, -0.35],
        [-0.22, -0.35],
        [0.22, 0.35],
        [-0.22, 0.35],
      ].map(([lx, lz], i) => (
        <group key={i} ref={(el) => (legs.current[i] = el)} position={[lx, 0.4, lz]}>
          <mesh castShadow position={[0, -0.22, 0]}>
            <cylinderGeometry args={[0.06, 0.07, 0.45, 6]} />
            <meshStandardMaterial color={dark} flatShading />
          </mesh>
          {/* hoof */}
          <mesh castShadow position={[0, -0.46, 0]}>
            <cylinderGeometry args={[0.08, 0.07, 0.06, 6]} />
            <meshStandardMaterial color="#1a120a" flatShading />
          </mesh>
        </group>
      ))}

      {/* body */}
      <mesh castShadow position={[0, 0.62, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <capsuleGeometry args={[0.32, 0.6, 6, 12]} />
        <meshStandardMaterial color={fur} flatShading roughness={1} />
      </mesh>

      {/* head */}
      <group ref={head} position={[0, 0.85, -0.55]}>
        <mesh castShadow>
          <boxGeometry args={[0.3, 0.3, 0.4]} />
          <meshStandardMaterial color={fur} flatShading />
        </mesh>
        {/* muzzle */}
        <mesh castShadow position={[0, -0.08, -0.22]}>
          <boxGeometry args={[0.18, 0.16, 0.2]} />
          <meshStandardMaterial color={dark} flatShading />
        </mesh>
        {/* curling horns */}
        <mesh castShadow position={[0.13, 0.18, 0.05]} rotation={[0.6, 0.2, 0.3]}>
          <torusGeometry args={[0.16, 0.04, 6, 10, Math.PI * 1.3]} />
          <meshStandardMaterial color={horn} flatShading />
        </mesh>
        <mesh castShadow position={[-0.13, 0.18, 0.05]} rotation={[0.6, -0.2, -0.3]}>
          <torusGeometry args={[0.16, 0.04, 6, 10, Math.PI * 1.3]} />
          <meshStandardMaterial color={horn} flatShading />
        </mesh>
        {/* eyes */}
        {[0.1, -0.1].map((ex, i) => (
          <mesh key={i} position={[ex, 0.02, -0.21]}>
            <sphereGeometry args={[0.04, 8, 6]} />
            <meshStandardMaterial color="#1a0e02" />
          </mesh>
        ))}
        {/* ears */}
        <mesh castShadow position={[0.18, 0.05, 0.05]} rotation={[0, 0, -0.4]}>
          <coneGeometry args={[0.05, 0.18, 5]} />
          <meshStandardMaterial color={dark} flatShading />
        </mesh>
        <mesh castShadow position={[-0.18, 0.05, 0.05]} rotation={[0, 0, 0.4]}>
          <coneGeometry args={[0.05, 0.18, 5]} />
          <meshStandardMaterial color={dark} flatShading />
        </mesh>
        {/* beard */}
        <mesh castShadow position={[0, -0.2, -0.18]} rotation={[0.3, 0, 0]}>
          <coneGeometry args={[0.06, 0.16, 5]} />
          <meshStandardMaterial color={fur} flatShading />
        </mesh>
      </group>

      {/* tail */}
      <group ref={tail} position={[0, 0.7, 0.4]}>
        <mesh castShadow position={[0, 0.05, 0.1]} rotation={[-0.5, 0, 0]}>
          <coneGeometry args={[0.06, 0.18, 5]} />
          <meshStandardMaterial color={fur} flatShading />
        </mesh>
      </group>
    </group>
  );
}
