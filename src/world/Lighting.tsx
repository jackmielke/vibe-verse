import { Environment } from "@react-three/drei";
import { SUN_POSITION } from "./sun";

export function Lighting() {
  return (
    <>
      <ambientLight intensity={0.35} color="#ffe9d1" />
      <hemisphereLight
        args={["#ffd9a8", "#3a5a3f", 0.45]}
      />
      <directionalLight
        position={SUN_POSITION}
        intensity={2.4}
        color="#ffe1b3"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-90}
        shadow-camera-right={90}
        shadow-camera-top={90}
        shadow-camera-bottom={-90}
        shadow-camera-near={0.1}
        shadow-camera-far={250}
        shadow-bias={-0.0005}
        shadow-normalBias={0.04}
      />
      <Environment preset="sunset" background={false} />
    </>
  );
}
