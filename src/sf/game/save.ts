/**
 * game/save.ts — versioned, migration-safe persistence.
 *
 * Rules this module lives by, in order of importance:
 *
 *   1. It never throws. Storage can be absent (SSR, the screenshot harness),
 *      disabled (private browsing on some engines), full (quota), or corrupt
 *      (a half-written string from a tab that was killed mid-write). Every one
 *      of those is normal, and none of them may take the game down. Failures
 *      degrade to an in-memory store and a `lastError` string.
 *   2. It never trusts what it reads. A save file is untrusted input: every
 *      field is checked, unknown ids are dropped, numbers are finite-checked.
 *      A save written by a newer build must not break an older one.
 *   3. Migrations are explicit and chained. `MIGRATIONS[n]` turns a version-n
 *      blob into a version-(n+1) blob. Adding a field means bumping the
 *      version and writing the one-line migration, not "it'll be undefined,
 *      that's fine" — because it is fine right up until it is not.
 *
 * Autosave is debounced and only writes when something actually changed, and
 * it serialises on a director tick rather than a frame, so `JSON.stringify`
 * never lands in a 16 ms budget.
 *
 * Public API
 * ----------
 *   saveGame(reason?) / loadGame() / clearSave() / hasSave()
 *   saveSystem.tick(dt) / markDirty() / lastError / available
 */
import { WORLD_SEED } from "../config";
import { frame, useSfStore } from "../state/store";
import { discoveries } from "./discoveries";
import { gameHeat } from "./heat";
import { missions } from "./missions";
import { progression } from "./progression";
import type { QualityTier } from "../config";

const KEY = "sf-freefall-save";
export const SAVE_VERSION = 2;

/* ================================================================== *
 * Shape
 * ================================================================== */

export interface SaveSettings {
  quality: QualityTier | null;
  showHud: boolean;
  showDebug: boolean;
  /** Time-of-day the player left at, so the city is where they remember. */
  timeOfDay: number;
}

export interface SaveData {
  version: number;
  savedAt: number;
  /** World seed the save belongs to. A different seed is a different city. */
  seed: string;
  /** Career chaos total. */
  chaos: number;
  discoveries: string[];
  missions: string[];
  progression: ReturnType<typeof progression.serialize>;
  heat: {
    escapes: number;
    busted: number;
    longestPursuit: number;
    peakLevelEver: number;
    timeAtLevel: number[];
  };
  settings: SaveSettings;
}

/* ================================================================== *
 * Storage wrapper — the only place `localStorage` is touched
 * ================================================================== */

class SafeStorage {
  available = false;
  lastError: string | null = null;
  /** Fallback used when real storage is unavailable, so a session still works. */
  private memory: Record<string, string> = Object.create(null);

  constructor() {
    this.available = this.probe();
  }

  private probe(): boolean {
    try {
      if (typeof localStorage === "undefined") return false;
      const probeKey = "__sf_probe__";
      localStorage.setItem(probeKey, "1");
      localStorage.removeItem(probeKey);
      return true;
    } catch (err) {
      this.lastError = String(err);
      return false;
    }
  }

  get(key: string): string | null {
    try {
      if (this.available) return localStorage.getItem(key);
    } catch (err) {
      this.lastError = String(err);
      this.available = false;
    }
    return this.memory[key] ?? null;
  }

  set(key: string, value: string): boolean {
    this.memory[key] = value;
    try {
      if (this.available) {
        localStorage.setItem(key, value);
        return true;
      }
    } catch (err) {
      // Quota is the common one. Keep the in-memory copy so the session is not
      // lost, and stop hammering an API that is telling us no.
      this.lastError = String(err);
      this.available = false;
    }
    return false;
  }

  remove(key: string): void {
    delete this.memory[key];
    try {
      if (this.available) localStorage.removeItem(key);
    } catch (err) {
      this.lastError = String(err);
    }
  }
}

const storage = new SafeStorage();

/* ================================================================== *
 * Migrations
 * ================================================================== */

type AnySave = Record<string, unknown>;

/**
 * `MIGRATIONS[n]` upgrades a version-n blob in place and returns it as
 * version n+1. Missing entries mean "the shape did not change".
 */
const MIGRATIONS: Record<number, (s: AnySave) => AnySave> = {
  // v0: the pre-versioning shape, written before `settings` existed and when
  // discoveries were stored as a bare array at the top level.
  0: (s) => {
    const legacy = Array.isArray(s.discovered) ? (s.discovered as string[]) : [];
    return {
      ...s,
      version: 1,
      discoveries: Array.isArray(s.discoveries) ? s.discoveries : legacy,
      settings: { quality: null, showHud: true, showDebug: false, timeOfDay: 17.4 },
    };
  },
  // v1 → v2: mission completions moved from a `{id: true}` map to an array,
  // and the heat ledger gained `peakLevelEver`.
  1: (s) => {
    const raw = s.missions as unknown;
    const list = Array.isArray(raw)
      ? (raw as string[])
      : raw && typeof raw === "object"
        ? Object.keys(raw as object).filter((k) => (raw as Record<string, unknown>)[k])
        : [];
    const heat = (s.heat ?? {}) as AnySave;
    return {
      ...s,
      version: 2,
      missions: list,
      heat: { ...heat, peakLevelEver: num(heat.peakLevelEver, 0) },
    };
  },
};

/* ================================================================== *
 * Validation helpers — every field from disk goes through one of these
 * ================================================================== */

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) if (typeof item === "string") out.push(item);
  return out;
}

function numRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  if (!v || typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "number" && isFinite(val)) out[k] = val;
  }
  return out;
}

const QUALITY_TIERS = ["low", "medium", "high", "ultra"];

function sanitise(raw: AnySave): SaveData {
  const prog = (raw.progression ?? {}) as AnySave;
  const heat = (raw.heat ?? {}) as AnySave;
  const settings = (raw.settings ?? {}) as AnySave;
  const q = settings.quality;

  return {
    version: SAVE_VERSION,
    savedAt: num(raw.savedAt, 0),
    seed: typeof raw.seed === "string" ? raw.seed : WORLD_SEED,
    chaos: Math.max(0, num(raw.chaos, 0)),
    discoveries: strArray(raw.discoveries),
    missions: strArray(raw.missions),
    progression: {
      // `hydrate` filters unknown ids; here we only guarantee the *types*.
      stats: (prog.stats && typeof prog.stats === "object" ? prog.stats : {}) as never,
      unlocks: strArray(prog.unlocks),
      challenges: strArray(prog.challenges),
      bestTimes: numRecord(prog.bestTimes),
    },
    heat: {
      escapes: Math.max(0, num(heat.escapes, 0)),
      busted: Math.max(0, num(heat.busted, 0)),
      longestPursuit: Math.max(0, num(heat.longestPursuit, 0)),
      peakLevelEver: Math.max(0, Math.min(5, num(heat.peakLevelEver, 0))),
      timeAtLevel: Array.isArray(heat.timeAtLevel)
        ? (heat.timeAtLevel as unknown[]).map((v) => Math.max(0, num(v, 0)))
        : [],
    },
    settings: {
      quality: typeof q === "string" && QUALITY_TIERS.indexOf(q) >= 0 ? (q as QualityTier) : null,
      showHud: bool(settings.showHud, true),
      showDebug: bool(settings.showDebug, false),
      timeOfDay: Math.max(0, Math.min(24, num(settings.timeOfDay, 17.4))),
    },
  };
}

/* ================================================================== *
 * Read / write
 * ================================================================== */

/** Collect the current game state into a save blob. */
export function snapshot(): SaveData {
  const store = useSfStore.getState();
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    seed: WORLD_SEED,
    chaos: store.chaos,
    discoveries: discoveries.serialize(),
    missions: missions.completedIds(),
    progression: progression.serialize(),
    heat: {
      escapes: gameHeat.escapes,
      busted: gameHeat.busted,
      longestPursuit: gameHeat.longestPursuit,
      peakLevelEver: gameHeat.peakLevelEver,
      timeAtLevel: Array.from(gameHeat.timeAtLevel),
    },
    settings: {
      quality: store.quality,
      showHud: store.showHud,
      showDebug: store.showDebug,
      timeOfDay: frame.timeOfDay,
    },
  };
}

/** True if a save exists that this build can read. */
export function hasSave(): boolean {
  const raw = storage.get(KEY);
  return typeof raw === "string" && raw.length > 2;
}

/**
 * Write the current state. Returns true if it reached real storage. Safe to
 * call at any time; it never throws and never blocks on failure.
 */
export function saveGame(reason = "auto"): boolean {
  try {
    const data = snapshot();
    const ok = storage.set(KEY, JSON.stringify(data));
    saveSystem.lastSaveAt = frame.time;
    saveSystem.dirty = false;
    saveSystem.lastReason = reason;
    return ok;
  } catch (err) {
    // Serialisation itself failing means something upstream is corrupt; there
    // is nothing useful to do except record it and carry on playing.
    storage.lastError = String(err);
    return false;
  }
}

/**
 * Read, migrate, validate and apply a save. Returns the applied data, or null
 * if there was nothing readable (which is not an error — it is a new game).
 */
export function loadGame(): SaveData | null {
  const raw = storage.get(KEY);
  if (!raw) return null;

  let parsed: AnySave;
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object") return null;
    parsed = p as AnySave;
  } catch (err) {
    // Corrupt blob. Drop it rather than fighting it every launch.
    storage.lastError = `corrupt save: ${String(err)}`;
    storage.remove(KEY);
    return null;
  }

  // Chain the migrations up to the current version.
  let version = num(parsed.version, 0);
  let guard = 0;
  while (version < SAVE_VERSION && guard++ < 32) {
    const step = MIGRATIONS[version];
    parsed = step ? step(parsed) : { ...parsed, version: version + 1 };
    version = num(parsed.version, version + 1);
  }

  const data = sanitise(parsed);

  // A save from a different world seed describes a city that no longer exists:
  // the discoveries and missions in it are placed at coordinates this build
  // does not generate. Keep the career, drop the geography.
  const sameWorld = data.seed === WORLD_SEED;

  const store = useSfStore.getState();
  // Career chaos is set directly rather than through `addChaos` so loading a
  // save does not fire the combo economy and spray unlock cards everywhere.
  useSfStore.setState({ chaos: data.chaos });

  progression.hydrate(data.progression);
  gameHeat.hydrate(data.heat);
  if (sameWorld) {
    discoveries.hydrate(data.discoveries);
    missions.hydrate(data.missions);
  }

  if (data.settings.quality) store.setQuality(data.settings.quality);
  useSfStore.setState({
    showHud: data.settings.showHud,
    showDebug: data.settings.showDebug,
  });
  frame.timeOfDay = data.settings.timeOfDay;

  saveSystem.loaded = true;
  saveSystem.dirty = false;
  return data;
}

/** Delete the save. Used by "new game" and by the settings screen. */
export function clearSave(): void {
  storage.remove(KEY);
  saveSystem.dirty = false;
  saveSystem.loaded = false;
}

/** Export the save as a string, for the "copy my progress" button. */
export function exportSave(): string {
  try {
    return JSON.stringify(snapshot());
  } catch {
    return "";
  }
}

/** Import a save string. Returns false on anything unreadable. */
export function importSave(text: string): boolean {
  try {
    const p = JSON.parse(text);
    if (!p || typeof p !== "object") return false;
    storage.set(KEY, text);
    return loadGame() !== null;
  } catch {
    return false;
  }
}

/* ================================================================== *
 * Autosave
 * ================================================================== */

/** Seconds between autosaves, when something has changed. */
const AUTOSAVE_INTERVAL = 30;

class SaveSystem {
  dirty = false;
  loaded = false;
  lastSaveAt = -1e9;
  lastReason = "";
  private clock = 0;

  get available(): boolean {
    return storage.available;
  }
  get lastError(): string | null {
    return storage.lastError;
  }

  /** Something worth persisting happened. */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Called from the director tick. Serialisation is deferred to a moment when
   * nothing else is competing for the frame — never inside a mission
   * completion or a destruction event.
   */
  tick(dt: number): void {
    this.clock += dt;
    if (this.clock < AUTOSAVE_INTERVAL) return;
    this.clock = 0;
    if (!this.dirty) return;
    saveGame("auto");
  }

  /**
   * Wire the events that mean "the player would be upset to lose this":
   * discoveries, unlocks, mission completion, and the page going away.
   */
  install(): () => void {
    const offDiscover = discoveries.onDiscover(() => this.markDirty());
    const offUnlock = progression.onUnlock(() => this.markDirty());
    const offMission = missions.onEvent((e) => {
      if (e.type === "complete") {
        this.markDirty();
        // Mission completion is the one event worth an immediate write: it is
        // the largest single chunk of progress the player can lose.
        saveGame("mission");
      }
    });

    const onHide = () => {
      if (this.dirty) saveGame("hidden");
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onHide);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", onHide);
    }

    return () => {
      offDiscover();
      offUnlock();
      offMission();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onHide);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onHide);
      }
    };
  }
}

export const saveSystem = new SaveSystem();
