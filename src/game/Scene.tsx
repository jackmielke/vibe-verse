import { Canvas } from "@react-three/fiber";
import { Sky } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { Terrain, Scenery } from "./Terrain";
import { Ocean } from "./Water";
import { FoodField } from "./Food";
import { Player } from "./Player";
import { Predators } from "./Predators";
import { Allies } from "./Allies";
import { Fireballs } from "./Fireballs";
import { useGame } from "./store";

function Ticker() {
  const tick = useGame((s) => s.tick);
  useFrame((_, dt) => tick(Math.min(dt, 0.1)));
  return null;
}

function SunRig() {
  const tod = useGame((s) => s.timeOfDay);
  const dirRef = useRef<THREE.DirectionalLight>(null!);
  const ambRef = useRef<THREE.AmbientLight>(null!);
  useFrame(() => {
    const angle = tod * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle) * 30;
    const y = Math.sin(angle) * 30;
    if (dirRef.current) {
      dirRef.current.position.set(x, Math.max(2, y), 10);
      dirRef.current.intensity = Math.max(0.05, Math.sin(tod * Math.PI) * 1.4);
    }
    if (ambRef.current) {
      ambRef.current.intensity = 0.25 + Math.max(0, Math.sin(tod * Math.PI)) * 0.5;
    }
  });
  return (
    <>
      <ambientLight ref={ambRef} intensity={0.6} />
      <directionalLight
        ref={dirRef}
        position={[20, 25, 10]}
        intensity={1.2}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
      />
    </>
  );
}

export function Scene() {
  const tod = useGame((s) => s.timeOfDay);
  return (
    <Canvas shadows dpr={[1, 1.5]} camera={{ position: [0, 10, 14], fov: 55 }}>
      <color attach="background" args={[tod > 0.5 ? "#86c4f0" : "#1a2a4a"]} />
      <fog attach="fog" args={[tod > 0.5 ? "#bcdff5" : "#0e1830", 30, 80]} />
      <Sky sunPosition={[Math.cos(tod * Math.PI * 2 - Math.PI / 2) * 100, Math.sin(tod * Math.PI * 2 - Math.PI / 2) * 100, 50]} />
      <SunRig />
      <Terrain />
      <Ocean />
      <Scenery />
      <FoodField />
      <Predators />
      <Allies />
      <Player />
      <Fireballs />
      <Ticker />
    </Canvas>
  );
}
