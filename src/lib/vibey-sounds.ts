/**
 * vibey-sounds — tiny Web Audio synth for Vibey's beeps and bloops.
 *
 * Why synth instead of mp3 files: zero assets, infinite variants
 * (every blip pitched slightly differently), and the retro-robot
 * vibe matches a small expressive robot drifting on an asteroid
 * way better than canned samples ever would.
 *
 * Usage anywhere:
 *   import { playSound } from "@/lib/vibey-sounds";
 *   playSound("chirp");
 *   playSound("emote", { anim: "Dance" });
 *
 * The AudioContext is lazy-initialized on first call (browsers
 * require a user gesture to start audio; React components calling
 * this from click handlers satisfy that requirement).
 *
 * Mute state persists in localStorage. Listen for "vibey-sounds-mute"
 * events to keep UI in sync.
 */

const MUTE_KEY = "vibey.sounds.muted.v1";
const VOLUME_KEY = "vibey.sounds.volume.v1";

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let initFailed = false;

function getContext(): AudioContext | null {
  if (initFailed) return null;
  if (ctx) return ctx;
  if (typeof window === "undefined") return null;
  try {
    const AC =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) { initFailed = true; return null; }
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = readVolume();
    masterGain.connect(ctx.destination);
    return ctx;
  } catch {
    initFailed = true;
    return null;
  }
}

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
}
function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw == null) return 0.6;
    const v = parseFloat(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6;
  } catch { return 0.6; }
}

export function isMuted(): boolean { return readMuted(); }
export function getVolume(): number { return readVolume(); }

export function setMuted(next: boolean): void {
  try { localStorage.setItem(MUTE_KEY, next ? "1" : "0"); } catch { /* */ }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("vibey-sounds-mute", { detail: { muted: next } }));
  }
}
export function setVolume(next: number): void {
  const v = Math.max(0, Math.min(1, next));
  try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* */ }
  if (masterGain && ctx) masterGain.gain.setValueAtTime(v, ctx.currentTime);
}

/** Toggle mute + return new state. */
export function toggleMuted(): boolean {
  const next = !readMuted();
  setMuted(next);
  return next;
}

// ----------------------------------------------------------------------
// Voice primitives — every sound is a chain of these.
// ----------------------------------------------------------------------

interface ToneOpts {
  freq: number;
  freqEnd?: number; // for pitch sweeps
  duration: number; // seconds
  type?: OscillatorType;
  startGain?: number;
  delay?: number; // seconds from now
  attack?: number;
  decay?: number;
}

function tone(opts: ToneOpts): void {
  if (readMuted()) return;
  const audioCtx = getContext();
  if (!audioCtx || !masterGain) return;
  const now = audioCtx.currentTime + (opts.delay ?? 0);
  const osc = audioCtx.createOscillator();
  osc.type = opts.type ?? "triangle";
  osc.frequency.setValueAtTime(opts.freq, now);
  if (opts.freqEnd != null && opts.freqEnd !== opts.freq) {
    // Exponential ramp can't hit zero; clamp.
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(20, opts.freqEnd),
      now + opts.duration,
    );
  }
  const gain = audioCtx.createGain();
  const peak = opts.startGain ?? 0.22;
  const attack = opts.attack ?? 0.005;
  const decay = opts.decay ?? opts.duration;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(now);
  osc.stop(now + Math.max(opts.duration, attack + decay) + 0.05);
}

// ----------------------------------------------------------------------
// Named sounds — every interaction in /space routes through these.
// ----------------------------------------------------------------------

/** Tiny UI click — sending a chat, clicking a 3D thing. */
function blip(): void {
  tone({ freq: 880, freqEnd: 660, duration: 0.07, type: "triangle", startGain: 0.18 });
}

/** Soft "you have my attention" — opening the journal, hovering. */
function pop(): void {
  tone({ freq: 520, freqEnd: 760, duration: 0.06, type: "sine", startGain: 0.12 });
}

/** Happy ascending two-note (Yes, ThumbsUp, success). */
function chirp(): void {
  tone({ freq: 660, freqEnd: 990, duration: 0.09, type: "triangle", startGain: 0.2 });
  tone({ freq: 990, freqEnd: 1320, duration: 0.1, type: "triangle", startGain: 0.18, delay: 0.07 });
}

/** Sad descending two-note (No, error). */
function bloop(): void {
  tone({ freq: 660, freqEnd: 440, duration: 0.1, type: "triangle", startGain: 0.2 });
  tone({ freq: 440, freqEnd: 220, duration: 0.13, type: "triangle", startGain: 0.18, delay: 0.08 });
}

/** Surprise — short upward zip. */
function zip(): void {
  tone({ freq: 440, freqEnd: 1760, duration: 0.12, type: "sawtooth", startGain: 0.16 });
}

/** Soft chime — new journal entry landed, gentle attention. */
function chime(): void {
  // Two harmonics (fundamental + fifth) for a bell-ish color.
  tone({ freq: 880, duration: 0.55, type: "sine", startGain: 0.18, decay: 0.55 });
  tone({ freq: 1318.5, duration: 0.45, type: "sine", startGain: 0.1, decay: 0.45, delay: 0.02 });
}

/** Sparkle — 3-blip cluster for confetti / arrival / wave hello. */
function sparkle(): void {
  tone({ freq: 1320, duration: 0.05, type: "triangle", startGain: 0.14 });
  tone({ freq: 1760, duration: 0.05, type: "triangle", startGain: 0.13, delay: 0.05 });
  tone({ freq: 2093, duration: 0.06, type: "triangle", startGain: 0.12, delay: 0.1 });
}

/** A tiny 4-note rhythmic groove for Dance. */
function groove(): void {
  const beats = [
    { f: 440, t: 0.0 },
    { f: 660, t: 0.12 },
    { f: 880, t: 0.24 },
    { f: 660, t: 0.36 },
  ];
  for (const b of beats) {
    tone({ freq: b.f, freqEnd: b.f * 1.06, duration: 0.1, type: "square", startGain: 0.16, delay: b.t });
  }
}

/** Punch — short low hit. */
function thud(): void {
  tone({ freq: 220, freqEnd: 80, duration: 0.16, type: "triangle", startGain: 0.28 });
}

/** Jump — quick upward whoop. */
function whoop(): void {
  tone({ freq: 330, freqEnd: 1100, duration: 0.18, type: "triangle", startGain: 0.2 });
}

/** Death — sad descending whomp. */
function fall(): void {
  tone({ freq: 660, freqEnd: 110, duration: 0.45, type: "sawtooth", startGain: 0.2 });
}

/** Idle/standing — very subtle blip. */
function neutral(): void {
  tone({ freq: 520, duration: 0.05, type: "sine", startGain: 0.08 });
}

// ----------------------------------------------------------------------
// Public surface
// ----------------------------------------------------------------------

export type SoundName =
  | "blip"
  | "pop"
  | "chirp"
  | "bloop"
  | "zip"
  | "chime"
  | "sparkle"
  | "groove"
  | "thud"
  | "whoop"
  | "fall"
  | "neutral"
  | "emote";

interface PlayOptions {
  /** When name="emote", drive the right sound from the anim name. */
  anim?: string;
}

/** Map an animation name to a sound. Keeps Vibey's voice consistent. */
function soundForAnim(anim: string): () => void {
  switch (anim) {
    case "Wave":     return sparkle;
    case "Yes":      return chirp;
    case "ThumbsUp": return chirp;
    case "No":       return bloop;
    case "Dance":    return groove;
    case "Jump":     return whoop;
    case "Punch":    return thud;
    case "Death":    return fall;
    case "Surprised":return zip;
    case "Sitting":  return pop;
    case "Standing": return neutral;
    case "Running":  return whoop;
    case "Walking":  return neutral;
    case "Idle":     return neutral;
    default:         return blip;
  }
}

export function playSound(name: SoundName, opts: PlayOptions = {}): void {
  switch (name) {
    case "blip":    blip(); break;
    case "pop":     pop(); break;
    case "chirp":   chirp(); break;
    case "bloop":   bloop(); break;
    case "zip":     zip(); break;
    case "chime":   chime(); break;
    case "sparkle": sparkle(); break;
    case "groove":  groove(); break;
    case "thud":    thud(); break;
    case "whoop":   whoop(); break;
    case "fall":    fall(); break;
    case "neutral": neutral(); break;
    case "emote":   soundForAnim(opts.anim ?? "Idle")(); break;
  }
}

/**
 * Resume the AudioContext if it got auto-suspended (Chrome does this
 * if the tab hasn't had a recent user gesture). Safe to call anytime.
 */
export function ensureAudioRunning(): void {
  const c = getContext();
  if (c && c.state === "suspended") {
    c.resume().catch(() => { /* ignore */ });
  }
}
