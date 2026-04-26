import mapboxgl from "mapbox-gl";
import * as THREE from "three";

/**
 * 3D Observatory: a slender tower with a domed top and a rotating
 * telescope slit, glowing softly at night.
 */
export function createObservatoryLayer(
  id: string,
  lngLat: { lng: number; lat: number },
  altitude = 0,
): mapboxgl.CustomLayerInterface {
  const modelOrigin: [number, number] = [lngLat.lng, lngLat.lat];
  const modelRotate: [number, number, number] = [Math.PI / 2, 0, 0];

  const modelAsMercatorCoordinate = mapboxgl.MercatorCoordinate.fromLngLat(
    modelOrigin,
    altitude,
  );

  // Observatory ~20m base diameter, tall
  const meterScale = modelAsMercatorCoordinate.meterInMercatorCoordinateUnits() * 20;

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
  let dome: THREE.Mesh;
  let beam: THREE.Mesh;
  let domeLight: THREE.PointLight;
  const startTime = performance.now();

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      scene.add(new THREE.AmbientLight(0xb3c5ff, 0.45));
      const key = new THREE.DirectionalLight(0xffe5c2, 0.9);
      key.position.set(0, -70, 100).normalize();
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x67e8f9, 0.6);
      rim.position.set(0, 70, 50).normalize();
      scene.add(rim);

      domeLight = new THREE.PointLight(0x67e8f9, 3, 8);
      domeLight.position.set(0, 4, 0);
      scene.add(domeLight);

      const stoneMat = new THREE.MeshStandardMaterial({
        color: 0xd6d3cf, roughness: 0.8, metalness: 0.1,
      });
      const baseMat = new THREE.MeshStandardMaterial({
        color: 0x6b7280, roughness: 0.9,
      });
      const domeMat = new THREE.MeshStandardMaterial({
        color: 0x4a5568, roughness: 0.4, metalness: 0.7,
        emissive: 0x1e3a5f, emissiveIntensity: 0.3,
      });
      const slitMat = new THREE.MeshBasicMaterial({
        color: 0x67e8f9, transparent: true, opacity: 0.9,
      });
      const windowMat = new THREE.MeshStandardMaterial({
        color: 0xfbbf24, emissive: 0xfbbf24, emissiveIntensity: 1.5,
      });

      const root = new THREE.Group();

      // Stepped stone base
      const basePad = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 1.7, 0.2, 16),
        baseMat,
      );
      basePad.position.y = 0.1;
      root.add(basePad);

      // Tower shaft
      const tower = new THREE.Mesh(
        new THREE.CylinderGeometry(1.0, 1.15, 3.2, 16),
        stoneMat,
      );
      tower.position.y = 1.8;
      root.add(tower);

      // Decorative ring band partway up
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(1.08, 1.08, 0.15, 16),
        baseMat,
      );
      band.position.y = 2.2;
      root.add(band);

      // Four small windows around the tower
      const windowPositions = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
      windowPositions.forEach((angle) => {
        const x = Math.cos(angle) * 1.02;
        const z = Math.sin(angle) * 1.02;
        const win = new THREE.Mesh(
          new THREE.BoxGeometry(0.18, 0.3, 0.05),
          windowMat,
        );
        win.position.set(x, 1.4, z);
        win.lookAt(0, 1.4, 0);
        root.add(win);
      });

      // Dome on top (hemisphere)
      dome = new THREE.Mesh(
        new THREE.SphereGeometry(1.15, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
        domeMat,
      );
      dome.position.y = 3.4;
      root.add(dome);

      // Glowing telescope slit cut into the dome
      const slit = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 1.0, 1.2),
        slitMat,
      );
      slit.position.y = 3.85;
      root.add(slit);

      // Beam shooting up at an angle from the slit
      beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.18, 10, 8, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x67e8f9, transparent: true, opacity: 0.4,
        }),
      );
      beam.position.set(0, 8.5, 0);
      beam.rotation.z = 0.25;
      root.add(beam);

      // Tiny aerial on top
      const aerial = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.04, 0.5, 6),
        baseMat,
      );
      aerial.position.y = 4.7;
      root.add(aerial);

      scene.add(root);

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(gl, matrix) {
      const t = (performance.now() - startTime) / 1000;

      // Dome slowly rotates as if scanning the sky
      if (dome) dome.rotation.y = t * 0.2;
      // Beam sweeps with the dome
      if (beam) {
        beam.rotation.y = t * 0.2;
        const s = 0.9 + 0.2 * Math.sin(t * 1.5);
        beam.scale.x = s;
        beam.scale.z = s;
      }
      if (domeLight) {
        domeLight.intensity = 2.5 + 1.0 * Math.sin(t * 1.2);
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
