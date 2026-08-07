/**
 * Every sound in this world is built out of oscillators at run time.
 *
 * Not for cleverness — the actual effects belong to somebody, and a world that
 * shipped them is a world that gets taken down. What is not anybody's property
 * is the physics of the sounds: an LCARS chirp is two short square blips a
 * fourth apart; the warp core is a low saw with a slow beat between two
 * detuned copies of itself; the transporter is a cluster of sines glissing in
 * opposite directions through filtered noise. Build those and the ear files the
 * result under "that show" without a waveform ever having been copied.
 *
 * The most valuable thing in here is the least dramatic: `chirp`, fired at
 * random from an unattended console every few seconds. Take the idle chirps
 * away and the bridge sounds like a screensaver.
 */

type Node = AudioNode & { start?: (t?: number) => void; stop?: (t?: number) => void };

export interface Audio {
  resume(): void;
  /** LCARS console blip. `n` picks one of the panel's notes. */
  chirp(n?: number): void;
  /** The affirmative two-tone — a command was accepted. */
  accept(): void;
  /** The refusal buzz. */
  deny(): void;
  /** Sensor sweep: a rising filtered noise band. */
  scan(): void;
  /** Hail opening: a clean carrier settling onto pitch. */
  hail(): void;
  /** Transporter, both directions. `up` reverses the glissando. */
  transporter(up: boolean): void;
  /** Warp: the wind-up, the snap, and the sustained core note. */
  warpIn(): void;
  warpOut(): void;
  /** Red alert klaxon, one sweep. */
  alert(): void;
  /** Ambient bed. `space` is the bridge hum; `surface` is wind. */
  bed(kind: "space" | "surface" | "none", tint?: number): void;
  setMuted(m: boolean): void;
  muted(): boolean;
  update(dt: number): void;
  dispose(): void;
}

export function createAudio(): Audio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let bedGain: GainNode | null = null;
  let bedNodes: Node[] = [];
  let bedKind: "space" | "surface" | "none" = "none";
  let isMuted = false;
  let chirpTimer = 2;

  function ac(): AudioContext | null {
    if (isMuted) return null;
    if (!ctx) {
      try {
        const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new C();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
        bedGain = ctx.createGain();
        bedGain.gain.value = 0;
        bedGain.connect(master);
      } catch {
        return null;
      }
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  }

  /** One shaped oscillator. Everything below is a few of these. */
  function tone(
    freq: number,
    dur: number,
    opts: {
      type?: OscillatorType;
      gain?: number;
      delay?: number;
      to?: number;
      attack?: number;
      dest?: AudioNode;
    } = {},
  ): void {
    const c = ac();
    if (!c || !master) return;
    const t0 = c.currentTime + (opts.delay ?? 0);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = opts.type ?? "sine";
    o.frequency.setValueAtTime(freq, t0);
    if (opts.to !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + dur);
    const peak = opts.gain ?? 0.12;
    const atk = opts.attack ?? 0.008;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(opts.dest ?? master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /** A burst of band-passed white noise. Sweeps, transporters, wind. */
  function noise(
    dur: number,
    opts: { from?: number; to?: number; q?: number; gain?: number; delay?: number } = {},
  ): void {
    const c = ac();
    if (!c || !master) return;
    const t0 = c.currentTime + (opts.delay ?? 0);
    const frames = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = opts.q ?? 4;
    f.frequency.setValueAtTime(opts.from ?? 600, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, opts.to ?? 2200), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.1, t0 + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  function stopBed(): void {
    for (const n of bedNodes) {
      try {
        n.stop?.();
      } catch {
        /* already stopped */
      }
      try {
        n.disconnect();
      } catch {
        /* already detached */
      }
    }
    bedNodes = [];
  }

  const api: Audio = {
    resume() {
      ac();
    },
    chirp(n = Math.floor(Math.random() * 5)) {
      // The panel's five notes, a pentatonic run so that any two in a row are
      // consonant and the room never sounds like it is arguing with itself.
      const notes = [523.25, 587.33, 698.46, 783.99, 880.0];
      const f = notes[n % notes.length];
      tone(f, 0.07, { type: "square", gain: 0.045 });
      tone(f * 1.5, 0.05, { type: "square", gain: 0.02, delay: 0.045 });
    },
    accept() {
      tone(660, 0.07, { type: "square", gain: 0.07 });
      tone(990, 0.1, { type: "square", gain: 0.06, delay: 0.06 });
    },
    deny() {
      tone(180, 0.18, { type: "sawtooth", gain: 0.07, to: 120 });
    },
    scan() {
      noise(1.1, { from: 400, to: 4200, q: 8, gain: 0.05 });
      tone(1200, 1.1, { type: "sine", gain: 0.02, to: 2400 });
    },
    hail() {
      tone(392, 0.5, { type: "sine", gain: 0.05, to: 523.25 });
      tone(784, 0.35, { type: "sine", gain: 0.025, delay: 0.1 });
    },
    transporter(up) {
      // Two sines crossing, plus a noise wash. The crossing is the sound —
      // one goes up while the other goes down and the beat between them is
      // what the ear hears as "dematerialising".
      const a = up ? 220 : 1400;
      const b = up ? 1400 : 220;
      tone(a, 2.2, { type: "sine", gain: 0.06, to: b, attack: 0.3 });
      tone(a * 1.5, 2.2, { type: "sine", gain: 0.04, to: b * 0.66, attack: 0.4 });
      noise(2.2, { from: up ? 300 : 3000, to: up ? 3000 : 300, q: 2, gain: 0.05 });
    },
    warpIn() {
      // Wind-up, then the snap. The snap is a fifth above the wind-up's
      // landing note, which is what makes it read as a release rather than
      // another step in the ramp.
      tone(80, 1.6, { type: "sawtooth", gain: 0.08, to: 320, attack: 0.6 });
      tone(120, 1.6, { type: "sawtooth", gain: 0.05, to: 480, attack: 0.8 });
      noise(1.7, { from: 200, to: 5000, q: 1.5, gain: 0.06 });
      tone(720, 0.5, { type: "sine", gain: 0.09, delay: 1.55, to: 180 });
    },
    warpOut() {
      tone(400, 0.9, { type: "sawtooth", gain: 0.07, to: 60 });
      noise(0.9, { from: 3000, to: 200, q: 2, gain: 0.05 });
    },
    alert() {
      for (let i = 0; i < 2; i++) {
        tone(180, 0.42, { type: "sawtooth", gain: 0.08, to: 620, delay: i * 0.52 });
      }
    },
    bed(kind, tint = 1) {
      const c = ac();
      if (!c || !bedGain) return;
      if (kind === bedKind) return;
      bedKind = kind;
      stopBed();
      if (kind === "none") {
        bedGain.gain.setTargetAtTime(0, c.currentTime, 0.4);
        return;
      }
      if (kind === "space") {
        // Two detuned saws a fifth apart through a low-pass. The detune is
        // 0.6 Hz, which puts a slow beat under the room — the thing that makes
        // a hum sound like a running machine rather than a test tone.
        const f = c.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.value = 220;
        f.Q.value = 0.7;
        f.connect(bedGain);
        for (const [freq, gain] of [
          [55, 0.5],
          [55.6, 0.5],
          [82.5, 0.3],
        ] as [number, number][]) {
          const o = c.createOscillator();
          o.type = "sawtooth";
          o.frequency.value = freq * tint;
          const g = c.createGain();
          g.gain.value = gain;
          o.connect(g);
          g.connect(f);
          o.start();
          bedNodes.push(o, g as unknown as Node);
        }
        bedNodes.push(f as unknown as Node);
        bedGain.gain.setTargetAtTime(0.16, c.currentTime, 0.8);
      } else {
        // Wind: looping noise through a slowly wandering band-pass.
        const frames = Math.floor(c.sampleRate * 3);
        const buf = c.createBuffer(1, frames, c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < frames; i++) d[i] = Math.random() * 2 - 1;
        const src = c.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const f = c.createBiquadFilter();
        f.type = "bandpass";
        f.frequency.value = 320 * tint;
        f.Q.value = 0.8;
        const lfo = c.createOscillator();
        lfo.frequency.value = 0.08;
        const lfoG = c.createGain();
        lfoG.gain.value = 140;
        lfo.connect(lfoG);
        lfoG.connect(f.frequency);
        src.connect(f);
        f.connect(bedGain);
        src.start();
        lfo.start();
        bedNodes.push(src, lfo, f as unknown as Node, lfoG as unknown as Node);
        bedGain.gain.setTargetAtTime(0.13, c.currentTime, 0.8);
      }
    },
    setMuted(m) {
      isMuted = m;
      if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.5, ctx.currentTime, 0.05);
    },
    muted() {
      return isMuted;
    },
    update(dt) {
      if (bedKind !== "space" || isMuted) return;
      chirpTimer -= dt;
      if (chirpTimer <= 0) {
        chirpTimer = 1.6 + Math.random() * 3.2;
        api.chirp();
      }
    },
    dispose() {
      stopBed();
      try {
        void ctx?.close();
      } catch {
        /* already closed */
      }
      ctx = null;
      master = null;
      bedGain = null;
    },
  };

  return api;
}
