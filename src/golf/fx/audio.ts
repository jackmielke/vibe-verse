/**
 * Vibe Golf — WebAudio synthesis. Publishes `AudioService2`.
 *
 * Every sound in the game is generated at runtime: there are no audio files,
 * no decodeAudioData, no network. Percussive one-shots are built from three
 * primitives — a swept oscillator (`tone`), a filtered slice of a shared noise
 * buffer (`noise`), and an inharmonic bell stack — routed through a stereo
 * panner and a short generated-impulse reverb send.
 *
 * Three rules shape this module:
 *
 *  1. **It never throws.** Browsers block audio until a gesture, some
 *     browsers ship no `StereoPannerNode`, and a headless test harness has no
 *     `AudioContext` at all. Every entry point funnels through `ensure()`,
 *     which returns null instead of exploding, and every public method is a
 *     no-op when it does. A silent game is a bug; a crashed game is a disaster.
 *  2. **Unknown names still make a sound.** Sibling systems call names that
 *     were invented after this file was written, so `play()` resolves through
 *     an alias table and falls back to a generic blip rather than failing.
 *  3. **Impacts scale with energy.** `golf:bounce` carries a speed; volume,
 *     brightness and the presence of a transient "crack" layer all ride it, so
 *     a soft roll whispers and a slam cracks. That single mapping does more
 *     for game feel than any individual effect.
 *
 * Music is a generative, loop-free ambient bed — a drone, overlapping
 * pentatonic pads and sparse arpeggios scheduled with a 2 s lookahead, keyed
 * and voiced per `CourseTheme`. It is designed to sit under a puzzle game for
 * an hour without ever announcing itself.
 *
 * Consumes `golf:bounce`, `golf:shot`, `golf:hazard`, `golf:penalty`,
 * `golf:hole`, `golf:courseComplete`, `golf:mute`.
 */
import type {
  AudioService2,
  CourseTheme,
  SurfaceMaterial,
  System,
  SystemFactory,
} from "../types";
import { makeRng } from "../types";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const MASTER_GAIN = 0.85;
/**
 * Voices are scheduled this far ahead of `currentTime`. It has to clear one
 * render quantum plus whatever the main thread is doing: if the envelope's
 * start lands in the past, the attack ramp is already over by the time the
 * graph is processed and the voice plays silently. 30 ms is inaudible as
 * latency and survives a frame spike on a mid-range phone.
 */
const SCHED_AHEAD = 0.03;
const SFX_GAIN = 0.9;
const MUSIC_GAIN = 0.2;
/** Above this many in-flight voices, non-critical sounds are dropped. */
const VOICE_BUDGET = 26;
/**
 * Voices free themselves at roughly this rate (per second of *wall* time).
 * The estimate is decayed against `AudioContext.currentTime`, never the
 * engine's `dt` — `core.ts` clamps dt to 1/20, so on a stuttering phone a
 * frame-driven decay would run up to 20× slow and silently throttle the
 * game's sound effects exactly when the frame rate is already bad.
 */
const VOICE_DECAY = 24;
/** Impact speed (m/s) that counts as a full-energy slam. */
const SLAM_SPEED = 20;
const MUTE_KEY = "vibegolf.mute";

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface Engine {
  ac: AudioContext;
  /** Final trim — mute and page-visibility ducking live here. */
  master: GainNode;
  sfx: GainNode;
  music: GainNode;
  /** Reverb send bus; null when convolution is unavailable. */
  send: GainNode | null;
  wet: GainNode | null;
  noise: AudioBuffer;
  /** False on browsers without `createStereoPanner` (very old Safari). */
  panner: boolean;
}

interface ToneOpts {
  t: number;
  /** Start frequency, Hz. */
  f0: number;
  /** Optional end frequency for a glide. */
  f1?: number;
  /** Glide duration; defaults to the decay. */
  sweep?: number;
  type?: OscillatorType;
  gain: number;
  attack?: number;
  hold?: number;
  decay: number;
  pan?: number;
  wet?: number;
  dest?: GainNode;
}

interface NoiseOpts {
  t: number;
  gain: number;
  attack?: number;
  hold?: number;
  decay: number;
  filter?: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  /** Resampling rate of the noise slice — cheap timbre control. */
  rate?: number;
  pan?: number;
  wet?: number;
  dest?: GainNode;
}

const createAudio: SystemFactory = (ctx) => {
  // A locally seeded stream: the noise buffer and impulse response need tens
  // of thousands of samples, and draining the shared course RNG that hard
  // would reshuffle every generator that boots after this one. One draw seeds
  // it, so the result is still deterministic per run.
  const rng = makeRng(Math.floor(ctx.rng() * 0xffffffff) >>> 0);

  let eng: Engine | null = null;
  let dead = false; // WebAudio unavailable — stop trying
  let muted = false;
  let musicWanted = true;
  let musicOn = false;
  let hidden = false;
  let voiceLoad = 0;
  let loadAt = 0;
  let theme: CourseTheme = "seaside";

  /** Live-voice estimate, decayed against the audio clock. */
  function load(e: Engine): number {
    const t = e.ac.currentTime;
    voiceLoad = Math.max(0, voiceLoad - Math.max(0, t - loadAt) * VOICE_DECAY);
    loadAt = t;
    return voiceLoad;
  }

  try {
    muted = typeof localStorage !== "undefined" && localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    /* private mode — default to audible */
  }

  /** Build (or return) the audio graph. Null means "audio is unavailable". */
  function ensure(): Engine | null {
    if (eng || dead) return eng;
    try {
      const Ctor: typeof AudioContext | undefined =
        typeof AudioContext !== "undefined"
          ? AudioContext
          : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        dead = true;
        return null;
      }
      const ac = new Ctor({ latencyHint: "interactive" });

      const master = ac.createGain();
      master.gain.value = muted ? 0 : MASTER_GAIN;
      // A gentle limiter keeps a pile-up of bounces from clipping on phone
      // speakers without audibly pumping the music underneath.
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 24;
      comp.ratio.value = 5;
      comp.attack.value = 0.004;
      comp.release.value = 0.18;
      master.connect(comp);
      comp.connect(ac.destination);

      const sfx = ac.createGain();
      sfx.gain.value = SFX_GAIN;
      sfx.connect(master);

      const music = ac.createGain();
      music.gain.value = 0; // faded in by startMusic()
      music.connect(master);

      // Short generated IR. 1.5 s of noise under a power curve reads as a
      // pleasant outdoor space; the wet level is what changes per theme.
      let send: GainNode | null = null;
      let wet: GainNode | null = null;
      try {
        const conv = ac.createConvolver();
        const secs = 1.5;
        const n = Math.max(1, Math.floor(ac.sampleRate * secs));
        const ir = ac.createBuffer(2, n, ac.sampleRate);
        for (let c = 0; c < 2; c++) {
          const d = ir.getChannelData(c);
          for (let i = 0; i < n; i++) {
            const u = i / n;
            // A touch of early-reflection density up front, then a smooth tail.
            const early = u < 0.06 ? 1 + Math.sin(u * 260 + c) * 0.5 : 1;
            d[i] = (rng() * 2 - 1) * Math.pow(1 - u, 2.6) * early;
          }
        }
        conv.buffer = ir;
        send = ac.createGain();
        send.gain.value = 1;
        wet = ac.createGain();
        wet.gain.value = 0.2;
        send.connect(conv);
        conv.connect(wet);
        wet.connect(master);
      } catch {
        send = null;
        wet = null;
      }

      // 2 s of mono noise, shared by every percussive voice.
      const nb = ac.createBuffer(1, Math.max(1, Math.floor(ac.sampleRate * 2)), ac.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = rng() * 2 - 1;

      eng = {
        ac,
        master,
        sfx,
        music,
        send,
        wet,
        noise: nb,
        panner: typeof ac.createStereoPanner === "function",
      };
      applyThemeSpace();
      return eng;
    } catch (err) {
      console.warn("[Vibe Golf] audio unavailable:", err);
      dead = true;
      return null;
    }
  }

  /** Browsers start the context suspended; nudge it whenever we can. */
  function resume(): void {
    const e = eng;
    if (!e) return;
    if (e.ac.state === "suspended") void e.ac.resume().catch(() => { /* still gated */ });
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  /** Exponential AD(H)SR on a gain param. Never touches zero — WebAudio hates it. */
  function shape(p: AudioParam, t: number, peak: number, a: number, hold: number, d: number): void {
    const g = Math.max(0.0002, peak);
    p.setValueAtTime(0.0001, t);
    p.exponentialRampToValueAtTime(g, t + a);
    if (hold > 0) p.setValueAtTime(g, t + a + hold);
    p.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
  }

  /** Pan + dry/wet routing for one voice. */
  function route(e: Engine, node: AudioNode, pan: number, wet: number, dest?: GainNode): void {
    let out: AudioNode = node;
    if (e.panner && pan !== 0) {
      const p = e.ac.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      node.connect(p);
      out = p;
    }
    out.connect(dest ?? e.sfx);
    if (e.send && wet > 0) {
      const s = e.ac.createGain();
      s.gain.value = wet;
      out.connect(s);
      s.connect(e.send);
    }
  }

  function tone(e: Engine, o: ToneOpts): void {
    const a = o.attack ?? 0.004;
    const hold = o.hold ?? 0;
    const osc = e.ac.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(Math.max(12, o.f0), o.t);
    if (o.f1 !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(12, o.f1),
        o.t + (o.sweep ?? a + hold + o.decay),
      );
    }
    const g = e.ac.createGain();
    shape(g.gain, o.t, o.gain, a, hold, o.decay);
    osc.connect(g);
    route(e, g, o.pan ?? 0, o.wet ?? 0.1, o.dest);
    osc.start(o.t);
    osc.stop(o.t + a + hold + o.decay + 0.06);
    voiceLoad += 1;
  }

  function noise(e: Engine, o: NoiseOpts): void {
    const a = o.attack ?? 0.002;
    const hold = o.hold ?? 0;
    const src = e.ac.createBufferSource();
    src.buffer = e.noise;
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;
    const f = e.ac.createBiquadFilter();
    f.type = o.filter ?? "bandpass";
    f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(Math.max(20, o.f0), o.t);
    if (o.f1 !== undefined) {
      f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), o.t + a + hold + o.decay);
    }
    const g = e.ac.createGain();
    shape(g.gain, o.t, o.gain, a, hold, o.decay);
    src.connect(f);
    f.connect(g);
    route(e, g, o.pan ?? 0, o.wet ?? 0.08, o.dest);
    // Start at a random offset so repeated hits never phase-lock into a tone.
    src.start(o.t, rng() * 1.6);
    src.stop(o.t + a + hold + o.decay + 0.06);
    voiceLoad += 1;
  }

  /** Inharmonic partial stack — the backbone of chimes, bells and metal. */
  function bell(e: Engine, t: number, f: number, gain: number, dur: number, pan: number, wet: number): void {
    tone(e, { t, f0: f, type: "sine", gain, attack: 0.005, decay: dur, pan, wet });
    tone(e, { t, f0: f * 2.02, type: "sine", gain: gain * 0.34, attack: 0.004, decay: dur * 0.55, pan, wet });
    tone(e, { t, f0: f * 3.04, type: "triangle", gain: gain * 0.13, attack: 0.003, decay: dur * 0.3, pan, wet });
  }

  // -------------------------------------------------------------------------
  // Spatialisation
  // -------------------------------------------------------------------------

  /** Screen-relative pan (−1..1) and distance attenuation for a world point. */
  function spatial(x: number | null, y: number | null): { pan: number; gain: number } {
    const cam = ctx.camera;
    if (x === null || y === null || !cam) return { pan: 0, gain: 1 };
    const halfW = Math.max(1, (cam.right - cam.left) * 0.5);
    const halfH = Math.max(1, (cam.top - cam.bottom) * 0.5);
    const dx = (x - cam.position.x) / halfW;
    const dy = (y - cam.position.y) / halfH;
    const d = Math.hypot(dx, dy);
    // Full volume on screen, rolling off outside it — never quite to silence,
    // because an off-screen ball still needs to be heard landing.
    const gain = clamp(1 / (1 + 0.7 * Math.max(0, d - 0.9) ** 2), 0.14, 1);
    return { pan: clamp(dx * 0.8, -1, 1), gain };
  }

  /** Where the ball is right now, for calls that don't supply a position. */
  function ballPoint(): { x: number | null; y: number | null } {
    const balls = ctx.services.physics?.balls;
    if (balls) {
      for (const b of balls) if (b.active) return { x: b.pos.x, y: b.pos.y };
      // Nothing live — a ball that just died still holds its death position.
      for (let i = balls.length - 1; i >= 0; i--) return { x: balls[i].pos.x, y: balls[i].pos.y };
    }
    return { x: null, y: null };
  }

  /**
   * Which hazard a generic `splash` actually landed in. The rules module fires
   * `splash` for water, lava and out-of-bounds alike, and its `golf:hazard`
   * listener is registered eight boot stages ahead of ours — so we can't
   * intercept the event. Instead we ask the world directly, which is immune to
   * listener ordering: outside the hole's bounds means OB, otherwise probe the
   * surface the dead ball is resting against.
   */
  function splashKind(): string {
    const balls = ctx.services.physics?.balls;
    if (!balls || balls.length === 0) return "splash";
    let dead = balls[balls.length - 1];
    for (let i = balls.length - 1; i >= 0; i--) {
      if (!balls[i].active) { dead = balls[i]; break; }
    }
    const bounds = ctx.services.course?.current?.bounds;
    if (bounds && (dead.pos.x < bounds.min.x || dead.pos.x > bounds.max.x || dead.pos.y < bounds.min.y)) {
      return "penalty";
    }
    const hit = ctx.services.physics?.probe(dead.pos, dead.radius + 1.2);
    if (hit?.material === "lava") return "lava";
    if (hit?.material === "outOfBounds") return "penalty";
    return "splash";
  }

  // -------------------------------------------------------------------------
  // Sound bank
  // -------------------------------------------------------------------------

  /** `v` is the final volume, `r` a rate/pitch multiplier, `p` the pan. */
  type Synth = (e: Engine, t: number, v: number, r: number, p: number) => void;

  /** Per-material impact character. `k` is normalised impact energy, 0..1. */
  function impact(e: Engine, mat: SurfaceMaterial, k: number, t: number, v: number, p: number): void {
    const hard = sat((k - 0.25) / 0.75); // how much "crack" is in the hit
    switch (mat) {
      case "green":
      case "fairway":
      case "rough": {
        const lo = mat === "rough" ? 0.85 : 1;
        tone(e, { t, f0: 150 * lo, f1: 74 * lo, type: "sine", gain: 0.5 * v, attack: 0.002, decay: 0.09 + 0.05 * k, pan: p, wet: 0.05 });
        noise(e, { t, gain: 0.34 * v, filter: "lowpass", f0: 420 + 900 * k, f1: 180, q: 0.9, decay: 0.05 + 0.06 * k, pan: p, wet: 0.05 });
        if (hard > 0.3) noise(e, { t, gain: 0.14 * v * hard, filter: "highpass", f0: 2200, decay: 0.03, pan: p, wet: 0.04 });
        break;
      }
      case "sand": {
        noise(e, { t, gain: 0.42 * v, filter: "bandpass", f0: 900 + 1400 * k, f1: 320, q: 0.7, decay: 0.09 + 0.07 * k, pan: p, wet: 0.03 });
        tone(e, { t, f0: 96, f1: 58, type: "sine", gain: 0.2 * v, decay: 0.06, pan: p, wet: 0.02 });
        break;
      }
      case "stone": {
        tone(e, { t, f0: 320 + 90 * k, f1: 150, type: "triangle", gain: 0.26 * v, attack: 0.001, decay: 0.07, pan: p, wet: 0.16 });
        noise(e, { t, gain: (0.2 + 0.5 * hard) * v, filter: "bandpass", f0: 1400 + 2200 * hard, f1: 700, q: 1.4, decay: 0.04 + 0.09 * hard, pan: p, wet: 0.2 });
        if (hard > 0.5) noise(e, { t, gain: 0.22 * v * hard, filter: "highpass", f0: 4200, decay: 0.05, pan: p, wet: 0.24 });
        break;
      }
      case "metal": {
        const f = 560 + 260 * k;
        tone(e, { t, f0: f, type: "sine", gain: 0.3 * v, attack: 0.001, decay: 0.35 + 0.7 * k, pan: p, wet: 0.28 });
        tone(e, { t, f0: f * 1.41, type: "sine", gain: 0.2 * v, attack: 0.001, decay: 0.25 + 0.5 * k, pan: p, wet: 0.28 });
        tone(e, { t, f0: f * 2.07, type: "sine", gain: 0.12 * v * hard, attack: 0.001, decay: 0.18 + 0.4 * k, pan: p, wet: 0.3 });
        noise(e, { t, gain: 0.2 * v, filter: "bandpass", f0: 3000, q: 2, decay: 0.03, pan: p, wet: 0.1 });
        break;
      }
      case "wood": {
        tone(e, { t, f0: 380 + 120 * k, f1: 250, type: "triangle", gain: 0.34 * v, attack: 0.001, decay: 0.1 + 0.06 * k, pan: p, wet: 0.1 });
        tone(e, { t, f0: 980, type: "sine", gain: 0.12 * v * hard, attack: 0.001, decay: 0.05, pan: p, wet: 0.1 });
        noise(e, { t, gain: 0.2 * v, filter: "bandpass", f0: 900 + 1200 * hard, q: 1.1, decay: 0.035, pan: p, wet: 0.06 });
        break;
      }
      case "ice": {
        tone(e, { t, f0: 1750 + 700 * k, type: "sine", gain: 0.2 * v, attack: 0.001, decay: 0.18 + 0.2 * k, pan: p, wet: 0.34 });
        tone(e, { t, f0: 2680 + 900 * k, type: "sine", gain: 0.12 * v, attack: 0.001, decay: 0.12 + 0.16 * k, pan: p, wet: 0.34 });
        noise(e, { t, gain: 0.16 * v * hard, filter: "highpass", f0: 5200, decay: 0.06, pan: p, wet: 0.3 });
        break;
      }
      case "rubber": {
        tone(e, { t, f0: 420 + 320 * k, f1: 150, sweep: 0.13, type: "sine", gain: 0.44 * v, attack: 0.002, decay: 0.16 + 0.08 * k, pan: p, wet: 0.08 });
        tone(e, { t, f0: 180, f1: 96, sweep: 0.1, type: "triangle", gain: 0.16 * v, decay: 0.1, pan: p, wet: 0.06 });
        break;
      }
      default: {
        tone(e, { t, f0: 170, f1: 90, type: "sine", gain: 0.4 * v, decay: 0.09, pan: p, wet: 0.06 });
        noise(e, { t, gain: 0.24 * v, filter: "lowpass", f0: 700, decay: 0.05, pan: p, wet: 0.05 });
      }
    }
  }

  /** Scattered clicks — debris, rattles, ratchets. */
  function scatter(e: Engine, t: number, n: number, span: number, f: number, v: number, p: number, wet: number): void {
    for (let i = 0; i < n; i++) {
      const u = i / Math.max(1, n - 1);
      const tt = t + span * (u * u * 0.75 + rng() * 0.3 * span);
      noise(e, {
        t: tt,
        gain: v * (0.5 + rng() * 0.5) * (1 - u * 0.55),
        filter: "bandpass",
        f0: f * (0.7 + rng() * 0.9),
        q: 2.4,
        decay: 0.025 + rng() * 0.03,
        pan: p + (rng() - 0.5) * 0.3,
        wet,
      });
    }
  }

  const BANK: Record<string, Synth> = {
    // --- the shot ---------------------------------------------------------
    swing: (e, t, v, r, p) => {
      // Whoosh pitch rides power: the caller sends volume 0.5..1 for 0..100%.
      const k = sat((v - 0.4) / 0.7);
      const rate = r * (0.82 + 0.55 * k);
      // A bandpass throws away most of the noise energy, so these gains run
      // high compared with the tonal voices — measured, not guessed.
      noise(e, {
        t, gain: 0.62 * v, filter: "bandpass", f0: 260 * rate, f1: 1500 * rate,
        q: 0.7, attack: 0.05, decay: 0.11, rate, pan: p, wet: 0.08,
      });
      noise(e, {
        t: t + 0.05, gain: 0.5 * v, filter: "bandpass", f0: 1500 * rate, f1: 380 * rate,
        q: 0.9, attack: 0.02, decay: 0.13, rate, pan: p, wet: 0.1,
      });
    },
    hit: (e, t, v, r, p) => {
      tone(e, { t, f0: 1500 * r, f1: 210 * r, sweep: 0.035, type: "triangle", gain: 0.5 * v, attack: 0.001, decay: 0.05, pan: p, wet: 0.1 });
      noise(e, { t, gain: 0.44 * v, filter: "highpass", f0: 2600, decay: 0.022, pan: p, wet: 0.1 });
      tone(e, { t, f0: 190, f1: 110, type: "sine", gain: 0.3 * v, decay: 0.07, pan: p, wet: 0.05 });
    },
    bounce: (e, t, v, _r, p) => impact(e, "fairway", 0.5, t, v, p),

    // --- hazards ----------------------------------------------------------
    splash: (e, t, v, r, p) => {
      noise(e, { t, gain: 0.42 * v, filter: "lowpass", f0: 2400 * r, f1: 260, q: 0.8, attack: 0.004, decay: 0.34, pan: p, wet: 0.24 });
      tone(e, { t: t + 0.01, f0: 420 * r, f1: 980 * r, sweep: 0.1, type: "sine", gain: 0.2 * v, decay: 0.14, pan: p, wet: 0.3 });
      tone(e, { t: t + 0.07, f0: 300 * r, f1: 760 * r, sweep: 0.12, type: "sine", gain: 0.13 * v, decay: 0.16, pan: p, wet: 0.3 });
      noise(e, { t: t + 0.06, gain: 0.16 * v, filter: "highpass", f0: 3200, decay: 0.22, pan: p, wet: 0.28 });
    },
    lava: (e, t, v, r, p) => {
      tone(e, { t, f0: 74 * r, f1: 38 * r, type: "sine", gain: 0.5 * v, attack: 0.01, decay: 0.7, pan: p, wet: 0.2 });
      noise(e, { t, gain: 0.3 * v, filter: "lowpass", f0: 700, f1: 200, decay: 0.5, pan: p, wet: 0.2 });
      // The sizzle tail is what sells molten rock.
      noise(e, { t: t + 0.04, gain: 0.2 * v, filter: "highpass", f0: 3600, attack: 0.03, hold: 0.1, decay: 0.6, pan: p, wet: 0.3 });
    },
    stick: (e, t, v, r, p) => {
      tone(e, { t, f0: 240 * r, f1: 88 * r, sweep: 0.06, type: "sine", gain: 0.34 * v, decay: 0.09, pan: p, wet: 0.05 });
      noise(e, { t, gain: 0.24 * v, filter: "lowpass", f0: 620, decay: 0.06, pan: p, wet: 0.05 });
    },
    penalty: (e, t, v, r, p) => {
      tone(e, { t, f0: 330 * r, type: "triangle", gain: 0.24 * v, attack: 0.008, decay: 0.2, pan: p, wet: 0.22 });
      tone(e, { t: t + 0.13, f0: 247 * r, type: "triangle", gain: 0.22 * v, attack: 0.008, decay: 0.34, pan: p, wet: 0.26 });
      tone(e, { t, f0: 110, f1: 70, type: "sine", gain: 0.2 * v, decay: 0.2, pan: p, wet: 0.1 });
    },

    // --- the money sound --------------------------------------------------
    holed: (e, t, v, r, p) => {
      // Rattle first: the ball skittering round the plastic cup.
      for (let i = 0; i < 5; i++) {
        const tt = t + 0.02 + i * 0.055 * (1 - i * 0.06);
        tone(e, { t: tt, f0: (620 + rng() * 280) * r, f1: 320, sweep: 0.03, type: "triangle", gain: 0.16 * v * (1 - i * 0.14), attack: 0.001, decay: 0.045, pan: p, wet: 0.12 });
        noise(e, { t: tt, gain: 0.12 * v, filter: "bandpass", f0: 1800, q: 2, decay: 0.03, pan: p, wet: 0.12 });
      }
      // Then the warm chime — a rising major triad with a long tail.
      const base = 523.25 * r;
      bell(e, t + 0.14, base, 0.2 * v, 0.9, p, 0.4);
      bell(e, t + 0.24, base * 1.26, 0.17 * v, 1.1, p, 0.42);
      bell(e, t + 0.34, base * 1.5, 0.19 * v, 1.6, p, 0.45);
      tone(e, { t: t + 0.34, f0: base * 0.5, type: "sine", gain: 0.1 * v, attack: 0.06, decay: 1.6, pan: p, wet: 0.4 });
    },
    win: (e, t, v, r, p) => {
      // Pentatonic fanfare over a sustained fifth. Big, but never harsh.
      const root = 392 * r;
      const steps = [0, 4, 7, 12, 16, 19];
      for (let i = 0; i < steps.length; i++) {
        const tt = t + i * 0.11;
        const f = root * Math.pow(2, steps[i] / 12);
        bell(e, tt, f, (0.2 - i * 0.012) * v, 0.7 + i * 0.16, p + (i - 2.5) * 0.06, 0.4);
      }
      tone(e, { t, f0: root * 0.5, type: "triangle", gain: 0.11 * v, attack: 0.12, hold: 0.5, decay: 1.6, pan: p, wet: 0.4 });
      tone(e, { t, f0: root * 0.75, type: "sine", gain: 0.09 * v, attack: 0.16, hold: 0.5, decay: 1.8, pan: p, wet: 0.4 });
      scatter(e, t + 0.62, 7, 0.5, 5200, 0.07 * v, p, 0.4);
    },

    // --- props ------------------------------------------------------------
    portal: (e, t, v, r, p) => {
      tone(e, { t, f0: 200 * r, f1: 1500 * r, sweep: 0.26, type: "sine", gain: 0.24 * v, attack: 0.01, decay: 0.28, pan: p, wet: 0.45 });
      tone(e, { t, f0: 1300 * r, f1: 300 * r, sweep: 0.3, type: "triangle", gain: 0.13 * v, attack: 0.02, decay: 0.3, pan: -p, wet: 0.45 });
      noise(e, { t, gain: 0.14 * v, filter: "bandpass", f0: 800, f1: 5000, q: 3, attack: 0.05, decay: 0.3, pan: p, wet: 0.5 });
    },
    bumper: (e, t, v, r, p) => {
      tone(e, { t, f0: 700 * r, f1: 190 * r, sweep: 0.14, type: "sine", gain: 0.46 * v, attack: 0.002, decay: 0.2, pan: p, wet: 0.14 });
      tone(e, { t, f0: 1400 * r, f1: 620 * r, sweep: 0.06, type: "triangle", gain: 0.14 * v, attack: 0.001, decay: 0.09, pan: p, wet: 0.16 });
      tone(e, { t, f0: 150, f1: 82, type: "sine", gain: 0.22 * v, decay: 0.12, pan: p, wet: 0.06 });
    },
    fan: (e, t, v, r, p) => {
      noise(e, { t, gain: 0.2 * v, filter: "bandpass", f0: 620 * r, f1: 900 * r, q: 0.8, attack: 0.09, hold: 0.12, decay: 0.3, rate: r, pan: p, wet: 0.16 });
      noise(e, { t, gain: 0.09 * v, filter: "highpass", f0: 3200, attack: 0.12, decay: 0.3, pan: p, wet: 0.2 });
    },
    boost: (e, t, v, r, p) => {
      tone(e, { t, f0: 190 * r, f1: 1500 * r, sweep: 0.24, type: "sawtooth", gain: 0.16 * v, attack: 0.01, decay: 0.26, pan: p, wet: 0.16 });
      noise(e, { t, gain: 0.26 * v, filter: "bandpass", f0: 500, f1: 4200, q: 1.1, attack: 0.02, decay: 0.24, pan: p, wet: 0.2 });
      tone(e, { t, f0: 120, f1: 200, type: "sine", gain: 0.2 * v, decay: 0.16, pan: p, wet: 0.06 });
    },
    break: (e, t, v, r, p) => {
      noise(e, { t, gain: 0.5 * v, filter: "bandpass", f0: 2600 * r, f1: 900, q: 1.2, decay: 0.07, pan: p, wet: 0.22 });
      tone(e, { t, f0: 260, f1: 120, type: "triangle", gain: 0.22 * v, attack: 0.001, decay: 0.09, pan: p, wet: 0.12 });
      scatter(e, t + 0.03, 6, 0.26, 2600, 0.16 * v, p, 0.24);
    },
    cannon: (e, t, v, r, p) => {
      tone(e, { t, f0: 150 * r, f1: 44, sweep: 0.18, type: "sine", gain: 0.6 * v, attack: 0.003, decay: 0.42, pan: p, wet: 0.24 });
      noise(e, { t, gain: 0.44 * v, filter: "lowpass", f0: 1800, f1: 240, decay: 0.3, pan: p, wet: 0.26 });
      noise(e, { t, gain: 0.24 * v, filter: "highpass", f0: 3000, decay: 0.05, pan: p, wet: 0.2 });
    },
    cannonLoad: (e, t, v, _r, p) => {
      for (let i = 0; i < 5; i++) {
        noise(e, { t: t + i * 0.05, gain: 0.5 * v, filter: "bandpass", f0: 1100 + i * 260, q: 2.2, decay: 0.03, pan: p, wet: 0.1 });
        tone(e, { t: t + i * 0.05, f0: 300 + i * 70, type: "square", gain: 0.05 * v, attack: 0.002, decay: 0.025, pan: p, wet: 0.08 });
      }
    },
    thud: (e, t, v, r, p) => {
      tone(e, { t, f0: 140 * r, f1: 66 * r, type: "sine", gain: 0.46 * v, decay: 0.13, pan: p, wet: 0.06 });
      noise(e, { t, gain: 0.22 * v, filter: "lowpass", f0: 480, decay: 0.07, pan: p, wet: 0.05 });
    },

    // --- jetpack transients (the loop itself is special-cased) -------------
    jetpackOn: (e, t, v, r, p) => {
      tone(e, { t, f0: 60, f1: 130, sweep: 0.16, type: "sine", gain: 0.4 * v, attack: 0.006, decay: 0.2, pan: p, wet: 0.1 });
      noise(e, { t, gain: 0.3 * v, filter: "bandpass", f0: 400, f1: 2400, q: 0.9, attack: 0.02, decay: 0.28, rate: r, pan: p, wet: 0.16 });
    },
    jetpackOff: (e, t, v, r, p) => {
      noise(e, { t, gain: 0.22 * v, filter: "bandpass", f0: 1800 * r, f1: 320, q: 1, attack: 0.01, decay: 0.26, pan: p, wet: 0.14 });
      tone(e, { t, f0: 300, f1: 110, sweep: 0.2, type: "triangle", gain: 0.12 * v, decay: 0.22, pan: p, wet: 0.12 });
    },
    sputter: (e, t, v, r, p) => {
      for (let i = 0; i < 4; i++) {
        noise(e, { t: t + i * 0.07, gain: 0.24 * v * (1 - i * 0.18), filter: "lowpass", f0: 900 - i * 140, decay: 0.05, pan: p, wet: 0.1 });
        tone(e, { t: t + i * 0.07, f0: (190 - i * 26) * r, f1: 90, type: "square", gain: 0.07 * v, decay: 0.05, pan: p, wet: 0.08 });
      }
    },
    downSweep: (e, t, v, r, p) => {
      tone(e, { t, f0: 900 * r, f1: 180 * r, sweep: 0.24, type: "sine", gain: 0.2 * v, attack: 0.006, decay: 0.26, pan: p, wet: 0.2 });
      noise(e, { t, gain: 0.1 * v, filter: "lowpass", f0: 2400, f1: 400, decay: 0.24, pan: p, wet: 0.2 });
    },

    // --- UI ---------------------------------------------------------------
    tick: (e, t, v, r, p) => {
      // A 1 ms attack on a sine is a step edge: it measures far louder than
      // its gain suggests and reads as a spit. 5 ms keeps it a tick.
      tone(e, { t, f0: 1250 * r, type: "sine", gain: 0.13 * v, attack: 0.005, decay: 0.035, pan: p, wet: 0.06 });
      noise(e, { t, gain: 0.06 * v, filter: "highpass", f0: 4200, attack: 0.003, decay: 0.015, pan: p, wet: 0.06 });
    },
    select: (e, t, v, r, p) => {
      tone(e, { t, f0: 660 * r, type: "sine", gain: 0.18 * v, attack: 0.002, decay: 0.07, pan: p, wet: 0.14 });
      tone(e, { t: t + 0.055, f0: 990 * r, type: "sine", gain: 0.16 * v, attack: 0.002, decay: 0.13, pan: p, wet: 0.18 });
    },
    deny: (e, t, v, r, p) => {
      tone(e, { t, f0: 196 * r, type: "square", gain: 0.16 * v, attack: 0.004, decay: 0.06, pan: p, wet: 0.08 });
      tone(e, { t: t + 0.085, f0: 165 * r, type: "square", gain: 0.15 * v, attack: 0.004, decay: 0.1, pan: p, wet: 0.08 });
    },
    pickup: (e, t, v, r, p) => {
      const f = 784 * r;
      bell(e, t, f, 0.13 * v, 0.28, p, 0.28);
      bell(e, t + 0.07, f * 1.26, 0.12 * v, 0.34, p, 0.3);
      bell(e, t + 0.14, f * 1.5, 0.12 * v, 0.5, p, 0.34);
    },
    unlock: (e, t, v, r, p) => {
      const f = 523.25 * r;
      const steps = [0, 2, 4, 7, 9];
      for (let i = 0; i < steps.length; i++) {
        bell(e, t + i * 0.09, f * Math.pow(2, steps[i] / 12), (0.14 - i * 0.012) * v, 0.5 + i * 0.14, p, 0.36);
      }
      scatter(e, t + 0.4, 5, 0.4, 6000, 0.05 * v, p, 0.4);
    },
    generic: (e, t, v, r, p) => {
      tone(e, { t, f0: 520 * r, f1: 380 * r, type: "sine", gain: 0.14 * v, attack: 0.003, decay: 0.09, pan: p, wet: 0.12 });
    },
  };

  /**
   * Names other systems call, mapped onto the bank. New callers land on
   * `generic` rather than silence — or worse, an exception.
   */
  const ALIAS: Record<string, string> = {
    boing: "bumper",
    boom: "cannon",
    breakHit: "break",
    click: "tick",
    clank: "thud",
    close: "tick",
    fanWhoosh: "fan",
    hole: "holed",
    holeOut: "holed",
    jetpackOut: "sputter",
    land: "thud",
    nitro: "boost",
    nitroOut: "downSweep",
    open: "select",
    phaseIn: "portal",
    phaseOut: "downSweep",
    platformClank: "thud",
    shatter: "break",
    splash_in: "splash",
    splash_out: "splash",
    thump: "thud",
    ui: "tick",
    whoosh: "swing",
  };

  // -------------------------------------------------------------------------
  // Jetpack loop
  // -------------------------------------------------------------------------

  /**
   * The jetpack is retriggered ~10×/s by `play.jetpack`, so instead of firing
   * a voice per call we hold one continuous noise+rumble loop and steer it,
   * killing it when the retriggers stop. Continuous thrust, no machine-gun
   * artefacts, four nodes total.
   */
  interface JetLoop {
    src: AudioBufferSourceNode;
    filt: BiquadFilterNode;
    gain: GainNode;
    rumble: OscillatorNode;
    rumbleGain: GainNode;
    until: number;
  }
  let jet: JetLoop | null = null;

  function jetpackLoop(e: Engine, v: number, r: number, p: number): void {
    const t = e.ac.currentTime;
    if (!jet) {
      const src = e.ac.createBufferSource();
      src.buffer = e.noise;
      src.loop = true;
      const filt = e.ac.createBiquadFilter();
      filt.type = "bandpass";
      filt.Q.value = 0.8;
      filt.frequency.value = 900;
      const gain = e.ac.createGain();
      gain.gain.value = 0.0001;
      src.connect(filt);
      filt.connect(gain);
      route(e, gain, p, 0.14);

      const rumble = e.ac.createOscillator();
      rumble.type = "sawtooth";
      rumble.frequency.value = 58;
      const rumbleGain = e.ac.createGain();
      rumbleGain.gain.value = 0.0001;
      const lp = e.ac.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 220;
      rumble.connect(lp);
      lp.connect(rumbleGain);
      route(e, rumbleGain, p, 0.05);

      src.start(t);
      rumble.start(t);
      jet = { src, filt, gain, rumble, rumbleGain, until: t };
      voiceLoad += 2;
    }
    jet.until = t + 0.26;
    const k = sat(r - 0.6);
    // Watchdog envelope: every retrigger cancels a fade-out scheduled just
    // beyond the next expected one, so thrust is seamless while the calls
    // keep coming and the loop kills *itself* the moment they stop. Node
    // teardown still happens in update(), but if the frame loop ever stalls
    // the player is left with silence rather than a droning jetpack.
    jet.gain.gain.cancelScheduledValues(t);
    jet.rumbleGain.gain.cancelScheduledValues(t);
    jet.gain.gain.setTargetAtTime(0.3 * v, t, 0.05);
    jet.rumbleGain.gain.setTargetAtTime(0.12 * v, t, 0.06);
    jet.gain.gain.setTargetAtTime(0.0001, t + 0.2, 0.05);
    jet.rumbleGain.gain.setTargetAtTime(0.0001, t + 0.2, 0.05);
    jet.filt.frequency.setTargetAtTime(600 + 2200 * k, t, 0.06);
    jet.rumble.frequency.setTargetAtTime(46 + 40 * k, t, 0.08);
  }

  function stopJet(e: Engine): void {
    if (!jet) return;
    const t = e.ac.currentTime;
    jet.gain.gain.setTargetAtTime(0.0001, t, 0.05);
    jet.rumbleGain.gain.setTargetAtTime(0.0001, t, 0.05);
    jet.src.stop(t + 0.35);
    jet.rumble.stop(t + 0.35);
    jet = null;
    voiceLoad = Math.max(0, voiceLoad - 2);
  }

  // -------------------------------------------------------------------------
  // Music — generative ambient bed
  // -------------------------------------------------------------------------

  const PENT_MAJOR = [0, 2, 4, 7, 9];
  const PENT_MINOR = [0, 3, 5, 7, 10];

  interface ThemeMusic {
    /** Root of the pad register, Hz. */
    root: number;
    scale: number[];
    pad: OscillatorType;
    arp: OscillatorType;
    /** Pad lowpass cutoff, Hz — the single biggest timbre lever. */
    cutoff: number;
    /** Reverb wet level for the whole mix. */
    wet: number;
    /** Seconds between chords / between arpeggio notes. */
    chordGap: [number, number];
    arpGap: [number, number];
    /** Chance an arpeggio slot is a rest — sparseness. */
    rest: number;
    drone: number;
  }

  const THEME_MUSIC: Record<CourseTheme, ThemeMusic> = {
    seaside: { root: 220.0, scale: PENT_MAJOR, pad: "triangle", arp: "sine", cutoff: 1100, wet: 0.2, chordGap: [8, 12], arpGap: [1.4, 3.4], rest: 0.3, drone: 0.05 },
    jungle: { root: 196.0, scale: PENT_MINOR, pad: "triangle", arp: "triangle", cutoff: 820, wet: 0.24, chordGap: [7, 11], arpGap: [1.0, 2.6], rest: 0.28, drone: 0.06 },
    canyon: { root: 146.83, scale: PENT_MINOR, pad: "sine", arp: "sine", cutoff: 700, wet: 0.42, chordGap: [10, 15], arpGap: [2.2, 5.0], rest: 0.42, drone: 0.07 },
    neon: { root: 261.63, scale: PENT_MAJOR, pad: "sawtooth", arp: "square", cutoff: 620, wet: 0.26, chordGap: [6, 9], arpGap: [0.7, 1.8], rest: 0.2, drone: 0.05 },
    sky: { root: 293.66, scale: PENT_MAJOR, pad: "sine", arp: "sine", cutoff: 1500, wet: 0.34, chordGap: [9, 14], arpGap: [1.8, 4.2], rest: 0.36, drone: 0.035 },
    volcano: { root: 130.81, scale: PENT_MINOR, pad: "sawtooth", arp: "triangle", cutoff: 480, wet: 0.36, chordGap: [9, 13], arpGap: [2.4, 5.5], rest: 0.45, drone: 0.09 },
    glacier: { root: 246.94, scale: PENT_MAJOR, pad: "sine", arp: "sine", cutoff: 1800, wet: 0.48, chordGap: [11, 16], arpGap: [2.0, 4.6], rest: 0.4, drone: 0.04 },
  };

  let musicTimer = 0;
  let nextChord = 0;
  let nextArp = 0;
  let drone: { osc: OscillatorNode; sub: OscillatorNode; gain: GainNode } | null = null;
  let delayIn: GainNode | null = null;

  const between = (a: number, b: number): number => a + rng() * (b - a);
  const hz = (root: number, semis: number): number => root * Math.pow(2, semis / 12);

  /** Reverb wetness follows the theme — canyons and caves ring, seaside doesn't. */
  function applyThemeSpace(): void {
    const e = eng;
    if (!e?.wet) return;
    const m = THEME_MUSIC[theme] ?? THEME_MUSIC.seaside;
    e.wet.gain.setTargetAtTime(0.1 + m.wet * 0.55, e.ac.currentTime, 1.5);
  }

  function musicDest(e: Engine): GainNode {
    if (delayIn) return delayIn;
    // One shared feedback delay for the whole music bus — the arpeggios get
    // their echo for four nodes total instead of a delay line per note.
    const d = e.ac.createDelay(1.5);
    d.delayTime.value = 0.42;
    const fb = e.ac.createGain();
    fb.gain.value = 0.32;
    const lp = e.ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    const inGain = e.ac.createGain();
    inGain.gain.value = 1;
    inGain.connect(e.music);
    inGain.connect(d);
    d.connect(lp);
    lp.connect(fb);
    fb.connect(d);
    lp.connect(e.music);
    if (e.send) {
      const s = e.ac.createGain();
      s.gain.value = 0.4;
      lp.connect(s);
      s.connect(e.send);
    }
    delayIn = inGain;
    return inGain;
  }

  function scheduleChord(e: Engine, t: number): void {
    const m = THEME_MUSIC[theme] ?? THEME_MUSIC.seaside;
    const dest = musicDest(e);
    const filt = e.ac.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.setValueAtTime(m.cutoff * 0.6, t);
    filt.frequency.linearRampToValueAtTime(m.cutoff, t + 4);
    filt.Q.value = 0.6;
    const g = e.ac.createGain();
    // Long attack / long release, overlapping the next chord: no seam, ever.
    shape(g.gain, t, 0.16, 3.6, 2.2, 5.0);
    filt.connect(g);
    route(e, g, (rng() - 0.5) * 0.5, 0.5, dest);

    // Root plus two scale tones, one of them an octave up. Pentatonic means
    // any combination is consonant, so the "harmony" can be random.
    const pick = [0, 1 + Math.floor(rng() * 2), 2 + Math.floor(rng() * 3)];
    for (let i = 0; i < pick.length; i++) {
      const idx = pick[i] % m.scale.length;
      const oct = i === 2 && rng() < 0.6 ? 12 : 0;
      const f = hz(m.root, m.scale[idx] + oct);
      for (let d = 0; d < 2; d++) {
        const o = e.ac.createOscillator();
        o.type = m.pad;
        o.frequency.value = f;
        o.detune.value = d === 0 ? -5 : 6;
        const vg = e.ac.createGain();
        vg.gain.value = (i === 0 ? 0.5 : 0.34) / 2;
        o.connect(vg);
        vg.connect(filt);
        o.start(t);
        o.stop(t + 3.6 + 2.2 + 5.0 + 0.2);
      }
    }
  }

  function scheduleArp(e: Engine, t: number): void {
    const m = THEME_MUSIC[theme] ?? THEME_MUSIC.seaside;
    if (rng() < m.rest) return;
    const dest = musicDest(e);
    const idx = Math.floor(rng() * m.scale.length);
    const oct = 12 * (1 + (rng() < 0.35 ? 1 : 0));
    const f = hz(m.root, m.scale[idx] + oct);
    const g = 0.075 * (0.6 + rng() * 0.5);
    tone(e, { t, f0: f, type: m.arp, gain: g, attack: 0.02, decay: 0.9 + rng() * 0.8, pan: (rng() - 0.5) * 1.2, wet: 0.6, dest });
    // A quiet octave shimmer on some notes keeps the texture from flattening.
    if (rng() < 0.4) {
      tone(e, { t: t + 0.02, f0: f * 2, type: "sine", gain: g * 0.3, attack: 0.03, decay: 0.7, pan: (rng() - 0.5) * 1.2, wet: 0.6, dest });
    }
  }

  /** Lookahead scheduler — fires 1.5× per second, schedules 2.5 s ahead. */
  function pump(): void {
    const e = eng;
    if (!e || !musicOn || muted) return;
    if (e.ac.state === "suspended") return;
    const m = THEME_MUSIC[theme] ?? THEME_MUSIC.seaside;
    const now = e.ac.currentTime;
    const ahead = now + 2.5;
    if (nextChord < now) nextChord = now + 0.3;
    if (nextArp < now) nextArp = now + 0.8;
    let guard = 0;
    while (nextChord < ahead && guard++ < 8) {
      scheduleChord(e, nextChord);
      nextChord += between(m.chordGap[0], m.chordGap[1]);
    }
    guard = 0;
    while (nextArp < ahead && guard++ < 12) {
      scheduleArp(e, nextArp);
      nextArp += between(m.arpGap[0], m.arpGap[1]);
    }
  }

  function startMusic(): void {
    const e = ensure();
    if (!e || musicOn || muted) return;
    musicOn = true;
    const t = e.ac.currentTime;
    e.music.gain.cancelScheduledValues(t);
    e.music.gain.setTargetAtTime(MUSIC_GAIN, t, 1.6);

    const m = THEME_MUSIC[theme] ?? THEME_MUSIC.seaside;
    if (!drone) {
      const dest = musicDest(e);
      const osc = e.ac.createOscillator();
      osc.type = "sine";
      osc.frequency.value = m.root * 0.5;
      const sub = e.ac.createOscillator();
      sub.type = "sine";
      sub.frequency.value = m.root * 0.25;
      sub.detune.value = 4;
      const g = e.ac.createGain();
      g.gain.value = 0.0001;
      g.gain.setTargetAtTime(m.drone, t, 3);
      osc.connect(g);
      sub.connect(g);
      route(e, g, 0, 0.5, dest);
      osc.start(t);
      sub.start(t);
      drone = { osc, sub, gain: g };
    }
    nextChord = 0;
    nextArp = 0;
    pump();
    if (!musicTimer && typeof window !== "undefined") {
      musicTimer = window.setInterval(pump, 650);
    }
  }

  function stopMusic(): void {
    musicOn = false;
    if (musicTimer) {
      clearInterval(musicTimer);
      musicTimer = 0;
    }
    const e = eng;
    if (!e) return;
    const t = e.ac.currentTime;
    e.music.gain.cancelScheduledValues(t);
    e.music.gain.setTargetAtTime(0.0001, t, 0.8);
    if (drone) {
      drone.gain.gain.setTargetAtTime(0.0001, t, 0.8);
      drone.osc.stop(t + 4);
      drone.sub.stop(t + 4);
      drone = null;
    }
  }

  /** Retune the drone and re-space the reverb when the hole's theme changes. */
  function setTheme(next: CourseTheme): void {
    if (next === theme) return;
    theme = next;
    applyThemeSpace();
    const e = eng;
    const m = THEME_MUSIC[theme] ?? THEME_MUSIC.seaside;
    if (e && drone) {
      const t = e.ac.currentTime;
      drone.osc.frequency.setTargetAtTime(m.root * 0.5, t, 2.5);
      drone.sub.frequency.setTargetAtTime(m.root * 0.25, t, 2.5);
      drone.gain.gain.setTargetAtTime(m.drone, t, 2.5);
    }
    // Let the new key arrive on the next chord rather than cutting the old one.
    nextChord = 0;
  }

  // -------------------------------------------------------------------------
  // Service
  // -------------------------------------------------------------------------

  /** Sounds that always get a voice, budget or not. */
  const CRITICAL = new Set(["holed", "win", "splash", "lava", "cannon", "portal", "unlock", "penalty"]);
  const lastAt = new Map<string, number>();
  /** Minimum retrigger gaps, seconds. Anything not listed uses 0.03. */
  const GAP: Record<string, number> = { bounce: 0.028, thud: 0.03, tick: 0.02, fan: 0.16, splash: 0.2, break: 0.05 };

  function fire(name: string, opts?: { volume?: number; rate?: number; pan?: number }): void {
    const e = ensure();
    if (!e || muted) return;
    resume();
    if (e.ac.state !== "running") return; // still gated by the browser

    let key = ALIAS[name] ?? name;
    // A hazard fires `splash` whatever it landed in; specialise it here so the
    // rules module never has to know about lava.
    if (key === "splash") key = splashKind();

    const t = e.ac.currentTime + SCHED_AHEAD;
    const gap = GAP[key] ?? 0.03;
    const prev = lastAt.get(key);
    if (prev !== undefined && t - prev < gap) return;
    lastAt.set(key, t);

    if (load(e) > VOICE_BUDGET && !CRITICAL.has(key)) return;

    const synth = BANK[key] ?? BANK.generic;
    let vol = opts?.volume ?? 1;
    let pan = opts?.pan ?? 0;
    if (opts?.pan === undefined) {
      const b = ballPoint();
      const sp = spatial(b.x, b.y);
      pan = sp.pan;
      vol *= sp.gain;
    } else {
      // Callers that supply a pan already did the geometry; just roll off a
      // little at the screen edges so nothing shouts from off-camera.
      vol *= 1 - 0.22 * Math.abs(clamp(pan, -1, 1));
    }

    if (key === "jetpack") {
      jetpackLoop(e, vol, opts?.rate ?? 1, pan);
      return;
    }

    try {
      synth(e, t, clamp(vol, 0, 2), clamp(opts?.rate ?? 1, 0.25, 4), pan);
    } catch (err) {
      // A bad param must never take the frame down with it.
      if (!dead) console.warn("[Vibe Golf] audio voice failed:", name, err);
    }
  }

  const service: AudioService2 = {
    play(name, opts) {
      try {
        fire(name, opts);
      } catch {
        /* audio is never load-bearing */
      }
    },
    music(on) {
      musicWanted = on;
      try {
        if (on) startMusic();
        else stopMusic();
      } catch {
        /* ditto */
      }
    },
  };

  ctx.services.audio = service;

  // -------------------------------------------------------------------------
  // Gesture unlock + wiring
  // -------------------------------------------------------------------------

  let unlocked = false;
  function unlock(): void {
    if (unlocked) return;
    unlocked = true;
    const e = ensure();
    if (!e) return;
    resume();
    // Music can only begin once the context is actually running.
    if (musicWanted && !muted) window.setTimeout(() => startMusic(), 60);
  }

  const GESTURES = ["pointerdown", "touchstart", "mousedown", "keydown"] as const;
  if (typeof window !== "undefined") {
    for (const g of GESTURES) window.addEventListener(g, unlock, { passive: true });
  }

  function onVisibility(): void {
    const e = eng;
    if (!e) return;
    hidden = typeof document !== "undefined" && document.hidden;
    e.master.gain.setTargetAtTime(muted || hidden ? 0.0001 : MASTER_GAIN, e.ac.currentTime, 0.15);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  function setMuted(on: boolean): void {
    muted = on;
    try {
      localStorage.setItem(MUTE_KEY, on ? "1" : "0");
    } catch {
      /* nothing to persist to */
    }
    const e = eng;
    if (e) e.master.gain.setTargetAtTime(on || hidden ? 0.0001 : MASTER_GAIN, e.ac.currentTime, 0.12);
    if (on) stopMusic();
    else if (musicWanted && unlocked) startMusic();
    ctx.emit("golf:audioState", { muted, music: musicOn });
  }

  const offs: Array<() => void> = [];

  offs.push(ctx.on("golf:mute", (p) => {
    const on = typeof p === "boolean" ? p : !!(p as { muted?: boolean; on?: boolean })?.muted
      || !!(p as { on?: boolean })?.on;
    setMuted(on);
  }));

  // Impact energy → volume, brightness and transient content. This is the one
  // mapping that has to feel right; everything else is decoration.
  offs.push(ctx.on("golf:bounce", (p) => {
    const d = p as { at?: { x: number; y: number }; material?: SurfaceMaterial; speed?: number };
    const e = ensure();
    if (!e || muted || e.ac.state !== "running") return;
    const speed = d?.speed ?? 4;
    if (speed < 0.5) return;
    const k = sat(speed / SLAM_SPEED);
    const t = e.ac.currentTime + SCHED_AHEAD;
    if (t - (lastAt.get("bounce") ?? -1) < 0.026) return;
    lastAt.set("bounce", t);
    if (load(e) > VOICE_BUDGET) return;
    const sp = spatial(d?.at?.x ?? null, d?.at?.y ?? null);
    // k^0.6 keeps quiet taps audible without letting slams dominate.
    const vol = (0.14 + 0.86 * Math.pow(k, 0.6)) * sp.gain;
    try {
      impact(e, d?.material ?? "fairway", k, t, vol, sp.pan);
    } catch {
      /* keep rolling */
    }
  }));

  offs.push(ctx.on("golf:shot", (p) => {
    const power = (p as { power?: number })?.power ?? 0.6;
    // The whoosh comes from rules; this is the clubface click on top of it.
    fire("hit", { volume: 0.45 + 0.55 * power, rate: 1.08 - 0.22 * power });
  }));

  offs.push(ctx.on("golf:penalty", () => fire("penalty", { volume: 0.55 })));
  offs.push(ctx.on("golf:courseComplete", () => fire("win", { volume: 1 })));

  offs.push(ctx.on("golf:hole", (p) => {
    const t = (p as { hole?: { theme?: CourseTheme } })?.hole?.theme;
    if (t && THEME_MUSIC[t]) setTheme(t);
  }));

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  const sys: System = {
    name: "audio",

    update() {
      // The voice-load estimate decays on the audio clock inside `load()`,
      // so all this has to do is retire a jetpack loop nobody is feeding.
      const e = eng;
      if (e && jet && e.ac.currentTime > jet.until) stopJet(e);
    },

    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      if (typeof window !== "undefined") {
        for (const g of GESTURES) window.removeEventListener(g, unlock);
      }
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      stopMusic();
      const e = eng;
      if (e) {
        try {
          stopJet(e);
          e.master.gain.value = 0;
          void e.ac.close().catch(() => { /* already gone */ });
        } catch {
          /* nothing to clean */
        }
      }
      eng = null;
      dead = true;
      if (ctx.services.audio === service) ctx.services.audio = undefined;
    },
  };

  return sys;
};

export default createAudio;
