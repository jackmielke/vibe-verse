/**
 * Vibe Kart — items: the boxes, the roulette, the projectiles and the hazards.
 *
 * This is the module that turns a driving model into a *kart racer*. Everything
 * in here is built on four rules that are worth stating once, because they
 * explain nearly every decision below:
 *
 * 1. **A hazard is a state, not an object graph.** Projectiles live in flat
 *    pooled records with a pre-built visual node attached. Nothing is allocated
 *    after boot — not a Vector3, not a geometry, not a material. A blue shell
 *    detonating in the middle of a twelve-kart pile-up must cost the same as an
 *    empty road.
 *
 * 2. **The road is the authority.** Red and blue shells do not fly toward a
 *    world-space point; they walk the centreline, carrying their own arc
 *    position and a lateral offset, and ask the track for the surface height at
 *    every step. That is why they follow the hairpin instead of taking the
 *    scenic route through a grandstand, and it is how the genre has always done
 *    it. Green shells and fireballs are the opposite by design: they are dumb,
 *    they travel straight, and they reflect off walls, which is what makes them
 *    feel like a *skill* item next to the red shell's guided missile.
 *
 * 3. **Every impact goes through one door.** `damage()` is the only place a
 *    racer gets hurt, so the physics hit, the coin loss, the VFX burst, the
 *    audio cue, the camera shake and the `kart:hit` event can never drift out
 *    of sync with each other.
 *
 * 4. **Presentation is not decoration.** An item box is a rounded, prismatic,
 *    double-sided translucent cube with a bevelled "?" that reads at fifty
 *    metres, it bobs on a sine and spins on a tilted axis, it pops with an
 *    over-scale before it vanishes, and it drops a soft contact shadow onto the
 *    tarmac. All of that is one instanced draw call per layer. The cheap version
 *    of any of these would read as programmer art, and the expensive version
 *    costs almost nothing once it is instanced.
 *
 * Published as `ctx.services.items` synchronously, before any art is baked, so
 * that a system booted after this one never sees a hole where the service
 * should be.
 *
 * Services consumed, all optional, all degraded rather than required:
 *   track    the spline, the surface query and the wall query
 *   physics  racer states, `applyHit` / `applyBoost` / `applyImpulse`
 *   vfx      bursts at impact points
 *   audio    one-shot cues
 *   camera   shake
 *   race     the phase, so nothing fires during the countdown
 *   env      the prefiltered environment map, for the shells' specular
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  makeRng,
  TUNING,
  type AudioService,
  type CameraService,
  type ItemKind,
  type ItemService,
  type KartCtx,
  type PhysicsService,
  type RacerState,
  type System,
  type TrackService,
  type VfxBurst,
  type VfxService,
} from "../types";

// ---------------------------------------------------------------------------
// What we read from other systems
//
// These are structural views of services this module does not own. They are
// declared locally, deliberately: `types.ts` is shared law and this module does
// not get to edit it, and every field below is optional-tolerant so a partially
// booted world still races.
// ---------------------------------------------------------------------------

/** Physics publishes a few extras beyond `RacerState`; we use them if present. */
interface RacerView extends RacerState {
  /** Live normalised arc position on the centreline, not lap-aware. */
  t?: number;
  /** Signed metres from the centreline. */
  lateral?: number;
  /** True while the kart is being lifted back onto the road. */
  respawning?: boolean;
}

interface PhysicsView extends PhysicsService {
  racers: RacerView[];
  player: RacerView;
  get?(id: number): RacerView | undefined;
}

interface RaceView {
  phase?: string;
  totalLaps?: number;
}

/** The track's optional racing-line hint — bullets and blue shells want it. */
interface TrackView extends TrackService {
  racingLine?(t: number): number;
}

interface EnvView {
  envMap?: THREE.Texture | null;
}

/**
 * The published handle. `ItemService` is the contract; everything past it is
 * additive and any consumer is free to ignore it.
 */
export interface KartItemService extends ItemService {
  /** Live projectiles and dropped hazards, for the AI to steer around. */
  hazards(): HazardRef[];
  /** Inventory as the HUD wants it, including the roulette's current face. */
  display(racerId: number): ItemDisplay;
  /** Hand a racer an item directly — the tutorial, the debug menu, a cheat. */
  give(racerId: number, kind: ItemKind, count?: number): void;
  /** Seconds of bullet ride left, or 0. The camera pulls back while it burns. */
  bulletOf(racerId: number): number;
  /** Ink blindness 0..1 on a racer; the HUD reads the player's. */
  inkOf(racerId: number): number;
  /** Star shimmer 0..1 — non-zero while invincible, eased at both ends. */
  starOf(racerId: number): number;
  /** Fraction of extra top speed a racer's coins are currently buying. */
  coinBonusOf(racerId: number): number;
  /** Boxes still on the road (the rest are respawning). */
  liveBoxes(): number;
  /** Wipe every projectile, inventory and effect. Bound to `race:restart`. */
  reset(): void;
}

export interface ItemDisplay {
  kind: ItemKind | null;
  count: number;
  rolling: boolean;
  /** The face the roulette is showing this instant, for the HUD's spin. */
  face: ItemKind | null;
}

export interface HazardRef {
  id: number;
  kind: ItemKind;
  position: THREE.Vector3;
  ownerId: number;
}

// ---------------------------------------------------------------------------
// Tuning
//
// One table. Every number that decides how an item *feels* is here rather than
// buried at its use site, because balancing a kart racer is done by sweeping
// these together, not by hunting through eight hundred lines for the shell
// speed.
// ---------------------------------------------------------------------------

const TUNE = {
  // --- item boxes ---------------------------------------------------------
  /** Pickup radius, metres. Generous: missing a box you drove through is worse
   *  than collecting one you nearly missed. */
  boxRadius: 2.05,
  boxRespawn: 4.0,
  /** Bob amplitude and period of the float. */
  boxBob: 0.16,
  boxBobRate: 1.7,
  boxSpin: 0.85,
  /** Seconds the pop-and-vanish animation runs for. */
  boxPop: 0.26,

  // --- coins --------------------------------------------------------------
  coinRadius: 1.75,
  coinRespawn: 6.5,
  coinMax: 10,
  /** Extra top speed per coin. Ten coins buys 4 %, which is a corner a lap. */
  coinSpeed: 0.004,
  coinSpin: 3.1,
  /** Coins knocked loose by a hit, and how long they stay collectable. */
  coinsLostPerHit: 3,
  looseCoinLife: 9,
  looseCoinArm: 0.55,

  // --- roulette -----------------------------------------------------------
  rouletteTime: 1.2,
  /** How fast the displayed face cycles, seconds per face. */
  rouletteTick: 0.07,
  /** The last third slows down — a roulette that stops dead has no drama. */
  rouletteEase: 0.34,

  // --- projectiles --------------------------------------------------------
  shellSpeed: 33,
  shellBounces: 4,
  shellLife: 11,
  shellRadius: 0.44,
  redSpeed: 31,
  redLife: 13,
  /** Arc metres of lock range, fore and aft. Past it the shell goes stupid. */
  redLock: 165,
  redLateralRate: 2.6,
  blueSpeed: 58,
  blueCruise: 13,
  blueLife: 22,
  bananaLife: 34,
  bananaThrow: 15,
  bananaDrop: 3.5,
  bobombFuse: 3.4,
  bobombArm: 0.45,
  bobombProx: 6.2,
  bobombThrow: 19,
  blastRadius: 10,
  blastImpulse: 17,
  fireballSpeed: 27,
  fireballLife: 4.4,
  fireballBounces: 5,
  /** Grace period during which a projectile cannot hit the racer who fired it. */
  ownerGrace: 0.42,
  /** Hit radius against a kart. The karts are ~1.9 m wide. */
  hitRadius: 1.55,

  // --- status effects -----------------------------------------------------
  mushroomBoost: 1.55,
  bulletTime: 6.4,
  /** Bullet speed as a multiple of tarmac top speed. */
  bulletSpeed: 1.62,
  booTime: 4.6,
  /** How long the boo takes to reach its victim and come home. */
  booFlight: 0.85,
  inkTime: 5.5,
  shrinkTime: 7,
  shrinkScale: 0.52,
  /** Speed penalty while shrunk, applied after the shock stun wears off. */
  shrinkSpeed: 0.88,
  lightningStun: 2.6,
  /** How long an inked AI weaves for between nudges. */
  inkWobble: 0.55,
  /** Star aura fade, seconds. */
  auraFade: 0.35,

  // --- carried items ------------------------------------------------------
  /** Seconds before a held item is shown trailing behind the kart. */
  carryDelay: 0.28,
  carryTrail: 1.95,
  carryOrbit: 1.62,
  carryOrbitRate: 2.1,
  /** Radius at which a trailing item eats an incoming shell. */
  shieldRadius: 1.25,
} as const;

/** Kinds that sit behind the kart while held, and shield it while they do. */
const TRAILABLE: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "banana",
  "greenShell",
  "redShell",
  "bobomb",
]);

/** Kinds whose held visual orbits rather than trails, whatever the count. */
const ORBITAL: ReadonlySet<ItemKind> = new Set<ItemKind>(["tripleMushroom", "fireflower"]);

/** How many uses a rolled item is worth. */
function usesOf(kind: ItemKind): number {
  switch (kind) {
    case "tripleMushroom":
      return 3;
    case "fireflower":
      return 6;
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Distribution
//
// Eight columns, one per eighth of the field, interpolated so the table works
// for any grid size. The shape is the whole personality of the item game: the
// leader gets furniture to defend with, the back gets a way back into the race,
// and the middle gets the shells that make the middle a knife fight.
//
// The tail-end weapons (blue shell, lightning, bullet) are additionally gated:
// only one of each may be live at a time, and there is a cooldown after each,
// because two blue shells in ten seconds is not tension, it is noise.
// ---------------------------------------------------------------------------

interface DistRow {
  kind: ItemKind;
  weights: readonly number[];
}

const DISTRIBUTION: readonly DistRow[] = [
  { kind: "coin", /*        */ weights: [26, 20, 14, 9, 6, 3, 2, 0] },
  { kind: "banana", /*      */ weights: [42, 35, 26, 18, 12, 8, 4, 2] },
  { kind: "greenShell", /*  */ weights: [24, 30, 27, 21, 15, 10, 6, 3] },
  { kind: "redShell", /*    */ weights: [0, 7, 18, 25, 25, 19, 12, 7] },
  { kind: "mushroom", /*    */ weights: [0, 4, 10, 18, 24, 26, 21, 13] },
  { kind: "tripleMushroom", weights: [0, 0, 2, 6, 12, 18, 23, 21] },
  { kind: "bobomb", /*      */ weights: [0, 3, 8, 12, 12, 10, 7, 4] },
  { kind: "fireflower", /*  */ weights: [2, 6, 11, 13, 12, 10, 7, 4] },
  { kind: "blooper", /*     */ weights: [0, 2, 6, 9, 10, 9, 6, 3] },
  { kind: "boo", /*         */ weights: [0, 0, 2, 5, 8, 10, 10, 8] },
  { kind: "star", /*        */ weights: [0, 0, 0, 3, 8, 15, 21, 23] },
  { kind: "blueShell", /*   */ weights: [0, 0, 0, 2, 5, 8, 11, 11] },
  { kind: "lightning", /*   */ weights: [0, 0, 0, 0, 2, 5, 9, 15] },
  { kind: "bullet", /*      */ weights: [0, 0, 0, 0, 0, 4, 13, 24] },
];

/** Seconds before the field is allowed another of these, once one is used. */
const RARE_COOLDOWN: Partial<Record<ItemKind, number>> = {
  blueShell: 22,
  lightning: 26,
  bullet: 18,
  star: 12,
};

/** The order the roulette cycles its faces in — deliberately not the table's. */
const ROULETTE_FACES: readonly ItemKind[] = [
  "banana",
  "mushroom",
  "greenShell",
  "star",
  "redShell",
  "bobomb",
  "tripleMushroom",
  "coin",
  "fireflower",
  "blueShell",
  "boo",
  "lightning",
];

// ---------------------------------------------------------------------------
// Small maths — kept local so this module imports nothing but three
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential approach. */
function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

function wrap01(x: number): number {
  const v = x - Math.floor(x);
  return v < 0 ? v + 1 : v;
}

/** Shortest signed difference between two normalised arc positions. */
function arcDelta(from: number, to: number): number {
  let d = wrap01(to) - wrap01(from);
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  return d;
}

function easeOutBack(x: number): number {
  const c = 1.9;
  const u = x - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

function easeOutCubic(x: number): number {
  const u = 1 - x;
  return 1 - u * u * u;
}

function easeInQuad(x: number): number {
  return x * x;
}

/** Deterministic hash noise — no Math.random anywhere in this module. */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ===========================================================================
// The bakery — every texel in this module is drawn on a canvas at boot
// ===========================================================================

interface Canvas2D {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  s: number;
}

function makeCanvas(size: number): Canvas2D {
  if (typeof document === "undefined") throw new Error("[kart/items] no DOM canvas available");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.max(8, Math.round(size));
  const g = canvas.getContext("2d", { alpha: true });
  if (!g) throw new Error("[kart/items] 2D context unavailable");
  return { canvas, g, s: canvas.width };
}

function rgba(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}

function toTexture(c: Canvas2D, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c.canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The "?" drawn as a stroked path rather than as text.
 *
 * `fillText` would be one line, and it would also be a different glyph on every
 * machine — the headless screenshot runner has a different font stack from a
 * laptop, and "the item box looks wrong in CI" is not a bug anybody enjoys
 * chasing. A path is the same everywhere, and it lets the stroke be traced
 * three times (outline, body, highlight) for a real bevel.
 */
function questionPath(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  const r = s * 0.2;
  const topY = cy - s * 0.15;
  g.beginPath();
  // The hook: three quarters of a circle, opening toward the bottom right.
  g.arc(cx, topY, r, Math.PI * 1.06, Math.PI * 0.34, false);
  // ...falling into the stem, which stops short of the dot.
  g.quadraticCurveTo(cx + r * 0.55, cy + s * 0.06, cx, cy + s * 0.1);
}

function questionDot(g: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.beginPath();
  g.arc(cx, cy + s * 0.265, s * 0.075, 0, Math.PI * 2);
}

/**
 * One face of an item box.
 *
 * Four layers, in the order a painter would lay them down: a prismatic wash
 * that gives the cube its dichroic shimmer, a bevelled inner border so the edges
 * catch light, the "?" itself, and a specular streak across the top left. The
 * emissive companion carries only the glyph and the border, which is what makes
 * the box glow through the bloom without the whole cube turning into a lamp.
 */
function bakeBoxFace(size: number): {
  albedo: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
  alpha: THREE.CanvasTexture;
} {
  const c = makeCanvas(size);
  const { g, s } = c;

  // Base: a pale glass blue, brightest at the centre.
  const base = g.createRadialGradient(s * 0.5, s * 0.42, s * 0.05, s * 0.5, s * 0.5, s * 0.72);
  base.addColorStop(0, "#f4fdff");
  base.addColorStop(0.55, "#bfeaf8");
  base.addColorStop(1, "#79c7ea");
  g.fillStyle = base;
  g.fillRect(0, 0, s, s);

  // Prismatic wash: four wide, low-alpha corner sweeps in spectral order. This
  // is what stops the box reading as "a blue cube" — the hue shifts as it turns.
  const sweeps: Array<[number, number, number]> = [
    [0.1, 0.12, 0xff5fa8],
    [0.9, 0.14, 0xffd94a],
    [0.12, 0.9, 0x5fffc4],
    [0.88, 0.9, 0x9a7bff],
  ];
  for (const [x, y, col] of sweeps) {
    const gr = g.createRadialGradient(s * x, s * y, 0, s * x, s * y, s * 0.62);
    gr.addColorStop(0, rgba(col, 0.62));
    gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  }

  // Bevelled border: a bright inset frame with a darker shadow inside it.
  const inset = s * 0.055;
  g.lineWidth = s * 0.055;
  g.strokeStyle = "rgba(255,255,255,0.92)";
  g.strokeRect(inset, inset, s - inset * 2, s - inset * 2);
  g.lineWidth = s * 0.018;
  g.strokeStyle = "rgba(38,96,132,0.45)";
  g.strokeRect(inset * 2.1, inset * 2.1, s - inset * 4.2, s - inset * 4.2);

  // The glyph, traced three times: dark outline, warm body, top highlight.
  g.lineCap = "round";
  g.lineJoin = "round";
  const cx = s * 0.5;
  const cy = s * 0.47;
  g.strokeStyle = "rgba(16,44,70,0.96)";
  g.lineWidth = s * 0.185;
  questionPath(g, cx, cy, s);
  g.stroke();
  g.fillStyle = "rgba(16,44,70,0.96)";
  questionDot(g, cx, cy, s);
  g.fill();

  const body = g.createLinearGradient(0, s * 0.2, 0, s * 0.8);
  body.addColorStop(0, "#fff0a0");
  body.addColorStop(0.45, "#ffbe1a");
  body.addColorStop(1, "#f7801a");
  g.strokeStyle = body;
  g.lineWidth = s * 0.125;
  questionPath(g, cx, cy, s);
  g.stroke();
  g.fillStyle = body;
  questionDot(g, cx, cy, s);
  g.fill();

  g.strokeStyle = "rgba(255,255,255,0.75)";
  g.lineWidth = s * 0.04;
  questionPath(g, cx - s * 0.012, cy - s * 0.02, s);
  g.stroke();

  // Specular streak — a diagonal band of light across the upper left.
  g.save();
  g.globalCompositeOperation = "lighter";
  g.translate(s * 0.5, s * 0.5);
  g.rotate(-0.6);
  const streak = g.createLinearGradient(0, -s * 0.34, 0, -s * 0.06);
  streak.addColorStop(0, "rgba(255,255,255,0)");
  streak.addColorStop(0.5, "rgba(255,255,255,0.5)");
  streak.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = streak;
  g.fillRect(-s * 0.7, -s * 0.34, s * 1.4, s * 0.28);
  g.restore();

  // --- the emissive companion ---------------------------------------------
  const e = makeCanvas(size);
  const eg = e.g;
  eg.clearRect(0, 0, s, s);
  eg.fillStyle = "#000000";
  eg.fillRect(0, 0, s, s);
  eg.lineCap = "round";
  eg.lineJoin = "round";
  eg.strokeStyle = "#ffb62e";
  eg.lineWidth = s * 0.125;
  questionPath(eg, cx, cy, s);
  eg.stroke();
  eg.fillStyle = "#ffb62e";
  questionDot(eg, cx, cy, s);
  eg.fill();
  eg.lineWidth = s * 0.05;
  eg.strokeStyle = "rgba(150,230,255,0.85)";
  eg.strokeRect(inset, inset, s - inset * 2, s - inset * 2);

  // --- the alpha companion -------------------------------------------------
  // One uniform opacity would fade the "?" along with the glass, and a washed
  // out glyph is the difference between an item box and a soap bubble. three
  // reads alpha from the map's green channel, so the panel is painted at half
  // and the frame and glyph at nearly solid.
  const a = makeCanvas(size);
  const ag = a.g;
  ag.fillStyle = "#7a7a7a";
  ag.fillRect(0, 0, s, s);
  const edge = ag.createRadialGradient(s * 0.5, s * 0.5, s * 0.2, s * 0.5, s * 0.5, s * 0.72);
  edge.addColorStop(0, "rgba(255,255,255,0)");
  edge.addColorStop(1, "rgba(255,255,255,0.42)");
  ag.fillStyle = edge;
  ag.fillRect(0, 0, s, s);
  ag.lineWidth = s * 0.055;
  ag.strokeStyle = "rgba(255,255,255,0.75)";
  ag.strokeRect(inset, inset, s - inset * 2, s - inset * 2);
  ag.lineCap = "round";
  ag.lineJoin = "round";
  ag.strokeStyle = "#ffffff";
  ag.lineWidth = s * 0.185;
  questionPath(ag, cx, cy, s);
  ag.stroke();
  ag.fillStyle = "#ffffff";
  questionDot(ag, cx, cy, s);
  ag.fill();

  return { albedo: toTexture(c, true), emissive: toTexture(e, true), alpha: toTexture(a, false) };
}

/** Soft radial falloff, the workhorse of every additive sprite in here. */
function bakeGlow(size: number, hardness = 0.18): THREE.CanvasTexture {
  const c = makeCanvas(size);
  const { g, s } = c;
  const gr = g.createRadialGradient(s * 0.5, s * 0.5, s * hardness * 0.5, s * 0.5, s * 0.5, s * 0.5);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.35, "rgba(255,255,255,0.55)");
  gr.addColorStop(0.72, "rgba(255,255,255,0.14)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  return toTexture(c, true);
}

/** A four-pointed sparkle, for coin glints and the star's twinkle. */
function bakeSparkle(size: number): THREE.CanvasTexture {
  const c = makeCanvas(size);
  const { g, s } = c;
  const glow = g.createRadialGradient(s * 0.5, s * 0.5, 0, s * 0.5, s * 0.5, s * 0.34);
  glow.addColorStop(0, "rgba(255,255,255,0.95)");
  glow.addColorStop(0.4, "rgba(255,236,170,0.35)");
  glow.addColorStop(1, "rgba(255,210,120,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = "lighter";
  g.translate(s * 0.5, s * 0.5);
  for (let i = 0; i < 4; i++) {
    // Two long spikes and two short ones: an even cross reads as a plus sign,
    // an uneven one reads as light.
    const len = i % 2 === 0 ? s * 0.48 : s * 0.26;
    const wide = s * 0.045;
    const spike = g.createLinearGradient(0, 0, 0, -len);
    spike.addColorStop(0, "rgba(255,255,255,0.9)");
    spike.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = spike;
    g.beginPath();
    g.moveTo(-wide, 0);
    g.lineTo(0, -len);
    g.lineTo(wide, 0);
    g.closePath();
    g.fill();
    g.rotate(Math.PI / 2);
  }
  return toTexture(c, true);
}

/**
 * The star's shimmer: a looping spectral ramp with soft bands. Scrolled across
 * the aura shell each frame, it is the whole rainbow effect for one texture and
 * one extra draw call per invincible kart.
 */
function bakeRainbow(size: number): THREE.CanvasTexture {
  const c = makeCanvas(size);
  const { g, s } = c;
  const gr = g.createLinearGradient(0, 0, s, 0);
  const stops = [0xff4d6d, 0xffb03a, 0xffe94d, 0x5fe86b, 0x4fd2ff, 0x7b6bff, 0xff5fd0, 0xff4d6d];
  for (let i = 0; i < stops.length; i++) gr.addColorStop(i / (stops.length - 1), rgba(stops[i], 1));
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  // Vertical falloff so the aura fades at the roofline instead of ending flat.
  const fade = g.createLinearGradient(0, 0, 0, s);
  fade.addColorStop(0, "rgba(0,0,0,0.85)");
  fade.addColorStop(0.35, "rgba(0,0,0,0)");
  fade.addColorStop(0.75, "rgba(0,0,0,0)");
  fade.addColorStop(1, "rgba(0,0,0,0.9)");
  g.globalCompositeOperation = "multiply";
  g.fillStyle = fade;
  g.fillRect(0, 0, s, s);
  const tex = toTexture(c, true);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** An ink blob with tendrils and stray droplets — the blooper's calling card. */
function bakeInk(size: number): THREE.CanvasTexture {
  const c = makeCanvas(size);
  const { g, s } = c;
  g.clearRect(0, 0, s, s);
  g.fillStyle = "#0b0f1a";
  // The body: a circle pushed out by a low-frequency radial wobble, which is
  // what separates a splat from a dot.
  g.beginPath();
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const w = 1 + 0.22 * Math.sin(a * 3 + 0.7) + 0.13 * Math.sin(a * 5 - 1.9) + 0.07 * Math.sin(a * 9 + 2.3);
    const r = s * 0.3 * w;
    const x = s * 0.5 + Math.cos(a) * r;
    const y = s * 0.5 + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  // Tendrils and droplets, deterministic so every splat is the same splat.
  for (let i = 0; i < 9; i++) {
    const a = hash01(i * 3.7) * Math.PI * 2;
    const d = s * (0.34 + hash01(i * 9.1) * 0.14);
    const r = s * (0.018 + hash01(i * 5.3) * 0.045);
    g.beginPath();
    g.arc(s * 0.5 + Math.cos(a) * d, s * 0.5 + Math.sin(a) * d, r, 0, Math.PI * 2);
    g.fill();
  }
  // A glossy highlight keeps it from reading as a hole in the screen.
  g.globalCompositeOperation = "lighter";
  const sheen = g.createRadialGradient(s * 0.4, s * 0.36, 0, s * 0.4, s * 0.36, s * 0.22);
  sheen.addColorStop(0, "rgba(120,150,210,0.4)");
  sheen.addColorStop(1, "rgba(120,150,210,0)");
  g.fillStyle = sheen;
  g.fillRect(0, 0, s, s);
  return toTexture(c, true);
}

/** The soft ellipse every floating pickup drops onto the tarmac. */
function bakeBlob(size: number): THREE.CanvasTexture {
  const c = makeCanvas(size);
  const { g, s } = c;
  const gr = g.createRadialGradient(s * 0.5, s * 0.5, 0, s * 0.5, s * 0.5, s * 0.5);
  gr.addColorStop(0, "rgba(0,0,0,0.55)");
  gr.addColorStop(0.45, "rgba(0,0,0,0.34)");
  gr.addColorStop(0.8, "rgba(0,0,0,0.07)");
  gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  return toTexture(c, false);
}

// ===========================================================================
// The geometry kit
//
// Each item is authored at its real world size, merged down to a single
// vertex-coloured buffer, and shared by every instance of that kind. A green
// shell in flight, a green shell orbiting a kart and a green shell resting on
// the road are all the same 1.2 k triangles pointed at the same material.
// ===========================================================================

const TAU = Math.PI * 2;

/** Attach a flat vertex colour so parts can be merged into one draw call. */
function paint(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const n = geo.getAttribute("position").count;
  const arr = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

const _m4 = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _scale = new THREE.Vector3();

/** Position / rotate / scale a part in place, before it is merged. */
function place(
  geo: THREE.BufferGeometry,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.BufferGeometry {
  _euler.set(rx, ry, rz);
  _q.setFromEuler(_euler);
  _v.set(x, y, z);
  _scale.set(sx, sy, sz);
  _m4.compose(_v, _q, _scale);
  geo.applyMatrix4(_m4);
  return geo;
}

/**
 * Merge parts into one geometry.
 *
 * Everything is de-indexed first: `ExtrudeGeometry` ships non-indexed while the
 * primitives are indexed, and `mergeGeometries` refuses a mixed list. The
 * vertex count roughly doubles, which costs nothing at these sizes and is paid
 * once at boot for a permanent draw-call saving.
 */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat: THREE.BufferGeometry[] = [];
  for (const p of parts) {
    const f = p.index ? p.toNonIndexed() : p;
    if (f !== p) p.dispose();
    // Merging needs identical attribute sets; the primitives all carry uv, but
    // ExtrudeGeometry's is 2-component like everyone else's, so this is only a
    // guard against a part that was built without one.
    if (!f.getAttribute("uv")) {
      const n = f.getAttribute("position").count;
      f.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    flat.push(f);
  }
  const out = mergeGeometries(flat, false);
  for (const f of flat) f.dispose();
  if (!out) throw new Error("[kart/items] geometry merge failed");
  out.computeBoundingSphere();
  return out;
}

/**
 * A tapered tube swept along a polyline.
 *
 * Frames are carried forward from the previous ring rather than rebuilt from a
 * fixed up vector, so a banana's curve does not twist halfway along it.
 */
function sweep(points: THREE.Vector3[], radii: number[], radial = 8): THREE.BufferGeometry {
  const n = points.length;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const prevNormal = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    tangent.subVectors(b, a).normalize();
    if (tangent.lengthSq() < 1e-8) tangent.set(0, 0, 1);
    // Project the previous normal onto the new plane: parallel transport.
    normal.copy(prevNormal).addScaledVector(tangent, -prevNormal.dot(tangent));
    if (normal.lengthSq() < 1e-6) normal.set(tangent.y, -tangent.x, 0);
    normal.normalize();
    prevNormal.copy(normal);
    binormal.crossVectors(tangent, normal).normalize();

    for (let k = 0; k < radial; k++) {
      const a2 = (k / radial) * TAU;
      const cx = Math.cos(a2);
      const sy = Math.sin(a2);
      _v.copy(normal).multiplyScalar(cx).addScaledVector(binormal, sy);
      pos.push(
        points[i].x + _v.x * radii[i],
        points[i].y + _v.y * radii[i],
        points[i].z + _v.z * radii[i],
      );
      nor.push(_v.x, _v.y, _v.z);
      uv.push(k / radial, i / (n - 1));
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      const a = i * radial + k;
      const b = i * radial + k2;
      const c = (i + 1) * radial + k;
      const d = (i + 1) * radial + k2;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * A cube with its corners pulled toward a sphere.
 *
 * A hard-edged box has exactly one specular highlight per face and reads as a
 * primitive. Rounding the edges by a tenth gives every edge a bright rim that
 * travels as the box spins, which is most of why the item box looks made rather
 * than typed.
 */
function roundedBox(size: number, round: number, seg = 4): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(size, size, size, seg, seg, seg);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const half = size * 0.5;
  const inner = half - round;
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    // Clamp to the inner cube, then push back out along the offset: the exact
    // rounded-box construction, and it keeps the flat faces genuinely flat.
    _v2.set(clamp(_v.x, -inner, inner), clamp(_v.y, -inner, inner), clamp(_v.z, -inner, inner));
    _v3.subVectors(_v, _v2);
    const len = _v3.length();
    if (len > 1e-6) _v.copy(_v2).addScaledVector(_v3, round / len);
    pos.setXYZ(i, _v.x, _v.y, _v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** A five-pointed star outline, used by the item and by the coin's emboss. */
function starShape(outer: number, inner: number): THREE.Shape {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/** Two eyes with pupils, the single cheapest way to make a prop a character. */
function eyes(
  spread: number,
  y: number,
  z: number,
  size: number,
  white = 0xfbfdff,
  pupil = 0x1a2233,
): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    parts.push(
      paint(place(new THREE.SphereGeometry(size, 10, 8), s * spread, y, z, 0, 0, 0, 0.78, 1, 0.5), white),
    );
    parts.push(
      paint(
        place(new THREE.SphereGeometry(size * 0.45, 8, 6), s * spread * 1.05, y, z + size * 0.42, 0, 0, 0, 0.9, 1, 0.5),
        pupil,
      ),
    );
  }
  return parts;
}

interface ShellSpec {
  shell: number;
  crown: number;
  rim: number;
  belly: number;
  spikes?: boolean;
  wings?: boolean;
}

/**
 * A koopa shell.
 *
 * Dome, white rim, cream belly, and a ring of raised scutes on the back. The
 * scutes are the read: without them a shell is a painted hemisphere, with them
 * it catches a moving highlight on every one of them as it spins.
 */
function shellGeo(spec: ShellSpec): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const R = 0.46;

  parts.push(paint(place(new THREE.SphereGeometry(R, 20, 12, 0, TAU, 0, Math.PI * 0.52), 0, 0, 0, 0, 0, 0, 1, 0.88, 1), spec.shell));
  // A slightly brighter cap sells the curvature under a low sun.
  parts.push(paint(place(new THREE.SphereGeometry(R * 0.62, 16, 8, 0, TAU, 0, Math.PI * 0.42), 0, R * 0.2, 0, 0, 0, 0, 1, 0.7, 1), spec.crown));

  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.26;
    const rr = R * 0.66;
    parts.push(
      paint(
        place(
          new THREE.SphereGeometry(R * 0.2, 8, 6),
          Math.cos(a) * rr,
          R * 0.3,
          Math.sin(a) * rr,
          0,
          0,
          0,
          1,
          0.42,
          1,
        ),
        spec.crown,
      ),
    );
  }

  parts.push(paint(place(new THREE.TorusGeometry(R * 1.02, R * 0.13, 8, 22), 0, 0, 0, Math.PI * 0.5), spec.rim));
  parts.push(
    paint(place(new THREE.SphereGeometry(R * 0.99, 18, 8, 0, TAU, Math.PI * 0.5, Math.PI * 0.5), 0, 0, 0, 0, 0, 0, 1, 0.44, 1), spec.belly),
  );

  if (spec.spikes) {
    // The blue shell's crown of spines, and the reason it is legible at range.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const rr = R * 0.5;
      parts.push(
        paint(
          place(new THREE.ConeGeometry(R * 0.16, R * 0.5, 7), Math.cos(a) * rr, R * 0.5, Math.sin(a) * rr, 0.5 * Math.sin(a), 0, -0.5 * Math.cos(a)),
          0xf2f7ff,
        ),
      );
    }
    parts.push(paint(place(new THREE.ConeGeometry(R * 0.2, R * 0.62, 8), 0, R * 0.72, 0), 0xf2f7ff));
  }
  if (spec.wings) {
    for (const s of [-1, 1]) {
      const wing = new THREE.Shape();
      wing.moveTo(0, 0);
      wing.quadraticCurveTo(0.36, 0.3, 0.62, 0.12);
      wing.quadraticCurveTo(0.44, 0.02, 0.5, -0.16);
      wing.quadraticCurveTo(0.24, -0.12, 0, 0);
      const geo = new THREE.ExtrudeGeometry(wing, { depth: 0.035, bevelEnabled: false, curveSegments: 5 });
      parts.push(paint(place(geo, s * R * 0.82, R * 0.12, 0, Math.PI * 0.5, 0, 0, s, 1, 1), 0xffffff));
    }
  }
  return merge(parts);
}

/** A banana: a tapered crescent with a stubby stem and a dark tip. */
function bananaGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  const n = 12;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const a = lerp(-1.15, 1.15, u);
    pts.push(new THREE.Vector3(Math.sin(a) * 0.42, Math.cos(a) * 0.3 - 0.16, 0));
    // Fat in the middle, pinched at both ends — the silhouette does the work.
    radii.push(0.145 * Math.sin(Math.PI * clamp01(u * 0.94 + 0.03)) ** 0.55);
  }
  const parts = [paint(sweep(pts, radii, 10), 0xffd93b)];
  parts.push(paint(place(new THREE.CylinderGeometry(0.045, 0.062, 0.15, 7), pts[0].x, pts[0].y - 0.03, 0, 0, 0, 1.1), 0x8b6a2a));
  parts.push(paint(place(new THREE.SphereGeometry(0.05, 7, 6), pts[n - 1].x, pts[n - 1].y, 0), 0x6b5220));
  // A highlight ridge along the outer curve: bananas are glossy, and the ridge
  // is what tells the eye so from a hundred metres.
  const ridge: THREE.Vector3[] = [];
  const ridgeR: number[] = [];
  for (let i = 0; i < n; i++) {
    ridge.push(pts[i].clone().multiplyScalar(1.0).add(new THREE.Vector3(0, radii[i] * 0.6, 0)));
    ridgeR.push(radii[i] * 0.3);
  }
  parts.push(paint(sweep(ridge, ridgeR, 6), 0xfff3a8));
  return merge(parts);
}

/** A mushroom: dome cap, spots, fat stalk, two dot eyes. */
function mushroomGeo(cap: number, spot: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(place(new THREE.SphereGeometry(0.44, 18, 10, 0, TAU, 0, Math.PI * 0.56), 0, 0.06, 0, 0, 0, 0, 1, 0.92, 1), cap));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.4;
    const rr = 0.27;
    parts.push(
      paint(
        place(new THREE.SphereGeometry(0.12, 10, 8), Math.cos(a) * rr, 0.24 - (i % 2) * 0.05, Math.sin(a) * rr, 0, 0, 0, 1, 0.5, 1),
        spot,
      ),
    );
  }
  parts.push(paint(place(new THREE.SphereGeometry(0.15, 10, 8), 0, 0.36, 0, 0, 0, 0, 1, 0.55, 1), spot));
  parts.push(paint(place(new THREE.CylinderGeometry(0.2, 0.26, 0.3, 14), 0, -0.11, 0), 0xfff2dd));
  parts.push(paint(place(new THREE.SphereGeometry(0.045, 7, 6), -0.1, -0.09, 0.21, 0, 0, 0, 1, 1.3, 0.5), 0x2a2f3d));
  parts.push(paint(place(new THREE.SphereGeometry(0.045, 7, 6), 0.1, -0.09, 0.21, 0, 0, 0, 1, 1.3, 0.5), 0x2a2f3d));
  return merge(parts);
}

/** A bob-omb: navy sphere, wind-up key, feet, eyes. The fuse spark is separate. */
function bobombGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.SphereGeometry(0.4, 18, 14), 0x1b2440));
  // Rim light band: a hair-thin brighter ring near the top reads as reflected sky.
  parts.push(paint(place(new THREE.SphereGeometry(0.402, 18, 8, 0, TAU, 0, Math.PI * 0.33), 0, 0, 0), 0x2c3a63));
  parts.push(paint(place(new THREE.TorusGeometry(0.13, 0.035, 6, 12), 0, 0.08, -0.4, 0, 0, 0), 0xf0d24a));
  parts.push(paint(place(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 6), 0, 0.08, -0.34, Math.PI * 0.5), 0xf0d24a));
  for (const s of [-1, 1]) {
    parts.push(paint(place(new THREE.SphereGeometry(0.11, 8, 6), s * 0.16, -0.36, 0.07, 0, 0, 0, 1.1, 0.55, 1.4), 0xf4a52c));
  }
  parts.push(...eyes(0.12, 0.11, 0.34, 0.1));
  // The fuse: a swept curve out of the crown, ending where the spark will sit.
  const fuse: THREE.Vector3[] = [];
  const fuseR: number[] = [];
  for (let i = 0; i < 7; i++) {
    const u = i / 6;
    fuse.push(new THREE.Vector3(Math.sin(u * 2.1) * 0.12, 0.38 + u * 0.24, -Math.sin(u * 1.4) * 0.06));
    fuseR.push(lerp(0.035, 0.02, u));
  }
  parts.push(paint(sweep(fuse, fuseR, 6), 0xc9b48a));
  return merge(parts);
}

/** The star: a bevelled five-point extrude with a face. */
function starGeo(): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(starShape(0.5, 0.21), {
    depth: 0.16,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 2,
    curveSegments: 1,
  });
  geo.center();
  const parts = [paint(geo, 0xffe14a)];
  parts.push(...eyes(0.11, 0.02, 0.13, 0.075, 0xffffff, 0x25304a));
  return merge(parts);
}

/** A bullet bill, sized to swallow a kart whole. */
function bulletGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CapsuleGeometry(0.95, 1.5, 6, 20);
  // Local -Z is forward for everything in this game, karts included.
  parts.push(paint(place(body, 0, 0, -0.15, Math.PI * 0.5), 0x161a24));
  parts.push(paint(place(new THREE.SphereGeometry(0.96, 20, 10, 0, TAU, 0, Math.PI * 0.4), 0, 0, -1.2, -Math.PI * 0.5), 0x2a3040));
  for (const s of [-1, 1]) {
    parts.push(paint(place(new THREE.CapsuleGeometry(0.19, 0.5, 4, 8), s * 0.95, -0.1, 0.15, 0, 0, s * 1.15), 0x161a24));
  }
  // Tail fins, for a silhouette that reads as ordnance rather than a pill.
  for (const s of [-1, 1]) {
    parts.push(paint(place(new THREE.BoxGeometry(0.08, 0.5, 0.6), s * 0.7, 0.35, 1.1, 0, 0, s * 0.5), 0x30384a));
  }
  parts.push(...eyes(0.42, 0.18, -1.42, 0.3, 0xfdfdfd, 0x11141c));
  return merge(parts);
}

/** A boo: a sphere with three trailing lobes, big eyes, a small tongue. */
function booGeo(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(0.5, 20, 16);
  const pos = body.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    if (_v.y < 0.02) {
      const a = Math.atan2(_v.z, _v.x);
      // Three lobes, deepening toward the bottom: a ghost's ragged hem.
      const lobe = 1 + 0.36 * Math.sin(a * 3 + 0.6) * clamp01(-_v.y / 0.5);
      pos.setXYZ(i, _v.x * lobe, _v.y * 0.86, _v.z * lobe);
    }
  }
  body.computeVertexNormals();
  const parts = [paint(body, 0xf2f6ff)];
  parts.push(...eyes(0.16, 0.08, 0.44, 0.13, 0xffffff, 0x1b2233));
  parts.push(paint(place(new THREE.SphereGeometry(0.1, 8, 6), 0, -0.13, 0.44, 0, 0, 0, 1.4, 0.7, 0.4), 0xff8fae));
  return merge(parts);
}

/** A blooper: dome mantle, fins, tentacles. */
function bloopGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(place(new THREE.SphereGeometry(0.42, 16, 12, 0, TAU, 0, Math.PI * 0.62), 0, 0, 0, 0, 0, 0, 1, 1.25, 1), 0xf4f7fb));
  for (const s of [-1, 1]) {
    parts.push(paint(place(new THREE.SphereGeometry(0.2, 10, 8), s * 0.36, 0.05, 0, 0, 0, s * 0.4, 1, 0.35, 0.8), 0xe4ebf5));
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    parts.push(
      paint(
        place(new THREE.CylinderGeometry(0.05, 0.02, 0.4, 6), Math.cos(a) * 0.2, -0.24, Math.sin(a) * 0.2, Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35),
        0xeff3fa,
      ),
    );
  }
  parts.push(...eyes(0.14, 0.02, 0.35, 0.1, 0xffffff, 0x161b28));
  return merge(parts);
}

/** A coin: a bevelled disc with a raised star on both faces. */
function coinGeo(detail: boolean): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0, 0.045),
    new THREE.Vector2(0.3, 0.045),
    new THREE.Vector2(0.4, 0.03),
    new THREE.Vector2(0.42, 0),
    new THREE.Vector2(0.4, -0.03),
    new THREE.Vector2(0.3, -0.045),
    new THREE.Vector2(0, -0.045),
  ];
  const parts = [paint(new THREE.LatheGeometry(profile, detail ? 16 : 10), 0xffc327)];
  if (detail) {
    for (const s of [-1, 1]) {
      const star = new THREE.ExtrudeGeometry(starShape(0.24, 0.1), {
        depth: 0.02,
        bevelEnabled: false,
        curveSegments: 1,
      });
      // Authored in XY facing +Z; a quarter turn about X lays it flat on the
      // coin's ±Y face, where the lathe left a plateau for it.
      parts.push(paint(place(star, 0, s * 0.042, 0, -s * Math.PI * 0.5), 0xfff0a4));
    }
  }
  return merge(parts);
}

/** A fire flower: five petals, a bright pistil, two leaves. */
function flowerGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    parts.push(
      paint(
        place(new THREE.SphereGeometry(0.19, 10, 8), Math.cos(a) * 0.26, 0.16, Math.sin(a) * 0.26, 0, 0, 0, 1, 0.42, 1),
        i % 2 === 0 ? 0xff7a2e : 0xffb03a,
      ),
    );
  }
  parts.push(paint(place(new THREE.SphereGeometry(0.17, 12, 10), 0, 0.2, 0, 0, 0, 0, 1, 0.7, 1), 0xfff0a0));
  parts.push(paint(place(new THREE.CylinderGeometry(0.045, 0.055, 0.34, 8), 0, -0.02, 0), 0x3fa63f));
  for (const s of [-1, 1]) {
    parts.push(paint(place(new THREE.SphereGeometry(0.13, 8, 6), s * 0.13, -0.08, 0, 0, 0, s * 0.6, 1.2, 0.3, 0.6), 0x53c353));
  }
  parts.push(...eyes(0.07, 0.19, 0.14, 0.05, 0xffffff, 0x2a2f3d));
  return merge(parts);
}

/** A lightning bolt, extruded flat — used for the strike over each victim. */
function boltGeo(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0.16, 1);
  shape.lineTo(-0.3, 0.12);
  shape.lineTo(-0.02, 0.12);
  shape.lineTo(-0.22, -1);
  shape.lineTo(0.3, 0.02);
  shape.lineTo(0.0, 0.02);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false, curveSegments: 1 });
  geo.center();
  return paint(geo, 0xfff6b0);
}

// ===========================================================================
// The art bundle — geometry, materials and node construction in one place
// ===========================================================================

type Piece =
  | "banana"
  | "greenShell"
  | "redShell"
  | "blueShell"
  | "mushroom"
  | "bobomb"
  | "star"
  | "flower"
  | "blooper"
  | "boo"
  | "bullet"
  | "coin"
  | "bolt"
  | "fireball";

/** Which prop stands in for an item, in the hand and in the air. */
function pieceOf(kind: ItemKind): Piece {
  switch (kind) {
    case "banana":
      return "banana";
    case "greenShell":
      return "greenShell";
    case "redShell":
      return "redShell";
    case "blueShell":
      return "blueShell";
    case "mushroom":
    case "tripleMushroom":
      return "mushroom";
    case "bobomb":
      return "bobomb";
    case "star":
      return "star";
    case "fireflower":
      return "flower";
    case "blooper":
      return "blooper";
    case "boo":
      return "boo";
    case "bullet":
      return "bullet";
    case "lightning":
      return "bolt";
    case "coin":
      return "coin";
    default:
      return "banana";
  }
}

interface Art {
  geo: Record<Piece, THREE.BufferGeometry>;
  box: THREE.BufferGeometry;
  quad: THREE.BufferGeometry;
  aura: THREE.BufferGeometry;
  ghost: THREE.BufferGeometry;
  mats: {
    plastic: THREE.MeshStandardMaterial;
    metal: THREE.MeshStandardMaterial;
    gold: THREE.MeshStandardMaterial;
    star: THREE.MeshStandardMaterial;
    spirit: THREE.MeshStandardMaterial;
    ember: THREE.MeshStandardMaterial;
    boxFace: THREE.MeshStandardMaterial;
    boxGlow: THREE.MeshBasicMaterial;
    halo: THREE.MeshBasicMaterial;
    sparkle: THREE.MeshBasicMaterial;
    rainbow: THREE.MeshBasicMaterial;
    shadow: THREE.MeshBasicMaterial;
    ink: THREE.MeshBasicMaterial;
    flash: THREE.MeshBasicMaterial;
  };
  /** Build a pooled visual for one prop. Geometry and materials are shared. */
  node(piece: Piece): THREE.Group;
  /** Re-point every PBR material at the scene's prefiltered environment. */
  setEnvMap(env: THREE.Texture | null): void;
  dispose(): void;
}

interface ArtOptions {
  quality: KartCtx["quality"];
}

function buildArt(opts: ArtOptions): Art {
  const q = opts.quality;
  const rich = q === "high" || q === "ultra";
  const texSize = q === "low" ? 128 : q === "medium" ? 256 : 512;

  const textures: THREE.Texture[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const track = <T extends THREE.Texture>(t: T): T => (textures.push(t), t);
  const keep = <T extends THREE.BufferGeometry>(g: T): T => (geometries.push(g), g);
  const own = <T extends THREE.Material>(m: T): T => (materials.push(m), m);

  const face = bakeBoxFace(texSize);
  track(face.albedo);
  track(face.emissive);
  track(face.alpha);
  const glowTex = track(bakeGlow(q === "low" ? 64 : 128));
  const sparkleTex = track(bakeSparkle(q === "low" ? 64 : 128));
  const rainbowTex = track(bakeRainbow(q === "low" ? 64 : 256));
  const inkTex = track(bakeInk(q === "low" ? 128 : 256));
  const blobTex = track(bakeBlob(q === "low" ? 64 : 128));

  // -- materials ------------------------------------------------------------
  // Shells, fruit and fungi are all the same moulded plastic: low roughness, a
  // whisper of metalness so the environment shows up in the highlight, and
  // vertex colour doing the palette work. One material, fourteen props.
  const plastic = own(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.24,
      metalness: 0.04,
      envMapIntensity: 1.25,
    }),
  );
  const metal = own(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.86, envMapIntensity: 1.5 }),
  );
  const gold = own(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.19,
      metalness: 0.92,
      emissive: 0xff9d18,
      emissiveIntensity: 0.16,
      envMapIntensity: 1.6,
    }),
  );
  const star = own(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.26,
      metalness: 0.2,
      emissive: 0xffb300,
      emissiveIntensity: 0.85,
      envMapIntensity: 1.4,
    }),
  );
  // Boos and the boo'd: solid enough to read, transparent enough to be a ghost.
  const spirit = own(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.45,
      metalness: 0,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      emissive: 0x8fb6ff,
      emissiveIntensity: 0.35,
    }),
  );
  const ember = own(
    new THREE.MeshStandardMaterial({
      color: 0xff6a1e,
      emissive: 0xff9b2e,
      emissiveIntensity: 2.4,
      roughness: 0.55,
      metalness: 0,
    }),
  );

  // The item box. Double-sided and depth-write-free so you see the far faces
  // through the near ones — that read-through is the entire illusion of glass,
  // and it costs one flag rather than a transmission pass the software
  // rasteriser would never survive.
  const boxFace = own(
    new THREE.MeshStandardMaterial({
      map: face.albedo,
      emissive: 0xffffff,
      emissiveMap: face.emissive,
      emissiveIntensity: 1.15,
      alphaMap: face.alpha,
      transparent: true,
      opacity: 1,
      roughness: 0.08,
      metalness: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
      envMapIntensity: 1.8,
    }),
  );
  const boxGlow = own(
    new THREE.MeshBasicMaterial({
      map: glowTex,
      color: 0x9fe6ff,
      transparent: true,
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    }),
  );
  const halo = own(
    new THREE.MeshBasicMaterial({
      map: glowTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.85,
    }),
  );
  const sparkle = own(
    new THREE.MeshBasicMaterial({
      map: sparkleTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.9,
    }),
  );
  const rainbow = own(
    new THREE.MeshBasicMaterial({
      map: rainbowTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
      opacity: 0.55,
    }),
  );
  const shadow = own(
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.85 }),
  );
  const ink = own(new THREE.MeshBasicMaterial({ map: inkTex, transparent: true, depthWrite: false }));
  const flash = own(
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      color: 0xffffff,
    }),
  );

  // -- geometry -------------------------------------------------------------
  const geo: Record<Piece, THREE.BufferGeometry> = {
    banana: keep(bananaGeo()),
    greenShell: keep(shellGeo({ shell: 0x3fbf46, crown: 0x7ce46a, rim: 0xfdfdfd, belly: 0xfff2cf })),
    redShell: keep(shellGeo({ shell: 0xe0342f, crown: 0xff7a5e, rim: 0xfdfdfd, belly: 0xfff2cf })),
    blueShell: keep(
      shellGeo({ shell: 0x2a63d8, crown: 0x5fa2ff, rim: 0xeaf4ff, belly: 0xdfeaff, spikes: true, wings: true }),
    ),
    mushroom: keep(mushroomGeo(0xe8483f, 0xfff6e6)),
    bobomb: keep(bobombGeo()),
    star: keep(starGeo()),
    flower: keep(flowerGeo()),
    blooper: keep(bloopGeo()),
    boo: keep(booGeo()),
    bullet: keep(bulletGeo()),
    coin: keep(coinGeo(rich)),
    bolt: keep(boltGeo()),
    fireball: keep(paint(new THREE.IcosahedronGeometry(0.3, rich ? 1 : 0), 0xff7a2a)),
  };

  const box = keep(roundedBox(1.55, 0.19, rich ? 3 : 2));
  const quad = keep(new THREE.PlaneGeometry(1, 1));
  const aura = keep(new THREE.SphereGeometry(1.5, rich ? 20 : 12, rich ? 14 : 8));
  const ghost = keep(roundedBox(1.3, 0.4, 2));

  function matFor(piece: Piece): THREE.Material {
    switch (piece) {
      case "coin":
        return gold;
      case "bullet":
        return metal;
      case "star":
      case "bolt":
        return star;
      case "boo":
        return spirit;
      case "fireball":
        return ember;
      default:
        return plastic;
    }
  }

  /** Props that carry their own additive halo — the ones that are meant to burn. */
  function haloOf(piece: Piece): { size: number; color: number } | null {
    switch (piece) {
      case "fireball":
        return { size: 1.9, color: 0xffa33c };
      case "star":
        return { size: 2.6, color: 0xffe07a };
      case "bolt":
        return { size: 3.2, color: 0xfff2a0 };
      case "blueShell":
        return { size: 2.4, color: 0x7fb4ff };
      case "coin":
        return { size: 1.5, color: 0xffd469 };
      default:
        return null;
    }
  }

  function node(piece: Piece): THREE.Group {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(geo[piece], matFor(piece));
    // Item shadows are worth their cost on the props that spend time still —
    // a banana sitting on the apex without a shadow floats. Fireballs and the
    // coin swarm use the cheap blob instead.
    mesh.castShadow = rich && piece !== "fireball" && piece !== "coin";
    mesh.receiveShadow = false;
    g.add(mesh);
    const h = haloOf(piece);
    if (h && q !== "low") {
      const sprite = new THREE.Mesh(quad, halo.clone());
      (sprite.material as THREE.MeshBasicMaterial).color.setHex(h.color);
      materials.push(sprite.material as THREE.Material);
      sprite.scale.setScalar(h.size);
      sprite.renderOrder = 3;
      sprite.userData.halo = true;
      g.add(sprite);
    }
    g.visible = false;
    return g;
  }

  const pbr: THREE.MeshStandardMaterial[] = [plastic, metal, gold, star, spirit, ember, boxFace];

  return {
    geo,
    box,
    quad,
    aura,
    ghost,
    mats: { plastic, metal, gold, star, spirit, ember, boxFace, boxGlow, halo, sparkle, rainbow, shadow, ink, flash },
    node,
    setEnvMap(env) {
      for (const m of pbr) {
        if (m.envMap === env) continue;
        m.envMap = env;
        m.needsUpdate = true;
      }
    },
    dispose() {
      for (const t of textures) t.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      textures.length = 0;
      geometries.length = 0;
      materials.length = 0;
    },
  };
}

// ===========================================================================
// The system
// ===========================================================================

/** Pooled projectile / hazard record. Nothing here is ever reallocated. */
interface Proj {
  id: number;
  active: boolean;
  kind: ItemKind;
  piece: Piece;
  ownerId: number;
  /** Seconds since launch — owner grace, arming and fuses all read it. */
  age: number;
  life: number;
  /** Per-kind phase. 0 is always "in flight". */
  mode: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Surface normal at the last ground sample, for resting orientation. */
  normal: THREE.Vector3;
  /** Spline-followers carry their own arc position and offset. */
  t: number;
  lateral: number;
  hint: number;
  target: number;
  bounces: number;
  spin: number;
  /** Spawn/despawn scale animation, 0..1 with a >0 overshoot band. */
  grow: number;
  dying: number;
  node: THREE.Group | null;
  /** Cheap contact shadow: ground point and how far above it we are. */
  shadowY: number;
  shadowUp: THREE.Vector3;
  /** What a boo is carrying home. */
  payload: ItemKind | null;
}

/** A visual an item box has handed over but which has not been fired yet. */
interface Carry {
  piece: Piece;
  node: THREE.Group;
  /** Lagged world position, so the trail swings through corners. */
  at: THREE.Vector3;
  seeded: boolean;
}

/** Everything this module tracks about one racer. */
interface Slot {
  id: number;
  kind: ItemKind | null;
  count: number;
  /** Roulette seconds remaining; 0 when not spinning. */
  roll: number;
  rolled: ItemKind | null;
  face: number;
  faceClock: number;
  /** Seconds since the item locked — the carry visual waits on it. */
  hold: number;
  /** Seconds of bullet ride left, and where along the road it has got to. */
  bullet: number;
  bulletT: number;
  bulletLateral: number;
  /** The bullet shell wrapped around the kart while it rides. */
  bulletNode: THREE.Group | null;
  /** The silhouette that stands in for a boo'd kart. */
  ghostNode: THREE.Mesh | null;
  /** Boo: seconds of invisibility left. */
  ghost: number;
  /** Blooper: seconds of ink left, and the wobble clock for the AI penalty. */
  ink: number;
  inkClock: number;
  inkSide: number;
  /** Lightning: seconds of shrink left. */
  shrink: number;
  /** Eased star shimmer 0..1, so the aura fades instead of blinking. */
  shimmer: number;
  aura: THREE.Mesh | null;
  splat: THREE.Mesh | null;
  carry: Carry[];
  /** Rig scale we last wrote, so the racer's transform is restored exactly once. */
  rigScale: number;
  prev: THREE.Vector3;
  hint: number;
  /** Fire flower rate limit. */
  cooldown: number;
}

/** One item box or one coin. Same record, same instanced pipeline. */
interface Pickup {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  /** Tilted spin axis, so a box turns like a jewel rather than a turntable. */
  axis: THREE.Vector3;
  /** Rotation that stands the prop up on this stretch of road. */
  orient: THREE.Quaternion;
  /** Ground contact point for the blob shadow. */
  ground: THREE.Vector3;
  t: number;
  phase: number;
  /** 0 live · 1 popping · 2 waiting to respawn · 3 growing back in. */
  state: number;
  clock: number;
}

export default function createItems(ctx: KartCtx): System {
  const quality = ctx.quality;
  const rich = quality === "high" || quality === "ultra";
  const maxProj = quality === "low" ? 14 : quality === "medium" ? 20 : quality === "ultra" ? 36 : 28;

  // -------------------------------------------------------------------------
  // Neighbours. Every one of these may be missing; every caller copes.
  // -------------------------------------------------------------------------
  const getTrack = (): TrackView | undefined => ctx.services.track as TrackView | undefined;
  const getPhysics = (): PhysicsView | undefined => ctx.services.physics as PhysicsView | undefined;
  const getVfx = (): VfxService | undefined => ctx.services.vfx as VfxService | undefined;
  const getAudio = (): AudioService | undefined => ctx.services.audio as AudioService | undefined;
  const getCamera = (): CameraService | undefined => ctx.services.camera as CameraService | undefined;
  const getRace = (): RaceView | undefined => ctx.services.race as RaceView | undefined;

  const slots = new Map<number, Slot>();
  const projectiles: Proj[] = [];
  const nodePool = new Map<Piece, THREE.Group[]>();
  const hazardRefs: HazardRef[] = [];
  /** Backing store for the above: grows once, never shrinks, never reallocates. */
  const hazardPool: HazardRef[] = [];
  const boxes: Pickup[] = [];
  const coins: Pickup[] = [];
  /** Arc-bucketed indices, so a pickup test is eight distance checks, not two hundred. */
  const BUCKETS = 96;
  const boxBuckets: number[][] = [];
  const coinBuckets: number[][] = [];
  /** Field-wide cooldowns on the rare items, keyed by kind. */
  const rareClock = new Map<ItemKind, number>();

  let projSeq = 1;
  let liveBoxes = 0;
  let flash = 0;
  let flashLife = 0.6;
  let flashColor = 0xffffff;
  let flashPeak = 0;
  let disposed = false;

  // Scratch. Declared once, reused everywhere — see rule 1 in the header.
  const _p = new THREE.Vector3();
  const _p2 = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _upv = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _mat = new THREE.Matrix4();
  const _quat = new THREE.Quaternion();
  const _col = new THREE.Color();
  const UP = new THREE.Vector3(0, 1, 0);
  const FORWARD = new THREE.Vector3(0, 0, -1);

  // -------------------------------------------------------------------------
  // Publish first, build second. A system booted after this one is entitled to
  // find a working service even while our textures are still warm.
  // -------------------------------------------------------------------------
  const service: KartItemService = {
    roll,
    use,
    hazards,
    display,
    give,
    bulletOf,
    inkOf,
    starOf,
    coinBonusOf,
    liveBoxes: () => liveBoxes,
    reset,
  };
  ctx.services.items = service;

  let art: Art | null = null;
  try {
    art = buildArt({ quality });
  } catch (err) {
    // No canvas (a headless test, a hostile embed): the item *rules* still work,
    // which is what the AI and the race need. Only the props are missing.
    console.warn("[kart/items] art unavailable, running headless:", err);
  }

  const root = new THREE.Group();
  root.name = "items";
  if (art) ctx.scene.add(root);

  const projRoot = new THREE.Group();
  const carryRoot = new THREE.Group();
  root.add(projRoot, carryRoot);

  // -------------------------------------------------------------------------
  // Pickup fields
  // -------------------------------------------------------------------------
  let boxMesh: THREE.InstancedMesh | null = null;
  let boxGlowMesh: THREE.InstancedMesh | null = null;
  let coinMesh: THREE.InstancedMesh | null = null;
  let glintMesh: THREE.InstancedMesh | null = null;
  let blobMesh: THREE.InstancedMesh | null = null;
  let projBlobMesh: THREE.InstancedMesh | null = null;
  let flashMesh: THREE.Mesh | null = null;

  function bucketOf(t: number): number {
    return Math.min(BUCKETS - 1, Math.max(0, Math.floor(wrap01(t) * BUCKETS)));
  }

  function indexPickups(list: Pickup[], buckets: number[][]): void {
    for (let i = 0; i < BUCKETS; i++) buckets.push([]);
    for (let i = 0; i < list.length; i++) buckets[bucketOf(list[i].t)].push(i);
  }

  /**
   * Where a floating pickup's shadow lands, and which way the ground faces.
   * Falls back to straight down when there is no track service to ask.
   */
  function groundUnder(position: THREE.Vector3, hint: number, outNormal: THREE.Vector3): THREE.Vector3 {
    const t = getTrack();
    const out = new THREE.Vector3().copy(position);
    if (!t) {
      outNormal.set(0, 1, 0);
      out.y -= 1.2;
      return out;
    }
    const s = t.surfaceAt(position, hint);
    outNormal.copy(s.normal);
    out.y = s.height + 0.03;
    return out;
  }

  function buildFields(): void {
    const t = getTrack();
    if (!t || !art) return;

    for (let i = 0; i < t.itemBoxes.length; i++) {
      const spec = t.itemBoxes[i];
      const normal = new THREE.Vector3(0, 1, 0);
      const ground = groundUnder(spec.position, spec.t, normal);
      // The spin axis is the road normal tipped a little, deterministically per
      // box, so a row of five does not turn in lockstep like a factory line.
      const axis = normal
        .clone()
        .add(new THREE.Vector3(hash01(i * 3.1) - 0.5, 0, hash01(i * 7.7) - 0.5).multiplyScalar(0.45))
        .normalize();
      boxes.push({
        position: spec.position.clone(),
        normal,
        axis,
        orient: new THREE.Quaternion().setFromUnitVectors(UP, normal),
        ground,
        t: spec.t,
        phase: hash01(i * 1.7) * TAU,
        state: 0,
        clock: 0,
      });
    }

    // On low, every other coin is dropped: the run still reads as a route, and
    // the instanced draw halves.
    const step = quality === "low" ? 2 : 1;
    for (let i = 0; i < t.coins.length; i += step) {
      const p = t.coins[i];
      const normal = new THREE.Vector3(0, 1, 0);
      const pr = t.project(p);
      const ground = groundUnder(p, pr.t, normal);
      coins.push({
        position: p.clone(),
        normal,
        axis: normal.clone(),
        orient: new THREE.Quaternion().setFromUnitVectors(UP, normal),
        ground,
        t: pr.t,
        phase: hash01(i * 2.3) * TAU,
        state: 0,
        clock: 0,
      });
    }

    indexPickups(boxes, boxBuckets);
    indexPickups(coins, coinBuckets);
    liveBoxes = boxes.length;

    if (boxes.length > 0) {
      boxMesh = new THREE.InstancedMesh(art.box, art.mats.boxFace, boxes.length);
      boxMesh.frustumCulled = false;
      boxMesh.renderOrder = 4;
      boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      root.add(boxMesh);

      if (quality !== "low") {
        boxGlowMesh = new THREE.InstancedMesh(art.box, art.mats.boxGlow, boxes.length);
        boxGlowMesh.frustumCulled = false;
        boxGlowMesh.renderOrder = 3;
        boxGlowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        root.add(boxGlowMesh);
      }
    }

    if (coins.length > 0) {
      coinMesh = new THREE.InstancedMesh(art.geo.coin, art.mats.gold, coins.length);
      coinMesh.frustumCulled = false;
      coinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      root.add(coinMesh);

      if (rich) {
        glintMesh = new THREE.InstancedMesh(art.quad, art.mats.sparkle, coins.length);
        glintMesh.frustumCulled = false;
        glintMesh.renderOrder = 5;
        glintMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        root.add(glintMesh);
      }
    }

    // Contact shadows for everything that floats. One draw call for the whole
    // course, written once at boot and then only when something is collected.
    const blobCount = boxes.length + coins.length;
    if (blobCount > 0 && quality !== "low") {
      blobMesh = new THREE.InstancedMesh(art.quad, art.mats.shadow, blobCount);
      blobMesh.frustumCulled = false;
      blobMesh.renderOrder = 1;
      blobMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      root.add(blobMesh);
    }
    if (quality !== "low") {
      projBlobMesh = new THREE.InstancedMesh(art.quad, art.mats.shadow, maxProj);
      projBlobMesh.frustumCulled = false;
      projBlobMesh.renderOrder = 1;
      projBlobMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      root.add(projBlobMesh);
      for (let i = 0; i < maxProj; i++) hideInstance(projBlobMesh, i);
    }

    // The full-screen flash, parented to the camera so it needs no billboarding.
    flashMesh = new THREE.Mesh(art.quad, art.mats.flash);
    flashMesh.position.set(0, 0, -0.5);
    flashMesh.renderOrder = 10000;
    flashMesh.frustumCulled = false;
    flashMesh.visible = false;
    ctx.camera.add(flashMesh);
  }

  /** Park an instance where nothing can see it. Cheaper than a per-instance flag. */
  function hideInstance(mesh: THREE.InstancedMesh, index: number): void {
    _mat.makeScale(0, 0, 0);
    mesh.setMatrixAt(index, _mat);
  }

  /**
   * Lay a blob shadow on the ground, sized and faded by ride height: high things
   * cast wide soft shadows, things resting on the tarmac cast tight dark ones.
   */
  function writeBlob(mesh: THREE.InstancedMesh, index: number, at: THREE.Vector3, normal: THREE.Vector3, height: number, scale: number): void {
    if (scale <= 0.001) {
      hideInstance(mesh, index);
      return;
    }
    const spread = clamp(0.9 + height * 0.32, 0.9, 2.4) * scale;
    _quat.setFromUnitVectors(FORWARD, _dir.copy(normal).multiplyScalar(-1));
    _p2.copy(at).addScaledVector(normal, 0.02);
    _mat.compose(_p2, _quat, _p.set(spread, spread, 1));
    mesh.setMatrixAt(index, _mat);
  }

  // -------------------------------------------------------------------------
  // Talking to the neighbours
  // -------------------------------------------------------------------------
  function sfx(id: string, at?: THREE.Vector3, volume = 1, rate = 1): void {
    const a = getAudio();
    if (!a) return;
    try {
      a.play(id, at, { volume, rate });
    } catch {
      // A missing cue is a missing cue. It is not a reason to stop the race.
    }
  }

  function burst(kind: VfxBurst, at: THREE.Vector3, normal?: THREE.Vector3, scale = 1): void {
    const v = getVfx();
    if (!v) return;
    try {
      v.burst(kind, at, normal, scale);
    } catch {
      /* as above */
    }
  }

  function shake(amount: number, duration = 0.35): void {
    const c = getCamera();
    if (!c) return;
    try {
      c.shake(amount, duration);
    } catch {
      /* as above */
    }
  }

  /** Fire the full-screen flash. A brighter call wins; a dimmer one is ignored. */
  function flashScreen(color: number, peak: number, seconds: number): void {
    const current = flashPeak * clamp01(flash / Math.max(0.01, flashLife));
    if (peak <= current) return;
    flashColor = color;
    flashPeak = peak;
    flashLife = seconds;
    flash = seconds;
  }

  function racing(): boolean {
    const phase = getRace()?.phase;
    if (phase) return phase === "racing" || phase === "finished";
    return !getPhysics()?.paused;
  }

  // -------------------------------------------------------------------------
  // Racer lookups
  // -------------------------------------------------------------------------
  const order: RacerView[] = [];
  const _sa = new THREE.Vector3();
  const _sb = new THREE.Vector3();
  const _sc = new THREE.Vector3();

  function racerById(id: number): RacerView | undefined {
    const ph = getPhysics();
    if (!ph) return undefined;
    if (ph.get) {
      const hit = ph.get(id);
      if (hit) return hit;
    }
    for (const r of ph.racers) if (r.id === id) return r;
    return undefined;
  }

  function slotOf(id: number): Slot {
    let s = slots.get(id);
    if (s) return s;
    s = {
      id,
      kind: null,
      count: 0,
      roll: 0,
      rolled: null,
      face: 0,
      faceClock: 0,
      hold: 0,
      bullet: 0,
      bulletT: 0,
      bulletLateral: 0,
      bulletNode: null,
      ghostNode: null,
      ghost: 0,
      ink: 0,
      inkClock: 0,
      inkSide: 1,
      shrink: 0,
      shimmer: 0,
      aura: null,
      splat: null,
      carry: [],
      rigScale: 1,
      prev: new THREE.Vector3(),
      hint: 0,
      cooldown: 0,
    };
    slots.set(id, s);
    return s;
  }

  function forwardOf(racer: RacerState, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(FORWARD).applyQuaternion(racer.quaternion);
  }

  /** Live arc position, from physics when it publishes one and by projection otherwise. */
  function arcOf(racer: RacerView, slot: Slot): number {
    if (typeof racer.t === "number" && Number.isFinite(racer.t)) {
      slot.hint = racer.t;
      return racer.t;
    }
    const t = getTrack();
    if (!t) return 0;
    const pr = t.project(racer.position, slot.hint);
    slot.hint = pr.t;
    return pr.t;
  }

  /** Race progress in laps; falls back to raw arc when nobody is counting laps. */
  function progressOf(racer: RacerView): number {
    if (Number.isFinite(racer.progress) && racer.progress > 0) return racer.progress;
    return (racer.lap || 0) + (racer.t ?? 0);
  }

  /** The field, leader first. Rebuilt in place — the array never reallocates. */
  function sortedField(): RacerView[] {
    const ph = getPhysics();
    order.length = 0;
    if (!ph) return order;
    for (const r of ph.racers) order.push(r);
    order.sort((a, b) => progressOf(b) - progressOf(a));
    return order;
  }

  /** The racer immediately in front of (or behind, when `back`) this one. */
  function neighbour(racer: RacerView, back: boolean): RacerView | null {
    const ph = getPhysics();
    if (!ph) return null;
    const mine = progressOf(racer);
    let best: RacerView | null = null;
    let bestGap = Infinity;
    for (const r of ph.racers) {
      if (r.id === racer.id || r.finished) continue;
      const gap = back ? mine - progressOf(r) : progressOf(r) - mine;
      if (gap > 0.0005 && gap < bestGap) {
        bestGap = gap;
        best = r;
      }
    }
    return best;
  }

  function leaderOf(exclude: number): RacerView | null {
    const field = sortedField();
    for (const r of field) if (r.id !== exclude && !r.finished) return r;
    return null;
  }

  /** Squared distance from `p` to the segment a→b — the swept pickup test. */
  function segDistSq(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3): number {
    _sa.subVectors(b, a);
    const len2 = _sa.lengthSq();
    let u = 0;
    if (len2 > 1e-8) u = clamp01(_sb.subVectors(p, a).dot(_sa) / len2);
    return _sc.copy(a).addScaledVector(_sa, u).distanceToSquared(p);
  }

  // -------------------------------------------------------------------------
  // Damage — the one door every impact goes through
  // -------------------------------------------------------------------------
  function canBeHit(racer: RacerView | null | undefined): racer is RacerView {
    if (!racer) return false;
    return !racer.finished && !racer.respawning && racer.invuln <= 0 && racer.star <= 0;
  }

  function damage(
    victim: RacerView,
    by: ItemKind,
    how: "spin" | "squash" | "shock" | "bump",
    seconds?: number,
    at?: THREE.Vector3,
  ): boolean {
    const ph = getPhysics();
    if (!ph || !canBeHit(victim)) return false;
    ph.applyHit(victim.id, how, seconds);
    ctx.emit("kart:hit", { racer: victim.id, by, spin: how === "spin" });

    const where = at ?? victim.position;
    burst("impact", where, undefined, how === "squash" ? 1.4 : 1);
    sfx(how === "squash" ? "itemSquash" : "itemHit", where, 1, 0.94 + hash01(victim.id * 5.5) * 0.12);
    if (victim.isPlayer) shake(how === "squash" ? 0.9 : 0.55, 0.4);

    // Coins are the currency of momentum: losing them is most of the sting of
    // being hit, and they scatter so a rival behind gets a consolation prize.
    loseCoins(victim, TUNE.coinsLostPerHit);
    return true;
  }

  function gainCoins(racer: RacerView, n: number): void {
    const before = racer.coins;
    racer.coins = Math.min(TUNE.coinMax, racer.coins + n);
    if (racer.coins === before) return;
    ctx.emit("coin:pickup", { racer: racer.id, coins: racer.coins, delta: racer.coins - before });
  }

  function loseCoins(racer: RacerView, n: number): void {
    const lost = Math.min(racer.coins, n);
    if (lost <= 0) return;
    racer.coins -= lost;
    ctx.emit("coin:drop", { racer: racer.id, coins: racer.coins, delta: -lost });
    forwardOf(racer, _fwd);
    for (let i = 0; i < lost; i++) {
      const a = (i / Math.max(1, lost)) * TAU + hash01(racer.id + i) * 2;
      _p.copy(racer.position).addScaledVector(UP, 0.7);
      _dir
        .set(Math.cos(a) * 4.2, 6.5 + hash01(i * 3.3) * 2, Math.sin(a) * 4.2)
        .addScaledVector(_fwd, -2)
        .addScaledVector(racer.velocity, 0.25);
      const p = spawnProj("coin", "coin", -1, _p, _dir, TUNE.looseCoinLife);
      if (p) p.spin = hash01(i * 9.7) * TAU;
    }
  }

  // -------------------------------------------------------------------------
  // The roulette
  // -------------------------------------------------------------------------
  const rng = makeRng((Math.floor(ctx.rng() * 0xffffffff) ^ 0x1734bead) >>> 0);

  /**
   * Weighted pick from the place table, with the rare items gated.
   *
   * The interpolation between columns matters more than it looks: with eight
   * hard buckets, a twelve-kart field would see fourth and fifth place share a
   * column and feel identical. Sampling the curve continuously means every
   * place on the road has its own distribution.
   */
  function chooseKind(racer: RacerView | undefined): ItemKind {
    const ph = getPhysics();
    const field = Math.max(1, ph?.racers.length ?? TUNING.fieldSize);
    const place = clamp(racer?.place ?? 1, 1, field);
    const u = field > 1 ? (place - 1) / (field - 1) : 0;
    const col = u * 7;
    const i0 = Math.min(6, Math.floor(col));
    const f = clamp01(col - i0);

    let total = 0;
    const weights: number[] = weightScratch;
    for (let i = 0; i < DISTRIBUTION.length; i++) {
      const row = DISTRIBUTION[i];
      let w = lerp(row.weights[i0], row.weights[i0 + 1], f);
      if (w > 0 && !allowed(row.kind, racer)) w = 0;
      weights[i] = w;
      total += w;
    }
    if (total <= 0) return "banana";

    let pick = rng() * total;
    for (let i = 0; i < DISTRIBUTION.length; i++) {
      pick -= weights[i];
      if (pick <= 0) return DISTRIBUTION[i].kind;
    }
    return DISTRIBUTION[DISTRIBUTION.length - 1].kind;
  }

  const weightScratch: number[] = new Array(DISTRIBUTION.length).fill(0);

  function allowed(kind: ItemKind, racer: RacerView | undefined): boolean {
    if ((rareClock.get(kind) ?? 0) > 0) return false;
    switch (kind) {
      case "coin":
        // A coin item is a reward, not a shrug: never hand one to a racer who
        // is already carrying the maximum.
        return !racer || racer.coins < TUNE.coinMax;
      case "star":
        return !racer || racer.star <= 0;
      case "bullet":
        return !racer || (slotOf(racer.id).bullet <= 0 && (racer.place ?? 1) > 2);
      case "blueShell":
        return !anyLive("blueShell");
      case "lightning":
        return !anyLive("lightning");
      default:
        return true;
    }
  }

  function anyLive(kind: ItemKind): boolean {
    for (const p of projectiles) if (p.active && p.kind === kind) return true;
    return false;
  }

  function roll(racerId: number): ItemKind {
    const racer = racerById(racerId);
    const slot = slotOf(racerId);
    const kind = chooseKind(racer);
    slot.rolled = kind;
    slot.roll = TUNE.rouletteTime;
    slot.face = Math.floor(rng() * ROULETTE_FACES.length);
    slot.faceClock = 0;
    slot.kind = null;
    slot.count = 0;
    if (racer) {
      racer.rolling = true;
      racer.item = ROULETTE_FACES[slot.face];
      racer.itemCount = 0;
    }
    sfx("itemRoulette", racer?.position, racer?.isPlayer ? 1 : 0.45);
    return kind;
  }

  function stepRoulette(racer: RacerView, slot: Slot, dt: number): void {
    if (slot.roll <= 0) return;
    slot.roll = Math.max(0, slot.roll - dt);
    const done = 1 - slot.roll / TUNE.rouletteTime;
    // The last third stretches out: a roulette that stops dead has no drama,
    // and the deceleration is what makes the lock feel like a result.
    const drag = easeInQuad(clamp01((done - (1 - TUNE.rouletteEase)) / TUNE.rouletteEase));
    slot.faceClock -= dt;
    if (slot.faceClock <= 0) {
      slot.faceClock = TUNE.rouletteTick * (1 + drag * 7);
      slot.face = (slot.face + 1) % ROULETTE_FACES.length;
      racer.item = ROULETTE_FACES[slot.face];
      if (racer.isPlayer) sfx("itemTick", undefined, 0.35, 1 + drag * 0.4);
    }
    if (slot.roll > 0) return;

    const kind = slot.rolled ?? "banana";
    slot.kind = kind;
    slot.count = usesOf(kind);
    slot.hold = 0;
    slot.rolled = null;
    racer.rolling = false;
    racer.item = kind;
    racer.itemCount = slot.count;
    const cool = RARE_COOLDOWN[kind];
    if (cool) rareClock.set(kind, cool);
    ctx.emit("item:roll", { racer: racer.id, kind, count: slot.count });
    sfx("itemGet", racer.position, racer.isPlayer ? 1 : 0.5);
  }

  function give(racerId: number, kind: ItemKind, count?: number): void {
    const racer = racerById(racerId);
    const slot = slotOf(racerId);
    slot.roll = 0;
    slot.rolled = null;
    slot.kind = kind;
    slot.count = Math.max(1, count ?? usesOf(kind));
    slot.hold = 0;
    if (racer) {
      racer.rolling = false;
      racer.item = kind;
      racer.itemCount = slot.count;
    }
  }

  function clearInventory(slot: Slot, racer: RacerView | undefined): void {
    slot.kind = null;
    slot.count = 0;
    slot.roll = 0;
    slot.rolled = null;
    slot.hold = 0;
    releaseCarry(slot);
    if (racer) {
      racer.item = null;
      racer.itemCount = 0;
      racer.rolling = false;
    }
  }

  // -------------------------------------------------------------------------
  // Boxes and coins
  // -------------------------------------------------------------------------
  function stepPickups(racer: RacerView, slot: Slot, dt: number): void {
    void dt;
    if (racer.finished || racer.respawning) return;
    const arc = arcOf(racer, slot);
    const b0 = bucketOf(arc);
    const boxR2 = TUNE.boxRadius * TUNE.boxRadius;
    const coinR2 = TUNE.coinRadius * TUNE.coinRadius;
    const takesItem = !slot.kind && slot.roll <= 0;

    for (let k = -1; k <= 1; k++) {
      const b = (b0 + k + BUCKETS) % BUCKETS;

      if (takesItem) {
        const list = boxBuckets[b];
        for (let i = 0; i < list.length; i++) {
          const box = boxes[list[i]];
          if (box.state !== 0) continue;
          if (segDistSq(slot.prev, racer.position, box.position) > boxR2) continue;
          popBox(box, racer);
          break;
        }
      }

      const clist = coinBuckets[b];
      for (let i = 0; i < clist.length; i++) {
        const coin = coins[clist[i]];
        if (coin.state !== 0) continue;
        if (segDistSq(slot.prev, racer.position, coin.position) > coinR2) continue;
        takeCoin(coin, racer);
      }
    }
  }

  function popBox(box: Pickup, racer: RacerView): void {
    box.state = 1;
    box.clock = 0;
    liveBoxes = Math.max(0, liveBoxes - 1);
    burst("itemBox", box.position, box.normal, 1.1);
    sfx("itemBox", box.position, racer.isPlayer ? 1 : 0.55);
    if (racer.isPlayer) shake(0.18, 0.18);
    roll(racer.id);
  }

  function takeCoin(coin: Pickup, racer: RacerView): void {
    coin.state = 1;
    coin.clock = 0;
    burst("coin", coin.position, coin.normal, 0.8);
    // The chime climbs with the count — ten coins is a little fanfare on its own.
    sfx("coin", coin.position, racer.isPlayer ? 0.9 : 0.4, 1 + Math.min(racer.coins, TUNE.coinMax) * 0.045);
    gainCoins(racer, 1);
  }

  function stepPickupField(list: Pickup[], respawn: number, isBox: boolean, dt: number): void {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.state === 0) continue;
      p.clock += dt;
      if (p.state === 1 && p.clock >= TUNE.boxPop) {
        p.state = 2;
        p.clock = 0;
      } else if (p.state === 2 && p.clock >= respawn) {
        p.state = 3;
        p.clock = 0;
        if (isBox) liveBoxes++;
        // A box that reappears in silence is a box nobody notices coming back.
        sfx(isBox ? "itemBoxRespawn" : "coinRespawn", p.position, 0.32);
      } else if (p.state === 3 && p.clock >= 0.4) {
        p.state = 0;
        p.clock = 0;
      }
    }
  }

  /** Scale curve for the pop and the return. */
  function pickupScale(p: Pickup): number {
    switch (p.state) {
      case 0:
        return 1;
      case 1: {
        // Swell, then collapse: the anticipation is what makes it feel struck.
        const u = clamp01(p.clock / TUNE.boxPop);
        return (1 - u * u) * (1 + 0.75 * Math.sin(Math.PI * u));
      }
      case 3:
        return easeOutBack(clamp01(p.clock / 0.4));
      default:
        return 0;
    }
  }

  // -------------------------------------------------------------------------
  // The projectile pool
  // -------------------------------------------------------------------------
  function acquireNode(piece: Piece): THREE.Group | null {
    if (!art) return null;
    let list = nodePool.get(piece);
    if (!list) nodePool.set(piece, (list = []));
    const node = list.pop() ?? art.node(piece);
    node.visible = true;
    node.scale.setScalar(0.001);
    if (!node.parent) projRoot.add(node);
    return node;
  }

  function releaseNode(piece: Piece, node: THREE.Group | null): void {
    if (!node) return;
    node.visible = false;
    let list = nodePool.get(piece);
    if (!list) nodePool.set(piece, (list = []));
    // Eight of anything on the shelf is plenty. The overflow is unparented and
    // left to the collector — its geometry and materials belong to the art
    // bundle, which frees them all at teardown.
    if (list.length < 8) list.push(node);
    else node.removeFromParent();
  }

  function spawnProj(
    kind: ItemKind,
    piece: Piece,
    ownerId: number,
    at: THREE.Vector3,
    velocity: THREE.Vector3,
    life: number,
  ): Proj | null {
    let p: Proj | null = null;
    for (const q of projectiles) {
      if (!q.active) {
        p = q;
        break;
      }
    }
    if (!p) {
      if (projectiles.length < maxProj) {
        p = {
          id: 0,
          active: false,
          kind: "banana",
          piece: "banana",
          ownerId: -1,
          age: 0,
          life: 0,
          mode: 0,
          position: new THREE.Vector3(),
          velocity: new THREE.Vector3(),
          normal: new THREE.Vector3(0, 1, 0),
          t: 0,
          lateral: 0,
          hint: 0,
          target: -1,
          bounces: 0,
          spin: 0,
          grow: 0,
          dying: 0,
          node: null,
          shadowY: 0,
          shadowUp: new THREE.Vector3(0, 1, 0),
          payload: null,
        };
        projectiles.push(p);
      } else {
        // Full pool: the oldest live hazard makes way. Better to lose a banana
        // that has been sitting for half a lap than to drop the shot somebody
        // just fired.
        let oldest: Proj | null = null;
        for (const q of projectiles) {
          if (q.mode < 0) continue;
          if (!oldest || q.age > oldest.age) oldest = q;
        }
        if (!oldest) return null;
        freeProj(oldest);
        p = oldest;
      }
    }

    if (p.node) releaseNode(p.piece, p.node);
    p.id = projSeq++;
    p.active = true;
    p.kind = kind;
    p.piece = piece;
    p.ownerId = ownerId;
    p.age = 0;
    p.life = life;
    p.mode = 0;
    p.position.copy(at);
    p.velocity.copy(velocity);
    p.normal.set(0, 1, 0);
    p.bounces = 0;
    p.spin = 0;
    p.grow = 0;
    p.dying = 0;
    p.target = -1;
    p.payload = null;
    p.lateral = 0;
    p.shadowY = at.y - 1;
    p.shadowUp.set(0, 1, 0);
    const t = getTrack();
    if (t) {
      // Seed the projection from the firing kart rather than from whatever this
      // record was doing in its last life: two parts of the course pass within
      // twenty metres of each other, and a stale hint can pick the wrong one.
      const owner = ownerId >= 0 ? slots.get(ownerId) : undefined;
      const pr = t.project(at, owner ? owner.hint : undefined);
      p.t = pr.t;
      p.lateral = pr.lateral;
      p.hint = pr.t;
    }
    p.node = acquireNode(piece);
    ctx.emit("item:spawn", { id: p.id, kind, position: p.position });
    return p;
  }

  /** Start the death animation. The record stays live until the pop finishes. */
  function kill(p: Proj, pop = true, where?: THREE.Vector3): void {
    if (p.mode < 0) return;
    p.mode = -1;
    p.dying = 0;
    if (pop) burst("smokePuff", where ?? p.position, undefined, 0.7);
  }

  function freeProj(p: Proj): void {
    if (!p.active) return;
    p.active = false;
    releaseNode(p.piece, p.node);
    p.node = null;
    ctx.emit("item:despawn", { id: p.id });
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------
  function use(racerId: number, aimBack: boolean): void {
    const racer = racerById(racerId);
    const slot = slotOf(racerId);
    if (!slot.kind || slot.roll > 0 || slot.cooldown > 0) return;
    if (!racer || racer.finished) return;

    const kind = slot.kind;
    let fired = true;
    switch (kind) {
      case "banana":
        fired = throwBanana(racer, aimBack);
        break;
      case "greenShell":
        fired = throwShell(racer, "greenShell", aimBack);
        break;
      case "redShell":
        fired = throwShell(racer, "redShell", aimBack);
        break;
      case "blueShell":
        fired = throwBlue(racer);
        break;
      case "mushroom":
      case "tripleMushroom":
        fired = useMushroom(racer);
        break;
      case "bobomb":
        fired = throwBobomb(racer, aimBack);
        break;
      case "star":
        fired = useStar(racer, slot);
        break;
      case "lightning":
        fired = useLightning(racer);
        break;
      case "boo":
        fired = useBoo(racer, slot);
        break;
      case "bullet":
        fired = useBullet(racer, slot);
        break;
      case "fireflower":
        fired = throwFireball(racer, slot);
        break;
      case "blooper":
        fired = useBlooper(racer);
        break;
      case "coin":
        gainCoins(racer, 2);
        sfx("coin", racer.position, racer.isPlayer ? 0.9 : 0.4, 1.15);
        break;
      default:
        fired = true;
    }
    if (!fired) return;

    ctx.emit("item:use", { racer: racerId, kind, aimBack });
    slot.count = Math.max(0, slot.count - 1);
    // The flower's whole personality is the rate of fire; everything else gets
    // a beat between presses so a triple does not leave as one shotgun blast.
    slot.cooldown = kind === "fireflower" ? 0.17 : 0.3;
    if (slot.count <= 0) clearInventory(slot, racer);
    else {
      racer.itemCount = slot.count;
      slot.hold = 0;
    }
  }

  /** Muzzle point: in front of the nose, or off the tail when aiming back. */
  function muzzle(racer: RacerView, back: boolean, ahead: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
    forwardOf(racer, _fwd);
    _upv.copy(UP).applyQuaternion(racer.quaternion);
    return out
      .copy(racer.position)
      .addScaledVector(_fwd, back ? -ahead : ahead)
      .addScaledVector(_upv, lift);
  }

  function throwBanana(racer: RacerView, back: boolean): boolean {
    muzzle(racer, back, back ? 1.9 : 1.6, 0.5, _p);
    forwardOf(racer, _fwd);
    if (back) {
      // A dropped banana keeps a little of the kart's speed and then settles,
      // which is what stops it landing under the wheels of the car behind.
      _dir.copy(racer.velocity).multiplyScalar(0.25).addScaledVector(_fwd, -TUNE.bananaDrop).addScaledVector(UP, 1.4);
    } else {
      _dir.copy(racer.velocity).multiplyScalar(0.35).addScaledVector(_fwd, TUNE.bananaThrow).addScaledVector(UP, 6.2);
    }
    const p = spawnProj("banana", "banana", racer.id, _p, _dir, TUNE.bananaLife);
    if (!p) return false;
    sfx(back ? "itemDrop" : "itemThrow", racer.position, 0.8);
    return true;
  }

  function throwShell(racer: RacerView, kind: "greenShell" | "redShell", back: boolean): boolean {
    muzzle(racer, back, 2.1, 0.42, _p);
    forwardOf(racer, _fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    const sign = back ? -1 : 1;
    const speed = kind === "greenShell" ? TUNE.shellSpeed : TUNE.redSpeed;
    _dir.copy(_fwd).multiplyScalar(sign * speed);
    const p = spawnProj(kind, kind, racer.id, _p, _dir, kind === "greenShell" ? TUNE.shellLife : TUNE.redLife);
    if (!p) return false;

    if (kind === "redShell") {
      // Lock on now, not per-frame: a shell that re-targets mid-flight chases
      // whoever happens to be nearest and reads as a cheat.
      const victim = neighbour(racer, back);
      p.target = victim ? victim.id : -1;
      // Spline mode needs its own arc position, and it starts from the kart's.
      p.t = arcOf(racer, slotOf(racer.id));
      p.lateral = racer.lateral ?? 0;
      p.mode = MODE_SPLINE;
    }
    sfx("itemThrow", racer.position, 0.85, kind === "redShell" ? 0.92 : 1);
    return true;
  }

  function throwBlue(racer: RacerView): boolean {
    const target = leaderOf(racer.id);
    muzzle(racer, false, 1.4, 1.4, _p);
    _dir.set(0, 6, 0);
    const p = spawnProj("blueShell", "blueShell", racer.id, _p, _dir, TUNE.blueLife);
    if (!p) return false;
    p.target = target ? target.id : -1;
    p.t = arcOf(racer, slotOf(racer.id));
    p.lateral = racer.lateral ?? 0;
    p.mode = MODE_SPLINE;
    sfx("blueShellLaunch", racer.position, 1);
    if (racer.isPlayer) shake(0.3, 0.4);
    return true;
  }

  function useMushroom(racer: RacerView): boolean {
    const ph = getPhysics();
    if (!ph) return false;
    ph.applyBoost(racer.id, TUNE.mushroomBoost, "mushroom");
    burst("boostFlame", racer.position, undefined, 1.2);
    sfx("mushroom", racer.position, racer.isPlayer ? 1 : 0.5);
    if (racer.isPlayer) shake(0.22, 0.25);
    return true;
  }

  function throwBobomb(racer: RacerView, back: boolean): boolean {
    muzzle(racer, back, 1.8, 0.6, _p);
    forwardOf(racer, _fwd);
    const sign = back ? -1 : 1;
    _dir
      .copy(racer.velocity)
      .multiplyScalar(0.4)
      .addScaledVector(_fwd, sign * (back ? 4 : TUNE.bobombThrow))
      .addScaledVector(UP, back ? 2.2 : 7.5);
    const p = spawnProj("bobomb", "bobomb", racer.id, _p, _dir, TUNE.bobombFuse + 6);
    if (!p) return false;
    sfx(back ? "itemDrop" : "itemThrow", racer.position, 0.85, 0.9);
    return true;
  }

  function useStar(racer: RacerView, slot: Slot): boolean {
    racer.star = Math.max(racer.star, TUNING.starTime);
    racer.invuln = Math.max(racer.invuln, TUNING.starTime);
    slot.shimmer = Math.max(slot.shimmer, 0.02);
    burst("confetti", racer.position, undefined, 1.2);
    sfx("star", racer.position, racer.isPlayer ? 1 : 0.5);
    ctx.emit("item:star", { racer: racer.id, duration: TUNING.starTime });
    return true;
  }

  function useLightning(owner: RacerView): boolean {
    const ph = getPhysics();
    if (!ph) return false;
    flashScreen(0xf2f6ff, 1.4, 0.6);
    shake(0.85, 0.7);
    sfx("lightning", undefined, 1);
    ctx.emit("item:lightning", { by: owner.id });

    for (const victim of ph.racers) {
      if (victim.id === owner.id || victim.finished || victim.star > 0) continue;
      const vs = slotOf(victim.id);
      // Mercy frames still count. Somebody who was hit half a second ago has
      // already paid; hitting them again is the kind of unfairness that reads
      // as a bug rather than a lightning bolt.
      if (victim.invuln <= 0 && !victim.respawning) {
        ph.applyHit(victim.id, "shock", TUNE.lightningStun);
        ctx.emit("kart:hit", { racer: victim.id, by: "lightning", spin: false });
        vs.shrink = TUNE.shrinkTime;
        loseCoins(victim, 2);
      }
      // Everyone loses what they were holding, mercy frames or not.
      if (vs.kind) dropHeld(victim, vs);
      if (vs.bullet > 0) endBullet(victim, vs);

      const bolt = spawnProj("lightning", "bolt", owner.id, _p.copy(victim.position).addScaledVector(UP, 3.4), _dir.set(0, 0, 0), 0.55);
      if (bolt) {
        bolt.mode = MODE_STRIKE;
        bolt.target = victim.id;
      }
    }
    return true;
  }

  /** Everything a racer is carrying hits the deck, with a puff and no owner. */
  function dropHeld(racer: RacerView, slot: Slot): void {
    const kind = slot.kind;
    if (!kind) return;
    if (kind === "banana" || kind === "greenShell" || kind === "redShell" || kind === "bobomb") {
      muzzle(racer, true, 2.4, 0.4, _p);
      _dir.set(0, 1.2, 0);
      // Dropped, not fired. A shed shell keeps its own look but behaves like a
      // banana from here on, which is why it is spawned as the dumb kind: a red
      // shell with no owner and no target has nothing to home at.
      const piece = pieceOf(kind);
      const dropped: ItemKind = kind === "bobomb" ? "bobomb" : kind === "banana" ? "banana" : "greenShell";
      const p = spawnProj(dropped, piece, -1, _p, _dir, TUNE.bananaLife * 0.6);
      if (p) p.mode = kind === "bobomb" ? MODE_FLY : MODE_REST;
    } else {
      burst("smokePuff", racer.position, undefined, 0.6);
    }
    clearInventory(slot, racer);
  }

  function useBoo(racer: RacerView, slot: Slot): boolean {
    slot.ghost = TUNE.booTime;
    racer.invuln = Math.max(racer.invuln, TUNE.booTime);

    // Steal from the best-placed racer who actually has something worth taking.
    let victim: RacerView | null = null;
    for (const r of sortedField()) {
      if (r.id === racer.id || r.finished) continue;
      const s = slotOf(r.id);
      if (s.kind && s.roll <= 0) {
        victim = r;
        break;
      }
    }

    muzzle(racer, false, 0.5, 1.6, _p);
    const p = spawnProj("boo", "boo", racer.id, _p, _dir.set(0, 0, 0), TUNE.booFlight * 2.4);
    if (p) p.target = victim ? victim.id : -1;
    sfx("boo", racer.position, racer.isPlayer ? 1 : 0.5);
    ctx.emit("item:boo", { racer: racer.id, duration: TUNE.booTime });
    return true;
  }

  function useBullet(racer: RacerView, slot: Slot): boolean {
    const t = getTrack();
    if (!t) return false;
    slot.bullet = TUNE.bulletTime;
    slot.bulletT = arcOf(racer, slot);
    slot.bulletLateral = racer.lateral ?? 0;
    racer.invuln = Math.max(racer.invuln, TUNE.bulletTime + 0.4);
    racer.stun = 0;
    racer.stunKind = null;
    if (!slot.bulletNode) {
      slot.bulletNode = acquireNode("bullet");
      if (slot.bulletNode) slot.bulletNode.scale.setScalar(0.01);
    }
    burst("boostFlame", racer.position, undefined, 1.6);
    sfx("bulletStart", racer.position, racer.isPlayer ? 1 : 0.55);
    if (racer.isPlayer) shake(0.5, 0.5);
    ctx.emit("item:bullet", { racer: racer.id, active: true, duration: TUNE.bulletTime });
    return true;
  }

  function throwFireball(racer: RacerView, slot: Slot): boolean {
    muzzle(racer, false, 1.7, 0.55, _p);
    forwardOf(racer, _fwd);
    _fwd.y = 0;
    _fwd.normalize();
    // Alternate the spread left/right per shot so a burst fans out.
    const yaw = (slot.count % 2 === 0 ? 1 : -1) * 0.14;
    _fwd.applyAxisAngle(UP, yaw);
    _dir.copy(_fwd).multiplyScalar(TUNE.fireballSpeed).addScaledVector(UP, 3.4).addScaledVector(racer.velocity, 0.3);
    const p = spawnProj("fireflower", "fireball", racer.id, _p, _dir, TUNE.fireballLife);
    if (!p) return false;
    sfx("fireball", racer.position, 0.7, 0.95 + hash01(slot.count) * 0.2);
    return true;
  }

  function useBlooper(owner: RacerView): boolean {
    const ph = getPhysics();
    if (!ph) return false;
    const mine = progressOf(owner);
    let inked = 0;
    for (const victim of ph.racers) {
      if (victim.id === owner.id || victim.finished || victim.star > 0) continue;
      if (progressOf(victim) <= mine) continue;
      const vs = slotOf(victim.id);
      vs.ink = TUNE.inkTime;
      vs.inkClock = 0;
      inked++;
      if (victim.isPlayer) {
        // The player's version is a screen overlay, so the UI gets the splat
        // layout rather than a mesh: positions in [0,1] screen space.
        const splats: Array<{ x: number; y: number; scale: number; rotation: number }> = [];
        for (let i = 0; i < 5; i++) {
          splats.push({
            x: 0.18 + hash01(i * 7.3 + victim.id) * 0.64,
            y: 0.2 + hash01(i * 3.9 + victim.id * 2) * 0.6,
            scale: 0.25 + hash01(i * 5.1) * 0.45,
            rotation: hash01(i * 11.7) * TAU,
          });
        }
        ctx.emit("item:ink", { racer: victim.id, duration: TUNE.inkTime, splats });
        sfx("inkSplat", undefined, 1);
      } else {
        attachSplat(victim, vs);
      }
    }
    muzzle(owner, false, 1.2, 1.8, _p);
    forwardOf(owner, _fwd);
    _dir.copy(_fwd).multiplyScalar(18).addScaledVector(UP, 2);
    const p = spawnProj("blooper", "blooper", owner.id, _p, _dir, 2.6);
    if (p) p.mode = MODE_FLYER;
    sfx("blooper", owner.position, owner.isPlayer ? 0.9 : 0.5);
    ctx.emit("item:blooper", { racer: owner.id, inked });
    return true;
  }

  // -------------------------------------------------------------------------
  // Impacts
  // -------------------------------------------------------------------------
  /** How long a projectile ignores the racer who fired it. */
  function ownerGrace(p: Proj): number {
    // Anything dropped at your own back bumper needs longer, or you drive into
    // it yourself before it has cleared the diffuser.
    return p.kind === "banana" || p.kind === "bobomb" ? 1.25 : TUNE.ownerGrace;
  }

  function hitRacers(p: Proj, radius: number, apply: (racer: RacerView) => void): boolean {
    const ph = getPhysics();
    if (!ph) return false;
    const r2 = radius * radius;
    for (const r of ph.racers) {
      if (r.finished || r.respawning) continue;
      if (r.id === p.ownerId && p.age < ownerGrace(p)) continue;
      if (r.position.distanceToSquared(p.position) > r2) continue;
      if (r.star > 0) {
        // Invincibility does not dodge a shell, it eats it. Loudly.
        burst("impact", p.position, undefined, 1.1);
        sfx("starDeflect", p.position, 0.8);
        kill(p);
        return true;
      }
      if (!canBeHit(r)) continue;
      apply(r);
      return true;
    }
    return false;
  }

  /** A trailing item is a shield: it and the incoming shot destroy each other. */
  function hitShields(p: Proj): boolean {
    if (p.kind === "banana" || p.kind === "coin" || p.kind === "lightning" || p.kind === "boo") return false;
    for (const [id, slot] of slots) {
      if (id === p.ownerId || slot.carry.length === 0) continue;
      for (const c of slot.carry) {
        if (c.at.distanceToSquared(p.position) > TUNE.shieldRadius * TUNE.shieldRadius) continue;
        const racer = racerById(id);
        burst("impact", c.at, undefined, 0.9);
        sfx("itemBlock", c.at, 0.85);
        consumeCarry(slot, racer);
        kill(p, true, c.at);
        return true;
      }
    }
    return false;
  }

  function consumeCarry(slot: Slot, racer: RacerView | undefined): void {
    slot.count = Math.max(0, slot.count - 1);
    if (slot.count <= 0) clearInventory(slot, racer);
    else if (racer) racer.itemCount = slot.count;
  }

  function blast(at: THREE.Vector3, radius: number, by: ItemKind, impulse: number): void {
    burst("explosion", at, undefined, radius / 9);
    burst("shockwave", at, undefined, radius / 9);
    sfx("explosion", at, 1);
    const ph = getPhysics();
    if (!ph) return;
    for (const r of ph.racers) {
      const d = r.position.distanceTo(at);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      if (r.isPlayer) {
        shake(0.55 + falloff * 0.9, 0.55);
        flashScreen(0xffbb72, 0.55 * falloff, 0.28);
      }
      if (!canBeHit(r)) continue;
      damage(r, by, "squash", undefined, at);
      _dir.subVectors(r.position, at);
      _dir.y = 0;
      if (_dir.lengthSq() < 1e-4) _dir.set(hash01(r.id) - 0.5, 0, hash01(r.id * 3) - 0.5);
      _dir.normalize().multiplyScalar(impulse * falloff);
      _dir.y = impulse * 0.8 * falloff;
      ph.applyImpulse(r.id, _dir);
    }
  }

  // -------------------------------------------------------------------------
  // Projectile motion
  // -------------------------------------------------------------------------
  const MODE_FLY = 0;
  const MODE_SPLINE = 1;
  const MODE_FLYER = 2;
  const MODE_STRIKE = 3;
  const MODE_REST = 4;
  const MODE_HOME = 5;

  /**
   * Gravity, ground contact and the void check, shared by everything that arcs.
   * Returns true on a frame where the prop touched the ground.
   */
  function ballistic(p: Proj, dt: number, bounce: number, radius: number): boolean {
    p.velocity.y -= TUNING.gravity * dt;
    p.position.addScaledVector(p.velocity, dt);

    const t = getTrack();
    if (!t) {
      if (p.position.y <= radius) {
        p.position.y = radius;
        p.velocity.y = bounce > 0 ? -p.velocity.y * bounce : 0;
        return true;
      }
      return false;
    }

    const s = t.surfaceAt(p.position, p.hint);
    p.hint = s.t;
    p.t = s.t;
    p.lateral = s.lateral;
    p.shadowY = s.height;
    p.shadowUp.copy(s.normal);
    if (s.kind === "void" && p.position.y < s.height + 2) {
      // Off the world. No pop — there is nobody down there to see it.
      kill(p, false);
      return false;
    }
    const floor = s.height + radius;
    if (p.position.y <= floor) {
      p.position.y = floor;
      p.normal.copy(s.normal);
      if (bounce > 0 && p.velocity.y < -1.5) {
        p.velocity.y = -p.velocity.y * bounce;
        p.velocity.x *= 0.84;
        p.velocity.z *= 0.84;
      } else {
        p.velocity.y = 0;
      }
      return true;
    }
    return false;
  }

  /** Wall reflection for the dumb projectiles. Returns true if it bounced. */
  function reflectWalls(p: Proj, radius: number, maxBounces: number): boolean {
    const t = getTrack();
    if (!t) return false;
    const hit = t.wallAt(p.position, radius, p.hint);
    if (!hit) return false;
    const vn = p.velocity.dot(hit.normal);
    p.position.addScaledVector(hit.normal, hit.depth + 0.03);
    if (vn >= 0) return false;
    // A true mirror reflection, minus a little energy on a soft barrier — this
    // is the whole reason a green shell is worth aiming rather than spraying.
    p.velocity.addScaledVector(hit.normal, -2 * vn * (hit.solid ? 1 : 0.7));
    p.bounces++;
    burst("impact", hit.point, hit.normal, 0.55);
    sfx("shellBounce", hit.point, 0.65, 0.95 + hash01(p.bounces + p.id) * 0.16);
    if (p.bounces > maxBounces) {
      burst("smokePuff", p.position, undefined, 0.8);
      sfx("itemBreak", p.position, 0.6);
      kill(p, false);
    }
    return true;
  }

  /** A shell rolling on the road: constant ground speed, hugging the surface. */
  function rollShell(p: Proj, dt: number, speed: number, maxBounces: number): void {
    _dir.copy(p.velocity);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
    _dir.normalize().multiplyScalar(speed);
    p.velocity.copy(_dir);
    p.position.addScaledVector(p.velocity, dt);

    const t = getTrack();
    if (t) {
      const s = t.surfaceAt(p.position, p.hint);
      p.hint = s.t;
      p.t = s.t;
      p.lateral = s.lateral;
      p.shadowY = s.height;
      p.shadowUp.copy(s.normal);
      if (s.kind === "void") {
        kill(p, false);
        return;
      }
      // Damped rather than snapped, so a shell crossing a kerb does not strobe.
      p.position.y = damp(p.position.y, s.height + TUNE.shellRadius, 22, dt);
      p.normal.copy(s.normal);
    }
    reflectWalls(p, TUNE.shellRadius * 1.7, maxBounces);
    p.spin += dt * 13;
  }

  /**
   * Place a spline-following projectile on the road at its own (t, lateral).
   *
   * The height comes from the surface query when the road is roughly level with
   * the world — which is everywhere except the anti-gravity plating, where the
   * frame's own up vector is the only thing that means anything.
   */
  function placeOnSpline(p: Proj, ride: number): void {
    const t = getTrack();
    if (!t) return;
    const frame = t.frameAt(p.t, splineFrame);
    const half = Math.max(2, frame.halfWidth - 0.8);
    p.lateral = clamp(p.lateral, -half, half);
    p.position.copy(frame.position).addScaledVector(frame.right, p.lateral);
    if (frame.up.y > 0.5) {
      const s = t.surfaceAt(p.position, p.t);
      p.hint = s.t;
      p.shadowY = s.height;
      p.shadowUp.copy(s.normal);
      p.position.y = s.height + ride;
      p.normal.copy(s.normal);
    } else {
      p.position.addScaledVector(frame.up, ride);
      p.shadowY = p.position.y - ride;
      p.shadowUp.copy(frame.up);
      p.normal.copy(frame.up);
    }
    p.velocity.copy(frame.forward);
  }

  const splineFrame = {
    t: 0,
    position: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, 1),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    halfWidth: 8,
    bank: 0,
    curvature: 0,
    grade: 0,
  };

  function stepProj(p: Proj, dt: number): void {
    p.age += dt;
    p.grow = Math.min(1, p.grow + dt * 6);

    if (p.mode < 0) {
      p.dying += dt;
      if (p.dying > 0.18) freeProj(p);
      return;
    }
    if (p.age > p.life) {
      expire(p);
      return;
    }

    switch (p.kind) {
      case "banana":
        stepBanana(p, dt);
        break;
      case "greenShell":
        stepGreenShell(p, dt);
        break;
      case "redShell":
        stepRedShell(p, dt);
        break;
      case "blueShell":
        stepBlueShell(p, dt);
        break;
      case "bobomb":
        stepBobomb(p, dt);
        break;
      case "fireflower":
        stepFireball(p, dt);
        break;
      case "boo":
        stepBoo(p, dt);
        break;
      case "blooper":
        stepFlyer(p, dt);
        break;
      case "lightning":
        stepStrike(p, dt);
        break;
      case "coin":
        stepLooseCoin(p, dt);
        break;
      default:
        kill(p, false);
    }
  }

  function expire(p: Proj): void {
    if (p.kind === "bobomb") {
      detonate(p);
      return;
    }
    if (p.kind === "blueShell") {
      detonate(p);
      return;
    }
    if (p.kind === "boo" && p.payload) deliverSteal(p);
    kill(p, p.kind !== "lightning" && p.kind !== "blooper");
  }

  function stepBanana(p: Proj, dt: number): void {
    if (p.mode === MODE_FLY) {
      const landed = ballistic(p, dt, 0.22, 0.28);
      if (landed && Math.abs(p.velocity.y) < 1.4) {
        p.mode = MODE_REST;
        p.velocity.set(0, 0, 0);
        sfx("bananaLand", p.position, 0.5);
      }
      // `ballistic` may have thrown it off the world; a dead banana hits nobody.
      if (p.mode < 0) return;
    } else {
      // At rest it turns slowly on the spot: enough motion to catch the eye of
      // somebody about to drive over it, not enough to look like it is alive.
      p.spin += dt * 0.9;
    }
    hitRacers(p, TUNE.hitRadius, (r) => {
      damage(r, "banana", "spin", TUNING.spinTime, p.position);
      burst("smokePuff", p.position, p.normal, 0.9);
      kill(p, false);
    });
  }

  function stepGreenShell(p: Proj, dt: number): void {
    if (p.mode === MODE_REST) {
      // A shell shed by lightning just sits there, exactly like a banana.
      p.spin += dt * 1.2;
    } else {
      rollShell(p, dt, TUNE.shellSpeed, TUNE.shellBounces);
    }
    if (!p.active || p.mode < 0) return;
    if (hitShields(p)) return;
    hitRacers(p, TUNE.hitRadius, (r) => {
      damage(r, "greenShell", "spin", TUNING.spinTime, p.position);
      kill(p, false);
      burst("impact", p.position, p.normal, 1);
    });
  }

  function stepRedShell(p: Proj, dt: number): void {
    const t = getTrack();
    if (!t || p.mode !== MODE_SPLINE) {
      // No lock, or no track to follow: it is a green shell now.
      rollShell(p, dt, TUNE.redSpeed, 2);
      if (p.active && p.mode >= 0 && !hitShields(p)) {
        hitRacers(p, TUNE.hitRadius, (r) => {
          damage(r, "redShell", "spin", TUNING.spinTime, p.position);
          kill(p, false);
        });
      }
      return;
    }

    p.t = wrap01(p.t + (TUNE.redSpeed * dt) / Math.max(1, t.length));
    let goal = 0;
    const target = p.target >= 0 ? racerById(p.target) : undefined;
    if (target && !target.finished) {
      const gap = arcDelta(p.t, target.t ?? p.t) * t.length;
      if (gap < -8 || gap > TUNE.redLock) {
        // Lost them: overshot, or they are a screen away. Go dumb rather than
        // teleporting the lock onto somebody else.
        loseLock(p);
        return;
      }
      goal = target.lateral ?? 0;
    } else if (p.target >= 0) {
      loseLock(p);
      return;
    }
    p.lateral = damp(p.lateral, goal, TUNE.redLateralRate, dt);
    placeOnSpline(p, TUNE.shellRadius + 0.06);
    p.spin += dt * 15;

    if (hitShields(p)) return;
    hitRacers(p, TUNE.hitRadius, (r) => {
      damage(r, "redShell", "spin", TUNING.spinTime, p.position);
      burst("impact", p.position, p.normal, 1.1);
      kill(p, false);
    });
  }

  function loseLock(p: Proj): void {
    p.target = -1;
    p.mode = MODE_FLY;
    const t = getTrack();
    if (t) {
      const frame = t.frameAt(p.t, splineFrame);
      p.velocity.copy(frame.forward).multiplyScalar(TUNE.redSpeed);
    }
    sfx("shellUnlock", p.position, 0.5);
  }

  function stepBlueShell(p: Proj, dt: number): void {
    const t = getTrack();
    if (!t) {
      detonate(p);
      return;
    }
    p.t = wrap01(p.t + (TUNE.blueSpeed * dt) / Math.max(1, t.length));
    const target = p.target >= 0 ? racerById(p.target) : undefined;
    let gap = Infinity;
    if (target && !target.finished) {
      gap = arcDelta(p.t, target.t ?? p.t) * t.length;
      if (gap < 0) gap += t.length;
      p.lateral = damp(p.lateral, target.lateral ?? 0, 2, dt);
    } else {
      p.lateral = damp(p.lateral, 0, 2, dt);
    }

    // Climb out, cruise, then stoop. The dive is the whole drama of the item.
    const climb = clamp01(p.age / 1.2);
    let ride = lerp(1.2, TUNE.blueCruise, easeOutCubic(climb));
    if (gap < 26) ride = lerp(1.1, ride, clamp01((gap - 3) / 23));
    placeOnSpline(p, ride);
    p.spin += dt * 5;

    if (gap < 3.2 || (target && target.position.distanceTo(p.position) < 4)) {
      detonate(p);
      return;
    }
    // A blue shell in the air is still a physical object to anything it clips.
    if (ride < 2.4) {
      hitRacers(p, TUNE.hitRadius, () => detonate(p));
    }
  }

  function detonate(p: Proj): void {
    if (p.mode < 0) return;
    const radius = p.kind === "blueShell" ? 11.5 : TUNE.blastRadius;
    const impulse = p.kind === "blueShell" ? TUNE.blastImpulse * 1.25 : TUNE.blastImpulse;
    if (p.kind === "blueShell") {
      sfx("blueShellHit", p.position, 1);
      flashScreen(0x9fd0ff, 0.5, 0.3);
      // The named victim always pays, even through mercy frames: the whole
      // point of the item is that first place is not safe.
      const target = p.target >= 0 ? racerById(p.target) : undefined;
      const ph = getPhysics();
      if (target && ph && !target.finished && target.star <= 0) {
        target.invuln = 0;
        damage(target, "blueShell", "squash", 1.6, p.position);
      }
    }
    blast(p.position, radius, p.kind, impulse);
    kill(p, false);
  }

  function stepBobomb(p: Proj, dt: number): void {
    if (p.mode === MODE_FLY) {
      const landed = ballistic(p, dt, 0.3, 0.36);
      if (landed && Math.abs(p.velocity.y) < 1.6) {
        p.mode = MODE_REST;
        p.velocity.multiplyScalar(0.1);
      }
      if (p.mode < 0) return;
    } else {
      p.velocity.multiplyScalar(Math.exp(-3 * dt));
      p.position.addScaledVector(p.velocity, dt);
      p.spin += dt * 1.4;
    }
    if (p.age < TUNE.bobombArm) return;

    const ph = getPhysics();
    if (ph) {
      const prox2 = TUNE.bobombProx * TUNE.bobombProx;
      for (const r of ph.racers) {
        if (r.finished || r.respawning) continue;
        if (r.id === p.ownerId && p.age < 1.3) continue;
        if (r.position.distanceToSquared(p.position) > prox2) continue;
        detonate(p);
        return;
      }
    }
  }

  function stepFireball(p: Proj, dt: number): void {
    const landed = ballistic(p, dt, 0.62, 0.3);
    if (landed) {
      p.bounces++;
      sfx("fireballBounce", p.position, 0.45, 1.1);
      burst("smokePuff", p.position, p.normal, 0.35);
      if (p.bounces > TUNE.fireballBounces) {
        kill(p);
        return;
      }
      // Keep the pace up: a fireball that loses all its speed is a dud.
      _dir.copy(p.velocity);
      _dir.y = 0;
      const speed = _dir.length();
      if (speed > 0.5) {
        _dir.multiplyScalar(TUNE.fireballSpeed / speed);
        p.velocity.x = _dir.x;
        p.velocity.z = _dir.z;
      }
    }
    if (p.mode < 0 || !p.active) return;
    reflectWalls(p, 0.5, 99);
    p.spin += dt * 9;
    if (hitShields(p)) return;
    hitRacers(p, TUNE.hitRadius * 0.9, (r) => {
      damage(r, "fireflower", "spin", TUNING.spinTime * 0.7, p.position);
      burst("explosion", p.position, undefined, 0.45);
      kill(p, false);
    });
  }

  function stepBoo(p: Proj, dt: number): void {
    const owner = racerById(p.ownerId);
    const victim = p.target >= 0 ? racerById(p.target) : undefined;
    const goal = p.mode === MODE_HOME ? owner : victim;
    if (!goal) {
      if (p.mode !== MODE_HOME) {
        p.mode = MODE_HOME;
        return;
      }
      kill(p);
      return;
    }
    _p.copy(goal.position).addScaledVector(UP, 1.9);
    // Ghosts do not travel in straight lines. A damped chase plus a lateral
    // sway is two lines of code and reads as drifting rather than flying.
    _dir.subVectors(_p, p.position);
    const dist = _dir.length();
    if (dist > 0.001) _dir.multiplyScalar(1 / dist);
    const speed = Math.max(26, dist * 3.2);
    p.position.addScaledVector(_dir, Math.min(dist, speed * dt));
    p.position.y += Math.sin(p.age * 6.3) * 0.5 * dt * 6;
    p.spin = Math.sin(p.age * 3.1) * 0.4;

    if (dist < 2.4) {
      if (p.mode === MODE_HOME) {
        deliverSteal(p);
        kill(p);
      } else {
        stealFrom(p, goal);
        p.mode = MODE_HOME;
      }
    }
  }

  function stealFrom(p: Proj, victim: RacerView): void {
    const vs = slotOf(victim.id);
    if (!vs.kind || vs.roll > 0) {
      p.mode = MODE_HOME;
      return;
    }
    p.payload = vs.kind;
    p.bounces = vs.count;
    clearInventory(vs, victim);
    burst("smokePuff", victim.position, undefined, 0.9);
    sfx("itemSteal", victim.position, 0.8);
    ctx.emit("item:steal", { from: victim.id, to: p.ownerId, kind: p.payload });
  }

  function deliverSteal(p: Proj): void {
    if (!p.payload) return;
    const owner = racerById(p.ownerId);
    if (owner && !owner.finished) {
      give(p.ownerId, p.payload, Math.max(1, p.bounces));
      ctx.emit("item:roll", { racer: p.ownerId, kind: p.payload, count: Math.max(1, p.bounces) });
      sfx("itemGet", owner.position, owner.isPlayer ? 1 : 0.5);
    }
    p.payload = null;
  }

  /** The blooper's fly-past: decoration with a bob, no collision. */
  function stepFlyer(p: Proj, dt: number): void {
    p.position.addScaledVector(p.velocity, dt);
    p.position.y += Math.sin(p.age * 7) * 1.6 * dt;
    p.velocity.multiplyScalar(Math.exp(-0.5 * dt));
    p.spin += dt * 2.2;
  }

  /** The bolt that lands on a lightning victim, pinned above their roof. */
  function stepStrike(p: Proj, dt: number): void {
    void dt;
    const victim = p.target >= 0 ? racerById(p.target) : undefined;
    if (victim) p.position.copy(victim.position).addScaledVector(UP, 3.2);
  }

  function stepLooseCoin(p: Proj, dt: number): void {
    if (p.mode === MODE_FLY) {
      const landed = ballistic(p, dt, 0.36, 0.2);
      if (landed && Math.abs(p.velocity.y) < 1.2) {
        p.mode = MODE_REST;
        p.velocity.set(0, 0, 0);
      }
      if (p.mode < 0) return;
    }
    p.spin += dt * 5.5;
    if (p.age < TUNE.looseCoinArm) return;
    const ph = getPhysics();
    if (!ph) return;
    for (const r of ph.racers) {
      if (r.finished || r.respawning) continue;
      if (r.position.distanceToSquared(p.position) > 3.2) continue;
      burst("coin", p.position, undefined, 0.6);
      sfx("coin", p.position, r.isPlayer ? 0.85 : 0.35, 1.1);
      gainCoins(r, 1);
      kill(p, false);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Per-racer state: timers, carried items, the bullet, and the coin overdrive
  // -------------------------------------------------------------------------
  function stepRacer(racer: RacerView, slot: Slot, dt: number): void {
    slot.cooldown = Math.max(0, slot.cooldown - dt);

    if (slot.roll > 0) stepRoulette(racer, slot, dt);
    else if (slot.kind) slot.hold += dt;

    if (slot.ghost > 0) {
      slot.ghost -= dt;
      racer.invuln = Math.max(racer.invuln, Math.min(slot.ghost, 0.4));
      if (slot.ghost <= 0) {
        burst("smokePuff", racer.position, undefined, 1.1);
        sfx("booEnd", racer.position, 0.6);
      }
    }
    if (slot.shrink > 0) slot.shrink -= dt;
    if (slot.ink > 0) {
      slot.ink -= dt;
      inkPenalty(racer, slot, dt);
    }
    if (slot.bullet > 0) stepBullet(racer, slot, dt);

    // A finished or respawning racer keeps nothing running.
    if (racer.finished || racer.respawning) {
      if (slot.bullet > 0) endBullet(racer, slot);
    }

    speedTrim(racer, slot, dt);
    updateCarryAnchors(racer, slot, dt);

    // Seed the swept-pickup segment on the first step, and after a teleport, so
    // a respawn does not hoover up every coin between here and the last frame.
    if (slot.prev.lengthSq() === 0 || slot.prev.distanceToSquared(racer.position) > 144) {
      slot.prev.copy(racer.position);
    }
    if (slot.bullet <= 0 && !racer.respawning) stepPickups(racer, slot, dt);
    slot.prev.copy(racer.position);
  }

  /**
   * Coins buy top speed, and being shrunk costs it.
   *
   * Physics recomputes `maxSpeed` from scratch every step and this module is not
   * allowed to reach into it, so the trim is a servo instead: a small forward
   * (or backward) acceleration that only engages within a whisker of the
   * ceiling. It settles within a percent of the target and, unlike a hard
   * override, it never fights the drift model or a boost.
   */
  function speedTrim(racer: RacerView, slot: Slot, dt: number): void {
    const ph = getPhysics();
    if (!ph || !racer.grounded || racer.stun > 0 || slot.bullet > 0 || racer.finished) return;
    const bonus = coinBonusOf(racer.id);
    const penalty = slot.shrink > 0 ? TUNE.shrinkSpeed : 1;
    if (bonus <= 0 && penalty >= 1) return;
    const target = racer.maxSpeed * (1 + bonus) * penalty;
    if (racer.speed < target * 0.9) return;
    const accel = clamp((target - racer.speed) * 3, -6, 4);
    forwardOf(racer, _fwd);
    ph.applyImpulse(racer.id, _fwd.multiplyScalar(accel * dt));
  }

  /** An inked rival cannot see the road, and it shows in the steering. */
  function inkPenalty(racer: RacerView, slot: Slot, dt: number): void {
    if (racer.isPlayer) return;
    const ph = getPhysics();
    if (!ph || !racer.grounded) return;
    slot.inkClock -= dt;
    if (slot.inkClock <= 0) {
      slot.inkClock = TUNE.inkWobble;
      slot.inkSide = -slot.inkSide;
    }
    _right.set(1, 0, 0).applyQuaternion(racer.quaternion);
    ph.applyImpulse(racer.id, _right.multiplyScalar(slot.inkSide * 2.6 * dt));
  }

  /**
   * The bullet drives; you do not.
   *
   * The kart is placed on the racing line kinematically, after physics has had
   * its step, so nothing can push it off. Controls are still fed to physics so
   * that its internal body frame keeps following the road — otherwise the kart
   * would snap back to a stale orientation the instant the bullet ran out.
   */
  function stepBullet(racer: RacerView, slot: Slot, dt: number): void {
    const t = getTrack();
    const ph = getPhysics();
    if (!t || !ph) {
      slot.bullet = 0;
      return;
    }
    slot.bullet -= dt;
    if (slot.bullet <= 0) {
      endBullet(racer, slot);
      return;
    }

    const speed = TUNING.topSpeed * TUNE.bulletSpeed;
    slot.bulletT = wrap01(slot.bulletT + (speed * dt) / Math.max(1, t.length));
    const frame = t.frameAt(slot.bulletT, splineFrame);
    const goal = t.racingLine ? t.racingLine(slot.bulletT) : 0;
    slot.bulletLateral = damp(slot.bulletLateral, clamp(goal, -frame.halfWidth + 1.5, frame.halfWidth - 1.5), 3.5, dt);

    _p.copy(frame.position).addScaledVector(frame.right, slot.bulletLateral);
    if (frame.up.y > 0.5) {
      const s = t.surfaceAt(_p, slot.bulletT);
      _p.y = s.height + 0.42;
    } else {
      _p.addScaledVector(frame.up, 0.42);
    }

    racer.position.copy(_p);
    _dir.copy(frame.forward).multiplyScalar(-1);
    _mat.makeBasis(frame.right, frame.up, _dir);
    racer.quaternion.setFromRotationMatrix(_mat);
    racer.velocity.copy(frame.forward).multiplyScalar(speed);
    racer.speed = speed;
    racer.grounded = true;
    racer.airTime = 0;
    racer.stun = 0;
    racer.stunKind = null;
    racer.rpm = 1;
    racer.invuln = Math.max(racer.invuln, 0.3);
    ph.setControls(racer.id, { accel: 1, brake: 0, steer: 0, drift: false });

    // Anything in the way is punted, which is the entire fantasy of the item.
    for (const other of ph.racers) {
      if (other.id === racer.id || other.finished || other.respawning) continue;
      if (other.position.distanceToSquared(racer.position) > 9) continue;
      if (!canBeHit(other)) continue;
      damage(other, "bullet", "spin", TUNING.spinTime, other.position);
      _dir.subVectors(other.position, racer.position).setY(0.35).normalize().multiplyScalar(13);
      ph.applyImpulse(other.id, _dir);
    }
  }

  function endBullet(racer: RacerView, slot: Slot): void {
    if (slot.bullet <= 0 && !slot.bulletNode) return;
    slot.bullet = 0;
    const ph = getPhysics();
    // Handed back at speed with a short boost, so the transition is a release
    // rather than a wall.
    if (ph) ph.applyBoost(racer.id, 0.6, "bullet");
    burst("smokePuff", racer.position, undefined, 1.3);
    sfx("bulletEnd", racer.position, 0.7);
    ctx.emit("item:bullet", { racer: racer.id, active: false, duration: 0 });
    if (slot.bulletNode) {
      releaseNode("bullet", slot.bulletNode);
      slot.bulletNode = null;
    }
  }

  // -------------------------------------------------------------------------
  // Carried items — the shield you are dragging and the triple you are orbiting
  // -------------------------------------------------------------------------
  function carryCount(slot: Slot): number {
    if (!art || !slot.kind || slot.roll > 0 || slot.bullet > 0 || slot.ghost > 0) return 0;
    if (slot.hold < TUNE.carryDelay) return 0;
    if (!TRAILABLE.has(slot.kind) && !ORBITAL.has(slot.kind) && slot.count <= 1) {
      // A single mushroom or star rides on the deck too — an empty-handed kart
      // holding a blue shell looks like a bug.
      return 1;
    }
    return Math.min(3, Math.max(1, slot.count));
  }

  function rebuildCarry(slot: Slot, piece: Piece, want: number): void {
    while (slot.carry.length > want) {
      const c = slot.carry.pop();
      if (c) releaseNode(c.piece, c.node);
    }
    for (const c of slot.carry) {
      if (c.piece === piece) continue;
      releaseNode(c.piece, c.node);
      const node = acquireNode(piece);
      if (!node) continue;
      c.piece = piece;
      c.node = node;
      c.seeded = false;
    }
    while (slot.carry.length < want) {
      const node = acquireNode(piece);
      if (!node) break;
      slot.carry.push({ piece, node, at: new THREE.Vector3(), seeded: false });
    }
  }

  function releaseCarry(slot: Slot): void {
    for (const c of slot.carry) releaseNode(c.piece, c.node);
    slot.carry.length = 0;
  }

  /** Where each carried prop wants to be this step. Read by the shield test. */
  function updateCarryAnchors(racer: RacerView, slot: Slot, dt: number): void {
    const want = carryCount(slot);
    const piece = slot.kind ? pieceOf(slot.kind) : "banana";
    if (slot.carry.length !== want || (want > 0 && slot.carry[0].piece !== piece)) {
      rebuildCarry(slot, piece, want);
    }
    if (want === 0) return;

    const orbit = want > 1 || (slot.kind !== null && ORBITAL.has(slot.kind));
    forwardOf(racer, _fwd);
    _upv.copy(UP).applyQuaternion(racer.quaternion);
    for (let i = 0; i < slot.carry.length; i++) {
      const c = slot.carry[i];
      if (orbit) {
        const a = ctx.elapsed * TUNE.carryOrbitRate + (i / slot.carry.length) * TAU;
        _right.set(1, 0, 0).applyQuaternion(racer.quaternion);
        _p.copy(racer.position)
          .addScaledVector(_right, Math.cos(a) * TUNE.carryOrbit)
          .addScaledVector(_fwd, Math.sin(a) * TUNE.carryOrbit)
          .addScaledVector(_upv, 0.62);
        // Orbiting items are rigid: the lag that sells a trailing shell makes an
        // orbit look like it is on elastic.
        c.at.copy(_p);
      } else {
        _p.copy(racer.position)
          .addScaledVector(_fwd, -TUNE.carryTrail)
          .addScaledVector(_upv, 0.34 + Math.sin(ctx.elapsed * 3 + racer.id) * 0.05);
        if (!c.seeded) c.at.copy(_p);
        // A spring, not a snap: the shell swings wide through a corner and
        // settles back on the exit, which is the whole charm of dragging one.
        c.at.x = damp(c.at.x, _p.x, 9, dt);
        c.at.y = damp(c.at.y, _p.y, 12, dt);
        c.at.z = damp(c.at.z, _p.z, 9, dt);
      }
      c.seeded = true;
    }
  }

  // -------------------------------------------------------------------------
  // Service surface
  // -------------------------------------------------------------------------
  function display(racerId: number): ItemDisplay {
    const slot = slots.get(racerId);
    if (!slot) return { kind: null, count: 0, rolling: false, face: null };
    return {
      kind: slot.kind,
      count: slot.count,
      rolling: slot.roll > 0,
      face: slot.roll > 0 ? ROULETTE_FACES[slot.face] : slot.kind,
    };
  }

  function bulletOf(racerId: number): number {
    return slots.get(racerId)?.bullet ?? 0;
  }

  function inkOf(racerId: number): number {
    const ink = slots.get(racerId)?.ink ?? 0;
    return Math.min(1, Math.max(0, ink));
  }

  function starOf(racerId: number): number {
    return slots.get(racerId)?.shimmer ?? 0;
  }

  function coinBonusOf(racerId: number): number {
    const racer = racerById(racerId);
    if (!racer) return 0;
    return Math.min(racer.coins, TUNE.coinMax) * TUNE.coinSpeed;
  }

  /**
   * The hazard list the AI steers around.
   *
   * Rebuilt in place into pre-allocated records: the AI asks for this five
   * times a second and would otherwise be handed a fresh array of fresh
   * Vector3s every time.
   */
  function hazards(): HazardRef[] {
    hazardRefs.length = 0;
    let n = 0;
    for (const p of projectiles) {
      if (!p.active || p.mode < 0) continue;
      // Decoration is not a hazard. A rival swerving around a lightning bolt
      // that cannot hurt them looks like a rival with a bug.
      if (p.kind === "lightning" || p.kind === "blooper" || p.kind === "boo" || p.kind === "coin") continue;
      const ref = hazardAt(n++);
      ref.id = p.id;
      ref.kind = p.kind;
      ref.ownerId = p.ownerId;
      ref.position.copy(p.position);
      hazardRefs.push(ref);
      if (n >= 24) break;
    }
    for (const [id, slot] of slots) {
      if (n >= 24) break;
      if (!slot.kind || slot.carry.length === 0) continue;
      if (!TRAILABLE.has(slot.kind)) continue;
      const c = slot.carry[0];
      const ref = hazardAt(n++);
      ref.id = -id - 1;
      ref.kind = slot.kind;
      ref.ownerId = id;
      ref.position.copy(c.at);
      hazardRefs.push(ref);
    }
    return hazardRefs;
  }

  function hazardAt(i: number): HazardRef {
    let ref = hazardPool[i];
    if (!ref) {
      ref = { id: 0, kind: "banana", position: new THREE.Vector3(), ownerId: -1 };
      hazardPool[i] = ref;
    }
    return ref;
  }

  function reset(): void {
    for (const p of projectiles) if (p.active) freeProj(p);
    for (const [id, slot] of slots) {
      const racer = racerById(id);
      if (slot.bullet > 0) {
        slot.bullet = 0;
        if (slot.bulletNode) {
          releaseNode("bullet", slot.bulletNode);
          slot.bulletNode = null;
        }
      }
      clearInventory(slot, racer);
      slot.ghost = 0;
      slot.ink = 0;
      slot.shrink = 0;
      slot.shimmer = 0;
      slot.cooldown = 0;
      slot.rigScale = 1;
      slot.prev.set(0, 0, 0);
      if (racer?.object) racer.object.scale.setScalar(1);
      detachSplat(slot);
    }
    for (const b of boxes) {
      b.state = 0;
      b.clock = 0;
    }
    for (const c of coins) {
      c.state = 0;
      c.clock = 0;
    }
    liveBoxes = boxes.length;
    rareClock.clear();
    flash = 0;
    flashPeak = 0;
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------
  const _quatB = new THREE.Quaternion();
  const _quatC = new THREE.Quaternion();
  /** Stands a lathed disc on its edge: local +Y (the disc axis) becomes +Z. */
  const TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 0.5);
  const ZPLUS = new THREE.Vector3(0, 0, 1);
  const ownedMaterials: THREE.Material[] = [];

  /** Display size per prop — the props are authored at their natural scale. */
  function sizeOf(piece: Piece): number {
    switch (piece) {
      case "blueShell":
        return 1.18;
      case "bolt":
        return 2.2;
      case "blooper":
        return 1.35;
      case "boo":
        return 1.3;
      case "star":
        return 1.15;
      default:
        return 1;
    }
  }

  function updateBoxes(elapsed: number): void {
    if (!boxMesh) return;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const s = pickupScale(b);
      if (s <= 0.002) {
        hideInstance(boxMesh, i);
        if (boxGlowMesh) hideInstance(boxGlowMesh, i);
        if (blobMesh) hideInstance(blobMesh, i);
        continue;
      }
      const bob = Math.sin(elapsed * TUNE.boxBobRate + b.phase) * TUNE.boxBob;
      _p.copy(b.position).addScaledVector(b.normal, bob);
      _quat.setFromAxisAngle(b.axis, elapsed * TUNE.boxSpin + b.phase);
      _mat.compose(_p, _quat, _p2.set(s, s, s));
      boxMesh.setMatrixAt(i, _mat);
      if (boxGlowMesh) {
        // The halo breathes a little out of phase with the bob, so the box
        // reads as lit from within rather than painted.
        const g = s * (1.16 + Math.sin(elapsed * 2.3 + b.phase) * 0.035);
        _mat.compose(_p, _quat, _p2.set(g, g, g));
        boxGlowMesh.setMatrixAt(i, _mat);
      }
      if (blobMesh) writeBlob(blobMesh, i, b.ground, b.normal, b.position.distanceTo(b.ground), s * 1.25);
    }
    boxMesh.instanceMatrix.needsUpdate = true;
    if (boxGlowMesh) boxGlowMesh.instanceMatrix.needsUpdate = true;
  }

  function updateCoins(elapsed: number): void {
    if (!coinMesh) return;
    const base = boxes.length;
    if (glintMesh) _quatC.copy(ctx.camera.quaternion);
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      const s = pickupScale(c);
      if (s <= 0.002) {
        hideInstance(coinMesh, i);
        if (glintMesh) hideInstance(glintMesh, i);
        if (blobMesh) hideInstance(blobMesh, base + i);
        continue;
      }
      const angle = elapsed * TUNE.coinSpin + c.phase;
      _quat.copy(c.orient).multiply(_quatB.setFromAxisAngle(UP, angle)).multiply(TILT);
      _p.copy(c.position).addScaledVector(c.normal, Math.sin(elapsed * 2.1 + c.phase) * 0.09);
      const size = s * 1.5;
      _mat.compose(_p, _quat, _p2.set(size, size, size));
      coinMesh.setMatrixAt(i, _mat);

      if (glintMesh) {
        // The flash happens as the face turns through the camera: a sharp power
        // curve on the spin phase, which is free and looks like polished metal.
        const face = Math.abs(Math.cos(angle));
        const flashAmt = Math.pow(face, 14) * s;
        if (flashAmt < 0.02) hideInstance(glintMesh, i);
        else {
          const g = 1.1 + flashAmt * 1.6;
          _mat.compose(_p, _quatC, _p2.set(g, g, g));
          glintMesh.setMatrixAt(i, _mat);
        }
      }
      if (blobMesh) writeBlob(blobMesh, base + i, c.ground, c.normal, c.position.distanceTo(c.ground), s);
    }
    coinMesh.instanceMatrix.needsUpdate = true;
    if (glintMesh) glintMesh.instanceMatrix.needsUpdate = true;
  }

  function updateProjectiles(): void {
    if (!projRoot) return;
    let blob = 0;
    for (const p of projectiles) {
      if (!p.active || !p.node) continue;
      const node = p.node;
      node.visible = true;
      node.position.copy(p.position);
      orientProp(p, node);

      let s = easeOutBack(clamp01(p.grow)) * sizeOf(p.piece);
      if (p.mode < 0) s *= clamp01(1 - p.dying / 0.18) * (1 + p.dying * 2.2);
      if (p.kind === "lightning") {
        // The bolt strikes: it arrives oversized and snaps down to nothing.
        const u = clamp01(p.age / Math.max(0.001, p.life));
        s = sizeOf("bolt") * (1.4 - u) * (u < 0.12 ? u / 0.12 : 1);
      }
      node.scale.setScalar(Math.max(0.001, s));

      // The halo always faces the camera, whatever the prop is doing.
      for (const child of node.children) {
        if (!child.userData.halo) continue;
        _quatB.copy(node.quaternion).invert().multiply(ctx.camera.quaternion);
        child.quaternion.copy(_quatB);
        const m = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        const pulse = p.kind === "fireflower" ? 0.75 + Math.sin(p.age * 30) * 0.25 : 0.85;
        m.opacity = pulse * clamp01(p.grow) * (p.mode < 0 ? clamp01(1 - p.dying / 0.18) : 1);
      }

      if (projBlobMesh && blob < maxProj) {
        const height = Math.max(0, p.position.y - p.shadowY);
        if (height < 9) {
          _p.copy(p.position).addScaledVector(p.shadowUp, -height);
          writeBlob(projBlobMesh, blob, _p, p.shadowUp, height, clamp01(1 - height / 9) * 0.9);
          blob++;
        }
      }
    }
    if (projBlobMesh) {
      for (let i = blob; i < maxProj; i++) hideInstance(projBlobMesh, i);
      projBlobMesh.instanceMatrix.needsUpdate = true;
    }
  }

  function orientProp(p: Proj, node: THREE.Object3D): void {
    switch (p.kind) {
      case "coin": {
        _quat.setFromUnitVectors(UP, p.normal);
        node.quaternion.copy(_quat).multiply(_quatB.setFromAxisAngle(UP, p.spin)).multiply(TILT);
        break;
      }
      case "banana":
      case "greenShell":
      case "redShell":
      case "blueShell":
      case "bobomb": {
        _quat.setFromUnitVectors(UP, p.normal);
        node.quaternion.copy(_quat).multiply(_quatB.setFromAxisAngle(UP, p.spin));
        break;
      }
      case "fireflower": {
        // A fireball tumbles on all three axes; anything less reads as a ball
        // being slid along the road.
        node.rotation.set(p.spin * 1.3, p.spin * 0.9, p.spin * 0.55);
        break;
      }
      case "lightning": {
        node.quaternion.copy(ctx.camera.quaternion);
        break;
      }
      default: {
        // Face where it is going, and lean into the wobble.
        _dir.copy(p.velocity);
        if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
        _p2.copy(p.position).add(_dir);
        _mat.lookAt(p.position, _p2, UP);
        node.quaternion.setFromRotationMatrix(_mat);
        node.rotateZ(p.spin);
        break;
      }
    }
  }

  function updateRacerVisuals(dt: number): void {
    const ph = getPhysics();
    if (!ph || !art) return;
    for (const racer of ph.racers) {
      const slot = slotOf(racer.id);

      // -- carried props ----------------------------------------------------
      for (let i = 0; i < slot.carry.length; i++) {
        const c = slot.carry[i];
        const node = c.node;
        node.visible = true;
        node.position.copy(c.at);
        node.quaternion.copy(racer.quaternion);
        node.rotateY(ctx.elapsed * (slot.count > 1 ? 2.6 : 1.4) + i * 2.1);
        const grow = clamp01((slot.hold - TUNE.carryDelay) * 5);
        node.scale.setScalar(Math.max(0.001, easeOutBack(grow) * 0.86 * sizeOf(c.piece)));
      }

      // -- star shimmer -----------------------------------------------------
      const wantShimmer = racer.star > 0 ? 1 : 0;
      slot.shimmer = damp(slot.shimmer, wantShimmer, 1 / Math.max(0.05, TUNE.auraFade), dt);
      if (slot.shimmer > 0.01) {
        if (!slot.aura) {
          const m = art.mats.rainbow.clone();
          ownedMaterials.push(m);
          slot.aura = new THREE.Mesh(art.aura, m);
          slot.aura.renderOrder = 6;
          slot.aura.frustumCulled = false;
          root.add(slot.aura);
        }
        slot.aura.visible = true;
        slot.aura.position.copy(racer.position).addScaledVector(UP, 0.35);
        slot.aura.quaternion.copy(racer.quaternion);
        const pulse = 1 + Math.sin(ctx.elapsed * 9 + racer.id) * 0.045;
        slot.aura.scale.set(0.92 * pulse, 0.74 * pulse, 1.12 * pulse);
        (slot.aura.material as THREE.MeshBasicMaterial).opacity = slot.shimmer * 0.6;
      } else if (slot.aura) {
        slot.aura.visible = false;
      }

      // -- boo: the kart folds away and a ghost takes its place -------------
      const hidden = slot.ghost > 0 || slot.bullet > 0;
      if (slot.ghost > 0) {
        if (!slot.ghostNode) {
          slot.ghostNode = new THREE.Mesh(art.ghost, art.mats.spirit);
          slot.ghostNode.frustumCulled = false;
          slot.ghostNode.renderOrder = 5;
          root.add(slot.ghostNode);
        }
        slot.ghostNode.visible = true;
        slot.ghostNode.position.copy(racer.position).addScaledVector(UP, 0.25 + Math.sin(ctx.elapsed * 2.4) * 0.06);
        slot.ghostNode.quaternion.copy(racer.quaternion);
        const wobble = 1 + Math.sin(ctx.elapsed * 5 + racer.id) * 0.04;
        slot.ghostNode.scale.set(1.35 * wobble, 0.9, 1.9 / wobble);
      } else if (slot.ghostNode) {
        slot.ghostNode.visible = false;
      }

      // -- bullet shell -----------------------------------------------------
      if (slot.bullet > 0 && slot.bulletNode) {
        const node = slot.bulletNode;
        node.visible = true;
        node.position.copy(racer.position).addScaledVector(UP, 0.35);
        node.quaternion.copy(racer.quaternion);
        const inOut = Math.min(clamp01((TUNE.bulletTime - slot.bullet) * 6), clamp01(slot.bullet * 4));
        node.scale.setScalar(Math.max(0.001, easeOutBack(inOut)));
      }

      // -- lightning shrink, boo vanish -------------------------------------
      const wantScale = hidden ? 0.001 : slot.shrink > 0 ? TUNE.shrinkScale : 1;
      slot.rigScale = damp(slot.rigScale, wantScale, 12, dt);
      if (racer.object) {
        if (Math.abs(slot.rigScale - 1) > 0.003) racer.object.scale.setScalar(slot.rigScale);
        else if (racer.object.scale.x !== 1) racer.object.scale.setScalar(1);
      }

      // -- ink splat --------------------------------------------------------
      if (slot.splat) {
        if (slot.ink <= 0) detachSplat(slot);
        else {
          const m = slot.splat.material as THREE.MeshBasicMaterial;
          m.opacity = clamp01(slot.ink * 1.4) * 0.92;
        }
      }
    }
  }

  function attachSplat(racer: RacerView, slot: Slot): void {
    if (!art || !racer.object || slot.splat) return;
    const m = art.mats.ink.clone();
    ownedMaterials.push(m);
    const mesh = new THREE.Mesh(art.quad, m);
    // Across the nose, tipped back toward the driver: it reads from the chase
    // camera and from a rival's mirror alike.
    mesh.position.set(0, 0.95, -0.55);
    mesh.rotation.set(-1.15, 0, hash01(racer.id) * TAU);
    mesh.scale.setScalar(1.9);
    mesh.renderOrder = 7;
    racer.object.add(mesh);
    slot.splat = mesh;
  }

  function detachSplat(slot: Slot): void {
    if (!slot.splat) return;
    slot.splat.removeFromParent();
    const m = slot.splat.material as THREE.Material;
    const i = ownedMaterials.indexOf(m);
    if (i >= 0) ownedMaterials.splice(i, 1);
    m.dispose();
    slot.splat = null;
  }

  function updateFlash(dt: number): void {
    if (!flashMesh || !art) return;
    if (flash <= 0) {
      if (flashMesh.visible) flashMesh.visible = false;
      return;
    }
    flash = Math.max(0, flash - dt);
    const u = clamp01(flash / Math.max(0.01, flashLife));
    const m = art.mats.flash;
    m.opacity = clamp01(flashPeak * easeInQuad(u));
    _col.setHex(flashColor);
    m.color.copy(_col);
    // Sized to the frustum every frame, because the camera's FOV widens with
    // speed and a fixed quad would show its edges at 300 km/h.
    const dist = 0.5;
    const h = 2 * dist * Math.tan((ctx.camera.fov * Math.PI) / 360) * 1.15;
    flashMesh.scale.set(h * ctx.camera.aspect, h, 1);
    flashMesh.visible = m.opacity > 0.002;
    if (flash <= 0) flashPeak = 0;
  }

  // -------------------------------------------------------------------------
  // The player's trigger
  // -------------------------------------------------------------------------
  // `itemPressed` is an edge flag the engine clears once per rendered frame,
  // while this runs up to eight times in that frame. Without the latch, one
  // press would fire a triple mushroom three times in three milliseconds.
  let itemLatch = false;

  function handlePlayerInput(ph: PhysicsView): void {
    if ((ph as { playerAi?: boolean }).playerAi) return;
    const player = ph.player;
    if (!player) return;
    const pressed = ctx.input.itemPressed;
    if (pressed && !itemLatch) {
      itemLatch = true;
      use(player.id, ctx.input.aimBack);
    } else if (!pressed) {
      itemLatch = false;
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  buildFields();

  const offRestart = ctx.on("race:restart", (() => reset()) as (p: never) => void);

  const offStart = ctx.on("race:start", (() => {
    // The lights going out wipes the road: nothing from the last run should
    // still be rolling around on the first corner of this one.
    for (const p of projectiles) if (p.active) freeProj(p);
  }) as (p: never) => void);

  const offRespawn = ctx.on("race:respawn", ((payload: { racer?: number }) => {
    const id = payload?.racer;
    if (typeof id !== "number") return;
    const slot = slots.get(id);
    if (!slot) return;
    const racer = racerById(id);
    if (slot.bullet > 0 && racer) endBullet(racer, slot);
    slot.ghost = 0;
    slot.ink = 0;
    slot.inkClock = 0;
    detachSplat(slot);
    // The swept pickup segment must not span the teleport.
    slot.prev.set(0, 0, 0);
  }) as (p: never) => void);

  return {
    fixedUpdate(dt: number): void {
      if (disposed) return;
      const ph = getPhysics();
      if (!ph || ph.paused || !racing()) return;

      for (const [kind, left] of rareClock) {
        if (left > 0) rareClock.set(kind, Math.max(0, left - dt));
      }

      handlePlayerInput(ph);
      for (const racer of ph.racers) stepRacer(racer, slotOf(racer.id), dt);
      for (const p of projectiles) if (p.active) stepProj(p, dt);
      stepPickupField(boxes, TUNE.boxRespawn, true, dt);
      stepPickupField(coins, TUNE.coinRespawn, false, dt);
    },

    update(dt: number): void {
      if (disposed || !art) return;
      // One reference compare a frame buys every shell in the air a correct
      // specular the moment the sky finishes prefiltering.
      art.setEnvMap((ctx.services.env as EnvView | undefined)?.envMap ?? null);
      const ramp = art.mats.rainbow.map;
      if (ramp) ramp.offset.x = -ctx.elapsed * 0.22;

      updateBoxes(ctx.elapsed);
      updateCoins(ctx.elapsed);
      updateProjectiles();
      updateRacerVisuals(dt);
      updateFlash(dt);
    },

    dispose(): void {
      disposed = true;
      offRestart();
      offStart();
      offRespawn();

      for (const p of projectiles) if (p.active) freeProj(p);
      projectiles.length = 0;

      for (const [id, slot] of slots) {
        const racer = racerById(id);
        if (racer) {
          racer.item = null;
          racer.itemCount = 0;
          racer.rolling = false;
          if (racer.object) racer.object.scale.setScalar(1);
        }
        detachSplat(slot);
        releaseCarry(slot);
        slot.aura?.removeFromParent();
        slot.ghostNode?.removeFromParent();
        if (slot.bulletNode) slot.bulletNode.removeFromParent();
      }
      slots.clear();

      for (const m of ownedMaterials) m.dispose();
      ownedMaterials.length = 0;
      for (const list of nodePool.values()) {
        for (const node of list) node.removeFromParent();
        list.length = 0;
      }
      nodePool.clear();

      if (flashMesh) {
        flashMesh.removeFromParent();
        flashMesh = null;
      }
      for (const mesh of [boxMesh, boxGlowMesh, coinMesh, glintMesh, blobMesh, projBlobMesh]) {
        if (mesh) mesh.dispose();
      }
      boxMesh = boxGlowMesh = coinMesh = glintMesh = blobMesh = projBlobMesh = null;

      root.removeFromParent();
      root.clear();
      art?.dispose();
      art = null;

      if (ctx.services.items === service) delete ctx.services.items;
    },
  };
}
