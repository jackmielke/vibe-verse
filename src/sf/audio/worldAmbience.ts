/**
 * audio/worldAmbience.ts — the sound of San Francisco.
 *
 * Ambience is the layer players never notice and always miss. It is also the
 * cheapest way to make an open world feel like a *place* rather than a level,
 * because it is the only system that is always running.
 *
 * Two mechanisms:
 *
 *  - **Beds.** Six looping, procedurally baked layers — traffic, sub-bass city
 *    rumble, wind, surf, crowd babble, park nature — each with its own filter,
 *    all head-locked stereo (an ambience bed is not a point source; putting one
 *    through a panner is how you get a city that swings around when you turn
 *    your head). Their levels are recomputed every frame from district, height
 *    above ground, time of day, fog density and how close the water is.
 *
 *  - **Punctuation.** Scheduled one-shots with real intervals: the Golden
 *    Gate's two-tone foghorn, gulls, cable-car bells on the Powell line, MUNI
 *    on Market, a ship in the channel, Grace Cathedral, jackhammers in SoMa on
 *    a weekday, sirens somewhere across town. These are what stop the beds
 *    from reading as a texture loop.
 *
 * Everything is keyed off `sfGeo` and `frame`, so it follows the player around
 * a real map with no authored trigger volumes anywhere.
 *
 * Public API
 * ----------
 *   worldAmbience.start() / stop() / update(dt) / setEnabled(b)
 *   worldAmbience.beds     — live levels, for the debug overlay
 *   playFoghorn / playSeagull / playCableCarBell / playDistantSiren
 */
import { clamp, clamp01, makeRng, smoothstep, type Rng } from "../math/rng";
import { frame, useSfStore } from "../state/store";
import {
  LANDMARK_BY_KEY,
  districtAt,
  isPark,
  isWater,
  landSDF,
  nearestStreet,
  terrainHeight,
} from "../geo/sfGeo";
import { audioEngine } from "./engine";
import { playBuffer, voicePool, scratchOptions, type Voice, type VoiceOptions } from "./spatial";
import {
  MODAL_LIBRARY,
  bakeSync,
  dcBlock,
  fillNoise,
  normalize,
  renderModal,
  softClip,
  svfSweep,
  type ModalSpec,
} from "./synth";

/* ================================================================== *
 * Loop helpers
 * ================================================================== */

/**
 * Make a buffer loop seamlessly by crossfading its tail over its head.
 *
 * Every bed here is stationary noise, so this is perceptually free — and
 * without it a 9-second loop clicks 6,400 times an hour, which players hear as
 * "something is wrong" long before they can name it.
 */
function loopFade(buf: Float32Array, sr: number, seconds = 0.35): void {
  const xf = Math.min(buf.length >> 1, Math.round(seconds * sr));
  if (xf < 8) return;
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    const tail = buf[buf.length - xf + i];
    buf[i] = buf[i] * t + tail * (1 - t);
  }
  // Trim the region we folded in so it is not heard twice.
  for (let i = 0; i < xf; i++) buf[buf.length - xf + i] = 0;
}

/** Sum of incommensurate sines — a cheap, deterministic slow LFO field. */
function slowMod(t: number, seed: number): number {
  return (
    0.5 +
    0.28 * Math.sin(t * 0.113 + seed) +
    0.14 * Math.sin(t * 0.271 + seed * 2.1) +
    0.08 * Math.sin(t * 0.617 + seed * 3.7)
  );
}

/* ================================================================== *
 * Beds
 * ================================================================== */

const BED_SECONDS = 9;

/**
 * Distant traffic.
 *
 * Not "cars": the *aggregate*. Hundreds of tyre contact patches and engines a
 * few blocks away sum into a broad low-mid hum that swells and ebbs as lights
 * change. The swell is the tell — a static hum reads as an air conditioner.
 */
function renderTrafficBed(chans: Float32Array[], sr: number, rng: Rng): void {
  const n = chans[0].length;
  for (let c = 0; c < chans.length; c++) {
    const d = chans[c];
    fillNoise(d, "pink", rng);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] *= 0.55 + 0.45 * slowMod(t + c * 7.3, 1.7 + c);
    }
    svfSweep(d, sr, 520, 480, 0.55, 0);

    // A handful of individual passes so the bed is not perfectly stationary.
    for (let k = 0; k < 5; k++) {
      const start = rng.range(0, BED_SECONDS - 2.2);
      const len = Math.round(rng.range(1.2, 2.1) * sr);
      const off = Math.round(start * sr);
      const pass = new Float32Array(len);
      fillNoise(pass, "pink", rng);
      for (let i = 0; i < len; i++) {
        const u = i / len;
        // Rise and fall — a car approaching and receding past you.
        pass[i] *= Math.exp(-Math.pow((u - 0.5) * 3.4, 2));
      }
      // Doppler-ish: the passband slides down through the pass.
      svfSweep(pass, sr, rng.range(900, 1500), rng.range(320, 520), 0.9, 1);
      const g = rng.range(0.15, 0.4) * (c === 0 ? 1 : 0.8);
      for (let i = 0; i < len && off + i < n; i++) d[off + i] += pass[i] * g;
    }

    dcBlock(d, sr, 22);
    normalize(d, 0.7);
    loopFade(d, sr);
  }
}

/** The sub-bass floor of a city: HVAC, transformers, the ground itself. */
function renderRumbleBed(chans: Float32Array[], sr: number, rng: Rng): void {
  const n = chans[0].length;
  for (let c = 0; c < chans.length; c++) {
    const d = chans[c];
    fillNoise(d, "brown", rng);
    svfSweep(d, sr, 74, 62, 0.7, 0);
    // 120 Hz mains hum, barely there, and its third harmonic. Cities buzz.
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] += (Math.sin(2 * Math.PI * 120 * t) * 0.035 + Math.sin(2 * Math.PI * 360 * t) * 0.012) *
        (0.6 + 0.4 * slowMod(t, 4.4 + c));
    }
    dcBlock(d, sr, 14);
    normalize(d, 0.8);
    loopFade(d, sr);
  }
}

/**
 * Wind.
 *
 * Gusts, not a hiss. The envelope is a slow noise field with a long attack and
 * a longer release, and the *filter* moves with it — a gust gets brighter as
 * it peaks because faster air past your ears makes more high-frequency
 * turbulence. That coupling is what makes synthesised wind believable.
 */
function renderWindBed(chans: Float32Array[], sr: number, rng: Rng): void {
  const n = chans[0].length;
  for (let c = 0; c < chans.length; c++) {
    const d = chans[c];
    fillNoise(d, "pink", rng);
    // Per-sample sweep coupled to the gust envelope.
    const svfBuf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const gust = clamp01(
        0.35 +
          0.45 * Math.sin(t * 0.19 + c * 2.1) +
          0.25 * Math.sin(t * 0.47 + c * 5.5) +
          0.15 * Math.sin(t * 1.13 + c),
      );
      svfBuf[i] = gust;
      d[i] *= 0.25 + gust * 0.95;
    }
    // Two-band shaping: a body around 300 Hz plus a whistle that only appears
    // at the top of a gust.
    const body = new Float32Array(d);
    svfSweep(body, sr, 340, 300, 0.8, 0);
    const whistle = new Float32Array(d);
    svfSweep(whistle, sr, 1900, 2400, 3.5, 1);
    for (let i = 0; i < n; i++) d[i] = body[i] * 0.9 + whistle[i] * svfBuf[i] * 0.5;
    dcBlock(d, sr, 26);
    normalize(d, 0.8);
    loopFade(d, sr);
  }
}

/** Surf on the seawall. Swell period ~9 s, which is why the loop is 9 s. */
function renderWaveBed(chans: Float32Array[], sr: number, rng: Rng): void {
  const n = chans[0].length;
  for (let c = 0; c < chans.length; c++) {
    const d = chans[c];
    d.fill(0);
    const base = new Float32Array(n);
    fillNoise(base, "brown", rng);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      base[i] *= 0.4 + 0.6 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 9 + c * 1.3));
    }
    svfSweep(base, sr, 420, 380, 0.6, 0);
    for (let i = 0; i < n; i++) d[i] += base[i] * 0.9;

    // Three breaks per loop: a bright hiss with a slow attack and a long
    // wash-back. This is the layer that says "ocean" rather than "static".
    for (let k = 0; k < 3; k++) {
      const start = (k / 3) * BED_SECONDS + rng.range(-0.6, 0.6);
      const off = Math.max(0, Math.round(start * sr));
      const len = Math.min(n - off, Math.round(rng.range(1.8, 3.0) * sr));
      if (len <= 32) continue;
      const br = new Float32Array(len);
      fillNoise(br, "white", rng);
      for (let i = 0; i < len; i++) {
        const u = i / len;
        br[i] *= Math.pow(clamp01(u / 0.14), 1.6) * Math.exp(-(u - 0.14) * 3.4);
      }
      svfSweep(br, sr, 3800, 700, 0.7, 1, (u) => Math.pow(u, 0.6));
      const g = rng.range(0.4, 0.9) * (c === 0 ? 1 : 0.85);
      for (let i = 0; i < len; i++) d[off + i] += br[i] * g;
    }
    dcBlock(d, sr, 30);
    normalize(d, 0.8);
    loopFade(d, sr);
  }
}

/**
 * Crowd babble.
 *
 * Built from formant pairs: a buzz at a plausible voice pitch through two
 * resonant bands at vowel formant frequencies. Individually unintelligible,
 * collectively unmistakably human — which is exactly right, because a crowd
 * you can understand is a crowd you start listening to.
 */
function renderCrowdBed(chans: Float32Array[], sr: number, rng: Rng): void {
  const n = chans[0].length;
  const VOWELS: [number, number][] = [
    [730, 1090],
    [530, 1840],
    [270, 2290],
    [570, 840],
    [440, 1020],
    [300, 870],
  ];
  for (let c = 0; c < chans.length; c++) {
    const d = chans[c];
    d.fill(0);
    for (let k = 0; k < 90; k++) {
      const start = rng.range(0, BED_SECONDS - 0.5);
      const dur = rng.range(0.12, 0.4);
      const off = Math.round(start * sr);
      const len = Math.min(n - off, Math.round(dur * sr));
      if (len <= 32) continue;
      const f0 = rng.range(85, 230);
      const [F1, F2] = rng.pick(VOWELS);
      const syl = new Float32Array(len);
      // Buzz source: a pulse train, which is what a glottis is.
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const drift = 1 + 0.06 * Math.sin((2 * Math.PI * i) / sr * rng.range(3, 6));
        phase += (f0 * drift) / sr;
        if (phase >= 1) phase -= 1;
        syl[i] = phase < 0.14 ? 1 - phase / 0.14 : -0.06;
      }
      const a = new Float32Array(syl);
      const b = new Float32Array(syl);
      svfSweep(a, sr, F1, F1 * rng.range(0.9, 1.15), 7, 1);
      svfSweep(b, sr, F2, F2 * rng.range(0.85, 1.2), 5, 1);
      const g = rng.range(0.1, 0.4);
      for (let i = 0; i < len; i++) {
        const u = i / len;
        const env = Math.sin(Math.PI * u) ** 1.3;
        d[off + i] += (a[i] * 0.7 + b[i] * 0.35) * env * g;
      }
    }
    // Footsteps and general shuffle under the voices.
    const bed = new Float32Array(n);
    fillNoise(bed, "pink", rng);
    svfSweep(bed, sr, 900, 700, 0.6, 1);
    for (let i = 0; i < n; i++) d[i] += bed[i] * 0.25;
    dcBlock(d, sr, 90);
    softClip(d, 1.2);
    normalize(d, 0.6);
    loopFade(d, sr);
  }
}

/** Park: leaves, and songbirds that are not gulls. */
function renderNatureBed(chans: Float32Array[], sr: number, rng: Rng): void {
  const n = chans[0].length;
  for (let c = 0; c < chans.length; c++) {
    const d = chans[c];
    fillNoise(d, "blue", rng);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] *= 0.3 + 0.7 * clamp01(0.4 + 0.5 * Math.sin(t * 0.31 + c) + 0.3 * Math.sin(t * 0.83));
    }
    svfSweep(d, sr, 2600, 3200, 0.55, 1);
    for (let i = 0; i < n; i++) d[i] *= 0.55;

    for (let k = 0; k < 14; k++) {
      const start = rng.range(0, BED_SECONDS - 0.4);
      const off = Math.round(start * sr);
      const len = Math.min(n - off, Math.round(rng.range(0.05, 0.22) * sr));
      if (len <= 16) continue;
      const f0 = rng.range(2200, 5200);
      const sweep = rng.range(-0.35, 0.45);
      const trill = rng.range(18, 42);
      let phase = 0;
      const g = rng.range(0.05, 0.22);
      for (let i = 0; i < len; i++) {
        const u = i / len;
        const f = f0 * (1 + sweep * u) * (1 + 0.06 * Math.sin(2 * Math.PI * trill * u));
        phase += (2 * Math.PI * f) / sr;
        d[off + i] += Math.sin(phase) * Math.sin(Math.PI * u) ** 2 * g;
      }
    }
    dcBlock(d, sr, 200);
    normalize(d, 0.55);
    loopFade(d, sr);
  }
}

type BedKey = "traffic" | "rumble" | "wind" | "waves" | "crowd" | "nature";

const BED_RENDERERS: Record<BedKey, (chans: Float32Array[], sr: number, rng: Rng) => void> = {
  traffic: renderTrafficBed,
  rumble: renderRumbleBed,
  wind: renderWindBed,
  waves: renderWaveBed,
  crowd: renderCrowdBed,
  nature: renderNatureBed,
};

/** Per-bed filter defaults; the update loop moves the cutoffs from there. */
const BED_FILTER: Record<BedKey, { type: BiquadFilterType; f: number; q: number }> = {
  traffic: { type: "lowpass", f: 900, q: 0.6 },
  rumble: { type: "lowpass", f: 200, q: 0.5 },
  wind: { type: "lowpass", f: 2400, q: 0.5 },
  waves: { type: "lowpass", f: 5000, q: 0.5 },
  crowd: { type: "lowpass", f: 3200, q: 0.5 },
  nature: { type: "lowpass", f: 8000, q: 0.5 },
};

class Bed {
  gain: GainNode;
  filter: BiquadFilterNode;
  src: AudioBufferSourceNode | null = null;
  level = 0;
  target = 0;

  constructor(
    readonly key: BedKey,
    ctx: AudioContext,
    dest: AudioNode,
  ) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    const f = BED_FILTER[key];
    this.filter = ctx.createBiquadFilter();
    this.filter.type = f.type;
    this.filter.frequency.value = f.f;
    this.filter.Q.value = f.q;
    this.filter.connect(this.gain);
    this.gain.connect(dest);

    const buf = bakeSync(ctx, `amb:${key}`, BED_SECONDS, 2, (ch, sr, rng) =>
      BED_RENDERERS[key](ch, sr, rng),
    );
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      // Loop the region we did not blank out in `loopFade`.
      src.loopStart = 0;
      src.loopEnd = buf.duration - 0.35;
      src.connect(this.filter);
      src.start(ctx.currentTime);
      this.src = src;
    }
  }

  stop(): void {
    try {
      this.src?.stop();
      this.src?.disconnect();
      this.filter.disconnect();
      this.gain.disconnect();
    } catch {
      /* graph gone */
    }
    this.src = null;
  }
}

/* ================================================================== *
 * Punctuation — one-shot renderers
 * ================================================================== */

/**
 * The Golden Gate foghorn.
 *
 * The bridge really does have two: a lower-pitched horn at mid-span and a
 * higher one at the south tower, and in fog they alternate. Physically it is a
 * diaphone — a harmonic-rich low tone with a slow attack, a long steady blast
 * and a distinctive downward "grunt" as the air pressure dies at the end.
 * That grunt is the whole character; a plain sine reads as a ferry.
 */
function renderFoghorn(out: Float32Array, sr: number, low: boolean, rng: Rng): void {
  const n = out.length;
  out.fill(0);
  const f0 = low ? 108 : 164;
  const blast = low ? 2.0 : 1.1;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // Pitch: rises a touch as it builds, then drops away at the end.
    const p =
      t < 0.25
        ? 0.965 + 0.035 * (t / 0.25)
        : t > blast
          ? 1 - 0.12 * clamp01((t - blast) / 0.55)
          : 1;
    const f = f0 * p;
    phase += (2 * Math.PI * f) / sr;
    // Attack over 180 ms, hold, release over 550 ms.
    const env =
      t < 0.18
        ? Math.pow(t / 0.18, 1.4)
        : t < blast
          ? 1
          : Math.max(0, 1 - (t - blast) / 0.6);
    if (env <= 0) break;
    // Harmonic stack with a slight beat between the two horn diaphragms.
    let v = 0;
    for (let h = 1; h <= 9; h++) {
      const amp = 1 / Math.pow(h, 1.35);
      v += Math.sin(phase * h + (h % 3) * 0.7) * amp;
    }
    v += Math.sin(phase * 1.006) * 0.4; // beating
    out[i] = v * env * 0.28;
  }
  softClip(out, 1.3);
  svfSweep(out, sr, 900, 620, 0.7, 0);
  dcBlock(out, sr, 30);
  // Breath: the air escaping around the diaphragm.
  {
    const air = new Float32Array(n);
    fillNoise(air, "pink", rng);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = t < 0.18 ? t / 0.18 : t < blast + 0.3 ? Math.exp(-(t - 0.18) * 1.4) : 0;
      air[i] *= env;
    }
    svfSweep(air, sr, 700, 400, 0.9, 1);
    for (let i = 0; i < n; i++) out[i] += air[i] * 0.12;
  }
  normalize(out, 0.9);
}

/** A gull. Three or four harsh syllables, each a formant-swept buzz. */
function renderSeagull(out: Float32Array, sr: number, rng: Rng): void {
  const n = out.length;
  out.fill(0);
  const syllables = rng.int(3, 5);
  let t = 0.03;
  for (let k = 0; k < syllables; k++) {
    const dur = rng.range(0.11, 0.24) * (k === 0 ? 1.3 : 1);
    const off = Math.round(t * sr);
    const len = Math.min(n - off, Math.round(dur * sr));
    if (len <= 32) break;
    const f0 = rng.range(620, 1000) * (1 - k * 0.06);
    const syl = new Float32Array(len);
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const u = i / len;
      // A gull's call bends up then down and is rough all the way through.
      const f = f0 * (1 + 0.5 * Math.sin(Math.PI * u)) * (1 + 0.1 * Math.sin(u * 60));
      phase += f / sr;
      if (phase >= 1) phase -= 1;
      syl[i] = (phase < 0.35 ? 1 : -0.5) * Math.sin(Math.PI * u) ** 0.8;
    }
    svfSweep(syl, sr, 1500, 2600, 4, 1);
    const g = rng.range(0.5, 1) * (k === 0 ? 1 : 0.8 - k * 0.1);
    for (let i = 0; i < len; i++) out[off + i] += syl[i] * g;
    t += dur + rng.range(0.05, 0.16);
    if (t * sr >= n) break;
  }
  dcBlock(out, sr, 300);
  normalize(out, 0.8);
}

/**
 * A cable car bell.
 *
 * Gripmen ring it in bursts, and it is a small, bright, very inharmonic bell —
 * the partials are nowhere near a harmonic series, which is what makes a bell
 * a bell rather than a chime.
 */
const BELL_SPEC: ModalSpec = {
  exciter: 0.0006,
  exciterKind: "white",
  noise: 0.15,
  tone: 16000,
  modes: [
    { f: 1180, decay: 1.1, gain: 0.9 },
    { f: 1770, decay: 0.85, gain: 1 },
    { f: 2520, decay: 0.6, gain: 0.7 },
    { f: 3480, decay: 0.42, gain: 0.5 },
    { f: 4720, decay: 0.3, gain: 0.32 },
    { f: 6350, decay: 0.2, gain: 0.2 },
    { f: 590, decay: 1.5, gain: 0.35 },
  ],
};

function renderCableBell(out: Float32Array, sr: number, rng: Rng): void {
  const n = out.length;
  out.fill(0);
  // The classic pattern: two quick strikes, a pause, then two more.
  const strikes = [0, 0.16, 0.44, 0.6, 0.88];
  const tmp = new Float32Array(Math.round(sr * 1.4));
  for (let k = 0; k < strikes.length; k++) {
    const off = Math.round(strikes[k] * sr);
    const len = Math.min(n - off, tmp.length);
    if (len <= 32) continue;
    renderModal(
      tmp.subarray(0, len),
      sr,
      {
        ...BELL_SPEC,
        modes: BELL_SPEC.modes.map((m) => ({
          f: m.f * rng.range(0.99, 1.01),
          decay: m.decay,
          gain: m.gain,
        })),
      },
      rng,
    );
    const g = rng.range(0.7, 1) * (k % 2 === 0 ? 1 : 0.8);
    for (let i = 0; i < len; i++) out[off + i] += tmp[i] * g;
  }
  dcBlock(out, sr, 120);
  normalize(out, 0.85);
}

/** A big church bell — Grace Cathedral, heard across Nob Hill. */
function renderChurchBell(out: Float32Array, sr: number, rng: Rng): void {
  renderModal(
    out,
    sr,
    {
      exciter: 0.004,
      exciterKind: "brown",
      noise: 0.1,
      tone: 9000,
      modes: [
        { f: 131, decay: 5.5, gain: 0.5 }, // hum
        { f: 262, decay: 4.5, gain: 1 }, // prime
        { f: 313, decay: 3.6, gain: 0.7 }, // minor third
        { f: 393, decay: 3.0, gain: 0.55 }, // fifth
        { f: 524, decay: 2.4, gain: 0.6 }, // nominal
        { f: 786, decay: 1.6, gain: 0.35 },
        { f: 1048, decay: 1.1, gain: 0.22 },
        { f: 1572, decay: 0.7, gain: 0.12 },
      ],
    },
    rng,
  );
  normalize(out, 0.9);
}

/** MUNI: DC traction whine sliding up, wheel flange squeal, wire clack. */
function renderMuniPass(out: Float32Array, sr: number, rng: Rng): void {
  const n = out.length;
  out.fill(0);
  const dur = n / sr;

  // Traction motor: a rising, then falling, harmonic whine.
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = t / dur;
    const f = 90 + 520 * Math.sin(Math.PI * Math.min(1, u * 1.25));
    phase += (2 * Math.PI * f) / sr;
    const env = Math.exp(-Math.pow((u - 0.5) * 2.6, 2));
    out[i] += (Math.sin(phase) * 0.5 + Math.sin(phase * 2) * 0.25 + Math.sin(phase * 3) * 0.12) * env * 0.35;
  }

  // Rolling stock + flange squeal on the curve.
  const roll = new Float32Array(n);
  fillNoise(roll, "pink", rng);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    roll[i] *= Math.exp(-Math.pow((u - 0.5) * 2.2, 2));
  }
  svfSweep(roll, sr, 1400, 500, 0.7, 1);
  for (let i = 0; i < n; i++) out[i] += roll[i] * 0.5;

  // A couple of pantograph clacks over the wire joints.
  for (let k = 0; k < 3; k++) {
    const off = Math.round(rng.range(0.15, 0.8) * n);
    const len = Math.min(n - off, Math.round(sr * 0.25));
    if (len <= 16) continue;
    const tmp = new Float32Array(len);
    renderModal(
      tmp,
      sr,
      {
        ...MODAL_LIBRARY.thinMetal,
        modes: MODAL_LIBRARY.thinMetal.modes.map((m) => ({
          f: m.f * rng.range(0.8, 1.4),
          decay: m.decay * 0.12,
          gain: m.gain,
        })),
        exciter: 0.0005,
      },
      rng,
    );
    for (let i = 0; i < len; i++) out[off + i] += tmp[i] * rng.range(0.15, 0.4);
  }
  dcBlock(out, sr, 40);
  normalize(out, 0.75);
}

/** A jackhammer. A pulse train at ~28 Hz through a metal resonance. */
function renderJackhammer(out: Float32Array, sr: number, rng: Rng): void {
  const n = out.length;
  out.fill(0);
  const rate = rng.range(24, 32);
  const period = Math.round(sr / rate);
  const burst = Math.round(sr * rng.range(0.9, 2.4));
  for (let i = 0; i < Math.min(n, burst); i += period) {
    const len = Math.min(n - i, Math.round(sr * 0.03));
    for (let j = 0; j < len; j++) {
      const t = j / sr;
      out[i + j] +=
        (Math.sin(2 * Math.PI * 190 * t) * 0.6 + (rng.next() * 2 - 1) * 0.9) *
        Math.exp(-t / 0.004);
    }
  }
  svfSweep(out, sr, 2600, 1100, 1.4, 1);
  softClip(out, 2);
  dcBlock(out, sr, 60);
  normalize(out, 0.7);
}

/** A ship's horn out in the channel. Very low, very long, very far away. */
function renderShipHorn(out: Float32Array, sr: number, rng: Rng): void {
  const n = out.length;
  out.fill(0);
  let phase = 0;
  const f0 = 74;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * f0 * (t > 2.4 ? 1 - 0.08 * (t - 2.4) : 1)) / sr;
    const env = t < 0.4 ? t / 0.4 : t < 2.4 ? 1 : Math.max(0, 1 - (t - 2.4) / 0.9);
    let v = 0;
    for (let h = 1; h <= 7; h++) v += Math.sin(phase * h) / Math.pow(h, 1.5);
    out[i] = v * env * 0.3;
  }
  softClip(out, 1.2);
  svfSweep(out, sr, 420, 300, 0.7, 0);
  dcBlock(out, sr, 24);
  void rng;
  normalize(out, 0.9);
}

/** A siren several blocks away: already filtered by distance and buildings. */
function renderDistantSiren(out: Float32Array, sr: number, rng: Rng): void {
  const n = out.length;
  out.fill(0);
  const dur = n / sr;
  let phase = 0;
  const wail = rng.range(0.32, 0.45);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 760 + 300 * Math.sin(2 * Math.PI * wail * t);
    phase += (2 * Math.PI * f) / sr;
    const u = t / dur;
    // Fades in and out as it moves along a street you cannot see.
    const env = Math.exp(-Math.pow((u - 0.5) * 2.4, 2));
    out[i] = (Math.sin(phase) + 0.3 * Math.sin(phase * 2)) * env * 0.4;
  }
  svfSweep(out, sr, 1500, 900, 0.8, 0);
  dcBlock(out, sr, 120);
  normalize(out, 0.6);
}

/* ================================================================== *
 * One-shot playback helpers
 * ================================================================== */

function oneShot(
  key: string,
  seconds: number,
  render: (out: Float32Array, sr: number, rng: Rng) => void,
  x: number,
  y: number,
  z: number,
  gain: number,
  loudness: number,
  pitch = 1,
): void {
  const ctx = audioEngine.ctx;
  if (!ctx) return;
  const buf = bakeSync(ctx, key, seconds, 1, (ch, sr, rng) => render(ch[0], sr, rng));
  if (!buf) return;
  const o = scratchOptions as VoiceOptions;
  o.x = x;
  o.y = y;
  o.z = z;
  o.vx = 0;
  o.vy = 0;
  o.vz = 0;
  o.bus = "world";
  o.local = false;
  o.gain = gain;
  o.pitch = pitch;
  o.priority = 0.2;
  o.loudness = loudness;
  o.propagate = false;
  o.noOcclusion = false;
  o.when = undefined;
  playBuffer(buf, o);
}

const ambRng = makeRng("sf-audio:ambience");

/** The Golden Gate's two-tone horn. `low` selects the mid-span diaphone. */
export function playFoghorn(low: boolean): void {
  const gg = LANDMARK_BY_KEY["golden-gate"];
  if (!gg) return;
  oneShot(
    `amb:foghorn:${low ? "lo" : "hi"}`,
    low ? 3.0 : 2.1,
    (out, sr, rng) => renderFoghorn(out, sr, low, rng),
    gg.x,
    60,
    gg.z,
    1.15,
    5200,
    1,
  );
}

export function playSeagull(x: number, y: number, z: number): void {
  const variant = ambRng.int(0, 3);
  oneShot(
    `amb:gull:${variant}`,
    1.4,
    renderSeagull,
    x,
    y,
    z,
    0.4,
    260,
    ambRng.range(0.88, 1.15),
  );
}

export function playCableCarBell(x: number, y: number, z: number): void {
  oneShot(`amb:bell:${ambRng.int(0, 2)}`, 2.4, renderCableBell, x, y, z, 0.55, 420, ambRng.range(0.96, 1.05));
}

export function playChurchBell(x: number, y: number, z: number): void {
  oneShot("amb:churchbell", 6, renderChurchBell, x, y, z, 0.7, 1400, 1);
}

export function playMuniPass(x: number, y: number, z: number): void {
  oneShot(`amb:muni:${ambRng.int(0, 2)}`, 5, renderMuniPass, x, y, z, 0.5, 320, ambRng.range(0.94, 1.08));
}

export function playJackhammer(x: number, y: number, z: number): void {
  oneShot(`amb:jack:${ambRng.int(0, 3)}`, 3, renderJackhammer, x, y, z, 0.42, 300, ambRng.range(0.9, 1.12));
}

export function playShipHorn(x: number, y: number, z: number): void {
  oneShot("amb:shiphorn", 4, renderShipHorn, x, y, z, 0.8, 4000, ambRng.range(0.95, 1.06));
}

export function playDistantSiren(x: number, y: number, z: number): void {
  oneShot(`amb:siren:${ambRng.int(0, 2)}`, 7, renderDistantSiren, x, y, z, 0.5, 900, ambRng.range(0.92, 1.1));
}

/* ================================================================== *
 * The ambience system
 * ================================================================== */

interface Cue {
  key: string;
  /** Seconds until the next attempt. */
  next: number;
  /** Returns the interval to the following attempt. */
  interval: (ctxWeight: number) => number;
  /** 0..1 — how appropriate this cue is right now. 0 disables it. */
  weight: () => number;
  fire: () => void;
}

/** Districts whose crowd bed should be loud even at 3 a.m. */
const NIGHTLIFE = new Set(["northbeach", "mission", "castro", "soma", "chinatown", "haight"]);
/** Districts with heavy daytime construction. */
const CONSTRUCTION = new Set(["soma", "mission", "dogpatch", "bayview", "rincon", "civiccenter"]);

class WorldAmbience {
  private beds: Partial<Record<BedKey, Bed>> = {};
  private busIn: GainNode | null = null;
  private voice: Voice | null = null;
  private started = false;
  private enabled = true;
  private cues: Cue[] = [];
  private rng: Rng = makeRng("sf-audio:cues");

  /** Wingsuit / freefall wind roar — its own chain, driven by airspeed. */
  private roarSrc: AudioBufferSourceNode | null = null;
  private roarGain: GainNode | null = null;
  private roarLp: BiquadFilterNode | null = null;
  private roarHp: BiquadFilterNode | null = null;

  /** Live bed levels, for the debug overlay. */
  readonly levels: Record<string, number> = {};

  start(): boolean {
    if (this.started) return true;
    const ctx = audioEngine.ctx;
    if (!ctx || !audioEngine.available) return false;

    // One held, head-locked voice carries every bed. Ambience must not pan
    // with head movement and must never be stolen.
    const o = scratchOptions as VoiceOptions;
    o.x = 0;
    o.y = 0;
    o.z = 0;
    o.local = true;
    o.pan = 0;
    o.bus = "world";
    o.gain = 1;
    o.pitch = 1;
    o.priority = 1;
    o.noOcclusion = true;
    o.propagate = false;
    o.duration = 1e9;
    const v = voicePool.acquire(o);
    o.local = false;
    o.noOcclusion = false;
    o.duration = undefined;
    if (!v) return false;
    v.hold = true;
    this.voice = v;
    this.busIn = v.input;

    for (const k of Object.keys(BED_RENDERERS) as BedKey[]) {
      this.beds[k] = new Bed(k, ctx, this.busIn);
    }

    this.buildRoar(ctx);
    this.buildCues();
    this.started = true;
    return true;
  }

  private buildRoar(ctx: AudioContext): void {
    if (!this.busIn) return;
    const buf = bakeSync(ctx, "amb:roar", 6, 2, (ch, sr, rng) => {
      for (const d of ch) {
        fillNoise(d, "pink", rng);
        // Broadband with a strong low-mid shelf — freefall wind is a *roar*,
        // not a hiss. The hiss only appears at very high airspeed.
        svfSweep(d, sr, 500, 460, 0.7, 0);
        normalize(d, 0.9);
        loopFade(d, sr, 0.4);
      }
    });
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopEnd = buf.duration - 0.4;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 60;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 400;
    lp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(hp);
    hp.connect(lp);
    lp.connect(g);
    g.connect(this.busIn);
    src.start(ctx.currentTime);
    this.roarSrc = src;
    this.roarGain = g;
    this.roarLp = lp;
    this.roarHp = hp;
  }

  private buildCues(): void {
    const r = this.rng;
    const pos = () => frame.position;

    this.cues = [
      {
        key: "foghorn",
        next: r.range(4, 16),
        // The real horns sound on a fixed schedule in fog; heavier fog does
        // not make them more frequent, it makes them audible further away.
        interval: () => r.range(18, 26),
        weight: () => {
          const p = pos();
          const gg = LANDMARK_BY_KEY["golden-gate"];
          if (!gg) return 0;
          const d = Math.hypot(p.x - gg.x, p.z - gg.z);
          const fog = clamp01((frame.fogDensity - 0.18) / 0.5);
          return fog * smoothstep(6500, 2200, d);
        },
        fire: () => {
          // Two-tone: mid-span low, south tower high, one after the other.
          playFoghorn(true);
          const hi = 2.6;
          setTimeoutSafe(() => playFoghorn(false), hi);
        },
      },
      {
        key: "gull",
        next: r.range(2, 9),
        interval: (w) => r.range(3, 14) / clamp(w, 0.2, 1),
        weight: () => {
          const p = pos();
          // Gulls are at the water and at anything that sells food outdoors.
          const sdf = landSDF(p.x, p.z);
          const near = smoothstep(420, 40, Math.abs(sdf));
          const d = districtAt(p.x, p.z);
          const bonus = d.key === "embarcadero" || d.key === "marina" ? 0.4 : 0;
          const night = frame.timeOfDay < 5.5 || frame.timeOfDay > 21 ? 0.15 : 1;
          return clamp01(near + bonus) * night;
        },
        fire: () => {
          const p = pos();
          const a = r.range(0, Math.PI * 2);
          const dist = r.range(15, 90);
          const x = p.x + Math.cos(a) * dist;
          const z = p.z + Math.sin(a) * dist;
          playSeagull(x, terrainHeight(x, z) + r.range(8, 40), z);
        },
      },
      {
        key: "cablecar",
        next: r.range(6, 20),
        interval: () => r.range(14, 40),
        weight: () => {
          const p = pos();
          const d = districtAt(p.x, p.z);
          // The Powell and California lines run through these four.
          const onLine =
            d.key === "nobhill" || d.key === "chinatown" || d.key === "russianhill" || d.key === "fidi";
          return onLine ? 1 : 0.08;
        },
        fire: () => {
          const p = pos();
          const a = r.range(0, Math.PI * 2);
          const dist = r.range(30, 160);
          const x = p.x + Math.cos(a) * dist;
          const z = p.z + Math.sin(a) * dist;
          playCableCarBell(x, terrainHeight(x, z) + 2, z);
        },
      },
      {
        key: "muni",
        next: r.range(10, 30),
        interval: () => r.range(24, 70),
        weight: () => {
          const p = pos();
          const st = nearestStreet(p.x, p.z);
          // Only near a real arterial — MUNI does not run down alleys.
          return st.roadClass === "arterial" || st.roadClass === "boulevard"
            ? smoothstep(120, 20, st.distance)
            : 0;
        },
        fire: () => {
          const p = pos();
          const a = r.range(0, Math.PI * 2);
          const dist = r.range(40, 140);
          const x = p.x + Math.cos(a) * dist;
          const z = p.z + Math.sin(a) * dist;
          playMuniPass(x, terrainHeight(x, z) + 2.5, z);
        },
      },
      {
        key: "jackhammer",
        next: r.range(5, 25),
        interval: () => r.range(4, 18),
        weight: () => {
          const p = pos();
          const hour = frame.timeOfDay;
          if (hour < 7.5 || hour > 17.5) return 0;
          return CONSTRUCTION.has(districtAt(p.x, p.z).key) ? 0.9 : 0.05;
        },
        fire: () => {
          const p = pos();
          const a = r.range(0, Math.PI * 2);
          const dist = r.range(50, 220);
          const x = p.x + Math.cos(a) * dist;
          const z = p.z + Math.sin(a) * dist;
          playJackhammer(x, terrainHeight(x, z) + 3, z);
        },
      },
      {
        key: "shiphorn",
        next: r.range(30, 120),
        interval: () => r.range(90, 260),
        weight: () => {
          const p = pos();
          return smoothstep(2000, 300, Math.abs(landSDF(p.x, p.z)));
        },
        fire: () => {
          const p = pos();
          const a = r.range(0, Math.PI * 2);
          const dist = r.range(500, 2200);
          playShipHorn(p.x + Math.cos(a) * dist, 12, p.z + Math.sin(a) * dist);
        },
      },
      {
        key: "siren",
        next: r.range(20, 60),
        // Heat raises the frequency dramatically — the city knows what you did.
        interval: (w) => r.range(12, 55) / clamp(w, 0.15, 3),
        weight: () => {
          const heat = useSfStore.getState().heat;
          const base = frame.timeOfDay > 20 || frame.timeOfDay < 4 ? 0.5 : 0.3;
          return clamp(base + heat * 0.7, 0, 3);
        },
        fire: () => {
          const p = pos();
          const a = r.range(0, Math.PI * 2);
          const dist = r.range(250, 900);
          const x = p.x + Math.cos(a) * dist;
          const z = p.z + Math.sin(a) * dist;
          playDistantSiren(x, terrainHeight(x, z) + 2, z);
        },
      },
      {
        key: "churchbell",
        next: r.range(60, 400),
        interval: () => r.range(300, 900),
        weight: () => {
          const p = pos();
          const grace = LANDMARK_BY_KEY["grace"];
          if (!grace) return 0;
          const d = Math.hypot(p.x - grace.x, p.z - grace.z);
          const hour = frame.timeOfDay;
          if (hour < 8 || hour > 20) return 0;
          return smoothstep(1800, 400, d);
        },
        fire: () => {
          const grace = LANDMARK_BY_KEY["grace"];
          if (grace) playChurchBell(grace.x, terrainHeight(grace.x, grace.z) + 45, grace.z);
        },
      },
    ];
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  stop(): void {
    if (!this.started) return;
    for (const b of Object.values(this.beds)) b?.stop();
    this.beds = {};
    try {
      this.roarSrc?.stop();
      this.roarSrc?.disconnect();
      this.roarHp?.disconnect();
      this.roarLp?.disconnect();
      this.roarGain?.disconnect();
    } catch {
      /* graph gone */
    }
    this.roarSrc = null;
    this.roarGain = null;
    this.roarLp = null;
    this.roarHp = null;
    if (this.voice) {
      this.voice.hold = false;
      voicePool.release(this.voice);
      this.voice = null;
    }
    this.busIn = null;
    this.started = false;
  }

  /**
   * Recompute every bed level from where the player is and what time it is.
   *
   * All of it is smoothed with `setTargetAtTime`, so walking from Chinatown
   * into the Broadway tunnel is a continuous change of mix rather than a
   * sequence of trigger volumes.
   */
  update(dt: number): void {
    if (!this.started || !this.enabled || !audioEngine.ctx) return;
    const ctx = audioEngine.ctx;
    const now = ctx.currentTime;
    const p = frame.position;

    const agl = Math.max(0, p.y - terrainHeight(p.x, p.z));
    const district = districtAt(p.x, p.z);
    const street = nearestStreet(p.x, p.z);
    const water = landSDF(p.x, p.z); // negative = inland
    const overWater = isWater(p.x, p.z);
    const park = isPark(p.x, p.z);
    const hour = frame.timeOfDay;
    const fog = clamp01(frame.fogDensity);
    const speed = frame.speed;

    // Time-of-day activity curve: a broad daytime plateau, a rush-hour bump
    // at each end, and a floor at night that never reaches zero (this is a
    // city, not a village).
    const dayCurve =
      0.22 +
      0.78 *
        clamp01(
          smoothstep(5.0, 8.0, hour) * smoothstep(23.5, 20.0, hour) +
            0.25 * Math.exp(-Math.pow((hour - 8.3) / 1.1, 2)) +
            0.3 * Math.exp(-Math.pow((hour - 17.6) / 1.3, 2)),
        );

    // Altitude: at 200 m the street is gone and all that is left is wind and
    // a low roar. This single curve is most of what makes climbing a tower
    // feel like climbing a tower.
    const altFade = smoothstep(260, 30, agl);
    const altWind = smoothstep(0, 220, agl);

    const streetFactor = smoothstep(90, 12, street.distance);
    const densityFactor = clamp01(district.density);

    /* ---- traffic ---- */
    this.setBed(
      "traffic",
      now,
      dayCurve * densityFactor * (0.35 + streetFactor * 0.65) * altFade * (overWater ? 0.25 : 1) * 0.55,
      // Traffic heard from above and from far away has lost its top end.
      420 + streetFactor * 1500 - agl * 1.2,
    );

    /* ---- rumble ---- */
    // The rumble never fully leaves; it is the floor of the whole mix and it
    // is what you hear on a rooftop at 3 a.m.
    this.setBed("rumble", now, (0.16 + densityFactor * 0.22) * (0.45 + dayCurve * 0.55) * 0.9, 220);

    /* ---- wind ---- */
    // Wind rises with height, with the base weather wind, and — the fun part —
    // with your own airspeed. A wingsuit at 90 m/s is a hurricane.
    const airspeed = clamp01((speed - 4) / 26);
    const windLevel =
      (0.1 + altWind * 0.62 + clamp01(frame.windSpeed / 18) * 0.28) * (park ? 1.15 : 1);
    this.setBed("wind", now, windLevel * 0.75, 700 + altWind * 2600 + airspeed * 2200);

    /* ---- waves ---- */
    const shoreDist = Math.abs(water);
    this.setBed(
      "waves",
      now,
      (overWater ? 0.6 : smoothstep(340, 15, shoreDist) * 0.55) * (0.7 + fog * 0.3),
      2200 + smoothstep(300, 10, shoreDist) * 3200,
    );

    /* ---- crowd ---- */
    const nightlife = NIGHTLIFE.has(district.key);
    const crowdTime = nightlife
      ? Math.max(dayCurve, hour > 19 || hour < 2.5 ? 0.85 : 0.35)
      : dayCurve;
    this.setBed(
      "crowd",
      now,
      crowdTime * densityFactor * streetFactor * altFade * (park ? 0.5 : 1) * (overWater ? 0 : 1) * 0.5,
      1400 + streetFactor * 2400,
    );

    /* ---- nature ---- */
    const dawn = clamp01(smoothstep(4.8, 7.2, hour) * smoothstep(20.5, 17.5, hour));
    this.setBed(
      "nature",
      now,
      (park ? 0.85 : district.density < 0.4 ? 0.25 : 0.05) * (0.35 + dawn * 0.75) * altFade * 0.55,
      9000,
    );

    /* ---- wind roar ---- */
    if (this.roarGain && this.roarLp && this.roarHp) {
      // Only in real flight: a sprint should not sound like a dive.
      const flying =
        frame.movement === "wingsuit" ||
        frame.movement === "airborne" ||
        frame.movement === "parachute";
      const v = flying ? clamp01((speed - 12) / 60) : 0;
      const gain = Math.pow(v, 1.35) * 0.85;
      this.roarGain.gain.setTargetAtTime(gain, now, 0.12);
      // At terminal velocity the roar is broadband; at 20 m/s it is all low.
      this.roarLp.frequency.setTargetAtTime(400 + v * 5200, now, 0.15);
      this.roarHp.frequency.setTargetAtTime(50 + v * 90, now, 0.2);
    }

    /* ---- punctuation ---- */
    for (const cue of this.cues) {
      cue.next -= dt;
      if (cue.next > 0) continue;
      const w = cue.weight();
      if (w <= 0.02) {
        // Not appropriate right now; check again shortly rather than firing.
        cue.next = 4 + this.rng.next() * 6;
        continue;
      }
      if (this.rng.next() < clamp01(w)) cue.fire();
      cue.next = Math.max(1.5, cue.interval(w));
    }
  }

  private setBed(key: BedKey, now: number, target: number, cutoff: number): void {
    const bed = this.beds[key];
    if (!bed) return;
    bed.target = clamp01(target);
    this.levels[key] = bed.target;
    // Slow gain moves (0.4 s) so a district boundary is a fade, not a cut;
    // filters move faster because they track altitude and speed.
    bed.gain.gain.setTargetAtTime(bed.target, now, 0.4);
    bed.filter.frequency.setTargetAtTime(clamp(cutoff, 80, 18000), now, 0.25);
  }
}

/**
 * Deferred callback without leaking timers on teardown.
 *
 * The foghorn's second tone is 2.6 s after the first and there is no good way
 * to express that with a single buffer (the interval jitters). One tracked
 * timeout is cheaper than a scheduler.
 */
const timers = new Set<ReturnType<typeof setTimeout>>();
function setTimeoutSafe(fn: () => void, seconds: number): void {
  const id = setTimeout(() => {
    timers.delete(id);
    try {
      fn();
    } catch {
      /* audio gone */
    }
  }, seconds * 1000);
  timers.add(id);
}

/** Cancel every deferred cue. Called on teardown. */
export function clearAmbienceTimers(): void {
  for (const id of timers) clearTimeout(id);
  timers.clear();
}

export const worldAmbience = new WorldAmbience();

/** Pre-bake the beds; they are the most expensive thing in the audio system. */
export async function primeAmbience(): Promise<void> {
  const ctx = audioEngine.ctx;
  if (!ctx) return;
  for (const k of Object.keys(BED_RENDERERS) as BedKey[]) {
    bakeSync(ctx, `amb:${k}`, BED_SECONDS, 2, (ch, sr, rng) => BED_RENDERERS[k](ch, sr, rng));
    await Promise.resolve();
  }
}
