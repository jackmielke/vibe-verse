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
import { lawnTextures, buildGrassField, buildGroundCover } from "./islandGrass";
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
  /**
   * Launch speed (m/s) when the player lands on this box's top. Leave it
   * unset for solid ground — only clouds bounce. See City's BuildingBox
   * for why this is a property of the box rather than of its altitude.
   */
  bouncy?: number;
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
  /** Repaint the SnackFe kiosk menu board — highlights what you can
   *  afford and ✓ what you already bought. Call whenever gems or
   *  purchase counts change. `justBought` briefly flashes that row. */
  setSnackMenu(gems: number, owned: Record<string, number>, justBought?: string | null): void;
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
  /** The rock-paper-scissors table — walk up to bet Vibecoin against the house. */
  rpsTable: THREE.Vector3;
  /** The God Orb in the sky — click it to wish something into the world. */
  divineSphere: THREE.Group;
  /** Cardboard TV (community photo gallery) — walk up to open the holo-gallery. */
  tv: THREE.Vector3;
}

const ISLAND_RADIUS = 55;

/** The SnackFe menu — one source of truth for the 3D kiosk board and
 *  the order rail in City. `msg` is the flavor line shown on purchase. */
export interface SnackItem {
  emoji: string;
  name: string;
  cost: number;
  msg: string;
}
export const SNACK_MENU: SnackItem[] = [
  { emoji: "🍓", name: "Strawberry", cost: 1, msg: "Sweet and bright. A tiny burst of summer." },
  { emoji: "🍦", name: "Mint coin float", cost: 2, msg: "An icy mint float in a tall glass. +1 vibe." },
  { emoji: "🥐", name: "Sunrise croissant", cost: 3, msg: "Flaky, buttery, still warm." },
  { emoji: "☕", name: "Edge espresso", cost: 3, msg: "Tiny cup, big punch. Your jetpack feels lighter." },
  { emoji: "🍡", name: "Neon mochi skewer", cost: 4, msg: "Three little glowing mochi on a stick." },
  { emoji: "🍉", name: "Watermelon slice", cost: 5, msg: "Cold, crunchy, dripping. The good kind of mess." },
];

// ------------------------------------------------------------------
// Canvas helpers — everything on the island is "drawn by hand".
// ------------------------------------------------------------------
export function cardboardTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(80808);

  // Kraft liner: not one brown, a mottled one. Recycled board is made of
  // pulped everything and no two square inches match.
  ctx.fillStyle = "#c2a06d";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const r = 4 + rand() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const warm = rand() < 0.5;
    g.addColorStop(0, warm ? "rgba(206,172,120,0.22)" : "rgba(150,116,72,0.2)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Paper fibres. Short, pale, every-which-way — the thing that separates
  // "kraft paper" from "brown".
  for (let i = 0; i < 2600; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const a = rand() * Math.PI * 2;
    const len = 3 + rand() * 12;
    ctx.strokeStyle = rand() < 0.55 ? "rgba(228,204,160,0.20)" : "rgba(126,96,56,0.18)";
    ctx.lineWidth = 0.7 + rand() * 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }

  // Flutes read through the liner as a soft periodic shading, not as ruled
  // lines. The old version drew a 1.5 px hard stroke every 7 px, which at any
  // real distance aliased into moiré stripes; a gradient band per flute
  // survives mip-mapping into an honest average instead.
  const FLUTE = 14;
  for (let y = 0; y < S; y += FLUTE) {
    const g = ctx.createLinearGradient(0, y, 0, y + FLUTE);
    g.addColorStop(0, "rgba(96,70,38,0.22)");
    g.addColorStop(0.42, "rgba(255,235,196,0.10)");
    g.addColorStop(1, "rgba(96,70,38,0.22)");
    ctx.fillStyle = g;
    ctx.fillRect(0, y, S, FLUTE);
  }

  // Packing tape — slightly glossy, slightly crooked, with a lifted end.
  const tape = (x: number, y: number, w: number, h: number, rot: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = "rgba(214,196,158,0.42)";
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = "rgba(240,230,205,0.5)";
    ctx.lineWidth = 1.4;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    // Trapped air bubbles along the run.
    ctx.fillStyle = "rgba(255,250,235,0.32)";
    for (let i = 0; i < w / 22; i++) {
      ctx.beginPath();
      ctx.ellipse(-w / 2 + 14 + i * 22, (rand() - 0.5) * h * 0.5, 3 + rand() * 4, 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };
  tape(S * 0.5, S * 0.3, S * 1.2, 20, 0.012);
  tape(S * 0.66, S * 0.5, 18, S * 1.2, Math.PI / 2 + 0.008);

  // Scuffs and creases — worn corners, a bent fold line, a coffee ring's
  // worth of grubbiness. Cardboard that has been handled by a child.
  for (let i = 0; i < 40; i++) {
    const x = rand() * S;
    const y = rand() * S;
    ctx.strokeStyle = `rgba(120,92,54,${0.06 + rand() * 0.1})`;
    ctx.lineWidth = 1 + rand() * 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 90, y + (rand() - 0.5) * 40);
    ctx.stroke();
  }
  for (let i = 0; i < 8; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const r = 20 + rand() * 60;
    const g = ctx.createRadialGradient(x, y, r * 0.4, x, y, r);
    g.addColorStop(0, "rgba(92,66,34,0)");
    g.addColorStop(1, "rgba(92,66,34,0.13)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Kid doodles — unchanged in spirit, because they are the whole point of
  // the island. Just drawn with a wobblier hand now.
  const doodles = ["#e85d75", "#5db8e8", "#8cd16a", "#f2b134", "#b78ae0"];
  ctx.lineCap = "round";
  for (let i = 0; i < 11; i++) {
    ctx.strokeStyle = doodles[i % doodles.length];
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 3.4;
    const x = (i * 147 + 40) % S;
    const y = (i * 95 + 60) % S;
    ctx.beginPath();
    if (i % 3 === 0) {
      ctx.arc(x, y, 13, 0, Math.PI * 2); // sun / flower head
    } else if (i % 3 === 1) {
      ctx.moveTo(x - 14, y + 10);
      ctx.lineTo(x + 1, y - 14);
      ctx.lineTo(x + 14, y + 10); // little roof / mountain
    } else {
      ctx.moveTo(x - 16, y);
      ctx.quadraticCurveTo(x, y - 18, x + 16, y); // rainbow arc
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * The corrugation, as geometry the light can find: a tiling normal map of
 * parallel flutes with a fibre-scale roughness on top.
 *
 * This is the single change that stops the shops being painted boxes. A flat
 * wall with a picture of cardboard on it is lit exactly like a flat wall; the
 * same wall with flutes in its normals catches a highlight along every ridge
 * and goes dark between them, and it turns as you walk past it. Corrugation is
 * the most recognisable surface in the world and it costs one texture.
 *
 * Clone the returned texture per material and set `.repeat` — a clone shares
 * the image but carries its own UV transform, so one canvas dresses a 15 m
 * shop wall and a 40 cm bench slat at the right scale for each.
 */
function corrugationNormalTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#8080ff";
  ctx.fillRect(0, 0, S, S);

  // Flutes: a sine ridge running along +x, encoded as a left/right tilt in
  // the red channel. Sixteen flutes over the tile.
  const FLUTES = 16;
  const period = S / FLUTES;
  const img = ctx.getImageData(0, 0, S, S);
  for (let y = 0; y < S; y++) {
    // dHeight/dy of a sine ridge → the y tilt, which lives in green.
    const phase = ((y % period) / period) * Math.PI * 2;
    const slope = Math.cos(phase) * 0.55;
    const g = Math.round(THREE.MathUtils.clamp(0.5 - slope * 0.5, 0, 1) * 255);
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      img.data[i] = 128;
      img.data[i + 1] = g;
      img.data[i + 2] = 235;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Fibre grain over the flutes so the surface is not perfectly extruded.
  const rand = mulberry32(1212);
  for (let i = 0; i < 1600; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const a = rand() * Math.PI * 2;
    const len = 2 + rand() * 9;
    ctx.strokeStyle = rand() < 0.5 ? "rgba(96,128,255,0.22)" : "rgba(160,128,255,0.22)";
    ctx.lineWidth = 0.8 + rand() * 1.1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }

  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * The cut edge of a sheet of corrugated board: two liners with a row of
 * fluted arches sandwiched between them.
 *
 * Nothing says "this is cardboard, not a beige box" as fast as the exposed
 * edge, and it is the one detail a real cardboard build has on every single
 * cut. Applied as thin strips along wall tops and roof rims.
 */
function fluteEdgeTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 32;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#b08f5e";
  ctx.fillRect(0, 0, W, H);
  // Liners top and bottom, a touch paler than the core.
  ctx.fillStyle = "#cfae7a";
  ctx.fillRect(0, 0, W, 5);
  ctx.fillRect(0, H - 5, W, 5);
  // The fluting: alternating arches, each shaded so it reads as a tube.
  const P = 9;
  for (let x = 0; x < W; x += P) {
    const g = ctx.createLinearGradient(x, 0, x + P, 0);
    g.addColorStop(0, "rgba(72,50,24,0.75)");
    g.addColorStop(0.45, "rgba(226,204,164,0.55)");
    g.addColorStop(1, "rgba(72,50,24,0.75)");
    ctx.fillStyle = g;
    ctx.fillRect(x, 5, P - 1, H - 10);
  }
  // Dark seam where core meets liner — the shadow line inside the sheet.
  ctx.fillStyle = "rgba(60,40,18,0.4)";
  ctx.fillRect(0, 5, W, 1.5);
  ctx.fillRect(0, H - 6.5, W, 1.5);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Bark for the Dream Tree: vertical fissures in three browns, with moss
 * gathering on the shaded side and lichen where the light gets in.
 *
 * The tree stands next to a field of individually-modelled grass blades, so a
 * flat brown cylinder is the first thing the eye finds wrong in the frame.
 */
function barkTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 512;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(4711);

  ctx.fillStyle = "#6b4a2c";
  ctx.fillRect(0, 0, W, H);

  // Ridges and fissures: long, near-vertical, wandering. Dark first (the
  // cracks), then light (the ridges between them catching the sun).
  for (const [n, dark, wMin, wSpan] of [
    [90, true, 2, 7],
    [120, false, 1.5, 5],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const x = rand() * W;
      ctx.strokeStyle = dark
        ? `rgba(38,24,12,${0.3 + rand() * 0.4})`
        : `rgba(158,124,86,${0.2 + rand() * 0.3})`;
      ctx.lineWidth = wMin + rand() * wSpan;
      ctx.beginPath();
      let cx = x;
      ctx.moveTo(cx, -10);
      for (let y = 0; y < H + 20; y += 26) {
        cx += (rand() - 0.5) * 11;
        ctx.lineTo(cx, y);
      }
      ctx.stroke();
    }
  }
  // Knots — a couple of old branch scars.
  for (let i = 0; i < 3; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const r = 8 + rand() * 16;
    for (let k = 4; k > 0; k--) {
      ctx.strokeStyle = `rgba(44,28,14,${0.14 * k})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(x, y, (r * k) / 4, ((r * k) / 4) * 1.5, 0.3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // Moss low down and on one side; lichen blotches higher up.
  for (let i = 0; i < 400; i++) {
    const x = (rand() * W * 0.55 + W * 0.05) % W;
    const y = H - Math.pow(rand(), 0.6) * H * 0.7;
    ctx.fillStyle = `rgba(78,116,52,${0.1 + rand() * 0.3})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.5 + rand() * 5, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(178,186,158,${0.08 + rand() * 0.16})`;
    ctx.beginPath();
    ctx.ellipse(rand() * W, rand() * H * 0.7, 3 + rand() * 9, 2 + rand() * 6, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2.5, 1.4);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * A soft round contact shadow, drawn as a texture and laid on the grass under
 * anything heavy.
 *
 * The island sits outside the sun's shadow frustum — deliberately, since it is
 * floating in the sky with nothing under it to catch a shadow — so every
 * building on it was hovering a couple of centimetres above its own lawn. A
 * painted patch of dark under the footprint is the cheap fix and, at this art
 * level, an almost undetectable one.
 */
function contactShadowTexture(): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(18,26,10,0.55)");
  g.addColorStop(0.55, "rgba(18,26,10,0.34)");
  g.addColorStop(1, "rgba(18,26,10,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The cut edge of the turf — the band you see on the cylinder wall of the
 * grass cap, from the zipline and from anywhere below the island.
 *
 * A cylinder's side UVs run u around the rim and v from bottom to top, so this
 * is drawn as a cross-section: soil and pebbles at the bottom, a root mat in
 * the middle, and grass spilling over the top lip. It used to be a flat green
 * that made the island look like it was extruded out of felt.
 */
function turfEdgeTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 128;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  const soil = ctx.createLinearGradient(0, H, 0, 0);
  soil.addColorStop(0, "#6d4f33"); // deep, damp
  soil.addColorStop(0.55, "#846044");
  soil.addColorStop(1, "#5f4a30"); // darker again right under the roots
  ctx.fillStyle = soil;
  ctx.fillRect(0, 0, W, H);

  // Pebbles and clods through the soil.
  for (let i = 0; i < 220; i++) {
    const x = (i * 71) % W;
    const y = H * 0.3 + ((i * 137) % Math.round(H * 0.7));
    const r = 1 + (i % 4);
    ctx.fillStyle = i % 3 === 0 ? "rgba(160,142,118,0.5)" : "rgba(58,42,26,0.45)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Root mat: pale threads reaching down out of the turf.
  ctx.strokeStyle = "rgba(214,196,158,0.4)";
  for (let i = 0; i < 90; i++) {
    const x = (i * 47) % W;
    ctx.lineWidth = 0.8 + (i % 3) * 0.4;
    ctx.beginPath();
    ctx.moveTo(x, H * 0.34);
    ctx.bezierCurveTo(x + 4, H * 0.5, x - 5, H * 0.62, x + 2, H * 0.78);
    ctx.stroke();
  }

  // The turf layer itself, with a ragged underside where soil meets roots.
  ctx.fillStyle = "#3f7a33";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(W, 0);
  ctx.lineTo(W, H * 0.3);
  for (let x = W; x >= 0; x -= 8) {
    ctx.lineTo(x, H * (0.3 + Math.sin(x * 0.11) * 0.045 + ((x * 13) % 7) * 0.006));
  }
  ctx.closePath();
  ctx.fill();

  // Grass spilling over the top lip — the blades that hang past the edge.
  ctx.strokeStyle = "#5da944";
  ctx.lineCap = "round";
  for (let i = 0; i < 320; i++) {
    const x = (i * 29) % W;
    const len = 6 + ((i * 17) % 16);
    ctx.lineWidth = 1.2 + (i % 3) * 0.5;
    ctx.strokeStyle = ["#4e9a3c", "#69bb4f", "#7fc95e"][i % 3];
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.quadraticCurveTo(x + ((i % 5) - 2), len * 0.6, x + ((i % 7) - 3), len);
    ctx.stroke();
  }

  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(14, 1);
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

/**
 * A painted cardboard facade.
 *
 * The important word is *painted*. Emulsion on corrugated board does not go on
 * flat: it soaks into the fibre, thins over the flute ridges so the kraft
 * ghosts through, pools at the brush edges, and never quite covers the corners.
 * The old version of this was a solid fill with four grain lines on it, which
 * is why the shops read as coloured boxes from any distance at all.
 *
 * Canvas y runs 0 at the top of the wall to S at the bottom (the wall meshes
 * are box faces with unrotated UVs), so the weathering at the end is applied
 * to the *bottom* of the image, where the wall meets the wet grass.
 */
function facadeTexture(tint: string, trim: string): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(
    // Same tint → same wall, always. Cheap string hash so the two shops don't
    // share a weathering pattern.
    [...tint].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7),
  );

  // Kraft underneath. Everything after this is paint that only mostly covers.
  ctx.fillStyle = "#b99a68";
  ctx.fillRect(0, 0, S, S);

  // Roller coats: broad vertical passes, each slightly translucent, so the
  // colour builds unevenly and the overlaps show as faint bands.
  ctx.fillStyle = tint;
  ctx.globalAlpha = 0.88;
  ctx.fillRect(0, 0, S, S);
  ctx.globalAlpha = 1;
  // Each pass is a soft-edged wash, not a rectangle. `fillRect` was the first
  // thing tried here and a hard vertical edge — even at four percent alpha —
  // is a crisp seam a metre wide on a thirteen-metre wall, and a dozen of them
  // turn a painted shop into a barcode.
  for (let i = 0; i < 14; i++) {
    const x = rand() * S;
    const w = 70 + rand() * 150;
    const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    const a = 0.05 + rand() * 0.08;
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, rand() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(30,20,8,${a})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - w / 2, -10, w, S + 20);
  }
  ctx.globalAlpha = 1;

  // Brush texture within the coats: fine light and dark streaks following the
  // stroke direction. Kept faint — one 512 px texture covers a 13 m wall, so
  // a stroke you can see here is a 10 cm stripe on the building, and a wall of
  // those reads as dirt rather than as paint.
  for (let i = 0; i < 420; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const len = 30 + rand() * 110;
    ctx.strokeStyle = rand() < 0.5 ? "rgba(255,255,255,0.035)" : "rgba(40,26,10,0.04)";
    ctx.lineWidth = 0.8 + rand() * 2.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 12, y + len);
    ctx.stroke();
  }

  // Flute ghosting: the paint sits thinner on the ridges, so the corrugation
  // shows faintly through the colour. Low contrast on purpose — this is the
  // texture equivalent of the normal map, for the far view where the normal
  // map has mipped away. Pitched to match `flutes()` on the wall material; if
  // one is retuned the other has to move with it or the wall gets two sets of
  // corrugation at different spacings, which reads as moiré.
  for (let y = 0; y < S; y += 64) {
    const g = ctx.createLinearGradient(0, y, 0, y + 64);
    g.addColorStop(0, "rgba(50,34,14,0.055)");
    g.addColorStop(0.45, "rgba(255,255,255,0.035)");
    g.addColorStop(1, "rgba(50,34,14,0.055)");
    ctx.fillStyle = g;
    ctx.fillRect(0, y, S, 64);
  }

  // Baseboard + upper trim line, hand-painted: not straight, and the brush
  // ran out at one end.
  ctx.fillStyle = trim;
  ctx.globalAlpha = 0.88;
  ctx.beginPath();
  ctx.moveTo(0, S - 40);
  for (let x = 0; x <= S; x += 32) ctx.lineTo(x, S - 40 + Math.sin(x * 0.03) * 3.5);
  ctx.lineTo(S, S);
  ctx.lineTo(0, S);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.38;
  ctx.fillRect(0, 52, S, 9);
  ctx.globalAlpha = 1;

  // Chips and scuffs where the kraft is showing through the paint — corners,
  // the odd knock, a scrape along the baseboard.
  for (let i = 0; i < 90; i++) {
    const edgeBias = rand();
    const x = edgeBias < 0.35 ? rand() * 40 : edgeBias < 0.7 ? S - rand() * 40 : rand() * S;
    const y = rand() < 0.5 ? S - rand() * 90 : rand() * S;
    ctx.fillStyle = `rgba(176,146,98,${0.25 + rand() * 0.35})`;
    ctx.beginPath();
    ctx.ellipse(x, y, 1.5 + rand() * 6, 1 + rand() * 3, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Ground weathering: splash-back dirt up the bottom of the wall, and a damp
  // line right at the grass. A building that is clean where it meets the
  // ground is the tell that it was dropped in rather than built there.
  const damp = ctx.createLinearGradient(0, S, 0, S - 110);
  damp.addColorStop(0, "rgba(56,44,24,0.42)");
  damp.addColorStop(0.4, "rgba(64,52,28,0.16)");
  damp.addColorStop(1, "rgba(64,52,28,0)");
  ctx.fillStyle = damp;
  ctx.fillRect(0, S - 110, S, 110);
  for (let i = 0; i < 160; i++) {
    const x = rand() * S;
    const y = S - rand() * rand() * 90;
    ctx.fillStyle = `rgba(70,54,28,${0.1 + rand() * 0.22})`;
    ctx.beginPath();
    ctx.arc(x, y, 1 + rand() * 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
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
  /**
   * Thin the lawn out. A phone is already pushing a 3× pixel ratio over the
   * whole district; twenty-six thousand grass blades is a fine trade on a
   * laptop and a bad one there. Same field, a third of the blades.
   */
  lowDetail?: boolean;
}): IslandWorld {
  const { centerX, centerZ, topY, boxes, lowDetail = false } = opts;
  const group = new THREE.Group();
  group.position.set(centerX, topY, centerZ); // group origin = island surface center
  const spinners: THREE.Object3D[] = [];
  const starSpots: THREE.Vector3[] = [];

  const cardboard = cardboardTexture();
  const corrugation = corrugationNormalTexture();
  const fluteEdge = fluteEdgeTexture();
  const contactShadow = contactShadowTexture();

  /**
   * Clone the corrugation for one surface at one scale.
   *
   * A three texture's `.repeat` belongs to the texture, not the material, so
   * sharing one instance across a 15 m shop wall and a 40 cm bench slat gives
   * you flutes at whichever scale was set last. Clones share the uploaded
   * image — this is a UV transform, not another megabyte of VRAM.
   */
  const flutes = (repeatU: number, repeatV = repeatU) => {
    const t = corrugation.clone();
    t.needsUpdate = true;
    t.repeat.set(repeatU, repeatV);
    return t;
  };

  const cardboardMat = new THREE.MeshStandardMaterial({
    map: cardboard,
    normalMap: flutes(3, 3),
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughness: 0.94,
  });
  // The "cut board" tone — roof slabs, posts, legs, counters. Now with the
  // corrugation in its normals, which is most of what makes a roof slab stop
  // looking like a slab of butter.
  const cardboardDark = new THREE.MeshStandardMaterial({
    color: "#9a7a4e",
    normalMap: flutes(6, 6),
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 0.96,
  });

  /**
   * Lay a soft dark patch on the lawn under something.
   *
   * See `contactShadowTexture` for why this exists rather than a real shadow.
   * `renderOrder` and `polygonOffset` keep it off the grass cap's z-fighting
   * range without lifting it far enough to be visible as a floating card.
   */
  const contactShadowMat = new THREE.MeshBasicMaterial({
    map: contactShadow,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const dropShadow = (
    parent: THREE.Object3D,
    x: number,
    z: number,
    sx: number,
    sz = sx,
    rotY = 0,
  ) => {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), contactShadowMat);
    s.rotation.set(-Math.PI / 2, 0, rotY);
    s.position.set(x, 0.02, z);
    s.renderOrder = 1;
    parent.add(s);
    return s;
  };

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
  // The cut edge of the turf, seen from below and from the zipline: soil with
  // roots in it and a fringe of grass over the lip, not a green wall.
  const grassSide = new THREE.MeshStandardMaterial({
    map: turfEdgeTexture(),
    roughness: 1,
    flatShading: true,
  });
  const lawn = lawnTextures();
  const top = new THREE.Mesh(capGeo, [
    grassSide,
    new THREE.MeshStandardMaterial({
      map: lawn.map,
      normalMap: lawn.normalMap,
      // Shallow. A normal map strong enough to see from the air makes the
      // ground look like crumpled foil from two metres away.
      normalScale: new THREE.Vector2(1.4, 1.4),
      roughnessMap: lawn.roughnessMap,
      roughness: 0.95,
      metalness: 0,
    }),
    grassSide,
  ]);
  top.position.y = -1.6;
  top.receiveShadow = true;
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
    const poolRand = mulberry32(2025);

    /**
     * The pool used to be one flat cyan disc, which is the same silhouette a
     * sheet of blue card would have. Water reads as water because of three
     * things, and none of them is its colour: it goes darker and bluer as it
     * gets deeper, it is wet at the edge where it meets the land, and its
     * surface moves.
     *
     * So: a bed painted with the depth gradient and a shelf of pale sand at
     * the rim, and a separate translucent surface over it that ripples.
     */
    const bedTex = (() => {
      const S = 256;
      const c = document.createElement("canvas");
      c.width = c.height = S;
      const x = c.getContext("2d")!;
      const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      g.addColorStop(0, "#1d5f74"); // deepest, in the middle
      g.addColorStop(0.5, "#37879b");
      g.addColorStop(0.78, "#8fbfae");
      g.addColorStop(0.93, "#cdba90"); // the sand shelf
      g.addColorStop(1, "#b9a279");
      x.fillStyle = g;
      x.fillRect(0, 0, S, S);
      // Pebbles and silt on the bed, thinning toward the middle.
      for (let i = 0; i < 900; i++) {
        const a = poolRand() * Math.PI * 2;
        const rr = Math.pow(poolRand(), 0.55) * (S / 2);
        const px = S / 2 + Math.cos(a) * rr;
        const py = S / 2 + Math.sin(a) * rr;
        x.fillStyle = poolRand() < 0.5
          ? `rgba(220,206,172,${0.1 + poolRand() * 0.3})`
          : `rgba(40,60,52,${0.08 + poolRand() * 0.22})`;
        x.beginPath();
        x.ellipse(px, py, 1 + poolRand() * 3.5, 1 + poolRand() * 2.6, poolRand() * 3, 0, Math.PI * 2);
        x.fill();
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();

    const bed = new THREE.Mesh(
      new THREE.CircleGeometry(4.6, 40),
      new THREE.MeshStandardMaterial({ map: bedTex, roughness: 0.95 }),
    );
    bed.rotation.x = -Math.PI / 2;
    bed.position.set(POOL_X, 0.05, POOL_Z);
    group.add(bed);

    // The surface: a ring, not a circle. `CircleGeometry` is a fan — one
    // vertex in the middle and one row around the rim — so displacing it can
    // only tilt the whole disc. `RingGeometry`'s phiSegments give the radial
    // rows the ripple actually needs; the 2 cm hole in the middle is under
    // the water line and nobody will ever find it.
    const surfGeo = new THREE.RingGeometry(0.02, 4.2, 44, 14);
    const surfBase = Float32Array.from(surfGeo.attributes.position.array);
    const poolMat = new THREE.MeshStandardMaterial({
      color: "#7fd0e2", roughness: 0.08, metalness: 0.25,
      transparent: true, opacity: 0.62,
      emissive: "#12414f", emissiveIntensity: 0.22,
      side: THREE.DoubleSide,
    });
    const pool = new THREE.Mesh(surfGeo, poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(POOL_X, 0.12, POOL_Z);
    group.add(pool);

    // Damp sand ring where the water has been lapping — the wet line.
    const wet = new THREE.Mesh(
      new THREE.RingGeometry(4.35, 5.3, 40),
      new THREE.MeshStandardMaterial({
        color: "#6f6247", roughness: 1, transparent: true, opacity: 0.55,
        depthWrite: false,
      }),
    );
    wet.rotation.x = -Math.PI / 2;
    wet.position.set(POOL_X, 0.03, POOL_Z);
    wet.renderOrder = 1;
    group.add(wet);

    // Stone lip around the pool — now varied in size and seated properly into
    // the ground rather than a ring of twelve identical beads.
    const lipMat = new THREE.MeshStandardMaterial({ color: "#b3a68d", roughness: 0.95, flatShading: true });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + poolRand() * 0.24;
      const sz = 0.32 + poolRand() * 0.42;
      const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(sz, 0), lipMat);
      const rr = 4.75 + (poolRand() - 0.5) * 0.5;
      stone.position.set(POOL_X + Math.cos(a) * rr, sz * 0.42, POOL_Z + Math.sin(a) * rr);
      stone.scale.set(1, 0.62, 1);
      stone.rotation.set(poolRand(), a * 3, poolRand() * 0.4);
      stone.castShadow = true;
      group.add(stone);
    }
    // Reeds standing in the shallows on one side.
    const reedMat = new THREE.MeshStandardMaterial({
      color: "#5c8f3c", roughness: 0.9, side: THREE.DoubleSide,
    });
    for (let i = 0; i < 26; i++) {
      const a = 1.6 + poolRand() * 1.5;
      const rr = 3.6 + poolRand() * 1.4;
      const h = 0.7 + poolRand() * 0.9;
      const reed = new THREE.Mesh(new THREE.PlaneGeometry(0.07, h), reedMat);
      reed.position.set(POOL_X + Math.cos(a) * rr, h / 2, POOL_Z + Math.sin(a) * rr);
      reed.rotation.set((poolRand() - 0.5) * 0.4, poolRand() * Math.PI, (poolRand() - 0.5) * 0.35);
      group.add(reed);
    }

    craftAnims.push((_dt, now) => {
      poolMat.emissiveIntensity = 0.22 + Math.sin(now * 0.0011) * 0.08;
      const p = surfGeo.attributes.position as THREE.BufferAttribute;
      const t = now * 0.0016;
      for (let i = 0; i < p.count; i++) {
        const x = surfBase[i * 3];
        const y = surfBase[i * 3 + 1];
        const r = Math.hypot(x, y);
        // Two rings travelling outward at different speeds, plus a slow slosh
        // across the whole surface. Amplitude is a couple of centimetres —
        // any more and a two-metre puddle turns into a swell at sea.
        p.setZ(
          i,
          Math.sin(r * 3.1 - t * 2.2) * 0.022 +
            Math.sin(r * 6.7 - t * 3.4) * 0.011 +
            Math.sin(x * 1.4 + t * 0.9) * 0.014,
        );
      }
      p.needsUpdate = true;
      surfGeo.computeVertexNormals();
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

    // Painted board: the facade colour, the corrugation in the normals, and
    // enough of a roughness spread that the light rakes across the flutes
    // instead of settling on the wall as one value.
    //
    // The flute pitch is set to about 1.5 per metre, which is nothing like
    // real C-flute — but this is a nine-metre-tall box built by a child out of
    // whatever came off a fridge, and at true pitch the ridges land under a
    // pixel and turn the whole wall into shimmering moiré. Pitched to what
    // reads, not to what measures.
    const wallMat = new THREE.MeshStandardMaterial({
      map: facadeTexture(s.bg, s.fg),
      normalMap: flutes(1, s.h * 0.095),
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.88,
      metalness: 0,
    });
    const trimMat = new THREE.MeshStandardMaterial({ color: s.fg, roughness: 0.62 });
    // The exposed sheet edge, for the strips capping the walls.
    const edgeMat = new THREE.MeshStandardMaterial({
      map: (() => {
        const t = fluteEdge.clone();
        t.needsUpdate = true;
        t.repeat.set(Math.max(2, Math.round(s.w * 0.8)), 1);
        return t;
      })(),
      roughness: 0.95,
    });

    // The building sits on the lawn — see `dropShadow`.
    dropShadow(shop, 0, 0, s.w * 1.9, s.d * 1.9);

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
      mesh.castShadow = true;
      mesh.receiveShadow = true;
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

    // ---- Roof --------------------------------------------------------
    // Still a flat landable slab — the collision box below assumes it and
    // people jump on these — but no longer a bare slab. What it gets is what a
    // real sheet of board laid on a box gets: a fold crease down the middle
    // where it was scored to sit flat, corrugated ridges running across it, a
    // taped seam, and a lifted corner that was never quite pressed down.
    const roofW = s.w + 1.6;
    const roofD = s.d + 1.6;
    const roofMat = new THREE.MeshStandardMaterial({
      map: cardboard,
      normalMap: flutes(1, roofD * 0.1),
      normalScale: new THREE.Vector2(1.15, 1.15),
      color: "#b59468",
      roughness: 0.96,
    });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(roofW, 0.5, roofD), roofMat);
    roof.position.y = s.h + 0.25;
    roof.rotation.z = 0.015;
    roof.castShadow = true;
    roof.receiveShadow = true;
    shop.add(roof);

    // Ridges: shallow battens across the sheet. Cheap geometry, and they are
    // what gives the roof a silhouette from the zipline and a set of edges for
    // the light to catch from the plaza.
    {
      const ridges = Math.max(4, Math.round(roofD / 1.5));
      const ridgeGeo = new THREE.BoxGeometry(roofW - 0.25, 0.12, 0.5);
      for (let i = 0; i < ridges; i++) {
        const t = (i + 0.5) / ridges - 0.5;
        const bar = new THREE.Mesh(ridgeGeo, cardboardDark);
        bar.position.set(0, s.h + 0.53, t * (roofD - 0.6));
        bar.rotation.z = 0.015;
        bar.castShadow = true;
        shop.add(bar);
      }
      // Scored fold line along the long axis.
      const crease = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.1, roofD - 0.2),
        new THREE.MeshStandardMaterial({ color: "#7d6039", roughness: 1 }),
      );
      crease.position.set(0, s.h + 0.52, 0);
      shop.add(crease);
      // Packing tape over the seam — the join that actually holds it on.
      const tape = new THREE.Mesh(
        new THREE.BoxGeometry(0.62, 0.04, roofD + 0.5),
        new THREE.MeshStandardMaterial({ color: "#d9c8a4", roughness: 0.42, metalness: 0.05 }),
      );
      tape.position.set(roofW * 0.22, s.h + 0.53, 0);
      shop.add(tape);
      // One corner flap, lifted. Nobody's cardboard roof is flat everywhere.
      const flap = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 1.5), roofMat);
      flap.position.set(-roofW / 2 + 0.9, s.h + 0.62, roofD / 2 - 0.75);
      flap.rotation.x = -0.22;
      flap.rotation.z = 0.06;
      shop.add(flap);
    }

    // Exposed sheet edge all the way round the roof rim — the fluting you
    // can see from the ground, which is the detail that reads as cardboard
    // faster than any amount of brown paint.
    for (const [w, d, ry] of [
      [roofW, 0, 0],
      [roofW, 0, Math.PI],
      [0, roofD, Math.PI / 2],
      [0, roofD, -Math.PI / 2],
    ] as const) {
      const len = w || d;
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.34), edgeMat);
      strip.position.set(
        ry === Math.PI / 2 ? roofW / 2 + 0.01 : ry === -Math.PI / 2 ? -roofW / 2 - 0.01 : 0,
        s.h + 0.25,
        ry === 0 ? roofD / 2 + 0.01 : ry === Math.PI ? -roofD / 2 - 0.01 : 0,
      );
      strip.rotation.y = ry;
      shop.add(strip);
    }

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

    /**
     * Windows on the side walls.
     *
     * These used to be a single emissive plane laid flat on the wall surface —
     * a lit rectangle, which from any angle other than straight-on is exactly
     * what it looked like. A window is a hole: it has a reveal you can see the
     * thickness of, a sill that catches light and throws a line of shade under
     * itself, and glass that sits back from the face and picks up the sky.
     * So this builds all four: reveal, sill, recessed glass, mullions.
     */
    const glassMat = new THREE.MeshStandardMaterial({
      color: "#fff3cf",
      emissive: "#ffcf7a",
      emissiveIntensity: 0.85,
      // Glass is the one thing on this island that is not matte. A low
      // roughness and a little metalness give it a specular the flutes and the
      // paint cannot have, which is what separates it from the wall.
      roughness: 0.12,
      metalness: 0.3,
      side: THREE.DoubleSide,
    });
    const WIN_W = 2.2;
    const WIN_H = 1.5;
    for (const side of [-1, 1]) {
      const faceV = side * (V / 2);
      const [wx, wz] = toLocal(0, faceV);
      const yaw = alongX ? 0 : Math.PI / 2;

      // Glass, set back into the wall by most of the wall's thickness.
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(WIN_W, WIN_H), glassMat);
      const [gx, gz] = toLocal(0, faceV - side * WALL_T * 0.7);
      pane.position.set(gx, 2.2, gz);
      pane.rotation.y = yaw;
      shop.add(pane);

      // The reveal: four short walls around the opening, in the facade
      // material, so the wall reads as having thickness at the hole.
      const revealMat = new THREE.MeshStandardMaterial({ color: s.bg, roughness: 0.9 });
      for (const [ow, oh, oy, ov] of [
        [WIN_W + 0.3, 0.16, WIN_H / 2 + 0.08, 0],
        [WIN_W + 0.3, 0.16, -WIN_H / 2 - 0.08, 0],
        [0.16, WIN_H + 0.3, 0, WIN_W / 2 + 0.08],
        [0.16, WIN_H + 0.3, 0, -WIN_W / 2 - 0.08],
      ] as const) {
        const sw = alongX ? ow : WALL_T * 0.7;
        const sd = alongX ? WALL_T * 0.7 : ow;
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(sw, oh, sd), revealMat);
        const [jx, jz] = toLocal(ov, faceV - side * WALL_T * 0.35);
        jamb.position.set(jx, 2.2 + oy, jz);
        shop.add(jamb);
      }

      // Frame + mullions, proud of the wall.
      for (const mull of [0, 1]) {
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(mull ? WIN_W + 0.15 : 0.1, mull ? 0.1 : WIN_H + 0.1, 0.08),
          trimMat,
        );
        const [mx, mz] = toLocal(0, faceV - side * WALL_T * 0.55);
        bar.position.set(mx, 2.2, mz);
        bar.rotation.y = yaw;
        shop.add(bar);
      }
      // Casing round the opening: four bars, not one box. A solid box here
      // would sit in front of the recessed glass and brick the window up.
      for (const [along, oy, ov] of [
        [WIN_W + 0.5, WIN_H / 2 + 0.17, 0],
        [WIN_W + 0.5, -WIN_H / 2 - 0.17, 0],
        [0, 0, WIN_W / 2 + 0.17],
        [0, 0, -WIN_W / 2 - 0.17],
      ] as const) {
        const horiz = along > 0;
        const lenU = horiz ? along : 0.17;
        const lenY = horiz ? 0.17 : WIN_H + 0.5;
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(alongX ? lenU || 0.17 : 0.15, lenY, alongX ? 0.15 : lenU || 0.17),
          trimMat,
        );
        const [cx4, cz4] = toLocal(ov, faceV + side * 0.04);
        bar.position.set(cx4, 2.2 + oy, cz4);
        shop.add(bar);
      }

      // Sill: a board under the window with a lip, and the flower box on it.
      const sill = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? WIN_W + 0.7 : 0.42, 0.14, alongX ? 0.42 : WIN_W + 0.7),
        cardboardDark,
      );
      const [sx, sz] = toLocal(0, faceV + side * 0.16);
      sill.position.set(sx, 2.2 - WIN_H / 2 - 0.16, sz);
      sill.castShadow = true;
      shop.add(sill);

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
      // Trailing greenery out of the box, so it isn't three balls on a shelf.
      for (let f = 0; f < 5; f++) {
        const vine = new THREE.Mesh(
          new THREE.CylinderGeometry(0.03, 0.015, 0.35 + (f % 3) * 0.22, 4),
          new THREE.MeshStandardMaterial({ color: "#4e8c3a", roughness: 0.95 }),
        );
        const [vx, vz] = toLocal((f - 2) * 0.5, side * (V / 2 + 0.42));
        vine.position.set(vx, 1.05 - (f % 3) * 0.08, vz);
        vine.rotation.z = (f - 2) * 0.09;
        shop.add(vine);
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
  const treeRand = mulberry32(9091);
  /**
   * Trunk. A cylinder is a pole; a tree is a cone that swells at the base into
   * roots and is never quite round. So the geometry gets a radial wobble and a
   * ring of root buttresses fanning into the grass, and the bark is a real
   * texture rather than a flat brown — vertical fissures, because a smooth
   * trunk next to blade-level grass is the thing your eye lands on.
   */
  const trunkGeo = new THREE.CylinderGeometry(0.85, 1.9, 9, 14, 6);
  {
    const p = trunkGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const r = Math.hypot(x, z);
      if (r < 0.01) continue;
      const a = Math.atan2(z, x);
      // Two frequencies: a slow oval and a fast fluting, both fading out with
      // height so the crown stays a clean cylinder for the canopy to sit on.
      const fade = 1 - THREE.MathUtils.clamp((y + 4.5) / 9, 0, 1) * 0.65;
      const w = 1 + (Math.sin(a * 3 + 0.7) * 0.07 + Math.sin(a * 7) * 0.035) * fade;
      p.setX(i, x * w);
      p.setZ(i, z * w);
      // A slow lean, so it is not a plumb line.
      p.setX(i, p.getX(i) + Math.pow((y + 4.5) / 9, 2) * 0.5);
    }
    p.needsUpdate = true;
    trunkGeo.computeVertexNormals();
  }
  const barkMat = new THREE.MeshStandardMaterial({
    map: barkTexture(),
    normalMap: (() => {
      const t = corrugation.clone();
      t.needsUpdate = true;
      // Corrugation rotated a quarter turn is a passable set of bark fissures:
      // parallel vertical grooves. Reusing it saves a texture and nobody has
      // ever looked at a tree and thought "those flutes are horizontal".
      t.rotation = Math.PI / 2;
      t.center.set(0.5, 0.5);
      t.repeat.set(2.5, 1.4);
      return t;
    })(),
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughness: 1,
  });
  const trunk = new THREE.Mesh(trunkGeo, barkMat);
  trunk.position.y = 4.5;
  trunk.castShadow = true;
  tree.add(trunk);
  // Root buttresses flaring into the lawn.
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + treeRand() * 0.5;
    const len = 1.1 + treeRand() * 1.3;
    const root = new THREE.Mesh(new THREE.ConeGeometry(0.42 + treeRand() * 0.3, len * 2.4, 5), barkMat);
    root.position.set(Math.cos(a) * (1.5 + len * 0.28), 0.5, Math.sin(a) * (1.5 + len * 0.28));
    root.rotation.z = Math.cos(a) * 0.85;
    root.rotation.x = -Math.sin(a) * 0.85;
    tree.add(root);
  }
  dropShadow(tree, 0, 0, 13, 13);

  /**
   * Canopy. Three big spheres is a cloud, not foliage — you can see every
   * facet and the silhouette is a smooth arc. Real foliage reads as clumps of
   * clumps: a few large masses, a lot of small ones bunched at their edges,
   * and a broken outline. So: seven masses, each roughened by pushing its
   * vertices in and out, in three greens so the light side and the shaded side
   * of the crown are different colours before any lighting happens.
   */
  const leafGreens = ["#3d7f3a", "#4fa04a", "#68b855"].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.92, flatShading: true }),
  );
  const roughBlob = (r: number, detail: number) => {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const p = g.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      // Gentle. Push these vertices around much harder and the flat-shaded
      // facets stop reading as leaf clumps and start reading as crumpled foil.
      v.multiplyScalar(0.91 + treeRand() * 0.17);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  };
  const canopy = new THREE.Group();
  canopy.position.y = 0.4;
  tree.add(canopy);
  ([
    [0.3, 10.6, 0.1, 4.0],
    [-2.9, 9.3, 1.5, 2.9],
    [2.7, 9.7, -1.3, 3.1],
    [-1.4, 12.2, -1.9, 2.4],
    [2.0, 12.0, 1.7, 2.2],
    [-3.6, 11.4, -1.0, 1.9],
    [0.6, 8.2, -3.1, 2.3],
  ] as const).forEach(([x, y, z, r], i) => {
    const blob = new THREE.Mesh(roughBlob(r, 2), leafGreens[i % 3]);
    blob.position.set(x, y, z);
    blob.scale.y = 0.82 + treeRand() * 0.3;
    blob.castShadow = true;
    canopy.add(blob);
    // Small satellite clumps around the big mass, which is what breaks the
    // silhouette. Without these the crown is a smooth arc against the sky and
    // it does not matter how good the rest of it is.
    const sats = 4 + Math.floor(treeRand() * 4);
    for (let s = 0; s < sats; s++) {
      const sa = treeRand() * Math.PI * 2;
      const sp = Math.acos(2 * treeRand() - 1);
      const sr = r * (0.26 + treeRand() * 0.2);
      const tuft = new THREE.Mesh(roughBlob(sr, 1), leafGreens[(i + s) % 3]);
      tuft.position.set(
        x + Math.sin(sp) * Math.cos(sa) * r * 0.95,
        y + Math.cos(sp) * r * 0.85,
        z + Math.sin(sp) * Math.sin(sa) * r * 0.95,
      );
      canopy.add(tuft);
    }
  });
  // The whole crown breathes in the same wind that moves the grass.
  craftAnims.push((_dt, now) => {
    canopy.rotation.z = Math.sin(now * 0.00042) * 0.017;
    canopy.rotation.x = Math.cos(now * 0.00031) * 0.013;
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
  /** Set when the rock-paper-scissors table is built, below. */
  let rpsAnimate: ((t: number) => void) | null = null;

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
    // Green paint with brushy variation. Pitched a shade darker and duller
    // than it used to be so the painted pad sits *into* the lawn instead of
    // glowing out of it — the grass around it is a deep meadow green now, and
    // a bright poster green next to that reads as a decal.
    ctx.fillStyle = "#37773a";
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = "rgba(66, 138, 72, 0.5)";
    for (let i = 0; i < 80; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      ctx.beginPath();
      ctx.ellipse(x, y, 18 + Math.random() * 30, 8 + Math.random() * 16, Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // Brush hair drag and a dry-brush pass showing the kraft under the paint.
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const a = Math.random() * Math.PI * 2;
      const len = 8 + Math.random() * 40;
      ctx.strokeStyle =
        Math.random() < 0.5
          ? "rgba(24,58,26,0.14)"
          : "rgba(150,120,74,0.10)"; // kraft grinning through
      ctx.lineWidth = 0.8 + Math.random() * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
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
  const TV_X = 31;
  const TV_Z = 24;
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
  const SHOP_X = 8;
  const SHOP_Z = 34;
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

  // ---- CHARACTER STUDIO: the hologram station ------------------------
  // A glowing ground-level stage that projects a hologram of the
  // character you're previewing. Walk up, cycle the holograms, become
  // one. Projector pylons ring the back arc; a sparkle column rises
  // through the figure.
  // Town plan: on the west ring south of Trader Joe's, beam visible
  // from the plaza. (It once sat at TJ-roof height — y=9 — which left
  // it hovering in the sky after the town re-plan and out of reach of
  // its own walk-up radius. It lives on the ground now.)
  const AVATAR_X = 28;
  const AVATAR_Z = 31;
  const AVATAR_Y = 0;
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
  let avatarSparkles!: THREE.Points;
  let avatarSparkleGeo!: THREE.BufferGeometry;
  const avatarPylonTipMats: THREE.MeshBasicMaterial[] = [];
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

    // Faint concentric ground rings that anchor the studio to the lawn
    // and read as a "stage area" from across the plaza.
    for (const [r, op] of [
      [2.7, 0.3],
      [3.3, 0.16],
    ] as const) {
      const gRing = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.06, r, 56),
        new THREE.MeshBasicMaterial({
          color: "#2dd4a8",
          transparent: true,
          opacity: op,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        }),
      );
      gRing.rotation.x = -Math.PI / 2;
      gRing.position.y = 0.02;
      avatarPortalGroup.add(gRing);
    }

    // Three projector pylons on the back (west) arc — little angled
    // posts whose glowing tips fire thin beams at the hologram's
    // chest, so the figure reads as "projected", not just floating.
    // The east side stays open: that's the approach from the plaza.
    const pylonPostMat = new THREE.MeshStandardMaterial({
      color: "#1c2733",
      roughness: 0.55,
      metalness: 0.4,
    });
    const HOLO_FOCUS = new THREE.Vector3(0, 1.55, 0);
    for (const ang of [Math.PI * 0.75, Math.PI, Math.PI * 1.25]) {
      const px = Math.cos(ang) * 2.75;
      const pz = Math.sin(ang) * 2.75;
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.14, 1.15, 10),
        pylonPostMat,
      );
      post.position.set(px, 0.575, pz);
      post.lookAt(HOLO_FOCUS.x, 3.4, HOLO_FOCUS.z); // slight inward lean
      post.rotateX(Math.PI / 2);
      avatarPortalGroup.add(post);

      const tipMat = new THREE.MeshBasicMaterial({
        color: "#7af0ff",
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      avatarPylonTipMats.push(tipMat);
      const tipPos = new THREE.Vector3(px * 0.88, 1.12, pz * 0.88);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), tipMat);
      tip.position.copy(tipPos);
      avatarPortalGroup.add(tip);

      // Thin beam from tip to the hologram focus point.
      const beamVec = HOLO_FOCUS.clone().sub(tipPos);
      const beamLen = beamVec.length();
      const pBeam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.035, beamLen, 6, 1, true),
        new THREE.MeshBasicMaterial({
          color: "#7af0ff",
          transparent: true,
          opacity: 0.22,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        }),
      );
      pBeam.position.copy(tipPos).addScaledVector(beamVec, 0.5);
      pBeam.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        beamVec.clone().normalize(),
      );
      avatarPortalGroup.add(pBeam);
    }

    // Sparkle column — drifting motes rising through the figure.
    {
      const N = 46;
      const pts = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * 1.15;
        pts[i * 3] = Math.cos(a) * r;
        pts[i * 3 + 1] = Math.random() * 3.6;
        pts[i * 3 + 2] = Math.sin(a) * r;
      }
      avatarSparkleGeo = new THREE.BufferGeometry();
      avatarSparkleGeo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
      avatarSparkles = new THREE.Points(
        avatarSparkleGeo,
        new THREE.PointsMaterial({
          color: "#a8fff0",
          size: 0.085,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        }),
      );
      avatarSparkles.position.y = 0.2;
      avatarPortalGroup.add(avatarSparkles);
    }

    // Floating "CHARACTER STUDIO" sign above the beam, facing the plaza.
    const ac = document.createElement("canvas");
    ac.width = 640;
    ac.height = 128;
    const ax = ac.getContext("2d")!;
    ax.fillStyle = "rgba(0,0,0,0)";
    ax.fillRect(0, 0, 640, 128);
    ax.font = "bold 52px 'Sora', system-ui, sans-serif";
    ax.textAlign = "center";
    ax.textBaseline = "middle";
    ax.shadowColor = "#7af0ff";
    ax.shadowBlur = 30;
    ax.fillStyle = "#e6fbff";
    ax.fillText("CHARACTER STUDIO", 320, 50);
    ax.shadowBlur = 0;
    ax.font = "24px 'Manrope', sans-serif";
    ax.fillStyle = "#2dd4a8";
    ax.fillText("walk up · become anyone", 320, 100);
    const aSignTex = new THREE.CanvasTexture(ac);
    aSignTex.colorSpace = THREE.SRGBColorSpace;
    const aSign = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 0.84),
      new THREE.MeshBasicMaterial({
        map: aSignTex,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    aSign.position.set(0, 5.1, 0);
    aSign.rotation.y = Math.PI / 2; // face the plaza (east, +x)
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
  const ARCADE_X = 22;
  const ARCADE_Z = 37;
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

  // ------------------------------------------------------------------
  // The rock-paper-scissors table — one hand against the house, staked in
  // Vibecoin. Sits next to the arcade cabinet because the SE corner is where
  // the island keeps the things that cost money, and because "walk past the
  // machine, sit at the table" is a nicer sentence than either alone.
  // ------------------------------------------------------------------
  const RPS_X = 13;
  const RPS_Z = 38;
  const rpsGroup = new THREE.Group();
  rpsGroup.position.set(RPS_X, 0, RPS_Z);
  rpsGroup.rotation.y = Math.PI / 7;
  {
    const feltMat = new THREE.MeshStandardMaterial({
      color: "#0d4a3c",
      roughness: 0.92,
      metalness: 0.02,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: "#c2a24a",
      roughness: 0.42,
      metalness: 0.65,
    });
    const legMat = new THREE.MeshStandardMaterial({ color: "#3a2a1c", roughness: 0.8 });

    // A half-round dealer's table: flat edge to the house, curve to the player.
    const top = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.14, 36, 1, false, 0, Math.PI), feltMat);
    top.position.y = 0.94;
    top.castShadow = true;
    top.receiveShadow = true;
    rpsGroup.add(top);

    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.07, 10, 36, Math.PI), trimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 1.0;
    rpsGroup.add(rim);

    // The straight edge needs its own lip or the table reads as a broken disc.
    const lip = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.14, 0.14), trimMat);
    lip.position.set(0, 1.0, 0);
    rpsGroup.add(lip);

    for (const [lx, lz] of [[-1.0, 0.55], [1.0, 0.55], [0, 1.25]] as const) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.94, 10), legMat);
      leg.position.set(lx, 0.47, lz);
      leg.castShadow = true;
      rpsGroup.add(leg);
    }

    // Three carved tokens laid on the felt — the whole game, readable from
    // across the plaza without a sign explaining it.
    const tokenMat = new THREE.MeshStandardMaterial({
      color: "#f2ead6",
      roughness: 0.55,
      emissive: new THREE.Color("#7dffd4"),
      emissiveIntensity: 0.12,
    });
    const tokens: THREE.Mesh[] = [];
    // rock: a squat stone. paper: a flat slab. scissors: a thin cross.
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.19), tokenMat);
    rock.position.set(-0.62, 1.06, 0.72);
    const paper = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.03, 0.46), tokenMat);
    paper.position.set(0, 1.03, 0.82);
    paper.rotation.y = 0.3;
    const sciA = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.04, 0.07), tokenMat);
    const sciB = sciA.clone();
    sciA.rotation.y = 0.5;
    sciB.rotation.y = -0.5;
    const scissors = new THREE.Group();
    scissors.add(sciA, sciB);
    scissors.position.set(0.62, 1.05, 0.72);
    rpsGroup.add(rock, paper, scissors);
    tokens.push(rock, paper);

    // A sealed-envelope motif floating over the table: the house's throw,
    // decided and hashed before anybody sits down. Bobs so it reads as live.
    const seal = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.28, 0.05),
      new THREE.MeshStandardMaterial({
        color: "#0b1220",
        emissive: new THREE.Color("#7dffd4"),
        emissiveIntensity: 0.9,
        roughness: 0.4,
      }),
    );
    seal.position.set(0, 1.72, 0.1);
    rpsGroup.add(seal);

    const halo2 = new THREE.Mesh(
      new THREE.CircleGeometry(1.9, 32),
      new THREE.MeshBasicMaterial({
        color: "#7dffd4",
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo2.rotation.x = -Math.PI / 2;
    halo2.position.y = 0.02;
    rpsGroup.add(halo2);

    rpsAnimate = (t: number) => {
      seal.position.y = 1.72 + Math.sin(t * 1.6) * 0.06;
      seal.rotation.y = t * 0.7;
      for (let i = 0; i < tokens.length; i++) {
        tokens[i].rotation.y = t * (0.3 + i * 0.12);
      }
    };
  }
  group.add(rpsGroup);







  // ---- SnackFe: modern neon cafe ---------------------------------------
  // A sleek modern micro-cafe with alternating mint/magenta string lights
  // along the front awning. Walk up to it to order a snack.
  // Town plan: pushed out to the SE ring so the mid-lawn stays open.
  /* ---- THE PLAZA -----------------------------------------------------
   *
   * Everything that costs or gives Vibecoin lives in one south-east corner,
   * in a rough arc around SnackFe, so a visitor can see the whole economy from
   * one spot instead of running the island to find it.
   *
   *              SnackFe (16,33)          ← the back of the plaza
   *                    ·
   *   shop (8,34)   RPS (13,38)   arcade (22,37)   avatar portal (28,31)
   *                                                      TV (31,24) ↘
   *
   * The character portal used to be at x = -34 — the far west shore, sixty
   * units and a jetpack ride from the shop it dresses you for. It was one of
   * the four things people actually use and the only one nowhere near the
   * others.
   *
   * Spacing is ~6–9 units: close enough to read every sign from the middle,
   * far enough that the kiosks do not clip. If you add a stall, keep it in the
   * arc and keep it that far from its neighbours.
   */
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

  // Service window: a live menu board (was a blank glowing rectangle).
  // The board is redrawn by setSnackMenu() as gems/purchases change, so
  // the menu lives on the kiosk screen instead of a popup overlay.
  const snackMenuCanvas = document.createElement("canvas");
  snackMenuCanvas.width = 700;
  snackMenuCanvas.height = 360;
  const snackMenuCtx = snackMenuCanvas.getContext("2d")!;
  const snackMenuTex = new THREE.CanvasTexture(snackMenuCanvas);
  snackMenuTex.colorSpace = THREE.SRGBColorSpace;
  let snackFlash: { name: string; t: number } | null = null;
  let lastSnackGems = 0;
  let lastSnackOwned: Record<string, number> = {};
  const drawSnackMenu = (gems: number, owned: Record<string, number>) => {
    lastSnackGems = gems;
    lastSnackOwned = owned;
    const ctx = snackMenuCtx;
    const W = snackMenuCanvas.width;
    const H = snackMenuCanvas.height;
    // Warm-lit interior board.
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#241a10");
    bg.addColorStop(1, "#17110a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,210,138,0.5)";
    ctx.lineWidth = 5;
    ctx.strokeRect(4, 4, W - 8, H - 8);
    // Header.
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = "bold 40px 'Sora', system-ui, sans-serif";
    ctx.fillStyle = "#46e88c";
    ctx.shadowColor = "#46e88c";
    ctx.shadowBlur = 16;
    ctx.fillText("SnackFe", 28, 40);
    ctx.shadowBlur = 0;
    ctx.textAlign = "right";
    ctx.font = "bold 28px 'Manrope', system-ui, sans-serif";
    ctx.fillStyle = "#ffd166";
    ctx.fillText(`✦ ${gems}`, W - 28, 40);
    ctx.textAlign = "left";
    // Rows.
    SNACK_MENU.forEach((item, i) => {
      const y = 92 + i * 44;
      const afford = gems >= item.cost;
      const has = (owned[item.name] ?? 0) > 0;
      const flash = snackFlash?.name === item.name ? snackFlash.t : 0;
      ctx.globalAlpha = afford ? 1 : 0.4;
      ctx.font = "30px 'Manrope', system-ui, sans-serif";
      ctx.fillStyle = flash > 0 ? "#bfffe0" : "#f3e4c8";
      ctx.fillText(`${item.emoji}  ${item.name}`, 28, y);
      if (has) {
        ctx.fillStyle = "#46e88c";
        ctx.font = "22px 'Manrope', system-ui, sans-serif";
        ctx.fillText(`✓${owned[item.name]}`, 360, y);
      }
      // Dotted leader out to the price.
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.moveTo(430, y + 4);
      ctx.lineTo(W - 90, y + 4);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "right";
      ctx.font = "bold 28px 'Manrope', system-ui, sans-serif";
      ctx.fillStyle = afford ? "#ffd166" : "#8a7a55";
      ctx.fillText(`✦${item.cost}`, W - 28, y);
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
    });
    snackMenuTex.needsUpdate = true;
  };
  drawSnackMenu(0, {});
  const snackWindow = new THREE.Mesh(
    new THREE.PlaneGeometry(SNACK_W * 0.74, SNACK_H * 0.4),
    new THREE.MeshBasicMaterial({ map: snackMenuTex }),
  );
  snackWindow.position.set(0, SNACK_H * 0.6, SNACK_D / 2 + 0.07);
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

    // (The seventy cone "grass tufts" that used to be scattered here are
    // gone. They were the best available stand-in for grass when the lawn was
    // a flat texture; standing in a field of actual blades they read as dark
    // plastic triangles, which is worse than nothing. See `islandGrass`.)

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
  // THE GOD ORB — one full geodesic sphere in the sky. (There used to
  // be a half-dome "generator" on the ground; retired. The sky orb is
  // the whole deal now: the island's crown, and the portal for asking
  // the universe to build things — click it and make a wish.)
  // ------------------------------------------------------------------
  const divineSphere = new THREE.Group();
  // Crowning the island: directly above the plaza, well above every
  // rooftop, visible from anywhere.
  divineSphere.position.set(0, 42, 0);
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

  // Floating invitation under the orb — the whole pitch in one line.
  {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 96;
    const ctx = c.getContext("2d")!;
    ctx.beginPath();
    ctx.roundRect(8, 14, 624, 68, 34);
    ctx.fillStyle = "rgba(10, 12, 20, 0.62)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255, 220, 140, 0.8)";
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 34px 'Sora', 'Segoe UI', sans-serif";
    ctx.fillStyle = "#ffe9b8";
    ctx.fillText("🌠 tap the orb — wish something into the world", 320, 50);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const tag = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    tag.scale.set(10, 1.5, 1);
    tag.position.set(0, divineBaseY - 8.5, 0);
    group.add(tag);
  }

  // Twinkle lights scattered across the lawn — small glowing pucks
  // sitting on the grass, color-rotating between mint and warm amber.
  const twinkleLights: { mat: THREE.MeshBasicMaterial; mesh: THREE.Mesh; phase: number; hue: number }[] = [];
  const twinkleGeo = new THREE.SphereGeometry(0.12, 10, 8);
  const islandR = 56;
  // Avoid stomping on buildings/portals: keep an exclusion zone around each shop.
  const avoid: { x: number; z: number; r: number }[] = SHOPS.map((s) => ({
    x: s.x, z: s.z, r: Math.max(s.w, s.d) * 0.7 + 2,
  }));
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

  // ---- The lawn ------------------------------------------------------
  // Built last on purpose: the exclusion predicate below names every pad,
  // path and footprint the rest of this function has just placed, and it can
  // only do that once they exist as constants.
  //
  // Grass does NOT get kept out of everything. It grows up against benches,
  // lamp posts, palms and the zipline poles, because that is what grass does
  // and a neat halo around every prop is the single most obvious tell that a
  // world was assembled rather than grown. What it stays out of is anything
  // with a floor: the plaza pad, the worn path cross, building interiors, the
  // pool, and the small pedestals you stand on.
  {
    /** Half-width of the sandy path cross, matched to the ground texture. */
    const PATH_HALF = 4.0;
    /** Circles: [x, z, radius]. */
    const clearCircles: Array<[number, number, number]> = [
      [PLAZA_CX, PLAZA_CZ, PLAZA_R + 1.4], // the plaza pad and its planter wall
      [36, 10, 4.9], // spring pool — grass grows in among the lip stones
      [PORTAL_X, PORTAL_Z, 2.4], // Vibe Maker ring base
      [AVATAR_X, AVATAR_Z, 3.2], // character studio pedestal
      [ARCADE_X, ARCADE_Z, 1.9],
      [RPS_X, RPS_Z, 2.2],
      [SHOP_X, SHOP_Z, 2.6],
      [TV_X, TV_Z, 2.2],
      [MILL_X, MILL_Z, 2.6],
    ];
    /** Rectangles: [x, z, halfW, halfD] — building footprints, plus a step. */
    // Footprints only, with no margin — grass grows right up against a wall
    // and a little way under the roof overhang, and a mown border round every
    // building is the tell that the buildings were dropped onto the lawn.
    const clearRects: Array<[number, number, number, number]> = [
      ...SHOPS.map((s) => [s.x, s.z, s.w / 2 - 0.3, s.d / 2 - 0.3] as [number, number, number, number]),
      [SNACK_X, SNACK_Z, SNACK_W / 2 - 0.3, SNACK_D / 2 - 0.3],
    ];

    const blocked = (x: number, z: number) => {
      if (Math.abs(x) < PATH_HALF || Math.abs(z) < PATH_HALF) return true;
      for (const [cx, cz, r] of clearCircles) {
        if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
      }
      for (const [rx, rz, hw, hd] of clearRects) {
        if (Math.abs(x - rx) < hw && Math.abs(z - rz) < hd) return true;
      }
      return false;
    };

    // The cap's top radius is (ISLAND_RADIUS + 1.6) scaled by the same rim
    // noise every other layer uses, so the grass ends exactly where the land
    // does — including the bits that bulge out past the nominal circle.
    const rimAt = (a: number) => 1 + landRim(a);
    const grass = buildGrassField({
      radius: ISLAND_RADIUS + 1.2,
      rimAt,
      blocked,
      count: lowDetail ? 18000 : 62000,
      seed: 61803,
    });
    group.add(grass.mesh);
    craftAnims.push((_dt, now) => grass.update(now));

    const cover = buildGroundCover({
      radius: ISLAND_RADIUS,
      rimAt,
      blocked,
      count: lowDetail ? 240 : 700,
      seed: 27182,
    });
    group.add(cover.mesh);
  }

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
      rpsAnimate?.(now * 0.001);
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
      // Sparkle motes drift up through the hologram and wrap.
      {
        const p = avatarSparkleGeo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) {
          let y = p.getY(i) + dt * 0.55;
          if (y > 3.6) y -= 3.6;
          p.setY(i, y);
        }
        p.needsUpdate = true;
      }
      for (let i = 0; i < avatarPylonTipMats.length; i++) {
        avatarPylonTipMats[i].opacity =
          0.65 + Math.sin(now * 0.004 + i * 2.1) * 0.3;
      }



      // God Orb: slow majestic spin + gentle sky-bob + halo pulse.
      divineSphere.rotation.y += dt * 0.18;
      divineSphere.rotation.x += dt * 0.05;
      divineSphere.position.y = divineBaseY + Math.sin(now * 0.0008) * 1.2;
      const divK = 0.5 + Math.sin(now * 0.0018) * 0.5;
      (divineCore.material as THREE.MeshBasicMaterial).opacity = 0.7 + divK * 0.28;
      divineCore.scale.setScalar(0.92 + divK * 0.14);
      (divineHalo.material as THREE.MeshBasicMaterial).opacity = 0.16 + divK * 0.18;
      divineHalo.scale.setScalar(1 + divK * 0.25);
      divineLight.intensity = 5 + divK * 5;
      for (let i = 0; i < twinkleLights.length; i++) {
        const t = twinkleLights[i];
        const k = 0.5 + Math.sin(now * 0.003 + t.phase) * 0.5;
        t.mat.opacity = 0.35 + k * 0.6;
        t.mesh.scale.setScalar(0.7 + k * 0.7);
      }

      // SnackFe purchase flash fades over ~0.8s, then settles the board.
      if (snackFlash) {
        snackFlash.t -= dt / 0.8;
        if (snackFlash.t <= 0) {
          snackFlash = null;
          drawSnackMenu(lastSnackGems, lastSnackOwned);
        }
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
    rpsTable: new THREE.Vector3(centerX + RPS_X, topY, centerZ + RPS_Z),
    tv: new THREE.Vector3(centerX + TV_X, topY, centerZ + TV_Z),
    divineSphere,
    setSnackMenu(gems, owned, justBought) {
      if (justBought) snackFlash = { name: justBought, t: 1 };
      drawSnackMenu(gems, owned);
    },
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
