/**
 * Sound for Mars College: a synth loop off the unicycle's speaker, the wind
 * of a dust storm, and somebody's power drill. Nothing is fetched. The
 * AudioContext is created on the first user gesture and closed on dispose,
 * because a leaked context is the kind of thing that breaks the next world.
 */

export interface MarsAudio {
  setMusic(on: boolean): void;
  musicOn(): boolean;
  /** 0..1, how deep inside the storm you are. */
  setStorm(level: number): void;
  drill(): void;
  dispose(): void;
}

// A minor pentatonic riff, in Hz, sixteen steps. Rides better than it reads.
const BASS = [55, 0, 55, 65.4, 0, 55, 0, 73.4, 55, 0, 55, 65.4, 0, 82.4, 73.4, 0];
const LEAD = [220, 261.6, 0, 293.7, 0, 220, 329.6, 0, 0, 261.6, 0, 293.7, 349.2, 0, 293.7, 0];
const STEP = 60 / 118 / 4;

export function createAudio(): MarsAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let stormGain: GainNode | null = null;
  let stormSrc: AudioBufferSourceNode | null = null;
  let music = false;
  let timer = 0;
  let nextStep = 0;
  let step = 0;
  let stormLevel = 0;
  let disposed = false;

  const ensure = (): AudioContext | null => {
    if (ctx || disposed) return ctx;
    const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // The storm: filtered noise, gain driven by the world.
    const seconds = 2;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      // Brown-ish noise reads as wind; white reads as a radio.
      last = (last + (Math.random() * 2 - 1) * 0.04) * 0.985;
      data[i] = last * 8;
    }
    stormSrc = ctx.createBufferSource();
    stormSrc.buffer = buf;
    stormSrc.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 520;
    stormGain = ctx.createGain();
    stormGain.gain.value = 0;
    stormSrc.connect(lp).connect(stormGain).connect(master);
    stormSrc.start();
    return ctx;
  };

  const voice = (freq: number, at: number, len: number, type: OscillatorType, gain: number) => {
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, at + len);
    o.connect(g).connect(master);
    o.start(at);
    o.stop(at + len + 0.02);
  };

  const kick = (at: number) => {
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(140, at);
    o.frequency.exponentialRampToValueAtTime(40, at + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.25);
    o.connect(g).connect(master);
    o.start(at);
    o.stop(at + 0.3);
  };

  const schedule = () => {
    if (!ctx || !music) return;
    while (nextStep < ctx.currentTime + 0.15) {
      const i = step % 16;
      if (i % 4 === 0) kick(nextStep);
      if (BASS[i]) voice(BASS[i], nextStep, STEP * 1.8, "sawtooth", 0.16);
      if (LEAD[i]) voice(LEAD[i], nextStep, STEP * 1.2, "square", 0.05);
      if (i % 2 === 1) voice(6000, nextStep, 0.03, "triangle", 0.03);
      nextStep += STEP;
      step++;
    }
  };

  return {
    setMusic(on) {
      music = on;
      if (on) {
        const c = ensure();
        if (!c) return;
        if (c.state === "suspended") void c.resume();
        nextStep = c.currentTime + 0.05;
        clearInterval(timer);
        timer = window.setInterval(schedule, 60);
      } else {
        clearInterval(timer);
        timer = 0;
      }
    },
    musicOn: () => music,
    setStorm(level) {
      stormLevel = Math.max(0, Math.min(1, level));
      if (!stormGain || !ctx) return;
      stormGain.gain.setTargetAtTime(stormLevel * 0.6, ctx.currentTime, 0.4);
    },
    drill() {
      if (!ctx || !master) return;
      const at = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(180, at);
      o.frequency.linearRampToValueAtTime(260, at + 0.6);
      o.frequency.linearRampToValueAtTime(200, at + 1.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, at);
      g.gain.linearRampToValueAtTime(0.05, at + 0.05);
      g.gain.linearRampToValueAtTime(0.0, at + 1.2);
      o.connect(g).connect(master);
      o.start(at);
      o.stop(at + 1.25);
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      try {
        stormSrc?.stop();
      } catch {
        /* never started */
      }
      if (ctx) void ctx.close();
      ctx = null;
    },
  };
}
