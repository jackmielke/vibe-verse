import mapboxgl from "mapbox-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import unit7ModelUrl from "@/assets/robot-expressive.glb";

// Locomotion + emote names from the RobotExpressive example.
// https://threejs.org/examples/?q=Animation#webgl_animation_skinning_morph
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

// Face morphs available on the model (head mesh has these blend shapes).
export type Unit7Expression = "Angry" | "Surprised" | "Sad";

export interface Unit7State {
  lng: number;
  lat: number;
  baseAltitude: number;
  heading: number;
  currentAnim: Unit7AnimName;
  // Bumped whenever the caller wants the *same* anim to retrigger (e.g. tap
  // Wave a second time). The layer compares to its last seen value.
  animPulse: number;
  // 0..1 per face morph. Defaults to all-zero (neutral expression).
  expressions: Record<Unit7Expression, number>;
  // Optional. When set, overrides the default SCALE_METERS so a UI slider
  // can grow him on the map without remounting the layer.
  scaleMeters?: number;
}

// Defaults / bounds for the size slider. Default = the value that "felt
// right" early on — proportionate halo, recognizable character.
export const UNIT7_DEFAULT_SCALE_METERS = 28;
export const UNIT7_MIN_SCALE_METERS = 28;
// 10× the old cap so he can tower over the plaza pavilion when you want.
export const UNIT7_MAX_SCALE_METERS = 1100;

export function createDefaultUnit7State(lng: number, lat: number): Unit7State {
  return {
    lng,
    lat,
    baseAltitude: 0,
    heading: 0,
    currentAnim: "Idle",
    animPulse: 0,
    expressions: { Angry: 0, Surprised: 0, Sad: 0 },
    scaleMeters: UNIT7_DEFAULT_SCALE_METERS,
  };
}

const SCALE_METERS = UNIT7_DEFAULT_SCALE_METERS;
// Tiny clearance over terrain so his soles don't z-fight the ground.
// He walks ON the ground; no float, no bob.
const GROUND_CLEARANCE = 0.3;
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
  // Head mesh + morph dictionary for facial expressions (Angry, Surprised, Sad).
  let faceMesh: THREE.Mesh | null = null;
  let morphIndex: Partial<Record<Unit7Expression, number>> = {};
  const actions = new Map<Unit7AnimName, THREE.AnimationAction>();
  let activeAction: THREE.AnimationAction | null = null;
  let lastAnim: Unit7AnimName | null = null;
  let lastPulse = state.animPulse;
  let lastTime = performance.now();
  // Static centering offsets captured after GLB load. Re-applied every frame
  // so any animation root motion can't drift the bot away from the halo.
  const modelHomePos = new THREE.Vector3();
  const startTime = performance.now();

  // Decorative beacon group so we can pulse / scale it in render().
  const beaconGroup = new THREE.Group();
  let beaconRing: THREE.Mesh | null = null;

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

      // Brighter lighting so the bot reads against dusk shadows.
      scene.add(new THREE.AmbientLight(0xffffff, 1.1));
      const key = new THREE.DirectionalLight(0xffffff, 1.4);
      key.position.set(-30, 60, 50).normalize();
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x9affd6, 0.7);
      rim.position.set(40, 20, -30).normalize();
      scene.add(rim);

      // ---- Beacon: subtle ring under his feet + tall pillar above -------
      // Ring sized to roughly his footprint so it reads as "this guy is
      // here", not as a giant landing pad. RobotExpressive's footprint is
      // ~0.6 local units wide.
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.45, 0.55, 64),
        new THREE.MeshBasicMaterial({
          color: 0x73ffb8,
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

      // Subtle glow filling the ring.
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(0.5, 64),
        new THREE.MeshBasicMaterial({
          color: 0x73ffb8,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
        }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.04;
      glow.renderOrder = -1;
      beaconGroup.add(glow);

      // Tall vertical pillar so he's findable from any zoom or angle.
      // Starts above the model's head (y=2.4) so he isn't wrapped inside it.
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.16, 18, 16, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x73ffb8,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      pillar.position.y = 11;
      beaconGroup.add(pillar);

      scene.add(beaconGroup);

      const loader = new GLTFLoader();
      loader.load(
        unit7ModelUrl,
        (gltf) => {
          model = gltf.scene;
          // Normalize height to 2 scene units. We do NOT translate to center
          // on the bbox — RobotExpressive's GLB is authored with origin
          // close to the feet center, and any pre-translate gets multiplied
          // by `meterScale` at render time, so even sub-unit offsets become
          // hundreds of meters at large slider values. Leaving it natural
          // keeps the bot tight to the halo at every scale.
          const box = new THREE.Box3().setFromObject(model);
          const size = new THREE.Vector3();
          box.getSize(size);
          const fit = 2 / (size.y || 1);
          model.scale.setScalar(fit);
          modelHomePos.copy(model.position); // (0, 0, 0)
          scene.add(model);

          // Find the head mesh that owns the face morph targets so we can
          // drive Angry / Surprised / Sad expressions later.
          model.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            const dict = mesh.morphTargetDictionary;
            if (dict && ("Angry" in dict || "Surprised" in dict || "Sad" in dict)) {
              faceMesh = mesh;
              morphIndex = {
                Angry: dict["Angry"],
                Surprised: dict["Surprised"],
                Sad: dict["Sad"],
              };
            }
          });

          mixer = new THREE.AnimationMixer(model);
          mixer.addEventListener("finished", () => {
            // After a one-shot, ask the consumer what to play next.
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
      const t = (now - startTime) / 1000;

      if (mixer) mixer.update(delta);

      // Pin the model back to its centered home each frame so any root
      // translation an animation tries to apply (Walking has stride drift,
      // for example) can't pull him out from under the halo.
      if (model) model.position.copy(modelHomePos);

      // Apply animation changes from outside.
      if (lastAnim !== state.currentAnim || lastPulse !== state.animPulse) {
        play(state.currentAnim, lastPulse !== state.animPulse);
        lastAnim = state.currentAnim;
        lastPulse = state.animPulse;
      }

      // Push expression weights every frame; cheap and keeps morphs in sync
      // even if the consumer mutates state mid-frame.
      if (faceMesh && faceMesh.morphTargetInfluences) {
        for (const name of ["Angry", "Surprised", "Sad"] as Unit7Expression[]) {
          const idx = morphIndex[name];
          if (typeof idx === "number") {
            const w = state.expressions?.[name] ?? 0;
            faceMesh.morphTargetInfluences[idx] = Math.max(0, Math.min(1, w));
          }
        }
      }

      if (model) {
        model.rotation.y = state.heading;
      }

      // Subtle pulsing beacon scale — characters' bob removed; he walks
      // ON the ground.
      const beaconPulse = 1 + Math.sin(t * 2) * 0.06;
      beaconGroup.scale.set(beaconPulse, 1, beaconPulse);
      if (beaconRing) {
        (beaconRing.material as THREE.MeshBasicMaterial).opacity =
          0.55 + Math.sin(t * 2) * 0.2;
      }

      // Anchor to the sampled terrain — feet just clear the surface.
      const altitude = state.baseAltitude + GROUND_CLEARANCE;
      const mercator = mapboxgl.MercatorCoordinate.fromLngLat(
        { lng: state.lng, lat: state.lat },
        altitude,
      );
      const scaleMeters = state.scaleMeters ?? SCALE_METERS;
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
