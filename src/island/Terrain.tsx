import { useMemo } from "react";
import * as THREE from "three";
import { heightAt, ISLAND_SIZE } from "./heightmap";

const SEGMENTS = 200;

export function Terrain() {
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(ISLAND_SIZE, ISLAND_SIZE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const sand = new THREE.Color("#e8d5a8");
    const wetSand = new THREE.Color("#b8a072");
    const grass = new THREE.Color("#6f8f4a");
    const darkGrass = new THREE.Color("#4a6b35");
    const rock = new THREE.Color("#7a7060");
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = heightAt(x, z);
      pos.setY(i, y);
      if (y < 0) tmp.copy(wetSand);
      else if (y < 0.6) tmp.copy(sand);
      else if (y < 3) tmp.lerpColors(sand, grass, (y - 0.6) / 2.4);
      else if (y < 6) tmp.lerpColors(grass, darkGrass, (y - 3) / 3);
      else tmp.lerpColors(darkGrass, rock, Math.min(1, (y - 6) / 3));
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return geo;
  }, []);

  return (
    <mesh geometry={geometry} receiveShadow castShadow>
      <meshStandardMaterial vertexColors roughness={0.95} metalness={0.0} />
    </mesh>
  );
}
