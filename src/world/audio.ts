/**
 * Synthwave loop, fully procedural. Renders an 8-second buffer offline,
 * then loops it through a master gain. No assets, no network calls.
 */

export interface AudioController {
  start: () => void;
  setMuted: (m: boolean) => void;
  isMuted: () => boolean;
  dispose: () => void;
}

const BPM = 92;
const BEATS = 16; // 4 bars
const NOTE_DURATION = 60 / BPM;

// A minor: i (Am) - VI (F) - III (C) - VII (G)
const ROOTS = [220, 174.61, 261.63, 196];
const CHORD_INTERVALS = [
  [0, 3, 7], // minor
  [0, 4, 7], // major
  [0, 4, 7], // major
  [0, 4, 7], // major
];

// Lead arpeggio pattern over 4 beats per chord
const ARP_STEPS = [0, 2, 1, 2];

function fadeEnv(p: AudioParam, t0: number, attack: number, hold: number, release: number, peak: number) {
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(peak, t0 + attack);
  p.setValueAtTime(peak, t0 + attack + hold);
  p.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
}

async function renderLoop(ctx: BaseAudioContext) {
  const len = NOTE_DURATION * BEATS;

  // Master comp
  const master = ctx.createGain();
  master.gain.value = 0.7;
  master.connect(ctx.destination);

  // Light reverb fake: a delay with feedback
  const delay = ctx.createDelay(0.6);
  delay.delayTime.value = 0.27;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const wet = ctx.createGain();
  wet.gain.value = 0.25;
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(master);

  for (let bar = 0; bar < 4; bar++) {
    const root = ROOTS[bar];
    const intervals = CHORD_INTERVALS[bar];
    const barStart = bar * 4 * NOTE_DURATION;

    // ----- Bass (saw, low-passed) -----
    {
      const t0 = barStart;
      const dur = 4 * NOTE_DURATION - 0.05;
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = root / 2;
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = 600;
      filt.Q.value = 4;
      const g = ctx.createGain();
      fadeEnv(g.gain, t0, 0.02, dur - 0.2, 0.18, 0.45);
      osc.connect(filt).connect(g).connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.2);
    }

    // ----- Pad (triangles, soft) -----
    {
      const t0 = barStart + 0.02;
      const dur = 4 * NOTE_DURATION - 0.1;
      intervals.forEach((semi) => {
        const f = root * Math.pow(2, semi / 12);
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = f;
        const g = ctx.createGain();
        fadeEnv(g.gain, t0, 0.4, dur - 0.7, 0.4, 0.07);
        osc.connect(g).connect(master);
        osc.connect(delay);
        osc.start(t0);
        osc.stop(t0 + dur + 0.4);
      });
    }

    // ----- Lead arp (square with filter) -----
    for (let beat = 0; beat < 4; beat++) {
      const stepIdx = ARP_STEPS[beat];
      const semi = intervals[stepIdx];
      const f = root * 2 * Math.pow(2, semi / 12);
      const t0 = barStart + beat * NOTE_DURATION + 0.02;
      const dur = NOTE_DURATION * 0.72;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = f;
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = 1800;
      const g = ctx.createGain();
      fadeEnv(g.gain, t0, 0.01, 0.04, dur - 0.05, 0.10);
      osc.connect(filt).connect(g).connect(master);
      g.connect(delay);
      osc.start(t0);
      osc.stop(t0 + dur + 0.1);
    }

    // ----- Drums -----
    for (let beat = 0; beat < 4; beat++) {
      const t0 = barStart + beat * NOTE_DURATION;
      // Kick on every beat
      const kick = ctx.createOscillator();
      kick.type = "sine";
      kick.frequency.setValueAtTime(120, t0);
      kick.frequency.exponentialRampToValueAtTime(40, t0 + 0.12);
      const kg = ctx.createGain();
      fadeEnv(kg.gain, t0, 0.001, 0.02, 0.18, 0.55);
      kick.connect(kg).connect(master);
      kick.start(t0);
      kick.stop(t0 + 0.3);

      // Snare on 2 and 4 (noise + tone)
      if (beat % 2 === 1) {
        const noise = ctx.createBufferSource();
        const buf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        noise.buffer = buf;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 1500;
        const ng = ctx.createGain();
        fadeEnv(ng.gain, t0, 0.001, 0.01, 0.14, 0.18);
        noise.connect(hp).connect(ng).connect(master);
        noise.start(t0);
        noise.stop(t0 + 0.2);
      }

      // Hi-hat on offbeats
      const offT = t0 + NOTE_DURATION / 2;
      const hat = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.07, ctx.sampleRate);
      const d2 = buf.getChannelData(0);
      for (let i = 0; i < d2.length; i++) d2[i] = Math.random() * 2 - 1;
      hat.buffer = buf;
      const hp2 = ctx.createBiquadFilter();
      hp2.type = "highpass";
      hp2.frequency.value = 7000;
      const hg = ctx.createGain();
      fadeEnv(hg.gain, offT, 0.001, 0.005, 0.05, 0.07);
      hat.connect(hp2).connect(hg).connect(master);
      hat.start(offT);
      hat.stop(offT + 0.08);
    }
  }

  return len;
}

export function createAudio(): AudioController {
  let started = false;
  let muted = false;
  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let masterGain: GainNode | null = null;

  const start = async () => {
    if (started) return;
    started = true;
    try {
      ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const len = NOTE_DURATION * BEATS;
      const offline = new OfflineAudioContext(2, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
      await renderLoop(offline);
      const buffer = await offline.startRendering();
      masterGain = ctx.createGain();
      masterGain.gain.value = muted ? 0 : 0.7;
      masterGain.connect(ctx.destination);
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(masterGain);
      source.start();
    } catch {
      started = false;
    }
  };

  return {
    start,
    setMuted: (m: boolean) => {
      muted = m;
      if (masterGain && ctx) {
        masterGain.gain.setTargetAtTime(m ? 0 : 0.7, ctx.currentTime, 0.05);
      }
    },
    isMuted: () => muted,
    dispose: () => {
      try {
        source?.stop();
      } catch {
        /* noop */
      }
      source?.disconnect();
      masterGain?.disconnect();
      ctx?.close();
    },
  };
}
