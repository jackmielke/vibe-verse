/**
 * Sound, synthesised.
 *
 * Nothing here loads a file. Two F414s, the air going past the canopy, the
 * stall warner, the radio and half a dozen one-shots are all oscillators,
 * noise and filters, which is why this world starts making noise the instant a
 * finger touches the screen instead of after a two-megabyte download.
 *
 * The engine is four voices because a jet is four sounds and people can tell:
 *
 *  - a **low rumble** at the shaft frequency, which is what you feel;
 *  - a **compressor whine** an octave and a half up, which is what makes it a
 *    turbine rather than a lawnmower;
 *  - **broadband roar** from the exhaust, which is most of the level;
 *  - a **burner rip** that only exists above the detent — heavily saturated
 *    low noise, and it is the sound the crowd came for.
 *
 * Three rules, in the order they matter:
 *
 * · **It never throws.** No context, a suspended context, a cue invented after
 *   this file was written — all silent no-ops. A quiet world is a bug; a
 *   crashed one is a disaster.
 * · **The context is built on a gesture, not at boot**, because every browser
 *   requires it and because building it at boot costs a frame at the worst
 *   possible moment.
 * · **Continuous sound is steered, not retriggered.** The engine note is one
 *   graph whose parameters are pushed every frame with `setTargetAtTime`.
 */
import * as THREE from "three";
import type { AngelsCtx, AudioService, System } from "../types";
import type { FleetService } from "../play/fleet";

type Ctor = new () => AudioContext;

function audioCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  if (typeof AudioContext !== "undefined") return AudioContext;
  const legacy = (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
  return legacy ?? null;
}

function isShot(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return new URLSearchParams(window.location.search).has("shot");
  } catch {
    return false;
  }
}

/** A second of white noise, looped. Cheaper and calmer than a ScriptProcessor. */
function noiseBuffer(ac: AudioContext): AudioBuffer {
  const len = ac.sampleRate * 2;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  // Brown-ish noise: integrated white, which has the low-frequency weight a
  // jet exhaust actually has. Pure white sounds like a hiss, not a jet.
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.2 + w * 0.3;
  }
  return buf;
}

interface Rig {
  ac: AudioContext;
  master: GainNode;
  sfx: GainNode;
  engineBus: GainNode;
  noise: AudioBuffer;

  rumble: OscillatorNode;
  rumbleGain: GainNode;
  whine: OscillatorNode;
  whineGain: GainNode;
  roar: AudioBufferSourceNode;
  roarFilter: BiquadFilterNode;
  roarGain: GainNode;
  burner: AudioBufferSourceNode;
  burnerFilter: BiquadFilterNode;
  burnerGain: GainNode;
  wind: AudioBufferSourceNode;
  windFilter: BiquadFilterNode;
  windGain: GainNode;
  /** Everything the aircraft makes, attenuated by how far away it is. */
  distance: BiquadFilterNode;
  distanceGain: GainNode;
}

function buildRig(): Rig | null {
  const Ctor2 = audioCtor();
  if (!Ctor2) return null;
  let ac: AudioContext;
  try {
    ac = new Ctor2();
  } catch {
    return null;
  }

  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 12;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.18;
  limiter.connect(ac.destination);

  const master = ac.createGain();
  master.gain.value = 0.85;
  master.connect(limiter);

  const sfx = ac.createGain();
  sfx.gain.value = 0.9;
  sfx.connect(master);

  // Everything the jet makes goes through one distance stage: a gain and a
  // lowpass. Air eats high frequencies first, which is why a jet two miles
  // away is a rumble and the same jet overhead is a scream.
  const distanceGain = ac.createGain();
  distanceGain.gain.value = 1;
  const distance = ac.createBiquadFilter();
  distance.type = "lowpass";
  distance.frequency.value = 18000;
  distanceGain.connect(distance);
  distance.connect(master);

  const engineBus = ac.createGain();
  engineBus.gain.value = 0.7;
  engineBus.connect(distanceGain);

  const noise = noiseBuffer(ac);

  const rumble = ac.createOscillator();
  rumble.type = "sawtooth";
  rumble.frequency.value = 48;
  const rumbleGain = ac.createGain();
  rumbleGain.gain.value = 0;
  const rumbleFilter = ac.createBiquadFilter();
  rumbleFilter.type = "lowpass";
  rumbleFilter.frequency.value = 220;
  rumble.connect(rumbleFilter);
  rumbleFilter.connect(rumbleGain);
  rumbleGain.connect(engineBus);
  rumble.start();

  const whine = ac.createOscillator();
  whine.type = "sawtooth";
  whine.frequency.value = 620;
  const whineFilter = ac.createBiquadFilter();
  whineFilter.type = "bandpass";
  whineFilter.frequency.value = 1800;
  whineFilter.Q.value = 3.4;
  const whineGain = ac.createGain();
  whineGain.gain.value = 0;
  whine.connect(whineFilter);
  whineFilter.connect(whineGain);
  whineGain.connect(engineBus);
  whine.start();

  const roar = ac.createBufferSource();
  roar.buffer = noise;
  roar.loop = true;
  const roarFilter = ac.createBiquadFilter();
  roarFilter.type = "bandpass";
  roarFilter.frequency.value = 400;
  roarFilter.Q.value = 0.7;
  const roarGain = ac.createGain();
  roarGain.gain.value = 0;
  roar.connect(roarFilter);
  roarFilter.connect(roarGain);
  roarGain.connect(engineBus);
  roar.start();

  const burner = ac.createBufferSource();
  burner.buffer = noise;
  burner.loop = true;
  const burnerFilter = ac.createBiquadFilter();
  burnerFilter.type = "lowpass";
  burnerFilter.frequency.value = 300;
  burnerFilter.Q.value = 1.2;
  const burnerGain = ac.createGain();
  burnerGain.gain.value = 0;
  burner.connect(burnerFilter);
  burnerFilter.connect(burnerGain);
  burnerGain.connect(engineBus);
  burner.start();

  // Wind is not routed through the distance stage: it is in the cockpit with
  // you no matter where the camera is.
  const wind = ac.createBufferSource();
  wind.buffer = noise;
  wind.loop = true;
  const windFilter = ac.createBiquadFilter();
  windFilter.type = "bandpass";
  windFilter.frequency.value = 900;
  windFilter.Q.value = 0.5;
  const windGain = ac.createGain();
  windGain.gain.value = 0;
  wind.connect(windFilter);
  windFilter.connect(windGain);
  windGain.connect(master);
  wind.start();

  return {
    ac,
    master,
    sfx,
    engineBus,
    noise,
    rumble,
    rumbleGain,
    whine,
    whineGain,
    roar,
    roarFilter,
    roarGain,
    burner,
    burnerFilter,
    burnerGain,
    wind,
    windFilter,
    windGain,
    distance,
    distanceGain,
  };
}

export function createAudio(ctx: AngelsCtx): System {
  const fleet = ctx.services.fleet as FleetService | undefined;
  let rig: Rig | null = null;
  let dead = isShot();
  let muted = false;
  let hidden = typeof document !== "undefined" && document.visibilityState === "hidden";

  function ensure(): Rig | null {
    if (rig || dead) return rig;
    rig = buildRig();
    if (!rig) dead = true;
    return rig;
  }

  function resume(): void {
    const r = ensure();
    if (!r) return;
    if (r.ac.state === "suspended") void r.ac.resume().catch(() => {});
  }

  function mix(): void {
    const r = rig;
    if (!r) return;
    r.master.gain.setTargetAtTime(muted || hidden ? 0 : 0.85, r.ac.currentTime, 0.05);
  }

  const gestureEvents = ["pointerdown", "keydown", "touchstart"] as const;
  const onGesture = () => resume();
  if (!dead && typeof window !== "undefined") {
    for (const e of gestureEvents) window.addEventListener(e, onGesture, { passive: true });
  }
  const onVisibility = () => {
    hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    mix();
  };
  if (!dead && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  /** One-shots. Each is a tiny synth, built and thrown away. */
  function cue(name: string, opts: { gain?: number; rate?: number } = {}): void {
    const r = ensure();
    if (!r || muted || hidden) return;
    const t = r.ac.currentTime;
    const g = opts.gain ?? 1;
    const rate = opts.rate ?? 1;

    const env = r.ac.createGain();
    env.connect(r.sfx);

    switch (name) {
      case "hoop": {
        // Two stacked sines, a fifth apart, with a fast decay. Reads as a
        // "yes" without ever being annoying at nine per course.
        for (const [f, a] of [[880, 0.5], [1320, 0.32]] as const) {
          const o = r.ac.createOscillator();
          o.type = "sine";
          o.frequency.value = f * rate;
          const og = r.ac.createGain();
          og.gain.setValueAtTime(0, t);
          og.gain.linearRampToValueAtTime(a * g * 0.35, t + 0.006);
          og.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
          o.connect(og);
          og.connect(env);
          o.start(t);
          o.stop(t + 0.6);
        }
        env.gain.value = 1;
        break;
      }
      case "achievement": {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => {
          const o = r.ac.createOscillator();
          o.type = "triangle";
          o.frequency.value = f;
          const og = r.ac.createGain();
          const at = t + i * 0.085;
          og.gain.setValueAtTime(0, at);
          og.gain.linearRampToValueAtTime(0.22 * g, at + 0.01);
          og.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
          o.connect(og);
          og.connect(env);
          o.start(at);
          o.stop(at + 0.55);
        });
        env.gain.value = 1;
        break;
      }
      case "radio": {
        // The click and squelch either side of a transmission. Two clicks and
        // a hiss, and the brain fills in a radio.
        const src = r.ac.createBufferSource();
        src.buffer = r.noise;
        const bp = r.ac.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 2200;
        bp.Q.value = 2;
        env.gain.setValueAtTime(0.10 * g, t);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        src.connect(bp);
        bp.connect(env);
        src.start(t);
        src.stop(t + 0.1);
        break;
      }
      case "gear": {
        const src = r.ac.createBufferSource();
        src.buffer = r.noise;
        const lp = r.ac.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(700, t);
        lp.frequency.exponentialRampToValueAtTime(140, t + 0.8);
        env.gain.setValueAtTime(0.3 * g, t);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
        src.connect(lp);
        lp.connect(env);
        src.start(t);
        src.stop(t + 1.2);
        break;
      }
      case "impact": {
        const src = r.ac.createBufferSource();
        src.buffer = r.noise;
        const lp = r.ac.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(1400, t);
        lp.frequency.exponentialRampToValueAtTime(90, t + 1.4);
        env.gain.setValueAtTime(0.75 * g, t);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
        src.connect(lp);
        lp.connect(env);
        src.start(t);
        src.stop(t + 2);
        break;
      }
      case "boom": {
        // A sonic boom is a pressure step, not a bang: a very fast attack and
        // a long low tail.
        const src = r.ac.createBufferSource();
        src.buffer = r.noise;
        const lp = r.ac.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(400, t);
        lp.frequency.exponentialRampToValueAtTime(45, t + 2.2);
        env.gain.setValueAtTime(0.9 * g, t);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
        src.connect(lp);
        lp.connect(env);
        src.start(t);
        src.stop(t + 2.5);
        break;
      }
      case "warn": {
        const o = r.ac.createOscillator();
        o.type = "square";
        o.frequency.value = 720;
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(0.10 * g, t + 0.01);
        env.gain.setValueAtTime(0.10 * g, t + 0.11);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(env);
        o.start(t);
        o.stop(t + 0.2);
        break;
      }
      default:
        return;
    }
  }

  const service: AudioService = {
    unlock: resume,
    cue,
    setMuted(v) {
      muted = v;
      mix();
      try {
        localStorage?.setItem("angels.muted", v ? "1" : "0");
      } catch {
        /* ignore */
      }
    },
    get muted() {
      return muted;
    },
  };
  try {
    muted = localStorage?.getItem("angels.muted") === "1";
  } catch {
    /* ignore */
  }
  ctx.services.audio = service;

  const unsubs = [
    ctx.on("angels:hoop", () => cue("hoop")),
    ctx.on("angels:achievement", () => cue("achievement")),
    ctx.on("angels:radio", () => cue("radio")),
    ctx.on("angels:gear", () => cue("gear")),
    ctx.on("angels:impact", (v: number) => cue("impact", { gain: Math.min(1, v) })),
  ];

  let wasSupersonic = false;
  let stallBeep = 0;
  const _camPos = new THREE.Vector3();

  return {
    update(dt, c) {
      const r = rig;
      if (!r || !fleet || r.ac.state !== "running") return;
      const s = fleet.player.state;
      const t = r.ac.currentTime;
      const tau = 0.06;

      // ---- engine ----------------------------------------------------------
      const power = THREE.MathUtils.clamp(s.power, 0, 2);
      const dry = Math.min(power, 1);
      const ab = Math.max(0, power - 1);
      // Shaft speed does not track the throttle exactly — it lags, and it
      // rises a little with airspeed as the intake rams.
      const n1 = 0.28 + dry * 0.72 + Math.min(0.2, s.mach * 0.16);

      r.rumble.frequency.setTargetAtTime(34 + n1 * 66, t, tau);
      r.rumbleGain.gain.setTargetAtTime(0.30 + dry * 0.34 + ab * 0.2, t, tau);

      r.whine.frequency.setTargetAtTime(340 + n1 * 900, t, tau);
      r.whineGain.gain.setTargetAtTime(0.028 + dry * 0.075, t, tau);

      r.roarFilter.frequency.setTargetAtTime(260 + n1 * 620, t, tau);
      r.roarGain.gain.setTargetAtTime(0.10 + dry * 0.36, t, tau);

      r.burnerFilter.frequency.setTargetAtTime(150 + ab * 420, t, tau);
      r.burnerGain.gain.setTargetAtTime(ab * 0.95, t, 0.12);

      // ---- distance ---------------------------------------------------------
      _camPos.copy(c.camera.position);
      const range = _camPos.distanceTo(s.position);
      // Inverse-ish falloff with a floor, so the tower camera at 2 km still
      // hears something and the cockpit is not deafening.
      const near = THREE.MathUtils.clamp(220 / (range + 90), 0.06, 1.1);
      r.distanceGain.gain.setTargetAtTime(near, t, 0.1);
      r.distance.frequency.setTargetAtTime(
        THREE.MathUtils.clamp(19000 / (1 + range * 0.012), 260, 19000),
        t,
        0.1,
      );

      // ---- airflow ----------------------------------------------------------
      // Wind noise goes with dynamic pressure, not speed: at altitude the same
      // true airspeed is a much quieter aeroplane.
      const q = 0.5 * 1.225 * Math.exp(-s.altitude / 8400) * s.airspeed * s.airspeed;
      r.windGain.gain.setTargetAtTime(THREE.MathUtils.clamp(q / 42000, 0, 0.5), t, 0.14);
      r.windFilter.frequency.setTargetAtTime(500 + Math.min(2600, s.airspeed * 8), t, 0.14);

      // ---- events ------------------------------------------------------------
      const supersonic = s.mach > 1.0;
      if (supersonic && !wasSupersonic) cue("boom", { gain: 0.8 });
      wasSupersonic = supersonic;

      if (s.stalled || s.liftDemand > 0.94) {
        stallBeep -= dt;
        if (stallBeep <= 0) {
          cue("warn", { gain: 0.8 });
          stallBeep = 0.42;
        }
      } else {
        stallBeep = 0;
      }
    },

    dispose() {
      for (const u of unsubs) u();
      if (typeof window !== "undefined") {
        for (const e of gestureEvents) window.removeEventListener(e, onGesture);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      const r = rig;
      rig = null;
      if (r) {
        try {
          r.rumble.stop();
          r.whine.stop();
          r.roar.stop();
          r.burner.stop();
          r.wind.stop();
        } catch {
          /* already stopped */
        }
        try {
          void r.ac.close();
        } catch {
          /* closing a closed context throws on some builds */
        }
      }
      if (ctx.services.audio === service) delete ctx.services.audio;
    },
  };
}
