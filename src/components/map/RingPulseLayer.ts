import mapboxgl from "mapbox-gl";
import * as THREE from "three";

/**
 * Ring-pulse landmark marker: concentric rings on the ground that
 * ripple outward from a center point. No vertical pillar — reads as
 * a soft ambient mark on the street level. Different aesthetic from
 * the tall light beam used elsewhere.
 */
export function createRingPulseLayer(
  id: string,
  lngLat: { lng: number; lat: number },
  altitude = 0,
  color = 0x73ffb8,
): mapboxgl.CustomLayerInterface {
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
  const RING_COUNT = 4;
  const rings: THREE.Mesh[] = [];

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 1));

      const c = new THREE.Color(color);

      // Static halo disc beneath the rings.
      const halo = new THREE.Mesh(
        new THREE.CircleGeometry(3.5, 48),
        new THREE.MeshBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.02;
      scene.add(halo);

      // Ripple rings — each starts at radius 0 and expands.
      for (let i = 0; i < RING_COUNT; i++) {
        const geo = new THREE.RingGeometry(0.92, 1.0, 64);
        const mat = new THREE.MeshBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(geo, mat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.1;
        ring.userData.phase = i / RING_COUNT;
        scene.add(ring);
        rings.push(ring);
      }

      // Slim vertical anchor pillar so the spot reads from above too,
      // even though the rings are the primary visual.
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.5, 22, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      pillar.position.y = 11;
      scene.add(pillar);

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(_gl, matrix) {
      const t = (performance.now() - startTime) / 1000;
      // Each ring runs a 3-second cycle, staggered.
      for (const ring of rings) {
        const phase = ring.userData.phase as number;
        const local = (t / 3 + phase) % 1; // 0..1
        const r = 1 + local * 22; // radius in meters
        ring.scale.set(r, r, 1);
        const mat = ring.material as THREE.MeshBasicMaterial;
        // Fade in fast, fade out toward the end.
        mat.opacity = Math.sin(local * Math.PI) * 0.95;
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
