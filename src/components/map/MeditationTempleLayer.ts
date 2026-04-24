import mapboxgl from "mapbox-gl";
import * as THREE from "three";

/**
 * Mapbox CustomLayer that renders a small 3D meditation pavilion at a given
 * lng/lat using Three.js. Built from primitives — no external assets.
 *
 * Mapbox owns the WebGL context, so we render with the gl/matrix it provides
 * inside the `render()` hook. See:
 * https://docs.mapbox.com/mapbox-gl-js/example/add-3d-model/
 */
export function createMeditationTempleLayer(
  id: string,
  lngLat: { lng: number; lat: number },
  altitude = 0,
): mapboxgl.CustomLayerInterface {
  const modelOrigin: [number, number] = [lngLat.lng, lngLat.lat];
  const modelAltitude = altitude;
  // Rotate X by 90° so Three.js Y-up becomes Mapbox Z-up (model stands upright on ground).
  const modelRotate: [number, number, number] = [Math.PI / 2, 0, 0];

  const modelAsMercatorCoordinate = mapboxgl.MercatorCoordinate.fromLngLat(
    modelOrigin,
    modelAltitude,
  );

  // Scale: meters → mercator units. Pavilion ~25m wide — visible from village-level zoom.
  const meterScale = modelAsMercatorCoordinate.meterInMercatorCoordinateUnits() * 25;

  const modelTransform = {
    translateX: modelAsMercatorCoordinate.x,
    translateY: modelAsMercatorCoordinate.y,
    translateZ: modelAsMercatorCoordinate.z,
    rotateX: modelRotate[0],
    rotateY: modelRotate[1],
    rotateZ: modelRotate[2],
    scale: meterScale,
  };

  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
  let orb: THREE.Mesh;
  let roofGlow: THREE.PointLight;
  const startTime = performance.now();

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      // ---- Lighting ----
      // Soft warm ambient like dusk
      scene.add(new THREE.AmbientLight(0xffd9b3, 0.55));

      // Key light from the side
      const key = new THREE.DirectionalLight(0xffe5c2, 1.1);
      key.position.set(0, -70, 100).normalize();
      scene.add(key);

      // Cool rim light from opposite
      const rim = new THREE.DirectionalLight(0x73ffb8, 0.5);
      rim.position.set(0, 70, 50).normalize();
      scene.add(rim);

      // Glow inside the temple (point light at orb position — set later)
      roofGlow = new THREE.PointLight(0x73ffb8, 4, 6);
      roofGlow.position.set(0, 1.4, 0);
      scene.add(roofGlow);

      // ---- Materials ----
      const stoneMat = new THREE.MeshStandardMaterial({
        color: 0xe8dcc4,
        roughness: 0.85,
        metalness: 0.05,
      });
      const woodMat = new THREE.MeshStandardMaterial({
        color: 0x8b6f4e,
        roughness: 0.7,
        metalness: 0.0,
      });
      const roofMat = new THREE.MeshStandardMaterial({
        color: 0x2dd4a8,
        roughness: 0.35,
        metalness: 0.4,
        emissive: 0x0d5a44,
        emissiveIntensity: 0.4,
      });
      const orbMat = new THREE.MeshStandardMaterial({
        color: 0x73ffb8,
        emissive: 0x73ffb8,
        emissiveIntensity: 2.5,
        roughness: 0.2,
        metalness: 0.1,
      });

      // ---- Geometry (Y-up; after the layer's rotateX=π/2, +Y becomes world up) ----
      const root = new THREE.Group();

      // Two-step stone base (octagonal). CylinderGeometry's axis is Y by default.
      const baseLower = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 2.4, 0.25, 8),
        stoneMat,
      );
      baseLower.position.y = 0.125;
      root.add(baseLower);

      const baseUpper = new THREE.Mesh(
        new THREE.CylinderGeometry(1.9, 2.0, 0.18, 8),
        stoneMat,
      );
      baseUpper.position.y = 0.34;
      root.add(baseUpper);

      // Floor pad (slightly darker)
      const floorPad = new THREE.Mesh(
        new THREE.CylinderGeometry(1.7, 1.7, 0.05, 8),
        new THREE.MeshStandardMaterial({ color: 0xc9a87a, roughness: 0.9 }),
      );
      floorPad.position.y = 0.45;
      root.add(floorPad);

      // Four corner pillars (vertical along Y)
      const pillarGeom = new THREE.CylinderGeometry(0.12, 0.14, 1.6, 10);
      const pillarPositions: [number, number][] = [
        [1.3, 1.3], [-1.3, 1.3], [1.3, -1.3], [-1.3, -1.3],
      ];
      pillarPositions.forEach(([x, z]) => {
        const pillar = new THREE.Mesh(pillarGeom, woodMat);
        pillar.position.set(x, 1.25, z);
        root.add(pillar);
      });

      // Roof — pagoda-ish stepped pyramid (two tiers). Cone axis = Y.
      const roofLower = new THREE.Mesh(
        new THREE.ConeGeometry(2.3, 0.7, 4),
        roofMat,
      );
      roofLower.position.y = 2.25;
      roofLower.rotation.y = Math.PI / 4;
      root.add(roofLower);

      const roofUpper = new THREE.Mesh(
        new THREE.ConeGeometry(1.4, 1.1, 4),
        roofMat,
      );
      roofUpper.position.y = 2.95;
      roofUpper.rotation.y = Math.PI / 4;
      root.add(roofUpper);

      // Spire
      const spire = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.08, 0.5, 8),
        woodMat,
      );
      spire.position.y = 3.65;
      root.add(spire);

      // Glowing orb on top
      orb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 24), orbMat);
      orb.position.set(0, 3.95, 0);
      root.add(orb);

      // Tall glowing beacon column shooting up from the orb — visible from any zoom
      const beaconMat = new THREE.MeshBasicMaterial({
        color: 0x73ffb8,
        transparent: true,
        opacity: 0.45,
      });
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.25, 14, 12, 1, true),
        beaconMat,
      );
      beacon.position.set(0, 11, 0);
      root.add(beacon);

      // Inner brighter core
      const beaconCore = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.08, 14, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }),
      );
      beaconCore.position.set(0, 11, 0);
      root.add(beaconCore);

      // Update glow position to match orb
      roofGlow.position.set(0, 3.5, 0);

      scene.add(root);

      // ---- Renderer using Mapbox's GL context ----
      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(gl, matrix) {
      // Pulse the orb + glow
      const t = (performance.now() - startTime) / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 2);
      if (orb) {
        const s = 1 + pulse * 0.25;
        orb.scale.set(s, s, s);
      }
      if (roofGlow) {
        roofGlow.intensity = 3 + pulse * 3;
      }

      const rotationX = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(1, 0, 0), modelTransform.rotateX,
      );
      const rotationY = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(0, 1, 0), modelTransform.rotateY,
      );
      const rotationZ = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(0, 0, 1), modelTransform.rotateZ,
      );

      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(
          modelTransform.translateX,
          modelTransform.translateY,
          modelTransform.translateZ,
        )
        .scale(new THREE.Vector3(modelTransform.scale, -modelTransform.scale, modelTransform.scale))
        .multiply(rotationX)
        .multiply(rotationY)
        .multiply(rotationZ);

      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);
    },
  };
}
