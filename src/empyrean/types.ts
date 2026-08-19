/**
 * The contract every system in The Empyrean is built against.
 *
 * There are a dozen modules here — streets, buildings, props, crowds,
 * traffic, interiors, activities, lighting, audio — and they were written in
 * parallel. That only works if they agree on three things and nothing else:
 * what a system *is*, what it gets told each frame, and which of the two
 * scene graphs it belongs to. This file is those three things and no
 * implementation at all, so importing it costs nothing and drags nothing in.
 *
 * The rule that keeps it honest: **a system may import `types.ts`,
 * `config.ts`, `cityplan.ts` and `three`, and nothing else from this
 * directory.** Anything a system needs from another system is either in the
 * plan or is passed to it in the frame context. Cross-imports between systems
 * are how a set of parallel modules quietly becomes one module with twelve
 * files in it.
 */
import type * as THREE from "three";

/* -------------------------------------------------------------------------
 * The frame
 * ---------------------------------------------------------------------- */

/** What the player is doing, as far as anything else needs to know. */
export interface PlayerView {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Facing, radians. */
  yaw: number;
  grounded: boolean;
  /** 0..1 jetpack throttle. */
  burn: number;
  /** Metres above the deck under them. */
  altitude: number;
}

export type QualityTier = "low" | "high";

/**
 * Everything a system is handed on `update`.
 *
 * Deliberately a single object that is *mutated in place* by the engine and
 * never reallocated: this is passed to every system every frame, and a fresh
 * object sixty times a second across a dozen systems is a garbage collector
 * pause you can see.
 */
export interface FrameContext {
  /** Seconds since the world booted. Monotonic. */
  time: number;
  /** Seconds since the last frame, already clamped. Never above 0.05. */
  dt: number;
  camera: THREE.PerspectiveCamera;
  player: PlayerView;
  quality: QualityTier;
  /**
   * Where the world is in its day, 0..1.
   *
   * 0 is midnight, 0.25 dawn, 0.5 noon, 0.75 the sunset the whole place is
   * painted at. It starts at 0.75 and moves slowly, because the reference is
   * a sunset and a world that leaves its best light after ninety seconds has
   * thrown away the thing it was made for.
   */
  dayPhase: number;
  /** Unit vector toward the sun. Recomputed from `dayPhase` each frame. */
  sunDir: THREE.Vector3;
  /** 0 at night, 1 in full day. What lamps and windows switch on against. */
  daylight: number;
  /**
   * Squared distance from the camera to the island's axis, cached.
   * Systems that cull by "am I even near the city" read this instead of
   * recomputing a hypot per object.
   */
  camRadiusSq: number;
}

/* -------------------------------------------------------------------------
 * Systems
 * ---------------------------------------------------------------------- */

/**
 * One buildable, updatable, disposable piece of the world.
 *
 * `group` is added to the scene by the engine and never re-parented. `update`
 * is called every frame in registration order and must not allocate. `dispose`
 * must release every geometry, material and render target the system made —
 * browsers cap live WebGL contexts and a world that leaks one breaks the
 * *next* world the visitor opens.
 */
export interface System {
  readonly name: string;
  group: THREE.Object3D;
  /**
   * True if this belongs in the island's silhouette and should therefore
   * appear in the lake.
   *
   * The reflection is a real `clone(true)` of one group mirrored through the
   * water plane, so everything in it costs a second draw. That is worth it for
   * the rock and the buildings, which *are* the reflection, and not for eight
   * hundred pedestrians and a thousand bollards, which at a kilometre and a
   * half are four pixels of noise.
   *
   * A reflected system has one extra obligation: **every gradient it draws
   * must run along an attribute on the object's own height, never along world
   * Y.** Mirror a world-Y gradient and the towers come out the right way up
   * inside an upside-down reflection — subtly, unplaceably wrong.
   */
  readonly reflected?: boolean;
  update?(ctx: FrameContext): void;
  dispose(): void;
}

/** What a system is handed when it is built. */
export interface BuildContext {
  quality: QualityTier;
  /** Seeded, so a system can branch without breaking determinism elsewhere. */
  seedSalt: string;
}

/* -------------------------------------------------------------------------
 * Interaction
 * ---------------------------------------------------------------------- */

/**
 * Something in the world you can walk up to and press a key on.
 *
 * Registered by whatever system owns the thing; the engine finds the nearest
 * one each frame and the HUD draws a prompt for it. Keeping this in one shape
 * is what lets a market stall, a race start line, a tram door and a telescope
 * all use the same prompt and the same key without any of them knowing about
 * the others.
 */
export interface Interactable {
  id: string;
  /** World position of the prompt. */
  x: number;
  y: number;
  z: number;
  /** How close you have to be, metres. */
  radius: number;
  /** Shown on the prompt, e.g. "Ride the tram". */
  label: string;
  /** Secondary line, optional. */
  detail?: string;
  /** Called when the player presses the interact key inside `radius`. */
  activate(): void;
  /** When false the prompt is hidden — a race you are already running. */
  enabled?: () => boolean;
}

/** A system that offers things to interact with. */
export interface InteractiveSystem extends System {
  interactables(): Interactable[];
}

/* -------------------------------------------------------------------------
 * The HUD's view of the world
 * ---------------------------------------------------------------------- */

/** One line of the notification stack — "Parcel delivered. +12 coins." */
export interface Toast {
  id: number;
  text: string;
  /** Seconds remaining. The engine counts it down. */
  ttl: number;
  tone: "info" | "good" | "warn";
}

/** Everything the React layer draws, pushed at ~10 Hz rather than per frame. */
export interface EmpyreanState {
  /** Metres above the snow. */
  altitude: number;
  /** Horizontal speed, m/s. */
  speed: number;
  /** Clear air directly below, m. Infinity over the void. */
  drop: number;
  thrusting: boolean;
  /** Catalog label of whoever is flying. */
  who: string;
  /** District name, or the landmark you are standing at. */
  place: string;
  /** District accent colour, for the HUD chip. */
  placeAccent: string;
  /** Local time of day as "18:42". */
  clock: string;
  /** The nearest thing you could press a key on, if any. */
  prompt: { label: string; detail?: string } | null;
  /** Live activity readout: race timer, delivery target, etc. */
  activity: {
    title: string;
    lines: string[];
    /** 0..1, drives a bar. Omitted when there is nothing to fill. */
    progress?: number;
  } | null;
  toasts: Toast[];
  /** Vibey Coins earned this session. */
  earned: number;
  /** What has been found, for the collectibles line. */
  found: { got: number; total: number };
}
