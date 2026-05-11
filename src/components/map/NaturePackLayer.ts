import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import tree1Url from "@/assets/glb/nature/Tree1.glb";
import tree2Url from "@/assets/glb/nature/Tree2.glb";
import tree3Url from "@/assets/glb/nature/Tree3.glb";
import tree4Url from "@/assets/glb/nature/Tree4.glb";
import bush1Url from "@/assets/glb/nature/Bush1.glb";
import bush2Url from "@/assets/glb/nature/Bush2.glb";
import bush3Url from "@/assets/glb/nature/Bush3.glb";
import grass1Url from "@/assets/glb/nature/Grass1.glb";
import grass2Url from "@/assets/glb/nature/Grass2.glb";
import grass3Url from "@/assets/glb/nature/Grass3.glb";
import rock1Url from "@/assets/glb/nature/Rock1.glb";
import rock2Url from "@/assets/glb/nature/Rock2.glb";
import rock3Url from "@/assets/glb/nature/Rock3.glb";

/**
 * Nature Pack landmark: scatters low-poly trees / bushes / grass /
 * rocks in a circle around a lng/lat. Built from the free Simple
 * Nature Pack (Dec 2016) by Quaternius. Trees sway slightly in a
 * shared wind so the cluster feels alive.
 */
type Scatter = {
  url: string;
  x: number; // meters east of center
  z: number; // meters south of center
  yaw: number; // radians
  scale: number;
  swayAmplitude: number; // radians
  swayPhase: number;
};

const ASSETS = {
  trees: [tree1Url, tree2Url, tree3Url, tree4Url],
  bushes: [bush1Url, bush2Url, bush3Url],
  grasses: [grass1Url, grass2Url, grass3Url],
  rocks: [rock1Url, rock2Url, rock3Url],
};

// Deterministic scatter so the park looks the same every reload.
function rand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function buildScatter(seed: number, radius: number): Scatter[] {
  const r = rand(seed);
  const items: Scatter[] = [];
  function place(url: string, opts: { count: number; minR: number; maxR: number; scaleMin: number; scaleMax: number; sway: number }) {
    for (let i = 0; i < opts.count; i++) {
      const angle = r() * Math.PI * 2;
      const dist = opts.minR + r() * (opts.maxR - opts.minR);
      items.push({
        url,
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        yaw: r() * Math.PI * 2,
        scale: opts.scaleMin + r() * (opts.scaleMax - opts.scaleMin),
        swayAmplitude: opts.sway,
        swayPhase: r() * Math.PI * 2,
      });
    }
  }
  // Trees ring the perimeter (halved — was 16, now 8 total).
  for (const url of ASSETS.trees) {
    place(url, { count: 2, minR: radius * 0.55, maxR: radius, scaleMin: 1.6, scaleMax: 2.6, sway: 0.05 });
  }
  // Bushes scattered mid-radius (was 9, now 6).
  for (const url of ASSETS.bushes) {
    place(url, { count: 2, minR: radius * 0.25, maxR: radius * 0.75, scaleMin: 0.9, scaleMax: 1.6, sway: 0.025 });
  }
  // Grass tufts close in (was 12, now 6).
  for (const url of ASSETS.grasses) {
    place(url, { count: 2, minR: radius * 0.1, maxR: radius * 0.6, scaleMin: 0.6, scaleMax: 1.0, sway: 0.04 });
  }
  // Rocks dotted near the trees, no sway.
  for (const url of ASSETS.rocks) {
    place(url, { count: 2, minR: radius * 0.4, maxR: radius * 0.85, scaleMin: 0.7, scaleMax: 1.4, sway: 0 });
  }
  return items;
}

export function createNaturePackLayer(
  id: string,
  lngLat: { lng: number; lat: number },
  altitude = 0,
  options: { seed?: number; radius?: number; scaleMeters?: number } = {},
): mapboxgl.CustomLayerInterface {
  const seed = options.seed ?? 42;
  // Scatter radius in meters (real-world).
  const radiusMeters = options.radius ?? 28;
  // Each individual model is ~1 unit tall in source; we want them
  // ~3-4m tall on the map, so use a meter-based scale.
  const baseMeters = options.scaleMeters ?? 3.5;

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
  const startTime = performance.now();
  // Each loaded model gets cached in this map so scatter instances
  // share geometry/material (cheap to mass-produce).
  const cache = new Map<string, THREE.Group>();
  const placed: { mesh: THREE.Group; sway: number; phase: number }[] = [];

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      // Soft outdoor lighting — trees/bushes are MeshPhongMaterial
      // out of the box from obj2gltf, so they need real lights.
      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const sun = new THREE.DirectionalLight(0xfff5d8, 1.2);
      sun.position.set(40, 80, 30);
      scene.add(sun);
      const skyFill = new THREE.DirectionalLight(0xa5d8ff, 0.4);
      skyFill.position.set(-40, 30, -20);
      scene.add(skyFill);

      // Subtle ground halo so the park location reads from above.
      const halo = new THREE.Mesh(
        new THREE.CircleGeometry(radiusMeters * 0.95, 64),
        new THREE.MeshBasicMaterial({
          color: 0x73ffb8,
          transparent: true,
          opacity: 0.12,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.05;
      scene.add(halo);

      const scatter = buildScatter(seed, radiusMeters);
      const loader = new GLTFLoader();

      // Group scatter items by URL so each GLB only loads once.
      const byUrl = new Map<string, Scatter[]>();
      for (const item of scatter) {
        const list = byUrl.get(item.url) ?? [];
        list.push(item);
        byUrl.set(item.url, list);
      }

      for (const [url, items] of byUrl) {
        loader.load(
          url,
          (gltf) => {
            cache.set(url, gltf.scene);
            for (const item of items) {
              const inst = gltf.scene.clone(true);
              // Each instance: position in meters relative to center,
              // yaw randomly, scale uniformly. The whole layer is
              // metersScaled by Mapbox's projection matrix, so passing
              // raw meter values works.
              inst.position.set(item.x, 0, item.z);
              inst.rotation.y = item.yaw;
              inst.scale.setScalar(item.scale * baseMeters);
              scene.add(inst);
              placed.push({
                mesh: inst,
                sway: item.swayAmplitude,
                phase: item.swayPhase,
              });
            }
            mapRef?.triggerRepaint();
          },
          undefined,
          (err) => {
            console.error("[NaturePack]", url, err);
          },
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
      // Gentle wind sway: rotate Z by sin(time + phase) * amplitude.
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
