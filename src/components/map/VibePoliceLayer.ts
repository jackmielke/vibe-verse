import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Anti-Vibe Officer ("Vibe Police") — a Meshy-generated rigged biped.
// Each GLB ships one animation clip; we load the Walking one as the base
// (gives us the SkinnedMesh) and pull additional clips from the others.
// Files live in /public/models so their ~27 MB each don't bundle.
const WALKING_URL = "/models/vibe-police-walking.glb";
const ALERT_URL = "/models/vibe-police-alert.glb";

export type VibePoliceAnimName = "Alert" | "Walking";

export interface VibePoliceState {
  lng: number;
  lat: number;
  baseAltitude: number;
  heading: number;
  currentAnim: VibePoliceAnimName;
  // Bumped to retrigger the same one-shot.
  animPulse: number;
  scaleMeters: number;
}

// The Meshy export's bounding box is dominated by huge head/clothing
// volumes, so a "scaleMeters" of 22 here actually rendered him at roughly
// 20× the apparent size of Unit-7. Drop the defaults way down — the slider
// still goes up to 1100 if you want a kaiju cop.
export const VIBE_POLICE_DEFAULT_SCALE_METERS = 2;
export const VIBE_POLICE_MIN_SCALE_METERS = 1;
export const VIBE_POLICE_MAX_SCALE_METERS = 1100;

export function createDefaultVibePoliceState(
  lng: number,
  lat: number,
): VibePoliceState {
  return {
    lng,
    lat,
    baseAltitude: 0,
    heading: 0,
    currentAnim: "Alert",
    animPulse: 0,
    scaleMeters: VIBE_POLICE_DEFAULT_SCALE_METERS,
  };
}

const GROUND_CLEARANCE = 0.3;
const FADE_SECONDS = 0.25;

export function createVibePoliceLayer(
  id: string,
  state: VibePoliceState,
): mapboxgl.CustomLayerInterface {
  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
  let mapRef: mapboxgl.Map | null = null;

  let model: THREE.Group | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  const actions = new Map<VibePoliceAnimName, THREE.AnimationAction>();
  let activeAction: THREE.AnimationAction | null = null;
  let lastAnim: VibePoliceAnimName | null = null;
  let lastPulse = state.animPulse;
  let lastTime = performance.now();
  const startTime = performance.now();
  const modelHomePos = new THREE.Vector3();

  const beaconGroup = new THREE.Group();
  let beaconRing: THREE.Mesh | null = null;

  function play(name: VibePoliceAnimName, restart = false) {
    const next = actions.get(name);
    if (!next) return;
    if (activeAction === next && !restart) return;
    if (activeAction && activeAction !== next) activeAction.fadeOut(FADE_SECONDS);
    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.fadeIn(FADE_SECONDS).play();
    activeAction = next;
  }

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      // Slightly cooler/blue lighting to differentiate the cop from Unit-7.
      scene.add(new THREE.AmbientLight(0xffffff, 1.0));
      const key = new THREE.DirectionalLight(0xffffff, 1.3);
      key.position.set(-30, 60, 50).normalize();
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x7ec5ff, 0.7);
      rim.position.set(40, 20, -30).normalize();
      scene.add(rim);

      // Blue beacon to differentiate from Unit-7's teal.
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.6, 64),
        new THREE.MeshBasicMaterial({
          color: 0x6aa8ff,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.05;
      halo.renderOrder = -1;
      beaconGroup.add(halo);
      beaconRing = halo;

      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(0.45, 64),
        new THREE.MeshBasicMaterial({
          color: 0x6aa8ff,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
        }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.04;
      glow.renderOrder = -1;
      beaconGroup.add(glow);

      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.22, 18, 16, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x6aa8ff,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      pillar.position.y = 11;
      beaconGroup.add(pillar);

      scene.add(beaconGroup);

      // Load the Walking GLB as the base — its scene tree includes the
      // SkinnedMesh we'll animate. Also pull in the Alert clip from the
      // separate Alert GLB (Meshy ships one anim per file).
      const loader = new GLTFLoader();
      loader.load(WALKING_URL, (walkingGltf) => {
        model = walkingGltf.scene;
        // Scale to ~2 scene units tall.
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const fit = 2 / (size.y || 1);
        model.scale.setScalar(fit);
        scene.add(model);
        modelHomePos.copy(model.position);

        mixer = new THREE.AnimationMixer(model);
        // The walking clip lives in `walkingGltf.animations` — Meshy names it
        // something like the file's name. Just take the first one.
        const walkClip = walkingGltf.animations[0];
        if (walkClip) {
          walkClip.name = "Walking";
          actions.set("Walking", mixer.clipAction(walkClip));
        }

        // Now load the Alert clip and attach it to the same mixer/skeleton.
        loader.load(ALERT_URL, (alertGltf) => {
          if (!mixer) return;
          const alertClip = alertGltf.animations[0];
          if (alertClip) {
            alertClip.name = "Alert";
            actions.set("Alert", mixer.clipAction(alertClip));
          }
          play(state.currentAnim);
          lastAnim = state.currentAnim;
          mapRef?.triggerRepaint();
        });

        // Kick off whatever's set immediately so he's not frozen during the
        // Alert-clip download.
        play(state.currentAnim);
        lastAnim = state.currentAnim;
        mapRef?.triggerRepaint();
      });

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(_gl, matrix) {
      const now = performance.now();
      const delta = (now - lastTime) / 1000;
      lastTime = now;
      const t = (now - startTime) / 1000;

      if (mixer) mixer.update(delta);

      if (model) model.position.copy(modelHomePos);

      if (lastAnim !== state.currentAnim || lastPulse !== state.animPulse) {
        play(state.currentAnim, lastPulse !== state.animPulse);
        lastAnim = state.currentAnim;
        lastPulse = state.animPulse;
      }

      if (model) model.rotation.y = state.heading;

      // Subtle pulse on the halo ring.
      const beaconPulse = 1 + Math.sin(t * 2) * 0.06;
      beaconGroup.scale.set(beaconPulse, 1, beaconPulse);
      if (beaconRing) {
        (beaconRing.material as THREE.MeshBasicMaterial).opacity =
          0.55 + Math.sin(t * 2) * 0.2;
      }

      const altitude = state.baseAltitude + GROUND_CLEARANCE;
      const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
        { lng: state.lng, lat: state.lat },
        altitude,
      );
      const scaleMeters = state.scaleMeters || VIBE_POLICE_DEFAULT_SCALE_METERS;
      const meterScale = mercator.meterInMercatorCoordinateUnits() * scaleMeters;

      const rotationX = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(1, 0, 0),
        Math.PI / 2,
      );

      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(mercator.x, mercator.y, mercator.z)
        .scale(new THREE.Vector3(meterScale, -meterScale, meterScale))
        .multiply(rotationX);

      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);

      mapRef?.triggerRepaint();
    },
  };
}

