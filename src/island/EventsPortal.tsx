import * as THREE from "three";
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";

const screenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const screenFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  void main() {
    vec2 uv = vUv;
    float t = uTime * 0.4;
    float bands = sin((uv.x * 6.0 + uv.y * 3.0) - t * 3.0) * 0.5 + 0.5;
    float n = noise(uv * 4.0 + vec2(t, -t * 0.7));
    n = pow(n, 1.6);
    float bar = step(0.0, sin(uv.x * 40.0));
    float barH = 0.15 + 0.25 * sin(uv.x * 12.0 + t * 6.0) * 0.5 + 0.25;
    float eq = step(uv.y, barH) * bar * step(uv.y, 0.32);
    vec3 a = vec3(0.55, 0.10, 0.95);
    vec3 b = vec3(0.05, 0.85, 1.00);
    vec3 c = vec3(1.00, 0.20, 0.65);
    vec3 col = mix(a, b, n);
    col = mix(col, c, bands * 0.55);
    col += eq * vec3(0.3, 1.0, 1.2) * 0.8;
    float v = smoothstep(0.0, 0.4, uv.y) * smoothstep(1.0, 0.6, uv.y);
    col *= 0.4 + 0.6 * v;
    gl_FragColor = vec4(col, 1.0);
  }
`;

function GiantScreen() {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  useFrame((s) => {
    if (matRef.current) matRef.current.uniforms.uTime.value = s.clock.elapsedTime;
  });

  const geom = useMemo(() => {
    const g = new THREE.CylinderGeometry(
      9, 9, 6, 48, 1, true,
      Math.PI - 0.7, 1.4
    );
    return g;
  }, []);

  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), []);

  return (
    <group position={[0, 4, -4]}>
      <mesh geometry={geom}>
        <shaderMaterial
          ref={matRef}
          vertexShader={screenVertex}
          fragmentShader={screenFragment}
          uniforms={uniforms}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, 3.05, 0]}>
        <torusGeometry args={[9.05, 0.08, 8, 64, 1.4]} />
        <meshStandardMaterial color="#0a0a14" emissive="#7b3aff" emissiveIntensity={1.5} />
      </mesh>
      <mesh position={[0, -3.05, 0]}>
        <torusGeometry args={[9.05, 0.08, 8, 64, 1.4]} />
        <meshStandardMaterial color="#0a0a14" emissive="#00e0ff" emissiveIntensity={1.5} />
      </mesh>
      <pointLight position={[0, 0, 4]} intensity={3} distance={22} color="#a040ff" />
      <pointLight position={[-4, 0, 4]} intensity={1.2} distance={14} color="#00d8ff" />
      <pointLight position={[4, 0, 4]} intensity={1.2} distance={14} color="#ff3aa0" />
    </group>
  );
}

function PortalRing({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  const inner = useRef<THREE.Mesh>(null);
  const outer = useRef<THREE.Mesh>(null);
  useFrame((s) => {
    const t = s.clock.elapsedTime;
    if (inner.current) {
      const m = inner.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 2 + Math.sin(t * 3) * 0.8;
      inner.current.rotation.z = t * 0.4;
    }
    if (outer.current) {
      outer.current.rotation.z = -t * 0.2;
    }
  });
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh ref={outer} position={[0, 2.6, 0]}>
        <torusGeometry args={[2.6, 0.18, 16, 64]} />
        <meshStandardMaterial color="#0a0a14" emissive="#00e0ff" emissiveIntensity={2.2} metalness={0.8} roughness={0.2} />
      </mesh>
      <mesh ref={inner} position={[0, 2.6, 0]}>
        <torusGeometry args={[2.2, 0.08, 12, 64]} />
        <meshStandardMaterial color="#0a0a14" emissive="#ff3aa0" emissiveIntensity={2.5} />
      </mesh>
      <mesh position={[0, 2.6, 0]} rotation={[0, 0, 0]}>
        <circleGeometry args={[2.1, 48]} />
        <meshBasicMaterial color="#7b3aff" transparent opacity={0.18} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      {[-2.4, 2.4].map((x, i) => (
        <mesh key={i} position={[x, 0.3, 0]}>
          <boxGeometry args={[0.4, 0.6, 0.6]} />
          <meshStandardMaterial color="#1a1a22" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
      <pointLight position={[0, 1, 0]} intensity={1.5} distance={8} color="#7b3aff" />
    </group>
  );
}

function HexFloor() {
  const ringRef = useRef<THREE.Mesh>(null);
  useFrame((s) => {
    if (!ringRef.current) return;
    const t = s.clock.elapsedTime;
    const sc = 1 + ((t * 0.4) % 1) * 4;
    ringRef.current.scale.set(sc, sc, sc);
    const m = ringRef.current.material as THREE.MeshBasicMaterial;
    m.opacity = 0.6 * (1 - ((t * 0.4) % 1));
  });
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} receiveShadow>
        <circleGeometry args={[8, 6]} />
        <meshStandardMaterial color="#0a0a14" roughness={0.4} metalness={0.6} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
        <ringGeometry args={[7.85, 8, 6]} />
        <meshBasicMaterial color="#00e0ff" toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.07, 0]}>
        <ringGeometry args={[3.95, 4, 6]} />
        <meshBasicMaterial color="#ff3aa0" toneMapped={false} />
      </mesh>
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.08, 0]}>
        <ringGeometry args={[1.0, 1.1, 48]} />
        <meshBasicMaterial color="#7b3aff" transparent opacity={0.6} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function Particles({ count = 80 }: { count?: number }) {
  const ref = useRef<THREE.Points>(null);
  const { positions, speeds } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 7;
      positions[i * 3 + 0] = Math.cos(a) * r;
      positions[i * 3 + 1] = Math.random() * 6;
      positions[i * 3 + 2] = Math.sin(a) * r;
      speeds[i] = 0.2 + Math.random() * 0.6;
    }
    return { positions, speeds };
  }, [count]);

  useFrame((_, dt) => {
    if (!ref.current) return;
    const arr = ref.current.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < count; i++) {
      arr[i * 3 + 1] += speeds[i] * dt;
      if (arr[i * 3 + 1] > 7) arr[i * 3 + 1] = 0;
    }
    ref.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.12}
        color="#a070ff"
        transparent
        opacity={0.85}
        sizeAttenuation
        toneMapped={false}
      />
    </points>
  );
}

function BeamLights() {
  const a = useRef<THREE.SpotLight>(null);
  const b = useRef<THREE.SpotLight>(null);
  useFrame((s) => {
    const t = s.clock.elapsedTime;
    if (a.current) a.current.target.position.set(Math.sin(t * 0.7) * 4, 0, -2);
    if (b.current) b.current.target.position.set(Math.sin(t * 0.9 + 1.5) * 4, 0, -2);
    a.current?.target.updateMatrixWorld();
    b.current?.target.updateMatrixWorld();
  });
  return (
    <>
      <spotLight
        ref={a}
        position={[-5, 7, 2]}
        angle={0.35}
        penumbra={0.4}
        intensity={2.5}
        distance={20}
        color="#00d8ff"
      />
      <spotLight
        ref={b}
        position={[5, 7, 2]}
        angle={0.35}
        penumbra={0.4}
        intensity={2.5}
        distance={20}
        color="#ff3aa0"
      />
    </>
  );
}

export function EventsPortal({
  position,
  rotation = 0,
}: {
  position: [number, number, number];
  rotation?: number;
}) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <HexFloor />
      <GiantScreen />
      <PortalRing position={[0, 0, 7]} rotationY={0} />
      <PortalRing position={[-6.5, 0, 3]} rotationY={Math.PI / 2.5} />
      <PortalRing position={[6.5, 0, 3]} rotationY={-Math.PI / 2.5} />

      <BeamLights />
      <Particles />

      {[-7, 7].map((x, i) => (
        <mesh key={i} position={[x, 3, -3]} castShadow>
          <boxGeometry args={[0.6, 6, 0.6]} />
          <meshStandardMaterial color="#0a0a14" metalness={0.8} roughness={0.3} emissive="#3a1a6a" emissiveIntensity={0.6} />
        </mesh>
      ))}

      <pointLight position={[0, 5, 4]} intensity={0.6} distance={18} color="#7b3aff" />
    </group>
  );
}
