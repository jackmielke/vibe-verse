/**
 * City — Vibe City, the explorable neon district.
 *
 * A procedurally generated night city you fly through with a jetpack.
 * This is the seed of the "build a city and keep adding stuff to it"
 * world: every block, rooftop and landing pad is generated from a
 * deterministic seed, so the city is stable across visits and there is
 * no heavy GLB to download — the whole district is geometry we build
 * in code, plus one small Quaternius character.
 *
 * Pure Three.js (no Mapbox, no r3f) — same pattern as Museum and
 * MemoryGarden, which keeps it WebXR-compatible via lib/webxr.ts.
 *
 * Locomotion (third-person, Mario-style):
 *   WASD / arrows — move (camera-relative)   Shift — run
 *   Space (hold)  — jetpack thrust            drag — orbit camera
 *   scroll        — zoom
 *
 * The pilot can land on any rooftop — buildings carry real AABB
 * collision, and the tallest towers get glowing landing pads as an
 * invitation. Extend the city by tweaking the constants in the
 * "City plan" section below; everything regenerates from the seed.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { motion, AnimatePresence } from "framer-motion";
import { Rocket } from "lucide-react";
import { enableVR } from "@/lib/webxr";
import pilotUrl from "@/assets/glb/characters/BlueSoldier_Male.glb";

// ------------------------------------------------------------------
// City plan — tune these and the whole district regenerates.
// ------------------------------------------------------------------
const CITY_SEED = "vibe-city-v1";
const GRID = 9; // city is GRID x GRID cells
const BLOCK = 28; // buildable block size (m)
const STREET = 12; // street width between blocks (m)
const PITCH = BLOCK + STREET; // cell-to-cell distance
const CITY_HALF = (GRID * PITCH) / 2;
const WINDOW_TILE = 12.8; // world meters covered by one window-texture tile
const PAD_MIN_HEIGHT = 48; // towers taller than this get a landing pad

// Movement feel.
const WALK_SPEED = 5.5;
const RUN_SPEED = 11.5;
const GRAVITY = 24;
const THRUST = 50; // jetpack accel (net climb = THRUST - GRAVITY)
const MAX_RISE = 19;
const MAX_FALL = 32;
const PLAYER_RADIUS = 0.55;

interface BuildingBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

// Deterministic rng — same pattern as Museum, so the city never
// reshuffles between visits.
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------
// Window textures — one facade canvas (dark, with unlit + lit panes)
// and one emissive canvas (lit panes only) per variant. The top-left
// corner pixel stays pure facade so roof faces can sample it.
// ------------------------------------------------------------------
function makeWindowTextures(
  variantSeed: string,
  facade: string,
  lit: string,
): { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture } {
  const S = 512;
  const cols = 16;
  const rows = 16;
  const cell = S / cols;
  const r = rng(variantSeed);

  const base = document.createElement("canvas");
  base.width = base.height = S;
  const bctx = base.getContext("2d")!;
  const emi = document.createElement("canvas");
  emi.width = emi.height = S;
  const ectx = emi.getContext("2d")!;

  bctx.fillStyle = facade;
  bctx.fillRect(0, 0, S, S);
  ectx.fillStyle = "#000000";
  ectx.fillRect(0, 0, S, S);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = cx * cell + cell * 0.22;
      const y = cy * cell + cell * 0.2;
      const w = cell * 0.56;
      const h = cell * 0.6;
      const isLit = r() < 0.32;
      if (isLit) {
        const dim = 0.55 + r() * 0.45;
        bctx.fillStyle = lit;
        bctx.globalAlpha = dim;
        bctx.fillRect(x, y, w, h);
        bctx.globalAlpha = 1;
        ectx.fillStyle = lit;
        ectx.globalAlpha = dim;
        ectx.fillRect(x, y, w, h);
        ectx.globalAlpha = 1;
      } else {
        bctx.fillStyle = "rgba(8, 12, 16, 0.92)";
        bctx.fillRect(x, y, w, h);
      }
    }
  }
  // Reserved roof-colored corner texel for roofs/floors — slightly
  // lighter than the facade so rooftops read from above.
  bctx.fillStyle = "#1f2733";
  bctx.fillRect(0, 0, 4, 4);
  ectx.fillStyle = "#000";
  ectx.fillRect(0, 0, 4, 4);

  const mk = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: mk(base), emissiveMap: mk(emi) };
}

// ------------------------------------------------------------------
// Building geometry: a box whose side-face UVs are scaled so windows
// keep a constant world size, and whose roof/floor UVs collapse onto
// the reserved facade texel.
// ------------------------------------------------------------------
function buildingGeometry(
  w: number,
  h: number,
  d: number,
  cx: number,
  cz: number,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const normal = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const ny = normal.getY(i);
    if (Math.abs(ny) > 0.5) {
      uv.setXY(i, 0.003, 0.997); // roof + floor → reserved roof texel
      continue;
    }
    const horiz = Math.abs(normal.getX(i)) > 0.5 ? d : w;
    uv.setXY(i, (uv.getX(i) * horiz) / WINDOW_TILE, (uv.getY(i) * h) / WINDOW_TILE);
  }
  uv.needsUpdate = true;
  geo.translate(cx, h / 2, cz);
  return geo;
}

// ------------------------------------------------------------------
// Generate the district: building AABBs (for collision) plus merged
// geometry per material variant (for cheap rendering).
// ------------------------------------------------------------------
function generateCity(): {
  boxes: BuildingBox[];
  geoByVariant: THREE.BufferGeometry[][];
  pads: Array<{ x: number; z: number; y: number }>;
} {
  const r = rng(CITY_SEED);
  const boxes: BuildingBox[] = [];
  const variants = 6;
  const geoByVariant: THREE.BufferGeometry[][] = Array.from({ length: variants }, () => []);
  const pads: Array<{ x: number; z: number; y: number }> = [];
  const center = (GRID - 1) / 2;

  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      // The middle cell is the spawn plaza — keep it open.
      if (gx === Math.floor(center) && gz === Math.floor(center)) continue;

      const cellX = (gx - center) * PITCH;
      const cellZ = (gz - center) * PITCH;
      const ringDist = Math.max(Math.abs(gx - center), Math.abs(gz - center));

      // 1, 2 or 4 buildings per block.
      const layout = r();
      const lots: Array<[number, number, number, number]> =
        layout < 0.35
          ? [[cellX, cellZ, BLOCK, BLOCK]]
          : layout < 0.7
            ? r() < 0.5
              ? [
                  [cellX - BLOCK / 4, cellZ, BLOCK / 2, BLOCK],
                  [cellX + BLOCK / 4, cellZ, BLOCK / 2, BLOCK],
                ]
              : [
                  [cellX, cellZ - BLOCK / 4, BLOCK, BLOCK / 2],
                  [cellX, cellZ + BLOCK / 4, BLOCK, BLOCK / 2],
                ]
            : [
                [cellX - BLOCK / 4, cellZ - BLOCK / 4, BLOCK / 2, BLOCK / 2],
                [cellX + BLOCK / 4, cellZ - BLOCK / 4, BLOCK / 2, BLOCK / 2],
                [cellX - BLOCK / 4, cellZ + BLOCK / 4, BLOCK / 2, BLOCK / 2],
                [cellX + BLOCK / 4, cellZ + BLOCK / 4, BLOCK / 2, BLOCK / 2],
              ];

      for (const [lx, lz, lw, ld] of lots) {
        // Inset from the lot edge so neighbors don't touch.
        const w = lw - 3 - r() * 3;
        const d = ld - 3 - r() * 3;
        // Towers cluster on the ring right around the plaza; the
        // outskirts stay low so the skyline reads from the center.
        const towerChance = ringDist <= 2 ? 0.38 : ringDist === 3 ? 0.18 : 0.05;
        const roll = r();
        const height =
          roll < towerChance
            ? 46 + r() * 42 // tower 46–88
            : roll < 0.62
              ? 16 + r() * 26 // mid-rise 16–42
              : 7 + r() * 8; // low-rise 7–15

        const variant = Math.floor(r() * variants);
        geoByVariant[variant].push(buildingGeometry(w, height, d, lx, lz));
        boxes.push({
          minX: lx - w / 2,
          maxX: lx + w / 2,
          minZ: lz - d / 2,
          maxZ: lz + d / 2,
          height,
        });
        if (height > PAD_MIN_HEIGHT) pads.push({ x: lx, z: lz, y: height });
      }
    }
  }
  return { boxes, geoByVariant, pads };
}

// Ground texture: asphalt with sidewalk-edged blocks and dashed
// street center lines, drawn once for the whole district.
function makeGroundTexture(): THREE.CanvasTexture {
  const S = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const m = S / (GRID * PITCH); // px per meter
  const center = (GRID - 1) / 2;

  ctx.fillStyle = "#0e1219"; // asphalt
  ctx.fillRect(0, 0, S, S);

  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      const px = (gx * PITCH + STREET / 2) * m;
      const pz = (gz * PITCH + STREET / 2) * m;
      const side = BLOCK * m;
      // Sidewalk ring then block interior.
      ctx.fillStyle = "#1d2531";
      ctx.fillRect(px, pz, side, side);
      ctx.fillStyle = gx === center && gz === center ? "#13312a" : "#121822";
      ctx.fillRect(px + 2.2 * m, pz + 2.2 * m, side - 4.4 * m, side - 4.4 * m);
    }
  }

  // Dashed center lines down every street, both axes.
  ctx.strokeStyle = "rgba(45, 212, 168, 0.6)";
  ctx.lineWidth = 0.35 * m;
  ctx.setLineDash([3 * m, 4.5 * m]);
  for (let g = 0; g <= GRID; g++) {
    const p = g * PITCH * m;
    if (g > 0 && g < GRID) {
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, S);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(S, p);
      ctx.stroke();
    }
  }

  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Neon "VIBE CITY" marquee sprite floating over the plaza.
function makeMarqueeSprite(): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 1024, 256);
  ctx.font = "900 110px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "#2dd4a8";
  ctx.shadowBlur = 42;
  ctx.fillStyle = "#baffe9";
  ctx.fillText("VIBE CITY", 512, 128);
  ctx.shadowBlur = 0;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(26, 6.5, 1);
  return sprite;
}

// Strip the "Armature|" prefix Quaternius rigs add to clip names.
function shortClipName(raw: string) {
  const afterPipe = raw.includes("|") ? raw.split("|")[1] : raw;
  return afterPipe.replace(/^Character_/, "");
}

export default function City() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [entered, setEntered] = useState(false);
  const enteredRef = useRef(false);
  const [hud, setHud] = useState({ alt: 0, spd: 0, jet: false });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // ---- Renderer / scene / camera ---------------------------------
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#05080d");
    scene.fog = new THREE.Fog("#05080d", 90, 520);

    const camera = new THREE.PerspectiveCamera(
      60,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      2200,
    );

    scene.add(new THREE.AmbientLight(0x8899bb, 0.5));
    scene.add(new THREE.HemisphereLight(0x32445e, 0x0c1018, 1.1));
    const moonlight = new THREE.DirectionalLight(0xbfd4ff, 1.05);
    moonlight.position.set(180, 320, -140);
    scene.add(moonlight);
    const plazaGlow = new THREE.PointLight(0x2dd4a8, 60, 90, 1.6);
    plazaGlow.position.set(0, 10, 0);
    scene.add(plazaGlow);

    // ---- The district ----------------------------------------------
    const { boxes, geoByVariant, pads } = generateCity();
    const facades = ["#151b27", "#132033", "#11141c"];
    const litColors = ["#2dd4a8", "#ffd9a0", "#6fd9ff"];
    const buildingMeshes: THREE.Mesh[] = [];
    geoByVariant.forEach((geos, i) => {
      if (!geos.length) return;
      const { map, emissiveMap } = makeWindowTextures(
        `${CITY_SEED}-tex-${i}`,
        facades[i % facades.length],
        litColors[Math.floor(i / facades.length) % litColors.length],
      );
      const merged = mergeGeometries(geos, false)!;
      geos.forEach((g) => g.dispose());
      const mat = new THREE.MeshStandardMaterial({
        map,
        emissive: new THREE.Color("#ffffff"),
        emissiveMap,
        emissiveIntensity: 1.0,
        roughness: 0.85,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(merged, mat);
      scene.add(mesh);
      buildingMeshes.push(mesh);
    });

    // Ground: textured district plate over a huge dark apron.
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(GRID * PITCH, GRID * PITCH),
      new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 0.95 }),
    );
    plate.rotation.x = -Math.PI / 2;
    scene.add(plate);
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ color: "#04060a", roughness: 1 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.05;
    scene.add(apron);

    // Plaza spawn ring + marquee.
    const padMat = new THREE.MeshBasicMaterial({
      color: "#2dd4a8",
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const plazaRing = new THREE.Mesh(new THREE.RingGeometry(4.2, 5.4, 48), padMat);
    plazaRing.rotation.x = -Math.PI / 2;
    plazaRing.position.y = 0.06;
    scene.add(plazaRing);
    const marquee = makeMarqueeSprite();
    marquee.position.set(0, 24, 0);
    scene.add(marquee);

    // Rooftop landing pads on the tallest towers.
    const padGeo = new THREE.RingGeometry(2.1, 3, 36);
    pads.forEach((p) => {
      const ring = new THREE.Mesh(padGeo, padMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, p.y + 0.12, p.z);
      scene.add(ring);
    });

    // Stars + moon (fog-exempt so they read at any distance).
    const starGeo = new THREE.BufferGeometry();
    {
      const r = rng(`${CITY_SEED}-stars`);
      const pts: number[] = [];
      for (let i = 0; i < 1400; i++) {
        const theta = r() * Math.PI * 2;
        const phi = r() * Math.PI * 0.48;
        const rad = 1500;
        pts.push(
          Math.cos(theta) * Math.cos(phi) * rad,
          Math.sin(phi) * rad + 40,
          Math.sin(theta) * Math.cos(phi) * rad,
        );
      }
      starGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    }
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xcfe8ff, size: 2.2, sizeAttenuation: false, fog: false }),
    );
    scene.add(stars);
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(60, 32, 32),
      new THREE.MeshBasicMaterial({ color: "#e8f1ff", fog: false }),
    );
    moon.position.set(620, 430, -900);
    scene.add(moon);

    // ---- Pilot + jetpack rig ----------------------------------------
    const player = new THREE.Group(); // origin = feet
    player.position.set(0, 0, 6);
    scene.add(player);
    const modelHolder = new THREE.Group(); // takes the flight tilt
    player.add(modelHolder);

    let mixer: THREE.AnimationMixer | null = null;
    const actions = new Map<string, THREE.AnimationAction>();
    let activeAction: THREE.AnimationAction | null = null;
    let activeName = "";

    const playClip = (names: RegExp[], fallbackFirst = false) => {
      let pick: string | undefined;
      for (const re of names) {
        pick = [...actions.keys()].find((n) => re.test(n));
        if (pick) break;
      }
      if (!pick && fallbackFirst) pick = [...actions.keys()][0];
      if (!pick || pick === activeName) return;
      const next = actions.get(pick)!;
      next.reset().fadeIn(0.22).play();
      activeAction?.fadeOut(0.22);
      activeAction = next;
      activeName = pick;
    };

    const loader = new GLTFLoader();
    loader.load(pilotUrl, (gltf) => {
      const model = gltf.scene;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const fit = 1.85 / Math.max(size.x, size.y, size.z, 0.0001);
      model.scale.setScalar(fit);
      model.updateMatrixWorld(true);
      const scaled = new THREE.Box3().setFromObject(model);
      model.position.y = -scaled.min.y;
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const apply = (mat: THREE.Material) => {
          const std = mat as THREE.MeshStandardMaterial;
          if (std && "metalness" in std) {
            std.metalness = Math.min(std.metalness, 0.3);
            std.roughness = Math.max(std.roughness, 0.45);
            std.needsUpdate = true;
          }
        };
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach(apply);
        else if (mat) apply(mat);
      });
      modelHolder.add(model);

      if (gltf.animations.length) {
        mixer = new THREE.AnimationMixer(model);
        for (const clip of gltf.animations) {
          actions.set(shortClipName(clip.name), mixer.clipAction(clip));
        }
        console.debug("[city] pilot clips:", [...actions.keys()].join(", "));
        playClip([/^idle$/i, /idle/i], true);
      }
    });

    // Procedural jetpack: backplate + twin tanks + nozzles + flames.
    const jetpack = new THREE.Group();
    const packMat = new THREE.MeshStandardMaterial({
      color: "#1d2733",
      roughness: 0.5,
      metalness: 0.55,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: "#2dd4a8",
      emissive: "#2dd4a8",
      emissiveIntensity: 0.7,
      roughness: 0.4,
    });
    const backplate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.12), packMat);
    jetpack.add(backplate);
    const flameMat = new THREE.MeshBasicMaterial({
      color: "#7dfce0",
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flames: THREE.Mesh[] = [];
    [-0.13, 0.13].forEach((x) => {
      const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.34, 6, 12), packMat);
      tank.position.set(x, 0, -0.1);
      jetpack.add(tank);
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.07, 12), trimMat);
      collar.position.set(x, -0.3, -0.1);
      jetpack.add(collar);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.5, 10), flameMat);
      flame.rotation.x = Math.PI; // point down
      flame.position.set(x, -0.58, -0.1);
      flame.visible = false;
      jetpack.add(flame);
      flames.push(flame);
    });
    jetpack.position.set(0, 1.06, -0.24); // on the pilot's back
    modelHolder.add(jetpack);
    const jetLight = new THREE.PointLight(0x7dfce0, 0, 9, 2);
    jetLight.position.set(0, 0.4, -0.2);
    player.add(jetLight);

    // Thruster particle trail.
    const P_COUNT = 160;
    const pPos = new Float32Array(P_COUNT * 3);
    const pLife = new Float32Array(P_COUNT).fill(0);
    const pVel = new Float32Array(P_COUNT * 3);
    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    const particles = new THREE.Points(
      particleGeo,
      new THREE.PointsMaterial({
        color: 0x7dfce0,
        size: 0.32,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    particles.frustumCulled = false;
    scene.add(particles);
    let nextParticle = 0;

    // ---- Input -------------------------------------------------------
    const keys = new Set<string>();
    const handled = new Set([
      "KeyW", "KeyA", "KeyS", "KeyD",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Space", "ShiftLeft", "ShiftRight",
    ]);
    const onKeyDown = (e: KeyboardEvent) => {
      if (!enteredRef.current || !handled.has(e.code)) return;
      e.preventDefault();
      keys.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Drag-to-orbit camera (no pointer lock — phone-friendlier later).
    let camYaw = Math.PI;
    let camPitch = 0.42;
    let camDist = 9;
    let dragging = false;
    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      camYaw -= e.movementX * 0.0052;
      camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * 0.0052, 0.06, 1.25);
    };
    const onPointerUp = () => (dragging = false);
    const onWheel = (e: WheelEvent) => {
      camDist = THREE.MathUtils.clamp(camDist * (1 + e.deltaY * 0.0011), 4.5, 18);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: true });

    // ---- Collision helpers --------------------------------------------
    const supportHeightAt = (x: number, z: number): number => {
      let h = 0;
      for (const b of boxes) {
        if (x >= b.minX - PLAYER_RADIUS && x <= b.maxX + PLAYER_RADIUS &&
            z >= b.minZ - PLAYER_RADIUS && z <= b.maxZ + PLAYER_RADIUS) {
          if (b.height > h) h = b.height;
        }
      }
      return h;
    };
    const blockedAt = (x: number, z: number, y: number): boolean => {
      for (const b of boxes) {
        if (y < b.height - 0.4 &&
            x >= b.minX - PLAYER_RADIUS && x <= b.maxX + PLAYER_RADIUS &&
            z >= b.minZ - PLAYER_RADIUS && z <= b.maxZ + PLAYER_RADIUS) {
          return true;
        }
      }
      return false;
    };

    // ---- Simulation state ---------------------------------------------
    const vel = new THREE.Vector3();
    let onGround = true;
    let modelYaw = 0;
    let lastTime = performance.now();

    const hudTimer = window.setInterval(() => {
      setHud({
        alt: Math.max(0, player.position.y),
        spd: vel.length(),
        jet: keys.has("Space") && enteredRef.current,
      });
    }, 120);

    const disposeVR = enableVR(renderer, canvas.parentElement!, {
      referenceSpace: "local-floor",
    });

    const tick = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      // Input → camera-relative move intent.
      const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const intent = new THREE.Vector3();
      if (enteredRef.current) {
        if (keys.has("KeyW") || keys.has("ArrowUp")) intent.add(fwd);
        if (keys.has("KeyS") || keys.has("ArrowDown")) intent.sub(fwd);
        if (keys.has("KeyD") || keys.has("ArrowRight")) intent.add(right);
        if (keys.has("KeyA") || keys.has("ArrowLeft")) intent.sub(right);
      }
      const running = keys.has("ShiftLeft") || keys.has("ShiftRight");
      const thrusting = enteredRef.current && keys.has("Space");
      if (intent.lengthSq() > 0) intent.normalize();
      const targetSpeed = running ? RUN_SPEED : WALK_SPEED;

      // Horizontal velocity eases toward intent; lighter control mid-air.
      const k = onGround ? 1 - Math.pow(0.0001, dt) : 1 - Math.pow(0.05, dt);
      vel.x += (intent.x * targetSpeed - vel.x) * k;
      vel.z += (intent.z * targetSpeed - vel.z) * k;

      // Vertical: gravity vs. jetpack.
      vel.y -= GRAVITY * dt;
      if (thrusting) {
        vel.y += THRUST * dt;
        onGround = false;
      }
      vel.y = THREE.MathUtils.clamp(vel.y, -MAX_FALL, MAX_RISE);

      // Integrate with axis-separated horizontal collision.
      const pos = player.position;
      const nx = THREE.MathUtils.clamp(pos.x + vel.x * dt, -CITY_HALF - 40, CITY_HALF + 40);
      const nz = THREE.MathUtils.clamp(pos.z + vel.z * dt, -CITY_HALF - 40, CITY_HALF + 40);
      if (!blockedAt(nx, nz, pos.y)) {
        pos.x = nx;
        pos.z = nz;
      } else if (!blockedAt(nx, pos.z, pos.y)) {
        pos.x = nx;
        vel.z = 0;
      } else if (!blockedAt(pos.x, nz, pos.y)) {
        pos.z = nz;
        vel.x = 0;
      } else {
        vel.x = 0;
        vel.z = 0;
      }
      pos.y += vel.y * dt;

      // Land on whatever is underneath (street or rooftop).
      const support = supportHeightAt(pos.x, pos.z);
      if (pos.y <= support && vel.y <= 0) {
        pos.y = support;
        vel.y = 0;
        onGround = true;
      } else if (pos.y > support + 0.05) {
        onGround = false;
      }

      // Face the direction of travel; tilt forward while flying fast.
      const hSpeed = Math.hypot(vel.x, vel.z);
      if (hSpeed > 0.6) {
        const target = Math.atan2(vel.x, vel.z);
        let d = target - modelYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        modelYaw += d * Math.min(1, dt * 10);
        modelHolder.rotation.y = modelYaw;
      }
      const tiltTarget = !onGround ? Math.min(hSpeed / RUN_SPEED, 1) * 0.38 : 0;
      modelHolder.rotation.x += (tiltTarget - modelHolder.rotation.x) * Math.min(1, dt * 6);

      // Animation state machine.
      if (actions.size) {
        if (!onGround) playClip([/jump_idle/i, /jump/i, /fall/i, /idle/i], true);
        else if (hSpeed > 6.5) playClip([/^run/i, /run/i, /walk/i], true);
        else if (hSpeed > 0.6) playClip([/^walk/i, /walk/i, /run/i], true);
        else playClip([/^idle$/i, /idle/i], true);
      }
      mixer?.update(dt);

      // Jetpack VFX.
      flames.forEach((f) => {
        f.visible = thrusting;
        if (thrusting) {
          const s = 0.8 + Math.random() * 0.5;
          f.scale.set(s, s * (1 + Math.random() * 0.4), s);
        }
      });
      jetLight.intensity = thrusting ? 26 + Math.random() * 14 : 0;
      if (thrusting) {
        for (let s = 0; s < 3; s++) {
          const i = nextParticle++ % P_COUNT;
          const side = s % 2 === 0 ? -0.13 : 0.13;
          const nozzle = new THREE.Vector3(side, -0.62, -0.1);
          jetpack.localToWorld(nozzle);
          pPos[i * 3] = nozzle.x;
          pPos[i * 3 + 1] = nozzle.y;
          pPos[i * 3 + 2] = nozzle.z;
          pVel[i * 3] = (Math.random() - 0.5) * 1.4;
          pVel[i * 3 + 1] = -7 - Math.random() * 3;
          pVel[i * 3 + 2] = (Math.random() - 0.5) * 1.4;
          pLife[i] = 0.7;
        }
      }
      for (let i = 0; i < P_COUNT; i++) {
        if (pLife[i] <= 0) continue;
        pLife[i] -= dt;
        pPos[i * 3] += pVel[i * 3] * dt;
        pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
        pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
        if (pLife[i] <= 0) pPos[i * 3 + 1] = -1000;
      }
      particleGeo.attributes.position.needsUpdate = true;

      // Pulse the landing pads and plaza ring together.
      padMat.opacity = 0.55 + Math.sin(now * 0.0024) * 0.3;

      // Chase camera.
      const eye = new THREE.Vector3(
        pos.x + Math.sin(camYaw) * Math.cos(camPitch) * camDist,
        pos.y + Math.sin(camPitch) * camDist + 1.4,
        pos.z + Math.cos(camYaw) * Math.cos(camPitch) * camDist,
      );
      // Keep the camera out of the street floor.
      eye.y = Math.max(eye.y, supportHeightAt(eye.x, eye.z) + 0.6);
      camera.position.lerp(eye, 1 - Math.pow(0.0008, dt));
      camera.lookAt(pos.x, pos.y + 1.5, pos.z);

      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(tick);

    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(canvas);

    return () => {
      renderer.setAnimationLoop(null);
      disposeVR();
      ro.disconnect();
      window.clearInterval(hudTimer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh || (obj as THREE.Points).isPoints) {
          mesh.geometry?.dispose();
          const m = mesh.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose();
        }
      });
      renderer.dispose();
    };
  }, []);

  const enter = () => {
    enteredRef.current = true;
    setEntered(true);
  };

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden text-foreground">
      <canvas ref={canvasRef} className="w-full h-full block touch-none" />

      {/* HUD: altitude / speed / thrust readout. */}
      {entered && (
        <div className="absolute bottom-4 left-4 glass-panel rounded-2xl px-4 py-3 text-xs font-mono space-y-1 pointer-events-none">
          <div className="flex items-center gap-2">
            <Rocket
              className={`w-3.5 h-3.5 ${hud.jet ? "text-primary animate-pulse" : "text-muted-foreground"}`}
            />
            <span className={hud.jet ? "text-primary" : "text-muted-foreground"}>
              JETPACK {hud.jet ? "FIRING" : "READY"}
            </span>
          </div>
          <div className="text-muted-foreground">
            ALT <span className="text-foreground">{hud.alt.toFixed(0)}m</span>
            {"  ·  "}
            SPD <span className="text-foreground">{hud.spd.toFixed(0)} m/s</span>
          </div>
        </div>
      )}

      {/* Controls hint, fades in once you enter. */}
      {entered && (
        <div className="absolute bottom-4 right-4 glass-panel rounded-2xl px-4 py-3 text-[11px] text-muted-foreground pointer-events-none hidden sm:block">
          WASD move · Shift run · <span className="text-primary">Space hold = jetpack</span> · drag
          look · scroll zoom
        </div>
      )}

      {/* Entry overlay. */}
      <AnimatePresence>
        {!entered && (
          <motion.div
            className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.5 } }}
          >
            <motion.div
              className="glass-panel rounded-3xl px-8 py-7 max-w-md mx-4 text-center space-y-4"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="text-3xl">🏙️</div>
              <h1 className="font-heading text-2xl font-bold tracking-wide text-primary">
                VIBE CITY
              </h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                A neon district to explore. Walk the streets, then hold{" "}
                <span className="text-primary font-semibold">Space</span> to fire the jetpack and
                land on the rooftops — the glowing rings mark the best perches.
              </p>
              <div className="text-[11px] text-muted-foreground font-mono">
                WASD / arrows — move · Shift — run · Space — jetpack
                <br />
                drag — look around · scroll — zoom
              </div>
              <button
                onClick={enter}
                className="px-6 py-2.5 rounded-full bg-primary text-primary-foreground font-heading font-semibold text-sm tracking-wider uppercase hover:opacity-90 transition-opacity"
              >
                Jet in
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
