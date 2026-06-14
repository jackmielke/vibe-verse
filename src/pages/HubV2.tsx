/**
 * HubV2 — VibeVerse orbital lobby.
 *
 * Visually cloned from /space (Unit7Playground): same multi-layer
 * starfield, same neon key/rim/fill lighting, same UnrealBloom pass,
 * and Vibey himself standing on a floating asteroid platform.
 *
 * The "show" content is replaced with an orbital ring of worlds.
 * Vibey watches the active world (looks at it and Waves when it
 * changes) and the user selects with drag / A/D / arrows / clicks.
 *
 * Lives at /hub-v2 so the original /hub stays available to compare.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight } from "lucide-react";

import unit7ModelUrl from "@/assets/glb/robot-expressive.glb";
import floatingIslandUrl from "@/assets/glb/floating-island.glb";

import cityArt from "@/assets/worlds/city.jpg";
import islandArt from "@/assets/worlds/island.jpg";
import spaceArt from "@/assets/worlds/space.jpg";
import lobbyArt from "@/assets/worlds/lobby.png";
import gardenArt from "@/assets/worlds/garden.jpg";
import museumArt from "@/assets/worlds/museum.jpg";
import evolveArt from "@/assets/worlds/evolve.jpg";
import ninjaArt from "@/assets/worlds/ninja.jpg";
import vibeArt from "@/assets/worlds/vibe.jpg";
import aboutArt from "@/assets/worlds/about.jpg";
import villageArt from "@/assets/edge-app-icon-bg.png";

type Category = "Social" | "Relax" | "Explore" | "Adventure" | "Creative";
interface World {
  to: string;
  name: string;
  blurb: string;
  art: string;
  color: string;
  cats: Category[];
}

const WORLDS: World[] = [
  { to: "/city?spawn=island", name: "Cardboard Island", art: islandArt, color: "#fde68a",
    blurb: "A handcrafted papercraft realm full of surprises.", cats: ["Creative", "Social"] },
  { to: "/space", name: "Space Outpost", art: spaceArt, color: "#7dd3fc",
    blurb: "Vibey 2.0's late-night show on a floating asteroid.", cats: ["Relax", "Creative"] },
  { to: "/city", name: "Vibe City", art: cityArt, color: "#f0abfc",
    blurb: "Jetpack a neon district — multiplayer + NPCs.", cats: ["Adventure", "Social"] },
  { to: "/evolve", name: "Genesis Bloom", art: evolveArt, color: "#a3e635",
    blurb: "Play a creature, eat, mutate, survive the apex.", cats: ["Adventure"] },
  { to: "/garden", name: "Memory Garden", art: gardenArt, color: "#86efac",
    blurb: "Vibey's memory garden and the outdoor art fair.", cats: ["Relax", "Creative"] },
  { to: "/museum", name: "Fractal Museum", art: museumArt, color: "#fbcfe8",
    blurb: "A walkable, Seuss-flavored gallery of famous fractals.", cats: ["Relax", "Explore"] },
  { to: "/lobby", name: "Lobby", art: lobbyArt, color: "#fca5a5",
    blurb: "Pick your character and vehicle, Mario-Kart style.", cats: ["Social"] },
  { to: "/ninja", name: "Fruit Ninja", art: ninjaArt, color: "#fda4af",
    blurb: "Slice fruit in VR (or mouse) — chase the high score.", cats: ["Adventure"] },
  { to: "/vibe", name: "VIBE Hub", art: vibeArt, color: "#fcd34d",
    blurb: "$VIBE — community currency, holders, and market.", cats: ["Social"] },
  { to: "/", name: "Healdsburg Village", art: villageArt, color: "#5eead4",
    blurb: "The real-world map — Vibey, choppers, spawnables.", cats: ["Explore", "Social"] },
  { to: "/about", name: "About", art: aboutArt, color: "#c4b5fd",
    blurb: "What this is and how it's stitched together.", cats: ["Explore"] },
];

const ALL_CATS: ("All" | Category)[] = ["All", "Social", "Relax", "Explore", "Adventure", "Creative"];

export default function HubV2() {
  const navigate = useNavigate();
  const mountRef = useRef<HTMLDivElement>(null);

  // Orbit angle (radians). Smoothly chases targetAngle which snaps to slots.
  const angleRef = useRef(0);
  const targetAngleRef = useRef(0);
  const draggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartAngleRef = useRef(0);

  const [activeFilter, setActiveFilter] = useState<"All" | Category>("All");
  const filtered = activeFilter === "All" ? WORLDS : WORLDS.filter((w) => w.cats.includes(activeFilter));
  const [focusedIdx, setFocusedIdx] = useState(0);
  // Reset focus when filter changes.
  useEffect(() => {
    setFocusedIdx(0);
    targetAngleRef.current = 0;
  }, [activeFilter]);

  const focusedRef = useRef(0);
  useEffect(() => { focusedRef.current = focusedIdx; }, [focusedIdx]);

  const filteredRef = useRef(filtered);
  useEffect(() => { filteredRef.current = filtered; }, [filtered]);

  // Imperative refs the scene reads.
  const vibeyRef = useRef<THREE.Group | null>(null);
  const vibeyMixerRef = useRef<THREE.AnimationMixer | null>(null);
  const vibeyActionsRef = useRef<Map<string, THREE.AnimationAction>>(new Map());
  const planetsRef = useRef<{ group: THREE.Group; mesh: THREE.Mesh; halo: THREE.Mesh; centerIsland?: THREE.Group }[]>([]);
  const orbitGroupRef = useRef<THREE.Group | null>(null);

  // ----------- Selection: cycle worlds -----------
  const cycle = (dir: number) => {
    const n = filteredRef.current.length;
    if (!n) return;
    setFocusedIdx((i) => (i + dir + n) % n);
    targetAngleRef.current -= dir * ((Math.PI * 2) / n);
    // Trigger Vibey wave.
    const actions = vibeyActionsRef.current;
    const wave = actions.get("Wave");
    if (wave) {
      wave.reset();
      wave.setLoop(THREE.LoopOnce, 1);
      wave.clampWhenFinished = true;
      wave.fadeIn(0.15).play();
    }
  };

  // ----------- Three.js scene (mount once) -----------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05060f, 0.012);

    // PBR environment so PBR materials still read nicely.
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor(0x05060f, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    mount.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.1, 500);
    // Camera distance is driven by a ref so pinch/wheel zoom can move it.
    const camDistRef = { current: 18 };
    const camDistTargetRef = { current: 18 };
    const CAM_MIN = 9, CAM_MAX = 30;
    camera.position.set(0, 6.5, camDistRef.current);
    camera.lookAt(0, 1.2, 0);

    // ---------- Multi-layer starfield (cloned vibe) ----------
    const makeStars = (count: number, rMin: number, rMax: number, size: number, color: number, opacity: number) => {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const r = rMin + Math.random() * (rMax - rMin);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        pos[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
        pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        pos[i * 3 + 2] = r * Math.cos(phi);
      }
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        color, size, sizeAttenuation: true, transparent: true, opacity,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const pts = new THREE.Points(geo, mat);
      scene.add(pts);
      return pts;
    };
    makeStars(1800, 80, 200, 0.45, 0xffffff, 0.7);
    makeStars(700, 40, 90, 0.3, 0x9ad8ff, 0.45);
    const sparkles = makeStars(220, 18, 40, 0.4, 0x73ffb8, 0.55);

    // ---------- Lighting (matches /space palette, dialed down) ----------
    scene.add(new THREE.AmbientLight(0x4a5fa8, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(8, 14, 6);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x73ffb8, 0.45);
    rim.position.set(-6, 4, -8);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xff7eb3, 0.25);
    fill.position.set(4, -3, 6);
    scene.add(fill);

    // ---------- Asteroid platform Vibey stands on ----------
    const platform = new THREE.Group();
    const platTop = new THREE.Mesh(
      new THREE.CylinderGeometry(2.6, 2.4, 0.5, 48),
      new THREE.MeshStandardMaterial({ color: 0x1a2233, roughness: 0.85, metalness: 0.15, emissive: 0x0a1428, emissiveIntensity: 0.4 }),
    );
    platform.add(platTop);
    const platSpire = new THREE.Mesh(
      new THREE.ConeGeometry(2.4, 4, 24, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x10182a, roughness: 1, metalness: 0 }),
    );
    platSpire.position.y = -2.2;
    platform.add(platSpire);
    // Neon rim ring around the platform edge (subtle, not bloom-fuel).
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.55, 0.025, 12, 96),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.45 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.26;
    platform.add(ring);
    platform.position.y = -0.5;
    scene.add(platform);

    // ---------- Orbit group (worlds rotate around Y here) ----------
    const orbit = new THREE.Group();
    scene.add(orbit);
    orbitGroupRef.current = orbit;

    // Faint orbit ellipse hint (a flat ring on the orbital plane).
    const orbitRing = new THREE.Mesh(
      new THREE.RingGeometry(7.95, 8.03, 128),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.08, side: THREE.DoubleSide }),
    );
    orbitRing.rotation.x = -Math.PI / 2;
    orbitRing.position.y = 1.5;
    scene.add(orbitRing);

    // Build planet slots — we'll re-layout when the filter changes.
    // Each slot is a textured sphere + halo, lazy-allocated in layoutPlanets.
    const loader = new THREE.TextureLoader();
    const planetSlots: { group: THREE.Group; mesh: THREE.Mesh; halo: THREE.Mesh; centerIsland?: THREE.Group }[] = [];
    const ORBIT_R = 8;
    const ORBIT_Y = 1.5;

    const layoutPlanets = (list: World[]) => {
      // Remove existing.
      for (const p of planetSlots) {
        orbit.remove(p.group);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.MeshStandardMaterial).map?.dispose();
        (p.mesh.material as THREE.MeshStandardMaterial).dispose();
      }
      planetSlots.length = 0;

      list.forEach((w, i) => {
        const angle = (i / list.length) * Math.PI * 2;
        const wrap = new THREE.Group();
        wrap.position.set(Math.cos(angle) * ORBIT_R, ORBIT_Y, Math.sin(angle) * ORBIT_R);
        const tex = loader.load(w.art);
        tex.colorSpace = THREE.SRGBColorSpace;
        const planet = new THREE.Mesh(
          new THREE.SphereGeometry(0.85, 48, 48),
          new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.05 }),
        );
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(1.05, 24, 24),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(w.color), transparent: true, opacity: 0.05, depthWrite: false }),
        );
        wrap.add(planet);
        wrap.add(halo);
        wrap.userData = { index: i };
        orbit.add(wrap);
        planetSlots.push({ group: wrap, mesh: planet, halo });
      });
      planetsRef.current = planetSlots;
    };
    layoutPlanets(filteredRef.current);

    // ---------- Center island (focused world's "hero" model) ----------
    // We load the floating-island glb once and re-skin it per focused world
    // (subtle emissive tint) so the active slot reads as the mockup's big
    // central island.
    const centerSlot = new THREE.Group();
    centerSlot.position.set(0, ORBIT_Y, 0);
    scene.add(centerSlot);
    let centerIsland: THREE.Group | null = null;
    new GLTFLoader().load(floatingIslandUrl, (gltf) => {
      centerIsland = gltf.scene;
      // Strip emissive/over-bright materials so the island doesn't blow out under bloom.
      centerIsland.traverse((o: THREE.Object3D) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const std = mat as THREE.MeshStandardMaterial;
          if (std.emissive) { std.emissive.setScalar(0); std.emissiveIntensity = 0; }
          if (typeof std.roughness === "number") std.roughness = Math.max(0.6, std.roughness);
          if (typeof std.metalness === "number") std.metalness = Math.min(0.15, std.metalness);
        }
      });
      // Normalize size.
      const box = new THREE.Box3().setFromObject(centerIsland);
      const size = new THREE.Vector3();
      box.getSize(size);
      const targetSize = 2.6;
      const s = targetSize / Math.max(size.x, size.y, size.z);
      centerIsland.scale.setScalar(s);
      centerIsland.position.y = -0.4;
      centerSlot.add(centerIsland);
    }, undefined, () => {
      // GLB failed — fall back to a textured sphere so the scene still reads.
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(1.2, 48, 48),
        new THREE.MeshStandardMaterial({ color: 0x4ade80, roughness: 0.7, metalness: 0.1 }),
      );
      centerSlot.add(sphere);
      centerIsland = sphere as unknown as THREE.Group;
    });

    // ---------- Vibey (Unit7 robot) ----------
    new GLTFLoader().load(unit7ModelUrl, (gltf) => {
      const v = gltf.scene;
      v.scale.setScalar(0.9);
      v.position.set(0, -0.25, 1.3);
      v.rotation.y = 0;
      platform.add(v);
      vibeyRef.current = v;

      const mixer = new THREE.AnimationMixer(v);
      vibeyMixerRef.current = mixer;
      const actions = vibeyActionsRef.current;
      for (const clip of gltf.animations) {
        actions.set(clip.name, mixer.clipAction(clip));
      }
      const idle = actions.get("Idle");
      if (idle) idle.play();
    });

    // ---------- Bloom postprocessing (dialed way down) ----------
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // strength, radius, threshold — only the brightest pixels (rim + stars) bloom.
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(mount.clientWidth, mount.clientHeight),
      0.32, 0.45, 0.82,
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // ---------- Pointer interactions ----------
    const ndc = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const onPointerDown = (ev: PointerEvent) => {
      draggingRef.current = true;
      dragStartXRef.current = ev.clientX;
      dragStartAngleRef.current = targetAngleRef.current;
      (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    };
    const onPointerMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = ev.clientX - dragStartXRef.current;
      targetAngleRef.current = dragStartAngleRef.current + dx * 0.005;
    };
    const onPointerUp = (ev: PointerEvent) => {
      const wasDragging = draggingRef.current;
      draggingRef.current = false;
      const dx = ev.clientX - dragStartXRef.current;
      // Snap to nearest slot.
      const n = filteredRef.current.length || 1;
      const step = (Math.PI * 2) / n;
      const snapped = Math.round(targetAngleRef.current / step) * step;
      targetAngleRef.current = snapped;
      const newIdx = ((Math.round(-snapped / step) % n) + n) % n;
      if (newIdx !== focusedRef.current) {
        setFocusedIdx(newIdx);
        const wave = vibeyActionsRef.current.get("Wave");
        if (wave) {
          wave.reset(); wave.setLoop(THREE.LoopOnce, 1); wave.clampWhenFinished = true;
          wave.fadeIn(0.15).play();
        }
      }
      // Click-through: if barely moved, treat as a tap on a planet.
      if (Math.abs(dx) < 4 && wasDragging) {
        const rect = renderer.domElement.getBoundingClientRect();
        ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(orbit.children, true);
        if (hits.length) {
          let obj: THREE.Object3D | null = hits[0].object;
          while (obj && obj.userData?.index === undefined) obj = obj.parent;
          if (obj && typeof obj.userData.index === "number") {
            const targetIdx = obj.userData.index as number;
            const delta = ((targetIdx - focusedRef.current + n + Math.floor(n / 2)) % n) - Math.floor(n / 2);
            if (delta !== 0) {
              setFocusedIdx(targetIdx);
              targetAngleRef.current -= delta * step;
            }
          }
        }
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    // ---------- Animation loop ----------
    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      const dt = clock.getDelta();
      const t = clock.elapsedTime;

      // Smooth orbit rotation toward target.
      angleRef.current += (targetAngleRef.current - angleRef.current) * Math.min(1, dt * 5);
      orbit.rotation.y = angleRef.current;

      // Per-planet bob + active scaling.
      const focusedI = focusedRef.current;
      planetSlots.forEach((p, i) => {
        const isActive = i === focusedI;
        const bob = Math.sin(t * 0.9 + i * 1.2) * 0.08;
        p.group.position.y = ORBIT_Y + bob;
        p.mesh.rotation.y += dt * 0.4;
        const targetScale = isActive ? 0 : 1; // hide the planet at the focused slot — center island takes its place
        p.group.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.12);
        const halo = p.halo.material as THREE.MeshBasicMaterial;
        halo.opacity = 0.18;
      });

      // Center island spins slowly and bobs.
      if (centerSlot) {
        centerSlot.position.y = ORBIT_Y + Math.sin(t * 0.6) * 0.18;
        centerSlot.rotation.y += dt * 0.25;
      }

      // Sparkles drift.
      sparkles.rotation.y += dt * 0.02;

      // Vibey looks at the center island and breathes.
      const vibey = vibeyRef.current;
      if (vibey) {
        const tgt = new THREE.Vector3(0, ORBIT_Y, 0);
        const localTgt = vibey.parent!.worldToLocal(tgt.clone());
        const desiredY = Math.atan2(localTgt.x - vibey.position.x, localTgt.z - vibey.position.z);
        vibey.rotation.y += (desiredY - vibey.rotation.y) * Math.min(1, dt * 4);
        vibey.position.y = -0.25 + Math.sin(t * 1.4) * 0.03;
      }
      vibeyMixerRef.current?.update(dt);

      // Subtle camera parallax.
      camera.position.x = Math.sin(t * 0.15) * 0.4;
      camera.lookAt(0, 1.6, 0);

      composer.render();
      raf = requestAnimationFrame(tick);
    };
    tick();

    // ---------- Resize ----------
    const onResize = () => {
      if (!mount) return;
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      composer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    // Expose layoutPlanets so the filter-change effect can call it.
    (orbit as any).__layoutPlanets = layoutPlanets;

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      composer.dispose();
      renderer.dispose();
      pmrem.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, []);

  // When the filter changes, rebuild planet slots in the scene.
  useEffect(() => {
    const orbit = orbitGroupRef.current as (THREE.Group & { __layoutPlanets?: (list: World[]) => void }) | null;
    orbit?.__layoutPlanets?.(filtered);
    // Reset orbit rotation target to slot 0.
    targetAngleRef.current = 0;
  }, [activeFilter]);

  // Keyboard nav.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") cycle(1);
      else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") cycle(-1);
      else if (e.key === "Enter") {
        const list = filteredRef.current;
        if (list[focusedRef.current]) navigate(list[focusedRef.current].to);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const focused = filtered[focusedIdx] ?? WORLDS[0];

  return (
    <div className="fixed inset-0 bg-background overflow-hidden select-none">
      <div ref={mountRef} className="absolute inset-0 touch-none cursor-grab active:cursor-grabbing" />

      {/* Vignette */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-radial from-transparent via-transparent to-background/85" />

      {/* Top bar: brand + online */}
      <div className="absolute top-3 left-4 right-4 z-10 flex items-center justify-between pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-primary shadow-[0_0_10px_hsl(var(--primary))]" />
          <span className="font-heading font-bold tracking-[0.25em] text-xs sm:text-sm">VIBE VERSE</span>
        </div>
        <div className="glass-panel rounded-full px-3 py-1 text-[10px] sm:text-xs flex items-center gap-1.5 pointer-events-auto">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          344 online
        </div>
      </div>

      {/* Category filters */}
      <div className="absolute top-14 sm:top-16 left-1/2 -translate-x-1/2 z-10 flex flex-wrap items-center justify-center gap-1.5 px-3 max-w-[95vw]">
        {ALL_CATS.map((c) => {
          const active = activeFilter === c;
          return (
            <button
              key={c}
              onClick={() => setActiveFilter(c)}
              className={`rounded-full text-[10px] sm:text-xs font-heading font-semibold tracking-wider uppercase px-3 py-1.5 transition-all ${
                active
                  ? "bg-primary text-primary-foreground shadow-[0_0_18px_hsl(var(--primary)/0.6)]"
                  : "bg-background/40 backdrop-blur-md border border-border/40 text-foreground/75 hover:text-foreground hover:border-primary/40"
              }`}
            >
              {c === "All" ? "All Worlds" : c}
            </button>
          );
        })}
      </div>

      {/* Focused world title block */}
      <div className="absolute top-28 sm:top-32 left-1/2 -translate-x-1/2 z-10 text-center px-4 pointer-events-none w-[min(95vw,42rem)]">
        <AnimatePresence mode="wait">
          <motion.div
            key={focused?.to}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.28 }}
          >
            <h1 className="font-heading text-3xl sm:text-5xl font-bold tracking-tight text-foreground drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)]">
              {focused?.name}
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground mt-2">
              {focused?.blurb}
            </p>
            <div className="mt-3 flex items-center justify-center gap-1.5 flex-wrap">
              {focused?.cats.map((c) => (
                <span
                  key={c}
                  className="rounded-full text-[10px] font-heading font-semibold tracking-wider uppercase px-2.5 py-1 bg-background/40 backdrop-blur-md border border-border/40 text-foreground/80"
                >
                  {c}
                </span>
              ))}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Bottom controls */}
      <div className="absolute bottom-6 sm:bottom-10 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-3 pointer-events-none w-full px-4">
        <button
          onClick={() => focused && navigate(focused.to)}
          className="pointer-events-auto group flex items-center gap-2 rounded-full bg-primary text-primary-foreground font-heading font-bold text-sm sm:text-base px-6 sm:px-8 py-3 shadow-[0_0_30px_hsl(var(--primary)/0.5)] hover:shadow-[0_0_40px_hsl(var(--primary)/0.8)] hover:scale-[1.03] transition-all"
        >
          Enter {focused?.name}
          <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
        </button>
        <div className="flex items-center gap-1.5 text-[10px] sm:text-xs text-muted-foreground">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
          {Math.floor(20 + (focusedIdx * 7) % 80)} online now
        </div>
        <div className="flex items-center gap-2 text-[10px] sm:text-xs text-muted-foreground">
          Drag or use
          <kbd className="rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 font-mono text-[10px]">A</kbd>
          <kbd className="rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 font-mono text-[10px]">D</kbd>
          to explore
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          {filtered.map((w, i) => (
            <button
              key={w.to}
              onClick={() => {
                const delta = i - focusedIdx;
                if (!delta) return;
                setFocusedIdx(i);
                const n = filtered.length;
                const step = (Math.PI * 2) / n;
                targetAngleRef.current -= delta * step;
              }}
              className={`pointer-events-auto h-1.5 rounded-full transition-all ${
                i === focusedIdx ? "w-6 bg-primary" : "w-1.5 bg-foreground/25 hover:bg-foreground/50"
              }`}
              aria-label={`Focus ${w.name}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
