import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, extend } from "@react-three/fiber";
import * as THREE from "three";
import { Water } from "three/examples/jsm/objects/Water.js";

extend({ Water });

declare module "@react-three/fiber" {
  interface ThreeElements {
    water: any;
  }
}

export function Ocean({ sunDirection }: { sunDirection: THREE.Vector3 }) {
  const ref = useRef<any>(null);
  const { scene } = useThree();

  const waterNormals = useMemo(() => {
    const loader = new THREE.TextureLoader();
    const tex = loader.load(
      "https://threejs.org/examples/textures/waternormals.jpg"
    );
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }, []);

  const water = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(2000, 2000);
    const w = new Water(geometry, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals,
      sunDirection: sunDirection.clone().normalize(),
      sunColor: 0xffd9a0,
      waterColor: 0x0a3a5a,
      distortionScale: 2.8,
      fog: true,
      alpha: 0.95,
    });
    w.rotation.x = -Math.PI / 2;
    w.position.y = 0;
    return w;
  }, [waterNormals, sunDirection]);

  useEffect(() => {
    scene.add(water);
    return () => {
      scene.remove(water);
    };
  }, [water, scene]);

  useFrame((_, dt) => {
    (water.material as any).uniforms["time"].value += dt * 0.6;
  });

  return null;
}
