/**
 * Hub — the VibeVerse constellation lobby.
 *
 * A starfield sphere with a slowly-rotating wireframe globe at the
 * center. Every world is a glowing node placed on a larger orbital
 * sphere; the focused node also gets a textured mini-planet (its
 * screenshot wrapped onto a sphere) and a floating glass card with
 * its title + blurb + Enter button.
 *
 * Inputs (this pass — visuals first):
 *  - Click/tap a node to focus it.
 *  - Arrow keys ← / → and on-screen arrows cycle through worlds.
 *  - Drag to orbit (OrbitControls). Auto-rotates when idle.
 *  - Enter or the Enter button routes into the chosen world.
 *
 * Lives at /hub for now. The plan is to eventually promote this to
 * be the first thing users see, replacing the splash + WorldPicker.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ChevronLeft, ChevronRight, ArrowRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import cityArt from "@/assets/worlds/city.jpg";
import islandArt from "@/assets/worlds/island.jpg";
import skiArt from "@/assets/worlds/ski.jpg";
import spaceArt from "@/assets/worlds/space.jpg";
import lobbyArt from "@/assets/worlds/lobby.png";
import gardenArt from "@/assets/worlds/garden.jpg";
import museumArt from "@/assets/worlds/museum.jpg";
import evolveArt from "@/assets/worlds/evolve.jpg";
import ninjaArt from "@/assets/worlds/ninja.jpg";
import vibeArt from "@/assets/worlds/vibe.jpg";
import aboutArt from "@/assets/worlds/about.jpg";
import villageArt from "@/assets/edge-app-icon-bg.png";

interface World {
  to: string;
  emoji: string;
  name: string;
  art: string;
  blurb: string;
  color: string; // hex glow color
}

const WORLDS: World[] = [
  { to: "/space", emoji: "🌌", name: "Space", art: spaceArt, color: "#7dd3fc",
    blurb: "Vibey 2.0's late-night show on a floating asteroid." },
  { to: "/evolve", emoji: "🧬", name: "Evolve", art: evolveArt, color: "#a3e635",
    blurb: "Play a creature, eat, mutate, survive the apex." },
  { to: "/garden", emoji: "🌱", name: "Garden", art: gardenArt, color: "#86efac",
    blurb: "Vibey's memory garden and the outdoor art fair." },
  { to: "/city", emoji: "🏙️", name: "Vibe City", art: cityArt, color: "#f0abfc",
    blurb: "Jetpack a neon district — multiplayer + NPCs." },
  { to: "/city?spawn=island", emoji: "🏝️", name: "Vibe Island", art: islandArt, color: "#fde68a",
    blurb: "A magically weird world in the sky — Jerry, SnackFe, zipline, Firewall." },
  { to: "/city?spawn=ski", emoji: "⛷️", name: "Powder Peak", art: skiArt, color: "#bfe6ff",
    blurb: "The ski world — real slopes, gondolas, the Vibe Lodge." },
  { to: "/", emoji: "🗺️", name: "Village", art: villageArt, color: "#5eead4",
    blurb: "The real Healdsburg map — Vibey, choppers, spawnables." },
  { to: "/lobby", emoji: "🏎️", name: "Lobby", art: lobbyArt, color: "#fca5a5",
    blurb: "Pick your character and vehicle, Mario-Kart style." },
  { to: "/museum", emoji: "🖼️", name: "Museum", art: museumArt, color: "#fbcfe8",
    blurb: "A walkable, Seuss-flavored gallery of famous fractals." },
  { to: "/ninja", emoji: "🍉", name: "Fruit Ninja", art: ninjaArt, color: "#fda4af",
    blurb: "Slice fruit in VR (or mouse) — chase the high score." },
  { to: "/coin", emoji: "🪙", name: "VIBE", art: vibeArt, color: "#fcd34d",
    blurb: "$VIBE — community currency, holders, and market." },
  { to: "/about", emoji: "✨", name: "About", art: aboutArt, color: "#c4b5fd",
    blurb: "What this is and how it's stitched together." },
];

// Fibonacci-sphere distribution so the constellation feels even
// regardless of how many worlds we add later.
function fibonacciSphere(count: number, radius: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const phi = Math.PI * (Math.sqrt(5) - 1);
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2; // 1 -> -1
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    out.push(new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).multiplyScalar(radius));
  }
  return out;
}

export default function Hub() {
  const navigate = useNavigate();
  const mountRef = useRef<HTMLDivElement>(null);
  const [focusedIdx, setFocusedIdx] = useState(0);
  const focusedRef = useRef(0);

  // Imperative handles the canvas loop reads each frame.
  const positionsRef = useRef<THREE.Vector3[]>([]);
  const nodeGroupRef = useRef<THREE.Group | null>(null);
  const planetRef = useRef<THREE.Mesh | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  useEffect(() => {
    focusedRef.current = focusedIdx;
  }, [focusedIdx]);

  // ---------- Three.js scene ----------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05070d, 0.015);

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.1, 1000);
    camera.position.set(0, 4, 22);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor(0x05070d, 1);
    mount.appendChild(renderer.domElement);

    // Starfield — additive points sphere.
    const starGeom = new THREE.BufferGeometry();
    const STAR_COUNT = 2500;
    const starPos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const r = 80 + Math.random() * 120;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPos[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPos[i * 3 + 2] = r * Math.cos(phi);
    }
    starGeom.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(
      starGeom,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.6, sizeAttenuation: true, transparent: true, opacity: 0.85 }),
    );
    scene.add(stars);

    // Central wireframe globe — the "VibeVerse core".
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.4, 2),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, wireframe: true, transparent: true, opacity: 0.35 }),
    );
    scene.add(core);
    const coreGlow = new THREE.Mesh(
      new THREE.SphereGeometry(2.6, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.08 }),
    );
    scene.add(coreGlow);

    // World nodes on an orbital sphere.
    const ORBIT_R = 9;
    const positions = fibonacciSphere(WORLDS.length, ORBIT_R);
    positionsRef.current = positions;

    const nodeGroup = new THREE.Group();
    nodeGroupRef.current = nodeGroup;
    scene.add(nodeGroup);

    const loader = new THREE.TextureLoader();
    WORLDS.forEach((w, i) => {
      const color = new THREE.Color(w.color);
      // Outer glow halo.
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.85, 24, 24),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18 }),
      );
      // Solid node — textured with the world screenshot so it already
      // reads as "that world" before you focus it.
      const tex = loader.load(w.art);
      tex.colorSpace = THREE.SRGBColorSpace;
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 32, 32),
        new THREE.MeshBasicMaterial({ map: tex }),
      );
      const wrap = new THREE.Group();
      wrap.position.copy(positions[i]);
      wrap.add(node);
      wrap.add(halo);
      wrap.userData = { index: i, halo, node };
      nodeGroup.add(wrap);
    });

    // Big "focused planet" — same screenshot wrapped on a bigger sphere
    // that floats in front of the camera between the core and the node.
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(1.6, 48, 48),
      new THREE.MeshBasicMaterial({ map: loader.load(WORLDS[0].art) }),
    );
    (planet.material as THREE.MeshBasicMaterial).map!.colorSpace = THREE.SRGBColorSpace;
    planet.position.set(0, 0, 0);
    planetRef.current = planet;
    scene.add(planet);
    const planetRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.1, 0.04, 16, 96),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.6 }),
    );
    planetRing.rotation.x = Math.PI / 2.3;
    planet.add(planetRing);

    // Lighting (the materials are MeshBasic so this is mostly a no-op,
    // but keeping a hemisphere light here so if we swap to standard
    // materials later it still looks alive).
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    // Controls — orbit only, no zoom-to-pan, gentle auto-rotate.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 12;
    controls.maxDistance = 30;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.4;
    controlsRef.current = controls;

    // Raycasting for clicks.
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onPointerDown = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(nodeGroup.children, true);
      if (hits.length) {
        let obj: THREE.Object3D | null = hits[0].object;
        while (obj && obj.userData?.index === undefined) obj = obj.parent;
        if (obj && typeof obj.userData.index === "number") {
          setFocusedIdx(obj.userData.index);
        }
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    // Animation loop.
    let raf = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      const dt = clock.getDelta();
      const t = clock.elapsedTime;

      core.rotation.y += dt * 0.15;
      core.rotation.x += dt * 0.05;
      coreGlow.scale.setScalar(1 + Math.sin(t * 1.4) * 0.03);

      // Nodes gently bob + face the camera-ish (billboards stay readable).
      nodeGroup.children.forEach((wrap, i) => {
        const base = positions[i];
        const bob = Math.sin(t * 0.8 + i * 1.3) * 0.12;
        wrap.position.set(base.x, base.y + bob, base.z);
        const isFocused = i === focusedRef.current;
        const target = isFocused ? 1.5 : 1.0;
        wrap.scale.lerp(new THREE.Vector3(target, target, target), 0.08);
        const halo = wrap.userData.halo as THREE.Mesh;
        const mat = halo.material as THREE.MeshBasicMaterial;
        mat.opacity = isFocused ? 0.45 + Math.sin(t * 3) * 0.1 : 0.18;
      });

      // Focused planet drifts between camera and focused node.
      const focusedPos = positions[focusedRef.current];
      const cameraPos = camera.position;
      const between = focusedPos.clone().lerp(cameraPos, 0.55);
      planet.position.lerp(between, 0.06);
      planet.rotation.y += dt * 0.25;
      planet.lookAt(0, 0, 0); // belt stays facing core
      planet.rotation.y += t * 0.0; // keep above lookAt influence

      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    const onResize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // Swap focused planet's texture when focus changes.
  useEffect(() => {
    const planet = planetRef.current;
    if (!planet) return;
    const tex = new THREE.TextureLoader().load(WORLDS[focusedIdx].art);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = planet.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.map = tex;
    mat.needsUpdate = true;
  }, [focusedIdx]);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setFocusedIdx((i) => (i + 1) % WORLDS.length);
      else if (e.key === "ArrowLeft") setFocusedIdx((i) => (i - 1 + WORLDS.length) % WORLDS.length);
      else if (e.key === "Enter") navigate(WORLDS[focusedRef.current].to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const focused = WORLDS[focusedIdx];

  return (
    <div className="fixed inset-0 bg-background overflow-hidden">
      <div ref={mountRef} className="absolute inset-0" />

      {/* Vignette */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-radial from-transparent via-transparent to-background/80" />

      {/* Header */}
      <div className="absolute top-16 sm:top-20 left-1/2 -translate-x-1/2 text-center px-4 z-10 pointer-events-none">
        <p className="text-[10px] sm:text-xs tracking-[0.4em] uppercase text-primary/80">
          VibeVerse
        </p>
        <h1 className="font-heading text-2xl sm:text-4xl font-bold text-gradient-mint mt-1">
          Choose your world
        </h1>
        <p className="text-[10px] sm:text-xs text-muted-foreground mt-1.5">
          Tap a planet · ← → to cycle · Enter to travel
        </p>
      </div>

      {/* Side arrows */}
      <button
        onClick={() => setFocusedIdx((i) => (i - 1 + WORLDS.length) % WORLDS.length)}
        className="absolute left-3 sm:left-6 top-1/2 -translate-y-1/2 z-20 glass-panel rounded-full p-3 hover:bg-primary/10 transition-colors"
        aria-label="Previous world"
      >
        <ChevronLeft className="w-5 h-5" />
      </button>
      <button
        onClick={() => setFocusedIdx((i) => (i + 1) % WORLDS.length)}
        className="absolute right-3 sm:right-6 top-1/2 -translate-y-1/2 z-20 glass-panel rounded-full p-3 hover:bg-primary/10 transition-colors"
        aria-label="Next world"
      >
        <ChevronRight className="w-5 h-5" />
      </button>

      {/* Floating card */}
      <div className="absolute bottom-6 sm:bottom-10 left-1/2 -translate-x-1/2 z-10 w-[min(92vw,28rem)]">
        <AnimatePresence mode="wait">
          <motion.div
            key={focused.to}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.28 }}
            className="glass-panel rounded-2xl border border-border/50 p-4 sm:p-5 shadow-[0_0_40px_-10px_hsl(var(--primary)/0.4)]"
            style={{ boxShadow: `0 0 40px -10px ${focused.color}55` }}
          >
            <div className="flex items-center gap-3">
              <div className="text-3xl">{focused.emoji}</div>
              <div className="flex-1 min-w-0">
                <div className="font-heading text-base sm:text-lg font-bold leading-tight">
                  {focused.name}
                </div>
                <div className="text-[11px] sm:text-xs text-muted-foreground mt-0.5 truncate">
                  {focused.blurb}
                </div>
              </div>
              <button
                onClick={() => navigate(focused.to)}
                className="flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground font-heading font-semibold text-xs uppercase tracking-wider px-3.5 py-2 hover:opacity-90 transition-opacity"
              >
                Enter
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Dot pager */}
            <div className="mt-3 flex items-center justify-center gap-1.5 flex-wrap">
              {WORLDS.map((w, i) => (
                <button
                  key={w.to}
                  onClick={() => setFocusedIdx(i)}
                  className={`h-1.5 rounded-full transition-all ${
                    i === focusedIdx
                      ? "w-6 bg-primary"
                      : "w-1.5 bg-foreground/25 hover:bg-foreground/50"
                  }`}
                  aria-label={`Focus ${w.name}`}
                />
              ))}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
