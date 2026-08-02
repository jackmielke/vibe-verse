/**
 * I SPY — sound.
 *
 * Synthesised, not streamed: a level like this wants the visuals locked to the
 * beat, and owning the clock is the only way to guarantee that. `beatPhase()`
 * is read by the renderer every frame, so the strobe is the music.
 *
 * 145 BPM, four bars of kick-and-bass under a minor arpeggio that opens up
 * every eight bars. Nothing here is longer than the level.
 */

const BPM = 145;
const BEAT = 60 / BPM;
const STEP = BEAT / 4; // sixteenths
const LOOKAHEAD = 0.12;

/** A minor pentatonic ladder, in Hz, that the arp walks. */
const ARP = [
  164.81, 196.0, 246.94, 293.66, 329.63, 392.0, 493.88, 587.33,
];
const BASS = [82.41, 82.41, 61.74, 73.42];

export class ISpyAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private step = 0;
  private nextTime = 0;
  private startTime = 0;
  private running = false;
  private muted = false;

  async start() {
    if (this.running) return;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!this.ctx) {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
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

  /** Restart the loop from the top — a new attempt gets a new downbeat. */
  restart() {
    if (!this.ctx) return;
    this.step = 0;
    this.startTime = this.ctx.currentTime;
    this.nextTime = this.ctx.currentTime + 0.03;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx)
      this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  get isMuted() {
    return this.muted;
  }

  /** 0..1 through the current beat. Drives every strobe on screen. */
  beatPhase(): number {
    if (!this.ctx || !this.running) return (performance.now() / 1000 / BEAT) % 1;
    return (((this.ctx.currentTime - this.startTime) / BEAT) % 1 + 1) % 1;
  }

  dispose() {
    this.stop();
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
  }

  // ── one-shots ──────────────────────────────────────────────────────────

  death() {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    noise.buffer = buf;
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

  win() {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    [329.63, 415.3, 493.88, 659.25].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.24, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.6);
      o.connect(g).connect(master);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.65);
    });
  }

  // ── the loop ───────────────────────────────────────────────────────────

  private schedule() {
    const { ctx } = this;
    if (!ctx || !this.running) return;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.playStep(this.step, this.nextTime);
      this.step = (this.step + 1) % 128;
      this.nextTime += STEP;
    }
  }

  private playStep(step: number, t: number) {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const bar = Math.floor(step / 16);
    const open = bar >= 4; // the second half of the loop lifts

    if (step % 4 === 0) this.kick(t);
    if (step % 8 === 4) this.snare(t);
    if (step % 2 === 1) this.hat(t, open ? 0.09 : 0.05);

    if (step % 4 === 0) this.bass(t, BASS[bar % 4]);
    if (open || step % 4 !== 3) {
      const note = ARP[(step * 3 + bar * 2) % ARP.length] * (open ? 2 : 1);
      this.arp(t, note, open ? 0.075 : 0.045);
    }
  }

  private kick(t: number) {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.24);
  }

  private snare(t: number) {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const n = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    n.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 1500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(f).connect(g).connect(master);
    n.start(t);
    n.stop(t + 0.18);
  }

  private hat(t: number, level: number) {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const n = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.06, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    n.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(f).connect(g).connect(master);
    n.start(t);
    n.stop(t + 0.06);
  }

  private bass(t: number, freq: number) {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(1100, t);
    f.frequency.exponentialRampToValueAtTime(240, t + 0.34);
    f.Q.value = 7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    o.connect(f).connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.4);
  }

  private arp(t: number, freq: number, level: number) {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.15);
  }
}
