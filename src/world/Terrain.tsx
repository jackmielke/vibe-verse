import { useMemo } from "react";
import * as THREE from "three";
import {
  ISLAND_RADIUS,
  SEA_LEVEL,
  TERRAIN_SEGMENTS,
  heightAt,
  slopeAt,
} from "./terrain";

const SAND_COLOR = new THREE.Color("#e8d3a2");
const SHORE_COLOR = new THREE.Color("#d4c08a");
const GRASS_COLOR = new THREE.Color("#5a8a4a");
const GRASS_DARK = new THREE.Color("#3f6e38");
const ROCK_COLOR = new THREE.Color("#7a7269");

const TERRAIN_SIZE = (ISLAND_RADIUS + 14) * 2;

export function Terrain() {
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(
      TERRAIN_SIZE,
      TERRAIN_SIZE,
      TERRAIN_SEGMENTS,
      TERRAIN_SEGMENTS,
    );
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const tmp = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = heightAt(x, z);
      pos.setY(i, y);

      // Material zones by elevation + slope
      const slope = slopeAt(x, z);
      if (y < SEA_LEVEL + 0.4) {
        tmp.copy(SAND_COLOR).lerp(SHORE_COLOR, 0.5);
      } else if (y < SEA_LEVEL + 1.1) {
        // Beach-to-grass gradient
        const t = (y - (SEA_LEVEL + 0.4)) / 0.7;
        tmp.copy(SAND_COLOR).lerp(GRASS_COLOR, t);
      } else if (slope > 0.55 || y > 6.5) {
        // Rocky ridges or peaks
        const t = Math.min(1, (y - 6.5) / 2.5 + (slope - 0.55) * 1.5);
        tmp.copy(GRASS_DARK).lerp(ROCK_COLOR, Math.max(0, t));
      } else {
        // Grass with subtle tonal variation
        const variation = (Math.sin(x * 0.31 + z * 0.27) + 1) * 0.5;
        tmp.copy(GRASS_COLOR).lerp(GRASS_DARK, variation * 0.5);
      }

      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return geo;
  }, []);

  return (
    <mesh
      geometry={geometry}
      receiveShadow
      castShadow
      position={[0, 0, 0]}
    >
      <meshStandardMaterial
        vertexColors
        roughness={0.95}
        metalness={0}
        flatShading={false}
      />
    </mesh>
  );
}
