/**
 * BLOB — the noise.
 *
 * Synthesised, not sampled: the whole soundtrack is a few oscillators and an
 * envelope each, which costs nothing to download and means the pitch of a bite
 * can be a function of what you just ate. Eating a pellet and eating a rival
 * are the same code with a different note, and that mapping — bigger meal,
 * lower and longer — is doing real work. You can hear how well you are doing
 * with your eyes on the other side of the screen.
 *
 * Every entry point is wrapped so that a browser with no Web Audio, a suspended
 * context, or a user who has never tapped the page cannot take the game down
 * with it. Sound is the one system here that is allowed to silently do nothing.
 */

/** Bites per second that actually make a sound. A giant sweeping a pellet field
 *  triggers dozens a frame, and all of them at once is white noise. */
const EAT_RATE = 14;

export class BlobAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private padGain: GainNode | null = null;
  private readonly padNodes: OscillatorNode[] = [];
  private lastEat = 0;
  private muted = false;

  constructor() {
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      this.startPad();
    } catch {
      this.ctx = null;
    }
  }

  /** Browsers hold the context suspended until a gesture. Call from the first
   *  click or tap — cheap, idempotent, and safe to call when there is no ctx. */
  resume(): void {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  dispose(): void {
    for (const o of this.padNodes) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    }
    this.padNodes.length = 0;
    // Browsers cap live audio contexts the same way they cap WebGL ones. A
    // world that leaks one breaks the *next* world the visitor opens.
    if (this.ctx) void this.ctx.close().catch(() => {});
    this.ctx = null;
    this.master = null;
  }

  // -------------------------------------------------------------------------

  /** A slow warm bed, so silence between bites is not actual silence. */
  private startPad(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.05;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.Q.value = 0.7;
    this.padGain.connect(filter).connect(this.master);

    // Two detuned triangles a fifth apart — the cheapest thing that sounds like
    // a room rather than a test tone.
    for (const [freq, detune] of [
      [55, -6],
      [82.4, 7],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(this.padGain);
      osc.start();
      this.padNodes.push(osc);
    }

    // A very slow wobble on the filter, so the bed drifts instead of sitting.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    this.padNodes.push(lfo);
  }

  private blip(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    slideTo?: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, from: number, to: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + dur);
    filter.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
  }

  // -------------------------------------------------------------------------
  // What the game asks for
  // -------------------------------------------------------------------------

  /** A bite. `mass` is what was eaten: a pellet chirps, a rival thuds. */
  eat(mass: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastEat < 1 / EAT_RATE) return;
    this.lastEat = now;
    // 3 mass → ~880 Hz, 300 mass → ~200 Hz. Log, because pitch is.
    const f = 980 / (1 + Math.log2(1 + mass) * 0.42);
    this.blip(f * (0.96 + Math.random() * 0.08), mass > 40 ? 0.2 : 0.07, "sine", 0.16, f * 0.7);
    if (mass > 40) this.blip(f * 0.5, 0.28, "triangle", 0.12, f * 0.34);
  }

  split(): void {
    this.noise(0.16, 0.14, 700, 2400);
    this.blip(300, 0.12, "square", 0.06, 620);
  }

  eject(): void {
    this.blip(520, 0.06, "square", 0.045, 260);
  }

  /** A virus pop: the loudest thing in the game, because it is the worst. */
  pop(): void {
    this.noise(0.34, 0.3, 2600, 220);
    this.blip(180, 0.32, "sawtooth", 0.16, 46);
  }

  /** You died. Long, low, and unmistakable. */
  death(): void {
    this.blip(220, 0.9, "sine", 0.24, 42);
    this.noise(0.6, 0.14, 900, 90);
  }

  /** You ate somebody. A little two-note fanfare, so a kill is a moment. */
  kill(): void {
    this.blip(520, 0.12, "triangle", 0.14);
    window.setTimeout(() => this.blip(784, 0.22, "triangle", 0.13), 90);
  }

  /** New personal best, or the end of a Blitz round. */
  fanfare(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((n, i) => window.setTimeout(() => this.blip(n, 0.3, "triangle", 0.13), i * 110));
  }
}
