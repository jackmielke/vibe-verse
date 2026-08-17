#!/usr/bin/env node
/**
 * city-perf — what did all this cost?
 *
 *     node scripts/city-perf.mjs [--port N] [--label NAME]
 *
 * Three commits' worth of work went into `/city` — caustics patched into the
 * seabed, light shafts, motes, three schools of fish, an offshore shelf, four
 * particle pools for spray, bubbles, fire and smoke, a point light for the
 * fireball, and free-flight physics for knocked cars — and none of it was ever
 * measured. `/city` was already the heaviest route in the repo. "It still
 * builds" is not the same claim as "it still runs".
 *
 * ## How it measures
 *
 * By sampling `requestAnimationFrame` deltas from inside the page, injected at
 * runtime. Deliberately NOT through a debug hook: the whole point is to run the
 * identical script against an OLD commit that has no such hook, and a
 * measurement that only works on the new code cannot tell you what the new code
 * cost. Everything here is vanilla DOM.
 *
 * ## What the numbers mean
 *
 * This runs on SwiftShader — software rasterisation on the CPU. Absolute
 * milliseconds are meaningless; nobody's phone is this slow and nobody's
 * desktop is this uniform. What it IS good for is the ratio between two builds
 * of the same scene, and it is unusually sensitive to exactly the kind of
 * regression worth catching here: per-fragment cost. An extra point light, an
 * extra shader branch and a screenful of overdraw all show up loudly. Extra
 * triangles show up more quietly than they would on a real GPU.
 *
 * So: treat a 5% difference as noise and a 40% difference as real.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", process.env.CITY_PORT ?? 5192));
const LABEL = arg("label", "current");
const BASE = `http://127.0.0.1:${PORT}`;
/** Frames per scenario. Enough to ride out a GC pause or a texture upload. */
const FRAMES = 140;

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch { /* not yet */ }
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
if (server && !(await up(BASE, 180000))) {
  console.error("dev server never came up");
  process.exit(1);
}

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});
// Fixed and modest: frame cost scales with pixels, so a viewport that differs
// between the two runs would swamp whatever is being compared.
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

// Three minutes, not the default thirty seconds. A vite server on a tree it
// has never seen before spends the first request optimising dependencies, and
// this script exists to be pointed at exactly such a tree — an old commit in a
// worktree. The baseline run died here on its first attempt, which would have
// been very easy to read as "the old build is broken".
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(24000);
await page.waitForFunction(() => typeof window.__cityWarp === "function", null, { timeout: 90000 });

/** Median and 95th percentile of `n` consecutive rAF deltas, in ms. */
const sample = (n) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const d = [];
        let last = performance.now();
        // Two frames of warm-up are dropped: the first delta after an
        // evaluate() lands includes the round-trip and is not a frame.
        let warm = 2;
        const tick = () => {
          const now = performance.now();
          if (warm > 0) warm--;
          else d.push(now - last);
          last = now;
          if (d.length < count) requestAnimationFrame(tick);
          else {
            d.sort((a, b) => a - b);
            resolve({
              median: d[Math.floor(d.length / 2)],
              p95: d[Math.floor(d.length * 0.95)],
              n: d.length,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    n,
  );

/**
 * The scenarios, and why these three.
 *
 * Everything added lives in one of them. `plaza` is the control — dry land,
 * none of the new work visible — and is the one that catches a cost paid
 * everywhere whether you are near it or not, which is what a permanently
 * resident point light would be. `shore` puts the ocean, the beach and the
 * extended shelf in frame. `sea` sits over deep water where the surface is
 * doing its most expensive work.
 */
const SCENARIOS = [
  { name: "plaza (dry, control)", x: 0, y: 2, z: 40, dist: 12, pitch: 0.35 },
  { name: "shore (beach + surf)", x: 205, y: 2, z: 0, dist: 14, pitch: 0.3 },
  { name: "sea   (deep water)", x: 420, y: 3, z: 40, dist: 14, pitch: 0.25 },
];

// `--only sea` runs one scenario. A full pass is fifteen minutes, and once you
// know which scenario regressed, the other two are fifteen minutes of
// confirming that nothing changed.
const ONLY = arg("only", null);
const out = {};
for (const s of SCENARIOS.filter((s) => !ONLY || s.name.startsWith(ONLY))) {
  await page.evaluate((c) => {
    window.__cityDay(true);
    window.__cityWarp(c.x, c.y, c.z);
    window.__cityCam(c.dist, c.pitch, 0);
  }, s);
  // Let the camera ease in and the streaming settle before timing anything.
  await page.waitForTimeout(4000);
  await page.evaluate((c) => window.__cityCam(c.dist, c.pitch, 0), s);
  await page.waitForTimeout(1500);
  const r = await sample(FRAMES);
  out[s.name] = r;
  console.log(
    `${LABEL.padEnd(10)} ${s.name.padEnd(22)} median ${r.median.toFixed(1)} ms  p95 ${r.p95.toFixed(1)} ms`,
  );
}

console.log(`\nJSON ${LABEL} ${JSON.stringify(out)}`);

await browser.close();
server?.kill();
