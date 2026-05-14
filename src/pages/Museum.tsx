/**
 * Museum — Edge Esmeralda's playful "Fractal Museum" world.
 *
 * Inspired by the Dr. Seuss Fractal Museum book cover: turquoise
 * walls, butter-yellow floor, hand-tilted frames in mismatched
 * colors, characters wandering between them. A walkable 3D gallery
 * room where every painting can be:
 *   1) clicked once → zoom modal (artwork big + caption)
 *   2) clicked again → Seuss-style rhyming story page
 *
 * Pure Three.js (no Mapbox, no r3f) — same pattern as MemoryGarden,
 * which keeps it WebXR-compatible via lib/webxr.ts.
 *
 * Locomotion: WASD / arrow keys to walk, mouse to look (pointer
 * lock). Click "Walk in" to enter, ESC to release.
 *
 * Content: edit ARTWORKS at the top of this file. Each entry can
 * provide a real image_url, or just a `palette` of hex colors and
 * the museum will paint a Mondrian-ish abstract for it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, BookOpen, ChevronLeft, ChevronRight } from "lucide-react";
import { enableVR } from "@/lib/webxr";
import { createVRPortal, leaveXrAndNavigate } from "@/lib/vrPortals";
import { useNavigate } from "react-router-dom";

// ------------------------------------------------------------------
// Content. Swap freely — add/remove items, point image_url at any
// CDN, or skip image_url and pass a palette to get a generated piece.
// Rhyme is rendered on the "story page" after the second click.
// ------------------------------------------------------------------
interface Artwork {
  id: string;
  title: string;
  artist: string;
  caption: string;
  rhyme: string; // 4–8 short lines, Seussy
  // Either a real image OR a palette. Palette wins if both omitted.
  image_url?: string;
  palette?: string[];
  frame: string; // hex color of the frame
  shape?: "rect" | "tall" | "wide" | "oval";
}

const ARTWORKS: Artwork[] = [
  {
    id: "mandelbrot",
    title: "The Mandelbrot Set",
    artist: "Benoît Mandelbrot, 1980",
    caption:
      "The OG fractal. Zoom in forever and the same swirl keeps showing up — proof the universe is doodling.",
    rhyme:
      "It folds and it folds and it folds and it folds,\n" +
      "down rabbity holes that the math gently molds.\n" +
      "You zoom and you zoom and you never quite land —\n" +
      "the picture is bigger than thinking has planned!",
    palette: ["#0a1f3d", "#1d3b6b", "#f6c945", "#0a0a0a"],
    frame: "#e8b73f",
  },
  {
    id: "koch",
    title: "Koch Snowflake",
    artist: "Helge von Koch, 1904",
    caption:
      "A triangle that keeps growing tiny triangles on its edges. Finite area, infinite perimeter. Cozy.",
    rhyme:
      "A triangle ate a triangle's edge,\n" +
      "then sprouted three more on a wee little ledge.\n" +
      "It's tiny! It's spiky! It cannot stop snowing —\n" +
      "the edge keeps on edging and growing and growing!",
    palette: ["#e9f6f8", "#7dd3fc", "#0c2340", "#ffffff"],
    frame: "#5b8fb9",
  },
  {
    id: "sierpinski",
    title: "Sierpinski's Triangle",
    artist: "Wacław Sierpiński, 1915",
    caption:
      "Take a triangle. Cut a triangle out. Cut more triangles out. Keep going. You will not run out of triangles.",
    rhyme:
      "A triangle, a triangle, a triangle inside,\n" +
      "another wee triangle, eyes open wide.\n" +
      "However you measure, however you trace —\n" +
      "there's always more triangle hiding in space.",
    palette: ["#0d0d0d", "#ff5722", "#ffeb3b", "#ffffff"],
    frame: "#c44a1a",
    shape: "tall",
  },
  {
    id: "julia",
    title: "Julia Set No. 7",
    artist: "Gaston Julia, 1918",
    caption:
      "Cousin to the Mandelbrot. Tiny tweak to the formula, wildly different swirl. Like cousins, basically.",
    palette: ["#2a0a3d", "#9b59ff", "#5cf2c1", "#ffd6f1"],
    frame: "#f0d78c",
    rhyme:
      "If Mandelbrot's swirl is a calm, mossy pond,\n" +
      "then Julia's is fireworks blown by a wand.\n" +
      "Same family, sure — but a wholly new song,\n" +
      "and we'll hum it together the whole evening long.",
    shape: "oval",
  },
  {
    id: "dragon",
    title: "Heighway Dragon",
    artist: "John Heighway, 1966",
    caption:
      "Fold a strip of paper in half. Then half. Then half. Open it up. There's the dragon. Hi, dragon.",
    palette: ["#0d3b2e", "#2dd4a8", "#f5f0e0", "#0a0a0a"],
    frame: "#2dd4a8",
    rhyme:
      "Fold-it and fold-it and fold-it some more,\n" +
      "a paper-y dragon will walk through the door.\n" +
      "He nibbles on numbers, he naps on a curve —\n" +
      "the bendier sort, with the courage and verve.",
    shape: "wide",
  },
  {
    id: "barnsley",
    title: "Barnsley Fern",
    artist: "Michael Barnsley, 1988",
    caption:
      "Four little rules, applied a million times, and out comes a fern. Nature was using fractals all along.",
    palette: ["#1a3c2a", "#5a8a5c", "#a0c49d", "#0d1b0d"],
    frame: "#5a8a5c",
    rhyme:
      "Four little rules and a roll of the die,\n" +
      "a fern fronds itself toward the sky.\n" +
      "It's not really plants, but it isn't not, either —\n" +
      "the math and the meadow are made of one weather.",
    shape: "tall",
  },
  {
    id: "lorenz",
    title: "Lorenz Attractor",
    artist: "Edward Lorenz, 1963",
    caption:
      "A weatherman's equation that drew butterflies. The reason your forecast keeps lying to you.",
    palette: ["#0a0a1a", "#4f46e5", "#67e8f9", "#a78bfa"],
    frame: "#4f46e5",
    rhyme:
      "A butterfly fluttered her wings in Peru,\n" +
      "and somewhere in Texas it rained on a shoe.\n" +
      "The weather, you see, is a chaos of loops —\n" +
      "two wings, two great wings, and a thousand sweet swoops.",
    shape: "wide",
  },
  {
    id: "cantor",
    title: "Cantor Dust",
    artist: "Georg Cantor, 1883",
    caption:
      "Take a line. Erase the middle third. Erase the middle third of what's left. Keep going. End: dust.",
    palette: ["#f5f3ee", "#1a1a1a", "#c9a84c", "#0d0d0d"],
    frame: "#1a1a1a",
    rhyme:
      "A line was a line was a line was a line,\n" +
      "till the middle got nibbled, time after time.\n" +
      "What's left is a sprinkling, a dusting, a hush —\n" +
      "a song that is silence, a thought that is plush.",
  },
  {
    id: "menger",
    title: "Menger Sponge",
    artist: "Karl Menger, 1926",
    caption:
      "A cube that keeps eating itself. Surface area: enormous. Volume: zero. Perfect for soup.",
    palette: ["#6b3a2a", "#cd7f32", "#e8c07a", "#1a1a1a"],
    frame: "#cd7f32",
    rhyme:
      "A cube ate a cube, then it ate twenty more,\n" +
      "till the cube was a hole was a cube was a door.\n" +
      "It mops up the soup with the holes that it grew —\n" +
      "and somehow the soup is still drippity-droo.",
    shape: "tall",
  },
];

// ------------------------------------------------------------------
// Generate a Mondrian/Seuss-ish painted CanvasTexture from a palette.
// Used when an artwork has no image_url. Deterministic per-id so the
// same artwork always paints the same way.
// ------------------------------------------------------------------
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

function paintArtwork(art: Artwork): THREE.CanvasTexture {
  const W = 512;
  const H = art.shape === "tall" ? 768 : art.shape === "wide" ? 384 : 512;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const palette = art.palette ?? ["#1a1a2e", "#e94560", "#f5d76e", "#0f3460"];
  const r = rng(art.id);

  // Wash the background with the lightest color in the palette.
  const bg = palette[0] ?? "#fff";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Mondrian-style block partition: recursive vertical/horizontal
  // splits, each block painted with a random palette color.
  const blocks: Array<[number, number, number, number]> = [[0, 0, W, H]];
  const splits = 5 + Math.floor(r() * 4);
  for (let i = 0; i < splits; i++) {
    const idx = Math.floor(r() * blocks.length);
    const [x, y, w, h] = blocks.splice(idx, 1)[0];
    if (w < 60 || h < 60) {
      blocks.push([x, y, w, h]);
      continue;
    }
    const vert = w > h ? r() < 0.7 : r() < 0.3;
    const t = 0.3 + r() * 0.4;
    if (vert) {
      const cut = Math.floor(w * t);
      blocks.push([x, y, cut, h], [x + cut, y, w - cut, h]);
    } else {
      const cut = Math.floor(h * t);
      blocks.push([x, y, w, cut], [x, y + cut, w, h - cut]);
    }
  }
  for (const [x, y, w, h] of blocks) {
    ctx.fillStyle = palette[Math.floor(r() * palette.length)];
    ctx.fillRect(x, y, w, h);
  }

  // Fractal-ish accent: a recursive triangle, circle ring, or
  // Sierpinski cluster painted on top — gives each piece a "this
  // is a fractal" hint without being literal.
  ctx.globalAlpha = 0.85;
  const accent = palette[palette.length - 1] ?? "#000";
  const mode = Math.floor(r() * 3);
  if (mode === 0) {
    // recursive squares
    let cx = W / 2,
      cy = H / 2,
      s = Math.min(W, H) * 0.45;
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = palette[i % palette.length];
      ctx.lineWidth = 6 - i * 0.7;
      ctx.strokeRect(cx - s / 2, cy - s / 2, s, s);
      s *= 0.66;
    }
  } else if (mode === 1) {
    // dot snowflake
    const cx = W / 2,
      cy = H / 2;
    for (let ring = 1; ring <= 4; ring++) {
      const count = ring * 6;
      const radius = ring * Math.min(W, H) * 0.08;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        ctx.fillStyle = palette[(ring + i) % palette.length];
        ctx.beginPath();
        ctx.arc(
          cx + Math.cos(a) * radius,
          cy + Math.sin(a) * radius,
          6 + ring,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }
  } else {
    // sierpinski triangle, 4 levels
    const drawTri = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      cx: number,
      cy: number,
      depth: number,
    ) => {
      if (depth === 0) {
        ctx.fillStyle = palette[(depth + 1) % palette.length];
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.lineTo(cx, cy);
        ctx.closePath();
        ctx.fill();
        return;
      }
      const abx = (ax + bx) / 2,
        aby = (ay + by) / 2;
      const bcx = (bx + cx) / 2,
        bcy = (by + cy) / 2;
      const cax = (cx + ax) / 2,
        cay = (cy + ay) / 2;
      drawTri(ax, ay, abx, aby, cax, cay, depth - 1);
      drawTri(abx, aby, bx, by, bcx, bcy, depth - 1);
      drawTri(cax, cay, bcx, bcy, cx, cy, depth - 1);
    };
    ctx.fillStyle = accent;
    drawTri(W * 0.1, H * 0.85, W * 0.9, H * 0.85, W * 0.5, H * 0.15, 4);
  }
  ctx.globalAlpha = 1;

  // Faint paper grain for that hand-painted feel.
  const grain = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < grain.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    grain.data[i] = Math.max(0, Math.min(255, grain.data[i] + n));
    grain.data[i + 1] = Math.max(0, Math.min(255, grain.data[i + 1] + n));
    grain.data[i + 2] = Math.max(0, Math.min(255, grain.data[i + 2] + n));
  }
  ctx.putImageData(grain, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ------------------------------------------------------------------
// Room geometry constants — tuned so the camera at eye-height (1.6m)
// can look around comfortably and frames sit at portrait height.
// ------------------------------------------------------------------
const ROOM_W = 26;
const ROOM_D = 26;
const ROOM_H = 7;
const WALL_COLOR = "#7fcfd0"; // Seuss turquoise
const FLOOR_COLOR = "#f5d572"; // butter yellow
const TRIM_COLOR = "#fff8e7";
const EYE_HEIGHT = 1.6;

interface FramePlacement {
  artId: string;
  x: number;
  y: number;
  z: number;
  ry: number; // yaw to face into room
  w: number;
  h: number;
  tilt: number; // tiny rotation around z for "hung crooked" feel
  oval: boolean;
  frameColor: string;
}

function layoutFrames(): FramePlacement[] {
  const out: FramePlacement[] = [];
  // Distribute artworks across the four walls.
  const perWall = Math.ceil(ARTWORKS.length / 4);
  const wallDefs = [
    { axis: "z", side: -ROOM_D / 2 + 0.05, ry: 0 },
    { axis: "z", side: ROOM_D / 2 - 0.05, ry: Math.PI },
    { axis: "x", side: -ROOM_W / 2 + 0.05, ry: Math.PI / 2 },
    { axis: "x", side: ROOM_W / 2 - 0.05, ry: -Math.PI / 2 },
  ] as const;

  ARTWORKS.forEach((art, i) => {
    const wallIdx = Math.floor(i / perWall);
    const wall = wallDefs[Math.min(wallIdx, 3)];
    const slot = i % perWall;
    const span = wall.axis === "z" ? ROOM_W : ROOM_D;
    const t = (slot + 1) / (perWall + 1); // 0..1 along wall
    const along = (t - 0.5) * (span - 4);

    let w = 2.6,
      h = 2.0;
    if (art.shape === "tall") {
      w = 1.8;
      h = 2.8;
    } else if (art.shape === "wide") {
      w = 3.4;
      h = 1.8;
    } else if (art.shape === "oval") {
      w = 2.2;
      h = 2.6;
    }
    const tiltSeed = rng(art.id)();
    const tilt = (tiltSeed - 0.5) * 0.12;
    const yJitter = (rng(art.id + "y")() - 0.5) * 0.4;

    out.push({
      artId: art.id,
      x: wall.axis === "z" ? along : wall.side,
      z: wall.axis === "z" ? wall.side : along,
      y: 2.6 + yJitter,
      ry: wall.ry,
      w,
      h,
      tilt,
      oval: art.shape === "oval",
      frameColor: art.frame,
    });
  });
  return out;
}

export default function Museum() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [ready, setReady] = useState(false);
  const [walking, setWalking] = useState(false);
  const [zoomed, setZoomed] = useState<Artwork | null>(null);
  const [story, setStory] = useState<Artwork | null>(null);
  const placements = useMemo(() => layoutFrames(), []);

  // We let the click handler reach into refs to read latest state
  // without re-mounting the renderer.
  const stateRef = useRef({ zoomed: null as Artwork | null });
  useEffect(() => {
    stateRef.current.zoomed = zoomed;
  }, [zoomed]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#bfeef0");
    scene.fog = new THREE.Fog("#bfeef0", 30, 60);

    const camera = new THREE.PerspectiveCamera(
      72,
      mount.clientWidth / mount.clientHeight,
      0.1,
      200,
    );
    camera.position.set(0, EYE_HEIGHT, ROOM_D / 2 - 3);
    camera.lookAt(0, EYE_HEIGHT, 0);

    // Lights — bright daytime gallery feel, warm sun + cool fill.
    scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const sun = new THREE.DirectionalLight(0xfff3d0, 1.1);
    sun.position.set(8, 12, 6);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xa5d8ff, 0.45);
    fill.position.set(-6, 8, -4);
    scene.add(fill);

    // Floor.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_W, ROOM_D),
      new THREE.MeshStandardMaterial({
        color: FLOOR_COLOR,
        roughness: 0.85,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    // Painted "stage curve" — a soft cream half-disc on the floor
    // echoing the book cover's arc under the visitors.
    const arc = new THREE.Mesh(
      new THREE.CircleGeometry(7, 64, 0, Math.PI),
      new THREE.MeshStandardMaterial({
        color: "#fff5d8",
        roughness: 0.9,
      }),
    );
    arc.rotation.x = -Math.PI / 2;
    arc.position.set(0, 0.01, ROOM_D / 2 - 8);
    arc.rotation.z = Math.PI;
    scene.add(arc);

    // Walls + ceiling.
    const wallMat = new THREE.MeshStandardMaterial({
      color: WALL_COLOR,
      roughness: 0.95,
      side: THREE.DoubleSide,
    });
    const ceilMat = new THREE.MeshStandardMaterial({
      color: TRIM_COLOR,
      roughness: 0.9,
      side: THREE.DoubleSide,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: TRIM_COLOR,
      roughness: 0.7,
    });
    const buildWall = (w: number, x: number, z: number, ry: number) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, ROOM_H), wallMat);
      mesh.position.set(x, ROOM_H / 2, z);
      mesh.rotation.y = ry;
      scene.add(mesh);
      // Cream baseboard trim.
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(w, 0.35, 0.1),
        trimMat,
      );
      base.position.set(x, 0.18, z);
      base.rotation.y = ry;
      scene.add(base);
    };
    buildWall(ROOM_W, 0, -ROOM_D / 2, 0);
    buildWall(ROOM_W, 0, ROOM_D / 2, Math.PI);
    buildWall(ROOM_D, -ROOM_W / 2, 0, Math.PI / 2);
    buildWall(ROOM_D, ROOM_W / 2, 0, -Math.PI / 2);

    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_W, ROOM_D),
      ceilMat,
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = ROOM_H;
    scene.add(ceiling);

    // Central pedestal + plant — a Seuss-ish potted topiary.
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.5, 1.1, 24),
      new THREE.MeshStandardMaterial({ color: "#fff8e7", roughness: 0.6 }),
    );
    pedestal.position.set(0, 0.55, 0);
    scene.add(pedestal);
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.4, 0.35, 24),
      new THREE.MeshStandardMaterial({ color: "#c44a1a", roughness: 0.7 }),
    );
    pot.position.set(0, 1.28, 0);
    scene.add(pot);
    const topiary = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const blob = new THREE.Mesh(
        new THREE.SphereGeometry(0.38 - i * 0.05, 20, 16),
        new THREE.MeshStandardMaterial({
          color: i % 2 === 0 ? "#3aa56a" : "#5dc488",
          roughness: 0.85,
        }),
      );
      blob.position.set(
        Math.cos(i * 1.7) * 0.18,
        1.55 + i * 0.32,
        Math.sin(i * 1.7) * 0.18,
      );
      topiary.add(blob);
    }
    scene.add(topiary);

    // Frames + paintings.
    const frameMeshes: Array<{
      group: THREE.Group;
      art: Artwork;
      hitMesh: THREE.Mesh;
    }> = [];
    for (const p of placements) {
      const art = ARTWORKS.find((a) => a.id === p.artId)!;
      const tex = paintArtwork(art);

      const group = new THREE.Group();
      group.position.set(p.x, p.y, p.z);
      group.rotation.y = p.ry;
      group.rotation.z = p.tilt;

      // Frame — chunky box around the canvas.
      const frameDepth = 0.12;
      const frameThick = 0.18;
      const frameMat = new THREE.MeshStandardMaterial({
        color: p.frameColor,
        roughness: 0.55,
        metalness: 0.05,
      });
      // Build a 4-piece frame.
      const top = new THREE.Mesh(
        new THREE.BoxGeometry(p.w + frameThick * 2, frameThick, frameDepth),
        frameMat,
      );
      top.position.set(0, p.h / 2 + frameThick / 2, 0);
      const bot = top.clone();
      bot.position.set(0, -p.h / 2 - frameThick / 2, 0);
      const left = new THREE.Mesh(
        new THREE.BoxGeometry(frameThick, p.h, frameDepth),
        frameMat,
      );
      left.position.set(-p.w / 2 - frameThick / 2, 0, 0);
      const right = left.clone();
      right.position.set(p.w / 2 + frameThick / 2, 0, 0);
      group.add(top, bot, left, right);

      // Mat (cream border) + canvas with the painted texture.
      const mat = new THREE.Mesh(
        new THREE.PlaneGeometry(p.w, p.h),
        new THREE.MeshStandardMaterial({
          color: "#fffdf2",
          roughness: 0.95,
        }),
      );
      mat.position.set(0, 0, frameDepth / 2 + 0.001);
      group.add(mat);
      const canvasW = p.w * 0.86;
      const canvasH = p.h * 0.86;
      const canvasGeom = p.oval
        ? new THREE.CircleGeometry(0.5, 48).clone()
        : new THREE.PlaneGeometry(canvasW, canvasH);
      if (p.oval) {
        canvasGeom.scale(canvasW, canvasH, 1);
      }
      const canvasMesh = new THREE.Mesh(
        canvasGeom,
        new THREE.MeshStandardMaterial({
          map: tex,
          roughness: 0.85,
        }),
      );
      canvasMesh.position.set(0, 0, frameDepth / 2 + 0.003);
      canvasMesh.userData.artId = art.id;
      group.add(canvasMesh);

      // Tiny brass label below the frame.
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(p.w * 0.55, 0.18),
        new THREE.MeshStandardMaterial({
          color: "#e8b73f",
          roughness: 0.4,
          metalness: 0.4,
        }),
      );
      label.position.set(0, -p.h / 2 - frameThick - 0.22, frameDepth / 2);
      group.add(label);

      scene.add(group);
      frameMeshes.push({ group, art, hitMesh: canvasMesh });
    }

    // Floating motes (dust in sunbeams).
    const moteGeom = new THREE.BufferGeometry();
    const moteCount = 200;
    const positions = new Float32Array(moteCount * 3);
    for (let i = 0; i < moteCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * (ROOM_W - 2);
      positions[i * 3 + 1] = Math.random() * (ROOM_H - 1) + 0.5;
      positions[i * 3 + 2] = (Math.random() - 0.5) * (ROOM_D - 2);
    }
    moteGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const motes = new THREE.Points(
      moteGeom,
      new THREE.PointsMaterial({
        color: 0xfff5d0,
        size: 0.05,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    scene.add(motes);

    // Pointer-lock walking controls.
    const controls = new PointerLockControls(camera, renderer.domElement);
    controls.addEventListener("lock", () => setWalking(true));
    controls.addEventListener("unlock", () => setWalking(false));

    const keys = { w: false, a: false, s: false, d: false };
    const onKey = (e: KeyboardEvent, down: boolean) => {
      const k = e.key.toLowerCase();
      if (k === "w" || k === "arrowup") keys.w = down;
      if (k === "s" || k === "arrowdown") keys.s = down;
      if (k === "a" || k === "arrowleft") keys.a = down;
      if (k === "d" || k === "arrowright") keys.d = down;
    };
    const onDown = (e: KeyboardEvent) => onKey(e, true);
    const onUp = (e: KeyboardEvent) => onKey(e, false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);

    // Click → raycast a frame → first click zooms, second click on
    // the same artwork opens the story page.
    const raycaster = new THREE.Raycaster();
    const onClick = () => {
      if (!controls.isLocked) return;
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const meshes = frameMeshes.map((f) => f.hitMesh);
      const hit = raycaster.intersectObjects(meshes, false)[0];
      if (!hit) return;
      const id = (hit.object as THREE.Mesh).userData.artId as string;
      const art = ARTWORKS.find((a) => a.id === id);
      if (!art) return;
      const current = stateRef.current.zoomed;
      controls.unlock();
      if (current && current.id === art.id) {
        setStory(art);
        setZoomed(null);
      } else {
        setZoomed(art);
        setStory(null);
      }
    };
    renderer.domElement.addEventListener("click", onClick);

    // Resize.
    const onResize = () => {
      if (!mount) return;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    // WebXR — VR button + animation loop.
    const disposeVR = enableVR(renderer, mount, { referenceSpace: "local-floor" });

    const move = new THREE.Vector3();
    const SPEED = 3.2;
    const HALF_W = ROOM_W / 2 - 0.6;
    const HALF_D = ROOM_D / 2 - 0.6;
    let last = performance.now();

    renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (controls.isLocked) {
        move.set(0, 0, 0);
        if (keys.w) move.z -= 1;
        if (keys.s) move.z += 1;
        if (keys.a) move.x -= 1;
        if (keys.d) move.x += 1;
        if (move.lengthSq() > 0) {
          move.normalize().multiplyScalar(SPEED * dt);
          // Translate relative to camera yaw.
          controls.moveRight(move.x);
          controls.moveForward(-move.z);
          // Stay inside the room + a little offset from the
          // pedestal so you can't walk through it.
          camera.position.x = Math.max(-HALF_W, Math.min(HALF_W, camera.position.x));
          camera.position.z = Math.max(-HALF_D, Math.min(HALF_D, camera.position.z));
          const distToPedestal = Math.hypot(camera.position.x, camera.position.z);
          if (distToPedestal < 1.2) {
            const s = 1.2 / distToPedestal;
            camera.position.x *= s;
            camera.position.z *= s;
          }
          camera.position.y = EYE_HEIGHT;
        }
      }

      // gentle topiary sway + mote drift
      topiary.rotation.y += dt * 0.15;
      const pos = motes.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < moteCount; i++) {
        pos.array[i * 3 + 1] += Math.sin(now * 0.0006 + i) * 0.0006;
      }
      pos.needsUpdate = true;

      renderer.render(scene, camera);
    });

    setReady(true);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.setAnimationLoop(null);
      disposeVR();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const m = mesh.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose();
        }
      });
    };
  }, [placements]);

  // Story page navigation: prev/next within ARTWORKS order.
  const storyIndex = story ? ARTWORKS.findIndex((a) => a.id === story.id) : -1;
  const goStory = (delta: number) => {
    const next = ARTWORKS[(storyIndex + delta + ARTWORKS.length) % ARTWORKS.length];
    setStory(next);
  };

  const requestWalk = () => {
    // Click the canvas to trigger pointer lock — easier than calling
    // controls.lock() from outside the effect.
    const canvas = containerRef.current?.querySelector("canvas");
    canvas?.dispatchEvent(new MouseEvent("mousedown"));
    // PointerLockControls listens for direct interaction; we use a
    // tiny shim via the canvas focus + the user's expected click.
    (canvas as HTMLCanvasElement | undefined)?.requestPointerLock?.();
  };

  return (
    <div className="fixed inset-0 bg-[#bfeef0] text-foreground overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Top-left brand chip */}
      <div className="absolute top-14 md:top-4 left-4 z-10 pointer-events-none">
        <div className="glass-panel rounded-2xl px-3 py-2 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <div className="leading-tight">
            <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
              Edge Esmeralda
            </div>
            <div
              className="font-display text-sm font-semibold"
              style={{ fontFamily: "'Sora', sans-serif", color: "#0d3b4f" }}
            >
              Fractal Museum
            </div>
          </div>
        </div>
      </div>

      {/* Walk-in / instructions overlay */}
      <AnimatePresence>
        {ready && !walking && !zoomed && !story && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none"
          >
            <div className="pointer-events-auto bg-white/90 backdrop-blur-md rounded-3xl px-8 py-7 shadow-2xl border-4 max-w-md text-center"
              style={{ borderColor: "#0d3b4f" }}
            >
              <div
                className="font-display text-3xl mb-2"
                style={{ fontFamily: "'Sora', sans-serif", color: "#c44a1a" }}
              >
                The Fractal Museum
              </div>
              <p className="text-sm text-slate-700 mb-1">
                Open for visitors! Inside you'll find pieces of famous fractal
                art — each one very different, because each artist looked at
                fractals in their own unique way.
              </p>
              <p className="text-[11px] text-slate-500 mb-5">
                Walk with W A S D, look with the mouse. Click a painting to
                zoom in. Click again to read its rhyme. ESC to leave.
              </p>
              <div className="mb-5 inline-flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-dashed"
                style={{ borderColor: "#c44a1a", background: "#fff5e0" }}
              >
                <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">Lovable discount code</span>
                <span className="font-heading font-bold text-sm tracking-wider" style={{ color: "#c44a1a", fontFamily: "'Sora', sans-serif" }}>COMM-VIBE-EC46</span>
              </div>
              <button
                onClick={requestWalk}
                className="font-heading font-semibold px-6 py-3 rounded-xl text-white text-sm uppercase tracking-wider"
                style={{
                  background: "linear-gradient(135deg, #c44a1a, #e8b73f)",
                  boxShadow: "0 6px 20px rgba(196,74,26,0.35)",
                }}
              >
                Walk in →
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Walking HUD reticle */}
      {walking && (
        <div className="absolute inset-0 pointer-events-none z-10 flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-white/80 mix-blend-difference" />
        </div>
      )}

      {/* Zoom modal */}
      <AnimatePresence>
        {zoomed && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 bg-black/65 backdrop-blur-md flex items-center justify-center p-6"
            onClick={() => setZoomed(null)}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: "spring", stiffness: 200, damping: 22 }}
              className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full overflow-hidden"
              style={{ borderTop: `8px solid ${zoomed.frame}` }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-between items-start p-5 pb-2">
                <div>
                  <div
                    className="font-display text-2xl"
                    style={{ fontFamily: "'Sora', sans-serif", color: "#c44a1a" }}
                  >
                    {zoomed.title}
                  </div>
                  <div className="text-xs uppercase tracking-widest text-slate-500">
                    {zoomed.artist}
                  </div>
                </div>
                <button
                  onClick={() => setZoomed(null)}
                  className="text-slate-400 hover:text-slate-700 p-1"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="px-5 pb-3">
                <div
                  className="rounded-xl overflow-hidden"
                  style={{ background: zoomed.palette?.[0] ?? "#eee" }}
                >
                  <ArtworkPreview art={zoomed} />
                </div>
              </div>
              <div className="px-5 pb-5 text-sm text-slate-700">
                {zoomed.caption}
              </div>
              <div className="border-t bg-amber-50/60 px-5 py-3 flex items-center justify-end">
                <button
                  onClick={() => {
                    setStory(zoomed);
                    setZoomed(null);
                  }}
                  className="flex items-center gap-2 font-heading font-semibold text-sm uppercase tracking-wider px-4 py-2 rounded-lg text-white"
                  style={{ background: "#0d3b4f" }}
                >
                  <BookOpen className="w-4 h-4" /> Read the rhyme
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Story page */}
      <AnimatePresence>
        {story && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 flex items-center justify-center p-6"
            style={{ background: "#7fcfd0" }}
          >
            <motion.div
              key={story.id}
              initial={{ rotateY: -10, opacity: 0, x: 30 }}
              animate={{ rotateY: 0, opacity: 1, x: 0 }}
              exit={{ rotateY: 10, opacity: 0, x: -30 }}
              transition={{ type: "spring", stiffness: 180, damping: 20 }}
              className="relative bg-[#fff8e7] rounded-[28px] shadow-2xl max-w-4xl w-full p-8 md:p-12 grid grid-cols-1 md:grid-cols-2 gap-8"
              style={{ border: `6px solid ${story.frame}` }}
            >
              <button
                onClick={() => setStory(null)}
                className="absolute top-3 right-3 text-slate-500 hover:text-slate-800 p-2"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
              <div className="flex items-center justify-center">
                <div
                  className="rounded-2xl overflow-hidden shadow-lg"
                  style={{ border: `10px solid ${story.frame}` }}
                >
                  <ArtworkPreview art={story} small />
                </div>
              </div>
              <div className="flex flex-col justify-center">
                <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500 mb-1">
                  {story.artist}
                </div>
                <div
                  className="font-display text-3xl md:text-4xl mb-5 leading-none"
                  style={{ fontFamily: "'Sora', sans-serif", color: "#c44a1a" }}
                >
                  {story.title}
                </div>
                <pre
                  className="whitespace-pre-wrap font-heading text-base md:text-lg leading-relaxed text-slate-800"
                  style={{ fontFamily: "'Sora', serif" }}
                >
                  {story.rhyme}
                </pre>
              </div>
              <div className="md:col-span-2 flex items-center justify-between pt-2 border-t border-amber-200">
                <button
                  onClick={() => goStory(-1)}
                  className="flex items-center gap-1 text-sm font-heading uppercase tracking-wider text-slate-600 hover:text-slate-900"
                >
                  <ChevronLeft className="w-4 h-4" /> Prev piece
                </button>
                <button
                  onClick={() => setStory(null)}
                  className="text-xs uppercase tracking-widest text-slate-500 hover:text-slate-800"
                >
                  Back to museum
                </button>
                <button
                  onClick={() => goStory(1)}
                  className="flex items-center gap-1 text-sm font-heading uppercase tracking-wider text-slate-600 hover:text-slate-900"
                >
                  Next piece <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * 2D HTML preview of an artwork — used inside the zoom modal and the
 * story page so we don't have to mount a second WebGL context.
 * Mirrors paintArtwork() visually using a canvas ref.
 */
function ArtworkPreview({ art, small }: { art: Artwork; small?: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const tex = paintArtwork(art);
    const src = (tex.image as HTMLCanvasElement).toDataURL();
    const img = new Image();
    img.onload = () => {
      const c = ref.current;
      if (!c) return;
      c.width = img.width;
      c.height = img.height;
      c.getContext("2d")?.drawImage(img, 0, 0);
    };
    img.src = src;
  }, [art]);
  return (
    <canvas
      ref={ref}
      className={small ? "max-h-[260px] w-auto block" : "max-h-[55vh] w-auto block mx-auto"}
    />
  );
}
