import mapboxgl from "mapbox-gl";
import * as THREE from "three";

/**
 * 3D Helicopter floating high above the village. The model bobs gently and
 * slowly orbits in place, with spinning main + tail rotors and a blinking
 * underbelly beacon. Same MercatorCoordinate pattern as the other layers,
 * but with a large altitude offset so it sits in the sky.
 */
export function createHelicopterLayer(
  id: string,
  lngLat: { lng: number; lat: number },
  altitude = 0,
): mapboxgl.CustomLayerInterface {
  // Float ~60m above whatever ground elevation was sampled — high enough to
  // read as "in the sky" but still in frame at typical pitch/zoom.
  const FLY_HEIGHT = 60;
  const modelOrigin: [number, number] = [lngLat.lng, lngLat.lat];
  const modelRotate: [number, number, number] = [Math.PI / 2, 0, 0];

  const modelAsMercatorCoordinate = mapboxgl.MercatorCoordinate.fromLngLat(
    modelOrigin,
    altitude + FLY_HEIGHT,
  );

  // Helicopter ~30m long — oversized so it's clearly visible from village zoom.
  const meterScale = modelAsMercatorCoordinate.meterInMercatorCoordinateUnits() * 30;

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
  let chopper: THREE.Group;
  let mainRotor: THREE.Group;
  let tailRotor: THREE.Group;
  let beacon: THREE.Mesh;
  const startTime = performance.now();

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const key = new THREE.DirectionalLight(0xffffff, 1.1);
      key.position.set(0, -50, 80).normalize();
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x73ffb8, 0.4);
      rim.position.set(50, 30, 20).normalize();
      scene.add(rim);

      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x2dd4a8, roughness: 0.4, metalness: 0.6,
      });
      const darkMat = new THREE.MeshStandardMaterial({
        color: 0x0d1b2a, roughness: 0.6, metalness: 0.4,
      });
      const glassMat = new THREE.MeshStandardMaterial({
        color: 0x73ffb8, roughness: 0.1, metalness: 0.2,
        emissive: 0x73ffb8, emissiveIntensity: 0.2,
        transparent: true, opacity: 0.7,
      });
      const bladeMat = new THREE.MeshStandardMaterial({
        color: 0x111111, roughness: 0.5, transparent: true, opacity: 0.55,
      });
      const beaconMat = new THREE.MeshStandardMaterial({
        color: 0xff3344, emissive: 0xff3344, emissiveIntensity: 2.5,
      });

      chopper = new THREE.Group();

      // Main fuselage — stretched sphere
      const fuselage = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 20, 16),
        bodyMat,
      );
      fuselage.scale.set(1, 0.7, 1.6);
      chopper.add(fuselage);

      // Cockpit glass dome on the front
      const cockpit = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 16, 12),
        glassMat,
      );
      cockpit.scale.set(0.95, 0.7, 1.0);
      cockpit.position.set(0, 0.05, 0.55);
      chopper.add(cockpit);

      // Tail boom
      const tail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.14, 1.4, 12),
        bodyMat,
      );
      tail.rotation.x = Math.PI / 2;
      tail.position.set(0, 0.05, -1.0);
      chopper.add(tail);

      // Tail fin
      const fin = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.35, 0.3),
        bodyMat,
      );
      fin.position.set(0, 0.25, -1.65);
      chopper.add(fin);

      // Landing skids
      const skidGeom = new THREE.CylinderGeometry(0.04, 0.04, 1.4, 8);
      const skidL = new THREE.Mesh(skidGeom, darkMat);
      skidL.rotation.x = Math.PI / 2;
      skidL.position.set(-0.35, -0.5, 0);
      chopper.add(skidL);
      const skidR = skidL.clone();
      skidR.position.x = 0.35;
      chopper.add(skidR);
      // Skid struts
      [-0.4, 0.4].forEach((z) => {
        [-0.35, 0.35].forEach((x) => {
          const strut = new THREE.Mesh(
            new THREE.CylinderGeometry(0.025, 0.025, 0.4, 6),
            darkMat,
          );
          strut.position.set(x, -0.3, z);
          chopper.add(strut);
        });
      });

      // Rotor mast
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.3, 8),
        darkMat,
      );
      mast.position.set(0, 0.55, 0.05);
      chopper.add(mast);

      // Main rotor — 4 blades on a hub
      mainRotor = new THREE.Group();
      mainRotor.position.set(0, 0.72, 0.05);
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, 0.08, 10),
        darkMat,
      );
      mainRotor.add(hub);
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(
          new THREE.BoxGeometry(2.6, 0.04, 0.18),
          bladeMat,
        );
        blade.rotation.y = (i * Math.PI) / 2;
        mainRotor.add(blade);
      }
      chopper.add(mainRotor);

      // Tail rotor
      tailRotor = new THREE.Group();
      tailRotor.position.set(0.12, 0.18, -1.65);
      for (let i = 0; i < 3; i++) {
        const blade = new THREE.Mesh(
          new THREE.BoxGeometry(0.04, 0.5, 0.06),
          bladeMat,
        );
        blade.rotation.z = (i * Math.PI * 2) / 3;
        tailRotor.add(blade);
      }
      chopper.add(tailRotor);

      // Blinking belly beacon
      beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 8, 8),
        beaconMat,
      );
      beacon.position.set(0, -0.45, 0);
      chopper.add(beacon);

      const beaconLight = new THREE.PointLight(0xff3344, 1.5, 6);
      beaconLight.position.set(0, -0.45, 0);
      chopper.add(beaconLight);

      scene.add(chopper);

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(gl, matrix) {
      const t = (performance.now() - startTime) / 1000;

      if (chopper) {
        // Slow yaw orbit + gentle bob
        chopper.rotation.y = t * 0.25;
        chopper.position.y = Math.sin(t * 1.2) * 0.15;
        // Subtle bank
        chopper.rotation.z = Math.sin(t * 0.5) * 0.05;
      }
      if (mainRotor) mainRotor.rotation.y = t * 30;
      if (tailRotor) tailRotor.rotation.x = t * 40;
      if (beacon) {
        const blink = (Math.sin(t * 4) + 1) / 2;
        (beacon.material as THREE.MeshStandardMaterial).emissiveIntensity =
          0.5 + blink * 3;
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
