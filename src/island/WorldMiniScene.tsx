import { Suspense, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { World } from "./world";

function OrbitCam({ radius = 24, height = 14, speed = 0.12 }: { radius?: number; height?: number; speed?: number }) {
  const t = useRef(0);
  useFrame(({ camera }, dt) => {
    t.current += dt * speed;
    camera.position.set(
      Math.cos(t.current) * radius,
      height,
      Math.sin(t.current) * radius
    );
    camera.lookAt(0, 2, 0);
  });
  return null;
}

export function WorldMiniScene({ world }: { world: World }) {
  const Scene = world.Scene;
  return (
    <Canvas
      shadows={false}
      dpr={[1, 1.25]}
      camera={{ position: [24, 14, 24], fov: 38, near: 0.5, far: 500 }}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 0.95,
        alpha: false,
      }}
    >
      <Suspense fallback={null}>
        <Scene />
        <OrbitCam radius={world.id === "island" ? 36 : 30} height={world.id === "island" ? 12 : 14} />
      </Suspense>
    </Canvas>
  );
}
