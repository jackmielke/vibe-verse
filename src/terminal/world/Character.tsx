/**
 * The Vibeverse traveller — the character standing on the platform.
 *
 * Modelled on the robot in references 2 and 3, which are the same character in
 * two styles: a soft rounded body, a big friendly head, thin antennae, no face
 * beyond a single visor. That reads as a *someone* without committing to a
 * species, an age or a gender, which is exactly what a stand-in for the player
 * should do.
 *
 * Built from primitives on purpose. At lobby distance the silhouette is the
 * entire performance, and a clean silhouette out of eight shapes beats a muddy
 * one out of a thousand triangles.
 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export interface CharacterProps {
  /** Toon ramp shared with the rest of the scene. */
  gradientMap: THREE.Texture;
  /** Body colour. */
  color?: string;
  accent?: string;
}

export default function Character({
  gradientMap,
  color = "#f6c445",
  accent = "#3fd0d4",
}: CharacterProps) {
  const root = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const antennaL = useRef<THREE.Mesh>(null);
  const antennaR = useRef<THREE.Mesh>(null);

  const mats = useMemo(
    () => ({
      body: new THREE.MeshToonMaterial({ color, gradientMap }),
      dark: new THREE.MeshToonMaterial({ color: "#3b3327", gradientMap }),
      visor: new THREE.MeshToonMaterial({ color: accent, gradientMap }),
      light: new THREE.MeshToonMaterial({ color: "#fdf6e6", gradientMap }),
    }),
    [color, accent, gradientMap],
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    // Idle: a slow breath in the body and a little life in the head. Without
    // this the character reads as a statue and the whole lobby goes dead.
    if (root.current) {
      root.current.position.y = Math.sin(t * 1.1) * 0.035;
      root.current.rotation.y = Math.sin(t * 0.28) * 0.10;
    }
    if (head.current) {
      head.current.rotation.y = Math.sin(t * 0.42 + 1.1) * 0.22;
      head.current.rotation.x = Math.sin(t * 0.63) * 0.05;
    }
    // Antennae lag behind the head — cheap secondary motion, big charm return.
    const wob = Math.sin(t * 2.1) * 0.12;
    if (antennaL.current) antennaL.current.rotation.z = 0.22 + wob;
    if (antennaR.current) antennaR.current.rotation.z = -0.22 - wob;
  });

  return (
    <group ref={root} name="traveller">
      {/* Body — a rounded capsule, wider at the base so it sits rather than floats. */}
      <mesh position={[0, 0.62, 0]} castShadow material={mats.body}>
        <capsuleGeometry args={[0.36, 0.42, 6, 16]} />
      </mesh>

      {/* Head */}
      <group ref={head} position={[0, 1.36, 0]}>
        <mesh castShadow material={mats.body}>
          <sphereGeometry args={[0.34, 20, 16]} />
        </mesh>
        {/* Visor — one shape doing all the expression work. */}
        <mesh position={[0, 0.03, 0.27]} rotation={[0.08, 0, 0]} material={mats.visor}>
          <capsuleGeometry args={[0.085, 0.24, 4, 10]} />
        </mesh>
        <mesh ref={antennaL} position={[-0.20, 0.30, 0]} material={mats.dark}>
          <cylinderGeometry args={[0.018, 0.018, 0.46, 5]} />
        </mesh>
        <mesh ref={antennaR} position={[0.20, 0.30, 0]} material={mats.dark}>
          <cylinderGeometry args={[0.018, 0.018, 0.46, 5]} />
        </mesh>
      </group>

      {/* Arms */}
      <mesh position={[-0.44, 0.70, 0]} rotation={[0, 0, 0.30]} castShadow material={mats.body}>
        <capsuleGeometry args={[0.10, 0.34, 4, 10]} />
      </mesh>
      <mesh position={[0.44, 0.70, 0]} rotation={[0, 0, -0.30]} castShadow material={mats.body}>
        <capsuleGeometry args={[0.10, 0.34, 4, 10]} />
      </mesh>

      {/* Feet */}
      <mesh position={[-0.17, 0.10, 0.04]} castShadow material={mats.dark}>
        <capsuleGeometry args={[0.115, 0.10, 4, 10]} />
      </mesh>
      <mesh position={[0.17, 0.10, 0.04]} castShadow material={mats.dark}>
        <capsuleGeometry args={[0.115, 0.10, 4, 10]} />
      </mesh>
    </group>
  );
}
