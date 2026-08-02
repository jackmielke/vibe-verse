/**
 * Vibe Kart — engines.
 *
 * The player's kart gets a real synthesised motor, not a looped sample with a
 * playbackRate on it:
 *
 *   · two detuned oscillators on a custom harmonic stack (the fundamental plus
 *     eight partials weighted like a small high-revving four-stroke),
 *   · a square an octave down for the half-order thump the firing order makes,
 *   · a sine sub two octaves down that you feel more than hear,
 *   · band-passed noise for induction roar, which is the layer that stops the
 *     whole thing sounding like a synth pad the moment it sweeps,
 *   · a resonant low-pass whose cutoff rides RPM *and* load — an engine on the
 *     overrun is dark, an engine pulling is bright, and that difference is 90%
 *     of why a real motor sounds alive,
 *   · a tanh waveshaper for grit at high load, and
 *   · a separate, brighter boost layer that fades in over the top.
 *
 * RPM is not speed. A six-speed box maps speed into a sawtooth of RPM that
 * resets at every upshift, and the shift itself ducks the throttle for 55 ms.
 * That single detail is the difference between "a siren" and "a gearbox".
 *
 * Every parameter is driven with `setTargetAtTime` at a 40–90 ms time constant.
 * Nothing here calls `setValueAtTime` on a live param per frame, because that
 * is what zipper noise *is*.
 *
 * Rivals get a cheaper version of the same idea — two oscillators and a filter
 * through a PannerNode — assigned to the nearest karts with a crossfade so the
 * reassignment never lands as a pitch jump. Three of them is enough for a pack
 * to sound like a pack.
 */
import { createPanner, setPannerPosition, type AudioGraph } from "./graph";
import { clamp, clamp01, engineWave } from "./synth";

/** Structural view of what an engine voice needs from a racer. */
export interface EngineRacer {
  id: number;
  speed: number;
  maxSpeed: number;
  rpm: number;
  boost: number;
  grounded: boolean;
  stun: number;
  position: { x: number; y: number; z: number };
}

/** Fundamental at idle and at the limiter, Hz. */
const F_IDLE = 46;
const F_MAX = 232;

/**
 * Gear boundaries as a fraction of top speed. First is short and frantic, the
 * upper gears stretch out — the same shape as any real ratio set, and it means
 * the shifts cluster where the player spends the least time.
 */
const GEARS = [0, 0.16, 0.33, 0.52, 0.72, 0.88, 1.35];

/** Harmonic weights for the main tone. Odd partials lead; the 3rd is the growl. */
const HARMONICS = [1, 0.62, 0.78, 0.4, 0.34, 0.2, 0.16, 0.09, 0.05];
const RIVAL_HARMONICS = [1, 0.5, 0.6, 0.28, 0.18, 0.1];

function saturationCurve(): Float32Array {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // Gentle up to ±0.5, hardening after: clean cruise, dirty full throttle.
    c[i] = Math.tanh(x * 1.9) * 0.86;
  }
  return c;
}

interface PlayerVoice {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  half: OscillatorNode;
  sub: OscillatorNode;
  induction: AudioBufferSourceNode;
  inductionBp: BiquadFilterNode;
  inductionGain: GainNode;
  mix: GainNode;
  filter: BiquadFilterNode;
  shaper: WaveShaperNode;
  out: GainNode;
  boostOsc: OscillatorNode;
  boostNoise: AudioBufferSourceNode;
  boostBp: BiquadFilterNode;
  boostGain: GainNode;
  nodes: AudioNode[];
}

interface RivalVoice {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode | StereoPannerNode | null;
  /** Racer currently sung by this voice, or -1 while idle. */
  target: number;
  /** Fade-out countdown while handing the voice to a different kart. */
  swapping: number;
  pending: number;
  nodes: AudioNode[];
}

export interface EngineRig {
  /** Drive the player's motor. `dt` is the frame delta in seconds. */
  player(racer: EngineRacer | null, dt: number): void;
  /** Drive the rival pack; pass every non-player racer, nearest-first is fine. */
  rivals(list: EngineRacer[], listener: { x: number; y: number; z: number }, dt: number): void;
  dispose(): void;
}

function rivalCount(g: AudioGraph): number {
  switch (g.quality) {
    case "low":
      return 0;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

export function createEngineRig(g: AudioGraph): EngineRig {
  const ac = g.ac;
  const t0 = ac.currentTime;
  const wave = engineWave(ac, HARMONICS);
  const rivalWave = engineWave(ac, RIVAL_HARMONICS);
  const curve = saturationCurve();
  const owned: AudioNode[] = [];

  // --- Player voice --------------------------------------------------------
  const mix = ac.createGain();
  mix.gain.value = 1;

  const oscA = ac.createOscillator();
  oscA.setPeriodicWave(wave);
  const oscB = ac.createOscillator();
  oscB.setPeriodicWave(wave);
  oscB.detune.value = 11; // a hair sharp: two cylinders never agree exactly
  const half = ac.createOscillator();
  half.type = "square";
  const sub = ac.createOscillator();
  sub.type = "sine";

  const gA = ac.createGain();
  gA.gain.value = 0.5;
  const gB = ac.createGain();
  gB.gain.value = 0.34;
  const gHalf = ac.createGain();
  gHalf.gain.value = 0.17;
  const gSub = ac.createGain();
  gSub.gain.value = 0.3;
  oscA.connect(gA).connect(mix);
  oscB.connect(gB).connect(mix);
  half.connect(gHalf).connect(mix);
  sub.connect(gSub).connect(mix);

  const induction = ac.createBufferSource();
  induction.buffer = g.noise;
  induction.loop = true;
  const inductionBp = ac.createBiquadFilter();
  inductionBp.type = "bandpass";
  inductionBp.Q.value = 0.9;
  inductionBp.frequency.value = 900;
  const inductionGain = ac.createGain();
  inductionGain.gain.value = 0.02;
  induction.connect(inductionBp).connect(inductionGain).connect(mix);

  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 500;
  filter.Q.value = 4.5;
  const shaper = ac.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = "2x";
  const out = ac.createGain();
  out.gain.value = 0.0001;
  mix.connect(filter).connect(shaper).connect(out);
  out.connect(g.engine);

  // The engine gets a whisper of the room so it sits in the same space as the
  // rest of the mix, but no more: a wet engine sounds like it is behind glass.
  const engineSend = ac.createGain();
  engineSend.gain.value = 0.06;
  out.connect(engineSend).connect(g.send);

  const boostOsc = ac.createOscillator();
  boostOsc.type = "sawtooth";
  const boostNoise = ac.createBufferSource();
  boostNoise.buffer = g.noise;
  boostNoise.loop = true;
  boostNoise.playbackRate.value = 1.3;
  const boostBp = ac.createBiquadFilter();
  boostBp.type = "bandpass";
  boostBp.Q.value = 1.1;
  boostBp.frequency.value = 2200;
  const boostGain = ac.createGain();
  boostGain.gain.value = 0.0001;
  const boostOscGain = ac.createGain();
  boostOscGain.gain.value = 0.35;
  boostOsc.connect(boostOscGain).connect(boostBp);
  boostNoise.connect(boostBp);
  boostBp.connect(boostGain).connect(g.engine);
  const boostSend = ac.createGain();
  boostSend.gain.value = 0.18;
  boostGain.connect(boostSend).connect(g.send);

  const voice: PlayerVoice = {
    oscA,
    oscB,
    half,
    sub,
    induction,
    inductionBp,
    inductionGain,
    mix,
    filter,
    shaper,
    out,
    boostOsc,
    boostNoise,
    boostBp,
    boostGain,
    nodes: [
      mix, gA, gB, gHalf, gSub, inductionBp, inductionGain, filter, shaper, out, engineSend,
      boostBp, boostGain, boostOscGain, boostSend,
    ],
  };
  owned.push(...voice.nodes);

  for (const src of [oscA, oscB, half, sub, boostOsc]) src.start(t0);
  induction.start(t0, g.rng() * 1.5);
  boostNoise.start(t0, g.rng() * 1.5);

  // --- Rival voices --------------------------------------------------------
  const rivals: RivalVoice[] = [];
  for (let i = 0; i < rivalCount(g); i++) {
    const a = ac.createOscillator();
    a.setPeriodicWave(rivalWave);
    const b = ac.createOscillator();
    b.type = "sawtooth";
    b.detune.value = -14;
    const ga = ac.createGain();
    ga.gain.value = 0.6;
    const gb = ac.createGain();
    gb.gain.value = 0.22;
    const f = ac.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 900;
    f.Q.value = 2.6;
    const amp = ac.createGain();
    amp.gain.value = 0.0001;
    a.connect(ga).connect(f);
    b.connect(gb).connect(f);
    f.connect(amp);

    let panner: PannerNode | StereoPannerNode | null = createPanner(g, 0, 0, 0);
    if (panner) {
      amp.connect(panner);
      panner.connect(g.engine);
    } else if (g.stereo) {
      const sp = ac.createStereoPanner();
      amp.connect(sp);
      sp.connect(g.engine);
      panner = sp;
    } else {
      amp.connect(g.engine);
    }
    const send = ac.createGain();
    send.gain.value = 0.1;
    amp.connect(send).connect(g.send);

    a.start(t0);
    b.start(t0);
    const nodes: AudioNode[] = [ga, gb, f, amp, send];
    if (panner) nodes.push(panner);
    owned.push(...nodes);
    rivals.push({ oscA: a, oscB: b, filter: f, gain: amp, panner, target: -1, swapping: 0, pending: -1, nodes });
  }

  // --- State ---------------------------------------------------------------
  let gear = 0;
  let shiftHold = 0;
  let lastSpeed = 0;
  let loadSmooth = 0.3;
  let rpmSmooth = 0.12;

  /** Speed fraction → gear index and the RPM fraction inside that gear. */
  function gearbox(u: number, dt: number): number {
    let next = gear;
    while (next < GEARS.length - 2 && u >= GEARS[next + 1]) next++;
    while (next > 0 && u < GEARS[next] - 0.03) next--; // hysteresis on the downshift
    if (next !== gear) {
      shiftHold = 0.055;
      gear = next;
    }
    shiftHold = Math.max(0, shiftHold - dt);
    const lo = GEARS[gear];
    const hi = GEARS[gear + 1];
    const span = Math.max(0.02, hi - lo);
    // Bottom of a gear is never idle — 0.3 of the rev range is where you land.
    return clamp01(0.3 + 0.7 * ((u - lo) / span));
  }

  function player(racer: EngineRacer | null, dt: number): void {
    const t = ac.currentTime;
    if (!racer) {
      voice.out.gain.setTargetAtTime(0.0001, t, 0.15);
      voice.boostGain.gain.setTargetAtTime(0.0001, t, 0.12);
      return;
    }

    const top = Math.max(6, racer.maxSpeed || 28);
    const speed = Math.abs(racer.speed || 0);
    const u = clamp01(speed / top);
    const step = Math.max(1e-3, dt);
    // Longitudinal acceleration is our stand-in for throttle: nobody hands the
    // audio system the pedal, but pulling away and coasting look very different
    // here and the ear only cares about the difference.
    const accel = (speed - lastSpeed) / step;
    lastSpeed = speed;

    const airborne = !racer.grounded;
    const stunned = (racer.stun ?? 0) > 0;
    const boosting = (racer.boost ?? 0) > 0;

    // Prefer the physics system's own RPM when it publishes one; it knows about
    // wheelspin and we do not. Fall back to the gearbox model.
    const geared = gearbox(u, dt);
    const supplied = clamp01(racer.rpm ?? 0);
    let rpm = supplied > 0.001 ? supplied * 0.45 + geared * 0.55 : geared;
    // Wheels off the ground: no load, so the motor chases the limiter.
    if (airborne) rpm = Math.min(1, rpm + 0.22);
    if (stunned) rpm *= 0.55;
    if (boosting) rpm = Math.min(1.06, rpm + 0.12);

    let load = clamp01(0.34 + accel * 0.11 + (boosting ? 0.5 : 0) - (airborne ? 0.3 : 0));
    if (stunned) load *= 0.3;
    // Smooth in the frame domain so a physics hiccup cannot flick the timbre.
    loadSmooth += (load - loadSmooth) * Math.min(1, step * 9);
    rpmSmooth += (rpm - rpmSmooth) * Math.min(1, step * 12);

    const f = F_IDLE + (F_MAX - F_IDLE) * Math.pow(rpmSmooth, 0.92);
    // Idle is never perfectly steady — a slow wobble reads as a lumpy motor.
    const lope = 1 + Math.sin(t * 5.7) * 0.012 * (1 - rpmSmooth);
    const tau = 0.05;
    voice.oscA.frequency.setTargetAtTime(f * lope, t, tau);
    voice.oscB.frequency.setTargetAtTime(f * lope * 1.004, t, tau);
    voice.half.frequency.setTargetAtTime(f * 0.5, t, tau);
    voice.sub.frequency.setTargetAtTime(f * 0.25, t, tau);

    // Cutoff: RPM opens it, load opens it further, the overrun closes it down.
    const cutoff = 320 + Math.pow(rpmSmooth, 1.35) * 4200 + loadSmooth * 1500;
    voice.filter.frequency.setTargetAtTime(clamp(cutoff, 180, 11000), t, 0.06);
    voice.filter.Q.setTargetAtTime(3.2 + loadSmooth * 3.4, t, 0.12);

    voice.inductionBp.frequency.setTargetAtTime(600 + rpmSmooth * 2600, t, 0.07);
    voice.inductionGain.gain.setTargetAtTime(0.012 + loadSmooth * 0.055 + rpmSmooth * 0.03, t, 0.08);

    // Level: mostly load, floored so the idle is always present, ducked hard
    // for the 55 ms of a shift so the ratio change actually lands as a punch.
    const shift = shiftHold > 0 ? 0.42 : 1;
    const level = (0.1 + 0.62 * loadSmooth + 0.3 * rpmSmooth) * shift * (stunned ? 0.45 : 1);
    voice.out.gain.setTargetAtTime(Math.max(0.0005, level), t, shiftHold > 0 ? 0.012 : 0.045);

    // Boost layer: an octave up, bright, and gone the moment the boost is.
    voice.boostOsc.frequency.setTargetAtTime(f * 2, t, 0.04);
    voice.boostBp.frequency.setTargetAtTime(1600 + rpmSmooth * 3200, t, 0.05);
    voice.boostGain.gain.setTargetAtTime(boosting ? 0.14 : 0.0001, t, boosting ? 0.05 : 0.12);
  }

  const RIVAL_FADE = 0.18;

  function rivals_(list: EngineRacer[], listener: { x: number; y: number; z: number }, dt: number): void {
    if (rivals.length === 0) return;
    const t = ac.currentTime;

    // Nearest first. The pack is eight karts; a full sort is nothing.
    const sorted = list
      .map((r) => ({
        r,
        d2:
          (r.position.x - listener.x) ** 2 +
          (r.position.y - listener.y) ** 2 +
          (r.position.z - listener.z) ** 2,
      }))
      .sort((a, b) => a.d2 - b.d2)
      .slice(0, rivals.length);

    const wanted = sorted.map((s) => s.r.id);
    const held = new Set(rivals.map((v) => (v.swapping > 0 ? v.pending : v.target)));

    // Hand a voice over only when its kart has genuinely dropped out of the
    // nearest set, and always through a fade — a hot swap is a pitch jump.
    for (const v of rivals) {
      const current = v.swapping > 0 ? v.pending : v.target;
      if (current >= 0 && wanted.includes(current)) continue;
      const claim = wanted.find((id) => !held.has(id));
      if (claim === undefined) continue;
      held.delete(current);
      held.add(claim);
      v.pending = claim;
      v.swapping = RIVAL_FADE;
    }

    for (const v of rivals) {
      if (v.swapping > 0) {
        v.swapping -= dt;
        if (v.swapping <= 0) {
          v.target = v.pending;
          v.swapping = 0;
        }
      }
      const entry = v.target >= 0 ? sorted.find((s) => s.r.id === v.target) : undefined;
      if (!entry) {
        v.gain.gain.setTargetAtTime(0.0001, t, 0.08);
        continue;
      }
      const r = entry.r;
      const top = Math.max(6, r.maxSpeed || 28);
      const u = clamp01(Math.abs(r.speed || 0) / top);
      // Rivals get a simpler rev curve — no gearbox, just a firm exponential —
      // because three of them shifting independently is mush, not detail.
      const rpm = clamp01(0.18 + 0.82 * Math.pow(u, 0.8) + (r.boost > 0 ? 0.12 : 0));
      const f = F_IDLE + (F_MAX - F_IDLE) * rpm;
      v.oscA.frequency.setTargetAtTime(f, t, 0.07);
      v.oscB.frequency.setTargetAtTime(f * 0.5, t, 0.07);
      v.filter.frequency.setTargetAtTime(400 + rpm * 3000, t, 0.08);

      if (v.panner && "positionX" in v.panner) {
        setPannerPosition(g, v.panner, r.position.x, r.position.y, r.position.z, 0.05);
      } else if (v.panner && "pan" in v.panner) {
        // Stereo-only fallback: place by the sign of the listener offset.
        const dx = r.position.x - listener.x;
        v.panner.pan.setTargetAtTime(clamp(dx / 20, -1, 1), t, 0.08);
      }

      // Fade to nothing while a swap is in flight, and roll off with distance
      // even when a PannerNode is already doing it — belt and braces, because
      // the stereo fallback has no distance model at all.
      const dist = Math.sqrt(entry.d2);
      const near = clamp01(1 - (dist - 8) / 120);
      const swapping = v.swapping > 0 ? clamp01(v.swapping / RIVAL_FADE) : 0;
      const level = 0.16 * (0.35 + 0.65 * rpm) * near * (1 - swapping) * (r.stun > 0 ? 0.4 : 1);
      v.gain.gain.setTargetAtTime(Math.max(0.0001, level), t, 0.06);
    }
  }

  return {
    player,
    rivals: rivals_,
    dispose() {
      const t = ac.currentTime;
      for (const src of [oscA, oscB, half, sub, boostOsc, induction, boostNoise]) {
        try {
          src.stop(t);
        } catch {
          /* already stopped */
        }
      }
      for (const v of rivals) {
        try {
          v.oscA.stop(t);
          v.oscB.stop(t);
        } catch {
          /* already stopped */
        }
      }
      for (const n of owned) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
      owned.length = 0;
      rivals.length = 0;
    },
  };
}
