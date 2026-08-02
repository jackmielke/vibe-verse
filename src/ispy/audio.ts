/**
 * I SPY — the score.
 *
 * Not the original level's track. That song belongs to the person who wrote
 * it, and shipping a copy of it in someone else's game is not ours to do — so
 * this is an original piece written for this level, in the idiom the original
 * lives in: F♯ minor, 120 BPM, i–VI–III–VII, sidechained four-on-the-floor.
 *
 * It is also **through-composed rather than looped**. The level is exactly 120
 * beats and its six movements are at known beats, so the arrangement is
 * written against those same boundaries: the drop lands when the strobe
 * section starts because both of them start at beat 62. A loop cannot do that,
 * and a level cut to its music deserves music cut to its level.
 *
 *   beat   0  THE QUIET PART   half-time kick, sub, filtered pad
 *   beat  21  I SPY            snare, offbeat hats, the arp arrives
 *   beat  42  MIRROR           sixteenth hats, the bass opens up
 *   beat  62  STROBE           the drop: lead, crash, everything
 *   beat  80  GREEN            breakdown, filter down, no lead
 *   beat  98  EVERYTHING       final drop, lead an octave up
 *
 * `beatPhase()` is read by the renderer every frame, so the strobe on screen
 * is this file's clock rather than an approximation of it.
 */

/** 120, so a beat is half a second — the length of a 1× jump. See build.ts. */
const BPM = 120;
const BEAT = 60 / BPM;
const STEP = BEAT / 4; // sixteenths
const LOOKAHEAD = 0.12;

/** The level's six movements, in beats. Mirrors CHAPTERS in level.ts. */
const MOVEMENT_BEATS = [0, 21, 42, 62, 80, 98];

/** i–VI–III–VII in F♯ minor, one chord per bar. */
const BASS_ROOTS = [92.5, 73.42, 110.0, 82.41]; // F♯2 D2 A2 E2
const PAD_CHORDS: number[][] = [
  [185.0, 220.0, 277.18], // F♯m
  [146.83, 185.0, 220.0], // D
  [220.0, 277.18, 329.63], // A
  [164.81, 207.65, 246.94], // E
];
const ARP_CHORDS: number[][] = [
  [369.99, 440.0, 554.37, 739.99],
  [293.66, 369.99, 440.0, 587.33],
  [440.0, 554.37, 659.25, 880.0],
  [329.63, 415.3, 493.88, 659.25],
];

/** F♯ natural minor, two octaves up from F♯4 — the lead's whole vocabulary. */
const SCALE = [369.99, 415.3, 440.0, 493.88, 554.37, 587.33, 659.25, 739.99];

/**
 * The hook: 32 sixteenths, two bars, −1 for a rest. It climbs to the fifth and
 * falls back to the root, which is the shape half of this genre is built on.
 */
const LEAD: number[] = [
  4, -1, 2, -1, 4, -1, 6, -1, 5, -1, 4, -1, 2, -1, 0, -1,
  3, -1, 2, -1, 3, -1, 5, -1, 6, -1, 5, -1, 4, -1, 2, -1,
];

export class ISpyAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Everything except the kick goes through here, so the kick can duck it. */
  private duck: GainNode | null = null;
  private delay: DelayNode | null = null;
  private timer: number | null = null;
  private step = 0;
  private nextTime = 0;
  private startTime = 0;
  private running = false;
  private muted = false;
  /** Which of the level's six movements is playing. Set by the engine. */
  private movement = 0;

  async start() {
    if (this.running) return;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!this.ctx) {
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.42;
      this.master.connect(ctx.destination);

      this.duck = ctx.createGain();
      this.duck.gain.value = 1;
      this.duck.connect(this.master);

      // A dotted-eighth delay — 0.375 s at 120 BPM, so echoes land on the
      // offbeat instead of smearing across it.
      this.delay = ctx.createDelay(1);
      this.delay.delayTime.value = BEAT * 0.75;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.33;
      const wet = ctx.createGain();
      wet.gain.value = 0.5;
      this.delay.connect(feedback).connect(this.delay);
      this.delay.connect(wet).connect(this.duck);
    }
    await this.ctx.resume().catch(() => undefined);
    this.running = true;
    this.step = 0;
    this.startTime = this.ctx.currentTime;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop() {
    this.running = false;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** Restart from the top — a new attempt gets a new downbeat, and the score
      is written against the level, so it has to start where the level does. */
  restart() {
    if (!this.ctx) return;
    this.step = 0;
    this.movement = 0;
    this.startTime = this.ctx.currentTime;
    this.nextTime = this.ctx.currentTime + 0.03;
  }

  /**
   * Jump the arrangement to a movement. Used when a run resumes from a
   * checkpoint two thirds of the way through the level: the score should be at
   * the final drop, not back at the filtered intro.
   */
  seekToMovement(i: number) {
    if (!this.ctx) return;
    const clamped = Math.max(0, Math.min(MOVEMENT_BEATS.length - 1, i));
    this.movement = clamped;
    this.step = MOVEMENT_BEATS[clamped] * 4;
    this.startTime = this.ctx.currentTime - MOVEMENT_BEATS[clamped] * BEAT;
    this.nextTime = this.ctx.currentTime + 0.03;
  }

  setMovement(i: number) {
    const clamped = Math.max(0, Math.min(MOVEMENT_BEATS.length - 1, i));
    if (clamped === this.movement) return;
    const rising = clamped > this.movement;
    this.movement = clamped;
    // A crash on the way up, a filtered swell on the way down.
    if (rising) this.crash();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx)
      this.master.gain.setTargetAtTime(m ? 0 : 0.42, this.ctx.currentTime, 0.05);
  }

  get isMuted() {
    return this.muted;
  }

  /** 0..1 through the current beat. Drives every strobe on screen. */
  beatPhase(): number {
    if (!this.ctx || !this.running) return (performance.now() / 1000 / BEAT) % 1;
    return ((((this.ctx.currentTime - this.startTime) / BEAT) % 1) + 1) % 1;
  }

  dispose() {
    this.stop();
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.duck = null;
    this.delay = null;
  }

  // ── one-shots ──────────────────────────────────────────────────────────

  death() {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(0.5, true);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(4200, t);
    f.frequency.exponentialRampToValueAtTime(180, t + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    noise.connect(f).connect(g).connect(master);
    noise.start(t);
    noise.stop(t + 0.5);
  }

  /** The spy pulse: a rising sweep, so you hear the truth arrive. */
  pulse() {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(2400, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.6);
  }

  /** Banking a checkpoint: a short rising two-note. */
  checkpoint() {
    this.chime([523.25, 783.99], 0.16, 0.3);
  }

  /** A coin: bright, four notes, unmistakably a reward. */
  coin() {
    this.chime([1046.5, 1318.5, 1568, 2093], 0.2, 0.42);
  }

  win() {
    this.chime([369.99, 554.37, 739.99, 1108.73], 0.24, 0.7);
  }

  private chime(freqs: number[], level: number, len: number) {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      const g = ctx.createGain();
      const at = t + i * 0.055;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(level, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(g).connect(master);
      o.start(at);
      o.stop(at + len + 0.02);
    });
  }

  // ── the arrangement ────────────────────────────────────────────────────

  private schedule() {
    const { ctx } = this;
    if (!ctx || !this.running) return;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.playStep(this.step, this.nextTime);
      // 480 sixteenths is the whole level. Past the end it wraps, which only
      // happens when someone is standing on the finish line admiring it.
      this.step = (this.step + 1) % 480;
      this.nextTime += STEP;
    }
  }

  private playStep(step: number, t: number) {
    if (!this.ctx || !this.duck) return;
    const bar = Math.floor(step / 16) % 4;
    const inBar = step % 16;
    const m = this.movement;

    // Movements 0 and 4 are the quiet ones; 3 and 5 are the drops.
    const drop = m === 3 || m === 5;
    const quiet = m === 0 || m === 4;

    // ── drums ────────────────────────────────────────────────────────────
    // The kick is the clock the level is cut to. Half-time while it is quiet,
    // four-on-the-floor once the level starts lying to you.
    const kickHere = m === 0 ? inBar % 8 === 0 : inBar % 4 === 0;
    if (kickHere) {
      this.kick(t, drop);
      this.sidechain(t, drop ? 0.28 : 0.45);
    }
    if (m >= 1 && inBar % 8 === 4) this.snare(t, m >= 3);
    if (m >= 1 && inBar % 4 === 2) this.hat(t, 0.05, false);
    if (m >= 2 && inBar % 2 === 1) this.hat(t, drop ? 0.055 : 0.035, false);
    if (drop && inBar === 14) this.hat(t, 0.07, true);
    // A fill on the last beat of every fourth bar.
    if (m >= 2 && bar === 3 && inBar >= 12) this.snare(t + 0, false, 0.5);

    // ── bass ─────────────────────────────────────────────────────────────
    const root = BASS_ROOTS[bar];
    if (inBar === 0) this.sub(t, root, quiet ? BEAT * 3.6 : BEAT * 1.8);
    if (!quiet && inBar % 4 === 0) this.reese(t, root * 2, drop ? 0.22 : 0.14);
    if (drop && (inBar === 6 || inBar === 10 || inBar === 14)) this.reese(t, root * 2, 0.16);

    // ── pad ──────────────────────────────────────────────────────────────
    if (inBar === 0) this.pad(t, PAD_CHORDS[bar], BEAT * 3.6, quiet ? 900 : 2600);

    // ── arp ──────────────────────────────────────────────────────────────
    if (m >= 1 && inBar % 2 === 0) {
      const notes = ARP_CHORDS[bar];
      const n = notes[(step / 2) % notes.length];
      this.arp(t, n * (drop ? 2 : 1), drop ? 0.06 : 0.042);
    }

    // ── lead ─────────────────────────────────────────────────────────────
    if (drop) {
      const idx = LEAD[step % LEAD.length];
      if (idx >= 0) this.lead(t, SCALE[idx] * (m === 5 ? 2 : 1), 0.075);
    }
  }

  /** Duck everything but the kick, then let it back in. The pump. */
  private sidechain(t: number, depth: number) {
    if (!this.duck) return;
    this.duck.gain.cancelScheduledValues(t);
    this.duck.gain.setValueAtTime(depth, t);
    this.duck.gain.linearRampToValueAtTime(1, t + BEAT * 0.62);
  }

  private noiseBuffer(seconds: number, decay = false): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * (decay ? 1 - i / d.length : 1);
    }
    return buf;
  }

  private kick(t: number, hard: boolean) {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(hard ? 190 : 150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + (hard ? 0.09 : 0.12));
    const g = ctx.createGain();
    g.gain.setValueAtTime(hard ? 1 : 0.8, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.26);
    // Click, so it cuts through the strobe.
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer(0.02, true);
    const ng = ctx.createGain();
    ng.gain.value = hard ? 0.22 : 0.12;
    n.connect(ng).connect(master);
    n.start(t);
  }

  private snare(t: number, hard: boolean, level = 1) {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer(0.2, true);
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = hard ? 1200 : 1600;
    const g = ctx.createGain();
    g.gain.setValueAtTime((hard ? 0.4 : 0.3) * level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(f).connect(g).connect(master);
    n.start(t);
    n.stop(t + 0.18);
  }

  private hat(t: number, level: number, open: boolean) {
    const { ctx, duck } = this;
    if (!ctx || !duck) return;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer(open ? 0.22 : 0.06, true);
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 7800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.2 : 0.05));
    n.connect(f).connect(g).connect(duck);
    n.start(t);
    n.stop(t + (open ? 0.22 : 0.06));
  }

  private crash() {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer(1.4, true);
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 3800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    n.connect(f).connect(g).connect(master);
    n.start(t);
    n.stop(t + 1.4);
  }

  /** Sine sub — the weight under everything. */
  private sub(t: number, freq: number, len: number) {
    const { ctx, duck } = this;
    if (!ctx || !duck) return;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34, t + 0.02);
    g.gain.setValueAtTime(0.34, t + len * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(duck);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  /** Two detuned saws through a resonant filter — the growl in the mids. */
  private reese(t: number, freq: number, level: number) {
    const { ctx, duck } = this;
    if (!ctx || !duck) return;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(2200, t);
    f.frequency.exponentialRampToValueAtTime(320, t + 0.3);
    f.Q.value = 8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    f.connect(g).connect(duck);
    for (const detune of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(f);
      o.start(t);
      o.stop(t + 0.36);
    }
  }

  private pad(t: number, chord: number[], len: number, cutoff: number) {
    const { ctx, duck } = this;
    if (!ctx || !duck) return;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.055, t + 0.12);
    g.gain.setValueAtTime(0.055, t + len * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    f.connect(g).connect(duck);
    for (const freq of chord) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq;
      o.detune.value = (Math.random() - 0.5) * 8;
      o.connect(f);
      o.start(t);
      o.stop(t + len + 0.05);
    }
  }

  private arp(t: number, freq: number, level: number) {
    const { ctx, duck, delay } = this;
    if (!ctx || !duck) return;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o.connect(g).connect(duck);
    if (delay) g.connect(delay);
    o.start(t);
    o.stop(t + 0.15);
  }

  /** The hook. Two detuned saws, into the delay, sitting above everything. */
  private lead(t: number, freq: number, level: number) {
    const { ctx, duck, delay } = this;
    if (!ctx || !duck) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    g.connect(duck);
    if (delay) g.connect(delay);
    for (const detune of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(g);
      o.start(t);
      o.stop(t + 0.24);
    }
  }
}
