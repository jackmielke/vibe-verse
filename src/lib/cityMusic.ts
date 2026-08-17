/**
 * cityMusic — the beat the city dances to, generated rather than played.
 *
 * ## Why there is no audio file here
 *
 * The dances were already the best-synchronised thing in the world and the
 * least perceptible: every character runs off `Date.now()` at one house tempo,
 * so two people who start the same move ten seconds apart are genuinely in
 * step — and in silence that reads as coincidence. Sound is what turns it into
 * something you can hear happening.
 *
 * It is synthesised for the same reason `citySounds.ts` is: no asset to ship,
 * no licence to honour, and — the part that actually matters here — a loop
 * that can be *phase-locked to the wall clock* instead of merely started at
 * some moment. An `<audio>` tag loops from whenever it was pressed play, so
 * two browsers are on two different downbeats and the whole point is lost. A
 * scheduler that asks "what beat is it, absolutely?" and places notes at that
 * beat puts every listener on the same bar line, including the one who opened
 * the page thirty seconds late.
 *
 * ## How the clock works
 *
 * `cityBeats()` is beats since the Unix epoch at `CITY_BPM` — the same
 * function the dances read. WebAudio schedules against `ctx.currentTime`,
 * which is a different clock entirely, so the two are tied together once at
 * startup (`anchorBeat` ↔ `anchorTime`) and everything is placed relative to
 * that anchor. The system clock and the audio hardware clock drift apart by a
 * few parts per million, which is an hour or two before it matters and free to
 * correct, so the scheduler re-anchors when they disagree by more than a
 * sixteenth of a beat.
 *
 * ## Layers, not a volume knob
 *
 * The track is arranged in four layers gated on how many people are dancing
 * near you. Alone you get kick, bass and a pad; a second dancer brings in the
 * hats, a third the claps and the lead, a fifth the octave stabs. That is the
 * bit that makes a crowd *sound* like a crowd — somebody joining is an audible
 * event rather than the same loop slightly louder, and it rewards the thing
 * the shared clock made possible.
 */
import { CITY_BPM, cityBeats } from "@/components/city/dances";

export interface CityMusic {
  /**
   * Per-frame. `dancers` counts everybody dancing within earshot, the local
   * player included; 0 fades the track out and stops scheduling.
   */
  update(dancers: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

const SEC_PER_BEAT = 60 / CITY_BPM;
/** Sixteenth notes: the finest grid anything in the arrangement lands on. */
const STEPS_PER_BEAT = 4;
const STEP_BEATS = 1 / STEPS_PER_BEAT;
/** Four bars of 4/4 — one chord each. */
const PATTERN_STEPS = 4 * 4 * STEPS_PER_BEAT;

/**
 * Am – F – C – G, one bar each.
 *
 * The most over-used progression in pop music, chosen on purpose: it is the
 * one a stranger can start dancing to without listening first, which is the
 * entire job here. Roots are low (A2–C3) so the bass has somewhere to sit, and
 * the upper voices are the triad an octave and a half up for the arp.
 */
const CHORDS = [
  { root: 110.0, tones: [440.0, 523.25, 659.25] },   // Am : A C E
  { root: 87.31, tones: [349.23, 440.0, 523.25] },   // F  : F A C
  { root: 130.81, tones: [392.0, 523.25, 659.25] },  // C  : C E G
  { root: 98.0, tones: [392.0, 493.88, 587.33] },    // G  : G B D
];

/** Layer thresholds: how many dancers it takes to bring each part in. */
const LAYER_AT = { hats: 2, lead: 3, stabs: 5 };

/** Which bus a note goes to — also which layer gates it. */
export type MusicBus = "drums" | "bass" | "pad" | "hats" | "lead" | "stabs";

/**
 * The mix for a given headcount: master, then one gain per bus.
 *
 * A pure function so the live mixer, the offline renderer that draws the
 * waveform, and the HUD readout all read the same thresholds. Three copies of
 * "hats come in at two" is three chances for the picture, the sound and the
 * caption to disagree about what the player is hearing.
 */
export function mixerLevels(dancers: number): { master: number } & Record<MusicBus, number> {
  const n = Math.max(0, dancers | 0);
  const on = n > 0 ? 1 : 0;
  return {
    master: on * 0.76,
    drums: on,
    bass: on,
    pad: on,
    hats: n >= LAYER_AT.hats ? 1 : 0,
    lead: n >= LAYER_AT.lead ? 1 : 0,
    stabs: n >= LAYER_AT.stabs ? 1 : 0,
  };
}

export interface StepEvent {
  voice: "kick" | "clap" | "hat" | "openhat" | "bass" | "pad" | "pluck";
  bus: MusicBus;
  /** Offset from the step, in seconds. Only the clap's flams use it. */
  at?: number;
  freq?: number;
  tones?: number[];
  dur?: number;
  level?: number;
}

/**
 * The arrangement, as data.
 *
 * A pure function of the step index — no state, no counters — which buys two
 * things. The scheduler can jump straight to whatever step the wall clock says
 * it is and be correct, including on the first tick after a page loads
 * mid-bar; and the pattern can be asserted in a test without a sound card,
 * which is the only way "the kick is on every beat" is ever going to be
 * checked, since nobody is going to hear a missing one in a review.
 *
 * `step` is a sixteenth, already wrapped into the four-bar pattern.
 */
export function stepEvents(step: number): StepEvent[] {
  const bar = Math.floor(step / (4 * STEPS_PER_BEAT)) % CHORDS.length;
  const inBar = step % (4 * STEPS_PER_BEAT);
  const beatInBar = Math.floor(inBar / STEPS_PER_BEAT);
  const sub = inBar % STEPS_PER_BEAT;
  const chord = CHORDS[bar];
  const out: StepEvent[] = [];

  if (sub === 0) {
    out.push({ voice: "kick", bus: "drums" });
    // Bass on every beat, dropping to the fifth on the last beat of the bar so
    // the progression pulls forward instead of sitting down.
    out.push({
      voice: "bass",
      bus: "bass",
      freq: beatInBar === 3 ? chord.root * 1.5 : chord.root,
      dur: SEC_PER_BEAT * 0.8,
    });
    if (beatInBar === 1 || beatInBar === 3) out.push({ voice: "clap", bus: "drums" });
    if (inBar === 0) out.push({ voice: "pad", bus: "pad", tones: chord.tones });
  }
  // Eighths, with the bar's last offbeat left open — the one that pulls you
  // over the bar line.
  if (sub === 2) out.push({ voice: beatInBar === 3 ? "openhat" : "hat", bus: "hats" });
  if (sub === 1 || sub === 3) out.push({ voice: "hat", bus: "hats" });

  // Lead: a rolling sixteenth arp up the chord, skipping the downbeat so the
  // kick has it to itself.
  if (sub !== 0) {
    out.push({
      voice: "pluck",
      bus: "lead",
      freq: chord.tones[(beatInBar * 3 + sub) % chord.tones.length],
      dur: 0.18,
      level: 0.19,
    });
  }
  // Stabs: the octave above, on the "and" of every beat. This is the layer a
  // five-person crowd unlocks, so it has to read as the track opening up —
  // the first pass put two of these in four bars and it arrived like nothing.
  if (sub === 2) {
    out.push({
      voice: "pluck",
      bus: "stabs",
      freq: chord.tones[beatInBar % chord.tones.length] * 2,
      dur: 0.26,
      level: 0.22,
    });
  }
  return out;
}

/** Sixteenths in the full loop, exported for anything that wants to walk it. */
export const MUSIC_PATTERN_STEPS = PATTERN_STEPS;
export const MUSIC_STEPS_PER_BEAT = STEPS_PER_BEAT;

export interface MusicGraph {
  master: GainNode;
  muteGain: GainNode;
  buses: Record<MusicBus, GainNode>;
  /** Render one step's events at audio time `t`. */
  playStep(step: number, t: number): void;
}

/**
 * Build the instrument.
 *
 * Takes a `BaseAudioContext` rather than an `AudioContext` so the exact same
 * graph can be rendered by an `OfflineAudioContext` — which is how
 * `scripts/music-check.mjs` gets to look at a waveform and assert that the
 * kicks land on the beat. A synth that can only be heard cannot be checked.
 */
export function buildMusicGraph(ctx: BaseAudioContext, destination: AudioNode): MusicGraph {
  const master = ctx.createGain();
  master.gain.value = 0;
  // A gentle ceiling so the music never fights the jetpack or a chime. It is a
  // floor you are standing on, not a thing you are listening to.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -14;
  limiter.ratio.value = 6;
  master.connect(limiter).connect(destination);

  const muteGain = ctx.createGain();
  muteGain.gain.value = 1;
  muteGain.connect(master);

  /** One bus per layer, so a layer can arrive and leave without a re-render. */
  const bus = (open: number) => {
    const g = ctx.createGain();
    g.gain.value = open;
    g.connect(muteGain);
    return g;
  };
  const buses: Record<MusicBus, GainNode> = {
    drums: bus(0),
    bass: bus(0),
    pad: bus(0),
    hats: bus(0),
    lead: bus(0),
    stabs: bus(0),
  };

  // One noise buffer, shared by every percussive voice.
  const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
  const noise = noiseBuf.getChannelData(0);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;

  const noiseBurst = (
    t: number,
    dur: number,
    level: number,
    filter: BiquadFilterType,
    freq: number,
    q: number,
    dest: GainNode,
  ) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t);
    src.stop(t + dur + 0.02);
  };

  /** Four-on-the-floor: pitch collapses fast, which is the whole sound. */
  const kick = (t: number, dest: GainNode) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.52, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + 0.3);
    // The click. Without it a kick is felt but not heard on laptop speakers,
    // which is what most of the city is listening on.
    noiseBurst(t, 0.012, 0.15, "highpass", 1200, 0.7, dest);
  };

  const hat = (t: number, open: boolean, dest: GainNode) =>
    noiseBurst(t, open ? 0.2 : 0.038, open ? 0.36 : 0.44, "highpass", 7600, 0.9, dest);

  /** Three bursts a few milliseconds apart, then a tail — that IS a clap. */
  const clap = (t: number, dest: GainNode) => {
    for (let i = 0; i < 3; i++) {
      noiseBurst(t + i * 0.009, 0.022, 0.22, "bandpass", 1500, 1.1, dest);
    }
    noiseBurst(t + 0.028, 0.14, 0.15, "bandpass", 1300, 0.9, dest);
  };

  const bass = (t: number, freq: number, dur: number, dest: GainNode) => {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 6;
    // The filter sweep is the note's whole character: it opens on the attack
    // and shuts again, which is what makes a saw read as "plucked" rather than
    // as a held drone.
    lp.frequency.setValueAtTime(220, t);
    lp.frequency.exponentialRampToValueAtTime(1500, t + 0.03);
    lp.frequency.exponentialRampToValueAtTime(300, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp).connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  };

  const pluck = (t: number, freq: number, dur: number, level: number, dest: GainNode) => {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    // A second oscillator a few cents off. One is a test tone; two is an
    // instrument.
    const det = ctx.createOscillator();
    det.type = "triangle";
    det.frequency.value = freq * 1.004;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    det.connect(g);
    g.connect(dest);
    osc.start(t);
    det.start(t);
    osc.stop(t + dur + 0.05);
    det.stop(t + dur + 0.05);
  };

  /** A whole bar of chord, breathing in and out under everything else. */
  const pad = (t: number, tones: number[], dest: GainNode) => {
    const dur = SEC_PER_BEAT * 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.08, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(0.0, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    g.connect(lp).connect(dest);
    for (const tone of tones) {
      for (const detune of [-4, 4]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = tone / 2;
        osc.detune.value = detune;
        osc.connect(g);
        osc.start(t);
        osc.stop(t + dur + 0.1);
      }
    }
  };

  // ---- Dispatch -----------------------------------------------------------
  /**
   * Turn one step of the arrangement into sound.
   *
   * The decisions all happened in `stepEvents`; this only knows how to make a
   * noise. Keeping the two apart is what lets the pattern be asserted in a
   * unit test and rendered offline into a waveform, neither of which can be
   * done to a function that reaches straight for an oscillator.
   */
  const playStep = (step: number, t: number) => {
    for (const e of stepEvents(step)) {
      const dest = buses[e.bus];
      const at = t + (e.at ?? 0);
      switch (e.voice) {
        case "kick": kick(at, dest); break;
        case "clap": clap(at, dest); break;
        case "hat": hat(at, false, dest); break;
        case "openhat": hat(at, true, dest); break;
        case "bass": bass(at, e.freq!, e.dur!, dest); break;
        case "pad": pad(at, e.tones!, dest); break;
        case "pluck": pluck(at, e.freq!, e.dur!, e.level!, dest); break;
      }
    }
  };

  return { master, muteGain, buses, playStep };
}

export function createCityMusic(): CityMusic | null {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return null; // no audio support — the city dances silently, as before
  }
  const { master, muteGain, buses, playStep } = buildMusicGraph(ctx, ctx.destination);

  // ---- Clock + scheduler --------------------------------------------------
  let anchorBeat = cityBeats();
  let anchorTime = ctx.currentTime + 0.08;
  const reanchor = () => {
    anchorBeat = cityBeats();
    anchorTime = ctx.currentTime + 0.08;
  };
  /** Audio time for an absolute city beat. */
  const timeOf = (beat: number) => anchorTime + (beat - anchorBeat) * SEC_PER_BEAT;

  /** Absolute step index last handed to `playStep`, so nothing plays twice. */
  let lastStep = Math.floor(cityBeats() / STEP_BEATS);
  /** True while the track should be audible; drives whether we schedule at all. */
  let live = false;

  const LOOKAHEAD_S = 0.22;
  const tick = () => {
    if (ctx.state === "suspended") return;
    const nowBeat = cityBeats();

    // Drift between the system clock and the audio clock. Left alone it would
    // walk the beat off the dances over a long session; corrected every tick it
    // would jitter. So: only when it exceeds a sixteenth.
    if (Math.abs(timeOf(nowBeat) - ctx.currentTime) > STEP_BEATS * SEC_PER_BEAT) {
      reanchor();
      lastStep = Math.floor(nowBeat / STEP_BEATS);
    }
    if (!live) {
      // Nothing to hear: keep the cursor with the clock so that starting up
      // lands on the true beat rather than replaying however many steps went by
      // while the city was quiet.
      lastStep = Math.floor((nowBeat + LOOKAHEAD_S / SEC_PER_BEAT) / STEP_BEATS);
      return;
    }
    const untilStep = Math.floor((nowBeat + LOOKAHEAD_S / SEC_PER_BEAT) / STEP_BEATS);
    // Bounded: a suspended tab that resumes an hour later must not try to
    // render an hour of sixteenth notes into the next 200ms.
    if (untilStep - lastStep > 64) lastStep = untilStep - 1;
    while (lastStep < untilStep) {
      lastStep++;
      const t = timeOf(lastStep * STEP_BEATS);
      if (t > ctx.currentTime) {
        playStep(((lastStep % PATTERN_STEPS) + PATTERN_STEPS) % PATTERN_STEPS, t);
      }
    }
  };
  const timer = window.setInterval(tick, 30);

  const ramp = (g: GainNode, v: number, tau = 0.35) =>
    g.gain.setTargetAtTime(v, ctx.currentTime, tau);

  return {
    update(dancers) {
      const n = Math.max(0, dancers | 0);
      // The context starts suspended until a gesture unblocks it; the city
      // creates this from a click, but a tab restored from bfcache can land
      // back in "suspended" with no further gesture coming.
      if (n > 0 && ctx.state === "suspended") void ctx.resume();

      live = n > 0;
      const mix = mixerLevels(n);
      // Slow master swell so walking up to a crowd is a fade-in rather than a
      // switch, and walking away is not a cut.
      ramp(master, mix.master, n > 0 ? 0.45 : 0.7);
      ramp(buses.drums, mix.drums);
      ramp(buses.bass, mix.bass);
      ramp(buses.pad, mix.pad);
      // Layer gains are stepped rather than continuous: somebody joining should
      // be an audible event, which a smooth curve on a headcount never is.
      ramp(buses.hats, mix.hats, 0.25);
      ramp(buses.lead, mix.lead, 0.3);
      ramp(buses.stabs, mix.stabs, 0.3);
    },
    setMuted(muted) {
      muteGain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
    },
    dispose() {
      window.clearInterval(timer);
      live = false;
      void ctx.close();
    },
  };
}

/**
 * How many layers `n` dancers unlock, purely for the HUD.
 *
 * Exported so the readout and the mixer cannot disagree about what the player
 * is hearing — the thresholds live in exactly one place.
 */
export function musicLayerCount(dancers: number): number {
  if (dancers <= 0) return 0;
  let n = 1;
  if (dancers >= LAYER_AT.hats) n++;
  if (dancers >= LAYER_AT.lead) n++;
  if (dancers >= LAYER_AT.stabs) n++;
  return n;
}

/**
 * The headcount that brings the next layer in, or null once the mix is full.
 *
 * `1` is in the list because the first dancer is itself a threshold — they
 * bring in the kick, the bass and the pad. Leaving it out made this answer
 * "two more" to a silent city, which is both wrong and the exact number the
 * HUD prints at the player.
 */
export function nextLayerAt(dancers: number): number | null {
  for (const at of [1, LAYER_AT.hats, LAYER_AT.lead, LAYER_AT.stabs]) {
    if (dancers < at) return at;
  }
  return null;
}
