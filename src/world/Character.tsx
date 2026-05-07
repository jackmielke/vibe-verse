import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useAnimations, useGLTF } from "@react-three/drei";

export type CharacterAction = "idle" | "walk" | "run";

const ACTION_NAME: Record<CharacterAction, string> = {
  idle: "Idle",
  walk: "Walk",
  run: "Run",
};

interface CharacterProps {
  action: CharacterAction;
}

/**
 * The rigged Soldier model from three.js examples (CC0 by @donmccurdy / Mixamo).
 * Has Idle, Walk, and Run skeletal animation clips baked in. We crossfade
 * between them as the character's movement state changes.
 */
export function Character({ action }: CharacterProps) {
  const group = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF("/models/Soldier.glb");
  const { actions } = useAnimations(animations, group);

  useEffect(() => {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // Slightly nicer material response under HDRI
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat && "roughness" in mat) {
          mat.roughness = Math.max(mat.roughness ?? 0.8, 0.7);
          mat.envMapIntensity = 0.8;
        }
      }
    });
  }, [scene]);

  useEffect(() => {
    const next = actions[ACTION_NAME[action]];
    if (!next) return;
    next.reset().fadeIn(0.25).play();
    return () => {
      next.fadeOut(0.25);
    };
  }, [action, actions]);

  return (
    <group ref={group} dispose={null}>
      <primitive object={scene} />
    </group>
  );
}

useGLTF.preload("/models/Soldier.glb");
