/**
 * VIBE CUP — sound, all synthesised: a thud for a kick, a ping off the post,
 * a referee's whistle, and a crowd made of filtered noise that swells for a
 * goal. No files, nothing to license. The context is made on the first tap
 * or key, the only time a browser allows it.
 */
import type { GameEvent } from "./game";

export class CupAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(ctx.destination);
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // The crowd: a constant murmur we can swell.
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 700;
      bp.Q.value = 0.6;
      this.crowd = ctx.createGain();
      this.crowd.gain.value = 0.05;
      src.connect(bp).connect(this.crowd).connect(this.master);
      src.start();
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.02);
  }

  close() {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.crowd = null;
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
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(at: number, dur: number, vol: number, freq: number, q = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private swell(to: number, hold: number) {
    if (!this.ctx || !this.crowd) return;
    const t = this.ctx.currentTime;
    this.crowd.gain.cancelScheduledValues(t);
    this.crowd.gain.setTargetAtTime(to, t, 0.08);
    this.crowd.gain.setTargetAtTime(0.05, t + hold, 0.8);
  }

  private whistle(long: boolean) {
    const n = long ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const at = i * 0.32;
      const dur = long && i === n - 1 ? 0.7 : 0.22;
      this.tone(2900, at, dur, "square", 0.06);
      this.tone(3060, at, dur, "sine", 0.05);
    }
  }

  play(e: GameEvent) {
    if (!this.ctx) return;
    switch (e.type) {
      case "kick":
      case "pass":
        this.tone(140, 0, 0.09, "sine", 0.35, 60);
        this.burst(0, 0.04, 0.12, 2000, 2);
        break;
      case "shot":
        this.tone(110, 0, 0.14, "sine", 0.55, 45);
        this.burst(0, 0.07, 0.25, 1400, 1.5);
        if (e.fire) this.burst(0.02, 0.5, 0.18, 400, 0.5);
        this.swell(0.12, 0.4);
        break;
      case "bounce":
        if (e.power > 4) this.tone(90, 0, 0.06, "sine", Math.min(0.25, e.power * 0.02), 50);
        break;
      case "post":
        this.tone(880, 0, 0.5, "triangle", 0.25);
        this.tone(1320, 0, 0.35, "sine", 0.12);
        this.swell(0.2, 0.6);
        break;
      case "save":
        this.burst(0, 0.12, 0.25, 900, 1);
        this.swell(0.16, 0.8);
        break;
      case "tackle":
        this.burst(0, 0.15, 0.2, 500, 0.8);
        break;
      case "bump":
        this.burst(0, 0.18, 0.22, 380, 0.7);
        this.tone(120, 0, 0.12, "sine", 0.3, 55);
        this.swell(e.own ? 0.2 : 0.12, 0.6);
        break;
      case "goal":
        this.burst(0, 0.35, 0.3, 3000, 0.7); // the net
        this.swell(0.42, 2.6);
        this.tone(523, 0.15, 0.18, "square", 0.08);
        this.tone(659, 0.3, 0.18, "square", 0.08);
        this.tone(784, 0.45, 0.4, "square", 0.08);
        break;
      case "whistle":
        this.whistle(e.long);
        break;
      case "golden":
        this.swell(0.25, 1.5);
        break;
      case "fulltime":
        this.swell(0.35, 3);
        break;
    }
  }
}
