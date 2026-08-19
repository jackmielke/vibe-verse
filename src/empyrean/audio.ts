/**
 * THE EMPYREAN — what the place sounds like.
 *
 * Everything here is made out of oscillators, noise buffers written a sample
 * at a time, and biquads. There are no files, no fetches and no decode step,
 * which is the same argument the rest of this world makes about its geometry:
 * a city that generates six hundred buildings and then waits four megabytes
 * for a whoosh has thrown the argument away.
 *
 * ## The shape of it
 *
 * One `AudioContext`, created inside the first user gesture and never before,
 * because a context built at load sits `suspended` forever while everything
 * downstream silently does nothing and the console fills with autoplay
 * warnings. `buildAudio()` therefore allocates *nothing* — it hands back a
 * handle whose `update()` is a no-op until `resume()` is called.
 *
 * Under the master there are six buses and two kinds of voice:
 *
 * ```
 *                            ┌ wind        ── speed × exposure × altitude
 *                            ├ jet         ── ignition, roar, tail
 *   master → limiter → out ──┼ bed         ── the five districts, cross-faded
 *                            ├ positional  ── 8 pooled panner slots
 *                            ├ oneshot     ── steps, clatter, birds, coins
 *                            └ music       ── the pad and the arpeggio
 *                                 ↘ reverb send (an impulse we generate)
 * ```
 *
 * **Every voice is permanent.** The tone pool, the percussion pool and the
 * panner pool are built once and retriggered by scheduling envelopes on gains
 * that already exist. **The frame path creates no audio node of any kind**,
 * so a busy minute in the Bazaar cannot turn into a three-hundred-node graph
 * and a mount/unmount cycle gives back exactly what it took.
 * `src/test/empyreanAudio.test.ts` counts node constructions across twenty
 * thousand simulated frames and fails if the number moves at all.
 *
 * **Positional sources are pooled and stolen by distance.** There are eleven
 * things in the city that make a noise from a fixed place — the fountain, the
 * market hall, the beacon, the observatory, the launch terrace, the tram
 * station, four crowd spots around the bazaar ring and the tram itself — and
 * eight `PannerNode` slots to play them through. The nearest eight win. That
 * ranking runs at 10 Hz, not per frame.
 *
 * ## Why the districts are the point
 *
 * The test that matters is not a unit test: stand still in a street with your
 * eyes shut and you should know which district you are in. So the five bands
 * of `cityplan.ts` each get their own texture and their own scheduled
 * incidents, cross-faded by radius so walking out of the Bazaar and into the
 * Terraces is a slow substitution of crowd for leaves rather than a switch.
 * `ctx.daylight` thins the crowd and swaps the Terraces' birds for wind
 * chimes after dark; nothing ever goes to zero, because a city that falls
 * silent at night reads as broken rather than as late.
 *
 * ## Volume
 *
 * Deliberately quiet. The loudest thing in the mix is the wind at full tilt
 * over the lake, at about a third of full scale, and the music sits under
 * everything at a tenth. The bar is that somebody can leave this open in a
 * tab for an hour, which is a much harder bar than sounding good for ten
 * seconds, and it is met by turning things down rather than by adding fewer
 * of them.
 */
import * as THREE from "three";
import type { BuildContext, FrameContext, System } from "./types";
import { ISLAND_Y, PLATEAU_R } from "./config";
import { DISTRICTS, LANDMARKS, RING_R, surfaceAt } from "./cityplan";

/* ==================================================================== *
 * The public API
 * ==================================================================== */

/** Everything the rest of the world can ask the soundtrack for. */
export interface AudioHandle extends System {
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  /** Called on the first real user gesture. */
  resume(): void;
  /** One-shots the rest of the world fires. */
  event(
    kind: "land" | "jump" | "jetOn" | "jetOff" | "coin" | "ring" | "pickup" | "deliver" | "photo" | "ui",
    strength?: number,
  ): void;
  /** Optional positional hint from another system, e.g. the tram. */
  setTram(x: number, y: number, z: number, active: boolean): void;
  /**
   * Live voice census. Test-only, and the honest way to assert the pools are
   * pools: these numbers are fixed at build and must never grow.
   */
  readonly voices: VoiceCensus;
}

export interface VoiceCensus {
  /** Panner slots that exist. Never more than `MAX_POSITIONAL_VOICES`. */
  positional: number;
  /** Panner slots currently assigned to an emitter. */
  positionalActive: number;
  tone: number;
  perc: number;
  /** Emitters competing for the positional slots. */
  emitters: number;
}

/** One-shot kinds `event()` understands. Anything else is ignored. */
export type AudioEvent = Parameters<AudioHandle["event"]>[0];

/* ==================================================================== *
 * Budgets
 * ==================================================================== */

/**
 * Panner slots. Eight, not eleven: the point of a pool is that adding a
 * twelfth noisy thing to the city costs nothing, and the only way to keep
 * that true is to make the pool smaller than the cast from the start.
 */
export const MAX_POSITIONAL_VOICES = 8;
/** Retriggerable pitched voices — plucks, bells, birds, coins. */
export const MAX_TONE_VOICES = 8;
/** Retriggerable noise voices — footsteps, clatter, thumps, creaks. */
export const MAX_PERC_VOICES = 8;

/** The low tier halves the pools and drops the convolver. */
const LOW = { pos: 5, tone: 5, perc: 5 } as const;

/** Where the mute flag lives between sessions. */
const MUTE_KEY = "empyrean.muted";

/**
 * Full-scale master.
 *
 * Under one on purpose. Everything downstream is mixed against this number,
 * and the brief is a tab somebody leaves open for an hour rather than a demo
 * somebody watches for ten seconds.
 */
const MASTER_LEVEL = 0.85;

/* ==================================================================== *
 * The curves — pure, testable, and where the feel actually lives
 * ==================================================================== */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * How far from any shelter you are, in metres.
 *
 * Height above the deck and height above whatever is under you are different
 * numbers — over the lake you are twenty metres *below* the deck and six
 * hundred above the ice — and for weather purposes the bigger one wins.
 */
export function skyOpenness(y: number, altitude: number): number {
  const overDeck = y - ISLAND_Y;
  return overDeck > altitude ? overDeck : altitude;
}

/**
 * 0..1: how much of the sky can reach you here.
 *
 * This is the whole of the "wind gets quiet in a street" effect, and it is
 * faked entirely from `surfaceAt` and the radius. A street between two glass
 * towers in the Spires is a canyon; the rim promenade has four hundred metres
 * of nothing on one side of it; forty metres up there is nothing between you
 * and the weather at all.
 */
export function exposureAt(x: number, z: number, y: number, altitude: number): number {
  const open = skyOpenness(y, altitude);
  const hit = surfaceAt(x, z);
  if (hit.kind === "void") return 1;

  let shelter: number;
  switch (hit.kind) {
    case "plaza":
      shelter = 0.46;
      break;
    case "road":
      shelter = 0.3;
      break;
    case "walk":
      shelter = 0.26;
      break;
    case "lot":
      shelter = 0.22;
      break;
    case "promenade":
      shelter = 0.8;
      break;
    default:
      // parapet — you are leaning on the edge of the world.
      shelter = 0.88;
      break;
  }

  // Fewer things upwind of you the closer you get to the rim.
  const r = Math.hypot(x, z);
  const radial = 0.62 + 0.38 * Math.min(1, r / PLATEAU_R);
  const street = Math.min(1, shelter * radial);

  // Out of the canyon: above roof height there is nothing in the way.
  return street + (1 - street) * smoothstep(8, 74, open);
}

/**
 * How loud the wind is.
 *
 * The two ends the brief names: standing in a street it is 0.02 and you would
 * not describe it as a sound; at cruise over the lake it is the loudest thing
 * in the mix by a factor of ten. Speed does most of the work, exposure gates
 * all of it, and altitude adds a floor so that hanging motionless at six
 * hundred metres still has air in it.
 */
export function windGain(speed: number, exposure: number, openness: number): number {
  const s = Math.min(1.25, Math.max(0, speed) / 34);
  const high = clamp01((openness - 60) / 420);
  const drive = 0.052 + 0.3 * Math.pow(s, 1.45) + 0.055 * high;
  return Math.min(0.36, 0.01 + clamp01(exposure) * drive);
}

/** Centre of the wind's whistle band, Hz. Rises hard with airspeed. */
export function windTone(speed: number): number {
  return 340 + Math.min(1.3, Math.max(0, speed) / 34) * 1150;
}

/**
 * The jetpack roar, gated by throttle.
 *
 * Nowhere near linear: a touch of throttle to stop falling should be audible
 * but not an event, and holding it wide open should be. `^1.35` is the curve
 * that makes a hover feel like a hover.
 */
export function jetGain(burn: number): number {
  const b = clamp01(burn);
  return b <= 0 ? 0 : 0.02 + Math.pow(b, 1.35) * 0.15;
}

/** Seconds between footfalls. Infinity when you are not going anywhere. */
export function strideSeconds(speed: number): number {
  if (speed < 0.6) return Infinity;
  return Math.max(0.26, Math.min(0.72, 0.66 - speed * 0.024));
}

/**
 * A run of coins plays a phrase rather than the same ping eight times.
 *
 * Major pentatonic, up over six, then home — so however many you find in a
 * row it never climbs out of hearing and it always sounds like it meant to
 * end where it ended.
 */
const COIN_RUN = [0, 2, 4, 7, 9, 12, 14, 16];

export function coinSemitone(n: number): number {
  const i = Math.max(0, Math.floor(n)) % (COIN_RUN.length + 1);
  return i === COIN_RUN.length ? COIN_RUN[0] : COIN_RUN[i];
}

/**
 * How much of the city is still around you.
 *
 * Falls off outward past the rim and upward past roof height, so climbing out
 * of the city is a thing you can hear happening rather than a cliff.
 */
export function cityPresence(radius: number, y: number, altitude: number): number {
  const radial = 1 - smoothstep(PLATEAU_R * 0.9, PLATEAU_R + 280, radius);
  const open = skyOpenness(y, altitude);
  const vert = open >= 0 ? 1 - smoothstep(45, 360, open) : 1 - smoothstep(12, 150, -open);
  return radial * vert;
}

/**
 * Weight of each district at a radius, in `DISTRICTS` order, normalised.
 *
 * Feathered by 26 m at every boundary, which is about eight paces: enough
 * that a step across a ring road is a fade and not a cut, small enough that
 * standing in the middle of the Bazaar you are hearing the Bazaar and not an
 * average of the whole island.
 *
 * `out` is supplied by the caller and written in place — this runs on the
 * 10 Hz tick and must not allocate.
 */
export function districtMix(radius: number, out: number[] | Float64Array): void {
  const FEATHER = 26;
  let sum = 0;
  for (let i = 0; i < DISTRICTS.length; i++) {
    const d = DISTRICTS[i];
    const lo = d.r0 <= 0 ? 1 : smoothstep(d.r0 - FEATHER, d.r0 + FEATHER, radius);
    const hi = 1 - smoothstep(d.r1 - FEATHER, d.r1 + FEATHER, radius);
    const w = Math.min(lo, hi);
    out[i] = w;
    sum += w;
  }
  if (sum <= 1e-4) {
    // Past the rim: everything belongs to the outermost band.
    for (let i = 0; i < DISTRICTS.length; i++) out[i] = i === DISTRICTS.length - 1 ? 1 : 0;
    return;
  }
  for (let i = 0; i < DISTRICTS.length; i++) out[i] /= sum;
}

/**
 * What the dark does to a layer.
 *
 * Crowds go home, birds go quiet, machinery does not care and gets slightly
 * more noticeable for the room the others left. Nothing reaches zero.
 */
export function nightScale(daylight: number, layer: "crowd" | "birds" | "machine" | "air"): number {
  const d = clamp01(daylight);
  switch (layer) {
    case "crowd":
      return 0.3 + 0.7 * d;
    case "birds":
      return 0.12 + 0.88 * d;
    case "machine":
      return 1.05 - 0.25 * d;
    default:
      return 1;
  }
}

/* ==================================================================== *
 * Legacy shim
 * ==================================================================== */

/**
 * The old three-number interface `world.ts` still calls.
 *
 * @deprecated Move to `buildAudio()` + `handle.update(frameContext)`. This
 * path knows your speed, your throttle and your height and nothing else, so
 * it can drive the wind, the jets, the music and the mute — but it has no
 * idea where you are standing, and therefore stands you in the middle of the
 * Halo and plays you the Halo. Everything interesting in this file is behind
 * the `FrameContext` version.
 */
export interface EmpyreanAudio {
  /** @param speed m/s, @param burn 0..1 throttle, @param y world height */
  update(speed: number, burn: number, y: number): void;
  setMuted(muted: boolean): void;
  resume(): void;
  dispose(): void;
}

/* ==================================================================== *
 * Internals
 * ==================================================================== */

type Ctor = typeof AudioContext;

function audioCtor(): Ctor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext;
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    /* private mode, blocked storage, a browser with opinions */
    return false;
  }
}

function writeMuted(m: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* not being able to remember is not a reason to fail */
  }
}

/**
 * Everything the mix needs to know, as one struct that is written in place.
 *
 * Both entry points — the `FrameContext` one and the legacy shim — fill this
 * and hand it to the same `drive()`, so there is one implementation of the
 * mix and two ways to feed it.
 */
interface Drive {
  dt: number;
  x: number;
  y: number;
  z: number;
  speed: number;
  groundSpeed: number;
  vy: number;
  burn: number;
  grounded: boolean;
  altitude: number;
  daylight: number;
  /** Camera, for the listener. Zeroed forward means "use the player". */
  camX: number;
  camY: number;
  camZ: number;
  fwdX: number;
  fwdY: number;
  fwdZ: number;
  upX: number;
  upY: number;
  upZ: number;
}

interface ToneVoice {
  a: OscillatorNode;
  b: OscillatorNode;
  bGain: GainNode;
  env: GainNode;
  pan: StereoPannerNode | null;
  free: number;
}

interface PercVoice {
  filter: BiquadFilterNode;
  env: GainNode;
  pan: StereoPannerNode | null;
  free: number;
}

interface Slot {
  input: GainNode;
  air: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  owner: number;
}

interface Emitter {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Beyond this it is not worth a slot. */
  radius: number;
  ref: number;
  priority: number;
  active: boolean;
  /** Target gain for this frame, 0..1. */
  level: number;
  out: GainNode;
  slot: number;
}

/* -------------------------------------------------------------------- *
 * Buffers we write by hand
 * -------------------------------------------------------------------- */

/** Pink-ish noise: a one-pole on white. Wind has this spectrum; white does not. */
function pinkBuffer(ac: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.045 * w) / 1.045;
    d[i] = last * 3.2;
  }
  return buf;
}

/** Flat white, for transients that need teeth. */
function whiteBuffer(ac: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Brown, for the bottom of the wind and the bottom of the jets. */
function brownBuffer(ac: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.018 * (Math.random() * 2 - 1)) / 1.018;
    d[i] = last * 5.2;
  }
  return buf;
}

/**
 * A room, generated.
 *
 * Exponentially decaying noise with a handful of early reflections stamped
 * into the first eighty milliseconds. It is not a real space and it is not
 * pretending to be one; it is the difference between a footstep on a plaza
 * and a footstep in a vacuum.
 */
function plateBuffer(ac: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(2, n, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * 0.55;
    }
    // Early reflections, offset per channel so the room has a width.
    const taps = [0.011, 0.019, 0.029, 0.041, 0.057, 0.073];
    for (let k = 0; k < taps.length; k++) {
      const i = Math.floor((taps[k] + c * 0.004) * ac.sampleRate);
      if (i < n) d[i] += (k % 2 ? -1 : 1) * (0.5 - k * 0.06);
    }
  }
  return buf;
}

/* ==================================================================== *
 * buildAudio
 * ==================================================================== */

/**
 * Build the soundtrack, or `null` on a browser with no Web Audio.
 *
 * Nothing is created here — no context, no nodes, no buffers. The handle is
 * inert until `resume()`, which the page must call from a real user gesture.
 * Every caller must cope with `null`, and every method on the handle is safe
 * to call before `resume()` and after `dispose()`.
 */
export function buildAudio(buildCtx: BuildContext): AudioHandle | null {
  const Ctor = audioCtor();
  const group = new THREE.Group();
  group.name = "audio";
  if (!Ctor) return null;

  const high = buildCtx.quality !== "low";
  const POS_N = high ? MAX_POSITIONAL_VOICES : LOW.pos;
  const TONE_N = high ? MAX_TONE_VOICES : LOW.tone;
  const PERC_N = high ? MAX_PERC_VOICES : LOW.perc;

  let muted = readMuted();
  let disposed = false;
  let ac: AudioContext | null = null;

  /* ---- everything below is null until the first gesture ---------------- */
  let master: GainNode;
  let windLowGain: GainNode;
  let windHighGain: GainNode;
  let windHighFilter: BiquadFilterNode;
  let windLowFilter: BiquadFilterNode;
  let jetGainNode: GainNode;
  let jetFilter: BiquadFilterNode;
  let jetAirGain: GainNode;
  let jetSubGain: GainNode;
  let jetSub: OscillatorNode;
  let jetSubFilter: BiquadFilterNode;
  let bedBus: GainNode;
  let posBus: GainNode;
  let oneShotBus: GainNode;
  let musicBus: GainNode;
  let padFilter: BiquadFilterNode;
  let padOsc: OscillatorNode[] = [];
  let padGain: GainNode[] = [];
  let bedGain: GainNode[] = [];
  let coreHum: OscillatorNode[] = [];
  /** The tram's own two oscillators, so the doppler detune can find them. */
  let tramOsc: OscillatorNode[] = [];
  let lfos: OscillatorNode[] = [];
  let noiseSrc: AudioBufferSourceNode[] = [];
  let tone: ToneVoice[] = [];
  let perc: PercVoice[] = [];
  let slots: Slot[] = [];
  let emitters: Emitter[] = [];
  let started = false;

  /* ---- scratch, allocated once ---------------------------------------- */
  const mix = new Float64Array(DISTRICTS.length);
  const bedLevel = new Float64Array(DISTRICTS.length);
  const chosen = new Int8Array(32);
  const drive: Drive = {
    dt: 0.016,
    x: 0,
    y: ISLAND_Y,
    z: 0,
    speed: 0,
    groundSpeed: 0,
    vy: 0,
    burn: 0,
    grounded: true,
    altitude: 0,
    daylight: 0.5,
    camX: 0,
    camY: ISLAND_Y + 2,
    camZ: 6,
    fwdX: 0,
    fwdY: 0,
    fwdZ: -1,
    upX: 0,
    upY: 1,
    upZ: 0,
  };

  const census: VoiceCensus = {
    positional: 0,
    positionalActive: 0,
    tone: 0,
    perc: 0,
    emitters: 0,
  };

  /* ---- running state --------------------------------------------------- */
  let tickAccum = 0;
  let stepPhase = 0;
  let stepFoot = 0;
  let prevGroundSpeed = 0;
  let scuffCooldown = 0;
  let landCooldown = 0;
  let wasGrounded = true;
  let wasBurning = false;
  let exposure = 0.3;
  let presence = 1;
  let coinRun = 0;
  let coinRunAt = -99;
  let toneCursor = 0;
  let percCursor = 0;
  let duck = 1;

  /* ---- scheduler clocks (audio time, seconds) -------------------------- */
  let nextChordAt = 0;
  let chordIndex = 0;
  let nextArpAt = 0;
  let nextClatterAt = 0;
  let nextBirdAt = 0;
  let nextCreakAt = 0;
  let nextGlassAt = 0;

  /* ---- the tram, if anybody hands it to us ----------------------------- */
  let tramX = 0;
  let tramY = ISLAND_Y;
  let tramZ = 0;
  let tramActive = false;
  let tramPrevDist = 0;

  /* -------------------------------------------------------------------- *
   * The music
   * -------------------------------------------------------------------- */

  /**
   * D — A — Bm — G, voiced so that almost nothing moves between chords.
   *
   * It is the most unambiguously hopeful four bars in Western music and there
   * is no point being coy about it: the brief says optimistic, and a suspended
   * chord that never resolves — which is what this file used to play — reads
   * as *pensive*, which is a different and much colder feeling.
   */
  const CHORDS = [
    [73.42, 110.0, 146.83, 185.0, 220.0, 329.63], // D2 A2 D3 F#3 A3 E4
    [82.41, 110.0, 164.81, 220.0, 277.18, 329.63], // E2 A2 E3 A3 C#4 E4
    [61.74, 123.47, 146.83, 185.0, 246.94, 293.66], // B1 B2 D3 F#3 B3 D4
    [98.0, 123.47, 146.83, 196.0, 246.94, 293.66], // G2 B2 D3 G3 B3 D4
  ];

  /** Five notes per chord for the arpeggio to wander around in. */
  const ARP = [
    [587.33, 739.99, 880.0, 1108.73, 1174.66],
    [659.26, 830.61, 987.77, 1108.73, 1318.51],
    [587.33, 739.99, 987.77, 1174.66, 1479.98],
    [587.33, 783.99, 987.77, 1174.66, 1567.98],
  ];

  /** Seconds a chord is held. Slow on purpose — this is a place, not a track. */
  const CHORD_SECONDS = 9.5;

  /* -------------------------------------------------------------------- *
   * Small helpers over the graph
   * -------------------------------------------------------------------- */

  const ramp = (p: AudioParam, v: number, tc: number): void => {
    try {
      p.setTargetAtTime(v, ac!.currentTime, tc);
    } catch {
      /* a param that refuses a ramp still takes a value */
      try {
        p.value = v;
      } catch {
        /* nothing more to do */
      }
    }
  };

  const at = (p: AudioParam, v: number, t: number): void => {
    try {
      p.setValueAtTime(v, t);
    } catch {
      /* ignore */
    }
  };

  const glide = (p: AudioParam, v: number, t: number, secs: number): void => {
    try {
      p.linearRampToValueAtTime(v, t + secs);
    } catch {
      /* ignore */
    }
  };

  const expTo = (p: AudioParam, v: number, t: number): void => {
    try {
      p.exponentialRampToValueAtTime(Math.max(1e-4, v), t);
    } catch {
      /* ignore */
    }
  };

  const gainNode = (v: number): GainNode => {
    const g = ac!.createGain();
    g.gain.value = v;
    return g;
  };

  const filterNode = (type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode => {
    const f = ac!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  };

  const stereoPan = (): StereoPannerNode | null => {
    try {
      const p = ac!.createStereoPanner();
      return p ?? null;
    } catch {
      return null;
    }
  };

  /** A looping source on a buffer, started immediately. Returns the node. */
  const loopSource = (buf: AudioBuffer, rate: number): AudioBufferSourceNode => {
    const s = ac!.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    try {
      s.playbackRate.value = rate;
    } catch {
      /* ignore */
    }
    try {
      s.start();
    } catch {
      /* a source that will not start is not worth a broken world */
    }
    noiseSrc.push(s);
    return s;
  };

  /** An LFO, running forever, scaled into `depth`. */
  const lfo = (hz: number, depth: number): GainNode => {
    const o = ac!.createOscillator();
    o.type = "sine";
    o.frequency.value = hz;
    const g = gainNode(depth);
    o.connect(g);
    try {
      o.start();
    } catch {
      /* ignore */
    }
    lfos.push(o);
    return g;
  };

  /* -------------------------------------------------------------------- *
   * Voice pools
   * -------------------------------------------------------------------- */

  /**
   * A pitched hit: fundamental plus one partial, an envelope, and an optional
   * glide for birdsong. Voices are permanent; this only writes automation.
   */
  const ping = (
    when: number,
    freq: number,
    gain: number,
    decay: number,
    opts: {
      attack?: number;
      partial?: number;
      partialGain?: number;
      pan?: number;
      type?: OscillatorType;
      glideTo?: number;
      glideSecs?: number;
    },
  ): void => {
    if (!started || muted || tone.length === 0) return;
    const now = ac!.currentTime;
    const t = when < now ? now : when;
    // Round-robin, but skip anything still ringing if there is a quiet one.
    let v = tone[toneCursor % tone.length];
    for (let k = 0; k < tone.length; k++) {
      const cand = tone[(toneCursor + k) % tone.length];
      if (cand.free <= t) {
        v = cand;
        toneCursor = (toneCursor + k + 1) % tone.length;
        break;
      }
    }
    v.free = t + decay;
    const attack = opts.attack ?? 0.006;
    v.a.type = opts.type ?? "sine";
    at(v.a.frequency, freq, t);
    if (opts.glideTo) glide(v.a.frequency, opts.glideTo, t, opts.glideSecs ?? 0.09);
    at(v.b.frequency, freq * (opts.partial ?? 2.01), t);
    at(v.bGain.gain, opts.partialGain ?? 0.28, t);
    if (v.pan) at(v.pan.pan, opts.pan ?? 0, t);
    try {
      v.env.gain.cancelScheduledValues(t);
    } catch {
      /* ignore */
    }
    at(v.env.gain, 0.0001, t);
    expTo(v.env.gain, Math.max(1e-4, gain), t + attack);
    expTo(v.env.gain, 0.0001, t + decay);
  };

  /**
   * A noise hit: one band of the shared noise, shaped and swept.
   *
   * Every footstep, every market clang, every creak in the rim and the landing
   * thump come out of this one function with different numbers in it, which is
   * the whole reason the pool can be eight voices wide.
   */
  const hit = (
    when: number,
    freq: number,
    q: number,
    gain: number,
    decay: number,
    opts: { type?: BiquadFilterType; sweepTo?: number; pan?: number; attack?: number },
  ): void => {
    if (!started || muted || perc.length === 0) return;
    const now = ac!.currentTime;
    const t = when < now ? now : when;
    let v = perc[percCursor % perc.length];
    for (let k = 0; k < perc.length; k++) {
      const cand = perc[(percCursor + k) % perc.length];
      if (cand.free <= t) {
        v = cand;
        percCursor = (percCursor + k + 1) % perc.length;
        break;
      }
    }
    v.free = t + decay;
    v.filter.type = opts.type ?? "bandpass";
    at(v.filter.frequency, freq, t);
    if (opts.sweepTo) expTo(v.filter.frequency, opts.sweepTo, t + decay);
    at(v.filter.Q, q, t);
    if (v.pan) at(v.pan.pan, opts.pan ?? 0, t);
    try {
      v.env.gain.cancelScheduledValues(t);
    } catch {
      /* ignore */
    }
    at(v.env.gain, 0.0001, t);
    expTo(v.env.gain, Math.max(1e-4, gain), t + (opts.attack ?? 0.004));
    expTo(v.env.gain, 0.0001, t + decay);
  };

  /* -------------------------------------------------------------------- *
   * Building the graph — once, inside the first gesture
   * -------------------------------------------------------------------- */

  function createGraph(): boolean {
    // `a` rather than `ac` throughout the builder: `ac` is a `let` that
    // `dispose()` sets to null, so a local const is both narrower for the
    // type checker and impossible to have pulled out from under us halfway.
    let a: AudioContext;
    try {
      a = new Ctor!();
    } catch {
      return false;
    }
    ac = a;
    try {
      // The context is meant to be created inside the gesture that resumes
      // it, so it should already be suspended. Belt and braces: a context we
      // have *asked* to suspend cannot surprise us with an autoplay warning.
      if (a.state === "running") void a.suspend();
    } catch {
      /* Safari will not always suspend on demand; harmless */
    }

    try {
      master = gainNode(0);
      let tail: AudioNode = master;
      try {
        const comp = a.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 18;
        comp.ratio.value = 6;
        comp.attack.value = 0.006;
        comp.release.value = 0.22;
        master.connect(comp);
        tail = comp;
      } catch {
        /* no compressor is a mix decision, not a failure */
      }
      tail.connect(a.destination);

      /* ---- reverb send ------------------------------------------------- */
      let verb: GainNode | null = null;
      if (high) {
        try {
          const conv = a.createConvolver();
          conv.buffer = plateBuffer(a, 1.9);
          const wet = gainNode(0.5);
          conv.connect(wet).connect(master);
          verb = gainNode(1);
          verb.connect(conv);
        } catch {
          verb = null;
        }
      }

      /* ---- buses ------------------------------------------------------- */
      const windBus = gainNode(1);
      windBus.connect(master);
      const jetBus = gainNode(1);
      jetBus.connect(master);
      bedBus = gainNode(1);
      bedBus.connect(master);
      posBus = gainNode(1);
      posBus.connect(master);
      oneShotBus = gainNode(1);
      oneShotBus.connect(master);
      musicBus = gainNode(0.1);
      musicBus.connect(master);
      if (verb) {
        const sendOne = gainNode(0.22);
        oneShotBus.connect(sendOne).connect(verb);
        const sendPos = gainNode(0.16);
        posBus.connect(sendPos).connect(verb);
        const sendMusic = gainNode(0.3);
        musicBus.connect(sendMusic).connect(verb);
      }

      /* ---- shared noise ------------------------------------------------ */
      const pink = pinkBuffer(a, 3);
      const white = whiteBuffer(a, 2);
      const brown = brownBuffer(a, 3);
      // Slightly detuned copies so two things fed by "the same" noise do not
      // phase-lock into a single audible pattern.
      const pinkA = loopSource(pink, 1);
      const pinkB = loopSource(pink, 0.83);
      const whiteA = loopSource(white, 1);
      const whiteB = loopSource(white, 1.17);
      const brownA = loopSource(brown, 1);

      /* ---- gust: the one modulator the whole weather shares ------------- */
      const gustSum = gainNode(1);
      lfo(0.055, 1).connect(gustSum);
      lfo(0.137, 0.55).connect(gustSum);
      lfo(0.31, 0.2).connect(gustSum);

      /* ---- wind -------------------------------------------------------- */
      windLowFilter = filterNode("lowpass", 260, 0.8);
      windLowGain = gainNode(0.01);
      brownA.connect(windLowFilter).connect(windLowGain).connect(windBus);

      windHighFilter = filterNode("bandpass", 420, 0.75);
      windHighGain = gainNode(0.008);
      pinkA.connect(windHighFilter).connect(windHighGain).connect(windBus);
      // The gust rides the whistle, not the rumble: rumble is the pressure and
      // the whistle is the weather moving through something.
      const gustDepth = gainNode(0.02);
      gustSum.connect(gustDepth).connect(windHighGain.gain);
      const gustTone = gainNode(140);
      gustSum.connect(gustTone).connect(windHighFilter.frequency);

      /* ---- jets -------------------------------------------------------- */
      jetFilter = filterNode("lowpass", 520, 1.3);
      jetGainNode = gainNode(0);
      brownA.connect(jetFilter).connect(jetGainNode).connect(jetBus);

      const jetAir = filterNode("bandpass", 2600, 1.1);
      jetAirGain = gainNode(0);
      whiteA.connect(jetAir).connect(jetAirGain).connect(jetBus);

      jetSub = a.createOscillator();
      jetSub.type = "sawtooth";
      jetSub.frequency.value = 56;
      jetSubFilter = filterNode("lowpass", 170, 1.1);
      jetSubGain = gainNode(0);
      jetSub.connect(jetSubFilter).connect(jetSubGain).connect(jetBus);
      try {
        jetSub.start();
      } catch {
        /* ignore */
      }

      /* ---- the five beds ----------------------------------------------- */
      bedGain = [];
      for (let i = 0; i < DISTRICTS.length; i++) bedGain.push(gainNode(0));
      for (const g of bedGain) g.connect(bedBus);

      // 0 halo — an open, reverberant hush with the whole city blurred into it.
      {
        const f = filterNode("bandpass", 620, 0.4);
        const g = gainNode(0.5);
        pinkB.connect(f).connect(g).connect(bedGain[0]);
        const shimmer = filterNode("highpass", 5200, 0.7);
        const sg = gainNode(0.05);
        whiteB.connect(shimmer).connect(sg).connect(bedGain[0]);
      }

      // 1 core / The Spires — glass and machinery, low and unhurried.
      {
        for (const hz of [61.7, 92.6]) {
          const o = a.createOscillator();
          o.type = "sine";
          o.frequency.value = hz;
          const g = gainNode(0.16);
          o.connect(g).connect(bedGain[1]);
          try {
            o.start();
          } catch {
            /* ignore */
          }
          coreHum.push(o);
        }
        const mach = filterNode("bandpass", 235, 4.5);
        const mg = gainNode(0.26);
        pinkA.connect(mach).connect(mg).connect(bedGain[1]);
        // Slowly wandering, so it never becomes a test tone.
        lfo(0.041, 9).connect(mach.frequency);
      }

      // 2 market / The Bazaar — a room full of people talking at once.
      {
        const murmur = filterNode("bandpass", 500, 0.85);
        const mg = gainNode(0.62);
        pinkB.connect(murmur).connect(mg).connect(bedGain[2]);
        const body = filterNode("lowpass", 220, 0.7);
        const bg = gainNode(0.2);
        brownA.connect(body).connect(bg).connect(bedGain[2]);
        // Two incommensurate wobbles: the crowd swells and never repeats.
        const swell = gainNode(1);
        lfo(0.11, 1).connect(swell);
        lfo(0.37, 0.45).connect(swell);
        const depth = gainNode(0.13);
        swell.connect(depth).connect(mg.gain);
        const colour = gainNode(70);
        swell.connect(colour).connect(murmur.frequency);
      }

      // 3 gardens / The Terraces — leaves, moved by the same gust as the wind.
      {
        const leaves = filterNode("bandpass", 3100, 0.6);
        const lg = gainNode(0.16);
        whiteB.connect(leaves).connect(lg).connect(bedGain[3]);
        const depth = gainNode(0.12);
        gustSum.connect(depth).connect(lg.gain);
        const under = filterNode("bandpass", 700, 0.5);
        const ug = gainNode(0.12);
        pinkA.connect(under).connect(ug).connect(bedGain[3]);
      }

      // 4 rim — air, and something structural taking the strain.
      {
        const air = filterNode("bandpass", 900, 0.35);
        const ag = gainNode(0.2);
        pinkB.connect(air).connect(ag).connect(bedGain[4]);
        const deep = filterNode("lowpass", 120, 1.4);
        const dg = gainNode(0.22);
        brownA.connect(deep).connect(dg).connect(bedGain[4]);
        const depth = gainNode(0.09);
        gustSum.connect(depth).connect(ag.gain);
      }

      /* ---- the pad ----------------------------------------------------- */
      padFilter = filterNode("lowpass", 900, 0.6);
      padFilter.connect(musicBus);
      const chord = CHORDS[0];
      for (let i = 0; i < 6; i++) {
        const o = a.createOscillator();
        o.type = i < 2 ? "sine" : "triangle";
        o.frequency.value = chord[i];
        // Detune the upper voices a hair so the chord beats slowly instead of
        // sitting there like an organ.
        try {
          o.detune.value = i < 2 ? 0 : (i % 2 ? 4 : -4);
        } catch {
          /* ignore */
        }
        const g = gainNode(i < 2 ? 0.16 : 0.1);
        o.connect(g).connect(padFilter);
        try {
          o.start();
        } catch {
          /* ignore */
        }
        padOsc.push(o);
        padGain.push(g);
      }

      /* ---- voice pools -------------------------------------------------- */
      for (let i = 0; i < TONE_N; i++) {
        const oa = a.createOscillator();
        oa.type = "sine";
        oa.frequency.value = 440;
        const ob = a.createOscillator();
        ob.type = "sine";
        ob.frequency.value = 880;
        const bGain = gainNode(0.28);
        const env = gainNode(0.0001);
        const pan = stereoPan();
        oa.connect(env);
        ob.connect(bGain).connect(env);
        if (pan) env.connect(pan).connect(oneShotBus);
        else env.connect(oneShotBus);
        try {
          oa.start();
          ob.start();
        } catch {
          /* ignore */
        }
        tone.push({ a: oa, b: ob, bGain, env, pan, free: 0 });
      }

      for (let i = 0; i < PERC_N; i++) {
        const filter = filterNode("bandpass", 900, 3);
        const env = gainNode(0.0001);
        const pan = stereoPan();
        // Alternate the source so two simultaneous footsteps are not the same
        // two hundred samples of noise played twice.
        (i % 3 === 0 ? whiteA : i % 3 === 1 ? whiteB : pinkA).connect(filter);
        filter.connect(env);
        if (pan) env.connect(pan).connect(oneShotBus);
        else env.connect(oneShotBus);
        perc.push({ filter, env, pan, free: 0 });
      }

      for (let i = 0; i < POS_N; i++) {
        const input = gainNode(1);
        const air = filterNode("lowpass", 12000, 0.7);
        const g = gainNode(0);
        const panner = a.createPanner();
        try {
          panner.panningModel = high ? "HRTF" : "equalpower";
          panner.distanceModel = "inverse";
          panner.refDistance = 18;
          panner.maxDistance = 600;
          panner.rolloffFactor = 1.1;
        } catch {
          /* ignore */
        }
        input.connect(air).connect(g).connect(panner);
        panner.connect(posBus);
        slots.push({ input, air, gain: g, panner, owner: -1 });
      }

      /* ---- the eleven things that make a noise from a fixed place -------
       *
       * The radii are generous — a crowd spot carries a hundred and ninety
       * metres — because the inverse distance model and the air lowpass do
       * the real work: at the far edge of its radius a bazaar spot is a
       * muffled two per cent of its close gain, which is what a market three
       * streets away actually sounds like. It also means that standing in the
       * middle of the island nine things are audible and there are eight
       * slots, so the pool is a pool rather than a decoration.
       */
      const landmark = (id: string) => LANDMARKS.find((l) => l.id === id);

      const addEmitter = (
        id: string,
        x: number,
        y: number,
        z: number,
        radius: number,
        ref: number,
        priority: number,
        wire: (out: GainNode) => void,
      ): void => {
        const out = gainNode(0);
        wire(out);
        emitters.push({ id, x, y, z, radius, ref, priority, active: true, level: 0, out, slot: -1 });
      };

      // Water, at the Cistern.
      const cistern = landmark("fountain");
      addEmitter("fountain", cistern?.x ?? 0, ISLAND_Y + 1.4, cistern?.z ?? 44, 120, 9, 1, (out) => {
        const spray = filterNode("bandpass", 2100, 0.9);
        const sg = gainNode(0.5);
        whiteA.connect(spray).connect(sg).connect(out);
        lfo(0.23, 420).connect(spray.frequency);
        const basin = filterNode("bandpass", 380, 1.6);
        const bg = gainNode(0.34);
        pinkA.connect(basin).connect(bg).connect(out);
        const hiss = filterNode("highpass", 4200, 0.7);
        const hg = gainNode(0.12);
        whiteB.connect(hiss).connect(hg).connect(out);
      });

      // The Market Hall: four hundred stalls under iron and glass.
      const hall = landmark("market-hall");
      addEmitter("market-hall", hall?.x ?? 0, ISLAND_Y + 3, hall?.z ?? 0, 230, 22, 0.95, (out) => {
        const crowd = filterNode("bandpass", 560, 0.7);
        const cg = gainNode(0.55);
        pinkB.connect(crowd).connect(cg).connect(out);
        const room = filterNode("lowpass", 300, 0.8);
        const rg = gainNode(0.3);
        brownA.connect(room).connect(rg).connect(out);
        lfo(0.19, 0.09).connect(cg.gain);
      });

      // The Beacon: five hundred metres of lit glass, and it hums.
      const beacon = landmark("beacon");
      addEmitter("beacon", beacon?.x ?? 0, ISLAND_Y + 12, beacon?.z ?? 0, 240, 20, 0.8, (out) => {
        for (const hz of [46.2, 69.4]) {
          const o = ac!.createOscillator();
          o.type = "triangle";
          o.frequency.value = hz;
          const g = gainNode(0.2);
          o.connect(g).connect(out);
          try {
            o.start();
          } catch {
            /* ignore */
          }
          coreHum.push(o);
        }
        const glass = filterNode("bandpass", 1900, 8);
        const gg = gainNode(0.06);
        pinkA.connect(glass).connect(gg).connect(out);
      });

      // The Observatory: metal, wind and a mount that never quite stops.
      const obs = landmark("observatory");
      addEmitter("observatory", obs?.x ?? 0, ISLAND_Y + 4, obs?.z ?? -306, 130, 12, 0.6, (out) => {
        const groan = filterNode("bandpass", 150, 6);
        const gg = gainNode(0.28);
        brownA.connect(groan).connect(gg).connect(out);
        lfo(0.07, 26).connect(groan.frequency);
        const rail = filterNode("bandpass", 3400, 3);
        const rg = gainNode(0.04);
        whiteB.connect(rail).connect(rg).connect(out);
      });

      // The Launch Terrace: a wind sock, and races leaving.
      const launch = landmark("launch");
      addEmitter("launch", launch?.x ?? 0, ISLAND_Y + 2, launch?.z ?? 0, 150, 14, 0.55, (out) => {
        const flap = filterNode("bandpass", 780, 1.4);
        const fg = gainNode(0.3);
        whiteA.connect(flap).connect(fg).connect(out);
        const flapLfo = lfo(1.9, 0.22);
        flapLfo.connect(fg.gain);
        lfo(0.09, 180).connect(flap.frequency);
      });

      // Halo Station: a transformer and a rail nobody is on right now.
      const station = landmark("tram-halo");
      addEmitter("station", station?.x ?? -96, ISLAND_Y + 2, station?.z ?? 0, 120, 10, 0.5, (out) => {
        const o = ac!.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = 100;
        const f = filterNode("lowpass", 220, 3);
        const g = gainNode(0.07);
        o.connect(f).connect(g).connect(out);
        try {
          o.start();
        } catch {
          /* ignore */
        }
        coreHum.push(o);
      });

      // Four crowd spots around the bazaar ring, so the market has a direction
      // you can point at rather than being a fog you are inside.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        const rr = (RING_R[0] + RING_R[1]) / 2;
        addEmitter(
          `bazaar-${i}`,
          Math.cos(a) * rr,
          ISLAND_Y + 1.6,
          Math.sin(a) * rr,
          190,
          14,
          0.45,
          (out) => {
            const f = filterNode("bandpass", 460 + i * 55, 0.8);
            const g = gainNode(0.42);
            (i % 2 ? pinkA : pinkB).connect(f).connect(g).connect(out);
            lfo(0.13 + i * 0.031, 0.1).connect(g.gain);
          },
        );
      }

      // The tram, wherever the traffic system says it is. Inactive until
      // somebody calls setTram, and we never import traffic to find out.
      addEmitter("tram", 0, ISLAND_Y, 0, 320, 26, 0.9, (out) => {
        for (const hz of [54, 81.2]) {
          const o = ac!.createOscillator();
          o.type = "sawtooth";
          o.frequency.value = hz;
          const f = filterNode("lowpass", 340, 2.4);
          const g = gainNode(0.12);
          o.connect(f).connect(g).connect(out);
          try {
            o.start();
          } catch {
            /* ignore */
          }
          tramOsc.push(o);
        }
        const rail = filterNode("bandpass", 1750, 2.2);
        const rg = gainNode(0.12);
        whiteA.connect(rail).connect(rg).connect(out);
      });
      const tramEmitter = emitters[emitters.length - 1];
      tramEmitter.active = false;

      census.positional = slots.length;
      census.tone = tone.length;
      census.perc = perc.length;
      census.emitters = emitters.length;
      started = true;
      return true;
    } catch {
      // A half-built graph is worse than none. Give the context back and go
      // silent for the rest of the session rather than crashing the world.
      try {
        void ac?.close();
      } catch {
        /* ignore */
      }
      ac = null;
      started = false;
      return false;
    }
  }

  /* -------------------------------------------------------------------- *
   * The listener
   * -------------------------------------------------------------------- */

  function placeListener(): void {
    const l = ac!.listener;
    try {
      if (l.positionX) {
        const t = ac!.currentTime;
        l.positionX.setValueAtTime(drive.camX, t);
        l.positionY.setValueAtTime(drive.camY, t);
        l.positionZ.setValueAtTime(drive.camZ, t);
        l.forwardX.setValueAtTime(drive.fwdX, t);
        l.forwardY.setValueAtTime(drive.fwdY, t);
        l.forwardZ.setValueAtTime(drive.fwdZ, t);
        l.upX.setValueAtTime(drive.upX, t);
        l.upY.setValueAtTime(drive.upY, t);
        l.upZ.setValueAtTime(drive.upZ, t);
        return;
      }
    } catch {
      /* fall through to the deprecated calls */
    }
    try {
      const legacy = l as unknown as {
        setPosition?: (x: number, y: number, z: number) => void;
        setOrientation?: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
      };
      legacy.setPosition?.(drive.camX, drive.camY, drive.camZ);
      legacy.setOrientation?.(drive.fwdX, drive.fwdY, drive.fwdZ, drive.upX, drive.upY, drive.upZ);
    } catch {
      /* a listener that will not move is still a listener */
    }
  }

  /* -------------------------------------------------------------------- *
   * The positional pool
   * -------------------------------------------------------------------- */

  /**
   * Rank the emitters and hand the eight best a slot.
   *
   * Runs at 10 Hz over eleven emitters, which is under a hundred comparisons
   * a second, and it is the only thing standing between the Bazaar and a
   * panner per stall.
   */
  function assignSlots(): void {
    const n = emitters.length;
    for (let i = 0; i < n; i++) chosen[i] = 0;

    // Score, then pick the top `slots.length` by selection — no sort, no
    // temporary array, and the constant is small enough not to care.
    for (let k = 0; k < slots.length; k++) {
      let bestI = -1;
      let bestScore = 0;
      for (let i = 0; i < n; i++) {
        if (chosen[i]) continue;
        const e = emitters[i];
        if (!e.active) continue;
        const dx = e.x - drive.camX;
        const dy = e.y - drive.camY;
        const dz = e.z - drive.camZ;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > e.radius) continue;
        const score = e.priority * (1 - d / e.radius);
        if (score > bestScore) {
          bestScore = score;
          bestI = i;
        }
      }
      if (bestI < 0) break;
      chosen[bestI] = 1;
    }

    // Release anything that lost.
    for (let i = 0; i < n; i++) {
      const e = emitters[i];
      if (e.slot >= 0 && !chosen[i]) {
        const s = slots[e.slot];
        ramp(s.gain.gain, 0, 0.12);
        try {
          e.out.disconnect(s.input);
        } catch {
          /* ignore */
        }
        s.owner = -1;
        e.slot = -1;
      }
    }

    // Give the winners a slot.
    let active = 0;
    for (let i = 0; i < n; i++) {
      const e = emitters[i];
      if (!chosen[i]) continue;
      active++;
      if (e.slot >= 0) continue;
      for (let s = 0; s < slots.length; s++) {
        if (slots[s].owner !== -1) continue;
        slots[s].owner = i;
        e.slot = s;
        try {
          slots[s].gain.gain.value = 0;
        } catch {
          /* ignore */
        }
        try {
          e.out.connect(slots[s].input);
        } catch {
          /* ignore */
        }
        try {
          slots[s].panner.refDistance = e.ref;
          slots[s].panner.maxDistance = e.radius * 1.4;
        } catch {
          /* ignore */
        }
        break;
      }
    }
    census.positionalActive = active;
  }

  /** Move the slots' panners, and set their gain and their air absorption. */
  function drivePositional(): void {
    const t = ac!.currentTime;
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s];
      if (slot.owner < 0) continue;
      const e = emitters[slot.owner];
      const p = slot.panner;
      try {
        if (p.positionX) {
          p.positionX.setValueAtTime(e.x, t);
          p.positionY.setValueAtTime(e.y, t);
          p.positionZ.setValueAtTime(e.z, t);
        } else {
          (p as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(
            e.x,
            e.y,
            e.z,
          );
        }
      } catch {
        /* ignore */
      }
      const dx = e.x - drive.camX;
      const dy = e.y - drive.camY;
      const dz = e.z - drive.camZ;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Air absorption, plus a dull edge for everything you are hearing round
      // a corner. This is the whole of the occlusion model and it is enough.
      const cut = (900 + 15000 * Math.exp(-d / 70)) * (0.4 + 0.6 * exposure);
      ramp(slot.air.frequency, Math.max(500, Math.min(16000, cut)), 0.3);
      ramp(slot.gain.gain, muted ? 0 : e.level, 0.3);
    }
  }

  /* -------------------------------------------------------------------- *
   * Footsteps
   * -------------------------------------------------------------------- */

  /**
   * One footfall, with the timbre of whatever you are standing on.
   *
   * These four are the difference between a world and a treadmill: the plaza
   * is bright and rings a little, the pavement is dull, the roadway is flat
   * and dead, and the promenade decks are a sheet of metal over four hundred
   * metres of nothing and sound exactly like it.
   */
  function footstep(foot: number): void {
    const s = surfaceAt(drive.x, drive.z);
    if (s.kind === "void") return;
    const t = ac!.currentTime + 0.002;
    const pan = foot ? 0.14 : -0.14;
    const jitter = 0.88 + Math.random() * 0.24;
    const load = 0.55 + Math.min(1, drive.groundSpeed / 16) * 0.45;

    switch (s.kind) {
      case "plaza":
      case "parapet":
        hit(t, 1500 * jitter, 2.2, 0.07 * load, 0.1, { pan });
        hit(t, 420 * jitter, 1.4, 0.045 * load, 0.07, { pan });
        break;
      case "walk":
      case "lot":
        hit(t, 950 * jitter, 1.6, 0.06 * load, 0.075, { pan });
        hit(t, 300 * jitter, 1.2, 0.04 * load, 0.06, { type: "lowpass", pan });
        break;
      case "road":
        hit(t, 520 * jitter, 0.9, 0.055 * load, 0.065, { type: "lowpass", pan });
        break;
      default: {
        // promenade — a metal deck, which rings.
        hit(t, 2650 * jitter, 9, 0.05 * load, 0.24, { pan });
        hit(t, 470 * jitter, 6, 0.055 * load, 0.19, { pan: -pan });
        hit(t, 160 * jitter, 1.2, 0.035 * load, 0.07, { type: "lowpass", pan });
        break;
      }
    }
  }

  function landThump(strength: number): void {
    const t = ac!.currentTime + 0.002;
    const g = clamp01(strength);
    const s = surfaceAt(drive.x, drive.z);
    const metal = s.kind === "promenade";
    hit(t, 140, 0.9, 0.05 + g * 0.16, 0.16, { type: "lowpass", sweepTo: 60 });
    hit(t, metal ? 2400 : 1100, metal ? 7 : 1.6, 0.03 + g * 0.09, metal ? 0.3 : 0.09, {});
    ping(t, metal ? 190 : 78, 0.03 + g * 0.07, 0.28, { partial: 1.51, partialGain: 0.2 });
  }

  function scuff(): void {
    const t = ac!.currentTime + 0.002;
    hit(t, 2200, 1.1, 0.05, 0.16, { sweepTo: 620 });
  }

  /* -------------------------------------------------------------------- *
   * The jetpack's punctuation
   * -------------------------------------------------------------------- */

  function jetIgnite(): void {
    const t = ac!.currentTime + 0.002;
    hit(t, 900, 0.7, 0.14, 0.2, { type: "lowpass", sweepTo: 2600, attack: 0.008 });
    ping(t, 120, 0.09, 0.32, { partial: 1.5, partialGain: 0.15, glideTo: 210, glideSecs: 0.22 });
  }

  function jetTail(): void {
    const t = ac!.currentTime + 0.002;
    hit(t, 1400, 0.6, 0.07, 0.55, { type: "lowpass", sweepTo: 260, attack: 0.02 });
  }

  /* -------------------------------------------------------------------- *
   * Scheduling: music and the districts' incidents
   * -------------------------------------------------------------------- */

  function schedule(): void {
    const now = ac!.currentTime;
    const ahead = now + 0.35;
    const day = clamp01(drive.daylight);
    const open = clamp01((skyOpenness(drive.y, drive.altitude) - 10) / 380);

    /* ---- chords ------------------------------------------------------- */
    if (nextChordAt < now - 4) nextChordAt = now + 0.1;
    while (nextChordAt < ahead) {
      const c = CHORDS[chordIndex % CHORDS.length];
      for (let i = 0; i < padOsc.length; i++) {
        // A glide, not a jump: the chord changes the way weather does.
        try {
          padOsc[i].frequency.setTargetAtTime(c[i], nextChordAt, 1.1);
        } catch {
          /* ignore */
        }
        // Higher voices come in as you climb and drop out at street level, so
        // the pad literally opens up with altitude.
        const weight = i < 2 ? 0.17 : 0.055 + open * 0.085;
        try {
          padGain[i].gain.setTargetAtTime(weight, nextChordAt, 2.2);
        } catch {
          /* ignore */
        }
      }
      // One bell on the change, quiet, high when you are high.
      if (!muted) {
        ping(nextChordAt + 0.05, c[4] * (open > 0.55 ? 2 : 1), 0.028 + open * 0.02, 3.4, {
          attack: 0.02,
          partial: 2.0,
          partialGain: 0.16,
          pan: (Math.random() - 0.5) * 0.6,
        });
      }
      chordIndex++;
      nextChordAt += CHORD_SECONDS;
    }

    /* ---- arpeggio ------------------------------------------------------ */
    // Sparser at night, denser and higher as you climb. Never a stream of
    // notes: there is a rest in it more often than not near the ground.
    const step = 0.62 * (1 + (1 - day) * 0.85) * (1 - open * 0.28);
    if (nextArpAt < now - 2) nextArpAt = now + 0.05;
    while (nextArpAt < ahead) {
      const set = ARP[(chordIndex + CHORDS.length - 1) % CHORDS.length];
      const chance = (0.34 + open * 0.34) * (0.45 + 0.55 * day);
      if (!muted && Math.random() < chance) {
        const f = set[Math.floor(Math.random() * set.length)];
        ping(nextArpAt, f, 0.02 + open * 0.016, 1.9, {
          attack: 0.012,
          type: "triangle",
          partial: 2.005,
          partialGain: 0.13,
          pan: (Math.random() - 0.5) * 0.8,
        });
      }
      nextArpAt += step;
    }

    if (muted) {
      // Keep the clocks moving so unmuting does not fire a backlog.
      nextClatterAt = Math.max(nextClatterAt, now);
      nextBirdAt = Math.max(nextBirdAt, now);
      nextCreakAt = Math.max(nextCreakAt, now);
      nextGlassAt = Math.max(nextGlassAt, now);
      return;
    }

    const bazaar = mix[2] * presence * nightScale(day, "crowd");
    const terrace = mix[3] * presence;
    const rim = mix[4] * presence;
    const spires = mix[1] * presence;

    /* ---- the Bazaar clatters ------------------------------------------ */
    if (nextClatterAt < now - 2) nextClatterAt = now;
    while (nextClatterAt < ahead) {
      if (bazaar > 0.06 && Math.random() < bazaar) {
        const pan = (Math.random() - 0.5) * 1.6;
        const roll = Math.random();
        if (roll < 0.35) {
          // A pot, or something being put down on something.
          hit(nextClatterAt, 1800 + Math.random() * 1600, 6, 0.03 * bazaar, 0.17, { pan });
        } else if (roll < 0.6) {
          // Wood on wood.
          hit(nextClatterAt, 380 + Math.random() * 220, 3, 0.035 * bazaar, 0.1, { pan });
        } else if (roll < 0.82) {
          // Something frying.
          hit(nextClatterAt, 5200, 0.7, 0.02 * bazaar, 0.5, {
            type: "highpass",
            attack: 0.08,
            pan,
          });
        } else {
          // A stallholder's bell.
          ping(nextClatterAt, 1046 + Math.random() * 300, 0.022 * bazaar, 0.7, {
            partial: 2.76,
            partialGain: 0.3,
            pan,
          });
        }
      }
      nextClatterAt += 0.22 + Math.random() * 0.5;
    }

    /* ---- the Terraces: birds by day, chimes after dark ----------------- */
    if (nextBirdAt < now - 3) nextBirdAt = now;
    while (nextBirdAt < ahead) {
      if (terrace > 0.08) {
        const pan = (Math.random() - 0.5) * 1.7;
        if (day > 0.32) {
          // Two or three whistled notes, each swept — that sweep is most of
          // what makes a sine into a bird.
          const base = 2000 + Math.random() * 1400;
          const n = 2 + (Math.random() < 0.4 ? 1 : 0);
          for (let i = 0; i < n; i++) {
            const f = base * (1 + i * 0.12);
            ping(nextBirdAt + i * 0.11, f, 0.026 * terrace * nightScale(day, "birds"), 0.11, {
              attack: 0.012,
              partial: 2.0,
              partialGain: 0.08,
              glideTo: f * (1 + (Math.random() - 0.3) * 0.28),
              glideSecs: 0.08,
              pan,
            });
          }
        } else {
          // A chime in the dark: pentatonic, so it can never be wrong.
          const SCALE = [587.33, 659.26, 739.99, 880.0, 987.77];
          ping(nextBirdAt, SCALE[Math.floor(Math.random() * SCALE.length)], 0.022 * terrace, 2.6, {
            attack: 0.02,
            partial: 3.01,
            partialGain: 0.22,
            pan,
          });
        }
      }
      nextBirdAt += (day > 0.32 ? 1.6 : 3.4) + Math.random() * 4.5;
    }

    /* ---- the Rim creaks ------------------------------------------------ */
    if (nextCreakAt < now - 5) nextCreakAt = now;
    while (nextCreakAt < ahead) {
      if (rim > 0.12) {
        hit(nextCreakAt, 110 + Math.random() * 90, 11, 0.05 * rim, 1.6, {
          attack: 0.35,
          sweepTo: 70,
          pan: (Math.random() - 0.5) * 1.2,
        });
      }
      nextCreakAt += 7 + Math.random() * 13;
    }

    /* ---- the Spires tick ------------------------------------------------ */
    if (nextGlassAt < now - 5) nextGlassAt = now;
    while (nextGlassAt < ahead) {
      if (spires > 0.15) {
        ping(nextGlassAt, 2400 + Math.random() * 1800, 0.012 * spires, 1.3, {
          partial: 4.2,
          partialGain: 0.2,
          pan: (Math.random() - 0.5) * 1.4,
        });
      }
      nextGlassAt += 5 + Math.random() * 11;
    }
  }

  /* -------------------------------------------------------------------- *
   * The mix, once a frame
   * -------------------------------------------------------------------- */

  function run(): void {
    if (!started || disposed || !ac) return;
    const dt = Math.min(0.05, Math.max(0, drive.dt));

    placeListener();

    /* ---- wind ---------------------------------------------------------- */
    const open = skyOpenness(drive.y, drive.altitude);
    const w = muted ? 0 : windGain(drive.speed, exposure, open);
    ramp(windHighGain.gain, w * 0.72, 0.16);
    ramp(windLowGain.gain, w * 0.55 + (muted ? 0 : 0.006), 0.28);
    ramp(windHighFilter.frequency, windTone(drive.speed), 0.2);
    ramp(windLowFilter.frequency, 190 + Math.min(1, drive.speed / 34) * 260, 0.25);

    /* ---- jets ---------------------------------------------------------- */
    const jg = muted ? 0 : jetGain(drive.burn);
    ramp(jetGainNode.gain, jg, 0.05);
    ramp(jetAirGain.gain, muted ? 0 : Math.pow(clamp01(drive.burn), 2) * 0.03, 0.06);
    ramp(jetSubGain.gain, muted ? 0 : clamp01(drive.burn) * 0.075, 0.05);
    ramp(jetFilter.frequency, 480 + clamp01(drive.burn) * 1250, 0.07);
    ramp(jetSub.frequency, 52 + clamp01(drive.burn) * 16, 0.12);

    // The music steps back a little while you are burning — a jetpack you can
    // hear over is a jetpack that is doing something.
    const wantDuck = 1 - clamp01(drive.burn) * 0.35 - Math.min(0.2, w);
    duck += (wantDuck - duck) * Math.min(1, dt * 3);

    /* ---- footsteps ------------------------------------------------------ */
    if (drive.grounded && !muted) {
      const stride = strideSeconds(drive.groundSpeed);
      if (stride !== Infinity) {
        stepPhase += dt / stride;
        if (stepPhase >= 1) {
          stepPhase -= Math.floor(stepPhase);
          stepFoot ^= 1;
          footstep(stepFoot);
        }
      } else {
        stepPhase = 0.62;
      }
      scuffCooldown -= dt;
      if (prevGroundSpeed > 3.4 && drive.groundSpeed < 1.3 && scuffCooldown <= 0) {
        scuffCooldown = 0.7;
        scuff();
      }
    }
    prevGroundSpeed = drive.groundSpeed;

    /* ---- landing and ignition, detected as well as announced ------------ */
    landCooldown -= dt;
    if (drive.grounded && !wasGrounded && landCooldown <= 0) {
      landCooldown = 0.18;
      if (!muted) landThump(clamp01(Math.abs(drive.vy) / 22));
    }
    wasGrounded = drive.grounded;

    const burning = drive.burn > 0.08;
    if (burning !== wasBurning) {
      if (!muted) {
        if (burning) jetIgnite();
        else jetTail();
      }
      wasBurning = burning;
    }

    /* ---- the slow tick -------------------------------------------------- */
    tickAccum += dt;
    if (tickAccum >= 0.1) {
      tickAccum = 0;
      const r = Math.hypot(drive.x, drive.z);
      exposure = exposureAt(drive.x, drive.z, drive.y, drive.altitude);
      presence = cityPresence(r, drive.y, drive.altitude);
      districtMix(r, mix);

      const day = clamp01(drive.daylight);
      // Written in place: this runs ten times a second and a fresh array of
      // five numbers, sixty thousand times an hour, is a thing you can see in
      // a heap profile of a world that is otherwise perfectly still.
      bedLevel[0] = 0.075 * nightScale(day, "crowd");
      bedLevel[1] = 0.055 * nightScale(day, "machine");
      bedLevel[2] = 0.115 * nightScale(day, "crowd");
      bedLevel[3] = 0.085;
      bedLevel[4] = 0.07;
      for (let i = 0; i < bedGain.length; i++) {
        // Never all the way to zero while you are on the island: a city that
        // stops making any noise at all reads as broken, not as late.
        const floor = presence > 0.05 ? 0.02 : 0;
        const v = muted ? 0 : (mix[i] * presence + floor * mix[i]) * bedLevel[i];
        ramp(bedGain[i].gain, v, 0.45);
      }

      // Emitter levels, then who gets a slot, then where the slots are.
      for (let i = 0; i < emitters.length; i++) {
        const e = emitters[i];
        let lvl = 0.5;
        if (e.id === "fountain") lvl = 0.62;
        else if (e.id === "market-hall") lvl = 0.55 * nightScale(day, "crowd");
        else if (e.id.startsWith("bazaar")) lvl = 0.4 * nightScale(day, "crowd");
        else if (e.id === "beacon") lvl = 0.34 * nightScale(day, "machine");
        else if (e.id === "observatory") lvl = 0.4;
        else if (e.id === "launch") lvl = 0.35;
        else if (e.id === "station") lvl = 0.32 * nightScale(day, "machine");
        else if (e.id === "tram") lvl = 0.5;
        e.level = lvl;
      }

      // The tram's approach, faked as a detune on its own hum: WebAudio threw
      // doppler out in 2014 and a pass-by without it does not read as a pass.
      const tram = emitters[emitters.length - 1];
      tram.x = tramX;
      tram.y = tramY;
      tram.z = tramZ;
      tram.active = tramActive;
      if (tramActive) {
        const dx = tramX - drive.camX;
        const dy = tramY - drive.camY;
        const dz = tramZ - drive.camZ;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const closing = (tramPrevDist - d) / 0.1;
        tramPrevDist = d;
        const cents = Math.max(-70, Math.min(70, closing * 2.4));
        for (let i = 0; i < tramOsc.length; i++) ramp(tramOsc[i].detune, cents, 0.12);
      }

      assignSlots();
      drivePositional();

      // The pad's filter opens as you climb — the same "thinner air" idea the
      // first version of this file had, kept because it is the right one.
      const openness = clamp01((open - 10) / 380);
      ramp(padFilter.frequency, 700 + openness * 2600, 0.9);
      ramp(musicBus.gain, muted ? 0 : 0.1 * (0.68 + 0.32 * openness) * duck, 0.5);
      ramp(posBus.gain, muted ? 0 : 1, 0.2);
      ramp(oneShotBus.gain, muted ? 0 : 1, 0.05);
    }

    schedule();
  }

  /* -------------------------------------------------------------------- *
   * One-shots
   * -------------------------------------------------------------------- */

  function fire(kind: string, strength: number): void {
    if (!started || disposed || muted || !ac) return;
    const t = ac.currentTime + 0.002;
    const s = clamp01(strength);
    switch (kind) {
      case "land":
        landCooldown = 0.18;
        landThump(s || 0.5);
        break;
      case "jump":
        hit(t, 260, 0.8, 0.05, 0.13, { type: "lowpass", sweepTo: 900 });
        hit(t, 3200, 0.6, 0.02, 0.09, {});
        break;
      case "jetOn":
        wasBurning = true;
        jetIgnite();
        break;
      case "jetOff":
        wasBurning = false;
        jetTail();
        break;
      case "coin": {
        // A run of coins climbs and comes home. See `coinSemitone`.
        const now = ac.currentTime;
        if (now - coinRunAt > 1.6) coinRun = 0;
        coinRunAt = now;
        const semi = coinSemitone(coinRun++);
        const f = 880 * Math.pow(2, semi / 12);
        ping(t, f, 0.075, 0.42, { partial: 2.0, partialGain: 0.35 });
        ping(t + 0.045, f * 2, 0.035, 0.6, { partial: 3.01, partialGain: 0.2 });
        break;
      }
      case "ring":
        ping(t, 1174.66, 0.075, 1.1, { partial: 2.76, partialGain: 0.4 });
        ping(t + 0.07, 1760, 0.045, 1.5, { partial: 2.0, partialGain: 0.25, pan: 0.3 });
        break;
      case "pickup":
        ping(t, 659.26, 0.06, 0.3, { partial: 2.0, partialGain: 0.3 });
        ping(t + 0.08, 987.77, 0.06, 0.45, { partial: 2.0, partialGain: 0.3 });
        break;
      case "deliver":
        // Three notes up a major triad. There is no more satisfying shape.
        ping(t, 587.33, 0.06, 0.4, { partial: 2.0, partialGain: 0.3 });
        ping(t + 0.09, 739.99, 0.06, 0.4, { partial: 2.0, partialGain: 0.3 });
        ping(t + 0.18, 880.0, 0.07, 1.3, { partial: 2.01, partialGain: 0.4 });
        break;
      case "photo":
        hit(t, 3600, 4, 0.06, 0.035, {});
        hit(t + 0.075, 2200, 3, 0.045, 0.05, {});
        break;
      case "ui":
        ping(t, 1318.51, 0.03, 0.11, { partial: 3.0, partialGain: 0.15 });
        break;
      default:
        // An event this file has never heard of is not an error. The rest of
        // the world adds verbs faster than the soundtrack does.
        break;
    }
  }

  /* -------------------------------------------------------------------- *
   * The handle
   * -------------------------------------------------------------------- */

  /**
   * Muting is a hard zero on the master, now.
   *
   * Not a fade: somebody pressing M has decided they want silence, and half a
   * second of the Bazaar on the way out is the difference between a control
   * and a suggestion. Unmuting *is* a fade, because arriving at full volume
   * in one sample is a click.
   */
  function applyMute(): void {
    if (!started || !ac) return;
    try {
      const t = ac.currentTime;
      master.gain.cancelScheduledValues(t);
      if (muted) {
        master.gain.setValueAtTime(0, t);
      } else {
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.setTargetAtTime(MASTER_LEVEL, t, 0.12);
      }
    } catch {
      try {
        master.gain.value = muted ? 0 : MASTER_LEVEL;
      } catch {
        /* a master that will not move is a world without sound, not a crash */
      }
    }
  }

  const handle: AudioHandle = {
    name: "audio",
    group,
    voices: census,

    get muted() {
      return muted;
    },

    setMuted(m: boolean) {
      muted = !!m;
      writeMuted(muted);
      if (disposed) return;
      applyMute();
      if (!muted && ac && ac.state === "suspended") {
        try {
          void ac.resume();
        } catch {
          /* ignore */
        }
      }
    },

    resume() {
      if (disposed) return;
      if (!started && !createGraph()) return;
      try {
        if (ac && ac.state !== "running") void ac.resume();
      } catch {
        /* ignore */
      }
      const now = ac ? ac.currentTime : 0;
      nextChordAt = now + 0.2;
      nextArpAt = now + 1.2;
      nextClatterAt = now + 0.3;
      nextBirdAt = now + 1.6;
      nextCreakAt = now + 4;
      nextGlassAt = now + 6;
      applyMute();
    },

    update(ctx: FrameContext) {
      if (disposed || !started) return;
      const p = ctx.player;
      drive.dt = ctx.dt;
      drive.x = p.position.x;
      drive.y = p.position.y;
      drive.z = p.position.z;
      drive.groundSpeed = Math.hypot(p.velocity.x, p.velocity.z);
      drive.speed = Math.hypot(drive.groundSpeed, p.velocity.y);
      drive.vy = p.velocity.y;
      drive.burn = p.burn;
      drive.grounded = p.grounded;
      drive.altitude = p.altitude;
      drive.daylight = ctx.daylight;

      const m = ctx.camera.matrixWorld.elements;
      drive.camX = m[12];
      drive.camY = m[13];
      drive.camZ = m[14];
      // Column 2 of a THREE matrix is the camera's +Z, which points backwards.
      drive.fwdX = -m[8];
      drive.fwdY = -m[9];
      drive.fwdZ = -m[10];
      drive.upX = m[4];
      drive.upY = m[5];
      drive.upZ = m[6];
      run();
    },

    event(kind, strength) {
      try {
        fire(kind, strength ?? 1);
      } catch {
        // A sound effect is never worth a thrown frame.
      }
    },

    setTram(x, y, z, active) {
      tramX = x;
      tramY = y;
      tramZ = z;
      tramActive = !!active;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      const stop = (n: { stop?: () => void }) => {
        try {
          n.stop?.();
        } catch {
          /* already stopped */
        }
      };
      for (const s of noiseSrc) stop(s);
      for (const o of lfos) stop(o);
      for (const o of coreHum) stop(o);
      for (const o of tramOsc) stop(o);
      for (const o of padOsc) stop(o);
      for (const v of tone) {
        stop(v.a);
        stop(v.b);
      }
      if (typeof jetSub !== "undefined") stop(jetSub);
      try {
        master?.disconnect();
      } catch {
        /* ignore */
      }
      noiseSrc = [];
      lfos = [];
      coreHum = [];
      tramOsc = [];
      padOsc = [];
      padGain = [];
      bedGain = [];
      tone = [];
      perc = [];
      slots = [];
      emitters = [];
      census.positional = 0;
      census.positionalActive = 0;
      census.tone = 0;
      census.perc = 0;
      census.emitters = 0;
      try {
        void ac?.close();
      } catch {
        /* a context that will not close is out of our hands */
      }
      ac = null;
    },
  };

  return handle;
}

/* ==================================================================== *
 * The legacy entry point
 * ==================================================================== */

/**
 * @deprecated `world.ts` still calls this. It drives the wind, the jets and
 * the music from three numbers and stands you in the middle of the Halo,
 * because it has no idea where you are. Swap it for:
 *
 * ```ts
 * const audio = buildAudio({ quality: quality.tier, seedSalt: "audio" });
 * // ...on the first pointerdown/keydown: audio?.resume();
 * // ...each frame: audio?.update(frameContext);
 * // ...on landing:  audio?.event("land", impact / 22);
 * ```
 */
export function createEmpyreanAudio(): EmpyreanAudio | null {
  const inner = buildAudio({ quality: "high", seedSalt: "audio" });
  if (!inner) return null;

  // One camera, one player view, built once and mutated — the same contract
  // the real `FrameContext` has.
  const camera = new THREE.PerspectiveCamera();
  const shim = {
    time: 0,
    dt: 0.016,
    camera,
    player: {
      position: new THREE.Vector3(0, ISLAND_Y, 0),
      velocity: new THREE.Vector3(),
      yaw: 0,
      grounded: true,
      burn: 0,
      altitude: 0,
    },
    quality: "high" as const,
    dayPhase: 0.75,
    sunDir: new THREE.Vector3(0, 0.2, -1),
    daylight: 0.45,
    camRadiusSq: 0,
  };
  let last = typeof performance !== "undefined" ? performance.now() : 0;

  return {
    update(speed, burn, y) {
      const now = typeof performance !== "undefined" ? performance.now() : last + 16;
      shim.dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      shim.time += shim.dt;
      shim.player.position.set(0, y, 0);
      shim.player.velocity.set(speed, 0, 0);
      shim.player.burn = burn;
      shim.player.grounded = Math.abs(y - ISLAND_Y) < 1.2;
      shim.player.altitude = y >= ISLAND_Y - 40 ? y - ISLAND_Y : y;
      camera.position.set(0, y + 2, 8);
      camera.updateMatrixWorld();
      inner.update?.(shim);
    },
    setMuted(m) {
      inner.setMuted(m);
    },
    resume() {
      inner.resume();
    },
    dispose() {
      inner.dispose();
    },
  };
}
