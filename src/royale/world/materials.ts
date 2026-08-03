/**
 * DROP ZERO — the material library.
 *
 * Every textured surface on the island comes from here. Terrain, POIs, props,
 * vegetation, loot and the build pieces all call `ctx.services.materials`, and
 * because they share one library the island reads as one place and the texture
 * budget stays bounded instead of being re-rolled twenty times over.
 *
 * NO EXTERNAL ASSETS. Every pixel below is painted on a Canvas2D at boot and
 * lifted onto the GPU. Nothing is fetched.
 *
 * ── What "not a Three.js demo" actually means here ────────────────────────
 * Six things betray a web game in a blind side-by-side, and five of them are
 * this module's problem:
 *
 *  1. UNIFORM ROUGHNESS. The single loudest tell. A surface with one roughness
 *     value is plastic under every light. So every material ships a painted
 *     roughness channel: mortar is rougher than the brick face, tile crowns
 *     take a rain polish the grooves never get, rust is dead matte against
 *     bright zinc, wheel paths on asphalt are burnished. Nothing here is flat.
 *  2. NO KEY / FLAT AMBIENT. The sky system owns the sun, but *specular* is
 *     ours: `env` is a PMREM'd procedural sky+ground probe assigned to
 *     `scene.environment`. Without it every metal in the game is grey paint
 *     and every window is a black rectangle. This one texture is worth a tier.
 *  3. UNTEXTURED SOLID COLOUR. Nothing gets a flat fill — every base coat is
 *     followed by blotching, per-unit tone variance and a grain pass.
 *  4. HARD-EDGED, RELIEF-FREE GEOMETRY. Geometry is somebody else's file, but
 *     the *small* relief is ours: every material authors a height field which
 *     is sobelled into a tangent-space normal map. Brick courses, plank gaps,
 *     tile rows, corrugation ribs and bark fissures all catch the sun.
 *  5. NO SMALL-SCALE DETAIL. Nail heads, tie holes, screw washers, rivets,
 *     stitch lines, efflorescence, lichen, chipped arrises, soot streaks. The
 *     detail that reads at 2 m is what sells the surface at 30 m.
 *
 * (The sixth — aerial haze — belongs to sky/postfx.)
 *
 * ── Channel packing ───────────────────────────────────────────────────────
 * Five canvases are painted per material in lockstep — albedo, AO, roughness,
 * metalness, height — so a rivet is authored as one statement that knows it is
 * bright, glossy, metal, proud of the wall and shadowed at its root.
 *
 * They bake into three GPU textures, the glTF ORM convention:
 *
 *   map     RGB albedo (sRGB), A = cutout coverage for foliage
 *   normalMap  tangent-space normals, sobelled from the height canvas
 *   ORM     R = AO, G = roughness, B = metalness — bound as `aoMap`,
 *           `roughnessMap` and `metalnessMap` at once. Three reads .r/.g/.b
 *           from those three slots natively, so one fetch serves all three,
 *           and in r160 `Texture.channel` defaults to 0 so the ORM map rides
 *           the same UV set as the albedo (no uv2 required from callers).
 *
 * `material.roughness` and `material.metalness` are pinned to 1 so the maps
 * carry the real values rather than being scaled by a second knob.
 *
 * A fraction of the AO is *also* multiplied into the albedo at bake time. An
 * aoMap only darkens indirect light; folding a third of it into the base
 * colour is what keeps mortar joints and plank gaps dark when the key light
 * is straight on them.
 *
 * ── Baking is lazy, and that is deliberate ────────────────────────────────
 * `get()`/`texture()` bake on first ask. Two reasons: the cost lands inside
 * whichever boot stage actually wants the surface (so the loading bar keeps
 * moving instead of stalling on one line), and a material nobody uses costs
 * nothing — at "high" the full twenty would be ~170 MB of VRAM and no map ever
 * needs all twenty. Every bake seeds its own RNG from a hash of the material
 * name, so bake *order* can never change what a surface looks like, and we
 * never draw from `ctx.rng` (which is shared, and whose call count other
 * systems' determinism depends on).
 *
 * ── The shared shader patch ───────────────────────────────────────────────
 * Every opaque material gets one small `onBeforeCompile`:
 *
 *  • MACRO VARIATION. A world-space noise fetch multiplies the albedo by
 *    ±8 %. Tiling repetition is the thing that makes a 3 km island look like
 *    graph paper from the bus, and this kills it for one texture fetch.
 *  • INSTANCE TINT. r160 routes `instanceColor` into `vColor` but only
 *    *applies* it under `USE_COLOR`, which needs `vertexColors: true`, which
 *    would cost every non-instanced user a colour attribute. We apply it
 *    ourselves so a thousand instanced crates can be individually painted off
 *    one shared material.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre. Texture UVs are
 * authored in metres: divide world distance by `MATERIAL_TILE_METRES[name]`
 * when you generate UVs and the brick courses will be the right size.
 */
import * as THREE from "three";
import type {
  ImpactMaterial,
  MaterialName,
  MaterialsService,
  QualityTier,
  System,
  SystemFactory,
  TextureName,
  WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

interface Tier {
  /** Albedo/normal resolution for a full-detail material. */
  base: number;
  aniso: number;
  /**
   * Real refraction on glass. `transmission` costs an extra full-scene render
   * target every frame, which is not a trade a battle royale can make below
   * the top tier — everything else gets a tuned alpha pane that reads almost
   * identically at the distances glass is actually seen from.
   */
  transmission: boolean;
  /** Octaves in the seamless grain field folded over every material. */
  grainOctaves: number;
  /** Equirect width for the environment probe. */
  env: number;
}

/**
 * The suggested ladder was 512/1024/2048. `low` is pulled to 256 on purpose:
 * a low tier is by definition the machine that can least afford ~170 MB of
 * material atlases, and at the pixel-ratio cap that tier runs at, 256 with
 * good anisotropy is indistinguishable from 512.
 */
const TIERS: Record<QualityTier, Tier> = {
  low: { base: 256, aniso: 2, transmission: false, grainOctaves: 2, env: 256 },
  medium: { base: 512, aniso: 4, transmission: false, grainOctaves: 3, env: 512 },
  high: { base: 1024, aniso: 8, transmission: false, grainOctaves: 3, env: 512 },
  ultra: { base: 2048, aniso: 16, transmission: true, grainOctaves: 4, env: 1024 },
};

/** Hard floor — below this the brick courses stop resolving at all. */
const MIN_SIZE = 128;

/**
 * How each material behaves once it is baked.
 *
 * `tintable` materials are painted near-neutral (value and a whisper of hue
 * jitter, no committed colour) so `tinted()` can repaint them outright for
 * per-POI identity; `base` is then the colour `get()` hands back so the
 * un-tinted material still looks like terracotta rather than grey card.
 * Everything else is painted in its own colours and `tinted()` multiplies.
 */
interface MatSpec {
  /** Linear resolution multiplier off the tier base. */
  detail: number;
  /** Height→normal gain, in height-units per texel, normalised to 256 px. */
  relief: number;
  /** Tangent-space normal strength. */
  normalScale: number;
  /** Reflection strength against `scene.environment`. */
  env: number;
  /** Fraction of the baked AO multiplied into the albedo. */
  aoBake: number;
  /** World metres spanned by one UV repeat. */
  metres: number;
  /** Default `material.color`, i.e. the identity colour of the surface. */
  base: number;
  tintable?: boolean;
  /** Painter writes an alpha channel; the material becomes an alpha cutout. */
  cutout?: boolean;
  side?: THREE.Side;
  /** Impact family, so collision/vfx can classify a surface by its material. */
  impact: ImpactMaterial;
}

const SPEC: Record<MaterialName, MatSpec> = {
  plaster: { detail: 1, relief: 1.4, normalScale: 0.85, env: 0.55, aoBake: 0.35, metres: 3.2, base: 0xf0e6d4, tintable: true, impact: "concrete" },
  brick: { detail: 1, relief: 3.4, normalScale: 1.15, env: 0.4, aoBake: 0.45, metres: 2.4, base: 0xffffff, impact: "concrete" },
  woodPlank: { detail: 1, relief: 2.6, normalScale: 1.0, env: 0.45, aoBake: 0.4, metres: 2.6, base: 0xffffff, impact: "wood" },
  woodLog: { detail: 0.5, relief: 2.8, normalScale: 1.0, env: 0.4, aoBake: 0.4, metres: 2.0, base: 0xffffff, impact: "wood" },
  concrete: { detail: 1, relief: 1.6, normalScale: 0.9, env: 0.5, aoBake: 0.35, metres: 3.6, base: 0xffffff, impact: "concrete" },
  asphalt: { detail: 0.5, relief: 1.2, normalScale: 0.8, env: 0.6, aoBake: 0.3, metres: 5.0, base: 0xffffff, impact: "concrete" },
  metalPanel: { detail: 1, relief: 2.6, normalScale: 1.0, env: 1.1, aoBake: 0.35, metres: 2.8, base: 0xdfe3e6, tintable: true, impact: "metal" },
  corrugated: { detail: 1, relief: 5.2, normalScale: 1.25, env: 1.15, aoBake: 0.4, metres: 3.0, base: 0xffffff, impact: "metal" },
  roofTile: { detail: 1, relief: 4.4, normalScale: 1.2, env: 0.6, aoBake: 0.5, metres: 2.6, base: 0xc4562e, tintable: true, impact: "concrete" },
  roofShingle: { detail: 0.5, relief: 3.0, normalScale: 1.05, env: 0.35, aoBake: 0.45, metres: 3.0, base: 0x6d6a66, tintable: true, impact: "concrete" },
  glass: { detail: 0.5, relief: 0.6, normalScale: 0.35, env: 1.6, aoBake: 0.0, metres: 2.0, base: 0xdff0f4, impact: "glass" },
  rock: { detail: 1, relief: 3.2, normalScale: 1.1, env: 0.35, aoBake: 0.45, metres: 4.5, base: 0xffffff, impact: "concrete" },
  dirt: { detail: 1, relief: 2.0, normalScale: 0.95, env: 0.25, aoBake: 0.4, metres: 4.0, base: 0xffffff, impact: "dirt" },
  sand: { detail: 0.5, relief: 1.8, normalScale: 0.9, env: 0.3, aoBake: 0.3, metres: 4.0, base: 0xffffff, impact: "sand" },
  grass: { detail: 1, relief: 2.2, normalScale: 1.0, env: 0.22, aoBake: 0.45, metres: 3.0, base: 0xffffff, impact: "grass" },
  foliage: { detail: 0.5, relief: 2.4, normalScale: 1.0, env: 0.3, aoBake: 0.35, metres: 1.0, base: 0xffffff, cutout: true, side: THREE.DoubleSide, impact: "grass" },
  bark: { detail: 1, relief: 4.6, normalScale: 1.25, env: 0.2, aoBake: 0.5, metres: 2.2, base: 0xffffff, impact: "wood" },
  fabric: { detail: 0.5, relief: 1.6, normalScale: 0.8, env: 0.4, aoBake: 0.3, metres: 2.0, base: 0xf2ede2, tintable: true, side: THREE.DoubleSide, impact: "dirt" },
  gold: { detail: 0.5, relief: 1.8, normalScale: 0.7, env: 1.5, aoBake: 0.2, metres: 1.2, base: 0xffffff, impact: "metal" },
  rubber: { detail: 0.5, relief: 3.2, normalScale: 1.05, env: 0.5, aoBake: 0.4, metres: 1.4, base: 0xffffff, impact: "dirt" },
};

/** World metres spanned by one UV repeat, per material. Divide world by this. */
export const MATERIAL_TILE_METRES: Record<MaterialName, number> = Object.fromEntries(
  (Object.keys(SPEC) as MaterialName[]).map((k) => [k, SPEC[k].metres]),
) as Record<MaterialName, number>;

/** Impact family per material — footsteps, bullet decals, harvest particles. */
export const MATERIAL_IMPACT: Record<MaterialName, ImpactMaterial> = Object.fromEntries(
  (Object.keys(SPEC) as MaterialName[]).map((k) => [k, SPEC[k].impact]),
) as Record<MaterialName, ImpactMaterial>;

/** ±8 % world-space albedo swing. Enough to kill tiling, too small to notice. */
const MACRO_STRENGTH = 0.16;
/** Metres per repeat of the macro-variation field. */
const MACRO_METRES = 41;

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** FNV-1a over a name — a stable per-material seed, independent of bake order. */
function seedFor(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32, local so we never disturb the shared world RNG. */
function rngFor(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise on a wrapped integer lattice — seamless by construction. */
function vnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let u = x - xi;
  let v = y - yi;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}

/**
 * Fractal value noise over UV in [0,1). Seamless across the texture edge.
 *
 * Exported because every system that paints its own canvas needs exactly this
 * and there is no reason for five copies of it to exist. `period` must be a
 * whole number — the wrap is a modulo on the lattice, and a fractional period
 * puts a seam down the middle of the tile.
 */
export function tileableFbm(u: number, v: number, period: number, octaves: number, seed: number): number {
  return fbmT(u, v, period, octaves, seed);
}

function fbmT(u: number, v: number, period: number, octaves: number, seed: number): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(u * p, v * p, p, seed + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/**
 * A seamless scalar field evaluated on a coarse lattice and bilinearly
 * resampled. At 1024² a per-texel fbm costs ~0.2 s per material; a 96² lattice
 * costs a fraction of a millisecond and, for a field whose whole job is
 * low-frequency drift, is visually identical.
 */
function grainField(res: number, period: number, octaves: number, seed: number): Float32Array {
  const f = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      f[y * res + x] = fbmT((x + 0.5) / res, (y + 0.5) / res, period, octaves, seed);
    }
  }
  return f;
}

/** Wrapped bilinear tap into a `grainField`. */
function sampleField(f: Float32Array, res: number, u: number, v: number): number {
  const fx = u * res - 0.5;
  const fy = v * res - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = ((x0 % res) + res) % res;
  const ya = ((y0 % res) + res) % res;
  const xb = (xa + 1) % res;
  const yb = (ya + 1) % res;
  const a = f[ya * res + xa];
  const b = f[ya * res + xb];
  const c = f[yb * res + xa];
  const d = f[yb * res + xb];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

/* ------------------------------------------------------------------------ *
 * Canvas painting
 * ------------------------------------------------------------------------ */

type Ctx2D = CanvasRenderingContext2D;

interface Paint {
  /** Albedo (sRGB). Starts transparent for cutout materials. */
  a: Ctx2D;
  /** Ambient occlusion, greyscale. 255 = fully open. */
  o: Ctx2D;
  /** Roughness, greyscale. */
  r: Ctx2D;
  /** Metalness, greyscale. */
  m: Ctx2D;
  /** Height, greyscale. 128 = the datum plane. */
  h: Ctx2D;
  /** Resolution. */
  n: number;
  rng: () => number;
}

const css = (r: number, g: number, b: number) =>
  `rgb(${Math.round(clamp01(r) * 255)},${Math.round(clamp01(g) * 255)},${Math.round(clamp01(b) * 255)})`;
const grey = (v: number) => {
  const c = Math.round(clamp01(v) * 255);
  return `rgb(${c},${c},${c})`;
};

/**
 * Set every channel's fill at once. Argument order is deliberately
 * albedo → roughness → metalness → AO → height, i.e. loudest first, so a
 * painter line reads as "this colour, this rough, this metal, this deep".
 */
function style(
  p: Paint,
  r: number,
  g: number,
  b: number,
  rough: number,
  metal: number,
  ao: number,
  hgt: number,
): void {
  p.a.fillStyle = css(r, g, b);
  p.r.fillStyle = grey(rough);
  p.m.fillStyle = grey(metal);
  p.o.fillStyle = grey(ao);
  p.h.fillStyle = grey(hgt);
}

/**
 * Every wrapped copy of a rect that crosses a texture edge. A map with a seam
 * is worse than no map at all, so anything that can straddle the boundary is
 * drawn through here rather than clipped.
 */
function wrapped(x: number, y: number, w: number, h: number, n: number): number[][] {
  const xs = x < 0 ? [x, x + n] : x + w > n ? [x, x - n] : [x];
  const ys = y < 0 ? [y, y + n] : y + h > n ? [y, y - n] : [y];
  const out: number[][] = [];
  for (let i = 0; i < xs.length; i++) for (let j = 0; j < ys.length; j++) out.push([xs[i], ys[j]]);
  return out;
}

/** Fill a rect into all five canvases, wrapping across the edges. */
function fill(p: Paint, x: number, y: number, w: number, h: number): void {
  const cells = wrapped(x, y, w, h, p.n);
  for (let i = 0; i < cells.length; i++) {
    const cx = cells[i][0];
    const cy = cells[i][1];
    p.a.fillRect(cx, cy, w, h);
    p.o.fillRect(cx, cy, w, h);
    p.r.fillRect(cx, cy, w, h);
    p.m.fillRect(cx, cy, w, h);
    p.h.fillRect(cx, cy, w, h);
  }
}

/** Single-channel wrapped rect, used by the targeted helpers below. */
function channelRect(
  g: Ctx2D,
  n: number,
  fillStyle: string,
  alpha: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  g.save();
  g.globalAlpha = clamp01(alpha);
  g.fillStyle = fillStyle;
  const cells = wrapped(x, y, w, h, n);
  for (let i = 0; i < cells.length; i++) g.fillRect(cells[i][0], cells[i][1], w, h);
  g.restore();
}

/** Albedo-only wash — stains, paint, soot, efflorescence. */
function tint(p: Paint, r: number, g: number, b: number, alpha: number, x: number, y: number, w: number, h: number): void {
  channelRect(p.a, p.n, css(r, g, b), alpha, x, y, w, h);
}
/** Roughness-only — polish, wet patches, scuffs. */
function polish(p: Paint, rough: number, alpha: number, x: number, y: number, w: number, h: number): void {
  channelRect(p.r, p.n, grey(rough), alpha, x, y, w, h);
}
/** Metalness-only — bare metal showing through paint, rust killing it off. */
function metalize(p: Paint, metal: number, alpha: number, x: number, y: number, w: number, h: number): void {
  channelRect(p.m, p.n, grey(metal), alpha, x, y, w, h);
}
/** AO-only — contact shadows, crevices, overlaps. */
function occlude(p: Paint, ao: number, alpha: number, x: number, y: number, w: number, h: number): void {
  channelRect(p.o, p.n, grey(ao), alpha, x, y, w, h);
}
/** Height-only — relief without changing what the surface is made of. */
function bump(p: Paint, hgt: number, alpha: number, x: number, y: number, w: number, h: number): void {
  channelRect(p.h, p.n, grey(hgt), alpha, x, y, w, h);
}

/** Wrapped ellipse on one channel — the workhorse for anything organic. */
function blob(g: Ctx2D, n: number, fillStyle: string, alpha: number, x: number, y: number, rx: number, ry: number, rot: number): void {
  const m = Math.max(rx, ry) + 1;
  const xs = x < m ? [x, x + n] : x > n - m ? [x, x - n] : [x];
  const ys = y < m ? [y, y + n] : y > n - m ? [y, y - n] : [y];
  g.save();
  g.globalAlpha = clamp01(alpha);
  g.fillStyle = fillStyle;
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length; j++) {
      g.beginPath();
      g.ellipse(xs[i], ys[j], rx, ry, rot, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

/**
 * A wandering polyline in texture space.
 *
 * Generated once and stroked onto several channels, never re-generated per
 * channel: a crack that is dark in the albedo but whose groove in the height
 * map wandered somewhere else is the single most obvious authoring mistake a
 * procedural material can make, and it is invisible until you light it.
 */
function crackPath(x0: number, y0: number, steps: number, spread: number, rng: () => number): number[][] {
  const pts: number[][] = [[x0, y0]];
  let x = x0;
  let y = y0;
  let ang = rng() * Math.PI * 2;
  for (let i = 0; i < steps; i++) {
    ang += (rng() - 0.5) * 1.2;
    x += Math.cos(ang) * spread;
    y += Math.sin(ang) * spread;
    pts.push([x, y]);
  }
  return pts;
}

/** Stroke a path on one channel, wrapped in both axes. */
function strokePath(g: Ctx2D, n: number, strokeStyle: string, alpha: number, width: number, pts: number[][]): void {
  g.save();
  g.globalAlpha = clamp01(alpha);
  g.strokeStyle = strokeStyle;
  g.lineWidth = Math.max(0.5, width);
  g.lineCap = "round";
  g.lineJoin = "round";
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      g.beginPath();
      g.moveTo(pts[0][0] + ox * n, pts[0][1] + oy * n);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] + ox * n, pts[i][1] + oy * n);
      g.stroke();
    }
  }
  g.restore();
}

function makeCanvas(size: number): Ctx2D | null {
  try {
    if (typeof document === "undefined") return null;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
    if (!g) return null;
    return g;
  } catch {
    return null;
  }
}

/**
 * Read a channel back, flipped vertically.
 *
 * Canvas row 0 is the top; a `DataTexture` row 0 is v = 0. Flipping once here
 * lets every painter author top-down (y = 0 is the top of the wall) and keeps
 * albedo, normal and ORM in agreement — which matters for the directional
 * materials, where "rust collects at the bottom edge" has to mean something.
 */
function readChannel(g: Ctx2D, size: number): Uint8ClampedArray | null {
  let data: Uint8ClampedArray;
  try {
    data = g.getImageData(0, 0, size, size).data;
  } catch {
    return null;
  }
  const row = size * 4;
  const tmp = new Uint8ClampedArray(row);
  for (let y = 0; y < size >> 1; y++) {
    const a = y * row;
    const b = (size - 1 - y) * row;
    tmp.set(data.subarray(a, a + row));
    data.copyWithin(a, b, b + row);
    data.set(tmp, b);
  }
  return data;
}

/* ------------------------------------------------------------------------ *
 * Material painters
 * ------------------------------------------------------------------------ */
//
// Every painter is authored against a 0..1 range on all five channels and a
// square canvas of `p.n`. They must stay resolution-independent — everything
// is expressed as a fraction of `n` — because the same painter runs at 256 on
// a laptop and 2048 on a workstation.

/* --- plaster --------------------------------------------------------------- */
//
// Rendered lime plaster: the default wall of the island. Painted near-white so
// a POI can repaint it wholesale; all the character is in the trowel relief,
// the blotching and the crazing.

function paintPlaster(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 0.90, 0.885, 0.855, 0.90, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Blotching: big slow patches of slightly different mix. Plaster is laid by
  // hand in bays and never dries to one value — this is the difference between
  // "wall" and "swatch".
  for (let i = 0; i < 90; i++) {
    const s = n * (0.06 + rng() * 0.24);
    const warm = rng() < 0.5;
    blob(p.a, n, css(warm ? 0.98 : 0.80, warm ? 0.955 : 0.79, warm ? 0.90 : 0.775), 0.05 + rng() * 0.09, rng() * n, rng() * n, s, s * (0.5 + rng() * 0.7), rng() * Math.PI);
    blob(p.r, n, grey(0.86 + rng() * 0.11), 0.35, rng() * n, rng() * n, s, s * 0.7, rng() * Math.PI);
  }

  // Trowel arcs — overlapping shallow sweeps, in height only, so the sun rakes
  // across them at low angles the way it does across real render.
  for (let i = 0; i < 420; i++) {
    const s = n * (0.02 + rng() * 0.10);
    blob(p.h, n, grey(0.5 + (rng() - 0.5) * 0.22), 0.30, rng() * n, rng() * n, s, s * (0.30 + rng() * 0.45), rng() * Math.PI);
  }

  // Aggregate pitting. Tiny, dense, and the single cheapest thing that stops a
  // flat wall reading as a painted plane at 2 m.
  for (let i = 0; i < Math.round(n * 5.5); i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = 1 + rng() * (n / 340);
    blob(p.h, n, grey(0.36 + rng() * 0.1), 0.55, x, y, s, s, 0);
    if (rng() < 0.4) blob(p.a, n, css(0.72, 0.70, 0.67), 0.25, x, y, s, s, 0);
  }

  // Hairline crazing. One path, three channels — the AO is deliberately the
  // widest stroke so the crack still reads once the normal map has mipped out.
  for (let i = 0; i < 34; i++) {
    const w = Math.max(1, n / 900);
    const path = crackPath(rng() * n, rng() * n, 7, n * 0.045, rng);
    strokePath(p.a, n, "rgb(150,144,132)", 0.30, w, path);
    strokePath(p.h, n, "rgb(96,96,96)", 0.55, w * 1.4, path);
    strokePath(p.o, n, "rgb(190,190,190)", 0.40, w * 2.2, path);
  }

  // Damp and moss find the same places twice: dull, slightly darker, and only
  // where water sits.
  for (let i = 0; i < 22; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.03 + rng() * 0.10);
    blob(p.a, n, css(0.66, 0.66, 0.60), 0.10 + rng() * 0.12, x, y, s, s * 0.7, rng() * Math.PI);
    blob(p.r, n, grey(0.97), 0.5, x, y, s, s * 0.7, 0);
  }
}

/* --- brick ---------------------------------------------------------------- */
//
// Running bond, twelve courses to a 2.4 m repeat (≈ 200 mm gauge). Mortar sits
// 12 % below the brick face in the height map and is a full 0.12 rougher — the
// contrast between the two is what makes a brick wall read as brick rather
// than as a photograph of brick.

/** Fired-clay range. Real brick is never one colour, not even in one course. */
const BRICK_TONES: number[][] = [
  [0.62, 0.26, 0.19],
  [0.71, 0.36, 0.25],
  [0.55, 0.22, 0.17],
  [0.76, 0.45, 0.32],
  [0.47, 0.21, 0.18],
  [0.68, 0.32, 0.22],
  [0.58, 0.34, 0.28],
];

function paintBrick(p: Paint): void {
  const n = p.n;
  const rng = p.rng;
  const ROWS = 12;
  const COLS = 6;
  const rh = n / ROWS;
  const bw = n / COLS;
  const joint = Math.max(1.5, n * 0.008);

  // Mortar bed first — everything else is laid on top of it.
  style(p, 0.70, 0.685, 0.65, 0.97, 0, 0.82, 0.34);
  fill(p, 0, 0, n, n);
  for (let i = 0; i < 700; i++) {
    const s = 1 + rng() * (n / 260);
    blob(p.a, n, rng() < 0.5 ? "rgb(210,206,196)" : "rgb(140,136,126)", 0.22, rng() * n, rng() * n, s, s, 0);
  }

  for (let r = 0; r < ROWS; r++) {
    // Half-brick offset on alternate courses: running bond.
    const off = (r & 1) * bw * 0.5;
    const y = r * rh;
    for (let c = 0; c < COLS; c++) {
      const x = c * bw + off;
      const t = BRICK_TONES[(rng() * BRICK_TONES.length) | 0];
      // Per-brick value jitter on top of the palette pick, so no two faces in a
      // course match even when they drew the same tone.
      const j = 0.88 + rng() * 0.26;
      const rough = 0.74 + rng() * 0.14;
      style(p, t[0] * j, t[1] * j, t[2] * j, rough, 0, 1, 0.60 + rng() * 0.05);
      fill(p, x + joint, y + joint, bw - joint * 2, rh - joint * 2);

      // Arris highlight along the top edge and a contact shadow under the
      // bottom — the brick is proud of the joint and has to look it.
      tint(p, 1.0, 0.86, 0.76, 0.14, x + joint, y + joint, bw - joint * 2, Math.max(1, rh * 0.07));
      occlude(p, 0.42, 0.85, x + joint, y + rh - joint - Math.max(1, rh * 0.10), bw - joint * 2, Math.max(1, rh * 0.10));
      occlude(p, 0.52, 0.7, x + joint, y + joint, Math.max(1, bw * 0.03), rh - joint * 2);
      occlude(p, 0.52, 0.7, x + bw - joint - Math.max(1, bw * 0.03), y + joint, Math.max(1, bw * 0.03), rh - joint * 2);

      // Face grit: fired clay is porous and speckled.
      for (let i = 0; i < 26; i++) {
        const s = 1 + rng() * (n / 420);
        const dark = rng() < 0.6;
        blob(p.a, n, dark ? "rgb(60,32,26)" : "rgb(220,190,170)", 0.10 + rng() * 0.2, x + joint + rng() * (bw - joint * 2), y + joint + rng() * (rh - joint * 2), s, s, 0);
      }
      // One brick in eight has a spalled corner: chip the height and the AO.
      if (rng() < 0.13) {
        const cx = x + (rng() < 0.5 ? joint * 2 : bw - joint * 2);
        const cy = y + (rng() < 0.5 ? joint * 2 : rh - joint * 2);
        const s = Math.max(2, bw * (0.06 + rng() * 0.10));
        blob(p.h, n, grey(0.42), 0.9, cx, cy, s, s * 0.8, rng() * Math.PI);
        blob(p.a, n, "rgb(190,150,120)", 0.55, cx, cy, s, s * 0.8, 0);
        blob(p.o, n, grey(0.6), 0.7, cx, cy, s, s * 0.8, 0);
        blob(p.r, n, grey(0.94), 0.8, cx, cy, s, s * 0.8, 0);
      }
    }
  }

  // Efflorescence: salt bloom weeping out of the joints. Pale, chalky, and the
  // detail nobody thinks to add.
  for (let i = 0; i < 18; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.03 + rng() * 0.09);
    blob(p.a, n, "rgb(238,236,230)", 0.09 + rng() * 0.13, x, y, s, s * (0.4 + rng() * 0.5), 0);
    blob(p.r, n, grey(0.98), 0.5, x, y, s, s * 0.5, 0);
  }
  // Soot and rain-shadow streaks running down the wall.
  for (let i = 0; i < 26; i++) {
    const x = rng() * n;
    const w = 1 + rng() * (n * 0.012);
    tint(p, 0.24, 0.22, 0.20, 0.04 + rng() * 0.08, x, rng() * n, w, n * (0.2 + rng() * 0.6));
  }
}

/* --- wood plank ------------------------------------------------------------ */
//
// Six boards to a 2.6 m repeat (≈ 430 mm). Boards run along U. The gaps carry
// both height and AO, because a deck read from above is nothing but its gaps.

function paintWoodPlank(p: Paint): void {
  const n = p.n;
  const rng = p.rng;
  const PLANKS = 6;
  const ph = n / PLANKS;

  style(p, 0.30, 0.21, 0.13, 0.94, 0, 0.35, 0.22);
  fill(p, 0, 0, n, n);

  for (let i = 0; i < PLANKS; i++) {
    const y = i * ph;
    // Per-plank tone shift. Boards come off different parts of the log and one
    // uniform brown is the fastest way to make timber look like cardboard.
    const warm = 0.86 + rng() * 0.30;
    const base = [0.54 * warm, 0.38 * warm, 0.23 * warm];
    style(p, base[0], base[1], base[2], 0.76 + rng() * 0.10, 0, 1, 0.62 + rng() * 0.06);
    fill(p, 0, y + Math.max(1, ph * 0.035), n, ph - Math.max(2, ph * 0.07));

    const y0 = y + ph * 0.035;
    const y1 = y + ph * 0.965;

    // Grain: long wandering streaks along the board, in albedo and height. The
    // sinusoidal warp is what makes it read as sawn timber and not as stripes.
    const lines = 26 + ((rng() * 18) | 0);
    for (let k = 0; k < lines; k++) {
      const gy = y0 + rng() * (y1 - y0);
      const amp = ph * (0.02 + rng() * 0.06);
      const freq = (1 + Math.floor(rng() * 3)) * Math.PI * 2;
      const phase = rng() * Math.PI * 2;
      const dark = rng() < 0.62;
      const w = Math.max(1, n / (300 + rng() * 500));
      p.a.save();
      p.h.save();
      p.a.globalAlpha = 0.10 + rng() * 0.22;
      p.h.globalAlpha = 0.28;
      p.a.strokeStyle = dark ? "rgb(66,42,24)" : "rgb(214,178,132)";
      p.h.strokeStyle = dark ? "rgb(110,110,110)" : "rgb(176,176,176)";
      p.a.lineWidth = w;
      p.h.lineWidth = w * 1.3;
      p.a.beginPath();
      p.h.beginPath();
      for (let x = 0; x <= n; x += Math.max(2, n / 128)) {
        const yy = gy + Math.sin((x / n) * freq + phase) * amp;
        if (x === 0) {
          p.a.moveTo(x, yy);
          p.h.moveTo(x, yy);
        } else {
          p.a.lineTo(x, yy);
          p.h.lineTo(x, yy);
        }
      }
      p.a.stroke();
      p.h.stroke();
      p.a.restore();
      p.h.restore();
    }

    // Knots: concentric rings, dark core, and a resin halo the grain flows past.
    const knots = rng() < 0.75 ? 1 + ((rng() * 2) | 0) : 0;
    for (let k = 0; k < knots; k++) {
      const kx = rng() * n;
      const ky = y0 + ph * (0.2 + rng() * 0.6);
      const kr = ph * (0.12 + rng() * 0.18);
      for (let ring = 6; ring >= 1; ring--) {
        const t = ring / 6;
        blob(p.a, n, css(lerp(0.16, 0.44, 1 - t), lerp(0.09, 0.28, 1 - t), lerp(0.05, 0.16, 1 - t)), 0.55, kx, ky, kr * t, kr * t * 0.62, 0.3);
      }
      blob(p.h, n, grey(0.40), 0.8, kx, ky, kr * 0.7, kr * 0.45, 0.3);
      blob(p.o, n, grey(0.55), 0.75, kx, ky, kr * 0.75, kr * 0.5, 0.3);
      blob(p.r, n, grey(0.58), 0.6, kx, ky, kr * 0.5, kr * 0.32, 0.3);
    }

    // Butt joint: one board in three is short and joins somewhere along U.
    if (rng() < 0.34) {
      const jx = rng() * n;
      const jw = Math.max(1.5, n * 0.006);
      style(p, 0.26, 0.18, 0.11, 0.95, 0, 0.40, 0.30);
      fill(p, jx, y0, jw, y1 - y0);
    }

    // Nail heads. Two per board end, slightly proud, rust-haloed.
    for (const nx of [n * 0.06, n * 0.30, n * 0.56, n * 0.82]) {
      const ny = y0 + (y1 - y0) * (rng() < 0.5 ? 0.22 : 0.78);
      const r = Math.max(1.2, n * 0.0055);
      blob(p.a, n, "rgb(96,88,80)", 0.9, nx, ny, r, r, 0);
      blob(p.m, n, grey(0.85), 0.9, nx, ny, r, r, 0);
      blob(p.r, n, grey(0.46), 0.9, nx, ny, r, r, 0);
      blob(p.h, n, grey(0.70), 0.85, nx, ny, r * 0.8, r * 0.8, 0);
      blob(p.o, n, grey(0.62), 0.55, nx, ny, r * 2.0, r * 2.0, 0);
      blob(p.a, n, "rgb(120,66,30)", 0.20, nx, ny, r * 2.4, r * 2.4, 0);
    }

    // The gap itself: dark, deep, occluded.
    occlude(p, 0.22, 0.95, 0, y, n, Math.max(1.5, ph * 0.05));
    occlude(p, 0.30, 0.8, 0, y + ph - Math.max(1.5, ph * 0.05), n, Math.max(1.5, ph * 0.05));
  }

  // Traffic wear: burnished lanes where feet go, plus splits and dents.
  for (let i = 0; i < 16; i++) {
    const y = rng() * n;
    const h = n * (0.02 + rng() * 0.05);
    polish(p, 0.54, 0.45, 0, y, n, h);
    tint(p, 0.72, 0.58, 0.40, 0.10, 0, y, n, h);
  }
  for (let i = 0; i < 24; i++) {
    const path = crackPath(rng() * n, rng() * n, 5, n * 0.05, rng);
    strokePath(p.h, n, "rgb(80,80,80)", 0.5, Math.max(1, n / 700), path);
    strokePath(p.a, n, "rgb(44,30,18)", 0.35, Math.max(1, n / 900), path);
  }
}

/* --- milled log ------------------------------------------------------------ */
//
// Debarked pole: the harvestable timber, gate posts, jetty piles. Longitudinal
// fibre, drying checks that open along the grain, and saw kerf at the ends.

function paintWoodLog(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 0.70, 0.55, 0.35, 0.84, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Fibre bundles running along U, at three scales.
  for (let i = 0; i < 260; i++) {
    const y = rng() * n;
    const h = Math.max(1, n * (0.002 + rng() * 0.012));
    const dark = rng() < 0.55;
    tint(p, dark ? 0.46 : 0.86, dark ? 0.33 : 0.72, dark ? 0.19 : 0.52, 0.10 + rng() * 0.24, 0, y, n, h);
    bump(p, dark ? 0.42 : 0.60, 0.35, 0, y, n, h);
  }
  // Drying checks: deep splits that follow the fibre.
  for (let i = 0; i < 16; i++) {
    const y = rng() * n;
    const w = n * (0.15 + rng() * 0.6);
    const x = rng() * n;
    const h = Math.max(1.5, n * 0.008);
    style(p, 0.24, 0.16, 0.09, 0.96, 0, 0.36, 0.24);
    fill(p, x, y, w, h);
    occlude(p, 0.42, 0.8, x, y - h, w, h * 3);
  }
  // Saw kerf: shallow arcs where the blade left the cut.
  for (let i = 0; i < 40; i++) {
    const cx = rng() * n;
    const cy = rng() * n;
    const r = n * (0.1 + rng() * 0.5);
    p.h.save();
    p.h.globalAlpha = 0.18;
    p.h.strokeStyle = "rgb(160,160,160)";
    p.h.lineWidth = Math.max(1, n / 500);
    p.h.beginPath();
    for (const ox of [-n, 0, n]) {
      for (const oy of [-n, 0, n]) {
        p.h.moveTo(cx + ox + r, cy + oy);
        p.h.arc(cx + ox, cy + oy, r, 0, Math.PI * 2);
      }
    }
    p.h.stroke();
    p.h.restore();
  }
  // Sapwood/heartwood banding and a little bark cling at the edges.
  for (let i = 0; i < 26; i++) {
    const s = n * (0.05 + rng() * 0.2);
    blob(p.a, n, rng() < 0.5 ? "rgb(150,110,68)" : "rgb(206,176,132)", 0.10 + rng() * 0.14, rng() * n, rng() * n, s, s * (0.2 + rng() * 0.4), rng() * 0.4);
  }
  for (let i = 0; i < 900; i++) {
    const s = 1 + rng() * (n / 300);
    blob(p.h, n, grey(0.5 + (rng() - 0.5) * 0.3), 0.4, rng() * n, rng() * n, s, s * 0.6, 0);
  }
}

/* --- concrete -------------------------------------------------------------- */
//
// Board-formed in-situ concrete: the industrial POIs, retaining walls, bunker
// bases. The board lines and the tie holes are the whole identity of the
// surface, and both live mostly in the height map.

function paintConcrete(p: Paint): void {
  const n = p.n;
  const rng = p.rng;
  const BOARDS = 8;
  const bh = n / BOARDS;

  style(p, 0.68, 0.665, 0.635, 0.90, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Pour mottle: slow patches of different water content.
  for (let i = 0; i < 70; i++) {
    const s = n * (0.08 + rng() * 0.3);
    const light = rng() < 0.5;
    blob(p.a, n, light ? "rgb(196,193,185)" : "rgb(140,138,132)", 0.05 + rng() * 0.10, rng() * n, rng() * n, s, s * (0.4 + rng() * 0.7), rng() * Math.PI);
    blob(p.r, n, grey(light ? 0.94 : 0.84), 0.30, rng() * n, rng() * n, s, s * 0.6, 0);
  }

  for (let i = 0; i < BOARDS; i++) {
    const y = i * bh;
    // Each board of the formwork prints its own slight offset and grain.
    const v = 0.96 + (rng() - 0.5) * 0.10;
    tint(p, 0.68 * v, 0.665 * v, 0.635 * v, 0.55, 0, y, n, bh);
    bump(p, 0.5 + (rng() - 0.5) * 0.12, 0.6, 0, y, n, bh);
    // The joint between boards: a hard line, a lip and a shadow.
    const jw = Math.max(1.5, n * 0.005);
    style(p, 0.50, 0.49, 0.47, 0.95, 0, 0.55, 0.30);
    fill(p, 0, y, n, jw);
    tint(p, 0.86, 0.85, 0.82, 0.35, 0, y + jw, n, jw * 0.9);
    occlude(p, 0.55, 0.85, 0, y, n, jw * 2.4);
    // Timber grain printed into the concrete — the reason to form with boards.
    for (let k = 0; k < 10; k++) {
      const gy = y + rng() * bh;
      bump(p, 0.5 + (rng() - 0.5) * 0.18, 0.25, 0, gy, n, Math.max(1, n * 0.002));
    }
  }

  // Formwork tie holes, on a real grid — this is the detail that dates the
  // construction method and no procedural concrete ever has it.
  const tieCols = 4;
  const tieRows = 4;
  for (let r = 0; r < tieRows; r++) {
    for (let c = 0; c < tieCols; c++) {
      const x = (c + 0.5) * (n / tieCols) + (rng() - 0.5) * n * 0.01;
      const y = (r + 0.5) * (n / tieRows) + (rng() - 0.5) * n * 0.01;
      const rr = Math.max(2, n * 0.012);
      blob(p.h, n, grey(0.30), 0.95, x, y, rr, rr, 0);
      blob(p.a, n, "rgb(110,106,100)", 0.85, x, y, rr, rr, 0);
      blob(p.o, n, grey(0.36), 0.9, x, y, rr * 1.5, rr * 1.5, 0);
      blob(p.r, n, grey(0.95), 0.7, x, y, rr, rr, 0);
      // A rust weep running down from each one.
      tint(p, 0.44, 0.26, 0.13, 0.16, x - rr * 0.6, y, rr * 1.2, n * (0.05 + rng() * 0.2));
    }
  }

  // Air voids: thousands of pinholes. Cheap, and instantly reads as concrete.
  for (let i = 0; i < Math.round(n * 3.2); i++) {
    const s = 0.8 + rng() * (n / 420);
    const x = rng() * n;
    const y = rng() * n;
    blob(p.h, n, grey(0.40), 0.6, x, y, s, s, 0);
    blob(p.a, n, "rgb(120,118,112)", 0.35, x, y, s, s, 0);
  }

  // Patch repairs, shrinkage cracks and the dirt line that collects on ledges.
  for (let i = 0; i < 4; i++) {
    const w = n * (0.12 + rng() * 0.28);
    const h = n * (0.08 + rng() * 0.2);
    const x = rng() * n;
    const y = rng() * n;
    style(p, 0.74, 0.73, 0.70, 0.86, 0, 0.95, 0.53);
    fill(p, x, y, w, h);
    occlude(p, 0.72, 0.6, x, y, w, Math.max(1, n * 0.003));
  }
  for (let i = 0; i < 20; i++) {
    const path = crackPath(rng() * n, rng() * n, 8, n * 0.05, rng);
    strokePath(p.a, n, "rgb(74,72,68)", 0.5, Math.max(1, n / 700), path);
    strokePath(p.h, n, "rgb(84,84,84)", 0.7, Math.max(1, n / 560), path);
    strokePath(p.o, n, "rgb(170,170,170)", 0.45, Math.max(1, n / 400), path);
  }
}

/* --- asphalt --------------------------------------------------------------- */

function paintAsphalt(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 0.185, 0.183, 0.185, 0.90, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Aggregate: two passes, coarse then fine, both in albedo and height. Asphalt
  // is a chip surface and reads wrong without visible stone.
  for (let i = 0; i < Math.round(n * 4); i++) {
    const s = 1 + rng() * (n / 150);
    const v = 0.22 + rng() * 0.24;
    const x = rng() * n;
    const y = rng() * n;
    blob(p.a, n, css(v, v * 0.98, v * 0.95), 0.20 + rng() * 0.35, x, y, s, s * (0.6 + rng() * 0.6), rng() * Math.PI);
    blob(p.h, n, grey(0.5 + rng() * 0.22), 0.4, x, y, s, s * 0.8, 0);
  }
  // Resurfacing patches with a seam around them.
  for (let i = 0; i < 5; i++) {
    const w = n * (0.14 + rng() * 0.36);
    const h = n * (0.12 + rng() * 0.3);
    const x = rng() * n;
    const y = rng() * n;
    style(p, 0.145, 0.145, 0.15, 0.86, 0, 0.96, 0.51);
    fill(p, x, y, w, h);
    style(p, 0.10, 0.10, 0.10, 0.92, 0, 0.6, 0.42);
    fill(p, x, y, w, Math.max(1.5, n * 0.004));
    fill(p, x, y + h, w, Math.max(1.5, n * 0.004));
  }
  // Alligator cracking and the odd pothole edge.
  for (let i = 0; i < 26; i++) {
    const path = crackPath(rng() * n, rng() * n, 6, n * 0.07, rng);
    strokePath(p.a, n, "rgb(16,16,17)", 0.75, Math.max(1, n / 400), path);
    strokePath(p.h, n, "rgb(60,60,60)", 0.80, Math.max(1, n / 340), path);
    strokePath(p.o, n, "rgb(150,150,150)", 0.50, Math.max(1, n / 260), path);
  }
  // Wheel paths: burnished, darker, glossier. The only strongly directional
  // feature, and the thing that tells the eye this is a road and not a car park.
  for (const t of [0.24, 0.76]) {
    const y = n * t;
    const h = n * 0.10;
    tint(p, 0.10, 0.10, 0.11, 0.30, 0, y - h * 0.5, n, h);
    polish(p, 0.56, 0.55, 0, y - h * 0.5, n, h);
  }
  // Oil and tyre rubber.
  for (let i = 0; i < 14; i++) {
    const s = n * (0.02 + rng() * 0.08);
    const x = rng() * n;
    const y = rng() * n;
    blob(p.a, n, "rgb(14,13,16)", 0.35, x, y, s, s * 0.7, rng() * Math.PI);
    blob(p.r, n, grey(0.32), 0.5, x, y, s * 0.8, s * 0.55, 0);
  }
}

/* --- painted steel panel --------------------------------------------------- */
//
// Container walls, silo cladding, shutter doors, vehicle bodies. Painted near
// white so a POI can pick its colour; the bare metal that shows through the
// scratches is absolute, which is exactly the read you want — a red container
// still scratches to silver.

function paintMetalPanel(p: Paint): void {
  const n = p.n;
  const rng = p.rng;
  const PANELS = 4;
  const pw = n / PANELS;

  style(p, 0.87, 0.87, 0.875, 0.42, 0.05, 1, 0.55);
  fill(p, 0, 0, n, n);

  // Orange peel. A perfectly smooth painted panel is the plastic look in its
  // purest form; the roll of the highlight across this is what fixes it.
  for (let i = 0; i < 900; i++) {
    const s = n * (0.008 + rng() * 0.045);
    blob(p.h, n, grey(0.55 + (rng() - 0.5) * 0.14), 0.35, rng() * n, rng() * n, s, s * (0.6 + rng() * 0.6), 0);
  }
  // Panel-to-panel value drift — sheets are painted in different batches.
  for (let i = 0; i < PANELS; i++) {
    const v = 0.97 + (rng() - 0.5) * 0.07;
    tint(p, v, v, v, 0.6, i * pw, 0, pw, n);
  }

  // Ribs: the corrugation stiffener every container panel has.
  const ribs = 3;
  for (let i = 0; i < PANELS; i++) {
    for (let k = 1; k <= ribs; k++) {
      const x = i * pw + (pw * k) / (ribs + 1);
      const w = Math.max(2, pw * 0.10);
      bump(p, 0.74, 0.9, x - w * 0.5, 0, w, n);
      bump(p, 0.44, 0.7, x - w * 0.9, 0, w * 0.4, n);
      bump(p, 0.44, 0.7, x + w * 0.5, 0, w * 0.4, n);
      tint(p, 1.0, 1.0, 1.0, 0.10, x - w * 0.3, 0, w * 0.35, n);
      occlude(p, 0.70, 0.6, x - w * 0.9, 0, w * 0.4, n);
      occlude(p, 0.70, 0.6, x + w * 0.5, 0, w * 0.4, n);
    }
    // Vertical seam between sheets, with a weld bead.
    const sx = i * pw;
    style(p, 0.72, 0.72, 0.73, 0.55, 0.25, 0.55, 0.40);
    fill(p, sx, 0, Math.max(1.5, n * 0.005), n);
    occlude(p, 0.55, 0.9, sx - n * 0.004, 0, n * 0.013, n);
    for (let k = 0; k < 60; k++) {
      const y = rng() * n;
      blob(p.h, n, grey(0.62), 0.5, sx + n * 0.0025, y, n * 0.004, n * 0.006, 0);
    }
  }

  // Horizontal rails top and bottom, with rivets.
  for (const t of [0.06, 0.5, 0.94]) {
    const y = n * t;
    const h = Math.max(3, n * 0.030);
    style(p, 0.84, 0.84, 0.845, 0.46, 0.08, 1, 0.66);
    fill(p, 0, y - h * 0.5, n, h);
    occlude(p, 0.62, 0.8, 0, y + h * 0.5, n, Math.max(1.5, n * 0.008));
    const step = n / 16;
    for (let x = step * 0.5; x < n; x += step) {
      const r = Math.max(1.4, n * 0.006);
      blob(p.h, n, grey(0.86), 0.95, x, y, r, r, 0);
      blob(p.a, n, "rgb(196,196,198)", 0.5, x, y, r, r, 0);
      blob(p.r, n, grey(0.36), 0.7, x, y, r * 0.7, r * 0.7, 0);
      blob(p.o, n, grey(0.68), 0.6, x, y, r * 2.1, r * 2.1, 0);
    }
  }

  // Scratches and chips down to bare steel: metalness 1, roughness low, and a
  // rust bloom where the primer has gone too.
  for (let i = 0; i < 130; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const len = n * (0.01 + rng() * 0.16);
    const w = Math.max(1, n / 900);
    const ang = rng() * Math.PI;
    p.a.save();
    p.m.save();
    p.r.save();
    p.a.globalAlpha = 0.35 + rng() * 0.4;
    p.m.globalAlpha = 0.8;
    p.r.globalAlpha = 0.8;
    p.a.strokeStyle = "rgb(168,170,174)";
    p.m.strokeStyle = grey(0.95);
    p.r.strokeStyle = grey(0.28);
    p.a.lineWidth = p.m.lineWidth = p.r.lineWidth = w;
    for (const g of [p.a, p.m, p.r]) {
      g.beginPath();
      // Wrapped: a scratch clipped at the tile edge becomes a repeating line of
      // dashes across the whole wall once the material tiles.
      for (const ox of [-n, 0, n]) {
        for (const oy of [-n, 0, n]) {
          g.moveTo(x + ox, y + oy);
          g.lineTo(x + ox + Math.cos(ang) * len, y + oy + Math.sin(ang) * len);
        }
      }
      g.stroke();
    }
    p.a.restore();
    p.m.restore();
    p.r.restore();
  }
  for (let i = 0; i < 40; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.004 + rng() * 0.02);
    blob(p.a, n, "rgb(122,66,30)", 0.3 + rng() * 0.4, x, y, s, s * (0.6 + rng() * 0.8), rng() * Math.PI);
    blob(p.r, n, grey(0.96), 0.8, x, y, s, s * 0.8, 0);
    blob(p.m, n, grey(0.04), 0.8, x, y, s, s * 0.8, 0);
    // The streak that runs down from the chip.
    tint(p, 0.42, 0.24, 0.11, 0.10 + rng() * 0.10, x - s * 0.5, y, s, n * (0.02 + rng() * 0.12));
  }
  // Grime settling on the horizontal ledges.
  for (let i = 0; i < 30; i++) {
    tint(p, 0.36, 0.34, 0.30, 0.05 + rng() * 0.08, 0, rng() * n, n, n * (0.004 + rng() * 0.02));
  }
}

/* --- corrugated iron ------------------------------------------------------- */
//
// The signature roof and shed wall of the island. The rib profile is authored
// analytically so it is exactly periodic and exactly seamless, then everything
// interesting is layered on top of it: rain-polished crowns, grime in the
// troughs, and rust climbing out of the bottom edge.

function paintCorrugated(p: Paint): void {
  const n = p.n;
  const rng = p.rng;
  /** Ten ribs across a 3 m repeat ≈ 300 mm pitch, which is the real profile. */
  const RIBS = 10;
  const period = n / RIBS;

  for (let x = 0; x < n; x++) {
    const u = ((x % period) / period) * Math.PI * 2;
    const c = Math.cos(u);
    // 1 at the crown, 0 in the trough. Rain runs off the crowns and polishes
    // them; grit and moss sit in the troughs and kill the specular.
    const wear = 0.5 + c * 0.5;
    const v = 0.605 + wear * 0.155;
    style(p, v * 0.985, v, v * 1.02, 0.50 - wear * 0.18, 0.82 + wear * 0.16, 0.72 + wear * 0.28, 0.5 + c * 0.42);
    p.a.fillRect(x, 0, 1, n);
    p.r.fillRect(x, 0, 1, n);
    p.m.fillRect(x, 0, 1, n);
    p.o.fillRect(x, 0, 1, n);
    p.h.fillRect(x, 0, 1, n);
  }

  // Spangle: the crystalline pattern galvanising leaves. Faint, but it is the
  // difference between "zinc" and "grey paint".
  for (let i = 0; i < Math.round(n * 2.4); i++) {
    const s = n * (0.004 + rng() * 0.018);
    const x = rng() * n;
    const y = rng() * n;
    blob(p.a, n, rng() < 0.5 ? "rgb(214,218,222)" : "rgb(150,154,158)", 0.10 + rng() * 0.14, x, y, s, s * (0.5 + rng() * 0.8), rng() * Math.PI);
    blob(p.r, n, grey(0.34 + rng() * 0.3), 0.35, x, y, s, s * 0.7, 0);
  }

  // Fixing screws through the crowns, on three purlin lines.
  for (const t of [0.14, 0.5, 0.86]) {
    const y = n * t;
    for (let k = 0; k < RIBS; k += 2) {
      const x = (k + 0.5) * period;
      const r = Math.max(1.6, n * 0.008);
      blob(p.h, n, grey(0.90), 0.95, x, y, r * 1.5, r * 1.5, 0);
      blob(p.a, n, "rgb(150,152,150)", 0.85, x, y, r * 1.5, r * 1.5, 0);
      blob(p.a, n, "rgb(60,56,52)", 0.9, x, y, r * 0.55, r * 0.55, 0);
      blob(p.m, n, grey(0.95), 0.9, x, y, r * 1.5, r * 1.5, 0);
      blob(p.r, n, grey(0.38), 0.8, x, y, r * 1.5, r * 1.5, 0);
      blob(p.o, n, grey(0.58), 0.7, x, y, r * 2.6, r * 2.6, 0);
      // Rubber washer, and the rust ring that always forms under it.
      blob(p.a, n, "rgb(112,60,26)", 0.28, x, y, r * 2.4, r * 2.4, 0);
      tint(p, 0.44, 0.24, 0.10, 0.22, x - r, y, r * 2, n * (0.03 + rng() * 0.09));
    }
  }

  // Rust. Concentrated at the bottom edge (v small after the read-back flip is
  // the *bottom* of the sheet, which in canvas space is large y) and climbing
  // upward in streaks, because that is where the water stands.
  const rustLine = n * 0.52;
  for (let i = 0; i < 120; i++) {
    const x = rng() * n;
    const y0 = rustLine + rng() * (n - rustLine);
    const bias = (y0 - rustLine) / (n - rustLine);
    const w = n * (0.004 + rng() * 0.03);
    const h = n * (0.02 + rng() * 0.28) * (0.4 + bias);
    const a = (0.10 + rng() * 0.35) * (0.25 + bias);
    tint(p, 0.42 + rng() * 0.2, 0.21 + rng() * 0.1, 0.08, a, x, y0, w, h);
    polish(p, 0.94, a * 1.4, x, y0, w, h);
    metalize(p, 0.03, a * 1.3, x, y0, w, h);
    // Rust eats the sheet: pit the height a little where it is worst.
    if (bias > 0.55) bump(p, 0.44, a * 0.8, x, y0, w, h);
  }
  // A hard corroded band right at the bottom lip.
  for (let i = 0; i < 40; i++) {
    const x = rng() * n;
    const w = n * (0.02 + rng() * 0.12);
    tint(p, 0.38, 0.19, 0.07, 0.25 + rng() * 0.4, x, n * (0.92 + rng() * 0.07), w, n * 0.08);
    polish(p, 0.97, 0.8, x, n * 0.92, w, n * 0.08);
    metalize(p, 0.02, 0.85, x, n * 0.92, w, n * 0.08);
  }
  // Dents. Sheds get hit.
  for (let i = 0; i < 12; i++) {
    const s = n * (0.02 + rng() * 0.06);
    const x = rng() * n;
    const y = rng() * n;
    blob(p.h, n, grey(0.36), 0.35, x, y, s, s * 0.7, rng() * Math.PI);
    blob(p.o, n, grey(0.72), 0.4, x, y, s, s * 0.7, 0);
  }
}

/* --- barrel roof tile ------------------------------------------------------ */
//
// Six courses of pantile to a 2.6 m repeat. The one thing that makes a tiled
// roof read from 300 m is the shadow line where each course laps the one below
// — it is baked hard into the AO here, and repeated in the height so the normal
// map throws its own shadow when the sun is low.
//
// Painted near-neutral: `tinted()` is how every POI gets its roof identity.

function paintRoofTile(p: Paint): void {
  const n = p.n;
  const rng = p.rng;
  const ROWS = 6;
  const COLS = 7;
  const rh = n / ROWS;
  const tw = n / COLS;
  /** Fraction of each course hidden under the course above. */
  const LAP = 0.26;

  style(p, 0.62, 0.60, 0.575, 0.86, 0, 1, 0.4);
  fill(p, 0, 0, n, n);

  for (let r = 0; r < ROWS; r++) {
    const y = r * rh;
    // Courses stagger by half a tile, like real pantiling.
    const off = (r & 1) * tw * 0.5;
    for (let c = 0; c <= COLS; c++) {
      const x0 = c * tw + off;
      // Per-tile value + a whisper of hue jitter. Neutral enough that a tint
      // fully repaints it, varied enough that the roof never reads as one slab.
      const v = 0.90 + rng() * 0.22;
      const warm = (rng() - 0.5) * 0.05;
      const rough = 0.72 + rng() * 0.12;
      // Barrel profile across the tile, sampled per column.
      const step = Math.max(1, Math.round(tw / 48));
      for (let dx = 0; dx < tw; dx += step) {
        const t = dx / tw;
        const prof = Math.sin(t * Math.PI);
        const hgt = 0.30 + prof * 0.58;
        // Crowns take a rain polish; the flanks never dry the same way.
        const crown = Math.pow(prof, 2.2);
        const vv = v * (0.86 + prof * 0.20);
        style(
          p,
          vv * (1 + warm),
          vv * (0.985 - warm * 0.2),
          vv * (0.95 - warm),
          rough - crown * 0.24,
          0,
          0.70 + prof * 0.30,
          hgt,
        );
        fill(p, x0 + dx, y, step, rh);
      }
      // The valley between two tiles: dark, wet, occluded.
      occlude(p, 0.34, 0.9, x0 - Math.max(1, tw * 0.03), y, Math.max(2, tw * 0.06), rh);
      polish(p, 0.95, 0.8, x0 - Math.max(1, tw * 0.03), y, Math.max(2, tw * 0.06), rh);
      tint(p, 0.30, 0.30, 0.27, 0.30, x0 - Math.max(1, tw * 0.02), y, Math.max(1.5, tw * 0.04), rh);
    }

    // The lap. Hard AO gradient at the head of the course, plus a step down in
    // height so the normal map agrees with it.
    const lapH = rh * LAP;
    const bands = 10;
    for (let b = 0; b < bands; b++) {
      const t = b / bands;
      occlude(p, 0.20 + t * 0.66, 0.9, 0, y + (lapH * b) / bands, n, lapH / bands + 1);
    }
    bump(p, 0.26, 0.85, 0, y, n, lapH * 0.55);
    // The butt of the course above catches the light — a bright lip.
    tint(p, 1.0, 0.97, 0.92, 0.16, 0, y - Math.max(1.5, rh * 0.03), n, Math.max(1.5, rh * 0.03));
    bump(p, 0.94, 0.8, 0, y - Math.max(1.5, rh * 0.022), n, Math.max(1.5, rh * 0.022));
  }

  // Moss and lichen collect in the valleys and along the laps. Absolute colour
  // on purpose — a green roof still grows green moss.
  for (let i = 0; i < 70; i++) {
    const x = rng() * n;
    const y = Math.floor(rng() * ROWS) * rh + rh * (rng() * LAP * 1.6);
    const s = n * (0.004 + rng() * 0.024);
    blob(p.a, n, rng() < 0.6 ? "rgb(96,110,58)" : "rgb(150,156,120)", 0.22 + rng() * 0.35, x, y, s, s * (0.4 + rng() * 0.6), rng() * Math.PI);
    blob(p.r, n, grey(0.99), 0.85, x, y, s, s * 0.6, 0);
    blob(p.h, n, grey(0.60), 0.4, x, y, s, s * 0.6, 0);
  }
  // Chips off the exposed edges, and a general dusting of grit.
  for (let i = 0; i < 40; i++) {
    const s = n * (0.003 + rng() * 0.012);
    const x = rng() * n;
    const y = Math.floor(rng() * ROWS) * rh + rh * (0.9 + rng() * 0.1);
    blob(p.a, n, "rgb(196,186,172)", 0.5, x, y, s, s * 0.7, 0);
    blob(p.h, n, grey(0.44), 0.7, x, y, s, s * 0.7, 0);
  }
  for (let i = 0; i < Math.round(n * 1.6); i++) {
    const s = 1 + rng() * (n / 400);
    blob(p.a, n, rng() < 0.5 ? "rgb(210,204,194)" : "rgb(112,106,98)", 0.10 + rng() * 0.16, rng() * n, rng() * n, s, s, 0);
  }
}

/* --- asphalt shingle ------------------------------------------------------- */
//
// The suburban roof. Staggered tabs, granule speckle, and the butt shadow that
// makes the rows legible from the air — which is where they will be seen from,
// since players arrive by parachute.

function paintRoofShingle(p: Paint): void {
  const n = p.n;
  const rng = p.rng;
  const ROWS = 8;
  const TABS = 5;
  const rh = n / ROWS;
  const tw = n / TABS;

  style(p, 0.56, 0.55, 0.53, 0.95, 0, 1, 0.45);
  fill(p, 0, 0, n, n);

  for (let r = 0; r < ROWS; r++) {
    const y = r * rh;
    const off = (r % 2) * tw * 0.5 + (rng() - 0.5) * tw * 0.06;
    for (let c = 0; c <= TABS; c++) {
      const x = c * tw + off;
      // Per-tab tone: shingles are blended from several granule colours and
      // sorting is deliberately imperfect.
      const v = 0.88 + rng() * 0.28;
      style(p, 0.56 * v, 0.552 * v, 0.535 * v, 0.93 + rng() * 0.06, 0, 1, 0.55 + rng() * 0.08);
      fill(p, x + 1, y + rh * 0.06, tw - 2, rh * 0.94);
      // The keyway slot between tabs.
      style(p, 0.26, 0.255, 0.25, 0.98, 0, 0.42, 0.26);
      fill(p, x - Math.max(1, tw * 0.012), y + rh * 0.45, Math.max(2, tw * 0.024), rh * 0.55);
      // A curled corner on one tab in six — the thing that says "old roof".
      if (rng() < 0.16) {
        bump(p, 0.78, 0.6, x + 2, y + rh * 0.72, tw * 0.4, rh * 0.26);
        occlude(p, 0.66, 0.5, x + 2, y + rh * 0.94, tw * 0.4, rh * 0.10);
      }
    }
    // Butt shadow: the course above overhangs, and this is its shadow.
    const lap = rh * 0.16;
    for (let b = 0; b < 8; b++) {
      const t = b / 8;
      occlude(p, 0.26 + t * 0.62, 0.92, 0, y + (lap * b) / 8, n, lap / 8 + 1);
    }
    bump(p, 0.32, 0.8, 0, y, n, lap * 0.6);
    tint(p, 0.86, 0.85, 0.83, 0.14, 0, y - Math.max(1, rh * 0.02), n, Math.max(1, rh * 0.02));
  }

  // Granules. Dense, three-toned, and folded into the height so the surface
  // never goes glassy at grazing angles.
  for (let i = 0; i < Math.round(n * 9); i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = 0.7 + rng() * (n / 300);
    const k = rng();
    const col = k < 0.42 ? "rgb(96,94,90)" : k < 0.78 ? "rgb(154,150,142)" : "rgb(58,60,56)";
    blob(p.a, n, col, 0.18 + rng() * 0.3, x, y, s, s, 0);
    if (rng() < 0.35) blob(p.h, n, grey(0.5 + (rng() - 0.5) * 0.3), 0.5, x, y, s, s, 0);
  }
  // Algae streaking — the black stain that runs down every real asphalt roof.
  for (let i = 0; i < 20; i++) {
    const x = rng() * n;
    tint(p, 0.20, 0.22, 0.20, 0.05 + rng() * 0.10, x, rng() * n, n * (0.01 + rng() * 0.05), n * (0.2 + rng() * 0.6));
  }
}

/* --- glass ----------------------------------------------------------------- */

function paintGlass(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 0.88, 0.94, 0.95, 0.045, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Float glass is never flat. A very low-amplitude waviness makes the
  // reflected horizon ripple as you strafe, which is most of what sells glass.
  for (let i = 0; i < 160; i++) {
    const s = n * (0.08 + rng() * 0.35);
    blob(p.h, n, grey(0.5 + (rng() - 0.5) * 0.16), 0.28, rng() * n, rng() * n, s, s * (0.3 + rng() * 0.7), rng() * Math.PI);
  }
  // Smears, rain spotting and dust. Roughness only — the tint stays neutral.
  for (let i = 0; i < 90; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.01 + rng() * 0.09);
    blob(p.r, n, grey(0.10 + rng() * 0.22), 0.30 + rng() * 0.3, x, y, s, s * (0.3 + rng() * 0.8), rng() * Math.PI);
    if (rng() < 0.4) blob(p.a, n, "rgb(236,240,240)", 0.06, x, y, s, s * 0.6, 0);
  }
  for (let i = 0; i < Math.round(n * 1.2); i++) {
    const s = 0.8 + rng() * (n / 320);
    const x = rng() * n;
    const y = rng() * n;
    blob(p.r, n, grey(0.30 + rng() * 0.4), 0.5, x, y, s, s, 0);
    blob(p.h, n, grey(0.56), 0.4, x, y, s, s, 0);
  }
  // Grime creeping in from the frame edges.
  for (const e of [0, 1]) {
    for (let i = 0; i < 30; i++) {
      const x = rng() * n;
      const w = n * (0.01 + rng() * 0.06);
      const h = n * (0.02 + rng() * 0.10);
      const y = e === 0 ? rng() * n * 0.06 : n * (0.94 - rng() * 0.06);
      blob(p.r, n, grey(0.34), 0.4, x, y, w, h, 0);
      blob(p.a, n, "rgb(190,196,192)", 0.10, x, y, w, h, 0);
    }
  }
  // A couple of star cracks, because someone always shoots the windows.
  for (let i = 0; i < 3; i++) {
    const x = rng() * n;
    const y = rng() * n;
    for (let k = 0; k < 7; k++) {
      const path = crackPath(x, y, 4, n * 0.03, rng);
      strokePath(p.h, n, "rgb(90,90,90)", 0.5, Math.max(1, n / 800), path);
      strokePath(p.r, n, "rgb(220,220,220)", 0.5, Math.max(1, n / 800), path);
    }
  }
}

/* --- rock ------------------------------------------------------------------ */

function paintRock(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 0.50, 0.485, 0.455, 0.88, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Facets. Rock breaks along planes; a rock texture with no planar structure
  // reads as porridge no matter how good the speckle is.
  for (let i = 0; i < 42; i++) {
    const cx = rng() * n;
    const cy = rng() * n;
    const r = n * (0.06 + rng() * 0.22);
    const sides = 4 + ((rng() * 4) | 0);
    const pts: number[][] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2 + rng() * 0.5;
      const rr = r * (0.6 + rng() * 0.7);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    const v = 0.86 + rng() * 0.3;
    const hv = 0.5 + (rng() - 0.5) * 0.34;
    // Hoisted out of the wrap loop on purpose: draw the same facet nine times
    // with nine different roughness values and the tile stops being seamless.
    const rv = 0.84 + rng() * 0.12;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (const g of [p.a, p.h, p.r]) {
          g.save();
          g.globalAlpha = g === p.a ? 0.5 : 0.55;
          g.fillStyle = g === p.a ? css(0.50 * v, 0.485 * v, 0.455 * v) : g === p.h ? grey(hv) : grey(rv);
          g.beginPath();
          g.moveTo(pts[0][0] + ox * n, pts[0][1] + oy * n);
          for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0] + ox * n, pts[k][1] + oy * n);
          g.closePath();
          g.fill();
          g.restore();
        }
      }
    }
  }

  // Mineral speckle: quartz, feldspar, biotite. Three populations, not one.
  for (let i = 0; i < Math.round(n * 7); i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = 0.8 + rng() * (n / 200);
    const k = rng();
    const col = k < 0.4 ? "rgb(226,222,214)" : k < 0.72 ? "rgb(178,150,140)" : "rgb(42,40,40)";
    blob(p.a, n, col, 0.15 + rng() * 0.4, x, y, s, s * (0.6 + rng() * 0.7), rng() * Math.PI);
    if (k < 0.4) blob(p.r, n, grey(0.62 + rng() * 0.2), 0.5, x, y, s, s, 0);
    blob(p.h, n, grey(0.5 + (rng() - 0.5) * 0.28), 0.35, x, y, s, s, 0);
  }

  // Joints and fractures, deep and occluded.
  for (let i = 0; i < 30; i++) {
    const path = crackPath(rng() * n, rng() * n, 9, n * 0.055, rng);
    strokePath(p.a, n, "rgb(38,36,34)", 0.55, Math.max(1, n / 420), path);
    strokePath(p.h, n, "rgb(52,52,52)", 0.80, Math.max(1, n / 300), path);
    strokePath(p.o, n, "rgb(120,120,120)", 0.70, Math.max(1, n / 220), path);
  }

  // Lichen. Pale, chalky, matte, and it always grows in irregular rosettes.
  for (let i = 0; i < 34; i++) {
    const cx = rng() * n;
    const cy = rng() * n;
    const r = n * (0.02 + rng() * 0.07);
    const pale = rng() < 0.5;
    for (let k = 0; k < 14; k++) {
      const a = rng() * Math.PI * 2;
      const d = rng() * r;
      const s = r * (0.18 + rng() * 0.4);
      blob(p.a, n, pale ? "rgb(178,184,158)" : "rgb(126,146,96)", 0.16 + rng() * 0.24, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s, s * (0.6 + rng() * 0.5), rng() * Math.PI);
      blob(p.r, n, grey(0.99), 0.6, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s, s * 0.8, 0);
      blob(p.h, n, grey(0.56), 0.3, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s, s * 0.8, 0);
    }
  }
  // Water staining down the faces.
  for (let i = 0; i < 22; i++) {
    tint(p, 0.30, 0.28, 0.25, 0.05 + rng() * 0.10, rng() * n, rng() * n, n * (0.005 + rng() * 0.03), n * (0.1 + rng() * 0.5));
  }
}

/* --- dirt ------------------------------------------------------------------ */

function paintDirt(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 0.34, 0.255, 0.165, 0.95, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Damp/dry patchwork. Damp earth is darker *and* markedly less rough, and
  // that pairing is what makes ground look like ground.
  for (let i = 0; i < 70; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.05 + rng() * 0.26);
    const damp = rng() < 0.45;
    blob(p.a, n, damp ? "rgb(60,44,28)" : "rgb(136,110,78)", 0.10 + rng() * 0.20, x, y, s, s * (0.5 + rng() * 0.7), rng() * Math.PI);
    blob(p.r, n, grey(damp ? 0.66 : 0.98), 0.35, x, y, s, s * 0.7, 0);
  }
  // Pebbles: proud, with their own roughness and a contact shadow.
  for (let i = 0; i < Math.round(n * 1.1); i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.004 + rng() * 0.020);
    const v = 0.42 + rng() * 0.32;
    blob(p.o, n, grey(0.55), 0.5, x + s * 0.3, y + s * 0.3, s * 1.5, s * 1.2, 0);
    blob(p.a, n, css(v, v * 0.96, v * 0.90), 0.85, x, y, s, s * (0.6 + rng() * 0.5), rng() * Math.PI);
    blob(p.h, n, grey(0.68 + rng() * 0.2), 0.85, x, y, s * 0.9, s * 0.7, 0);
    blob(p.r, n, grey(0.72 + rng() * 0.2), 0.7, x, y, s, s * 0.8, 0);
  }
  // Grit and organic litter.
  for (let i = 0; i < Math.round(n * 5); i++) {
    const s = 0.7 + rng() * (n / 340);
    const k = rng();
    blob(p.a, n, k < 0.4 ? "rgb(28,20,12)" : k < 0.75 ? "rgb(120,98,66)" : "rgb(72,66,34)", 0.2 + rng() * 0.35, rng() * n, rng() * n, s, s, 0);
  }
  // Roots and twigs breaking the surface.
  for (let i = 0; i < 26; i++) {
    // Roots sit *proud* of the soil, so the height stroke is bright here where
    // a crack's would be dark. Same path, opposite relief.
    const path = crackPath(rng() * n, rng() * n, 6, n * 0.05, rng);
    strokePath(p.a, n, "rgb(62,44,26)", 0.40, Math.max(1, n / 300), path);
    strokePath(p.h, n, "rgb(178,178,178)", 0.50, Math.max(1, n / 300), path);
    strokePath(p.o, n, "rgb(190,190,190)", 0.30, Math.max(1, n / 180), path);
  }
  // Tread and boot dimples.
  for (let i = 0; i < 90; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.006 + rng() * 0.022);
    blob(p.h, n, grey(0.38), 0.35, x, y, s, s * (0.5 + rng() * 0.6), rng() * Math.PI);
    blob(p.o, n, grey(0.70), 0.4, x, y, s, s * 0.7, 0);
  }
}

/* --- sand ------------------------------------------------------------------ */

function paintSand(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 0.855, 0.755, 0.565, 0.96, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Wind ripples: a sinusoid whose crest line is itself warped, so they curve
  // the way real ripples do instead of reading as corduroy.
  //
  // Drawn straight onto the canvases rather than through the wrapped helpers.
  // This is the one inner loop in the module dense enough for the save/restore
  // and the wrap allocation to dominate — at 512 px the helper version costs
  // more than every other painter in the file combined.
  const RIPPLES = 9;
  const bandH = n / RIPPLES;
  const slices = 12;
  const sliceH = bandH / slices;
  const step = Math.max(2, Math.round(n / 128));
  p.h.save();
  p.a.save();
  p.h.globalAlpha = 0.45;
  for (let x = 0; x < n; x += step) {
    const warp = Math.sin((x / n) * Math.PI * 4) * n * 0.03 + Math.sin((x / n) * Math.PI * 10 + 1.3) * n * 0.012;
    for (let k = 0; k < RIPPLES; k++) {
      const y = ((k + 0.5) * n) / RIPPLES + warp;
      for (let s = 0; s < slices; s++) {
        const t = (s + 0.5) / slices - 0.5;
        const prof = Math.cos(t * Math.PI);
        const yy = (((y + t * bandH) % n) + n) % n;
        p.h.fillStyle = grey(0.5 + prof * 0.30);
        p.h.fillRect(x, yy, step, sliceH + 1);
        // The wrapped copy: a slice that straddles the seam would otherwise
        // lose its lower half and put a hairline in the tile.
        p.h.fillRect(x, yy - n, step, sliceH + 1);
        // The lee side of a ripple traps the coarse dark grains; the windward
        // face is swept clean and pale.
        p.a.globalAlpha = t > 0 ? 0.06 : 0.05;
        p.a.fillStyle = t > 0 ? "rgb(184,158,115)" : "rgb(245,230,189)";
        p.a.fillRect(x, yy, step, sliceH + 1);
        p.a.fillRect(x, yy - n, step, sliceH + 1);
      }
    }
  }
  p.h.restore();
  p.a.restore();
  // Grain. Very fine, very dense — sand is the one surface where the texel
  // scale itself is the material.
  for (let i = 0; i < Math.round(n * 14); i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = 0.6 + rng() * (n / 460);
    const k = rng();
    blob(p.a, n, k < 0.35 ? "rgb(238,222,186)" : k < 0.72 ? "rgb(196,170,124)" : "rgb(128,104,74)", 0.10 + rng() * 0.26, x, y, s, s, 0);
    if (rng() < 0.25) blob(p.h, n, grey(0.5 + (rng() - 0.5) * 0.34), 0.4, x, y, s, s, 0);
  }
  // Shell fragments and coral chips: bright, hard, glossy against the matte.
  for (let i = 0; i < 70; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.003 + rng() * 0.012);
    blob(p.a, n, rng() < 0.6 ? "rgb(250,244,234)" : "rgb(246,206,196)", 0.7, x, y, s, s * (0.3 + rng() * 0.5), rng() * Math.PI);
    blob(p.r, n, grey(0.34 + rng() * 0.2), 0.8, x, y, s, s * 0.5, 0);
    blob(p.h, n, grey(0.66), 0.7, x, y, s, s * 0.5, 0);
    blob(p.o, n, grey(0.78), 0.4, x, y, s * 1.6, s * 1.1, 0);
  }
  // Damp patches near the waterline — darker, denser, much less rough.
  for (let i = 0; i < 16; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.05 + rng() * 0.2);
    blob(p.a, n, "rgb(150,126,90)", 0.16 + rng() * 0.14, x, y, s, s * (0.4 + rng() * 0.5), rng() * Math.PI);
    blob(p.r, n, grey(0.70), 0.4, x, y, s, s * 0.5, 0);
  }
}

/* --- grass ----------------------------------------------------------------- */
//
// The ground plane under the treeline. Not the blade cards — this is the mat
// the cards are planted in, and it has to hold up on its own when the grass
// LOD drops out at distance.

function paintGrass(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 0.175, 0.30, 0.105, 0.96, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Colour zoning first: lush hollows, sun-bleached crowns, bare scrapes.
  for (let i = 0; i < 60; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.06 + rng() * 0.26);
    const k = rng();
    const col = k < 0.4 ? "rgb(38,84,26)" : k < 0.75 ? "rgb(112,132,52)" : "rgb(84,66,38)";
    blob(p.a, n, col, 0.14 + rng() * 0.24, x, y, s, s * (0.5 + rng() * 0.7), rng() * Math.PI);
  }
  // Bare earth showing through — grass is never a continuous carpet.
  for (let i = 0; i < 26; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.015 + rng() * 0.06);
    blob(p.a, n, "rgb(84,64,40)", 0.35 + rng() * 0.3, x, y, s, s * (0.5 + rng() * 0.6), rng() * Math.PI);
    blob(p.h, n, grey(0.36), 0.5, x, y, s, s * 0.7, 0);
    blob(p.o, n, grey(0.66), 0.5, x, y, s, s * 0.7, 0);
  }

  // Blades. Short directional strokes, clustered, with a green range wide
  // enough to survive being lit from any angle.
  // Blades are stroked, and strokes are the most expensive canvas op in this
  // file — so the save/restore lives outside the loop and only the per-blade
  // style is touched inside it.
  const clusters = Math.round(n * 0.5);
  p.a.save();
  p.h.save();
  p.a.lineWidth = p.h.lineWidth = Math.max(1, n / 420);
  p.a.lineCap = p.h.lineCap = "round";
  p.h.globalAlpha = 0.35;
  for (let i = 0; i < clusters; i++) {
    const cx = rng() * n;
    const cy = rng() * n;
    const lean = rng() * Math.PI * 2;
    const count = 5 + ((rng() * 8) | 0);
    const tone = rng();
    for (let k = 0; k < count; k++) {
      const a = lean + (rng() - 0.5) * 1.1;
      const len = n * (0.006 + rng() * 0.022);
      // The ±n offsets keep a clump that lands on the seam whole.
      const bx = cx + (rng() - 0.5) * n * 0.012;
      const by = cy + (rng() - 0.5) * n * 0.012;
      const g = 0.26 + tone * 0.30 + rng() * 0.12;
      p.a.globalAlpha = 0.3 + rng() * 0.5;
      p.a.strokeStyle = css(g * 0.55, g, g * 0.30);
      p.h.strokeStyle = grey(0.5 + rng() * 0.28);
      const edge = bx < len || bx > n - len || by < len || by > n - len;
      for (const gg of [p.a, p.h]) {
        gg.beginPath();
        for (const ox of edge ? [-n, 0, n] : [0]) {
          for (const oy of edge ? [-n, 0, n] : [0]) {
            const x = bx + ox;
            const y = by + oy;
            gg.moveTo(x, y);
            gg.quadraticCurveTo(
              x + Math.cos(a) * len * 0.5,
              y + Math.sin(a) * len * 0.5 - len * 0.2,
              x + Math.cos(a) * len,
              y + Math.sin(a) * len,
            );
          }
        }
        gg.stroke();
      }
    }
    // Every clump shadows its own base.
    blob(p.o, n, grey(0.62), 0.35, cx, cy, n * 0.014, n * 0.012, 0);
  }
  p.a.restore();
  p.h.restore();
  // Dry thatch and the odd flower — small saturated dots that catch the eye.
  for (let i = 0; i < Math.round(n * 0.8); i++) {
    const s = 0.8 + rng() * (n / 400);
    blob(p.a, n, "rgb(160,148,86)", 0.2 + rng() * 0.3, rng() * n, rng() * n, s, s * 2.2, rng() * Math.PI);
  }
  for (let i = 0; i < 34; i++) {
    const s = Math.max(1, n * 0.004);
    const k = rng();
    blob(p.a, n, k < 0.5 ? "rgb(248,244,226)" : k < 0.8 ? "rgb(246,206,80)" : "rgb(216,150,214)", 0.75, rng() * n, rng() * n, s, s, 0);
  }
}

/* --- foliage (leaf cards) -------------------------------------------------- */
//
// The only cutout material. Painted onto a transparent albedo canvas: the
// alpha becomes the card's coverage, so the silhouette is authored here rather
// than being a square with a texture on it.

function paintFoliage(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  // Everything outside the leaves must be fully open in ORM and flat in height,
  // or the cut-away texels drag the normal map around at the silhouette.
  style(p, 0, 0, 0, 0.88, 0, 1, 0.5);
  p.o.fillRect(0, 0, n, n);
  p.r.fillRect(0, 0, n, n);
  p.m.fillRect(0, 0, n, n);
  p.h.fillRect(0, 0, n, n);

  // Twigs first, so the leaves sit on top of them.
  p.a.save();
  p.a.strokeStyle = "rgb(74,58,36)";
  p.a.lineWidth = Math.max(1.5, n * 0.008);
  p.a.lineCap = "round";
  for (let i = 0; i < 7; i++) {
    const y = n * (0.12 + rng() * 0.76);
    p.a.beginPath();
    p.a.moveTo(0, y);
    p.a.quadraticCurveTo(n * 0.5, y + (rng() - 0.5) * n * 0.2, n, y + (rng() - 0.5) * n * 0.1);
    p.a.stroke();
  }
  p.a.restore();

  const leaves = 44;
  for (let i = 0; i < leaves; i++) {
    const cx = rng() * n;
    const cy = rng() * n;
    const len = n * (0.10 + rng() * 0.16);
    const wid = len * (0.30 + rng() * 0.22);
    const ang = rng() * Math.PI * 2;
    // Canopy leaves are lighter and yellower at the tips, darker and bluer in
    // shade. Baking that variance in is what stops a tree reading as one flat
    // green blob from 200 m.
    const sun = rng();
    const g = 0.30 + sun * 0.34;
    const col = css(g * (0.42 + sun * 0.36), g, g * (0.22 + sun * 0.12));
    // Hoisted: every wrapped copy of this leaf must be byte-identical.
    const leafRough = grey(0.72 + rng() * 0.2);
    const leafHeight = grey(0.5 + (sun - 0.5) * 0.45);

    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const x = cx + ox * n;
        const y = cy + oy * n;
        if (x < -len * 2 || x > n + len * 2 || y < -len * 2 || y > n + len * 2) continue;
        p.a.save();
        p.a.translate(x, y);
        p.a.rotate(ang);
        p.a.fillStyle = col;
        p.a.beginPath();
        p.a.moveTo(0, 0);
        p.a.quadraticCurveTo(wid, len * 0.35, 0, len);
        p.a.quadraticCurveTo(-wid, len * 0.35, 0, 0);
        p.a.fill();
        // Midrib + a pale margin. Three strokes and the leaf stops being a blob.
        p.a.strokeStyle = css(g * 0.7, g * 1.25, g * 0.4);
        p.a.lineWidth = Math.max(1, n * 0.004);
        p.a.beginPath();
        p.a.moveTo(0, 0);
        p.a.lineTo(0, len);
        p.a.stroke();
        p.a.globalAlpha = 0.45;
        for (let v = 1; v <= 4; v++) {
          const t = v / 5;
          p.a.beginPath();
          p.a.moveTo(0, len * t);
          p.a.lineTo(wid * 0.6 * (1 - t), len * (t + 0.14));
          p.a.moveTo(0, len * t);
          p.a.lineTo(-wid * 0.6 * (1 - t), len * (t + 0.14));
          p.a.stroke();
        }
        p.a.restore();

        // The same shape into height/AO/roughness, so the leaves overlap with
        // real relief and the top of the card is not a flat sticker.
        for (const g2 of [p.h, p.o, p.r]) {
          g2.save();
          g2.translate(x, y);
          g2.rotate(ang);
          g2.globalAlpha = g2 === p.h ? 0.55 : 0.35;
          g2.fillStyle = g2 === p.h ? leafHeight : g2 === p.o ? grey(0.74) : leafRough;
          g2.beginPath();
          g2.moveTo(0, 0);
          g2.quadraticCurveTo(wid, len * 0.35, 0, len);
          g2.quadraticCurveTo(-wid, len * 0.35, 0, 0);
          g2.fill();
          g2.restore();
        }
      }
    }
  }
}

/* --- bark ------------------------------------------------------------------ */

function paintBark(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 0.30, 0.235, 0.175, 0.98, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Fissures. Vertical, wandering, deep — and the AO in them is doing most of
  // the work at any distance where the normal map has mipped away.
  const RIDGES = 14;
  for (let i = 0; i < RIDGES; i++) {
    const x0 = (i / RIDGES) * n + (rng() - 0.5) * (n / RIDGES) * 0.5;
    const w = (n / RIDGES) * (0.18 + rng() * 0.3);
    const steps = 22;
    // Pre-walk the fissure, then subtract a linear ramp so it arrives back at
    // its starting x. A trunk tiles vertically; a wander that does not close
    // puts a visible kink around the whole tree at every repeat.
    const xs: number[] = [x0];
    for (let s = 1; s <= steps; s++) xs.push(xs[s - 1] + (rng() - 0.5) * (n / RIDGES) * 0.45);
    const drift = xs[steps] - x0;
    for (let s = 0; s <= steps; s++) xs[s] -= (drift * s) / steps;
    p.a.save();
    p.h.save();
    p.o.save();
    p.a.strokeStyle = "rgb(28,20,14)";
    p.h.strokeStyle = "rgb(46,46,46)";
    p.o.strokeStyle = "rgb(96,96,96)";
    p.a.lineWidth = w;
    p.h.lineWidth = w * 0.8;
    p.o.lineWidth = w * 1.6;
    p.a.lineCap = p.h.lineCap = p.o.lineCap = "round";
    for (const ox of [-n, 0, n]) {
      p.a.beginPath();
      p.h.beginPath();
      p.o.beginPath();
      for (let s = 0; s <= steps; s++) {
        const y = (s / steps) * n;
        const x = xs[s] + ox;
        if (s === 0) {
          p.a.moveTo(x, y);
          p.h.moveTo(x, y);
          p.o.moveTo(x, y);
        } else {
          p.a.lineTo(x, y);
          p.h.lineTo(x, y);
          p.o.lineTo(x, y);
        }
      }
      p.a.stroke();
      p.h.stroke();
      p.o.stroke();
    }
    p.a.restore();
    p.h.restore();
    p.o.restore();
  }
  // Ridge crowns: lighter, drier, proud.
  for (let i = 0; i < 220; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.006 + rng() * 0.020);
    blob(p.a, n, rng() < 0.5 ? "rgb(120,100,76)" : "rgb(78,62,46)", 0.20 + rng() * 0.3, x, y, s, s * (1.6 + rng() * 2.4), 0);
    blob(p.h, n, grey(0.66 + rng() * 0.2), 0.4, x, y, s, s * 2.0, 0);
  }
  // Plate flaking — the scaly texture on older trunks.
  for (let i = 0; i < 150; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const s = n * (0.008 + rng() * 0.026);
    blob(p.h, n, grey(0.5 + (rng() - 0.5) * 0.4), 0.35, x, y, s, s * (0.5 + rng() * 0.9), rng() * 0.5);
    blob(p.o, n, grey(0.80), 0.3, x, y, s, s * 0.8, 0);
  }
  // Lenticels — the little horizontal scars. Nobody adds these and everybody
  // notices when a trunk has none.
  for (let i = 0; i < 90; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const w = n * (0.004 + rng() * 0.016);
    blob(p.a, n, "rgb(150,132,104)", 0.3 + rng() * 0.3, x, y, w, Math.max(1, n * 0.0015), 0);
  }
  // Moss, biased to one side of the trunk. Directional on purpose.
  for (let i = 0; i < 90; i++) {
    const x = (rng() * 0.42 + 0.04) * n;
    const y = rng() * n;
    const s = n * (0.006 + rng() * 0.026);
    blob(p.a, n, rng() < 0.6 ? "rgb(72,102,44)" : "rgb(120,140,86)", 0.16 + rng() * 0.3, x, y, s, s * (0.6 + rng() * 0.8), rng() * Math.PI);
    blob(p.r, n, grey(1.0), 0.6, x, y, s, s * 0.7, 0);
  }
}

/* --- fabric ---------------------------------------------------------------- */
//
// Awnings, tents, sandbags, banners. Near-white so `tinted()` owns the colour.
// The weave lives entirely in the height map: a canvas awning is only readable
// as canvas when the light rakes across the threads.

function paintFabric(p: Paint): void {
  const n = p.n;
  const rng = p.rng;
  const THREADS = 48;
  const t = n / THREADS;

  style(p, 0.90, 0.885, 0.855, 0.90, 0, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Plain weave: warp over weft, alternating. Drawn as short segments so the
  // over/under actually alternates rather than reading as a grid.
  for (let i = 0; i < THREADS; i++) {
    for (let j = 0; j < THREADS; j++) {
      const over = (i + j) & 1;
      const x = i * t;
      const y = j * t;
      bump(p, over ? 0.66 : 0.40, 0.85, x, y + t * 0.15, t, t * 0.7);
      bump(p, over ? 0.40 : 0.66, 0.55, x + t * 0.15, y, t * 0.7, t);
      if (!over) occlude(p, 0.82, 0.5, x, y, t, t);
    }
  }
  // Thread tone variance, so the weave is not a perfect machine print.
  for (let i = 0; i < THREADS; i++) {
    const v = 0.97 + (rng() - 0.5) * 0.06;
    tint(p, v, v, v * 0.995, 0.5, i * t, 0, t, n);
    const v2 = 0.97 + (rng() - 0.5) * 0.06;
    tint(p, v2, v2, v2 * 0.995, 0.35, 0, i * t, n, t);
  }
  // Seams: two lines of stitching with a rolled hem behind them.
  for (const y of [n * 0.24, n * 0.76]) {
    bump(p, 0.74, 0.9, 0, y - n * 0.012, n, n * 0.024);
    occlude(p, 0.72, 0.7, 0, y + n * 0.012, n, n * 0.012);
    tint(p, 0.84, 0.83, 0.80, 0.35, 0, y - n * 0.012, n, n * 0.024);
    const step = n * 0.022;
    for (let x = 0; x < n; x += step) {
      bump(p, 0.86, 0.9, x, y - n * 0.002, step * 0.55, Math.max(1, n * 0.005));
      tint(p, 0.70, 0.68, 0.64, 0.5, x, y - n * 0.002, step * 0.55, Math.max(1, n * 0.005));
    }
  }
  // Wear: creases, sun bleach, and dirt in the folds.
  for (let i = 0; i < 20; i++) {
    const path = crackPath(rng() * n, rng() * n, 5, n * 0.09, rng);
    strokePath(p.h, n, "rgb(96,96,96)", 0.40, Math.max(1.5, n / 260), path);
    strokePath(p.o, n, "rgb(180,180,180)", 0.35, Math.max(2, n / 180), path);
    strokePath(p.a, n, "rgb(198,192,180)", 0.25, Math.max(2, n / 200), path);
  }
  for (let i = 0; i < 30; i++) {
    const s = n * (0.03 + rng() * 0.12);
    blob(p.a, n, rng() < 0.6 ? "rgb(200,194,180)" : "rgb(246,244,238)", 0.08 + rng() * 0.12, rng() * n, rng() * n, s, s * (0.4 + rng() * 0.6), rng() * Math.PI);
  }
  for (let i = 0; i < 300; i++) {
    const s = 0.8 + rng() * (n / 400);
    blob(p.a, n, "rgb(140,132,116)", 0.10 + rng() * 0.2, rng() * n, rng() * n, s, s, 0);
  }
}

/* --- gold ------------------------------------------------------------------ */
//
// Legendary loot, trophies, the victory podium. Metal reads entirely off the
// environment probe, so this material is a roughness map with a colour on it —
// which is exactly why the probe is not optional.

function paintGold(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 1.0, 0.775, 0.34, 0.22, 1, 1, 0.5);
  fill(p, 0, 0, n, n);

  // Hammered dimples: a slow-rolling highlight is what makes gold look forged
  // rather than like a sphere with a yellow gradient.
  for (let i = 0; i < 260; i++) {
    const s = n * (0.02 + rng() * 0.07);
    blob(p.h, n, grey(0.5 + (rng() - 0.5) * 0.5), 0.35, rng() * n, rng() * n, s, s * (0.7 + rng() * 0.5), rng() * Math.PI);
  }
  // Concentric polishing swirls in roughness only.
  for (let i = 0; i < 60; i++) {
    const cx = rng() * n;
    const cy = rng() * n;
    p.r.save();
    p.r.globalAlpha = 0.14;
    p.r.strokeStyle = grey(0.12 + rng() * 0.22);
    p.r.lineWidth = Math.max(1, n / 300);
    for (let k = 0; k < 6; k++) {
      const r = n * (0.02 + k * 0.02 + rng() * 0.01);
      p.r.beginPath();
      for (const ox of [-n, 0, n]) {
        for (const oy of [-n, 0, n]) {
          // moveTo before each arc, or canvas joins the subpaths with a chord.
          p.r.moveTo(cx + ox + r, cy + oy);
          p.r.arc(cx + ox, cy + oy, r, 0, Math.PI * 2);
        }
      }
      p.r.stroke();
    }
    p.r.restore();
  }
  // Scratches, and tarnish in the recesses.
  for (let i = 0; i < 200; i++) {
    const x = rng() * n;
    const y = rng() * n;
    const len = n * (0.02 + rng() * 0.2);
    const ang = rng() * Math.PI;
    p.r.save();
    p.r.globalAlpha = 0.4;
    p.r.strokeStyle = grey(0.10 + rng() * 0.4);
    p.r.lineWidth = Math.max(1, n / 900);
    p.r.beginPath();
    for (const ox of [-n, 0, n]) {
      for (const oy of [-n, 0, n]) {
        p.r.moveTo(x + ox, y + oy);
        p.r.lineTo(x + ox + Math.cos(ang) * len, y + oy + Math.sin(ang) * len);
      }
    }
    p.r.stroke();
    p.r.restore();
  }
  for (let i = 0; i < 34; i++) {
    const s = n * (0.02 + rng() * 0.09);
    const x = rng() * n;
    const y = rng() * n;
    blob(p.a, n, "rgb(140,102,38)", 0.18 + rng() * 0.24, x, y, s, s * (0.5 + rng() * 0.6), rng() * Math.PI);
    blob(p.r, n, grey(0.58), 0.45, x, y, s, s * 0.7, 0);
    blob(p.o, n, grey(0.82), 0.4, x, y, s, s * 0.7, 0);
  }
}

/* --- rubber ---------------------------------------------------------------- */

function paintRubber(p: Paint): void {
  const n = p.n;
  const rng = p.rng;

  style(p, 0.085, 0.085, 0.092, 0.82, 0, 1, 0.62);
  fill(p, 0, 0, n, n);

  // Tread: a chevron block pattern, cut deep into the height with hard AO in
  // the grooves. This is the whole silhouette of the material.
  const BLOCKS = 6;
  const bw = n / BLOCKS;
  for (let i = 0; i < BLOCKS; i++) {
    for (let j = 0; j < 2; j++) {
      const x = i * bw + (j ? bw * 0.5 : 0);
      const y = j * n * 0.5;
      const skew = bw * 0.35;
      for (const ox of [-n, 0, n]) {
        for (const g of [p.h, p.o]) {
          g.save();
          g.fillStyle = g === p.h ? grey(0.20) : grey(0.30);
          g.globalAlpha = 0.95;
          g.beginPath();
          g.moveTo(x + ox, y);
          g.lineTo(x + ox + skew, y + n * 0.5);
          g.lineTo(x + ox + skew + bw * 0.22, y + n * 0.5);
          g.lineTo(x + ox + bw * 0.22, y);
          g.closePath();
          g.fill();
          g.restore();
        }
      }
    }
  }
  // Circumferential grooves.
  for (const t of [0.18, 0.5, 0.82]) {
    style(p, 0.05, 0.05, 0.055, 0.92, 0, 0.34, 0.20);
    fill(p, 0, n * t - n * 0.018, n, n * 0.036);
    occlude(p, 0.36, 0.85, 0, n * t - n * 0.026, n, n * 0.052);
  }
  // Pebbled micro-surface + the moulding flash line every tyre has.
  for (let i = 0; i < Math.round(n * 6); i++) {
    const s = 0.7 + rng() * (n / 280);
    const x = rng() * n;
    const y = rng() * n;
    blob(p.h, n, grey(0.5 + (rng() - 0.5) * 0.26), 0.4, x, y, s, s, 0);
    if (rng() < 0.3) blob(p.a, n, "rgb(38,38,42)", 0.3, x, y, s, s, 0);
  }
  bump(p, 0.78, 0.6, 0, n * 0.5 - n * 0.003, n, n * 0.006);
  // Wear: the contact patch is burnished, everything else stays matte. Also a
  // faint chalky bloom where the rubber has oxidised.
  for (let i = 0; i < 26; i++) {
    const y = rng() * n;
    polish(p, 0.62, 0.35, 0, y, n, n * (0.01 + rng() * 0.05));
  }
  for (let i = 0; i < 30; i++) {
    const s = n * (0.02 + rng() * 0.1);
    blob(p.a, n, "rgb(122,120,118)", 0.06 + rng() * 0.08, rng() * n, rng() * n, s, s * 0.6, rng() * Math.PI);
    blob(p.r, n, grey(0.97), 0.4, rng() * n, rng() * n, s, s * 0.6, 0);
  }
}

const PAINTERS: Record<MaterialName, (p: Paint) => void> = {
  plaster: paintPlaster,
  brick: paintBrick,
  woodPlank: paintWoodPlank,
  woodLog: paintWoodLog,
  concrete: paintConcrete,
  asphalt: paintAsphalt,
  metalPanel: paintMetalPanel,
  corrugated: paintCorrugated,
  roofTile: paintRoofTile,
  roofShingle: paintRoofShingle,
  glass: paintGlass,
  rock: paintRock,
  dirt: paintDirt,
  sand: paintSand,
  grass: paintGrass,
  foliage: paintFoliage,
  bark: paintBark,
  fabric: paintFabric,
  gold: paintGold,
  rubber: paintRubber,
};

/* ------------------------------------------------------------------------ *
 * Bakery
 * ------------------------------------------------------------------------ */

interface BakedMaps {
  map: THREE.Texture;
  normal: THREE.Texture;
  /** R = AO, G = roughness, B = metalness. */
  orm: THREE.Texture;
}

function finishTexture(tex: THREE.Texture, srgb: boolean, aniso: number): THREE.Texture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** A 1×1 stand-in so a canvas-less context (SSR, jsdom) still boots. */
function flatTexture(r: number, g: number, b: number, a: number, srgb: boolean): THREE.Texture {
  const d = new Uint8Array([
    Math.round(clamp01(r) * 255),
    Math.round(clamp01(g) * 255),
    Math.round(clamp01(b) * 255),
    Math.round(clamp01(a) * 255),
  ]);
  return finishTexture(new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat), srgb, 1);
}

/**
 * Tangent-space normals from the height field, by a wrapped Sobel.
 *
 * Sobel rather than a central difference because the 3×3 kernel averages
 * across the perpendicular axis: with the amount of high-frequency stipple
 * these height fields carry, a two-tap difference turns pinholes into noise
 * that shimmers under a moving light.
 *
 * The source array has already been flipped into texture space, so +row is +v
 * and the green channel comes out in the OpenGL convention three expects.
 */
export function normalFromHeight(
  px: Uint8ClampedArray,
  size: number,
  strength: number,
  aniso: number,
): THREE.Texture {
  const out = new Uint8Array(size * size * 4);
  const s = strength / 255;
  for (let y = 0; y < size; y++) {
    const yc = y * size;
    const yp = ((y + 1) % size) * size;
    const yn = ((y - 1 + size) % size) * size;
    for (let x = 0; x < size; x++) {
      const xp = (x + 1) % size;
      const xn = (x - 1 + size) % size;
      const tl = px[(yn + xn) * 4];
      const tc = px[(yn + x) * 4];
      const tr = px[(yn + xp) * 4];
      const ml = px[(yc + xn) * 4];
      const mr = px[(yc + xp) * 4];
      const bl = px[(yp + xn) * 4];
      const bc = px[(yp + x) * 4];
      const br = px[(yp + xp) * 4];
      const gx = (tr + 2 * mr + br - tl - 2 * ml - bl) * 0.25 * s;
      const gy = (bl + 2 * bc + br - tl - 2 * tc - tr) * 0.25 * s;
      let nx = -gx;
      let ny = -gy;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const o = (yc + x) * 4;
      out[o] = (nx * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * 0.5 + 0.5) * 255;
      out[o + 2] = inv * 255;
      out[o + 3] = 255;
    }
  }
  return finishTexture(new THREE.DataTexture(out, size, size, THREE.RGBAFormat), false, aniso);
}

/**
 * Bleed the leaf colour outward into the transparent margin.
 *
 * Mip generation averages RGB *and* alpha, so a cutout whose transparent
 * texels are black produces a dark fringe around every leaf the moment the
 * card is more than a few metres away. Flooding the colour outward costs two
 * cheap passes and removes the fringe entirely — it is the difference between
 * a canopy and a smudge at 100 m.
 */
function dilateAlpha(px: Uint8ClampedArray, size: number, passes: number): void {
  const alpha = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) alpha[i] = px[i * 4 + 3] > 8 ? 255 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const next = alpha.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (alpha[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = (y + dy + size) % size;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = (x + dx + size) % size;
            const j = yy * size + xx;
            if (!alpha[j]) continue;
            r += px[j * 4];
            g += px[j * 4 + 1];
            b += px[j * 4 + 2];
            count++;
          }
        }
        if (!count) continue;
        px[i * 4] = r / count;
        px[i * 4 + 1] = g / count;
        px[i * 4 + 2] = b / count;
        next[i] = 255;
      }
    }
    alpha.set(next);
  }
}

/**
 * Box-downsample the three grey channels into one ORM texture at half
 * resolution. Roughness/AO/metalness are low-frequency by nature — halving
 * them is invisible and takes 25 % off the material's VRAM bill.
 */
function packOrm(
  ao: Uint8ClampedArray,
  rough: Uint8ClampedArray,
  metal: Uint8ClampedArray,
  size: number,
  aniso: number,
): THREE.Texture {
  const half = Math.max(32, size >> 1);
  const scale = size / half;
  const out = new Uint8Array(half * half * 4);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      let a = 0;
      let r = 0;
      let m = 0;
      let count = 0;
      for (let dy = 0; dy < scale; dy++) {
        const sy = (y * scale + dy) | 0;
        for (let dx = 0; dx < scale; dx++) {
          const sx = (x * scale + dx) | 0;
          const i = (sy * size + sx) * 4;
          a += ao[i];
          r += rough[i];
          m += metal[i];
          count++;
        }
      }
      const o = (y * half + x) * 4;
      out[o] = a / count;
      out[o + 1] = r / count;
      out[o + 2] = m / count;
      out[o + 3] = 255;
    }
  }
  return finishTexture(new THREE.DataTexture(out, half, half, THREE.RGBAFormat), false, aniso);
}

/** Paint one material and lift its three maps onto the GPU. */
function bakeMaterial(name: MaterialName, size: number, aniso: number, tier: Tier): BakedMaps {
  const spec = SPEC[name];
  const ga = makeCanvas(size);
  const go = makeCanvas(size);
  const gr = makeCanvas(size);
  const gm = makeCanvas(size);
  const gh = makeCanvas(size);
  const fallback = (): BakedMaps => ({
    map: flatTexture(0.62, 0.58, 0.52, 1, true),
    normal: flatTexture(0.5, 0.5, 1, 1, false),
    orm: flatTexture(1, 0.85, 0, 1, false),
  });
  if (!ga || !go || !gr || !gm || !gh) return fallback();

  // Sensible neutral defaults, so a painter that forgets a channel still ships
  // a physically sane surface rather than a black hole.
  go.fillStyle = "rgb(255,255,255)";
  go.fillRect(0, 0, size, size);
  gr.fillStyle = "rgb(216,216,216)";
  gr.fillRect(0, 0, size, size);
  gm.fillStyle = "rgb(0,0,0)";
  gm.fillRect(0, 0, size, size);
  gh.fillStyle = "rgb(128,128,128)";
  gh.fillRect(0, 0, size, size);
  if (!spec.cutout) {
    ga.fillStyle = "rgb(128,128,128)";
    ga.fillRect(0, 0, size, size);
  }

  const p: Paint = { a: ga, o: go, r: gr, m: gm, h: gh, n: size, rng: rngFor(seedFor(name)) };
  try {
    PAINTERS[name](p);
  } catch {
    // A painter that throws still ships a usable surface — losing the brick
    // detail is survivable, losing the whole world is not.
  }

  const albedo = readChannel(ga, size);
  const aoPx = readChannel(go, size);
  const roughPx = readChannel(gr, size);
  const metalPx = readChannel(gm, size);
  const heightPx = readChannel(gh, size);
  if (!albedo || !aoPx || !roughPx || !metalPx || !heightPx) return fallback();
  if (spec.cutout) dilateAlpha(albedo, size, 3);

  // Grain + baked AO. Two passes folded into one loop over the albedo:
  //  • a seamless low-frequency field breaks up the texel-level flatness that
  //    reads as CG from any distance, and grains the height with it so the
  //    relief drifts too;
  //  • a fraction of the AO goes into the base colour, because an aoMap only
  //    touches indirect light and crevices have to stay dark under the key.
  const gres = 96;
  const field = grainField(gres, 6, tier.grainOctaves, seedFor(name) ^ 0x5bd1e995);
  const aoBake = spec.aoBake;
  const mapData = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const g = sampleField(field, gres, (x + 0.5) * inv, (y + 0.5) * inv) - 0.5;
      const mul = (1 + g * 0.18) * (1 - aoBake + aoBake * (aoPx[o] / 255));
      mapData[o] = Math.min(255, albedo[o] * mul);
      mapData[o + 1] = Math.min(255, albedo[o + 1] * mul);
      mapData[o + 2] = Math.min(255, albedo[o + 2] * mul);
      mapData[o + 3] = spec.cutout ? albedo[o + 3] : 255;
      const h = heightPx[o] + g * 30;
      heightPx[o] = h < 0 ? 0 : h > 255 ? 255 : h;
    }
  }

  const baked: BakedMaps = {
    map: finishTexture(new THREE.DataTexture(mapData, size, size, THREE.RGBAFormat), true, aniso),
    normal: normalFromHeight(heightPx, size, spec.relief * (size / 256), aniso),
    orm: packOrm(aoPx, roughPx, metalPx, size, aniso),
  };
  // Release five canvases' worth of backing store now rather than waiting for
  // the GC to notice — at 2048 that is 80 MB per material still resident while
  // the next one bakes.
  for (const g of [ga, go, gr, gm, gh]) {
    g.canvas.width = 1;
    g.canvas.height = 1;
  }
  return baked;
}

/* ------------------------------------------------------------------------ *
 * Utility textures
 * ------------------------------------------------------------------------ */
//
// The sprite/mask family every other system asks for. These carry no PBR
// packing, so they stay `CanvasTexture` — no read-back, no post-pass, and the
// browser keeps the upload path in C++.

interface TexSpec {
  size: number;
  srgb: boolean;
  wrap: THREE.Wrapping;
  mips: boolean;
}

const TEX_SPEC: Record<TextureName, TexSpec> = {
  noise: { size: 256, srgb: false, wrap: THREE.RepeatWrapping, mips: true },
  grassBlade: { size: 128, srgb: true, wrap: THREE.ClampToEdgeWrapping, mips: true },
  leafCluster: { size: 256, srgb: true, wrap: THREE.ClampToEdgeWrapping, mips: true },
  gravel: { size: 256, srgb: true, wrap: THREE.RepeatWrapping, mips: true },
  cloud: { size: 256, srgb: true, wrap: THREE.ClampToEdgeWrapping, mips: true },
  spark: { size: 64, srgb: true, wrap: THREE.ClampToEdgeWrapping, mips: true },
  smoke: { size: 128, srgb: true, wrap: THREE.ClampToEdgeWrapping, mips: true },
  muzzle: { size: 128, srgb: true, wrap: THREE.ClampToEdgeWrapping, mips: true },
  decalBullet: { size: 128, srgb: true, wrap: THREE.ClampToEdgeWrapping, mips: true },
  stormGrid: { size: 256, srgb: true, wrap: THREE.RepeatWrapping, mips: true },
};

/** Radial gradient helper — the backbone of every soft sprite here. */
function radial(g: Ctx2D, x: number, y: number, r: number, stops: [number, string][]): void {
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  for (const [t, c] of stops) grad.addColorStop(t, c);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

function paintUtilityTexture(name: TextureName, g: Ctx2D, n: number, rng: () => number): void {
  const half = n * 0.5;
  switch (name) {
    case "noise": {
      // Four decorrelated seamless fields, one per channel: R coarse fbm,
      // G medium, B fine, A a rough cellular stand-in. Shaders across the
      // world pick whichever frequency they need out of one fetch.
      const img = g.createImageData(n, n);
      const d = img.data;
      const seed = seedFor("dz-noise");
      const f0 = grainField(n, 4, 4, seed);
      const f1 = grainField(n, 10, 3, seed + 17);
      const f2 = grainField(n, 26, 2, seed + 91);
      const f3 = grainField(n, 16, 1, seed + 313);
      for (let i = 0; i < n * n; i++) {
        d[i * 4] = f0[i] * 255;
        d[i * 4 + 1] = f1[i] * 255;
        d[i * 4 + 2] = f2[i] * 255;
        d[i * 4 + 3] = 255 - Math.abs(f3[i] - 0.5) * 2 * 255;
      }
      g.putImageData(img, 0, 0);
      break;
    }
    case "grassBlade": {
      // Three blades on one card, tapering, darker at the root. Vegetation
      // instances this millions of times, so the alpha edge has to be clean.
      g.clearRect(0, 0, n, n);
      for (let i = 0; i < 3; i++) {
        const x0 = n * (0.24 + i * 0.26);
        const lean = (i - 1) * n * 0.10;
        const w = n * 0.075;
        const grad = g.createLinearGradient(0, n, 0, 0);
        const tone = 0.86 + i * 0.12;
        grad.addColorStop(0, css(0.10 * tone, 0.20 * tone, 0.06 * tone));
        grad.addColorStop(0.55, css(0.24 * tone, 0.46 * tone, 0.12 * tone));
        grad.addColorStop(1, css(0.52 * tone, 0.70 * tone, 0.24 * tone));
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(x0 - w, n);
        g.quadraticCurveTo(x0 - w * 0.5 + lean * 0.4, n * 0.45, x0 + lean, n * 0.04);
        g.quadraticCurveTo(x0 + w * 0.5 + lean * 0.4, n * 0.45, x0 + w, n);
        g.closePath();
        g.fill();
        // Centre rib, so the blade catches a highlight along its length.
        g.strokeStyle = "rgba(255,255,255,0.16)";
        g.lineWidth = Math.max(1, n * 0.008);
        g.beginPath();
        g.moveTo(x0, n);
        g.quadraticCurveTo(x0 + lean * 0.4, n * 0.45, x0 + lean, n * 0.06);
        g.stroke();
      }
      break;
    }
    case "leafCluster": {
      g.clearRect(0, 0, n, n);
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2 + rng() * 0.5;
        const d = n * (0.06 + rng() * 0.30);
        const cx = half + Math.cos(a) * d;
        const cy = half + Math.sin(a) * d;
        const len = n * (0.11 + rng() * 0.13);
        const wid = len * (0.32 + rng() * 0.20);
        const sun = rng();
        const gg = 0.30 + sun * 0.34;
        g.save();
        g.translate(cx, cy);
        g.rotate(a + Math.PI * 0.5 + (rng() - 0.5) * 0.6);
        g.fillStyle = css(gg * (0.42 + sun * 0.34), gg, gg * (0.22 + sun * 0.14));
        g.beginPath();
        g.moveTo(0, 0);
        g.quadraticCurveTo(wid, len * 0.35, 0, len);
        g.quadraticCurveTo(-wid, len * 0.35, 0, 0);
        g.fill();
        g.strokeStyle = css(gg * 0.66, gg * 1.28, gg * 0.4);
        g.lineWidth = Math.max(1, n * 0.005);
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(0, len);
        g.stroke();
        g.restore();
      }
      break;
    }
    case "gravel": {
      g.fillStyle = "rgb(74,70,64)";
      g.fillRect(0, 0, n, n);
      for (let i = 0; i < 1400; i++) {
        const x = rng() * n;
        const y = rng() * n;
        const s = n * (0.006 + rng() * 0.028);
        const v = 0.32 + rng() * 0.42;
        for (const ox of [-n, 0, n]) {
          for (const oy of [-n, 0, n]) {
            g.save();
            g.translate(x + ox, y + oy);
            g.rotate(rng() * Math.PI);
            g.fillStyle = css(v, v * 0.97, v * 0.92);
            g.beginPath();
            g.ellipse(0, 0, s, s * (0.6 + rng() * 0.5), 0, 0, Math.PI * 2);
            g.fill();
            // Contact shadow on one side — the cheapest possible fake AO.
            g.fillStyle = "rgba(0,0,0,0.25)";
            g.beginPath();
            g.ellipse(s * 0.25, s * 0.25, s * 0.9, s * 0.55, 0, 0, Math.PI * 2);
            g.fill();
            g.restore();
          }
        }
      }
      break;
    }
    case "cloud": {
      g.clearRect(0, 0, n, n);
      for (let i = 0; i < 42; i++) {
        const a = rng() * Math.PI * 2;
        const d = rng() * n * 0.26;
        const r = n * (0.08 + rng() * 0.20);
        radial(g, half + Math.cos(a) * d, half + Math.sin(a) * d * 0.55, r, [
          [0, "rgba(255,255,255,0.55)"],
          [0.5, "rgba(250,252,255,0.26)"],
          [1, "rgba(240,246,255,0)"],
        ]);
      }
      break;
    }
    case "spark": {
      g.clearRect(0, 0, n, n);
      // Additive ember: a white-hot core falling off through orange. The tight
      // core is what keeps it a spark and not a fuzzy dot when it is 3 px wide.
      radial(g, half, half, half, [
        [0, "rgba(255,255,255,1)"],
        [0.12, "rgba(255,240,190,0.95)"],
        [0.34, "rgba(255,168,60,0.55)"],
        [0.7, "rgba(210,80,18,0.14)"],
        [1, "rgba(120,30,0,0)"],
      ]);
      break;
    }
    case "smoke": {
      g.clearRect(0, 0, n, n);
      for (let i = 0; i < 30; i++) {
        const a = rng() * Math.PI * 2;
        const d = rng() * n * 0.22;
        const r = n * (0.12 + rng() * 0.22);
        radial(g, half + Math.cos(a) * d, half + Math.sin(a) * d, r, [
          [0, "rgba(214,212,208,0.28)"],
          [0.6, "rgba(190,188,184,0.12)"],
          [1, "rgba(170,168,164,0)"],
        ]);
      }
      // A soft alpha vignette so the puff can never show a square edge.
      g.globalCompositeOperation = "destination-in";
      radial(g, half, half, half, [
        [0, "rgba(0,0,0,1)"],
        [0.72, "rgba(0,0,0,1)"],
        [1, "rgba(0,0,0,0)"],
      ]);
      g.globalCompositeOperation = "source-over";
      break;
    }
    case "muzzle": {
      g.clearRect(0, 0, n, n);
      // Spikes first, core over the top, so the core stays clean and hot.
      g.save();
      g.translate(half, half);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + rng() * 0.3;
        const len = half * (0.5 + rng() * 0.5);
        const w = half * (0.05 + rng() * 0.07);
        const grad = g.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
        grad.addColorStop(0, "rgba(255,246,210,0.9)");
        grad.addColorStop(1, "rgba(255,150,40,0)");
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(Math.cos(a + 1.57) * w, Math.sin(a + 1.57) * w);
        g.lineTo(Math.cos(a) * len, Math.sin(a) * len);
        g.lineTo(Math.cos(a - 1.57) * w, Math.sin(a - 1.57) * w);
        g.closePath();
        g.fill();
      }
      g.restore();
      radial(g, half, half, half * 0.5, [
        [0, "rgba(255,255,255,1)"],
        [0.35, "rgba(255,236,170,0.85)"],
        [0.7, "rgba(255,168,60,0.30)"],
        [1, "rgba(255,120,20,0)"],
      ]);
      break;
    }
    case "decalBullet": {
      g.clearRect(0, 0, n, n);
      // Scorch halo, cracked ring, dark hole. Alpha falls off to nothing well
      // inside the card so the decal quad never shows its own edge.
      radial(g, half, half, half * 0.92, [
        [0, "rgba(30,26,22,0.75)"],
        [0.35, "rgba(40,36,30,0.45)"],
        [0.7, "rgba(50,46,40,0.14)"],
        [1, "rgba(60,56,50,0)"],
      ]);
      g.strokeStyle = "rgba(228,224,214,0.5)";
      g.lineWidth = Math.max(1, n * 0.012);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + rng() * 0.4;
        const r0 = half * 0.16;
        const r1 = half * (0.3 + rng() * 0.5);
        g.beginPath();
        g.moveTo(half + Math.cos(a) * r0, half + Math.sin(a) * r0);
        g.lineTo(half + Math.cos(a) * r1, half + Math.sin(a) * r1);
        g.stroke();
      }
      radial(g, half, half, half * 0.22, [
        [0, "rgba(8,6,5,1)"],
        [0.7, "rgba(16,12,10,0.95)"],
        [1, "rgba(30,24,20,0)"],
      ]);
      break;
    }
    case "stormGrid": {
      // Seamless hex lattice for the storm wall. Alpha-only lines with a soft
      // bloom either side so the wall reads as energy rather than as wireframe.
      g.clearRect(0, 0, n, n);
      const rows = 4;
      const cols = 4;
      const cw = n / cols;
      const ch = n / rows;
      g.lineJoin = "round";
      for (let pass = 0; pass < 2; pass++) {
        g.strokeStyle = pass === 0 ? "rgba(150,205,255,0.20)" : "rgba(226,242,255,0.9)";
        g.lineWidth = pass === 0 ? Math.max(3, n * 0.030) : Math.max(1, n * 0.008);
        for (let r = -1; r <= rows; r++) {
          for (let c = -1; c <= cols; c++) {
            const cx = c * cw + (r & 1 ? cw * 0.5 : 0);
            const cy = r * ch;
            g.beginPath();
            for (let k = 0; k <= 6; k++) {
              const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
              const x = cx + Math.cos(a) * cw * 0.5;
              const y = cy + Math.sin(a) * ch * 0.58;
              if (k === 0) g.moveTo(x, y);
              else g.lineTo(x, y);
            }
            g.stroke();
          }
        }
      }
      // Drifting motes inside the cells.
      for (let i = 0; i < 120; i++) {
        const s = n * (0.002 + rng() * 0.006);
        radial(g, rng() * n, rng() * n, s * 3, [
          [0, "rgba(255,255,255,0.7)"],
          [1, "rgba(160,210,255,0)"],
        ]);
      }
      break;
    }
  }
}

function bakeUtilityTexture(name: TextureName, scale: number, aniso: number): THREE.Texture {
  const spec = TEX_SPEC[name];
  const n = Math.max(32, Math.round(spec.size * scale));
  const g = makeCanvas(n);
  if (!g) return flatTexture(1, 1, 1, 1, spec.srgb);
  try {
    paintUtilityTexture(name, g, n, rngFor(seedFor(name)));
  } catch {
    /* a sprite that fails to paint still ships something drawable */
  }
  const tex = new THREE.CanvasTexture(g.canvas as HTMLCanvasElement);
  tex.wrapS = tex.wrapT = spec.wrap;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = spec.mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = spec.mips;
  tex.anisotropy = spec.mips ? aniso : 1;
  tex.colorSpace = spec.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------------ *
 * Environment probe
 * ------------------------------------------------------------------------ */

/**
 * A procedural sky + ground equirect, PMREM'd into a reflection probe.
 *
 * This is the highest-value texture in the module by a wide margin. Without a
 * probe, `MeshStandardMaterial` has no specular environment: every metal in
 * the game is flat grey, every window is a black rectangle, and every rough
 * dielectric loses its horizon sheen. With one, the same materials pick up a
 * warm sun side, a cool sky side and a bounce from the ground — for free, in
 * one texture, before a single light has been added.
 *
 * The sky system will very likely replace `scene.environment` with its own
 * time-of-day probe once it boots. That is the correct outcome and we do not
 * fight it: this one exists so that everything baked or previewed *before*
 * that point is already lit, and so the world still looks right if sky fails.
 */
function buildEnvironment(renderer: THREE.WebGLRenderer, width: number): {
  texture: THREE.Texture | null;
  dispose(): void;
} {
  const h = Math.max(64, width >> 1);
  const g = makeCanvas(width);
  if (!g) return { texture: null, dispose: () => {} };
  const canvas = g.canvas as HTMLCanvasElement;
  canvas.height = h;

  // --- sky dome ---------------------------------------------------------
  // Zenith → horizon in three stops. The pale band right at the horizon is the
  // aerial-perspective colour, and it is what the metals will pick up as their
  // grazing highlight.
  const sky = g.createLinearGradient(0, 0, 0, h * 0.5);
  sky.addColorStop(0, "rgb(38,86,178)");
  sky.addColorStop(0.55, "rgb(104,164,224)");
  sky.addColorStop(0.88, "rgb(178,214,242)");
  sky.addColorStop(1, "rgb(214,232,244)");
  g.fillStyle = sky;
  g.fillRect(0, 0, width, h * 0.5);

  // --- ground half ------------------------------------------------------
  const ground = g.createLinearGradient(0, h * 0.5, 0, h);
  ground.addColorStop(0, "rgb(150,148,116)");
  ground.addColorStop(0.18, "rgb(84,96,54)");
  ground.addColorStop(1, "rgb(34,38,24)");
  g.fillStyle = ground;
  g.fillRect(0, h * 0.5, width, h * 0.5);

  // --- sun --------------------------------------------------------------
  // Elevation ~48°, roughly where the sky system's default noon key sits, so
  // the specular hot spot and the shadow direction agree on the first frame.
  const sunX = width * 0.62;
  const sunY = h * (0.5 - 0.48 / 1.8);
  const glow = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, width * 0.24);
  glow.addColorStop(0, "rgba(255,252,238,1)");
  glow.addColorStop(0.04, "rgba(255,246,214,1)");
  glow.addColorStop(0.16, "rgba(255,232,180,0.55)");
  glow.addColorStop(0.5, "rgba(212,226,240,0.16)");
  glow.addColorStop(1, "rgba(180,210,238,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, width, h * 0.5);

  // --- cloud banding ----------------------------------------------------
  const rng = rngFor(seedFor("dz-env"));
  for (let i = 0; i < 60; i++) {
    const y = h * (0.10 + rng() * 0.34);
    const x = rng() * width;
    const rx = width * (0.03 + rng() * 0.11);
    const ry = h * (0.012 + rng() * 0.035);
    const a = 0.10 + rng() * 0.35 * (1 - Math.abs(y / (h * 0.5) - 0.6));
    for (const ox of [-width, 0, width]) {
      const grad = g.createRadialGradient(x + ox, y, 0, x + ox, y, rx);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(0.6, `rgba(246,250,255,${a * 0.4})`);
      grad.addColorStop(1, "rgba(236,244,255,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(x + ox, y, rx, ry, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Horizon haze band, drawn last so it sits over both halves. Softening the
  // sky/ground seam is what stops reflective surfaces showing a hard line.
  const haze = g.createLinearGradient(0, h * 0.44, 0, h * 0.58);
  haze.addColorStop(0, "rgba(214,232,244,0)");
  haze.addColorStop(0.5, "rgba(206,224,238,0.85)");
  haze.addColorStop(1, "rgba(150,158,132,0)");
  g.fillStyle = haze;
  g.fillRect(0, h * 0.44, width, h * 0.14);

  const source = new THREE.CanvasTexture(canvas);
  source.mapping = THREE.EquirectangularReflectionMapping;
  source.colorSpace = THREE.SRGBColorSpace;
  source.needsUpdate = true;

  let pmrem: THREE.PMREMGenerator | null = null;
  let target: THREE.WebGLRenderTarget | null = null;
  try {
    pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    target = pmrem.fromEquirectangular(source);
  } catch {
    target = null;
  }
  // The PMREM result owns the data now; the equirect and the generator are
  // both dead weight from here.
  source.dispose();
  pmrem?.dispose();

  return {
    texture: target ? target.texture : null,
    dispose: () => {
      target?.dispose();
      target = null;
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Shared shader patch
 * ------------------------------------------------------------------------ */

interface MacroUniforms {
  uDzMacroMap: { value: THREE.Texture | null };
  /** x = repeats per metre, y = strength. */
  uDzMacro: { value: THREE.Vector2 };
}

/**
 * Macro variation + instance tint. See the file header for why both exist.
 *
 * Kept deliberately tiny: this function runs on every material in the game and
 * a mistake here is a black screen, not a bad-looking wall. It only touches
 * chunks that exist in every `MeshStandardMaterial`/`MeshPhysicalMaterial`
 * shader in r160 — `common`, `project_vertex`, `map_fragment`, `color_fragment`
 * — and it never redefines a three symbol.
 */
function patchMaterial(mat: THREE.MeshStandardMaterial, uni: MacroUniforms, macro: boolean): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDzMacroMap = uni.uDzMacroMap;
    shader.uniforms.uDzMacro = uni.uDzMacro;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying vec3 vDzWorld;
        #ifdef USE_INSTANCING_COLOR
          varying vec3 vDzTint;
        #endif`,
      )
      .replace(
        "#include <project_vertex>",
        /* glsl */ `#include <project_vertex>
        // Re-derive the world position rather than leaning on worldpos_vertex,
        // whose worldPosition is only declared when an envMap / shadow /
        // transmission define happens to be set. Mirrors that chunk exactly,
        // instancing included.
        vec4 dzWorld = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          dzWorld = instanceMatrix * dzWorld;
        #endif
        vDzWorld = ( modelMatrix * dzWorld ).xyz;
        #ifdef USE_INSTANCING_COLOR
          vDzTint = instanceColor;
        #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform sampler2D uDzMacroMap;
        uniform vec2 uDzMacro;
        varying vec3 vDzWorld;
        #ifdef USE_INSTANCING_COLOR
          varying vec3 vDzTint;
        #endif`,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */ `#include <map_fragment>
        ${
          macro
            ? `
        // Two decorrelated taps, one planar and one that varies with height so
        // vertical faces break up too. Multiplicative, so it survives tinting.
        float dzA = texture2D( uDzMacroMap, vDzWorld.xz * uDzMacro.x ).r;
        float dzB = texture2D( uDzMacroMap, vec2( vDzWorld.x + vDzWorld.z, vDzWorld.y ) * uDzMacro.x * 0.63 ).g;
        diffuseColor.rgb *= 1.0 + ( dzA * 0.45 + dzB * 0.55 - 0.5 ) * uDzMacro.y;`
            : ""
        }`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        // r160 routes instanceColor into vColor but only applies it under
        // USE_COLOR, which needs vertexColors. Apply it ourselves so instanced
        // props can be individually painted off one shared material.
        #if defined( USE_INSTANCING_COLOR ) && !defined( USE_COLOR )
          diffuseColor.rgb *= vDzTint;
        #endif`,
      );
  };
}

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

export const createMaterials: SystemFactory = (ctx: WorldCtx): System => {
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const maxAniso = (() => {
    try {
      return Math.min(tier.aniso, ctx.renderer.capabilities.getMaxAnisotropy());
    } catch {
      return 1;
    }
  })();

  const maps = new Map<MaterialName, BakedMaps>();
  const materials = new Map<string, THREE.Material>();
  const textures = new Map<TextureName, THREE.Texture>();
  const macroUniforms: MacroUniforms = {
    uDzMacroMap: { value: null },
    uDzMacro: { value: new THREE.Vector2(1 / MACRO_METRES, MACRO_STRENGTH) },
  };
  let envTexture: THREE.Texture | null = null;
  let envHandle: { texture: THREE.Texture | null; dispose(): void } | null = null;
  let disposed = false;

  // ---- service, published before a single texel is painted ----------------
  // `build`, `mapsFor` and `bakeUtilityTexture` are all function declarations
  // and therefore hoisted, so the service can go up here where it belongs: a
  // later system that boots while we are still baking must be able to find us.
  const service: MaterialsService = {
    get(name: MaterialName): THREE.Material {
      const key = `${name}|base`;
      let m = materials.get(key);
      if (!m) {
        m = build(name, SPEC[name].base);
        materials.set(key, m);
      }
      return m;
    },
    tinted(name: MaterialName, color: THREE.ColorRepresentation): THREE.Material {
      // Cached by name + hex: a POI's roof identity costs one material, not one
      // per mesh. Without this cache a hundred-building district would carry a
      // hundred materials' worth of uniform state and blow the draw budget.
      const hex = new THREE.Color(color).getHex();
      const key = `${name}|${hex.toString(16)}`;
      let m = materials.get(key);
      if (!m) {
        m = build(name, hex);
        materials.set(key, m);
      }
      return m;
    },
    texture(name: TextureName): THREE.Texture {
      let t = textures.get(name);
      if (!t) {
        // Sprites do not need the full material ladder — half scale on "low"
        // is plenty for something that is a few dozen pixels on screen.
        const scale = ctx.quality === "low" ? 0.5 : ctx.quality === "ultra" ? 2 : 1;
        t = bakeUtilityTexture(name, scale, maxAniso);
        textures.set(name, t);
      }
      return t;
    },
    get env(): THREE.Texture | null {
      return envTexture;
    },
  };
  ctx.services.materials = service;

  function mapsFor(name: MaterialName): BakedMaps {
    let m = maps.get(name);
    if (!m) {
      const spec = SPEC[name];
      const size = Math.max(MIN_SIZE, Math.round(tier.base * spec.detail));
      m = bakeMaterial(name, size, maxAniso, tier);
      maps.set(name, m);
    }
    return m;
  }

  /** Build the concrete three material for a name, optionally colour-tinted. */
  function build(name: MaterialName, color: number): THREE.Material {
    const spec = SPEC[name];
    const m = mapsFor(name);

    // ORM rides the same UV set as everything else. `channel` defaults to 0 in
    // r160, but say it out loud — a silent switch to uv1 would make every
    // aoMap sample garbage on geometry that only has one UV set.
    m.orm.channel = 0;

    const common = {
      map: m.map,
      normalMap: m.normal,
      aoMap: m.orm,
      roughnessMap: m.orm,
      metalnessMap: m.orm,
      // Pinned to 1: the maps carry the real values, and a second scalar knob
      // on top of them is just a way to lose the variation we painted.
      roughness: 1,
      metalness: 1,
      color,
      envMapIntensity: spec.env,
      side: spec.side ?? THREE.FrontSide,
      normalScale: new THREE.Vector2(spec.normalScale, spec.normalScale),
    };

    let mat: THREE.MeshStandardMaterial;
    if (name === "glass") {
      const g = new THREE.MeshPhysicalMaterial(common);
      g.clearcoat = 1;
      g.clearcoatRoughness = 0.06;
      g.ior = 1.5;
      g.reflectivity = 0.6;
      if (tier.transmission) {
        g.transmission = 0.9;
        g.thickness = 0.05;
      } else {
        // A tuned alpha pane. At the distances glass is read from in a BR —
        // across a street, through a window frame — this is within a hair of
        // the transmission path and does not cost a second scene render.
        g.transparent = true;
        g.opacity = 0.34;
      }
      mat = g;
    } else if (name === "gold") {
      const g = new THREE.MeshPhysicalMaterial(common);
      g.clearcoat = 0.28;
      g.clearcoatRoughness = 0.22;
      mat = g;
    } else if (name === "fabric") {
      const f = new THREE.MeshPhysicalMaterial(common);
      // Sheen is what makes canvas look like canvas: a soft rim that brightens
      // at grazing angles instead of the flat matte a plain standard gives.
      f.sheen = 0.7;
      f.sheenRoughness = 0.85;
      f.sheenColor = new THREE.Color(0xffffff);
      mat = f;
    } else {
      mat = new THREE.MeshStandardMaterial(common);
    }

    if (spec.cutout) {
      mat.transparent = false;
      mat.alphaTest = 0.42;
      mat.depthWrite = true;
      // Cutout shadows: three's depth material copies `map` + `alphaTest`, so
      // leaves throw leaf-shaped shadows rather than square ones.
      mat.shadowSide = THREE.DoubleSide;
    }

    mat.name = `dz:${name}`;
    // Glass would double-count the macro tint against its own transparency,
    // and gold is a mirror — neither wants world-space albedo noise.
    patchMaterial(mat, macroUniforms, name !== "glass" && name !== "gold");
    return mat;
  }

  // ---- eager work ---------------------------------------------------------
  // Only two things bake now. Everything else is on demand — see the header.
  //
  // The noise tile has to exist before any material compiles, because the
  // macro-variation patch samples it; and the probe has to exist before
  // anything is rendered, or the first frames are lit with no specular at all.
  macroUniforms.uDzMacroMap.value = service.texture("noise");

  try {
    envHandle = buildEnvironment(ctx.renderer, tier.env);
    envTexture = envHandle.texture;
    if (envTexture) ctx.scene.environment = envTexture;
  } catch (err) {
    console.warn("[Drop Zero] environment probe failed; metals will read flat", err);
    envTexture = null;
  }

  return {
    name: "materials",
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const m of materials.values()) m.dispose();
      materials.clear();
      for (const m of maps.values()) {
        m.map.dispose();
        m.normal.dispose();
        m.orm.dispose();
      }
      maps.clear();
      for (const t of textures.values()) t.dispose();
      textures.clear();
      macroUniforms.uDzMacroMap.value = null;
      // Only release the probe if it is still ours — the sky system routinely
      // swaps in a time-of-day probe, and stomping that on teardown would blank
      // the scene mid-dispose for anything that renders after us.
      if (envTexture && ctx.scene.environment === envTexture) ctx.scene.environment = null;
      envHandle?.dispose();
      envHandle = null;
      envTexture = null;
    },
  };
};

export default createMaterials;
