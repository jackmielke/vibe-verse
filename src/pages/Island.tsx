import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { KeyboardControls } from "@react-three/drei";
import * as THREE from "three";
import { Scene } from "@/world/Scene";
import { HUD } from "@/world/HUD";
import { PLAYER_KEYMAP } from "@/world/keymap";

const Island = () => {
  return (
    <div className="fixed inset-0 h-screen w-screen overflow-hidden bg-[#f4c89a]">
      <KeyboardControls map={PLAYER_KEYMAP}>
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{
            antialias: true,
            powerPreference: "high-performance",
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.05,
          }}
          camera={{ fov: 55, near: 0.1, far: 1000, position: [0, 6, 18] }}
        >
          <Suspense fallback={null}>
            <Scene />
          </Suspense>
        </Canvas>
        <HUD />
      </KeyboardControls>
    </div>
  );
};

export default Island;
