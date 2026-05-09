import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import grapeUrl from "@/assets/glb/kits/crops/BushBerries_3.glb";
import grapeMatureUrl from "@/assets/glb/kits/crops/BushBerries_4.glb";
import wheatUrl from "@/assets/glb/kits/crops/Wheat_4.glb";
import palmUrl from "@/assets/glb/kits/crops/PalmTree_3.glb";
import flowersUrl from "@/assets/glb/kits/crops/Flower_3.glb";

/**
 * Vineyard tasting: a tidy grid of grape vines (Quaternius's
 * BushBerries — closest match to grapes), bordered by palm trees and
 * accented with wheat tufts + flowers. Built for a real Healdsburg
 * winery beacon (Garagiste). Vines sway in a shared wind.
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

function buildVineyard(seed: number): RowItem[] {
  const r = rand(seed);
  const items: RowItem[] = [];

  // 5 rows of grape vines — each row is ~12 vines, spaced 2.5m apart.
  // Rows are 4m apart so a person can imagine walking between them.
  const ROWS = 5;
  const PER_ROW = 12;
  const ROW_SPACING = 4;
  const VINE_SPACING = 2.5;
  const totalWidth = (ROWS - 1) * ROW_SPACING;
  const totalLength = (PER_ROW - 1) * VINE_SPACING;
  for (let row = 0; row < ROWS; row++) {
    for (let i = 0; i < PER_ROW; i++) {
      // Mix mature vs juvenile so it doesn't look identical.
      const url = r() > 0.5 ? grapeUrl : grapeMatureUrl;
      items.push({
        url,
        x: row * ROW_SPACING - totalWidth / 2,
        z: i * VINE_SPACING - totalLength / 2 + (r() - 0.5) * 0.4,
        yaw: r() * Math.PI * 2,
        scale: 1.6 + r() * 0.5,
        sway: 0.04,
      });
    }
  }

  // Palm trees marking the four corners.
  const halfW = totalWidth / 2 + 3;
  const halfL = totalLength / 2 + 3;
  for (const [x, z] of [
    [-halfW, -halfL], [halfW, -halfL], [-halfW, halfL], [halfW, halfL],
  ]) {
    items.push({
      url: palmUrl,
      x, z,
      yaw: r() * Math.PI * 2,
      scale: 2.0 + r() * 0.4,
      sway: 0.06,
    });
  }

  // Wheat tufts dotted around the perimeter for texture.
  for (let i = 0; i < 14; i++) {
    const angle = r() * Math.PI * 2;
    const dist = halfW + 1 + r() * 4;
    items.push({
      url: wheatUrl,
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      yaw: r() * Math.PI * 2,
      scale: 0.9 + r() * 0.4,
      sway: 0.05,
    });
  }

  // Flowers scattered between rows so the ground reads alive.
  for (let i = 0; i < 18; i++) {
    items.push({
      url: flowersUrl,
      x: (r() - 0.5) * totalWidth * 1.1,
      z: (r() - 0.5) * totalLength * 1.1,
      yaw: r() * Math.PI * 2,
      scale: 0.6 + r() * 0.3,
      sway: 0.03,
    });
  }

  return items;
}

export function createVineyardLayer(
  id: string,
  lngLat: { lng: number; lat: number },
  altitude = 0,
  options: { seed?: number; scaleMeters?: number } = {},
): mapboxgl.CustomLayerInterface {
  const seed = options.seed ?? 99;
  const baseMeters = options.scaleMeters ?? 1.6;

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
      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const sun = new THREE.DirectionalLight(0xffe8c2, 1.4);
      sun.position.set(40, 80, 30);
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0xa5d8ff, 0.3);
      fill.position.set(-40, 30, -20);
      scene.add(fill);

      // Soft halo so the spot reads from the air.
      const halo = new THREE.Mesh(
        new THREE.CircleGeometry(18, 64),
        new THREE.MeshBasicMaterial({
          color: 0xb392ff,
          transparent: true,
          opacity: 0.1,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.05;
      scene.add(halo);

      const layout = buildVineyard(seed);
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
