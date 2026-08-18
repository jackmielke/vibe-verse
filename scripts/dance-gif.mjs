#!/usr/bin/env node
/**
 * dance-gif — record the dancers, so the timing can actually be judged.
 *
 *   node scripts/dance-gif.mjs                 # a row of four, each their own move
 *   node scripts/dance-gif.mjs floss           # all four doing the floss
 *   node scripts/dance-gif.mjs floss --straight  # ...with the groove switched off
 *
 * Writes `.dance-shots/gif-*.gif`. `dance-shots.mjs` answers "is the arm where
 * I meant it"; this answers "does it look like a person", which is entirely a
 * question about timing and entirely invisible in a still.
 *
 * The `--straight` flag is the control. Recording the same dance with the
 * groove off is the only way to tell whether the groove is doing anything —
 * two clips of four dancers both look plausible until you put them side by
 * side and see that one of them is four copies of one person.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.SF_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(process.cwd(), ".dance-shots");

const args = process.argv.slice(2);
const straight = args.includes("--straight");
const dance = args.find((a) => !a.startsWith("-")) ?? null;

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
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.evaluate(async () => {
  await import("/src/dev/danceGif.ts");
});

mkdirSync(OUT_DIR, { recursive: true });
// Four seconds is two bars at the city's tempo, so the clip loops on a bar
// line rather than mid-phrase.
const tag = `${dance ?? "mixed"}${straight ? "-straight" : ""}`;

// The filmstrip first, because it is the one a reviewer in a terminal can
// actually read: consecutive frames, so what changes between two of them is
// on the page rather than in the playback.
const strip = await page.evaluate(
  ([d, st]) => window.__shootDanceStrip({ dance: d ?? undefined, straight: st }),
  [dance, straight],
);
const stripFile = resolve(OUT_DIR, `strip-${tag}.png`);
writeFileSync(stripFile, Buffer.from(strip.split(",")[1], "base64"));
console.log(`wrote ${stripFile}`);

if (!process.argv.includes("--strip-only")) {
  const url = await page.evaluate(
    ([d, st]) => window.__shootDanceGif({ dance: d ?? undefined, straight: st, seconds: 4 }),
    [dance, straight],
  );
  const buf = Buffer.from(url.split(",")[1], "base64");
  const file = resolve(OUT_DIR, `gif-${tag}.gif`);
  writeFileSync(file, buf);
  console.log(`wrote ${file} (${Math.round(buf.length / 1024)} kB)`);
}

await browser.close();
if (server) server.kill();
