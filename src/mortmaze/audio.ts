/**
 * MORT'S MAZE — sound. Every noise is synthesised on the spot with WebAudio,
 * so there are no files to fetch and nothing to license. The context is made
 * on the first tap or key, which is the only time a browser allows it.
 */
import type { GameEvent } from "./game";

export class MazeAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private coinFlip = false;
  private lastCoin = 0;
  muted = false;

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  close() {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
  }

  private tone(freq: number, at: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private splash(at: number, dur: number, vol: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + at;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(400, t + dur);
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  play(e: GameEvent) {
    if (!this.ctx || this.muted) return;
    switch (e.type) {
      case "coin": {
        // A tiny two-note tink, alternating, and never faster than it can be heard.
        const now = this.ctx.currentTime;
        if (now - this.lastCoin < 0.06) return;
        this.lastCoin = now;
        this.coinFlip = !this.coinFlip;
        this.tone(this.coinFlip ? 1318 : 1568, 0, 0.07, "triangle", 0.12);
        return;
      }
      case "balloon":
        this.splash(0, 0.45, 0.5);
        this.tone(220, 0, 0.35, "sine", 0.25, 880);
        return;
      case "bonk":
        this.splash(0, 0.25, 0.4);
        this.tone(660, 0.02, 0.12, "square", 0.12, 1320);
        this.tone(990, 0.12, 0.18, "square", 0.1, 1980);
        return;
      case "bonus":
        [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, i * 0.06, 0.12, "triangle", 0.16));
        return;
      case "die":
        this.tone(600, 0, 1.1, "sawtooth", 0.14, 70);
        this.tone(606, 0, 1.1, "sawtooth", 0.08, 72);
        return;
      case "clear":
        [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, i * 0.11, 0.16, "square", 0.08));
        return;
      case "life":
        [1047, 1319, 1568, 2093].forEach((f, i) => this.tone(f, i * 0.08, 0.14, "triangle", 0.14));
        return;
      case "ready":
        // A little island riff: up, around, and home.
        [392, 523, 659, 587, 523, 659, 784].forEach((f, i) =>
          this.tone(f, i * 0.14, 0.13, "square", 0.07));
        [196, 262, 196, 262].forEach((f, i) => this.tone(f, i * 0.28, 0.24, "triangle", 0.12));
        return;
      case "over":
        [392, 330, 262, 196].forEach((f, i) => this.tone(f, i * 0.2, 0.25, "triangle", 0.14));
        return;
    }
  }
}
