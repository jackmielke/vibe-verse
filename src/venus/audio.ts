/**
 * The sound of fifty-four kilometres.
 *
 * Everything is synthesised: a wind bed that is mostly low rumble (you ride
 * with the wind, so the air on deck is calm, and what you hear is the planet
 * underneath), a slow pad, and small sounds for the things you do. If the
 * city has a Jazz Club, somebody is noodling on a vibraphone.
 */
export class VenusAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private wind!: GainNode;
  private windFilter!: BiquadFilterNode;
  private pad!: GainNode;
  private padFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private muted = false;
  private jazzAt = 0;
  jazz = false;
  night = 0;

  start() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);

    // Brown noise, two seconds, looped.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 380;
    this.windFilter.Q.value = 0.6;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0.35;
    src.connect(this.windFilter).connect(this.wind).connect(this.master);
    src.start();

    // A pad: F, A, C, E, G — Fmaj9, detuned, very slow.
    this.pad = ctx.createGain();
    this.pad.gain.value = 0.0;
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = "lowpass";
    this.padFilter.frequency.value = 900;
    this.pad.connect(this.padFilter).connect(this.master);
    for (const f of [87.31, 174.61, 220.0, 261.63, 329.63, 392.0]) {
      for (const det of [-6, 5]) {
        const o = ctx.createOscillator();
        o.type = f < 100 ? "sine" : "triangle";
        o.frequency.value = f;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = f < 100 ? 0.12 : 0.035;
        o.connect(g).connect(this.pad);
        o.start();
      }
    }
    this.pad.gain.setTargetAtTime(0.5, ctx.currentTime, 4);
  }

  resume() { this.ctx?.resume().catch(() => {}); }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.1);
  }

  /** Called every frame with how hot and how dark it is. */
  update(dt: number, heat: number, night: number, time: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.night = night;
    const gust = 0.5 + 0.5 * Math.sin(time * 0.13) * Math.sin(time * 0.041 + 1);
    this.wind.gain.setTargetAtTime(0.22 + gust * 0.2 + heat * 0.5, ctx.currentTime, 0.5);
    this.windFilter.frequency.setTargetAtTime(260 + gust * 260 + heat * 900, ctx.currentTime, 0.5);
    this.padFilter.frequency.setTargetAtTime(500 + (1 - night) * 900 - heat * 300, ctx.currentTime, 1);
    if (this.jazz) {
      this.jazzAt -= dt;
      if (this.jazzAt <= 0) {
        // Swung eighths, mostly.
        this.jazzAt = (Math.random() < 0.66 ? 0.34 : 0.17) * (Math.random() < 0.15 ? 3 : 1);
        const scale = [349.23, 392, 440, 523.25, 587.33, 659.25, 698.46, 783.99];
        this.vibe(scale[Math.floor(Math.random() * scale.length)] * (Math.random() < 0.2 ? 0.5 : 1), 0.05 + night * 0.04);
      }
    }
  }

  private env(g: GainNode, peak: number, a: number, d: number) {
    const t = this.ctx!.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private tone(freq: number, type: OscillatorType, peak: number, a: number, d: number, glideTo?: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, ctx.currentTime + a + d);
    const g = ctx.createGain();
    o.connect(g).connect(this.master);
    this.env(g, peak, a, d);
    o.start();
    o.stop(ctx.currentTime + a + d + 0.05);
  }

  private vibe(freq: number, peak: number) {
    this.tone(freq, "sine", peak, 0.005, 1.4);
    this.tone(freq * 4, "sine", peak * 0.15, 0.002, 0.25);
  }

  private hiss(peak: number, a: number, d: number, from: number, to: number, type: BiquadFilterType = "bandpass") {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = from;
    f.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + a + d);
    f.Q.value = 0.8;
    const g = ctx.createGain();
    s.connect(f).connect(g).connect(this.master);
    this.env(g, peak, a, d);
    s.start();
    s.stop(ctx.currentTime + a + d + 0.1);
  }

  click() { this.tone(880, "sine", 0.08, 0.003, 0.08); }
  build() {
    this.tone(392, "triangle", 0.12, 0.01, 0.6);
    setTimeout(() => this.tone(587.33, "triangle", 0.1, 0.01, 0.8), 90);
    setTimeout(() => this.tone(783.99, "sine", 0.08, 0.01, 1.2), 180);
    this.hiss(0.1, 0.05, 0.8, 800, 3000);
  }
  fall() {
    this.tone(300, "sine", 0.18, 0.02, 3.5, 40);
    this.hiss(0.25, 0.3, 3.5, 2000, 200);
  }
  ballast() { this.hiss(0.3, 0.1, 2.2, 1400, 300); }
  chime() {
    this.tone(659.25, "sine", 0.1, 0.01, 1.4);
    setTimeout(() => this.tone(987.77, "sine", 0.07, 0.01, 1.8), 140);
  }
  milestone() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => setTimeout(() => this.tone(f, "triangle", 0.09, 0.01, 1.6), i * 120));
  }
  thunder() { this.hiss(0.35, 0.05, 2.8, 180, 50, "lowpass"); }
  warn() { this.tone(220, "square", 0.05, 0.01, 0.3); }
  massDriver() {
    this.tone(60, "sawtooth", 0.12, 0.2, 4, 900);
    this.hiss(0.3, 0.5, 4, 200, 4000);
  }
  whoosh() { this.hiss(0.3, 1.2, 2.5, 300, 5000); }

  dispose() {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
