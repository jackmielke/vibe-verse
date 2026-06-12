import { useMemo } from "react";
import * as THREE from "three";
import { biomeAt, WORLD } from "./store";
import { shoreDistance } from "./island";

export function Terrain() {
  const colors = useMemo(() => {
    const seg = 96;
    const size = WORLD * 1.7;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const colorArr: number[] = [];
    const pos = geo.attributes.position;
    const sand = new THREE.Color(0.91, 0.84, 0.62);
    const wetSand = new THREE.Color(0.62, 0.56, 0.42);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // Inland height noise (kept above the waterline)
      const base =
        0.45 +
        Math.sin(x * 0.15) * 0.18 +
        Math.cos(z * 0.12) * 0.18 +
        Math.sin((x + z) * 0.08) * 0.22;
      // Island falloff: slope down into the seabed past the shoreline
      const sd = shoreDistance(x, z);
      const tRaw = THREE.MathUtils.clamp((sd + 14) / 19, 0, 1);
      const tEase = tRaw * tRaw * (3 - 2 * tRaw);
      const h = THREE.MathUtils.lerp(-5.5, base, tEase);
      pos.setY(i, h);

      const b = biomeAt(x, z);
      let c: THREE.Color;
      if (b === "forest") c = new THREE.Color(0.18, 0.42, 0.22);
      else if (b === "desert") c = new THREE.Color(0.92, 0.78, 0.45);
      else c = new THREE.Color(0.45, 0.7, 0.32);
      // border blend
      const edge = Math.min(Math.abs(Math.abs(x) - WORLD / 6), 3) / 3;
      c.multiplyScalar(0.85 + edge * 0.25);
      // Beach: blend to sand near the waterline, wet sand below it
      if (h < -0.4) c.copy(wetSand);
      else if (sd < 6) {
        const beach = THREE.MathUtils.clamp((6 - sd) / 5, 0, 1);
        c.lerp(sand, beach);
      }
      colorArr.push(c.r, c.g, c.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colorArr, 3));
    geo.computeVertexNormals();
    return geo;
  }, []);

  return (
    <mesh geometry={colors} receiveShadow>
      <meshStandardMaterial vertexColors flatShading roughness={1} />
    </mesh>
  );
}

type SceneryKind =
  | "pine"
  | "oak"
  | "birch"
  | "mushroom"
  | "fern"
  | "rock"
  | "cactus"
  | "barrel_cactus"
  | "dead_tree"
  | "palm"
  | "bush"
  | "flower"
  | "tall_grass"
  | "baobab";

export function Scenery() {
  const items = useMemo(() => {
    const out: { pos: [number, number, number]; kind: SceneryKind; rot: number; scale: number }[] = [];
    const push = (kind: SceneryKind, x: number, z: number) =>
      out.push({
        pos: [x, 0, z],
        kind,
        rot: Math.random() * Math.PI * 2,
        scale: 0.8 + Math.random() * 0.5,
      });
    let attempts = 0;
    while (out.length < 180 && attempts < 1200) {
      attempts++;
      const x = (Math.random() - 0.5) * WORLD * 0.98;
      const z = (Math.random() - 0.5) * WORLD * 0.98;
      const sd = shoreDistance(x, z);
      if (sd < 2.5) continue; // in or too close to the water
      const b = biomeAt(x, z);
      const r = Math.random();
      if (sd < 8) {
        // Beach strip: palms, rocks and grass tufts
        if (r < 0.55) push("palm", x, z);
        else if (r < 0.8) push("rock", x, z);
        else push("tall_grass", x, z);
      } else if (b === "forest") {
        if (r < 0.4) push("pine", x, z);
        else if (r < 0.6) push("oak", x, z);
        else if (r < 0.72) push("birch", x, z);
        else if (r < 0.82) push("mushroom", x, z);
        else if (r < 0.92) push("fern", x, z);
        else push("dead_tree", x, z);
      } else if (b === "desert") {
        if (r < 0.35) push("cactus", x, z);
        else if (r < 0.55) push("barrel_cactus", x, z);
        else if (r < 0.7) push("dead_tree", x, z);
        else if (r < 0.8) push("palm", x, z);
        else if (r < 0.9) push("baobab", x, z);
        else push("rock", x, z);
      } else {
        if (r < 0.3) push("bush", x, z);
        else if (r < 0.55) push("flower", x, z);
        else if (r < 0.75) push("tall_grass", x, z);
        else if (r < 0.88) push("oak", x, z);
        else push("baobab", x, z);
      }
    }
    return out;
  }, []);

  return (
    <group>
      {items.map((it, i) => (
        <group key={i} position={it.pos} rotation={[0, it.rot, 0]} scale={it.scale}>
          <Plant kind={it.kind} />
        </group>
      ))}
    </group>
  );
}

function Plant({ kind }: { kind: SceneryKind }) {
  switch (kind) {
    case "pine":
      return (
        <group>
          <mesh castShadow position={[0, 1, 0]}>
            <cylinderGeometry args={[0.18, 0.28, 2, 6]} />
            <meshStandardMaterial color="#4a2d18" flatShading />
          </mesh>
          {[2.4, 3.4, 4.2].map((y, j) => (
            <mesh key={j} castShadow position={[0, y, 0]}>
              <coneGeometry args={[1.2 - j * 0.3, 1.6 - j * 0.3, 7]} />
              <meshStandardMaterial color={j === 0 ? "#1f5530" : j === 1 ? "#26683a" : "#2d7a45"} flatShading />
            </mesh>
          ))}
        </group>
      );
    case "oak":
      return (
        <group>
          <mesh castShadow position={[0, 1.2, 0]}>
            <cylinderGeometry args={[0.28, 0.4, 2.4, 7]} />
            <meshStandardMaterial color="#5a3a1f" flatShading />
          </mesh>
          <mesh castShadow position={[0, 3.2, 0]}>
            <icosahedronGeometry args={[1.5, 0]} />
            <meshStandardMaterial color="#3a7a3f" flatShading />
          </mesh>
          <mesh castShadow position={[0.8, 2.8, 0.4]}>
            <icosahedronGeometry args={[0.9, 0]} />
            <meshStandardMaterial color="#2f6b34" flatShading />
          </mesh>
          <mesh castShadow position={[-0.7, 2.9, -0.3]}>
            <icosahedronGeometry args={[0.85, 0]} />
            <meshStandardMaterial color="#418445" flatShading />
          </mesh>
        </group>
      );
    case "birch":
      return (
        <group>
          <mesh castShadow position={[0, 1.6, 0]}>
            <cylinderGeometry args={[0.13, 0.16, 3.2, 6]} />
            <meshStandardMaterial color="#ece6d6" flatShading />
          </mesh>
          {[1.0, 1.8, 2.6].map((y, j) => (
            <mesh key={j} position={[0, y, 0.15]}>
              <boxGeometry args={[0.32, 0.06, 0.02]} />
              <meshStandardMaterial color="#1a1410" />
            </mesh>
          ))}
          <mesh castShadow position={[0, 3.7, 0]}>
            <icosahedronGeometry args={[0.95, 0]} />
            <meshStandardMaterial color="#a8c84a" flatShading />
          </mesh>
          <mesh castShadow position={[0.4, 3.4, 0.3]}>
            <icosahedronGeometry args={[0.6, 0]} />
            <meshStandardMaterial color="#c4dc63" flatShading />
          </mesh>
        </group>
      );
    case "mushroom":
      return (
        <group>
          <mesh castShadow position={[0, 0.35, 0]}>
            <cylinderGeometry args={[0.13, 0.18, 0.7, 8]} />
            <meshStandardMaterial color="#f0eadc" flatShading />
          </mesh>
          <mesh castShadow position={[0, 0.8, 0]}>
            <sphereGeometry args={[0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color="#c43030" flatShading emissive="#3a0a0a" emissiveIntensity={0.3} />
          </mesh>
          {([[0.2, 0.85, 0.1], [-0.15, 0.95, -0.15], [0.05, 0.92, -0.25]] as [number, number, number][]).map((p, j) => (
            <mesh key={j} position={p}>
              <sphereGeometry args={[0.06, 6, 6]} />
              <meshStandardMaterial color="#fff" />
            </mesh>
          ))}
        </group>
      );
    case "fern":
      return (
        <group>
          {Array.from({ length: 7 }).map((_, j) => {
            const a = (j / 7) * Math.PI * 2;
            return (
              <mesh
                key={j}
                castShadow
                position={[Math.cos(a) * 0.15, 0.4, Math.sin(a) * 0.15]}
                rotation={[0.6, -a, 0]}
              >
                <coneGeometry args={[0.22, 1.0, 4]} />
                <meshStandardMaterial color="#2c6b3a" flatShading />
              </mesh>
            );
          })}
        </group>
      );
    case "rock":
      return (
        <mesh castShadow position={[0, 0.3, 0]}>
          <dodecahedronGeometry args={[0.6, 0]} />
          <meshStandardMaterial color="#c2a070" flatShading />
        </mesh>
      );
    case "cactus":
      return (
        <group>
          <mesh castShadow position={[0, 1, 0]}>
            <capsuleGeometry args={[0.32, 1.6, 4, 10]} />
            <meshStandardMaterial color="#3a7a3a" flatShading />
          </mesh>
          <mesh castShadow position={[0.5, 1.2, 0]} rotation={[0, 0, -0.4]}>
            <capsuleGeometry args={[0.18, 0.9, 4, 8]} />
            <meshStandardMaterial color="#3a7a3a" flatShading />
          </mesh>
          <mesh castShadow position={[-0.45, 1.5, 0.1]} rotation={[0, 0, 0.5]}>
            <capsuleGeometry args={[0.16, 0.7, 4, 8]} />
            <meshStandardMaterial color="#3a7a3a" flatShading />
          </mesh>
          {Array.from({ length: 8 }).map((_, j) => {
            const a = (j / 8) * Math.PI * 2;
            return (
              <mesh key={j} position={[Math.cos(a) * 0.34, 0.6 + (j % 3) * 0.4, Math.sin(a) * 0.34]} rotation={[0, -a, Math.PI / 2]}>
                <coneGeometry args={[0.025, 0.12, 4]} />
                <meshStandardMaterial color="#fafafa" />
              </mesh>
            );
          })}
        </group>
      );
    case "barrel_cactus":
      return (
        <group>
          <mesh castShadow position={[0, 0.45, 0]}>
            <sphereGeometry args={[0.55, 10, 8]} />
            <meshStandardMaterial color="#4a8a3a" flatShading />
          </mesh>
          {Array.from({ length: 10 }).map((_, j) => {
            const a = (j / 10) * Math.PI * 2;
            return (
              <mesh key={j} position={[Math.cos(a) * 0.55, 0.45, Math.sin(a) * 0.55]} rotation={[0, -a, 0]}>
                <boxGeometry args={[0.04, 0.9, 0.04]} />
                <meshStandardMaterial color="#2f5e25" flatShading />
              </mesh>
            );
          })}
          <mesh position={[0, 0.95, 0]}>
            <sphereGeometry args={[0.12, 8, 6]} />
            <meshStandardMaterial color="#ff5a8a" emissive="#5a0a1a" emissiveIntensity={0.4} />
          </mesh>
        </group>
      );
    case "dead_tree":
      return (
        <group>
          <mesh castShadow position={[0, 1.4, 0]}>
            <cylinderGeometry args={[0.16, 0.28, 2.8, 6]} />
            <meshStandardMaterial color="#5a4a38" flatShading />
          </mesh>
          <mesh castShadow position={[0.6, 2.4, 0]} rotation={[0, 0, -0.7]}>
            <cylinderGeometry args={[0.06, 0.12, 1.0, 5]} />
            <meshStandardMaterial color="#5a4a38" flatShading />
          </mesh>
          <mesh castShadow position={[-0.5, 2.7, 0.2]} rotation={[0.3, 0, 0.8]}>
            <cylinderGeometry args={[0.05, 0.1, 0.8, 5]} />
            <meshStandardMaterial color="#5a4a38" flatShading />
          </mesh>
          <mesh castShadow position={[0.1, 3.1, 0]} rotation={[0.2, 0.3, 0.1]}>
            <cylinderGeometry args={[0.04, 0.08, 0.6, 5]} />
            <meshStandardMaterial color="#5a4a38" flatShading />
          </mesh>
        </group>
      );
    case "palm":
      return (
        <group>
          <mesh castShadow position={[0, 1.6, 0]} rotation={[0, 0, 0.15]}>
            <cylinderGeometry args={[0.16, 0.22, 3.2, 6]} />
            <meshStandardMaterial color="#7a5230" flatShading />
          </mesh>
          {Array.from({ length: 6 }).map((_, j) => {
            const a = (j / 6) * Math.PI * 2;
            return (
              <mesh
                key={j}
                castShadow
                position={[Math.cos(a) * 0.6, 3.2, Math.sin(a) * 0.6]}
                rotation={[0.6, -a, 0]}
              >
                <coneGeometry args={[0.18, 1.6, 3]} />
                <meshStandardMaterial color="#3d8c3d" flatShading />
              </mesh>
            );
          })}
          <mesh castShadow position={[0.12, 3.15, 0.1]}>
            <sphereGeometry args={[0.12, 8, 6]} />
            <meshStandardMaterial color="#4a2a1a" flatShading />
          </mesh>
          <mesh castShadow position={[-0.1, 3.1, 0.12]}>
            <sphereGeometry args={[0.11, 8, 6]} />
            <meshStandardMaterial color="#4a2a1a" flatShading />
          </mesh>
        </group>
      );
    case "bush":
      return (
        <group>
          <mesh castShadow position={[0, 0.35, 0]}>
            <icosahedronGeometry args={[0.55, 0]} />
            <meshStandardMaterial color="#3b8c4a" flatShading />
          </mesh>
          <mesh castShadow position={[0.4, 0.3, 0.2]}>
            <icosahedronGeometry args={[0.35, 0]} />
            <meshStandardMaterial color="#4ca35a" flatShading />
          </mesh>
          {([[0.3, 0.55, -0.1], [-0.2, 0.65, 0.2], [0.1, 0.5, 0.4]] as [number, number, number][]).map((p, j) => (
            <mesh key={j} position={p}>
              <sphereGeometry args={[0.07, 6, 6]} />
              <meshStandardMaterial color="#e94e6b" emissive="#5a0a1a" emissiveIntensity={0.3} />
            </mesh>
          ))}
        </group>
      );
    case "flower": {
      const colors = ["#ff5a8a", "#ffd23a", "#a566ff", "#ff8a3a", "#ffffff"];
      const c = colors[Math.floor(Math.random() * colors.length)];
      return (
        <group>
          <mesh castShadow position={[0, 0.3, 0]}>
            <cylinderGeometry args={[0.025, 0.035, 0.6, 5]} />
            <meshStandardMaterial color="#3a7a3a" flatShading />
          </mesh>
          <mesh position={[0.1, 0.25, 0]} rotation={[0, 0, -0.6]}>
            <coneGeometry args={[0.08, 0.18, 4]} />
            <meshStandardMaterial color="#2f6b34" flatShading />
          </mesh>
          {Array.from({ length: 6 }).map((_, j) => {
            const a = (j / 6) * Math.PI * 2;
            return (
              <mesh
                key={j}
                castShadow
                position={[Math.cos(a) * 0.1, 0.62, Math.sin(a) * 0.1]}
                rotation={[Math.PI / 2 + 0.4, -a, 0]}
              >
                <coneGeometry args={[0.08, 0.18, 4]} />
                <meshStandardMaterial color={c} flatShading emissive={c} emissiveIntensity={0.2} />
              </mesh>
            );
          })}
          <mesh position={[0, 0.65, 0]}>
            <sphereGeometry args={[0.06, 8, 6]} />
            <meshStandardMaterial color="#ffd23a" />
          </mesh>
        </group>
      );
    }
    case "tall_grass":
      return (
        <group>
          {Array.from({ length: 5 }).map((_, j) => {
            const a = (j / 5) * Math.PI * 2;
            const r = (j % 3) * 0.05;
            return (
              <mesh
                key={j}
                position={[Math.cos(a) * r, 0.3, Math.sin(a) * r]}
                rotation={[0, -a, (j % 2 ? 0.15 : -0.15)]}
              >
                <coneGeometry args={[0.04, 0.6, 3]} />
                <meshStandardMaterial color="#8aa840" flatShading />
              </mesh>
            );
          })}
        </group>
      );
    case "baobab":
      return (
        <group>
          <mesh castShadow position={[0, 1.3, 0]}>
            <cylinderGeometry args={[0.55, 0.85, 2.6, 8]} />
            <meshStandardMaterial color="#7a5a3a" flatShading />
          </mesh>
          <mesh castShadow position={[0.7, 2.9, 0]} rotation={[0, 0, -0.8]}>
            <cylinderGeometry args={[0.08, 0.18, 0.9, 5]} />
            <meshStandardMaterial color="#7a5a3a" flatShading />
          </mesh>
          <mesh castShadow position={[-0.65, 3.0, 0.2]} rotation={[0, 0, 0.9]}>
            <cylinderGeometry args={[0.08, 0.18, 0.9, 5]} />
            <meshStandardMaterial color="#7a5a3a" flatShading />
          </mesh>
          <mesh castShadow position={[0, 3.1, 0.6]} rotation={[0.7, 0, 0]}>
            <cylinderGeometry args={[0.08, 0.16, 0.8, 5]} />
            <meshStandardMaterial color="#7a5a3a" flatShading />
          </mesh>
          <mesh castShadow position={[1.0, 3.2, 0]}>
            <icosahedronGeometry args={[0.45, 0]} />
            <meshStandardMaterial color="#5a8a3a" flatShading />
          </mesh>
          <mesh castShadow position={[-1.0, 3.3, 0.3]}>
            <icosahedronGeometry args={[0.45, 0]} />
            <meshStandardMaterial color="#5a8a3a" flatShading />
          </mesh>
          <mesh castShadow position={[0, 3.4, 1.0]}>
            <icosahedronGeometry args={[0.4, 0]} />
            <meshStandardMaterial color="#5a8a3a" flatShading />
          </mesh>
        </group>
      );
  }
}
