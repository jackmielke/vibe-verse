/**
 * Vibe Kart — the score.
 *
 * A real tune, sequenced live: chords, a walking-ish bass, a sixteenth-note
 * arpeggio, a written melody, backbeat stabs and a synthesised drum kit, in D
 * major because the genre lives in bright major keys and D sits the lead
 * exactly where a small speaker is loudest.
 *
 * **Form, not loop points.** Nothing here is a loop of rendered audio, so
 * there is no seam to hide: the sequencer walks a sixteen-bar form (A A B C)
 * and the arrangement thins and thickens by cycle, so the third time round is
 * not the first time round. Over three laps you hear the same harmony maybe
 * eight times and a different arrangement of it every time — which is exactly
 * how the games this is modelled on avoid wearing out.
 *
 * **There is a hook.** The A section always plays the same two-bar phrase, and
 * plays it twice; B and C are the departure and the answer. Rotating the
 * melody freely through every phrase — which is what this used to do — gives
 * you eight bars of notes rather than a tune, and nothing to recognise on the
 * second lap.
 *
 * **Every pitched voice is filtered.** A raw `square` oscillator carries
 * strong harmonics all the way to Nyquist, and a written melody sitting at
 * 1.5 kHz with all of them intact is the definition of shrill on a phone
 * speaker. Each voice runs through a lowpass whose cutoff tracks the note and
 * falls across the note's life — a synth brief, not an effect — so the score
 * has body and top without the fizz. The music bus then takes a high shelf on
 * the way out as a backstop.
 *
 * **The harmony is diatonic.** Major chords are 6ths rather than major 7ths
 * (a maj7 puts a semitone under the root, right where the melody lives), and
 * the dominant is a dom7 — an A *major 7th* in D major carries a G♯ the
 * melody's G natural collides with every single time the V comes round, which
 * is a sour bar every four.
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
import { bake, clamp, noteHz, normalize, onePole, oneHigh, percEnv, playBuffer, shape, softClip, svfBand } from "./synth";

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
const FORM_A: Chord[] = [CH(0), CH(9, "min"), CH(5), CH(7, "dom")];
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
  CH(0), CH(5), CH(9, "min"), CH(7, "dom"),
  CH(0), CH(5), CH(2, "min"), CH(7, "dom"),
];

/**
 * Chord tones, as semitones above the chord root.
 *
 * `maj` is a 6th, not a major 7th. The 7th sits a semitone under the octave
 * and the melody spends most of its life on the root and the 3rd; the 6th is
 * the same brightness with none of the rub, and it is what every arcade racer
 * of the era actually voiced.
 */
function chordTones(c: Chord): number[] {
  switch (c.quality) {
    case "min":
      return [0, 3, 7, 10];
    case "sus":
      return [0, 5, 7, 12];
    case "dom":
      return [0, 4, 7, 10];
    default:
      return [0, 4, 7, 9];
  }
}

/** Melody phrases: [step within 2 bars (0..31), scale degree, length in steps]. */
type Phrase = ReadonlyArray<readonly [number, number, number]>;

/**
 * The hook, and the phrases that answer it.
 *
 * `HOOK` plays over both halves of every A section — twice per form, four
 * times before the first lap is out — which is what makes it a tune you can
 * hum rather than a stream of correct notes. The rest is the middle eight.
 */
const HOOK: Phrase = [
  [0, 4, 2], [2, 2, 2], [4, 0, 3], [8, 2, 2], [10, 4, 2], [12, 6, 4],
  [16, 7, 3], [20, 6, 2], [22, 4, 2], [24, 2, 4], [29, 4, 3],
];

/** A lift on the repeat: the same shape, taken up a step and left hanging. */
const HOOK_LIFT: Phrase = [
  [0, 4, 2], [2, 2, 2], [4, 0, 3], [8, 2, 2], [10, 4, 2], [12, 6, 4],
  [16, 8, 3], [20, 7, 2], [22, 6, 2], [24, 7, 6], [31, 6, 1],
];

const PHRASE_B: Phrase = [
  [0, 7, 3], [4, 6, 1], [6, 4, 2], [8, 2, 5], [14, 4, 2], [16, 5, 3],
  [20, 4, 2], [22, 2, 2], [24, 1, 4], [28, 0, 4],
];

const PHRASE_B2: Phrase = [
  [0, 2, 1], [1, 4, 1], [2, 7, 4], [8, 6, 2], [10, 7, 2], [12, 9, 4],
  [16, 8, 2], [18, 7, 2], [20, 6, 4], [26, 4, 2], [28, 2, 4],
];

const PHRASE_C: Phrase = [
  [0, 0, 2], [4, 2, 2], [6, 4, 2], [8, 6, 4], [13, 7, 3],
  [16, 9, 2], [18, 7, 2], [20, 6, 2], [22, 4, 2], [24, 5, 2], [26, 4, 2], [28, 2, 4],
];

/**
 * Which phrase covers which two-bar slot of the form.
 *
 * Indexed by `floor(bar / 2)` and wrapped, so a form of any length gets a
 * sensible melody and the sixteen-bar race form gets hook / hook-lift / hook /
 * hook-lift / middle / middle / answer / turnaround.
 */
const PHRASE_PLAN: Phrase[] = [HOOK, HOOK_LIFT, HOOK, HOOK_LIFT, PHRASE_B, PHRASE_B2, PHRASE_C, HOOK_LIFT];

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
  /** Backbeat chord stabs — the thing that makes it sound like a band. */
  stab: boolean;
  /** The final-lap extra: octave lead double + tambourine sixteenths. */
  extra: boolean;
  /** Lead octave offset in semitones above the key. */
  leadOct: number;
  /** Swing on the off-sixteenths, as a fraction of a step. */
  swing: number;
  gain: number;
}

const TRACKS: Record<MusicTrack, TrackCfg> = {
  menu: { bpm: 100, form: MENU_FORM, loopFrom: 0, drums: false, bass: true, arp: true, lead: true, pad: true, stab: false, extra: false, leadOct: 24, swing: 0.12, gain: 0.78 },
  race: { bpm: 152, form: RACE_FORM, loopFrom: 0, drums: true, bass: true, arp: true, lead: true, pad: false, stab: true, extra: false, leadOct: 24, swing: 0.06, gain: 1 },
  finalLap: { bpm: 170, form: RACE_FORM, loopFrom: 0, drums: true, bass: true, arp: true, lead: true, pad: false, stab: true, extra: true, leadOct: 24, swing: 0.04, gain: 1.04 },
  results: { bpm: 132, form: RESULTS_FORM, loopFrom: 2, drums: true, bass: true, arp: true, lead: true, pad: true, stab: true, extra: false, leadOct: 24, swing: 0.08, gain: 0.96 },
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
    for (let i = 0; i < clickN; i++) d[i] += (i % 3 === 0 ? 1 : -1) * 0.22 * Math.exp(-i / (sr * 0.0007));
    softClip(d, 1.35);
    normalize(d, 0.95);
  });

  const snare = bake(ac, 0.35, (d, sr) => {
    const band = svfBand(sr, 1.3);
    // The wires are the loudest thing in the kit and they sit right in the
    // band the ear is most sensitive to. Roll the very top off them.
    const lp = onePole(7200, sr);
    let phase = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      phase += (2 * Math.PI * (185 + 90 * Math.exp(-t / 0.02))) / sr;
      const body = Math.sin(phase) * percEnv(t, 0.001, 0.045) * 0.7;
      const wires = lp(band(rnd() * 2 - 1, 1900)) * percEnv(t, 0.001, 0.09);
      d[i] = body + wires;
    }
    softClip(d, 1.2);
    normalize(d, 0.9);
  });

  // 5.2 kHz rather than 6.5: a hat that is pure top end is a hiss on every
  // eighth note, and a hiss on every eighth note is what people mean by
  // "fatiguing". Band-limited above as well, so it never sizzles.
  const hat = bake(ac, 0.09, (d, sr) => {
    const hp = oneHigh(5200, sr);
    const lp = onePole(11000, sr);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = lp(hp(rnd() * 2 - 1)) * percEnv(t, 0.0004, 0.012);
    }
    normalize(d, 0.62);
  });

  const openHat = bake(ac, 0.4, (d, sr) => {
    const hp = oneHigh(4400, sr);
    const lp = onePole(10000, sr);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = lp(hp(rnd() * 2 - 1)) * percEnv(t, 0.001, 0.1);
    }
    normalize(d, 0.5);
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
    const hp = oneHigh(3600, sr);
    const lp = onePole(8200, sr);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      let jingles = 0;
      for (const f of [6200, 7400, 8900]) jingles += Math.sin(2 * Math.PI * f * t) * 0.18;
      d[i] = (lp(hp(rnd() * 2 - 1)) * 0.8 + lp(jingles)) * percEnv(t, 0.0008, 0.035);
    }
    normalize(d, 0.48);
  });

  return { kick, snare, hat, openHat, tom, tamb };
}

// ---------------------------------------------------------------------------
// Voicing helpers
// ---------------------------------------------------------------------------

/**
 * Move a melody note onto the chord.
 *
 * The old rule shifted every non-chord tone by one semitone in a fixed
 * direction, which turned a 9th into a flat 9th — it *created* the clash it
 * was there to fix. This one leaves the colour tones alone (a 9th and a 6th
 * over any chord are sweet, and a passing sixteenth is over before it can
 * offend) and otherwise moves to whichever chord tone is genuinely nearest.
 */
export function snapToChord(midi: number, root: number, tones: number[], steps: number): number {
  const rel = (((midi - root) % 12) + 12) % 12;
  if (tones.includes(rel)) return midi;
  // Short notes are passing tones; a 9th and a 6th are colour, not collision.
  if (steps <= 1 || rel === 2 || rel === 9) return midi;
  let bestDelta = 12;
  for (const tone of tones) {
    for (const octave of [-12, 0, 12]) {
      const d = tone + octave - rel;
      if (Math.abs(d) < Math.abs(bestDelta) || (Math.abs(d) === Math.abs(bestDelta) && d > bestDelta)) {
        bestDelta = d;
      }
    }
  }
  return midi + bestDelta;
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

  /**
   * Tone control on the way out. Everything upstream is filtered per voice
   * already; this is the backstop that guarantees no arrangement, however
   * dense, can pile enough top end up to be shrill — and it costs two biquads.
   */
  const tilt = ac.createBiquadFilter();
  tilt.type = "highshelf";
  tilt.frequency.value = 3400;
  tilt.gain.value = -4;
  const airCap = ac.createBiquadFilter();
  airCap.type = "lowpass";
  airCap.frequency.value = 11000;
  airCap.Q.value = 0.7;
  bus.connect(tilt).connect(airCap).connect(g.music);
  owned.push(bus, tilt, airCap);

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

  // Trims chosen so the sum of a full arrangement lands *under* the master
  // limiter's threshold. The old set drove it into 8–10 dB of gain reduction
  // on every downbeat, which is what "loud and squashed" sounds like.
  const drumBus = sub(0.7, 0.07);
  const bassBus = sub(0.62, 0.04);
  const arpBus = sub(0.26, 0.24);
  const leadBus = sub(0.42, 0.2);
  const padBus = sub(0.26, 0.36);
  const stabBus = sub(0.3, 0.18);
  const starBus = sub(0.0001, 0.2);

  const LEAD_GAIN = 0.42;
  const ARP_GAIN = 0.26;

  // A slap-back on the arp is what makes eight bars of sixteenths feel like a
  // record rather than a metronome with a tune bolted to it. Kept short of the
  // feedback that turns it into a wash of its own.
  const echo = ac.createDelay(1);
  const echoFb = ac.createGain();
  const echoLp = ac.createBiquadFilter();
  echoLp.type = "lowpass";
  echoLp.frequency.value = 2400;
  echoFb.gain.value = 0.2;
  echo.delayTime.value = 0.26;
  arpBus.connect(echo).connect(echoLp).connect(echoFb).connect(echo);
  const echoOut = ac.createGain();
  echoOut.gain.value = 0.16;
  echoLp.connect(echoOut).connect(bus);
  owned.push(echo, echoFb, echoLp, echoOut);

  // --- Voices --------------------------------------------------------------

  /**
   * A lowpass with a cutoff that opens on the attack and closes across the
   * note, tracking the pitch so a note two octaves up is not two octaves
   * brighter. This is the whole difference between a synth and a buzzer.
   */
  function brief(dest: AudioNode, t: number, hz: number, dur: number, open: number, close: number): BiquadFilterNode {
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.9;
    const f0 = clamp(hz * open, 320, 5200);
    const f1 = clamp(hz * close, 260, 3000);
    lp.frequency.setValueAtTime(f0, t);
    lp.frequency.exponentialRampToValueAtTime(f1, t + Math.max(0.03, dur * 0.9));
    lp.connect(dest);
    // Deliberately not `owned`: this is a per-note node, and it is collected
    // with the oscillator that feeds it. Retaining one per sixteenth would be
    // a leak measured in tens of thousands over a race.
    return lp;
  }

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
    amp.connect(brief(dest, t, f, dur, 3.4, 1.7));
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
    a.detune.value = -5;
    const b = ac.createOscillator();
    b.type = "triangle";
    b.frequency.value = f;
    b.detune.value = 6;
    const bg = ac.createGain();
    bg.gain.value = 0.8;
    const amp = ac.createGain();
    // Longer notes get a slower attack, which is most of what "phrasing" is.
    shape(amp.gain, t, vel, dur > 0.25 ? 0.02 : 0.008, dur * 0.55, dur * 0.6);
    a.connect(amp);
    b.connect(bg).connect(amp);
    // The lead is the loudest pitched thing in the mix and the highest, so it
    // gets the tightest brief of the lot.
    amp.connect(brief(leadBus, t, f, dur, 3.4, 1.8));
    a.start(t);
    b.start(t);
    const stop = t + dur * 1.2 + 0.08;
    a.stop(stop);
    b.stop(stop);
  }

  /**
   * Backbeat stabs. Three notes, saw-and-square, opened hard and shut in a
   * tenth of a second — the horn section every arcade racer has and the thing
   * that turns a bass-and-arp bed into a band.
   */
  function stab(t: number, midis: number[], dur: number, vel: number): void {
    const amp = ac.createGain();
    shape(amp.gain, t, vel, 0.006, dur * 0.18, dur * 0.5);
    amp.connect(brief(stabBus, t, noteHz(midis[0]), dur, 5.5, 1.6));
    for (let i = 0; i < midis.length; i++) {
      const f = noteHz(midis[i]);
      const osc = ac.createOscillator();
      osc.type = i === 0 ? "sawtooth" : "square";
      osc.frequency.value = f;
      osc.detune.value = (i - 1) * 7;
      const vg = ac.createGain();
      vg.gain.value = i === 0 ? 0.6 : 0.34;
      osc.connect(vg).connect(amp);
      osc.start(t);
      osc.stop(t + dur * 1.2 + 0.08);
    }
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
      lp.frequency.value = 1600;
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
    playBuffer(g, { t, buffer, gain: vel, rate, pan, dest: drumBus, wet: 0.05 });
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
      if (bitAt(snareMask, inBar)) hit("snare", swung, inBar % 4 === 0 ? 0.62 : 0.44);
      if (bitAt(hatMask, inBar)) {
        const open = inBar === 14 && (bar & 1) === 1;
        hit(open ? "openHat" : "hat", swung, open ? 0.22 : inBar % 4 === 0 ? 0.26 : 0.15, 1, inBar % 4 === 2 ? 0.18 : -0.14);
      }
      // Four-bar fill: toms tumbling down into the next section.
      if (fillBar && inBar >= 12) {
        hit("tom", swung, 0.5, 1.3 - (inBar - 12) * 0.14, (inBar - 13.5) * 0.25);
      }
      if (c.extra && inBar % 2 === 0) hit("tamb", t, inBar % 8 === 0 ? 0.24 : 0.14, 1, 0.3);
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
        pluck(arpBus, swung, root + tone + oct, dur * 1.4, 0.24, "triangle", 7);
      }
    }

    // --- Stabs: a horn chord on the backbeat, answering the snare.
    if (c.stab && (inBar === 4 || inBar === 12 || (fillBar && inBar === 14))) {
      const voicing = [root + 12, root + tones[1] + 12, root + tones[2] + 12];
      stab(swung, voicing, dur * (inBar === 14 ? 1.4 : 2.2), inBar === 4 ? 0.3 : 0.24);
    }

    // --- Pad: one long chord per bar.
    if (c.pad && inBar === 0) {
      padChord(t, tones.slice(0, 3).map((n) => root + n + 12), dur * 15, 0.16);
    }

    // --- Lead: the hook over the A sections, the answer over B and C.
    if (c.lead && !star) {
      const slot = Math.floor(bar / 2) % PHRASE_PLAN.length;
      const phrase = PHRASE_PLAN[slot];
      const pos = (bar % 2) * 16 + inBar;
      // The last two bars of a form are a breath — the melody sits out so the
      // next pass lands as an arrival rather than as more of the same.
      const resting = bar >= c.form.length - 2 && cycle % 2 === 1;
      if (!resting) {
        for (const [at, degree, len] of phrase) {
          if (at !== pos) continue;
          const oct = 12 * Math.floor(degree / 7);
          const midi = KEY + c.leadOct + oct + SCALE[degree % 7];
          const fixed = snapToChord(midi, root, tones, len);
          leadNote(swung, fixed, dur * len, 0.34);
          if (c.extra) leadNote(swung, fixed, dur * len, 0.11, 12);
        }
      }
    }

    // --- Star: a fast chromatic-ish arpeggio over everything else.
    if (star) {
      const ladder = [0, 4, 7, 12, 16, 12, 7, 4];
      const n = ladder[starPhase % ladder.length];
      starPhase++;
      pluck(starBus, t, KEY + 12 + chord.root + n, dur * 1.1, 0.3, "triangle", 9);
      if ((starPhase & 1) === 0) hit("hat", t, 0.13, 1.3, 0.25);
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
      starBus.gain.setTargetAtTime(on ? 0.28 : 0.0001, t, 0.12);
      // Duck the tune under the invincibility arp rather than muting it.
      leadBus.gain.setTargetAtTime(on ? 0.1 : LEAD_GAIN, t, 0.15);
      arpBus.gain.setTargetAtTime(on ? 0.12 : ARP_GAIN, t, 0.15);
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

/** The key the whole score is written in, and the scale the melody draws from. */
export const MUSIC_KEY = KEY;
export const MUSIC_SCALE = SCALE;

/**
 * A track's harmony, as chord roots and chord tones in semitones above the key.
 *
 * Exported for the test that asserts every chord is diatonic. A single wrong
 * quality — the dominant voiced as a major 7th rather than a dom 7th — puts a
 * note outside the key under a melody built from inside it, and the result is
 * a sour bar every four for the entire race. That is not something anyone
 * spots by reading a table of chord symbols.
 */
export function trackHarmony(t: MusicTrack): Array<{ root: number; tones: number[] }> {
  return TRACKS[t].form.map((c) => ({ root: c.root, tones: chordTones(c) }));
}
