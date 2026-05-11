import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import vibeyModelUrl from "@/assets/glb/vibey.glb";

export interface VibeyState {
  lng: number;
  lat: number;
  baseAltitude: number; // ground altitude in meters
  heading: number; // radians, 0 = north
  walkMode: boolean; // when true, suppress auto-spin
}

/**
 * Vibey — our community agent character. Loads a GLB model and renders it
 * as a custom Mapbox layer that bobs gently up/down and slowly rotates.
 * Triggers continuous map repaints so the animation runs even when the
 * camera is idle.
 */
export function createVibeyLayer(
  id: string,
  state: VibeyState,
): mapboxgl.CustomLayerInterface {
  const modelRotate: [number, number, number] = [Math.PI / 2, 0, 0];
  const FLOAT_HEIGHT = 22; // meters above ground
  const BOB_AMPLITUDE = 2.5; // meters
  const SCALE_METERS = 18; // approximate height in meters

  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
  let vibey: THREE.Group | null = null;
  let mapRef: mapboxgl.Map | null = null;
  const startTime = performance.now();

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const key = new THREE.DirectionalLight(0xffffff, 1.0);
      key.position.set(0, -50, 80).normalize();
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x73ffb8, 0.5);
      rim.position.set(50, 30, 20).normalize();
      scene.add(rim);

      // Soft glow disc beneath the character
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0x2dd4a8,
        transparent: true,
        opacity: 0.35,
      });
      const glow = new THREE.Mesh(new THREE.CircleGeometry(1.2, 32), glowMat);
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = -1.2;
      scene.add(glow);

      const loader = new GLTFLoader();
      loader.load(
        vibeyModelUrl,
        (gltf) => {
          vibey = gltf.scene;
          // Normalize size so the model fits in roughly 2 units
          const box = new THREE.Box3().setFromObject(vibey);
          const size = new THREE.Vector3();
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const fit = 2 / maxDim;
          vibey.scale.setScalar(fit);
          // Center horizontally, drop so feet sit at y=-1
          const center = new THREE.Vector3();
          box.getCenter(center);
          vibey.position.x = -center.x * fit;
          vibey.position.z = -center.z * fit;
          vibey.position.y = -box.min.y * fit - 1;
          scene.add(vibey);
          mapRef?.triggerRepaint();
        },
        undefined,
        (err) => {
          console.error("[Vibey] failed to load model", err);
        },
      );

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(_gl, matrix) {
      const t = (performance.now() - startTime) / 1000;

      // Gentle bob always; auto-spin only when not being walked
      const bob = Math.sin(t * 1.4) * 0.25;
      if (vibey) {
        vibey.rotation.y = state.walkMode ? -state.heading : t * 0.5;
      }

      const altitude =
        state.baseAltitude +
        (state.walkMode ? 0 : FLOAT_HEIGHT) +
        bob * BOB_AMPLITUDE * (state.walkMode ? 0.3 : 1);

      const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
        { lng: state.lng, lat: state.lat },
        altitude,
      );
      const meterScale =
        mercator.meterInMercatorCoordinateUnits() * SCALE_METERS;

      const rotationX = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(1, 0, 0),
        modelRotate[0],
      );
      const rotationY = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(0, 1, 0),
        modelRotate[1],
      );
      const rotationZ = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(0, 0, 1),
        modelRotate[2],
      );

      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(mercator.x, mercator.y, mercator.z)
        .scale(new THREE.Vector3(meterScale, -meterScale, meterScale))
        .multiply(rotationX)
        .multiply(rotationY)
        .multiply(rotationZ);

      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);

      mapRef?.triggerRepaint();
    },
  };
}
