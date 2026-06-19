import { Sky, Environment } from "@react-three/drei";
import * as THREE from "three";
import { useMemo } from "react";
import { Terrain } from "./Terrain";
import { Ocean } from "./Ocean";
import { Vegetation } from "./Vegetation";
import { heightAt } from "./heightmap";
import type { World } from "./world";

function IslandScene() {
  const sunPos = useMemo(() => new THREE.Vector3(-60, 18, -40), []);
  const sunDir = useMemo(() => sunPos.clone().normalize(), [sunPos]);
  return (
    <>
      <fog attach="fog" args={["#e8c8a0", 80, 260]} />
      <color attach="background" args={["#f0d2a8"]} />
      <Sky
        distance={4500}
        sunPosition={[sunPos.x, sunPos.y, sunPos.z]}
        inclination={0.48}
        azimuth={0.25}
        turbidity={6}
        rayleigh={2.5}
        mieCoefficient={0.012}
        mieDirectionalG={0.85}
      />
      <Environment preset="sunset" />
      <ambientLight intensity={0.35} color="#ffd9a0" />
      <directionalLight
        position={[sunPos.x, sunPos.y, sunPos.z]}
        intensity={1.6}
        color="#ffe0b0"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
        shadow-camera-near={1}
        shadow-camera-far={200}
      />
      <Terrain />
      <Ocean sunDirection={sunDir} />
      <Vegetation />
    </>
  );
}

export const ISLAND_WORLD: World = {
  id: "island",
  name: "Sunset Cove",
  tagline: "A small island at golden hour",
  description:
    "Procedural beach, palms and warm seas. Find the shells scattered along the shoreline.",
  accent: "from-amber-500/40 to-orange-700/40",
  spawn: { x: 0, y: 2, z: 8, yaw: 0 },
  heightAt: (x, z) => heightAt(x, z),
  Scene: IslandScene,
  hasShells: true,
  hudAccent: "amber",
};
