/**
 * Vibe Kart — audio. Publishes `ctx.services.audio`.
 *
 * Nothing in this folder loads a file. The engine, the tyres, sixty one-shots
 * and a four-minute score are all synthesised from oscillators, noise and
 * sample-domain DSP, which is why the whole game is a few hundred kilobytes of
 * JavaScript and starts making noise the instant a finger touches the screen.
 *
 * This file is the plumbing: it owns the lazy context, the service object, the
 * event wiring and the per-frame pass that feeds the continuous rigs.
 *
 * Rules it lives by
 * -----------------
 * · **It never throws.** No AudioContext, a suspended context, a sibling
 *   system that failed to boot, a cue name invented after this file was
 *   written — every one of those is a silent no-op. A quiet game is a bug; a
 *   crashed game is a disaster.
 * · **The context is built on a gesture, not at boot.** Browsers will not let
 *   it run before one, and the screenshot harness is headless, so building
 *   eagerly buys nothing but a warning in the console. `unlock()` is the
 *   documented entry point and a one-shot window listener is the safety net.
 * · **Continuous sound is driven, not triggered.** The engine, the tyres and
 *   the music are all long-lived graphs whose parameters are steered every
 *   frame with `setTargetAtTime`. Nothing in the hot path allocates a voice
 *   unless something actually happened.
 *
 * Consumes: `race:*`, `kart:*`, `item:*`, `ui:*`, and reads
 * `services.physics`, `services.track`, `services.race` — all optional.
 */
import type { AudioService, KartCtx, RacerState, SurfaceKind, System } from "../types";
import { makeRng } from "../types";
import { BUS_GAIN, createGraph, disposeGraph, updateListener, type AudioGraph } from "./graph";
import { createBank, type Bank } from "./bank";
import { createEngineRig, type EngineRacer, type EngineRig } from "./engineVoice";
import { createTyreRig, type TyreRig, type TyreState } from "./tyres";
import { createMusicRig, type MusicRig, type MusicTrack } from "./music";
import { clamp, clamp01, type Vec3Like } from "./synth";

const MUTE_KEY = "vibekart.mute";

export interface AudioMix {
  master: number;
  music: number;
  sfx: number;
  engine: number;
}

/** What we publish: the contract in types.ts plus a mixer the options menu wants. */
export interface KartAudioService extends AudioService {
  /** Bus trims as multipliers on the defaults. */
  setMix(mix: Partial<AudioMix>): void;
  readonly mix: AudioMix;
  /** True once a gesture has actually started the context. */
  readonly ready: boolean;
}

/** The screenshot harness renders headless; there is nobody there to hear it. */
function isShotMode(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return new URLSearchParams(window.location.search).has("shot");
  } catch {
    return false;
  }
}

interface RacerLike extends RacerState {
  /** Published by the physics system; absent on a bare RacerState. */
  slipAngle?: number;
}

export default function createAudio(ctx: KartCtx): System {
  // A private stream: the noise buffers and baked kit drain tens of thousands
  // of samples, and taking that out of the shared RNG would reshuffle every
  // system that boots after us. One draw seeds it, so runs stay deterministic.
  const rng = makeRng(Math.floor(ctx.rng() * 0xffffffff) >>> 0);

  let graph: AudioGraph | null = null;
  let bank: Bank | null = null;
  let engineRig: EngineRig | null = null;
  let tyreRig: TyreRig | null = null;
  let musicRig: MusicRig | null = null;
  let dead = isShotMode();
  let muted = false;
  // A tab that starts in the background must not start the score playing to
  // nobody; `visibilitychange` only fires on a transition.
  let hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  let wantedTrack: MusicTrack | null = null;

  try {
    muted = typeof localStorage !== "undefined" && localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    /* private browsing — default to audible */
  }

  const mix: AudioMix = { master: 1, music: 1, sfx: 1, engine: 1 };

  /** Build the whole rig on first use. Null forever after a failure. */
  function ensure(): AudioGraph | null {
    if (graph || dead) return graph;
    const g = createGraph(ctx.quality, rng);
    if (!g) {
      dead = true;
      return null;
    }
    graph = g;
    try {
      bank = createBank(g);
      engineRig = createEngineRig(g);
      tyreRig = createTyreRig(g);
      musicRig = createMusicRig(g);
    } catch (err) {
      console.warn("[Vibe Kart] audio rig failed to build:", err);
    }
    applyMix();
    return g;
  }

  function applyMix(): void {
    if (!graph) return;
    const t = graph.ac.currentTime;
    const gate = muted || hidden ? 0.0001 : 1;
    graph.master.gain.setTargetAtTime(BUS_GAIN.master * clamp(mix.master, 0, 2) * gate, t, 0.05);
    graph.music.gain.setTargetAtTime(BUS_GAIN.music * clamp(mix.music, 0, 2), t, 0.08);
    graph.sfx.gain.setTargetAtTime(BUS_GAIN.sfx * clamp(mix.sfx, 0, 2), t, 0.05);
    graph.engine.gain.setTargetAtTime(BUS_GAIN.engine * clamp(mix.engine, 0, 2), t, 0.05);
  }

  function resume(): void {
    const g = ensure();
    if (!g) return;
    if (g.ac.state === "suspended") {
      void g.ac.resume().then(
        () => {
          // The context only starts counting once it is running; the music rig
          // anchors itself on the first update after that.
          if (wantedTrack) musicRig?.set(wantedTrack);
        },
        () => {
          /* still gated — the next gesture will try again */
        },
      );
    } else if (wantedTrack) {
      musicRig?.set(wantedTrack);
    }
  }

  // A gesture anywhere unlocks the context. The UI is expected to call
  // `unlock()` from its start button; this is the safety net for every other
  // way a player can end up on the track.
  const gestureEvents = ["pointerdown", "keydown", "touchstart"] as const;
  const onGesture = (): void => resume();
  if (!dead && typeof window !== "undefined") {
    for (const e of gestureEvents) window.addEventListener(e, onGesture, { passive: true });
  }

  const onVisibility = (): void => {
    hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    applyMix();
  };
  if (!dead && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  // -------------------------------------------------------------------------
  // The service
  // -------------------------------------------------------------------------
  function play(id: string, position?: Vec3Like, opts?: { volume?: number; rate?: number }): void {
    // Deliberately does *not* build the graph: baking the bank costs real
    // milliseconds and would be spent producing silence, because a context
    // built outside a gesture is suspended. The gesture builds; this plays.
    if (dead || !graph || !bank || muted || hidden) return;
    bank.play(id, { at: position ?? null, volume: opts?.volume ?? 1, rate: opts?.rate ?? 1 });
  }

  /** Racer handed to us by an external caller this frame, if any. */
  let drivenRacer: RacerState | null = null;
  let drivenAt = -1;

  const service: KartAudioService = {
    play(id, position, opts) {
      play(id, position as Vec3Like | undefined, opts);
    },
    engine(racer) {
      drivenRacer = racer;
      drivenAt = ctx.elapsed;
    },
    music(trackName) {
      // Remembered even before the context exists: `resume()` starts whatever
      // the last request was, so a menu that asks for music at boot still gets
      // it the instant the player touches anything.
      wantedTrack = (trackName as MusicTrack | null) ?? null;
      if (dead || !graph) return;
      musicRig?.set(wantedTrack);
    },
    setMuted(next) {
      if (next === muted) return;
      muted = next;
      service.muted = next;
      try {
        localStorage?.setItem(MUTE_KEY, next ? "1" : "0");
      } catch {
        /* private browsing */
      }
      applyMix();
    },
    muted,
    unlock() {
      if (dead) return;
      resume();
    },
    setMix(next) {
      if (next.master !== undefined) mix.master = next.master;
      if (next.music !== undefined) mix.music = next.music;
      if (next.sfx !== undefined) mix.sfx = next.sfx;
      if (next.engine !== undefined) mix.engine = next.engine;
      applyMix();
    },
    mix,
    get ready() {
      return !!graph && graph.ac.state === "running";
    },
  };
  // Published synchronously: everything after this line can be late, but the
  // handle cannot be, or the systems booting behind us will never find it.
  ctx.services.audio = service;

  // -------------------------------------------------------------------------
  // Neighbours
  // -------------------------------------------------------------------------
  const offs: Array<() => void> = [];

  function on<T>(event: string, fn: (payload: T) => void): void {
    offs.push(
      ctx.on(event, ((p: T) => {
        try {
          fn(p);
        } catch {
          // A malformed payload costs one sound effect, not the race.
        }
      }) as (p: never) => void),
    );
  }

  const racers = (): RacerLike[] => (ctx.services.physics?.racers as RacerLike[] | undefined) ?? [];
  const player = (): RacerLike | null =>
    (ctx.services.physics?.player as RacerLike | undefined) ?? racers().find((r) => r.isPlayer) ?? null;

  function racerById(id: number | undefined): RacerLike | null {
    if (id === undefined) return null;
    for (const r of racers()) if (r.id === id) return r;
    return null;
  }

  function at(id: number | undefined): Vec3Like | undefined {
    const r = racerById(id);
    return r ? r.position : undefined;
  }

  const isPlayerId = (id: number | undefined): boolean => {
    const r = racerById(id);
    return r ? r.isPlayer : id === 0;
  };

  interface RacerPayload {
    racer?: number;
    isPlayer?: boolean;
  }

  on<{ count?: number }>("race:countdown", (p) => {
    const n = p?.count ?? 0;
    if (n > 0) play("count", undefined, { volume: 0.9 });
    else {
      play("countGo", undefined, { volume: 1 });
      cheer(1);
    }
  });

  on<RacerPayload>("race:start", () => {
    cheer(0.8);
  });

  on<RacerPayload & { lap?: number }>("race:lap", (p) => {
    if (!isPlayerId(p?.racer)) return;
    play("lap", undefined, { volume: 0.9 });
    cheer(0.55);
  });

  on<RacerPayload>("race:finalLap", (p) => {
    if (p?.isPlayer === false) return;
    play("finalLap", undefined, { volume: 1 });
    cheer(0.7);
  });

  on<RacerPayload & { place?: number }>("race:finish", (p) => {
    if (!isPlayerId(p?.racer)) return;
    play("finish", undefined, { volume: 1 });
    cheer(1);
  });

  on<RacerPayload>("race:respawn", (p) => {
    play("respawn", at(p?.racer), { volume: isPlayerId(p?.racer) ? 0.9 : 0.4 });
  });

  on<RacerPayload & { wrong?: boolean }>("race:wrongWay", (p) => {
    if (!p?.wrong || p.isPlayer === false) return;
    play("uiBack", undefined, { volume: 0.7, rate: 0.8 });
  });

  on<RacerPayload & { result?: string }>("race:rocketStart", (p) => {
    if (p?.isPlayer === false) return;
    if (p?.result === "flooded") play("bump", undefined, { volume: 0.6, rate: 0.7 });
    else play("boost", undefined, { volume: 0.9, rate: 1.05 });
  });

  on<{ racer?: number; source?: string }>("kart:boost", (p) => {
    const src = p?.source ?? "miniTurbo";
    // The item system already voices its own mushroom; doubling it just makes
    // the mix muddy. Everything else is ours.
    if (src === "mushroom" || src === "bullet") return;
    const solo = isPlayerId(p?.racer);
    const rate = src === "pad" ? 0.92 : src === "start" ? 1.08 : 1;
    play("boost", at(p?.racer), { volume: solo ? 0.85 : 0.32, rate });
  });

  on<{ racer?: number; by?: string; spin?: boolean }>("kart:hit", (p) => {
    const where = at(p?.racer);
    const solo = isPlayerId(p?.racer);
    const v = solo ? 0.95 : 0.45;
    if (p?.by === "banana") play("bananaSlip", where, { volume: v });
    else if (p?.spin) play("spinOut", where, { volume: v });
    else play("bump", where, { volume: v });
  });

  on<{ racer?: number; impact?: number }>("kart:land", (p) => {
    const impact = clamp01(p?.impact ?? 0.5);
    if (impact < 0.06) return;
    play("landing", at(p?.racer), {
      volume: (isPlayerId(p?.racer) ? 0.85 : 0.35) * (0.4 + impact * 0.8),
      rate: 1.1 - impact * 0.25,
    });
  });

  on<{ racer?: number }>("kart:trick", (p) => {
    play("trickSpin", at(p?.racer), { volume: isPlayerId(p?.racer) ? 0.7 : 0.3 });
  });

  on<{ racer?: number; tier?: number }>("kart:miniTurbo", (p) => {
    play("boost", at(p?.racer), { volume: isPlayerId(p?.racer) ? 0.8 : 0.3, rate: 1 + (p?.tier ?? 1) * 0.06 });
  });

  on<{ a?: number; b?: number; impulse?: number }>("kart:collide", (p) => {
    const force = clamp01((p?.impulse ?? 4) / 12);
    if (force < 0.08) return;
    play("bump", at(p?.a), { volume: 0.4 + force * 0.5, rate: 1.15 - force * 0.2 });
  });

  on<{ racer?: number; kind?: string }>("item:use", (p) => {
    // Items voice their own launches; this is only the "nothing to fire" click.
    if (!p?.kind) play("uiBack", undefined, { volume: 0.35 });
  });

  on<RacerPayload>("ui:pause", () => play("uiBack", undefined, { volume: 0.6 }));
  on<RacerPayload>("ui:resume", () => play("uiSelect", undefined, { volume: 0.6 }));

  // -------------------------------------------------------------------------
  // Crowd
  // -------------------------------------------------------------------------
  /** The grandstands are at the start/finish line; cache the point once. */
  let standPoint: Vec3Like | null = null;
  let lastCheer = -99;

  function standsAt(): Vec3Like | null {
    if (standPoint) return standPoint;
    const track = ctx.services.track;
    if (!track) return null;
    try {
      const f = track.frameAt(0);
      // A few metres off the racing line and up in the seats, so the cheer
      // arrives from the stands rather than from under the kart.
      standPoint = {
        x: f.position.x - f.right.x * 22 + f.up.x * 6,
        y: f.position.y + 6,
        z: f.position.z - f.right.z * 22 + f.up.z * 6,
      };
    } catch {
      standPoint = null;
    }
    return standPoint;
  }

  function cheer(intensity: number): void {
    if (ctx.elapsed - lastCheer < 2.2) return;
    lastCheer = ctx.elapsed;
    play("cheer", standsAt() ?? undefined, { volume: 0.5 + intensity * 0.6, rate: 0.95 + intensity * 0.12 });
  }

  /** A swell as the player barrels past the grandstands at speed. */
  function crowdProximity(p: RacerLike | null): void {
    if (!p) return;
    const point = standsAt();
    if (!point) return;
    const dx = p.position.x - point.x;
    const dz = p.position.z - point.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 55 * 55) return;
    if (Math.abs(p.speed) < 8) return;
    cheer(0.35 + clamp01(Math.abs(p.speed) / 28) * 0.4);
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------
  const rivalScratch: EngineRacer[] = [];
  let starOn = false;

  function toEngineRacer(r: RacerLike): EngineRacer {
    return {
      id: r.id,
      speed: r.speed ?? 0,
      maxSpeed: r.maxSpeed ?? 28,
      rpm: r.rpm ?? 0,
      boost: r.boost ?? 0,
      grounded: r.grounded !== false,
      stun: r.stun ?? 0,
      position: r.position,
    };
  }

  function toTyreState(r: RacerLike): TyreState {
    return {
      speed: r.speed ?? 0,
      maxSpeed: r.maxSpeed ?? 28,
      surface: (r.surface as SurfaceKind) ?? "road",
      drifting: !!r.drifting,
      driftCharge: r.driftCharge ?? 0,
      // Physics publishes a real slip angle; without it, a drift is our only cue.
      slip: Math.abs(r.slipAngle ?? (r.drifting ? 0.35 : 0)),
      grounded: r.grounded !== false && (r.airTime ?? 0) < 0.05,
    };
  }

  function lateUpdate(dt: number): void {
    if (dead) return;
    const g = graph;
    if (!g) return;
    if (g.ac.state !== "running") return;

    // The camera system runs its lateUpdate after ours, so this pose is one
    // frame old. At a 30 ms glide that is entirely inaudible, and it saves
    // fighting over system order.
    ctx.camera.updateMatrixWorld();
    updateListener(g, ctx.camera.matrixWorld.elements);

    musicRig?.update();

    if (muted || hidden) {
      // Still run the sequencer (so the music does not restart on unmute) but
      // let the continuous rigs idle down to nothing.
      engineRig?.player(null, dt);
      tyreRig?.update(null, dt);
      return;
    }

    const driven = drivenAt === ctx.elapsed ? (drivenRacer as RacerLike | null) : null;
    const you = driven ?? player();

    if (you) {
      engineRig?.player(toEngineRacer(you), dt);
      tyreRig?.update(toTyreState(you), dt);
      crowdProximity(you);

      const star = (you.star ?? 0) > 0;
      if (star !== starOn) {
        starOn = star;
        musicRig?.setStar(star);
      }
    } else {
      engineRig?.player(null, dt);
      tyreRig?.update(null, dt);
    }

    if (engineRig) {
      rivalScratch.length = 0;
      for (const r of racers()) {
        if (you && r.id === you.id) continue;
        if (r.finished && r.speed === 0) continue;
        rivalScratch.push(toEngineRacer(r));
      }
      const cam = ctx.camera.position;
      engineRig.rivals(rivalScratch, cam, dt);
    }

    drivenRacer = null;
  }

  return {
    lateUpdate(dt) {
      try {
        lateUpdate(dt);
      } catch (err) {
        // One bad frame must not take the audio system down for the race.
        console.warn("[Vibe Kart] audio frame failed:", err);
      }
    },
    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      if (typeof window !== "undefined") {
        for (const e of gestureEvents) window.removeEventListener(e, onGesture);
      }
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      musicRig?.dispose();
      tyreRig?.dispose();
      engineRig?.dispose();
      bank?.dispose();
      if (graph) disposeGraph(graph);
      graph = null;
      bank = null;
      engineRig = null;
      tyreRig = null;
      musicRig = null;
      dead = true;
      if (ctx.services.audio === service) delete ctx.services.audio;
    },
  };
}
