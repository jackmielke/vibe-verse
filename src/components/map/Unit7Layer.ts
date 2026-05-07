import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import unit7ModelUrl from "@/assets/robot-expressive.glb";

export type Unit7AnimName =
  | "Idle"
  | "Walking"
  | "Running"
  | "Dance"
  | "Death"
  | "Sitting"
  | "Standing"
  | "Jump"
  | "Yes"
  | "No"
  | "Wave"
  | "Punch"
  | "ThumbsUp";

export interface Unit7State {
  lng: number;
  lat: number;
  baseAltitude: number;
  heading: number;
  currentAnim: Unit7AnimName;
  // Bumped whenever the caller wants the *same* anim to retrigger (e.g. tap
  // Wave a second time). The layer compares to its last seen value.
  animPulse: number;
}

// In meters. 18 keeps him recognizable at the zoom levels the map uses by
// default, while still feeling like a character (not a building).
const SCALE_METERS = 18;
const FADE_SECONDS = 0.2;
const ONE_SHOTS: Unit7AnimName[] = ["Wave", "Yes", "No", "ThumbsUp", "Punch", "Jump"];

export function createUnit7Layer(
  id: string,
  state: Unit7State,
  onIdleAfterOneShot?: () => void,
): mapboxgl.CustomLayerInterface {
  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
  let mapRef: mapboxgl.Map | null = null;

  let model: THREE.Group | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  const actions = new Map<Unit7AnimName, THREE.AnimationAction>();
  let activeAction: THREE.AnimationAction | null = null;
  let lastAnim: Unit7AnimName | null = null;
  let lastPulse = state.animPulse;
  let lastTime = performance.now();

  function play(name: Unit7AnimName, restart = false) {
    const next = actions.get(name);
    if (!next) return;
    const isOneShot = ONE_SHOTS.includes(name);

    if (activeAction === next && !restart) return;

    if (activeAction && activeAction !== next) {
      activeAction.fadeOut(FADE_SECONDS);
    }
    next.reset();
    next.setLoop(isOneShot ? THREE.LoopOnce : THREE.LoopRepeat, isOneShot ? 1 : Infinity);
    next.clampWhenFinished = isOneShot;
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

      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const key = new THREE.DirectionalLight(0xffffff, 1.1);
      key.position.set(-30, 60, 50).normalize();
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x9affd6, 0.55);
      rim.position.set(40, 20, -30).normalize();
      scene.add(rim);

      // Soft glow disc beneath the bot
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(1.2, 48),
        new THREE.MeshBasicMaterial({
          color: 0x73ffb8,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.02;
      glow.renderOrder = -1;
      scene.add(glow);

      // Vertical beacon beam so the bot is findable from any zoom.
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0x73ffb8,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 12, 16), beamMat);
      beam.position.y = 6;
      scene.add(beam);

      const loader = new GLTFLoader();
      loader.load(
        unit7ModelUrl,
        (gltf) => {
          model = gltf.scene;
          // Normalize so the model is ~2 units tall and feet sit at y=0.
          const box = new THREE.Box3().setFromObject(model);
          const size = new THREE.Vector3();
          box.getSize(size);
          const fit = 2 / (size.y || 1);
          model.scale.setScalar(fit);
          const center = new THREE.Vector3();
          box.getCenter(center);
          model.position.x = -center.x * fit;
          model.position.z = -center.z * fit;
          model.position.y = -box.min.y * fit;
          scene.add(model);

          mixer = new THREE.AnimationMixer(model);
          mixer.addEventListener("finished", () => {
            // Drop back to whatever the caller set as `currentAnim` after a
            // one-shot finishes. If it's still a one-shot, the consumer
            // probably wants Idle — let them decide via callback.
            onIdleAfterOneShot?.();
          });
          for (const clip of gltf.animations) {
            actions.set(clip.name as Unit7AnimName, mixer.clipAction(clip));
          }
          play(state.currentAnim);
          lastAnim = state.currentAnim;
          mapRef?.triggerRepaint();
        },
        undefined,
        (err) => {
          console.error("[Unit-7] failed to load model", err);
        },
      );

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

      if (mixer) mixer.update(delta);

      // Apply animation changes from outside.
      if (lastAnim !== state.currentAnim || lastPulse !== state.animPulse) {
        play(state.currentAnim, lastPulse !== state.animPulse);
        lastAnim = state.currentAnim;
        lastPulse = state.animPulse;
      }

      if (model) {
        // state.heading: 0 = north (i.e. -y in mercator). Robot's "forward"
        // is +Z in its local frame, so rotate accordingly.
        model.rotation.y = state.heading;
      }

      // Lift the model 1m above sampled terrain so we don't z-fight on
      // sloped tiles or get clipped on terrain mesh edges.
      const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
        { lng: state.lng, lat: state.lat },
        state.baseAltitude + 1,
      );
      const meterScale = mercator.meterInMercatorCoordinateUnits() * SCALE_METERS;

      // Mapbox custom-layer convention: rotate +X by π/2 so model "up" is +Z
      // in mercator space, and flip Y (-meterScale) so meshes don't render
      // mirrored.
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
