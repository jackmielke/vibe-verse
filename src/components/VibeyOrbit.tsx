/**
 * VibeyOrbit — small Three.js canvas that renders Vibey 2.0 floating
 * in a soft halo with a slow camera orbit + idle animation. Used as
 * the hero ornament on /vibe and any other page that wants the
 * little robot to set the tone.
 *
 * Loads the same robot-expressive.glb that drives /space and the
 * memory garden, plays the Idle clip, and rotates the camera around
 * him so he reads as "alive" even on a static page. ~150 LOC,
 * cleans up on unmount.
 *
 * Props let callers tweak the look without forking:
 *   size      — px square (default 200)
 *   animation — clip name to play (default "Idle")
 *   tint      — accent color for the halo glow
 *   bg        — "transparent" (default) lets the page color through
 *               so the canvas blends into any hero gradient
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { releaseRenderer } from "@/lib/quality";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import vibeyUrl from "@/assets/glb/robot-expressive.glb";

interface Props {
  size?: number;
  animation?: string;
  tint?: string;
  className?: string;
}

export default function VibeyOrbit({
  size = 200,
  animation = "Idle",
  tint = "#73ffb8",
  className = "",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true, // transparent so the page bg shows through
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    // No fog — the orbit reads better against a clean halo.

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
    camera.position.set(0, 1.6, 4.2);
    camera.lookAt(0, 1.0, 0);

    // Soft trio of lights: cool fill, warm key from the side,
    // accent point light beneath in the tint color so Vibey has a
    // little community-color glow tied to him.
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xfff0e0, 1.4);
    key.position.set(2.5, 3.5, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xb0c8ff, 0.5);
    fill.position.set(-2, 1.5, -1);
    scene.add(fill);
    const accent = new THREE.PointLight(new THREE.Color(tint), 1.4, 5);
    accent.position.set(0, 0.3, 1.4);
    scene.add(accent);

    // A subtle disc-glow behind Vibey so the halo reads as a coin or
    // a community emblem instead of a void.
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(1.4, 48),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(tint),
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    halo.position.set(0, 1.05, -0.5);
    scene.add(halo);

    let model: THREE.Group | null = null;
    let mixer: THREE.AnimationMixer | null = null;

    // Load Vibey, normalize size, bottom-anchor him so he stands on
    // y = 0 regardless of where the GLB's origin happens to be.
    new GLTFLoader().load(
      vibeyUrl,
      (gltf) => {
        model = gltf.scene;
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const sz = new THREE.Vector3();
        box.getSize(sz);
        const fit = 1.7 / Math.max(sz.y, 0.01);
        model.scale.setScalar(fit);
        model.updateMatrixWorld(true);
        const box2 = new THREE.Box3().setFromObject(model);
        model.position.y = -box2.min.y;
        const center = new THREE.Vector3();
        box2.getCenter(center);
        model.position.x = -center.x;
        model.position.z = -center.z;
        scene.add(model);
        if (gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model);
          const clip =
            gltf.animations.find((c) => c.name.toLowerCase() === animation.toLowerCase()) ??
            gltf.animations.find((c) => /idle|breath/i.test(c.name)) ??
            gltf.animations[0];
          if (clip) mixer.clipAction(clip).play();
        }
      },
      undefined,
      (err) => console.warn("[VibeyOrbit] failed to load model", err),
    );

    // Slow camera orbit + halo pulse. RAF kept tight (35° FOV, no
    // EffectComposer) so 60fps is cheap even on a phone.
    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      const dt = Math.min(0.05, clock.getDelta());
      const t = clock.elapsedTime;
      const r = 4.0;
      const a = t * 0.45;
      camera.position.set(Math.sin(a) * r, 1.6 + Math.sin(t * 0.6) * 0.12, Math.cos(a) * r);
      camera.lookAt(0, 1.0, 0);
      halo.lookAt(camera.position);
      (halo.material as THREE.MeshBasicMaterial).opacity =
        0.12 + Math.sin(t * 1.4) * 0.04;
      mixer?.update(dt);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      /* Not `renderer.dispose()` — that drops three's caches and leaves the GL
         context for the garbage collector, which may never come. These are
         decorative canvases that mount and unmount with the pages around them,
         so each visit stranded one: measured, the hub leaked a context every
         single time a visitor came back to it from a world. Browsers cap live
         contexts near sixteen and evict the *oldest*, so the world that broke
         was whichever one had been open longest. */
      releaseRenderer(renderer);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    };
  }, [size, animation, tint]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={className}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden="true"
    />
  );
}
