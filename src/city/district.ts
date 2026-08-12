/**
 * The district — Vibe City's buildings, roofs and streets.
 *
 * ## Why this exists
 *
 * The city is judged from the air, and from the air it did not hold up. Pinch
 * the camera out and what you saw was ninety extruded boxes standing on a
 * painted plate: nothing cast a shadow, so nothing sat on the ground; every
 * roof was a single flat colour, so the surface that fills most of an aerial
 * frame was the least-drawn thing in the scene; and one silhouette repeated at
 * three heights, so the skyline had no rhythm.
 *
 * All three are fixed here, in the order of how much each one matters when you
 * are two hundred metres up:
 *
 * 1. **Roofs are the city.** Every building now has a parapet with a real edge
 *    that catches the sun and throws a line of shade across its own roof, a
 *    membrane texture with seams, patches and ponding instead of one texel, and
 *    rooftop plant — condensers, water tanks, stair bulkheads, vents.
 * 2. **Massing, not extrusion.** Towers are a podium, a shaft set back from it,
 *    and a crown set back again. Setbacks are what give a skyline depth at a low
 *    sun — and because each step is a real collision box, they are also
 *    terraces you can land a jetpack on.
 * 3. **Streets with a kerb.** A 14 cm concrete rim around every block costs
 *    nothing and buys a shadow line down every street, which is what makes a
 *    grid read as streets rather than as a texture.
 *
 * Then trees and moving traffic, which are what make it read as inhabited.
 *
 * ## What it deliberately does not do
 *
 * Lighting, tone mapping and fog live in `City.tsx` with the renderer. They are
 * the scene's, not the district's — the island, the moon and Mars are lit by
 * the same sun, and a module that grabbed the lights would be deciding how
 * three other worlds look.
 *
 * ## The contract with the player
 *
 * `boxes` is the same `WorldBox` list the collision layer has always taken.
 * Every visible mass gets exactly one box, `base` at its bottom and `height` at
 * its top. Stacking works because `CollisionWorld.supportAt` takes the highest
 * top at or below you: a podium roof holds you at 12 m while the shaft passing
 * your shoulder is ignored, and stepping into the shaft's footprint is blocked.
 * None of that is new — it is the same rule, now used for three boxes per tower
 * instead of one.
 *
 * The street furniture is deliberately **not** collidable, and that is the one
 * real compromise in here. Kerbs, sidewalk slabs and road paint all sit within
 * a few centimetres of grade, so walking over them looks right without a box;
 * giving each of the 81 blocks one would put another 300 entries in a query
 * that runs several times a frame, to stop a player noticing a 14 cm step. The
 * things you *can* walk into — bulkheads, water tanks — do get boxes.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldBox } from "@/components/city/cardboardIsland";

export interface DistrictOpts {
  /** Deterministic — the same seed always builds the same city. */
  seed: string;
  /** Cells per side. */
  grid: number;
  /** Buildable block size, metres. */
  block: number;
  /** Street width between blocks, metres. */
  street: number;
  /** Towers above this get a rooftop landing pad. */
  padMinHeight: number;
  /**
   * Snow accumulation, if the world has weather. Every up-facing surface the
   * district owns — streets, sidewalks, parks, the plaza, every roof — is
   * handed to it, so a fall covers the whole district at once rather than a
   * list of things somebody remembered to include.
   */
  snow?: { patch(m: THREE.Material | THREE.Material[] | null | undefined): void };
}

export interface District {
  group: THREE.Group;
  /** Collision, in the shape the player's `CollisionWorld` already takes. */
  boxes: WorldBox[];
  /** Rooftop landing pads, for the ring markers and the fast-travel list. */
  pads: Array<{ x: number; z: number; y: number }>;
  /** Flip the whole district between day and night. */
  setDay(day: boolean): void;
  /** Drive the traffic. */
  update(dt: number): void;
  dispose(): void;
}

/**
 * World metres covered by one tile of the window texture, across and up.
 *
 * These used to be one number — 12.8 m on both axes — and that single value was
 * quietly the reason the buildings had no believable size. The tile is a 16×16
 * grid, so 12.8 m square put a window row every **0.8 m**: storeys eight inches
 * apart, which the eye reads not as a small building but as graph paper glued
 * to a box. Nothing else can fix that, because scale in architecture is floor
 * height and floor height alone.
 *
 * So the tile is no longer square. 16 storeys of `FLOOR_H` up, 16 windows of
 * about 1.6 m across — which are the dimensions of an actual office building,
 * and which make a 48 m tower read as fifteen floors instead of sixty.
 */
const WINDOW_TILE_U = 25.6;
const WINDOW_TILE_V = 16 * 3.2;
/** …and of the roof membrane. Smaller, because roofs get walked on. */
const ROOF_TILE = 8;
/** Floor-to-floor. Sets the window row pitch, so it has to look like a storey. */
const FLOOR_H = 3.2;
/** Height of the kerb, and of the sidewalk slab it rims. */
const KERB = 0.14;
/** Clear ground kept between a building and its block edge, for the sidewalk. */
const SIDEWALK = 4.5;

// ---------------------------------------------------------------------------
// Deterministic rng — the same generator the rest of the city uses, so a seed
// means the same thing here as it does everywhere else.
// ---------------------------------------------------------------------------
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

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function canvasOf(size: number) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return { c, x: c.getContext("2d")! };
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

interface FacadeSkin {
  facade: string;
  trim: string;
  glass: string;
  /** The building's accent. One window in eight gets it; see `LIT_PALETTE`. */
  lit: string;
  litChance: number;
}

/**
 * Eight slots a lit window can draw from, weighted by repetition: five warm
 * (tungsten and the warm end of LED), two cool (the fluorescent floor nobody
 * has refitted), one the building's accent.
 */
const LIT_PALETTE = (accent: string) => [
  "#ffe2b4", "#ffe2b4", "#ffd79a", "#ffdca6", "#ffca86",
  "#e6efff", "#d6e4f7",
  accent,
];

/**
 * A facade tile: floor bands, mullions, and windows that are not all the same
 * window.
 *
 * The old tile was a flat colour with a grid of identical rectangles punched
 * into it, which at any distance averaged to a single grey and made every tower
 * the same tower. Three cheap things fix that:
 *
 * - **A spandrel band per floor.** Real curtain wall has an opaque strip at each
 *   slab edge, and horizontal banding is what tells you a building has storeys
 *   — which is what gives it a believable *size*.
 * - **Blinds.** A random part of each window covered from the top, to a random
 *   depth. Two lines of canvas, and the single biggest reason a facade stops
 *   looking printed.
 * - **Grime.** A gradient pooling under each band, because a perfectly clean
 *   building reads as untextured rather than as new.
 */
function makeFacade(seed: string, s: FacadeSkin) {
  const S = 1024;
  const cols = 16;
  const rows = 16;
  const cell = S / cols;
  const r = rng(seed);
  const { c: baseC, x: b } = canvasOf(S);
  const { c: emiC, x: e } = canvasOf(S);

  b.fillStyle = s.facade;
  b.fillRect(0, 0, S, S);
  e.fillStyle = "#000";
  e.fillRect(0, 0, S, S);

  for (let cy = 0; cy < rows; cy++) {
    b.fillStyle = s.trim;
    b.fillRect(0, cy * cell, S, cell * 0.16);

    const g = b.createLinearGradient(0, cy * cell + cell * 0.16, 0, (cy + 1) * cell);
    g.addColorStop(0, "rgba(0,0,0,0.20)");
    g.addColorStop(0.4, "rgba(0,0,0,0)");
    b.fillStyle = g;
    b.fillRect(0, cy * cell + cell * 0.16, S, cell * 0.84);

    for (let cx = 0; cx < cols; cx++) {
      const x = cx * cell + cell * 0.18;
      const y = cy * cell + cell * 0.26;
      const w = cell * 0.64;
      const h = cell * 0.56;

      const isLit = r() < s.litChance;
      // Lit rooms are not all the same brightness. A floor of identical
      // squares is exactly what reads as a texture rather than as offices.
      const dim = isLit ? 0.45 + r() * 0.55 : 1;
      // …nor all the same colour. Every window in a tower used to be the
      // variant's one accent hue, which gave a skyline of solid pink and solid
      // cyan buildings — striking, and nothing like a city. Real offices are
      // overwhelmingly warm white with a scatter of cooler fluorescent, so the
      // accent survives at about one window in eight: enough to keep the place
      // called Vibe City, not enough to read as a colour swatch.
      const litColor = isLit ? LIT_PALETTE(s.lit)[Math.floor(r() * 8)] : s.glass;
      b.globalAlpha = dim;
      b.fillStyle = litColor;
      b.fillRect(x, y, w, h);
      b.globalAlpha = 1;

      if (isLit) {
        e.globalAlpha = dim;
        e.fillStyle = litColor;
        e.fillRect(x, y, w, h);
        e.globalAlpha = 1;
      }

      if (r() < 0.42) {
        const drop = h * (0.2 + r() * 0.6);
        b.fillStyle = "rgba(196, 204, 214, 0.5)";
        b.fillRect(x, y, w, drop);
        if (isLit) {
          // Punch the blind out of the glow too, or the emissive pass lights
          // straight through it and the window looks like it has no blind.
          e.globalCompositeOperation = "destination-out";
          e.fillStyle = "#000";
          e.fillRect(x, y, w, drop);
          e.globalCompositeOperation = "source-over";
        }
      }

      b.fillStyle = s.trim;
      b.fillRect(cx * cell + cell * 0.06, cy * cell, cell * 0.09, cell);
    }
  }
  return { map: texture(baseC), emissiveMap: texture(emiC) };
}

/**
 * The roof membrane: seams, patches, ponding, gravel.
 *
 * This is the texture that did not exist. Roof faces used to sample one
 * reserved 4×4 texel in the corner of the facade tile, so from above the city
 * was a field of flat grey rectangles — the exact view everybody sees, and the
 * one nothing was drawing.
 */
function makeRoof(day: boolean): THREE.CanvasTexture {
  const S = 512;
  const { c, x } = canvasOf(S);
  const r = rng("vibe-city-roof");
  x.fillStyle = day ? "#585f68" : "#191e26";
  x.fillRect(0, 0, S, S);

  for (let i = 0; i < 5200; i++) {
    const v = r();
    x.fillStyle = `rgba(${day ? "255,255,255" : "150,170,200"},${0.02 + v * 0.05})`;
    x.fillRect(r() * S, r() * S, 1 + v * 2, 1 + v * 2);
  }

  // Rolled membrane comes in strips; the overlap is a raised line with a lit
  // side and a shaded one.
  const strip = S / 6;
  for (let i = 1; i < 6; i++) {
    x.strokeStyle = day ? "rgba(0,0,0,0.20)" : "rgba(0,0,0,0.35)";
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(i * strip, 0);
    x.lineTo(i * strip, S);
    x.stroke();
    x.strokeStyle = day ? "rgba(255,255,255,0.10)" : "rgba(140,165,200,0.09)";
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(i * strip + 2, 0);
    x.lineTo(i * strip + 2, S);
    x.stroke();
  }

  // Repairs, in a slightly wrong shade. Every flat roof has them.
  for (let i = 0; i < 7; i++) {
    x.fillStyle = day
      ? `rgba(${34 + r() * 26},${36 + r() * 26},${40 + r() * 26},0.5)`
      : "rgba(10,14,20,0.55)";
    x.fillRect(r() * S, r() * S, 30 + r() * 90, 24 + r() * 70);
  }

  // Ponding: water sits where the deck sags and dries darker.
  for (let i = 0; i < 5; i++) {
    const cx = r() * S;
    const cy = r() * S;
    const rad = 28 + r() * 60;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, day ? "rgba(20,26,34,0.34)" : "rgba(4,8,14,0.4)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g;
    x.beginPath();
    x.arc(cx, cy, rad, 0, Math.PI * 2);
    x.fill();
  }
  return texture(c);
}

/** Asphalt, as a small tile repeated across the plate. */
function makeAsphalt(day: boolean): THREE.CanvasTexture {
  const S = 512;
  const { c, x } = canvasOf(S);
  const r = rng("vibe-city-asphalt");
  x.fillStyle = day ? "#4b5058" : "#0e1219";
  x.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    const v = r();
    x.fillStyle = `rgba(${day ? "255,255,255" : "120,145,180"},${0.015 + v * 0.05})`;
    x.fillRect(r() * S, r() * S, 1 + v * 2, 1 + v * 2);
  }
  x.strokeStyle = day ? "rgba(20,22,26,0.5)" : "rgba(0,0,0,0.5)";
  x.lineWidth = 2.5;
  for (let i = 0; i < 3; i++) {
    let px = r() * S;
    let py = r() * S;
    x.beginPath();
    x.moveTo(px, py);
    for (let k = 0; k < 6; k++) {
      px += (r() - 0.5) * 120;
      py += (r() - 0.5) * 120;
      x.lineTo(px, py);
    }
    x.stroke();
  }
  return texture(c);
}

/** Concrete paving for the sidewalks, with expansion joints. */
function makePaving(day: boolean): THREE.CanvasTexture {
  const S = 512;
  const { c, x } = canvasOf(S);
  const r = rng("vibe-city-paving");
  x.fillStyle = day ? "#9aa1a9" : "#1b222c";
  x.fillRect(0, 0, S, S);
  for (let i = 0; i < 4500; i++) {
    const v = r();
    x.fillStyle = `rgba(${day ? "0,0,0" : "130,155,190"},${0.015 + v * 0.045})`;
    x.fillRect(r() * S, r() * S, 1 + v * 2, 1 + v * 2);
  }
  x.strokeStyle = day ? "rgba(0,0,0,0.22)" : "rgba(0,0,0,0.4)";
  x.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    x.beginPath();
    x.moveTo((i * S) / 4, 0);
    x.lineTo((i * S) / 4, S);
    x.moveTo(0, (i * S) / 4);
    x.lineTo(S, (i * S) / 4);
    x.stroke();
  }
  return texture(c);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * The four walls of a box, without a lid.
 *
 * Built from planes rather than by stripping faces off a `BoxGeometry` because
 * the roof needs its own material — a roof lit and textured like a wall is the
 * bug this module exists to fix — and `mergeGeometries` collapses sub-groups,
 * so "one box, two materials" does not survive being merged with four hundred
 * other boxes. Two separate merges is the shape that works.
 */
function wallGeometry(
  w: number,
  h: number,
  d: number,
  cx: number,
  y0: number,
  cz: number,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const face = (fw: number, rotY: number, ox: number, oz: number) => {
    const p = new THREE.PlaneGeometry(fw, h);
    // UVs in world metres, so a window is a window whatever the wall's size —
    // and a storey is a storey, which is the part that carries the scale.
    const uv = p.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) * fw) / WINDOW_TILE_U, (uv.getY(i) * h) / WINDOW_TILE_V);
    }
    p.rotateY(rotY);
    p.translate(cx + ox, y0 + h / 2, cz + oz);
    parts.push(p);
  };
  face(w, 0, 0, d / 2);
  face(w, Math.PI, 0, -d / 2);
  face(d, Math.PI / 2, w / 2, 0);
  face(d, -Math.PI / 2, -w / 2, 0);
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/** A single upward quad, UV'd in world metres against its tile. */
function flatQuad(
  w: number,
  d: number,
  cx: number,
  y: number,
  cz: number,
  tile: number,
): THREE.BufferGeometry {
  const p = new THREE.PlaneGeometry(w, d);
  if (tile > 0) {
    const uv = p.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * d) / tile);
    }
  }
  p.rotateX(-Math.PI / 2);
  p.translate(cx, y, cz);
  return p;
}

// ---------------------------------------------------------------------------
// Massing
// ---------------------------------------------------------------------------

interface Mass {
  cx: number;
  cz: number;
  w: number;
  d: number;
  y0: number;
  y1: number;
}

/**
 * Turn a lot and a target height into a stack of volumes.
 *
 * These are the shapes cities actually produce, and each earns its place by
 * what it does to the silhouette:
 *
 * - **Low-rise** — one volume. Most of the outskirts. Nothing clever on
 *   purpose: they are the floor the towers stand out from, and if they get
 *   interesting the skyline stops having a subject.
 * - **Mid-rise** — a body with a small mechanical penthouse set in from the
 *   parapet. That one 3 m step is what stops a field of mid-rises reading as a
 *   single extruded mass.
 * - **Tower** — podium, shaft, crown. The setbacks are the whole reason a
 *   skyline has depth at a low sun: each step catches light on its own roof and
 *   throws shade on the step below.
 * - **Wedding cake** — rare on purpose. Two or three per city are landmarks;
 *   ten are wallpaper.
 */
function massing(
  r: () => number,
  lx: number,
  lz: number,
  lw: number,
  ld: number,
  height: number,
): Mass[] {
  const at = (inset: number, y0: number, y1: number): Mass => ({
    cx: lx,
    cz: lz,
    w: Math.max(3, lw - inset * 2),
    d: Math.max(3, ld - inset * 2),
    y0,
    y1,
  });

  if (height < 16) return [at(0, 0, height)];

  if (height < 44) {
    const cap = 2.4 + r() * 2.2;
    return [at(0, 0, height - cap), at(1.4 + r() * 1.2, height - cap, height)];
  }

  if (r() < 0.18) {
    const a = height * (0.32 + r() * 0.1);
    const b = height * (0.68 + r() * 0.08);
    return [at(0, 0, a), at(1.8, a, b), at(3.6, b, height)];
  }

  const podium = 8 + r() * 7;
  const crown = 4 + r() * 5;
  return [
    at(0, 0, podium),
    at(2.2 + r() * 2.2, podium, height - crown),
    at(4.4 + r() * 2.4, height - crown, height),
  ];
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export function buildDistrict(opts: DistrictOpts): District {
  const { seed, grid, block, street, padMinHeight } = opts;
  const pitch = block + street;
  const span = grid * pitch;
  const half = span / 2;
  const center = (grid - 1) / 2;
  const r = rng(seed);

  const group = new THREE.Group();
  const boxes: WorldBox[] = [];
  const pads: Array<{ x: number; z: number; y: number }> = [];
  const trash: Array<{ dispose(): void }> = [];

  // ---- Skins -----------------------------------------------------------
  // Night is where the city has always looked best, so the night palette keeps
  // its accent colours. Day varies by *value*, not hue: a skyline where every
  // tower is a different colour looks like a toy, and one where they are all
  // the same grey looks like a placeholder.
  const NIGHT: FacadeSkin[] = [
    { facade: "#161c26", trim: "#0e131b", glass: "#0b1017", lit: "#ffd9a0", litChance: 0.3 },
    { facade: "#131f31", trim: "#0c1524", glass: "#0a121c", lit: "#6fd9ff", litChance: 0.28 },
    { facade: "#11151d", trim: "#0a0d13", glass: "#080c12", lit: "#2dd4a8", litChance: 0.26 },
    { facade: "#1a1a24", trim: "#101018", glass: "#0b0b12", lit: "#ffc48a", litChance: 0.32 },
    { facade: "#0f1a22", trim: "#091116", glass: "#070d12", lit: "#a8e6ff", litChance: 0.24 },
    { facade: "#191520", trim: "#100d16", glass: "#0a0810", lit: "#ffb0d8", litChance: 0.27 },
  ];
  /**
   * Daytime. Six buildings that are recognisably six buildings.
   *
   * The first cut was six shades of the same pale grey, and from the air the
   * district came out as one white mass with street-shaped gaps in it — the
   * daylight version of the flat-black problem. Real downtowns have a handful
   * of materials, not a gradient: pale precast, blue-green curtain wall, warm
   * limestone, dark bronze glass, red brick. Spreading the *value* is what
   * separates the towers; keeping the count low is what stops it looking like
   * a colour picker.
   */
  const DAY: FacadeSkin[] = [
    // Pale precast concrete with blue glass — the default downtown tower.
    { facade: "#c3c9d0", trim: "#9aa2ab", glass: "#5b7793", lit: "#fff", litChance: 0 },
    // Blue-green curtain wall, mostly glass.
    { facade: "#8fa6b4", trim: "#6f8695", glass: "#41697f", lit: "#fff", litChance: 0 },
    // Warm limestone.
    { facade: "#cfc4ae", trim: "#a99e89", glass: "#5f6f7d", lit: "#fff", litChance: 0 },
    // Dark bronze glass — the one that reads as a silhouette from the air and
    // gives the skyline something to be lighter than.
    { facade: "#6c6a66", trim: "#4e4d4a", glass: "#3b4148", lit: "#fff", litChance: 0 },
    // Cool white, high glazing ratio.
    { facade: "#d5dade", trim: "#adb4ba", glass: "#67879f", lit: "#fff", litChance: 0 },
    // Red brick mid-rise stock.
    { facade: "#9c6f5e", trim: "#7c5546", glass: "#4a5563", lit: "#fff", litChance: 0 },
  ];
  const VARIANTS = NIGHT.length;

  const skins: Array<{
    mat: THREE.MeshStandardMaterial;
    night: { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture };
    day: { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture };
  }> = [];

  const wallsByVariant: THREE.BufferGeometry[][] = Array.from({ length: VARIANTS }, () => []);
  const roofGeos: THREE.BufferGeometry[] = [];

  // ---- Instanced furniture, collected as transforms ---------------------
  // An InstancedMesh needs its count up front, so gather first and upload once.
  // `concrete` holds both parapets and kerbs: they are the same grey poured
  // thing, so they can share a draw call.
  const concrete: THREE.Matrix4[] = [];
  const plant: THREE.Matrix4[] = [];
  const tanks: THREE.Matrix4[] = [];
  const vents: THREE.Matrix4[] = [];
  /** Roof tops tall enough to warrant an aviation warning light. */
  const beaconAt: Array<{ x: number; y: number; z: number }> = [];

  const M = new THREE.Matrix4();
  const S3 = new THREE.Vector3();
  const box = (
    list: THREE.Matrix4[],
    cx: number,
    yBottom: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    rotY = 0,
  ) => {
    M.makeRotationY(rotY);
    M.scale(S3.set(w, h, d));
    M.setPosition(cx, yBottom + h / 2, cz);
    list.push(M.clone());
  };
  const cyl = (list: THREE.Matrix4[], cx: number, yBottom: number, cz: number, h: number) => {
    M.identity();
    M.scale(S3.set(1, h, 1));
    M.setPosition(cx, yBottom + h / 2, cz);
    list.push(M.clone());
  };

  /** The rim around a roof. Four thin boxes, and the reason roofs read. */
  const parapet = (m: Mass) => {
    const t = 0.34;
    const h = 0.85 + r() * 0.5;
    box(concrete, m.cx, m.y1, m.cz + m.d / 2 - t / 2, m.w, h, t);
    box(concrete, m.cx, m.y1, m.cz - m.d / 2 + t / 2, m.w, h, t);
    box(concrete, m.cx + m.w / 2 - t / 2, m.y1, m.cz, t, h, m.d - t * 2);
    box(concrete, m.cx - m.w / 2 + t / 2, m.y1, m.cz, t, h, m.d - t * 2);
  };

  /**
   * What is actually on a roof.
   *
   * Everything stays inside the parapet with a margin so nothing overhangs an
   * edge, and off the middle of pad roofs so a landing ring never ends up on a
   * water tank. Anything tall enough to walk into gets a collision box; the
   * knee-high condensers do not.
   */
  const dressRoof = (m: Mass, hasPad: boolean) => {
    const margin = 1.5;
    const iw = m.w - margin * 2;
    const id = m.d - margin * 2;
    if (iw < 2.5 || id < 2.5) return;

    const spot = (): [number, number] => {
      for (let tries = 0; tries < 8; tries++) {
        const x = m.cx + (r() - 0.5) * iw;
        const z = m.cz + (r() - 0.5) * id;
        if (!hasPad || Math.hypot(x - m.cx, z - m.cz) > 4.2) return [x, z];
      }
      return [m.cx + iw / 2, m.cz + id / 2];
    };

    // Stair bulkhead — anything tall enough to need stairs to the roof.
    if (m.y1 > 18) {
      const [x, z] = spot();
      const w = 2.6 + r() * 1.6;
      const d = 2.2 + r() * 1.2;
      const h = 2.4 + r() * 0.9;
      box(plant, x, m.y1, z, w, h, d);
      boxes.push({
        minX: x - w / 2, maxX: x + w / 2,
        minZ: z - d / 2, maxZ: z + d / 2,
        base: m.y1, height: m.y1 + h,
      });
    }

    // Condensers, in a row, because that is how they are installed.
    const units = 1 + Math.floor(r() * 4);
    const [ux, uz] = spot();
    const rot = r() * Math.PI;
    for (let i = 0; i < units; i++) {
      const off = (i - (units - 1) / 2) * 1.9;
      box(
        plant,
        ux + Math.cos(rot) * off, m.y1, uz + Math.sin(rot) * off,
        1.5, 0.85 + r() * 0.4, 1.0, rot,
      );
    }

    // Water tank on a stand, on the taller ones.
    if (m.y1 > 26 && r() < 0.5) {
      const [x, z] = spot();
      const h = 2.0 + r() * 1.1;
      box(plant, x, m.y1, z, 2.0, 0.8, 2.0); // the stand
      cyl(tanks, x, m.y1 + 0.8, z, h);
      boxes.push({
        minX: x - 1.1, maxX: x + 1.1,
        minZ: z - 1.1, maxZ: z + 1.1,
        base: m.y1, height: m.y1 + 0.8 + h,
      });
    }

    for (let i = 0; i < 1 + Math.floor(r() * 4); i++) {
      const [x, z] = spot();
      cyl(vents, x, m.y1, z, 0.5 + r() * 0.8);
    }
  };

  // ---- Lay out the blocks ----------------------------------------------
  for (let gx = 0; gx < grid; gx++) {
    for (let gz = 0; gz < grid; gz++) {
      if (gx === Math.floor(center) && gz === Math.floor(center)) continue; // plaza

      const cellX = (gx - center) * pitch;
      const cellZ = (gz - center) * pitch;
      const ringDist = Math.max(Math.abs(gx - center), Math.abs(gz - center));

      const layout = r();
      const lots: Array<[number, number, number, number]> =
        layout < 0.35
          ? [[cellX, cellZ, block, block]]
          : layout < 0.7
            ? r() < 0.5
              ? [
                  [cellX - block / 4, cellZ, block / 2, block],
                  [cellX + block / 4, cellZ, block / 2, block],
                ]
              : [
                  [cellX, cellZ - block / 4, block, block / 2],
                  [cellX, cellZ + block / 4, block, block / 2],
                ]
            : [
                [cellX - block / 4, cellZ - block / 4, block / 2, block / 2],
                [cellX + block / 4, cellZ - block / 4, block / 2, block / 2],
                [cellX - block / 4, cellZ + block / 4, block / 2, block / 2],
                [cellX + block / 4, cellZ + block / 4, block / 2, block / 2],
              ];

      for (const [lx, lz, lw, ld] of lots) {
        // The inset is bigger than it used to be, and deliberately so: it is
        // what leaves room for a sidewalk wide enough to put a tree on.
        const w = lw - SIDEWALK - r() * 2.5;
        const d = ld - SIDEWALK - r() * 2.5;
        const towerChance = ringDist <= 2 ? 0.38 : ringDist === 3 ? 0.18 : 0.05;
        const roll = r();
        const raw =
          roll < towerChance ? 46 + r() * 42 : roll < 0.62 ? 16 + r() * 26 : 7 + r() * 8;
        // Snap to whole floors. A tower 61.7 m tall has a half storey at the
        // top and its window rows stop lining up with its own parapet.
        const height = Math.max(2, Math.round(raw / FLOOR_H)) * FLOOR_H;

        const variant = Math.floor(r() * VARIANTS);
        const masses = massing(r, lx, lz, w, d, height);
        const hasPad = height > padMinHeight;

        for (const m of masses) {
          wallsByVariant[variant].push(wallGeometry(m.w, m.y1 - m.y0, m.d, m.cx, m.y0, m.cz));
          roofGeos.push(flatQuad(m.w, m.d, m.cx, m.y1 + 0.02, m.cz, ROOF_TILE));
          parapet(m);
          boxes.push({
            minX: m.cx - m.w / 2, maxX: m.cx + m.w / 2,
            minZ: m.cz - m.d / 2, maxZ: m.cz + m.d / 2,
            base: m.y0, height: m.y1,
          });
        }

        dressRoof(masses[masses.length - 1], hasPad);
        if (hasPad) pads.push({ x: lx, z: lz, y: height });
        // Anything an aircraft could hit gets a beacon, which above 60 m is
        // most of the skyline's tallest fifth.
        if (height > 60) beaconAt.push({ x: lx, y: height, z: lz });
      }
    }
  }

  // ---- Facade meshes ---------------------------------------------------
  wallsByVariant.forEach((geos, i) => {
    if (!geos.length) return;
    const night = makeFacade(`${seed}-n${i}`, NIGHT[i]);
    const day = makeFacade(`${seed}-d${i}`, DAY[i]);
    const merged = mergeGeometries(geos, false)!;
    geos.forEach((g) => g.dispose());
    const mat = new THREE.MeshStandardMaterial({
      map: night.map,
      emissive: new THREE.Color("#ffffff"),
      emissiveMap: night.emissiveMap,
      emissiveIntensity: 1,
      roughness: 0.78,
      metalness: 0.06,
    });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    skins.push({ mat, night, day });
    trash.push(merged, mat, night.map, night.emissiveMap, day.map, day.emissiveMap);
  });

  // ---- Roofs -----------------------------------------------------------
  const roofNight = makeRoof(false);
  const roofDay = makeRoof(true);
  const roofMat = new THREE.MeshStandardMaterial({ map: roofNight, roughness: 0.94 });
  const roofMerged = mergeGeometries(roofGeos, false)!;
  roofGeos.forEach((g) => g.dispose());
  const roofMesh = new THREE.Mesh(roofMerged, roofMat);
  roofMesh.receiveShadow = true;
  group.add(roofMesh);
  trash.push(roofMerged, roofMat, roofNight, roofDay);

  // ---- Streets ---------------------------------------------------------
  // Asphalt is a small tile repeated across the plate rather than one giant
  // canvas: 2048 px stretched over 360 m is 5.7 px per metre, which is a blur
  // underfoot. A 512 px tile every 16 m is 32 px per metre for a sixteenth of
  // the memory.
  const asphaltNight = makeAsphalt(false);
  const asphaltDay = makeAsphalt(true);
  [asphaltNight, asphaltDay].forEach((t) => t.repeat.set(span / 16, span / 16));
  const roadMat = new THREE.MeshStandardMaterial({ map: asphaltNight, roughness: 0.96 });
  const plate = new THREE.Mesh(flatQuad(span, span, 0, 0, 0, 0), roadMat);
  plate.receiveShadow = true;
  group.add(plate);
  trash.push(plate.geometry, roadMat, asphaltNight, asphaltDay);

  // Sidewalks are a flat quad plus a kerb rim, NOT a raised slab. A slab would
  // put every block interior 14 cm above grade, and every prop, agent and
  // spawn point in the city is placed at y=0 — they would all sink to the
  // ankles. The rim alone gives the shadow line; the ground stays where
  // everything else expects it.
  const paveNight = makePaving(false);
  const paveDay = makePaving(true);
  [paveNight, paveDay].forEach((t) => t.repeat.set(block / 8, block / 8));
  /**
   * The sidewalk sits 1.2 cm above the asphalt, which is a real gap on the
   * ground and no gap at all in the depth buffer once the camera is a few
   * hundred metres up: precision falls off with the square of range, so from a
   * flyover the block interiors and the road they sit on land in the same
   * depth value and the grid boils.
   *
   * `polygonOffset` fixes that in the units that actually matter — it biases
   * by a number of *resolvable depth steps*, whatever those happen to be worth
   * at this range — so the sidewalk wins from a kerb-height camera and from
   * orbit alike. The dynamic near plane in City.tsx does most of the work for
   * the orbit camera; this is what covers the case it cannot, a player who
   * jetpacks to 300 m with the camera still tight behind them.
   */
  const decal = (units: number) => ({
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: units,
  });
  const paveMat = new THREE.MeshStandardMaterial({ map: paveNight, roughness: 0.92, ...decal(-4) });
  const parkMat = new THREE.MeshStandardMaterial({ color: "#16311f", roughness: 0.95, ...decal(-4) });
  const plazaMat = new THREE.MeshStandardMaterial({ color: "#13312a", roughness: 0.9, ...decal(-4) });

  const walkGeos: THREE.BufferGeometry[] = [];
  const parkGeos: THREE.BufferGeometry[] = [];
  const plazaGeos: THREE.BufferGeometry[] = [];
  const isPark: boolean[][] = [];
  for (let gx = 0; gx < grid; gx++) {
    isPark[gx] = [];
    for (let gz = 0; gz < grid; gz++) {
      const cx = (gx - center) * pitch;
      const cz = (gz - center) * pitch;
      const plaza = gx === Math.floor(center) && gz === Math.floor(center);
      const park = !plaza && r() < 0.09;
      isPark[gx][gz] = park;
      const q = flatQuad(block, block, cx, 0.012, cz, park || plaza ? 0 : 8);
      (plaza ? plazaGeos : park ? parkGeos : walkGeos).push(q);

      // The kerb: a rim, 36 cm wide, standing 14 cm proud of the asphalt.
      const t = 0.36;
      const e = block / 2 - t / 2;
      box(concrete, cx, 0, cz + e, block, KERB, t);
      box(concrete, cx, 0, cz - e, block, KERB, t);
      box(concrete, cx + e, 0, cz, t, KERB, block - t * 2);
      box(concrete, cx - e, 0, cz, t, KERB, block - t * 2);
    }
  }
  const addSlabs = (geos: THREE.BufferGeometry[], mat: THREE.Material) => {
    if (!geos.length) return;
    const m = mergeGeometries(geos, false)!;
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(m, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
    trash.push(m);
  };
  addSlabs(walkGeos, paveMat);
  addSlabs(parkGeos, parkMat);
  addSlabs(plazaGeos, plazaMat);
  trash.push(paveMat, parkMat, plazaMat, paveNight, paveDay);

  // Everything the weather can settle on. Roofs and roads matter most — they
  // are what the city IS from the air — but the trees are what gives it away:
  // a district under six inches of snow with a green canopy over it reads as
  // a filter somebody applied rather than as weather. The tree materials are
  // declared further down, so they are patched at the end of the build.
  opts.snow?.patch([roofMat, roadMat, paveMat, parkMat, plazaMat]);

  // Road markings: centre dashes down every street and a zebra at every
  // intersection. Instanced quads a couple of centimetres off the asphalt
  // rather than paint in the road texture, which tiles every 16 m and would
  // repeat the crossings with it.
  // Deeper offset than the pavement: the paint has to clear both the asphalt
  // and the sidewalk it can overlap at a junction. Without it the crossings
  // blink in and out from the air — they never wrote depth, so they were not
  // fighting anything, they were simply failing the depth test half the time.
  const markMat = new THREE.MeshBasicMaterial({
    color: "#c9d4c0", transparent: true, opacity: 0.5, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -10,
  });
  const markGeo = new THREE.PlaneGeometry(1, 1);
  const marks: THREE.Matrix4[] = [];
  const paint = (x: number, z: number, w: number, l: number) => {
    M.makeRotationX(-Math.PI / 2);
    M.scale(S3.set(w, l, 1));
    M.setPosition(x, 0.02, z);
    marks.push(M.clone());
  };
  for (let g = 1; g < grid; g++) {
    const p = (g - center - 0.5) * pitch;
    for (let t = -half + 4; t < half - 4; t += 7) {
      // Skip the junctions — a dashed lane line through a crossing is wrong.
      const fromNode = Math.abs(((t + half) % pitch) - pitch / 2);
      if (fromNode > block / 2 - 1) continue;
      paint(p, t, 0.3, 3.6);
      paint(t, p, 3.6, 0.3);
    }
  }
  for (let gx = 1; gx < grid; gx++) {
    for (let gz = 1; gz < grid; gz++) {
      const x = (gx - center - 0.5) * pitch;
      const z = (gz - center - 0.5) * pitch;
      for (let s = -2; s <= 2; s++) {
        const o = s * 1.8;
        paint(x + o, z + street / 2 + 1.6, 0.7, 3.0);
        paint(x + o, z - street / 2 - 1.6, 0.7, 3.0);
        paint(x + street / 2 + 1.6, z + o, 3.0, 0.7);
        paint(x - street / 2 - 1.6, z + o, 3.0, 0.7);
      }
    }
  }
  trash.push(markGeo, markMat);

  // ---- Street trees ----------------------------------------------------
  // Two instanced meshes, and the aerial view stops being grey. Placed in the
  // sidewalk strip between the building line and the kerb — which is the whole
  // reason the buildings were inset further above.
  const trunks: THREE.Matrix4[] = [];
  const crowns: THREE.Matrix4[] = [];
  const EDGE = block / 2 - 1.1;
  for (let gx = 0; gx < grid; gx++) {
    for (let gz = 0; gz < grid; gz++) {
      const cx = (gx - center) * pitch;
      const cz = (gz - center) * pitch;
      const inPark = isPark[gx][gz];
      for (let side = 0; side < 4; side++) {
        for (let k = -1; k <= 1; k++) {
          if (!inPark && r() < 0.4) continue;
          const along = k * (block / 3) + (r() - 0.5) * 2.6;
          const x = side === 0 || side === 1 ? cx + along : cx + (side === 2 ? EDGE : -EDGE);
          const z = side === 0 ? cz + EDGE : side === 1 ? cz - EDGE : cz + along;
          const h = 3.4 + r() * 2.4;
          cyl(trunks, x, KERB, z, h);
          const cr = 1.25 + r() * 0.75;
          M.makeRotationY(r() * Math.PI);
          M.scale(S3.set(cr, cr * (0.8 + r() * 0.45), cr));
          M.setPosition(x, KERB + h + cr * 0.3, z);
          crowns.push(M.clone());
        }
      }
    }
  }

  // ---- Street lights ---------------------------------------------------
  // What a night city looks like from the air is its lighting grid. Every
  // aerial photograph of a city after dark is orange dots in rows, and without
  // them the streets below simply disappear — which is what was happening to
  // all of the work above: crosswalks, kerbs and trees, invisible at night.
  //
  // No actual lights. Two hundred PointLights would be two hundred forward
  // passes per material; instead each lamp is an emissive head over an additive
  // pool painted on the road. It does not illuminate anything, and from any
  // distance at which you can see the grid you cannot tell.
  const lampPosts: THREE.Matrix4[] = [];
  const lampHeads: THREE.Matrix4[] = [];
  const lampPools: THREE.Matrix4[] = [];
  const LAMP_H = 5.4;
  for (let g = 1; g < grid; g++) {
    const laneCentre = (g - center - 0.5) * pitch;
    // Stepped along the BLOCKS rather than at a fixed interval down the street.
    // A fixed interval lands every other lamp dead in the middle of a junction,
    // where a lamp post is a bollard in the road.
    for (let k = 0; k < grid; k++) {
      for (const off of [-block / 4, block / 4]) {
        const t = (k - center) * pitch + off;
        // Alternate which kerb it stands on, as they actually are.
        const side = ((g + k) % 2 ? 1 : -1) * (street / 2 - 0.6);
        for (const axis of [0, 1] as const) {
          const x = axis === 0 ? laneCentre + side : t;
          const z = axis === 0 ? t : laneCentre + side;
          cyl(lampPosts, x, 0, z, LAMP_H);
          box(lampHeads, x, LAMP_H, z, 0.5, 0.22, 1.1);
          M.makeRotationX(-Math.PI / 2);
          M.scale(S3.set(11, 11, 1));
          M.setPosition(x, 0.05, z);
          lampPools.push(M.clone());
        }
      }
    }
  }

  // The pool: a soft additive disc. Drawn as a texture rather than a shader
  // because it is one gradient and a 128 px canvas costs nothing.
  const poolTex = (() => {
    const { c, x } = canvasOf(128);
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255, 214, 150, 0.62)");
    g.addColorStop(0.45, "rgba(255, 190, 120, 0.20)");
    g.addColorStop(1, "rgba(255, 180, 110, 0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lampHeadMat = new THREE.MeshStandardMaterial({
    color: "#20262e",
    emissive: new THREE.Color("#ffd08a"),
    emissiveIntensity: 2.4,
  });
  const lampPostMat = new THREE.MeshStandardMaterial({ color: "#2b323b", roughness: 0.8 });

  // ---- Aviation beacons ------------------------------------------------
  // The red lights on tall buildings. Three groups blinking out of phase,
  // because two hundred lamps flashing in unison reads as a rendering bug.
  const BEACON_GROUPS = 3;
  const beacons: THREE.Matrix4[][] = Array.from({ length: BEACON_GROUPS }, () => []);
  const beaconMats = Array.from(
    { length: BEACON_GROUPS },
    () =>
      new THREE.MeshBasicMaterial({ color: "#ff4d4d", transparent: true, depthWrite: false }),
  );
  beaconAt.forEach((b, i) => {
    M.identity();
    M.setPosition(b.x, b.y + 1.5, b.z);
    beacons[i % BEACON_GROUPS].push(M.clone());
  });

  // ---- Upload the instanced meshes -------------------------------------
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const tankGeo = new THREE.CylinderGeometry(1.05, 1.05, 1, 12);
  const ventGeo = new THREE.CylinderGeometry(0.32, 0.38, 1, 8);
  const trunkGeo = new THREE.CylinderGeometry(0.17, 0.26, 1, 6);
  const crownGeo = new THREE.IcosahedronGeometry(1, 0);

  const concreteMat = new THREE.MeshStandardMaterial({ color: "#39414c", roughness: 0.92 });
  const plantMat = new THREE.MeshStandardMaterial({ color: "#3d454f", roughness: 0.7, metalness: 0.25 });
  const tankMat = new THREE.MeshStandardMaterial({ color: "#2e2720", roughness: 0.85 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: "#241c15", roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ color: "#1a3823", roughness: 0.9, flatShading: true });

  const instance = (geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[]) => {
    if (!mats.length) return;
    const im = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true;
    im.receiveShadow = true;
    group.add(im);
  };
  instance(unitBox, concreteMat, concrete);
  instance(unitBox, plantMat, plant);
  instance(tankGeo, tankMat, tanks);
  instance(ventGeo, plantMat, vents);
  instance(trunkGeo, trunkMat, trunks);
  instance(crownGeo, leafMat, crowns);
  opts.snow?.patch([leafMat, concreteMat, tankMat]);

  const lampPostGeo = new THREE.CylinderGeometry(0.09, 0.13, 1, 6);
  const poolGeo = new THREE.PlaneGeometry(1, 1);
  const beaconGeo = new THREE.SphereGeometry(0.42, 8, 6);
  instance(lampPostGeo, lampPostMat, lampPosts);
  instance(unitBox, lampHeadMat, lampHeads);
  // Pools and beacons are unlit overlays — casting or receiving from them
  // would put a shadow under a light, which is exactly backwards.
  const flatInstance = (geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[]) => {
    if (!mats.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
    return im;
  };
  const poolMesh = flatInstance(poolGeo, poolMat, lampPools);
  const beaconMeshes = beacons.map((list, i) => flatInstance(beaconGeo, beaconMats[i], list));
  trash.push(lampPostGeo, poolGeo, beaconGeo, lampPostMat, lampHeadMat, poolMat, poolTex, ...beaconMats);

  if (marks.length) {
    const im = new THREE.InstancedMesh(markGeo, markMat, marks.length);
    marks.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
  }
  trash.push(
    unitBox, tankGeo, ventGeo, trunkGeo, crownGeo,
    concreteMat, plantMat, tankMat, trunkMat, leafMat,
  );

  // ---- Traffic ---------------------------------------------------------
  // Cars are the difference between a model of a city and a city. They run the
  // street centrelines at a constant speed and wrap at the far edge — no
  // junction logic, because from any altitude where you can see the grid you
  // cannot see that nobody is turning.
  const CAR_COLORS = ["#c9ced6", "#2b3440", "#8d2f38", "#26506e", "#b8a13f", "#5a6470"];
  const cars: Array<{ lane: number; axis: 0 | 1; dir: 1 | -1; t: number; speed: number }> = [];
  for (let g = 1; g < grid; g++) {
    const laneCentre = (g - center - 0.5) * pitch;
    for (const axis of [0, 1] as const) {
      for (const dir of [1, -1] as const) {
        for (let i = 0, n = 2 + Math.floor(r() * 3); i < n; i++) {
          cars.push({
            lane: laneCentre + dir * 2.6,
            axis,
            dir,
            t: r() * span - half,
            speed: 8 + r() * 7,
          });
        }
      }
    }
  }
  const carGeo = new THREE.BoxGeometry(1.8, 1.25, 4.2);
  const carMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.5 });
  const carMesh = new THREE.InstancedMesh(carGeo, carMat, Math.max(1, cars.length));
  carMesh.castShadow = true;
  {
    const c = new THREE.Color();
    for (let i = 0; i < cars.length; i++) {
      c.set(CAR_COLORS[Math.floor(r() * CAR_COLORS.length)]);
      carMesh.setColorAt(i, c);
    }
    if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;
  }
  group.add(carMesh);
  trash.push(carGeo, carMat);

  const carQ = new THREE.Quaternion();
  const carP = new THREE.Vector3();
  const carS = new THREE.Vector3(1, 1, 1);
  const UP = new THREE.Vector3(0, 1, 0);

  // ---- Day / night -----------------------------------------------------
  const setDay = (day: boolean) => {
    skins.forEach((s) => {
      const src = day ? s.day : s.night;
      s.mat.map = src.map;
      s.mat.emissiveMap = src.emissiveMap;
      s.mat.emissiveIntensity = day ? 0 : 1;
      s.mat.needsUpdate = true;
    });
    roofMat.map = day ? roofDay : roofNight;
    roofMat.needsUpdate = true;
    roadMat.map = day ? asphaltDay : asphaltNight;
    roadMat.needsUpdate = true;
    paveMat.map = day ? paveDay : paveNight;
    paveMat.needsUpdate = true;
    concreteMat.color.set(day ? "#a7aeb6" : "#39414c");
    plantMat.color.set(day ? "#a8b0b9" : "#3d454f");
    tankMat.color.set(day ? "#7d6852" : "#2e2720");
    trunkMat.color.set(day ? "#5b4636" : "#241c15");
    leafMat.color.set(day ? "#4e9455" : "#1a3823");
    parkMat.color.set(day ? "#4f8f57" : "#16311f");
    plazaMat.color.set(day ? "#57a184" : "#13312a");
    markMat.opacity = day ? 0.72 : 0.5;
    // Street lights go out in daylight — a lit lamp at noon is the kind of
    // detail that reads as "nobody looked at this in the other mode".
    lampHeadMat.emissiveIntensity = day ? 0 : 2.4;
    lampHeadMat.color.set(day ? "#6f7883" : "#20262e");
    lampPostMat.color.set(day ? "#79828d" : "#2b323b");
    if (poolMesh) poolMesh.visible = !day;
    beaconMeshes.forEach((m) => {
      if (m) m.visible = !day;
    });
  };
  setDay(false);

  let clock = 0;
  const update = (dt: number) => {
    clock += dt;
    // Aviation beacons: a slow blink, each group a third of a period out of
    // phase, so the skyline twinkles instead of strobing.
    for (let i = 0; i < BEACON_GROUPS; i++) {
      const phase = (clock / 2.4 + i / BEACON_GROUPS) % 1;
      // Short flash, long dark — a beacon is mostly off.
      beaconMats[i].opacity = phase < 0.22 ? 0.55 + Math.sin(phase / 0.22 * Math.PI) * 0.45 : 0.06;
    }
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      car.t += car.speed * car.dir * dt;
      if (car.t > half) car.t -= span;
      else if (car.t < -half) car.t += span;
      const x = car.axis === 0 ? car.lane : car.t;
      const z = car.axis === 0 ? car.t : car.lane;
      const yaw =
        car.axis === 0
          ? car.dir > 0 ? 0 : Math.PI
          : car.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      carQ.setFromAxisAngle(UP, yaw);
      carP.set(x, 0.65, z);
      M.compose(carP, carQ, carS);
      carMesh.setMatrixAt(i, M);
    }
    carMesh.instanceMatrix.needsUpdate = true;
  };

  return {
    group,
    boxes,
    pads,
    setDay,
    update,
    dispose() {
      trash.forEach((t) => t.dispose());
    },
  };
}
