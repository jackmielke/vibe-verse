#!/usr/bin/env node
/**
 * swim-shots — photograph the swimmer, from the angles a swim stroke fails at.
 *
 *     node scripts/swim-shots.mjs <outDir> [day|night]
 *
 * The stroke is solved rather than played back (see `src/city/swim.ts`), so
 * there is no clip to scrub and no way to eyeball it except by putting a body
 * in the water and looking. The interesting cases are all about the waterline:
 * treading with the head out, prone with the back out, and the moment of
 * arrival — a swimmer floating a foot under an opaque sea is invisible, and
 * one floating a foot above it is walking on water.
 *
 * Each pose holds the player still and drives the stroke by TIME rather than
 * by input, so the frames are comparable between runs.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/swim-shots");
const MODE = process.argv[3] ?? "day";
const PORT = Number(process.env.CITY_PORT ?? 5184);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * `at` is where the swimmer is put; `hold` is how many seconds of stroke to
 * let run before the shutter, so a burst catches different points in the
 * cycle rather than the same frame every time.
 *
 * The moving poses sit well offshore on purpose. `swim` drives the player
 * along the CAMERA's forward, which is the same yaw that frames them — so a
 * side-on shot taken near the beach aims the swimmer straight at it, and by
 * the time the camera has settled they have waded out and are standing in the
 * road.
 */
const SHOTS = [
  { name: "01-tread-close", at: [250, 0, 20], dist: 6, pitch: 0.3, yaw: 1.4, hold: 2 },
  { name: "02-tread-eye", at: [250, 0, 20], dist: 9, pitch: 0.06, yaw: 0.4, hold: 5 },
  { name: "03-crawl-side", at: [430, 0, 40], dist: 8, pitch: 0.38, yaw: 1.5708, hold: 3, swim: 1 },
  { name: "04-crawl-behind", at: [430, 0, 40], dist: 7, pitch: 0.42, yaw: 0, hold: 4, swim: 1 },
  { name: "05-crawl-front", at: [430, 0, 40], dist: 7.5, pitch: 0.3, yaw: 3.1416, hold: 5, swim: 1 },
  { name: "06-shore", at: [222, 0, 20], dist: 14, pitch: 0.14, yaw: 1.5708, hold: 3 },
  { name: "07-wide", at: [430, 0, 20], dist: 34, pitch: 0.45, yaw: 1.5708, hold: 3, swim: 1 },
];

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
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/supabase|websocket|ERR_CONNECTION|tunnel|Failed to load/i.test(t)) {
    errors.push(`console: ${t}`);
  }
});

console.log("· booting the city (software GL, this is slow)");
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(22000);
await page.waitForFunction(
  () => typeof window.__citySwim === "function" && window.__cityDebug?.camPose,
  null,
  { timeout: 90000 },
);

for (const s of SHOTS) {
  // `__citySwim` holds the player in the water and, optionally, feeds a
  // constant forward intent so the stroke goes prone without a key being held.
  await page.evaluate(
    ([at, d, p, y, isDay, swim]) => {
      window.__cityDay(isDay);
      window.__cityWarp(at[0], at[1], at[2]);
      window.__citySwim(swim);
      window.__cityCam(d, p, y);
    },
    [s.at, s.dist, s.pitch, s.yaw, MODE === "day", s.swim ?? 0],
  );
  /**
   * Wait for buoyancy to actually get there.
   *
   * The tick clamps dt to 0.05, so under the software renderer the simulation
   * advances at something like a fifteenth of real time — a body settling to
   * its float line takes a second and a half of game time and half a minute of
   * wall clock. Shooting on a fixed timer photographed a swimmer still on the
   * way down every time, which reads as floating a metre above the sea.
   */
  for (let i = 0; i < 40; i++) {
    await page.evaluate(([d, p, y]) => window.__cityCam(d, p, y), [s.dist, s.pitch, s.yaw]);
    await page.waitForTimeout(700);
    const st = await page.evaluate(() => window.__citySwimState());
    const settled = st.swimming && Math.abs(st.y - st.floatY) < 0.2;
    const upToSpeed = !s.swim || st.speed > 2.4;
    if (settled && upToSpeed && i * 0.7 > (s.hold ?? 2)) break;
  }
  await page.screenshot({ path: `${OUT}/${MODE}-${s.name}.png` });
  const st = await page.evaluate(() => window.__citySwimState());
  console.log(
    `· ${MODE}-${s.name} — swimming ${st.swimming}, prone ${st.prone.toFixed(2)}, ` +
      `speed ${st.speed.toFixed(1)}, y ${st.y.toFixed(2)}, sea ${st.sea.toFixed(2)}`,
  );
}

await page.evaluate(() => window.__citySwim(0));
if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 10).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
server?.kill();
