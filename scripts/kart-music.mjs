#!/usr/bin/env node
/**
 * kart-music — render the score offline and measure it.
 *
 * The sequencer schedules onto an AudioContext clock, so the only honest way to
 * hear it outside a browser is to run it in one. This boots a page against the
 * dev server, imports `src/kart/audio/music.ts` through Vite, drives the rig
 * inside an OfflineAudioContext (stepping it with `suspend`/`resume` so the
 * 220 ms lookahead still works), and writes a WAV.
 *
 * It also prints the numbers that matter for "does this hurt to listen to":
 * peak, RMS, crest factor, and the share of energy in the 2–8 kHz band the ear
 * is most sensitive to. A mix that is 40% harsh-band is a mix that is shouting.
 *
 * Usage: node scripts/kart-music.mjs [--track race] [--seconds 24] [--out music.wav]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const track = flag("track", "race");
const seconds = Number(flag("seconds", 24));
const out = flag("out", null);

const PORT = Number(process.env.KART_PORT ?? 5178);
const BASE = `http://127.0.0.1:${PORT}`;

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const server = (await up(BASE, 1200))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, BROWSER: "none" },
    });
if (server && !(await up(BASE, 180000))) {
  console.error("dev server never came up");
  process.exit(1);
}

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome"].find(
  (p) => existsSync(p),
);
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=4096"],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.setDefaultTimeout(600000);
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("console:", m.text());
});

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 180000 });

const result = await page.evaluate(async ({ track, seconds, wantWav }) => {
  const music = await import("/src/kart/audio/music.ts");
  const graphMod = await import("/src/kart/audio/graph.ts");

  const SR = 44100;
  const oac = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  // The rig bails while the context is not "running"; offline rendering never
  // reports that, so shadow the getter with the answer it wants.
  Object.defineProperty(oac, "state", { get: () => "running", configurable: true });

  let seed = 12345;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // A stand-in for the live graph: the same buses, the same trims, no reverb
  // bank (its tail is a wash, not a thing you can measure a mix by).
  const master = oac.createGain();
  master.gain.value = graphMod.BUS_GAIN.master;
  const limiter = oac.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.22;
  master.connect(limiter).connect(oac.destination);

  const musicBus = oac.createGain();
  musicBus.gain.value = graphMod.BUS_GAIN.music;
  musicBus.connect(master);
  const sfx = oac.createGain();
  sfx.gain.value = graphMod.BUS_GAIN.sfx;
  sfx.connect(master);
  const send = oac.createGain();
  send.gain.value = 0.0001; // measured dry
  send.connect(master);

  const n = Math.floor(SR * 2);
  const noise = oac.createBuffer(1, n, SR);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < n; i++) nd[i] = rng() * 2 - 1;

  const g = {
    ac: oac, master, sfx, engine: sfx, music: musicBus, send, wet: master,
    noise, spatial: false, stereo: true, quality: "high", rng,
    budget: 64, voices: 0, voicesAt: 0, owned: [],
  };

  const rig = music.createMusicRig(g);
  rig.set(track);

  // Step the sequencer on the render clock: suspend every ~93 ms, push the
  // notes whose time falls in the lookahead window, resume.
  //
  // The step has to be a whole number of 128-sample render quanta — Chrome
  // rejects a suspend that does not land on a quantum boundary, and a rejected
  // suspend means a resume that never fires and a render that never finishes.
  const QUANTA = 32; // 4096 frames ≈ 93 ms at 44.1 kHz
  const STEP = (QUANTA * 128) / SR;
  rig.update(); // prime the first lookahead window before the clock starts
  for (let t = STEP; t < seconds; t += STEP) {
    oac.suspend(t).then(
      () => {
        rig.update();
        void oac.resume();
      },
      () => {
        /* a boundary the context would not take — the next one covers it */
      },
    );
  }

  const buf = await oac.startRendering();
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;

  // --- measurements -------------------------------------------------------
  let peak = 0;
  let sum = 0;
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const v = (L[i] + R[i]) * 0.5;
    mono[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / L.length);

  // Octave-ish band energy by Goertzel-free brute FFT on windowed chunks.
  const N = 4096;
  const bands = [
    ["<200", 0, 200], ["200-800", 200, 800], ["0.8-2k", 800, 2000],
    ["2-8k (harsh)", 2000, 8000], [">8k", 8000, SR / 2],
  ];
  const energy = bands.map(() => 0);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let frames = 0;
  for (let off = 0; off + N <= mono.length; off += N * 4) {
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = mono[off + i] * w;
      im[i] = 0;
    }
    // Iterative radix-2 FFT.
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    for (let k = 1; k < N / 2; k++) {
      const f = (k * SR) / N;
      const p = re[k] * re[k] + im[k] * im[k];
      for (let b = 0; b < bands.length; b++) {
        if (f >= bands[b][1] && f < bands[b][2]) { energy[b] += p; break; }
      }
    }
    frames++;
  }
  const totalE = energy.reduce((a, b) => a + b, 0) || 1;
  const spectrum = bands.map((b, i) => [b[0], +((energy[i] / totalE) * 100).toFixed(1)]);

  // 16-bit WAV, so it can actually be listened to.
  const len = L.length;
  const bytes = new ArrayBuffer(44 + len * 4);
  const view = new DataView(bytes);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, 36 + len * 4, true); str(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, SR, true); view.setUint32(28, SR * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, len * 4, true);
  for (let i = 0; i < len; i++) {
    view.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    view.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  // Chunked base64 — a 20 s stereo WAV is 3.5 MB and String.fromCharCode
  // applied to the whole array blows the argument limit.
  let bin = "";
  if (wantWav) {
    const u8 = new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
  }

  return {
    peak: +peak.toFixed(4),
    rms: +rms.toFixed(4),
    crest: +(20 * Math.log10(peak / (rms || 1e-9))).toFixed(1),
    rmsDb: +(20 * Math.log10(rms || 1e-9)).toFixed(1),
    spectrum,
    wav: wantWav ? btoa(bin) : null,
  };
}, { track, seconds, wantWav: !!out });

console.log(`track=${track}  seconds=${seconds}`);
console.log(`peak=${result.peak}  rms=${result.rms} (${result.rmsDb} dBFS)  crest=${result.crest} dB`);
console.log("band share of energy:");
for (const [name, pct] of result.spectrum) console.log(`  ${name.padEnd(14)} ${String(pct).padStart(5)}%`);

if (out && result.wav) {
  writeFileSync(out, Buffer.from(result.wav, "base64"));
  console.log(`\nwrote ${out}`);
}

await browser.close();
if (server) server.kill();
