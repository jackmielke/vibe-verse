/**
 * COIL — the noise.
 *
 * Synthesised, like BLOB's, for the same reasons: nothing to download, and the
 * pitch of a sound can be a function of what caused it. The palette is
 * different because the game is — there is no "I ate somebody" here, only "I
 * survived somebody", so the loudest thing in the mix is the crash.
 *
 * Every entry point is wrapped. A browser with no Web Audio, a context the user
 * has never unlocked with a gesture, a device that refuses to allocate one —
 * none of those may take the game down. Sound is the one system here allowed to
 * silently do nothing.
 */

/** Pickups per second that actually make a sound. Hoovering a corpse spill
 *  triggers dozens in a frame, and all of them at once is a hiss. */
const EAT_RATE = 16;

export class CoilAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private boostGain: GainNode | null = null;
  private readonly running: AudioNode[] = [];
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
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.startBeds();
    } catch {
      this.ctx = null;
    }
  }

  resume(): void {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  dispose(): void {
    for (const n of this.running) {
      try {
        (n as OscillatorNode).stop?.();
      } catch {
        /* already stopped */
      }
    }
    this.running.length = 0;
    // Browsers cap live audio contexts the way they cap WebGL ones. A world
    // that leaks one breaks the next world the visitor opens.
    if (this.ctx) void this.ctx.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.boostGain = null;
  }

  // -------------------------------------------------------------------------

  /** A low bed, plus the boost's rushing noise held at zero until wanted. */
  private startBeds(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;

    const pad = ctx.createGain();
    pad.gain.value = 0.05;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 380;
    pad.connect(filter).connect(this.master);
    for (const [freq, detune] of [
      [49, -7],
      [73.4, 6],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(pad);
      osc.start();
      this.running.push(osc);
    }

    /* The boost is a continuous sound rather than a repeated one — it is a
       state you hold, and retriggering a whoosh every frame would machine-gun.
       So: looping noise through a bandpass, with the gain as the switch. */
    const frames = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 0.9;
    this.boostGain = ctx.createGain();
    this.boostGain.gain.value = 0;
    src.connect(bp).connect(this.boostGain).connect(this.master);
    src.start();
    this.running.push(src);
  }

  /** Held down, not triggered. */
  setBoosting(on: boolean): void {
    if (!this.ctx || !this.boostGain) return;
    this.boostGain.gain.setTargetAtTime(on && !this.muted ? 0.09 : 0, this.ctx.currentTime, 0.06);
  }

  private blip(freq: number, dur: number, type: OscillatorType, gain: number, to?: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** An orb. Bigger ones — the spill off a corpse — land lower and longer. */
  eat(value: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastEat < 1 / EAT_RATE) return;
    this.lastEat = now;
    const f = 760 / (1 + Math.log2(1 + value) * 0.5);
    this.blip(f * (0.97 + Math.random() * 0.06), value > 3 ? 0.14 : 0.05, "sine", 0.11, f * 0.75);
  }

  /** You died. Long, low and unmistakable. */
  crash(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    this.blip(260, 0.85, "sawtooth", 0.2, 38);
    const t = ctx.currentTime;
    const frames = Math.floor(ctx.sampleRate * 0.6);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(2200, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  /** Somebody ran into you. The one unambiguously good sound in the game. */
  kill(): void {
    this.blip(523, 0.11, "triangle", 0.13);
    window.setTimeout(() => this.blip(784, 0.2, "triangle", 0.12), 85);
  }

  fanfare(): void {
    [523, 659, 784, 1047].forEach((n, i) =>
      window.setTimeout(() => this.blip(n, 0.28, "triangle", 0.12), i * 105),
    );
  }
}
