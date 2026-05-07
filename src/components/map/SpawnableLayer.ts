import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Generic GLB-as-floating-object Mapbox custom layer. Heavy assets are
// served from /public so they don't bundle into the JS chunk; the URL is
// passed in from the consumer. Used for the Edge Island, the Death Star,
// and any other "spawn this in the world" object.
export interface SpawnableState {
  lng: number;
  lat: number;
  altitude: number; // meters above sea level
  heading: number; // radians; rotates over time
  scaleMeters: number; // approx footprint in meters
  // Optional motion. Defaults match the Edge Island feel.
  rotationSpeed?: number; // rad/sec around world-up. 0 disables rotation.
  bobAmplitude?: number; // meters of vertical sine bob. 0 disables.
  bobPeriod?: number; // seconds for one full bob cycle.
}

interface CreateOpts {
  modelUrl: string;
  // Called with progress (0..1, may be undefined if size unknown) while
  // streaming the GLB. Useful for UI feedback because the file can be huge.
  onProgress?: (loaded: number, total: number | undefined) => void;
  onLoaded?: () => void;
  onError?: (e: unknown) => void;
}

export function createSpawnableLayer(
  id: string,
  state: SpawnableState,
  opts: CreateOpts,
): mapboxgl.CustomLayerInterface & { dispose: () => void } {
  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
  let model: THREE.Group | null = null;
  let mapRef: mapboxgl.Map | null = null;
  const startTime = performance.now();
  let disposed = false;

  function disposeModel() {
    if (!model) return;
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      }
    });
    model = null;
  }

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      scene.add(new THREE.AmbientLight(0xffffff, 0.85));
      const sun = new THREE.DirectionalLight(0xffffff, 1.1);
      sun.position.set(-40, 60, 40).normalize();
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0x9affd6, 0.4);
      fill.position.set(50, 30, -20).normalize();
      scene.add(fill);

      const loader = new GLTFLoader();
      loader.load(
        opts.modelUrl,
        (gltf) => {
          if (disposed) {
            // Layer was removed before the download finished — drop the result.
            return;
          }
          model = gltf.scene;
          // Normalize so largest dimension is 2 units; world scale is then
          // controlled by `state.scaleMeters` in the render transform.
          const box = new THREE.Box3().setFromObject(model);
          const size = new THREE.Vector3();
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const fit = 2 / maxDim;
          model.scale.setScalar(fit);
          const center = new THREE.Vector3();
          box.getCenter(center);
          model.position.x = -center.x * fit;
          model.position.y = -center.y * fit;
          model.position.z = -center.z * fit;
          scene.add(model);
          opts.onLoaded?.();
          mapRef?.triggerRepaint();
        },
        (event) => {
          opts.onProgress?.(event.loaded, event.lengthComputable ? event.total : undefined);
        },
        (err) => {
          // eslint-disable-next-line no-console
          console.error("[FloatingIsland] failed to load", err);
          opts.onError?.(err);
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
      const bobAmp = state.bobAmplitude ?? 6;
      const bobPeriod = state.bobPeriod ?? 16;
      const rotSpeed = state.rotationSpeed ?? 0.05;
      const bob = bobAmp ? Math.sin((t / bobPeriod) * Math.PI * 2) * bobAmp : 0;

      if (model) {
        // Slow continuous rotation around the world-up axis. After our
        // X-rotation below, world-up corresponds to the model's local +Y, so
        // setting model.rotation.y here gives a yaw rotation in world space.
        model.rotation.y = state.heading + t * rotSpeed;
      }

      const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
        { lng: state.lng, lat: state.lat },
        state.altitude + bob,
      );
      const meterScale =
        mercator.meterInMercatorCoordinateUnits() * state.scaleMeters;

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

    onRemove() {
      disposed = true;
      disposeModel();
    },

    // Public dispose so the React caller can flush GPU resources when the
    // toggle is turned off.
    dispose() {
      disposed = true;
      disposeModel();
    },
  };
}
