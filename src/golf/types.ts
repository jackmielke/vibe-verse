/**
 * Vibe Golf — shared contracts.
 *
 * A Super-Stickman-Golf-shaped physics golf game: 2D side-on play, rendered
 * as elevated 2.5D. Every subsystem is a `System` receiving the shared
 * `GolfCtx`; systems never import each other, they talk through
 * `ctx.services`. Same pattern as the San Palmas engine — it kept fifteen
 * modules independently authorable.
 *
 * Convention: +X right, +Y **up**, metres. (Note this differs from a canvas's
 * y-down convention — the renderer flips at the camera, not in the physics.)
 */
import type * as THREE from "three";

// ---------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });

/** Surface materials. Each drives restitution, friction and impact FX. */
export type SurfaceMaterial =
  | "fairway"
  | "green"
  | "rough"
  | "sand"
  | "stone"
  | "metal"
  | "wood"
  | "ice"
  | "rubber"
  | "water"
  | "lava"
  | "outOfBounds";

export interface MaterialProps {
  /** 0 = dead stop, 1 = perfectly elastic. */
  restitution: number;
  /** Tangential friction applied on contact, 0..1. */
  friction: number;
  /**
   * Rolling-resistance coefficient. Applied as a *constant* deceleration
   * (`rollDrag × g`) opposing motion — not exponential damping. That's what
   * lets a ball come to a genuine stop on a gentle slope while still running
   * away down a steep one; exponential damping only ever approaches zero and
   * leaves the ball creeping forever.
   */
  rollDrag: number;
  /** Killing surfaces end the shot and reset the ball (water, lava, OB). */
  lethal?: boolean;
}

export const MATERIALS: Record<SurfaceMaterial, MaterialProps> = {
  fairway: { restitution: 0.34, friction: 0.36, rollDrag: 0.34 },
  green: { restitution: 0.28, friction: 0.30, rollDrag: 0.20 },
  rough: { restitution: 0.20, friction: 0.72, rollDrag: 0.78 },
  sand: { restitution: 0.08, friction: 0.88, rollDrag: 1.70 },
  stone: { restitution: 0.52, friction: 0.26, rollDrag: 0.24 },
  metal: { restitution: 0.62, friction: 0.16, rollDrag: 0.15 },
  wood: { restitution: 0.44, friction: 0.34, rollDrag: 0.30 },
  ice: { restitution: 0.40, friction: 0.02, rollDrag: 0.02 },
  rubber: { restitution: 0.92, friction: 0.40, rollDrag: 0.30 },
  water: { restitution: 0.0, friction: 1.0, rollDrag: 3.0, lethal: true },
  lava: { restitution: 0.0, friction: 1.0, rollDrag: 3.0, lethal: true },
  outOfBounds: { restitution: 0.0, friction: 1.0, rollDrag: 3.0, lethal: true },
};

// ---------------------------------------------------------------------------
// Course description
// ---------------------------------------------------------------------------

/**
 * A collidable polyline. Points are in world metres; the surface is treated
 * as solid on the side its winding puts "outside", and segments are stored
 * as a strip so terrain reads naturally as a ground profile.
 */
export interface Surface {
  points: Vec2[];
  material: SurfaceMaterial;
  /** Closed shapes (islands, blocks) collide on all sides. */
  closed?: boolean;
  /** Optional id so movers/hazards can address this surface at runtime. */
  id?: string;
}

export type PropKind =
  | "portal"
  | "bumper"
  | "fan"
  | "conveyor"
  | "mover"
  | "windZone"
  | "boost"
  | "breakable"
  | "cannon";

export interface PropSpec {
  kind: PropKind;
  id?: string;
  at: Vec2;
  /** Half-extents for box-ish props. */
  size?: Vec2;
  angle?: number;
  /** Portal partner id — momentum is preserved through the pair. */
  link?: string;
  /** Generic tuning knob per kind (fan strength, conveyor speed, …). */
  power?: number;
  /** Path for movers: waypoints in world space, looped. */
  path?: Vec2[];
  speed?: number;
  material?: SurfaceMaterial;
}

export interface Hole {
  id: string;
  name: string;
  par: number;
  tee: Vec2;
  cup: Vec2;
  surfaces: Surface[];
  props: PropSpec[];
  /** Playable bounds — outside this is out of bounds. */
  bounds: { min: Vec2; max: Vec2 };
  /** Which visual theme the renderer should dress this hole in. */
  theme: CourseTheme;
  /** Par-relative hint shown on the loading card. */
  hint?: string;
}

export type CourseTheme =
  | "seaside"
  | "jungle"
  | "canyon"
  | "neon"
  | "sky"
  | "volcano"
  | "glacier";

export interface Course {
  id: string;
  name: string;
  theme: CourseTheme;
  blurb: string;
  holes: Hole[];
  /** Course is locked until this many total stars are earned. */
  unlockAt?: number;
}

// ---------------------------------------------------------------------------
// Ball + power-ups
// ---------------------------------------------------------------------------

export type BallType =
  | "standard"
  | "sticky"
  | "ice"
  | "nitro"
  | "super"
  | "multi"
  | "ghost"
  | "heavy";

export interface BallTypeProps {
  name: string;
  blurb: string;
  /** Multiplies the material restitution on every bounce. */
  bounce: number;
  /** Multiplies launch speed. */
  power: number;
  /** Air drag scale. */
  drag: number;
  /** Sticks to the first surface it touches. */
  sticky?: boolean;
  /** Passes through breakables/hazards. */
  ghost?: boolean;
  /** Splits into N balls on launch; the best resting ball is kept. */
  split?: number;
  tint: number;
}

export interface BallState {
  pos: Vec2;
  vel: Vec2;
  /** Angular velocity, rad/s — drives magnus curve and roll rendering. */
  spin: number;
  radius: number;
  type: BallType;
  /** True once the ball has settled and the next shot may be taken. */
  resting: boolean;
  /** Frames the ball has been slow enough to be considered stopped. */
  restTimer: number;
  /** Set when the ball is stuck to a surface by the sticky ball. */
  stuck: boolean;
  active: boolean;
  /** Trail sample ring for the renderer. */
  trail: Vec2[];
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface RayHit2 {
  point: Vec2;
  normal: Vec2;
  /** 0..1 along the swept motion. */
  t: number;
  material: SurfaceMaterial;
  surface?: Surface;
}

export interface PhysicsService {
  /** Advance every active ball by `dt`, resolving collisions with CCD. */
  step(dt: number): void;
  /** Swept-circle query against the current hole. */
  sweep(from: Vec2, to: Vec2, radius: number): RayHit2 | null;
  /** Closest surface point to `p` within `maxDist`, or null. */
  probe(p: Vec2, maxDist: number): RayHit2 | null;
  /** Rebuild the broadphase from a hole. Called on hole load. */
  setHole(hole: Hole): void;
  /** Gravity, m/s². Negative Y. */
  gravity: Vec2;
  /** Global wind, m/s. Hazards may add to this locally. */
  wind: Vec2;
  balls: BallState[];
  /** Push an impulse into any ball overlapping the point. */
  impulse(at: Vec2, radius: number, force: Vec2): void;
}

export interface CourseService {
  courses: Course[];
  current: Hole | null;
  courseIndex: number;
  holeIndex: number;
  load(courseId: string, holeIndex: number): void;
  next(): boolean;
}

export interface VfxService2 {
  burst(at: Vec2, count: number, opts?: { color?: number; speed?: number; spread?: number; life?: number }): void;
  splash(at: Vec2, material: SurfaceMaterial): void;
  ring(at: Vec2, radius: number, color?: number): void;
  trailPuff(at: Vec2, color?: number): void;
  screenShake(amount: number): void;
}

export interface AudioService2 {
  play(name: string, opts?: { volume?: number; rate?: number; pan?: number }): void;
  music(on: boolean): void;
}

export interface ShotResult {
  strokes: number;
  holed: boolean;
}

/** The rules layer: strokes, hole progression, scoring. */
export interface RulesService {
  strokes: number;
  totalStrokes: number;
  /** Called by the aim system when the player commits a shot. */
  takeShot(dir: Vec2, power: number): void;
  /** True when the player may aim (ball resting, hole not complete). */
  canShoot: boolean;
  holeComplete: boolean;
  ballType: BallType;
  setBallType(t: BallType): void;
  /** Inventory of remaining power-up balls this round. */
  inventory: Partial<Record<BallType, number>>;
  resetBall(): void;
}

export interface GolfServices {
  physics?: PhysicsService;
  course?: CourseService;
  vfx?: VfxService2;
  audio?: AudioService2;
  rules?: RulesService;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface GolfInput {
  /** Pointer position in world metres, or null when not pointing. */
  pointer: Vec2 | null;
  /** True while a drag is in progress. */
  dragging: boolean;
  /** Where the drag started, world metres. */
  dragStart: Vec2 | null;
  /** Edge-triggered this frame. */
  pressed: Set<string>;
  /** Held keys. */
  held: Set<string>;
  /** Pinch/wheel zoom delta accumulated this frame. */
  zoomDelta: number;
  /** True on the frame the pointer was released. */
  released: boolean;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type GolfQuality = "low" | "medium" | "high";

export interface GolfCtx {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
  services: GolfServices;
  input: GolfInput;
  elapsed: number;
  quality: GolfQuality;
  rng: () => number;
  emit(event: string, payload?: unknown): void;
  on(event: string, fn: (payload: unknown) => void): () => void;
}

export interface System {
  name: string;
  update?(dt: number, ctx: GolfCtx): void;
  lateUpdate?(dt: number, ctx: GolfCtx): void;
  resize?(w: number, h: number): void;
  dispose?(): void;
}

export type SystemFactory = (ctx: GolfCtx) => System | Promise<System>;

/** Mulberry32 — deterministic, seedable. Course generation depends on it. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BALL_TYPES: Record<BallType, BallTypeProps> = {
  standard: { name: "Standard", blurb: "Balanced. Does what you tell it.", bounce: 1, power: 1, drag: 1, tint: 0xffffff },
  sticky: { name: "Sticky", blurb: "Sticks to the first thing it touches.", bounce: 0, power: 0.96, drag: 1, sticky: true, tint: 0x9ae66e },
  ice: { name: "Ice", blurb: "Slides forever. Barely any friction.", bounce: 0.7, power: 1, drag: 0.9, tint: 0x7dd3fc },
  nitro: { name: "Nitro", blurb: "Big power, hard to control.", bounce: 1.1, power: 1.42, drag: 1.1, tint: 0xfb7185 },
  super: { name: "Super", blurb: "Bounces like it's made of rubber.", bounce: 1.75, power: 1.05, drag: 1, tint: 0xfbbf24 },
  multi: { name: "Multi", blurb: "Splits into three. Best one counts.", bounce: 1, power: 1, drag: 1, split: 3, tint: 0xc084fc },
  ghost: { name: "Ghost", blurb: "Passes through breakables and hazards.", bounce: 0.8, power: 1, drag: 1, ghost: true, tint: 0xa5b4fc },
  heavy: { name: "Heavy", blurb: "Ignores wind. Drops like a stone.", bounce: 0.45, power: 0.92, drag: 1.6, tint: 0x94a3b8 },
};
