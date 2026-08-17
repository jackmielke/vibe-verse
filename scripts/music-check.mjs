#!/usr/bin/env node
/**
 * music-check — render the dance track offline and look at it.
 *
 *   node scripts/music-check.mjs
 *
 * Writes `.dance-shots/music.png`: one waveform row per crowd size, with the
 * beat grid drawn over it and detected onsets marked underneath. Prints peak,
 * RMS and the worst distance from an onset to a beat.
 *
 * This exists because the music is the one part of the feature nobody can
 * review. A silent track, a clipping track and a track a sixteenth off the
 * dances all pass every other check in the repo — and the last one is the
 * expensive failure, because the entire premise is that the beat you hear and
 * the beat everyone is dancing on are the same beat.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.SF_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(process.cwd(), ".dance-shots");

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server = (await up(BASE, 1200))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, BROWSER: "none" },
    });
if (server && !(await up(BASE, 120000))) {
  console.error("dev server never came up");
  process.exit(1);
}

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.evaluate(async () => {
  await import("/src/dev/musicShot.ts");
});

const { png, stats } = await page.evaluate(() => window.__shootMusic());

mkdirSync(OUT_DIR, { recursive: true });
const file = resolve(OUT_DIR, "music.png");
writeFileSync(file, Buffer.from(png.split(",")[1], "base64"));

let bad = 0;
for (const s of stats) {
  const flags = [];
  if (s.dancers === 0 && s.rms > 1e-5) flags.push("SHOULD BE SILENT");
  if (s.dancers > 0 && s.rms < 1e-3) flags.push("SILENT");
  // Headroom, not just "did it clip". The city plays chimes, thuds and a
  // jetpack over this; a track already at the rail leaves nowhere for them.
  if (s.peak > 0.8) flags.push("NO HEADROOM");
  if (s.dancers > 0 && s.worstGridErrorMs > 25) flags.push("OFF THE GRID");
  if (flags.length) bad++;
  console.log(
    `${(s.solo ? `${s.solo} solo` : `${s.dancers} dancing`).padStart(11)}  ` +
      `peak ${s.peak.toFixed(3)}  rms ${s.rms.toFixed(5)}  lo ${s.bands.low.toFixed(5)} ` +
      `mid ${s.bands.mid.toFixed(5)} hi ${s.bands.high.toFixed(5)}  ` +
      `worst off-grid ${s.worstGridErrorMs.toFixed(1)}ms  ` +
      (flags.join(" ") || "ok"),
  );
}

/*
 * A crowd has to sound bigger, and it has to sound bigger in the band the new
 * layer actually occupies. Total RMS is useless for this: the kick dominates
 * it, so hats arriving moves it by three percent, which is indistinguishable
 * from nothing. The bands are where each layer lives — hats on top, lead and
 * stabs in the middle — so that is where the arrival has to show up.
 */
const at = (n) => stats.find((s) => s.dancers === n && !s.solo);
const grew = (a, b, band, factor) =>
  a && b && b.bands[band] > a.bands[band] * factor;
const checks = [
  ["hats at 2 dancers", grew(at(1), at(2), "high", 1.5)],
  ["lead at 3 dancers", grew(at(2), at(3), "mid", 1.3)],
  ["stabs at 5 dancers", grew(at(3), at(5), "mid", 1.1)],
];
for (const [what, ok] of checks) {
  if (!ok) {
    console.log(`  INAUDIBLE: ${what} does not change the mix`);
    bad++;
  }
}
console.log(`wrote ${file}`);

await browser.close();
if (server) server.kill();
process.exit(bad ? 1 : 0);
