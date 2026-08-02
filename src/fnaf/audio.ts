/**
 * Every sound in the building, synthesised. No files.
 *
 * The reason isn't purity — it's that this game is mostly listening. You spend
 * the night deciding whether that was a footstep in the east hall or the fan,
 * and synthesis lets the footstep be *parameterised by distance* rather than
 * being one recorded clip played at two volumes.
 *
 * One AudioContext, one master gain, and `dispose()` closes it. A world that
 * leaks an audio context makes the next world in the hub sound wrong.
 */

type Ctx = AudioContext;

export class FnafAudio {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private loops = new Map<string, { stop: () => void }>();
  private disposed = false;

  /** Browsers won't start audio before a gesture; the title screen is ours. */
  async resume() {
    if (this.disposed) return;
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  setMuted(muted: boolean) {
    if (this.master) this.master.gain.value = muted ? 0 : 0.85;
  }

  private now() {
    return this.ctx?.currentTime ?? 0;
  }

  private noise(gain: number, filter: number, q = 1, type: BiquadFilterType = "lowpass") {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = filter;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.master!);
    return { src, f, g };
  }

  /* ------------------------------------------------------------- one-shots */

  private ping(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    sweepTo?: number,
  ) {
    if (!this.ctx) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private burst(dur: number, gain: number, cutoff: number, sweepTo?: number) {
    if (!this.ctx) return;
    const t = this.now();
    const { src, f, g } = this.noise(0, cutoff);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** The button click. Small, plastic, satisfying. */
  click() {
    this.burst(0.05, 0.28, 3800, 900);
  }

  /** Steel door coming down: motor, then the slam. */
  doorClose() {
    this.burst(0.34, 0.24, 1400, 300);
    this.ping(140, 0.4, "sawtooth", 0.16, 60);
    window.setTimeout(() => {
      this.burst(0.2, 0.5, 700, 90);
      this.ping(58, 0.55, "sine", 0.4, 34);
    }, 330);
  }

  doorOpen() {
    this.ping(90, 0.35, "sawtooth", 0.14, 190);
    this.burst(0.45, 0.16, 900, 2200);
  }

  /** Hall light: the fluorescent strike and then a hum you can hear thinking. */
  lightOn() {
    this.burst(0.07, 0.3, 6000, 2000);
    this.startLightHum();
  }

  lightOff() {
    this.stopLoop("lighthum");
    this.click();
  }

  /** Monitor up / down — the flip and the tape hiss. */
  camUp() {
    this.burst(0.16, 0.34, 5200, 1400);
    this.ping(420, 0.1, "square", 0.06, 180);
  }

  camDown() {
    this.burst(0.14, 0.3, 3000, 6000);
  }

  /** Changing channel. */
  camSwitch() {
    this.burst(0.1, 0.26, 5200, 1800);
  }

  /** The tablet falling over after thirty seconds: a fault, then dead air. */
  camFault() {
    this.burst(0.22, 0.42, 6000, 300);
    this.ping(180, 0.5, "square", 0.12, 60);
    window.setTimeout(() => {
      this.ping(120, 0.35, "sawtooth", 0.1, 40);
      this.burst(0.4, 0.2, 900, 120);
    }, 160);
  }

  /**
   * A footstep somewhere in the building. `dist` in metres does the work:
   * far away it's a muffled thud, close up it's servos and metal.
   */
  step(dist: number, heavy = false) {
    if (!this.ctx) return;
    const near = Math.max(0, 1 - dist / 26);
    const vol = 0.05 + near * near * 0.4;
    this.burst(0.09 + near * 0.05, vol * (heavy ? 1.4 : 1), 300 + near * 2600, 120);
    if (near > 0.35) this.ping(90 + Math.random() * 40, 0.12, "square", vol * 0.14, 50);
  }

  /** Metallic groan when one of them turns its head towards a camera. */
  servo(dist: number) {
    if (!this.ctx) return;
    const near = Math.max(0, 1 - dist / 26);
    this.ping(300 + Math.random() * 500, 0.22, "sawtooth", 0.02 + near * 0.05, 140);
  }

  /** Foxy leaving the cove: the sprint down the west hall. */
  foxyRun() {
    if (!this.ctx) return;
    for (let i = 0; i < 12; i++) {
      window.setTimeout(() => this.step(14 - i * 1.1, true), i * 105);
    }
    this.ping(880, 1.3, "sawtooth", 0.06, 220);
  }

  /** Foxy hitting a door that is, this time, shut. */
  doorBang() {
    for (let i = 0; i < 3; i++) {
      window.setTimeout(() => {
        this.burst(0.22, 0.55, 500, 80);
        this.ping(70, 0.3, "square", 0.3, 40);
      }, i * 190);
    }
  }

  /** The scream. Distorted, layered, and mercifully short. */
  scream() {
    if (!this.ctx) return;
    const t = this.now();
    for (const [f, to, g] of [
      [1400, 180, 0.4],
      [900, 120, 0.35],
      [2100, 320, 0.22],
    ]) {
      const o = this.ctx.createOscillator();
      const gn = this.ctx.createGain();
      const sh = this.ctx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const x = (i / 128) - 1;
        curve[i] = Math.tanh(x * 6);
      }
      sh.curve = curve;
      o.type = "sawtooth";
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(to, t + 0.9);
      gn.gain.setValueAtTime(g, t);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
      o.connect(sh).connect(gn).connect(this.master!);
      o.start(t);
      o.stop(t + 1.05);
    }
    this.burst(0.9, 0.5, 6000, 400);
  }

  /** Power gone: the room dies in one descending slide. */
  powerDown() {
    this.stopLoop("fan");
    this.stopLoop("lighthum");
    this.ping(240, 1.6, "sawtooth", 0.2, 40);
    this.burst(1.2, 0.2, 1800, 120);
  }

  /**
   * The music box. Bizet's Toreador March, which is public domain and was
   * always the joke: the most cheerful possible thing to hear in the dark.
   */
  toreador() {
    if (!this.ctx) return;
    const notes = [
      659.25, 659.25, 698.46, 783.99, 783.99, 698.46, 659.25, 587.33,
      523.25, 523.25, 587.33, 659.25, 659.25, 587.33, 587.33, 0,
      659.25, 659.25, 698.46, 783.99, 783.99, 698.46, 659.25, 587.33,
      523.25, 587.33, 659.25, 587.33, 523.25, 0, 0, 0,
    ];
    const beat = 0.26;
    let stopped = false;
    const play = (i: number) => {
      if (stopped || this.disposed || !this.ctx) return;
      const f = notes[i % notes.length];
      if (f > 0) {
        const t = this.now();
        // Two detuned sines with a fast decay = music box, near enough.
        for (const [mul, g] of [[1, 0.13], [2, 0.05], [3.01, 0.02]] as const) {
          const o = this.ctx.createOscillator();
          const gn = this.ctx.createGain();
          o.type = "sine";
          o.frequency.value = f * mul;
          gn.gain.setValueAtTime(0, t);
          gn.gain.linearRampToValueAtTime(g, t + 0.01);
          gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
          o.connect(gn).connect(this.master!);
          o.start(t);
          o.stop(t + 0.95);
        }
      }
      const id = window.setTimeout(() => play(i + 1), beat * 1000);
      this.loops.set("toreador", {
        stop: () => {
          stopped = true;
          window.clearTimeout(id);
        },
      });
    };
    play(0);
  }

  /** 6 AM. Bells, then the day shift's cheering, which is the reward. */
  sixAm() {
    this.stopLoop("toreador");
    this.stopLoop("fan");
    for (let i = 0; i < 6; i++) {
      window.setTimeout(() => {
        this.ping(1046.5, 1.4, "sine", 0.14);
        this.ping(1568, 1.2, "sine", 0.07);
      }, i * 340);
    }
    window.setTimeout(() => {
      if (!this.ctx) return;
      const { src, g } = this.noise(0.001, 1800);
      const t = this.now();
      g.gain.linearRampToValueAtTime(0.16, t + 0.4);
      g.gain.linearRampToValueAtTime(0.0001, t + 3.4);
      src.start(t);
      src.stop(t + 3.6);
    }, 1900);
  }

  /* ----------------------------------------------------------------- loops */

  private register(key: string, stop: () => void) {
    this.stopLoop(key);
    this.loops.set(key, { stop });
  }

  /** The office fan. On all night, and you stop hearing it in ninety seconds. */
  startFan() {
    if (!this.ctx || this.loops.has("fan")) return;
    const { src, g } = this.noise(0.055, 620);
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.frequency.value = 21; // blade-pass frequency
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain).connect(g.gain);
    src.start();
    lfo.start();
    this.register("fan", () => {
      try {
        src.stop();
        lfo.stop();
      } catch {
        /* already stopped */
      }
    });
  }

  /** Room tone: the building itself, breathing. */
  startAmbience() {
    if (!this.ctx || this.loops.has("amb")) return;
    const { src, g } = this.noise(0.03, 140);
    const o = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    o.type = "sine";
    o.frequency.value = 47;
    og.gain.value = 0.035;
    o.connect(og).connect(this.master!);
    src.start();
    o.start();
    this.register("amb", () => {
      try {
        src.stop();
        o.stop();
      } catch {
        /* already stopped */
      }
      g.disconnect();
    });
  }

  private startLightHum() {
    if (!this.ctx || this.loops.has("lighthum")) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "square";
    o.frequency.value = 120;
    g.gain.value = 0.012;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 900;
    o.connect(f).connect(g).connect(this.master!);
    o.start(t);
    this.register("lighthum", () => {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    });
  }

  /** Tape hiss while the monitor is up — louder than you expect, on purpose. */
  startCamStatic() {
    if (!this.ctx || this.loops.has("camstatic")) return;
    const { src, g } = this.noise(0.07, 5200, 0.7, "highpass");
    src.start();
    this.register("camstatic", () => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      g.disconnect();
    });
  }

  /** The kitchen camera is dead, so the kitchen is only ever a sound. */
  startKitchenAudio() {
    if (!this.ctx || this.loops.has("kitchen")) return;
    const { src, g } = this.noise(0.04, 700);
    src.start();
    // Pans, occasionally, and never at a comfortable interval.
    const bang = () => {
      if (this.disposed) return;
      this.ping(320 + Math.random() * 500, 0.5, "triangle", 0.05, 90);
      const id = window.setTimeout(bang, 1600 + Math.random() * 3400);
      this.loops.set("kitchenbang", { stop: () => window.clearTimeout(id) });
    };
    bang();
    this.register("kitchen", () => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      g.disconnect();
      this.stopLoop("kitchenbang");
    });
  }

  stopLoop(key: string) {
    const l = this.loops.get(key);
    if (l) {
      l.stop();
      this.loops.delete(key);
    }
  }

  stopAll() {
    [...this.loops.keys()].forEach((k) => this.stopLoop(k));
  }

  dispose() {
    this.disposed = true;
    this.stopAll();
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
  }
}
