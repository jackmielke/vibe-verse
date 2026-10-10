/**
 * The sound of the place, synthesised: surf on the rocks, a breeze, gulls,
 * and a lyre somebody in the town is playing, slowly, in the Dorian mode.
 * Nothing is downloaded. The context starts on the first click or tap,
 * because browsers will not let it start any sooner.
 */

export interface Ambience {
  resume(): void;
  setMuted(m: boolean): void;
  play(name: "whoosh" | "splash"): void;
  update(dt: number, at: { x: number; y: number; z: number; swimming: boolean }): void;
  dispose(): void;
}

// D Dorian, in two octaves, as frequencies.
const SCALE = [146.83, 164.81, 174.61, 196.0, 220.0, 246.94, 261.63, 293.66, 329.63, 349.23, 392.0, 440.0];

export function createAmbience(): Ambience {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let surfGain: GainNode | null = null;
  let windGain: GainNode | null = null;
  let musicGain: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let muted = false;
  let nextGull = 3;
  let nextNote = 1;
  let phrase: number[] = [];
  let wasSwimming = false;
  const sources: AudioScheduledSourceNode[] = [];

  const start = () => {
    if (ctx) return;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);
    // Pink-ish noise, two seconds, looped.
    const len = ctx.sampleRate * 2;
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    }
    const loop = (filterType: BiquadFilterType, freq: number, q: number) => {
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
      sources.push(src);
      return { g, f };
    };
    surfGain = loop("lowpass", 520, 0.4).g;
    const wind = loop("bandpass", 380, 0.6);
    windGain = wind.g;
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.22;
    musicGain.connect(master);
  };

  const gull = () => {
    if (!ctx || !master) return;
    const t0 = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    const g = ctx.createGain();
    g.gain.value = 0;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1700;
    f.Q.value = 2.5;
    f.connect(g).connect(pan).connect(master);
    const calls = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < calls; i++) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      const s = t0 + i * 0.32;
      const base = 1500 + Math.random() * 300;
      o.frequency.setValueAtTime(base * 1.25, s);
      o.frequency.exponentialRampToValueAtTime(base * 0.72, s + 0.24);
      o.connect(f);
      o.start(s);
      o.stop(s + 0.28);
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.03, s + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0008, s + 0.26);
    }
  };

  const pluck = (freq: number, when: number, vel: number) => {
    if (!ctx || !musicGain) return;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(freq * 9, when);
    f.frequency.exponentialRampToValueAtTime(freq * 1.6, when + 0.9);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.18 * vel, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0005, when + 2.4);
    f.connect(g).connect(musicGain);
    for (const [type, mul, amp] of [["triangle", 1, 1], ["sine", 2, 0.35], ["sine", 3.01, 0.12]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * mul;
      const og = ctx.createGain();
      og.gain.value = amp;
      o.connect(og).connect(f);
      o.start(when);
      o.stop(when + 2.5);
    }
  };

  const noiseBurst = (dur: number, from: number, to: number, vol: number) => {
    if (!ctx || !master || !noise) return;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    const t = ctx.currentTime;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start();
    src.stop(t + dur);
  };

  return {
    resume() {
      start();
      void ctx?.resume().catch(() => undefined);
    },
    setMuted(m) {
      muted = m;
      if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.1);
    },
    play(name) {
      if (name === "whoosh") noiseBurst(0.5, 300, 2400, 0.25);
      else noiseBurst(0.7, 1800, 300, 0.4);
    },
    update(dt, at) {
      if (!ctx || ctx.state !== "running") return;
      const t = ctx.currentTime;
      // Surf: swells every few seconds, louder low down and near the water.
      const near = Math.max(0, 1 - Math.max(0, at.y - 1) / 25);
      const swell = 0.55 + 0.45 * Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1);
      surfGain?.gain.setTargetAtTime((0.12 + 0.3 * near) * (0.6 + swell * 0.6) * (at.swimming ? 1.6 : 1), t, 0.3);
      windGain?.gain.setTargetAtTime(0.05 + Math.min(0.25, Math.max(0, at.y - 8) / 120) + 0.03 * Math.sin(t * 0.21), t, 0.6);
      if (at.swimming && !wasSwimming) noiseBurst(0.7, 1800, 300, 0.4);
      wasSwimming = at.swimming;
      nextGull -= dt;
      if (nextGull <= 0) { gull(); nextGull = 5 + Math.random() * 9; }
      // The lyre: short phrases that wander the mode and come home to D.
      nextNote -= dt;
      if (nextNote <= 0) {
        if (!phrase.length) {
          const len = 5 + Math.floor(Math.random() * 5);
          let i = 4 + Math.floor(Math.random() * 4);
          for (let k = 0; k < len; k++) {
            i = Math.max(0, Math.min(SCALE.length - 1, i + [-2, -1, -1, 1, 1, 2, 0][Math.floor(Math.random() * 7)]));
            phrase.push(i);
          }
          phrase.push(Math.random() < 0.5 ? 0 : 7);
          nextNote = 2.5 + Math.random() * 3; // breathe between phrases
          return;
        }
        const i = phrase.shift()!;
        pluck(SCALE[i], t + 0.02, 0.7 + Math.random() * 0.3);
        if (!phrase.length) pluck(SCALE[0] / 2, t + 0.02, 0.6);
        nextNote = [0.42, 0.42, 0.84, 0.21][Math.floor(Math.random() * 4)];
      }
    },
    dispose() {
      for (const s of sources) { try { s.stop(); } catch { /* already */ } }
      void ctx?.close().catch(() => undefined);
      ctx = null;
    },
  };
}
