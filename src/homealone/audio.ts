/**
 * Sound, synthesised. No files.
 *
 * A house at night is mostly *quiet*, and the job of this file is to make the
 * quiet expensive: a furnace two floors down, wind on the storm windows, and
 * one board that creaks under a foot that is not yours. When Marv is upstairs
 * you should know it from the ceiling before you know it from the screen.
 *
 * Two pieces of real music, both long out of copyright:
 *
 * - **Shchedryk / Carol of the Bells** (Leontovych, 1914). Four notes, endless,
 *   and it turns menace into slapstick the instant it starts. It plays over the
 *   battle, which is exactly what it is for.
 * - An original celeste line over the menu, because a title needs to be warm
 *   before the house gets cold.
 */

type Voice = { stop(): void };

export class HomeAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private muted = false;
  private noiseBuf: AudioBuffer | null = null;
  private voices = new Set<Voice>();
  private musicTimer: number | null = null;
  private lastStep = 0;

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new C();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.85;
      this.master.connect(ctx.destination);
      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = 0.0;
      this.musicGain.connect(this.master);
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      return ctx;
    } catch {
      return null;
    }
  }

  /** Browsers will not start an AudioContext without a gesture. */
  resume() {
    const ctx = this.ensure();
    if (ctx && ctx.state === "suspended") void ctx.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.85;
  }

  private now() {
    return this.ctx?.currentTime ?? 0;
  }

  private tone(
    freq: number,
    dur: number,
    opts: { type?: OscillatorType; gain?: number; attack?: number; sweep?: number; delay?: number; dest?: AudioNode } = {},
  ) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type ?? "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.sweep), t0 + dur);
    const peak = opts.gain ?? 0.2;
    const atk = opts.attack ?? 0.008;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(opts.dest ?? this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, opts: { gain?: number; freq?: number; q?: number; type?: BiquadFilterType; sweep?: number; delay?: number } = {}) {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noiseBuf) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? "bandpass";
    f.frequency.setValueAtTime(opts.freq ?? 900, t0);
    if (opts.sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, opts.sweep), t0 + dur);
    f.Q.value = opts.q ?? 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.2, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /* ---- the house ---------------------------------------------------- *
   * A wind bed and a furnace hum, running for as long as you are inside.
   * ------------------------------------------------------------------- */

  startAmbience() {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noiseBuf || this.windGain) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 340;
    const g = ctx.createGain();
    g.gain.value = 0.055;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    this.windGain = g;
    // Gusts. The wind should never sit still, or it stops being wind.
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = 0.07;
    lg.gain.value = 0.035;
    lfo.connect(lg).connect(g.gain);
    lfo.start();
    // Furnace: a low hum with a slow wobble, two floors down.
    const hum = ctx.createOscillator();
    const hg = ctx.createGain();
    hum.type = "sawtooth";
    hum.frequency.value = 47;
    const hf = ctx.createBiquadFilter();
    hf.type = "lowpass";
    hf.frequency.value = 130;
    hg.gain.value = 0.028;
    hum.connect(hf).connect(hg).connect(this.master);
    hum.start();
    this.voices.add({ stop: () => { src.stop(); lfo.stop(); hum.stop(); } });
  }

  /** Footstep. `hard` for wood and tile, soft for carpet, `snow` outside. */
  step(surface: "wood" | "carpet" | "tile" | "snow" | "stair", running: boolean) {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.currentTime - this.lastStep < 0.06) return;
    this.lastStep = ctx.currentTime;
    const v = running ? 1.5 : 1;
    if (surface === "snow") {
      this.noise(0.11, { gain: 0.10 * v, freq: 2600, q: 0.7, type: "highpass" });
      this.noise(0.06, { gain: 0.05 * v, freq: 420, q: 1.4 });
      return;
    }
    if (surface === "carpet") {
      this.noise(0.07, { gain: 0.045 * v, freq: 320, q: 1.0, type: "lowpass" });
      return;
    }
    const f = surface === "tile" ? 1500 : surface === "stair" ? 700 : 520;
    this.noise(0.045, { gain: 0.09 * v, freq: f, q: 2.4 });
    this.tone(surface === "tile" ? 210 : 118, 0.07, { type: "triangle", gain: 0.05 * v, sweep: 70 });
  }

  /** Something heavy landing on a floor, two rooms away or right beside you. */
  thud(dist = 1) {
    const g = Math.max(0.03, 0.34 / (1 + dist * 0.25));
    this.tone(72, 0.34, { type: "sine", gain: g, sweep: 34 });
    this.noise(0.16, { gain: g * 0.5, freq: 240, q: 0.8, type: "lowpass" });
  }

  /** A door on dry hinges. The single best free scare in any house. */
  creak(len = 0.9) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    osc.type = "sawtooth";
    f.type = "bandpass";
    f.Q.value = 9;
    osc.frequency.setValueAtTime(180, t0);
    osc.frequency.linearRampToValueAtTime(430, t0 + len);
    f.frequency.setValueAtTime(700, t0);
    f.frequency.linearRampToValueAtTime(1500, t0 + len);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.045, t0 + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    osc.connect(f).connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + len + 0.05);
  }

  /** A floorboard, somewhere above you. */
  boardCreak() {
    this.creak(0.35);
  }

  /* ---- traps -------------------------------------------------------- */

  clang() {
    // The iron. Struck metal: three inharmonic partials and a long tail.
    for (const [f, g, d] of [[520, 0.16, 1.5], [1180, 0.10, 1.1], [1970, 0.06, 0.8]] as const)
      this.tone(f, d, { type: "triangle", gain: g });
    this.noise(0.09, { gain: 0.10, freq: 3200, q: 0.8, type: "highpass" });
  }

  glass() {
    for (let i = 0; i < 9; i++)
      this.noise(0.09 + Math.random() * 0.1, {
        gain: 0.055, freq: 3600 + Math.random() * 4200, q: 5, delay: Math.random() * 0.16,
      });
  }

  fire() {
    this.noise(0.55, { gain: 0.13, freq: 900, q: 0.5, type: "lowpass", sweep: 240 });
    this.tone(120, 0.4, { type: "sawtooth", gain: 0.05, sweep: 60 });
  }

  slip() {
    this.noise(0.3, { gain: 0.08, freq: 1800, q: 1.2, sweep: 420 });
  }

  clatter() {
    for (let i = 0; i < 7; i++)
      this.tone(280 + Math.random() * 500, 0.1, { type: "square", gain: 0.045, delay: i * 0.045 + Math.random() * 0.03 });
  }

  /** Harry growls, Marv yelps. Two formants and a pitch envelope is plenty. */
  yell(who: "harry" | "marv") {
    const base = who === "harry" ? 116 : 208;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const f1 = ctx.createBiquadFilter();
    const f2 = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(base * 1.25, t0);
    osc.frequency.exponentialRampToValueAtTime(base * (who === "harry" ? 0.7 : 1.9), t0 + 0.14);
    osc.frequency.exponentialRampToValueAtTime(base * 0.6, t0 + 0.7);
    f1.type = "bandpass";
    f1.frequency.value = who === "harry" ? 620 : 880;
    f1.Q.value = 5;
    f2.type = "bandpass";
    f2.frequency.value = who === "harry" ? 1180 : 1620;
    f2.Q.value = 6;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.19, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.75);
    osc.connect(f1).connect(g);
    f1.connect(f2);
    f2.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + 0.8);
  }

  /** Kevin. Everybody knows this one, and it is a sine sweep with vibrato. */
  scream() {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const vib = ctx.createOscillator();
    const vg = ctx.createGain();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(560, t0);
    osc.frequency.exponentialRampToValueAtTime(940, t0 + 0.18);
    osc.frequency.exponentialRampToValueAtTime(700, t0 + 1.4);
    vib.frequency.value = 6.2;
    vg.gain.value = 34;
    vib.connect(vg).connect(osc.frequency);
    f.type = "bandpass";
    f.frequency.value = 1500;
    f.Q.value = 2.4;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.2, t0 + 0.06);
    g.gain.setValueAtTime(0.2, t0 + 1.0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
    osc.connect(f).connect(g).connect(this.master);
    osc.start(t0);
    vib.start(t0);
    osc.stop(t0 + 1.55);
    vib.stop(t0 + 1.55);
  }

  /**
   * The BB gun. A spring, a puff of air, and a tiny metallic ring — the point
   * is that it sounds like a *toy*, because it is one, and because a real
   * gunshot in this world would be a different and much worse game.
   */
  bb() {
    this.noise(0.05, { gain: 0.13, freq: 3200, q: 1.2, sweep: 900, type: "bandpass" });
    this.tone(1750, 0.09, { type: "square", gain: 0.06, sweep: 620 });
    this.tone(4200, 0.16, { type: "triangle", gain: 0.03 });
  }

  /** A light switch. Small, dry, and the sound of a decision. */
  tick() {
    this.noise(0.03, { gain: 0.09, freq: 2400, q: 3.5 });
    this.tone(880, 0.04, { type: "square", gain: 0.03 });
  }

  chime(up = true) {
    const notes = up ? [523.25, 659.25, 783.99, 1046.5] : [1046.5, 783.99, 622.25, 523.25];
    notes.forEach((n, i) => this.tone(n, 0.7, { type: "triangle", gain: 0.11, delay: i * 0.09 }));
  }

  doorbell() {
    this.tone(659.25, 1.1, { type: "sine", gain: 0.16 });
    this.tone(523.25, 1.4, { type: "sine", gain: 0.16, delay: 0.55 });
  }

  /* ---- music -------------------------------------------------------- */

  /**
   * Shchedryk, 1914. Four notes, a bar each, forever — which is exactly the
   * shape of a chase where the same two men keep coming back.
   */
  private static BELLS: Array<[number, number]> = (() => {
    const n = (semi: number) => 440 * Math.pow(2, semi / 12);
    // G#4 as tonic; the ostinato is A4 G#4 A4 F#4 in the original's shape.
    const A = n(0), Gs = n(-1), Fs = n(-3), E = n(-5), Cs = n(-8), B = n(-10), Ds = n(-7);
    const bar = (a: number, b: number, c: number, d: number): Array<[number, number]> => [
      [a, 0.22], [b, 0.22], [c, 0.22], [d, 0.22],
    ];
    return [
      ...bar(A, Gs, A, Fs), ...bar(A, Gs, A, Fs),
      ...bar(A, Gs, A, Fs), ...bar(A, Gs, A, Fs),
      ...bar(B, A, B, Gs), ...bar(B, A, B, Gs),
      ...bar(Cs, B, Cs, A), ...bar(E, Ds, E, Cs),
    ];
  })();

  /** A warm original for the menu — a slow celeste waltz, nothing borrowed. */
  private static HOME: Array<[number, number]> = (() => {
    const n = (semi: number) => 440 * Math.pow(2, semi / 12);
    const seq: Array<[number, number]> = [];
    const line = [0, 4, 7, 12, 7, 4, 2, 5, 9, 14, 9, 5, -1, 4, 7, 11, 7, 4, 0, 4, 7, 12, 7, 4];
    for (let i = 0; i < line.length; i++) seq.push([n(line[i] - 5), i % 6 === 0 ? 0.62 : 0.42]);
    return seq;
  })();

  playMusic(which: "bells" | "home" | null, volume = 0.5) {
    const ctx = this.ensure();
    if (!ctx || !this.musicGain) return;
    if (this.musicTimer !== null) {
      window.clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
    if (!which) {
      this.musicGain.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
      return;
    }
    this.musicGain.gain.setTargetAtTime(volume, ctx.currentTime, 0.6);
    const seq = which === "bells" ? HomeAudio.BELLS : HomeAudio.HOME;
    let i = 0;
    const step = () => {
      if (!this.ctx || !this.musicGain) return;
      const [freq, dur] = seq[i % seq.length];
      // Two voices an octave apart with a plucked envelope reads as a celeste.
      this.tone(freq, dur * 2.6, { type: "triangle", gain: 0.14, attack: 0.004, dest: this.musicGain });
      this.tone(freq * 2, dur * 1.6, { type: "sine", gain: 0.06, attack: 0.003, dest: this.musicGain });
      if (which === "bells" && i % 4 === 0)
        this.tone(freq / 2, dur * 3.4, { type: "sine", gain: 0.10, attack: 0.01, dest: this.musicGain });
      i++;
      this.musicTimer = window.setTimeout(step, dur * 1000);
    };
    step();
  }

  dispose() {
    if (this.musicTimer !== null) window.clearTimeout(this.musicTimer);
    this.musicTimer = null;
    for (const v of this.voices) {
      try {
        v.stop();
      } catch {
        /* already stopped */
      }
    }
    this.voices.clear();
    this.windGain = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
  }
}
