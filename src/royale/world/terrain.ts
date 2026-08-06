/**
 * DROP ZERO — the island.
 *
 * Publishes `TerrainService`. Everything that touches the ground — the player
 * capsule, the bots, the POI placer, the loot scatter, the vegetation, the
 * storm — asks this module "how high is it here, and what is it made of".
 *
 * Four pieces, in dependency order:
 *
 *  1. THE AUTHORED ISLAND. Not uniform noise. A wobbled radial coastline with
 *     a harbour bay, a north-west peninsula and two offshore stacks; a ridged
 *     central highland; a broad quantised plain in the north-east for the big
 *     town; two river valleys that actually run downhill and meet the sea; a
 *     cliff coast on the west-south-west and beaches everywhere else. See
 *     THE MAP below for the numbers and why each one is what it is.
 *
 *  2. THE BAKED FIELD. All of the above costs ~1.1 µs a sample, and `heightAt`
 *     is called tens of thousands of times a frame by bots, physics and the
 *     mesher. So the macro layer is baked once into a lattice (4 m on `high`)
 *     and read back with bilinear taps at ~25 ns. Only the sub-lattice detail
 *     — the metre-scale lumpiness a heightfield needs to be walkable rather
 *     than a ramp — is evaluated analytically on top. The mesh is a sampling
 *     of that same function, so what you see and what you collide with can
 *     never disagree.
 *
 *  3. THE PADS. Towns need level, grid-aligned ground: a wall you build in a
 *     street has to sit flush, and a POI floor has to land on a multiple of
 *     `GRID`. Each pad flattens the field to a quantised elevation with a
 *     smoothstep skirt, and the resolved list is published on the service as
 *     `pads` so `pois.ts` can drop its districts onto known-flat ground.
 *
 *  4. THE CHUNKED LOD MESH. A 3.85 km square split into 350 m chunks, four
 *     detail levels each, selected per frame by distance and frustum-culled by
 *     hand. Chunk edges carry a skirt so an LOD boundary shows a sliver of
 *     ground rather than a hole. The coarsest level is resident for every
 *     chunk from boot, so there is always something drawn under your feet;
 *     the three finer levels are a pool of slots handed out to whichever
 *     chunks are near and visible, and rebuilt incrementally against a vertex
 *     budget so a fast flight never spikes the frame.
 *
 * ---------------------------------------------------------------------------
 * THE MAP
 *
 *   Origin is the middle of the island and a legal spawn. +X east, +Z south.
 *
 *   - Coast: ellipse of radius ~1155 m, wobbled by three sines and a noise
 *     octave, so it reads as geography rather than as a circle. `worldSize`
 *     (1500) is the half-extent of the playable square; the sea and the
 *     continental shelf are modelled out to 1780 m so the horizon never shows
 *     a cut edge under the water plane.
 *   - Highland: a ridged massif on the west-centre, peaking near 210 m. Ridged
 *     noise under a domain warp, because plain FBM makes hills and only ridged
 *     noise makes mountains.
 *   - Plain: 430 m radius at (560, -600), flattened to 36 m — nine grid cells,
 *     so a whole town's floors land on multiples of 4 without a single
 *     hand-placed offset.
 *   - Rivers: two polylines with an explicit bed elevation per node, carved as
 *     a wide valley plus a narrow channel. The last node of each sits below
 *     sea level, which is what turns the mouth into a real estuary once the
 *     water system puts its plane down at y = 0.
 *   - Cliffs: west-south-west facing coast rises ~62 m in ~34 m of run. That
 *     is the one stretch you cannot land a glider on, and it is deliberately
 *     the loudest silhouette from the bus.
 * ---------------------------------------------------------------------------
 */
import * as THREE from "three";
import { createNoise2D } from "simplex-noise";
import {
  GRID,
  makeRng,
  type ImpactMaterial,
  type MaterialName,
  type MaterialsService,
  type QualityTier,
  type System,
  type SystemFactory,
  type TerrainService,
} from "../types";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Half-extent of the playable square. The storm never closes outside this. */
const WORLD_SIZE = 1500;
/** Sea plane. Everything in this world is authored against y = 0. */
const SEA_LEVEL = 0;

/**
 * Half-extent of the baked field and of the chunk grid. Past `WORLD_SIZE` by
 * 280 m so that a player pinned against the storm's outer edge still sees
 * modelled seabed and shelf rather than the apron.
 */
const FIELD_EXTENT = 1780;

/** Island body. Centre is nudged off the origin so the map is not symmetric. */
const ISLE_X = -40;
const ISLE_Z = 40;
const ISLE_R = 1155;
/** N-S squash. Slightly wider than tall reads better on the minimap. */
const ISLE_SQUASH = 1.06;

/** Unit vector the cliff coast faces. West-south-west. */
const CLIFF_DIR_X = -0.86;
const CLIFF_DIR_Z = 0.51;

/** Height of the cliff wall, and the horizontal run it takes to get there. */
const CLIFF_HEIGHT = 62;
const CLIFF_RUN = 34;

/** Depth the continental shelf settles to. The apron below is flat past it. */
const SHELF_DEPTH = 62;

/** The big north-east plain, flattened for the largest POI on the map. */
const PLAIN = { x: 560, z: -600, r: 430, y: 36 };

/** Central highland: centre, axis, half-extents, peak. */
const RIDGE = {
  x: -250,
  z: 90,
  /** Axis direction (unit). Runs south-west to north-east. */
  dx: 0.62,
  dz: -0.78,
  halfLength: 800,
  halfWidth: 430,
  height: 210,
};

/** Terrain is silent under the water plane for the first this-many metres. */
const SHORE_FADE = 170;

/**
 * Chunk edge, metres.
 *
 * This is a pure draw-call trade. At 250 m the frustum from the battle bus
 * (620 m up, looking across the whole island) held 195 chunks — terrain alone
 * eating a fifth of the 900-call frame budget before a single building, tree
 * or player is drawn. At 350 m the same view is ~100, and the coarser culling
 * granularity costs a handful of extra chunks at ground level, where there is
 * headroom.
 */
const CHUNK = 350;
/** Chunks per side. 11 × 350 = 3850 m, comfortably past the baked field. */
const CHUNKS = Math.ceil((FIELD_EXTENT * 2) / CHUNK);

interface Tier {
  /** Lattice step of the baked macro field, metres. */
  fieldStep: number;
  /** Quads per side for LOD 0..3. */
  segs: [number, number, number, number];
  /** Slot counts for LOD 0..2. LOD 3 is resident for every chunk. */
  pool: [number, number, number];
  /** Distance (m) at which each LOD gives way to the next. */
  lodDist: [number, number, number];
  /**
   * Beyond this a chunk is not drawn at all. Tighter than the fog alone would
   * justify, and it can be: the island body is only ~1155 m across, so past
   * ~2.4 km from anywhere on it there is nothing but submerged shelf — which
   * the water surface hides anyway. Culling ocean floor is free.
   */
  cull: number;
  /** Vertices re-tessellated per frame before a rebuild spills into the next. */
  budget: number;
  /** Drop the triplanar rock pass and the second macro octave. */
  cheap: boolean;
  aniso: number;
}

const TIERS: Record<QualityTier, Tier> = {
  low: {
    fieldStep: 8,
    segs: [56, 32, 18, 9],
    pool: [3, 9, 26],
    lodDist: [250, 520, 1050],
    cull: 1900,
    budget: 2400,
    cheap: true,
    aniso: 2,
  },
  medium: {
    fieldStep: 6,
    segs: [88, 44, 24, 11],
    pool: [4, 12, 34],
    lodDist: [300, 640, 1250],
    cull: 2200,
    budget: 3400,
    cheap: true,
    aniso: 4,
  },
  high: {
    fieldStep: 4,
    segs: [128, 64, 32, 14],
    pool: [5, 16, 46],
    lodDist: [370, 760, 1500],
    cull: 2600,
    budget: 5000,
    cheap: false,
    aniso: 8,
  },
  ultra: {
    fieldStep: 4,
    segs: [176, 88, 44, 16],
    pool: [7, 20, 60],
    lodDist: [460, 940, 1800],
    cull: 3000,
    budget: 7000,
    cheap: false,
    aniso: 16,
  },
};

/** Interleaved channels of the macro field. One tap fills a cache line. */
const F_H = 0;
const F_D = 1;
const F_STRIDE = 2;

/** Which splat layer each index in `aSplat` is. Mirrored in the shader. */
const L_SAND = 0;
const L_GRASS = 1;
const L_DIRT = 2;
const L_ROCK = 3;

/**
 * World metres per UV repeat for the ALBEDO maps.
 *
 * Far larger than the shared material library's own tiling (3–4.5 m), and the
 * numbers were arrived at by bisection in a browser, not by taste.
 *
 * Every one of the library's ground maps carries a strong low-frequency
 * signature — a pale blotch, a clump of turf. Tile it and that signature
 * repeats on a perfect lattice, and seen at a grazing angle from 100 m the
 * lattice is unmistakable: a chequerboard marching across every open field. It
 * is the single most damning "this is a Three.js demo" tell there is. Nothing
 * downstream hides it — not macro tint, not height blending, not randomised
 * per-patch UV offsets, because the *period* is the tell and those only change
 * its phase. At 8 m it was glaring; at 22–26 m it is gone, because the blotches
 * are now the size of real ground features and read as ground.
 *
 * The cost is texel density, and the maps are 1024², so even at 26 m that is
 * still 39 texels per metre — 2.5 cm texels underfoot. The fine detail comes
 * back through the normal maps below, which tile four times finer.
 */
const TILE_METRES: [number, number, number, number] = [22, 26, 24, 18];

/**
 * Metres per repeat for the NORMAL maps, which tile much finer.
 *
 * Splitting the two is what buys both halves of the look. Albedo has to tile
 * large or its low-frequency blotches read as a lattice; normals can tile small
 * because a tangent-space normal map has almost no low-frequency energy — a
 * test render with the normals switched off was indistinguishable — so this is
 * where the crisp, close-up "you can see individual pebbles" detail comes from.
 *
 * These are now the rates the library actually painted for (SPEC[].metres:
 * grass 3.0, dirt/sand 4.0, rock 4.5). At the old 5.5–6.5 m every feature was
 * blown up ~2× past its authored size, which is most of the way to "smooth".
 */
const TILE_NORMAL_METRES: [number, number, number, number] = [4.0, 3.0, 4.0, 4.5];

/**
 * Metres per repeat for the DETAIL albedo tap. See DZ_DETAIL in the shader.
 *
 * The albedo maps are authored at 3–4.5 m per tile: `paintGrass` strokes blades
 * ~1.7–8.4 cm long at that rate, `paintSand` lays grain at texel scale. Tiling
 * them at TILE_METRES instead stretches every one of those features ~7×, which
 * turns grass blades into half-metre smears and sand grain into gravel. That —
 * not a failed shader patch — is why the ground had no character underfoot: the
 * texture WAS bound, it was just magnified past the point where its content
 * meant anything.
 *
 * We cannot simply tile smaller (the header above explains what that costs), so
 * the map is sampled a SECOND time at its authored rate and high-passed against
 * its own blurred self. What survives is only the frequencies above ~3 cm —
 * blades, grain, pebbles — and a signal with no low-frequency energy left in it
 * cannot draw a lattice however tightly it tiles. Exactly the argument the
 * normal maps have always relied on, applied to albedo.
 */
const TILE_DETAIL_METRES: [number, number, number, number] = [4.0, 3.0, 4.0, 4.5];

/** Which library material feeds each splat layer. */
const LAYER_MATERIAL: [MaterialName, MaterialName, MaterialName, MaterialName] = [
  "sand",
  "grass",
  "dirt",
  "rock",
];

/** Dominant-splat → impact family, for footsteps, decals and bullet puffs. */
const LAYER_IMPACT: [ImpactMaterial, ImpactMaterial, ImpactMaterial, ImpactMaterial] = [
  "sand",
  "grass",
  "dirt",
  "concrete",
];

// ---------------------------------------------------------------------------
// Small maths
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Polynomial smooth minimum — carves a bay without leaving a crease. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Polynomial smooth maximum — welds the peninsula onto the island body. */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

// ---------------------------------------------------------------------------
// Flat pads
// ---------------------------------------------------------------------------

/**
 * A patch of level, grid-aligned ground reserved for a POI.
 *
 * BEYOND THE TYPED INTERFACE. `TerrainService` in types.ts has no field for
 * these, so they ride on the published service object as `pads` and the POI
 * system reads them structurally. Documented here rather than added to the
 * shared contract, which other systems are authoring against right now.
 */
export interface TerrainPad {
  /** Stable id, so a POI can ask for the pad it wants by name. */
  id: string;
  /** Suggested display name. `pois.ts` is free to ignore it. */
  name: string;
  /** Centre, with `y` set to the resolved elevation once the field is baked. */
  center: THREE.Vector3;
  /** Radius of the fully-flat interior, metres. */
  radius: number;
  /** Width of the smoothstep skirt outside `radius`. */
  skirt: number;
  /** Flat elevation, always an exact multiple of `GRID`. */
  elevation: number;
}

interface PadDef {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  skirt: number;
  /** Minimum elevation, in grid cells. Keeps coastal pads out of the surf. */
  minCells?: number;
}

/**
 * Pad placement. Kept clear of the two river channels on purpose: a pad that
 * straddles a river fills it in, and a town with a dry riverbed running under
 * it is the sort of thing a screenshot critic spots immediately.
 */
const PAD_DEFS: PadDef[] = [
  // The big one. Sits on the quantised north-east plain, so its skirt has
  // almost no work to do and the streets come out dead level.
  { id: "neon-heights", name: "Neon Heights", x: 560, z: -600, radius: 250, skirt: 70 },
  { id: "salt-harbor", name: "Salt Harbor", x: 150, z: 870, radius: 140, skirt: 52, minCells: 2 },
  { id: "the-quarry", name: "The Quarry", x: -560, z: -330, radius: 135, skirt: 55 },
  { id: "ridge-station", name: "Ridge Station", x: -330, z: 150, radius: 78, skirt: 44 },
  { id: "mill-hollow", name: "Mill Hollow", x: -260, z: -520, radius: 105, skirt: 44 },
  { id: "palm-cove", name: "Palm Cove", x: 960, z: 345, radius: 112, skirt: 46, minCells: 2 },
  { id: "cargo-yard", name: "Cargo Yard", x: -720, z: 470, radius: 124, skirt: 46 },
  { id: "stonewall", name: "Stonewall Fort", x: -960, z: -600, radius: 92, skirt: 40 },
  { id: "tilted-yard", name: "Tilted Yard", x: 330, z: 420, radius: 132, skirt: 48 },
  { id: "lonely-lookout", name: "Lonely Lookout", x: 930, z: -120, radius: 70, skirt: 36 },
];

// ---------------------------------------------------------------------------
// Rivers
// ---------------------------------------------------------------------------

interface RiverNode {
  x: number;
  z: number;
  /** Bed elevation at this node. Strictly descending toward the sea. */
  y: number;
  /** Channel half-width. */
  w: number;
}

/**
 * Two rivers. The bed elevations descend monotonically and the last node of
 * each is below sea level, so the mouth floods and reads as an estuary instead
 * of a ditch that stops at the beach.
 */
const RIVERS: RiverNode[][] = [
  [
    { x: -230, z: 30, y: 118, w: 15 },
    { x: -90, z: -180, y: 76, w: 19 },
    { x: 60, z: -380, y: 44, w: 24 },
    { x: 150, z: -620, y: 20, w: 30 },
    { x: 200, z: -880, y: 5, w: 38 },
    { x: 215, z: -1160, y: -5, w: 48 },
  ],
  [
    { x: -190, z: 200, y: 112, w: 14 },
    { x: -60, z: 430, y: 64, w: 18 },
    { x: 60, z: 640, y: 30, w: 24 },
    { x: 120, z: 880, y: 8, w: 32 },
    { x: 155, z: 1120, y: -5, w: 42 },
  ],
];

/** Flattened segment table: ax, az, vx, vz, invLenSq, y0, y1, w0, w1. */
const RIVER_STRIDE = 9;

function buildRiverSegments(): Float64Array[] {
  return RIVERS.map((nodes) => {
    const out = new Float64Array((nodes.length - 1) * RIVER_STRIDE);
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const o = i * RIVER_STRIDE;
      out[o] = a.x;
      out[o + 1] = a.z;
      out[o + 2] = vx;
      out[o + 3] = vz;
      out[o + 4] = 1 / Math.max(1e-6, vx * vx + vz * vz);
      out[o + 5] = a.y;
      out[o + 6] = b.y;
      out[o + 7] = a.w;
      out[o + 8] = b.w;
    }
    return out;
  });
}

const RIVER_SEGS = buildRiverSegments();

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

/**
 * What terrain actually publishes. The typed `TerrainService` is the contract
 * every other system is compiled against; the extras below are additive and
 * read structurally by the systems that want them (`pads` by pois, `slopeAt`
 * and `coastDistanceAt` by vegetation and loot scatter).
 */
export interface RoyaleTerrainService extends TerrainService {
  /** Flat, grid-aligned ground reserved for POIs. */
  readonly pads: readonly TerrainPad[];
  /** The pad containing a point, or null. */
  padAt(x: number, z: number): TerrainPad | null;
  /** 0 = flat, 1 = vertical. Cheap surface classification. */
  slopeAt(x: number, z: number): number;
  /** Signed metres to the coastline. Positive inland. */
  coastDistanceAt(x: number, z: number): number;
  /** Metres of water above the ground, 0 on land. */
  waterDepthAt(x: number, z: number): number;
  /** Baked macro ambient occlusion, 0..1. Useful for prop and grass tinting. */
  aoAt(x: number, z: number): number;
  /** Normalised [sand, grass, dirt, rock] cover. Writes into `out` if given. */
  surfaceWeightsAt(x: number, z: number, out?: Float32Array): Float32Array;
  /** Radius of the island body, before the coastline wobble. */
  readonly islandRadius: number;
}

/** One 250 m cell of the world. Owns nothing but its bounds and its slots. */
interface Chunk {
  ix: number;
  iz: number;
  /** Centre in world space. */
  cx: number;
  cz: number;
  box: THREE.Box3;
  /** Distance from the camera to the nearest point of `box`, this frame. */
  dist: number;
  inView: boolean;
  desired: number;
  /** Slot per LOD. Index 3 is resident from boot and never released. */
  owned: (Slot | null)[];
}

/** A reusable set of GPU buffers for one chunk at one LOD. */
interface Slot {
  lod: number;
  segs: number;
  geom: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  pos: Float32Array;
  nrm: Float32Array;
  splat: Uint8Array;
  aux: Uint8Array;
  /** Chunk currently holding this slot, or null when free. */
  chunk: Chunk | null;
  /** False until a build has committed — never show a half-written buffer. */
  ready: boolean;
}

interface BuildJob {
  chunk: Chunk;
  slot: Slot;
  /** True while filling the height halo, false while emitting vertices. */
  sampling: boolean;
  row: number;
  minY: number;
  maxY: number;
}

const createTerrain: SystemFactory = async (ctx) => {
  const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  // Draw from the shared RNG once, then run our own stream: worldgen must not
  // shift because some other system asked ctx.rng for a different count.
  const rng = makeRng(Math.floor(ctx.rng() * 0xffffffff) >>> 0);

  // Independent fields so octaves at different scales never correlate into
  // visible axis-aligned artefacts.
  const nCoast = createNoise2D(rng);
  const nWarp = createNoise2D(rng);
  const nHill = createNoise2D(rng);
  const nRidge = createNoise2D(rng);
  const nDetail = createNoise2D(rng);
  const nDune = createNoise2D(rng);

  type Noise2 = (x: number, y: number) => number;

  /** Fractal Brownian motion, normalised to 0..1. */
  function fbm(n: Noise2, x: number, z: number, octaves: number, lac = 2.03, gain = 0.5): number {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let fx = x;
    let fz = z;
    for (let o = 0; o < octaves; o++) {
      sum += n(fx, fz) * amp;
      norm += amp;
      amp *= gain;
      fx *= lac;
      fz *= lac;
    }
    return sum / norm / 2 + 0.5;
  }

  /** Ridged fractal, 0..1. The |n| fold is what makes mountains, not hills. */
  function ridged(n: Noise2, x: number, z: number, octaves: number): number {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let fx = x;
    let fz = z;
    for (let o = 0; o < octaves; o++) {
      const t = 1 - Math.abs(n(fx, fz));
      sum += t * t * amp;
      norm += amp;
      amp *= 0.5;
      fx *= 2.07;
      fz *= 2.07;
    }
    return sum / norm;
  }

  // -------------------------------------------------------------------------
  // The authored island — evaluated once per lattice cell, never per frame
  // -------------------------------------------------------------------------

  /**
   * Signed distance to the coastline, in metres. Positive inland.
   *
   * The three sines are the coarse shape of the coast and the noise octave is
   * the fine one; between them nothing on this shoreline repeats inside the
   * 3.6 km the player can see. The bay, the peninsula and the two stacks are
   * unioned with smooth min/max so no join shows a crease.
   */
  function coastSdf(x: number, z: number): number {
    const dx = x - ISLE_X;
    const dz = (z - ISLE_Z) * ISLE_SQUASH;
    let d = ISLE_R - Math.sqrt(dx * dx + dz * dz);

    d +=
      Math.sin(x * 0.0031 + z * 0.0017) * 118 +
      Math.sin(x * 0.0072 - z * 0.0059 + 1.9) * 54 +
      Math.sin(z * 0.0128 - 0.6) * 22 +
      nCoast(x * 0.00085, z * 0.00085) * 95;

    // Harbour bay in the south — the reason Salt Harbor is where it is.
    const bay = 260 - Math.hypot((x - 420) * 0.92, (z - 1050) * 1.15);
    d = smin(d, -bay, 90);

    // North-west peninsula. Stonewall Fort stands on it.
    const pen = 215 - Math.hypot((x + 900) * 0.95, (z + 560) * 1.1);
    d = smax(d, pen, 110);

    // Two sea stacks off the cliff coast. Pure silhouette value from the bus.
    const s1 = 64 - Math.hypot(x + 1320, z - 320);
    const s2 = 44 - Math.hypot(x + 1180, z - 620);
    d = Math.max(d, Math.max(s1, s2));

    return d;
  }

  /** 0 on a beach coast, 1 on the cliff coast. Wobbled so it is not a wedge. */
  function cliffFactor(x: number, z: number): number {
    const dx = x - ISLE_X;
    const dz = z - ISLE_Z;
    const r = Math.sqrt(dx * dx + dz * dz) + 1e-3;
    const facing = (dx / r) * CLIFF_DIR_X + (dz / r) * CLIFF_DIR_Z;
    const wobble = 0.58 + 0.42 * (nCoast(x * 0.0021 + 40, z * 0.0021 - 17) * 0.5 + 0.5);
    return clamp01(smoothstep(0.3, 0.86, facing) * wobble);
  }

  /**
   * Elevation of the bare coast profile — seabed offshore, beach or cliff
   * onshore. Everything else in the macro pass adds on top of this.
   */
  function shoreBase(d: number, cliff: number): number {
    if (d <= 0) {
      // Two exponential shelves. The cliff coast plunges; the beach coast has
      // the long shallow apron a swimmable BR needs.
      const gentle = -SHELF_DEPTH * (1 - Math.exp(d / 300));
      const steep = -SHELF_DEPTH * (1 - Math.exp(d / 64));
      return mix(gentle, steep, cliff);
    }
    // Beach: a couple of metres over the first 30 m, then a slow inland rise
    // so the land behind a beach is not a shelf.
    const beach = 5.5 * (1 - Math.exp(-d / 26)) + 16 * smoothstep(0, 300, d);
    const wall = CLIFF_HEIGHT * smoothstep(0, CLIFF_RUN, d) + 14 * smoothstep(CLIFF_RUN, 340, d);
    return mix(beach, wall, cliff);
  }

  /** Highland + rolling hills. Zero at the waterline, full strength inland. */
  function landform(x: number, z: number, d: number): number {
    const inland = smoothstep(0, SHORE_FADE, d);
    if (inland <= 0) return 0;

    // Domain warp. Without it the ridged octaves read as a noise texture with
    // a mountain-shaped mask over it; with it they read as folded rock.
    //
    // AMPLITUDE IS CAPPED ON PURPOSE. The warp stays invertible only while
    // `amplitude * frequency * 2π < 1`; at 0.00092 that is 173 m. Past it the
    // map folds onto itself and the massif grows a caustic — a fan of
    // concentric arcs and radial spokes centred on the peak, which is exactly
    // as bad as it sounds and took a relief render to spot. 110 leaves margin.
    const wx = x + nWarp(x * 0.00092, z * 0.00092) * 110;
    const wz = z + nWarp(x * 0.00092 + 31.7, z * 0.00092 - 12.4) * 110;

    // --- the central highland ---
    const rx = wx - RIDGE.x;
    const rz = wz - RIDGE.z;
    const along = (rx * RIDGE.dx + rz * RIDGE.dz) / RIDGE.halfLength;
    const across = (rx * -RIDGE.dz + rz * RIDGE.dx) / RIDGE.halfWidth;
    // Squared falloff on both axes: a linear one gives a tent, and a tent
    // silhouette is the single most obvious "procedural terrain" tell.
    const mask = clamp01(1 - (along * along + across * across));
    let h = 0;
    if (mask > 0) {
      // Big folds, not fine crinkle: at 0.0011 the ridged octaves have a ~900 m
      // base wavelength, so the massif reads as three or four real peaks with
      // saddles between them rather than as a crumpled sheet.
      const rn = ridged(nRidge, wx * 0.0011, wz * 0.0011, 5);
      // Shaped with mask^1.8. The cube it started as pulled the mountain in so
      // hard it read as a scar in the middle of the island instead of a massif
      // you can see from the north coast.
      const shape = Math.pow(mask, 1.8);
      h += RIDGE.height * shape * (0.34 + 0.66 * rn);
      // Spurs and gullies running off the flanks, peaking at mid-height. Kept
      // at a ~450 m wavelength so they read as ridge lines from a distance and
      // not as combing.
      const flank = mask * (1 - mask) * 4;
      h += (ridged(nRidge, wx * 0.0024 + 9.1, wz * 0.0024 - 3.3, 3) - 0.4) * 34 * flank;
    }

    // --- rolling country everywhere else ---
    // Always additive: a signed term here digs accidental inland lakes, and an
    // unauthored lake in a BR is a place players drown for no reason.
    h += fbm(nHill, x * 0.0012, z * 0.0012, 4) * 52;
    // Foothill ridge lines across the whole island. Ridged and raised to 1.5
    // so the crests are sharp and the ground between them is broad and open —
    // rolling FBM alone gives an undifferentiated quilt with no readable
    // landmarks, and a BR map lives or dies on readable landmarks.
    h += Math.pow(ridged(nRidge, x * 0.0021 + 200, z * 0.0021 - 90, 3), 1.5) * 42;
    h += (fbm(nHill, x * 0.0043 + 17, z * 0.0043 + 5, 3) - 0.5) * 17;

    return h * inland;
  }

  /**
   * Flatten the north-east plain. Returns the new height; `outDamp[0]` gets
   * the detail-noise damping so the plain does not grow its own lumps back.
   */
  function applyPlain(x: number, z: number, h: number, outDamp: Float32Array): number {
    const r = Math.hypot(x - PLAIN.x, z - PLAIN.z) / PLAIN.r;
    if (r >= 1) return h;
    const w = 1 - smoothstep(0.58, 1.0, r);
    outDamp[0] = Math.min(outDamp[0], mix(1, 0.3, w));
    // A whisper of roll survives, or the plain reads as a billiard table from
    // the bus. 2.2 m over 400 m is invisible on foot and legible from the air.
    return mix(h, PLAIN.y + (fbm(nHill, x * 0.0031, z * 0.0031, 2) - 0.5) * 2.2, w);
  }

  /** Carve both rivers: a wide valley, then a narrow channel inside it. */
  function carveRivers(x: number, z: number, h: number, outDamp: Float32Array): number {
    // Meander. The polylines are five straight legs each, and a straight river
    // reads as a canal — measuring the distance from a noise-displaced point
    // instead bends the whole channel without adding a single control node.
    // Amplitude is capped the same way the massif warp is: 45 × 0.0026 × 2π
    // = 0.73, comfortably under the fold threshold.
    const mx = x + nDune(x * 0.0026, z * 0.0026) * 45;
    const mz = z + nDune(x * 0.0026 + 11.3, z * 0.0026 - 7.9) * 45;

    for (let r = 0; r < RIVER_SEGS.length; r++) {
      const seg = RIVER_SEGS[r];
      let bestD = Infinity;
      let bedY = 0;
      let bedW = 0;
      for (let i = 0; i < seg.length; i += RIVER_STRIDE) {
        const ax = seg[i];
        const az = seg[i + 1];
        const vx = seg[i + 2];
        const vz = seg[i + 3];
        let t = ((mx - ax) * vx + (mz - az) * vz) * seg[i + 4];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = mx - ax - t * vx;
        const ez = mz - az - t * vz;
        const dd = Math.sqrt(ex * ex + ez * ez);
        if (dd < bestD) {
          bestD = dd;
          bedY = mix(seg[i + 5], seg[i + 6], t);
          bedW = mix(seg[i + 7], seg[i + 8], t);
        }
      }

      // Valley: five times the channel width, floor 22 m above the bed. This
      // is what makes a river read from 400 m away — the channel itself is
      // barely a pixel at that range, the valley is the whole landform.
      const vw = bedW * 5.5;
      if (bestD < vw) {
        const q = bestD / vw;
        const target = bedY + 22 + q * q * 40;
        const w = 1 - smoothstep(0.55, 1.0, q);
        h += (Math.min(h, target) - h) * w;
      }

      // Channel: the wet bit. Cubic cross-section, so the banks are steep at
      // the water and flatten as they climb.
      const cw = bedW * 1.7;
      if (bestD < cw) {
        const q = clamp01(bestD / bedW);
        const target = bedY + q * q * q * 26;
        const w = 1 - smoothstep(0.62, 1.0, bestD / cw);
        h += (Math.min(h, target) - h) * w;
        outDamp[0] = Math.min(outDamp[0], mix(0.32, 1, q));
      }
    }
    return h;
  }

  // -------------------------------------------------------------------------
  // Pads
  // -------------------------------------------------------------------------

  const pads: TerrainPad[] = [];

  /** Flatten toward every pad, nearest-weight wins. Runs last, so pads rule. */
  function applyPads(x: number, z: number, h: number, d: number, outDamp: Float32Array): number {
    let bestW = 0;
    let bestY = 0;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      const r = Math.hypot(x - p.center.x, z - p.center.z);
      if (r > p.radius + p.skirt) continue;
      const w = 1 - smoothstep(p.radius, p.radius + p.skirt, r);
      if (w > bestW) {
        bestW = w;
        bestY = p.elevation;
      }
    }
    if (bestW <= 0) return h;
    // A pad may never reclaim sea. Salt Harbor's flat ground stops at the
    // waterline and the last few metres become a quay, which is what you want.
    bestW *= smoothstep(-6, 26, d);
    if (bestW <= 0) return h;
    outDamp[0] = Math.min(outDamp[0], 1 - bestW);
    return mix(h, bestY, bestW);
  }

  /** Height, coast distance and detail damping before pads are applied. */
  const baseScratch = new Float32Array(1);

  function baseCell(x: number, z: number, out: Float32Array): void {
    const d = coastSdf(x, z);
    const cliff = cliffFactor(x, z);
    let h = shoreBase(d, cliff);
    baseScratch[0] = 1;
    if (d > 0) {
      h += landform(x, z, d);
      h = applyPlain(x, z, h, baseScratch);
      h = carveRivers(x, z, h, baseScratch);
    }
    out[0] = h;
    out[1] = d;
    out[2] = baseScratch[0];
  }

  // Resolve pad elevations from the terrain underneath them, then quantise to
  // the build grid. Authoring the numbers by hand would drift the moment any
  // landform constant changed; deriving them keeps the two in step forever.
  {
    const cell = new Float32Array(3);
    // Five taps in a cross, so a pad straddling a slope lands on its mean
    // rather than on whatever the exact centre happened to be.
    const TAPS = [
      [0, 0],
      [0.6, 0],
      [-0.6, 0],
      [0, 0.6],
      [0, -0.6],
    ];
    for (const def of PAD_DEFS) {
      let sum = 0;
      let n = 0;
      let minD = Infinity;
      for (const [ox, oz] of TAPS) {
        const px = def.x + ox * def.radius;
        const pz = def.z + oz * def.radius;
        baseCell(px, pz, cell);
        sum += cell[0];
        n++;
        if (cell[1] < minD) minD = cell[1];
      }
      baseCell(def.x, def.z, cell);
      if (cell[1] < 25) {
        // The coastline wobble moved; this pad is in the water. Dropping it is
        // the only safe answer — a POI on a flattened patch of sea is worse
        // than a POI that never spawns.
        console.warn(`[Drop Zero] terrain pad "${def.id}" fell in the sea; dropped.`);
        continue;
      }
      const minY = (def.minCells ?? 1) * GRID;
      const elevation = Math.max(minY, Math.round(sum / n / GRID) * GRID);
      pads.push({
        id: def.id,
        name: def.name,
        center: new THREE.Vector3(def.x, elevation, def.z),
        radius: def.radius,
        skirt: def.skirt,
        elevation,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Bake the macro field
  // -------------------------------------------------------------------------

  const STEP = tier.fieldStep;
  const RES = Math.round((FIELD_EXTENT * 2) / STEP) + 1;
  const INV_STEP = 1 / STEP;
  /** Interleaved [height, coastDistance]. */
  const fMacro = new Float32Array(RES * RES * F_STRIDE);
  /** Detail-noise damping, 0 = pad-flat, 255 = wild. */
  const fDamp = new Uint8Array(RES * RES);
  /** Macro horizon occlusion. Vertex-rate only. */
  const fAo = new Uint8Array(RES * RES);

  {
    const cell = new Float32Array(3);
    // Bake in bands and yield between them: this is ~800 k evaluations on
    // `high` and a loading bar that never repaints looks like a hang.
    const BANDS = 8;
    const rowsPerBand = Math.ceil(RES / BANDS);
    for (let band = 0; band < BANDS; band++) {
      const j0 = band * rowsPerBand;
      const j1 = Math.min(RES, j0 + rowsPerBand);
      for (let j = j0; j < j1; j++) {
        const z = -FIELD_EXTENT + j * STEP;
        for (let i = 0; i < RES; i++) {
          const x = -FIELD_EXTENT + i * STEP;
          baseCell(x, z, cell);
          const c = j * RES + i;
          const h = applyPads(x, z, cell[0], cell[1], baseScratch);
          fMacro[c * F_STRIDE + F_H] = h;
          fMacro[c * F_STRIDE + F_D] = cell[1];
          fDamp[c] = Math.min(cell[2], baseScratch[0]) * 255;
        }
      }
      if (j1 < RES) await breathe();
    }
  }

  await breathe();

  // Macro occlusion: horizon angle in eight directions at three radii. Unlike
  // a shadow map this holds for every sun angle, which matters because the sky
  // system moves the sun — and it is what puts shade in the river valleys and
  // keeps the ridgelines bright at every hour.
  {
    const RAD = [2, 5, 12];
    const DIR = [1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1, 0, -1, 1, -1];
    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        const c = j * RES + i;
        const e = fMacro[c * F_STRIDE + F_H];
        let occ = 0;
        for (let a = 0; a < 8; a++) {
          const ca = DIR[a * 2];
          const sa = DIR[a * 2 + 1];
          let hmax = 0;
          for (let k = 0; k < 3; k++) {
            const si = Math.min(RES - 1, Math.max(0, i + ca * RAD[k]));
            const sj = Math.min(RES - 1, Math.max(0, j + sa * RAD[k]));
            const rise = (fMacro[(sj * RES + si) * F_STRIDE + F_H] - e) / (RAD[k] * STEP);
            if (rise > hmax) hmax = rise;
          }
          occ += hmax / (hmax + 0.85);
        }
        fAo[c] = (1 - clamp01(occ / 8) * 0.82) * 255;
      }
    }
  }

  await breathe();

  // -------------------------------------------------------------------------
  // The ground function
  // -------------------------------------------------------------------------

  /** Shared bilinear tap: [height, coastDistance, damping]. Not reentrant. */
  const tap = new Float32Array(3);

  function sampleField(x: number, z: number): Float32Array {
    let u = (x + FIELD_EXTENT) * INV_STEP;
    let v = (z + FIELD_EXTENT) * INV_STEP;
    const lim = RES - 1.0001;
    u = u < 0 ? 0 : u > lim ? lim : u;
    v = v < 0 ? 0 : v > lim ? lim : v;
    const i = u | 0;
    const j = v | 0;
    const fu = u - i;
    const fv = v - j;
    const c = j * RES + i;
    const o = c * F_STRIDE;
    const row = RES * F_STRIDE;

    for (let k = 0; k < F_STRIDE; k++) {
      const a = fMacro[o + k];
      const b = fMacro[o + F_STRIDE + k];
      const cc = fMacro[o + row + k];
      const dd = fMacro[o + row + F_STRIDE + k];
      const top = a + (b - a) * fu;
      tap[k] = top + (cc + (dd - cc) * fu - top) * fv;
    }

    const d0 = fDamp[c];
    const d1 = fDamp[c + 1];
    const d2 = fDamp[c + RES];
    const d3 = fDamp[c + RES + 1];
    const dt = d0 + (d1 - d0) * fu;
    tap[2] = (dt + (d2 + (d3 - d2) * fu - dt) * fv) * (1 / 255);
    return tap;
  }

  function sampleAo(x: number, z: number): number {
    let u = (x + FIELD_EXTENT) * INV_STEP;
    let v = (z + FIELD_EXTENT) * INV_STEP;
    const lim = RES - 1.0001;
    u = u < 0 ? 0 : u > lim ? lim : u;
    v = v < 0 ? 0 : v > lim ? lim : v;
    const i = u | 0;
    const j = v | 0;
    const fu = u - i;
    const fv = v - j;
    const o = j * RES + i;
    const top = fAo[o] + (fAo[o + 1] - fAo[o]) * fu;
    const bot = fAo[o + RES] + (fAo[o + RES + 1] - fAo[o + RES]) * fu;
    return (top + (bot - top) * fv) * (1 / 255);
  }

  /**
   * Per-octave gain for the analytic detail, indexed by DB_* below.
   *
   * BAND LIMITING — read this before touching the detail octaves.
   *
   * A coarse LOD samples the height function on a grid several metres wide. Any
   * octave whose wavelength is near that spacing aliases, and because the
   * sampling grid is axis-aligned the aliasing does not look like noise — it
   * looks like a *chequerboard*, marching across every open field at exactly
   * the LOD's cell size. It cost a browser render and two wrong hypotheses
   * (texture tiling, then normal maps) to find, and it is the sort of thing a
   * screenshot critic reads instantly as "web game".
   *
   * So the mesher asks for the height band-limited to what its cell can carry,
   * and the octaves it cannot resolve are simply switched off. LOD 0 — the one
   * the player stands on — always asks for the full function, so the surface
   * you collide with and the surface you can see are bit-identical there. The
   * coarser levels differ by at most the amplitude of the octaves they dropped
   * (0.3 m at LOD 1), which is sub-pixel at the distance they are drawn.
   */
  const DB_MID = 0; // ~80 m
  const DB_FINE = 1; // ~37 m
  const DB_GRAIN = 2; // ~14 m
  const DB_DUNE = 3; // ~48 m
  const BAND_FULL = Float32Array.of(1, 1, 1, 1);

  /** Gains for a mesh of `cell` metres. `cell <= 0` means "give me it all". */
  function bandFor(cell: number, out: Float32Array): Float32Array {
    if (cell <= 0) {
      out.set(BAND_FULL);
      return out;
    }
    // Four samples per wavelength is the practical floor for a heightfield;
    // below ~2.2 the beat pattern is already obvious.
    const gate = (wave: number) => smoothstep(cell * 2.2, cell * 4.5, wave);
    out[DB_MID] = gate(80);
    out[DB_FINE] = gate(37);
    out[DB_GRAIN] = gate(14);
    out[DB_DUNE] = gate(48);
    return out;
  }

  /**
   * Ground height. Baked macro layer plus the sub-lattice detail the lattice
   * cannot carry, evaluated analytically so there is no grid to alias against.
   * ~70 ns a call; bots and the capsule solver lean on it hard.
   */
  function heightWith(x: number, z: number, b: Float32Array): number {
    const f = sampleField(x, z);
    let h = f[0];
    const d = f[1];
    const damp = f[2];

    if (d > 0) {
      // Fades in over the first 60 m so no dune ever pokes through the surf.
      const inland = clamp01(d / 60);
      // Metre-scale lumpiness. This is the band that makes a hillside walkable
      // rather than a ramp, and it is damped to nothing under the pads.
      h +=
        (nDetail(x * 0.0125, z * 0.0125) * b[DB_MID] +
          nDetail(x * 0.0268, z * 0.0268) * 0.45 * b[DB_FINE]) *
        2.7 *
        damp *
        inland;
      // Sub-metre grain. Gives footfall and tyre tracks something to read, and
      // costs one noise call.
      if (b[DB_GRAIN] > 0.001) h += nDetail(x * 0.071, z * 0.071) * 0.3 * damp * b[DB_GRAIN];
      // Dunes, only in the beach band and only above the waterline.
      const dune = smoothstep(60, 10, d) * smoothstep(0.5, 4, h) * b[DB_DUNE];
      if (dune > 0.002) h += nDune(x * 0.021, z * 0.021) * 1.6 * dune * damp;
    } else {
      // Seabed. Amplitude tapers to nothing at the waterline so no sandbar
      // breaches the surf line. Its octaves are 140 m and 32 m, and it is only
      // ever seen through water, so it takes the fine gate wholesale.
      const amp = Math.min(1, -d / 45);
      h +=
        (nDetail(x * 0.0072, z * 0.0072) * 2.4 + nDune(x * 0.031, z * 0.031) * 0.7 * b[DB_GRAIN]) *
        amp;
      // Longshore bars, parallel to the coast because they follow the SDF.
      h += Math.sin(d * 0.1) * 0.7 * amp * smoothstep(-240, -15, d) * b[DB_FINE];
    }
    return h;
  }

  /** The authoritative surface. Physics, bots and LOD 0 all use exactly this. */
  function heightAt(x: number, z: number): number {
    return heightWith(x, z, BAND_FULL);
  }

  function normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    // Central differences on the same function the mesh is tessellated from,
    // so the surface you slide on is the surface you can see.
    const e = 0.7;
    const hl = heightAt(x - e, z);
    const hr = heightAt(x + e, z);
    const hd = heightAt(x, z - e);
    const hu = heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  const slopeScratch = new THREE.Vector3();

  function slopeAt(x: number, z: number): number {
    return 1 - normalAt(x, z, slopeScratch).y;
  }

  // -------------------------------------------------------------------------
  // Splat classification
  // -------------------------------------------------------------------------

  const splatOut = new Float32Array(4);

  /**
   * Vertex-rate authority on what the ground is made of. `slope` is 1 - n.y,
   * so a 30° face reads 0.13 and a 55° face 0.43 — the thresholds below have
   * to be read in those terms, not in degrees. The fragment shader sharpens
   * and re-noises these at pixel rate; this is the low-frequency truth.
   */
  function splatAt(x: number, z: number, h: number, slope: number, d: number, cliff: number): Float32Array {
    const rock = clamp01(
      smoothstep(0.16, 0.42, slope) +
        smoothstep(155, 245, h) * 0.6 +
        cliff * smoothstep(4, 34, h) * 0.55,
    );

    if (d <= 0) {
      // Seabed: pale carbonate silt near shore, rock where the shelf breaks.
      splatOut[L_SAND] = 1;
      splatOut[L_GRASS] = 0;
      splatOut[L_DIRT] = 0.12;
      splatOut[L_ROCK] = Math.max(rock * 0.7, smoothstep(-90, -320, d) * 0.5);
    } else {
      const beach = smoothstep(78, 3, d) * (1 - smoothstep(5, 18, h));
      // Above the treeline the grass gives out and the bare ground shows.
      const alpine = smoothstep(130, 210, h);
      // Dirt lives on the *medium* slopes — the band too steep for turf to
      // hold and too shallow to be exposed rock. Getting this window right is
      // most of what stops a heightfield reading as a green blanket.
      const slopeDirt = smoothstep(0.05, 0.19, slope) * (1 - smoothstep(0.2, 0.4, slope));
      // Dry, worn earth in broad patches on otherwise flat ground. One noise
      // tap at vertex rate, and it is the single cheapest thing that stops
      // 80 % of the island reading as one continuous green blanket.
      const dry = clamp01(nHill(x * 0.0034 + 61, z * 0.0034 - 19) * 1.6 - 0.35);
      splatOut[L_SAND] = beach * (1 - rock * 0.8);
      splatOut[L_DIRT] =
        (0.14 + slopeDirt * 0.95 + alpine * 0.45 + dry * 0.6) * (1 - beach) * (1 - rock * 0.7);
      splatOut[L_GRASS] =
        (1 - beach) * (1 - rock) * (1 - alpine * 0.88) * (1 - dry * 0.55) * (0.95 - slopeDirt * 0.5);
      splatOut[L_ROCK] = rock + alpine * 0.3;
    }

    const sum =
      splatOut[0] + splatOut[1] + splatOut[2] + splatOut[3] + 1e-5;
    splatOut[0] /= sum;
    splatOut[1] /= sum;
    splatOut[2] /= sum;
    splatOut[3] /= sum;
    return splatOut;
  }

  function surfaceWeightsAt(x: number, z: number, out?: Float32Array): Float32Array {
    const f = sampleField(x, z);
    const d = f[1];
    const h = heightAt(x, z);
    const w = splatAt(x, z, h, slopeAt(x, z), d, cliffFactor(x, z));
    const dst = out ?? new Float32Array(4);
    dst[0] = w[0];
    dst[1] = w[1];
    dst[2] = w[2];
    dst[3] = w[3];
    return dst;
  }

  function materialAt(x: number, z: number): ImpactMaterial {
    const h = heightAt(x, z);
    if (h < SEA_LEVEL) return "water";
    const w = splatAt(x, z, h, slopeAt(x, z), sampleField(x, z)[1], cliffFactor(x, z));
    let best = 0;
    for (let i = 1; i < 4; i++) if (w[i] > w[best]) best = i;
    return LAYER_IMPACT[best];
  }

  // -------------------------------------------------------------------------
  // Ground material
  // -------------------------------------------------------------------------

  let maxAniso = tier.aniso;
  try {
    maxAniso = Math.min(tier.aniso, ctx.renderer.capabilities.getMaxAnisotropy());
  } catch {
    /* headless — anisotropy is a hint, not a requirement */
  }

  /** Textures this module created and therefore owns. */
  const ownedTextures: THREE.Texture[] = [];

  function makeDataTexture(
    size: number,
    fill: (u: number, v: number, out: Float32Array) => void,
    srgb: boolean,
  ): THREE.DataTexture {
    const data = new Uint8Array(size * size * 4);
    const px = new Float32Array(4);
    const inv = 1 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        fill((x + 0.5) * inv, (y + 0.5) * inv, px);
        const o = (y * size + x) * 4;
        data[o] = clamp01(px[0]) * 255;
        data[o + 1] = clamp01(px[1]) * 255;
        data[o + 2] = clamp01(px[2]) * 255;
        data[o + 3] = clamp01(px[3]) * 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = maxAniso;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    ownedTextures.push(tex);
    return tex;
  }

  /** Tileable value noise on a wrapped lattice. simplex does not tile. */
  function hash2(ix: number, iy: number, seed: number): number {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function vnoise(x: number, y: number, period: number, seed: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % period) + period) % period;
    const y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const a = hash2(x0, y0, seed);
    const b = hash2(x1, y0, seed);
    const c = hash2(x0, y1, seed);
    const e = hash2(x1, y1, seed);
    const top = a + (b - a) * u;
    return top + (c + (e - c) * u - top) * v;
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
   * Large-scale colour variation. R = macro tint, G = warmth, B = layer drift.
   * Linear, not sRGB — this is data. Without it the ground repeats on a
   * visible grid from any elevated position, which is the single loudest tell
   * of procedural terrain and the reason so many web games look like demos.
   */
  const texMacro = makeDataTexture(
    256,
    (u, v, out) => {
      out[0] = fbmT(u, v, 3, 5, 5501);
      out[1] = fbmT(u, v, 5, 4, 8123);
      out[2] = fbmT(u, v, 2, 5, 3307);
      out[3] = 1;
    },
    false,
  );

  /** 4×4 stand-ins so the shader compiles before the library is consulted. */
  const placeholderAlbedo = makeDataTexture(
    4,
    (_u, _v, out) => {
      out[0] = 0.45;
      out[1] = 0.44;
      out[2] = 0.4;
      out[3] = 1;
    },
    true,
  );
  const placeholderNormal = makeDataTexture(
    4,
    (_u, _v, out) => {
      out[0] = 0.5;
      out[1] = 0.5;
      out[2] = 1;
      out[3] = 1;
    },
    false,
  );

  const hazeColor = new THREE.Color(0xa8c8dc);

  const uniforms = {
    uSand: { value: placeholderAlbedo as THREE.Texture },
    uGrass: { value: placeholderAlbedo as THREE.Texture },
    uDirt: { value: placeholderAlbedo as THREE.Texture },
    uRock: { value: placeholderAlbedo as THREE.Texture },
    uSandN: { value: placeholderNormal as THREE.Texture },
    uGrassN: { value: placeholderNormal as THREE.Texture },
    uDirtN: { value: placeholderNormal as THREE.Texture },
    uRockN: { value: placeholderNormal as THREE.Texture },
    uMacro: { value: texMacro as THREE.Texture },
    uHaze: { value: hazeColor },
    uSeaLevel: { value: SEA_LEVEL },
    uTile: {
      value: new THREE.Vector4(
        1 / TILE_METRES[0],
        1 / TILE_METRES[1],
        1 / TILE_METRES[2],
        1 / TILE_METRES[3],
      ),
    },
    uTileN: {
      value: new THREE.Vector4(
        1 / TILE_NORMAL_METRES[0],
        1 / TILE_NORMAL_METRES[1],
        1 / TILE_NORMAL_METRES[2],
        1 / TILE_NORMAL_METRES[3],
      ),
    },
    uTileD: {
      value: new THREE.Vector4(
        1 / TILE_DETAIL_METRES[0],
        1 / TILE_DETAIL_METRES[1],
        1 / TILE_DETAIL_METRES[2],
        1 / TILE_DETAIL_METRES[3],
      ),
    },
    // Base roughness and the per-texel swing around it, per layer. Uniform
    // roughness is what makes a surface read as plastic; sand is matte and
    // even, wet rock is glossy and blotchy, and the difference has to be
    // visible in the specular roll-off or none of this looks expensive.
    //
    // Pulled down and widened from (0.93,0.87,0.90,0.72)/(0.10,0.22,0.18,0.34).
    // Above ~0.9 the GGX lobe is so broad that the whole surface responds to
    // light as pure Lambert: every normal-map bump and every roughness break
    // lands on the same flat shading term, and the ground reads as felt. The
    // relief was there; there was nothing in the BRDF for it to catch.
    uRough: { value: new THREE.Vector4(0.86, 0.78, 0.82, 0.62) },
    uRoughVar: { value: new THREE.Vector4(0.2, 0.34, 0.3, 0.44) },
    // Mean colour per layer, used past the detail-fade distance. Sampling a
    // 5 m tile at 2 km is pure aliasing; a flat mean modulated by the macro
    // map reads better and costs less.
    uAvgSand: { value: new THREE.Color(0.82, 0.74, 0.56) },
    uAvgGrass: { value: new THREE.Color(0.25, 0.4, 0.16) },
    uAvgDirt: { value: new THREE.Color(0.36, 0.27, 0.19) },
    uAvgRock: { value: new THREE.Color(0.46, 0.44, 0.42) },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    dithering: true,
  });
  if (tier.cheap) material.defines = { ...(material.defines ?? {}), DZ_CHEAP: "" };

  /**
   * Chunk names this build of three did not hand us. See `inject`.
   *
   * A `String.replace` whose needle is absent is a silent no-op: the patch
   * evaporates, the material compiles perfectly, and what renders is a plain
   * untextured MeshStandardMaterial — a smooth pastel surface, which is exactly
   * what a broken splat looks like from the outside. There is no way to tell
   * that apart from "the splat ran and the tuning is wrong" by looking at a
   * frame, so it gets checked rather than assumed.
   */
  const injectionFailures: string[] = [];

  function inject(src: string, needle: string, into: string, label: string): string {
    const out = src.replace(needle, into);
    if (out === src) {
      injectionFailures.push(label);
      console.error(
        `[Drop Zero] terrain: shader injection "${label}" FAILED — three r${THREE.REVISION} ` +
          `has no "${needle}" in its physical shader. The ground will render untextured.`,
      );
    }
    return out;
  }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectionFailures.length = 0;

    shader.vertexShader = inject(
      shader.vertexShader,
      "#include <common>",
      /* glsl */ `#include <common>
        attribute vec4 aSplat;
        attribute vec2 aAux;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying vec4 vSplat;
        varying vec2 vAux;`,
      "vert:common",
    );
    shader.vertexShader = inject(
      shader.vertexShader,
      "#include <begin_vertex>",
      /* glsl */ `#include <begin_vertex>
        vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        vWNrm = normalize( mat3( modelMatrix ) * objectNormal );
        vSplat = aSplat;
        vAux = aAux;`,
      "vert:begin_vertex",
    );

    shader.fragmentShader = inject(
      shader.fragmentShader,
      "#include <common>",
        /* glsl */ `#include <common>
        uniform sampler2D uSand;
        uniform sampler2D uGrass;
        uniform sampler2D uDirt;
        uniform sampler2D uRock;
        uniform sampler2D uSandN;
        uniform sampler2D uGrassN;
        uniform sampler2D uDirtN;
        uniform sampler2D uRockN;
        uniform sampler2D uMacro;
        uniform vec3 uHaze;
        uniform vec3 uAvgSand;
        uniform vec3 uAvgGrass;
        uniform vec3 uAvgDirt;
        uniform vec3 uAvgRock;
        uniform vec4 uTile;
        uniform vec4 uTileN;
        uniform vec4 uTileD;
        uniform vec4 uRough;
        uniform vec4 uRoughVar;
        uniform float uSeaLevel;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying vec4 vSplat;
        varying vec2 vAux;

        const vec3 DZ_LUM = vec3( 0.2126, 0.7152, 0.0722 );

        /**
         * Two-tap randomised-offset detiling (Quílez's technique).
         *
         * The tile size in TILE_METRES is what stops the repeat reading as a
         * lattice up close; this is what stops it reading as one from the air,
         * where you can see forty tiles at a time. Each patch of ground gets a
         * different random UV offset and neighbouring patches cross-fade, so
         * the texture still tiles locally but never lines up globally.
         *
         * The selector is a smooth 0..1 field, and how fast it varies is the
         * patch size. A constant UV offset leaves the derivatives untouched, so
         * mip selection stays correct without needing textureGrad; only the one
         * pixel where floor(l) steps sees a wrong gradient, and it sits inside
         * the cross-fade where both taps agree anyway.
         */
        vec3 dzDetile( sampler2D tex, vec2 uv, float v, float mipB ) {
          float l = v * 8.0;
          float fl = floor( l );
          vec2 offa = sin( vec2( 3.0, 7.0 ) * fl );
          vec2 offb = sin( vec2( 3.0, 7.0 ) * ( fl + 1.0 ) );
          vec3 ca = texture2D( tex, uv + offa, mipB ).rgb;
          vec3 cb = texture2D( tex, uv + offb, mipB ).rgb;
          // Blended on the difference between the two taps, so the cross-fade
          // hides itself where they disagree most.
          return mix( ca, cb, smoothstep( 0.2, 0.8, fract( l ) - 0.1 * ( ca.g - cb.g ) ) );
        }

        /** Micro-relief 0..1: luminance minus its own heavily blurred self. */
        float dzRelief( sampler2D tex, vec2 uv, vec3 col, float mipB ) {
          float lo = dot( texture2D( tex, uv, 4.0 + mipB ).rgb, DZ_LUM );
          return clamp( 0.5 + ( dot( col, DZ_LUM ) - lo ) * 2.4, 0.0, 1.0 );
        }

        /**
         * DZ_DETAIL — the map at the rate it was actually painted for, with its
         * low frequencies taken back out. Signed, centred on zero.
         *
         * Two taps of the same sampler: the surface, and the surface three mips
         * up (~8× the current footprint). The difference is only the content
         * finer than that footprint — blades, grain, chips — and because the
         * footprint is measured in screen space the band self-selects: standing
         * on the ground it is centimetre detail, at 200 m the two taps have
         * converged and the term goes to zero on its own. That is both the
         * anti-alias and the distance fade, for free, with no tuned constant.
         *
         * Because everything below the local footprint is subtracted away there
         * is no low-frequency energy left to line up on a grid, which is the one
         * thing that made TILE_METRES unable to go this fine in the first place.
         */
        float dzDetail( sampler2D tex, vec2 uv ) {
          float hi = dot( texture2D( tex, uv ).rgb, DZ_LUM );
          float lo = dot( texture2D( tex, uv, 3.0 ).rgb, DZ_LUM );
          return hi - lo;
        }

        /**
         * Height-weighted splat blend. A linear lerp between two ground
         * textures dissolves one into the other and reads as a smear; letting
         * each layer's own relief bid for the pixel makes the pebbles of one
         * poke up through the grass of the other, so the boundary interlocks.
         * It is the difference between "two textures fading" and "a place
         * where the grass runs out".
         */
        vec4 dzHeightBlend( vec4 w, vec4 relief ) {
          // Additive, not multiplicative. A multiplicative form makes the
          // cutoff scale with the relief, so a pair of dark textures mushes
          // into an even lerp while a pair of bright ones snaps to
          // winner-takes-all — the two failure modes this blend exists to
          // avoid. Weight is worth 2× relief so a layer with no coverage can
          // never punch through on the strength of its own texture alone.
          vec4 hw = w * 2.0 + relief * min( vec4( 1.0 ), w * 8.0 );
          float m = max( max( hw.x, hw.y ), max( hw.z, hw.w ) ) - 0.35;
          vec4 b = max( hw - m, vec4( 0.0 ) );
          return b / ( b.x + b.y + b.z + b.w + 1e-5 );
        }

        void dzSurface( out vec3 oAlb, out float oRough, out vec3 oNrm, out float oAo ) {

          vec3 wN = normalize( vWNrm );
          vec3 p = vWPos;
          float dist = length( p - cameraPosition );

          // --- far-field mip bias --------------------------------------------
          // Carrying the real albedo out to a kilometre and a half is what makes
          // the island read as geography from the bus — but a 20 m tile seen at
          // that range is a few pixels across, and hardware mip selection off
          // screen-space derivatives under-blurs a surface this oblique. The
          // result is a moire lattice crawling over every far ridge, which is
          // the exact artefact TILE_METRES was chosen to avoid. Two and a half
          // mips of extra blur past 300 m costs nothing at that size and makes
          // the fine path converge smoothly onto the mean instead of racing it.
          float mipB = smoothstep( 250.0, 1000.0, dist ) * 3.0;
          // Rock gets a mip more than the rest. It tiles tightest (18 m), it is
          // the one layer the detiler never touches because the triplanar path
          // owns it, and its painted facets are the most regular signature of
          // the four — so it is always the first surface to draw a lattice.
          float mipR = mipB + smoothstep( 220.0, 900.0, dist ) * 1.3;

          // --- variation ---------------------------------------------------
          vec3 mac = texture2D( uMacro, p.xz * 0.00042 ).rgb;
          vec3 mic = texture2D( uMacro, p.xz * 0.0091 ).rgb;
          #ifndef DZ_CHEAP
            // Detile patch selector. ~830 m period, so a patch of ground keeps
            // one UV offset for roughly 50 m — two of the large albedo tiles,
            // which is the window where the repeat is broken but the cross-fade
            // is not itself visible as mush.
            vec3 pat = texture2D( uMacro, p.xz * 0.0012 ).rgb;
          #endif

          // --- splat weights ------------------------------------------------
          float steep = 1.0 - wN.y;
          vec4 w = vSplat;
          // Re-derive rock per pixel: the vertex weight is interpolated, and a
          // lerped cliff edge looks like a smear rather than an edge.
          w.w = max( w.w, smoothstep( 0.16, 0.42, steep ) );
          w.x *= 1.0 + ( mic.r - 0.5 ) * 0.85;
          w.y *= 1.0 + ( mic.g - 0.5 ) * 1.05 + ( mac.b - 0.5 ) * 0.8;
          w.z *= 1.0 + ( mic.b - 0.5 ) * 1.10 - ( mac.b - 0.5 ) * 0.6;
          w = max( w, vec4( 0.0 ) );
          w /= ( w.x + w.y + w.z + w.w + 1e-4 );

          // --- triplanar weights --------------------------------------------
          // Cliffs are the one place a planar XZ projection falls apart: the
          // texture stretches into vertical smears. Project on all three axes
          // and blend by the normal so strata stay horizontal on a vertical
          // face. Only rock pays for it — nothing else lives on a 70° slope.
          vec3 bw = abs( wN ); bw = bw * bw * bw * bw;
          bw /= ( bw.x + bw.y + bw.z + 1e-5 );

          vec2 uvS = p.xz * uTile.x;
          vec2 uvG = p.xz * uTile.y;
          vec2 uvD = p.xz * uTile.z;
          vec2 uvR = p.xz * uTile.w;

          #ifndef DZ_CHEAP
            vec3 cS = dzDetile( uSand, uvS, pat.r, mipB );
            vec3 cG = dzDetile( uGrass, uvG, pat.g, mipB );
            vec3 cD = dzDetile( uDirt, uvD, pat.b, mipB );
            vec3 cR = texture2D( uRock, p.zy * uTile.w, mipR ).rgb * bw.x
                    + texture2D( uRock, uvR, mipR ).rgb * bw.y
                    + texture2D( uRock, p.xy * uTile.w, mipR ).rgb * bw.z;
          #else
            // One tap each: no detiling, no triplanar. The tile size still does
            // most of the work, so what a low-end machine loses is the far-field
            // repeat and stretched cliff faces — not the whole look.
            vec3 cS = texture2D( uSand, uvS, mipB ).rgb;
            vec3 cG = texture2D( uGrass, uvG, mipB ).rgb;
            vec3 cD = texture2D( uDirt, uvD, mipB ).rgb;
            vec3 cR = texture2D( uRock, uvR, mipR ).rgb;
          #endif

          // Relief proxy for the interlocking blend. The library's albedo maps
          // are painted with their own occlusion baked in, so luminance tracks
          // "proud" well — but ONLY once the low frequencies are taken out.
          //
          // Raw luminance also carries each map's big soft blotches, which are
          // the tile signature; feeding those into a blend whose whole job is
          // to sharpen contrast turns a barely-visible repeat into a hard
          // chequerboard across every open field. High-passing against a
          // heavily-biased tap of the same map (mip +4, so ~16× blur) leaves
          // only the pebble-and-clump scale the blend actually wants.
          vec4 relief;
          #ifndef DZ_CHEAP
            relief = vec4(
              dzRelief( uSand,  uvS, cS, mipB ),
              dzRelief( uGrass, uvG, cG, mipB ),
              dzRelief( uDirt,  uvD, cD, mipB ),
              dzRelief( uRock,  uvR, cR, mipR ) );
          #else
            relief = vec4( dot( cS, DZ_LUM ), dot( cG, DZ_LUM ),
                           dot( cD, DZ_LUM ), dot( cR, DZ_LUM ) );
          #endif
          vec4 b = dzHeightBlend( w, relief );

          vec3 fine = cS * b.x + cG * b.y + cD * b.z + cR * b.w;
          vec3 mean = uAvgSand * b.x + uAvgGrass * b.y + uAvgDirt * b.z + uAvgRock * b.w;
          // Was smoothstep( 780.0, 180.0, dist ): every pixel past 780 m was a
          // flat per-layer average. From the bus, from a ridge, from anywhere
          // above head height that is nearly the whole screen — the island had
          // no surface at all in the exact shots that are supposed to sell it.
          // Mip-mapping is what stops a 24 m tile aliasing at range; the mean is
          // only needed once the tile is genuinely sub-pixel, which is 2 km out.
          vec3 alb = mix( mean, fine, smoothstep( 1500.0, 400.0, dist ) );

          // --- detail albedo --------------------------------------------------
          // The band the large tile threw away. See DZ_DETAIL / dzDetail.
          //
          // Taken unconditionally, not inside a distance branch: an implicit-
          // derivative fetch in non-uniform control flow has undefined mip
          // selection, and "undefined" on a ground shader means a band of the
          // hillside picking mip 0 at a kilometre. The gate scales the result
          // instead, and the two taps have converged to zero by then anyway.
          float dGate = smoothstep( 420.0, 90.0, dist );
          float det = dzDetail( uGrass, p.xz * uTileD.y ) * b.y
                    + dzDetail( uDirt,  p.xz * uTileD.z ) * b.z;
          #ifndef DZ_CHEAP
            det += dzDetail( uSand, p.xz * uTileD.x ) * b.x
                 + dzDetail( uRock, p.xz * uTileD.w ) * b.w;
          #else
            // Beach and cliff borrow the two maps already fetched. Wrong map,
            // right frequency band — and a wrong-but-present grain reads far
            // better than a surface with none.
            det += dzDetail( uDirt, p.xz * uTileD.x ) * ( b.x + b.w );
          #endif
          det *= dGate;
          // 2.2 is a lot, and deliberately: this is high-passed luminance with
          // a tiny standard deviation, so anything gentler is invisible and we
          // are back to a pastel slope.
          alb *= clamp( 1.0 + det * 2.2, 0.35, 1.9 );

          // Roughness from the per-texel relief, around a per-layer base.
          // Darker (recessed, damp, shaded) reads rougher; proud reads
          // smoother. This is the variation that stops everything looking
          // moulded from the same plastic.
          vec4 rr = uRough + ( vec4( 0.5 ) - relief ) * uRoughVar;
          oRough = clamp( dot( rr, b ) - det * 1.6, 0.05, 1.0 );

          // Micro occlusion falls straight out of the relief — free contact
          // shading in every crevice of the ground.
          oAo = mix( 1.0, 0.55 + 0.45 * dot( relief, b ), 0.6 );
          oAo *= clamp( 1.0 + det * 1.8, 0.5, 1.0 );

          // --- macro tint ----------------------------------------------------
          alb *= 0.72 + 0.60 * mac.r;
          // A second, tighter octave straight onto the albedo. The splat
          // weights are already jittered by the same field, but where one
          // layer covers everything (open grass, open sand) there is no
          // boundary to jitter, and this is all that is left breaking up the
          // repeat.
          alb *= 0.86 + 0.28 * mic.g;
          // Biome drift, ~800 m across. Pushed well past the old 0.7/0.40: from
          // 600 m up you are looking at three or four of these at once, and if
          // the swing between them is under about 15% the island reads as one
          // painted tone rather than as dry uplands and lush valleys. This is
          // the term that has to make the map look like geography.
          alb = mix( alb, alb * vec3( 1.16, 1.05, 0.78 ), mac.g * 0.85 );         // sun-bleached
          alb = mix( alb, alb * vec3( 0.76, 1.12, 0.74 ), ( 1.0 - mac.g ) * 0.62 * b.y );
          // A third, slower band on the mineral layers, so rock and dirt drift
          // warm to cool across the island instead of being one grey everywhere.
          float mineral = clamp( b.z + b.w, 0.0, 1.0 );
          alb *= mix( vec3( 0.90, 0.95, 1.08 ), vec3( 1.12, 1.00, 0.86 ),
                      clamp( mac.b, 0.0, 1.0 ) ) * mineral + ( 1.0 - mineral );

          // --- baked macro occlusion ------------------------------------------
          alb *= mix( 0.38, 1.0, vAux.x );
          oAo *= mix( 0.55, 1.0, vAux.x );

          // --- the waterline ---------------------------------------------------
          // Wet sand is far darker and far glossier than dry sand. This band is
          // what sells a beach; the water system draws its foam on top of it.
          float above = p.y - uSeaLevel;
          float shore = vAux.y;
          float wet = shore * ( 1.0 - smoothstep( -0.5, 2.0, above ) );
          alb *= mix( 1.0, 0.42, wet );
          oRough = mix( oRough, 0.10, wet );
          // A bleached salt line just above the wet band.
          float salt = shore * smoothstep( 1.4, 2.6, above ) * ( 1.0 - smoothstep( 2.6, 5.2, above ) );
          alb = mix( alb, vec3( 0.94, 0.91, 0.83 ), salt * 0.28 * mic.r );

          // --- the seabed --------------------------------------------------------
          float depth = max( 0.0, uSeaLevel - p.y );
          float sub = smoothstep( 0.0, 0.9, depth );
          alb = mix( alb, alb * mix( vec3( 1.0 ), vec3( 0.30, 0.58, 0.70 ),
                                     smoothstep( 0.0, 32.0, depth ) ), sub );
          oRough = mix( oRough, 0.55, sub );

          // --- normals ------------------------------------------------------------
          // Was smoothstep( 420.0, 60.0 ): relief only existed within 60 m and
          // was gone by 420, so a hillside two hundred metres off — which is
          // what a landscape shot is mostly made of — had a perfectly smooth
          // shading normal. Held to full strength out to 200 m now, and carried
          // (weakening) to 1.1 km; the maps mip down long before they alias.
          float nFade = smoothstep( 1100.0, 200.0, dist );
          // Normals tile ~5× finer than albedo, so they alias ~2.3 mips sooner.
          // Without this the relief that was just turned up shimmers on every
          // distant slope, which is worse than the flat slope it replaced.
          float mipN = mipB + smoothstep( 80.0, 700.0, dist ) * 2.0;
          vec2 tn = vec2( 0.0 );
          #ifndef DZ_CHEAP
            vec3 nS = texture2D( uSandN, p.xz * uTileN.x, mipN ).xyz * 2.0 - 1.0;
            vec3 nD = texture2D( uDirtN, p.xz * uTileN.z, mipN ).xyz * 2.0 - 1.0;
            tn += nS.xy * b.x + nD.xy * b.z;
          #else
            // Even the cheap tier gets dirt: bare earth is what the splat falls
            // back to on every slope and path, and with only grass wired up it
            // was the one surface guaranteed to render dead flat.
            vec3 nD = texture2D( uDirtN, p.xz * uTileN.z, mipN ).xyz * 2.0 - 1.0;
            tn += nD.xy * ( b.x + b.z );
          #endif
          vec3 nG = texture2D( uGrassN, p.xz * uTileN.y, mipN ).xyz * 2.0 - 1.0;
          tn += nG.xy * b.y;
          tn *= nFade;

          // Tangent frame off the least-aligned world axis, so it never
          // degenerates however the ground is tilted.
          vec3 a = abs( wN );
          vec3 ref = ( a.x <= a.y && a.x <= a.z ) ? vec3( 1.0, 0.0, 0.0 )
                   : ( a.y <= a.z ) ? vec3( 0.0, 1.0, 0.0 ) : vec3( 0.0, 0.0, 1.0 );
          vec3 T = normalize( cross( ref, wN ) );
          vec3 B = cross( wN, T );
          // 1.5, up from 0.9. The library paints these maps for a 3–4 m tile on
          // a wall, where the geometry underneath is flat; on ground seen at a
          // grazing angle the same perturbation subtends a fraction as much
          // screen space and needs to shout to be seen at all.
          vec3 nGround = normalize( wN + T * tn.x * 1.5 + B * tn.y * 1.5 );

          #ifndef DZ_CHEAP
            // Whiteout-style triplanar normal blend: swizzle each projection's
            // tangent normal into world space and weight it the same way the
            // albedo was weighted, so cliff relief lines up with cliff colour.
            vec3 rx = texture2D( uRockN, p.zy * uTileN.w, mipN ).xyz * 2.0 - 1.0;
            vec3 ry = texture2D( uRockN, p.xz * uTileN.w, mipN ).xyz * 2.0 - 1.0;
            vec3 rz = texture2D( uRockN, p.xy * uTileN.w, mipN ).xyz * 2.0 - 1.0;
            vec3 nx = vec3( rx.xy + wN.zy, abs( rx.z ) * wN.x ).zyx;
            vec3 ny = vec3( ry.xy + wN.xz, abs( ry.z ) * wN.y ).xzy;
            vec3 nz = vec3( rz.xy + wN.xy, abs( rz.z ) * wN.z ).xyz;
            vec3 nRock = normalize( nx * bw.x + ny * bw.y + nz * bw.z );
            oNrm = normalize( mix( nGround, nRock, b.w * ( 0.3 + 0.7 * nFade ) ) );
          #else
            oNrm = nGround;
          #endif

          // --- aerial perspective ---------------------------------------------------
          // Fog alone turns distance grey. Bleeding the saturation out of the
          // albedo first is what makes 3 km read as 3 km rather than as a
          // foggy 300 m — without this a landscape looks like a diorama.
          float ap = smoothstep( 300.0, 3000.0, dist );
          float lum = dot( alb, DZ_LUM );
          alb = mix( alb, mix( vec3( lum ), uHaze, 0.6 ), ap * 0.44 );

          oAlb = alb;
        }`,
      "frag:common",
    );
    shader.fragmentShader = inject(
      shader.fragmentShader,
      "#include <map_fragment>",
      /* glsl */ `
        vec3 dzAlbedo; float dzRough; vec3 dzNormal; float dzAo;
        dzSurface( dzAlbedo, dzRough, dzNormal, dzAo );
        diffuseColor.rgb *= dzAlbedo;`,
      "frag:map_fragment",
    );
    shader.fragmentShader = inject(
      shader.fragmentShader,
      "#include <roughnessmap_fragment>",
      /* glsl */ `float roughnessFactor = clamp( dzRough, 0.05, 1.0 );`,
      "frag:roughnessmap_fragment",
    );
    shader.fragmentShader = inject(
      shader.fragmentShader,
      "#include <normal_fragment_maps>",
      /* glsl */ `normal = normalize( ( viewMatrix * vec4( dzNormal, 0.0 ) ).xyz );`,
      "frag:normal_fragment_maps",
    );
    shader.fragmentShader = inject(
      shader.fragmentShader,
      "#include <aomap_fragment>",
      /* glsl */ `reflectedLight.indirectDiffuse *= dzAo;`,
      "frag:aomap_fragment",
    );

    // One line, once, saying whether the ground is actually being shaded by
    // this module or by a stock standard material. Reading it off a frame is
    // impossible; reading it off the console takes a second.
    const ok = injectionFailures.length === 0;
    const usesSplat = shader.fragmentShader.includes("dzSurface(");
    ctx.emit("dz:terrain-shader", {
      injected: ok && usesSplat,
      failures: injectionFailures.slice(),
      revision: THREE.REVISION,
      cheap: tier.cheap,
    });
    if (ok && usesSplat) {
      console.info(
        `[Drop Zero] terrain: splat shader injected (three r${THREE.REVISION}, ` +
          `${tier.cheap ? "cheap" : "full"} path).`,
      );
    }
  };

  /**
   * Adopt the shared library's ground maps.
   *
   * Deliberately NOT done at factory time: materials boots first, but boot
   * order is a promise about sequence, not about success, and a system that
   * reaches for a service in its constructor is a system that dies when its
   * neighbour throws. The engine runs every update before the first render,
   * so this lands with zero grey frames.
   */
  let mapsResolved = false;
  let resolveTries = 0;

  /**
   * Returns true only when all four layers ended up on a real map.
   *
   * Anything still pointing at a 4×4 placeholder shades as one flat tone, so
   * "the service answered" is not the success condition — "the textures are
   * bigger than the stand-ins" is. Reported per layer, because losing one of
   * the four is a subtler and much more confusing failure than losing all of
   * them: three quarters of the island looks right.
   */
  function adoptMaps(mats: MaterialsService): boolean {
    const slots: [MaterialName, "uSand" | "uGrass" | "uDirt" | "uRock", "uSandN" | "uGrassN" | "uDirtN" | "uRockN"][] = [
      [LAYER_MATERIAL[L_SAND], "uSand", "uSandN"],
      [LAYER_MATERIAL[L_GRASS], "uGrass", "uGrassN"],
      [LAYER_MATERIAL[L_DIRT], "uDirt", "uDirtN"],
      [LAYER_MATERIAL[L_ROCK], "uRock", "uRockN"],
    ];
    const missing: string[] = [];
    for (const [name, albedoKey, normalKey] of slots) {
      let src: THREE.MeshStandardMaterial | null = null;
      try {
        src = mats.get(name) as THREE.MeshStandardMaterial;
      } catch (err) {
        console.warn(`[Drop Zero] terrain could not fetch material "${name}"`, err);
      }
      // These textures belong to the material library. We borrow them and must
      // never dispose them — ownedTextures is the list we are allowed to free.
      if (src?.map) uniforms[albedoKey].value = src.map;
      if (src?.normalMap) uniforms[normalKey].value = src.normalMap;

      // A 1×1 or 4×4 image is either our own placeholder or the library's
      // canvas-less fallback. Either way there is no texture content in it, and
      // the detail tap will return a constant zero for that layer.
      const img = uniforms[albedoKey].value.image as { width?: number } | undefined;
      if (!src?.map || !src?.normalMap || (img?.width ?? 0) < 64) missing.push(name);
    }
    if (missing.length) {
      console.warn(
        `[Drop Zero] terrain: ground maps unresolved for [${missing.join(", ")}] — ` +
          `those layers will render as a flat tone.`,
      );
    }
    return missing.length === 0;
  }

  // -------------------------------------------------------------------------
  // Chunked LOD mesh
  // -------------------------------------------------------------------------

  const root = new THREE.Group();
  root.name = "dz.terrain";
  root.matrixAutoUpdate = false;
  ctx.scene.add(root);

  /**
   * The camera the previous frame was actually rendered with.
   *
   * `ctx.camera` is the right answer in play, but it is only the camera as of
   * the update pass; anything that re-poses the camera afterwards (the capture
   * harness poses in `renderOverride`) leaves LOD selection chasing a viewpoint
   * nobody is looking from. three hands every rendered mesh the real camera, so
   * we take it from there and use it next frame — one frame of lag on a
   * streaming decision is invisible, and it makes the level of detail track the
   * picture rather than the simulation.
   */
  let renderCamera: THREE.Camera | null = null;
  const noteRenderCamera: THREE.Mesh["onBeforeRender"] = (_r, _s, cam) => {
    renderCamera = cam;
  };

  const LOD_SEGS = tier.segs;
  const MAX_SEGS = LOD_SEGS[0];
  const HALO = MAX_SEGS + 3;

  // One shared scratch set: only one chunk is ever mid-build.
  const scratchH = new Float32Array(HALO * HALO);
  const scratchD = new Float32Array(HALO * HALO);
  const scratchC = new Float32Array(HALO * HALO);

  /**
   * Index buffers are shared across every chunk at a given LOD — the topology
   * of a regular grid plus its skirt does not depend on where the grid is.
   * 196 chunks × 4 levels would otherwise be 784 identical index buffers.
   */
  const sharedIndex: THREE.BufferAttribute[] = [];

  function buildIndexFor(segs: number): THREE.BufferAttribute {
    const gridVerts = (segs + 1) * (segs + 1);
    const tris = segs * segs * 2 + segs * 8;
    const idx = new Uint16Array(tris * 3);
    let w = 0;
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * (segs + 1) + i;
        const b = a + (segs + 1);
        idx[w++] = a;
        idx[w++] = b;
        idx[w++] = b + 1;
        idx[w++] = a;
        idx[w++] = b + 1;
        idx[w++] = a + 1;
      }
    }
    // Skirt. Four edges, each an apron hanging below the border vertices.
    // Winding is per-edge: a back-faced skirt is an invisible skirt, and an
    // invisible skirt means visible cracks at every LOD boundary.
    const S0 = gridVerts;
    const n = segs + 1;
    for (let k = 0; k < segs; k++) {
      // north (j = 0, facing -Z)
      const gN = k;
      const sN = S0 + k;
      idx[w++] = gN; idx[w++] = sN + 1; idx[w++] = sN;
      idx[w++] = gN; idx[w++] = gN + 1; idx[w++] = sN + 1;
      // south (j = segs, facing +Z)
      const gS = segs * n + k;
      const sS = S0 + n + k;
      idx[w++] = gS; idx[w++] = sS; idx[w++] = sS + 1;
      idx[w++] = gS; idx[w++] = sS + 1; idx[w++] = gS + 1;
      // west (i = 0, facing -X)
      const gW = k * n;
      const sW = S0 + 2 * n + k;
      idx[w++] = gW; idx[w++] = sW; idx[w++] = sW + 1;
      idx[w++] = gW; idx[w++] = sW + 1; idx[w++] = gW + n;
      // east (i = segs, facing +X)
      const gE = k * n + segs;
      const sE = S0 + 3 * n + k;
      idx[w++] = gE; idx[w++] = sE + 1; idx[w++] = sE;
      idx[w++] = gE; idx[w++] = gE + n; idx[w++] = sE + 1;
    }
    return new THREE.BufferAttribute(idx, 1);
  }

  for (let l = 0; l < 4; l++) sharedIndex.push(buildIndexFor(LOD_SEGS[l]));

  function makeSlot(lod: number): Slot {
    const segs = LOD_SEGS[lod];
    const n = segs + 1;
    const verts = n * n + 4 * n;
    const pos = new Float32Array(verts * 3);
    const nrm = new Float32Array(verts * 3);
    const splat = new Uint8Array(verts * 4);
    const aux = new Uint8Array(verts * 2);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute("aSplat", new THREE.BufferAttribute(splat, 4, true));
    geom.setAttribute("aAux", new THREE.BufferAttribute(aux, 2, true));
    geom.setIndex(sharedIndex[lod]);
    // We maintain this by hand in `commit` rather than letting three derive it,
    // because the vertex buffer is rewritten in place and a recompute per
    // rebuild would walk every vertex twice. It has to be RIGHT, though: it is
    // what three frustum-culls against. See the note on `frustumCulled` below.
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CHUNK * 1.5);

    const mesh = new THREE.Mesh(geom, material);
    mesh.name = `dz.terrain.lod${lod}`;
    /**
     * FRUSTUM CULLING BELONGS TO THREE, NOT TO US.
     *
     * This was false, and the chunk was shown or hidden by a frustum this
     * module built itself in `lateUpdate` from `ctx.camera`. That is a bet that
     * the camera which will render the frame is the camera we just looked at,
     * and the bet does not always pay: anything that re-poses the camera after
     * the update pass — the capture harness does exactly this, in
     * `renderOverride` — renders from a camera whose frustum the terrain never
     * saw. Every chunk then holds the previous camera's answer, and with the
     * old camera pointed away from the island that answer is "hidden" for all
     * 121 of them. The ground does not render at all, the water plane shows
     * through where the island should be, and the frame reads as a flat white
     * sheet — which is exactly what it looks like when the splat shader is
     * broken, so it gets misdiagnosed as one.
     *
     * three culls against the camera it is actually rendering with, so it
     * cannot be wrong in that way. Distance and LOD selection stay ours (they
     * are streaming hints and tolerate a frame of lag); presence does not.
     */
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    // Terrain deliberately does not cast: at cascade sizes of 135–900 m a
    // heightfield shadowing itself is all acne and no shadow. The baked macro
    // AO carries the large-scale occlusion instead.
    mesh.castShadow = false;
    mesh.visible = false;
    mesh.onBeforeRender = noteRenderCamera;
    root.add(mesh);

    return { lod, segs, geom, mesh, pos, nrm, splat, aux, chunk: null, ready: false };
  }

  const pools: Slot[][] = [[], [], [], []];
  for (let l = 0; l < 3; l++) {
    for (let i = 0; i < tier.pool[l]; i++) pools[l].push(makeSlot(l));
  }

  // --- chunks ---------------------------------------------------------------

  const chunks: Chunk[] = [];
  const half = (CHUNKS * CHUNK) / 2;
  for (let iz = 0; iz < CHUNKS; iz++) {
    for (let ix = 0; ix < CHUNKS; ix++) {
      const cx = -half + (ix + 0.5) * CHUNK;
      const cz = -half + (iz + 0.5) * CHUNK;
      chunks.push({
        ix,
        iz,
        cx,
        cz,
        box: new THREE.Box3(
          new THREE.Vector3(cx - CHUNK / 2, -SHELF_DEPTH, cz - CHUNK / 2),
          new THREE.Vector3(cx + CHUNK / 2, RIDGE.height + 80, cz + CHUNK / 2),
        ),
        dist: 0,
        inView: false,
        desired: 3,
        owned: [null, null, null, null],
      });
    }
  }
  // The coarsest level is resident: every chunk keeps one forever, so there is
  // never a frame where a piece of the world has nothing drawn for it.
  for (const chunk of chunks) {
    const slot = makeSlot(3);
    slot.chunk = chunk;
    chunk.owned[3] = slot;
    pools[3].push(slot);
  }

  // --- tessellation ---------------------------------------------------------

  function startJob(chunk: Chunk, slot: Slot): BuildJob {
    return { chunk, slot, sampling: true, row: 0, minY: Infinity, maxY: -Infinity };
  }

  /** Per-job octave gains. See BAND LIMITING on `bandFor`. */
  const jobBand = new Float32Array(4);

  /** Fill the height halo for a build. One extra ring, for clean normals. */
  function sampleRows(job: BuildJob, budget: number): number {
    const segs = job.slot.segs;
    const cell = CHUNK / segs;
    const span = segs + 3;
    const x0 = job.chunk.cx - CHUNK / 2 - cell;
    const z0 = job.chunk.cz - CHUNK / 2 - cell;
    // LOD 0 asks for the exact function, whatever its cell size works out to on
    // this tier — the ground under the player must match collision exactly.
    bandFor(job.slot.lod === 0 ? 0 : cell, jobBand);
    let done = 0;
    while (job.row < span) {
      const z = z0 + job.row * cell;
      // Stride is this LOD's own span, not HALO: the scratch buffers are sized
      // for the finest level and every coarser one simply uses less of them.
      const o = job.row * span;
      for (let i = 0; i < span; i++) {
        const x = x0 + i * cell;
        scratchH[o + i] = heightWith(x, z, jobBand);
        // heightAt just tapped the field for this exact point — keep the two
        // channels the vertex pass wants instead of tapping again for them.
        scratchD[o + i] = tap[1];
        scratchC[o + i] = cliffFactor(x, z);
      }
      job.row++;
      done += span;
      if (done >= budget) break;
    }
    return done;
  }

  function emitRows(job: BuildJob, budget: number): number {
    const { slot, chunk } = job;
    const segs = slot.segs;
    const n = segs + 1;
    const cell = CHUNK / segs;
    const span = segs + 3;
    const x0 = chunk.cx - CHUNK / 2;
    const z0 = chunk.cz - CHUNK / 2;
    let done = 0;

    while (job.row <= segs) {
      const j = job.row;
      const wz = z0 + j * cell;
      const lz = j * cell - CHUNK / 2;
      for (let i = 0; i <= segs; i++) {
        const wx = x0 + i * cell;
        const lx = i * cell - CHUNK / 2;
        const hi = (j + 1) * span + (i + 1);
        const h = scratchH[hi];

        // Normals straight off the halo: no extra height calls, and they agree
        // across chunk borders because the underlying function does.
        const nx = scratchH[hi - 1] - scratchH[hi + 1];
        const nz = scratchH[hi - span] - scratchH[hi + span];
        const inv = 1 / Math.sqrt(nx * nx + nz * nz + 4 * cell * cell);
        const ny = 2 * cell * inv;

        const v = j * n + i;
        slot.pos[v * 3] = lx;
        slot.pos[v * 3 + 1] = h;
        slot.pos[v * 3 + 2] = lz;
        slot.nrm[v * 3] = nx * inv;
        slot.nrm[v * 3 + 1] = ny;
        slot.nrm[v * 3 + 2] = nz * inv;

        const d = scratchD[hi];
        const s = splatAt(wx, wz, h, 1 - ny, d, scratchC[hi]);
        slot.splat[v * 4] = s[0] * 255;
        slot.splat[v * 4 + 1] = s[1] * 255;
        slot.splat[v * 4 + 2] = s[2] * 255;
        slot.splat[v * 4 + 3] = s[3] * 255;

        // Macro occlusion × local cavity. The cavity term is free — it falls
        // out of the halo we already sampled — and it is what darkens gullies
        // and puts a bright lip on every dune and bank.
        const cav = clamp01(
          0.55 +
            ((h -
              (scratchH[hi - 1] + scratchH[hi + 1] + scratchH[hi - span] + scratchH[hi + span]) *
                0.25) /
              (cell * 0.9)) *
              0.3,
        );
        slot.aux[v * 2] = clamp01(sampleAo(wx, wz) * (0.5 + 0.5 * cav)) * 255;
        slot.aux[v * 2 + 1] = (1 - smoothstep(0, 45, Math.abs(d))) * 255;

        if (h < job.minY) job.minY = h;
        if (h > job.maxY) job.maxY = h;
      }
      job.row++;
      done += n;
      if (done >= budget) break;
    }
    return done;
  }

  /**
   * Hang the skirt. Depth scales with the cell size, because the worst crack
   * an LOD transition can open is roughly half a cell of the coarser level
   * times the local slope — three cells is generous at every level and still
   * short enough that the apron never pokes out of a ridge below it.
   */
  function emitSkirt(slot: Slot, segs: number): void {
    const n = segs + 1;
    const cell = CHUNK / segs;
    const depth = Math.max(2.5, cell * 3);
    const base = n * n;
    const copy = (dst: number, src: number) => {
      slot.pos[dst * 3] = slot.pos[src * 3];
      slot.pos[dst * 3 + 1] = slot.pos[src * 3 + 1] - depth;
      slot.pos[dst * 3 + 2] = slot.pos[src * 3 + 2];
      slot.nrm[dst * 3] = slot.nrm[src * 3];
      slot.nrm[dst * 3 + 1] = slot.nrm[src * 3 + 1];
      slot.nrm[dst * 3 + 2] = slot.nrm[src * 3 + 2];
      slot.splat[dst * 4] = slot.splat[src * 4];
      slot.splat[dst * 4 + 1] = slot.splat[src * 4 + 1];
      slot.splat[dst * 4 + 2] = slot.splat[src * 4 + 2];
      slot.splat[dst * 4 + 3] = slot.splat[src * 4 + 3];
      slot.aux[dst * 2] = slot.aux[src * 2];
      slot.aux[dst * 2 + 1] = slot.aux[src * 2 + 1];
    };
    for (let k = 0; k < n; k++) {
      copy(base + k, k); // north
      copy(base + n + k, segs * n + k); // south
      copy(base + 2 * n + k, k * n); // west
      copy(base + 3 * n + k, k * n + segs); // east
    }
  }

  function commit(job: BuildJob): void {
    const { slot, chunk } = job;
    emitSkirt(slot, slot.segs);
    slot.geom.attributes.position.needsUpdate = true;
    slot.geom.attributes.normal.needsUpdate = true;
    slot.geom.attributes.aSplat.needsUpdate = true;
    slot.geom.attributes.aAux.needsUpdate = true;
    slot.mesh.position.set(chunk.cx, 0, chunk.cz);
    slot.mesh.updateMatrix();
    const sphere = slot.geom.boundingSphere as THREE.Sphere;
    sphere.center.set(0, (job.minY + job.maxY) * 0.5, 0);
    // The skirt hangs `depth` below the lowest vertex and is part of the mesh,
    // so it is part of the bounds. Leaving it out understated the sphere by up
    // to 75 m at the coarsest level, and now that three culls against this
    // sphere an understated one is a chunk that pops out at the screen edge.
    sphere.radius =
      Math.sqrt(CHUNK * CHUNK * 0.5 + Math.pow((job.maxY - job.minY) * 0.5, 2)) +
      Math.max(2.5, (CHUNK / slot.segs) * 3) +
      CHUNK * 0.1;
    slot.ready = true;

    // The coarsest level is the one that defines the chunk's real vertical
    // bounds, and it is built first, so this is always the tightest box we
    // will get. Padded for the detail the finer levels add on top.
    if (slot.lod === 3) {
      chunk.box.min.y = job.minY - 20;
      chunk.box.max.y = job.maxY + 20;
    }
  }

  /**
   * Advance a job across both phases. Returns the vertices actually spent, and
   * sets jobDone when the job committed — the scheduler needs both numbers,
   * and returning the pair through a module-scoped flag keeps the hot path
   * allocation-free.
   */
  let jobDone = false;

  function advance(job: BuildJob, budget: number): number {
    jobDone = false;
    let spent = 0;
    if (job.sampling) {
      spent += sampleRows(job, budget);
      if (job.row < job.slot.segs + 3) return spent;
      job.sampling = false;
      job.row = 0;
      if (spent >= budget) return spent;
    }
    spent += emitRows(job, budget - spent);
    if (job.row <= job.slot.segs) return spent;
    commit(job);
    jobDone = true;
    return spent;
  }

  // Build the resident level for every chunk now, synchronously. ~32 k height
  // samples on high; a few milliseconds for a world that is correct on its
  // very first frame.
  for (const chunk of chunks) {
    const slot = chunk.owned[3];
    if (slot) advance(startJob(chunk, slot), Number.MAX_SAFE_INTEGER);
  }

  await breathe();

  // --- slot scheduling -------------------------------------------------------

  const jobs: BuildJob[] = [];

  function releaseSlot(slot: Slot): void {
    if (slot.chunk) {
      slot.chunk.owned[slot.lod] = null;
      slot.chunk = null;
    }
    slot.ready = false;
    slot.mesh.visible = false;
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].slot === slot) jobs.splice(i, 1);
  }

  /**
   * Hand a chunk a slot at lod, evicting if the pool is full.
   *
   * Eviction is least-useful-first: an out-of-view holder goes before any
   * in-view one, then the most distant. The * 0.85 guard is anti-thrash —
   * we only steal from a chunk that is meaningfully further away, or two
   * chunks at the same range trade the slot back and forth every frame and
   * neither ever finishes building.
   */
  function acquireSlot(chunk: Chunk, lod: number): Slot | null {
    const pool = pools[lod];
    for (const s of pool) if (!s.chunk) return s;

    let victim: Slot | null = null;
    let bestScore = -Infinity;
    for (const s of pool) {
      const owner = s.chunk;
      if (!owner || owner === chunk) continue;
      const score = owner.inView ? owner.dist : 1e6 + owner.dist;
      if (score > bestScore) {
        bestScore = score;
        victim = s;
      }
    }
    if (!victim || !victim.chunk) return null;
    const owner = victim.chunk;
    if (owner.inView && owner.dist * 0.85 <= chunk.dist) return null;
    releaseSlot(victim);
    return victim;
  }

  function lodFor(dist: number): number {
    if (dist < tier.lodDist[0]) return 0;
    if (dist < tier.lodDist[1]) return 1;
    if (dist < tier.lodDist[2]) return 2;
    return 3;
  }

  const camPos = new THREE.Vector3();
  const boxPoint = new THREE.Vector3();
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const viewInverse = new THREE.Matrix4();
  /** Reused request list — this runs every frame and must not churn the GC. */
  const wanting: Chunk[] = [];
  const byDistance = (a: { dist: number }, b: { dist: number }) => a.dist - b.dist;
  const byJobDistance = (a: BuildJob, b: BuildJob) => a.chunk.dist - b.chunk.dist;

  function refreshLod(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    camPos.setFromMatrixPosition(camera.matrixWorld);
    viewInverse.copy(camera.matrixWorld).invert();
    projScreen.multiplyMatrices(camera.projectionMatrix, viewInverse);
    frustum.setFromProjectionMatrix(projScreen);

    wanting.length = 0;
    for (const chunk of chunks) {
      chunk.box.clampPoint(camPos, boxPoint);
      chunk.dist = boxPoint.distanceTo(camPos);
      chunk.inView = chunk.dist < tier.cull && frustum.intersectsBox(chunk.box);
      // Desire is a function of distance ALONE, never of visibility. Tying it
      // to the frustum means every mouse flick releases and re-requests half
      // the map, and nothing near the player ever finishes building.
      chunk.desired = chunk.dist < tier.cull ? lodFor(chunk.dist) : 3;

      // Give back anything finer than we now need, so a player running across
      // the map does not leave a trail of pinned LOD 0 slots behind them.
      for (let l = 0; l < chunk.desired; l++) {
        const s = chunk.owned[l];
        if (s) releaseSlot(s);
      }
      if (chunk.inView && chunk.desired < 3 && !chunk.owned[chunk.desired]) wanting.push(chunk);
    }

    // Request, nearest first: whatever is under the player's nose upgrades
    // before anything on the horizon does.
    wanting.sort(byDistance);
    for (const chunk of wanting) {
      const slot = acquireSlot(chunk, chunk.desired);
      if (!slot) continue; // pool is full of nearer work; this chunk waits
      slot.chunk = chunk;
      slot.ready = false;
      chunk.owned[chunk.desired] = slot;
      jobs.push(startJob(chunk, slot));
    }

    // Spend the vertex budget on the nearest outstanding job. Nothing reaches
    // the GPU until a job commits — the driver only sees a buffer when
    // needsUpdate flips — so a half-built chunk is invisible, not torn.
    if (jobs.length) {
      jobs.sort(byJobDistance);
      // A backed-up queue means a teleport, a bus drop or a glide; spend more
      // rather than let the player outrun their own ground.
      let budget = tier.budget * (jobs.length > 4 ? 2 : 1);
      while (jobs.length && budget > 0) {
        const spent = advance(jobs[0], budget);
        if (jobDone) jobs.shift();
        // Guard against a zero-spend iteration (an already-finished phase with
        // no budget left) turning this into an infinite loop.
        budget -= Math.max(1, spent);
      }
    }

    // Finally decide what is DRAWABLE: the finest committed slot each chunk
    // owns, and nothing else. Deliberately not gated on `inView` — see the
    // note on `frustumCulled` in `makeSlot`. A chunk outside the view costs one
    // sphere test in three's projectObject and is then skipped; a chunk wrongly
    // marked invisible here is a hole in the world.
    for (const chunk of chunks) {
      let shown = false;
      for (let l = 0; l < 4; l++) {
        const s = chunk.owned[l];
        if (!s) continue;
        const show = !shown && s.ready;
        s.mesh.visible = show;
        if (show) shown = true;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Service
  // -------------------------------------------------------------------------

  const service: RoyaleTerrainService = {
    heightAt,
    normalAt,
    isWater(x, z) {
      return heightAt(x, z) < SEA_LEVEL;
    },
    materialAt,
    slopeAt,
    surfaceWeightsAt,
    coastDistanceAt(x, z) {
      return sampleField(x, z)[1];
    },
    waterDepthAt(x, z) {
      return Math.max(0, SEA_LEVEL - heightAt(x, z));
    },
    aoAt: sampleAo,
    padAt(x, z) {
      for (const p of pads) {
        const dx = x - p.center.x;
        const dz = z - p.center.z;
        if (dx * dx + dz * dz <= p.radius * p.radius) return p;
      }
      return null;
    },
    pads,
    islandRadius: ISLE_R,
    worldSize: WORLD_SIZE,
    seaLevel: SEA_LEVEL,
  };
  ctx.services.terrain = service;

  ctx.emit("dz:terrain-ready", {
    worldSize: WORLD_SIZE,
    seaLevel: SEA_LEVEL,
    chunks: chunks.length,
    pads: pads.map((p) => ({ id: p.id, name: p.name, x: p.center.x, z: p.center.z, y: p.elevation })),
  });

  // -------------------------------------------------------------------------

  const sys: System = {
    name: "terrain",

    update(_dt, c) {
      if (!mapsResolved) {
        const mats = c.services.materials;
        // Retried until every layer is on a real map, not latched on the first
        // frame the service happens to exist: the library bakes lazily, and a
        // slot that came back as a fallback texture on frame 1 is exactly the
        // failure that used to stick for the whole match.
        if (mats && adoptMaps(mats)) {
          mapsResolved = true;
        } else if (++resolveTries > 30) {
          // The library never came up, or never produced usable ground maps.
          // The placeholders are ugly but the world still renders, which is the
          // whole point of failing soft.
          console.warn(
            mats
              ? "[Drop Zero] terrain: ground maps never resolved after 30 frames; running on placeholders."
              : "[Drop Zero] terrain: materials service never appeared.",
          );
          mapsResolved = true;
        }
      }

      // The sky owns the fog; aerial perspective just follows it, so the
      // ground always desaturates toward whatever the horizon is doing.
      const fog = c.scene.fog as THREE.Fog | THREE.FogExp2 | null;
      if (fog?.color) hazeColor.copy(fog.color);
    },

    /**
     * LOD selection is camera-dependent, and the player system moves the
     * camera in its own update. Running here means we cull against this
     * frame's view rather than last frame's — which matters at 500 km/h in
     * the bus, where a frame of lag is 140 m of wrongly-culled ground.
     */
    lateUpdate(_dt, c) {
      // Prefer the camera the last frame was really drawn with; fall back to
      // the engine's until the first frame has been rendered.
      refreshLod(renderCamera ?? c.camera);
    },

    dispose() {
      ctx.scene.remove(root);
      for (const pool of pools) {
        for (const slot of pool) {
          slot.geom.dispose();
          root.remove(slot.mesh);
        }
      }
      pools.length = 0;
      // Index buffers are shared between every geometry at a level; three's
      // WebGLAttributes keys its GPU buffers by the attribute object, so the
      // first geom.dispose() above frees each one and the rest are no-ops.
      sharedIndex.length = 0;
      // Only textures this module created — the four ground albedo/normal maps
      // belong to the material library and disposing them would take out every
      // other system that shares them.
      for (const tex of ownedTextures) tex.dispose();
      ownedTextures.length = 0;
      material.dispose();
      jobs.length = 0;
      chunks.length = 0;
      if (ctx.services.terrain === service) delete ctx.services.terrain;
    },
  };

  return sys;
};

export default createTerrain;
