/**
 * The valley's own sounds, all synthesised. No files, so nothing to load,
 * and everything responds to the state the moment it changes.
 *
 * What makes wind sound like wind rather than like a hiss is that it never
 * holds still: it comes in gusts, the gusts are random rather than a sine,
 * a strong gust rises in pitch as well as in level, and most of what you
 * actually hear is not the air but what it moves, the leaves. So the wind
 * here is three layers driven by one random gust process:
 *
 *   body     brown noise, low-passed, the cutoff opening with each gust
 *   howl     two narrow band-passes that only sing when it really blows
 *   leaves   high noise with a fast flutter, loud near trees
 *
 * Around that: a river that babbles (several bubbling voices, not one
 * filtered noise) by distance, birds by day (including the bush warbler's
 * "hoo, hokekyo", which is what spring in Japan sounds like), bell crickets
 * and frogs at night, glass wind chimes that ring when the wind reaches
 * them, footsteps by surface, a hearth that crackles indoors, and a very
 * quiet koto that plays a few notes now and then. Everything that is a
 * point in the world is panned and attenuated from the listener, and the
 * whole outdoors is muffled when you step inside.
 *
 * Vibey's *voice* is not here; that is a WebRTC audio track the voice
 * session owns. This is the room the voice speaks in.
 */

export type Surface = "grass" | "wood" | "stone" | "water" | "tatami";

export interface AmbienceLevels {
  rain: number;
  wind: number;
  night: number;
  storm: number;
  /** 0 to 1: how close the river is. */
  water: number;
  /** 0 to 1: how many trees are near, for the rustle. */
  leaves?: number;
  /** Songbirds allowed (day, not raining). */
  birds?: number;
  /** Frogs: water nearby, evening, rain. */
  frogs?: number;
  /** Cicadas: summer days. */
  cicadas?: number;
  /** 0 outside, 1 inside a house. */
  indoors?: number;
  /** 0 to 1: a hearth nearby. */
  fire?: number;
}

export type SoundName = "bell" | "gong" | "thunder" | "chime" | "whoosh" | "hit" | "fizz" | "roar" | "pop" | "splash" | "sparkle" | "plop" | "furin" | "purr" | "mew";

export interface Ambience {
  /** Must be called from a user gesture at least once. */
  resume(): void;
  set(levels: AmbienceLevels): void;
  /** Where the listener stands and faces (yaw 0 looks down -z). */
  listener(x: number, z: number, yaw: number): void;
  /** Wind chimes that ring when the wind reaches them. */
  setChimes(points: Array<{ x: number; z: number }>): void;
  play(name: SoundName, at?: { x: number; z: number }): void;
  /** A tone at a point in the world, for things like the magic screen. */
  beep(freq: number, dur: number, type?: OscillatorType, gain?: number, at?: { x: number; z: number }): void;
  step(surface: Surface): void;
  setMuted(m: boolean): void;
  setMusic(on: boolean): void;
  /** The mix as a stream, for the recorder. */
  stream(): MediaStream | null;
  /** An analyser on the final mix, for checking the sound without speakers. */
  analyser(): AnalyserNode | null;
  dispose(): void;
}

/** Yo scale (D E G A B), the pentatonic of Japanese folk song, over three octaves. */
const YO = [146.83, 164.81, 196.0, 220.0, 246.94, 293.66, 329.63, 392.0, 440.0, 493.88, 587.33, 659.25];

export function createAmbience(): Ambience {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  /** Everything outdoors goes through here, so indoors can muffle it. */
  let outdoor: BiquadFilterNode | null = null;
  let outdoorGain: GainNode | null = null;
  let reverbIn: GainNode | null = null;
  let tap: MediaStreamAudioDestinationNode | null = null;
  let probe: AnalyserNode | null = null;
  let muted = false;
  let music = true;
  const g: Record<string, GainNode> = {};
  const f: Record<string, BiquadFilterNode> = {};
  const timers = new Set<number>();
  let levels: Required<AmbienceLevels> = { rain: 0, wind: 0.25, night: 0, storm: 0, water: 0, leaves: 0, birds: 0, frogs: 0, cicadas: 0, indoors: 0, fire: 0 };
  const me = { x: 0, z: 0, yaw: 0 };
  let chimes: Array<{ x: number; z: number }> = [];
  // The gust process: an Ornstein-Uhlenbeck walk, which is what makes it
  // sound like weather rather than a machine.
  let gust = 0.5, gustFast = 0.5, gustL = 0.5, gustR = 0.5;
  let windTimer: number | null = null;

  function later(fn: () => void, ms: number) {
    const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  }

  function whiteBuffer(c: AudioContext, seconds: number): AudioBuffer {
    const b = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function brownBuffer(c: AudioContext, seconds: number): AudioBuffer {
    const b = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    return b;
  }
  /** A decaying stereo noise tail: a hall made of nothing. */
  function impulse(c: AudioContext, seconds: number, decay: number): AudioBuffer {
    const b = c.createBuffer(2, Math.floor(c.sampleRate * seconds), c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, decay);
    }
    return b;
  }

  let white: AudioBuffer | null = null;

  function ensure(): AudioContext | null {
    if (ctx) return ctx;
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
    const c = ctx;
    master = c.createGain();
    master.gain.value = muted ? 0 : 0.85;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    master.connect(comp).connect(c.destination);
    tap = c.createMediaStreamDestination();
    comp.connect(tap);
    probe = c.createAnalyser();
    probe.fftSize = 2048;
    probe.smoothingTimeConstant = 0;
    comp.connect(probe);

    outdoor = c.createBiquadFilter();
    outdoor.type = "lowpass";
    outdoor.frequency.value = 18000;
    outdoorGain = c.createGain();
    outdoorGain.gain.value = 1;
    outdoor.connect(outdoorGain).connect(master);

    const verb = c.createConvolver();
    verb.buffer = impulse(c, 2.8, 3.2);
    reverbIn = c.createGain();
    reverbIn.gain.value = 0.35;
    const verbOut = c.createGain();
    verbOut.gain.value = 0.5;
    reverbIn.connect(verb).connect(verbOut).connect(master);

    white = whiteBuffer(c, 3);
    const brownL = brownBuffer(c, 4), brownR = brownBuffer(c, 4.3);
    const loop = (buf: AudioBuffer, name: string, type: BiquadFilterType, freq: number, q: number, pan = 0, out: AudioNode = outdoor!) => {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = Math.random() * 0.5;
      const fl = c.createBiquadFilter();
      fl.type = type;
      fl.frequency.value = freq;
      fl.Q.value = q;
      const gn = c.createGain();
      gn.gain.value = 0;
      const p = c.createStereoPanner();
      p.pan.value = pan;
      src.connect(fl).connect(gn).connect(p).connect(out);
      src.start(0, Math.random() * 2);
      g[name] = gn;
      f[name] = fl;
    };
    loop(brownL, "bodyL", "lowpass", 380, 0.5, -0.55);
    loop(brownR, "bodyR", "lowpass", 380, 0.5, 0.55);
    loop(white, "howl1", "bandpass", 520, 14, -0.2);
    loop(white, "howl2", "bandpass", 780, 18, 0.25);
    loop(white, "leaves", "highpass", 2600, 0.4, 0);
    loop(white, "rain", "highpass", 1600, 0.5, 0);
    loop(white, "rainLow", "lowpass", 500, 0.6, 0);
    loop(brownL, "storm", "lowpass", 160, 0.8, 0);
    loop(brownR, "river", "lowpass", 700, 0.5, 0);
    // Babble: bubbling voices on top of the river's body.
    for (let i = 0; i < 4; i++) loop(white, `bub${i}`, "bandpass", 600 + i * 350, 7, (i - 1.5) * 0.3);
    loop(white, "cicada", "bandpass", 5200, 3, 0.3);
    loop(brownL, "hearth", "lowpass", 260, 0.7, 0, master);

    windTimer = window.setInterval(tickWind, 60);
    return c;
  }

  function tickWind() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const dt = 0.06;
    const ou = (v: number, mean: number, theta: number, sigma: number) => Math.max(0, Math.min(1, v + theta * (mean - v) * dt + sigma * Math.sqrt(dt) * (Math.random() * 2 - 1) * 1.7));
    gust = ou(gust, 0.45, 0.35, 0.45);
    gustFast = ou(gustFast, gust, 3.5, 1.1);
    gustL = ou(gustL, gust, 1.2, 0.5);
    gustR = ou(gustR, gust, 1.2, 0.5);
    const w = levels.wind * (1 - levels.indoors * 0.6);
    const e = (x: number) => w * (0.25 + 1.05 * x);
    const el = e(gustL), er = e(gustR);
    const tc = 0.25;
    g.bodyL.gain.setTargetAtTime(0.015 + el * 0.42, t, tc);
    g.bodyR.gain.setTargetAtTime(0.015 + er * 0.42, t, tc);
    f.bodyL.frequency.setTargetAtTime(160 + el * 620, t, tc);
    f.bodyR.frequency.setTargetAtTime(170 + er * 600, t, tc);
    const howl = Math.max(0, e(gust) - 0.38);
    g.howl1.gain.setTargetAtTime(howl * howl * 0.5, t, 0.4);
    g.howl2.gain.setTargetAtTime(howl * howl * 0.28, t, 0.5);
    f.howl1.frequency.setTargetAtTime(380 + e(gust) * 420 + Math.sin(t * 0.7) * 30, t, 0.5);
    f.howl2.frequency.setTargetAtTime(600 + e(gustFast) * 520, t, 0.4);
    // Leaves: the wind you actually hear, fluttering fast.
    const rustle = (0.25 + levels.leaves * 0.9) * e(gustFast) * (0.6 + Math.random() * 0.8);
    g.leaves.gain.setTargetAtTime(rustle * 0.07, t, 0.03);
    // River babble: each voice wanders on its own.
    for (let i = 0; i < 4; i++) {
      g[`bub${i}`].gain.setTargetAtTime(levels.water * (Math.random() < 0.35 ? 0.05 + Math.random() * 0.07 : 0.008), t, 0.04);
      if (Math.random() < 0.2) f[`bub${i}`].frequency.setTargetAtTime(450 + Math.random() * 1700, t, 0.05);
    }
    // Hearth crackle: a noise bed plus random pops.
    g.hearth.gain.setTargetAtTime(levels.fire * (0.05 + Math.random() * 0.05), t, 0.08);
    if (levels.fire > 0.05 && Math.random() < 0.25 * levels.fire) crack(levels.fire);
    // Chimes: a strong gust reaching a chime rings it.
    for (const ch of chimes) {
      const d = Math.hypot(ch.x - me.x, ch.z - me.z);
      if (d > 40) continue;
      if (Math.random() < 0.035 * e(gustFast) * 3) furin(ch, 0.6 + Math.random() * 0.4);
    }
  }

  /** Gain and pan for a point in the world, from the listener. */
  function place(at: { x: number; z: number } | undefined, radius = 12): { gain: number; pan: number } {
    if (!at) return { gain: 1, pan: 0 };
    const dx = at.x - me.x, dz = at.z - me.z;
    const d = Math.hypot(dx, dz);
    const gain = 1 / (1 + (d * d) / (radius * radius));
    // Right of the listener is +x when looking down -z.
    const rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw);
    const pan = d < 0.5 ? 0 : Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) * 0.8;
    return { gain, pan };
  }

  function voice(dest: "dry" | "wet" | "both", pan: number, outdoors = true): GainNode | null {
    if (!ctx || !master) return null;
    const gn = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    gn.connect(p);
    if (dest !== "wet") p.connect(outdoors && outdoor ? outdoor : master);
    if (dest !== "dry" && reverbIn) p.connect(reverbIn);
    return gn;
  }

  function tone(freq: number, dur: number, gain: number, type: OscillatorType = "sine", detune = 0, opts: { at?: { x: number; z: number }; wet?: boolean; bend?: number; delay?: number; attack?: number } = {}) {
    const c = ensure();
    if (!c) return;
    const { gain: dg, pan } = place(opts.at);
    if (dg < 0.01) return;
    const t = c.currentTime + (opts.delay ?? 0);
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (opts.bend) o.frequency.exponentialRampToValueAtTime(freq * opts.bend, t + dur);
    o.detune.value = detune;
    const out = voice(opts.wet ? "both" : "dry", pan, !!opts.at);
    if (!out) return;
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * dg), t + (opts.attack ?? 0.008));
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function burst(dur: number, gain: number, freq: number, type: BiquadFilterType = "lowpass", opts: { at?: { x: number; z: number }; sweep?: number; q?: number; wet?: boolean } = {}) {
    const c = ensure();
    if (!c || !white) return;
    const { gain: dg, pan } = place(opts.at);
    if (dg < 0.01) return;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = white;
    const fl = c.createBiquadFilter();
    fl.type = type;
    fl.Q.value = opts.q ?? 0.8;
    fl.frequency.setValueAtTime(freq, t);
    fl.frequency.exponentialRampToValueAtTime(Math.max(40, freq * (opts.sweep ?? 0.2)), t + dur);
    const out = voice(opts.wet ? "both" : "dry", pan, !!opts.at);
    if (!out) return;
    out.gain.setValueAtTime(gain * dg, t);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(fl).connect(out);
    src.start(t, Math.random() * 2, dur + 0.05);
  }

  /** A cat's purr: low noise pulsed about twenty-five times a second, breathing in and out. */
  function purr(at?: { x: number; z: number }) {
    const c = ensure();
    if (!c || !white) return;
    const { gain: dg, pan } = place(at, 4);
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = white;
    const fl = c.createBiquadFilter();
    fl.type = "lowpass"; fl.frequency.value = 180; fl.Q.value = 2;
    const am = c.createGain();
    am.gain.value = 0;
    const lfo = c.createOscillator();
    lfo.frequency.value = 26;
    const depth = c.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(am.gain);
    const out = voice("dry", pan, false);
    if (!out) return;
    out.gain.setValueAtTime(0, t);
    for (let i = 0; i < 3; i++) {
      out.gain.linearRampToValueAtTime(0.5 * dg, t + i * 1.1 + 0.5);
      out.gain.linearRampToValueAtTime(0.22 * dg, t + i * 1.1 + 1.05);
    }
    out.gain.linearRampToValueAtTime(0, t + 3.6);
    src.connect(fl).connect(am).connect(out);
    src.start(t, Math.random(), 3.7);
    lfo.start(t);
    lfo.stop(t + 3.7);
  }

  function crack(level: number) {
    burst(0.02 + Math.random() * 0.03, 0.12 * level, 1800 + Math.random() * 2500, "bandpass", { q: 2, sweep: 0.6 });
  }

  /** A glass fuurin: a clapper striking a small bell, inharmonic partials. */
  function furin(at: { x: number; z: number } | undefined, strength: number) {
    const base = 2100 + Math.random() * 90;
    const opts = { at, wet: true };
    tone(base, 1.8, 0.05 * strength, "sine", 0, opts);
    tone(base * 2.76, 1.1, 0.025 * strength, "sine", 0, opts);
    tone(base * 5.4, 0.5, 0.012 * strength, "sine", 0, opts);
    if (Math.random() < 0.5) tone(base * 1.004, 1.4, 0.03 * strength, "sine", 0, { ...opts, delay: 0.09 + Math.random() * 0.1 });
  }

  // ---- living things -------------------------------------------------------

  function birdsong() {
    if (ctx && levels.birds > 0.05 && levels.indoors < 0.5 && Math.random() < levels.birds) {
      const at = { x: me.x + (Math.random() - 0.5) * 50, z: me.z + (Math.random() - 0.5) * 50 };
      const roll = Math.random();
      if (roll < 0.28) {
        // Uguisu: a long held whistle, then "ho-ke-kyo".
        const b = 1150 + Math.random() * 120;
        tone(b, 1.3, 0.05, "sine", 0, { at, wet: true, bend: 1.06, attack: 0.25 });
        tone(b * 1.45, 0.16, 0.05, "sine", 0, { at, wet: true, delay: 1.45, bend: 1.2 });
        tone(b * 2.05, 0.14, 0.05, "sine", 0, { at, wet: true, delay: 1.65, bend: 0.8 });
        tone(b * 1.6, 0.45, 0.05, "sine", 0, { at, wet: true, delay: 1.83, bend: 0.92 });
      } else if (roll < 0.75) {
        // A small bird: a run of quick descending chirps.
        const n = 2 + Math.floor(Math.random() * 5);
        const b = 2800 + Math.random() * 1600;
        for (let i = 0; i < n; i++) tone(b * (1 - i * 0.03), 0.07, 0.03, "sine", 0, { at, wet: true, delay: i * 0.11, bend: 0.65 });
      } else {
        // A far dove: two soft low notes.
        tone(520, 0.45, 0.025, "sine", 0, { at, wet: true, attack: 0.1, bend: 0.94 });
        tone(470, 0.7, 0.025, "sine", 0, { at, wet: true, attack: 0.1, delay: 0.55, bend: 0.94 });
      }
    }
    later(birdsong, 1800 + Math.random() * 5000);
  }

  function night() {
    if (ctx && levels.indoors < 0.8) {
      const n = levels.night * (1 - levels.rain * 0.8) * (1 - levels.indoors * 0.6);
      if (n > 0.05) {
        // Suzumushi, the bell cricket: a bright ringing trill.
        const at = { x: me.x + (Math.random() - 0.5) * 16, z: me.z + (Math.random() - 0.5) * 16 };
        const freq = 4100 + Math.random() * 500;
        const pulses = 5 + Math.floor(Math.random() * 8);
        for (let i = 0; i < pulses; i++) tone(freq, 0.035, 0.022 * n, "sine", 0, { at, delay: i * 0.045 });
      }
      if (levels.frogs > 0.05 && Math.random() < levels.frogs) {
        // Kaeru: a throaty double croak.
        const at = { x: me.x + (Math.random() - 0.5) * 20, z: me.z + (Math.random() - 0.5) * 20 };
        const fr = 280 + Math.random() * 160;
        for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
          tone(fr, 0.09, 0.05 * levels.frogs, "square", 0, { at, delay: i * 0.16, bend: 0.8 });
        }
      }
    }
    later(night, 350 + Math.random() * 900);
  }

  /** A few koto notes in the yo scale, a long way apart. */
  function koto() {
    if (ctx && music && !muted) {
      const n = 1 + Math.floor(Math.random() * 3);
      let idx = 3 + Math.floor(Math.random() * 6);
      for (let i = 0; i < n; i++) {
        const fr = YO[Math.max(0, Math.min(YO.length - 1, idx))];
        const d = i * (0.35 + Math.random() * 0.4);
        tone(fr, 2.4, 0.045, "triangle", 0, { wet: true, delay: d, bend: 0.997 });
        tone(fr * 2, 1.2, 0.012, "sine", 4, { wet: true, delay: d });
        idx += Math.random() < 0.5 ? -1 : -2;
      }
    }
    later(koto, 5000 + Math.random() * 9000);
  }

  let started = false;

  return {
    resume() {
      const c = ensure();
      if (c && c.state === "suspended") void c.resume();
      if (!started) { started = true; birdsong(); night(); later(koto, 3000); }
    },
    set(l) {
      levels = { ...levels, ...l, leaves: l.leaves ?? levels.leaves, birds: l.birds ?? 0, frogs: l.frogs ?? 0, cicadas: l.cicadas ?? 0, indoors: l.indoors ?? 0, fire: l.fire ?? 0 };
      if (!ctx || !outdoor || !outdoorGain) return;
      const t = ctx.currentTime;
      const inside = levels.indoors;
      outdoor.frequency.setTargetAtTime(inside > 0.5 ? 900 : 18000, t, 0.4);
      outdoorGain.gain.setTargetAtTime(1 - inside * 0.45, t, 0.4);
      g.rain.gain.setTargetAtTime(l.rain * 0.16, t, 0.8);
      g.rainLow.gain.setTargetAtTime(l.rain * 0.1 + l.storm * 0.06, t, 0.8);
      g.storm.gain.setTargetAtTime(l.storm * 0.14, t, 0.8);
      g.river.gain.setTargetAtTime(l.water * 0.09, t, 0.6);
      g.cicada.gain.setTargetAtTime(levels.cicadas * 0.018 * (0.6 + 0.4 * Math.sin(t * 9)), t, 0.3);
    },
    listener(x, z, yaw) { me.x = x; me.z = z; me.yaw = yaw; },
    setChimes(points) { chimes = points; },
    play(name, at) {
      const o = { at, wet: true };
      switch (name) {
        case "bell": tone(660, 3.2, 0.22, "sine", 0, o); tone(1320, 2.2, 0.07, "sine", 0, o); tone(990, 2.6, 0.05, "sine", 12, o); break;
        case "gong": tone(140, 4, 0.3, "triangle", 0, o); tone(210, 3.5, 0.13, "sine", 0, o); tone(283, 2.5, 0.09, "sine", 0, o); burst(0.4, 0.12, 800, "lowpass", o); break;
        case "thunder": burst(2.4, 0.55, 220, "lowpass", { wet: true }); later(() => burst(1.6, 0.32, 140, "lowpass", { wet: true }), 350); break;
        case "chime": tone(1046, 0.9, 0.1, "sine", 0, o); tone(1318, 0.8, 0.08, "sine", 0, { ...o, delay: 0.09 }); tone(1568, 1.1, 0.08, "sine", 0, { ...o, delay: 0.18 }); break;
        case "sparkle": for (let i = 0; i < 6; i++) tone(YO[6 + (i % 6)] * 2, 0.6, 0.035, "sine", 0, { ...o, delay: i * 0.06 }); break;
        case "whoosh": burst(0.6, 0.22, 2400, "bandpass", o); break;
        case "hit": burst(0.35, 0.45, 600); tone(110, 0.3, 0.25, "square"); break;
        case "fizz": burst(0.9, 0.18, 4000, "highpass", o); break;
        case "roar": burst(1.8, 0.5, 300, "lowpass", o); tone(70, 1.6, 0.3, "sawtooth", 0, o); tone(95, 1.2, 0.18, "sawtooth", 8, o); break;
        case "pop": tone(880, 0.12, 0.18, "triangle", 0, o); burst(0.12, 0.13, 3000, "bandpass", o); break;
        case "splash": burst(0.5, 0.3, 2600, "bandpass", { ...o, q: 0.6, sweep: 0.3 }); later(() => burst(0.25, 0.12, 1800, "bandpass", o), 120); break;
        case "plop": tone(420, 0.12, 0.12, "sine", 0, { ...o, bend: 2.2 }); burst(0.08, 0.06, 1500, "bandpass", o); break;
        case "furin": furin(at, 1); break;
        case "purr": purr(at); break;
        case "mew": tone(620, 0.35, 0.05, "triangle", 0, { ...o, bend: 1.45, attack: 0.05 }); tone(900, 0.4, 0.035, "triangle", 0, { ...o, delay: 0.3, bend: 0.62, attack: 0.04 }); break;
      }
    },
    beep(freq, dur, type = "square", gain = 0.05, at) {
      tone(Math.max(40, Math.min(8000, freq)), Math.max(0.02, Math.min(2, dur)), Math.max(0, Math.min(0.12, gain)), type, 0, { at });
    },
    step(surface) {
      if (!ctx) return;
      switch (surface) {
        case "grass": burst(0.09, 0.05, 3200, "highpass", { sweep: 0.5 }); break;
        case "wood": tone(150 + Math.random() * 30, 0.08, 0.09, "triangle", 0, { bend: 0.7 }); burst(0.05, 0.05, 900, "lowpass"); break;
        case "tatami": burst(0.12, 0.035, 1400, "bandpass", { q: 0.5, sweep: 0.7 }); break;
        case "stone": burst(0.07, 0.07, 1600, "bandpass", { q: 1.2, sweep: 0.6 }); break;
        case "water": burst(0.2, 0.08, 1800, "bandpass", { q: 0.7, sweep: 0.4 }); break;
      }
    },
    stream() { ensure(); return tap?.stream ?? null; },
    analyser() { ensure(); return probe; },
    setMuted(m) {
      muted = m;
      if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.85, ctx.currentTime, 0.1);
    },
    setMusic(on) { music = on; },
    dispose() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (windTimer !== null) clearInterval(windTimer);
      void ctx?.close();
      ctx = null;
    },
  };
}
