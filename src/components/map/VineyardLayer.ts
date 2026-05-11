import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import palm1Url from "@/assets/glb/kits/crops/PalmTree_2.glb";
import palm2Url from "@/assets/glb/kits/crops/PalmTree_3.glb";
import palm3Url from "@/assets/glb/kits/crops/PalmTree_4.glb";

/**
 * Palm-tree ring: scatters palm trees in a soft ring around a lng/
 * lat. Used for the Garagiste vineyard beacon and as ambient
 * decoration around the plaza. Wind-swayed.
 */
type RowItem = {
  url: string;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  sway: number;
};

function rand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function buildPalmRing(seed: number, count: number, minR: number, maxR: number): RowItem[] {
  const r = rand(seed);
  const items: RowItem[] = [];
  const palms = [palm1Url, palm2Url, palm3Url];
  for (let i = 0; i < count; i++) {
    // Slightly jittered angle so the ring doesn't look mechanical.
    const angle = (i / count) * Math.PI * 2 + (r() - 0.5) * 0.3;
    const dist = minR + r() * (maxR - minR);
    items.push({
      url: palms[i % palms.length],
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      yaw: r() * Math.PI * 2,
      scale: 1.8 + r() * 0.6,
      sway: 0.05,
    });
  }
  return items;
}

export function createVineyardLayer(
  id: string,
  lngLat: { lng: number; lat: number },
  altitude = 0,
  options: {
    seed?: number;
    scaleMeters?: number;
    count?: number;
    minRadius?: number;
    maxRadius?: number;
  } = {},
): mapboxgl.CustomLayerInterface {
  const seed = options.seed ?? 99;
  const baseMeters = options.scaleMeters ?? 1.6;
  const count = options.count ?? 12;
  const minR = options.minRadius ?? 12;
  const maxR = options.maxRadius ?? 18;

  const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
    [lngLat.lng, lngLat.lat],
    altitude,
  );
  const meterScale = mercator.meterInMercatorCoordinateUnits();
  const transform = {
    translateX: mercator.x,
    translateY: mercator.y,
    translateZ: mercator.z,
    rotateX: Math.PI / 2,
    scale: meterScale,
  };

  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
  let mapRef: mapboxgl.Map | null = null;
  const placed: { mesh: THREE.Group; sway: number; phase: number }[] = [];
  const startTime = performance.now();

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      // Outdoor lighting tuned warmer than the nature pack — vineyards
      // read better in golden-hour-ish light.
      // Bright outdoor lighting so the palm trees actually read as
      // alive, not as silhouettes. Bumped ambient + sun + sky-fill,
      // with a third bottom-bounce light so the underside of the
      // canopy isn't pitch black.
      scene.add(new THREE.AmbientLight(0xffffff, 1.1));
      const sun = new THREE.DirectionalLight(0xffeed8, 1.8);
      sun.position.set(40, 80, 30);
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0xa5d8ff, 0.6);
      fill.position.set(-40, 30, -20);
      scene.add(fill);
      const bounce = new THREE.DirectionalLight(0xb0d8b0, 0.45);
      bounce.position.set(0, -20, 10);
      scene.add(bounce);

      const layout = buildPalmRing(seed, count, minR, maxR);
      const loader = new GLTFLoader();
      const cache = new Map<string, THREE.Group>();
      const byUrl = new Map<string, RowItem[]>();
      for (const item of layout) {
        const list = byUrl.get(item.url) ?? [];
        list.push(item);
        byUrl.set(item.url, list);
      }

      for (const [url, items] of byUrl) {
        loader.load(
          url,
          (gltf) => {
            // Brighten the palm materials so they read as a daytime
            // grove, not silhouettes. obj2gltf produces MeshPhong by
            // default — add a self-emissive lift so the canopy stays
            // colorful even under the dusk-tinted Mapbox sky.
            gltf.scene.traverse((obj) => {
              const mesh = obj as THREE.Mesh;
              if (!mesh.isMesh) return;
              const apply = (mat: THREE.Material) => {
                const std = mat as THREE.MeshStandardMaterial & {
                  shininess?: number;
                };
                if (std && "metalness" in std) {
                  std.metalness = 0.0;
                  std.roughness = 0.85;
                }
                if ("emissive" in std && "color" in std) {
                  // Lift toward the diffuse color so leaves/bark stay
                  // recognizable while their value rises.
                  std.emissive = (std.color ?? new THREE.Color(0xffffff)).clone();
                  std.emissiveIntensity = 0.35;
                }
                std.needsUpdate = true;
              };
              const mat = mesh.material;
              if (Array.isArray(mat)) mat.forEach(apply);
              else if (mat) apply(mat);
            });
            cache.set(url, gltf.scene);
            for (const item of items) {
              const inst = gltf.scene.clone(true);
              inst.position.set(item.x, 0, item.z);
              inst.rotation.y = item.yaw;
              inst.scale.setScalar(item.scale * baseMeters);
              scene.add(inst);
              placed.push({
                mesh: inst,
                sway: item.sway,
                phase: Math.random() * Math.PI * 2,
              });
            }
            mapRef?.triggerRepaint();
          },
          undefined,
          (err) => console.error("[Vineyard]", url, err),
        );
      }

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(_gl, matrix) {
      const t = (performance.now() - startTime) / 1000;
      for (const { mesh, sway, phase } of placed) {
        if (sway === 0) continue;
        mesh.rotation.z = Math.sin(t * 1.4 + phase) * sway;
      }
      const m = new THREE.Matrix4().fromArray(matrix);
      const rx = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(1, 0, 0),
        transform.rotateX,
      );
      const l = new THREE.Matrix4()
        .makeTranslation(transform.translateX, transform.translateY, transform.translateZ)
        .scale(new THREE.Vector3(transform.scale, -transform.scale, transform.scale))
        .multiply(rx);
      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);
      mapRef?.triggerRepaint();
    },
  };
}
