/**
 * audio.ts — the whole soundtrack, synthesised, with no files in it.
 *
 * Every sound in Vibe Francisco is made out of oscillators and filtered noise
 * at runtime. That is not a purity exercise: it is the same argument as
 * `look.ts` making the city out of flat colour instead of textures. A world
 * whose geometry, colour and layout are all generated and whose audio is four
 * megabytes of MP3 is a world that loads in two seconds and then waits ten for
 * a whoosh. This adds nothing to the download and can be tuned by changing a
 * number rather than by re-recording something.
 *
 * Three rules the Web Audio API imposes and one this world imposes:
 *
 * **Nothing exists until a gesture.** Browsers refuse to start an
 * `AudioContext` before the user has touched the page, and a context created
 * early sits in `suspended` forever while everything downstream silently does
 * nothing. So the graph is built inside `start()`, which the page calls from
 * the first pointer or key event, and `update()` is a no-op until then.
 *
 * **It has to be given back.** Chrome caps live audio contexts per page at a
 * small number, and a world that leaks one breaks the *next* world the visitor
 * opens — the same failure mode as leaking a WebGL context, and harder to
 * diagnose because the symptom is silence rather than a black screen.
 *
 * **Nothing is ever hard-stopped.** Every gain change ramps. A gain set
 * directly on a running oscillator is a step discontinuity, which is a click,
 * and a click is the single most noticeable artefact in synthesised audio.
 *
 * And: **the mix is mostly quiet.** The loudest thing here is the jetpack, at
 * a third of full scale. A toy city should sound like one from across a room,
 * not like a flight simulator.
 */

/* ------------------------------------------------------------------ *
 * The curves — pure, testable, and where the feel actually lives
 * ------------------------------------------------------------------ */

/**
 * How loud the wind is, given speed in m/s and height above the ground.
 *
 * Speed does most of it, but not all: hanging still at three hundred metres
 * should not be silent, or the top of the Transamerica feels like a menu
 * screen rather than a place with weather.
 */
export function windGain(speed: number, altitude: number): number {
  const bySpeed = Math.min(1, speed / 34) ** 1.4;
  const byHeight = Math.min(1, Math.max(0, altitude - 25) / 260) * 0.5;
  return Math.min(0.34, bySpeed * 0.3 + byHeight);
}

/**
 * How loud the city is, given height above the ground.
 *
 * Traffic and voices are a ground-level phenomenon and they fall away fast:
 * by a hundred metres you are above it, which is a real and slightly eerie
 * property of tall buildings that costs one line to reproduce.
 */
export function cityGain(altitude: number): number {
  return 0.16 * Math.max(0, 1 - Math.max(0, altitude - 4) / 130) ** 1.6;
}

/** Jetpack loudness from the throttle, with a floor so ignition is audible. */
export function jetGain(burning: boolean, fuel: number): number {
  if (!burning || fuel <= 0) return 0;
  // Sputters as the tank empties, which is the warning the fuel bar cannot
  // give you while you are looking at the ground.
  return 0.3 * (0.55 + 0.45 * Math.min(1, fuel * 4));
}

/** Seconds between footfalls at a given ground speed. */
export function strideSeconds(speed: number): number {
  if (speed < 0.6) return Infinity;
  return Math.max(0.26, 0.86 - speed * 0.045);
}

/** Coin pitch, in semitones above the root, for a run of `n` collected. */
export function coinSemitone(n: number): number {
  // A rising major pentatonic that resets after eight, so a line of coins
  // plays a phrase rather than a siren.
  const STEPS = [0, 2, 4, 7, 9, 12, 14, 16];
  return STEPS[Math.min(STEPS.length - 1, n % STEPS.length)];
}

const A4 = 440;
const semitoneToHz = (s: number) => A4 * Math.pow(2, s / 12);

/* ------------------------------------------------------------------ *
 * The graph
 * ------------------------------------------------------------------ */

export interface AudioFrame {
  speed: number;
  altitude: number;
  grounded: boolean;
  burning: boolean;
  fuel: number;
  inWater: boolean;
}

export type Cue = "coin" | "landmark" | "ring" | "finish" | "jump" | "land";

const STORE_KEY = "frisco.muted";

export class CityAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private wind: GainNode | null = null;
  private city: GainNode | null = null;
  private jet: GainNode | null = null;
  private jetFilter: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private strideAcc = 0;
  private coinRun = 0;
  private lastCoinAt = -10;
  private elapsed = 0;
  private muted: boolean;
  private started = false;

  constructor() {
    let m = false;
    try {
      m = localStorage.getItem(STORE_KEY) === "1";
    } catch {
      /* Storage can be unavailable in an embed; default to audible. */
    }
    this.muted = m;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get isRunning(): boolean {
    return this.started && this.ctx !== null && this.ctx.state === "running";
  }

  /**
   * Build the graph. Safe to call repeatedly — the page wires it to every
   * plausible first gesture and only the first one does anything.
   */
  start(): void {
    if (this.started) {
      void this.ctx?.resume();
      return;
    }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.started = true;

    const ctx = new Ctor();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 1;
    master.connect(ctx.destination);
    this.master = master;

    // Two seconds of white noise, looped. One buffer feeds the wind, the city
    // and the jetpack through different filters, which is most of why this
    // whole file is a few hundred lines rather than a few thousand.
    const N = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, N, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Deterministic noise: an audible seed makes A/B comparisons possible.
    let seed = 0x2f6e2b1;
    for (let i = 0; i < N; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0x7fffffff - 1) * 0.6;
    }
    this.noise = buf;

    /* ---- wind: noise through a wide band-pass ---- */
    this.wind = this.noiseVoice(buf, master, "bandpass", 620, 0.7, 0);

    /* ---- the city: a low rumble, plus a hint of the noise above it ---- */
    this.city = ctx.createGain();
    this.city.gain.value = 0;
    this.city.connect(master);
    const hum = ctx.createOscillator();
    hum.type = "sawtooth";
    hum.frequency.value = 54;
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = "lowpass";
    humFilter.frequency.value = 180;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.5;
    hum.connect(humFilter).connect(humGain).connect(this.city);
    hum.start();
    this.sources.push(hum);
    const traffic = ctx.createBufferSource();
    traffic.buffer = buf;
    traffic.loop = true;
    const trafficFilter = ctx.createBiquadFilter();
    trafficFilter.type = "lowpass";
    trafficFilter.frequency.value = 380;
    const trafficGain = ctx.createGain();
    trafficGain.gain.value = 0.6;
    traffic.connect(trafficFilter).connect(trafficGain).connect(this.city);
    traffic.start();
    this.sources.push(traffic);

    /* ---- jetpack: noise through a sweeping low-pass, plus a body tone ---- */
    this.jet = ctx.createGain();
    this.jet.gain.value = 0;
    this.jet.connect(master);
    const jetSrc = ctx.createBufferSource();
    jetSrc.buffer = buf;
    jetSrc.loop = true;
    const jetFilter = ctx.createBiquadFilter();
    jetFilter.type = "lowpass";
    jetFilter.frequency.value = 900;
    jetFilter.Q.value = 3;
    jetSrc.connect(jetFilter).connect(this.jet);
    jetSrc.start();
    this.sources.push(jetSrc);
    this.jetFilter = jetFilter;
    const body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.value = 96;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.22;
    body.connect(bodyGain).connect(this.jet);
    body.start();
    this.sources.push(body);
  }

  private noiseVoice(
    buf: AudioBuffer,
    dest: AudioNode,
    type: BiquadFilterType,
    freq: number,
    q: number,
    gain: number,
  ): GainNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(dest);
    src.start();
    this.sources.push(src);
    return g;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    try {
      localStorage.setItem(STORE_KEY, m ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (this.master && this.ctx) {
      // Ramped, not set: a master gain snapping to zero clicks like a switch.
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(m ? 0 : 1, t, 0.03);
    }
  }

  update(dt: number, f: AudioFrame): void {
    this.elapsed += dt;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;

    // `setTargetAtTime` rather than `setValueAtTime`: an exponential approach
    // with a time constant is a one-pole smoother, which is exactly what these
    // want and costs nothing per frame.
    this.wind?.gain.setTargetAtTime(windGain(f.speed, f.altitude), t, 0.14);
    this.city?.gain.setTargetAtTime(f.inWater ? 0 : cityGain(f.altitude), t, 0.3);

    const jg = jetGain(f.burning, f.fuel);
    this.jet?.gain.setTargetAtTime(jg, t, jg > 0 ? 0.05 : 0.16);
    if (this.jetFilter && jg > 0) {
      // The filter opens as the tank drains, so a nearly-empty jetpack is
      // thinner and harsher. It is a fuel gauge you can hear.
      this.jetFilter.frequency.setTargetAtTime(700 + (1 - f.fuel) * 900, t, 0.2);
    }

    // Footsteps.
    if (f.grounded && !f.inWater) {
      const stride = strideSeconds(f.speed);
      if (Number.isFinite(stride)) {
        this.strideAcc += dt;
        if (this.strideAcc >= stride) {
          this.strideAcc = 0;
          this.step();
        }
      } else {
        this.strideAcc = stride === Infinity ? 0 : this.strideAcc;
      }
    }
  }

  /** A short filtered noise burst — a foot on concrete. */
  private step(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.master) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 340 + Math.random() * 180;
    filter.Q.value = 1.4;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.055, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.12);
  }

  /**
   * A one-shot.
   *
   * Every voice here is created, scheduled and stopped — `stop()` releases it
   * for collection, and a graph that only ever grows is a leak that presents
   * as the audio getting gradually crunchier and then cutting out.
   */
  cue(kind: Cue): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== "running") return;
    const t = ctx.currentTime;

    switch (kind) {
      case "coin": {
        // A run of coins climbs a pentatonic scale and resets if you stop.
        if (this.elapsed - this.lastCoinAt > 2.2) this.coinRun = 0;
        this.lastCoinAt = this.elapsed;
        const hz = semitoneToHz(12 + coinSemitone(this.coinRun));
        this.coinRun++;
        this.bell(hz, 0.09, 0.24, "triangle");
        this.bell(hz * 2, 0.045, 0.16, "sine");
        break;
      }
      case "landmark": {
        // A warm arpeggio: something has been added to the logbook.
        const root = semitoneToHz(-5);
        [0, 4, 7, 12].forEach((s, i) => {
          this.bell(root * Math.pow(2, s / 12), 0.07, 0.5, "triangle", i * 0.085);
        });
        break;
      }
      case "ring":
        this.bell(semitoneToHz(7), 0.07, 0.16, "square");
        break;
      case "finish": {
        const root = semitoneToHz(0);
        [0, 7, 12, 16, 19].forEach((s, i) => {
          this.bell(root * Math.pow(2, s / 12), 0.075, 0.7, "triangle", i * 0.1);
        });
        break;
      }
      case "jump":
        this.sweep(220, 420, 0.05, 0.12);
        break;
      case "land":
        this.sweep(180, 90, 0.07, 0.14);
        break;
    }
  }

  /** A struck tone with an exponential tail. */
  private bell(hz: number, peak: number, seconds: number, type: OscillatorType, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz;
    const g = ctx.createGain();
    // Exponential ramps cannot touch zero, hence the tiny floor at each end.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
  }

  /** A pitch slide — jumping up, landing down. */
  private sweep(from: number, to: number, peak: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* Already stopped, or never started. */
      }
    }
    this.sources.length = 0;
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.wind = this.city = this.jet = null;
    this.jetFilter = null;
    this.noise = null;
    this.started = false;
    // `close()` is what actually returns the context to the browser's pool.
    // Dropping the reference does not: it stays open until it is collected,
    // which may be never, and the cap is on open contexts.
    void ctx?.close().catch(() => undefined);
  }
}
