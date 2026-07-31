/**
 * Vibe Kart — the score.
 *
 * A real tune, sequenced live: chords, a walking-ish bass, a sixteenth-note
 * arpeggio, a written melody and a synthesised drum kit, in D major because
 * the genre lives in bright major keys and D sits the lead exactly where a
 * small speaker is loudest.
 *
 * **Form, not loop points.** Nothing here is a loop of rendered audio, so
 * there is no seam to hide: the sequencer walks a sixteen-bar form (A A B C)
 * and the arrangement thins and thickens by cycle, so the third time round is
 * not the first time round. Over three laps you hear the same harmony maybe
 * eight times and a different arrangement of it every time — which is exactly
 * how the games this is modelled on avoid wearing out.
 *
 * **Scheduling is on the audio clock.** A frame-driven `setInterval` sequencer
 * drifts, and worse, it hitches audibly the moment the renderer stalls. This
 * one keeps a 220 ms lookahead: each frame it pushes every note whose time
 * falls inside the window onto the AudioContext clock, where it is
 * sample-accurate and completely immune to what the GPU is doing.
 *
 * **Variants share material.** `race` and `finalLap` are the same form, the
 * same patterns and the same key; final lap is 12% faster with an extra
 * octave-doubled lead and a driving tambourine. The change lands on the next
 * bar line, so the transition is a gear change rather than an edit.
 *
 * The star layer is a separate fast arpeggio that ducks the melody while it
 * runs — the invincibility music, playing over the top of whatever is on.
 */
import type { Rng } from "../types";
import type { AudioGraph } from "./graph";
import { bake, noteHz, normalize, onePole, oneHigh, percEnv, playBuffer, shape, softClip, svfBand } from "./synth";

export type MusicTrack = "menu" | "race" | "finalLap" | "results";

/** Key centre. D3 for the bass to sit on, everything else offsets from it. */
const KEY = 50; // D3
const SCALE = [0, 2, 4, 5, 7, 9, 11];

/** How far ahead of the audio clock notes are committed. */
const LOOKAHEAD = 0.22;

interface Chord {
  /** Semitones above the key. */
  root: number;
  quality: "maj" | "min" | "sus" | "dom";
}

const CH = (root: number, quality: Chord["quality"] = "maj"): Chord => ({ root, quality });

/** I – vi – IV – V, then ii – V – iii – vi, then a turnaround. Pop, on purpose. */
const FORM_A: Chord[] = [CH(0), CH(9, "min"), CH(5), CH(7)];
const FORM_B: Chord[] = [CH(2, "min"), CH(7, "dom"), CH(4, "min"), CH(9, "min")];
const FORM_C: Chord[] = [CH(5), CH(7, "sus"), CH(0), CH(7, "dom")];
const RACE_FORM: Chord[] = [...FORM_A, ...FORM_A, ...FORM_B, ...FORM_C];

/** Menu: slower harmonic rhythm, softer function. I – iii – IV – ii/V. */
const MENU_FORM: Chord[] = [
  CH(0), CH(4, "min"), CH(5), CH(2, "min"),
  CH(0), CH(4, "min"), CH(5), CH(7, "sus"),
];

/** Results: a two-bar flourish, then a victory-lap loop. */
const RESULTS_FORM: Chord[] = [
  CH(0), CH(7, "dom"), // fanfare bars
  CH(0), CH(5), CH(9, "min"), CH(7),
  CH(0), CH(5), CH(2, "min"), CH(7, "dom"),
];

function chordTones(c: Chord): number[] {
  switch (c.quality) {
    case "min":
      return [0, 3, 7, 10];
    case "sus":
      return [0, 5, 7, 12];
    case "dom":
      return [0, 4, 7, 10];
    default:
      return [0, 4, 7, 11];
  }
}

/** Melody phrases: [step within 2 bars (0..31), scale degree, length in steps]. */
type Phrase = ReadonlyArray<readonly [number, number, number]>;

const PHRASES: Phrase[] = [
  [
    [0, 4, 2], [2, 2, 2], [4, 0, 3], [8, 2, 2], [10, 4, 2], [12, 6, 4],
    [16, 7, 3], [20, 6, 2], [22, 4, 2], [24, 2, 4], [29, 4, 3],
  ],
  [
    [0, 7, 3], [4, 6, 1], [6, 4, 2], [8, 2, 5], [14, 4, 2], [16, 5, 3],
    [20, 4, 2], [22, 2, 2], [24, 1, 4], [28, 0, 4],
  ],
  [
    [0, 2, 1], [1, 4, 1], [2, 7, 4], [8, 6, 2], [10, 7, 2], [12, 9, 4],
    [16, 8, 2], [18, 7, 2], [20, 6, 4], [26, 4, 2], [28, 2, 4],
  ],
  [
    [0, 0, 2], [4, 2, 2], [6, 4, 2], [8, 6, 4], [13, 7, 3],
    [16, 9, 2], [18, 7, 2], [20, 6, 2], [22, 4, 2], [24, 5, 2], [26, 4, 2], [28, 2, 4],
  ],
];

/** 16-step drum masks. Bit i (from the left) is the i-th sixteenth. */
const KICK = [
  0b1000_1000_1000_1000, // four-on-the-floor spine
  0b1000_0010_1000_0100,
  0b1000_1000_1001_0000,
  0b1000_0010_1010_0010,
];
const SNARE = [
  0b0000_1000_0000_1000,
  0b0000_1000_0000_1010,
  0b0000_1000_0010_1000,
  0b0000_1001_0000_1000,
];
const HAT = [
  0b1010_1010_1010_1010,
  0b1011_1010_1010_1110,
  0b1010_1011_1010_1010,
];

const bitAt = (mask: number, i: number): boolean => ((mask >> (15 - i)) & 1) === 1;

interface TrackCfg {
  bpm: number;
  form: Chord[];
  /** Bar the form loops back to — everything before it is a one-time intro. */
  loopFrom: number;
  drums: boolean;
  bass: boolean;
  arp: boolean;
  lead: boolean;
  pad: boolean;
  /** The final-lap extra: octave lead double + tambourine sixteenths. */
  extra: boolean;
  /** Lead octave offset in semitones above the key. */
  leadOct: number;
  /** Swing on the off-sixteenths, as a fraction of a step. */
  swing: number;
  gain: number;
}

const TRACKS: Record<MusicTrack, TrackCfg> = {
  menu: { bpm: 100, form: MENU_FORM, loopFrom: 0, drums: false, bass: true, arp: true, lead: true, pad: true, extra: false, leadOct: 24, swing: 0.12, gain: 0.8 },
  race: { bpm: 152, form: RACE_FORM, loopFrom: 0, drums: true, bass: true, arp: true, lead: true, pad: false, extra: false, leadOct: 24, swing: 0.06, gain: 1 },
  finalLap: { bpm: 170, form: RACE_FORM, loopFrom: 0, drums: true, bass: true, arp: true, lead: true, pad: false, extra: true, leadOct: 24, swing: 0.04, gain: 1.05 },
  results: { bpm: 132, form: RESULTS_FORM, loopFrom: 2, drums: true, bass: true, arp: true, lead: true, pad: true, extra: false, leadOct: 24, swing: 0.08, gain: 1 },
};

export interface MusicRig {
  set(track: MusicTrack | null): void;
  /** Run the scheduler. Call once per frame. */
  update(): void;
  /** Star power: layer the invincibility arp and duck the melody. */
  setStar(on: boolean): void;
  current: MusicTrack | null;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

export function bakeKit(ac: BaseAudioContext, rnd: Rng): Record<string, AudioBuffer> {

  const kick = bake(ac, 0.42, (d, sr) => {
    let phase = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      // 150 Hz to 46 Hz in 30 ms. The pitch drop *is* the kick.
      const f = 46 + 104 * Math.exp(-t / 0.03);
      phase += (2 * Math.PI * f) / sr;
      d[i] = Math.sin(phase) * percEnv(t, 0.001, 0.14);
    }
    // A little click, so it survives on a laptop speaker with no low end.
    const clickN = Math.min(d.length, Math.floor(sr * 0.004));
    for (let i = 0; i < clickN; i++) d[i] += (i % 3 === 0 ? 1 : -1) * 0.28 * Math.exp(-i / (sr * 0.0007));
    softClip(d, 1.35);
    normalize(d, 0.95);
  });

  const snare = bake(ac, 0.35, (d, sr) => {
    const band = svfBand(sr, 1.3);
    let phase = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      phase += (2 * Math.PI * (185 + 90 * Math.exp(-t / 0.02))) / sr;
      const body = Math.sin(phase) * percEnv(t, 0.001, 0.045) * 0.6;
      const wires = band(rnd() * 2 - 1, 1900) * percEnv(t, 0.001, 0.09);
      d[i] = body + wires;
    }
    softClip(d, 1.2);
    normalize(d, 0.9);
  });

  const hat = bake(ac, 0.09, (d, sr) => {
    const hp = oneHigh(6500, sr);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = hp(rnd() * 2 - 1) * percEnv(t, 0.0004, 0.012);
    }
    normalize(d, 0.7);
  });

  const openHat = bake(ac, 0.4, (d, sr) => {
    const hp = oneHigh(5200, sr);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = hp(rnd() * 2 - 1) * percEnv(t, 0.001, 0.1);
    }
    normalize(d, 0.6);
  });

  const tom = bake(ac, 0.3, (d, sr) => {
    let phase = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      phase += (2 * Math.PI * (150 + 110 * Math.exp(-t / 0.05))) / sr;
      d[i] = Math.sin(phase) * percEnv(t, 0.001, 0.1);
    }
    normalize(d, 0.85);
  });

  // Tambourine: a cluster of high partials plus a hiss, for the final lap.
  const tamb = bake(ac, 0.18, (d, sr) => {
    const hp = oneHigh(4000, sr);
    const lp = onePole(9000, sr);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      let jingles = 0;
      for (const f of [6200, 7400, 8900]) jingles += Math.sin(2 * Math.PI * f * t) * 0.25;
      d[i] = (lp(hp(rnd() * 2 - 1)) * 0.8 + jingles) * percEnv(t, 0.0008, 0.035);
    }
    normalize(d, 0.55);
  });

  return { kick, snare, hat, openHat, tom, tamb };
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

export function createMusicRig(g: AudioGraph): MusicRig {
  const ac = g.ac;
  const kit = bakeKit(g.ac, g.rng);
  const owned: AudioNode[] = [];

  const bus = ac.createGain();
  bus.gain.value = 0.0001;
  bus.connect(g.music);
  owned.push(bus);

  function sub(gain: number, wet: number): GainNode {
    const n = ac.createGain();
    n.gain.value = gain;
    n.connect(bus);
    const s = ac.createGain();
    s.gain.value = wet;
    n.connect(s).connect(g.send);
    owned.push(n, s);
    return n;
  }

  const drumBus = sub(0.85, 0.08);
  const bassBus = sub(0.75, 0.04);
  const arpBus = sub(0.36, 0.28);
  const leadBus = sub(0.5, 0.24);
  const padBus = sub(0.3, 0.4);
  const starBus = sub(0.0001, 0.22);

  // A slap-back on the arp is what makes eight bars of sixteenths feel like a
  // record rather than a metronome with a tune bolted to it.
  const echo = ac.createDelay(1);
  const echoFb = ac.createGain();
  const echoLp = ac.createBiquadFilter();
  echoLp.type = "lowpass";
  echoLp.frequency.value = 3200;
  echoFb.gain.value = 0.3;
  echo.delayTime.value = 0.26;
  arpBus.connect(echo).connect(echoLp).connect(echoFb).connect(echo);
  const echoOut = ac.createGain();
  echoOut.gain.value = 0.28;
  echoLp.connect(echoOut).connect(bus);
  owned.push(echo, echoFb, echoLp, echoOut);

  // --- Voices --------------------------------------------------------------
  function pluck(dest: GainNode, t: number, midi: number, dur: number, vel: number, type: OscillatorType, detune: number): void {
    const f = noteHz(midi);
    const a = ac.createOscillator();
    a.type = type;
    a.frequency.value = f;
    const b = ac.createOscillator();
    b.type = type === "square" ? "triangle" : type;
    b.frequency.value = f;
    b.detune.value = detune;
    const amp = ac.createGain();
    shape(amp.gain, t, vel, 0.006, dur * 0.35, dur * 0.7);
    a.connect(amp);
    b.connect(amp);
    amp.connect(dest);
    a.start(t);
    b.start(t);
    const stop = t + dur * 1.1 + 0.06;
    a.stop(stop);
    b.stop(stop);
  }

  function bassNote(t: number, midi: number, dur: number, vel: number): void {
    const f = noteHz(midi);
    const osc = ac.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = f;
    const sq = ac.createOscillator();
    sq.type = "square";
    sq.frequency.value = f * 0.5; // an octave down for weight on small speakers
    const sqGain = ac.createGain();
    sqGain.gain.value = 0.5;
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 6;
    // A filter envelope on every note — the pluck that makes a bass line move.
    lp.frequency.setValueAtTime(320 + 900 * vel, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + dur * 0.8);
    const amp = ac.createGain();
    shape(amp.gain, t, vel, 0.005, dur * 0.5, dur * 0.5);
    osc.connect(lp);
    sq.connect(sqGain).connect(lp);
    lp.connect(amp).connect(bassBus);
    osc.start(t);
    sq.start(t);
    const stop = t + dur + 0.06;
    osc.stop(stop);
    sq.stop(stop);
  }

  function leadNote(t: number, midi: number, dur: number, vel: number, octave = 0): void {
    const f = noteHz(midi + octave);
    const a = ac.createOscillator();
    a.type = "square";
    a.frequency.value = f;
    a.detune.value = -6;
    const b = ac.createOscillator();
    b.type = "triangle";
    b.frequency.value = f;
    b.detune.value = 7;
    const bg = ac.createGain();
    bg.gain.value = 0.7;
    const amp = ac.createGain();
    // Longer notes get a slower attack, which is most of what "phrasing" is.
    shape(amp.gain, t, vel, dur > 0.25 ? 0.02 : 0.008, dur * 0.55, dur * 0.6);
    a.connect(amp);
    b.connect(bg).connect(amp);
    amp.connect(leadBus);
    a.start(t);
    b.start(t);
    const stop = t + dur * 1.2 + 0.08;
    a.stop(stop);
    b.stop(stop);
  }

  function padChord(t: number, midis: number[], dur: number, vel: number): void {
    for (const m of midis) {
      const osc = ac.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = noteHz(m);
      const det = ac.createOscillator();
      det.type = "sine";
      det.frequency.value = noteHz(m);
      det.detune.value = 9;
      const dg = ac.createGain();
      dg.gain.value = 0.5;
      const lp = ac.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1800;
      const amp = ac.createGain();
      shape(amp.gain, t, vel, dur * 0.25, dur * 0.3, dur * 0.6);
      osc.connect(lp);
      det.connect(dg).connect(lp);
      lp.connect(amp).connect(padBus);
      osc.start(t);
      det.start(t);
      const stop = t + dur * 1.2 + 0.1;
      osc.stop(stop);
      det.stop(stop);
    }
  }

  function hit(name: keyof typeof kit, t: number, vel: number, rate = 1, pan = 0): void {
    const buffer = kit[name];
    if (!buffer) return;
    playBuffer(g, { t, buffer, gain: vel, rate, pan, dest: drumBus, wet: 0.06 });
  }

  // --- Transport -----------------------------------------------------------
  let cfg: TrackCfg | null = null;
  let track: MusicTrack | null = null;
  let step = 0;
  let nextTime = 0;
  let bpm = 120;
  /** Pending track, applied on the next bar line (or immediately on a cut). */
  let queued: MusicTrack | null = null;
  let star = false;
  let starPhase = 0;

  const stepDur = (): number => 60 / bpm / 4;

  function begin(next: MusicTrack, at: number): void {
    track = next;
    cfg = TRACKS[next];
    bpm = cfg.bpm;
    step = 0;
    nextTime = at;
    bus.gain.cancelScheduledValues(at);
    bus.gain.setTargetAtTime(cfg.gain, at, 0.25);
  }

  function scheduleStep(s: number, t: number): void {
    if (!cfg) return;
    const c = cfg;
    const inBar = s & 15;
    const barAbs = s >> 4;
    const loopLen = Math.max(1, c.form.length - c.loopFrom);
    const bar = barAbs < c.loopFrom ? barAbs : c.loopFrom + ((barAbs - c.loopFrom) % loopLen);
    const cycle = Math.floor(Math.max(0, barAbs - c.loopFrom) / loopLen);
    const chord = c.form[bar] ?? c.form[0];
    const tones = chordTones(chord);
    const root = KEY + chord.root;
    const spice = cycle % 3; // arrangement variation between passes
    const dur = stepDur();
    // Swing: push the off-sixteenths late. Tiny amounts do a lot.
    const swung = inBar % 2 === 1 ? t + dur * c.swing : t;
    const fillBar = (bar & 3) === 3;

    // --- Drums
    if (c.drums) {
      const kickMask = KICK[(bar + spice) % KICK.length];
      const snareMask = SNARE[(bar + spice) % SNARE.length];
      const hatMask = HAT[(bar + spice) % HAT.length];
      if (bitAt(kickMask, inBar)) hit("kick", t, 0.9);
      if (bitAt(snareMask, inBar)) hit("snare", swung, inBar % 4 === 0 ? 0.7 : 0.5);
      if (bitAt(hatMask, inBar)) {
        const open = inBar === 14 && (bar & 1) === 1;
        hit(open ? "openHat" : "hat", swung, open ? 0.28 : inBar % 4 === 0 ? 0.34 : 0.2, 1, inBar % 4 === 2 ? 0.18 : -0.14);
      }
      // Four-bar fill: toms tumbling down into the next section.
      if (fillBar && inBar >= 12) {
        hit("tom", swung, 0.55, 1.3 - (inBar - 12) * 0.14, (inBar - 13.5) * 0.25);
      }
      if (c.extra && inBar % 2 === 0) hit("tamb", t, inBar % 8 === 0 ? 0.3 : 0.18, 1, 0.3);
    }

    // --- Bass: root on the beat, fifth and octave on the pushes.
    if (c.bass) {
      const pattern = spice === 2 ? [0, 3, 6, 8, 11, 14] : [0, 6, 8, 14];
      if (pattern.includes(inBar)) {
        const isRoot = inBar === 0 || inBar === 8;
        const note = root - 12 + (isRoot ? 0 : inBar === 6 ? 7 : inBar === 14 ? 12 : 7);
        bassNote(swung, note, dur * (isRoot ? 2.6 : 1.6), isRoot ? 0.5 : 0.34);
      }
    }

    // --- Arp: sixteenths through the chord, direction alternating by bar.
    if (c.arp) {
      const on = spice === 1 ? inBar % 2 === 0 || inBar % 8 === 3 : inBar % 2 === 0;
      if (on) {
        const idx = (inBar >> 1) + bar;
        const up = (bar & 1) === 0;
        const seq = up ? idx : 7 - (idx % 8);
        const tone = tones[((seq % tones.length) + tones.length) % tones.length];
        const oct = 12 * (1 + (Math.floor(Math.abs(seq) / tones.length) % 2));
        pluck(arpBus, swung, root + tone + oct, dur * 1.4, 0.24, "square", 6);
      }
    }

    // --- Pad: one long chord per bar.
    if (c.pad && inBar === 0) {
      padChord(t, tones.slice(0, 3).map((n) => root + n + 12), dur * 15, 0.16);
    }

    // --- Lead: a written phrase over two bars, chosen by section and cycle.
    if (c.lead && !star) {
      const phrase = PHRASES[(Math.floor(bar / 2) + spice) % PHRASES.length];
      const pos = (bar % 2) * 16 + inBar;
      // The last two bars of a form are a breath — the melody sits out so the
      // next pass lands as an arrival rather than as more of the same.
      const resting = bar >= c.form.length - 2 && cycle % 2 === 1;
      if (!resting) {
        for (const [at, degree, len] of phrase) {
          if (at !== pos) continue;
          const oct = 12 * Math.floor(degree / 7);
          const midi = KEY + c.leadOct + oct + SCALE[degree % 7];
          // Snap the phrase into the chord: shift a note that clashes hard by
          // one scale step. Cheap voice-leading, and it keeps every bar sweet.
          const rel = ((midi - root) % 12 + 12) % 12;
          const fixed = tones.includes(rel) || len <= 1 ? midi : midi + (rel === 1 || rel === 6 ? 1 : -1);
          leadNote(swung, fixed, dur * len, 0.34);
          if (c.extra) leadNote(swung, fixed, dur * len, 0.13, 12);
        }
      }
    }

    // --- Star: a fast chromatic-ish arpeggio over everything else.
    if (star) {
      const ladder = [0, 4, 7, 12, 16, 12, 7, 4];
      const n = ladder[starPhase % ladder.length];
      starPhase++;
      pluck(starBus, t, KEY + 12 + chord.root + n, dur * 1.1, 0.3, "square", 9);
      if ((starPhase & 1) === 0) hit("hat", t, 0.16, 1.3, 0.25);
    }
  }

  /** race ↔ finalLap share every note; only tempo and layers differ. */
  function sameMaterial(a: MusicTrack | null, b: MusicTrack): boolean {
    return (a === "race" && b === "finalLap") || (a === "finalLap" && b === "race");
  }

  function update(): void {
    if (ac.state !== "running") return;
    const now = ac.currentTime;

    if (queued) {
      const next = queued;
      if (!track) {
        queued = null;
        begin(next, now + 0.06);
      } else if (!sameMaterial(track, next)) {
        // Different material: duck out, then start clean.
        queued = null;
        bus.gain.cancelScheduledValues(now);
        bus.gain.setTargetAtTime(0.0001, now, 0.12);
        begin(next, now + 0.42);
        return;
      }
      // Same material falls through: the swap happens on a bar line inside the
      // scheduling loop below, which is the only place that sees every step.
    }

    if (!cfg) return;
    // A hidden tab freezes the clock; re-anchor rather than machine-gunning
    // every note we owe when it comes back.
    if (nextTime < now - 0.3) nextTime = now + 0.05;

    let guard = 0;
    while (nextTime < now + LOOKAHEAD && guard++ < 96) {
      // Change tempo and layers on the bar line so the final-lap shift reads
      // as the band leaning in, not as an edit.
      if (queued && (step & 15) === 0) {
        const next = queued;
        queued = null;
        track = next;
        cfg = TRACKS[next];
        bpm = cfg.bpm;
        bus.gain.setTargetAtTime(cfg.gain, nextTime, 0.2);
      }
      scheduleStep(step, nextTime);
      nextTime += stepDur();
      step++;
    }
  }

  return {
    set(next) {
      if (next === null) {
        queued = null;
        track = null;
        cfg = null;
        bus.gain.cancelScheduledValues(ac.currentTime);
        bus.gain.setTargetAtTime(0.0001, ac.currentTime, 0.2);
        return;
      }
      if (next === track && !queued) return;
      queued = next;
    },
    update,
    setStar(on) {
      if (on === star) return;
      star = on;
      starPhase = 0;
      const t = ac.currentTime;
      starBus.gain.setTargetAtTime(on ? 0.32 : 0.0001, t, 0.12);
      // Duck the tune under the invincibility arp rather than muting it.
      leadBus.gain.setTargetAtTime(on ? 0.12 : 0.5, t, 0.15);
      arpBus.gain.setTargetAtTime(on ? 0.16 : 0.36, t, 0.15);
    },
    get current() {
      return track;
    },
    dispose() {
      for (const n of owned) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
      owned.length = 0;
      cfg = null;
      track = null;
    },
  };
}

/** Exposed so a debug overlay can name the tempo of what is playing. */
export function musicTempo(t: MusicTrack): number {
  return TRACKS[t].bpm;
}
