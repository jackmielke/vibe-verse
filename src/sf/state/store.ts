/**
 * The game store for San Francisco: FREE FALL.
 *
 * Deliberately split in two:
 *   - `useSfStore` (zustand) holds *UI-facing* state — anything React should
 *     re-render for: health, ammo counts, heat level, menus, objectives.
 *   - `frame` holds *per-frame* state — position, velocity, camera basis,
 *     tether endpoints. Nothing here goes through React; it is mutated in
 *     place by the simulation and read directly by renderers. Putting a
 *     60 Hz position vector into a React store is how you turn a AAA frame
 *     budget into a slideshow.
 */
import * as THREE from "three";
import { create } from "zustand";
import { PLAYER, QUALITY, WORLD_SEED, detectQualityTier, type QualityTier } from "../config";
import { makeRng, type Rng } from "../math/rng";

/* ------------------------------------------------------------------ *
 * Per-frame simulation state (no React)
 * ------------------------------------------------------------------ */

export type MovementState =
  | "grounded"
  | "airborne"
  | "wingsuit"
  | "parachute"
  | "grappling"
  | "swimming"
  | "vehicle"
  | "dead";

export interface TetherState {
  active: boolean;
  /** World-space anchor the hook is attached to. */
  anchor: THREE.Vector3;
  /** Object the anchor is attached to, if it moves. */
  attachedTo: number | null;
  /** Rest length of the tether. */
  length: number;
  /** True while the hook is still flying toward the anchor. */
  flying: boolean;
  flyProgress: number;
  /** True while actively reeling in. */
  reeling: boolean;
}

export interface FrameState {
  /** Seconds since the level loaded. */
  time: number;
  /** Last frame's delta, clamped. */
  dt: number;
  /** Player capsule centre. */
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Camera yaw/pitch in radians. */
  yaw: number;
  pitch: number;
  /** Camera roll, driven by wingsuit banking + damage. */
  roll: number;
  /** Unit forward vector derived from yaw/pitch. */
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  movement: MovementState;
  grounded: boolean;
  groundNormal: THREE.Vector3;
  /** Height above the ground directly below, metres. */
  altitudeAGL: number;
  /** Current speed magnitude, m/s. */
  speed: number;
  /** Camera field of view actually in use this frame. */
  fov: number;
  /** Weapon sway/recoil offsets applied to the viewmodel. */
  recoil: THREE.Vector2;
  viewKick: THREE.Vector2;
  tethers: TetherState[];
  /** Set by the vehicle system when the player is driving. */
  vehicleId: number | null;
  /** Time-of-day in hours, 0..24. */
  timeOfDay: number;
  /** 0..1 fog/marine-layer intensity — SF's signature weather. */
  fogDensity: number;
  windDirection: THREE.Vector2;
  windSpeed: number;
  /** Set true by the pause menu / photo mode to freeze simulation. */
  paused: boolean;
}

function makeTether(): TetherState {
  return {
    active: false,
    anchor: new THREE.Vector3(),
    attachedTo: null,
    length: 0,
    flying: false,
    flyProgress: 0,
    reeling: false,
  };
}

/** The single mutable frame state. Import it; do not clone it. */
export const frame: FrameState = {
  time: 0,
  dt: 1 / 60,
  position: new THREE.Vector3(0, 80, 0),
  velocity: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  roll: 0,
  forward: new THREE.Vector3(0, 0, -1),
  right: new THREE.Vector3(1, 0, 0),
  up: new THREE.Vector3(0, 1, 0),
  movement: "airborne",
  grounded: false,
  groundNormal: new THREE.Vector3(0, 1, 0),
  altitudeAGL: 80,
  speed: 0,
  fov: PLAYER.fov,
  recoil: new THREE.Vector2(),
  viewKick: new THREE.Vector2(),
  tethers: [makeTether(), makeTether()],
  vehicleId: null,
  timeOfDay: 17.4,
  fogDensity: 0.35,
  windDirection: new THREE.Vector2(0.82, 0.57),
  windSpeed: 7.5,
  paused: false,
};

/** Reset frame state to a spawn. Called by the level loader. */
export function resetFrame(x: number, y: number, z: number, heading: number): void {
  frame.position.set(x, y, z);
  frame.velocity.set(0, 0, 0);
  frame.yaw = heading;
  frame.pitch = 0;
  frame.roll = 0;
  frame.movement = "airborne";
  frame.grounded = false;
  frame.speed = 0;
  frame.fov = PLAYER.fov;
  frame.recoil.set(0, 0);
  frame.viewKick.set(0, 0);
  frame.vehicleId = null;
  for (const t of frame.tethers) {
    t.active = false;
    t.flying = false;
    t.reeling = false;
    t.attachedTo = null;
  }
}

/** The world's master RNG. Every generator forks from this. */
export const worldRng: Rng = makeRng(WORLD_SEED);

/* ------------------------------------------------------------------ *
 * UI-facing store (React)
 * ------------------------------------------------------------------ */

export type GamePhase = "loading" | "menu" | "playing" | "paused" | "dead" | "photo";

export interface WeaponAmmo {
  magazine: number;
  reserve: number;
}

export interface Objective {
  id: string;
  title: string;
  detail: string;
  /** World position for the compass marker. */
  x: number;
  z: number;
  y: number;
  complete: boolean;
  /** 0..1 for progressive objectives (e.g. "destroy 6 generators"). */
  progress: number;
}

export interface NotificationEntry {
  id: number;
  text: string;
  kind: "info" | "chaos" | "damage" | "objective" | "unlock";
  /** Points awarded, if any. */
  value?: number;
  createdAt: number;
}

export interface SfState {
  phase: GamePhase;
  loadProgress: number;
  loadLabel: string;

  quality: QualityTier;
  settings: (typeof QUALITY)[QualityTier];

  health: number;
  maxHealth: number;
  /** 0..1 — red vignette / directional damage indicator. */
  lastDamageDirection: number | null;

  /** Currently equipped weapon key, from the weapon registry. */
  weapon: string;
  /** Ammo per weapon key. */
  ammo: Record<string, WeaponAmmo>;
  reloading: boolean;
  aiming: boolean;

  chaos: number;
  heat: number;
  /** Running kill/destroy feed. */
  notifications: NotificationEntry[];

  objectives: Objective[];
  /** Landmarks the player has physically visited. */
  discovered: string[];

  /** HUD toggles. */
  showHud: boolean;
  showMap: boolean;
  showDebug: boolean;
  /** Frames-per-second, sampled once a second for the debug overlay. */
  fps: number;
  drawCalls: number;
  triangles: number;

  /* ---- actions ---- */
  setPhase: (p: GamePhase) => void;
  setLoad: (progress: number, label?: string) => void;
  setQuality: (q: QualityTier) => void;
  damage: (amount: number, fromDirection?: number) => void;
  heal: (amount: number) => void;
  respawn: () => void;
  setWeapon: (key: string) => void;
  setAmmo: (key: string, ammo: Partial<WeaponAmmo>) => void;
  setReloading: (v: boolean) => void;
  setAiming: (v: boolean) => void;
  addChaos: (points: number, label?: string) => void;
  setHeat: (level: number) => void;
  notify: (text: string, kind?: NotificationEntry["kind"], value?: number) => void;
  pruneNotifications: (now: number) => void;
  addObjective: (o: Objective) => void;
  updateObjective: (id: string, patch: Partial<Objective>) => void;
  discover: (key: string) => void;
  toggleHud: () => void;
  toggleMap: () => void;
  toggleDebug: () => void;
  setStats: (fps: number, drawCalls: number, triangles: number) => void;
}

let notifyId = 0;

const initialTier = detectQualityTier();

export const useSfStore = create<SfState>((set, get) => ({
  phase: "loading",
  loadProgress: 0,
  loadLabel: "Waking up San Francisco",

  quality: initialTier,
  settings: QUALITY[initialTier],

  health: PLAYER.maxHealth,
  maxHealth: PLAYER.maxHealth,
  lastDamageDirection: null,

  weapon: "sidearm",
  ammo: {},
  reloading: false,
  aiming: false,

  chaos: 0,
  heat: 0,
  notifications: [],

  objectives: [],
  discovered: [],

  showHud: true,
  showMap: false,
  showDebug: false,
  fps: 0,
  drawCalls: 0,
  triangles: 0,

  setPhase: (phase) => set({ phase }),
  setLoad: (loadProgress, loadLabel) =>
    set((s) => ({ loadProgress, loadLabel: loadLabel ?? s.loadLabel })),

  setQuality: (quality) => set({ quality, settings: QUALITY[quality] }),

  damage: (amount, fromDirection) =>
    set((s) => {
      const health = Math.max(0, s.health - amount);
      return {
        health,
        lastDamageDirection: fromDirection ?? s.lastDamageDirection,
        phase: health <= 0 ? "dead" : s.phase,
      };
    }),

  heal: (amount) =>
    set((s) => ({ health: Math.min(s.maxHealth, s.health + amount) })),

  respawn: () =>
    set((s) => ({ health: s.maxHealth, phase: "playing", lastDamageDirection: null })),

  setWeapon: (weapon) => set({ weapon, reloading: false }),

  setAmmo: (key, ammo) =>
    set((s) => ({
      ammo: {
        ...s.ammo,
        [key]: { ...(s.ammo[key] ?? { magazine: 0, reserve: 0 }), ...ammo },
      },
    })),

  setReloading: (reloading) => set({ reloading }),
  setAiming: (aiming) => set({ aiming }),

  addChaos: (points, label) => {
    const chaos = get().chaos + points;
    set({ chaos });
    if (label) get().notify(label, "chaos", points);
  },

  setHeat: (heat) => set({ heat }),

  notify: (text, kind = "info", value) =>
    set((s) => ({
      notifications: [
        ...s.notifications.slice(-7),
        { id: ++notifyId, text, kind, value, createdAt: frame.time },
      ],
    })),

  pruneNotifications: (now) =>
    set((s) => {
      const kept = s.notifications.filter((n) => now - n.createdAt < 4.5);
      return kept.length === s.notifications.length ? {} : { notifications: kept };
    }),

  addObjective: (o) => set((s) => ({ objectives: [...s.objectives, o] })),

  updateObjective: (id, patch) =>
    set((s) => ({
      objectives: s.objectives.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    })),

  discover: (key) =>
    set((s) => (s.discovered.includes(key) ? {} : { discovered: [...s.discovered, key] })),

  toggleHud: () => set((s) => ({ showHud: !s.showHud })),
  toggleMap: () => set((s) => ({ showMap: !s.showMap })),
  toggleDebug: () => set((s) => ({ showDebug: !s.showDebug })),

  setStats: (fps, drawCalls, triangles) => set({ fps, drawCalls, triangles }),
}));

/** Non-reactive read, for use inside the frame loop. */
export const sf = () => useSfStore.getState();
