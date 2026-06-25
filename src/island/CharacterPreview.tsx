import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
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
  onFit,
}: {
  character: CharacterOption;
  spinning: boolean;
  onFit: (size: THREE.Vector3) => void;
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

      // Auto-frame: recenter on x/z, plant feet at y=0
      const box = new THREE.Box3().setFromObject(cloned);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      cloned.position.x -= center.x;
      cloned.position.z -= center.z;
      cloned.position.y -= box.min.y;
      cloned.position.y += character.yOffset;

      const mixer = new THREE.AnimationMixer(cloned);
      const clip =
        findClip(gltf.animations, ["idle"]) ??
        findClip(gltf.animations, ["walk", "survey", "dance", "run"]);
      if (clip) mixer.clipAction(clip).play();
      mixerRef.current = mixer;
      setScene(cloned);
      onFit(size);
    }).catch(() => {});
    return () => {
      alive = false;
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
    };
  }, [character.url, character.scale, character.yOffset, onFit]);

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

function CameraRig({ targetY, distance }: { targetY: number; distance: number }) {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(0, targetY + 0.05, distance);
    camera.lookAt(0, targetY, 0);
  }, [camera, targetY, distance]);
  return null;
}

export function CharacterPreview({
  character,
  spinning = true,
}: {
  character: CharacterOption;
  spinning?: boolean;
}) {
  const [size, setSize] = useState<THREE.Vector3 | null>(null);
  const onFit = useCallback((s: THREE.Vector3) => setSize(s.clone()), []);

  const fov = 28;
  const { targetY, distance } = useMemo(() => {
    if (!size) {
      return { targetY: character.previewTarget, distance: character.previewDistance };
    }
    const h = Math.max(size.y, 0.3);
    const w = Math.max(size.x, size.z, 0.3);
    const fovRad = (fov * Math.PI) / 180;
    const distV = (h * 1.2) / (2 * Math.tan(fovRad / 2));
    const distH = (w * 1.2) / (2 * Math.tan(fovRad / 2));
    return { targetY: h / 2, distance: Math.max(distV, distH, 1.2) };
  }, [size, character.previewTarget, character.previewDistance]);

  // Reset fit on character swap so the next model auto-frames itself.
  useEffect(() => {
    setSize(null);
  }, [character.url]);

  return (
    <Canvas
      shadows={false}
      dpr={[1, 1.5]}
      camera={{ position: [0, 1.4, 3], fov, near: 0.1, far: 50 }}
      gl={{ antialias: true, alpha: true }}
    >
      <CameraRig targetY={targetY} distance={distance} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 4, 3]} intensity={1.2} color="#ffe6b8" />
      <directionalLight position={[-3, 2, -2]} intensity={0.6} color="#a0c8ff" />
      <Suspense fallback={null}>
        <PreviewModel character={character} spinning={spinning} onFit={onFit} />
      </Suspense>
    </Canvas>
  );
}
