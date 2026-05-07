import { Sky as DreiSky, Cloud, Clouds } from "@react-three/drei";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { SUN_POSITION } from "./sun";

/** Fixed golden-hour vibe. Sun position matches the Lighting module. */
export function Sky() {
  const { scene } = useThree();

  useEffect(() => {
    scene.fog = new THREE.Fog("#f4c89a", 80, 320);
    return () => {
      scene.fog = null;
    };
  }, [scene]);

  return (
    <>
      <DreiSky
        distance={4500}
        sunPosition={SUN_POSITION}
        inclination={0.48}
        azimuth={0.25}
        mieCoefficient={0.008}
        mieDirectionalG={0.85}
        rayleigh={2.4}
        turbidity={6}
      />
      <Clouds material={THREE.MeshLambertMaterial} limit={120}>
        <Cloud
          seed={1}
          segments={26}
          bounds={[14, 3, 14]}
          volume={9}
          color="#fff5e2"
          opacity={0.75}
          position={[20, 55, -30]}
          fade={70}
          speed={0.06}
        />
        <Cloud
          seed={2}
          segments={22}
          bounds={[10, 2, 10]}
          volume={7}
          color="#ffe5c4"
          opacity={0.65}
          position={[-40, 60, 20]}
          fade={70}
          speed={0.05}
        />
        <Cloud
          seed={3}
          segments={20}
          bounds={[8, 2, 8]}
          volume={5}
          color="#ffffff"
          opacity={0.55}
          position={[60, 70, 50]}
          fade={70}
          speed={0.04}
        />
      </Clouds>
    </>
  );
}
