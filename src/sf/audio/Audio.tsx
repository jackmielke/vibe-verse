/**
 * audio/Audio.tsx — the audio system's slot in the scene graph.
 *
 * Mount `<SfAudio />` once inside the Canvas and everything else in this
 * directory comes alive:
 *
 *   - the AudioContext is created (suspended — the browser insists) and
 *     resumed on the first click, tap or keypress;
 *   - the expensive banks are baked during the loading screen, yielding
 *     between weapons so the main thread never blocks for a visible frame;
 *   - a physics-backed occlusion probe is installed, with a terrain-only
 *     fallback for the window before Rapier finishes booting;
 *   - the listener follows the camera, the environment reverb follows the
 *     district, ambience follows the weather, and the score follows the heat;
 *   - `globalThis.__sfAudio` is published, which is how `weapons/bridge.ts`
 *     finds the weapon sink without either module importing the other.
 *
 * The component renders nothing. It is a subsystem with a React lifecycle
 * bolted on, and it does exactly one thing per frame: pump the audio clock.
 */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { frame, useSfStore } from "../state/store";
import { makeRayHit, raycast } from "../physics/raycast";
import { isPhysicsReady } from "../physics/world";
import {
  audioEngine,
  setOcclusionProbe,
  terrainOcclusion,
  updateEnvironmentFromFrame,
  type AudioSettings,
} from "./engine";
import { voicePool } from "./spatial";
import { primeWeaponBanks } from "./weaponSounds";
import { primeExplosionBanks, updateExplosions } from "./explosionSounds";
import { primeFootstepBanks, updateFootsteps } from "./footsteps";
import { primeAmbience, worldAmbience, clearAmbienceTimers } from "./worldAmbience";
import { music, primeMusic } from "./music";
import { vehicleAudio } from "./vehicleSounds";
import { sfAudio } from "./api";

/* ------------------------------------------------------------------ *
 * Scratch — hoisted, because none of this may allocate at 60 Hz.
 * ------------------------------------------------------------------ */

const _camPos = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _rayHit = makeRayHit();

/* ------------------------------------------------------------------ *
 * Occlusion probe
 * ------------------------------------------------------------------ */

/**
 * One ray from source to listener.
 *
 * A binary hit/miss is deliberately *not* what we return: a single sample
 * would make occlusion flicker on and off as a car drives between you and a
 * fight. Instead the hit distance modulates how occluded it reads — a wall
 * right against the source muffles far more than a lamp post halfway along
 * the ray — and the voice smooths the result over ~150 ms on top.
 *
 * Rays are cheap here because `Voice.tick` throttles per-voice probing by
 * distance: at most a handful of these run per frame even in a firefight.
 */
function physicsOcclusion(
  sx: number,
  sy: number,
  sz: number,
  lx: number,
  ly: number,
  lz: number,
): number {
  const terrain = terrainOcclusion(sx, sy, sz, lx, ly, lz);
  if (!isPhysicsReady()) return terrain;
  const dx = lx - sx;
  const dy = ly - sy;
  const dz = lz - sz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1.5) return terrain;
  // Start a little off the source so a gun fired against a wall does not
  // occlude itself on the wall it is touching.
  const inv = 1 / dist;
  const ox = sx + dx * inv * 0.6;
  const oy = sy + dy * inv * 0.6;
  const oz = sz + dz * inv * 0.6;
  const hit = raycast(ox, oy, oz, dx, dy, dz, dist - 1.2, _rayHit, { skipSurface: true });
  if (!hit || !_rayHit.hit) return terrain;
  // Thick obstruction near the middle of the ray (a whole building) reads as
  // more occlusion than something hugging either end (a doorway, a railing).
  const u = _rayHit.distance / dist;
  const centrality = 1 - Math.abs(u - 0.5) * 1.2;
  return Math.max(terrain, 0.55 + 0.4 * Math.max(0, centrality));
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export interface SfAudioProps {
  /** Start the adaptive score. Default true. */
  music?: boolean;
  /** Start the world ambience beds. Default true. */
  ambience?: boolean;
  /** Initial mixer settings. */
  settings?: Partial<AudioSettings>;
  /**
   * Pre-bake every bank during mount instead of lazily. Default true; turn it
   * off in the screenshot harness, where nothing is ever heard and the bake
   * would only cost load time.
   */
  prime?: boolean;
}

export default function SfAudio({
  music: wantMusic = true,
  ambience: wantAmbience = true,
  settings,
  prime = true,
}: SfAudioProps) {
  const camera = useThree((s) => s.camera);
  const started = useRef(false);
  const wasPaused = useRef(false);
  const lastHeat = useRef(0);
  const lastPhase = useRef<string>("loading");

  /* ---- boot ---- */
  useEffect(() => {
    const ok = audioEngine.init(settings);
    setOcclusionProbe(physicsOcclusion);
    sfAudio.publish();
    if (!ok) return;

    let cancelled = false;
    if (prime) {
      // Fire and forget. Each helper yields to the microtask queue between
      // banks, so a long bake never shows up as a dropped frame.
      void (async () => {
        await primeWeaponBanks();
        if (cancelled) return;
        await primeFootstepBanks();
        if (cancelled) return;
        await primeExplosionBanks();
        if (cancelled) return;
        await primeAmbience();
        if (cancelled) return;
        primeMusic();
      })();
    }

    return () => {
      cancelled = true;
      music.stop();
      worldAmbience.stop();
      clearAmbienceTimers();
      vehicleAudio.stopAll();
      voicePool.dispose();
      setOcclusionProbe(null);
      sfAudio.unpublish();
      audioEngine.dispose();
      started.current = false;
    };
    // `settings` is read once at boot on purpose; live changes go through
    // `sfAudio.setVolume`, which does not need a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prime]);

  /* ---- per frame ---- */
  useFrame((_, delta) => {
    if (!audioEngine.available) return;
    const dt = Math.min(delta, 1 / 20);

    // The listener is the camera, not the player capsule: in a vehicle or in
    // photo mode those are metres apart and the ears follow the view.
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_camFwd);
    _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    audioEngine.setListener(
      _camPos.x,
      _camPos.y,
      _camPos.z,
      _camFwd.x,
      _camFwd.y,
      _camFwd.z,
      _camUp.x,
      _camUp.y,
      _camUp.z,
      frame.velocity.x,
      frame.velocity.y,
      frame.velocity.z,
    );

    // Pausing: suspend the whole context rather than muting. No DSP runs, no
    // reverb tail keeps ringing behind a frozen screen.
    if (frame.paused !== wasPaused.current) {
      wasPaused.current = frame.paused;
      if (frame.paused) audioEngine.suspend();
      else audioEngine.resume();
    }
    if (frame.paused) return;

    updateEnvironmentFromFrame();
    audioEngine.update(dt);
    voicePool.update(dt);
    updateExplosions();
    updateFootsteps(dt);

    // Ambience and music only start once audio is actually running — starting
    // them into a suspended context wastes a held voice each.
    if (!started.current && !audioEngine.blocked) {
      // Only latch once both actually got their held voices. `start()` returns
      // false if the pool was exhausted or the mix was muted at that instant,
      // and latching on a failed start would leave the world permanently
      // silent after the player unmutes.
      const a = wantAmbience ? worldAmbience.start() : true;
      const m = wantMusic ? music.start() : true;
      started.current = a && m;
    }
    if (wantAmbience) worldAmbience.update(dt);
    if (wantMusic) music.update(dt);

    // Vehicles report themselves during their own update; this reaps anything
    // that stopped reporting (despawned, culled, destroyed).
    vehicleAudio.endFrame();

    // Score reactions to game state. Read non-reactively — subscribing would
    // re-render this component sixty times a second for nothing.
    const st = useSfStore.getState();
    if (st.heat > lastHeat.current && wantMusic) music.stinger("heat");
    else if (st.heat === 0 && lastHeat.current > 0 && wantMusic) music.stinger("clear");
    lastHeat.current = st.heat;
    if (st.phase !== lastPhase.current) {
      if (st.phase === "dead" && wantMusic) music.stinger("death");
      lastPhase.current = st.phase;
    }
  });

  return null;
}
