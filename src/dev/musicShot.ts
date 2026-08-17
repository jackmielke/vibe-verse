/**
 * Waveform sheets for the dance track — a build-time tool, not part of the app.
 *
 * Nothing imports this. It is the audio half of the same argument
 * `danceShot.ts` makes about poses: a build, a typecheck and a smoke test all
 * pass while the music is silence, or a click every four bars, or a wall of
 * clipping — and the only person who would find out is the one who opened the
 * route with the volume up. I cannot listen to it. A waveform I can look at.
 *
 * It renders the *real* `buildMusicGraph` through an `OfflineAudioContext`,
 * which is why that function takes a `BaseAudioContext` instead of reaching
 * for `new AudioContext()` itself. What comes back is the exact sample stream
 * the city would produce, so the three things worth checking are checkable:
 *
 *   1. it makes a sound at all, and does not clip;
 *   2. the kicks land on the beat — the whole premise is that the music and
 *      the dances share a clock, and a scheduler that is half a step out
 *      breaks that silently;
 *   3. a bigger crowd is a bigger mix, layer by layer.
 */
import {
  MUSIC_PATTERN_STEPS,
  MUSIC_STEPS_PER_BEAT,
  buildMusicGraph,
  mixerLevels,
  type MusicBus,
} from "@/lib/cityMusic";
import { CITY_BPM } from "@/components/city/dances";

const SEC_PER_BEAT = 60 / CITY_BPM;
const SEC_PER_STEP = SEC_PER_BEAT / MUSIC_STEPS_PER_BEAT;

export interface MusicRender {
  dancers: number;
  seconds: number;
  sampleRate: number;
  peak: number;
  rms: number;
  /**
   * RMS split three ways, because overall RMS cannot see this mechanic.
   *
   * A kick carries almost all the energy in a dance track, so hats arriving —
   * which is the entire audible signal for "somebody joined you" — moves total
   * RMS by about three percent and looks like noise in the measurement. Split
   * by band and it is unmissable: the hats are the top band, the lead and
   * stabs the middle, the kick and bass the bottom.
   */
  bands: { low: number; mid: number; high: number };
  /** Which bus was soloed for this render, if any. */
  solo?: MusicBus;
  /** Onset times in seconds, from a crude energy detector. */
  onsets: number[];
  /**
   * Worst distance from any onset to the nearest sixteenth, in seconds.
   *
   * The sixteenth grid, not the beat: once the top layer put stabs on the
   * offbeat, a beat-only check started flagging the arrangement's own
   * syncopation as a timing bug — a false alarm that would have been "fixed"
   * by deleting the syncopation. Everything the arrangement plays is on this
   * grid, so this is the invariant that is actually true.
   *
   * For the kick specifically, solo the drums (see `shootMusic`) and the same
   * number becomes a beat check, because that bus only plays on beats.
   */
  worstGridError: number;
  samples: Float32Array;
}

/**
 * Render `seconds` of the track at a given crowd size, starting on a downbeat.
 *
 * The mix is set statically from `mixerLevels` rather than ramped, because the
 * question here is "what does a five-person crowd sound like", not "what does
 * the fade sound like" — and a 0.45s swell across a four-second render would
 * confound every measurement below.
 */
export async function renderMusic(
  dancers: number,
  seconds = 8,
  solo?: MusicBus,
): Promise<MusicRender> {
  const sampleRate = 44100;
  const ctx = new OfflineAudioContext(1, Math.ceil(sampleRate * seconds), sampleRate);
  const { master, buses, playStep } = buildMusicGraph(ctx, ctx.destination);

  const mix = mixerLevels(dancers);
  master.gain.value = mix.master;
  for (const [name, gain] of Object.entries(buses)) {
    gain.gain.value = solo && name !== solo ? 0 : (mix[name as keyof typeof mix] as number);
  }

  // Step 0 at t=0: the render starts on a downbeat, so "on the beat" means
  // "at a whole multiple of SEC_PER_BEAT" and the check below is exact.
  const steps = Math.ceil(seconds / SEC_PER_STEP);
  for (let i = 0; i < steps; i++) {
    playStep(i % MUSIC_PATTERN_STEPS, i * SEC_PER_STEP);
  }

  const buf = await ctx.startRendering();
  const samples = buf.getChannelData(0);

  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sumSq += samples[i] * samples[i];
  }

  const onsets = detectOnsets(samples, sampleRate);
  // Soloed drums only ever fire on beats, so grade that render against beats;
  // the full mix is graded against the sixteenth grid it is written on.
  const grid = solo === "drums" ? SEC_PER_BEAT : SEC_PER_STEP;
  let worstGridError = 0;
  for (const t of onsets) {
    const err = Math.abs(t - Math.round(t / grid) * grid);
    if (err > worstGridError) worstGridError = err;
  }

  return {
    dancers,
    seconds,
    sampleRate,
    peak,
    rms: Math.sqrt(sumSq / samples.length),
    bands: bandEnergies(samples, sampleRate),
    solo,
    onsets,
    worstGridError,
    samples,
  };
}

/**
 * Energy below 200 Hz, between 200 Hz and 2 kHz, and above.
 *
 * One-pole filters rather than an FFT: the boundaries are soft and the numbers
 * are not calibrated, which is fine — nothing here compares them to a
 * standard, only to the same measurement at a different crowd size.
 */
function bandEnergies(samples: Float32Array, sampleRate: number) {
  const onePole = (cutoff: number) => 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  const aLow = onePole(200);
  const aMid = onePole(2000);
  let low = 0;
  let mid = 0;
  let sLow = 0;
  let sMid = 0;
  let sumLow = 0;
  let sumMid = 0;
  let sumHigh = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    sLow += aLow * (x - sLow);          // < 200 Hz
    sMid += aMid * (x - sMid);          // < 2 kHz
    low = sLow;
    mid = sMid - sLow;                  // 200 Hz .. 2 kHz
    const high = x - sMid;              // > 2 kHz
    sumLow += low * low;
    sumMid += mid * mid;
    sumHigh += high * high;
  }
  const n = samples.length;
  return {
    low: Math.sqrt(sumLow / n),
    mid: Math.sqrt(sumMid / n),
    high: Math.sqrt(sumHigh / n),
  };
}

/**
 * Rough onset detection: short-window energy, and a peak counts when it jumps
 * well clear of the window before it.
 *
 * Deliberately crude — this is not trying to transcribe the track, only to ask
 * whether the loudest transients (which are the kicks; nothing else in the mix
 * is close) sit on beat boundaries. A dance track's kick is the easiest onset
 * in music to find, which is exactly why it is the one being measured.
 */
function detectOnsets(samples: Float32Array, sampleRate: number): number[] {
  const win = Math.floor(sampleRate * 0.01); // 10 ms
  const energies: number[] = [];
  for (let i = 0; i + win < samples.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += samples[j] * samples[j];
    energies.push(Math.sqrt(e / win));
  }
  const sorted = [...energies].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.6)] || 1e-6;
  const out: number[] = [];
  let cooldown = 0;
  for (let i = 1; i < energies.length; i++) {
    if (cooldown > 0) {
      cooldown--;
      continue;
    }
    if (energies[i] > floor * 3.2 && energies[i] > energies[i - 1] * 1.7) {
      out.push((i * win) / sampleRate);
      cooldown = Math.floor(0.12 / 0.01); // one onset per 120 ms at most
    }
  }
  return out;
}

/**
 * Draw one render as a waveform strip with the beat grid over it.
 *
 * The grid is the point. A waveform on its own says "there is sound"; a
 * waveform with beat lines says "and it is in time", which is the property
 * this whole feature is built on and the one no test output makes visible.
 */
export function waveformSheet(renders: MusicRender[], width = 1400, rowH = 130): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = rowH * renders.length;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0f1118";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  renders.forEach((r, row) => {
    const y0 = row * rowH;
    const mid = y0 + rowH / 2;

    // Beat grid, with the bar lines brighter.
    const beats = r.seconds / SEC_PER_BEAT;
    for (let b = 0; b <= beats; b++) {
      const x = (b / beats) * width;
      ctx.strokeStyle = b % 4 === 0 ? "rgba(140,200,255,0.45)" : "rgba(140,200,255,0.14)";
      ctx.beginPath();
      ctx.moveTo(x, y0 + 16);
      ctx.lineTo(x, y0 + rowH - 4);
      ctx.stroke();
    }

    // Waveform: min/max per pixel column, which is what makes a transient
    // visible at all at this scale.
    ctx.strokeStyle = "#73ffb8";
    ctx.beginPath();
    const per = r.samples.length / width;
    for (let x = 0; x < width; x++) {
      let lo = 0;
      let hi = 0;
      const from = Math.floor(x * per);
      const to = Math.min(r.samples.length, Math.floor((x + 1) * per));
      for (let i = from; i < to; i++) {
        if (r.samples[i] < lo) lo = r.samples[i];
        if (r.samples[i] > hi) hi = r.samples[i];
      }
      const h = (rowH / 2 - 22);
      ctx.moveTo(x + 0.5, mid - hi * h);
      ctx.lineTo(x + 0.5, mid - lo * h);
    }
    ctx.stroke();

    // Detected onsets, so a kick that has slid off the grid is obvious.
    ctx.fillStyle = "rgba(255,120,120,0.9)";
    for (const t of r.onsets) {
      const x = (t / r.seconds) * width;
      ctx.fillRect(x - 1, y0 + rowH - 10, 2, 6);
    }

    ctx.fillStyle = "#ffd166";
    ctx.font = "bold 12px monospace";
    ctx.fillText(
      `${r.solo ? `${r.solo} solo` : `${r.dancers} dancing`} · peak ${r.peak.toFixed(2)} · rms ${r.rms.toFixed(4)}` +
        ` · lo ${r.bands.low.toFixed(4)} mid ${r.bands.mid.toFixed(4)} hi ${r.bands.high.toFixed(4)}` +
        ` · worst off-grid ${(r.worstGridError * 1000).toFixed(1)}ms`,
      8,
      y0 + 13,
    );
  });
  return canvas.toDataURL("image/png");
}

/** Render the crowd sizes that change the mix, and sheet them together. */
export async function shootMusic(counts = [0, 1, 2, 3, 5], seconds = 8) {
  const renders: MusicRender[] = [];
  for (const n of counts) renders.push(await renderMusic(n, seconds));
  // One extra row with only the drums up. It is the row that answers the
  // question the whole feature rests on — is the thing a dancer locks to
  // actually on the beat — without the offbeat layers muddying the detector.
  renders.push(await renderMusic(5, seconds, "drums"));
  return {
    png: waveformSheet(renders),
    stats: renders.map((r) => ({
      dancers: r.dancers,
      solo: r.solo ?? null,
      peak: r.peak,
      rms: r.rms,
      bands: r.bands,
      onsets: r.onsets.length,
      worstGridErrorMs: r.worstGridError * 1000,
    })),
  };
}

declare global {
  interface Window {
    __shootMusic?: typeof shootMusic;
  }
}

if (typeof window !== "undefined") window.__shootMusic = shootMusic;
