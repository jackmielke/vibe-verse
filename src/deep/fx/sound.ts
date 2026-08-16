/**
 * The Midnight Zone — the hydrophone.
 *
 * All synthesised, no assets. The deep sea has a real and famous sound — a
 * low, wide, pressure-heavy hum with almost nothing above 500 Hz, because the
 * water absorbs it — and that is exactly what a couple of filtered noise
 * sources and a detuned oscillator pair produce for free.
 *
 * Four voices:
 *   · **Drone** — two oscillators a few cents apart through a lowpass that
 *     closes as you descend. The closing filter is the descent, in sound.
 *   · **Flow** — filtered noise, driven by speed. This is the thing that makes
 *     the thrusters feel like they are pushing water.
 *   · **Groans** — the hull, below crush depth. Pitch-bent, brief, alarming.
 *   · **Chime** — the survey confirmation. The one bright sound in the world,
 *     which is why it lands.
 *
 * Browsers will not start an AudioContext without a gesture, so everything is
 * built suspended and `unlock()` resumes it — called from the UI's first click.
 */
import { depthOf, type DeepCtx, type SubService, type System } from "../types";

export interface SoundService {
  unlock(): void;
  setMuted(muted: boolean): void;
  muted: boolean;
  chime(good: boolean): void;
}

/** One second of white noise, reused by every noise voice. */
function noiseBuffer(actx: AudioContext): AudioBuffer {
  const buf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export default function createSound(ctx: DeepCtx): System {
  let actx: AudioContext | null = null;
  let master: GainNode | null = null;
  let droneGain: GainNode | null = null;
  let droneFilter: BiquadFilterNode | null = null;
  let flowGain: GainNode | null = null;
  let flowFilter: BiquadFilterNode | null = null;
  let muted = false;
  const nodes: Array<{ stop?: (t?: number) => void; disconnect: () => void }> = [];

  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("no AudioContext");
    actx = new Ctor();

    master = actx.createGain();
    master.gain.value = 0.5;
    master.connect(actx.destination);

    // -- drone --------------------------------------------------------------
    droneFilter = actx.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 420;
    droneFilter.Q.value = 0.7;
    droneGain = actx.createGain();
    droneGain.gain.value = 0.22;
    droneFilter.connect(droneGain).connect(master);

    for (const [freq, detune] of [[41, 0], [41, 9], [61.5, -7]] as const) {
      const osc = actx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = actx.createGain();
      g.gain.value = freq > 50 ? 0.28 : 1;
      osc.connect(g).connect(droneFilter);
      osc.start();
      nodes.push(osc, g);
    }

    // A slow LFO on the drone gain: the sea breathes.
    const lfo = actx.createOscillator();
    lfo.frequency.value = 0.055;
    const lfoGain = actx.createGain();
    lfoGain.gain.value = 0.07;
    lfo.connect(lfoGain).connect(droneGain.gain);
    lfo.start();
    nodes.push(lfo, lfoGain);

    // -- flow ---------------------------------------------------------------
    const noise = actx.createBufferSource();
    noise.buffer = noiseBuffer(actx);
    noise.loop = true;
    flowFilter = actx.createBiquadFilter();
    flowFilter.type = "bandpass";
    flowFilter.frequency.value = 340;
    flowFilter.Q.value = 0.55;
    flowGain = actx.createGain();
    flowGain.gain.value = 0;
    noise.connect(flowFilter).connect(flowGain).connect(master);
    noise.start();
    nodes.push(noise, flowFilter, flowGain);

    // Suspended until a gesture. Chrome will not have it otherwise.
    void actx.suspend();
  } catch (err) {
    console.error("[The Deep] audio unavailable; diving in silence:", err);
    actx = null;
  }

  function chime(good: boolean): void {
    if (!actx || !master || muted) return;
    const t = actx.currentTime;
    // A rising perfect fifth for a new species, a flat single tone for a
    // repeat — so you know which happened without reading anything.
    const notes = good ? [660, 990] : [440];
    notes.forEach((f, i) => {
      const osc = actx!.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      const g = actx!.createGain();
      const start = t + i * 0.11;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.16, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0008, start + 0.85);
      osc.connect(g).connect(master!);
      osc.start(start);
      osc.stop(start + 0.9);
    });
  }

  function groan(): void {
    if (!actx || !master || muted) return;
    const t = actx.currentTime;
    const osc = actx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(90 + Math.random() * 40, t);
    // The bend downward is the sound of something giving.
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.7);
    const f = actx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 260;
    const g = actx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.2, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.95);
    osc.connect(f).connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 1);
  }

  const service: SoundService = {
    muted: false,
    unlock() {
      if (actx && actx.state !== "running") void actx.resume();
    },
    setMuted(next) {
      muted = next;
      service.muted = next;
      if (master && actx) master.gain.setTargetAtTime(next ? 0 : 0.5, actx.currentTime, 0.1);
    },
    chime,
  };
  ctx.services.sound = service;

  const offNew = ctx.on("scan:new", (() => chime(true)) as (p: never) => void);
  const offAgain = ctx.on("scan:again", (() => chime(false)) as (p: never) => void);
  const offGroan = ctx.on("sub:groan", (() => groan()) as (p: never) => void);

  return {
    update() {
      if (!actx || actx.state !== "running") return;
      const sub = ctx.services.sub as SubService | undefined;
      const depth = sub?.depth ?? depthOf(ctx.camera.position.y);
      const now = actx.currentTime;

      // The filter closes as you go down. By the abyss there is nothing left
      // above 130 Hz, and the world sounds like the inside of a chest.
      if (droneFilter) {
        const target = 460 - Math.min(1, depth / 5000) * 330;
        droneFilter.frequency.setTargetAtTime(target, now, 0.6);
      }
      if (droneGain) {
        droneGain.gain.setTargetAtTime(0.2 + Math.min(1, depth / 6000) * 0.16, now, 0.8);
      }
      // Flow noise from speed — including the ballast sink, so even drifting
      // down doing nothing has a sound.
      if (flowGain && flowFilter) {
        const speed = sub ? Math.abs(sub.speed) + Math.abs(sub.velocity.y) : 0;
        flowGain.gain.setTargetAtTime(Math.min(0.14, speed * 0.011), now, 0.15);
        flowFilter.frequency.setTargetAtTime(280 + speed * 14, now, 0.2);
      }
    },

    dispose() {
      offNew();
      offAgain();
      offGroan();
      for (const n of nodes) {
        try {
          n.stop?.(0);
        } catch {
          /* already stopped */
        }
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
      // A world that leaves an AudioContext running leaves a hum behind it in
      // the *next* world the visitor opens.
      void actx?.close();
      actx = null;
      if (ctx.services.sound === service) delete ctx.services.sound;
    },
  };
}
