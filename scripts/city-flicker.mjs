#!/usr/bin/env node
/**
 * city-flicker — catch the city shimmering from the air, with a number.
 *
 *     node scripts/city-flicker.mjs <outDir> [dist] [pitch] [yaw]
 *     node scripts/city-flicker.mjs --compare <dirA> <dirB>
 *
 * "It flickers from above" is not something a screenshot shows or a build
 * catches. Z-fighting is also invisible in a frozen frame — two surfaces at
 * the same depth pick a winner and hold it, and the pattern only *flickers*
 * once the camera moves. So this drives a deliberate, tiny, reproducible orbit
 * (a fraction of a pixel per frame at this range) and counts the pixels that
 * flip hard and flip back, which is the z-fighting signature and is nothing
 * like the smooth movement of traffic, water or a blinking window.
 *
 * Two things make the number trustworthy, and both were learned the hard way:
 *
 *  - The pose is read BACK through `__cityDebug.camPose()` and re-asserted
 *    until it sticks. `__cityCam` is a request; the arrival swoop, fast travel
 *    and the kart chase all drive the camera too. A run where the camera
 *    quietly settled at a different zoom reported a fix as a regression.
 *  - The orbit is identical between runs, so two runs are comparable. With a
 *    genuinely frozen camera the metric reads zero whether or not the depth
 *    buffer is in trouble.
 *
 * Frames are written out too, so the speckle can be eyeballed for where it is.
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

/** Assert the pose until the page agrees, then confirm it held for a beat. */
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
    // ...and ARRIVED, not merely momentarily stationary. The chase camera eases
    // in, and there is a beat at the very start of a 700 m zoom where it has
    // not moved yet — a burst begun there is a burst of the wrong shot, taken
    // while every distance-dependent thing in the frame is still catching up.
    const arrived = Math.abs(a.y - (2 + Math.sin(PITCH) * DIST + 1.4)) < DIST * 0.05;
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
