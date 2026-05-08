import mapboxgl from "mapbox-gl";
import * as THREE from "three";

/**
 * Venue beacon: a thin pillar of light + glowing ground halo at a
 * fixed lng/lat. Marks where a venue lives on the map without having
 * to render the full 3D structure. Click handling is wired by the
 * caller; this layer is purely visual.
 */
export function createVenueBeaconLayer(
  id: string,
  lngLat: { lng: number; lat: number },
  altitude = 0,
  color = 0x73ffb8,
): mapboxgl.CustomLayerInterface {
  const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
    [lngLat.lng, lngLat.lat],
    altitude,
  );
  // 1 unit = 1 meter, then the projection matrix scales it down.
  const meterScale = mercator.meterInMercatorCoordinateUnits();

  const transform = {
    translateX: mercator.x,
    translateY: mercator.y,
    translateZ: mercator.z,
    rotateX: Math.PI / 2,
    rotateY: 0,
    rotateZ: 0,
    scale: meterScale,
  };

  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
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
      scene.add(new THREE.AmbientLight(0xffffff, 1));

      const c = new THREE.Color(color);

      // Tall thin pillar — 60m high, 0.6m wide, additive so it reads
      // as light against either day or dusk skies.
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.6, 0.9, 60, 16, 1, true),
        new THREE.MeshBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      pillar.position.y = 30;
      pillar.userData.role = "pillar";
      scene.add(pillar);

      // Soft glow disc at the base.
      const halo = new THREE.Mesh(
        new THREE.CircleGeometry(4, 48),
        new THREE.MeshBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.05;
      halo.userData.role = "halo";
      scene.add(halo);

      // Slow ascending sparks along the pillar.
      const SPARK_COUNT = 14;
      const sparkPositions = new Float32Array(SPARK_COUNT * 3);
      const sparkPhase = new Float32Array(SPARK_COUNT);
      for (let i = 0; i < SPARK_COUNT; i++) {
        sparkPositions[i * 3 + 0] = (Math.random() - 0.5) * 0.6;
        sparkPositions[i * 3 + 1] = Math.random() * 60;
        sparkPositions[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
        sparkPhase[i] = Math.random() * Math.PI * 2;
      }
      const sparkGeo = new THREE.BufferGeometry();
      sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPositions, 3));
      const sparkMat = new THREE.PointsMaterial({
        color: c,
        size: 1.6,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sparks = new THREE.Points(sparkGeo, sparkMat);
      sparks.userData.role = "sparks";
      sparks.userData.phase = sparkPhase;
      scene.add(sparks);

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(_gl, matrix) {
      const t = (performance.now() - startTime) / 1000;

      // Pillar opacity pulse.
      scene.traverse((obj) => {
        if (obj.userData.role === "pillar") {
          const m = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
          m.opacity = 0.35 + Math.sin(t * 1.4) * 0.15;
        }
        if (obj.userData.role === "halo") {
          const m = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
          m.opacity = 0.4 + Math.sin(t * 1.4) * 0.15;
          obj.scale.setScalar(1 + Math.sin(t * 1.4) * 0.06);
        }
        if (obj.userData.role === "sparks") {
          const positions = (obj as THREE.Points).geometry.getAttribute(
            "position",
          ) as THREE.BufferAttribute;
          const phase = obj.userData.phase as Float32Array;
          for (let i = 0; i < positions.count; i++) {
            const y = ((t * 4 + phase[i] * 8) % 60);
            positions.setY(i, y);
          }
          positions.needsUpdate = true;
        }
      });

      const m = new THREE.Matrix4().fromArray(matrix);
      const rotationX = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(1, 0, 0),
        transform.rotateX,
      );
      const l = new THREE.Matrix4()
        .makeTranslation(transform.translateX, transform.translateY, transform.translateZ)
        .scale(new THREE.Vector3(transform.scale, -transform.scale, transform.scale))
        .multiply(rotationX);
      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);
      mapRef?.triggerRepaint();
    },
  };
}
