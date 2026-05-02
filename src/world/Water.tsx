import { useMemo } from "react";
import * as THREE from "three";
import { useFrame, useLoader } from "@react-three/fiber";
import { Water } from "three/examples/jsm/objects/Water.js";
import { SUN_POSITION } from "./sun";

const WATER_SIZE = 2000;

export function Ocean() {
  const normals = useLoader(THREE.TextureLoader, "/textures/waternormals.jpg");

  const waterObject = useMemo(() => {
    normals.wrapS = THREE.RepeatWrapping;
    normals.wrapT = THREE.RepeatWrapping;

    const geometry = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE);
    const water = new Water(geometry, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: normals,
      sunDirection: new THREE.Vector3(...SUN_POSITION).normalize(),
      sunColor: 0xffd699,
      waterColor: 0x10485f,
      distortionScale: 2.4,
      fog: true,
      alpha: 0.96,
    });
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.05;
    return water;
  }, [normals]);

  useFrame((_, dt) => {
    const mat = waterObject.material as THREE.ShaderMaterial;
    mat.uniforms.time.value += dt * 0.6;
  });

  return <primitive object={waterObject} />;
}
