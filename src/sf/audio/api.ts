/**
 * audio/api.ts — the module-level singleton every other system calls.
 *
 * Nothing outside `src/sf/audio` should have to know that there are nine
 * modules in here, which bus a sound belongs on, or whether a buffer has been
 * baked yet. It imports `sfAudio` and calls a verb:
 *
 *     import { sfAudio } from "@/sf/audio";
 *     sfAudio.playShot("ar556", { x, y, z, local: true });
 *     sfAudio.playImpact("concrete", { x, y, z, power: 0.7 });
 *     sfAudio.playExplosion({ x, y, z, kind: "vehicle", radius: 6 });
 *
 * Every entry point is safe to call at any time — before boot, while the
 * autoplay policy still has the context locked, after teardown, with audio
 * muted. They no-op instead of throwing. A game that crashes because a browser
 * would not let it make a noise is a worse game than a silent one.
 *
 * `publish()` puts this object on `globalThis.__sfAudio`, which is the
 * late-binding hook `weapons/bridge.ts` already polls for — so weapons get
 * real audio the moment this mounts, with no import between the two modules
 * and no re-mount when it does.
 */
import { audioEngine, type AudioSettings, type BusName, type EnvironmentKind } from "./engine";
import { voicePool } from "./spatial";
import {
  playCasing,
  playDistantShot,
  playShot,
  playWeaponMech,
  weaponSink,
  type ShotOptions,
} from "./weaponSounds";
import {
  playDebrisShower,
  playExplosion,
  playIgnition,
  playTinnitus,
  type DebrisKind,
  type ExplosionOptions,
} from "./explosionSounds";
import {
  playBodyFall,
  playFoley,
  playFootstep,
  playImpact,
  playJump,
  playLanding,
  playRicochet,
  surfaceAt,
  type FoleyKind,
  type FootstepOptions,
  type ImpactOptions,
} from "./footsteps";
import {
  engineSpec,
  playHorn,
  vehicleAudio,
  type SirenMode,
  type VehicleAudioState,
  type VehicleKind,
} from "./vehicleSounds";
import {
  playCableCarBell,
  playChurchBell,
  playDistantSiren,
  playFoghorn,
  playJackhammer,
  playMuniPass,
  playSeagull,
  playShipHorn,
  worldAmbience,
} from "./worldAmbience";
import { music, type StingerKind } from "./music";

export interface SfAudioStats {
  engine: ReturnType<typeof audioEngine.stats>;
  voices: typeof voicePool.stats;
  vehicles: number;
  music: typeof music.state;
  beds: Record<string, number>;
}

export const sfAudio = {
  /* ---------------- lifecycle ---------------- */

  /** Build the graph. Idempotent. Returns false if WebAudio is unavailable. */
  init(settings?: Partial<AudioSettings>): boolean {
    return audioEngine.init(settings);
  },

  /** Resume the context from a user gesture. Safe to call repeatedly. */
  unlock(): Promise<boolean> {
    return audioEngine.unlock();
  },

  dispose(): void {
    music.stop();
    worldAmbience.stop();
    vehicleAudio.stopAll();
    voicePool.dispose();
    audioEngine.dispose();
  },

  get available(): boolean {
    return audioEngine.available;
  },

  /** True while the browser's autoplay policy is still holding audio back. */
  get blocked(): boolean {
    return audioEngine.blocked;
  },

  /* ---------------- mixer ---------------- */

  setVolume(bus: BusName | "master", v: number): void {
    audioEngine.setVolume(bus, v);
  },

  /** Instant and total. No tail, no fade, no residual reverb. */
  setMuted(muted: boolean): void {
    audioEngine.setMuted(muted);
    if (muted) voicePool.stopAll();
  },

  toggleMute(): boolean {
    const m = audioEngine.toggleMute();
    if (m) voicePool.stopAll();
    return m;
  },

  get muted(): boolean {
    return audioEngine.muted;
  },

  get settings(): AudioSettings {
    return audioEngine.settings;
  },

  applySettings(patch: Partial<AudioSettings>): void {
    audioEngine.applySettings(patch);
  },

  /** Hard cap on simultaneous positional voices. */
  setMaxVoices(n: number): void {
    voicePool.setMaxVoices(n);
  },

  /* ---------------- listener + space ---------------- */

  setListener(
    px: number,
    py: number,
    pz: number,
    fx: number,
    fy: number,
    fz: number,
    ux = 0,
    uy = 1,
    uz = 0,
    vx = 0,
    vy = 0,
    vz = 0,
  ): void {
    audioEngine.setListener(px, py, pz, fx, fy, fz, ux, uy, uz, vx, vy, vz);
  },

  /** Force a reverb space — use for interiors and tunnels the heuristic misses. */
  setEnvironment(kind: EnvironmentKind, immediate = false): void {
    audioEngine.setEnvironment(kind, immediate);
  },

  get environment(): EnvironmentKind {
    return audioEngine.environment;
  },

  /* ---------------- weapons ---------------- */

  playShot(bank: string, opts: ShotOptions): void {
    playShot(bank, opts);
  },
  playSuppressedShot(bank: string, opts: ShotOptions): void {
    playShot(bank, { ...opts, suppressed: true });
  },
  playDistantShot(bank: string, opts: ShotOptions): void {
    playDistantShot(bank, opts);
  },
  /** Reloads, bolts, draws, dry fire — any bank key from the registry. */
  playWeaponMech(bank: string, opts: ShotOptions): void {
    playWeaponMech(bank, opts);
  },
  playCasing(heavy: boolean, opts: ShotOptions): void {
    playCasing(heavy, opts);
  },
  /** Hand this to `setWeaponAudioSink` — or let the bridge find it via publish(). */
  weaponSink,

  /* ---------------- explosions ---------------- */

  playExplosion(opts: ExplosionOptions): void {
    playExplosion(opts);
  },
  playDebris(kind: DebrisKind, x: number, y: number, z: number, volume = 1): void {
    playDebrisShower(kind, { x, y, z, volume });
  },
  playIgnition(x: number, y: number, z: number, volume = 1): void {
    playIgnition(x, y, z, volume);
  },
  playTinnitus(intensity: number): void {
    playTinnitus(intensity);
  },
  /** Duck the whole mix — for cinematics and mission voice-over. */
  duck(amount: number, hold = 0.3, release = 0.6): void {
    audioEngine.duck(amount, 0.03, hold, release);
  },

  /* ---------------- surfaces ---------------- */

  playImpact(surface: string, opts: ImpactOptions): void {
    playImpact(surface, opts);
  },
  playRicochet(opts: ImpactOptions): void {
    playRicochet(opts);
  },
  playFootstep(surface: string, opts: FootstepOptions): void {
    playFootstep(surface, opts);
  },
  playLanding(surface: string, opts: FootstepOptions & { impact?: number }): void {
    playLanding(surface, opts);
  },
  playJump(opts: FootstepOptions): void {
    playJump(opts);
  },
  playBodyFall(surface: string, x: number, y: number, z: number, force = 1): void {
    playBodyFall(surface, x, y, z, force);
  },
  playFoley(kind: FoleyKind, intensity: number, x: number, y: number, z: number, local = false): void {
    playFoley(kind, intensity, local, x, y, z);
  },
  /** What the ground is at (x, z), straight from `sfGeo`. */
  surfaceAt,

  /* ---------------- vehicles ---------------- */

  /**
   * Report one vehicle this frame. Creates its engine voice on first sight and
   * releases it automatically once you stop reporting it.
   */
  updateVehicle(id: number, kind: VehicleKind, state: VehicleAudioState, dt: number): void {
    vehicleAudio.update(id, engineSpec(kind), state, dt);
  },
  setSiren(id: number, mode: SirenMode): void {
    vehicleAudio.setSiren(id, mode);
  },
  releaseVehicle(id: number): void {
    vehicleAudio.release(id);
  },
  playHorn(x: number, y: number, z: number, kind = 0, duration = 0.4): void {
    playHorn(x, y, z, kind, duration);
  },

  /* ---------------- world ---------------- */

  playFoghorn,
  playSeagull,
  playCableCarBell,
  playChurchBell,
  playMuniPass,
  playJackhammer,
  playShipHorn,
  playDistantSiren,
  setAmbienceEnabled(v: boolean): void {
    worldAmbience.setEnabled(v);
  },

  /* ---------------- music ---------------- */

  setMusicIntensity(v: number): void {
    music.setIntensity(v);
  },
  stinger(kind: StingerKind): void {
    music.stinger(kind);
  },
  setMusicEnabled(v: boolean): void {
    music.setEnabled(v);
  },

  /* ---------------- diagnostics ---------------- */

  stats(): SfAudioStats {
    return {
      engine: audioEngine.stats(),
      voices: voicePool.stats,
      vehicles: vehicleAudio.count,
      music: music.state,
      beds: worldAmbience.levels,
    };
  },

  /* ---------------- late binding ---------------- */

  /**
   * Publish on `globalThis.__sfAudio`.
   *
   * `weapons/bridge.ts` polls that property once a frame and adopts
   * `.weaponSink` the moment it appears. Publishing rather than importing
   * keeps the dependency one-way: weapons compile and make noise whether or
   * not this module exists in a given build.
   */
  publish(): void {
    if (typeof globalThis === "undefined") return;
    (globalThis as Record<string, unknown>).__sfAudio = sfAudio;
  },

  unpublish(): void {
    if (typeof globalThis === "undefined") return;
    if ((globalThis as Record<string, unknown>).__sfAudio === sfAudio) {
      delete (globalThis as Record<string, unknown>).__sfAudio;
    }
  },
};

export type SfAudioApi = typeof sfAudio;
