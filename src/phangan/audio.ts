/**
 * Flow Phangan: the putter.
 *
 * One AudioContext, a sawtooth through a lowpass for the engine, a square
 * wave chopping its gain for the four-stroke putt, a noise loop for the rain,
 * and short sine bursts for the bell and the beats. Nothing fetched. The
 * context is created on the first user gesture the world sees and closed on
 * dispose, because a leaked AudioContext outlives the route.
 */

export interface Putter {
  /** rpm 0..1 by speed, throttle 0..1 by input. */
  engine(rpm: number, throttle: number): void;
  rain(level: number): void;
  click(kind: "perfect" | "good" | "miss" | "pick" | "eat" | "bump"): void;
  bell(): void;
  resume(): void;
  dispose(): void;
}

export function createPutter(): Putter {
  type Ctx = AudioContext;
  const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
  if (!AC) {
    return { engine() {}, rain() {}, click() {}, bell() {}, resume() {}, dispose() {} };
  }
  const ctx: Ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  // Engine.
  const carrier = ctx.createOscillator();
  carrier.type = "sawtooth";
  carrier.frequency.value = 50;
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 420;
  low.Q.value = 2;
  const chop = ctx.createGain();
  chop.gain.value = 0.5;
  const putt = ctx.createOscillator();
  putt.type = "square";
  putt.frequency.value = 9;
  const puttDepth = ctx.createGain();
  puttDepth.gain.value = 0.45;
  putt.connect(puttDepth).connect(chop.gain);
  const engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  carrier.connect(low).connect(chop).connect(engineGain).connect(master);
  carrier.start();
  putt.start();

  // Rain.
  const seconds = 2;
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 7;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 16807) % 2147483647;
    data[i] = (seed / 2147483647) * 2 - 1;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;
  const rainFilter = ctx.createBiquadFilter();
  rainFilter.type = "lowpass";
  rainFilter.frequency.value = 1600;
  const rainGain = ctx.createGain();
  rainGain.gain.value = 0;
  noise.connect(rainFilter).connect(rainGain).connect(master);
  noise.start();

  const burst = (freq: number, seconds: number, gain: number, type: OscillatorType = "sine", slide = 1) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), ctx.currentTime + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + seconds);
    o.connect(g).connect(master);
    o.start();
    o.stop(ctx.currentTime + seconds + 0.02);
  };

  let disposed = false;
  return {
    engine(rpm, throttle) {
      if (disposed) return;
      const r = Math.max(0, Math.min(1, rpm));
      const t = ctx.currentTime;
      carrier.frequency.setTargetAtTime(48 + r * 130 + throttle * 12, t, 0.08);
      putt.frequency.setTargetAtTime(7 + r * 38, t, 0.08);
      low.frequency.setTargetAtTime(380 + r * 900 + throttle * 300, t, 0.1);
      engineGain.gain.setTargetAtTime(0.06 + r * 0.1 + throttle * 0.05, t, 0.1);
    },
    rain(level) {
      if (disposed) return;
      rainGain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.12, ctx.currentTime, 0.4);
    },
    click(kind) {
      if (disposed || ctx.state !== "running") return;
      if (kind === "perfect") burst(880, 0.12, 0.25, "triangle", 1.5);
      else if (kind === "good") burst(620, 0.12, 0.2, "triangle", 1.2);
      else if (kind === "miss") burst(160, 0.2, 0.2, "sawtooth", 0.5);
      else if (kind === "pick") burst(520, 0.15, 0.18, "sine", 1.6);
      else if (kind === "eat") burst(420, 0.25, 0.2, "sine", 2);
      else burst(90, 0.18, 0.3, "square", 0.6);
    },
    bell() {
      if (disposed || ctx.state !== "running") return;
      burst(1320, 1.4, 0.2);
      burst(1980, 1.1, 0.12);
      burst(660, 1.8, 0.15);
    },
    resume() {
      if (disposed) return;
      if (ctx.state === "suspended") void ctx.resume();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        carrier.stop();
        putt.stop();
        noise.stop();
      } catch {
        /* already stopped */
      }
      void ctx.close();
    },
  };
}
