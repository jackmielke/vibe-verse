/**
 * What The Empyrean sounds like: wind, a rocket, and a chord that never
 * resolves.
 *
 * Everything is synthesised — no files to fetch, nothing to wait for, and the
 * whole module is under a hundred lines of WebAudio graph. Three voices:
 *
 *  - **Wind**, a band-passed noise whose gain and centre frequency both ride
 *    your airspeed. It is what tells you how fast you are going when there is
 *    nothing but sky to judge it against, which at four hundred metres up is
 *    most of the time.
 *  - **The jets**, low-passed noise plus a sub-oscillator, gated by throttle.
 *  - **The pad**, four detuned sines on a suspended chord. Quiet enough that
 *    you notice it when it stops.
 *
 * The context is created suspended and only resumed on the first gesture,
 * because Chrome will not start one otherwise and a console full of autoplay
 * warnings is how you find that out the hard way.
 */

export interface EmpyreanAudio {
  /** @param speed m/s, @param burn 0..1 throttle, @param alt metres up */
  update(speed: number, burn: number, alt: number): void;
  setMuted(muted: boolean): void;
  resume(): void;
  dispose(): void;
}

function noiseBuffer(ctx: AudioContext, seconds = 2): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Pink-ish: a one-pole filter on white, which is closer to wind than white
  // is and costs one multiply.
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.045 * w) / 1.045;
    d[i] = last * 3.2;
  }
  return buf;
}

export function createEmpyreanAudio(): EmpyreanAudio | null {
  const Ctx =
    typeof window !== "undefined"
      ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!Ctx) return null;

  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    return null;
  }

  const master = ctx.createGain();
  master.gain.value = 0.0;
  master.connect(ctx.destination);

  const noise = noiseBuffer(ctx);

  /* ---- wind ------------------------------------------------------------ */
  const windSrc = ctx.createBufferSource();
  windSrc.buffer = noise;
  windSrc.loop = true;
  const windFilter = ctx.createBiquadFilter();
  windFilter.type = "bandpass";
  windFilter.frequency.value = 420;
  windFilter.Q.value = 0.7;
  const windGain = ctx.createGain();
  windGain.gain.value = 0.02;
  windSrc.connect(windFilter).connect(windGain).connect(master);
  windSrc.start();

  /* ---- jets ------------------------------------------------------------ */
  const jetSrc = ctx.createBufferSource();
  jetSrc.buffer = noise;
  jetSrc.loop = true;
  const jetFilter = ctx.createBiquadFilter();
  jetFilter.type = "lowpass";
  jetFilter.frequency.value = 700;
  jetFilter.Q.value = 1.4;
  const jetGain = ctx.createGain();
  jetGain.gain.value = 0;
  jetSrc.connect(jetFilter).connect(jetGain).connect(master);
  jetSrc.start();

  const sub = ctx.createOscillator();
  sub.type = "sawtooth";
  sub.frequency.value = 58;
  const subGain = ctx.createGain();
  subGain.gain.value = 0;
  const subFilter = ctx.createBiquadFilter();
  subFilter.type = "lowpass";
  subFilter.frequency.value = 180;
  sub.connect(subFilter).connect(subGain).connect(master);
  sub.start();

  /* ---- pad ------------------------------------------------------------- */
  // D, A, E, F# — a sus2 with the third floating on top. Open, unresolved,
  // and it sits under the wind without ever asking to be listened to.
  const padGain = ctx.createGain();
  padGain.gain.value = 0.055;
  padGain.connect(master);
  const padOscs = [146.83, 220.0, 329.63, 369.99].map((f, i) => {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = f * (i === 3 ? 1.001 : 1);
    const g = ctx.createGain();
    g.gain.value = 0.25 / (i + 1);
    o.connect(g).connect(padGain);
    o.start();
    return o;
  });

  let muted = false;
  let disposed = false;

  const ramp = (p: AudioParam, v: number, t = 0.08) => {
    try {
      p.setTargetAtTime(v, ctx.currentTime, t);
    } catch {
      p.value = v;
    }
  };

  return {
    update(speed, burn, alt) {
      if (disposed) return;
      const s = Math.min(speed / 34, 1.4);
      ramp(windGain.gain, muted ? 0 : 0.015 + s * s * 0.16, 0.12);
      ramp(windFilter.frequency, 380 + s * 900, 0.15);
      ramp(jetGain.gain, muted ? 0 : burn * 0.16, 0.05);
      ramp(subGain.gain, muted ? 0 : burn * 0.10, 0.05);
      ramp(jetFilter.frequency, 500 + burn * 1300, 0.06);
      // Thinner air the higher you go: the pad opens up as the ground leaves.
      ramp(padGain.gain, muted ? 0 : 0.04 + Math.min(alt / 900, 1) * 0.05, 0.6);
    },
    setMuted(m) {
      muted = m;
      ramp(master.gain, m ? 0 : 1, 0.15);
    },
    resume() {
      if (ctx.state === "suspended") void ctx.resume();
      ramp(master.gain, muted ? 0 : 1, 0.4);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        windSrc.stop();
        jetSrc.stop();
        sub.stop();
        padOscs.forEach((o) => o.stop());
      } catch {
        /* already stopped */
      }
      void ctx.close();
    },
  };
}
