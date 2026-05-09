import mapboxgl from "mapbox-gl";
import * as THREE from "three";

/**
 * Orb-bob landmark marker: a glowing emissive sphere that hovers
 * ~12m above the location, bobs gently, with a soft halo behind it
 * and a thin tether of light down to a small ground disc.
 */
export function createOrbBobLayer(
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
  let orb: THREE.Mesh;
  let glow: THREE.Mesh;
  let groundHalo: THREE.Mesh;

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

      // Solid emissive orb — lifted higher so it clears low buildings.
      orb = new THREE.Mesh(
        new THREE.SphereGeometry(2.2, 32, 24),
        new THREE.MeshBasicMaterial({ color: c }),
      );
      orb.position.y = 26;
      scene.add(orb);

      // Soft glow billboard sprite around the orb.
      glow = new THREE.Mesh(
        new THREE.PlaneGeometry(12, 12),
        new THREE.MeshBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      glow.position.y = 26;
      scene.add(glow);

      // Ground halo disc beneath the orb so the spot reads on the
      // street even when the camera is high.
      groundHalo = new THREE.Mesh(
        new THREE.CircleGeometry(3.5, 48),
        new THREE.MeshBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      groundHalo.rotation.x = -Math.PI / 2;
      groundHalo.position.y = 0.05;
      scene.add(groundHalo);

      // Thin tether line down from the orb to the ground.
      const tetherGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.1, 0),
        new THREE.Vector3(0, 24, 0),
      ]);
      const tether = new THREE.Line(
        tetherGeo,
        new THREE.LineBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0.45,
        }),
      );
      scene.add(tether);

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(_gl, matrix) {
      const t = (performance.now() - startTime) / 1000;
      // Bob the orb + scale the glow.
      const bob = Math.sin(t * 1.2) * 0.9;
      orb.position.y = 26 + bob;
      glow.position.y = 26 + bob;
      const pulse = 1 + Math.sin(t * 2) * 0.08;
      glow.scale.setScalar(pulse);
      groundHalo.scale.setScalar(1 + Math.sin(t * 1.4) * 0.08);
      // Billboard the glow toward the camera.
      glow.lookAt(
        new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z),
      );

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
