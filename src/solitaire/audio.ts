/**
 * Card noises, synthesised. No files to fetch, nothing to license.
 *
 * A card on felt is a short burst of filtered noise; a flip is two of them a
 * few milliseconds apart; a card landing on a foundation also rings a soft
 * bell whose pitch climbs with the rank, so building a suit up from the ace
 * plays a little scale. That rising pitch is most of what makes it feel good.
 */
export class CardAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
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
      const len = Math.floor(this.ctx.sampleRate * 0.25);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private tick(at: number, freq: number, gain: number, dur = 0.05) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  private bell(at: number, freq: number, gain: number, dur = 0.5) {
    const ctx = this.ctx!;
    for (const [mult, amp] of [[1, 1], [2.01, 0.35], [3.98, 0.12]] as const) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(gain * amp, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(ctx.destination);
      o.start(at);
      o.stop(at + dur + 0.05);
    }
  }

  place() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.tick(ctx.currentTime, 1800 + Math.random() * 400, 0.35, 0.045);
  }

  flip() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tick(t, 2600, 0.18, 0.03);
    this.tick(t + 0.045, 1500, 0.28, 0.05);
  }

  pick() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.tick(ctx.currentTime, 3200, 0.12, 0.025);
  }

  /** A card reached a foundation. Rank 1..13 climbs a major pentatonic scale. */
  home(rank: number) {
    const ctx = this.ensure();
    if (!ctx) return;
    const steps = [0, 2, 4, 7, 9];
    const n = rank - 1;
    const semis = steps[n % 5] + 12 * Math.floor(n / 5);
    const t = ctx.currentTime;
    this.tick(t, 1900, 0.3, 0.04);
    this.bell(t + 0.01, 523.25 * 2 ** (semis / 12), 0.12, 0.6);
  }

  deny() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(110, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.16);
  }

  shuffle() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 18; i++) this.tick(t + i * 0.028, 1400 + Math.random() * 1600, 0.16, 0.035);
  }

  win() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const notes = [0, 4, 7, 12, 16, 19, 24];
    notes.forEach((s, i) => this.bell(t + i * 0.09, 392 * 2 ** (s / 12), 0.14, 0.9));
  }

  close() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
