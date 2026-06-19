import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { CharacterOption } from "./characters";

function findClip(clips: THREE.AnimationClip[], names: string[]): THREE.AnimationClip | null {
  for (const n of names) {
    const c = clips.find((x) => x.name.toLowerCase().includes(n.toLowerCase()));
    if (c) return c;
  }
  return clips[0] ?? null;
}

function PreviewModel({
  character,
  spinning,
}: {
  character: CharacterOption;
  spinning: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const [scene, setScene] = useState<THREE.Group | null>(null);

  useEffect(() => {
    let alive = true;
    const loader = new GLTFLoader();
    loader.loadAsync(character.url).then((gltf) => {
      if (!alive) return;
      const cloned = SkeletonUtils.clone(gltf.scene) as THREE.Group;
      cloned.traverse((o: any) => {
        if (o.isMesh) {
          o.castShadow = false;
          o.receiveShadow = false;
        }
      });
      cloned.scale.setScalar(character.scale);
      cloned.position.y = character.yOffset;
      const mixer = new THREE.AnimationMixer(cloned);
      const clip =
        findClip(gltf.animations, ["idle"]) ??
        findClip(gltf.animations, ["walk", "survey", "dance", "run"]);
      if (clip) mixer.clipAction(clip).play();
      mixerRef.current = mixer;
      setScene(cloned);
    }).catch(() => {});
    return () => {
      alive = false;
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
    };
  }, [character.url, character.scale, character.yOffset]);

  useFrame((_, dt) => {
    if (mixerRef.current) mixerRef.current.update(Math.min(dt, 0.05));
    if (groupRef.current && spinning) {
      groupRef.current.rotation.y += dt * 0.6;
    }
  });

  return (
    <group ref={groupRef}>
      {scene ? <primitive object={scene} /> : null}
    </group>
  );
}

export function CharacterPreview({
  character,
  spinning = true,
}: {
  character: CharacterOption;
  spinning?: boolean;
}) {
  const camPos = useMemo<[number, number, number]>(
    () => [0, character.previewHeight, character.previewDistance],
    [character.previewHeight, character.previewDistance]
  );
  return (
    <Canvas
      shadows={false}
      dpr={[1, 1.5]}
      camera={{ position: camPos, fov: 28, near: 0.1, far: 50 }}
      gl={{ antialias: true, alpha: true }}
      onCreated={({ camera }) => camera.lookAt(0, character.previewTarget, 0)}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 4, 3]} intensity={1.2} color="#ffe6b8" />
      <directionalLight position={[-3, 2, -2]} intensity={0.6} color="#a0c8ff" />
      <Suspense fallback={null}>
        <PreviewModel character={character} spinning={spinning} />
      </Suspense>
    </Canvas>
  );
}
