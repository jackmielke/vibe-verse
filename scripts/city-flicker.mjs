#!/usr/bin/env node
/**
 * city-flicker — measure how much of the city is decided by depth rounding.
 *
 *     node scripts/city-flicker.mjs <outDir> [dist] [pitch] [yaw]
 *
 * "It flickers from above" is not something a screenshot shows or a build
 * catches, and the obvious tool for it does not work. Diffing consecutive
 * frames sounds right and is useless here: at this zoom a fraction of a pixel
 * of camera drift lights up every edge in a dense city, so the metric
 * saturates around 45% whatever you do to the depth buffer. Two measurements
 * taken that way were wrong, one of them declaring a fix a regression.
 *
 * What works is a **depth probe**. Z-fighting is invisible in a frozen frame —
 * two surfaces at the same depth pick a winner and hold it — but it is not
 * invisible to a change in *precision*. So this renders the same frame twice
 * inside one synchronous call with the near plane nudged two parts in ten
 * thousand between them. No traffic has moved, no wave has advanced, the
 * camera has not shifted by a nanometre; every pixel that differs is a pixel
 * whose winner was decided by depth rounding rather than by geometry. That is
 * the number, and it is stable enough to compare across runs:
 *
 *     before the fix   6.93% of the district
 *     after            0.01%
 *
 * The pose is read BACK through `__cityDebug.camPose()` and re-asserted until
 * the camera has genuinely ARRIVED, not merely stopped for a beat. `__cityCam`
 * is a request, not a guarantee — the arrival swoop, fast travel and the kart
 * chase all drive the camera too, and a burst begun mid-swoop is a burst of
 * the wrong shot at the wrong zoom.
 *
 * Frames are written out as pairs (`f00a.png` / `f00b.png`) so the speckle can
 * be eyeballed for where it is; diff a pair to see the map.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/city-flicker");
const DIST = Number(process.argv[3] ?? 700);
const PITCH = Number(process.argv[4] ?? 1.0);
const YAW0 = Number(process.argv[5] ?? 0.6);
/** Radians per frame. At 700 m this moves the image well under a pixel. */
const YAW_STEP = 0.0007;
const FRAMES = Number(process.env.FLICKER_FRAMES ?? 12);
const PORT = Number(process.env.CITY_PORT ?? 5183);
const BASE = `http://127.0.0.1:${PORT}`;

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

mkdirSync(OUT, { recursive: true });

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
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on("pageerror", (e) => console.log(`PAGEERROR ${e}`));

await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(22000);
await page.waitForFunction(
  () => typeof window.__cityDay === "function" && window.__cityDebug?.camPose,
  null,
  { timeout: 90000 },
);

/** Assert the pose until the camera has actually arrived at it. */
async function pin(yaw) {
  for (let i = 0; i < 25; i++) {
    await page.evaluate(([d, p, y]) => {
      window.__cityDay(true);
      window.__cityWarp(0, 2, 6);
      window.__cityCam(d, p, y);
    }, [DIST, PITCH, yaw]);
    await page.waitForTimeout(i < 4 ? 900 : 400);
    const a = await page.evaluate(() => window.__cityDebug.camPose());
    await page.waitForTimeout(350);
    const b = await page.evaluate(() => window.__cityDebug.camPose());
    const posed = Math.abs(a.dist - DIST) < 1 && Math.abs(a.yaw - yaw) < 1e-4;
    // Settled: the eased chase camera has stopped closing on its target.
    const still = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.25;
    // ...and ARRIVED. `dist` is what the camera was ASKED for; the distance
    // from the player is what it currently IS. There is a beat at the start of
    // a 700 m zoom where the camera has not moved yet, and it passes a
    // stillness test while being 600 m from where it is going.
    const real = Math.hypot(a.x - a.px, a.y - a.py, a.z - a.pz);
    const arrived = Math.abs(real - DIST) < DIST * 0.04;
    if (posed && still && arrived) return a;
  }
  throw new Error("camera would not hold the pose");
}

const start = await pin(YAW0);
console.log(`· pinned at dist ${start.dist.toFixed(1)}, near ${start.near}`);

/**
 * The depth probe: the same frame, twice, with the near plane nudged by two
 * parts in ten thousand between them.
 *
 * Both renders happen inside ONE synchronous call, so no traffic has moved, no
 * wave has advanced and the camera has not shifted by a nanometre. The only
 * thing that changed is how finely the depth buffer divides the world — so
 * every pixel that comes out different is a pixel whose winner was decided by
 * depth precision rather than by geometry. That is z-fighting, measured
 * directly, with none of the animation that swamps a frame-to-frame diff.
 */
for (let i = 0; i < FRAMES; i++) {
  const yaw = YAW0 + i * YAW_STEP;
  await page.evaluate(([d, p, y]) => window.__cityCam(d, p, y), [DIST, PITCH, yaw]);
  await page.waitForTimeout(500);
  const pose = await page.evaluate(() => window.__cityDebug.camPose());
  if (Math.abs(pose.dist - DIST) > 1) throw new Error(`camera wandered to dist ${pose.dist}`);
  console.log(`  frame ${i}: near ${pose.near.toFixed(3)} dist ${pose.dist.toFixed(0)} camY ${pose.y.toFixed(0)}`);
  const pair = await page.evaluate(() => {
    const d = window.__cityDebug;
    const n = d.camPose().near;
    return [d.snapshot(), d.snapshot(n * 1.0002)];
  });
  pair.forEach((png, k) =>
    writeFileSync(`${OUT}/f${String(i).padStart(2, "0")}${k ? "b" : "a"}.png`,
      Buffer.from(png.split(",")[1], "base64")),
  );
}
console.log(`wrote ${FRAMES} depth-probe pairs to ${OUT} (near ${start.near})`);

await browser.close();
server?.kill();
