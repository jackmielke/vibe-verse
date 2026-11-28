/**
 * The Vibe Arcade's sound: a DJ's synthwave loop, coin clinks and the little
 * attract jingles a cabinet plays when you walk past it. All synthesised, no
 * files to download, so the arcade costs nothing until you walk in.
 *
 * The beat is also the arcade's clock: `beat()` is where the loop is, in
 * beats, and the lights pulse on it, so the room and the music agree. When
 * the audio is not running (muted, not started, outside) the clock carries on
 * from the wall clock at the same tempo, so the lights never stop.
 */
export const BPM = 112;
const SPB = 60 / BPM;

// Am, F, C, G: two bars each, sixteenths.
const ROOTS = [57, 53, 48, 55];
const CHORDS: number[][] = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const ARP = [0, 12, 7, 12, 3, 12, 7, 15];
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export interface ArcadeMusic {
  /** 0..1 how loud the room should be, eased. 0 stops scheduling soon after. */
  setLevel(v: number): void;
  setMuted(m: boolean): void;
  /** Beats since the loop began (fractional). */
  beat(): number;
  coin(): void;
  /** A short chiptune sting for a cabinet you walked up to. */
  attract(seed: number): void;
  dispose(): void;
}

export function createArcadeMusic(): ArcadeMusic {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let music: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let level = 0;
  let muted = false;
  let startAt = 0;
  let nextStep = 0; // sixteenth index
  let timer = 0;
  let quietSince = 0;
  const wallStart = performance.now();

  const ensure = () => {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    music = ctx.createGain();
    music.gain.value = 0.9;
    music.connect(master);
    const len = ctx.sampleRate * 0.5;
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    startAt = ctx.currentTime + 0.1;
    nextStep = 0;
    // Browsers start an AudioContext suspended until a gesture; the first
    // tap or key anywhere wakes it.
    const wake = () => {
      void ctx?.resume();
      if (ctx?.state === "running") {
        window.removeEventListener("pointerdown", wake);
        window.removeEventListener("keydown", wake);
      }
    };
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    wake();
    return ctx;
  };

  const env = (g: GainNode, t: number, peak: number, attack: number, decay: number) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  };

  const kick = (t: number) => {
    const c = ctx!;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    env(g, t, 0.9, 0.003, 0.3);
    o.connect(g).connect(music!);
    o.start(t);
    o.stop(t + 0.35);
  };
  const hiss = (t: number, dur: number, peak: number, freq: number, type: BiquadFilterType) => {
    const c = ctx!;
    const s = c.createBufferSource();
    s.buffer = noise;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = c.createGain();
    env(g, t, peak, 0.002, dur);
    s.connect(f).connect(g).connect(music!);
    s.start(t);
    s.stop(t + dur + 0.05);
  };
  const tone = (t: number, midi: number, dur: number, peak: number, type: OscillatorType, cutoff: number, dest?: AudioNode) => {
    const c = ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = hz(midi);
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.3), t + dur);
    const g = c.createGain();
    env(g, t, peak, 0.01, dur);
    o.connect(f).connect(g).connect(dest ?? music!);
    o.start(t);
    o.stop(t + dur + 0.05);
  };

  const schedule = () => {
    if (!ctx || ctx.state !== "running") return;
    const ahead = ctx.currentTime + 0.25;
    for (;;) {
      const t = startAt + nextStep * (SPB / 4);
      if (t > ahead) break;
      if (t >= ctx.currentTime - 0.02) {
        const s = nextStep % 16; // within a bar
        const bar = Math.floor(nextStep / 16);
        const chord = Math.floor(bar / 2) % 4;
        if (s % 4 === 0) kick(t);
        if (s === 4 || s === 12) hiss(t, 0.18, 0.35, 1800, "bandpass");
        if (s % 2 === 0) hiss(t, 0.04, 0.12, 8000, "highpass");
        // Bass on the off-eighths, pumping against the kick.
        if (s % 2 === 1) tone(t, ROOTS[chord] - 24, SPB / 2.2, 0.32, "sawtooth", 900);
        // The arpeggio that makes it synthwave.
        tone(t, ROOTS[chord] + ARP[s % 8], SPB / 4, 0.07, "square", 2600);
        // A pad at the top of each bar.
        if (s === 0) for (const n of CHORDS[chord]) tone(t, n, SPB * 3.6, 0.05, "triangle", 1800);
      }
      nextStep++;
    }
  };

  const apply = () => {
    if (!ctx || !master) return;
    const v = muted ? 0 : level * 0.5;
    master.gain.setTargetAtTime(v, ctx.currentTime, 0.4);
  };

  return {
    setLevel(v) {
      const next = Math.max(0, Math.min(1, v));
      if (next > 0.001 && !ctx) ensure();
      level = next;
      apply();
      if (level > 0.001) {
        quietSince = 0;
        if (!timer && ctx) {
          // Pick up the loop on the next bar rather than mid-phrase.
          const elapsed = (ctx.currentTime - startAt) / (SPB / 4);
          nextStep = Math.max(nextStep, Math.ceil(elapsed / 16) * 16);
          timer = window.setInterval(schedule, 90);
        }
      } else if (timer) {
        if (!quietSince) quietSince = performance.now();
        else if (performance.now() - quietSince > 2500) {
          window.clearInterval(timer);
          timer = 0;
        }
      }
    },
    setMuted(m) {
      muted = m;
      apply();
    },
    beat() {
      if (ctx && ctx.state === "running" && timer) return Math.max(0, (ctx.currentTime - startAt) / SPB);
      return ((performance.now() - wallStart) / 1000) / SPB;
    },
    coin() {
      const c = ensure();
      if (!c || muted || !master) return;
      const t = c.currentTime + 0.01;
      const g = c.createGain();
      g.gain.value = 0.6;
      g.connect(c.destination);
      tone(t, 88, 0.12, 0.25, "square", 9000, g);
      tone(t + 0.07, 93, 0.35, 0.25, "square", 9000, g);
    },
    attract(seed) {
      const c = ctx;
      if (!c || muted || c.state !== "running" || level < 0.01) return;
      const t = c.currentTime + 0.02;
      const g = c.createGain();
      g.gain.value = 0.35;
      g.connect(c.destination);
      const base = 72 + (Math.abs(Math.round(seed)) % 5);
      [0, 4, 7, 12, 7, 16].forEach((n, i) => tone(t + i * 0.07, base + n, 0.09, 0.18, "square", 6000, g));
    },
    dispose() {
      if (timer) window.clearInterval(timer);
      timer = 0;
      void ctx?.close();
      ctx = null;
    },
  };
}
