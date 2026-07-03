/**
 * cardboardIsland — the kids' cardboard city, floating off the east
 * edge of Vibe City.
 *
 * Based on the real cardboard-island build: hand-painted signs,
 * kraft-paper buildings (Trader Joe's Island Outpost, Cardboard Café,
 * Ninja's Palace, the Hospital, the Wish Wall), the Dream Tree in the
 * middle, a spinning windmill, palm trees from the pirate kit, and a
 * light beam so pilots can find it from the city.
 *
 * Everything is procedural canvas textures + boxes except the palms
 * (small Quaternius GLBs). The island registers real collision boxes
 * — including its own platform — so you can land on it, walk between
 * the shops, and step off the edge for a 120 m drop into the city.
 *
 * This module is the template for adding more worlds to the city:
 * build a group, push collision boxes, return update/dispose.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import palm1Url from "@/assets/glb/kits/pirate/environment/PalmTree_1.glb";
import palm2Url from "@/assets/glb/kits/pirate/environment/PalmTree_2.glb";
import palm3Url from "@/assets/glb/kits/pirate/environment/PalmTree_3.glb";

/** Structurally matches City's BuildingBox. */
export interface WorldBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  base: number;
  height: number;
}

export interface IslandWorld {
  group: THREE.Group;
  update(dt: number, now: number): void;
  /** Sweet spots for collectible stars, in world coordinates. */
  starSpots: THREE.Vector3[];
  /** The zipline cable loop, in world coordinates. */
  zipline: { x: number; z: number; y: number; radius: number };
  /** Where Jerry the snail sits, in world coordinates. */
  jerry: THREE.Vector3;
  /** Where the SnackFe cafe counter sits, in world coordinates. */
  snackfe: THREE.Vector3;
  /** Ground point right in front of the swing — used for proximity. */
  swingMount: THREE.Vector3;
  /** The swing seat, parented to the swinging pivot. Read its world
   *  position each frame to ride along with the swing. */
  swingSeat: THREE.Object3D;
  /** Current pendulum angle in radians (signed). */
  swingAngle(): number;
  /** Feed the cardboard TV a list of photo URLs to slideshow. */
  setTvPhotos(urls: string[]): void;
  /** The shop counter (modern kiosk behind the TV), in world coordinates. */
  shop: THREE.Vector3;
  /** Vibe Maker portal — players walk up to spawn 3D shapes that save
   *  to the database and appear for everyone on the island. */
  portal: THREE.Vector3;
  /** Avatar Hologram portal — players walk up to change their character. */
  avatarPortal: THREE.Vector3;
  /** Empty group floating on the avatar portal pedestal. The City
   *  scene mounts a holographic clone of the currently-previewed
   *  character into here so the player sees themselves in the portal. */
  avatarStage: THREE.Group;
  /** Esmeralda Jump arcade cabinet — walk up to launch the game. */
  arcade: THREE.Vector3;
  /** Cardboard TV (community photo gallery) — walk up to open the holo-gallery. */
  tv: THREE.Vector3;
}

const ISLAND_RADIUS = 55;

// ------------------------------------------------------------------
// Canvas helpers — everything on the island is "drawn by hand".
// ------------------------------------------------------------------
export function cardboardTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#c8a570";
  ctx.fillRect(0, 0, S, S);
  // Corrugation lines.
  ctx.strokeStyle = "rgba(122, 92, 50, 0.22)";
  ctx.lineWidth = 1.5;
  for (let y = 0; y < S; y += 7) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(S, y);
    ctx.stroke();
  }
  // Packing-tape strips.
  ctx.fillStyle = "rgba(190, 170, 130, 0.5)";
  ctx.fillRect(0, S * 0.3, S, 9);
  ctx.fillRect(S * 0.62, 0, 9, S);
  // Kid doodles.
  const doodles = ["#e85d75", "#5db8e8", "#8cd16a", "#f2b134", "#b78ae0"];
  for (let i = 0; i < 9; i++) {
    ctx.strokeStyle = doodles[i % doodles.length];
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2.2;
    const x = (i * 73 + 20) % S;
    const y = (i * 47 + 30) % S;
    ctx.beginPath();
    if (i % 3 === 0) {
      ctx.arc(x, y, 7, 0, Math.PI * 2); // sun/flower head
    } else if (i % 3 === 1) {
      ctx.moveTo(x - 7, y + 5);
      ctx.lineTo(x, y - 7);
      ctx.lineTo(x + 7, y + 5); // little roof / mountain
    } else {
      ctx.moveTo(x - 8, y);
      ctx.quadraticCurveTo(x, y - 9, x + 8, y); // rainbow arc
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function islandGroundTexture(): THREE.CanvasTexture {
  const S = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;

  // Lush lawn base with soft mowed-stripe variation.
  ctx.fillStyle = "#79c258";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.045)" : "rgba(30,80,30,0.05)";
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(0.35);
    ctx.fillRect(-S, -S / 2 + i * (S / 14), S * 2, S / 28);
    ctx.restore();
  }
  // Mottled grass texture: soft darker blobs.
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = i % 3 ? "rgba(52,120,52,0.10)" : "rgba(150,210,110,0.12)";
    const x = (i * 131 + 40) % S;
    const y = (i * 197 + 60) % S;
    ctx.beginPath();
    ctx.ellipse(x, y, 22 + ((i * 13) % 26), 14 + ((i * 7) % 18), i, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sandy path cross with a soft edge, then crisp stepping stones on top.
  const path = (horizontal: boolean) => {
    const g = horizontal
      ? ctx.createLinearGradient(0, S / 2 - 30, 0, S / 2 + 30)
      : ctx.createLinearGradient(S / 2 - 30, 0, S / 2 + 30, 0);
    g.addColorStop(0, "rgba(226,206,164,0)");
    g.addColorStop(0.25, "rgba(226,206,164,0.95)");
    g.addColorStop(0.75, "rgba(226,206,164,0.95)");
    g.addColorStop(1, "rgba(226,206,164,0)");
    ctx.fillStyle = g;
    if (horizontal) ctx.fillRect(0, S / 2 - 30, S, 60);
    else ctx.fillRect(S / 2 - 30, 0, 60, S);
  };
  path(true);
  path(false);
  for (let i = -10; i <= 10; i++) {
    for (const [dx, dy, horiz] of [[i * 42, 0, true], [0, i * 42, false]] as const) {
      if (!horiz && Math.abs(i) < 1) continue; // don't double the center
      ctx.fillStyle = "#d3bd97";
      ctx.strokeStyle = "rgba(120,100,70,0.28)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(S / 2 + dx + (i % 2 ? 5 : -5), S / 2 + dy, horiz ? 11 : 8, horiz ? 8 : 11, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Clover flowers scattered on the lawn (kept off the paths).
  const petals = ["#ff8fae", "#ffd166", "#c9a2ff", "#ffffff"];
  for (let i = 0; i < 64; i++) {
    const x = (i * 263 + 40) % S;
    const y = (i * 389 + 60) % S;
    if (Math.abs(x - S / 2) < 60 || Math.abs(y - S / 2) < 60) continue;
    ctx.fillStyle = petals[i % petals.length];
    for (let p = 0; p < 4; p++) {
      const pa = (p / 4) * Math.PI * 2 + i;
      ctx.beginPath();
      ctx.arc(x + Math.cos(pa) * 3.2, y + Math.sin(pa) * 3.2, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#f7f3d0";
    ctx.beginPath();
    ctx.arc(x, y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function signTexture(lines: string[], bg: string, fg: string, glow = false): THREE.CanvasTexture {
  const W = 512;
  const H = 128 + lines.length * 96;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(70, 50, 25, 0.65)";
  ctx.lineWidth = 10;
  ctx.strokeRect(7, 7, W - 14, H - 14);
  ctx.font = "bold 72px 'Comic Sans MS', 'Segoe Print', 'Chalkboard SE', cursive, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = fg;
  if (glow) {
    ctx.shadowColor = fg;
    ctx.shadowBlur = 22;
  }
  lines.forEach((line, i) => {
    const y = H / 2 + (i - (lines.length - 1) / 2) * 92;
    // A tiny per-line tilt sells "kid with a paintbrush".
    ctx.save();
    ctx.translate(W / 2, y);
    ctx.rotate((i % 2 === 0 ? -1 : 1) * 0.012);
    ctx.fillText(line, 0, 0, W - 60);
    ctx.restore();
  });
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------
// Craft-pass helpers: organic landform + refined facades.
// ------------------------------------------------------------------

/** Deterministic RNG so the island's silhouette never reshuffles. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth looping noise over angle [0..2π) — shared by every landform
 * layer so the grass lip, dirt band and rock cone silhouettes match. */
function makeRimNoise(rand: () => number, amp: number, knots = 12): (a: number) => number {
  const vals = Array.from({ length: knots }, () => (rand() * 2 - 1) * amp);
  return (a: number) => {
    const t = ((a / (Math.PI * 2)) % 1 + 1) % 1 * knots;
    const i = Math.floor(t);
    const f = t - i;
    const s = f * f * (3 - 2 * f);
    return vals[i % knots] + (vals[(i + 1) % knots] - vals[i % knots]) * s;
  };
}

/** Push vertices radially in/out by rimFn(angle) — organic, not a lathe. */
function displaceRadial(geo: THREE.BufferGeometry, rimFn: (a: number) => number) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 0.01) continue;
    const s = 1 + rimFn(Math.atan2(z, x));
    p.setX(i, x * s);
    p.setZ(i, z * s);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
}

/** Clean painted facade: soft color wash, paper grain, baseboard and a
 * trim line — handmade-but-tidy, replacing the raw doodle cardboard. */
function facadeTexture(tint: string, trim: string): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, S, S);
  // Paper grain: sparse soft strokes, two tones.
  for (let i = 0; i < 46; i++) {
    ctx.strokeStyle = i % 2 ? "rgba(255,255,255,0.05)" : "rgba(60,40,20,0.05)";
    ctx.lineWidth = 1 + (i % 3);
    const y = (i * 61) % S;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(S * 0.3, y + 3, S * 0.7, y - 3, S, y);
    ctx.stroke();
  }
  // Baseboard + upper trim line.
  ctx.fillStyle = trim;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(0, S - 18, S, 18);
  ctx.globalAlpha = 0.4;
  ctx.fillRect(0, 26, S, 5);
  ctx.globalAlpha = 1;
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Fluffy poster-style cloud: a cluster of white ellipses. */
function drawPosterCloud(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, s: number, alpha = 1,
) {
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  const puffs: Array<[number, number, number, number]> = [
    [0, 0, 30, 13], [-24, 4, 20, 10], [24, 4, 21, 10], [-10, -8, 18, 10], [12, -7, 16, 9],
  ];
  for (const [dx, dy, rx, ry] of puffs) {
    ctx.beginPath();
    ctx.ellipse(x + dx * s, y + dy * s, rx * s, ry * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Poster-style floating island: rocky cone under a grassy cap. */
function drawPosterIsle(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.fillStyle = "#7a5a3e";
  ctx.beginPath();
  ctx.moveTo(x - 26 * s, y);
  ctx.lineTo(x + 26 * s, y);
  ctx.lineTo(x + 6 * s, y + 30 * s);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#66c46a";
  ctx.beginPath();
  ctx.ellipse(x, y - 3 * s, 29 * s, 9 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  // A tiny tree so it reads "alive" even from far away.
  ctx.fillStyle = "#5a3d28";
  ctx.fillRect(x - 2 * s, y - 18 * s, 4 * s, 10 * s);
  ctx.fillStyle = "#3f9a4d";
  ctx.beginPath();
  ctx.arc(x, y - 22 * s, 10 * s, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The real VibeVerse brand poster, hosted by the app itself. Crowns
 * the welcome arch and leads the TV / holo gallery rotation.
 */
export const VIBEVERSE_POSTER_URL =
  "/__l5e/assets-v1/445589ab-f974-45bf-8630-1d90a1fd8797/vibeverse-poster.png";

/**
 * Hand-drawn stand-in for the poster (3:2) shown until the real PNG
 * arrives — and forever, wherever the asset can't be fetched. Same
 * language: blue sky, pixel wordmark, clouds, floating islands.
 */
function vibeversePosterFallbackTexture(): THREE.CanvasTexture {
  const W = 768;
  const H = 512;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#2470dd");
  sky.addColorStop(0.6, "#4f9bee");
  sky.addColorStop(1, "#9fd4f8");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  drawPosterCloud(ctx, 90, 400, 1.6, 0.95);
  drawPosterCloud(ctx, 690, 370, 1.4, 0.9);
  drawPosterCloud(ctx, 620, 470, 1.8, 1);
  drawPosterCloud(ctx, 140, 480, 1.9, 1);
  drawPosterCloud(ctx, 380, 500, 2.2, 1);
  drawPosterIsle(ctx, 120, 250, 1.3);
  drawPosterIsle(ctx, 650, 230, 1.0);
  drawPosterIsle(ctx, 560, 330, 0.6);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 20px 'Sora', 'Segoe UI', ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = "#eaf5ff";
  ctx.fillText("E V E R Y   B U I L D E R   G R O W S   T H E   U N I V E R S E", W / 2, 48);

  {
    const tiny = document.createElement("canvas");
    tiny.width = 232;
    tiny.height = 46;
    const t2 = tiny.getContext("2d")!;
    t2.textAlign = "center";
    t2.textBaseline = "middle";
    t2.font = "900 30px 'Arial Black', 'Arial', sans-serif";
    t2.fillStyle = "#1a4fa0";
    t2.fillText("VIBEVERSE", 117.5, 25.5);
    t2.fillStyle = "#ffffff";
    t2.fillText("VIBEVERSE", 116, 23);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tiny, 0, 0, 232, 46, 24, 86, 720, 143);
    ctx.imageSmoothingEnabled = true;
  }

  ctx.font = "italic 600 30px Georgia, 'Times New Roman', serif";
  ctx.fillStyle = "#0f2c50";
  ctx.fillText("What kind of adventure", W / 2, 268);
  ctx.fillText("do you want today?", W / 2, 306);

  ctx.font = "700 17px 'Sora', 'Segoe UI', ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText("EXPLORE  ·  BUILD  ·  CREATE  ·  CONNECT", W / 2, 452);

  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------
// Builders
// ------------------------------------------------------------------
interface ShopSpec {
  lines: string[];
  x: number; // relative to island center
  z: number;
  w: number;
  h: number;
  d: number;
  bg: string;
  fg: string;
  sub?: { lines: string[]; bg: string; fg: string; glow?: boolean };
  cross?: boolean; // hospital
  tier?: { w: number; h: number; d: number }; // pagoda top
}

const SHOPS: ShopSpec[] = [
  {
    lines: ["TRADER", "JOE'S"],
    x: -30, z: -8, w: 15, h: 9, d: 11,
    bg: "#e8d9b8", fg: "#c0392b",
    sub: { lines: ["GOOD FOOD", "GOOD VIBES"], bg: "#10241a", fg: "#46e88c", glow: true },
  },
  {
    lines: ["NINJA'S", "PALACE"],
    x: 26, z: -18, w: 13, h: 10, d: 11,
    bg: "#7d4ea8", fg: "#f2a134",
    tier: { w: 8, h: 6, d: 7 },
  },
  // JERRY'S PLAZA is now a real plaza built around Jerry, not a building.
];

export function buildCardboardIsland(opts: {
  centerX: number;
  centerZ: number;
  topY: number;
  boxes: WorldBox[];
}): IslandWorld {
  const { centerX, centerZ, topY, boxes } = opts;
  const group = new THREE.Group();
  group.position.set(centerX, topY, centerZ); // group origin = island surface center
  const spinners: THREE.Object3D[] = [];
  const starSpots: THREE.Vector3[] = [];

  const cardboard = cardboardTexture();
  const cardboardMat = new THREE.MeshStandardMaterial({ map: cardboard, roughness: 0.92 });
  const cardboardDark = new THREE.MeshStandardMaterial({ color: "#9a7a4e", roughness: 0.95 });

  // ---- Island body (craft pass) -------------------------------------
  // An organic landform instead of a lathe: every layer shares ONE rim
  // noise so the grass lip, dirt band and rock strata line up, like the
  // island was torn out of a hillside. Per-frame anims register here.
  const craftAnims: Array<(dt: number, now: number) => void> = [];
  const landRand = mulberry32(7331);
  const landRim = makeRimNoise(landRand, 0.07);

  // Grass cap — flat walkable top, wobbly rim with a lip that overhangs
  // the dirt below. Cylinder material order is [side, top, bottom].
  const capGeo = new THREE.CylinderGeometry(ISLAND_RADIUS + 1.6, ISLAND_RADIUS - 0.6, 3.2, 56, 1);
  displaceRadial(capGeo, landRim);
  const grassSide = new THREE.MeshStandardMaterial({ color: "#5da944", roughness: 0.95, flatShading: true });
  const top = new THREE.Mesh(capGeo, [
    grassSide,
    new THREE.MeshStandardMaterial({ map: islandGroundTexture(), roughness: 0.9 }),
    grassSide,
  ]);
  top.position.y = -1.6;
  group.add(top);

  // Dirt band under the lip.
  const dirtGeo = new THREE.CylinderGeometry(ISLAND_RADIUS - 0.5, ISLAND_RADIUS - 4.5, 5.5, 56, 1);
  displaceRadial(dirtGeo, landRim);
  const dirt = new THREE.Mesh(
    dirtGeo,
    new THREE.MeshStandardMaterial({ color: "#8a6a44", roughness: 1, flatShading: true }),
  );
  dirt.position.y = -5.9;
  group.add(dirt);

  // Rock strata cone — jittered vertices for a chiselled underside.
  const rockGeo = new THREE.ConeGeometry(ISLAND_RADIUS - 4, 30, 40, 4);
  displaceRadial(rockGeo, landRim);
  {
    const p = rockGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getY(i)) > 14.6) continue; // keep the apex sharp
      const n = 0.92 + landRand() * 0.16;
      p.setX(i, p.getX(i) * n);
      p.setZ(i, p.getZ(i) * n);
    }
    p.needsUpdate = true;
    rockGeo.computeVertexNormals();
  }
  const rock = new THREE.Mesh(
    rockGeo,
    new THREE.MeshStandardMaterial({ color: "#6b5540", roughness: 1, flatShading: true }),
  );
  rock.rotation.x = Math.PI;
  rock.position.y = -23.6;
  group.add(rock);

  // Hanging roots trailing off the dirt band.
  const rootMat = new THREE.MeshStandardMaterial({ color: "#6e4f32", roughness: 1 });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + landRand();
    const len = 3 + landRand() * 5;
    const root = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.22, len, 5), rootMat);
    const rr = (ISLAND_RADIUS - 3) * (1 + landRim(a));
    root.position.set(Math.cos(a) * rr, -8.5 - len / 2, Math.sin(a) * rr);
    root.rotation.z = (landRand() - 0.5) * 0.3;
    group.add(root);
  }

  // Drifting rock shards beneath — that "torn out of the earth" look.
  const shardGeo = new THREE.IcosahedronGeometry(1, 0);
  const shardMat = new THREE.MeshStandardMaterial({ color: "#75604a", roughness: 1, flatShading: true });
  for (let i = 0; i < 8; i++) {
    const shard = new THREE.Mesh(shardGeo, shardMat);
    const a = (i / 8) * Math.PI * 2 + 0.7;
    const rr = ISLAND_RADIUS * (0.45 + landRand() * 0.5);
    const baseYS = -16 - landRand() * 14;
    shard.position.set(Math.cos(a) * rr, baseYS, Math.sin(a) * rr);
    shard.scale.setScalar(0.5 + landRand() * 1.4);
    shard.rotation.set(landRand() * 3, landRand() * 3, landRand() * 3);
    group.add(shard);
    const phase = landRand() * Math.PI * 2;
    craftAnims.push((dt, now) => {
      shard.position.y = baseYS + Math.sin(now * 0.0005 + phase) * 0.6;
      shard.rotation.y += dt * 0.08;
    });
  }

  // ---- Spring pool on the east lawn ---------------------------------
  // A calm stone-ringed pool with a soft shimmer. (It used to spill off
  // the rim as a waterfall — cut; the island reads cleaner without it.)
  {
    const POOL_X = 36, POOL_Z = 10;
    const poolMat = new THREE.MeshStandardMaterial({
      color: "#5fc4de", roughness: 0.25, metalness: 0.1,
      transparent: true, opacity: 0.9,
      emissive: "#1a4a5a", emissiveIntensity: 0.25,
    });
    const pool = new THREE.Mesh(new THREE.CircleGeometry(4.2, 28), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(POOL_X, 0.09, POOL_Z);
    group.add(pool);
    // Stone lip around the pool.
    const lipMat = new THREE.MeshStandardMaterial({ color: "#b3a68d", roughness: 0.95, flatShading: true });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), lipMat);
      stone.position.set(POOL_X + Math.cos(a) * 4.5, 0.25, POOL_Z + Math.sin(a) * 4.5);
      stone.scale.set(1, 0.6, 1);
      stone.rotation.y = a * 3;
      group.add(stone);
    }
    craftAnims.push((_dt, now) => {
      poolMat.emissiveIntensity = 0.25 + Math.sin(now * 0.0011) * 0.1;
    });
  }

  // Platform collision: horizontal strips approximating the full round
  // cap. (This used to be a single square with half-extent ~40.7 — but
  // the grass reaches ~55 and the zipline ring sits at radius 42, so
  // walking to the zipline along an axis dropped you straight through
  // visually-solid lawn. Nine strips cover the whole disc.)
  {
    const DISC_R = 54;
    const STRIPS = 9;
    const stripH = (DISC_R * 2) / STRIPS;
    for (let i = 0; i < STRIPS; i++) {
      const z0 = -DISC_R + i * stripH;
      const zm = z0 + stripH / 2;
      const halfX = Math.sqrt(Math.max(0, DISC_R * DISC_R - zm * zm));
      boxes.push({
        minX: centerX - halfX, maxX: centerX + halfX,
        minZ: centerZ + z0, maxZ: centerZ + z0 + stripH,
        base: topY - 9,
        height: topY,
      });
    }
  }

  // ---- Shops (craft pass: real architecture you can walk into) ------
  // Each shop is now four true walls with a doorway cut into the face
  // that looks at the island center, a warm lit interior with furniture,
  // a swinging bracket sign, window boxes — and per-wall collision so
  // you can actually step inside (and still land on the roof from
  // above).
  const signMats: THREE.MeshBasicMaterial[] = [];
  const WALL_T = 0.4;
  const DOOR_W = 2.2;
  const DOOR_H = 2.7;
  for (const s of SHOPS) {
    const shop = new THREE.Group();
    shop.position.set(s.x, 0, s.z);
    // Door faces the island center along the dominant axis.
    const alongX = Math.abs(s.x) > Math.abs(s.z);
    const fs = alongX ? -Math.sign(s.x) : -Math.sign(s.z); // facing sign
    // Plane fronts must point AWAY from the wall (+x face → rotY π/2,
    // -x face → -π/2; +z face → 0, -z face → π) or the text mirrors.
    const rotY = alongX ? (fs > 0 ? Math.PI / 2 : -Math.PI / 2) : fs > 0 ? 0 : Math.PI;
    // Local frame: u = facing axis (door face at u = fs*U/2), v = the other.
    const U = alongX ? s.w : s.d;
    const V = alongX ? s.d : s.w;
    const toLocal = (u: number, v: number): [number, number] =>
      alongX ? [u, v] : [v, u];

    const wallMat = new THREE.MeshStandardMaterial({
      map: facadeTexture(s.bg, s.fg),
      roughness: 0.85,
    });
    const trimMat = new THREE.MeshStandardMaterial({ color: s.fg, roughness: 0.6 });

    // A wall panel: centered at (u,v) in the local frame, sized (du,dv,h),
    // rendered AND collided so interiors are real.
    const wallBoxes: WorldBox[] = [];
    const panel = (u: number, v: number, du: number, dv: number, h: number, yBase = 0) => {
      const [lx, lz] = toLocal(u, v);
      // Sizes rotate with the frame: alongX keeps (du,dv), otherwise swap.
      const sw = alongX ? du : dv;
      const sd = alongX ? dv : du;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sw, h, sd), wallMat);
      mesh.position.set(lx, yBase + h / 2, lz);
      shop.add(mesh);
      wallBoxes.push({
        minX: centerX + s.x + lx - sw / 2, maxX: centerX + s.x + lx + sw / 2,
        minZ: centerZ + s.z + lz - sd / 2, maxZ: centerZ + s.z + lz + sd / 2,
        base: topY + yBase,
        height: topY + yBase + h,
      });
    };

    // Back wall, side walls, and the split front wall with a door gap.
    panel(-fs * (U / 2 - WALL_T / 2), 0, WALL_T, V, s.h);
    panel(0, -(V / 2 - WALL_T / 2), U - 2 * WALL_T, WALL_T, s.h);
    panel(0, +(V / 2 - WALL_T / 2), U - 2 * WALL_T, WALL_T, s.h);
    const frontU = fs * (U / 2 - WALL_T / 2);
    const segV = (V - DOOR_W) / 2 - WALL_T;
    panel(frontU, -(DOOR_W / 2 + segV / 2 + WALL_T), WALL_T, segV, s.h);
    panel(frontU, +(DOOR_W / 2 + segV / 2 + WALL_T), WALL_T, segV, s.h);
    // Header above the doorway (walk under, no jetpacking through).
    panel(frontU, 0, WALL_T, DOOR_W, s.h - DOOR_H, DOOR_H);

    // Door frame trim: posts + lintel in the accent color.
    for (const side of [-1, 1]) {
      const [px, pz] = toLocal(fs * (U / 2 - WALL_T / 2), side * (DOOR_W / 2 + 0.12));
      const post = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 0.5 : 0.28, DOOR_H + 0.15, alongX ? 0.28 : 0.5), trimMat);
      post.position.set(px, (DOOR_H + 0.15) / 2, pz);
      shop.add(post);
    }
    {
      const [lx, lz] = toLocal(fs * (U / 2 - WALL_T / 2), 0);
      const lintel = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? 0.5 : DOOR_W + 0.5, 0.3, alongX ? DOOR_W + 0.5 : 0.5),
        trimMat,
      );
      lintel.position.set(lx, DOOR_H + 0.08, lz);
      shop.add(lintel);
    }

    // Roof slab with a proper overhang + fascia trim (still landable).
    const roof = new THREE.Mesh(new THREE.BoxGeometry(s.w + 1.6, 0.5, s.d + 1.6), cardboardDark);
    roof.position.y = s.h + 0.25;
    roof.rotation.z = 0.015;
    shop.add(roof);
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(s.w + 1.75, 0.18, s.d + 1.75), trimMat);
    fascia.position.y = s.h + 0.06;
    shop.add(fascia);
    boxes.push({
      minX: centerX + s.x - s.w / 2 - 0.8, maxX: centerX + s.x + s.w / 2 + 0.8,
      minZ: centerZ + s.z - s.d / 2 - 0.8, maxZ: centerZ + s.z + s.d / 2 + 0.8,
      base: topY + s.h,
      height: topY + s.h + 0.5,
    });

    // (No awning over the door — it used to hide the facade signs.
    // The trimmed doorway alone reads as a welcoming open entrance.)

    // Warm interior: rug, counter, shelf goods, hanging lamp + light.
    {
      const rug = new THREE.Mesh(
        new THREE.CircleGeometry(Math.min(U, V) * 0.28, 24),
        new THREE.MeshStandardMaterial({ color: s.fg, roughness: 0.95, transparent: true, opacity: 0.55 }),
      );
      rug.rotation.x = -Math.PI / 2;
      rug.position.y = 0.05;
      shop.add(rug);
      const [cx2, cz2] = toLocal(-fs * (U / 2 - 1.4), 0);
      const counter = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? 1 : V * 0.5, 1.1, alongX ? V * 0.5 : 1), cardboardDark);
      counter.position.set(cx2, 0.55, cz2);
      shop.add(counter);
      const goods = ["#e85d75", "#ffd166", "#8cd16a", "#5db8e8"];
      for (let gi = 0; gi < 4; gi++) {
        const item = new THREE.Mesh(
          new THREE.BoxGeometry(0.45, 0.4, 0.45),
          new THREE.MeshStandardMaterial({ color: goods[gi], roughness: 0.7 }),
        );
        const [gx, gz] = toLocal(-fs * (U / 2 - 1.4), (gi - 1.5) * 0.7);
        item.position.set(gx, 1.35, gz);
        item.rotation.y = gi * 0.7;
        shop.add(item);
      }
      const lampCone = new THREE.Mesh(
        new THREE.ConeGeometry(0.5, 0.5, 12, 1, true),
        new THREE.MeshStandardMaterial({ color: "#2c2c34", roughness: 0.5, side: THREE.DoubleSide }),
      );
      lampCone.position.y = s.h - 0.7;
      shop.add(lampCone);
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 10, 8),
        new THREE.MeshBasicMaterial({ color: "#ffe9b8" }),
      );
      bulb.position.y = s.h - 0.85;
      shop.add(bulb);
      const glow = new THREE.PointLight(0xffd9a0, 9, Math.max(U, V) * 1.4, 1.8);
      glow.position.y = s.h - 1.1;
      shop.add(glow);
    }

    // Glowing windows with mullions + flower boxes on the side walls.
    for (const side of [-1, 1]) {
      const [wx, wz] = toLocal(0, side * (V / 2 + 0.03));
      const pane = new THREE.Mesh(
        new THREE.PlaneGeometry(2.2, 1.5),
        new THREE.MeshStandardMaterial({
          color: "#fff3cf", emissive: "#ffcf7a", emissiveIntensity: 0.85,
          roughness: 0.4, side: THREE.DoubleSide,
        }),
      );
      pane.position.set(wx, 2.2, wz);
      pane.rotation.y = alongX ? 0 : Math.PI / 2;
      shop.add(pane);
      for (const mull of [0, 1]) {
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(mull ? 2.35 : 0.1, mull ? 0.1 : 1.6, 0.08),
          trimMat,
        );
        bar.position.set(wx, 2.2, wz);
        bar.rotation.y = alongX ? 0 : Math.PI / 2;
        shop.add(bar);
      }
      const box = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 2.3 : 0.5, 0.35, alongX ? 0.5 : 2.3), cardboardDark);
      const [bx2, bz2] = toLocal(0, side * (V / 2 + 0.28));
      box.position.set(bx2, 1.3, bz2);
      shop.add(box);
      for (let f = 0; f < 3; f++) {
        const flower = new THREE.Mesh(
          new THREE.SphereGeometry(0.13, 8, 6),
          new THREE.MeshStandardMaterial({ color: ["#ff8fae", "#ffd166", "#c9a2ff"][f], roughness: 0.7 }),
        );
        const [fx, fz] = toLocal((f - 1) * 0.7, side * (V / 2 + 0.28));
        flower.position.set(fx, 1.55, fz);
        shop.add(flower);
      }
    }

    // Hanging bracket sign by the door — sways gently.
    {
      const [ax, az] = toLocal(fs * (U / 2 + 0.55), DOOR_W / 2 + 1.1);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 1.1 : 0.12, 0.12, alongX ? 0.12 : 1.1), trimMat);
      arm.position.set((alongX ? ax - fs * 0.35 : ax), DOOR_H + 1.15, alongX ? az : az - 0.35);
      shop.add(arm);
      const hanger = new THREE.Group();
      hanger.position.set(ax, DOOR_H + 1.1, az);
      const smallTex = signTexture([s.lines[0]], s.bg, s.fg);
      const smallMat = new THREE.MeshBasicMaterial({ map: smallTex, side: THREE.DoubleSide });
      signMats.push(smallMat);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.8), smallMat);
      board.position.y = -0.55;
      hanger.add(board);
      shop.add(hanger);
      const phase = Math.random() * Math.PI * 2;
      craftAnims.push((_dt, now) => {
        hanger.rotation.x = Math.sin(now * 0.0012 + phase) * 0.1;
        hanger.rotation.z = Math.cos(now * 0.0009 + phase) * 0.08;
      });
    }

    if (s.tier) {
      const tier = new THREE.Mesh(new THREE.BoxGeometry(s.tier.w, s.tier.h, s.tier.d), wallMat);
      tier.position.y = s.h + 0.5 + s.tier.h / 2;
      shop.add(tier);
      const tierRoof = new THREE.Mesh(
        new THREE.BoxGeometry(s.tier.w + 1.6, 0.5, s.tier.d + 1.6),
        cardboardDark,
      );
      tierRoof.position.y = s.h + 0.5 + s.tier.h + 0.25;
      tierRoof.rotation.z = -0.04;
      shop.add(tierRoof);
    }

    // Marquee + sub boards above the door face.
    const addBoard = (
      lines: string[], bg: string, fg: string, glow: boolean, width: number, y: number, out: number,
    ) => {
      const tex = signTexture(lines, bg, fg, glow);
      const ratio = (tex.image as HTMLCanvasElement).height / (tex.image as HTMLCanvasElement).width;
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
      signMats.push(mat);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(width, width * ratio), mat);
      const [bx, bz] = toLocal(fs * (U / 2 + out), 0);
      board.position.set(bx, y, bz);
      board.rotation.y = rotY;
      shop.add(board);
    };
    addBoard(s.lines, s.bg, s.fg, false, Math.min(s.w * 0.8, 10), s.h * 0.78, 0.14);
    if (s.sub) addBoard(s.sub.lines, s.sub.bg, s.sub.fg, s.sub.glow ?? false, 4.6, s.h * 0.42, 0.2);
    if (s.cross) {
      const crossMat = new THREE.MeshBasicMaterial({ color: "#cc3333" });
      const barA = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.4, 0.3), crossMat);
      const barB = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 0.3), crossMat);
      const cy = s.h + 1.8;
      barA.position.set(0, cy, 0);
      barB.position.set(0, cy, 0);
      shop.add(barA, barB);
    }
    group.add(shop);

    // Register the per-wall colliders (replaces the old solid body box).
    for (const wb of wallBoxes) boxes.push(wb);
    if (s.tier) {
      boxes.push({
        minX: centerX + s.x - s.tier.w / 2, maxX: centerX + s.x + s.tier.w / 2,
        minZ: centerZ + s.z - s.tier.d / 2, maxZ: centerZ + s.z + s.tier.d / 2,
        base: topY + s.h + 0.5,
        height: topY + s.h + 0.5 + s.tier.h + 0.5,
      });
      starSpots.push(new THREE.Vector3(
        centerX + s.x, topY + s.h + s.tier.h + 3, centerZ + s.z,
      ));
    }
  }

  // ---- Dream Tree --------------------------------------------------
  // Moved off the plaza so it no longer crowds the spawn camera; tucked
  // into the NE lawn between the welcome path and the snack stand.
  // Town plan: the Dream Tree anchors the SW corner of the ring.
  const TREE_X = -28;
  const TREE_Z = 20;
  const tree = new THREE.Group();
  tree.position.set(TREE_X, 0, TREE_Z);
  tree.rotation.y = Math.atan2(-TREE_X, -TREE_Z); // sign faces the plaza
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.4, 9, 10),
    new THREE.MeshStandardMaterial({ color: "#7a5230", roughness: 0.9 }),
  );
  trunk.position.y = 4.5;
  tree.add(trunk);
  const leafMat = new THREE.MeshStandardMaterial({ color: "#4a9e58", roughness: 0.85 });
  [
    [0, 10.5, 0, 4.2],
    [-2.6, 9, 1.4, 2.8],
    [2.4, 9.4, -1.2, 3.0],
  ].forEach(([x, y, z, r]) => {
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leafMat);
    blob.position.set(x, y, z);
    tree.add(blob);
  });
  const treeSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5.5, 2.4),
    new THREE.MeshBasicMaterial({ map: signTexture(["DREAM TREE"], "#f2e2b8", "#3a7a4a"), side: THREE.DoubleSide }),
  );
  treeSign.position.set(0, 6.4, 1.8);
  tree.add(treeSign);
  group.add(tree);
  starSpots.push(new THREE.Vector3(centerX + TREE_X, topY + 14.5, centerZ + TREE_Z));

  // ---- Welcome sign ------------------------------------------------
  // A big hand-painted arch on the north side of the plaza: greets
  // visitors with "WELCOME TO THE CITY OF CARDBOARD WHATEVER" and a
  // smaller tagline locating us in the wider Galaxy of Creative
  // Whatever. Two chunky posts hold the stacked boards.
  const welcome = new THREE.Group();
  welcome.position.set(0, 0, -18);
  [-7, 7].forEach((px) => {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.28, 8.6, 10),
      cardboardDark,
    );
    post.position.set(px, 4.3, 0);
    welcome.add(post);
    // Crayon-stripe wrap so the posts feel kid-painted.
    const wrap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.24, 0.5, 10),
      new THREE.MeshStandardMaterial({ color: px < 0 ? "#ff6b6b" : "#2f7ad9", roughness: 0.7 }),
    );
    wrap.position.set(px, 1.0, 0);
    welcome.add(wrap);
  });
  // BIG headline: the REAL VibeVerse poster crowning the arch (3:2,
  // same proportions as the artwork). Starts on the hand-drawn
  // fallback and swaps to the hosted PNG the moment it loads — so it
  // shows the actual brand image in production and never goes black.
  {
    const posterMat = new THREE.MeshBasicMaterial({
      map: vibeversePosterFallbackTexture(),
      side: THREE.DoubleSide,
    });
    new THREE.TextureLoader().load(
      VIBEVERSE_POSTER_URL,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        posterMat.map = tex;
        posterMat.needsUpdate = true;
      },
      undefined,
      () => { /* offline / asset missing → keep the fallback */ },
    );
    // Poster floats 6cm proud of its backer — anything closer
    // z-fights and shimmers at distance.
    const marquee = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 7), posterMat);
    marquee.position.set(0, 10.85, 0.06); // bottom sits just above the bunting
    welcome.add(marquee);
    const marqueeBacker = new THREE.Mesh(
      new THREE.BoxGeometry(10.8, 7.3, 0.15),
      cardboardDark,
    );
    marqueeBacker.position.set(0, 10.85, -0.12);
    welcome.add(marqueeBacker);
  }
  const boards: Array<{ lines: string[]; y: number; w: number; h: number; bg: string; fg: string; glow?: boolean }> = [
    // Sub-banner: locate us in the wider story.
    { lines: ["inspired by the creative galaxy of whatever"], y: 5.1, w: 13, h: 1.8, bg: "#cfe6c2", fg: "#1f5fa8" },
    // Tiny rules-of-the-road slat.
    { lines: ["be kind · reuse · dream big"], y: 2.6, w: 10, h: 1.4, bg: "#ffd9a0", fg: "#5a3a1a" },
  ];
  boards.forEach((b) => {
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(b.w, b.h),
      new THREE.MeshBasicMaterial({
        map: signTexture(b.lines, b.bg, b.fg, b.glow),
        side: THREE.DoubleSide,
      }),
    );
    // 6cm off the backer face — coplanar boards z-fight and shimmer.
    board.position.set(0, b.y, 0.06);
    welcome.add(board);
    // Slim cardboard frame behind each board for depth.
    const backer = new THREE.Mesh(
      new THREE.BoxGeometry(b.w + 0.3, b.h + 0.3, 0.15),
      cardboardDark,
    );
    backer.position.set(0, b.y, -0.12);
    welcome.add(backer);
  });
  // Little rainbow bunting strung between the posts, just under the
  // headline — echoes the real-world arch in the reference photo.
  const buntingColors = ["#ff5b5b", "#ff9f43", "#ffd166", "#1ec96b", "#1f7be0", "#9b4bd6"];
  for (let i = 0; i < 14; i++) {
    const t = i / 13;
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.9),
      new THREE.MeshStandardMaterial({ color: buntingColors[i % buntingColors.length], roughness: 0.8, side: THREE.DoubleSide }),
    );
    // Catenary droop between posts.
    const x = THREE.MathUtils.lerp(-6.6, 6.6, t);
    const sag = Math.sin(t * Math.PI) * 0.5;
    flag.position.set(x, 7.2 - sag, 0.12);
    flag.rotation.z = (0.5 - t) * 0.3;
    welcome.add(flag);
  }
  group.add(welcome);

  // (The standalone poster easel that used to sit beside the arch is
  // gone — the real poster now crowns the welcome arch itself.)

  // (The floating "vibe and build" billboard that hovered over Ninja's
  // Palace is gone — it sat in a weird spot and read as a black slab
  // from across the plaza. The VibeVerse marquee on the welcome arch
  // is the brand sign now.)

  // ---- Windmill ----------------------------------------------------
  const mill = new THREE.Group();
  // Town plan: the windmill is a NE-rim landmark behind Ninja's Palace
  // now — it used to spin right at the plaza's edge.
  const MILL_X = 40;
  const MILL_Z = -26;
  mill.position.set(MILL_X, 0, MILL_Z);
  const towerH = 15;
  const tower = new THREE.Mesh(new THREE.BoxGeometry(4.5, towerH, 4.5), cardboardMat);
  tower.position.y = towerH / 2;
  mill.add(tower);
  const hub = new THREE.Group();
  hub.position.set(0, towerH + 1, 2.6);
  const bladeMat = new THREE.MeshStandardMaterial({
    color: "#e8e0c8",
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 7.5), bladeMat);
    blade.position.y = 0; // pivot at hub; offset via geometry translate
    blade.geometry.translate(0, 4.4, 0);
    blade.rotation.z = (i * Math.PI) / 2;
    hub.add(blade);
  }
  mill.add(hub);
  spinners.push(hub);
  group.add(mill);
  boxes.push({
    minX: centerX + MILL_X - 2.25, maxX: centerX + MILL_X + 2.25,
    minZ: centerZ + MILL_Z - 2.25, maxZ: centerZ + MILL_Z + 2.25,
    base: topY,
    height: topY + towerH,
  });

  // ---- Paper lantern + palms + beacon -------------------------------
  const lantern = new THREE.Mesh(
    new THREE.SphereGeometry(1.4, 14, 14),
    new THREE.MeshStandardMaterial({
      color: "#f2762a",
      emissive: "#f2762a",
      emissiveIntensity: 0.9,
      roughness: 0.6,
    }),
  );
  lantern.position.set(-21, 11, 12);
  group.add(lantern);
  // Warm pool of light so the island stays welcoming after dark.
  const lanternLight = new THREE.PointLight(0xf2a25c, 55, 70, 1.7);
  lanternLight.position.set(-8, 14, 6);
  group.add(lanternLight);

  const loader = new GLTFLoader();
  [palm1Url, palm2Url, palm3Url].forEach((url, i) => {
    loader.load(url, (gltf) => {
      const palm = gltf.scene;
      palm.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const std = mesh.material as THREE.MeshStandardMaterial;
        if (std && "metalness" in std) {
          std.metalness = Math.min(std.metalness, 0.2);
          std.roughness = Math.max(std.roughness, 0.6);
        }
      });
      const box = new THREE.Box3().setFromObject(palm);
      const size = new THREE.Vector3();
      box.getSize(size);
      const fit = 9 / Math.max(size.x, size.y, size.z, 0.0001);
      // Two clones of each variant, ringed around the island edge.
      for (let c = 0; c < 2; c++) {
        const inst = palm.clone();
        const a = ((i * 2 + c) / 6) * Math.PI * 2 + 0.4;
        inst.scale.setScalar(fit * (0.85 + ((i + c) % 3) * 0.12));
        inst.position.set(Math.cos(a) * (ISLAND_RADIUS - 7), 0, Math.sin(a) * (ISLAND_RADIUS - 7));
        inst.rotation.y = a * 2.3;
        group.add(inst);
      }
    });
  });

  // ---- The Firewall ---------------------------------------------------
  // A literal wall of fire, kid-style: painted cardboard with FIREWALL
  // across the top and a row of flickering flame cones along the edge.
  // No collision — you're meant to jetpack straight through it.
  const firewall = new THREE.Group();
  // Town plan: the firewall burns on the west ring north of Trader
  // Joe's, facing the plaza — rim art instead of mid-lawn clutter.
  firewall.position.set(-34, 0, -20);
  firewall.rotation.y = Math.atan2(34, 20);
  {
    const tex = (() => {
      const c = document.createElement("canvas");
      c.width = 512;
      c.height = 192;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#c8a570";
      ctx.fillRect(0, 0, 512, 192);
      const colors = ["#e03e1f", "#f2762a", "#ffc02e"];
      colors.forEach((col, layer) => {
        ctx.fillStyle = col;
        const h = 130 - layer * 38;
        ctx.beginPath();
        ctx.moveTo(0, 192);
        for (let x = 0; x <= 512; x += 32) {
          ctx.lineTo(x + 16, 192 - h - (x * 7919 % 23));
          ctx.lineTo(x + 32, 192);
        }
        ctx.closePath();
        ctx.fill();
      });
      ctx.font = "bold 52px 'Comic Sans MS', 'Segoe Print', cursive, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#5a2410";
      ctx.fillText("FIREWALL", 256, 44);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(10, 3.4, 0.5),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }),
    );
    wall.position.y = 1.7;
    firewall.add(wall);
  }
  const firewallFlames: THREE.Mesh[] = [];
  const fireMat = new THREE.MeshBasicMaterial({
    color: "#ff8a2a",
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (let i = 0; i < 8; i++) {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.4, 6), fireMat);
    flame.position.set(-4.4 + i * 1.26, 3.8, 0);
    firewall.add(flame);
    firewallFlames.push(flame);
  }
  group.add(firewall);

  // ---- The swing -------------------------------------------------------
  // Town plan: the swing lives on the NW rim now, turned to face the
  // open ocean — swinging out over the edge of the world.
  const SWING_X = -30;
  const SWING_Z = -28;
  const swing = new THREE.Group();
  swing.position.set(SWING_X, 0, SWING_Z);
  swing.rotation.y = Math.atan2(SWING_X, SWING_Z); // face outward, away from the plaza
  {
    const legGeo = new THREE.CylinderGeometry(0.12, 0.16, 3.8, 8);
    [-1.3, 1.3].forEach((x) => {
      [-0.5, 0.5].forEach((tilt) => {
        const leg = new THREE.Mesh(legGeo, cardboardDark);
        leg.position.set(x, 1.8, tilt * 0.7);
        leg.rotation.x = tilt * 0.36;
        swing.add(leg);
      });
    });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.9, 8), cardboardDark);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 3.5;
    swing.add(bar);
  }
  const swingPivot = new THREE.Group();
  swingPivot.position.y = 3.5;
  {
    const ropeGeo = new THREE.CylinderGeometry(0.035, 0.035, 2.5, 6);
    const ropeMat = new THREE.MeshStandardMaterial({ color: "#a8835a", roughness: 0.95 });
    [-0.45, 0.45].forEach((x) => {
      const rope = new THREE.Mesh(ropeGeo, ropeMat);
      rope.position.set(x, -1.25, 0);
      swingPivot.add(rope);
    });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.09, 0.42), cardboardMat);
    seat.position.y = -2.52;
    swingPivot.add(seat);
  }
  // Marker that rides with the seat — child positioned just above it
  // so a player parented/snapped here sits naturally on the plank.
  const swingSeatMarker = new THREE.Object3D();
  swingSeatMarker.position.y = -2.45;
  swingPivot.add(swingSeatMarker);
  swing.add(swingPivot);
  group.add(swing);
  let currentSwingAngle = 0;

  // ---- Jerry's Plaza ----------------------------------------------------
  // A real cardboard plaza built AROUND Jerry — modeled after the kids'
  // hand-painted reference: green-painted base, white cross paths, a blue
  // lily pond, planters of vines, benches, lanterns, and a JERRY'S PLAZA
  // archway you walk through to enter.
  const PLAZA_CX = 0;
  const PLAZA_CZ = 0;
  const PLAZA_R = 11; // plaza disk radius

  const plazaGroup = new THREE.Group();
  plazaGroup.position.set(PLAZA_CX, 0, PLAZA_CZ);

  // Painted green base disk (the cardboard pad).
  const plazaPadTex = (() => {
    const S = 512;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const ctx = c.getContext("2d")!;
    // Green paint with brushy variation.
    ctx.fillStyle = "#3f8c45";
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = "rgba(70, 160, 80, 0.55)";
    for (let i = 0; i < 80; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      ctx.beginPath();
      ctx.ellipse(x, y, 18 + Math.random() * 30, 8 + Math.random() * 16, Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // White cross paths.
    ctx.fillStyle = "#f1ecdd";
    ctx.fillRect(S * 0.42, 0, S * 0.16, S);
    ctx.fillRect(0, S * 0.42, S, S * 0.16);
    // Painted speckles (confetti dots).
    const dots = ["#e85d75", "#ffd166", "#5db8e8", "#b78ae0", "#ffffff"];
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = dots[i % dots.length];
      ctx.beginPath();
      ctx.arc(Math.random() * S, Math.random() * S, 2 + Math.random() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Blue pond.
    ctx.fillStyle = "#7fc8e8";
    ctx.beginPath();
    ctx.ellipse(S * 0.74, S * 0.28, 34, 24, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#4aa6d8";
    ctx.beginPath();
    ctx.ellipse(S * 0.76, S * 0.30, 16, 10, 0.3, 0, Math.PI * 2);
    ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const plazaPad = new THREE.Mesh(
    new THREE.CylinderGeometry(PLAZA_R, PLAZA_R, 0.18, 48),
    [
      new THREE.MeshStandardMaterial({ color: "#9a7a4e", roughness: 0.95 }), // side (cardboard edge)
      new THREE.MeshStandardMaterial({ map: plazaPadTex, roughness: 0.9 }),  // top
      new THREE.MeshStandardMaterial({ color: "#9a7a4e", roughness: 0.95 }), // bottom
    ],
  );
  plazaPad.position.y = 0.09;
  plazaGroup.add(plazaPad);

  // Low cardboard planter wall around the rim (segments, with gaps for paths).
  {
    const seg = 24;
    const wallMat = new THREE.MeshStandardMaterial({ map: cardboard, roughness: 0.95 });
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      // Leave 4 gaps aligned with the cross paths (N/S/E/W).
      const nearAxis =
        Math.min(
          Math.abs(((a + Math.PI / 2) % Math.PI) - Math.PI / 2),
          Math.abs((a % Math.PI) - Math.PI / 2),
        );
      if (nearAxis < 0.18) continue;
      const segLen = (Math.PI * 2 * PLAZA_R) / seg - 0.25;
      const w = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.7, segLen),
        wallMat,
      );
      w.position.set(Math.cos(a) * PLAZA_R, 0.45, Math.sin(a) * PLAZA_R);
      w.rotation.y = -a + Math.PI / 2;
      plazaGroup.add(w);
    }
  }

  // Flower-pot planters around the perimeter.
  {
    const potCount = 8;
    for (let i = 0; i < potCount; i++) {
      const a = (i / potCount) * Math.PI * 2 + 0.2;
      const r = PLAZA_R - 1.2;
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.42, 0.85, 12),
        new THREE.MeshStandardMaterial({ color: "#c0683a", roughness: 0.85 }),
      );
      pot.position.set(Math.cos(a) * r, 0.55, Math.sin(a) * r);
      plazaGroup.add(pot);
      // Foliage tuft.
      const tuftColor = ["#5aa84a", "#7cc46a", "#46a886"][i % 3];
      const tuft = new THREE.Mesh(
        new THREE.SphereGeometry(0.65, 12, 10),
        new THREE.MeshStandardMaterial({ color: tuftColor, roughness: 0.9 }),
      );
      tuft.position.set(Math.cos(a) * r, 1.25, Math.sin(a) * r);
      tuft.scale.set(1, 0.75, 1);
      plazaGroup.add(tuft);
      // Tiny flowers.
      const flowerColors = ["#e85d75", "#ffd166", "#b78ae0", "#ffffff"];
      for (let f = 0; f < 4; f++) {
        const flower = new THREE.Mesh(
          new THREE.SphereGeometry(0.12, 6, 6),
          new THREE.MeshBasicMaterial({ color: flowerColors[(i + f) % flowerColors.length] }),
        );
        const fa = (f / 4) * Math.PI * 2;
        flower.position.set(
          Math.cos(a) * r + Math.cos(fa) * 0.45,
          1.55,
          Math.sin(a) * r + Math.sin(fa) * 0.45,
        );
        plazaGroup.add(flower);
      }
    }
  }

  // Benches facing Jerry, on the diagonals.
  {
    const benchMat = new THREE.MeshStandardMaterial({ map: cardboard, roughness: 0.92 });
    const diagonals = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
    diagonals.forEach((a) => {
      const r = PLAZA_R - 2.6;
      const bx = Math.cos(a) * r;
      const bz = Math.sin(a) * r;
      const bench = new THREE.Group();
      bench.position.set(bx, 0, bz);
      bench.rotation.y = -a + Math.PI / 2; // face center
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.18, 0.7), benchMat);
      seat.position.y = 0.65;
      bench.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 0.12), benchMat);
      back.position.set(0, 1.0, -0.3);
      bench.add(back);
      [-0.95, 0.95].forEach((lx) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.65, 0.6), cardboardDark);
        leg.position.set(lx, 0.33, 0);
        bench.add(leg);
      });
      plazaGroup.add(bench);
    });
  }

  // Lily pond (raised, animated ripple via shader-free vertical offset).
  const pondGroup = new THREE.Group();
  pondGroup.position.set(6.5, 0, -5);
  {
    const pondRim = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.22, 10, 32),
      new THREE.MeshStandardMaterial({ color: "#a8835a", roughness: 0.9 }),
    );
    pondRim.rotation.x = Math.PI / 2;
    pondRim.position.y = 0.22;
    pondGroup.add(pondRim);
    const pondWater = new THREE.Mesh(
      new THREE.CircleGeometry(1.55, 32),
      new THREE.MeshStandardMaterial({
        color: "#4aa6d8",
        transparent: true,
        opacity: 0.92,
        roughness: 0.3,
        metalness: 0.2,
      }),
    );
    pondWater.rotation.x = -Math.PI / 2;
    pondWater.position.y = 0.24;
    pondGroup.add(pondWater);
    // Lily pads.
    [0.5, -0.6, 0.2].forEach((px, i) => {
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(0.32, 12),
        new THREE.MeshStandardMaterial({ color: "#4f9a4a", roughness: 0.85 }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(px, 0.26, [-0.4, 0.3, 0.7][i]);
      pondGroup.add(pad);
    });
  }
  plazaGroup.add(pondGroup);

  // JERRY'S PLAZA archway — kids' painted cardboard sign on two posts at the south entrance.
  {
    const archGroup = new THREE.Group();
    // West path entrance — rotated 90° from the south so the sign no
    // longer blocks the spawn camera's view of the player.
    archGroup.position.set(-(PLAZA_R + 0.3), 0, 0);
    archGroup.rotation.y = Math.PI / 2;
    const postMat = new THREE.MeshStandardMaterial({ map: cardboard, roughness: 0.95 });
    [-2.4, 2.4].forEach((px) => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.45, 5, 0.45), postMat);
      post.position.set(px, 2.5, 0);
      archGroup.add(post);
    });
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(5.4, 1.8),
      new THREE.MeshBasicMaterial({
        map: signTexture(["JERRY'S", "PLAZA"], "#d9c081", "#1f4ba0"),
        side: THREE.DoubleSide,
      }),
    );
    sign.position.set(0, 4.5, 0);
    archGroup.add(sign);
    // Cardboard "beam" on top.
    const beamTop = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.35, 0.45), postMat);
    beamTop.position.set(0, 5.45, 0);
    archGroup.add(beamTop);
    plazaGroup.add(archGroup);
  }

  // Paper lanterns on the planter wall — gentle glow at night.
  const plazaLanterns: THREE.Mesh[] = [];
  {
    const lanternPositions = [
      Math.PI / 4,
      (3 * Math.PI) / 4,
      (5 * Math.PI) / 4,
      (7 * Math.PI) / 4,
    ];
    lanternPositions.forEach((a) => {
      const r = PLAZA_R + 0.1;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.09, 2.6, 8),
        cardboardDark,
      );
      pole.position.set(Math.cos(a) * r, 1.3, Math.sin(a) * r);
      plazaGroup.add(pole);
      const lantern = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 14, 10),
        new THREE.MeshBasicMaterial({ color: "#ffd98a" }),
      );
      lantern.position.set(Math.cos(a) * r, 2.55, Math.sin(a) * r);
      plazaGroup.add(lantern);
      plazaLanterns.push(lantern);
    });
  }

  group.add(plazaGroup);

  // ---- Snails of Jerry's Plaza -----------------------------------------
  // Mayor Jerry sits on a red mayor's chair at the plaza center. Ben — a
  // slightly bigger snail with a different paint job — hangs out nearby.
  const allStalks: THREE.Mesh[] = [];
  const snailGroups: THREE.Group[] = [];

  const buildSnail = (opts: {
    name: string;
    pos: [number, number, number];
    rotY: number;
    scale: number;
    bodyColor: string;
    shellBase: string;
    shellSpiral: string;
    signFill: string;
    signInk: string;
  }) => {
    const g = new THREE.Group();
    g.position.set(opts.pos[0], opts.pos[1], opts.pos[2]);
    g.rotation.y = opts.rotY;
    g.scale.setScalar(opts.scale);
    const bodyMat = new THREE.MeshStandardMaterial({ color: opts.bodyColor, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), bodyMat);
    body.scale.set(1.5, 0.55, 0.75);
    body.position.y = 0.55;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.48, 14, 12), bodyMat);
    head.position.set(1.25, 1.05, 0);
    g.add(head);
    const shellTex = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = opts.shellBase;
      ctx.fillRect(0, 0, 256, 256);
      ctx.strokeStyle = opts.shellSpiral;
      ctx.lineWidth = 10;
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 7; a += 0.1) {
        const r = 4 + a * 5.4;
        const x = 128 + Math.cos(a) * r;
        const y = 128 + Math.sin(a) * r;
        if (a === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 18, 14),
      new THREE.MeshStandardMaterial({ map: shellTex, roughness: 0.75 }),
    );
    shell.position.set(-0.5, 1.5, 0);
    shell.rotation.z = 0.25;
    g.add(shell);
    [-0.22, 0.22].forEach((z) => {
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.75, 6), bodyMat);
      stalk.position.set(1.45, 1.65, z);
      stalk.rotation.z = -0.25;
      g.add(stalk);
      allStalks.push(stalk);
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 10, 8),
        new THREE.MeshBasicMaterial({ color: "#ffffff" }),
      );
      eye.position.set(1.55, 2.05, z);
      g.add(eye);
      const pupil = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 8, 6),
        new THREE.MeshBasicMaterial({ color: "#1a1a1a" }),
      );
      pupil.position.set(1.68, 2.07, z);
      g.add(pupil);
    });
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.42),
      new THREE.MeshBasicMaterial({
        map: signTexture([opts.name], opts.signFill, opts.signInk),
        side: THREE.DoubleSide,
      }),
    );
    sign.position.set(0.68, 1.55, 0);
    sign.rotation.y = Math.PI / 2;
    g.add(sign);
    group.add(g);
    snailGroups.push(g);
    return g;
  };

  // Mayor's red chair — a chunky cardboard throne behind Jerry. Static
  // (doesn't wiggle with him), positioned so the seat tucks under his
  // body and the tall backrest rises behind his shell.
  const JERRY_ROT_Y = Math.PI + 0.5;
  {
    const chair = new THREE.Group();
    chair.position.set(PLAZA_CX, 0, PLAZA_CZ);
    chair.rotation.y = JERRY_ROT_Y;
    const redSeat = new THREE.MeshStandardMaterial({ color: "#c62828", roughness: 0.7 });
    const redBack = new THREE.MeshStandardMaterial({ color: "#a91e1e", roughness: 0.7 });
    const trim = new THREE.MeshStandardMaterial({ color: "#f1c948", roughness: 0.6 });
    // Seat slab, tucked slightly back so Jerry's body rests on top.
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.45, 2.2), redSeat);
    seat.position.set(-0.2, 0.42, 0);
    chair.add(seat);
    // Four stubby legs.
    [[-1.1, -0.95], [-1.1, 0.95], [0.7, -0.95], [0.7, 0.95]].forEach(([x, z]) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.42, 0.28), redBack);
      leg.position.set(x, 0.21, z);
      chair.add(leg);
    });
    // Tall backrest behind Jerry's shell.
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.4, 2.3), redBack);
    back.position.set(-1.4, 1.9, 0);
    chair.add(back);
    // Gold crown trim on top of the backrest.
    const crown = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 2.5), trim);
    crown.position.set(-1.4, 3.7, 0);
    chair.add(crown);
    [-0.9, 0, 0.9].forEach((z) => {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 4), trim);
      spike.position.set(-1.4, 4.05, z);
      chair.add(spike);
    });
    // Armrests.
    [-1.05, 1.05].forEach((z) => {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.3, 0.28), redBack);
      arm.position.set(-0.2, 1.0, z);
      chair.add(arm);
    });
    group.add(chair);
  }

  // Jerry — the mayor. Sits on the chair (raised slightly so his slug
  // body rests on the seat slab).
  const jerryGroup = buildSnail({
    name: "JERRY",
    pos: [PLAZA_CX, 0.62, PLAZA_CZ],
    rotY: JERRY_ROT_Y,
    scale: 1,
    bodyColor: "#d9c36b",
    shellBase: "#c08a4e",
    shellSpiral: "#6a4520",
    signFill: "#eaa7c0",
    signInk: "#6a2c42",
  });

  // Ben — slightly bigger, cooler color palette, parked off to the side
  // of the plaza so he doesn't crowd the mayor.
  const BEN_X = PLAZA_CX + 5.2;
  const BEN_Z = PLAZA_CZ + 3.8;
  const BEN_ROT_Y = Math.PI + 1.2;
  const benGroup = buildSnail({
    name: "BEN",
    pos: [BEN_X, 0.18, BEN_Z],
    rotY: BEN_ROT_Y,
    scale: 0.35,
    bodyColor: "#9bc46b",
    shellBase: "#4e7fc0",
    shellSpiral: "#20406a",
    signFill: "#c5e1a5",
    signInk: "#2c5a2c",
  });

  // Collision: chair + Jerry footprint (a bit wider to cover the throne),
  // and Ben's larger footprint.
  {
    const JR = 2.2;
    const JH = 4.4; // includes chair backrest
    boxes.push({
      minX: centerX + PLAZA_CX - JR,
      maxX: centerX + PLAZA_CX + JR,
      minZ: centerZ + PLAZA_CZ - JR,
      maxZ: centerZ + PLAZA_CZ + JR,
      base: topY,
      height: topY + JH,
    });
    const BR = 2.2 * 1.25;
    const BH = 2.6 * 1.25;
    boxes.push({
      minX: centerX + BEN_X - BR,
      maxX: centerX + BEN_X + BR,
      minZ: centerZ + BEN_Z - BR,
      maxZ: centerZ + BEN_Z + BR,
      base: topY,
      height: topY + BH,
    });
  }
  // Preserve legacy alias for the wiggle animation below.
  const jerryParts = { stalks: allStalks };

  // ---- Cardboard TV: the island photo gallery ---------------------------
  // Town plan: the TV sits on the east ring by the spring pool, part
  // of the SE hangout corner (it used to crowd the plaza lawn).
  const TV_X = 30;
  const TV_Z = 22;
  const tv = new THREE.Group();
  tv.position.set(TV_X, 0, TV_Z);
  tv.rotation.y = Math.atan2(0 - TV_X, 0 - TV_Z); // screen faces the plaza center
  const tvTextures: THREE.Texture[] = [];
  let tvIndex = 0;
  let tvTimer = 0;
  const tvFallback = (() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 320;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#101418";
    ctx.fillRect(0, 0, 512, 320);
    const bars = ["#2dd4a8", "#ffd166", "#e85d75", "#5db8e8", "#b78ae0"];
    bars.forEach((b, i) => {
      ctx.fillStyle = b;
      ctx.fillRect(26 + i * 95, 190, 70, 90);
    });
    ctx.font = "bold 54px 'Comic Sans MS', 'Segoe Print', cursive, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#baffe9";
    ctx.fillText("VIBE TV", 256, 90);
    ctx.font = "26px sans-serif";
    ctx.fillStyle = "#8aa";
    ctx.fillText("tuning the village photo feed…", 256, 145);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const tvScreenMat = new THREE.MeshBasicMaterial({ map: tvFallback });
  {
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 3.1, 0.7), cardboardMat);
    body.position.y = 2.5;
    tv.add(body);
    // Screen sits 10cm proud of the cabinet face — 3cm used to
    // z-fight against the box and flicker from across the plaza.
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.3), tvScreenMat);
    screen.position.set(0, 2.5, 0.45);
    tv.add(screen);
    [-1.5, 1.5].forEach((x) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1, 8), cardboardDark);
      leg.position.set(x, 0.5, 0);
      tv.add(leg);
    });
    [-0.4, 0.4].forEach((tilt) => {
      const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), cardboardDark);
      antenna.position.set(tilt * 1.2, 4.7, 0);
      antenna.rotation.z = tilt;
      tv.add(antenna);
    });
  }
  group.add(tv);

  // ---- Vibe Shop: a modern neon kiosk on the south ring ---------------
  // Sleek dark counter with mint signage. Player walks up to it from
  // the back-island side; proximity opens the shop dialog in /city.
  // Sits just to the right of SnackFae (from a player approaching the counter)
  // so you can see both at once when you walk up to grab a snack.
  const SHOP_X = 5;
  const SHOP_Z = 35;
  {
    const shopGroup = new THREE.Group();
    shopGroup.position.set(SHOP_X, 0, SHOP_Z);
    shopGroup.rotation.y = Math.PI; // counter faces -Z, same as SnackFae, toward island center

  const shopBody = new THREE.MeshStandardMaterial({ color: "#10141c", roughness: 0.4, metalness: 0.35 });
  const shopMint = new THREE.MeshStandardMaterial({
    color: "#2dd4a8",
    emissive: "#2dd4a8",
    emissiveIntensity: 1.4,
    roughness: 0.3,
  });
  const shopMagenta = new THREE.MeshStandardMaterial({
    color: "#e85d75",
    emissive: "#e85d75",
    emissiveIntensity: 1.2,
    roughness: 0.3,
  });
  // Counter
  const shopCounter = new THREE.Mesh(new THREE.BoxGeometry(5.2, 1.1, 1.8), shopBody);
  shopCounter.position.set(0, 0.55, 0);
  shopGroup.add(shopCounter);
  // Mint edge strip across the front of the counter
  const edge = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.08, 0.06), shopMint);
  edge.position.set(0, 0.5, 0.92);
  shopGroup.add(edge);
  // Back display wall
  const wall = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.0, 0.18), shopBody);
  wall.position.set(0, 2.6, -0.85);
  shopGroup.add(wall);
  // Awning roof
  const roof = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.18, 2.2), shopBody);
  roof.position.set(0, 4.15, 0);
  shopGroup.add(roof);
  // Roof underside neon strip
  const roofGlow = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.04, 0.08), shopMagenta);
  roofGlow.position.set(0, 4.04, 0.6);
  shopGroup.add(roofGlow);
  // Two display shelves on the back wall
  for (let i = 0; i < 2; i++) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.06, 0.5), shopBody);
    shelf.position.set(0, 2.0 + i * 1.0, -0.55);
    shopGroup.add(shelf);
  }
  // Floating "SHOP" sign (canvas texture)
  const signCanvas = document.createElement("canvas");
  signCanvas.width = 512;
  signCanvas.height = 128;
  const sctx = signCanvas.getContext("2d")!;
  sctx.fillStyle = "rgba(15, 18, 28, 0)";
  sctx.fillRect(0, 0, 512, 128);
  sctx.font = "bold 88px system-ui, sans-serif";
  sctx.textAlign = "center";
  sctx.textBaseline = "middle";
  sctx.shadowColor = "#2dd4a8";
  sctx.shadowBlur = 36;
  sctx.fillStyle = "#baffe9";
  sctx.fillText("VIBE SHOP", 256, 64);
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 0.9),
    new THREE.MeshBasicMaterial({ map: signTex, transparent: true, depthWrite: false }),
  );
  sign.position.set(0, 4.6, -0.7);
  shopGroup.add(sign);
  // Soft uplight inside the kiosk
  const shopLight = new THREE.PointLight(0x2dd4a8, 22, 14, 2);
  shopLight.position.set(0, 2.4, 0.3);
  shopGroup.add(shopLight);
  // Shelf merchandise: a row of lit display goods so walking up feels
  // like window-shopping something valuable, not an empty counter.
  {
    const goodsSpec: Array<{ color: string; kind: "hat" | "flame" | "gem" | "pack" }> = [
      { color: "#e85d75", kind: "hat" },
      { color: "#ffd166", kind: "gem" },
      { color: "#7dfce0", kind: "flame" },
      { color: "#9a7bff", kind: "pack" },
      { color: "#5db8e8", kind: "hat" },
      { color: "#ff9d5c", kind: "gem" },
    ];
    goodsSpec.forEach((spec, i) => {
      const shelfRow = i < 3 ? 0 : 1;
      const x = (i % 3 - 1) * 1.6;
      const y = 2.0 + shelfRow * 1.0;
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.22, 14), shopBody);
      ped.position.set(x, y + 0.11, -0.55);
      shopGroup.add(ped);
      let item: THREE.Mesh;
      if (spec.kind === "hat") {
        item = new THREE.Mesh(
          new THREE.ConeGeometry(0.2, 0.34, 16),
          new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 0.5, roughness: 0.4 }),
        );
      } else if (spec.kind === "flame") {
        item = new THREE.Mesh(
          new THREE.ConeGeometry(0.15, 0.46, 12),
          new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }),
        );
        item.rotation.x = Math.PI;
      } else if (spec.kind === "gem") {
        item = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.2),
          new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 0.9, roughness: 0.2, metalness: 0.4 }),
        );
      } else {
        item = new THREE.Mesh(
          new THREE.BoxGeometry(0.28, 0.36, 0.2),
          new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 0.35, roughness: 0.45, metalness: 0.3 }),
        );
      }
      const baseY = y + 0.42;
      item.position.set(x, baseY, -0.55);
      shopGroup.add(item);
      craftAnims.push((_dt, now) => {
        item.rotation.y = now * 0.0008 + i * 1.1;
        item.position.y = baseY + Math.sin(now * 0.0016 + i * 0.9) * 0.045;
      });
    });
  }
  // (The beacon above the kiosk is the real iridescent $VIBE emblem —
  // the same GLB the /coin page spins — loaded by City and parked at
  // this kiosk's sky slot. A soft gold light here sells its glow.)
  {
    const coinGlow = new THREE.PointLight(0xffd9a0, 12, 12, 2);
    coinGlow.position.set(0, 5.9, 0);
    shopGroup.add(coinGlow);
    craftAnims.push((_dt, now) => {
      coinGlow.intensity = 10 + Math.sin(now * 0.003) * 4;
    });
  }

    group.add(shopGroup);
  }

  // ---- Vibe Maker portal: a glowing ring tucked next to the shop -----
  // Walk up to it to open a mini "vibe coding" panel that spawns 3D
  // primitives saved to public.island_spawns. Everyone on the island
  // sees what you make; only you can delete your own creations.
  // Town plan: south ring, clear of the shop pair.
  const PORTAL_X = -16;
  const PORTAL_Z = 31;
  const portalGroup = new THREE.Group();
  portalGroup.position.set(PORTAL_X, 0, PORTAL_Z);
  {
    const baseMat = new THREE.MeshStandardMaterial({
      color: "#0d1014",
      roughness: 0.55,
      metalness: 0.25,
    });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 0.4, 24), baseMat);
    base.position.y = 0.2;
    portalGroup.add(base);

    const ringMat = new THREE.MeshBasicMaterial({
      color: "#b78aff",
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.13, 16, 48), ringMat);
    ring.position.y = 1.9;
    ring.rotation.x = Math.PI / 2;
    portalGroup.add(ring);

    const innerMat = new THREE.MeshBasicMaterial({
      color: "#2dd4a8",
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const inner = new THREE.Mesh(new THREE.CircleGeometry(1.22, 36), innerMat);
    inner.position.y = 1.9;
    inner.rotation.x = Math.PI / 2;
    portalGroup.add(inner);

    const portalLight = new THREE.PointLight(0xb78aff, 14, 12, 1.8);
    portalLight.position.set(0, 2, 0);
    portalGroup.add(portalLight);

    // Floating "VIBE MAKER" sign above the portal.
    const sc = document.createElement("canvas");
    sc.width = 512;
    sc.height = 128;
    const sx = sc.getContext("2d")!;
    sx.fillStyle = "rgba(0,0,0,0)";
    sx.fillRect(0, 0, 512, 128);
    sx.font = "bold 70px 'Sora', system-ui, sans-serif";
    sx.textAlign = "center";
    sx.textBaseline = "middle";
    sx.shadowColor = "#b78aff";
    sx.shadowBlur = 32;
    sx.fillStyle = "#f0e1ff";
    sx.fillText("VIBE MAKER", 256, 56);
    sx.shadowBlur = 0;
    sx.font = "22px 'Manrope', sans-serif";
    sx.fillStyle = "#2dd4a8";
    sx.fillText("spawn anything · saved for everyone", 256, 104);
    const signTex = new THREE.CanvasTexture(sc);
    signTex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 0.85),
      new THREE.MeshBasicMaterial({ map: signTex, transparent: true, depthWrite: false }),
    );
    sign.position.set(0, 3.7, 0);
    portalGroup.add(sign);
    // Make the sign always face the player-ish (billboard at update time).
    (portalGroup as unknown as { __sign: THREE.Mesh }).__sign = sign;
    (portalGroup as unknown as { __ring: THREE.Mesh }).__ring = ring;
    (portalGroup as unknown as { __inner: THREE.Mesh }).__inner = inner;
    (portalGroup as unknown as { __light: THREE.PointLight }).__light = portalLight;
  }
  group.add(portalGroup);

  // ---- Avatar Hologram portal: change your character ------------------
  // A glowing pedestal that projects a holographic figure made of stacked
  // glowing rings + scrolling scanlines. Walk up to it to open the
  // character picker. Sits on the opposite side of the Vibe Shop from
  // the Vibe Maker so the three form a little plaza row.
  // Perched on the roof of Trader Joe's (see SHOPS[0] at x=-30, z=-8, h=9).
  // Town plan: out of Trader Joe's interior (the craft pass gave TJ
  // real walls and this portal ended up literally inside the shop) and
  // onto the west ring south of it, beam visible from the plaza.
  const AVATAR_X = -34;
  const AVATAR_Z = 10;
  const AVATAR_Y = 9; // Trader Joe's roof height (matches SHOPS[0].h)
  const avatarPortalGroup = new THREE.Group();
  avatarPortalGroup.position.set(AVATAR_X, AVATAR_Y, AVATAR_Z);
  const avatarHoloRings: THREE.Mesh[] = [];
  const avatarRingMats: THREE.MeshBasicMaterial[] = [];
  let avatarBeamMat!: THREE.MeshBasicMaterial;
  let avatarScanMat!: THREE.MeshBasicMaterial;
  let avatarOrbitRingA!: THREE.Mesh;
  let avatarOrbitRingB!: THREE.Mesh;
  let avatarPedestalLight!: THREE.PointLight;
  let avatarRimMat!: THREE.MeshBasicMaterial;
  let avatarDiscMat!: THREE.MeshBasicMaterial;
  // Stage = where the City scene mounts the live character holo.
  const avatarStage = new THREE.Group();
  {
    // Clean glowing disc pedestal — no dark side panel anymore, just
    // a thin emissive puck with a bright mint rim. Replaces the old
    // dark cylinder whose wider base read as "half black" from a
    // low angle.
    const PED_R = 1.95;
    const PED_H = 0.18;
    const padMat = new THREE.MeshBasicMaterial({
      color: "#0d2a24",
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: false,
    });
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(PED_R, PED_R, PED_H, 48),
      padMat,
    );
    pad.position.y = PED_H / 2;
    avatarPortalGroup.add(pad);

    // Glowing inner disc that fakes a hologram floor — bright mint
    // glow on top of the puck, additive so it lights up the player's
    // feet when they step in.
    avatarDiscMat = new THREE.MeshBasicMaterial({
      color: "#2dd4a8",
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(PED_R * 0.95, 48),
      avatarDiscMat,
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = PED_H + 0.005;
    avatarPortalGroup.add(disc);

    avatarRimMat = new THREE.MeshBasicMaterial({
      color: "#2dd4a8",
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(PED_R, 0.05, 12, 64), avatarRimMat);
    rim.position.y = PED_H + 0.01;
    rim.rotation.x = Math.PI / 2;
    avatarPortalGroup.add(rim);

    // Vertical "projection beam" — translucent cyan cone pointing up.
    avatarBeamMat = new THREE.MeshBasicMaterial({
      color: "#7af0ff",
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const beam = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4.6, 32, 1, true), avatarBeamMat);
    beam.position.y = 2.6;
    avatarPortalGroup.add(beam);

    // Scrolling scanline cylinder around the figure — gives it that
    // "data being projected" feel.
    const scanCanvas = document.createElement("canvas");
    scanCanvas.width = 16;
    scanCanvas.height = 256;
    const sctx = scanCanvas.getContext("2d")!;
    sctx.fillStyle = "rgba(0,0,0,0)";
    sctx.fillRect(0, 0, 16, 256);
    for (let y = 0; y < 256; y += 4) {
      sctx.fillStyle = `rgba(122, 240, 255, ${0.1 + Math.random() * 0.16})`;
      sctx.fillRect(0, y, 16, 1.5);
    }
    const scanTex = new THREE.CanvasTexture(scanCanvas);
    scanTex.wrapS = scanTex.wrapT = THREE.RepeatWrapping;
    scanTex.repeat.set(2, 1);
    avatarScanMat = new THREE.MeshBasicMaterial({
      map: scanTex,
      color: "#7af0ff",
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const scanCyl = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.15, 3.6, 32, 1, true),
      avatarScanMat,
    );
    scanCyl.position.y = 2.3;
    avatarPortalGroup.add(scanCyl);

    // Avatar mount point — the City scene parents a holographic
    // clone of the previewed character here.
    avatarStage.position.y = PED_H + 0.02;
    avatarPortalGroup.add(avatarStage);

    // Two orbiting rings around the character for that sci-fi UI vibe.
    const orbitMatA = new THREE.MeshBasicMaterial({
      color: "#2dd4a8",
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    avatarOrbitRingA = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.035, 10, 64), orbitMatA);
    avatarOrbitRingA.position.y = 1.6;
    avatarOrbitRingA.rotation.x = Math.PI / 2.3;
    avatarPortalGroup.add(avatarOrbitRingA);

    const orbitMatB = new THREE.MeshBasicMaterial({
      color: "#b78aff",
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    avatarOrbitRingB = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.028, 10, 64), orbitMatB);
    avatarOrbitRingB.position.y = 1.95;
    avatarOrbitRingB.rotation.x = Math.PI / 1.6;
    avatarPortalGroup.add(avatarOrbitRingB);

    avatarPedestalLight = new THREE.PointLight(0x7af0ff, 16, 14, 1.8);
    avatarPedestalLight.position.set(0, 1.6, 0);
    avatarPortalGroup.add(avatarPedestalLight);

    // Floating "AVATAR" sign above the beam.
    const ac = document.createElement("canvas");
    ac.width = 512;
    ac.height = 128;
    const ax = ac.getContext("2d")!;
    ax.fillStyle = "rgba(0,0,0,0)";
    ax.fillRect(0, 0, 512, 128);
    ax.font = "bold 70px 'Sora', system-ui, sans-serif";
    ax.textAlign = "center";
    ax.textBaseline = "middle";
    ax.shadowColor = "#7af0ff";
    ax.shadowBlur = 32;
    ax.fillStyle = "#e6fbff";
    ax.fillText("AVATAR", 256, 56);
    ax.shadowBlur = 0;
    ax.font = "22px 'Manrope', sans-serif";
    ax.fillStyle = "#2dd4a8";
    ax.fillText("step in to change your look", 256, 104);
    const aSignTex = new THREE.CanvasTexture(ac);
    aSignTex.colorSpace = THREE.SRGBColorSpace;
    const aSign = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 0.85),
      new THREE.MeshBasicMaterial({ map: aSignTex, transparent: true, depthWrite: false }),
    );
    aSign.position.set(0, 5.1, 0);
    avatarPortalGroup.add(aSign);
    (avatarPortalGroup as unknown as { __sign: THREE.Mesh }).__sign = aSign;
    (avatarPortalGroup as unknown as { __scanTex: THREE.CanvasTexture }).__scanTex = scanTex;
  }
  group.add(avatarPortalGroup);

  // ------------------------------------------------------------------
  // Esmeralda Jump arcade cabinet — a chunky cardboard arcade machine
  // tucked on the island plaza. Walk up to launch the embedded game
  // (which lives in its own Lovable project) in a fullscreen modal.
  // ------------------------------------------------------------------
  // Town plan: the arcade joins the SE hangout corner with SnackFe.
  const ARCADE_X = 26;
  const ARCADE_Z = 28;
  const arcadeGroup = new THREE.Group();
  arcadeGroup.position.set(ARCADE_X, 0, ARCADE_Z);
  arcadeGroup.rotation.y = -Math.PI / 5;
  {
    // Body
    const bodyMat = new THREE.MeshStandardMaterial({
      color: "#1b1330",
      roughness: 0.6,
      metalness: 0.2,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.6, 1.1), bodyMat);
    body.position.y = 1.3;
    body.castShadow = true;
    arcadeGroup.add(body);
    // Sloped control panel
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.35, 0.7),
      new THREE.MeshStandardMaterial({ color: "#2a1a4a", roughness: 0.55 }),
    );
    panel.position.set(0, 1.05, 0.55);
    panel.rotation.x = -Math.PI / 7;
    arcadeGroup.add(panel);
    // Joystick
    const stick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.2, 12),
      new THREE.MeshStandardMaterial({ color: "#111" }),
    );
    stick.position.set(-0.35, 1.25, 0.7);
    stick.rotation.x = -Math.PI / 14;
    arcadeGroup.add(stick);
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 16, 12),
      new THREE.MeshStandardMaterial({ color: "#ff2e7e", emissive: "#ff2e7e", emissiveIntensity: 0.6 }),
    );
    ball.position.set(-0.35, 1.36, 0.71);
    arcadeGroup.add(ball);
    // Buttons
    const btnColors = ["#22d3ee", "#fde047", "#a78bfa"];
    btnColors.forEach((c, i) => {
      const b = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.04, 16),
        new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.5 }),
      );
      b.position.set(0.05 + i * 0.18, 1.27, 0.7);
      b.rotation.x = -Math.PI / 14;
      arcadeGroup.add(b);
    });
    // Marquee screen (the "screen" face)
    const screenCanvas = document.createElement("canvas");
    screenCanvas.width = 256;
    screenCanvas.height = 256;
    const scx = screenCanvas.getContext("2d")!;
    const grad = scx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#1a0033");
    grad.addColorStop(1, "#330066");
    scx.fillStyle = grad;
    scx.fillRect(0, 0, 256, 256);
    // pixel character
    scx.fillStyle = "#39ff88";
    scx.fillRect(108, 90, 40, 40);
    scx.fillRect(98, 110, 60, 10);
    scx.fillStyle = "#fff";
    scx.fillRect(118, 100, 6, 6);
    scx.fillRect(132, 100, 6, 6);
    // ground
    scx.fillStyle = "#8b5a2b";
    scx.fillRect(0, 200, 256, 56);
    // title
    scx.font = "bold 28px sans-serif";
    scx.fillStyle = "#fde047";
    scx.textAlign = "center";
    scx.fillText("ESMERALDA", 128, 40);
    scx.font = "bold 22px sans-serif";
    scx.fillStyle = "#22d3ee";
    scx.fillText("JUMP", 128, 70);
    const screenTex = new THREE.CanvasTexture(screenCanvas);
    screenTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(1.3, 1.0),
      new THREE.MeshBasicMaterial({ map: screenTex }),
    );
    screen.position.set(0, 1.95, 0.561);
    arcadeGroup.add(screen);
    // Marquee top
    const topCanvas = document.createElement("canvas");
    topCanvas.width = 512;
    topCanvas.height = 128;
    const tcx = topCanvas.getContext("2d")!;
    tcx.fillStyle = "#ff2e7e";
    tcx.fillRect(0, 0, 512, 128);
    tcx.font = "bold 64px sans-serif";
    tcx.fillStyle = "#fff8";
    tcx.textAlign = "center";
    tcx.textBaseline = "middle";
    tcx.fillText("ARCADE", 256, 64);
    tcx.fillStyle = "#fff";
    tcx.fillText("ARCADE", 254, 62);
    const topTex = new THREE.CanvasTexture(topCanvas);
    topTex.colorSpace = THREE.SRGBColorSpace;
    const marquee = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.38),
      new THREE.MeshBasicMaterial({ map: topTex }),
    );
    marquee.position.set(0, 2.55, 0.561);
    arcadeGroup.add(marquee);
    // Glow halo on the floor under the cabinet
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(1.4, 32),
      new THREE.MeshBasicMaterial({
        color: "#ff2e7e",
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.02;
    arcadeGroup.add(halo);
  }
  group.add(arcadeGroup);







  // ---- SnackFe: modern neon cafe ---------------------------------------
  // A sleek modern micro-cafe with alternating mint/magenta string lights
  // along the front awning. Walk up to it to order a snack.
  // Town plan: pushed out to the SE ring so the mid-lawn stays open.
  const SNACK_X = 16;
  const SNACK_Z = 33;
  const SNACK_W = 9;
  const SNACK_D = 6;
  const SNACK_H = 4.4;
  const snackGroup = new THREE.Group();
  snackGroup.position.set(SNACK_X, 0, SNACK_Z);
  // Rotate so the service window faces inward toward the plaza/center.
  snackGroup.rotation.y = Math.PI;

  // Dark matte concrete body — contrast against cardboard kid-world.
  const snackBody = new THREE.Mesh(
    new THREE.BoxGeometry(SNACK_W, SNACK_H, SNACK_D),
    new THREE.MeshStandardMaterial({ color: "#1c1f26", roughness: 0.55, metalness: 0.15 }),
  );
  snackBody.position.y = SNACK_H / 2;
  snackGroup.add(snackBody);

  // Warm wood front panel under the service window.
  const snackPanel = new THREE.Mesh(
    new THREE.BoxGeometry(SNACK_W * 0.92, SNACK_H * 0.38, 0.12),
    new THREE.MeshStandardMaterial({ color: "#8b5e34", roughness: 0.75 }),
  );
  snackPanel.position.set(0, SNACK_H * 0.22, SNACK_D / 2 + 0.06);
  snackGroup.add(snackPanel);

  // Service window cutout (a glowing rectangle).
  const snackWindow = new THREE.Mesh(
    new THREE.PlaneGeometry(SNACK_W * 0.7, SNACK_H * 0.34),
    new THREE.MeshBasicMaterial({ color: "#fff2c8" }),
  );
  snackWindow.position.set(0, SNACK_H * 0.62, SNACK_D / 2 + 0.07);
  snackGroup.add(snackWindow);

  // Interior warm glow that spills out of the window.
  const snackInteriorLight = new THREE.PointLight(0xffd28a, 22, 18, 1.8);
  snackInteriorLight.position.set(0, SNACK_H * 0.6, SNACK_D / 2 - 0.6);
  snackGroup.add(snackInteriorLight);

  // Flat modern roof slab with slight overhang.
  const snackRoof = new THREE.Mesh(
    new THREE.BoxGeometry(SNACK_W + 1.6, 0.28, SNACK_D + 2.2),
    new THREE.MeshStandardMaterial({ color: "#0d1014", roughness: 0.6 }),
  );
  snackRoof.position.set(0, SNACK_H + 0.14, 0.6);
  snackGroup.add(snackRoof);

  // Neon "SnackFe" sign mounted above the window.
  const snackSignTex = (() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 160;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0d1014";
    ctx.fillRect(0, 0, 512, 160);
    ctx.font = "bold 96px 'Sora', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#46e88c";
    ctx.shadowBlur = 28;
    ctx.fillStyle = "#46e88c";
    ctx.fillText("SnackFe", 256, 82);
    ctx.shadowBlur = 0;
    ctx.font = "20px 'Manrope', sans-serif";
    ctx.fillStyle = "#e94f8a";
    ctx.fillText("· open late · vibes inside ·", 256, 138);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const snackSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 1.75),
    new THREE.MeshBasicMaterial({ map: snackSignTex, transparent: true }),
  );
  snackSign.position.set(0, SNACK_H + 1.1, SNACK_D / 2 + 0.08);
  snackGroup.add(snackSign);

  // Alternating string lights along the front roof edge.
  const snackLights: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; hue: 0 | 1 }[] = [];
  const LIGHT_COUNT = 11;
  for (let i = 0; i < LIGHT_COUNT; i++) {
    const t = i / (LIGHT_COUNT - 1);
    const x = (-SNACK_W / 2 - 0.6) + t * (SNACK_W + 1.2);
    const hue: 0 | 1 = (i % 2) as 0 | 1;
    const mat = new THREE.MeshBasicMaterial({
      color: hue === 0 ? "#46e88c" : "#e94f8a",
      transparent: true,
      opacity: 0.95,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), mat);
    bulb.position.set(x, SNACK_H + 0.05, SNACK_D / 2 + 1.05);
    snackGroup.add(bulb);
    snackLights.push({ mesh: bulb, mat, hue });
  }
  // Sagging cable that the bulbs hang from.
  {
    const cablePts: THREE.Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const x = (-SNACK_W / 2 - 0.6) + t * (SNACK_W + 1.2);
      const sag = Math.sin(t * Math.PI) * 0.18;
      cablePts.push(new THREE.Vector3(x, SNACK_H + 0.22 - sag, SNACK_D / 2 + 1.05));
    }
    const cableGeo = new THREE.BufferGeometry().setFromPoints(cablePts);
    const cableMat = new THREE.LineBasicMaterial({ color: "#222" });
    snackGroup.add(new THREE.Line(cableGeo, cableMat));
  }

  // Outdoor counter + two stools.
  const counter = new THREE.Mesh(
    new THREE.BoxGeometry(SNACK_W * 0.7, 0.22, 0.7),
    new THREE.MeshStandardMaterial({ color: "#d4a574", roughness: 0.7 }),
  );
  counter.position.set(0, 1.05, SNACK_D / 2 + 0.55);
  snackGroup.add(counter);

  // Glass display case on the counter, stocked with glowing treats —
  // walking up should feel like eyeing the pastry shelf.
  {
    const caseGlass = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.9, 0.62),
      new THREE.MeshStandardMaterial({
        color: "#bfe8ff", roughness: 0.05, metalness: 0.1,
        transparent: true, opacity: 0.22,
      }),
    );
    caseGlass.position.set(-0.6, 1.62, SNACK_D / 2 + 0.55);
    snackGroup.add(caseGlass);
    const caseLight = new THREE.PointLight(0xfff0c0, 6, 4, 2);
    caseLight.position.set(-0.6, 1.75, SNACK_D / 2 + 0.55);
    snackGroup.add(caseLight);
    const treats: Array<{ color: string; w: number; h: number }> = [
      { color: "#ff8fae", w: 0.3, h: 0.26 },  // strawberry cake
      { color: "#f2d59b", w: 0.34, h: 0.2 },  // croissant
      { color: "#8be8c8", w: 0.24, h: 0.3 },  // mint float
      { color: "#c9a2ff", w: 0.26, h: 0.24 }, // mochi
    ];
    treats.forEach((t, i) => {
      const treat = new THREE.Mesh(
        new THREE.BoxGeometry(t.w, t.h, 0.3),
        new THREE.MeshStandardMaterial({ color: t.color, emissive: t.color, emissiveIntensity: 0.25, roughness: 0.5 }),
      );
      treat.position.set(-1.6 + i * 0.68, 1.35 + t.h / 2, SNACK_D / 2 + 0.55);
      treat.rotation.y = i * 0.5;
      snackGroup.add(treat);
    });
    // A steaming espresso cup at the order end of the counter.
    const cup = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.1, 0.18, 14),
      new THREE.MeshStandardMaterial({ color: "#fff5e8", roughness: 0.4 }),
    );
    cup.position.set(1.7, 1.25, SNACK_D / 2 + 0.55);
    snackGroup.add(cup);
    const steam = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.5),
      new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }),
    );
    steam.position.set(1.7, 1.65, SNACK_D / 2 + 0.55);
    snackGroup.add(steam);
    craftAnims.push((_dt, now) => {
      const k = (now * 0.0006) % 1;
      steam.position.y = 1.55 + k * 0.5;
      (steam.material as THREE.MeshBasicMaterial).opacity = 0.32 * (1 - k);
      steam.rotation.z = Math.sin(now * 0.002) * 0.2;
    });
  }

  // Giant slowly-spinning soft-serve on the roof — the classic "come
  // eat here" beacon you can spot from across the island.
  {
    const swirl = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 1.1, 14),
      new THREE.MeshStandardMaterial({ color: "#d4a574", roughness: 0.8 }),
    );
    cone.rotation.x = Math.PI;
    cone.position.y = 0.55;
    swirl.add(cone);
    const scoopMat = new THREE.MeshStandardMaterial({
      color: "#fdf3ff", emissive: "#f9d8ff", emissiveIntensity: 0.35, roughness: 0.55,
    });
    for (let i = 0; i < 3; i++) {
      const scoop = new THREE.Mesh(new THREE.SphereGeometry(0.52 - i * 0.13, 16, 12), scoopMat);
      scoop.position.y = 1.25 + i * 0.42;
      swirl.add(scoop);
    }
    const cherry = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 8),
      new THREE.MeshStandardMaterial({ color: "#e94f8a", emissive: "#e94f8a", emissiveIntensity: 0.8, roughness: 0.4 }),
    );
    cherry.position.y = 2.32;
    swirl.add(cherry);
    swirl.position.set(-SNACK_W / 2 + 1.3, SNACK_H + 0.28, 0.4);
    snackGroup.add(swirl);
    craftAnims.push((_dt, now) => {
      swirl.rotation.y = now * 0.0006;
    });
  }

  // A-frame chalk menu board by the stools.
  {
    const board = new THREE.Group();
    const face = (() => {
      const c = document.createElement("canvas");
      c.width = 256; c.height = 320;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#1b1f24";
      ctx.fillRect(0, 0, 256, 320);
      ctx.strokeStyle = "#8b5e34";
      ctx.lineWidth = 14;
      ctx.strokeRect(7, 7, 242, 306);
      ctx.textAlign = "center";
      ctx.fillStyle = "#fff2c8";
      ctx.font = "bold 34px 'Comic Sans MS', cursive, sans-serif";
      ctx.fillText("SnackFe", 128, 58);
      ctx.font = "22px 'Comic Sans MS', cursive, sans-serif";
      ctx.fillStyle = "#46e88c";
      ctx.fillText("🍓 strawberry — 1✦", 128, 112);
      ctx.fillText("🍦 mint float — 2✦", 128, 152);
      ctx.fillText("🥐 croissant — 3✦", 128, 192);
      ctx.fillText("☕ espresso — 3✦", 128, 232);
      ctx.fillStyle = "#e94f8a";
      ctx.font = "italic 20px 'Comic Sans MS', cursive, sans-serif";
      ctx.fillText("today's vibe: peachy", 128, 286);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    for (const lean of [-1, 1]) {
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(1.15, 1.45),
        lean === 1
          ? new THREE.MeshBasicMaterial({ map: face })
          : new THREE.MeshStandardMaterial({ color: "#1b1f24", roughness: 0.9, side: THREE.DoubleSide }),
      );
      panel.position.set(0, 0.72, lean * 0.17);
      panel.rotation.x = lean * -0.22;
      if (lean === -1) panel.rotation.y = Math.PI;
      board.add(panel);
    }
    board.position.set(3.6, 0, SNACK_D / 2 + 1.6);
    board.rotation.y = -0.3;
    snackGroup.add(board);
  }
  [-1.6, 1.6].forEach((sx) => {
    const stoolPole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.9, 8),
      new THREE.MeshStandardMaterial({ color: "#222", roughness: 0.6, metalness: 0.4 }),
    );
    stoolPole.position.set(sx, 0.45, SNACK_D / 2 + 1.35);
    snackGroup.add(stoolPole);
    const stoolSeat = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 0.1, 16),
      new THREE.MeshStandardMaterial({ color: "#46e88c", roughness: 0.5, emissive: "#1a3a26", emissiveIntensity: 0.4 }),
    );
    stoolSeat.position.set(sx, 0.95, SNACK_D / 2 + 1.35);
    snackGroup.add(stoolSeat);
  });

  // Small floor mat with neon outline.
  const mat = new THREE.Mesh(
    new THREE.PlaneGeometry(SNACK_W * 0.85, 1.8),
    new THREE.MeshBasicMaterial({ color: "#0d1014" }),
  );
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(0, 0.02, SNACK_D / 2 + 1.4);
  snackGroup.add(mat);

  group.add(snackGroup);

  // Collision: the cafe body itself.
  boxes.push({
    minX: centerX + SNACK_X - SNACK_W / 2,
    maxX: centerX + SNACK_X + SNACK_W / 2,
    minZ: centerZ + SNACK_Z - SNACK_D / 2,
    maxZ: centerZ + SNACK_Z + SNACK_D / 2,
    base: topY,
    height: topY + SNACK_H + 0.3,
  });


  // ---- Craft details: lamps, bunting, benches, tufts, butterflies ----
  {
    // Warm path lamps at the four path shoulders.
    const lampPostMat = new THREE.MeshStandardMaterial({ color: "#3d4653", roughness: 0.55, metalness: 0.3 });
    const lampGlowMat = new THREE.MeshBasicMaterial({ color: "#ffdf9e" });
    for (const [lx, lz] of [[4.4, 9], [-4.4, -9], [9, -4.4], [-9, 4.4]] as const) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 2.6, 8), lampPostMat);
      post.position.set(lx, 1.3, lz);
      group.add(post);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.3, 8), lampPostMat);
      cap.position.set(lx, 2.85, lz);
      group.add(cap);
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), lampGlowMat);
      orb.position.set(lx, 2.62, lz);
      group.add(orb);
      craftAnims.push((_dt, now) => {
        (orb.material as THREE.MeshBasicMaterial).color.setHSL(0.11, 0.75, 0.72 + Math.sin(now * 0.002 + lx) * 0.08);
      });
    }

    // Pennant bunting: two sagging strings of little flags.
    const flagColors = [0xff8fae, 0xffd166, 0x8cd16a, 0x5db8e8, 0xc9a2ff];
    const bunting = (a: THREE.Vector3, b: THREE.Vector3, sag: number) => {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          Array.from({ length: 17 }, (_, i) => {
            const t = i / 16;
            const p = a.clone().lerp(b, t);
            p.y -= Math.sin(t * Math.PI) * sag;
            return p;
          }),
        ),
        new THREE.LineBasicMaterial({ color: 0xf6efe2, transparent: true, opacity: 0.8 }),
      );
      group.add(line);
      for (let i = 1; i < 12; i++) {
        const t = i / 12;
        const p = a.clone().lerp(b, t);
        p.y -= Math.sin(t * Math.PI) * sag;
        const flag = new THREE.Mesh(
          new THREE.ConeGeometry(0.22, 0.5, 3),
          new THREE.MeshStandardMaterial({ color: flagColors[i % flagColors.length], roughness: 0.85, side: THREE.DoubleSide }),
        );
        flag.position.set(p.x, p.y - 0.28, p.z);
        flag.rotation.x = Math.PI;
        group.add(flag);
        craftAnims.push((_dt, now) => {
          flag.rotation.z = Math.sin(now * 0.0016 + i) * 0.18;
        });
      }
    };
    bunting(new THREE.Vector3(0, 5.1, 14), new THREE.Vector3(-13, 8.4, 25), 0.7);
    bunting(new THREE.Vector3(-14, 8.4, 26), new THREE.Vector3(14, 14.6, 3), 1.1);

    // Two slat benches facing the plaza paths.
    const benchWood = new THREE.MeshStandardMaterial({ color: "#a8794a", roughness: 0.9 });
    for (const [bx, bz, ry] of [[7, 17, -0.5], [-19, 3, 1.1]] as const) {
      const bench = new THREE.Group();
      bench.position.set(bx, 0, bz);
      bench.rotation.y = ry;
      for (let sl = 0; sl < 3; sl++) {
        const slat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 0.28), benchWood);
        slat.position.set(0, 0.55, -0.32 + sl * 0.32);
        bench.add(slat);
      }
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.55, 0.9), cardboardDark);
        leg.position.set(side * 1.0, 0.27, 0);
        bench.add(leg);
      }
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.55, 0.08), benchWood);
      back.position.set(0, 1.0, -0.48);
      back.rotation.x = -0.18;
      bench.add(back);
      group.add(bench);
    }

    // Grass tufts sprinkled across the lawn (instanced, path-aware).
    const tuftGeo = new THREE.ConeGeometry(0.16, 0.55, 5);
    const tuftMat = new THREE.MeshStandardMaterial({ color: "#4f9c3c", roughness: 1, flatShading: true });
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, 70);
    const tuftM = new THREE.Matrix4();
    const tuftRand = mulberry32(4242);
    let placed = 0;
    while (placed < 70) {
      const a = tuftRand() * Math.PI * 2;
      const r = 8 + tuftRand() * (ISLAND_RADIUS - 12);
      const tx = Math.cos(a) * r;
      const tz = Math.sin(a) * r;
      if (Math.abs(tx) < 6 || Math.abs(tz) < 6) continue; // keep paths clean
      const sc = 0.7 + tuftRand() * 0.9;
      tuftM.makeRotationY(tuftRand() * Math.PI);
      tuftM.scale(new THREE.Vector3(sc, sc, sc));
      tuftM.setPosition(tx, 0.22 * sc, tz);
      tufts.setMatrixAt(placed, tuftM);
      placed++;
    }
    tufts.instanceMatrix.needsUpdate = true;
    group.add(tufts);

    // Butterflies fluttering figure-eights over the lawns.
    const flutterColors = [0xffb3c9, 0x9fd8ff, 0xfff0a8];
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Group();
      const wingMat = new THREE.MeshBasicMaterial({
        color: flutterColors[i % flutterColors.length], side: THREE.DoubleSide,
        transparent: true, opacity: 0.9,
      });
      const wings: THREE.Mesh[] = [];
      for (const side of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.CircleGeometry(0.18, 8), wingMat);
        wing.position.x = side * 0.1;
        b.add(wing);
        wings.push(wing);
      }
      const cx3 = (i - 2) * 11;
      const cz3 = 8 + (i % 3) * 9;
      group.add(b);
      craftAnims.push((_dt, now) => {
        const t = now * 0.00035 + i * 2.1;
        b.position.set(
          cx3 + Math.sin(t) * 5,
          2 + Math.sin(t * 2.3) * 0.8,
          cz3 + Math.sin(t * 0.7) * 4,
        );
        b.rotation.y = Math.cos(t) * 0.8;
        const flap = Math.sin(now * 0.02 + i) * 0.9;
        wings[0].rotation.y = flap;
        wings[1].rotation.y = -flap;
      });
    }
  }

  // ---- Zipline: a cable loop riding the island's perimeter ----------
  // Grab it under any stretch of cable and it carries you around the
  // whole cardboard city. Poles sit just outside the cable so riders
  // glide past them, not through them.
  const ZIP_RADIUS = 42;
  const ZIP_HEIGHT = 5;
  const cable = new THREE.Mesh(
    new THREE.TorusGeometry(ZIP_RADIUS, 0.08, 6, 96),
    new THREE.MeshBasicMaterial({ color: "#46392b" }),
  );
  cable.rotation.x = Math.PI / 2;
  cable.position.y = ZIP_HEIGHT;
  group.add(cable);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.33;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.32, ZIP_HEIGHT + 0.8, 8),
      cardboardDark,
    );
    pole.position.set(Math.cos(a) * (ZIP_RADIUS + 1.1), (ZIP_HEIGHT + 0.8) / 2, Math.sin(a) * (ZIP_RADIUS + 1.1));
    group.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.18), cardboardDark);
    arm.position.set(Math.cos(a) * (ZIP_RADIUS + 0.5), ZIP_HEIGHT + 0.25, Math.sin(a) * (ZIP_RADIUS + 0.5));
    arm.rotation.y = -a;
    group.add(arm);
  }

  // ------------------------------------------------------------------
  // GOD ORB GENERATOR + TWINKLE LIGHTS
  // A mysterious glowing dome at the island's north rim. It "powers" a
  // constellation of twinkle lights scattered across the island lawn.
  // ------------------------------------------------------------------
  // Town plan: the orb anchors the NORTH RIM at the end of the north
  // path — a mystic beacon framed by the welcome arch sightline. (It
  // used to sit in the middle of THE PALACE courtyard.)
  const GEN_X = 6;
  const GEN_Z = -36;
  const generatorGroup = new THREE.Group();
  generatorGroup.position.set(GEN_X, 0, GEN_Z);
  group.add(generatorGroup);

  // -- The God Orb (half-dome) --------------------------------------
  // A Zometool-style geodesic half-sphere: red / white / blue struts
  // joined at white ball nodes. Lore: this is HALF of the God Orb —
  // the other half is lost somewhere between the digital and physical
  // worlds. We render the upper hemisphere only.
  const ORB_R = 4.2;
  const orbCenterY = 0.4;
  const orbStruts = new THREE.Group();
  orbStruts.position.y = orbCenterY;
  generatorGroup.add(orbStruts);

  const icosa = new THREE.IcosahedronGeometry(ORB_R, 2);
  const posAttr = icosa.attributes.position as THREE.BufferAttribute;
  const orbVerts: THREE.Vector3[] = [];
  const vertKey = (v: THREE.Vector3) =>
    `${v.x.toFixed(3)}|${v.y.toFixed(3)}|${v.z.toFixed(3)}`;
  const vertMap = new Map<string, number>();
  for (let i = 0; i < posAttr.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(posAttr, i);
    const k = vertKey(v);
    if (!vertMap.has(k)) {
      vertMap.set(k, orbVerts.length);
      orbVerts.push(v);
    }
  }
  const edgeSet = new Set<string>();
  const orbEdges: [number, number][] = [];
  for (let i = 0; i < posAttr.count; i += 3) {
    const ids = [0, 1, 2].map((o) => {
      const v = new THREE.Vector3().fromBufferAttribute(posAttr, i + o);
      return vertMap.get(vertKey(v))!;
    });
    for (const [a, b] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]]) {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      orbEdges.push([a, b]);
    }
  }

  const strutMatRed = new THREE.MeshStandardMaterial({ color: "#d92b2b", roughness: 0.45, metalness: 0.15, emissive: "#3a0606", emissiveIntensity: 0.4 });
  const strutMatWhite = new THREE.MeshStandardMaterial({ color: "#f4f4f4", roughness: 0.55, metalness: 0.05, emissive: "#222222", emissiveIntensity: 0.2 });
  const strutMatBlue = new THREE.MeshStandardMaterial({ color: "#2f7ad9", roughness: 0.45, metalness: 0.15, emissive: "#061a3a", emissiveIntensity: 0.4 });
  const palette = [strutMatRed, strutMatWhite, strutMatBlue, strutMatRed, strutMatRed, strutMatBlue, strutMatWhite];
  const strutGeo = new THREE.CylinderGeometry(0.055, 0.055, 1, 6, 1);

  let strutCount = 0;
  for (const [a, b] of orbEdges) {
    const va = orbVerts[a];
    const vb = orbVerts[b];
    if (va.y < -0.01 || vb.y < -0.01) continue;
    const mid = new THREE.Vector3().addVectors(va, vb).multiplyScalar(0.5);
    const dir = new THREE.Vector3().subVectors(vb, va);
    const len = dir.length();
    const mat = palette[strutCount % palette.length];
    const strut = new THREE.Mesh(strutGeo, mat);
    strut.position.copy(mid);
    strut.scale.y = len;
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    orbStruts.add(strut);
    strutCount++;
  }

  const nodeGeo = new THREE.SphereGeometry(0.13, 10, 8);
  const nodeMat = new THREE.MeshStandardMaterial({ color: "#fafafa", roughness: 0.35, metalness: 0.2, emissive: "#444", emissiveIntensity: 0.25 });
  for (const v of orbVerts) {
    if (v.y < -0.01) continue;
    const ball = new THREE.Mesh(nodeGeo, nodeMat);
    ball.position.copy(v);
    orbStruts.add(ball);
  }

  // ------------------------------------------------------------------
  // DIVINE SPHERE — full geodesic sphere floating high over the island.
  // Lore-wise it complements the God Orb (the half-dome): the Divine
  // Sphere is the "whole" form, suspended between the digital and the
  // physical, slowly rotating in the sky as a beacon.
  // ------------------------------------------------------------------
  const divineSphere = new THREE.Group();
  // Floats out over the lagoon NW of the plaza, well above building
  // tops so it reads as a sky object from anywhere on the island.
  divineSphere.position.set(-26, 30, 16);
  group.add(divineSphere);

  const DIV_R = 5.0;
  const divIcosa = new THREE.IcosahedronGeometry(DIV_R, 2);
  const dPos = divIcosa.attributes.position as THREE.BufferAttribute;
  const dVerts: THREE.Vector3[] = [];
  const dVMap = new Map<string, number>();
  const dKey = (v: THREE.Vector3) => `${v.x.toFixed(3)}|${v.y.toFixed(3)}|${v.z.toFixed(3)}`;
  for (let i = 0; i < dPos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(dPos, i);
    const k = dKey(v);
    if (!dVMap.has(k)) { dVMap.set(k, dVerts.length); dVerts.push(v); }
  }
  const dEdgeSet = new Set<string>();
  const dEdges: [number, number][] = [];
  for (let i = 0; i < dPos.count; i += 3) {
    const ids = [0, 1, 2].map((o) => {
      const v = new THREE.Vector3().fromBufferAttribute(dPos, i + o);
      return dVMap.get(dKey(v))!;
    });
    for (const [a, b] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]]) {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (dEdgeSet.has(key)) continue;
      dEdgeSet.add(key);
      dEdges.push([a, b]);
    }
  }
  const divinePalette = [
    new THREE.MeshStandardMaterial({ color: "#d92b2b", roughness: 0.4, metalness: 0.2, emissive: "#3a0606", emissiveIntensity: 0.5 }),
    new THREE.MeshStandardMaterial({ color: "#ff8a1c", roughness: 0.4, metalness: 0.2, emissive: "#3a1a00", emissiveIntensity: 0.5 }),
    new THREE.MeshStandardMaterial({ color: "#ffd166", roughness: 0.4, metalness: 0.2, emissive: "#3a2a00", emissiveIntensity: 0.5 }),
    new THREE.MeshStandardMaterial({ color: "#2f7ad9", roughness: 0.4, metalness: 0.2, emissive: "#061a3a", emissiveIntensity: 0.5 }),
    new THREE.MeshStandardMaterial({ color: "#f4f4f4", roughness: 0.55, metalness: 0.05, emissive: "#333", emissiveIntensity: 0.35 }),
  ];
  const divineStrutGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 6, 1);
  let divIdx = 0;
  for (const [a, b] of dEdges) {
    const va = dVerts[a]; const vb = dVerts[b];
    const mid = new THREE.Vector3().addVectors(va, vb).multiplyScalar(0.5);
    const dir = new THREE.Vector3().subVectors(vb, va);
    const len = dir.length();
    const strut = new THREE.Mesh(divineStrutGeo, divinePalette[divIdx % divinePalette.length]);
    strut.position.copy(mid);
    strut.scale.y = len;
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    divineSphere.add(strut);
    divIdx++;
  }
  const divNodeGeo = new THREE.SphereGeometry(0.14, 10, 8);
  const divNodeMat = new THREE.MeshStandardMaterial({ color: "#fafafa", roughness: 0.3, metalness: 0.25, emissive: "#666", emissiveIntensity: 0.4 });
  for (const v of dVerts) {
    const ball = new THREE.Mesh(divNodeGeo, divNodeMat);
    ball.position.copy(v);
    divineSphere.add(ball);
  }
  // Glowing inner core to read against the sky.
  const divineCore = new THREE.Mesh(
    new THREE.SphereGeometry(1.4, 24, 18),
    new THREE.MeshBasicMaterial({ color: "#fff4c8", transparent: true, opacity: 0.85 }),
  );
  divineSphere.add(divineCore);
  const divineHalo = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 24, 18),
    new THREE.MeshBasicMaterial({
      color: "#ffe0a0",
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  divineSphere.add(divineHalo);
  const divineLight = new THREE.PointLight("#fff0c0", 8, 40, 2);
  divineSphere.add(divineLight);
  const divineBaseY = divineSphere.position.y;



  const orbFloor = new THREE.Mesh(
    new THREE.CircleGeometry(ORB_R * 0.98, 48),
    new THREE.MeshStandardMaterial({ color: "#1a1f2b", roughness: 0.9, metalness: 0.1 }),
  );
  orbFloor.rotation.x = -Math.PI / 2;
  orbFloor.position.y = 0.02;
  generatorGroup.add(orbFloor);

  const genOrb = new THREE.Mesh(
    new THREE.SphereGeometry(0.85, 24, 18),
    new THREE.MeshBasicMaterial({ color: "#ffe9a8", transparent: true, opacity: 0.85 }),
  );
  genOrb.position.y = orbCenterY + 0.6;
  generatorGroup.add(genOrb);

  const genHalo = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 20, 14),
    new THREE.MeshBasicMaterial({
      color: "#ffd166",
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  genHalo.position.y = orbCenterY + 0.6;
  generatorGroup.add(genHalo);

  const genLight = new THREE.PointLight("#ffd9a0", 10, 24, 2);
  genLight.position.y = orbCenterY + 0.7;
  generatorGroup.add(genLight);

  // Low cylindrical footprint collision ring.
  const NSIDES = 10;
  for (let i = 0; i < NSIDES; i++) {
    const a0 = (i / NSIDES) * Math.PI * 2;
    const a1 = ((i + 1) / NSIDES) * Math.PI * 2;
    const x0 = Math.cos(a0) * ORB_R * 0.9;
    const z0 = Math.sin(a0) * ORB_R * 0.9;
    const x1 = Math.cos(a1) * ORB_R * 0.9;
    const z1 = Math.sin(a1) * ORB_R * 0.9;
    boxes.push({
      minX: centerX + GEN_X + Math.min(x0, x1) - 0.1,
      maxX: centerX + GEN_X + Math.max(x0, x1) + 0.1,
      minZ: centerZ + GEN_Z + Math.min(z0, z1) - 0.1,
      maxZ: centerZ + GEN_Z + Math.max(z0, z1) + 0.1,
      base: topY, height: topY + 0.8,
    });
  }

  // Multi-color "GOD ORB" plaque matching the physical sign.
  const plaqueCanvas = document.createElement("canvas");
  plaqueCanvas.width = 512; plaqueCanvas.height = 160;
  {
    const ctx = plaqueCanvas.getContext("2d")!;
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, 512, 160);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, 492, 140);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 72px ui-sans-serif, system-ui, sans-serif";
    const word = "GOD ORB";
    const colors = ["#ff5b5b", "#1ec96b", "#1f7be0", "#111111", "#ff8a1c", "#d63bd6", "#1ec96b"];
    const totalW = ctx.measureText(word).width;
    let x = 256 - totalW / 2;
    for (let i = 0; i < word.length; i++) {
      const ch = word[i];
      ctx.fillStyle = colors[i % colors.length];
      const w = ctx.measureText(ch).width;
      ctx.fillText(ch, x + w / 2, 64);
      x += w;
    }
    ctx.fillStyle = "#444";
    ctx.font = "italic 22px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("½ found — the other half is in the imagination", 256, 124);
  }
  const plaqueTex = new THREE.CanvasTexture(plaqueCanvas);
  plaqueTex.colorSpace = THREE.SRGBColorSpace;
  const plaque = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 0.82),
    new THREE.MeshBasicMaterial({ map: plaqueTex, transparent: true, side: THREE.DoubleSide }),
  );
  plaque.position.set(0, 1.2, ORB_R + 0.05);
  generatorGroup.add(plaque);

  // Twinkle lights scattered across the lawn — small glowing pucks
  // sitting on the grass, color-rotating between mint and warm amber.
  const twinkleLights: { mat: THREE.MeshBasicMaterial; mesh: THREE.Mesh; phase: number; hue: number }[] = [];
  const twinkleGeo = new THREE.SphereGeometry(0.12, 10, 8);
  const islandR = 56;
  // Avoid stomping on buildings/portals: keep an exclusion zone around each shop.
  const avoid: { x: number; z: number; r: number }[] = SHOPS.map((s) => ({
    x: s.x, z: s.z, r: Math.max(s.w, s.d) * 0.7 + 2,
  }));
  avoid.push({ x: GEN_X, z: GEN_Z, r: 2 });
  avoid.push({ x: 0, z: 0, r: 4 }); // central plaza
  let placed = 0;
  let tries = 0;
  while (placed < 90 && tries < 600) {
    tries++;
    const a = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * (islandR - 8);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (avoid.some((v) => Math.hypot(v.x - x, v.z - z) < v.r)) continue;
    const warm = Math.random() < 0.45;
    const color = warm ? "#ffd58a" : "#9bf7c8";
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const mesh = new THREE.Mesh(twinkleGeo, mat);
    mesh.position.set(x, 0.18, z);
    group.add(mesh);
    twinkleLights.push({ mat, mesh, phase: Math.random() * Math.PI * 2, hue: warm ? 1 : 0 });
    placed++;
  }

  // Light beam: visible from the city day or night, fog-exempt.
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 320, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#ffd166",
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  beam.position.set(0, 40, -38);
  group.add(beam);
  spinners.push(beam);

  // A few starting star spots on the lawn ring.
  starSpots.push(
    new THREE.Vector3(centerX - 14, topY + 2, centerZ - 14),
    new THREE.Vector3(centerX + 16, topY + 2, centerZ + 14),
    new THREE.Vector3(centerX, topY + 2, centerZ - 22),
  );

  return {
    group,
    update(dt, now) {
      for (const fn of craftAnims) fn(dt, now);
      spinners[0].rotation.z += dt * 1.1; // windmill
      const beamMesh = spinners[1] as THREE.Mesh;
      (beamMesh.material as THREE.MeshBasicMaterial).opacity =
        0.28 + Math.sin(now * 0.0016) * 0.12;
      lantern.position.y = 11 + Math.sin(now * 0.0012) * 0.4;

      // Firewall flames flicker; the swing sways; Jerry wiggles.
      firewallFlames.forEach((f, i) => {
        const s = 0.75 + Math.abs(Math.sin(now * 0.011 + i * 1.7)) * 0.5;
        f.scale.set(s, 0.8 + Math.random() * 0.55, s);
      });
      currentSwingAngle = Math.sin(now * 0.0013) * 0.52;
      swingPivot.rotation.x = currentSwingAngle;
      jerryGroup.rotation.y = JERRY_ROT_Y + Math.sin(now * 0.0008) * 0.12;
      benGroup.rotation.y = BEN_ROT_Y + Math.sin(now * 0.0009 + 1.3) * 0.14;
      jerryParts.stalks.forEach((s, i) => {
        s.rotation.x = Math.sin(now * 0.0027 + i * 2.1) * 0.16;
      });

      // Plaza ambience: pond bob + lantern glow pulse.
      pondGroup.position.y = Math.sin(now * 0.0015) * 0.03;
      plazaLanterns.forEach((l, i) => {
        const s = 1 + Math.sin(now * 0.002 + i * 1.3) * 0.08;
        l.scale.set(s, s, s);
      });

      // SnackFe alternating string-light pulse: even-index bulbs glow
      // out of phase with odd-index bulbs, giving that vibey twinkle.
      snackLights.forEach((b) => {
        const phase = b.hue === 0 ? 0 : Math.PI;
        const k = 0.6 + (Math.sin(now * 0.004 + phase) * 0.5 + 0.5) * 0.55;
        b.mat.opacity = 0.55 + k * 0.45;
        b.mesh.scale.setScalar(0.9 + k * 0.35);
      });
      snackInteriorLight.intensity = 18 + Math.sin(now * 0.0015) * 4;

      // Vibe Maker portal: ring spin + light pulse.
      const pg = portalGroup as unknown as {
        __ring: THREE.Mesh;
        __inner: THREE.Mesh;
        __light: THREE.PointLight;
      };
      pg.__ring.rotation.z += dt * 0.6;
      pg.__inner.rotation.z -= dt * 0.3;
      pg.__light.intensity = 12 + Math.sin(now * 0.003) * 4;

      // Avatar Hologram portal: orbiting rings + scanline scroll +
      // gentle stage bob. The character mounted on the stage gets
      // animated by the City scene, not here.
      avatarOrbitRingA.rotation.z += dt * 0.9;
      avatarOrbitRingB.rotation.z -= dt * 0.5;
      avatarOrbitRingB.rotation.x = Math.PI / 1.6 + Math.sin(now * 0.0012) * 0.25;
      const aFloat = Math.sin(now * 0.0022) * 0.08;
      avatarStage.position.y = 0.22 + aFloat;
      avatarBeamMat.opacity = 0.08 + (Math.sin(now * 0.0025) * 0.5 + 0.5) * 0.1;
      avatarDiscMat.opacity = 0.45 + (Math.sin(now * 0.0035) * 0.5 + 0.5) * 0.2;
      avatarRimMat.opacity = 0.8 + Math.sin(now * 0.003) * 0.15;
      avatarPedestalLight.intensity = 14 + Math.sin(now * 0.003) * 5;
      const apg = avatarPortalGroup as unknown as { __scanTex: THREE.CanvasTexture };
      apg.__scanTex.offset.y = -(now * 0.00035) % 1;
      avatarScanMat.opacity = 0.35 + Math.sin(now * 0.0035) * 0.15;



      // God Orb dome: slow majestic rotation + inner core pulse.
      orbStruts.rotation.y += dt * 0.08;
      // Divine Sphere: slow majestic spin + gentle sky-bob + halo pulse.
      divineSphere.rotation.y += dt * 0.18;
      divineSphere.rotation.x += dt * 0.05;
      divineSphere.position.y = divineBaseY + Math.sin(now * 0.0008) * 1.2;
      const divK = 0.5 + Math.sin(now * 0.0018) * 0.5;
      (divineCore.material as THREE.MeshBasicMaterial).opacity = 0.7 + divK * 0.28;
      divineCore.scale.setScalar(0.92 + divK * 0.14);
      (divineHalo.material as THREE.MeshBasicMaterial).opacity = 0.16 + divK * 0.18;
      divineHalo.scale.setScalar(1 + divK * 0.25);
      divineLight.intensity = 5 + divK * 5;
      const orbK = 0.5 + Math.sin(now * 0.0022) * 0.5;
      (genOrb.material as THREE.MeshBasicMaterial).opacity = 0.7 + orbK * 0.3;
      genOrb.scale.setScalar(0.95 + orbK * 0.12);
      (genHalo.material as THREE.MeshBasicMaterial).opacity = 0.18 + orbK * 0.18;
      genHalo.scale.setScalar(1 + orbK * 0.25);
      genLight.intensity = 6 + orbK * 6;
      for (let i = 0; i < twinkleLights.length; i++) {
        const t = twinkleLights[i];
        const k = 0.5 + Math.sin(now * 0.003 + t.phase) * 0.5;
        t.mat.opacity = 0.35 + k * 0.6;
        t.mesh.scale.setScalar(0.7 + k * 0.7);
      }

      // Cardboard TV slideshow.
      tvTimer += dt;
      if (tvTimer > 7 && tvTextures.length > 0) {
        tvTimer = 0;
        tvIndex = (tvIndex + 1) % tvTextures.length;
        tvScreenMat.map = tvTextures[tvIndex];
        tvScreenMat.needsUpdate = true;
      }
    },
    starSpots,
    zipline: { x: centerX, z: centerZ, y: topY + ZIP_HEIGHT, radius: ZIP_RADIUS },
    jerry: new THREE.Vector3(centerX, topY, centerZ),
    snackfe: new THREE.Vector3(centerX + SNACK_X, topY, centerZ + SNACK_Z - SNACK_D / 2 - 1.4),
    // Mount point sits on the plaza side of the (outward-facing) swing.
    swingMount: new THREE.Vector3(centerX + SWING_X + 1.8, topY, centerZ + SWING_Z + 1.7),
    swingSeat: swingSeatMarker,
    swingAngle: () => currentSwingAngle,
    shop: new THREE.Vector3(centerX + SHOP_X, topY, centerZ + SHOP_Z - 2.3),
    portal: new THREE.Vector3(centerX + PORTAL_X, topY, centerZ + PORTAL_Z),
    avatarPortal: new THREE.Vector3(centerX + AVATAR_X, topY + AVATAR_Y, centerZ + AVATAR_Z),
    avatarStage,
    arcade: new THREE.Vector3(centerX + ARCADE_X, topY, centerZ + ARCADE_Z),
    tv: new THREE.Vector3(centerX + TV_X, topY, centerZ + TV_Z),
    setTvPhotos(urls) {
      const loader2 = new THREE.TextureLoader();
      loader2.setCrossOrigin("anonymous");
      urls.slice(0, 32).forEach((url) => {
        loader2.load(url, (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          tvTextures.push(t);
          // First photo takes over from the test pattern right away.
          if (tvTextures.length === 1) {
            tvScreenMat.map = t;
            tvScreenMat.needsUpdate = true;
          }
        });
      });
    },
  };
}
