import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import * as THREE from "three";
import { releaseRenderer } from "@/lib/quality";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ArrowLeft } from "lucide-react";

import vibeyUrl from "@/assets/glb/robot-expressive.glb";
import alienUrl from "@/assets/glb/alien.glb";
import wizardUrl from "@/assets/glb/characters/Wizard.glb";
import skeletonUrl from "@/assets/glb/characters/Pirate_Skeleton.glb";
import palm1Url from "@/assets/glb/kits/crops/PalmTree_2.glb";
import palm2Url from "@/assets/glb/kits/crops/PalmTree_3.glb";
import tree1Url from "@/assets/glb/nature/Tree1.glb";

/**
 * 3D About page — the project's narrative laid out as a vertical
 * scroll with a small Three.js scene burned into the background. The
 * left column is the readable story (works on phones), the right is
 * a slow-orbiting carousel of the village's characters. No clutter.
 */

type Section = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  cta?: { to: string; label: string };
};

const SECTIONS: Section[] = [
  {
    id: "intro",
    eyebrow: "Edge Esmeralda",
    title: "A pop-up village with a digital twin.",
    body: "An interactive map of Healdsburg, anchored to real GPS, with a community agent floating above the plaza. Every landmark is a real address; every event you'll see in the right panel comes straight from the live community database.",
  },
  {
    id: "speed",
    eyebrow: "Why",
    title: "Built at the speed of intuition.",
    body: "Worlds, characters, and stories are arriving faster than ever — drop a Quaternius pack, drop a Meshy export, and within minutes there's a new venue, a new pet, a new spacecraft orbiting Vibey. The whole stack favors getting cool things into the world over polishing them.",
  },
  {
    id: "web",
    eyebrow: "How",
    title: "An interconnected web of information.",
    body: "Mapbox holds the ground truth. Three.js gives us imagination on top — landmarks become beams of light, palm rings, vineyards, asteroid platforms. Supabase carries the live data: members, photos, events, Vibey's memories. Real coordinates underneath, made-up worlds on top.",
  },
  {
    id: "explore",
    eyebrow: "Where to go next",
    title: "Pick a place and arrive.",
    body: "The village shows the real map with light beams marking each venue. Outer Space is Vibey 2.0's late-night show on a floating asteroid. The Lobby is a Mario-Kart-style picker with 58 characters and their baked animations. Hop between any of them with one click.",
    cta: { to: "/", label: "Enter the village →" },
  },
];

export default function About() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      35,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      120,
    );
    camera.position.set(0, 3.5, 10);
    camera.lookAt(0, 1.4, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xffe8c2, 1.2);
    sun.position.set(-3, 6, 4);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x73ffb8, 0.55);
    rim.position.set(4, 3, -3);
    scene.add(rim);

    // Starfield — small + sparse, more atmospheric than Christmas-y.
    {
      const STAR_COUNT = 600;
      const positions = new Float32Array(STAR_COUNT * 3);
      for (let i = 0; i < STAR_COUNT; i++) {
        const r = 40 + Math.random() * 50;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.12,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      });
      scene.add(new THREE.Points(geo, mat));
    }

    // Floating asteroid platform + glowing rim.
    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(2.6, 2.4, 0.32, 48),
      new THREE.MeshStandardMaterial({
        color: 0x141a30,
        metalness: 0.45,
        roughness: 0.45,
        emissive: 0x0a1530,
        emissiveIntensity: 0.4,
      }),
    );
    platform.position.y = -0.16;
    scene.add(platform);
    const rim2 = new THREE.Mesh(
      new THREE.TorusGeometry(2.6, 0.05, 16, 64),
      new THREE.MeshBasicMaterial({ color: 0x73ffb8, transparent: true, opacity: 0.85 }),
    );
    rim2.rotation.x = Math.PI / 2;
    rim2.position.y = 0.05;
    scene.add(rim2);

    // Carousel: drop one of each interesting character on the
    // platform, slow-spin the whole turntable so they cycle.
    const turntable = new THREE.Group();
    scene.add(turntable);

    type Slot = {
      url: string;
      angle: number;
      mixer?: THREE.AnimationMixer;
    };
    const SLOTS: Slot[] = [
      { url: vibeyUrl, angle: 0 },
      { url: alienUrl, angle: Math.PI / 2 },
      { url: wizardUrl, angle: Math.PI },
      { url: skeletonUrl, angle: Math.PI * 1.5 },
    ];
    const RADIUS = 1.6;
    const loader = new GLTFLoader();
    for (const slot of SLOTS) {
      loader.load(slot.url, (gltf) => {
        const m = gltf.scene;
        m.position.set(0, 0, 0);
        m.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(m);
        const size = new THREE.Vector3();
        box.getSize(size);
        const fit = 1.6 / Math.max(size.x, size.y, size.z, 0.0001);
        m.scale.setScalar(fit);
        m.updateMatrixWorld(true);
        const scaled = new THREE.Box3().setFromObject(m);
        m.position.set(
          Math.cos(slot.angle) * RADIUS,
          0.03 - scaled.min.y,
          Math.sin(slot.angle) * RADIUS,
        );
        m.rotation.y = -slot.angle + Math.PI / 2;
        m.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const apply = (mat: THREE.Material) => {
            const std = mat as THREE.MeshStandardMaterial;
            if (std && "metalness" in std) {
              std.metalness = Math.min(std.metalness, 0.3);
              std.roughness = Math.max(std.roughness, 0.45);
              std.envMapIntensity = 1.0;
              std.needsUpdate = true;
            }
          };
          const mat = mesh.material;
          if (Array.isArray(mat)) mat.forEach(apply);
          else if (mat) apply(mat);
        });
        turntable.add(m);
        if (gltf.animations.length) {
          const mixer = new THREE.AnimationMixer(m);
          const idle = gltf.animations.find((c) => /idle/i.test(c.name)) ??
            gltf.animations[0];
          mixer.clipAction(idle).play();
          slot.mixer = mixer;
        }
      });
    }

    // Palm trees flanking the platform — same kit as the village.
    const palmUrls = [palm1Url, palm2Url, tree1Url];
    for (let i = 0; i < palmUrls.length; i++) {
      loader.load(palmUrls[i], (gltf) => {
        const palm = gltf.scene;
        palm.scale.setScalar(0.9);
        const a = (i / palmUrls.length) * Math.PI * 2 - Math.PI / 2;
        palm.position.set(Math.cos(a) * 4.2, -0.05, Math.sin(a) * 4.2 - 0.5);
        palm.rotation.y = Math.random() * Math.PI * 2;
        scene.add(palm);
      });
    }

    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(canvas);

    let raf = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const delta = (now - last) / 1000;
      last = now;
      turntable.rotation.y += delta * 0.18;
      const rmat = rim2.material as THREE.MeshBasicMaterial;
      rmat.opacity = 0.65 + Math.sin(now * 0.0015) * 0.2;
      for (const slot of SLOTS) slot.mixer?.update(delta);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      /* releaseRenderer, not dispose: three r160's dispose() drops its own caches and
         leaves the GL context to the garbage collector. See docs/performance.md. */
      releaseRenderer(renderer);
    };
  }, []);

  return (
    <div className="relative w-full min-h-[100dvh] bg-black overflow-hidden text-foreground">
      {/* Star/sky gradient behind the canvas. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top, hsl(216 60% 12%) 0%, hsl(220 50% 4%) 70%, #000 100%)",
        }}
      />

      {/* The 3D scene fills the screen and is the page's "art". */}
      <canvas
        ref={canvasRef}
        className="fixed inset-0 w-full h-full block pointer-events-none"
      />

      {/* Top bar */}
      <div className="relative z-10 flex items-center gap-3 px-4 md:px-6 pt-14 md:pt-6 pb-4 md:pb-6 flex-wrap">
        <Link
          to="/"
          className="glass-panel rounded-full px-3 py-2 flex items-center gap-2 hover:bg-muted transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-primary" />
          <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
            Back to village
          </span>
        </Link>
        <div className="glass-panel rounded-full px-3 py-2 flex items-center gap-2">
          <span className="text-[11px] font-heading font-semibold tracking-widest uppercase text-primary">
            About
          </span>
        </div>
      </div>

      {/* Narrative — a single scrolling column on the left so the 3D
          carousel on the right stays as background. On phones the
          column fills the width; the canvas just sits behind it. */}
      <div className="relative z-10 px-4 md:px-10 pb-24">
        <div className="max-w-xl flex flex-col gap-12 mt-4 md:mt-12">
          {SECTIONS.map((s) => (
            <section key={s.id} className="glass-panel rounded-2xl border border-primary/30 p-5 md:p-7">
              <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary mb-2">
                {s.eyebrow}
              </p>
              <h2 className="font-heading text-2xl md:text-3xl font-bold text-foreground leading-tight mb-3">
                {s.title}
              </h2>
              <p className="text-sm md:text-base text-foreground/85 leading-relaxed">
                {s.body}
              </p>
              {s.cta && (
                <Link
                  to={s.cta.to}
                  className="mt-4 inline-flex items-center gap-2 text-sm font-heading font-semibold text-primary hover:text-primary/80 transition-colors"
                >
                  {s.cta.label}
                </Link>
              )}
            </section>
          ))}

          <div className="grid grid-cols-3 gap-2">
            <Link
              to="/"
              className="glass-panel rounded-xl border border-primary/30 px-4 py-3 text-center hover:bg-primary/10 transition-colors"
            >
              <p className="text-2xl mb-1">🗺</p>
              <p className="text-[11px] font-heading font-semibold tracking-widest uppercase text-foreground">
                Village
              </p>
            </Link>
            <Link
              to="/space"
              className="glass-panel rounded-xl border border-primary/30 px-4 py-3 text-center hover:bg-primary/10 transition-colors"
            >
              <p className="text-2xl mb-1">🪐</p>
              <p className="text-[11px] font-heading font-semibold tracking-widest uppercase text-foreground">
                Outer space
              </p>
            </Link>
            <Link
              to="/lobby"
              className="glass-panel rounded-xl border border-primary/30 px-4 py-3 text-center hover:bg-primary/10 transition-colors"
            >
              <p className="text-2xl mb-1">🎮</p>
              <p className="text-[11px] font-heading font-semibold tracking-widest uppercase text-foreground">
                Lobby
              </p>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
