/**
 * The Static Bloom, live: drums, bass, a distorted guitar, keys, a voice and
 * a crowd, all synthesised, so the Vibe Bowl costs nothing to download and
 * nothing at all until you walk toward it.
 *
 * Everything is scheduled against the city clock (`show.ts`), not against
 * when this tab happened to start its audio, so every listener hears the same
 * bar. The look-ahead scheduler maps each sixteenth's wall-clock time onto the
 * AudioContext's clock through one measured offset, re-measured only when the
 * two have drifted apart by more than a few milliseconds (re-measuring every
 * tick would jitter the hats by however long the tick ran late).
 *
 * The "voice" is a sawtooth through three vowel formants with a little
 * vibrato. It is not singing, and it is not trying to be: from the back of an
 * open-air bowl it reads as somebody up front with a mic, which is the job.
 */
import { chordFor, pentatonic, showAt, type ShowState } from "./show";

const STEP = 0.125; // a sixteenth at 120 BPM, seconds
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export interface ConcertMusic {
  /** 0..1 how loud, from how close you are. 0 stops scheduling soon after. */
  setLevel(v: number): void;
  setMuted(m: boolean): void;
  /** Somebody on stage takes the next `bars` bars: a lead line over the band and a roar. */
  solo(bars?: number): void;
  /** Whether a player's solo is sounding at `beats`. */
  soloing(beats: number): boolean;
  dispose(): void;
}

export function createConcertMusic(): ConcertMusic {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let music: GainNode | null = null;
  let verb: GainNode | null = null;
  let guitarIn: GainNode | null = null;
  let leadIn: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let level = 0;
  let muted = false;
  let timer = 0;
  let quietSince = 0;
  let offset = 0; // wall seconds minus ctx seconds
  let nextStep = -1;
  let soloFrom = -1;
  let soloTo = -1;

  const wallSec = () => Date.now() / 1000;

  const ensure = () => {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
    } catch {
      return null;
    }
    const c = ctx;
    master = c.createGain();
    master.gain.value = 0;
    master.connect(c.destination);
    music = c.createGain();
    music.gain.value = 0.8;
    music.connect(master);

    // An open-air bowl: a long, soft tail.
    const conv = c.createConvolver();
    const len = Math.floor(c.sampleRate * 2.2);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    conv.buffer = ir;
    verb = c.createGain();
    verb.gain.value = 0.35;
    verb.connect(conv).connect(music);

    // One fuzz box for the rhythm guitar and one for the lead.
    const fuzz = (drive: number, tone: number, out: number) => {
      const shaper = c.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        curve[i] = Math.tanh(x * drive);
      }
      shaper.curve = curve;
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = tone;
      const g = c.createGain();
      g.gain.value = out;
      const input = c.createGain();
      input.connect(shaper).connect(lp).connect(g);
      g.connect(music!);
      g.connect(verb!);
      return input;
    };
    guitarIn = fuzz(6, 3000, 0.16);
    leadIn = fuzz(9, 4200, 0.14);

    const nlen = c.sampleRate;
    noise = c.createBuffer(1, nlen, c.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;

    offset = wallSec() - c.currentTime;
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
    return c;
  };

  // ---- Voices ---------------------------------------------------------------
  const env = (g: GainNode, t: number, peak: number, attack: number, decay: number) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  };
  const kick = (t: number, peak = 0.9) => {
    const c = ctx!;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    env(g, t, peak, 0.003, 0.32);
    o.connect(g).connect(music!);
    o.start(t);
    o.stop(t + 0.4);
  };
  const hiss = (t: number, dur: number, peak: number, freq: number, type: BiquadFilterType, wet = false) => {
    const c = ctx!;
    const s = c.createBufferSource();
    s.buffer = noise;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = c.createGain();
    env(g, t, peak, 0.002, dur);
    s.connect(f).connect(g).connect(music!);
    if (wet) g.connect(verb!);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  };
  const snare = (t: number, peak = 0.4) => {
    hiss(t, 0.2, peak, 1900, "bandpass", true);
    const c = ctx!;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    env(g, t, peak * 0.5, 0.002, 0.09);
    o.connect(g).connect(music!);
    o.start(t);
    o.stop(t + 0.15);
  };
  const crash = (t: number) => hiss(t, 1.6, 0.16, 6500, "highpass", true);
  const tone = (t: number, midi: number, dur: number, peak: number, type: OscillatorType, cutoff: number, dest: AudioNode, detune = 0) => {
    const c = ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = hz(midi);
    o.detune.value = detune;
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(180, cutoff * 0.35), t + dur);
    const g = c.createGain();
    env(g, t, peak, 0.008, dur);
    o.connect(f).connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  };
  /** Root, fifth and octave: the only chord a fuzz box likes. */
  const power = (t: number, root: number, dur: number, peak: number) => {
    for (const [n, d] of [[0, -7], [7, 6], [12, 3]] as const) {
      const c = ctx!;
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = hz(root + n);
      o.detune.value = d;
      const g = c.createGain();
      env(g, t, peak, 0.004, dur);
      o.connect(g).connect(guitarIn!);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  };
  const voice = (t: number, midi: number, dur: number, peak: number) => {
    const c = ctx!;
    const o = c.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = hz(midi);
    const lfo = c.createOscillator();
    lfo.frequency.value = 5.4;
    const lg = c.createGain();
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(18, t + Math.min(0.3, dur * 0.6));
    lfo.connect(lg).connect(o.detune);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.04);
    g.gain.setValueAtTime(peak, t + Math.max(0.05, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
    // "ah": formants near 750, 1200 and 2600 Hz.
    for (const [f, q, a] of [[750, 6, 1], [1200, 7, 0.6], [2600, 9, 0.25]] as const) {
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f;
      bp.Q.value = q;
      const ga = c.createGain();
      ga.gain.value = a;
      o.connect(bp).connect(ga).connect(g);
    }
    g.connect(music!);
    g.connect(verb!);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.1);
    lfo.stop(t + dur + 0.1);
  };
  const lead = (t: number, midi: number, dur: number, peak: number) => {
    tone(t, midi, dur, peak, "sawtooth", 5000, leadIn!, 4);
    tone(t, midi + 12, dur, peak * 0.3, "square", 4000, leadIn!, -4);
  };
  /** A crowd: a lot of bandpassed noise, swelling. */
  const roar = (t: number, dur: number, peak: number) => {
    const c = ctx!;
    const s = c.createBufferSource();
    s.buffer = noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1100;
    f.Q.value = 0.6;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(music!);
    g.connect(verb!);
    s.start(t);
    s.stop(t + dur + 0.1);
  };
  const clap = (t: number, peak: number) => hiss(t, 0.05, peak, 1400 + Math.random() * 900, "bandpass");

  // ---- The arrangement -------------------------------------------------------
  /** A lead run that never repeats the same way twice in one solo. */
  const soloNote = (st: ShowState, k: number) => {
    const w = Math.sin(k * 1.7) * 2.2 + Math.sin(k * 0.43) * 2.6 + Math.sin(k * 0.13) * 1.4;
    return pentatonic(st.song, 5 + Math.round(w));
  };

  const play = (k: number, t: number) => {
    const st = showAt(k / 4);
    const pos = ((k % 16) + 16) % 16;
    const playerSolo = k >= soloFrom && k < soloTo;

    if (st.inBreak) {
      // Applause, thinning out, then a count-in on the last bar.
      if (st.barInSection === 0 && pos === 0) roar(t, 3.5, 0.32);
      if (st.barInSection < 3 && Math.random() < 0.55 - st.barInSection * 0.15) clap(t + Math.random() * 0.1, 0.05);
      if (st.barInSection === 3 && pos % 4 === 0) hiss(t, 0.03, 0.25, 5000, "highpass"); // sticks
      return;
    }

    const { song, section } = st;
    const ch = chordFor(song, st.barInSong);
    const feel = song.feel;
    const full = section === "chorus" || section === "solo" || section === "outro";
    const sparse = section === "intro" || section === "bridge";
    const lastBar = section === "outro" && st.barInSection === st.sectionBars - 1;

    if (lastBar) {
      if (pos === 0) {
        kick(t, 1);
        crash(t);
        power(t, ch.root - 12, 2.2, 0.5);
        tone(t, ch.root - 24, 2, 0.4, "sawtooth", 700, music!);
        roar(t + 0.3, 4, 0.4);
      }
      return;
    }

    // Drums.
    if (pos === 0 && st.barInSection === 0 && (section === "chorus" || section === "solo")) crash(t);
    if (feel === "halftime") {
      if (pos === 0 || (full && pos === 10)) kick(t);
      if (pos === 8 && !sparse) snare(t, 0.45);
      if (pos % 2 === 0) hiss(t, 0.03, sparse ? 0.04 : 0.07, 8000, "highpass");
    } else if (feel === "disco") {
      if (pos % 4 === 0) kick(t, sparse ? 0.6 : 0.9);
      if ((pos === 4 || pos === 12) && !sparse) snare(t);
      if (pos % 4 === 2) hiss(t, 0.12, 0.09, 7000, "highpass");
      else hiss(t, 0.025, 0.05, 9000, "highpass");
    } else if (feel === "punk") {
      if (pos % 4 === 0) kick(t);
      if ((pos === 4 || pos === 12) && !sparse) snare(t, 0.42);
      if (pos % 2 === 0) hiss(t, 0.03, 0.08, 8000, "highpass");
    } else {
      if (pos === 0 || pos === 8 || (full && pos === 10)) kick(t);
      if ((pos === 4 || pos === 12) && !sparse) snare(t);
      if (pos % 2 === 0) hiss(t, 0.03, full ? 0.09 : 0.06, 8000, "highpass");
    }
    // A fill into every chorus.
    if (st.barInSection === st.sectionBars - 1 && (section === "verse" || section === "bridge") && pos >= 12) snare(t, 0.2 + (pos - 12) * 0.08);

    // Bass.
    const bass = ch.root - 24;
    if (feel === "disco") {
      if (pos % 2 === 0) tone(t, bass + (pos % 4 === 2 ? 12 : 0), 0.11, 0.3, "sawtooth", 1100, music!);
    } else if (feel === "halftime") {
      if (pos === 0 || pos === 8) tone(t, bass, 0.9, 0.34, "triangle", 800, music!);
    } else if (!sparse || section === "bridge") {
      if (pos % 2 === 0) tone(t, bass, 0.2, 0.3, "sawtooth", 900, music!);
    }

    // Guitar.
    if (feel === "halftime") {
      // Clean arpeggio, no fuzz.
      if (pos % 2 === 0) {
        const third = ch.minor ? 3 : 4;
        const arp = [0, 7, 12, third + 12, 19, third + 12, 12, 7][(pos / 2) | 0];
        tone(t, ch.root + arp - 12, 0.5, 0.07, "triangle", 2600, music!);
      }
      if (full && pos === 0) power(t, ch.root - 12, 1.9, 0.35);
    } else if (feel === "disco") {
      if (pos % 4 === 2) power(t, ch.root, 0.07, 0.45);
    } else if (section === "verse") {
      if (pos % 2 === 0) power(t, ch.root - 12, 0.09, 0.5);
    } else if (full) {
      if (pos === 0 || pos === 8) power(t, ch.root - 12, 0.9, 0.5);
      else if (pos % 2 === 0) power(t, ch.root - 12, 0.12, 0.3);
    } else if (section === "intro") {
      if (pos === 0) power(t, ch.root - 12, 1.8, 0.4);
    }

    // Keys: a pad on choruses and the bridge, always on the ballad.
    if (pos === 0 && (full || section === "bridge" || feel === "halftime" || feel === "disco")) {
      const third = ch.minor ? 3 : 4;
      for (const n of [0, third, 7]) tone(t, ch.root + n, 1.9, 0.035, "triangle", 2000, verb!);
    }

    // The voice.
    if (section === "verse" || section === "chorus") {
      if (pos % 2 === 0) {
        const hook = section === "chorus" ? song.chorus : song.verse;
        const i = (st.barInSection % 2) * 8 + pos / 2;
        const d = hook[i];
        if (d >= 0) {
          let len = 1;
          while (len < 4 && hook[(i + len) % 16] === -1) len++;
          voice(t, pentatonic(song, d), len * STEP * 2 - 0.04, section === "chorus" ? 0.13 : 0.1);
        }
      }
    }

    // The band's own solo.
    if (section === "solo" && !playerSolo && st.barInSection < 7 && (pos % 2 === 0 || st.barInSection >= 4)) {
      lead(t, soloNote(st, k), STEP * 1.6, 0.4);
    }

    // Yours: faster, higher, and the crowd goes up for it.
    if (playerSolo) {
      lead(t, soloNote(st, k * 3 + 7) + 12, STEP * 1.3, 0.45);
      if (k === soloFrom) roar(t, 4, 0.35);
    }

    // The crowd: a cheer into every chorus.
    if (section === "chorus" && st.barInSection === 0 && pos === 0) roar(t, 2.6, 0.22);
  };

  const schedule = () => {
    if (!ctx || ctx.state !== "running") return;
    const measured = wallSec() - ctx.currentTime;
    if (Math.abs(measured - offset) > 0.04) offset = measured;
    const nowWall = ctx.currentTime + offset;
    const ahead = nowWall + 0.3;
    if (nextStep < 0 || nextStep * STEP < nowWall - 0.5) nextStep = Math.ceil(nowWall / STEP);
    for (;;) {
      const tw = nextStep * STEP;
      if (tw > ahead) break;
      const t = tw - offset;
      if (t >= ctx.currentTime - 0.01) play(nextStep, t);
      nextStep++;
    }
  };

  const apply = () => {
    if (!ctx || !master) return;
    master.gain.setTargetAtTime(muted ? 0 : level * 0.65, ctx.currentTime, 0.5);
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
          nextStep = -1;
          timer = window.setInterval(schedule, 80);
        }
      } else if (timer) {
        if (!quietSince) quietSince = performance.now();
        else if (performance.now() - quietSince > 3000) {
          window.clearInterval(timer);
          timer = 0;
        }
      }
    },
    setMuted(m) {
      muted = m;
      apply();
    },
    solo(bars = 4) {
      // Start on the next bar line so it lands with the band.
      const k = Math.ceil((wallSec() + 0.05) / STEP);
      const start = Math.ceil(k / 16) * 16;
      soloFrom = start;
      soloTo = start + bars * 16;
    },
    soloing(beats) {
      const k = beats * 4;
      return k >= soloFrom && k < soloTo;
    },
    dispose() {
      if (timer) window.clearInterval(timer);
      timer = 0;
      void ctx?.close();
      ctx = null;
    },
  };
}
