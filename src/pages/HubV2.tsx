/**
 * HubV2 — VibeVerse lobby (row layout).
 *
 * Cloned visual stack from /space: multi-layer starfield, neon
 * key/rim/fill lighting, ACES tone mapping, gentle UnrealBloom.
 * Vibey stands on the asteroid platform and watches the active world.
 *
 * Layout is a horizontal "carousel row" rather than an orbit ring:
 *   - Worlds line up along the X axis at fixed spacing.
 *   - The focused world is centered in front of Vibey, scaled up.
 *   - Drag left/right (or A/D, ←/→) shuffles the row.
 *
 * One world (Cardboard Island) renders as the floating-island.glb
 * instead of a textured sphere, so the island that used to "just
 * float there randomly" is now an actual selectable destination.
 *
 * No category filters here — the WorldPicker handles deeper browsing.
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
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";

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

interface World {
  to: string;
  name: string;
  blurb: string;
  art: string;
  color: string;
  /** If set, render this world's hero slot as a 3D model instead of a sphere. */
  model?: "floating-island";
}

const WORLDS: World[] = [
  { to: "/city?spawn=island", name: "Cardboard Island", art: islandArt, color: "#fde68a",
    blurb: "A handcrafted papercraft realm floating in the sky.", model: "floating-island" },
  { to: "/space", name: "Space Outpost", art: spaceArt, color: "#7dd3fc",
    blurb: "Vibey 2.0's late-night show on a floating asteroid." },
  { to: "/city", name: "Vibe City", art: cityArt, color: "#f0abfc",
    blurb: "Jetpack a neon district — multiplayer + NPCs." },
  { to: "/evolve", name: "Genesis Bloom", art: evolveArt, color: "#a3e635",
    blurb: "Play a creature, eat, mutate, survive the apex." },
  { to: "/garden", name: "Memory Garden", art: gardenArt, color: "#86efac",
    blurb: "Vibey's memory garden and the outdoor art fair." },
  { to: "/museum", name: "Fractal Museum", art: museumArt, color: "#fbcfe8",
    blurb: "A walkable, Seuss-flavored gallery of famous fractals." },
  { to: "/lobby", name: "Lobby", art: lobbyArt, color: "#fca5a5",
    blurb: "Pick your character and vehicle, Mario-Kart style." },
  { to: "/ninja", name: "Fruit Ninja", art: ninjaArt, color: "#fda4af",
    blurb: "Slice fruit in VR (or mouse) — chase the high score." },
  { to: "/vibe", name: "VIBE Hub", art: vibeArt, color: "#fcd34d",
    blurb: "$VIBE — community currency, holders, and market." },
  { to: "/", name: "Healdsburg Village", art: villageArt, color: "#5eead4",
    blurb: "The real-world map — Vibey, choppers, spawnables." },
  { to: "/about", name: "About", art: aboutArt, color: "#c4b5fd",
    blurb: "What this is and how it's stitched together." },
];

// Horizontal spacing between adjacent worlds along the row.
const SLOT_SPACING = 5.2;
// Worlds float high above Vibey's head (he stands at y≈0) so the
// focused world reads as a body up in the sky, well clear of him.
const ROW_Y = 4.2;
// Push the worlds row back from Vibey (who sits near z≈3.7) so the
// focused world reads as a body floating in the distance, not stuck
// to his face.
const ROW_Z = -2.5;

export default function HubV2() {
  const navigate = useNavigate();
  const mountRef = useRef<HTMLDivElement>(null);

  // Row offset (world units). Smoothly chases targetOffset which snaps to slots.
  const offsetRef = useRef(0);
  const targetOffsetRef = useRef(0);
  const draggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartOffsetRef = useRef(0);

  const [focusedIdx, setFocusedIdx] = useState(0);
  const focusedRef = useRef(0);
  useEffect(() => { focusedRef.current = focusedIdx; }, [focusedIdx]);

  // Imperative refs the scene reads.
  const vibeyRef = useRef<THREE.Group | null>(null);
  const vibeyMixerRef = useRef<THREE.AnimationMixer | null>(null);
  const vibeyActionsRef = useRef<Map<string, THREE.AnimationAction>>(new Map());
  // Intro plays once Vibey has actually loaded. `introElapsedRef` runs the
  // sequence: face-hold (wave) → 180° orbit-around-Vibey → zoom out to base.
  const introStartedRef = useRef(false);
  const introElapsedRef = useRef(0);

  const cycle = (dir: number) => {
    const n = WORLDS.length;
    setFocusedIdx((i) => (i + dir + n) % n);
    targetOffsetRef.current -= dir * SLOT_SPACING;
    const wave = vibeyActionsRef.current.get("Wave");
    if (wave) {
      wave.reset();
      wave.setLoop(THREE.LoopOnce, 1);
      wave.clampWhenFinished = true;
      wave.fadeIn(0.15).play();
    }
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05060f, 0.014);

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
    // Resting camera distance *behind* Vibey. Big + high so you see the
    // whole tableau — Vibey on his platform in the foreground, the
    // focused world floating out beyond him.
    const camDistRef = { current: 17 };
    const camDistTargetRef = { current: 17 };
    const CAM_MIN = 11, CAM_MAX = 46;
    camera.position.set(0, 7, 21);
    camera.lookAt(0, ROW_Y - 1.3, ROW_Z);

    // Vibey's framing metrics. Fixed (not measured) because his
    // placement is fully controlled below — platform at z=5, Vibey at
    // local z=-1.3 → world z≈3.7, ~1.6 tall standing on the disc. (A
    // Box3 on the skinned model returns garbage bounds, so we don't.)
    const vibeyHeadY = 1.0;
    const vibeyMidY = 0.3;
    const vibeyZ = 3.7;
    // Any touch/scroll skips straight to the resting pose so the intro
    // never feels like it's trapping the camera.
    let introSkipped = false;
    const FACE_DUR = 1.5; // wave / hero hold
    const ORBIT_DUR = 3.6; // loop around + rise + pull back
    const HERO_R = 6.2; // hero-shot distance from Vibey
    const HERO_ANGLE = 0.55; // 3/4 front angle (radians off his facing axis)

    // ---------- Multi-layer starfield ----------
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

    // ---------- Lighting ----------
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

    // ---------- Vibey's platform (faceted asteroid + neon rings) ----------
    const platform = new THREE.Group();

    // Faceted asteroid base — jittered icosahedron for a hand-chiselled
    // rock look, squashed flat so Vibey has a stage to stand on.
    const asteroidGeo = new THREE.IcosahedronGeometry(2.7, 1);
    const apos = asteroidGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < apos.count; i++) {
      const n = 0.82 + Math.random() * 0.34;
      apos.setXYZ(i, apos.getX(i) * n, apos.getY(i) * n, apos.getZ(i) * n);
    }
    asteroidGeo.computeVertexNormals();
    const asteroid = new THREE.Mesh(
      asteroidGeo,
      new THREE.MeshStandardMaterial({
        color: 0x141b2c, roughness: 0.95, metalness: 0.12,
        flatShading: true, emissive: 0x0a1430, emissiveIntensity: 0.35,
      }),
    );
    asteroid.scale.set(1, 0.62, 1);
    asteroid.position.y = -1.5;
    platform.add(asteroid);

    // Standing disc Vibey actually rests on.
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(2.45, 2.62, 0.4, 64),
      new THREE.MeshStandardMaterial({
        color: 0x1b2740, roughness: 0.55, metalness: 0.4,
        emissive: 0x123a2e, emissiveIntensity: 0.5,
      }),
    );
    platform.add(disc);

    // Soft glow pool just above the disc.
    const glowDisc = new THREE.Mesh(
      new THREE.CircleGeometry(3.6, 64),
      new THREE.MeshBasicMaterial({
        color: 0x4ade80, transparent: true, opacity: 0.1,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
    );
    glowDisc.rotation.x = -Math.PI / 2;
    glowDisc.position.y = 0.22;
    platform.add(glowDisc);

    // Bright standing ring around the disc edge (pulses in the loop).
    const standRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.6, 0.03, 12, 120),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    standRing.rotation.x = Math.PI / 2;
    standRing.position.y = 0.24;
    platform.add(standRing);

    // (Removed tilted orbital rings around the platform — felt too noisy.)

    // Drifting debris rocks circling the platform.
    const debris: THREE.Mesh[] = [];
    const rockGeo = new THREE.IcosahedronGeometry(0.17, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x28324d, roughness: 1, metalness: 0.05, flatShading: true });
    for (let i = 0; i < 9; i++) {
      const rock = new THREE.Mesh(rockGeo, rockMat);
      rock.userData = {
        ang: (i / 9) * Math.PI * 2,
        rad: 3.0 + Math.random() * 1.0,
        yb: -0.6 + Math.random() * 1.1,
        spd: 0.12 + Math.random() * 0.22,
      };
      rock.scale.setScalar(0.55 + Math.random() * 1.1);
      platform.add(rock);
      debris.push(rock);
    }

    // Vibey faces -Z toward the worlds; the resting camera sits behind
    // him (+Z) and high, so we see his back and the worlds beyond.
    platform.position.set(0, -0.5, 5);
    scene.add(platform);

    // ---------- Row of world slots ----------
    const row = new THREE.Group();
    row.position.z = ROW_Z;
    scene.add(row);

    // Pre-load the floating island GLB once so we can drop it into the
    // Cardboard Island slot.
    let islandTemplate: THREE.Group | null = null;
    new GLTFLoader().load(floatingIslandUrl, (gltf) => {
      islandTemplate = gltf.scene;
      islandTemplate.traverse((o: THREE.Object3D) => {
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
      const box = new THREE.Box3().setFromObject(islandTemplate);
      const size = new THREE.Vector3();
      box.getSize(size);
      const targetSize = 2.0;
      const s = targetSize / Math.max(size.x, size.y, size.z);
      islandTemplate.scale.setScalar(s);
      // Drop into the matching slot if it's already built.
      for (const slot of slots) {
        if (slot.world.model === "floating-island" && !slot.modelObj) {
          const inst = islandTemplate!.clone(true);
          slot.modelObj = inst;
          slot.group.remove(slot.mesh);
          slot.group.add(inst);
        }
      }
    });

    const loader = new THREE.TextureLoader();
    interface Slot {
      world: World;
      group: THREE.Group;
      mesh: THREE.Mesh; // sphere planet (used unless modelObj swaps in)
      halo: THREE.Mesh;
      modelObj?: THREE.Object3D;
    }
    const slots: Slot[] = WORLDS.map((w, i) => {
      const wrap = new THREE.Group();
      wrap.position.set(i * SLOT_SPACING, ROW_Y, 0);
      wrap.userData = { index: i };

      const tex = loader.load(w.art);
      tex.colorSpace = THREE.SRGBColorSpace;
      const planet = new THREE.Mesh(
        new THREE.SphereGeometry(0.85, 48, 48),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.05 }),
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(1.05, 24, 24),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(w.color), transparent: true, opacity: 0.06, depthWrite: false }),
      );
      wrap.add(planet);
      wrap.add(halo);
      row.add(wrap);
      return { world: w, group: wrap, mesh: planet, halo };
    });

    // ---------- Vibey ----------
    new GLTFLoader().load(unit7ModelUrl, (gltf) => {
      const v = gltf.scene;
      v.scale.setScalar(0.9);
      // Sit Vibey on the platform's worlds-facing edge so he looks toward
      // the row at z=0. He faces -Z; "behind Vibey" is +Z (where the camera ends up).
      v.position.set(0, -0.25, -1.3);
      v.rotation.y = Math.PI; // face the worlds row
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
      // Opening wave — plays while the camera holds on Vibey's face,
      // before the 180° pan begins.
      const wave = actions.get("Wave");
      if (wave) {
        wave.reset();
        wave.setLoop(THREE.LoopOnce, 1);
        wave.clampWhenFinished = true;
        wave.fadeIn(0.25).play();
      }
      // Kick off the intro now that Vibey is actually visible.
      introStartedRef.current = true;
      introElapsedRef.current = 0;
    });





    // ---------- Bloom (subtle) ----------
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(mount.clientWidth, mount.clientHeight),
      0.32, 0.45, 0.82,
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // ---------- Pointer interactions ----------
    const ndc = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const activePointers = new Map<number, { x: number; y: number }>();
    let pinchStartDist = 0;
    let pinchStartCamDist = 0;
    let pinchStartCenterX = 0;
    let pinchStartOffset = 0;

    const pinchDistance = () => {
      const pts = Array.from(activePointers.values());
      if (pts.length < 2) return 0;
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      return Math.hypot(dx, dy);
    };
    const pinchCenterX = () => {
      const pts = Array.from(activePointers.values());
      if (pts.length < 2) return 0;
      return (pts[0].x + pts[1].x) / 2;
    };

    // Convert a screen-pixel dx into world units along the row.
    // Approximation: at camera distance D and vertical fov F, world width
    // per pixel ≈ (2 D tan(F/2)) / viewportHeightPx, scaled by aspect.
    const pixelsToWorld = (dxPx: number) => {
      const h = mount.clientHeight;
      const vFov = (camera.fov * Math.PI) / 180;
      const worldPerPx = (2 * camDistRef.current * Math.tan(vFov / 2)) / h;
      return dxPx * worldPerPx;
    };

    const onPointerDown = (ev: PointerEvent) => {
      introSkipped = true; // any interaction drops the cinematic intro
      activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
      if (activePointers.size === 1) {
        draggingRef.current = true;
        dragStartXRef.current = ev.clientX;
        dragStartOffsetRef.current = targetOffsetRef.current;
      } else if (activePointers.size === 2) {
        // Two-finger gesture: simultaneously pinch-zoom and pan horizontally
        // (like the /space world). Both anchor on the moment the 2nd finger
        // touched down.
        draggingRef.current = false;
        pinchStartDist = pinchDistance();
        pinchStartCamDist = camDistTargetRef.current;
        pinchStartCenterX = pinchCenterX();
        pinchStartOffset = targetOffsetRef.current;
      }
    };
    const onPointerMove = (ev: PointerEvent) => {
      if (activePointers.has(ev.pointerId)) {
        activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      }
      if (activePointers.size >= 2) {
        const d = pinchDistance();
        if (pinchStartDist > 0) {
          const scale = pinchStartDist / d;
          camDistTargetRef.current = THREE.MathUtils.clamp(
            pinchStartCamDist * scale, CAM_MIN, CAM_MAX,
          );
        }
        // Horizontal pan from centroid movement.
        const cx = pinchCenterX();
        targetOffsetRef.current = pinchStartOffset + pixelsToWorld(cx - pinchStartCenterX);
        return;
      }
      if (!draggingRef.current) return;
      const dx = ev.clientX - dragStartXRef.current;
      // Drag right => row slides right => offset increases.
      targetOffsetRef.current = dragStartOffsetRef.current + pixelsToWorld(dx);
    };
    const onPointerUp = (ev: PointerEvent) => {
      const wasMulti = activePointers.size >= 2;
      activePointers.delete(ev.pointerId);
      if (wasMulti) {
        if (activePointers.size === 1) {
          const remaining = Array.from(activePointers.values())[0];
          if (remaining) {
            dragStartXRef.current = remaining.x;
            dragStartOffsetRef.current = targetOffsetRef.current;
            draggingRef.current = true;
          }
        }
        return;
      }
      const wasDragging = draggingRef.current;
      draggingRef.current = false;
      const dx = ev.clientX - dragStartXRef.current;

      // Snap to nearest slot.
      const n = WORLDS.length;
      const snappedIdx = THREE.MathUtils.clamp(
        Math.round(-targetOffsetRef.current / SLOT_SPACING),
        0, n - 1,
      );
      targetOffsetRef.current = -snappedIdx * SLOT_SPACING;
      if (snappedIdx !== focusedRef.current) {
        setFocusedIdx(snappedIdx);
        const wave = vibeyActionsRef.current.get("Wave");
        if (wave) {
          wave.reset(); wave.setLoop(THREE.LoopOnce, 1); wave.clampWhenFinished = true;
          wave.fadeIn(0.15).play();
        }
      }

      // Tap (negligible movement) — focus the planet under the pointer.
      if (Math.abs(dx) < 4 && wasDragging) {
        const rect = renderer.domElement.getBoundingClientRect();
        ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(row.children, true);
        if (hits.length) {
          let obj: THREE.Object3D | null = hits[0].object;
          while (obj && obj.userData?.index === undefined) obj = obj.parent;
          if (obj && typeof obj.userData.index === "number") {
            const idx = obj.userData.index as number;
            if (idx !== focusedRef.current) {
              setFocusedIdx(idx);
              targetOffsetRef.current = -idx * SLOT_SPACING;
            } else {
              navigate(WORLDS[idx].to);
            }
          }
        }
      }
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      introSkipped = true;
      const factor = Math.exp(ev.deltaY * 0.0015);
      camDistTargetRef.current = THREE.MathUtils.clamp(
        camDistTargetRef.current * factor, CAM_MIN, CAM_MAX,
      );
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    // ---------- Animation loop ----------
    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      const dt = clock.getDelta();
      const t = clock.elapsedTime;

      // Smooth row scroll.
      offsetRef.current += (targetOffsetRef.current - offsetRef.current) * Math.min(1, dt * 6);
      row.position.x = offsetRef.current;

      // Per-slot styling. The focused slot is the one closest to x=0
      // in world space after applying the row offset.
      const focusedI = focusedRef.current;
      slots.forEach((s, i) => {
        const worldX = i * SLOT_SPACING + offsetRef.current;
        const dist = Math.abs(worldX);
        const focusT = Math.max(0, 1 - dist / SLOT_SPACING); // 1 at center, 0 at neighbors
        const bob = Math.sin(t * 0.9 + i * 1.2) * 0.08;
        s.group.position.y = ROW_Y + bob;
        const targetScale = 0.7 + focusT * 1.05; // neighbors ~0.7, focus ~1.75
        s.group.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.12);
        // Float the focused world slightly toward the camera so it
        // reads a touch bigger than its neighbors.
        s.group.position.z = focusT * 0.5;
        // Spin the visual.
        const spinObj: THREE.Object3D = s.modelObj ?? s.mesh;
        spinObj.rotation.y += dt * (i === focusedI ? 0.35 : 0.2);
        // Halo brightens only on the active slot.
        const halo = s.halo.material as THREE.MeshBasicMaterial;
        halo.opacity = 0.05 + focusT * 0.12;
      });

      sparkles.rotation.y += dt * 0.02;

      // Platform life: pulse the standing ring, sweep the tilted orbital
      // rings, drift the debris rocks.
      (standRing.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.sin(t * 1.5) * 0.18;
      for (const d of debris) {
        const u = d.userData as { ang: number; rad: number; yb: number; spd: number };
        u.ang += dt * u.spd;
        d.position.set(
          Math.cos(u.ang) * u.rad,
          u.yb + Math.sin(t * 0.8 + u.ang) * 0.18,
          Math.sin(u.ang) * u.rad,
        );
        d.rotation.x += dt * 0.6;
        d.rotation.y += dt * 0.5;
      }

      // Vibey breathes + faces the focused slot.
      const vibey = vibeyRef.current;
      if (vibey) {
        const focusWorldX = focusedI * SLOT_SPACING + offsetRef.current;
        const tgt = new THREE.Vector3(focusWorldX, ROW_Y, ROW_Z);
        const localTgt = vibey.parent!.worldToLocal(tgt.clone());
        const desiredY = Math.atan2(localTgt.x - vibey.position.x, localTgt.z - vibey.position.z);
        // shortest-arc lerp
        let delta = desiredY - vibey.rotation.y;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        vibey.rotation.y += delta * Math.min(1, dt * 4);
        vibey.position.y = -0.25 + Math.sin(t * 1.4) * 0.03;
      }
      vibeyMixerRef.current?.update(dt);

      // Smooth zoom (the resting distance behind Vibey).
      camDistRef.current += (camDistTargetRef.current - camDistRef.current) * Math.min(1, dt * 6);
      const camDist = camDistRef.current;

      // ---- Intro choreography ----
      //  A "hero"   : a flattering 3/4 front shot while Vibey waves.
      //  B "orbit"  : ~1.4 loops around him, ending behind, rising and
      //               pulling back to the resting distance.
      //  C "rest"   : high + far behind Vibey, gazing over the worlds.
      // Any touch/scroll sets introSkipped and jumps to C.
      if (introStartedRef.current && !introSkipped) introElapsedRef.current += dt;
      const introElapsed = introSkipped
        ? Infinity
        : introStartedRef.current
          ? introElapsedRef.current
          : 0;

      // Resting (C) pose — behind Vibey and a bit above, framing him in
      // the lower foreground with the focused world floating up beyond.
      const baseY = 6.5 + (camDist - 17) * 0.16;
      const basePos = new THREE.Vector3(
        Math.sin(t * 0.12) * 0.6,
        baseY,
        vibeyZ + camDist,
      );
      // Look-at sits well below the worlds row so the focused world
      // floats high in the frame (worlds at ROW_Y, look ~1.3 lower).
      const baseLook = new THREE.Vector3(0, ROW_Y - 1.3, ROW_Z);

      // Hero (A) pose — whole-robot 3/4 shot at a comfortable distance.
      const heroPos = new THREE.Vector3(
        Math.sin(HERO_ANGLE) * HERO_R + Math.sin(t * 0.6) * 0.15,
        vibeyHeadY + 0.7,
        vibeyZ - Math.cos(HERO_ANGLE) * HERO_R,
      );
      const heroLook = new THREE.Vector3(0, vibeyMidY + 0.35, vibeyZ);

      const easeInOut = (x: number) =>
        x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

      let camPos: THREE.Vector3;
      let camLook: THREE.Vector3;

      if (!introStartedRef.current) {
        // Vibey not loaded yet — hold the wide pose so the first frames
        // are never a close-up.
        camPos = basePos;
        camLook = baseLook;
      } else if (introElapsed < FACE_DUR) {
        camPos = heroPos;
        camLook = heroLook;
      } else if (introElapsed < FACE_DUR + ORBIT_DUR) {
        // Sweep θ from the hero angle, the long way around (+1 full
        // turn), landing behind Vibey (θ = π) at the resting distance.
        const e = easeInOut((introElapsed - FACE_DUR) / ORBIT_DUR);
        const theta = THREE.MathUtils.lerp(
          HERO_ANGLE,
          HERO_ANGLE + (Math.PI - HERO_ANGLE) + Math.PI * 2,
          e,
        );
        const r = THREE.MathUtils.lerp(HERO_R, camDist, e);
        const h = THREE.MathUtils.lerp(vibeyHeadY + 0.7, baseY, e);
        camPos = new THREE.Vector3(
          Math.sin(theta) * r,
          h,
          vibeyZ - Math.cos(theta) * r,
        );
        camLook = new THREE.Vector3(
          THREE.MathUtils.lerp(heroLook.x, baseLook.x, e),
          THREE.MathUtils.lerp(heroLook.y, baseLook.y, e),
          THREE.MathUtils.lerp(heroLook.z, baseLook.z, e),
        );
      } else {
        camPos = basePos;
        camLook = baseLook;
      }

      camera.position.copy(camPos);
      camera.lookAt(camLook);

      composer.render();
      raf = requestAnimationFrame(tick);
    };
    tick();

    const onResize = () => {
      if (!mount) return;
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      composer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("wheel", onWheel);
      composer.dispose();
      renderer.dispose();
      pmrem.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, [navigate]);

  // Keyboard nav.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") cycle(1);
      else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") cycle(-1);
      else if (e.key === "Enter") navigate(WORLDS[focusedRef.current].to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const focused = WORLDS[focusedIdx];

  return (
    <div className="fixed inset-0 bg-background overflow-hidden select-none">
      <div ref={mountRef} className="absolute inset-0 touch-none cursor-grab active:cursor-grabbing" />

      {/* Vignette */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-radial from-transparent via-transparent to-background/85" />

      {/* Focused world title — pushed below GlobalNav so they don't collide. */}
      <div className="absolute top-16 sm:top-20 left-1/2 -translate-x-1/2 z-10 text-center px-4 pointer-events-none w-[min(95vw,42rem)]">
        <AnimatePresence mode="wait">
          <motion.div
            key={focused.to}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.28 }}
          >
            <p className="text-[10px] sm:text-xs tracking-[0.4em] uppercase text-primary/80">
              VibeVerse
            </p>
            <h1 className="font-heading text-3xl sm:text-5xl font-bold tracking-tight text-foreground mt-1 drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)]">
              {focused.name}
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground mt-2">
              {focused.blurb}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Side arrows */}
      <button
        onClick={() => cycle(-1)}
        className="absolute left-3 sm:left-6 top-1/2 -translate-y-1/2 z-20 glass-panel rounded-full p-3 hover:bg-primary/10 transition-colors"
        aria-label="Previous world"
      >
        <ChevronLeft className="w-5 h-5" />
      </button>
      <button
        onClick={() => cycle(1)}
        className="absolute right-3 sm:right-6 top-1/2 -translate-y-1/2 z-20 glass-panel rounded-full p-3 hover:bg-primary/10 transition-colors"
        aria-label="Next world"
      >
        <ChevronRight className="w-5 h-5" />
      </button>

      {/* Bottom controls */}
      <div className="absolute bottom-6 sm:bottom-10 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-3 pointer-events-none w-full px-4">
        <button
          onClick={() => navigate(focused.to)}
          className="pointer-events-auto group flex items-center gap-2 rounded-full bg-primary text-primary-foreground font-heading font-bold text-sm sm:text-base px-6 sm:px-8 py-3 shadow-[0_0_30px_hsl(var(--primary)/0.5)] hover:shadow-[0_0_40px_hsl(var(--primary)/0.8)] hover:scale-[1.03] transition-all"
        >
          Enter {focused.name}
          <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
        </button>
        <div className="flex items-center gap-2 text-[10px] sm:text-xs text-muted-foreground">
          Drag or use
          <kbd className="rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 font-mono text-[10px]">A</kbd>
          <kbd className="rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 font-mono text-[10px]">D</kbd>
          to explore
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          {WORLDS.map((w, i) => (
            <button
              key={w.to}
              onClick={() => {
                if (i === focusedIdx) return;
                setFocusedIdx(i);
                targetOffsetRef.current = -i * SLOT_SPACING;
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
