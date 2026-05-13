/**
 * VibeArc — the iridescent arch from /space, rendered standalone
 * as a hero ornament on /vibe. Same GLB, same RoomEnvironment
 * setup so the PBR shimmer reads correctly. Slow Y rotation +
 * gentle X bob so it floats like it's drifting in space.
 *
 * Self-contained: no scene state from /space leaks in, no shared
 * resources to worry about. Drops anywhere a canvas can fit.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import iridescentArcUrl from "@/assets/glb/iridescent-arc.glb";

interface Props {
  /** Pixel square size. Default 260. */
  size?: number;
  /** Y-axis rotation seconds per full turn. Lower = faster. */
  rotateSeconds?: number;
  className?: string;
}

export default function VibeArc({ size = 260, rotateSeconds = 14, className = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const scene = new THREE.Scene();

    // RoomEnvironment is what makes iridescent PBR materials actually
    // shimmer — without an environment map, metalness reads near-black
    // on a dark page background.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
    camera.position.set(0, 0.6, 7);
    camera.lookAt(0, 0, 0);

    // Two small accent lights — colored from opposite sides so the
    // iridescent surface catches different hues as it rotates.
    const left = new THREE.DirectionalLight(0xff9bd8, 0.7);
    left.position.set(-5, 2, 4);
    scene.add(left);
    const right = new THREE.DirectionalLight(0x9be0ff, 0.7);
    right.position.set(5, 2, 4);
    scene.add(right);
    scene.add(new THREE.AmbientLight(0xffffff, 0.15));

    let arc: THREE.Group | null = null;

    new GLTFLoader().load(
      iridescentArcUrl,
      (gltf) => {
        arc = gltf.scene;
        // Normalize so the arc fits the canvas regardless of how the
        // GLB was authored.
        const box = new THREE.Box3().setFromObject(arc);
        const sz = new THREE.Vector3();
        box.getSize(sz);
        const target = 4.5;
        const fit = target / Math.max(sz.x, sz.y, sz.z, 0.0001);
        arc.scale.setScalar(fit);
        const center = new THREE.Vector3();
        box.getCenter(center);
        arc.position.x = -center.x * fit;
        arc.position.y = -center.y * fit;
        arc.position.z = -center.z * fit;
        // Boost the iridescent shimmer the same way /space does —
        // emissive map from the diffuse texture so the surface glows
        // against a dark backdrop, tone metalness down so it's not a
        // black mirror.
        arc.traverse((obj) => {
          const m = obj as THREE.Mesh;
          if (!m.isMesh) return;
          const apply = (mat: THREE.Material) => {
            const std = mat as THREE.MeshStandardMaterial;
            if (!std || !("metalness" in std)) return;
            std.metalness = Math.min(std.metalness, 0.3);
            std.roughness = Math.max(std.roughness, 0.35);
            if (std.map) {
              std.emissiveMap = std.map;
              std.emissive = new THREE.Color(0xffffff);
              std.emissiveIntensity = 0.55;
            }
            std.envMapIntensity = 1.2;
            std.needsUpdate = true;
          };
          const mat = m.material;
          if (Array.isArray(mat)) mat.forEach(apply);
          else if (mat) apply(mat);
        });
        scene.add(arc);
      },
      undefined,
      (err) => console.warn("[VibeArc] failed to load", err),
    );

    const clock = new THREE.Clock();
    const rotateRate = (Math.PI * 2) / rotateSeconds; // rad/sec
    let raf = 0;
    const tick = () => {
      const dt = clock.getDelta();
      const t = clock.elapsedTime;
      if (arc) {
        arc.rotation.y += dt * rotateRate;
        arc.rotation.x = Math.sin(t * 0.5) * 0.08;
        arc.position.y = Math.sin(t * 0.7) * 0.12;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      pmrem.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    };
  }, [size, rotateSeconds]);

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
