/**
 * Interface-owned state: settings, menu routing, waypoints, photo-mode rig.
 *
 * This is deliberately separate from `useSfStore`. That store is the *game's*
 * state — health, ammo, objectives — and belongs to gameplay systems. This one
 * is the *player's* state: what they turned on in the options screen, which
 * panel is open, where they dropped a waypoint. Mixing them would mean the
 * settings screen re-renders whenever the player takes a bullet.
 *
 * Nothing here updates at frame rate. Photo-mode camera motion goes through
 * `photo.ts`'s mutable rig, not through this store.
 */
import { create } from "zustand";
import { detectQualityTier, PLAYER, type QualityTier } from "../config";
import type { CvdMode } from "./theme";

/* ------------------------------------------------------------------ *
 * Input actions
 * ------------------------------------------------------------------ */

/**
 * Every rebindable action. The strings are stable identifiers — they end up
 * in localStorage, so renaming one silently resets a player's bindings.
 */
export const ACTIONS = [
  { id: "forward", label: "Move Forward", group: "Movement", default: "KeyW" },
  { id: "back", label: "Move Back", group: "Movement", default: "KeyS" },
  { id: "left", label: "Strafe Left", group: "Movement", default: "KeyA" },
  { id: "right", label: "Strafe Right", group: "Movement", default: "KeyD" },
  { id: "jump", label: "Jump", group: "Movement", default: "Space" },
  { id: "sprint", label: "Sprint", group: "Movement", default: "ShiftLeft" },
  { id: "crouch", label: "Crouch / Slide", group: "Movement", default: "ControlLeft" },
  { id: "interact", label: "Interact / Hijack", group: "Movement", default: "KeyF" },

  { id: "grapple", label: "Grapple", group: "Traversal", default: "Mouse2" },
  { id: "grappleRetract", label: "Retract Tethers", group: "Traversal", default: "KeyQ" },
  { id: "wingsuit", label: "Wingsuit", group: "Traversal", default: "KeyC" },
  { id: "parachute", label: "Parachute", group: "Traversal", default: "KeyE" },
  { id: "boost", label: "Boost Thruster", group: "Traversal", default: "ShiftLeft" },

  { id: "fire", label: "Fire", group: "Combat", default: "Mouse0" },
  { id: "aim", label: "Aim Down Sights", group: "Combat", default: "Mouse1" },
  { id: "reload", label: "Reload", group: "Combat", default: "KeyR" },
  { id: "melee", label: "Melee", group: "Combat", default: "KeyV" },
  { id: "grenade", label: "Throw Grenade", group: "Combat", default: "KeyG" },
  { id: "swap", label: "Previous Weapon", group: "Combat", default: "KeyX" },
  { id: "wheel", label: "Weapon Wheel", group: "Combat", default: "KeyB" },

  { id: "map", label: "Map", group: "Interface", default: "KeyM" },
  { id: "pause", label: "Pause / Back", group: "Interface", default: "Escape" },
  { id: "photo", label: "Photo Mode", group: "Interface", default: "KeyP" },
  { id: "hud", label: "Toggle HUD", group: "Interface", default: "KeyH" },
  { id: "waypoint", label: "Clear Waypoint", group: "Interface", default: "KeyN" },
  { id: "debug", label: "Debug Overlay", group: "Interface", default: "F3" },
] as const;

export type ActionId = (typeof ACTIONS)[number]["id"];

export type Bindings = Record<string, string>;

function defaultBindings(): Bindings {
  const b: Bindings = {};
  for (const a of ACTIONS) b[a.id] = a.default;
  return b;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export type SubtitleSize = "s" | "m" | "l" | "xl";

export interface UiSettings {
  /* --- graphics --- */
  quality: QualityTier;
  /** Degrees. Applied to the camera by the player rig; the HUD only stores it. */
  fov: number;
  /** Master brightness multiplier passed to the post chain's exposure. */
  brightness: number;
  filmGrain: number;
  chromaticAberration: number;
  vignette: number;
  motionBlur: number;
  bloom: number;
  /** Cap the renderer's frame rate. 0 = uncapped. */
  fpsCap: number;

  /* --- controls --- */
  sensitivity: number;
  adsSensitivity: number;
  invertY: boolean;
  /** 0..1. Snap-to-target strength for gamepad/accessibility. */
  aimAssist: number;
  /** Hold vs toggle. */
  toggleAim: boolean;
  toggleCrouch: boolean;
  toggleSprint: boolean;

  /* --- audio --- */
  volMaster: number;
  volMusic: number;
  volSfx: number;
  volVoice: number;
  volUi: number;
  /** Compress the dynamic range for late-night play. */
  nightMode: boolean;

  /* --- interface --- */
  hudScale: number;
  hudOpacity: number;
  showCrosshair: boolean;
  showCompass: boolean;
  showMinimap: boolean;
  minimapRotates: boolean;
  showDamageNumbers: boolean;
  speedUnits: "kmh" | "mph";

  /* --- accessibility --- */
  colorblind: CvdMode;
  subtitles: boolean;
  subtitleSize: SubtitleSize;
  reduceMotion: boolean;
  /** 0..1 multiplier on camera + HUD shake. */
  screenShake: number;
  /** Ease the low-health red-out for photosensitivity. */
  reduceFlashing: boolean;
  highContrastHud: boolean;
}

export const DEFAULT_SETTINGS: UiSettings = {
  quality: detectQualityTier(),
  fov: PLAYER.fov,
  brightness: 1,
  filmGrain: 0.55,
  chromaticAberration: 0.6,
  vignette: 0.65,
  motionBlur: 1,
  bloom: 1,
  fpsCap: 0,

  sensitivity: 1,
  adsSensitivity: 0.75,
  invertY: false,
  aimAssist: 0.25,
  toggleAim: false,
  toggleCrouch: false,
  toggleSprint: false,

  volMaster: 0.85,
  volMusic: 0.6,
  volSfx: 0.9,
  volVoice: 1,
  volUi: 0.7,
  nightMode: false,

  hudScale: 1,
  hudOpacity: 1,
  showCrosshair: true,
  showCompass: true,
  showMinimap: true,
  minimapRotates: true,
  showDamageNumbers: true,
  speedUnits: "mph",

  colorblind: "none",
  subtitles: true,
  subtitleSize: "m",
  reduceMotion: false,
  screenShake: 1,
  reduceFlashing: false,
  highContrastHud: false,
};

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

const STORAGE_KEY = "sf.freefall.ui.v1";

interface Persisted {
  settings: Partial<UiSettings>;
  bindings: Bindings;
}

function load(): Persisted {
  if (typeof localStorage === "undefined") return { settings: {}, bindings: defaultBindings() };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { settings: {}, bindings: defaultBindings() };
    const parsed = JSON.parse(raw) as Persisted;
    return {
      settings: parsed.settings ?? {},
      // Merge over the defaults so a new action added in a patch is not
      // permanently unbound for existing players.
      bindings: { ...defaultBindings(), ...(parsed.bindings ?? {}) },
    };
  } catch {
    return { settings: {}, bindings: defaultBindings() };
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(settings: UiSettings, bindings: Bindings) {
  if (typeof localStorage === "undefined") return;
  // Dragging a slider fires dozens of changes a second; coalesce them.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, bindings }));
    } catch {
      /* quota or private mode — settings are a nicety, not a requirement */
    }
  }, 300);
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

/** Which full-screen or modal surface currently owns the player's input. */
export type UiRoute =
  | "none"
  | "main"
  | "pause"
  | "settings"
  | "controls"
  | "credits"
  | "map"
  | "photo"
  | "spawn";

export type SettingsTab = "graphics" | "controls" | "audio" | "interface" | "accessibility";

export interface Waypoint {
  x: number;
  z: number;
  label: string;
}

export interface SfUiState {
  settings: UiSettings;
  bindings: Bindings;
  route: UiRoute;
  settingsTab: SettingsTab;
  /** Route to return to when the current one closes ("pause" → "settings" → back). */
  routeStack: UiRoute[];

  /** Player-placed map marker. */
  waypoint: Waypoint | null;
  /** Objective id the tracker is pinned to; null = nearest incomplete. */
  trackedObjective: string | null;

  /** Full-screen map camera. Persisted across opens so panning is not lost. */
  mapCenter: { x: number; z: number };
  mapZoom: number;

  /** Weapon wheel open state — held, so it lives here rather than in a ref. */
  wheelOpen: boolean;

  /** Subtitle line currently on screen, "" for none. */
  subtitle: string;

  setSetting: <K extends keyof UiSettings>(key: K, value: UiSettings[K]) => void;
  patchSettings: (patch: Partial<UiSettings>) => void;
  resetSettings: () => void;
  bind: (action: string, code: string) => void;
  resetBindings: () => void;

  go: (route: UiRoute) => void;
  push: (route: UiRoute) => void;
  back: () => void;
  setSettingsTab: (tab: SettingsTab) => void;

  setWaypoint: (w: Waypoint | null) => void;
  trackObjective: (id: string | null) => void;
  setMapView: (x: number, z: number, zoom: number) => void;
  setWheel: (open: boolean) => void;
  say: (line: string) => void;
}

const loaded = load();

export const useUiStore = create<SfUiState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS, ...loaded.settings },
  bindings: loaded.bindings,
  route: "none",
  settingsTab: "graphics",
  routeStack: [],

  waypoint: null,
  trackedObjective: null,

  mapCenter: { x: 0, z: 0 },
  mapZoom: 0.06,

  wheelOpen: false,
  subtitle: "",

  setSetting: (key, value) =>
    set((s) => {
      const settings = { ...s.settings, [key]: value };
      scheduleSave(settings, s.bindings);
      return { settings };
    }),

  patchSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      scheduleSave(settings, s.bindings);
      return { settings };
    }),

  resetSettings: () =>
    set((s) => {
      const settings = { ...DEFAULT_SETTINGS };
      scheduleSave(settings, s.bindings);
      return { settings };
    }),

  bind: (action, code) =>
    set((s) => {
      // A key can only do one thing. Steal it from whoever had it, and leave
      // that action unbound rather than silently double-bound.
      const bindings: Bindings = { ...s.bindings };
      for (const k of Object.keys(bindings)) {
        if (k !== action && bindings[k] === code) bindings[k] = "";
      }
      bindings[action] = code;
      scheduleSave(s.settings, bindings);
      return { bindings };
    }),

  resetBindings: () =>
    set((s) => {
      const bindings = defaultBindings();
      scheduleSave(s.settings, bindings);
      return { bindings };
    }),

  go: (route) => set({ route, routeStack: [] }),
  push: (route) => set((s) => ({ route, routeStack: [...s.routeStack, s.route] })),
  back: () =>
    set((s) => {
      const stack = s.routeStack.slice();
      const prev = stack.pop() ?? "none";
      return { route: prev, routeStack: stack };
    }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),

  setWaypoint: (waypoint) => set({ waypoint }),
  trackObjective: (trackedObjective) => set({ trackedObjective }),
  setMapView: (x, z, zoom) => set({ mapCenter: { x, z }, mapZoom: zoom }),
  setWheel: (wheelOpen) => set({ wheelOpen }),
  say: (subtitle) => set({ subtitle }),
}));

/** Non-reactive read, for use inside frame loops and event handlers. */
export const ui = () => useUiStore.getState();

/**
 * Resolve a key/mouse code to the action it triggers, or null.
 * The player input system should call this rather than hard-coding "KeyW";
 * it is the whole point of the rebinding screen.
 */
export function actionFor(code: string): string | null {
  const b = ui().bindings;
  for (const k of Object.keys(b)) if (b[k] === code) return k;
  return null;
}

/** The code currently bound to an action, or "" if unbound. */
export function keyFor(action: string): string {
  return ui().bindings[action] ?? "";
}
