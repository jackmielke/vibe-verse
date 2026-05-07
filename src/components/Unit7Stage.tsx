import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import unit7ModelUrl from "@/assets/robot-expressive.glb";
import type { Unit7AnimName, Unit7Expression } from "./map/Unit7Layer";

interface Props {
  currentAnim: Unit7AnimName;
  animPulse: number;
  expressions: Record<Unit7Expression, number>;
  // Called when a one-shot animation finishes so the parent can drop back to
  // a base animation if it wants.
  onOneShotEnd?: () => void;
}

const ONE_SHOTS: Set<Unit7AnimName> = new Set([
  "Wave",
  "Yes",
  "No",
  "ThumbsUp",
  "Punch",
  "Jump",
]);

/**
 * Close-up 3D stage of Unit-7 inside the chat dialog. Independent Three.js
 * scene — separate from the map's custom layer — so we can frame his face,
 * see morph targets clearly, and not fight the Mapbox camera model.
 */
export default function Unit7Stage({
  currentAnim,
  animPulse,
  expressions,
  onOneShotEnd,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Mutable refs so the rAF loop can read the latest props without re-binding.
  const propsRef = useRef({ currentAnim, animPulse, expressions });
  propsRef.current = { currentAnim, animPulse, expressions };
  const onOneShotEndRef = useRef(onOneShotEnd);
  onOneShotEndRef.current = onOneShotEnd;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // ---- Scene + lighting -----------------------------------------------
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(-1, 2.5, 2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x73ffb8, 0.7);
    rim.position.set(2, 1.2, -1.5);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xa5d8ff, 0.35);
    fill.position.set(-2, -0.5, 1);
    scene.add(fill);

    // ---- Camera ----------------------------------------------------------
    // Frame: roughly chest-up. Camera at ~3.2 units back, eye-level with the
    // head. Slightly low FOV so it feels like a portrait, not a fisheye.
    // Camera framing: ¾-front view of the bot's torso/head, like a
    // character-select screen. RobotExpressive's GLB renders at ~2 units
    // tall at native scale.
    // Match the threejs.org morph-skinning example camera so the bot
    // appears at the size+orientation that example was authored for.
    // https://threejs.org/examples/?q=Animation#webgl_animation_skinning_morph
    const camera = new THREE.PerspectiveCamera(
      45,
      canvas.clientWidth / canvas.clientHeight,
      0.25,
      100,
    );
    camera.position.set(-5, 3, 10);
    camera.lookAt(0, 1, 0);

    // ---- Renderer --------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    // ---- Soft glow disc beneath the bot ---------------------------------
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 64),
      new THREE.MeshBasicMaterial({
        color: 0x73ffb8,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.005;
    scene.add(glow);

    // ---- Model + animation/morph wiring ---------------------------------
    let model: THREE.Group | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    const actions = new Map<string, THREE.AnimationAction>();
    let activeAction: THREE.AnimationAction | null = null;
    let lastAnim: Unit7AnimName | null = null;
    let lastPulse = propsRef.current.animPulse - 1; // force first apply
    let faceMesh: THREE.Mesh | null = null;
    const morphIndex: Partial<Record<Unit7Expression, number>> = {};

    function play(name: Unit7AnimName, restart: boolean) {
      const next = actions.get(name);
      if (!next) return;
      const isOneShot = ONE_SHOTS.has(name);
      if (activeAction === next && !restart) return;
      if (activeAction && activeAction !== next) activeAction.fadeOut(0.18);
      next.reset();
      next.setLoop(isOneShot ? THREE.LoopOnce : THREE.LoopRepeat, isOneShot ? 1 : Infinity);
      next.clampWhenFinished = isOneShot;
      next.fadeIn(0.18).play();
      activeAction = next;
    }

    const loader = new GLTFLoader();
    let disposed = false;

    loader.load(
      unit7ModelUrl,
      (gltf) => {
        if (disposed) return;
        // Threejs example loads RobotExpressive and adds the scene as-is.
        // Don't try to compute or normalize the bounding box — the GLB
        // has node transforms and skinned meshes that produce a huge
        // misleading world bbox if you setFromObject on the root.
        model = gltf.scene;
        scene.add(model);

        mixer = new THREE.AnimationMixer(model);
        mixer.addEventListener("finished", () => {
          onOneShotEndRef.current?.();
        });
        for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip));

        // Locate the face mesh that owns morph blend shapes.
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          const dict = mesh.morphTargetDictionary;
          if (dict && ("Angry" in dict || "Surprised" in dict || "Sad" in dict)) {
            faceMesh = mesh;
            if ("Angry" in dict) morphIndex.Angry = dict["Angry"];
            if ("Surprised" in dict) morphIndex.Surprised = dict["Surprised"];
            if ("Sad" in dict) morphIndex.Sad = dict["Sad"];
          }
        });

        play(propsRef.current.currentAnim, true);
        lastAnim = propsRef.current.currentAnim;
        lastPulse = propsRef.current.animPulse;
      },
      undefined,
      (err) => {
        // eslint-disable-next-line no-console
        console.error("[Unit7Stage] failed to load model", err);
      },
    );

    // ---- Resize handling ------------------------------------------------
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(canvas);

    // ---- Animation loop -------------------------------------------------
    let lastTime = performance.now();
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      if (mixer) mixer.update(delta);

      const props = propsRef.current;

      // React to anim changes via prop changes / pulse bumps.
      if (model && (lastAnim !== props.currentAnim || lastPulse !== props.animPulse)) {
        play(props.currentAnim, lastPulse !== props.animPulse);
        lastAnim = props.currentAnim;
        lastPulse = props.animPulse;
      }

      // Push morph weights every frame so they ride on top of skeleton anim.
      if (faceMesh && faceMesh.morphTargetInfluences) {
        for (const name of ["Angry", "Surprised", "Sad"] as Unit7Expression[]) {
          const idx = morphIndex[name];
          if (typeof idx === "number") {
            const w = props.expressions?.[name] ?? 0;
            faceMesh.morphTargetInfluences[idx] = Math.max(0, Math.min(1, w));
          }
        }
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      // Clean up GPU resources.
      if (model) {
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry?.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat?.dispose();
        });
      }
      renderer.dispose();
    };
  }, []);

  return (
    <div className="relative w-full h-72 rounded-xl overflow-hidden bg-gradient-to-b from-primary/10 to-background/40 border border-border/50">
      <canvas
        ref={canvasRef}
        className="w-full h-full block"
        // Width/height set programmatically via ResizeObserver. Defaults
        // here just prevent flash before mount.
        width={400}
        height={288}
      />
    </div>
  );
}
