/**
 * The valley's own sounds, all synthesised. No files, so nothing to load,
 * and everything responds to the state the moment it changes: rain gets
 * louder as the rain gets heavier, wind follows the wind, and the crickets
 * come out with the fireflies.
 *
 * Vibey's *voice* is not here; that is a WebRTC audio track the voice
 * session owns. This is the room the voice speaks in.
 */

export interface Ambience {
  /** Must be called from a user gesture at least once. */
  resume(): void;
  set(levels: { rain: number; wind: number; night: number; storm: number; water: number }): void;
  play(name: "bell" | "gong" | "thunder" | "chime" | "whoosh" | "hit" | "fizz" | "roar" | "pop"): void;
  setMuted(m: boolean): void;
  /** The mix as a stream, for the recorder. */
  stream(): MediaStream | null;
  dispose(): void;
}

export function createAmbience(): Ambience {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let tap: MediaStreamAudioDestinationNode | null = null;
  let muted = false;
  const gains: Record<string, GainNode> = {};
  let cricketTimer: number | null = null;
  let cricketLevel = 0;

  function noiseBuffer(c: AudioContext, seconds = 2): AudioBuffer {
    const b = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  function ensure(): AudioContext | null {
    if (ctx) return ctx;
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.8;
    master.connect(ctx.destination);
    tap = ctx.createMediaStreamDestination();
    master.connect(tap);
    const noise = noiseBuffer(ctx, 3);
    const mk = (name: string, filterType: BiquadFilterType, freq: number, q = 0.7) => {
      const src = ctx!.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const f = ctx!.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx!.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(master!);
      src.start();
      gains[name] = g;
    };
    mk("rain", "highpass", 1800, 0.5);
    mk("wind", "bandpass", 320, 0.6);
    mk("water", "lowpass", 900, 0.4);
    mk("storm", "lowpass", 180, 0.8);
    // Wind gusts: slowly modulate the wind filter with an LFO.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.35;
    lfo.connect(lfoGain).connect(gains.wind.gain);
    lfo.start();
    return ctx;
  }

  function crickets() {
    if (!ctx || !master || cricketLevel <= 0.02) { cricketTimer = window.setTimeout(crickets, 400); return; }
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = 4200 + Math.random() * 600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    for (let i = 0; i < 4; i++) {
      g.gain.linearRampToValueAtTime(0.04 * cricketLevel, t + i * 0.09 + 0.02);
      g.gain.linearRampToValueAtTime(0, t + i * 0.09 + 0.06);
    }
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.5);
    cricketTimer = window.setTimeout(crickets, 500 + Math.random() * 1500);
  }

  function tone(freq: number, dur: number, gain: number, type: OscillatorType = "sine", detune = 0) {
    const c = ensure();
    if (!c || !master) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function burst(dur: number, gain: number, freq: number, type: BiquadFilterType = "lowpass") {
    const c = ensure();
    if (!c || !master) return;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, dur + 0.1);
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.2), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
  }

  return {
    resume() {
      const c = ensure();
      if (c && c.state === "suspended") void c.resume();
      if (cricketTimer === null) crickets();
    },
    set(l) {
      if (!ctx) return;
      const t = ctx.currentTime;
      gains.rain.gain.setTargetAtTime(l.rain * 0.22, t, 0.8);
      gains.wind.gain.setTargetAtTime(0.03 + l.wind * 0.25, t, 0.8);
      gains.water.gain.setTargetAtTime(l.water * 0.08, t, 0.8);
      gains.storm.gain.setTargetAtTime(l.storm * 0.12, t, 0.8);
      cricketLevel = l.night * (1 - l.rain);
    },
    play(name) {
      switch (name) {
        case "bell": tone(660, 3.2, 0.25); tone(1320, 2.2, 0.08); tone(990, 2.6, 0.05, "sine", 12); break;
        case "gong": tone(140, 4, 0.35, "triangle"); tone(210, 3.5, 0.15); tone(283, 2.5, 0.1); burst(0.4, 0.15, 800); break;
        case "thunder": burst(2.4, 0.6, 220); setTimeout(() => burst(1.6, 0.35, 140), 350); break;
        case "chime": tone(1046, 0.7, 0.12); setTimeout(() => tone(1318, 0.6, 0.1), 90); setTimeout(() => tone(1568, 0.9, 0.1), 180); break;
        case "whoosh": burst(0.6, 0.25, 2400, "bandpass"); break;
        case "hit": burst(0.35, 0.5, 600); tone(110, 0.3, 0.3, "square"); break;
        case "fizz": burst(0.9, 0.2, 4000, "highpass"); break;
        case "roar": burst(1.8, 0.55, 300); tone(70, 1.6, 0.35, "sawtooth"); tone(95, 1.2, 0.2, "sawtooth", 8); break;
        case "pop": tone(880, 0.12, 0.2, "triangle"); burst(0.12, 0.15, 3000, "bandpass"); break;
      }
    },
    stream() { ensure(); return tap?.stream ?? null; },
    setMuted(m) {
      muted = m;
      if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.1);
    },
    dispose() {
      if (cricketTimer !== null) clearTimeout(cricketTimer);
      void ctx?.close();
      ctx = null;
    },
  };
}
