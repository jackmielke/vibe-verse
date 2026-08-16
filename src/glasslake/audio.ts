/**
 * Sound, synthesised — no files, nothing to download, nothing to licence.
 *
 * Two continuous voices whose gains are driven by what you are doing (wind
 * from speed, blade hiss from how hard the edges are biting) and one struck
 * voice for the shards. The pentatonic step means the twelve pickups play a
 * rising phrase over the course of a run whatever order you find them in;
 * there is no arrangement of the lake that sounds wrong.
 *
 * The context is created from the click that starts the world, never before
 * — an AudioContext built at import time is a suspended context and a
 * console warning on every browser worth supporting.
 */

export interface LakeAudio {
  setMuted(muted: boolean): void;
  /** Continuous state, once a frame. */
  drive(speed: number, carve: number): void;
  shard(index: number): void;
  finale(): void;
  dispose(): void;
}

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Brown-ish noise: integrated white, which is the spectrum wind actually
  // has. Plain white noise sounds like a broken television.
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}

export function createLakeAudio(): LakeAudio | null {
  const Ctor: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }

  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  const buffer = noiseBuffer(ctx, 3);

  // Wind.
  const wind = ctx.createBufferSource();
  wind.buffer = buffer;
  wind.loop = true;
  const windFilter = ctx.createBiquadFilter();
  windFilter.type = "lowpass";
  windFilter.frequency.value = 420;
  const windGain = ctx.createGain();
  windGain.gain.value = 0.06;
  wind.connect(windFilter).connect(windGain).connect(master);

  // Blade hiss.
  const hiss = ctx.createBufferSource();
  hiss.buffer = buffer;
  hiss.loop = true;
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = "bandpass";
  hissFilter.frequency.value = 2600;
  hissFilter.Q.value = 0.9;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0;
  hiss.connect(hissFilter).connect(hissGain).connect(master);

  try {
    wind.start();
    hiss.start();
  } catch {
    /* a context that will not start is not worth a broken world */
  }

  const PENTATONIC = [0, 2, 4, 7, 9];
  const ping = (semitones: number, when: number, gain: number, decay: number) => {
    const freq = 261.63 * Math.pow(2, semitones / 12);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const bell = ctx.createOscillator();
    bell.type = "sine";
    bell.frequency.value = freq * 2.01; // a hair sharp, so it beats
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    osc.connect(g);
    bell.connect(g);
    g.connect(master);
    osc.start(when);
    bell.start(when);
    osc.stop(when + decay);
    bell.stop(when + decay);
  };

  let disposed = false;

  return {
    setMuted(muted) {
      if (disposed) return;
      master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.05);
      if (!muted && ctx.state === "suspended") void ctx.resume();
    },

    drive(speed, carve) {
      if (disposed) return;
      const t = ctx.currentTime;
      const s = Math.min(1, speed / 26);
      windGain.gain.setTargetAtTime(0.03 + s * 0.10, t, 0.25);
      windFilter.frequency.setTargetAtTime(380 + s * 900, t, 0.3);
      hissGain.gain.setTargetAtTime(Math.min(0.09, carve * 0.11 + s * 0.012), t, 0.08);
      hissFilter.frequency.setTargetAtTime(1800 + s * 2600, t, 0.15);
    },

    shard(index) {
      if (disposed) return;
      const octave = Math.floor(index / PENTATONIC.length);
      const note = PENTATONIC[index % PENTATONIC.length] + octave * 12;
      const t = ctx.currentTime;
      ping(note + 12, t, 0.22, 1.6);
      ping(note + 24, t + 0.06, 0.10, 1.1);
    },

    finale() {
      if (disposed) return;
      const t = ctx.currentTime;
      [0, 4, 7, 12, 16, 19, 24].forEach((n, i) => ping(n + 12, t + i * 0.09, 0.17, 3.2));
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        wind.stop();
        hiss.stop();
      } catch {
        /* already stopped */
      }
      void ctx.close();
    },
  };
}
