/**
 * Pool noises, synthesised: nothing to fetch, nothing to license.
 *
 * The click of two phenolic balls is the whole sound of the game, so it gets
 * the most care: a very short, bright resonant ping plus a tick of noise, both
 * scaled by how hard the balls met. A break is thirty of those inside a tenth
 * of a second, so they are rate limited to keep the mix from clipping.
 */
export class PoolAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private lastClick = 0;
  private clicksThisFrame = 0;
  muted = false;

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC();
      } catch {
        return null;
      }
      const len = Math.floor(this.ctx.sampleRate * 0.4);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  unlock() {
    this.ensure();
  }

  setMuted(m: boolean) {
    this.muted = m;
  }

  private burst(at: number, type: BiquadFilterType, freq: number, q: number, gain: number, dur: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(at, Math.random() * 0.2);
    src.stop(at + dur + 0.02);
  }

  private tone(at: number, freq: number, gain: number, dur: number, type: OscillatorType = "sine", glideTo?: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(this.master!);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  /** Call once per animation frame, before the frame's events. */
  frame() {
    this.clicksThisFrame = 0;
  }

  cue(speed: number) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const k = Math.min(1, speed / 6.5);
    this.tone(t, 640 + 200 * k, 0.12 + 0.3 * k, 0.05, "triangle", 300);
    this.burst(t, "bandpass", 2200, 1.2, 0.15 + 0.35 * k, 0.03);
  }

  click(speed: number) {
    const ctx = this.ensure();
    if (!ctx) return;
    if (speed < 0.03) return;
    const t = ctx.currentTime;
    if (this.clicksThisFrame >= 4 || t - this.lastClick < 0.004) return;
    this.clicksThisFrame++;
    this.lastClick = t;
    const k = Math.min(1, speed / 4);
    const g = 0.06 + 0.6 * k * k + 0.12 * k;
    this.tone(t, 3300 + Math.random() * 500, g, 0.035 + 0.02 * k);
    this.tone(t, 5200 + Math.random() * 600, g * 0.4, 0.02);
    this.burst(t, "highpass", 4000, 0.7, g * 0.6, 0.012);
  }

  rail(speed: number) {
    const ctx = this.ensure();
    if (!ctx) return;
    if (speed < 0.08) return;
    const t = ctx.currentTime;
    const k = Math.min(1, speed / 4);
    this.tone(t, 150 + 60 * k, 0.1 + 0.3 * k, 0.09, "sine", 90);
    this.burst(t, "lowpass", 700, 0.8, 0.08 + 0.25 * k, 0.06);
  }

  pot(speed: number) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const k = Math.min(1, 0.4 + speed / 3);
    // Into the leather, then rattling down the return.
    this.burst(t, "lowpass", 500, 1, 0.35 * k, 0.12);
    this.tone(t, 110, 0.22 * k, 0.16, "sine", 70);
    for (let i = 0; i < 4; i++) {
      const at = t + 0.16 + i * (0.07 + Math.random() * 0.05);
      this.tone(at, 900 + Math.random() * 500, 0.05 * (1 - i * 0.2), 0.03, "triangle");
      this.burst(at, "bandpass", 1500, 2, 0.05, 0.03);
    }
  }

  foul() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(t, 220, 0.12, 0.18, "triangle", 150);
    this.tone(t + 0.16, 170, 0.12, 0.25, "triangle", 110);
  }

  good() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(t, 880, 0.06, 0.25);
    this.tone(t + 0.07, 1320, 0.05, 0.3);
  }

  win() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => {
      this.tone(t + i * 0.085, 392 * 2 ** (s / 12), 0.12, 0.7);
      this.tone(t + i * 0.085, 784 * 2 ** (s / 12), 0.04, 0.5);
    });
  }

  lose() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    [7, 4, 0, -5].forEach((s, i) => this.tone(t + i * 0.16, 330 * 2 ** (s / 12), 0.1, 0.4, "triangle"));
  }

  close() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
