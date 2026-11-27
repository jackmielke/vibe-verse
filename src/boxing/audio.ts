/**
 * Every sound in the ring, synthesised: thuds, the bell, the wind-up whoosh,
 * a crowd that roars when you land a counter. No files, so nothing to load
 * before the first punch.
 */
export class RingAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  muted = false;

  /** Must be called from a tap, or the browser keeps it silent. */
  unlock(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(this.ctx.destination);
    // the crowd: filtered noise, always there, swelling on big moments
    const buf = this.noise(2);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 700;
    bp.Q.value = 0.6;
    this.crowd = this.ctx.createGain();
    this.crowd.gain.value = 0.04;
    src.connect(bp).connect(this.crowd).connect(this.master);
    src.start();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  private noise(sec: number): AudioBuffer {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  private burst(dur: number, freq: number, gain: number, type: BiquadFilterType = "lowpass"): void {
    const ctx = this.ctx, m = this.master;
    if (!ctx || !m) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(dur + 0.05);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(m);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = "sine", slide = 0): void {
    const ctx = this.ctx, m = this.master;
    if (!ctx || !m) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(m);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  hit(power: number, counter: boolean): void {
    this.tone(110 + power * 40, 0.16, 0.7, "sine", 0.4);
    this.burst(0.09, 2400, 0.35 + power * 0.3);
    if (counter) { this.tone(880, 0.25, 0.12, "triangle", 1.5); this.roar(0.6); }
  }
  blocked(): void { this.burst(0.06, 900, 0.3); this.tone(220, 0.08, 0.15, "square", 0.7); }
  whoosh(): void { this.burst(0.35, 1400, 0.12, "bandpass"); }
  hurt(): void { this.tone(70, 0.3, 0.9, "sine", 0.5); this.burst(0.15, 600, 0.5); }
  covered(): void { this.burst(0.08, 500, 0.45); this.tone(140, 0.12, 0.3, "sine", 0.6); }
  dodged(): void { this.burst(0.22, 3000, 0.1, "highpass"); this.roar(0.3); }
  bell(): void { for (const [f, d] of [[1250, 1.4], [1873, 1.0], [2550, 0.7]] as const) this.tone(f, d, 0.18, "sine"); }
  roar(amount: number): void {
    const ctx = this.ctx, g = this.crowd;
    if (!ctx || !g) return;
    const t = ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(0.04 + amount * 0.25, t, 0.05);
    g.gain.setTargetAtTime(0.04, t + 0.4, 0.6);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
