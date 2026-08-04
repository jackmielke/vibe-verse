/**
 * DROP ZERO — the match.
 *
 * Publishes `MatchService`. This module owns the *shape* of a game: the
 * cinematic that opens it, the bus that delivers a hundred people onto the
 * island, the count that ticks down from 100, and the two cards a match can
 * end on. Nothing here shoots anything; everything here decides when the
 * shooting is allowed to matter.
 *
 * ── The phases ────────────────────────────────────────────────────────────
 *
 *   warmup ──▶ bus ──▶ dropping ──▶ live ──┬─▶ victory
 *                                          └─▶ eliminated
 *
 * Each phase is a record with `enter` / `update` / `exit`, held in one table
 * so the transitions are readable in one screen rather than smeared across a
 * dozen booleans. Every transition emits `dz:match`; nothing else in the game
 * is allowed to write `service.phase`.
 *
 * ── Why the bus gets this much geometry ───────────────────────────────────
 * The battle bus is the first thing a player ever sees, for thirty-five
 * uninterrupted seconds, from four metres away, from *below*. That is the
 * worst possible viewing condition for a stylised vehicle: the belly is a
 * single large flat surface filling the frame, and a flat surface is where
 * every one of the classic "this is a Three.js demo" tells lives. So:
 *
 *  - **Nothing is a box.** `bevelBox` chamfers all twelve edges of every
 *    solid. A 4 cm chamfer costs eight triangles and gives the key light a
 *    bright sliver to run along, which is most of what separates a rendered
 *    vehicle from a rendered cube.
 *  - **The belly is the hero surface.** It gets its own 1024² painted panel
 *    — floor plates, a service hatch, walkway grip, running lights and the
 *    wordmark upside-down for the people hanging under it — plus six dangling
 *    grab straps at exactly the offset `player.ts` hangs the player at, so
 *    the player is visibly holding one instead of floating near one.
 *  - **Roughness is never uniform.** Every material carries a baked
 *    roughness map: polished where rain runs off, matte where dust settles,
 *    scuffed to bare metal along the door edges and the bottom trim. A single
 *    roughness value reads as plastic no matter how good the albedo is.
 *  - **Small detail at contact points.** Rivet lines along every seam, gutters
 *    over the windows, mullions between them, louvred vents by the rear
 *    thrusters, a ladder, mirror stalks, a tow eye, a roof rack with a lashed
 *    tarp. All of it merged into a handful of draw calls.
 *  - **Volume in the air.** Everything here is `MeshStandardMaterial` with
 *    fog on, so the bus obeys the sky's aerial perspective and *recedes* when
 *    it crosses the island at 600 m instead of sitting on top of the haze
 *    like a decal. The smoke trail runs the same fog term by hand.
 *
 * The balloon is a lathe with real gores, stitched seams baked into the
 * albedo, eight extruded rib strips with actual thickness, and a burner that
 * pulses. It sways on a slow sine that is deliberately *not* in phase with
 * the bus roll — two coupled bodies on one sine read as a rigid toy.
 *
 * No real lights are added. A `PointLight` in the scene forces every material
 * on the island to recompile with an extra light slot and costs a permanent
 * fraction of the frame for a glow the player reads as bloom anyway — so the
 * burner, the thrusters and the headlamps are emissive geometry plus additive
 * sprites, which is both cheaper and (with the composer's bloom) brighter.
 *
 * ── The crowd ─────────────────────────────────────────────────────────────
 * A hundred-player lobby that visibly contains eight bots is a lie the player
 * catches in the first minute. Two things fix it. `bots.ts` spawns the real
 * opponents you can actually shoot; this module owns everyone else — the
 * "phantom" population — as (a) a drain curve on the alive counter shaped
 * like a real BR's, with fabricated killfeed lines, and (b) actual canopies
 * in the sky during the drop, with contrails, peeling off the bus toward the
 * POIs they picked. They land, they fade, and by the time the storm's first
 * circle closes they are only a number. The count never drops below the
 * number of *real* actors still breathing, so the last kill is always a real
 * one and "1 remaining" is never a lie.
 *
 * ── Restarting ────────────────────────────────────────────────────────────
 * There is no in-place rematch. Rebuilding the island, the loot table and the
 * storm in place would mean every system needed a reset path that is only
 * ever exercised once, and the route re-boots in about a second — so on the
 * end card we emit `dz:restart-available` with `{ method: "reload" }` and the
 * HUD's "play again" reloads `/drop-zero`. Said out loud because it is a real
 * limitation, not an oversight.
 *
 * ── Consumed, all lazily, all null-checked ────────────────────────────────
 * `terrain` (bus altitude sanity, cinematic framing, where a diver lands),
 * `pois` (drop targets, cinematic waypoints), `player` (position, death,
 * camera hand-off), `combat` (how many real actors are still alive),
 * `materials` (the env map for the chrome), `audio` (horn, engine bed,
 * callouts), `sky` (keep the shadow cascade under the cinematic camera).
 * Every one may be missing and the match still runs to a victory card.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { makeRng } from "../types";
import type {
  DamageSource,
  MatchPhase,
  MatchService,
  MaterialsService,
  Poi,
  QualityTier,
  SkyService,
  System,
  SystemFactory,
  TerrainService,
  WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Contract shims
 *
 * `types.ts` is shared and is not ours to edit while a dozen other systems
 * compile against it. Anything we want beyond the published interfaces is
 * read structurally and optionally, with a fallback for when it is absent.
 * ------------------------------------------------------------------------ */

/** The slice of the player we touch. Everything optional but `position`. */
interface PlayerLike {
  position: THREE.Vector3;
  yaw: number;
  pitch: number;
  state?: string;
  camera?: THREE.PerspectiveCamera;
  rig?: THREE.Object3D;
  teleport?(p: THREE.Vector3): void;
}

/** Audio's one-shot surface. Every method optional — audio may not have booted. */
interface AudioLike {
  play?(name: string, opts?: { position?: THREE.Vector3; volume?: number; rate?: number }): void;
  ambience?(name: string, on: boolean, volume?: number): void;
  music?(name: string | null, volume?: number): void;
  readonly ready?: boolean;
}

/** Just enough of combat to count who is really still alive. */
interface CombatLike {
  queryTargets(point: THREE.Vector3, radius: number): {
    alive: boolean;
    faction: string;
    id: string;
  }[];
}

interface MatchServices {
  terrain?: TerrainService;
  materials?: MaterialsService;
  player?: PlayerLike;
  audio?: AudioLike;
  combat?: CombatLike;
  sky?: SkyService;
  /** Only `closing` is read — it biases who the fabricated feed blames. */
  storm?: { closing?: boolean };
  pois?: Poi[];
  match?: MatchService;
}

/** A scheduled departure from the bus, for `bots.ts` and for our own crowd. */
export interface BusDrop {
  /** Stable id — `bot-3`, or `phantom-41` for one of the crowd. */
  id: string;
  /** Bus progress 0..1 at which this one lets go. */
  t: number;
  /** Where they are heading. */
  target: THREE.Vector3;
  /** POI name, for the killfeed's "eliminated at Salt Harbor" flavour. */
  place: string;
  /** Set once the drop has been announced. */
  released: boolean;
}

/** One line of the elimination feed. */
export interface KillEntry {
  killer: string;
  victim: string;
  weapon: string;
  /** True when the local player got it. */
  byPlayer: boolean;
  /** True when the local player *was* it. */
  onPlayer: boolean;
  /** Storm/fall/out-of-bounds kills have no killer worth naming. */
  environmental: boolean;
  /** Seconds since boot, so the HUD can expire the line. */
  at: number;
}

/**
 * Our service: the shared `MatchService` plus what the HUD, the bots and the
 * spectate camera want and the shared contract does not carry. Anyone reading
 * `ctx.services.match` as a plain `MatchService` is unaffected.
 */
export interface DropZeroMatchService extends MatchService {
  /** Live world position of the bus. Read, never write. */
  readonly busPosition: THREE.Vector3;
  /** Sample the route at an arbitrary progress (unclamped). */
  busAt(t: number, out?: THREE.Vector3): THREE.Vector3;
  /** Route length in metres and the bus's ground speed. */
  readonly busLength: number;
  readonly busSpeed: number;
  /** True while the player may still let go. */
  readonly canJump: boolean;
  /** True once the player has let go. */
  readonly jumped: boolean;
  /** Seconds spent in the current phase. */
  readonly phaseTime: number;
  /** Seconds since the match went live. Negative before that. */
  readonly matchTime: number;
  /** Scheduled departures, in `t` order. `bots.ts` may drive itself off this. */
  readonly drops: readonly BusDrop[];
  /** Display name for an actor id — generated, stable, killfeed-ready. */
  nameFor(id: string): string;
  /** Most recent elimination feed lines, newest last. */
  readonly feed: readonly KillEntry[];
  /** End the opening cinematic early. The page's click handler calls this. */
  skipWarmup(): void;
  /** How many people the lobby started with. */
  readonly lobbySize: number;
}

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** Lobby size. The number on the HUD at the moment the bus doors open. */
const LOBBY = 100;

/** Bus cruise altitude. High enough that the island reads as a map. */
const BUS_ALTITUDE = 620;
/**
 * Half-length of the chord, in metres. The island's half-extent is 1500, so
 * ~1780 puts both ends of the route comfortably out over open water — the bus
 * has to *arrive* from somewhere and *leave* to somewhere or the illusion
 * that this island is part of a bigger world dies in the first ten seconds.
 */
const ROUTE_HALF = 1780;
/** Seconds from one end of the route to the other. */
const BUS_DURATION = 35;
/**
 * How far off dead centre the chord may sit. Always cutting the exact middle
 * makes every match's rotation decision identical; ±280 m is enough that the
 * far corner of the map is a real commitment on some routes and a freebie on
 * others.
 */
const ROUTE_OFFSET = 280;

/** Length of the opening fly-over. Long enough to establish, short enough to sit through twice. */
const WARMUP_TIME = 15;
/**
 * The bus flies the last stretch of its approach *during* warmup, so the
 * cinematic can end on it rather than cutting to it. Expressed as route
 * progress, hence negative.
 */
const BUS_PREROLL = -0.19;
/** Seconds of cross-fade from the cinematic camera to the player's camera. */
const HANDOFF_TIME = 1.15;

/** The player is thrown out at the very end of the route, Fortnite-style. */
const FORCE_JUMP_T = 0.985;
/** Below this the jump is refused — nobody wants to land in the sea at t=0.02. */
const JUMP_OPENS_T = 0.055;

/** Dropping ends when the player lands, or after this many seconds regardless. */
const DROP_TIMEOUT = 40;

/** Seconds the victory orbit takes to make one full turn. */
const VICTORY_ORBIT_PERIOD = 26;
/** Spectate pull-back distance and duration after the player is eliminated. */
const SPECTATE_DIST = 24;
const SPECTATE_RISE = 13;
const SPECTATE_TIME = 5.5;
/** How long after the death card before "play again" is offered. */
const RESTART_DELAY = 3.2;

/**
 * The alive-count curve: `[seconds since live, players remaining]`.
 *
 * Shaped off a real solo match — a savage first ninety seconds while the hot
 * drops resolve, a long quiet middle where the count barely moves and the
 * only thing killing anyone is the storm, then a steep finish as the circle
 * squeezes what is left into one field. A linear drain feels wrong in a way
 * players notice without being able to name: the count is the pacing.
 */
const DRAIN_CURVE: readonly (readonly [number, number])[] = [
  [0, LOBBY],
  [18, LOBBY],
  [42, 74],
  [75, 58],
  [120, 47],
  [180, 38],
  [250, 30],
  [330, 23],
  [410, 17],
  [490, 12],
  [560, 8],
  [640, 5],
  [720, 3],
  [820, 1],
];

/** Alive counts that get an announcement. Descending. */
const CALLOUTS: readonly number[] = [75, 50, 25, 10, 5, 3, 2];

/** Crowd size (visible canopies during the drop) per quality tier. */
const DIVERS: Record<QualityTier, number> = { low: 0, medium: 22, high: 40, ultra: 56 };
/** Smoke puffs in the bus's trail ring buffer. */
const SMOKE_PUFFS: Record<QualityTier, number> = { low: 60, medium: 130, high: 220, ultra: 300 };
/** Chamfer size. `low` gets none — a chamfer is 3.7× the triangles of a box. */
const BEVEL: Record<QualityTier, number> = { low: 0, medium: 0.03, high: 0.045, ultra: 0.05 };

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

type Geo = THREE.BufferGeometry;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Frame-rate independent exponential approach. */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

/** Ease that starts and ends still — the only acceptable curve for a camera move. */
function easeInOut(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Sample a monotonic `[x, y]` table with linear interpolation and flat ends. */
function sampleCurve(curve: readonly (readonly [number, number])[], x: number): number {
  if (curve.length === 0) return 0;
  if (x <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (x <= b[0]) {
      const f = (x - a[0]) / (b[0] - a[0] || 1);
      return a[1] + (b[1] - a[1]) * f;
    }
  }
  return last[1];
}

/* ------------------------------------------------------------------------ *
 * Geometry helpers
 *
 * Same vocabulary the props and loot modules use, kept local because systems
 * in this engine never import each other.
 * ------------------------------------------------------------------------ */

/** A rounded rectangle shape, used as the profile for every chamfered solid. */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = w / 2;
  const y = h / 2;
  const c = Math.max(0.0004, Math.min(r, x * 0.86, y * 0.86));
  s.moveTo(-x + c, -y);
  s.lineTo(x - c, -y);
  s.quadraticCurveTo(x, -y, x, -y + c);
  s.lineTo(x, y - c);
  s.quadraticCurveTo(x, y, x - c, y);
  s.lineTo(-x + c, y);
  s.quadraticCurveTo(-x, y, -x, y - c);
  s.lineTo(-x, -y + c);
  s.quadraticCurveTo(-x, -y, -x + c, -y);
  return s;
}

/**
 * A box with a real chamfer on all twelve edges, extruded along Z, centred on
 * the origin. `bevel <= 0` falls back to a plain box, which is what the low
 * tier gets — at that tier the bus is never close enough for the chamfer to
 * cover a pixel.
 */
function bevelBox(w: number, h: number, d: number, bevel: number, corner = 0): Geo {
  if (bevel <= 0.001) return new THREE.BoxGeometry(w, h, d);
  const b = Math.max(0.0006, Math.min(bevel, w * 0.3, h * 0.3, d * 0.3));
  const shape = roundedRect(w - 2 * b, h - 2 * b, corner || b);
  const depth = Math.max(0.002, d - 2 * b);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: corner > b * 2 ? 4 : 2,
    steps: 1,
  });
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return geo;
}

/** Cylinder along +Y, centred. */
function tube(rTop: number, rBot: number, len: number, seg = 12, open = false): Geo {
  return new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open);
}

/** Cylinder along +X — how every axle and handrail in here is laid out. */
function tubeX(rTop: number, rBot: number, len: number, seg = 10): Geo {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, false);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** Cylinder along +Z — the bus's long axis. */
function tubeZ(rTop: number, rBot: number, len: number, seg = 10): Geo {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, false);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Place a part: rotate (XYZ, radians) then translate. Returns the same geo. */
function put(g: Geo, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Geo {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/**
 * Strip a geometry to the attribute set `mergeGeometries` will accept — it
 * refuses a mixed indexed/non-indexed set, and `ExtrudeGeometry` is
 * non-indexed while every primitive is indexed.
 */
function normalise(geo: Geo): Geo {
  let g = geo;
  if (g.index) {
    const flat = g.toNonIndexed();
    g.dispose();
    g = flat;
  }
  for (const key of Object.keys(g.attributes)) {
    if (key !== "position" && key !== "normal" && key !== "uv") g.deleteAttribute(key);
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    const n = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  return g;
}

/** Merge a part list into one geometry. Empty list yields an empty geometry. */
function mergeParts(parts: Geo[]): Geo {
  if (parts.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeometries(parts.map(normalise), false);
  for (const p of parts) p.dispose();
  if (!merged) return new THREE.BufferGeometry();
  merged.computeVertexNormals();
  return merged;
}

/**
 * Box-project UVs from object space, per vertex, choosing the two axes from
 * the vertex normal.
 *
 * A single planar projection is the obvious implementation and it is wrong in
 * a way that is invisible until it is not: on a face perpendicular to the
 * projection plane one UV is constant across the whole face, the tangent
 * frame three derives for the normal map is degenerate, and the face shades
 * black. Per-vertex axis selection costs one branch and never does that.
 */
function boxProjectUv(g: Geo, metres: number): Geo {
  const pos = g.getAttribute("position");
  const nrm = g.getAttribute("normal");
  if (!pos || !nrm) return g;
  const count = pos.count;
  const arr = new Float32Array(count * 2);
  const inv = 1 / Math.max(0.001, metres);
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    // The half-tile shift puts the middle of the texture on the middle of the
    // object rather than on its wrap seam.
    if (ny >= nx && ny >= nz) {
      arr[i * 2] = x * inv + 0.5;
      arr[i * 2 + 1] = z * inv + 0.5;
    } else if (nx >= nz) {
      arr[i * 2] = z * inv + 0.5;
      arr[i * 2 + 1] = y * inv + 0.5;
    } else {
      arr[i * 2] = x * inv + 0.5;
      arr[i * 2 + 1] = y * inv + 0.5;
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(arr, 2));
  return g;
}

/* ------------------------------------------------------------------------ *
 * Procedural textures
 *
 * All baked on a 2D canvas at boot; no file ever leaves the bundle. Every one
 * of them exists for the same reason: to kill uniform roughness and put small
 * detail on surfaces the player will be four metres from for half a minute.
 * ------------------------------------------------------------------------ */

interface Canvas2D {
  c: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
}

function canvas2d(w: number, h = w): Canvas2D | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) return null;
  return { c, g };
}

function toTexture(c: HTMLCanvasElement, srgb: boolean, aniso = 8): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * Tileable value noise, bilinearly interpolated from a coarse lattice.
 * Written per-pixel into a Float32Array rather than composited out of
 * `fillRect`s, because 256² is well under a millisecond and gives honest
 * interpolation instead of visible blocks.
 */
function noiseField(size: number, cells: number, rng: () => number): Float32Array {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const out = new Float32Array(size * size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const fy = y * scale;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      // Smoothstep the interpolant: linear lattice noise has visible creases
      // along every cell boundary once it drives a normal map.
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const i00 = (y0 % cells) * cells + (x0 % cells);
      const i10 = (y0 % cells) * cells + ((x0 + 1) % cells);
      const i01 = ((y0 + 1) % cells) * cells + (x0 % cells);
      const i11 = ((y0 + 1) % cells) * cells + ((x0 + 1) % cells);
      const a = grid[i00] + (grid[i10] - grid[i00]) * sx;
      const b = grid[i01] + (grid[i11] - grid[i01]) * sx;
      out[y * size + x] = a + (b - a) * sy;
    }
  }
  return out;
}

/** Sum of octaves of `noiseField`. Returns values roughly in 0..1. */
function fbmField(size: number, rng: () => number, octaves = 4, base = 4): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const f = noiseField(size, base << o, rng);
    for (let i = 0; i < out.length; i++) out[i] += f[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  const inv = 1 / (total || 1);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/**
 * Derive a tangent-space normal map from a greyscale canvas by central
 * differences. Sobel would be smoother; central differences are two taps and
 * the difference is invisible on a surface this size, and the height source
 * here is already band-limited.
 */
function normalFromHeight(src: HTMLCanvasElement, strength: number): THREE.CanvasTexture | null {
  const w = src.width;
  const h = src.height;
  const read = src.getContext("2d");
  const dst = canvas2d(w, h);
  if (!read || !dst) return null;
  const data = read.getImageData(0, 0, w, h).data;
  const out = dst.g.createImageData(w, h);
  const px = out.data;
  const at = (x: number, y: number): number => {
    const xx = ((x % w) + w) % w;
    const yy = ((y % h) + h) % h;
    const i = (yy * w + xx) * 4;
    return (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * w + x) * 4;
      px[i] = (nx * 0.5 + 0.5) * 255;
      px[i + 1] = (ny * 0.5 + 0.5) * 255;
      px[i + 2] = (nz * 0.5 + 0.5) * 255;
      px[i + 3] = 255;
    }
  }
  dst.g.putImageData(out, 0, 0);
  return toTexture(dst.c, false);
}

/** Fill a canvas from a scalar field through a colour ramp. */
function paintField(
  g: CanvasRenderingContext2D,
  size: number,
  field: Float32Array,
  ramp: (v: number) => [number, number, number],
): void {
  const img = g.createImageData(size, size);
  const px = img.data;
  for (let i = 0; i < size * size; i++) {
    const [r, gg, b] = ramp(field[i]);
    px[i * 4] = r;
    px[i * 4 + 1] = gg;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

/** A line of rivets. Two-tone so each one has a lit top and a shadowed base. */
function rivetRun(
  g: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  count: number,
  r: number,
  light: string,
  dark: string,
): void {
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0.5 : i / (count - 1);
    const x = lerp(x0, x1, f);
    const y = lerp(y0, y1, f);
    g.fillStyle = dark;
    g.beginPath();
    g.arc(x, y + r * 0.35, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = light;
    g.beginPath();
    g.arc(x, y - r * 0.15, r * 0.78, 0, Math.PI * 2);
    g.fill();
  }
}

/** Streaks of grime running down a surface — the cheapest believable wear. */
function grimeStreaks(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  rng: () => number,
  count: number,
  alpha: number,
): void {
  g.save();
  for (let i = 0; i < count; i++) {
    const x = rng() * w;
    const top = rng() * h * 0.5;
    const len = h * (0.25 + rng() * 0.6);
    const wide = 1 + rng() * 5;
    const grad = g.createLinearGradient(0, top, 0, top + len);
    grad.addColorStop(0, `rgba(24,20,16,${alpha * (0.5 + rng() * 0.5)})`);
    grad.addColorStop(1, "rgba(24,20,16,0)");
    g.fillStyle = grad;
    g.fillRect(x, top, wide, len);
  }
  g.restore();
}

/**
 * The bus's painted panel albedo, tiled across the hull. Deep saturated blue
 * with panel seams, rivets, a scuffed lower band and sun-bleached streaks on
 * the horizontal surfaces. Tiles at 2 m.
 */
function bakeHullAlbedo(rng: () => number): { tex: THREE.CanvasTexture; height: HTMLCanvasElement } | null {
  const S = 512;
  const cv = canvas2d(S);
  const hv = canvas2d(S);
  if (!cv || !hv) return null;
  const { g } = cv;
  const noise = fbmField(S, rng, 4, 8);

  // Base coat, mottled — a flat fill is the fastest way to make paint read as
  // plastic, and the mottle survives all the way down to a 4-pixel-wide bus.
  paintField(g, S, noise, (v) => {
    const t = 0.72 + v * 0.36;
    // Bright saturated cobalt, not navy. Under ACES with a warm key this
    // lands about where Fortnite's bus does; anything darker turns to a
    // silhouette the moment the sun goes behind the balloon.
    return [Math.round(50 * t), Math.round(106 * t), Math.round(188 * t)];
  });

  // Panel seams. Uneven spacing: a perfect grid reads as wallpaper.
  hv.g.fillStyle = "#808080";
  hv.g.fillRect(0, 0, S, S);
  const seams: number[] = [0, 96, 168, 256, 344, 420, S];
  for (const x of seams) {
    g.fillStyle = "rgba(8,20,42,0.55)";
    g.fillRect(x - 1.5, 0, 3, S);
    g.fillStyle = "rgba(150,190,240,0.14)";
    g.fillRect(x + 1.5, 0, 1.5, S);
    hv.g.fillStyle = "#3a3a3a";
    hv.g.fillRect(x - 1.5, 0, 3, S);
  }
  for (const y of [0, 132, 300, S]) {
    g.fillStyle = "rgba(8,20,42,0.4)";
    g.fillRect(0, y - 1.5, S, 3);
    hv.g.fillStyle = "#3a3a3a";
    hv.g.fillRect(0, y - 1.5, S, 3);
  }

  // Rivets along every seam, in both the albedo and the height field.
  for (const x of seams) {
    rivetRun(g, x, 6, x, S - 6, 22, 2.6, "rgba(186,214,246,0.5)", "rgba(6,16,34,0.55)");
    rivetRun(hv.g, x, 6, x, S - 6, 22, 2.6, "#c8c8c8", "#5a5a5a");
  }

  // A scuffed band at the bottom where boots, kerbs and gravel live.
  const wear = g.createLinearGradient(0, S * 0.78, 0, S);
  wear.addColorStop(0, "rgba(120,110,96,0)");
  wear.addColorStop(1, "rgba(126,116,100,0.5)");
  g.fillStyle = wear;
  g.fillRect(0, S * 0.78, S, S * 0.22);

  grimeStreaks(g, S, S, rng, 34, 0.34);

  // A few chips down to bare metal, clustered near the seams where a panel
  // edge actually takes a knock.
  for (let i = 0; i < 40; i++) {
    const x = seams[Math.floor(rng() * seams.length)] + (rng() * 2 - 1) * 14;
    const y = rng() * S;
    const r = 1 + rng() * 3.5;
    g.fillStyle = `rgba(${168 + rng() * 40},${172 + rng() * 40},${178 + rng() * 40},0.75)`;
    g.beginPath();
    g.ellipse(x, y, r, r * (0.5 + rng()), rng() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }

  return { tex: toTexture(cv.c, true), height: hv.c };
}

/**
 * Roughness for the hull. Bright = rough. Wet-look polish on the upper
 * panels, matte where dust settles, and every seam and chip picked out
 * individually — this map is doing more for the look than the albedo is.
 */
function bakeHullRoughness(rng: () => number): THREE.CanvasTexture | null {
  const S = 512;
  const cv = canvas2d(S);
  if (!cv) return null;
  const { g } = cv;
  const noise = fbmField(S, rng, 5, 6);
  paintField(g, S, noise, (v) => {
    // 0.22 polished clear-coat → 0.78 chalky. The *range* is the point; any
    // single value in it reads as plastic.
    const r = Math.round((0.24 + v * 0.42) * 255);
    return [r, r, r];
  });
  for (const x of [0, 96, 168, 256, 344, 420, S]) {
    g.fillStyle = "rgba(230,230,230,0.7)";
    g.fillRect(x - 2, 0, 4, S);
  }
  const dust = g.createLinearGradient(0, S * 0.7, 0, S);
  dust.addColorStop(0, "rgba(255,255,255,0)");
  dust.addColorStop(1, "rgba(255,255,255,0.55)");
  g.fillStyle = dust;
  g.fillRect(0, S * 0.7, S, S * 0.3);
  grimeStreaks(g, S, S, rng, 26, 0.5);
  return toTexture(cv.c, false);
}

/**
 * Brushed metal for the trim, bumpers, rigging and thruster nacelles.
 * Directional scratches, because isotropic noise on metal reads as concrete.
 */
function bakeMetal(rng: () => number): {
  albedo: THREE.CanvasTexture;
  rough: THREE.CanvasTexture;
} | null {
  const S = 256;
  const av = canvas2d(S);
  const rv = canvas2d(S);
  if (!av || !rv) return null;
  const noise = fbmField(S, rng, 3, 10);
  paintField(av.g, S, noise, (v) => {
    const t = 0.62 + v * 0.5;
    return [Math.round(176 * t), Math.round(182 * t), Math.round(192 * t)];
  });
  paintField(rv.g, S, noise, (v) => {
    const r = Math.round((0.2 + v * 0.34) * 255);
    return [r, r, r];
  });
  // Brush lines. Horizontal on purpose: the trim runs along the bus, so the
  // anisotropy lines up with the form when the UVs are box-projected.
  for (let i = 0; i < 240; i++) {
    const y = rng() * S;
    const a = 0.05 + rng() * 0.13;
    av.g.strokeStyle = rng() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(40,44,52,${a})`;
    av.g.lineWidth = 0.6 + rng() * 1.4;
    av.g.beginPath();
    av.g.moveTo(0, y);
    av.g.lineTo(S, y + (rng() * 2 - 1) * 3);
    av.g.stroke();
    rv.g.strokeStyle = `rgba(255,255,255,${a * 1.6})`;
    rv.g.lineWidth = av.g.lineWidth;
    rv.g.beginPath();
    rv.g.moveTo(0, y);
    rv.g.lineTo(S, y + (rng() * 2 - 1) * 3);
    rv.g.stroke();
  }
  return { albedo: toTexture(av.c, true), rough: toTexture(rv.c, false) };
}

/**
 * The side livery: 2048×512, mapped 0..1 onto a panel under the windows.
 * This is the one texture with actual typography, so it gets the wordmark,
 * the route number, a chevron flash and the same wear as everything else.
 */
function bakeLivery(rng: () => number): THREE.CanvasTexture | null {
  const W = 2048;
  const H = 512;
  const cv = canvas2d(W, H);
  if (!cv) return null;
  const { g } = cv;

  const base = g.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, "#1f4c96");
  base.addColorStop(0.55, "#173d7e");
  base.addColorStop(1, "#102c5e");
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);

  // Chevron flash sweeping up toward the front of the bus. Reads as speed
  // from 300 m, which is the distance most people first see the livery from.
  g.save();
  g.beginPath();
  g.moveTo(0, H * 0.98);
  g.lineTo(W * 0.62, H * 0.2);
  g.lineTo(W * 0.78, H * 0.2);
  g.lineTo(W * 0.16, H * 0.98);
  g.closePath();
  g.fillStyle = "#f2a93b";
  g.fill();
  g.beginPath();
  g.moveTo(W * 0.68, H * 0.98);
  g.lineTo(W * 0.98, H * 0.52);
  g.lineTo(W, H * 0.62);
  g.lineTo(W * 0.8, H * 0.98);
  g.closePath();
  g.fillStyle = "#e0f0ff";
  g.fill();
  g.restore();

  // Wordmark.
  g.save();
  g.font = "900 176px 'Arial Black', system-ui, sans-serif";
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillStyle = "rgba(6,14,30,0.5)";
  g.fillText("DROP ZERO", 130, H * 0.42 + 8);
  g.fillStyle = "#f4f9ff";
  g.fillText("DROP ZERO", 124, H * 0.42);
  g.font = "600 54px system-ui, sans-serif";
  g.fillStyle = "rgba(210,232,255,0.72)";
  g.fillText("ISLAND SERVICE · NON-STOP · NO REFUNDS", 130, H * 0.72);
  g.restore();

  // Route roundel at the rear end of the panel.
  g.save();
  g.translate(W * 0.9, H * 0.34);
  g.fillStyle = "#0d1d3c";
  g.beginPath();
  g.arc(0, 0, 96, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#f2a93b";
  g.lineWidth = 10;
  g.stroke();
  g.font = "900 108px 'Arial Black', system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#ffd479";
  g.fillText("01", 0, 6);
  g.restore();

  // Panel seams over the paint, then the same wear the hull gets so the decal
  // panel does not read as a sticker on a dirty bus.
  for (let x = 0; x < W; x += 256) {
    g.fillStyle = "rgba(6,16,36,0.4)";
    g.fillRect(x - 2, 0, 4, H);
    rivetRun(g, x, 12, x, H - 12, 14, 3.2, "rgba(190,216,248,0.42)", "rgba(6,16,34,0.5)");
  }
  grimeStreaks(g, W, H, rng, 70, 0.36);
  const wear = g.createLinearGradient(0, H * 0.7, 0, H);
  wear.addColorStop(0, "rgba(120,110,96,0)");
  wear.addColorStop(1, "rgba(126,116,100,0.45)");
  g.fillStyle = wear;
  g.fillRect(0, H * 0.7, W, H * 0.3);

  const t = toTexture(cv.c, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * The belly plate. The player spends the whole bus ride four metres under
 * this, so it is the most-looked-at surface in the game's first minute:
 * walkway grip, a service hatch, running-light strips, lashing points and the
 * wordmark for the people hanging off the rails.
 */
function bakeBelly(rng: () => number): THREE.CanvasTexture | null {
  const S = 1024;
  const cv = canvas2d(S);
  if (!cv) return null;
  const { g } = cv;
  const noise = fbmField(S, rng, 4, 7);
  paintField(g, S, noise, (v) => {
    const t = 0.7 + v * 0.4;
    // Light enough to still read detail when it is the shadowed side of the
    // vehicle, which — for the whole bus ride — it always is.
    return [Math.round(96 * t), Math.round(106 * t), Math.round(124 * t)];
  });

  // Floor plates with a raised diamond-grip centre.
  for (let i = 0; i < 4; i++) {
    const y = 40 + i * 240;
    g.fillStyle = "rgba(14,18,26,0.5)";
    g.fillRect(30, y - 4, S - 60, 6);
    g.fillStyle = "rgba(150,170,200,0.09)";
    g.fillRect(30, y + 2, S - 60, 3);
  }
  g.save();
  g.globalAlpha = 0.5;
  for (let y = 60; y < S - 40; y += 22) {
    for (let x = 260; x < S - 240; x += 22) {
      g.fillStyle = "rgba(190,206,232,0.16)";
      g.beginPath();
      g.moveTo(x, y - 6);
      g.lineTo(x + 7, y);
      g.lineTo(x, y + 6);
      g.lineTo(x - 7, y);
      g.closePath();
      g.fill();
    }
  }
  g.restore();

  // Service hatch with a real recess line and four dogs.
  g.strokeStyle = "rgba(10,14,22,0.8)";
  g.lineWidth = 5;
  g.strokeRect(112, 372, 246, 246);
  g.strokeStyle = "rgba(168,190,222,0.2)";
  g.lineWidth = 2;
  g.strokeRect(118, 378, 234, 234);
  rivetRun(g, 132, 392, 338, 392, 8, 5, "rgba(196,216,246,0.42)", "rgba(6,12,24,0.6)");
  rivetRun(g, 132, 598, 338, 598, 8, 5, "rgba(196,216,246,0.42)", "rgba(6,12,24,0.6)");

  // Running-light strips down both long edges. These pair with an emissive
  // strip in geometry — the paint alone would not glow, and the geometry
  // alone would have no housing.
  for (const y of [26, S - 34]) {
    g.fillStyle = "rgba(14,18,26,0.85)";
    g.fillRect(60, y, S - 120, 12);
    for (let x = 76; x < S - 76; x += 64) {
      g.fillStyle = "rgba(255,214,142,0.85)";
      g.fillRect(x, y + 2, 26, 8);
    }
  }

  // Wordmark, mirrored, for the riders.
  g.save();
  g.translate(S * 0.62, S * 0.5);
  g.scale(-1, 1);
  g.font = "900 112px 'Arial Black', system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "rgba(8,12,20,0.55)";
  g.fillText("DROP ZERO", 5, 5);
  g.fillStyle = "rgba(226,238,255,0.82)";
  g.fillText("DROP ZERO", 0, 0);
  g.font = "700 34px system-ui, sans-serif";
  g.fillStyle = "rgba(242,169,59,0.8)";
  g.fillText("MIND THE DROP", 0, 74);
  g.restore();

  grimeStreaks(g, S, S, rng, 46, 0.42);
  const t = toTexture(cv.c, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * The balloon envelope: vertical gores in the bus's colours with stitched
 * seams, a woven fabric grain, and honest soft shading baked toward the
 * bottom of each gore so the lathe reads as cloth under tension rather than
 * as a smooth solid of revolution.
 */
function bakeBalloon(rng: () => number): {
  albedo: THREE.CanvasTexture;
  rough: THREE.CanvasTexture;
  height: HTMLCanvasElement;
} | null {
  const W = 1024;
  const H = 512;
  const av = canvas2d(W, H);
  const rv = canvas2d(W, H);
  const hv = canvas2d(W, H);
  if (!av || !rv || !hv) return null;

  const GORES = 16;
  const gw = W / GORES;
  const palette = ["#e9f1fb", "#2a63c0", "#e9f1fb", "#f2a93b"];
  for (let i = 0; i < GORES; i++) {
    const x = i * gw;
    av.g.fillStyle = palette[i % palette.length];
    av.g.fillRect(x, 0, gw + 1, H);
    // Cylindrical shading across each gore. Without this the lathe's own
    // smooth normal is the only shading cue and the balloon reads as plastic.
    const shade = av.g.createLinearGradient(x, 0, x + gw, 0);
    shade.addColorStop(0, "rgba(6,12,26,0.32)");
    shade.addColorStop(0.42, "rgba(255,255,255,0.1)");
    shade.addColorStop(1, "rgba(6,12,26,0.32)");
    av.g.fillStyle = shade;
    av.g.fillRect(x, 0, gw + 1, H);
  }

  // Fabric weave: a fine cross-hatch, low contrast, high frequency. It is
  // what stops the envelope reading as painted metal at close range.
  av.g.save();
  av.g.globalAlpha = 0.05;
  for (let y = 0; y < H; y += 3) {
    av.g.strokeStyle = y % 6 === 0 ? "#ffffff" : "#000000";
    av.g.beginPath();
    av.g.moveTo(0, y);
    av.g.lineTo(W, y);
    av.g.stroke();
  }
  for (let x = 0; x < W; x += 3) {
    av.g.strokeStyle = x % 6 === 0 ? "#ffffff" : "#000000";
    av.g.beginPath();
    av.g.moveTo(x, 0);
    av.g.lineTo(x, H);
    av.g.stroke();
  }
  av.g.restore();

  // Seams: a stitch line at every gore edge, in albedo and in height.
  hv.g.fillStyle = "#7a7a7a";
  hv.g.fillRect(0, 0, W, H);
  for (let i = 0; i <= GORES; i++) {
    const x = i * gw;
    av.g.fillStyle = "rgba(20,28,48,0.42)";
    av.g.fillRect(x - 2, 0, 4, H);
    hv.g.fillStyle = "#d0d0d0";
    hv.g.fillRect(x - 2.5, 0, 5, H);
    av.g.strokeStyle = "rgba(250,250,250,0.4)";
    av.g.lineWidth = 1.4;
    av.g.setLineDash([7, 7]);
    av.g.beginPath();
    av.g.moveTo(x - 5, 0);
    av.g.lineTo(x - 5, H);
    av.g.moveTo(x + 5, 0);
    av.g.lineTo(x + 5, H);
    av.g.stroke();
    av.g.setLineDash([]);
  }
  // Horizontal load tapes at three heights: real balloons have them, and they
  // break the vertical monotony of sixteen stripes.
  for (const y of [H * 0.24, H * 0.52, H * 0.78]) {
    av.g.fillStyle = "rgba(24,34,58,0.34)";
    av.g.fillRect(0, y - 3, W, 6);
    hv.g.fillStyle = "#c0c0c0";
    hv.g.fillRect(0, y - 3.5, W, 7);
  }

  // Soot at the mouth (bottom of the map) from the burner, and sun-bleach at
  // the crown.
  const soot = av.g.createLinearGradient(0, H * 0.84, 0, H);
  soot.addColorStop(0, "rgba(24,20,18,0)");
  soot.addColorStop(1, "rgba(24,20,18,0.6)");
  av.g.fillStyle = soot;
  av.g.fillRect(0, H * 0.84, W, H * 0.16);
  const sun = av.g.createLinearGradient(0, 0, 0, H * 0.2);
  sun.addColorStop(0, "rgba(255,250,238,0.22)");
  sun.addColorStop(1, "rgba(255,250,238,0)");
  av.g.fillStyle = sun;
  av.g.fillRect(0, 0, W, H * 0.2);

  // Roughness: cloth is rough everywhere, but not *equally* rough. The weave
  // and the seams both show up here.
  const noise = fbmField(512, rng, 4, 9);
  const tmp = canvas2d(512);
  if (tmp) {
    paintField(tmp.g, 512, noise, (v) => {
      const r = Math.round((0.66 + v * 0.3) * 255);
      return [r, r, r];
    });
    rv.g.drawImage(tmp.c, 0, 0, W, H);
  }
  for (let i = 0; i <= GORES; i++) {
    rv.g.fillStyle = "rgba(120,120,120,0.6)";
    rv.g.fillRect(i * gw - 3, 0, 6, H);
  }

  const albedo = toTexture(av.c, true);
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.wrapT = THREE.ClampToEdgeWrapping;
  const rough = toTexture(rv.c, false);
  rough.wrapS = THREE.RepeatWrapping;
  rough.wrapT = THREE.ClampToEdgeWrapping;
  return { albedo, rough, height: hv.c };
}

/** The lit destination board over the windshield. Pure emissive. */
function bakeDestination(): THREE.CanvasTexture | null {
  const W = 1024;
  const H = 256;
  const cv = canvas2d(W, H);
  if (!cv) return null;
  const { g } = cv;
  g.fillStyle = "#050608";
  g.fillRect(0, 0, W, H);
  // Dot-matrix: draw the text, then punch a pixel grid through it. Cheaper
  // and more convincing than trying to place dots per glyph.
  g.font = "900 132px 'Arial Black', system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#ffb43a";
  g.fillText("THE ISLAND", W / 2, H / 2 - 6);
  g.font = "700 40px system-ui, sans-serif";
  g.fillStyle = "#ff8c1a";
  g.fillText("ONE WAY", W / 2, H - 44);
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = "#000";
  for (let y = 0; y < H; y += 6) g.fillRect(0, y + 4, W, 2);
  for (let x = 0; x < W; x += 6) g.fillRect(x + 4, 0, 2, H);
  g.globalCompositeOperation = "source-over";
  const t = toTexture(cv.c, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** A soft puff with structure — a plain gaussian blob reads as a lens smudge. */
function bakeSmoke(rng: () => number): THREE.CanvasTexture | null {
  const S = 128;
  const cv = canvas2d(S);
  if (!cv) return null;
  const { g } = cv;
  const field = fbmField(S, rng, 4, 5);
  const img = g.createImageData(S, S);
  const px = img.data;
  const c = S / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      // Falloff × noise, with the noise biting harder at the rim so the puff
      // has a ragged edge instead of a perfect circle.
      const fall = clamp01(1 - d) ** 1.7;
      const n = 0.55 + field[y * S + x] * 0.9;
      const a = clamp01(fall * n - d * 0.25);
      const i = (y * S + x) * 4;
      const shade = Math.round(226 + field[y * S + x] * 28);
      px[i] = shade;
      px[i + 1] = shade;
      px[i + 2] = Math.min(255, shade + 6);
      px[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = toTexture(cv.c, true, 2);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Radial glow for the additive sprites: thrusters, burner, headlamps. */
function bakeGlow(inner: string, outer: string): THREE.CanvasTexture | null {
  const S = 128;
  const cv = canvas2d(S);
  if (!cv) return null;
  const { g } = cv;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.28, outer);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const t = toTexture(cv.c, true, 2);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/* ------------------------------------------------------------------------ *
 * The battle bus
 *
 * Local frame: forward is −Z (so `Object3D.lookAt` orients it correctly),
 * +X is the bus's right, and **y = 0 is the line the player hangs from**.
 * `player.ts` parks the rider at local (+1.5, −2.35, 0) — one and a half
 * metres to the right of the centreline, two and a third below the origin —
 * so every solid on this bus starts at y = +0.6 and the grab rail, the strap
 * they are holding and the belly plate are all authored around that offset.
 * Get this wrong and the player either floats in space or has their head
 * inside the fuel tank.
 * ------------------------------------------------------------------------ */

/** A cylinder between two points, for ropes, rigging and stalks. */
function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6): Geo {
  const len = Math.max(0.01, a.distanceTo(b));
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** Hull dimensions, in metres. Named because half a dozen parts key off them. */
const HULL = {
  halfW: 3.0,
  /** Belly plate height — the player's head clears this by ~1.2 m. */
  floorY: 0.6,
  /** Top of the lower (solid) body, bottom of the window band. */
  waistY: 2.5,
  /** Top of the window band. */
  browY: 4.1,
  /** Top of the upper body, under the roof cap. */
  shoulderY: 5.0,
  roofY: 5.45,
  halfL: 10.8,
};

interface BusModel {
  root: THREE.Object3D;
  /** Everything that sways — the hull, rigging and balloon. */
  sway: THREE.Object3D;
  /** The envelope, which breathes on its own phase. */
  balloon: THREE.Object3D;
  rotors: THREE.Object3D[];
  /** Burner flame cone; scaled and faded on a flicker. */
  flame: THREE.Object3D | null;
  flameMat: THREE.MeshBasicMaterial | null;
  burnerGlow: THREE.Sprite | null;
  thrusterGlows: THREE.Sprite[];
  /** World-space emitters for the smoke trail, in local coordinates. */
  exhausts: THREE.Vector3[];
  geometries: Geo[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
}

function buildBus(ctx: WorldCtx, rng: () => number): BusModel {
  const quality = ctx.quality;
  const bevel = BEVEL[quality];
  const geometries: Geo[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const env = ctx.services.materials?.env ?? null;

  const root = new THREE.Object3D();
  root.name = "dz-battle-bus";
  const sway = new THREE.Object3D();
  sway.name = "dz-bus-sway";
  root.add(sway);

  // ---- materials ---------------------------------------------------------

  const hullBake = bakeHullAlbedo(rng);
  const hullRough = bakeHullRoughness(rng);
  const hullNormal = hullBake ? normalFromHeight(hullBake.height, 2.6) : null;
  const metal = bakeMetal(rng);
  const liveryTex = bakeLivery(rng);
  const bellyTex = bakeBelly(rng);
  const balloonBake = bakeBalloon(rng);
  const balloonNormal = balloonBake ? normalFromHeight(balloonBake.height, 1.7) : null;
  const boardTex = bakeDestination();
  const glowTex = bakeGlow("rgba(255,255,255,1)", "rgba(255,196,110,0.85)");

  for (const t of [
    hullBake?.tex,
    hullRough,
    hullNormal,
    metal?.albedo,
    metal?.rough,
    liveryTex,
    bellyTex,
    balloonBake?.albedo,
    balloonBake?.rough,
    balloonNormal,
    boardTex,
    glowTex,
  ]) {
    if (t) textures.push(t);
  }

  const track = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  const hullMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: hullBake?.tex ?? null,
      roughnessMap: hullRough,
      normalMap: hullNormal,
      normalScale: new THREE.Vector2(0.65, 0.65),
      // Painted steel: enough metalness to pick up a sky reflection on the
      // upper panels, not so much that the shadowed side goes black.
      metalness: 0.18,
      roughness: 1,
      envMap: env,
      envMapIntensity: 0.75,
      // A hair of self-illumination in the paint's own hue. Not a cheat for
      // its own sake: the bus is backlit against the sky for most of its
      // life, and without an ambient floor the shadowed side crushes to pure
      // black, which is the flattest thing a stylised vehicle can do.
      emissive: new THREE.Color(0x0a1a33),
      emissiveIntensity: 1,
      fog: true,
    }),
  );

  const liveryMat = track(
    new THREE.MeshStandardMaterial({
      map: liveryTex,
      roughnessMap: hullRough,
      normalMap: hullNormal,
      normalScale: new THREE.Vector2(0.4, 0.4),
      metalness: 0.24,
      roughness: 1,
      envMap: env,
      envMapIntensity: 0.7,
      // The decal panel sits 2 cm proud of the hull; the offset keeps it out
      // of a depth fight when the bus is 600 m away and the buffer is coarse.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: true,
    }),
  );

  const bellyMat = track(
    new THREE.MeshStandardMaterial({
      map: bellyTex,
      roughnessMap: hullRough,
      normalMap: hullNormal,
      normalScale: new THREE.Vector2(0.5, 0.5),
      // Barely metallic. The belly never sees the key light, and metalness
      // is a diffuse-albedo tax you cannot afford on a surface lit only by
      // sky bounce.
      metalness: 0.12,
      // The underside is lit by its own strip lights and by whatever bounces
      // off the sea. Driving the emissive with the belly's own albedo keeps
      // the panel legible from directly below — which is the one angle the
      // player is guaranteed to see it from — without flattening it, because
      // the map still carries all the panel and grime variation.
      emissiveMap: bellyTex,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.45,
      roughness: 1,
      envMap: env,
      envMapIntensity: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
      fog: true,
    }),
  );

  const trimMat = track(
    new THREE.MeshStandardMaterial({
      map: metal?.albedo ?? null,
      roughnessMap: metal?.rough ?? null,
      color: 0xd6dbe4,
      metalness: 0.92,
      roughness: 1,
      envMap: env,
      envMapIntensity: 1.15,
      fog: true,
    }),
  );

  const darkMetalMat = track(
    new THREE.MeshStandardMaterial({
      map: metal?.albedo ?? null,
      roughnessMap: metal?.rough ?? null,
      color: 0x5c6674,
      metalness: 0.58,
      roughness: 1,
      envMap: env,
      envMapIntensity: 0.7,
      fog: true,
    }),
  );

  const glassMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x16243c,
      metalness: 0.55,
      roughness: 0.07,
      envMap: env,
      envMapIntensity: 1.6,
      transparent: true,
      opacity: 0.88,
      fog: true,
    }),
  );

  // Blocks the view straight through both window bands. Without it the bus is
  // visibly hollow from every three-quarter angle.
  const cabinMat = track(
    new THREE.MeshStandardMaterial({ color: 0x0e1118, roughness: 0.94, metalness: 0.05, fog: true }),
  );

  const rubberMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x17181c,
      roughness: 0.93,
      metalness: 0.02,
      map: metal?.albedo ?? null,
      roughnessMap: metal?.rough ?? null,
      fog: true,
    }),
  );

  const balloonMat = track(
    new THREE.MeshStandardMaterial({
      map: balloonBake?.albedo ?? null,
      roughnessMap: balloonBake?.rough ?? null,
      normalMap: balloonNormal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      color: 0xffffff,
      metalness: 0.02,
      roughness: 1,
      // Thin fabric with a burner under it and the sun above it: the inside
      // of the envelope is never black, and the player is looking straight up
      // into it for the whole bus ride.
      emissive: new THREE.Color(0x2a3450),
      emissiveIntensity: 0.85,
      side: THREE.DoubleSide,
      envMap: env,
      envMapIntensity: 0.35,
      fog: true,
    }),
  );

  const lampMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x2a2418,
      emissive: new THREE.Color(0xffd18a),
      emissiveIntensity: 3.4,
      roughness: 0.3,
      metalness: 0.1,
      fog: true,
    }),
  );

  const tailLampMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x2a0e0e,
      emissive: new THREE.Color(0xff3a24),
      emissiveIntensity: 2.6,
      roughness: 0.35,
      metalness: 0.1,
      fog: true,
    }),
  );

  const boardMat = track(
    new THREE.MeshStandardMaterial({
      map: boardTex,
      emissiveMap: boardTex,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 2.2,
      color: 0x101010,
      roughness: 0.5,
      metalness: 0,
      fog: true,
    }),
  );

  const glowMat = track(
    new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffc98a,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      // Sprites do not fog; at 600 m the additive glow would otherwise be the
      // one part of the bus that ignores aerial perspective and it reads as a
      // UI element pasted on the sky.
      fog: true,
      opacity: 0.9,
    }),
  );

  const flameMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xffb45c,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    }),
  );

  // ---- part buckets ------------------------------------------------------
  const hullParts: Geo[] = [];
  const trimParts: Geo[] = [];
  const darkParts: Geo[] = [];
  const lampParts: Geo[] = [];
  const tailParts: Geo[] = [];
  const rubberParts: Geo[] = [];

  const { halfW, floorY, waistY, browY, shoulderY, roofY, halfL } = HULL;

  // ---- lower body --------------------------------------------------------
  hullParts.push(
    put(
      bevelBox(halfW * 2, waistY - floorY, halfL * 2, bevel, 0.34),
      0,
      (floorY + waistY) / 2,
      0,
    ),
  );
  // Upper body above the glass, and the roof cap, narrower each time — a
  // tumblehome silhouette. A slab-sided box the same width top to bottom is
  // the single most toy-like thing a vehicle can do.
  hullParts.push(
    put(bevelBox(halfW * 2 - 0.22, shoulderY - browY, halfL * 2 - 0.5, bevel, 0.3), 0, (browY + shoulderY) / 2, 0),
  );
  hullParts.push(
    put(bevelBox(halfW * 2 - 0.7, roofY - shoulderY, halfL * 2 - 1.1, bevel, 0.5), 0, (shoulderY + roofY) / 2, 0),
  );

  // Nose: a sloped windshield surround and a stepped front cap, so the front
  // three-quarter view is not a flat rectangle.
  hullParts.push(put(bevelBox(halfW * 2 - 0.3, 1.9, 0.5, bevel, 0.2), 0, 3.3, -halfL - 0.1, -0.22));
  hullParts.push(put(bevelBox(halfW * 2 - 0.1, 0.6, 1.2, bevel, 0.24), 0, waistY - 0.1, -halfL - 0.35, 0.16));

  // Rear: engine bay bulge and a stepped tail.
  hullParts.push(put(bevelBox(halfW * 2 - 0.4, 2.1, 0.8, bevel, 0.24), 0, 3.2, halfL + 0.15));
  hullParts.push(put(bevelBox(halfW * 2 - 1.0, 0.7, 0.7, bevel, 0.2), 0, waistY + 0.2, halfL + 0.5));

  // Tail fin — pure silhouette. The bus has to read at 800 m from the ground
  // and the fin is what makes the shape legible against the sky.
  hullParts.push(put(bevelBox(0.28, 2.6, 2.4, bevel, 0.3), 0, roofY + 1.3, halfL - 1.6));

  // ---- window band -------------------------------------------------------
  const windowH = browY - waistY;
  const glassGeo = boxProjectUv(
    put(bevelBox(halfW * 2 - 0.3, windowH - 0.12, halfL * 2 - 1.4, bevel * 0.6), 0, (waistY + browY) / 2, 0),
    2,
  );
  const glass = new THREE.Mesh(glassGeo, glassMat);
  glass.castShadow = false;
  glass.receiveShadow = false;
  sway.add(glass);
  geometries.push(glassGeo);

  const cabinGeo = new THREE.BoxGeometry(halfW * 2 - 0.6, windowH - 0.3, halfL * 2 - 1.9);
  const cabin = new THREE.Mesh(cabinGeo, cabinMat);
  cabin.position.set(0, (waistY + browY) / 2, 0);
  sway.add(cabin);
  geometries.push(cabinGeo);

  // Mullions between the windows, plus the corner posts. Eight per side.
  for (const sx of [-1, 1]) {
    for (let i = 0; i <= 7; i++) {
      const z = -halfL + 1.1 + (i * (halfL * 2 - 2.2)) / 7;
      hullParts.push(put(bevelBox(0.22, windowH, 0.34, bevel * 0.7), sx * (halfW - 0.06), (waistY + browY) / 2, z));
    }
    // Gutter over the windows — a real protruding lip, which is what makes
    // the shadow line under the roof read as thickness rather than as paint.
    trimParts.push(put(bevelBox(0.2, 0.16, halfL * 2 - 0.8, bevel * 0.6), sx * (halfW + 0.02), browY + 0.16, 0));
    // Waist trim strip under the windows.
    trimParts.push(put(bevelBox(0.12, 0.24, halfL * 2 - 0.7, bevel * 0.6), sx * (halfW + 0.03), waistY - 0.14, 0));
  }

  // ---- livery panels -----------------------------------------------------
  // Explicit 0..1 UVs, so the wordmark lands where it was drawn. Everything
  // else on the hull is box-projected and tiled.
  // The +X panel turns +90° so its normal ends up pointing +X; the −X panel
  // turns the other way. Get the sign backwards and the livery faces into the
  // cabin, which is invisible right up until someone screenshots the bus.
  const liveryGeoL = new THREE.PlaneGeometry(15.4, 1.36);
  liveryGeoL.rotateY(Math.PI / 2);
  liveryGeoL.translate(halfW + 0.021, 1.62, 0);
  const liveryGeoR = new THREE.PlaneGeometry(15.4, 1.36);
  liveryGeoR.rotateY(-Math.PI / 2);
  liveryGeoR.translate(-halfW - 0.021, 1.62, 0);
  const liveryMesh = new THREE.Mesh(mergeParts([liveryGeoL, liveryGeoR]), liveryMat);
  sway.add(liveryMesh);
  geometries.push(liveryMesh.geometry);

  // ---- belly -------------------------------------------------------------
  const bellyGeo = new THREE.PlaneGeometry(halfW * 2 - 0.5, halfL * 2 - 0.6);
  bellyGeo.rotateX(Math.PI / 2);
  bellyGeo.translate(0, floorY - 0.021, 0);
  const bellyMesh = new THREE.Mesh(bellyGeo, bellyMat);
  sway.add(bellyMesh);
  geometries.push(bellyGeo);

  // Belly ribs, so the underside has cross-section as well as a texture.
  for (let i = -4; i <= 4; i++) {
    trimParts.push(put(bevelBox(halfW * 2 - 0.9, 0.14, 0.18, bevel * 0.6), 0, floorY - 0.09, i * 2.1));
  }
  // Running lights down both belly edges, as actual emissive geometry rather
  // than paint. The rider is looking straight up at this surface for
  // thirty-five seconds and it is the one part of the bus the key light never
  // reaches — without its own light it is a black rectangle.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 11; i++) {
      const z = -9.4 + i * 1.88;
      lampParts.push(put(bevelBox(0.26, 0.07, 0.5, bevel * 0.4), sx * (halfW - 0.42), floorY - 0.09, z));
      darkParts.push(put(bevelBox(0.4, 0.1, 0.64, bevel * 0.4), sx * (halfW - 0.42), floorY - 0.03, z));
    }
  }

  // ---- grab rails and straps --------------------------------------------
  // The rider hangs at local x = +1.5. Both rails exist; only one is ever
  // occupied, and the strap at z = 0 is the one in their hand.
  for (const sx of [-1, 1]) {
    trimParts.push(put(tubeZ(0.055, 0.055, halfL * 2 - 2.4, 8), sx * 1.5, floorY - 0.16, 0));
    for (const z of [-7.2, -4.4, -1.6, 0, 2.4, 5.6, 8.4]) {
      const drop = z === 0 ? 0.62 : 0.4 + rng() * 0.34;
      darkParts.push(put(bevelBox(0.07, drop, 0.16, bevel * 0.5), sx * 1.5, floorY - 0.18 - drop / 2, z));
      // The loop at the bottom of the strap.
      darkParts.push(
        put(new THREE.TorusGeometry(0.1, 0.03, 5, 10), sx * 1.5, floorY - 0.2 - drop, z, Math.PI / 2),
      );
    }
    // Boarding step, worn to bare metal — the classic contact-point detail.
    trimParts.push(put(bevelBox(0.5, 0.1, 1.4, bevel * 0.6), sx * (halfW - 0.1), floorY - 0.06, -6.4));
  }

  // ---- bumpers, lamps, grille -------------------------------------------
  for (const sz of [-1, 1]) {
    trimParts.push(put(bevelBox(halfW * 2 + 0.24, 0.5, 0.72, bevel, 0.16), 0, 1.35, sz * (halfL + 0.42)));
    // Bumper irons.
    for (const sx of [-1, 1]) {
      darkParts.push(put(bevelBox(0.22, 0.5, 0.36, bevel * 0.6), sx * 1.9, 1.35, sz * (halfL + 0.15)));
    }
  }
  // Grille slats behind the front bumper.
  for (let i = 0; i < 7; i++) {
    darkParts.push(put(bevelBox(3.6, 0.1, 0.16, bevel * 0.5), 0, 1.72 + i * 0.16, -halfL - 0.34, 0.18));
  }
  // Head lamps in recessed housings; tail lamps in the same treatment.
  for (const sx of [-1, 1]) {
    darkParts.push(put(tubeZ(0.42, 0.42, 0.3, 12), sx * 2.05, 1.95, -halfL - 0.18));
    lampParts.push(put(tubeZ(0.33, 0.33, 0.12, 12), sx * 2.05, 1.95, -halfL - 0.3));
    darkParts.push(put(tubeZ(0.2, 0.2, 0.24, 10), sx * 1.25, 1.72, -halfL - 0.2));
    lampParts.push(put(tubeZ(0.14, 0.14, 0.1, 10), sx * 1.25, 1.72, -halfL - 0.29));
    tailParts.push(put(bevelBox(0.5, 0.34, 0.1, bevel * 0.5), sx * 2.15, 1.95, halfL + 0.42));
  }
  // Marker lamps along the roof edge — five a side, the detail that makes the
  // silhouette twinkle when the bus banks.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const z = -6.4 + i * 3.2;
      lampParts.push(put(new THREE.SphereGeometry(0.09, 7, 5), sx * (halfW - 0.5), roofY + 0.04, z));
    }
  }

  // ---- destination board -------------------------------------------------
  const boardGeo = new THREE.PlaneGeometry(3.9, 0.95);
  // The plane's normal is +Z and the board lives on the nose, which faces −Z,
  // so the flip happens on the geometry *before* it is moved into place —
  // rotating the mesh afterwards would swing it to the back of the bus.
  boardGeo.rotateY(Math.PI);
  boardGeo.translate(0, 4.52, -halfL - 0.06);
  const boardMesh = new THREE.Mesh(boardGeo, boardMat);
  sway.add(boardMesh);
  geometries.push(boardGeo);
  darkParts.push(put(bevelBox(4.2, 1.2, 0.16, bevel * 0.6), 0, 4.52, -halfL - 0.02));

  // ---- vents, exhausts, ladder, mirrors ---------------------------------
  for (const sx of [-1, 1]) {
    // Louvred vent panel over the engine bay: a recessed frame plus six
    // angled blades. Vents are the cheapest way to say "this machine has an
    // inside".
    darkParts.push(put(bevelBox(0.1, 1.05, 2.1, bevel * 0.5), sx * (halfW - 0.02), 1.85, 7.4));
    for (let i = 0; i < 6; i++) {
      trimParts.push(
        put(bevelBox(0.08, 0.12, 1.9, bevel * 0.4), sx * (halfW + 0.03), 1.45 + i * 0.16, 7.4, -0.5),
      );
    }
    // Exhaust stack at the rear corner.
    darkParts.push(put(tubeZ(0.17, 0.2, 1.1, 10), sx * 2.2, 1.5, halfL + 0.35));
    trimParts.push(put(tubeZ(0.21, 0.21, 0.16, 10), sx * 2.2, 1.5, halfL + 0.88));
    // Mirror stalk and head.
    trimParts.push(
      put(tubeX(0.05, 0.05, 0.8, 6), sx * (halfW + 0.4), 4.35, -halfL + 0.6),
    );
    darkParts.push(put(bevelBox(0.14, 0.62, 0.34, bevel * 0.5), sx * (halfW + 0.78), 4.15, -halfL + 0.6, 0, 0.2));
  }
  // Rear ladder.
  for (const sx of [-1, 1]) {
    trimParts.push(put(tube(0.045, 0.045, 3.9, 6), sx * 0.62, 3.4, halfL + 0.62));
  }
  for (let i = 0; i < 6; i++) {
    trimParts.push(put(tubeX(0.035, 0.035, 1.24, 6), 0, 1.7 + i * 0.62, halfL + 0.62));
  }
  // Tow eye, front centre.
  darkParts.push(put(new THREE.TorusGeometry(0.16, 0.05, 6, 12), 0, 1.32, -halfL - 0.62, Math.PI / 2));

  // ---- wheels ------------------------------------------------------------
  // Never retracted, because a bus with its wheels tucked away is an
  // aircraft, and the joke only lands if it is unmistakably a bus.
  // Wheel centres sit *below* the belly line on purpose: buried in the well
  // at the hull's own height they would be completely invisible, and the
  // whole joke depends on the thing unmistakably being a bus.
  const wheelY = 0.55;
  const wheelZ = [-7.1, 5.4, 7.4];
  for (const sx of [-1, 1]) {
    for (const wz of wheelZ) {
      rubberParts.push(put(tubeX(0.78, 0.78, 0.62, 14), sx * 2.42, wheelY, wz));
      trimParts.push(put(tubeX(0.42, 0.42, 0.66, 12), sx * 2.42, wheelY, wz));
      darkParts.push(put(tubeX(0.16, 0.16, 0.7, 8), sx * 2.42, wheelY, wz));
      // The lip of the wheel well, at the belly line.
      hullParts.push(put(bevelBox(0.94, 0.3, 2.0, bevel, 0.3), sx * 2.42, floorY + 0.14, wz));
    }
  }
  // Axle beam between the rear pair — visible from directly below, which is
  // exactly where the player spends the ride.
  darkParts.push(put(tubeX(0.13, 0.13, 4.9, 8), 0, wheelY, 6.4));

  // ---- roof rack ---------------------------------------------------------
  for (const sx of [-1, 1]) {
    trimParts.push(put(tubeZ(0.07, 0.07, 16.4, 8), sx * 2.1, roofY + 0.42, 0));
    for (let i = 0; i < 6; i++) {
      trimParts.push(put(tube(0.05, 0.05, 0.42, 6), sx * 2.1, roofY + 0.21, -8 + i * 3.2));
    }
  }
  for (let i = 0; i < 5; i++) {
    trimParts.push(put(tubeX(0.06, 0.06, 4.2, 8), 0, roofY + 0.42, -7.2 + i * 3.6));
  }
  // Lashed cargo: three crates and a tarp, at three sizes and three angles.
  hullParts.push(put(bevelBox(1.9, 0.9, 2.6, bevel, 0.12), -0.6, roofY + 0.95, -4.6, 0, 0.09));
  hullParts.push(put(bevelBox(1.4, 0.7, 1.5, bevel, 0.1), 0.9, roofY + 0.85, -1.4, 0, -0.16));
  darkParts.push(put(bevelBox(3.5, 0.62, 4.4, bevel, 0.42), 0, roofY + 0.82, 3.4, 0, 0.04));
  for (const z of [-4.6, 3.4]) {
    for (const sx of [-1, 1]) {
      darkParts.push(put(bevelBox(0.09, 1.1, 0.14, bevel * 0.4), sx * 1.1, roofY + 0.85, z));
    }
  }

  // ---- thruster nacelles -------------------------------------------------
  const rotors: THREE.Object3D[] = [];
  const thrusterGlows: THREE.Sprite[] = [];
  const exhausts: THREE.Vector3[] = [];
  const NACELLE_Z = 4.6;
  for (const sx of [-1, 1]) {
    const x = sx * (halfW + 1.25);
    // Duct: an open shell so the rotor inside is visible, with a lip at each
    // end and a pylon back to the hull.
    darkParts.push(put(new THREE.CylinderGeometry(1.15, 1.15, 3.3, 18, 1, true), x, 3.1, NACELLE_Z, Math.PI / 2));
    trimParts.push(put(new THREE.TorusGeometry(1.16, 0.09, 6, 20), x, 3.1, NACELLE_Z - 1.65));
    trimParts.push(put(new THREE.TorusGeometry(1.16, 0.09, 6, 20), x, 3.1, NACELLE_Z + 1.65));
    trimParts.push(put(bevelBox(1.3, 0.36, 1.5, bevel * 0.7), sx * (halfW + 0.6), 3.1, NACELLE_Z, 0, 0, sx * 0.12));
    darkParts.push(put(tubeZ(0.28, 0.28, 3.2, 10), x, 3.1, NACELLE_Z));

    // Rotor: four blades with a real twist, spun in `update`.
    const blades: Geo[] = [];
    for (let b = 0; b < 4; b++) {
      // Pitch each blade about its own long axis first, then swing it around
      // the hub — a fan whose blades are flat reads as a four-armed cross.
      const g = bevelBox(2.0, 0.09, 0.42, bevel * 0.5);
      g.rotateX(0.38);
      g.translate(1.0, 0, 0);
      g.rotateZ((b * Math.PI) / 2);
      blades.push(g);
    }
    blades.push(put(tubeZ(0.34, 0.34, 0.5, 10), 0, 0, 0));
    const rotorGeo = boxProjectUv(mergeParts(blades), 1.4);
    const rotor = new THREE.Mesh(rotorGeo, darkMetalMat);
    rotor.position.set(x, 3.1, NACELLE_Z);
    rotor.castShadow = false;
    sway.add(rotor);
    rotors.push(rotor);
    geometries.push(rotorGeo);

    const glow = new THREE.Sprite(glowMat);
    glow.position.set(x, 3.1, NACELLE_Z + 1.9);
    glow.scale.setScalar(3.4);
    sway.add(glow);
    thrusterGlows.push(glow);
    exhausts.push(new THREE.Vector3(x, 3.1, NACELLE_Z + 2.1));
  }

  // ---- balloon -----------------------------------------------------------
  const balloonGroup = new THREE.Object3D();
  balloonGroup.name = "dz-bus-balloon";
  sway.add(balloonGroup);

  const MOUTH_Y = 9.8;
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(2.6, MOUTH_Y),
    new THREE.Vector2(4.4, MOUTH_Y + 0.9),
    new THREE.Vector2(6.8, MOUTH_Y + 2.2),
    new THREE.Vector2(9.3, MOUTH_Y + 4.3),
    new THREE.Vector2(10.7, MOUTH_Y + 6.6),
    new THREE.Vector2(11.0, MOUTH_Y + 8.6),
    new THREE.Vector2(10.2, MOUTH_Y + 10.7),
    new THREE.Vector2(8.0, MOUTH_Y + 12.6),
    new THREE.Vector2(4.9, MOUTH_Y + 14.1),
    new THREE.Vector2(2.2, MOUTH_Y + 15.0),
    new THREE.Vector2(0.0, MOUTH_Y + 15.35),
  ];
  const segs = quality === "low" ? 20 : quality === "medium" ? 28 : 40;
  const envelopeGeo = new THREE.LatheGeometry(profile, segs);
  const envelope = new THREE.Mesh(envelopeGeo, balloonMat);
  envelope.castShadow = quality !== "low";
  balloonGroup.add(envelope);
  geometries.push(envelopeGeo);

  // Load tapes: three hoops of real thickness around the envelope. The lathe
  // alone has no cross-section anywhere and reads as a balloon-shaped decal.
  const tapeParts: Geo[] = [];
  for (const [r, y] of [
    [6.9, MOUTH_Y + 2.25],
    [10.75, MOUTH_Y + 6.7],
    [8.1, MOUTH_Y + 12.5],
  ] as const) {
    tapeParts.push(put(new THREE.TorusGeometry(r, 0.11, 6, quality === "low" ? 16 : 28), 0, y, 0, Math.PI / 2));
  }
  // Vertical ribs at eight gore seams, standing 6 cm proud of the envelope.
  const RIBS = quality === "low" ? 4 : 8;
  for (let i = 0; i < RIBS; i++) {
    const a = (i / RIBS) * Math.PI * 2;
    const ribProfile = profile.map((p) => new THREE.Vector2(p.x * 1.012 + 0.02, p.y));
    tapeParts.push(new THREE.LatheGeometry(ribProfile, 2, a - 0.028, 0.056));
  }
  const tapesGeo = boxProjectUv(mergeParts(tapeParts), 3);
  const tapes = new THREE.Mesh(tapesGeo, trimMat);
  balloonGroup.add(tapes);
  geometries.push(tapesGeo);

  // Crown cap and the mouth ring.
  const balloonHardware: Geo[] = [];
  balloonHardware.push(put(tube(0.9, 1.4, 0.5, 12), 0, MOUTH_Y + 15.1, 0));
  balloonHardware.push(put(new THREE.TorusGeometry(2.6, 0.13, 6, 20), 0, MOUTH_Y, 0, Math.PI / 2));
  balloonHardware.push(put(new THREE.TorusGeometry(1.55, 0.1, 6, 16), 0, MOUTH_Y - 0.9, 0, Math.PI / 2));
  // Burner block and its fuel lines.
  balloonHardware.push(put(bevelBox(0.9, 0.7, 0.9, bevel, 0.16), 0, MOUTH_Y - 1.5, 0));
  for (const sx of [-1, 1]) {
    balloonHardware.push(
      strut(
        new THREE.Vector3(sx * 0.35, MOUTH_Y - 1.6, 0.2),
        new THREE.Vector3(sx * 1.1, roofY + 0.6, 1.4),
        0.055,
      ),
    );
  }
  const hardwareGeo = boxProjectUv(mergeParts(balloonHardware), 1.5);
  const hardware = new THREE.Mesh(hardwareGeo, trimMat);
  balloonGroup.add(hardware);
  geometries.push(hardwareGeo);

  // Rigging: eight ropes from the mouth ring down to the roof rack corners,
  // plus four cross-braces. Real cylinders, not lines — a line has no
  // thickness at distance and vanishes exactly when the silhouette needs it.
  const rigParts: Geo[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const top = new THREE.Vector3(Math.cos(a) * 2.55, MOUTH_Y - 0.05, Math.sin(a) * 2.55);
    const bx = Math.cos(a) > 0 ? 2.15 : -2.15;
    const bz = Math.sin(a) * 7.6;
    const bot = new THREE.Vector3(bx, roofY + 0.5, bz);
    rigParts.push(strut(top, bot, 0.045, 5));
  }
  for (const sx of [-1, 1]) {
    rigParts.push(
      strut(
        new THREE.Vector3(sx * 2.15, roofY + 0.5, -7.6),
        new THREE.Vector3(sx * 2.15, roofY + 0.5, 7.6),
        0.035,
        5,
      ),
    );
  }
  const rigGeo = boxProjectUv(mergeParts(rigParts), 1);
  const rigging = new THREE.Mesh(rigGeo, darkMetalMat);
  sway.add(rigging);
  geometries.push(rigGeo);

  // Burner flame: a cone up into the mouth, additive, flickered in `update`.
  const flameGeo = new THREE.ConeGeometry(0.85, 3.2, 12, 1, true);
  flameGeo.translate(0, 1.6, 0);
  const flame = new THREE.Mesh(flameGeo, flameMat);
  flame.position.set(0, MOUTH_Y - 1.1, 0);
  balloonGroup.add(flame);
  geometries.push(flameGeo);

  const burnerGlow = new THREE.Sprite(glowMat.clone());
  (burnerGlow.material as THREE.SpriteMaterial).color = new THREE.Color(0xffbe72);
  materials.push(burnerGlow.material as THREE.Material);
  burnerGlow.position.set(0, MOUTH_Y + 0.6, 0);
  burnerGlow.scale.setScalar(7);
  balloonGroup.add(burnerGlow);

  // A pennant on the tail fin, for a scrap of motion that is not a sine on
  // the whole vehicle.
  const pennantGeo = new THREE.PlaneGeometry(1.5, 0.7, 6, 2);
  pennantGeo.translate(0.75, 0, 0);
  const pennant = new THREE.Mesh(pennantGeo, balloonMat);
  pennant.position.set(0.16, roofY + 2.5, halfL - 1.6);
  pennant.rotation.y = Math.PI / 2;
  sway.add(pennant);
  geometries.push(pennantGeo);

  // ---- bake the buckets --------------------------------------------------
  const addMerged = (parts: Geo[], mat: THREE.Material, uvScale: number, shadow: boolean): void => {
    if (parts.length === 0) return;
    const geo = boxProjectUv(mergeParts(parts), uvScale);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = shadow && quality !== "low";
    mesh.receiveShadow = false;
    sway.add(mesh);
    geometries.push(geo);
  };
  addMerged(hullParts, hullMat, 2.2, true);
  addMerged(trimParts, trimMat, 1.2, false);
  addMerged(darkParts, darkMetalMat, 1.2, false);
  addMerged(lampParts, lampMat, 1, false);
  addMerged(tailParts, tailLampMat, 1, false);
  addMerged(rubberParts, rubberMat, 0.8, false);

  return {
    root,
    sway,
    balloon: balloonGroup,
    rotors,
    flame,
    flameMat,
    burnerGlow,
    thrusterGlows,
    exhausts,
    geometries,
    materials,
    textures,
  };
}

/* ------------------------------------------------------------------------ *
 * The bus's smoke trail
 *
 * A ring buffer of camera-facing points on a hand-written shader rather than
 * `PointsMaterial`, for one reason: per-particle alpha. `PointsMaterial` can
 * only fade a puff by fading its *colour*, which on additive blending is fine
 * and on normal blending turns every dying puff black. Smoke has to fade to
 * transparent, not to soot, so it gets its own twenty lines of GLSL — which
 * also lets it run the scene's exponential fog by hand and sit correctly
 * behind the haze at 600 m.
 * ------------------------------------------------------------------------ */

interface SmokeTrail {
  object: THREE.Points;
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number): void;
  update(dt: number): void;
  clear(): void;
  dispose(): void;
}

function makeSmokeTrail(count: number, map: THREE.Texture | null, rng: () => number): SmokeTrail {
  const pos = new Float32Array(count * 3);
  const alpha = new Float32Array(count);
  const size = new Float32Array(count);
  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const maxLife = new Float32Array(count);
  const grow = new Float32Array(count);
  let cursor = 0;
  let live = 0;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  // The bus is the only thing in the trail's neighbourhood, and the sphere is
  // recomputed nowhere — a generous fixed bound is cheaper and never culls
  // the trail out while the camera is inside it.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4000);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uColor: { value: new THREE.Color(0xdfe7f2) },
      fogColor: { value: new THREE.Color(0xa8c8dc) },
      fogDensity: { value: 0.00012 },
      fogNear: { value: 1 },
      fogFar: { value: 4000 },
    },
    vertexShader: `
      attribute float aAlpha;
      attribute float aSize;
      varying float vAlpha;
      #include <fog_pars_vertex>
      void main() {
        vAlpha = aAlpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (320.0 / max(0.001, -mvPosition.z));
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        vec4 tex = texture2D(uMap, gl_PointCoord);
        float a = tex.a * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor * tex.rgb, a);
        #include <fog_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    fog: true,
  });

  const object = new THREE.Points(geo, mat);
  object.frustumCulled = false;
  object.renderOrder = 3;
  object.name = "dz-bus-smoke";

  return {
    object,
    emit(x, y, z, vx, vy, vz, s) {
      const i = cursor;
      cursor = (cursor + 1) % count;
      if (live < count) live++;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      vel[i * 3] = vx;
      vel[i * 3 + 1] = vy;
      vel[i * 3 + 2] = vz;
      life[i] = 0;
      // Spread the lifetimes hard. Puffs that all die at the same age make
      // the trail pulse in time with the emitter, which is the giveaway that
      // it is a particle system rather than exhaust.
      maxLife[i] = 3.2 + rng() * 5.5;
      size[i] = s * (0.7 + rng() * 0.7);
      grow[i] = s * (2.6 + rng() * 3.4);
      alpha[i] = 0;
    },
    update(dt) {
      for (let i = 0; i < live; i++) {
        if (life[i] >= maxLife[i]) {
          alpha[i] = 0;
          continue;
        }
        life[i] += dt;
        const t = clamp01(life[i] / maxLife[i]);
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        // Drag, plus a little buoyancy: hot exhaust rises before it cools.
        const drag = Math.exp(-0.55 * dt);
        vel[i * 3] *= drag;
        vel[i * 3 + 1] = vel[i * 3 + 1] * drag + 1.6 * dt;
        vel[i * 3 + 2] *= drag;
        size[i] += grow[i] * dt;
        // Fast in, slow out: a puff appears at full density and thins for the
        // rest of its life, which is how smoke actually behaves.
        alpha[i] = smoothstep(0, 0.08, t) * (1 - t) * (1 - t) * 0.5;
      }
      geo.attributes.position.needsUpdate = true;
      (geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
      (geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      geo.setDrawRange(0, live);
    },
    clear() {
      for (let i = 0; i < count; i++) {
        alpha[i] = 0;
        life[i] = 1e9;
        maxLife[i] = 1;
      }
      live = 0;
      cursor = 0;
      geo.setDrawRange(0, 0);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/* ------------------------------------------------------------------------ *
 * The crowd
 *
 * Ninety-odd people leave this bus and `bots.ts` cannot afford to simulate
 * ninety-odd people. So the ones you will never meet are *seen* and not
 * simulated: a canopy, a body and a contrail each, on a closed-form arc from
 * the bus to a POI, fading out a few seconds after they land. Two instanced
 * meshes and one `LineSegments` for the whole lobby.
 *
 * They are cosmetic by construction — nothing here damages, blocks, loots or
 * appears in the alive count except through the drain curve, which is a
 * number, not an actor.
 * ------------------------------------------------------------------------ */

type DiverStage = "waiting" | "freefall" | "canopy" | "down";

interface Diver {
  stage: DiverStage;
  releaseT: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  groundY: number;
  canopyColor: THREE.Color;
  fade: number;
  /** Ring buffer of past positions for the contrail. */
  trail: Float32Array;
  trailCount: number;
  trailTimer: number;
  spin: number;
}

const TRAIL_POINTS = 9;

interface Crowd {
  root: THREE.Object3D;
  /** Release a diver at the bus's current position, heading for `target`. */
  release(from: THREE.Vector3, target: THREE.Vector3, groundY: number): void;
  update(dt: number): void;
  readonly airborne: number;
  dispose(): void;
}

function makeCrowd(count: number, rng: () => number): Crowd {
  const root = new THREE.Object3D();
  root.name = "dz-crowd";
  if (count <= 0) {
    return {
      root,
      release() {},
      update() {},
      get airborne() {
        return 0;
      },
      dispose() {},
    };
  }

  // Canopy: a shallow dome with a scalloped skirt. Double-sided, because half
  // the time you are under one looking up.
  const canopyGeo = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.44);
  canopyGeo.scale(1, 0.62, 1);
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0.02,
    side: THREE.DoubleSide,
    // Thin nylon with the sun behind it. Without a fill the underside — the
    // side you see for the entire descent, from below — renders black, and a
    // sky full of black canopies looks like a swarm of bats.
    emissive: new THREE.Color(0x9fbcd8),
    emissiveIntensity: 0.42,
    fog: true,
  });
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, count);
  canopies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  canopies.frustumCulled = false;
  canopies.castShadow = false;
  root.add(canopies);

  const bodyGeo = new THREE.CapsuleGeometry(0.32, 0.9, 3, 6);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x39435c,
    roughness: 0.72,
    metalness: 0.1,
    emissive: new THREE.Color(0x8fa8c4),
    emissiveIntensity: 0.22,
    fog: true,
  });
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bodies.frustumCulled = false;
  root.add(bodies);

  // Contrails. Per-vertex RGBA (three enables alpha as soon as the colour
  // attribute has four components), so each streak fades along its length
  // without a second draw call.
  const segs = TRAIL_POINTS - 1;
  const trailPos = new Float32Array(count * segs * 2 * 3);
  const trailCol = new Float32Array(count * segs * 2 * 4);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 4));
  trailGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4000);
  const trailMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const trails = new THREE.LineSegments(trailGeo, trailMat);
  trails.frustumCulled = false;
  trails.renderOrder = 2;
  root.add(trails);

  const divers: Diver[] = [];
  for (let i = 0; i < count; i++) {
    divers.push({
      stage: "waiting",
      releaseT: 0,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      target: new THREE.Vector3(),
      groundY: 0,
      canopyColor: new THREE.Color(),
      fade: 0,
      trail: new Float32Array(TRAIL_POINTS * 3),
      trailCount: 0,
      trailTimer: 0,
      spin: 0,
    });
  }
  let next = 0;

  const dummy = new THREE.Object3D();
  const tmp = new THREE.Vector3();
  let airborneCount = 0;
  // Canopy palette: the same rarity-ish spread of saturated hues Fortnite's
  // gliders use, so a sky full of them reads as a crowd of individuals.
  const PALETTE = [0xf25f5c, 0x4c8bf5, 0x53d24a, 0xf2a93b, 0xb455f0, 0xf4f4f4, 0x22c7c7];

  /** Terminal speeds. Deliberately faster than a real skydiver — this is a game. */
  const FREEFALL_TERMINAL = 74;
  const CANOPY_FALL = 13;
  const CANOPY_ALT = 130;

  return {
    root,
    release(from, target, groundY) {
      const d = divers[next];
      next = (next + 1) % count;
      d.stage = "freefall";
      d.pos.copy(from);
      // Scatter the exit so they do not leave the bus through one hole.
      d.pos.x += (rng() * 2 - 1) * 5;
      d.pos.y += (rng() * 2 - 1) * 1.5;
      d.pos.z += (rng() * 2 - 1) * 5;
      d.vel.set((rng() * 2 - 1) * 8, -6, (rng() * 2 - 1) * 8);
      d.target.copy(target);
      d.target.x += (rng() * 2 - 1) * 60;
      d.target.z += (rng() * 2 - 1) * 60;
      d.groundY = groundY;
      d.canopyColor.setHex(PALETTE[Math.floor(rng() * PALETTE.length)]);
      d.fade = 0;
      d.trailCount = 0;
      d.trailTimer = 0;
      d.spin = rng() * Math.PI * 2;
    },
    update(dt) {
      let airborne = 0;
      let ti = 0;
      for (let i = 0; i < count; i++) {
        const d = divers[i];
        if (d.stage === "waiting") {
          dummy.position.set(0, -10000, 0);
          dummy.scale.setScalar(0.0001);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          canopies.setMatrixAt(i, dummy.matrix);
          bodies.setMatrixAt(i, dummy.matrix);
          continue;
        }

        if (d.stage !== "down") {
          airborne++;
          tmp.subVectors(d.target, d.pos);
          tmp.y = 0;
          const dist = tmp.length() || 1;
          tmp.divideScalar(dist);
          if (d.stage === "freefall") {
            d.vel.y = damp(d.vel.y, -FREEFALL_TERMINAL, 0.6, dt);
            // Steer, hard, toward the target — a diver that misses its POI
            // and lands in the sea is a bug the player can see from the bus.
            const want = Math.min(52, dist * 0.6);
            d.vel.x = damp(d.vel.x, tmp.x * want, 1.4, dt);
            d.vel.z = damp(d.vel.z, tmp.z * want, 1.4, dt);
            if (d.pos.y - d.groundY < CANOPY_ALT) d.stage = "canopy";
          } else {
            d.vel.y = damp(d.vel.y, -CANOPY_FALL, 3.5, dt);
            const want = Math.min(26, dist * 0.9);
            d.vel.x = damp(d.vel.x, tmp.x * want, 2.5, dt);
            d.vel.z = damp(d.vel.z, tmp.z * want, 2.5, dt);
          }
          d.pos.addScaledVector(d.vel, dt);
          if (d.pos.y <= d.groundY + 0.6) {
            d.pos.y = d.groundY + 0.6;
            d.stage = "down";
            d.fade = 1;
          }

          // Trail sampling: fixed interval, not per frame, so the streak has
          // the same length regardless of frame rate.
          d.trailTimer -= dt;
          if (d.trailTimer <= 0) {
            d.trailTimer = 0.09;
            for (let k = TRAIL_POINTS - 1; k > 0; k--) {
              d.trail[k * 3] = d.trail[(k - 1) * 3];
              d.trail[k * 3 + 1] = d.trail[(k - 1) * 3 + 1];
              d.trail[k * 3 + 2] = d.trail[(k - 1) * 3 + 2];
            }
            d.trail[0] = d.pos.x;
            d.trail[1] = d.pos.y;
            d.trail[2] = d.pos.z;
            if (d.trailCount < TRAIL_POINTS) d.trailCount++;
          }
        } else if (d.fade > 0) {
          d.fade = Math.max(0, d.fade - dt * 0.55);
          if (d.fade <= 0) d.stage = "waiting";
        }

        const alive = d.stage !== "down" ? 1 : d.fade;
        d.spin += dt * (d.stage === "freefall" ? 1.1 : 0.35);

        // Body: always drawn, pitched forward while diving.
        dummy.position.copy(d.pos);
        dummy.rotation.set(d.stage === "freefall" ? 1.15 : 0.12, d.spin, 0, "YXZ");
        dummy.scale.setScalar(alive);
        dummy.updateMatrix();
        bodies.setMatrixAt(i, dummy.matrix);

        // Canopy: only once it is open, hanging four metres above the body and
        // banked into the turn.
        if (d.stage === "canopy" || (d.stage === "down" && d.fade > 0)) {
          dummy.position.set(d.pos.x, d.pos.y + 4.1, d.pos.z);
          dummy.scale.setScalar(3.4 * alive);
          dummy.rotation.set(0, d.spin, clamp(-d.vel.x * 0.006, -0.2, 0.2), "YXZ");
          dummy.updateMatrix();
          canopies.setMatrixAt(i, dummy.matrix);
          canopies.setColorAt(i, d.canopyColor);
        } else {
          dummy.position.set(0, -10000, 0);
          dummy.scale.setScalar(0.0001);
          dummy.updateMatrix();
          canopies.setMatrixAt(i, dummy.matrix);
        }

        // Contrail segments, oldest end faded to nothing.
        for (let k = 0; k + 1 < d.trailCount; k++) {
          const base = ti * 6;
          trailPos[base] = d.trail[k * 3];
          trailPos[base + 1] = d.trail[k * 3 + 1];
          trailPos[base + 2] = d.trail[k * 3 + 2];
          trailPos[base + 3] = d.trail[(k + 1) * 3];
          trailPos[base + 4] = d.trail[(k + 1) * 3 + 1];
          trailPos[base + 5] = d.trail[(k + 1) * 3 + 2];
          const a0 = (1 - k / TRAIL_POINTS) * 0.5 * alive;
          const a1 = (1 - (k + 1) / TRAIL_POINTS) * 0.5 * alive;
          const cb = ti * 8;
          trailCol[cb] = 1;
          trailCol[cb + 1] = 1;
          trailCol[cb + 2] = 1;
          trailCol[cb + 3] = a0;
          trailCol[cb + 4] = 1;
          trailCol[cb + 5] = 1;
          trailCol[cb + 6] = 1;
          trailCol[cb + 7] = a1;
          ti++;
        }
      }

      canopies.instanceMatrix.needsUpdate = true;
      if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
      bodies.instanceMatrix.needsUpdate = true;
      trailGeo.setDrawRange(0, ti * 2);
      trailGeo.attributes.position.needsUpdate = true;
      trailGeo.attributes.color.needsUpdate = true;
      root.visible = airborne > 0 || ti > 0;
      airborneCount = airborne;
    },
    get airborne() {
      return airborneCount;
    },
    dispose() {
      canopyGeo.dispose();
      canopyMat.dispose();
      bodyGeo.dispose();
      bodyMat.dispose();
      trailGeo.dispose();
      trailMat.dispose();
      canopies.dispose();
      bodies.dispose();
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Names
 *
 * Every elimination line needs somebody's handle on it. Generated rather than
 * listed so the lobby is different every match, and stable per id so the same
 * bot is called the same thing in the feed, on the damage numbers and on the
 * card at the end.
 * ------------------------------------------------------------------------ */

const NAME_PREFIX = [
  "Salt", "Iron", "Neon", "Storm", "Ash", "Vapor", "Cobalt", "Rust", "Onyx", "Jade",
  "Static", "Ghost", "Cinder", "Frost", "Lucky", "Grim", "Solar", "Void", "Rogue", "Nova",
  "Quiet", "Feral", "Gilded", "Wired", "Bitter", "Hollow", "Rapid", "Molten", "Pale", "Vivid",
];

const NAME_SUFFIX = [
  "Fox", "Bandit", "Vulture", "Hawk", "Wolf", "Otter", "Magpie", "Shark", "Moth", "Crane",
  "Widow", "Jackal", "Heron", "Viper", "Badger", "Falcon", "Cobra", "Lynx", "Raven", "Gull",
  "Comet", "Anchor", "Hammer", "Signal", "Ranger", "Drifter", "Runner", "Prowler", "Sentry", "Nomad",
];

/** Suffixes that make a handle look like it came off a real leaderboard. */
const NAME_TAG = ["", "", "", "_TV", "77", "01", "xx", "_YT", "99", "_", "42", "GG"];

function makeNamePool(rng: () => number, size: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let guard = 0;
  while (out.length < size && guard++ < size * 40) {
    const n =
      NAME_PREFIX[Math.floor(rng() * NAME_PREFIX.length)] +
      NAME_SUFFIX[Math.floor(rng() * NAME_SUFFIX.length)] +
      NAME_TAG[Math.floor(rng() * NAME_TAG.length)];
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Weapons the fabricated feed lines cite. Kept to what `weapons.ts` racks. */
const FEED_WEAPONS = [
  "AR", "AR", "AR", "Pump", "Tac", "SMG", "SMG", "Sniper", "Pistol", "Burst", "Grenade", "Pickaxe",
];

/* ------------------------------------------------------------------------ *
 * The system
 * ------------------------------------------------------------------------ */

/**
 * `System` in `types.ts` does not carry `fixed` — the engine looks for it
 * structurally (`FixedSystem` in `engine/core.ts`) and every simulation module
 * widens the interface locally rather than editing the shared contract while
 * a dozen systems are compiling against it. Same here.
 */
interface FixedSystem extends System {
  fixed(dt: number, ctx: WorldCtx): void;
}

const createMatch: SystemFactory = (ctx: WorldCtx): System => {
  const services = ctx.services as MatchServices;

  /**
   * A *fresh* stream, not `ctx.rng`. `ctx.rng` is the world seed and must
   * stay deterministic so the island regenerates identically; the bus route
   * is the one thing that has to differ every time you press play, because
   * the route is the match's opening decision.
   */
  const rng = makeRng(((Math.random() * 0xffffffff) >>> 0) ^ 0x9e3779b9);

  // ---- the route ---------------------------------------------------------
  const routeAngle = rng() * Math.PI * 2;
  const dirX = Math.cos(routeAngle);
  const dirZ = Math.sin(routeAngle);
  const offset = (rng() * 2 - 1) * ROUTE_OFFSET;
  const midX = -dirZ * offset;
  const midZ = dirX * offset;
  const busFrom = new THREE.Vector3(
    midX - dirX * ROUTE_HALF,
    BUS_ALTITUDE,
    midZ - dirZ * ROUTE_HALF,
  );
  const busTo = new THREE.Vector3(midX + dirX * ROUTE_HALF, BUS_ALTITUDE, midZ + dirZ * ROUTE_HALF);
  const routeDir = new THREE.Vector3().subVectors(busTo, busFrom);
  const routeLength = routeDir.length();
  routeDir.normalize();
  /** The bus's right-hand side, which is the side the player hangs off. */
  const routeRight = new THREE.Vector3(-routeDir.z, 0, routeDir.x);

  // ---- state -------------------------------------------------------------
  let phase: MatchPhase = "warmup";
  let phaseTime = 0;
  let liveAt = -1;
  /** Unclamped route progress — the bus flies in before the phase starts. */
  let routeU = BUS_PREROLL;
  let warmupT = 0;
  let jumped = false;
  let dropTimer = 0;
  let landed = false;
  let started = false;
  let drainAcc = 2;
  let cineWeight = 1;
  let cineTarget = 1;
  let skipRequested = false;
  let restartOffered = false;
  let hornedIn = false;
  let hornedOut = false;
  let realAliveCache = LOBBY;
  let realAliveTimer = 0;
  let victoryAngle = 0;
  let victoryRadius = 7;
  let spectateT = 0;
  const spectatePoint = new THREE.Vector3();
  const spectateDir = new THREE.Vector3(0, 0, 1);
  const deadIds = new Set<string>();
  const feed: KillEntry[] = [];
  const drops: BusDrop[] = [];
  const names = new Map<string, string>();
  const namePool = makeNamePool(rng, LOBBY + 40);
  let namePoolCursor = 0;
  let calloutCursor = 0;

  const busPosition = new THREE.Vector3().copy(busFrom);
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const cinePos = new THREE.Vector3();
  const cineLook = new THREE.Vector3();
  const holdPos = new THREE.Vector3();
  const holdQuat = new THREE.Quaternion();
  const cineQuat = new THREE.Quaternion();
  const cineMatrix = new THREE.Matrix4();
  const UP = new THREE.Vector3(0, 1, 0);
  let cineFov = 52;

  function busAt(t: number, out?: THREE.Vector3): THREE.Vector3 {
    const v = out ?? new THREE.Vector3();
    return v.copy(busFrom).addScaledVector(routeDir, t * routeLength);
  }

  function nameFor(id: string): string {
    if (id === "player") return "You";
    const existing = names.get(id);
    if (existing) return existing;
    const n = namePool[namePoolCursor % namePool.length] ?? `Rival${namePoolCursor}`;
    namePoolCursor++;
    names.set(id, n);
    return n;
  }

  // ---- the service, published before anything expensive ------------------
  // Everything below this line bakes textures and merges geometry, and the
  // systems that boot after us (bots, and the HUD through events) must be
  // able to find the match even if that bake throws.
  const service: DropZeroMatchService = {
    get phase() {
      return phase;
    },
    set phase(_p: MatchPhase) {
      // The phase is owned here. A setter that silently ignores the write is
      // friendlier than one that lets another system desync the machine, and
      // the shared interface declares the field mutable.
    },
    alive: LOBBY,
    eliminations: 0,
    placement: 0,
    busFrom,
    busTo,
    busT: 0,
    busPosition,
    busAt,
    busLength: routeLength,
    busSpeed: routeLength / BUS_DURATION,
    get canJump() {
      return (phase === "bus" || phase === "warmup") && !jumped && service.busT >= JUMP_OPENS_T;
    },
    get jumped() {
      return jumped;
    },
    get phaseTime() {
      return phaseTime;
    },
    get matchTime() {
      return liveAt < 0 ? -1 : ctx.elapsed - liveAt;
    },
    drops,
    nameFor,
    feed,
    lobbySize: LOBBY,
    skipWarmup() {
      skipRequested = true;
    },
    jump() {
      requestJump();
    },
    reportDeath(id, by) {
      reportDeath(id, by);
    },
  };
  ctx.services.match = service;

  // ---- audio helper ------------------------------------------------------
  // Every call is wrapped: audio may have failed to boot, and a synthesiser
  // that does not know a cue name should cost us the cue, not the match.
  function sfx(name: string, volume = 1, rate = 1, position?: THREE.Vector3): void {
    try {
      services.audio?.play?.(name, { volume, rate, position });
    } catch {
      /* audio is optional, always */
    }
  }

  function bed(name: string, on: boolean, volume = 0.5): void {
    try {
      services.audio?.ambience?.(name, on, volume);
    } catch {
      /* ditto */
    }
  }

  function music(name: string | null, volume = 0.6): void {
    try {
      services.audio?.music?.(name, volume);
    } catch {
      /* ditto */
    }
  }

  // ---- the bus -----------------------------------------------------------
  let bus: BusModel | null = null;
  try {
    bus = buildBus(ctx, rng);
    bus.root.position.copy(busAt(routeU, tmpA));
    bus.root.lookAt(tmpA.copy(bus.root.position).add(routeDir));
    ctx.scene.add(bus.root);
  } catch (err) {
    // A bus we cannot build costs us the opening shot, not the match.
    console.error("[Drop Zero] battle bus failed to build:", err);
    bus = null;
  }

  const smokeTex = bakeSmoke(rng);
  const smoke = makeSmokeTrail(SMOKE_PUFFS[ctx.quality], smokeTex, rng);
  ctx.scene.add(smoke.object);
  let smokeAcc = 0;

  const crowd = makeCrowd(DIVERS[ctx.quality], rng);
  ctx.scene.add(crowd.root);

  // ---- the opening fly-over ----------------------------------------------
  let flyPos: THREE.CatmullRomCurve3 | null = null;
  let flyLook: THREE.CatmullRomCurve3 | null = null;

  /**
   * Build the cinematic path off the POIs the world actually registered, so
   * the fly-over shows the player the map they are about to drop into rather
   * than three arbitrary points over the sea. Built lazily — `pois` is
   * published by a system that boots before us, but "before us" is an
   * ordering guarantee, not a success guarantee.
   */
  function buildFlyover(): void {
    if (flyPos) return;
    const terrain = services.terrain;
    const pois = services.pois ?? [];
    const ranked = [...pois].sort((a, b) => {
      const weight = (p: Poi): number => (p.tier === "landmark" ? 0 : p.tier === "major" ? 1 : 2);
      return weight(a) - weight(b);
    });
    const picks: THREE.Vector3[] = [];
    for (const p of ranked) {
      if (picks.length >= 3) break;
      // Skip anything too close to one already chosen — three shots of the
      // same valley is not an establishing sequence.
      if (picks.some((q) => q.distanceTo(p.center) < 420)) continue;
      picks.push(p.center.clone());
    }
    while (picks.length < 3) {
      const a = (picks.length / 3) * Math.PI * 2 + rng();
      picks.push(new THREE.Vector3(Math.cos(a) * 620, 0, Math.sin(a) * 620));
    }

    const ground = (x: number, z: number): number => {
      try {
        return terrain?.heightAt(x, z) ?? 0;
      } catch {
        return 0;
      }
    };

    const posPts: THREE.Vector3[] = [];
    const lookPts: THREE.Vector3[] = [];
    // Open wide and high out over the water on the bus's side of the island,
    // then descend through the three landmarks, then climb to meet the bus.
    const openAngle = routeAngle + Math.PI;
    posPts.push(
      new THREE.Vector3(Math.cos(openAngle) * 2100, 760, Math.sin(openAngle) * 2100),
    );
    lookPts.push(new THREE.Vector3(0, 60, 0));
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      const g = ground(p.x, p.z);
      const a = routeAngle + 1.1 + i * 1.5;
      const r = 300 + i * 40;
      posPts.push(new THREE.Vector3(p.x + Math.cos(a) * r, g + 190 + i * 45, p.z + Math.sin(a) * r));
      lookPts.push(new THREE.Vector3(p.x, g + 24, p.z));
    }
    // Final waypoint: out ahead of the bus, high, looking back down the route.
    const meet = busAt(0.12, new THREE.Vector3());
    posPts.push(new THREE.Vector3(meet.x + routeRight.x * 150, meet.y + 90, meet.z + routeRight.z * 150));
    lookPts.push(meet.clone());

    flyPos = new THREE.CatmullRomCurve3(posPts, false, "catmullrom", 0.35);
    flyLook = new THREE.CatmullRomCurve3(lookPts, false, "catmullrom", 0.35);
  }

  // ---- drop plans --------------------------------------------------------
  /**
   * Who gets off where. Each rival picks a POI weighted by tier, and leaves
   * at the point on the route closest to it — which is exactly the decision a
   * human makes, and it is what makes the sky over the good loot look busy.
   */
  function buildDropPlans(): void {
    if (drops.length) return;
    const pois = services.pois ?? [];
    const terrain = services.terrain;
    const weighted: Poi[] = [];
    for (const p of pois) {
      const n = p.tier === "landmark" ? 5 : p.tier === "major" ? 3 : 2;
      for (let i = 0; i < n; i++) weighted.push(p);
    }
    const planned = Math.min(LOBBY - 1, 64);
    for (let i = 0; i < planned; i++) {
      let target: THREE.Vector3;
      let place = "the wilds";
      if (weighted.length) {
        const poi = weighted[Math.floor(rng() * weighted.length)];
        place = poi.name;
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * poi.radius * 1.15;
        target = new THREE.Vector3(poi.center.x + Math.cos(a) * r, 0, poi.center.z + Math.sin(a) * r);
      } else {
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * 1100;
        target = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
      }
      try {
        target.y = terrain?.heightAt(target.x, target.z) ?? 0;
      } catch {
        target.y = 0;
      }
      // Closest approach of the route to the target, jittered — everyone
      // leaving at the mathematically optimal instant looks like a machine.
      tmpA.subVectors(target, busFrom);
      const t = clamp(tmpA.dot(routeDir) / routeLength + (rng() * 2 - 1) * 0.1, 0.06, 0.95);
      drops.push({ id: `rival-${i}`, t, target, place, released: false });
    }
    drops.sort((a, b) => a.t - b.t);
  }

  // ---- events ------------------------------------------------------------
  function emitMatch(reason: string): void {
    ctx.emit("dz:match", {
      phase,
      reason,
      alive: service.alive,
      lobby: LOBBY,
      eliminations: service.eliminations,
      placement: service.placement,
      busT: service.busT,
      canJump: service.canJump,
      jumped,
      matchTime: service.matchTime,
    });
  }

  /** Reused per-frame payload — the bus panel updates every frame. */
  const busEvent = {
    phase: "warmup" as MatchPhase,
    t: 0,
    x: 0,
    y: 0,
    z: 0,
    secondsLeft: BUS_DURATION,
    canJump: false,
    jumped: false,
    alive: LOBBY,
    warmup: 0,
    warmupTotal: WARMUP_TIME,
  };

  function announce(text: string, tone: "info" | "urgent" = "info"): void {
    ctx.emit("dz:announce", { text, tone, alive: service.alive });
  }

  function pushFeed(entry: KillEntry): void {
    feed.push(entry);
    // Six is what fits the corner of a 1600×900 frame without covering the
    // minimap; older lines are the HUD's problem to expire, not ours to keep.
    while (feed.length > 6) feed.shift();
    ctx.emit("dz:eliminate", {
      killer: entry.killer,
      victim: entry.victim,
      weapon: entry.weapon,
      byPlayer: entry.byPlayer,
      onPlayer: entry.onPlayer,
      environmental: entry.environmental,
      alive: service.alive,
    });
  }

  function checkCallouts(): void {
    while (calloutCursor < CALLOUTS.length && service.alive <= CALLOUTS[calloutCursor]) {
      const n = CALLOUTS[calloutCursor];
      calloutCursor++;
      // Only shout the threshold we actually landed on, and only while the
      // player is still in it — a callout on the death screen is noise.
      if (phase === "eliminated" || phase === "victory") continue;
      announce(n <= 5 ? `${service.alive} players remain` : `${n} players remain`, n <= 10 ? "urgent" : "info");
      sfx("callout", n <= 10 ? 0.65 : 0.45, n <= 10 ? 1.06 : 1);
    }
  }

  function setAlive(n: number): void {
    const next = Math.max(0, Math.floor(n));
    if (next === service.alive) return;
    service.alive = next;
    busEvent.alive = next;
    checkCallouts();
    emitMatch("alive");
  }

  // ---- deaths ------------------------------------------------------------
  const ENVIRONMENT_KILLERS = new Set(["storm", "world", "fall", "", "environment"]);

  function reportDeath(id: string, by: DamageSource): void {
    // Idempotent: combat, the storm and a bot's own bookkeeping may all shout
    // about the same corpse, and the alive count must only move once.
    if (deadIds.has(id)) return;
    deadIds.add(id);

    const victimIsPlayer = id === "player";
    const killerId = by?.by ?? "";
    const environmental = ENVIRONMENT_KILLERS.has(killerId) || killerId === id;
    const killer = environmental
      ? killerId === "storm" || killerId === "" ? "the storm" : killerId
      : by?.name ?? nameFor(killerId);
    const victim = victimIsPlayer ? "You" : nameFor(id);
    const weapon = by?.weapon ?? (environmental ? "storm" : "");

    if (killerId === "player" && !victimIsPlayer) {
      service.eliminations++;
      sfx("elim-confirm", 0.8, 1);
    }

    if (victimIsPlayer) {
      // Placement is the count *including* you, taken before the decrement:
      // die with eight alive and you came eighth.
      service.placement = Math.max(1, service.alive);
    }

    setAlive(service.alive - 1);
    pushFeed({
      killer,
      victim,
      weapon,
      byPlayer: killerId === "player",
      onPlayer: victimIsPlayer,
      environmental,
      at: ctx.elapsed,
    });

    if (victimIsPlayer && phase !== "eliminated" && phase !== "victory") {
      setPhase("eliminated");
    }
  }

  /**
   * Kill somebody nobody will ever meet. The drain curve decides *when*; this
   * decides who, and writes a line that is indistinguishable from a real one.
   */
  function killPhantom(): void {
    const byStorm = rng() < (services.storm?.closing ? 0.42 : 0.18);
    const victim = namePool[namePoolCursor % namePool.length] ?? "Rival";
    namePoolCursor++;
    setAlive(service.alive - 1);
    if (byStorm) {
      pushFeed({
        killer: "the storm",
        victim,
        weapon: "storm",
        byPlayer: false,
        onPlayer: false,
        environmental: true,
        at: ctx.elapsed,
      });
      return;
    }
    const killer = namePool[(namePoolCursor + 7) % namePool.length] ?? "Rival";
    pushFeed({
      killer,
      victim,
      weapon: FEED_WEAPONS[Math.floor(rng() * FEED_WEAPONS.length)],
      byPlayer: false,
      onPlayer: false,
      environmental: false,
      at: ctx.elapsed,
    });
  }

  /**
   * How many actors are *really* still breathing. The drain is never allowed
   * to push the counter below this, which is what stops "1 remaining" from
   * appearing while three bots are shooting at you.
   */
  function refreshRealAlive(): void {
    const player = services.player;
    const playerAlive = !player || player.state !== "dead" ? 1 : 0;
    let bots = 0;
    const combat = services.combat;
    if (combat) {
      try {
        // One sweep of the whole island, at 1 Hz. Cheaper than maintaining a
        // second register of everything combat already tracks.
        for (const t of combat.queryTargets(tmpA.set(0, 0, 0), 6000)) {
          if (t.alive && t.faction === "bot") bots++;
        }
      } catch {
        bots = 0;
      }
    }
    realAliveCache = playerAlive + bots;
  }

  function updateDrain(dt: number): void {
    realAliveTimer -= dt;
    if (realAliveTimer <= 0) {
      realAliveTimer = 1;
      refreshRealAlive();
    }
    const target = Math.ceil(sampleCurve(DRAIN_CURVE, service.matchTime));
    const floor = Math.max(1, realAliveCache);
    if (service.alive <= Math.max(target, floor)) return;
    drainAcc -= dt;
    if (drainAcc > 0) return;
    // Stagger the fabricated deaths. A tidy metronome of eliminations is the
    // one thing that would give the whole trick away.
    drainAcc = 0.4 + rng() * 2.4;
    killPhantom();
  }

  // ---- jumping -----------------------------------------------------------
  function requestJump(): void {
    if (jumped) return;
    if (phase !== "bus") return;
    jumped = true;
    ctx.emit("dz:jump", { t: service.busT, x: busPosition.x, y: busPosition.y, z: busPosition.z });
    sfx("bus-release", 0.8);
    setPhase("dropping");
  }

  // ---- phases ------------------------------------------------------------
  interface PhaseHooks {
    enter?(): void;
    fixed?(dt: number): void;
    exit?(): void;
  }

  const PHASES: Record<MatchPhase, PhaseHooks> = {
    warmup: {
      enter() {
        cineTarget = 1;
        cineWeight = 1;
        buildFlyover();
        buildDropPlans();
        music("drop-in", 0.55);
        bed("bus-engine", true, 0.28);
        ctx.emit("dz:warmup", {
          title: "DROP ZERO",
          subtitle: "100 drop. 1 walks out.",
          duration: WARMUP_TIME,
          skippable: true,
        });
      },
      fixed(dt) {
        warmupT += dt;
        // Fly the last stretch of the approach during the cinematic, at
        // exactly cruise speed, so the hand-off into the bus phase has no
        // velocity discontinuity for the eye to catch.
        routeU = Math.max(BUS_PREROLL, (warmupT - WARMUP_TIME) / BUS_DURATION);
        parkPlayerOnBus();
        if (skipRequested && warmupT > 1.2) {
          // Skipping does not teleport the bus — it fast-forwards the whole
          // approach, so the bus is where it would have been.
          warmupT = WARMUP_TIME;
        }
        if (warmupT >= WARMUP_TIME) setPhase("bus");
      },
      exit() {
        ctx.emit("dz:warmup", { done: true });
      },
    },

    bus: {
      enter() {
        service.busT = 0;
        routeU = 0;
        cineTarget = 0;
        bed("bus-engine", true, 0.45);
        announce("Drop when ready", "info");
      },
      fixed(dt) {
        routeU += dt / BUS_DURATION;
        service.busT = clamp01(routeU);
        parkPlayerOnBus();
        releaseDrops();
        if (!hornedIn && service.busT > 0.03) {
          hornedIn = true;
          sfx("bus-horn", 0.85, 1);
        }
        if (!hornedOut && service.busT > 0.88) {
          hornedOut = true;
          // Last call. Two short notes, higher, so it reads as "get off".
          sfx("bus-horn", 0.7, 1.22);
          announce("Last call", "urgent");
        }
        if (service.busT >= FORCE_JUMP_T && !jumped) {
          // Fortnite throws you out at the end of the line and so do we —
          // being carried past the island is not a strategy.
          announce("End of the line", "urgent");
          jumped = true;
          ctx.emit("dz:jump", {
            t: service.busT,
            forced: true,
            x: busPosition.x,
            y: busPosition.y,
            z: busPosition.z,
          });
          setPhase("dropping");
        }
      },
    },

    dropping: {
      enter() {
        dropTimer = 0;
        cineTarget = 0;
        bed("bus-engine", false);
        music("drop", 0.5);
      },
      fixed(dt) {
        dropTimer += dt;
        // The bus keeps going and keeps dropping people after you leave.
        routeU += dt / BUS_DURATION;
        service.busT = clamp01(routeU);
        releaseDrops();
        if (landed || dropTimer > DROP_TIMEOUT) setPhase("live");
      },
    },

    live: {
      enter() {
        liveAt = ctx.elapsed;
        cineTarget = 0;
        music("combat", 0.4);
        announce("Storm's coming", "info");
        emitMatch("live");
      },
      fixed(dt) {
        // The bus finishes its run and leaves; after that it is out of the
        // simulation entirely.
        if (routeU < 1.35) {
          routeU += dt / BUS_DURATION;
          service.busT = clamp01(routeU);
          releaseDrops();
        }
        updateDrain(dt);
        if (service.alive <= 1) {
          const player = services.player;
          if (!player || player.state !== "dead") setPhase("victory");
        }
      },
    },

    victory: {
      enter() {
        service.placement = 1;
        cineTarget = 1;
        victoryAngle = (services.player?.yaw ?? 0) + Math.PI;
        victoryRadius = 6;
        music("victory", 0.75);
        sfx("victory", 0.9);
        announce("VICTORY ROYALE", "urgent");
        ctx.emit("dz:victory", {
          placement: 1,
          eliminations: service.eliminations,
          lobby: LOBBY,
          matchTime: service.matchTime,
          feed: feed.slice(),
        });
      },
      fixed(dt) {
        // Input is already frozen: `player.controllable` is false outside the
        // playable phases, so the player system stops accepting movement,
        // aiming and fire the instant `phase` flips.
        victoryRadius = damp(victoryRadius, 13.5, 0.35, dt);
        victoryAngle += (dt * Math.PI * 2) / VICTORY_ORBIT_PERIOD;
        offerRestart(4);
      },
    },

    eliminated: {
      enter() {
        cineTarget = 1;
        spectateT = 0;
        const player = services.player;
        if (player) {
          spectatePoint.copy(player.position);
          spectatePoint.y += 1.2;
          // Pull back along the direction they were facing, so the killer's
          // side of the fight stays in frame.
          spectateDir.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
          if (spectateDir.lengthSq() < 1e-6) spectateDir.set(0, 0, 1);
        }
        music("defeat", 0.6);
        sfx("eliminated", 0.85);
        ctx.emit("dz:eliminated", {
          placement: service.placement,
          eliminations: service.eliminations,
          lobby: LOBBY,
          matchTime: service.matchTime,
          killer: feed.length ? feed[feed.length - 1].killer : "the storm",
          weapon: feed.length ? feed[feed.length - 1].weapon : "storm",
          feed: feed.slice(),
        });
      },
      fixed(dt) {
        spectateT += dt;
        offerRestart(RESTART_DELAY);
      },
    },
  };

  function setPhase(next: MatchPhase): void {
    if (next === phase) return;
    const prev = phase;
    try {
      PHASES[phase]?.exit?.();
    } catch (err) {
      console.error("[Drop Zero] match exit hook failed", prev, err);
    }
    phase = next;
    phaseTime = 0;
    busEvent.phase = next;
    try {
      PHASES[next]?.enter?.();
    } catch (err) {
      console.error("[Drop Zero] match enter hook failed", next, err);
    }
    emitMatch(`phase:${prev}->${next}`);
  }

  function offerRestart(delay: number): void {
    if (restartOffered || phaseTime < delay) return;
    restartOffered = true;
    // There is no in-place rematch: the island, the loot table and the storm
    // are all built once at boot, and reloading the route rebuilds them in
    // about a second. Said plainly in the payload so the HUD's button knows
    // what it is doing.
    ctx.emit("dz:restart-available", {
      method: "reload",
      route: typeof window !== "undefined" ? window.location.pathname : "/drop-zero",
      placement: service.placement,
      eliminations: service.eliminations,
    });
  }

  /**
   * Hold the player at the strap during warmup. `player.ts` only puts itself
   * on the bus once `phase === "bus"`, so without this they spend the whole
   * cinematic wandering around the spawn point, and the transition into the
   * bus is a teleport the player can see.
   */
  function parkPlayerOnBus(): void {
    const player = services.player;
    if (!player?.teleport) return;
    if (phase !== "warmup") return;
    busAt(routeU, tmpA);
    tmpA.addScaledVector(routeRight, 1.5);
    tmpA.y -= 2.35;
    player.teleport(tmpA);
  }

  function releaseDrops(): void {
    if (!drops.length) return;
    const terrain = services.terrain;
    for (const d of drops) {
      if (d.released || d.t > service.busT) continue;
      d.released = true;
      busAt(d.t, tmpA);
      ctx.emit("dz:bot-drop", {
        id: d.id,
        t: d.t,
        place: d.place,
        fromX: tmpA.x,
        fromY: tmpA.y,
        fromZ: tmpA.z,
        toX: d.target.x,
        toY: d.target.y,
        toZ: d.target.z,
      });
      let groundY = d.target.y;
      try {
        groundY = terrain?.heightAt(d.target.x, d.target.z) ?? d.target.y;
      } catch {
        /* keep the planned height */
      }
      crowd.release(tmpA, d.target, groundY);
    }
  }

  // ---- skip-the-cinematic input -----------------------------------------
  // Own listeners rather than reading `ctx.input`: the pointer is locked, the
  // page's own click already went to `requestPointerLock`, and a click during
  // the fly-over must not also be a trigger pull.
  function onSkip(ev: Event): void {
    if (phase !== "warmup") return;
    if (ev.type === "keydown") {
      const code = (ev as KeyboardEvent).code;
      if (code !== "Space" && code !== "Enter" && code !== "Escape") return;
    }
    skipRequested = true;
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pointerdown", onSkip);
    window.addEventListener("keydown", onSkip);
  }

  const offLanded = ctx.on("dz:landed", () => {
    landed = true;
  });

  // ---- cinematic camera --------------------------------------------------

  /** Where the camera wants to be this frame, when the match owns it. */
  function solveCine(dt: number): void {
    if (phase === "warmup" || (phase === "bus" && cineWeight > 0.001)) {
      buildFlyover();
      const dur = WARMUP_TIME;
      const raw = clamp01(warmupT / dur);
      // A little ease at both ends, but mostly constant speed: a camera that
      // eases the whole way reads as a slideshow.
      const u = lerp(raw, easeInOut(raw), 0.45);
      if (flyPos && flyLook) {
        flyPos.getPoint(u, cinePos);
        flyLook.getPoint(u, cineLook);
      } else {
        cinePos.set(0, 700, 1400);
        cineLook.set(0, 0, 0);
      }
      // Close on the bus for the last few seconds so the cinematic *ends* on
      // the thing the player is about to be hanging off.
      const hero = smoothstep(dur - 6.0, dur - 1.4, warmupT);
      if (hero > 0) {
        tmpA.copy(busPosition)
          .addScaledVector(routeRight, 34)
          .addScaledVector(routeDir, -22);
        tmpA.y += 13;
        cinePos.lerp(tmpA, hero);
        tmpB.copy(busPosition);
        tmpB.y += 5;
        cineLook.lerp(tmpB, hero);
      }
      cineFov = damp(cineFov, 52 - hero * 6, 2, dt);
      return;
    }

    if (phase === "victory") {
      const player = services.player;
      const c = tmpB.copy(player?.position ?? new THREE.Vector3());
      c.y += 1.7;
      cinePos.set(
        c.x + Math.cos(victoryAngle) * victoryRadius,
        c.y + 3.4 + Math.sin(victoryAngle * 0.5) * 0.8,
        c.z + Math.sin(victoryAngle) * victoryRadius,
      );
      cineLook.copy(c);
      cineFov = damp(cineFov, 48, 1.2, dt);
      return;
    }

    if (phase === "eliminated") {
      const t = clamp01(spectateT / SPECTATE_TIME);
      const e = easeInOut(t);
      // Straight up and back, slowly, then a lazy drift around the body. The
      // slowness is the point: the beat after a death is the only quiet one
      // in the match.
      const swing = t * 0.35;
      const dx = spectateDir.x * Math.cos(swing) - spectateDir.z * Math.sin(swing);
      const dz = spectateDir.x * Math.sin(swing) + spectateDir.z * Math.cos(swing);
      cinePos.set(
        spectatePoint.x + dx * SPECTATE_DIST * e,
        spectatePoint.y + SPECTATE_RISE * e + 1.5,
        spectatePoint.z + dz * SPECTATE_DIST * e,
      );
      cineLook.copy(spectatePoint);
      cineFov = damp(cineFov, 58, 1.4, dt);
      return;
    }

    cineFov = damp(cineFov, 52, 2, dt);
  }

  // ---- frame -------------------------------------------------------------

  function fixed(dt: number): void {
    phaseTime += dt;

    // Hold the whole match at the title until the player has actually entered
    // the world. The page keeps its veil up until the pointer locks, and a
    // bus that left without them is the worst possible first impression.
    if (!started) {
      if (!ctx.input.locked) {
        parkPlayerOnBus();
        return;
      }
      started = true;
      try {
        PHASES.warmup.enter?.();
      } catch (err) {
        console.error("[Drop Zero] warmup enter failed", err);
      }
      emitMatch("start");
    }

    try {
      PHASES[phase]?.fixed?.(dt);
    } catch (err) {
      console.error("[Drop Zero] match phase step failed", phase, err);
    }

    // Bus placement is simulation, not cosmetics: `player.ts` reads `busT` in
    // its own fixed step and hangs the rider off it.
    busAt(routeU, busPosition);
    if (bus) {
      bus.root.position.copy(busPosition);
      bus.root.lookAt(tmpA.copy(busPosition).add(routeDir));
      // Past the far end of the route the bus is three kilometres out over
      // the water and nothing but draw calls. Retire it, and let its trail
      // go with it.
      const visible = routeU <= 1.3;
      if (bus.root.visible !== visible) {
        bus.root.visible = visible;
        if (!visible) smoke.clear();
      }
    }
  }

  function update(dt: number): void {
    const t = ctx.elapsed;

    // ---- bus cosmetics ---------------------------------------------------
    if (bus && bus.root.visible) {
      // Two bodies, two phases. A balloon and a bus swaying on the same sine
      // is one rigid object; offsetting them by a couple of seconds is what
      // sells the tether between them.
      // Deliberately small in Y. `player.ts` hangs the rider off the route
      // point with its own gentle sway, not off this transform, so anything
      // bigger than about a quarter of a metre visibly stretches the strap.
      bus.sway.position.y = Math.sin(t * 0.55) * 0.22 + Math.sin(t * 0.23) * 0.1;
      bus.sway.rotation.z = Math.sin(t * 0.42) * 0.048 + Math.sin(t * 1.1) * 0.008;
      bus.sway.rotation.x = Math.sin(t * 0.31 + 1.1) * 0.022;
      bus.sway.rotation.y = Math.sin(t * 0.19 + 0.6) * 0.03;
      bus.balloon.rotation.z = Math.sin(t * 0.37 + 2.2) * 0.036;
      bus.balloon.rotation.x = Math.sin(t * 0.29 + 0.4) * 0.026;
      const breathe = 1 + Math.sin(t * 0.8) * 0.007;
      bus.balloon.scale.set(breathe, 2 - breathe, breathe);

      for (let i = 0; i < bus.rotors.length; i++) {
        // Opposite directions, slightly different rates: counter-rotating
        // fans, and no visible strobe beat between the two.
        bus.rotors[i].rotation.z += dt * (i % 2 === 0 ? 41 : -37);
      }

      // Burner: a hard pulse every few seconds with a fast attack, because
      // that is what a propane burner does and a smooth sine does not.
      const cycle = (t % 3.6) / 3.6;
      const burn = cycle < 0.28 ? Math.pow(1 - cycle / 0.28, 0.6) : 0;
      const flicker = 0.82 + Math.sin(t * 31) * 0.09 + Math.sin(t * 17.3) * 0.09;
      if (bus.flame && bus.flameMat) {
        const s = 0.25 + burn * 1.15 * flicker;
        bus.flame.scale.set(0.6 + burn * 0.7, s, 0.6 + burn * 0.7);
        bus.flameMat.opacity = (0.12 + burn * 0.75) * flicker;
      }
      if (bus.burnerGlow) {
        bus.burnerGlow.scale.setScalar(4 + burn * 9);
        (bus.burnerGlow.material as THREE.SpriteMaterial).opacity = 0.18 + burn * 0.72;
      }
      const thrust = phase === "warmup" || phase === "bus" || phase === "dropping" ? 1 : 0.55;
      for (let i = 0; i < bus.thrusterGlows.length; i++) {
        const pulse = 0.86 + Math.sin(t * (9 + i * 2.3)) * 0.14;
        bus.thrusterGlows[i].scale.setScalar((2.6 + pulse * 1.2) * thrust);
      }

      // ---- smoke -----------------------------------------------------------
      smokeAcc -= dt;
      if (smokeAcc <= 0) {
        smokeAcc = 0.05;
        // The subtree's world matrix is one frame stale at this point in the
        // loop; at 100 m/s that is a metre and a half, and refreshing it is
        // a dozen matrix multiplies.
        bus.root.updateMatrixWorld(true);
        for (const e of bus.exhausts) {
          tmpA.copy(e);
          bus.sway.localToWorld(tmpA);
          smoke.emit(
            tmpA.x + (rng() * 2 - 1) * 0.6,
            tmpA.y + (rng() * 2 - 1) * 0.6,
            tmpA.z + (rng() * 2 - 1) * 0.6,
            routeDir.x * -7 + (rng() * 2 - 1) * 2.5,
            1.5 + rng() * 2,
            routeDir.z * -7 + (rng() * 2 - 1) * 2.5,
            2.6,
          );
        }
      }
    }
    smoke.update(dt);
    crowd.update(dt);

    // ---- camera ownership ------------------------------------------------
    // Ramp rates differ by direction on purpose: taking the camera *away*
    // from the player has to be gentle, giving it back has to be quick.
    const rate = cineTarget > cineWeight ? (phase === "victory" ? 0.9 : 1.6) : 1 / HANDOFF_TIME;
    cineWeight = clamp01(cineWeight + Math.sign(cineTarget - cineWeight) * rate * dt);
    solveCine(dt);

    // ---- HUD -------------------------------------------------------------
    busEvent.phase = phase;
    busEvent.t = service.busT;
    busEvent.x = busPosition.x;
    busEvent.y = busPosition.y;
    busEvent.z = busPosition.z;
    busEvent.secondsLeft = Math.max(0, (1 - service.busT) * BUS_DURATION);
    busEvent.canJump = service.canJump;
    busEvent.jumped = jumped;
    busEvent.alive = service.alive;
    busEvent.warmup = phase === "warmup" ? warmupT : WARMUP_TIME;
    if (phase === "warmup" || phase === "bus" || phase === "dropping") ctx.emit("dz:bus", busEvent);
  }

  function lateUpdate(): void {
    if (cineWeight <= 0.0005) return;
    const camera = ctx.camera;
    // The player system wrote the camera in `update`; blending against what
    // it wrote is what makes the hand-off in either direction a move rather
    // than a cut.
    holdPos.copy(camera.position);
    holdQuat.copy(camera.quaternion);
    const holdFov = camera.fov;

    cineMatrix.lookAt(cinePos, cineLook, UP);
    cineQuat.setFromRotationMatrix(cineMatrix);

    camera.position.lerpVectors(holdPos, cinePos, cineWeight);
    camera.quaternion.slerpQuaternions(holdQuat, cineQuat, cineWeight);
    const fov = lerp(holdFov, cineFov, cineWeight);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    // Keep the shadow cascade under whatever the camera is actually looking
    // at, or the cinematic flies over an unshadowed island.
    if (cineWeight > 0.5) services.sky?.focus(cineLook);
  }

  const sys: FixedSystem = {
    name: "match",
    fixed(dt) {
      fixed(dt);
    },
    update(dt) {
      update(dt);
    },
    lateUpdate() {
      lateUpdate();
    },
    dispose() {
      if (typeof window !== "undefined") {
        window.removeEventListener("pointerdown", onSkip);
        window.removeEventListener("keydown", onSkip);
      }
      offLanded();
      bed("bus-engine", false);
      music(null);
      if (ctx.services.match === service) ctx.services.match = undefined;

      if (bus) {
        bus.root.removeFromParent();
        for (const g of bus.geometries) g.dispose();
        for (const m of bus.materials) m.dispose();
        // The bus owns these textures — they were baked here, so they are
        // disposed here. A leaked canvas texture per world visit is how a
        // browser ends up refusing the next WebGL context.
        for (const t of bus.textures) t.dispose();
        bus = null;
      }
      smoke.object.removeFromParent();
      smoke.dispose();
      smokeTex?.dispose();
      crowd.root.removeFromParent();
      crowd.dispose();
    },
  };

  return sys;
};

export default createMatch;
