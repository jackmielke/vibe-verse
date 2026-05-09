import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import alienModelUrl from "@/assets/glb/alien.glb";

export interface AlienState {
  lng: number;
  lat: number;
  baseAltitude: number;
  heading: number; // radians
}

const SCALE_METERS = 6; // approximate height in meters
const GROUND_CLEARANCE = 0.4;

/**
 * Alien — Quaternius's animated alien character. Loads the GLB,
 * plays its baked walk/idle clip, and renders as a custom Mapbox
 * layer anchored to a lng/lat. A purple beacon halo + pillar marks
 * the spot from a distance, similar to Vibey's beacon.
 */
export function createAlienLayer(
  id: string,
  state: AlienState,
): mapboxgl.CustomLayerInterface {
  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
  let mapRef: mapboxgl.Map | null = null;
  let model: THREE.Group | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  let lastTime = performance.now();
  const startTime = performance.now();

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      scene.add(new THREE.AmbientLight(0xffffff, 1.0));
      const key = new THREE.DirectionalLight(0xffffff, 1.2);
      key.position.set(-30, 60, 50).normalize();
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xb392ff, 0.6);
      rim.position.set(40, 20, -30).normalize();
      scene.add(rim);

      // Beacon halo on the ground so you can find the alien from a
      // distance. Sized to roughly his footprint.
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.7, 64),
        new THREE.MeshBasicMaterial({
          color: 0xb392ff,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.05;
      halo.renderOrder = -1;
      scene.add(halo);

      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.14, 14, 16, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xb392ff,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      pillar.position.y = 9;
      scene.add(pillar);

      const loader = new GLTFLoader();
      loader.load(
        alienModelUrl,
        (gltf) => {
          model = gltf.scene;
          // Normalize to ~2 scene units tall so meterScale produces the
          // right real-world height.
          const box = new THREE.Box3().setFromObject(model);
          const size = new THREE.Vector3();
          box.getSize(size);
          const fit = 2 / (size.y || 1);
          model.scale.setScalar(fit);
          // PBR clamp so the alien isn't black against the map.
          model.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            const apply = (mat: THREE.Material) => {
              const std = mat as THREE.MeshStandardMaterial;
              if (std && "metalness" in std) {
                std.metalness = Math.min(std.metalness, 0.3);
                std.roughness = Math.max(std.roughness, 0.45);
                std.envMapIntensity = 1.0;
                std.needsUpdate = true;
              }
            };
            const mat = mesh.material;
            if (Array.isArray(mat)) mat.forEach(apply);
            else if (mat) apply(mat);
          });
          scene.add(model);
          if (gltf.animations && gltf.animations.length) {
            mixer = new THREE.AnimationMixer(model);
            mixer.clipAction(gltf.animations[0]).play();
          }
          mapRef?.triggerRepaint();
        },
        undefined,
        (err) => {
          console.error("[Alien] failed to load model", err);
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
      const now = performance.now();
      const delta = (now - lastTime) / 1000;
      lastTime = now;
      const t = (now - startTime) / 1000;

      if (mixer) mixer.update(delta);
      if (model) model.rotation.y = state.heading;

      // Pulse the halo so the spot reads from far away.
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (mesh.geometry instanceof THREE.RingGeometry) {
          (mesh.material as THREE.MeshBasicMaterial).opacity =
            0.55 + Math.sin(t * 2) * 0.2;
        }
      });

      const altitude = state.baseAltitude + GROUND_CLEARANCE;
      const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
        { lng: state.lng, lat: state.lat },
        altitude,
      );
      const meterScale = mercator.meterInMercatorCoordinateUnits() * SCALE_METERS;

      const rotationX = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(1, 0, 0),
        Math.PI / 2,
      );

      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(mercator.x, mercator.y, mercator.z)
        .scale(new THREE.Vector3(meterScale, -meterScale, meterScale))
        .multiply(rotationX);

      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);
      mapRef?.triggerRepaint();
    },
  };
}

export function createDefaultAlienState(lng: number, lat: number): AlienState {
  return { lng, lat, baseAltitude: 0, heading: 0 };
}
