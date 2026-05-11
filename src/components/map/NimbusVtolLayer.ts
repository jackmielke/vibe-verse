import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import nimbusModelUrl from "@/assets/glb/nimbus-vtol.glb";

export interface NimbusState {
  lng: number;
  lat: number;
  altitude: number; // meters above ground
  heading: number; // radians, 0 = north, increases clockwise
  bank: number;
  pitch: number;
  thrusterIntensity: number; // 0..1, drives engine glow
  visible: boolean;
  pilotMode: boolean;
}

export function createDefaultNimbusState(
  lng: number,
  lat: number,
): NimbusState {
  return {
    lng,
    lat,
    altitude: 90,
    heading: 0,
    bank: 0,
    pitch: 0,
    thrusterIntensity: 0.6,
    visible: false,
    pilotMode: false,
  };
}

/**
 * Nimbus VTOL — futuristic personal aircraft. Loads a GLB model and renders
 * it as a Mapbox custom 3D layer. Reads its position/orientation from a
 * shared mutable state object every frame and triggers continuous repaints.
 */
export function createNimbusVtolLayer(
  id: string,
  state: NimbusState,
): mapboxgl.CustomLayerInterface {
  const modelRotate: [number, number, number] = [Math.PI / 2, 0, 0];
  const SCALE_METERS = 14; // approximate length

  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
  let craft: THREE.Group | null = null;
  // The thruster glow disc is intentionally omitted — the user found
  // the green halo distracting against satellite/light terrain.
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

      scene.add(new THREE.AmbientLight(0xffffff, 0.85));
      const key = new THREE.DirectionalLight(0xffffff, 1.1);
      key.position.set(0, -50, 80).normalize();
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x73ffb8, 0.6);
      rim.position.set(50, 30, 20).normalize();
      scene.add(rim);
      const under = new THREE.PointLight(0x4ade80, 1.6, 12);
      under.position.set(0, -1.4, 0);
      scene.add(under);

      const loader = new GLTFLoader();
      loader.load(
        nimbusModelUrl,
        (gltf) => {
          craft = gltf.scene;
          // Normalize size so the model fits in roughly 2.4 units
          const box = new THREE.Box3().setFromObject(craft);
          const size = new THREE.Vector3();
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const fit = 2.4 / maxDim;
          craft.scale.setScalar(fit);
          const center = new THREE.Vector3();
          box.getCenter(center);
          craft.position.x = -center.x * fit;
          craft.position.y = -center.y * fit;
          craft.position.z = -center.z * fit;
          scene.add(craft);
          mapRef?.triggerRepaint();
        },
        undefined,
        (err) => {
          console.error("[NimbusVTOL] failed to load model", err);
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
      if (!state.visible) return;
      const t = (performance.now() - startTime) / 1000;

      // Auto bob/yaw only when not piloted
      let bobY = 0;
      let autoYaw = 0;
      let autoBank = 0;
      if (!state.pilotMode) {
        autoYaw = t * 0.18;
        bobY = Math.sin(t * 1.0) * 0.18;
        autoBank = Math.sin(t * 0.4) * 0.04;
      }

      if (craft) {
        craft.rotation.order = "YXZ";
        craft.rotation.y = state.pilotMode ? -state.heading : autoYaw;
        craft.rotation.x = state.pitch;
        craft.rotation.z = state.bank + autoBank;
        craft.position.y = bobY;
      }

      // (glow disc removed — engine glow is implicit via the craft's own GLB emissive)

      const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
        { lng: state.lng, lat: state.lat },
        state.altitude,
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
