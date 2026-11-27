/**
 * VIBE HOOPS — the sound of the Dome, all synthesised: the dribble, the
 * swish, the clang off the iron, the horn, the arena organ, and a crowd of
 * filtered noise that roars when somebody throws one down. Nothing to
 * license, nothing to download. The context starts on the first tap or key.
 */
import type { GameEvent } from "./game";

export class HoopsAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private base = 0.06;
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
      // The crowd: twenty thousand people as a murmur we can swell.
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 650;
      bp.Q.value = 0.5;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 2200;
      this.crowd = ctx.createGain();
      this.crowd.gain.value = this.base;
      src.connect(bp).connect(lp).connect(this.crowd).connect(this.master);
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

  private burst(at: number, dur: number, vol: number, freq: number, q = 1, type: BiquadFilterType = "bandpass") {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
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

  /** The crowd: up to `to`, held, then back to the murmur. */
  swell(to: number, hold: number) {
    if (!this.ctx || !this.crowd) return;
    const t = this.ctx.currentTime;
    this.crowd.gain.cancelScheduledValues(t);
    this.crowd.gain.setTargetAtTime(to, t, 0.06);
    this.crowd.gain.setTargetAtTime(this.base, t + hold, 0.9);
  }

  /** The bounce of a dribble. */
  dribble(power = 1) {
    this.tone(95, 0, 0.07, "sine", 0.22 * power, 55);
    this.burst(0, 0.03, 0.05 * power, 900, 2);
  }

  squeak() {
    this.tone(2400 + Math.random() * 600, 0, 0.07, "sine", 0.035, 3100);
  }

  /** The arena organ: the old "charge" climb, in our own notes. */
  organ() {
    const notes = [392, 523, 659, 784, 659, 784];
    const at = [0, 0.16, 0.32, 0.48, 0.8, 0.96];
    notes.forEach((f, k) => {
      this.tone(f, at[k], k === 3 || k === 5 ? 0.34 : 0.14, "square", 0.05);
      this.tone(f * 2, at[k], k === 3 || k === 5 ? 0.34 : 0.14, "sine", 0.03);
    });
  }

  horn() {
    for (const f of [233, 294, 349]) this.tone(f, 0, 0.9, "sawtooth", 0.05);
  }

  buzzer() {
    this.tone(196, 0, 1.3, "sawtooth", 0.09);
    this.tone(208, 0, 1.3, "square", 0.05);
  }

  whistle() {
    this.tone(2900, 0, 0.28, "square", 0.05);
    this.tone(3060, 0, 0.28, "sine", 0.05);
  }

  /** "De-fense!": two claps and a roar, on a loop the page drives. */
  chant() {
    this.burst(0, 0.12, 0.12, 1200, 0.8);
    this.burst(0.3, 0.12, 0.12, 1200, 0.8);
  }

  play(e: GameEvent) {
    if (!this.ctx) return;
    switch (e.type) {
      case "pass":
        this.burst(0, 0.05, 0.12, 1800, 2);
        break;
      case "catch":
        this.tone(160, 0, 0.05, "sine", 0.18, 90);
        break;
      case "shot":
        this.swell(0.13, 0.6);
        break;
      case "dunk":
        this.swell(0.22, 0.5);
        break;
      case "rim":
        if (e.power > 0.6) {
          this.tone(720, 0, 0.32, "triangle", Math.min(0.25, 0.06 + e.power * 0.03));
          this.tone(1840, 0, 0.18, "sine", 0.06);
          this.burst(0, 0.05, 0.1, 3000, 3);
        }
        break;
      case "board":
        this.tone(130, 0, 0.12, "sine", 0.3, 70);
        this.burst(0, 0.08, 0.16, 600, 1);
        break;
      case "bounce":
        this.dribble(Math.min(1, e.power / 5));
        break;
      case "score":
        if (e.kind === "dunk") {
          this.tone(70, 0, 0.3, "sine", 0.5, 40);
          this.burst(0, 0.25, 0.35, 400, 0.6);
          this.horn();
          this.swell(0.55, 3.2);
        } else {
          this.burst(0, e.swish ? 0.3 : 0.2, e.swish ? 0.3 : 0.2, 4200, 0.8); // the net
          this.swell(e.big ? 0.5 : 0.3, e.big ? 2.8 : 1.6);
        }
        if (e.big) this.organ();
        if (e.buzzer) this.horn();
        break;
      case "block":
        this.tone(110, 0, 0.18, "sine", 0.45, 50);
        this.burst(0, 0.12, 0.28, 700, 0.8);
        this.swell(0.42, 1.6);
        break;
      case "steal":
        this.burst(0, 0.08, 0.18, 1500, 1.5);
        this.swell(0.28, 1.2);
        break;
      case "turnover":
      case "whistle":
        this.whistle();
        break;
      case "tip":
        this.swell(0.3, 1.2);
        break;
      case "buzzer":
        this.buzzer();
        break;
      case "sudden":
        this.swell(0.4, 2);
        this.organ();
        break;
      case "final":
        this.swell(0.6, 5);
        this.horn();
        break;
    }
  }
}
