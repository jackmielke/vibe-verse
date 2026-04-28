import mapboxgl from "mapbox-gl";
import * as THREE from "three";

/**
 * Live, mutable state for the helicopter. The MapView owns this object via
 * a ref and updates it every frame (when in pilot mode) or leaves it alone
 * for the default auto-orbit. The custom layer reads from it on each render.
 */
export interface HelicopterState {
  lng: number;
  lat: number;
  altitude: number; // meters above ground
  heading: number; // radians, 0 = north, increases clockwise
  bank: number; // radians, visual roll
  pitch: number; // radians, visual nose-down
  rotorSpeed: number; // multiplier on blade spin (0 = stopped)
  visible: boolean;
  pilotMode: boolean; // when true, suppresses auto-orbit/bob
}

export function createDefaultHelicopterState(
  lng: number,
  lat: number,
): HelicopterState {
  return {
    lng,
    lat,
    altitude: 60,
    heading: 0,
    bank: 0,
    pitch: 0,
    rotorSpeed: 1,
    visible: false,
    pilotMode: false,
  };
}

/**
 * 3D Helicopter — reads its position/orientation from a shared state object
 * each frame, and triggers a continuous map repaint so animation runs even
 * when the camera is still.
 */
export function createHelicopterLayer(
  id: string,
  state: HelicopterState,
): mapboxgl.CustomLayerInterface {
  const modelRotate: [number, number, number] = [Math.PI / 2, 0, 0];

  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
  let chopper: THREE.Group;
  let mainRotor: THREE.Group;
  let tailRotor: THREE.Group;
  let beacon: THREE.Mesh;
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

      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const key = new THREE.DirectionalLight(0xffffff, 1.1);
      key.position.set(0, -50, 80).normalize();
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x73ffb8, 0.4);
      rim.position.set(50, 30, 20).normalize();
      scene.add(rim);

      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2dd4a8, roughness: 0.4, metalness: 0.6 });
      const darkMat = new THREE.MeshStandardMaterial({ color: 0x0d1b2a, roughness: 0.6, metalness: 0.4 });
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

      const fuselage = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 16), bodyMat);
      fuselage.scale.set(1, 0.7, 1.6);
      chopper.add(fuselage);

      const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), glassMat);
      cockpit.scale.set(0.95, 0.7, 1.0);
      cockpit.position.set(0, 0.05, 0.55);
      chopper.add(cockpit);

      const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.14, 1.4, 12), bodyMat);
      tail.rotation.x = Math.PI / 2;
      tail.position.set(0, 0.05, -1.0);
      chopper.add(tail);

      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.35, 0.3), bodyMat);
      fin.position.set(0, 0.25, -1.65);
      chopper.add(fin);

      const skidGeom = new THREE.CylinderGeometry(0.04, 0.04, 1.4, 8);
      const skidL = new THREE.Mesh(skidGeom, darkMat);
      skidL.rotation.x = Math.PI / 2;
      skidL.position.set(-0.35, -0.5, 0);
      chopper.add(skidL);
      const skidR = skidL.clone();
      skidR.position.x = 0.35;
      chopper.add(skidR);
      [-0.4, 0.4].forEach((z) => {
        [-0.35, 0.35].forEach((x) => {
          const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 6), darkMat);
          strut.position.set(x, -0.3, z);
          chopper.add(strut);
        });
      });

      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 8), darkMat);
      mast.position.set(0, 0.55, 0.05);
      chopper.add(mast);

      mainRotor = new THREE.Group();
      mainRotor.position.set(0, 0.72, 0.05);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 10), darkMat);
      mainRotor.add(hub);
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.04, 0.18), bladeMat);
        blade.rotation.y = (i * Math.PI) / 2;
        mainRotor.add(blade);
      }
      chopper.add(mainRotor);

      tailRotor = new THREE.Group();
      tailRotor.position.set(0.12, 0.18, -1.65);
      for (let i = 0; i < 3; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.06), bladeMat);
        blade.rotation.z = (i * Math.PI * 2) / 3;
        tailRotor.add(blade);
      }
      chopper.add(tailRotor);

      beacon = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), beaconMat);
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

    render(_gl, matrix) {
      if (!state.visible) {
        // Still trigger repaint so we can resume cleanly when toggled back on.
        return;
      }

      const t = (performance.now() - startTime) / 1000;

      // Auto-orbit/bob only when not piloted
      let bobY = 0;
      let autoYaw = 0;
      let autoBank = 0;
      if (!state.pilotMode) {
        autoYaw = t * 0.25;
        bobY = Math.sin(t * 1.2) * 0.15;
        autoBank = Math.sin(t * 0.5) * 0.05;
      }

      // Spin rotors
      if (mainRotor) mainRotor.rotation.y = t * 30 * state.rotorSpeed;
      if (tailRotor) tailRotor.rotation.x = t * 40 * state.rotorSpeed;
      if (beacon) {
        const blink = (Math.sin(t * 4) + 1) / 2;
        (beacon.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.5 + blink * 3;
      }

      // Apply orientation to chopper group
      // model is rotated so that group Y is world up; group rotation order:
      //   Y = heading (yaw), Z = bank (roll), X = pitch
      chopper.rotation.order = "YXZ";
      chopper.rotation.y = state.pilotMode ? -state.heading : autoYaw;
      chopper.rotation.x = state.pitch;
      chopper.rotation.z = state.bank + autoBank;
      chopper.position.y = bobY;

      // Compute mercator transform from current state every frame
      const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
        { lng: state.lng, lat: state.lat },
        state.altitude,
      );
      const meterScale = mercator.meterInMercatorCoordinateUnits() * 30;

      const rotationX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), modelRotate[0]);
      const rotationY = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 1, 0), modelRotate[1]);
      const rotationZ = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 0, 1), modelRotate[2]);

      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(mercator.x, mercator.y, mercator.z)
        .scale(new THREE.Vector3(meterScale, -meterScale, meterScale))
        .multiply(rotationX)
        .multiply(rotationY)
        .multiply(rotationZ);

      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);

      // Keep animating even when the map camera is idle.
      mapRef?.triggerRepaint();
    },
  };
}
