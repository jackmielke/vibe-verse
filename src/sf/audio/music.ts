/**
 * audio/music.ts — the adaptive score.
 *
 * No stems on disk. Four synthesised layers, all running all the time, mixed
 * in and out by what the player is doing:
 *
 *   - **drone**   — a slow detuned pad on the current chord. Always audible at
 *                   some level; it is the harmonic bed everything else sits on.
 *   - **pulse**   — a filtered sixteenth-note bass figure. Comes in with
 *                   movement: driving fast or flying is *momentum*, and this is
 *                   the layer that says so.
 *   - **percussion** — kick, snare, hats. Comes in with heat. Nothing signals
 *                   "you are in trouble" like a drum kit arriving.
 *   - **lead**    — a sparse modal melody over the top, reserved for the high
 *                   end of the intensity curve so it never wears out.
 *
 * The scheduler is the standard WebAudio lookahead: the frame loop pushes
 * events into the audio clock up to 200 ms ahead, so scheduling accuracy is
 * sample-exact and completely immune to frame-rate hitching. Layer changes are
 * quantised to the bar, which is what makes intensity transitions feel
 * composed rather than like someone riding a fader.
 *
 * Public API
 * ----------
 *   music.start() / stop() / update(dt) / setEnabled(b)
 *   music.setIntensity(0..1)      — usually driven automatically
 *   music.stinger(kind)           — heat-up, objective, death
 *   music.state                   — bar/beat/intensity, for the debug overlay
 */
import { clamp01, makeRng, type Rng } from "../math/rng";
import { WORLD_SEED } from "../config";
import { frame, useSfStore } from "../state/store";
import { audioEngine } from "./engine";
import { voicePool, beginOptions, type Voice, type VoiceOptions } from "./spatial";
import {
  bakeSync,
  dcBlock,
  edgeFade,
  fillNoise,
  noteHz,
  normalize,
  percEnv,
  saturator,
  softClip,
  svfSweep,
} from "./synth";

/* ================================================================== *
 * Harmony
 * ================================================================== */

/**
 * Aeolian, because the game is a heist movie in a fog bank. Degrees are
 * semitone offsets from the root; the progression walks i – VI – III – VII,
 * which is the most useful four bars in film scoring and never gets stale
 * under a loop because it has no leading tone pulling it home.
 */
const SCALE = [0, 2, 3, 5, 7, 8, 10];
const PROGRESSION = [
  [0, 3, 7, 10], // i7
  [8, 12, 15, 19], // VI
  [3, 7, 10, 14], // III
  [10, 14, 17, 21], // VII
];

const TEMPO = 86; // BPM. Slow enough to sit under gunfire, fast enough to drive.
const BEATS_PER_BAR = 4;
const STEPS_PER_BEAT = 4; // sixteenths
const STEPS_PER_BAR = BEATS_PER_BAR * STEPS_PER_BEAT;

/* ================================================================== *
 * Percussion — baked once
 * ================================================================== */

function renderKick(out: Float32Array, sr: number): void {
  const n = out.length;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // 120 Hz down to 42 Hz in 40 ms: the pitch drop *is* the kick.
    const f = 42 + 78 * Math.exp(-t / 0.028);
    phase += (2 * Math.PI * f) / sr;
    const env = Math.min(1, t / 0.001) * Math.exp(-t / 0.22);
    out[i] = Math.sin(phase) * env;
  }
  // Click, so it survives on laptop speakers with no low end at all.
  for (let i = 0; i < Math.min(n, (sr * 0.004) | 0); i++) {
    out[i] += (i % 3 === 0 ? 1 : -1) * 0.3 * Math.exp(-i / (sr * 0.0006));
  }
  softClip(out, 1.4);
  dcBlock(out, sr, 18);
  normalize(out, 0.95);
  edgeFade(out, sr, 0.05, 8);
}

function renderSnare(out: Float32Array, sr: number, rng: Rng): void {
  const n = out.length;
  const noise = new Float32Array(n);
  fillNoise(noise, "white", rng);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    noise[i] *= Math.min(1, t / 0.0006) * Math.exp(-t / 0.09);
  }
  svfSweep(noise, sr, 5200, 1600, 0.9, 1, (u) => Math.pow(u, 0.5));
  // Two body tones a fourth apart: a snare drum is a tuned shell, not a hiss.
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t / 0.05);
    out[i] =
      noise[i] * 0.85 +
      (Math.sin(2 * Math.PI * 185 * t) * 0.4 + Math.sin(2 * Math.PI * 247 * t) * 0.25) * env;
  }
  softClip(out, 1.2);
  dcBlock(out, sr, 60);
  normalize(out, 0.9);
  edgeFade(out, sr, 0.05, 8);
}

function renderHat(out: Float32Array, sr: number, open: boolean, rng: Rng): void {
  const n = out.length;
  fillNoise(out, "white", rng);
  const decay = open ? 0.24 : 0.038;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] *= Math.min(1, t / 0.0004) * Math.exp(-t / decay);
  }
  // Metallic: a bank of inharmonic ring-mod partials is what makes noise into
  // a cymbal. Cheap version — highpass plus a resonant peak.
  svfSweep(out, sr, 8200, 9600, 1.4, 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] *= 1 + 0.25 * Math.sin(2 * Math.PI * 4300 * t);
  }
  dcBlock(out, sr, 2000);
  normalize(out, 0.7);
  edgeFade(out, sr, 0.05, 6);
}

/**
 * A low tom / floor hit used for accents at bar boundaries. Tuned to the
 * track's root so it never fights the harmony.
 */
function renderTom(out: Float32Array, sr: number, rootHz: number, rng: Rng): void {
  const n = out.length;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = rootHz * (1 + 0.6 * Math.exp(-t / 0.04));
    phase += (2 * Math.PI * f) / sr;
    out[i] = Math.sin(phase) * Math.min(1, t / 0.0012) * Math.exp(-t / 0.32);
  }
  const noise = new Float32Array(Math.min(n, (sr * 0.03) | 0));
  fillNoise(noise, "white", rng);
  for (let i = 0; i < noise.length; i++) out[i] += noise[i] * 0.25 * Math.exp(-i / (sr * 0.004));
  dcBlock(out, sr, 25);
  normalize(out, 0.9);
  edgeFade(out, sr, 0.1, 12);
}

/* ================================================================== *
 * Director
 * ================================================================== */

type StemKey = "drone" | "pulse" | "perc" | "lead";

interface Stem {
  gain: GainNode;
  /** Level the stem should be at once the current bar ends. */
  target: number;
  current: number;
}

export type StingerKind = "heat" | "objective" | "death" | "clear";

class MusicDirector {
  private ctx: AudioContext | null = null;
  private voice: Voice | null = null;
  private stems: Partial<Record<StemKey, Stem>> = {};
  private droneOscs: OscillatorNode[] = [];
  private droneFilter: BiquadFilterNode | null = null;
  private droneLfo: OscillatorNode | null = null;
  private pulseFilter: BiquadFilterNode | null = null;
  private pulseDrive: WaveShaperNode | null = null;
  private started = false;
  private enabled = true;

  private rng: Rng = makeRng(`${WORLD_SEED}:music`);
  private root = 38; // D2
  private stepTime = 60 / TEMPO / STEPS_PER_BEAT;
  private nextStepAt = 0;
  private step = 0;

  private intensity = 0;
  private intensityTarget = 0;

  /** Sixteenth-note patterns, one bit per step. Chosen, not random. */
  private kickPattern = 0b1000001000100000;
  private snarePattern = 0b0000100000001000;
  private hatPattern = 0b1010101010101010;
  private bassPattern = 0b1001001010010010;

  readonly state = { bar: 0, beat: 0, intensity: 0, running: false };

  /* ---------------- lifecycle ---------------- */

  start(): boolean {
    if (this.started) return true;
    const ctx = audioEngine.ctx;
    if (!ctx || !audioEngine.available) return false;
    this.ctx = ctx;

    // Music is head-locked and never occluded — it is not in the world.
    const o = beginOptions();
    o.x = 0;
    o.y = 0;
    o.z = 0;
    o.local = true;
    o.pan = 0;
    o.bus = "music";
    o.gain = 1;
    o.pitch = 1;
    o.priority = 1;
    o.noOcclusion = true;
    o.propagate = false;
    o.duration = 1e9;
    const v = voicePool.acquire(o);
    if (!v) return false;
    v.hold = true;
    this.voice = v;

    for (const k of ["drone", "pulse", "perc", "lead"] as StemKey[]) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(v.input);
      this.stems[k] = { gain: g, target: 0, current: 0 };
    }

    this.buildDrone(ctx);
    this.buildPulseChain(ctx);

    this.nextStepAt = ctx.currentTime + 0.08;
    this.step = 0;
    this.started = true;
    this.state.running = true;
    return true;
  }

  private buildDrone(ctx: AudioContext): void {
    const stem = this.stems.drone;
    if (!stem) return;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 700;
    filter.Q.value = 1.2;
    filter.connect(stem.gain);
    this.droneFilter = filter;

    // Four oscillators: root, fifth and two detuned octaves. The detune is
    // what turns three sawtooths into a pad — perfectly tuned unisons sound
    // synthetic because nothing in the physical world is perfectly in tune.
    const offsets = [0, 12, 19, 24];
    for (let i = 0; i < offsets.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? "sawtooth" : "triangle";
      osc.frequency.value = noteHz(this.root + offsets[i]);
      osc.detune.value = (i - 1.5) * this.rng.range(5, 11);
      const g = ctx.createGain();
      g.gain.value = [0.45, 0.28, 0.2, 0.12][i];
      osc.connect(g);
      g.connect(filter);
      osc.start(ctx.currentTime);
      this.droneOscs.push(osc);
    }

    // Very slow filter movement so the pad breathes.
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.043;
    const lg = ctx.createGain();
    lg.gain.value = 260;
    lfo.connect(lg);
    lg.connect(filter.frequency);
    lfo.start(ctx.currentTime);
    this.droneLfo = lfo;
  }

  private buildPulseChain(ctx: AudioContext): void {
    const stem = this.stems.pulse;
    if (!stem) return;
    const drive = saturator(ctx, 0.35, "asym");
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.Q.value = 5;
    drive.connect(filter);
    filter.connect(stem.gain);
    this.pulseDrive = drive;
    this.pulseFilter = filter;
  }

  stop(): void {
    if (!this.started) return;
    const kill = (n: AudioScheduledSourceNode | null) => {
      if (!n) return;
      try {
        n.stop();
        n.disconnect();
      } catch {
        /* stopped */
      }
    };
    for (const o of this.droneOscs) kill(o);
    kill(this.droneLfo);
    this.droneOscs.length = 0;
    this.droneLfo = null;
    try {
      this.droneFilter?.disconnect();
      this.pulseDrive?.disconnect();
      this.pulseFilter?.disconnect();
      for (const s of Object.values(this.stems)) s?.gain.disconnect();
    } catch {
      /* graph gone */
    }
    this.stems = {};
    this.droneFilter = null;
    this.pulseFilter = null;
    this.pulseDrive = null;
    if (this.voice) {
      this.voice.hold = false;
      voicePool.release(this.voice);
      this.voice = null;
    }
    this.started = false;
    this.state.running = false;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) {
      for (const s of Object.values(this.stems)) {
        s?.gain.gain.setTargetAtTime(0, audioEngine.now, 0.15);
      }
    }
  }

  /* ---------------- intensity ---------------- */

  /**
   * Set the target intensity. Applied at the next bar line, so the arrangement
   * always changes *on* the music. A layer that fades in halfway through a bar
   * sounds like a bug even when it is not.
   */
  setIntensity(v: number): void {
    this.intensityTarget = clamp01(v);
  }

  /**
   * Derive intensity from the game.
   *
   * Heat dominates — a police response should own the mix. Traversal speed
   * contributes a floor so a quiet high-speed wingsuit run is still scored,
   * and altitude adds a touch because being 300 m up is inherently dramatic.
   */
  private autoIntensity(): number {
    const st = useSfStore.getState();
    const heat = clamp01(st.heat / 5);
    const speed = clamp01((frame.speed - 12) / 60);
    const air = frame.movement === "wingsuit" || frame.movement === "parachute" ? 0.28 : 0;
    const dead = st.phase === "dead" ? 0 : 1;
    return clamp01(Math.max(heat, speed * 0.72 + air) * dead);
  }

  /* ---------------- scheduling ---------------- */

  /**
   * Push events into the audio clock. Call once a frame.
   *
   * The loop schedules every step that falls inside the lookahead window, so a
   * 20 ms frame and a 200 ms frame produce identical timing — the audio clock
   * is the only clock that matters here.
   */
  update(dt: number): void {
    if (!this.started || !this.enabled || !this.ctx) return;
    if (frame.paused) return;

    this.setIntensity(this.autoIntensity());

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const lookahead = 0.22;

    let guard = 0;
    while (this.nextStepAt < now + lookahead && guard++ < 64) {
      this.scheduleStep(this.step, this.nextStepAt);
      this.nextStepAt += this.stepTime;
      this.step++;
      if (this.step % STEPS_PER_BAR === 0) this.onBar(this.nextStepAt);
    }

    this.state.bar = Math.floor(this.step / STEPS_PER_BAR);
    this.state.beat = Math.floor((this.step % STEPS_PER_BAR) / STEPS_PER_BEAT);
    this.state.intensity = this.intensity;
    void dt;
  }

  /** Bar boundary: re-voice the chord and commit any intensity change. */
  private onBar(at: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const bar = Math.floor(this.step / STEPS_PER_BAR);
    const chord = PROGRESSION[bar % PROGRESSION.length];

    // Re-voice the drone. Ramped over most of a bar so the change is a
    // movement rather than a jump.
    const barLen = this.stepTime * STEPS_PER_BAR;
    for (let i = 0; i < this.droneOscs.length; i++) {
      const semis = chord[i % chord.length] + (i >= chord.length ? 12 : 0);
      this.droneOscs[i].frequency.setTargetAtTime(noteHz(this.root + semis), at, barLen * 0.35);
    }

    // Intensity is committed here and only here.
    const i = this.intensityTarget;
    this.intensity += (i - this.intensity) * 0.55;
    const v = this.intensity;

    // Layer thresholds, with generous overlap so nothing pops in cold.
    const levels: Record<StemKey, number> = {
      drone: 0.5 + v * 0.28,
      pulse: clamp01((v - 0.14) / 0.42) * 0.55,
      perc: clamp01((v - 0.34) / 0.4) * 0.62,
      lead: clamp01((v - 0.62) / 0.38) * 0.4,
    };
    for (const k of Object.keys(levels) as StemKey[]) {
      const s = this.stems[k];
      if (!s) continue;
      s.target = levels[k];
      s.gain.gain.setTargetAtTime(s.target, at, barLen * 0.4);
    }

    // Filter opens with intensity: the pad gets brighter as things get worse.
    this.droneFilter?.frequency.setTargetAtTime(420 + v * 2200, at, barLen * 0.5);
    this.pulseFilter?.frequency.setTargetAtTime(300 + v * 1600, at, barLen * 0.5);

    // Vary the patterns every few bars so a long chase does not loop audibly.
    if (bar % 4 === 3) {
      this.hatPattern = this.rng.chance(0.5) ? 0b1010101010101010 : 0b1011101010111010;
      this.bassPattern = this.rng.pick([
        0b1001001010010010, 0b1000100010101000, 0b1010010010001010,
      ]);
    }
  }

  private scheduleStep(step: number, at: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = step % STEPS_PER_BAR;
    const bit = 1 << (STEPS_PER_BAR - 1 - s);
    const bar = Math.floor(step / STEPS_PER_BAR);
    const chord = PROGRESSION[bar % PROGRESSION.length];

    const perc = this.stems.perc;
    if (perc && perc.target > 0.01) {
      if (this.kickPattern & bit) this.hit("kick", at, 1);
      if (this.snarePattern & bit) this.hit("snare", at, 0.85);
      if (this.hatPattern & bit) {
        const open = s % 8 === 6;
        this.hit(open ? "hatOpen" : "hat", at, open ? 0.32 : 0.22 + (s % 4 === 0 ? 0.12 : 0));
      }
      if (s === 0 && bar % 4 === 0) this.hit("tom", at, 0.6);
    }

    const pulse = this.stems.pulse;
    if (pulse && pulse.target > 0.01 && this.bassPattern & bit) {
      // Bass note from the chord, occasionally an octave up for movement.
      const semis = chord[s % 2 === 0 ? 0 : 2] - 12 + (this.rng.chance(0.12) ? 12 : 0);
      this.bassNote(noteHz(this.root + semis), at, this.stepTime * (s % 4 === 0 ? 2.4 : 1.1));
    }

    const lead = this.stems.lead;
    if (lead && lead.target > 0.01 && s % 4 === 0 && this.rng.chance(0.45)) {
      const degree = SCALE[this.rng.int(0, SCALE.length - 1)];
      const octave = this.rng.chance(0.35) ? 24 : 12;
      this.leadNote(noteHz(this.root + degree + octave), at, this.stepTime * this.rng.int(2, 6));
    }
  }

  /* ---------------- voices ---------------- */

  private percBuffer(kind: string): AudioBuffer | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    switch (kind) {
      case "kick":
        return bakeSync(ctx, "mus:kick", 0.4, 1, (ch, sr) => renderKick(ch[0], sr));
      case "snare":
        return bakeSync(ctx, "mus:snare", 0.3, 1, (ch, sr, rng) => renderSnare(ch[0], sr, rng));
      case "hat":
        return bakeSync(ctx, "mus:hat", 0.12, 1, (ch, sr, rng) => renderHat(ch[0], sr, false, rng));
      case "hatOpen":
        return bakeSync(ctx, "mus:hatopen", 0.5, 1, (ch, sr, rng) => renderHat(ch[0], sr, true, rng));
      case "tom":
        return bakeSync(ctx, "mus:tom", 0.7, 1, (ch, sr, rng) =>
          renderTom(ch[0], sr, noteHz(this.root), rng),
        );
      default:
        return null;
    }
  }

  private hit(kind: string, at: number, gain: number): void {
    const ctx = this.ctx;
    const stem = this.stems.perc;
    if (!ctx || !stem) return;
    const buf = this.percBuffer(kind);
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Humanise: a couple of percent of level and pitch variation. Machine-exact
    // repetition of the same sample is the sound of a drum machine, which is
    // fine for techno and wrong for a score.
    src.playbackRate.value = this.rng.range(0.985, 1.015);
    const g = ctx.createGain();
    g.gain.value = gain * this.rng.range(0.88, 1.06);
    src.connect(g);
    g.connect(stem.gain);
    src.start(at);
    src.onended = () => {
      try {
        g.disconnect();
      } catch {
        /* torn down */
      }
    };
  }

  private bassNote(hz: number, at: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.pulseDrive) return;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = hz;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = hz * 0.5;
    const g = ctx.createGain();
    percEnv(g.gain, at, 0.5, dur * 0.9, 0.004, 1.4);
    const sg = ctx.createGain();
    sg.gain.value = 0.6;
    osc.connect(g);
    sub.connect(sg);
    sg.connect(g);
    g.connect(this.pulseDrive);
    osc.start(at);
    sub.start(at);
    osc.stop(at + dur + 0.05);
    sub.stop(at + dur + 0.05);
    osc.onended = () => {
      try {
        g.disconnect();
        sg.disconnect();
      } catch {
        /* torn down */
      }
    };
  }

  private leadNote(hz: number, at: number, dur: number): void {
    const ctx = this.ctx;
    const stem = this.stems.lead;
    if (!ctx || !stem) return;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = hz;
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = hz * 2.005;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = hz * 2;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    // Soft attack: the lead should arrive, not stab.
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.32, at + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.3;
    osc.connect(bp);
    osc2.connect(g2);
    g2.connect(bp);
    bp.connect(g);
    g.connect(stem.gain);
    osc.start(at);
    osc2.start(at);
    osc.stop(at + dur + 0.08);
    osc2.stop(at + dur + 0.08);
    osc.onended = () => {
      try {
        bp.disconnect();
        g.disconnect();
        g2.disconnect();
      } catch {
        /* torn down */
      }
    };
  }

  /* ---------------- stingers ---------------- */

  /**
   * A one-off musical event, quantised to the next beat.
   *
   * Waiting for the beat is the whole trick: an unquantised stinger sounds
   * like a sound effect, a quantised one sounds like the score reacting.
   */
  stinger(kind: StingerKind): void {
    const ctx = this.ctx;
    if (!ctx || !this.started) return;
    const beatLen = this.stepTime * STEPS_PER_BEAT;
    const now = ctx.currentTime;
    const at = this.nextStepAt + (beatLen - ((this.nextStepAt - now) % beatLen));

    switch (kind) {
      case "heat": {
        // A rising minor third under a filtered noise swell.
        this.leadNote(noteHz(this.root + 24), at, beatLen * 1.5);
        this.leadNote(noteHz(this.root + 27), at + beatLen * 0.5, beatLen * 2);
        this.hit("tom", at, 0.9);
        break;
      }
      case "objective": {
        // Open fifth, up an octave. Bright, brief, resolved.
        this.leadNote(noteHz(this.root + 19), at, beatLen * 1.2);
        this.leadNote(noteHz(this.root + 26), at + beatLen * 0.25, beatLen * 1.6);
        break;
      }
      case "death": {
        // Everything drops except a low, detuned pair.
        for (const s of Object.values(this.stems)) {
          s?.gain.gain.setTargetAtTime(0.02, now, 0.35);
        }
        const d = this.stems.drone;
        if (d) d.gain.gain.setTargetAtTime(0.4, now + 0.4, 0.8);
        for (const o of this.droneOscs) {
          o.frequency.setTargetAtTime(o.frequency.value * 0.5, now, 1.2);
        }
        break;
      }
      case "clear": {
        this.intensityTarget = 0;
        this.hit("hatOpen", at, 0.3);
        break;
      }
    }
  }
}

export const music = new MusicDirector();

/** Pre-bake the kit so the first bar of percussion is not a hitch. */
export function primeMusic(): void {
  const ctx = audioEngine.ctx;
  if (!ctx) return;
  bakeSync(ctx, "mus:kick", 0.4, 1, (ch, sr) => renderKick(ch[0], sr));
  bakeSync(ctx, "mus:snare", 0.3, 1, (ch, sr, rng) => renderSnare(ch[0], sr, rng));
  bakeSync(ctx, "mus:hat", 0.12, 1, (ch, sr, rng) => renderHat(ch[0], sr, false, rng));
  bakeSync(ctx, "mus:hatopen", 0.5, 1, (ch, sr, rng) => renderHat(ch[0], sr, true, rng));
  bakeSync(ctx, "mus:tom", 0.7, 1, (ch, sr, rng) => renderTom(ch[0], sr, noteHz(38), rng));
}
