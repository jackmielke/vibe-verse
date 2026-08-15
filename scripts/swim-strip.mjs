#!/usr/bin/env node
/**
 * swim-strip — a filmstrip of one whole stroke, from a fixed camera.
 *
 *     node scripts/swim-strip.mjs <outDir> [side|behind|front]
 *
 * A swim stroke is motion, and motion is the one thing a screenshot cannot
 * show. Every earlier pass at this animation was judged on single frames, each
 * caught at whatever phase the clock happened to be at, and the defects that
 * survived were all *between* frames: an arm that reversed instead of coming
 * over the top, a body that yawed instead of rolling, an elbow that kinked
 * twice a cycle. Every one of those looks fine in a still.
 *
 * So the stroke is frozen at exact phases through `__citySwimPose` — it is a
 * pure function of speed and time, which is what makes that possible — and the
 * frames are tiled into one contact sheet. Read left to right: the arm should
 * go round, once, without ever going backwards.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/swim-strip");
const VIEW = process.argv[3] ?? "side";
const PORT = Number(process.env.CITY_PORT ?? 5187);
const BASE = `http://127.0.0.1:${PORT}`;

/** Frames across one cycle. At 3.2 m/s the rate is ~1.07 Hz, so ~0.93 s. */
const FRAMES = 12;
const CYCLE = 0.93;
const SPEED = 3.2;

const VIEWS = {
  side: { yaw: 1.5708, pitch: 0.62, dist: 6.5 },
  behind: { yaw: 0, pitch: 0.4, dist: 6 },
  front: { yaw: 3.1416, pitch: 0.3, dist: 6 },
};

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
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));

console.log("· booting the city (software GL, this is slow)");
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(22000);
await page.waitForFunction(
  () => typeof window.__citySwimPose === "function" && window.__cityDebug?.camPose,
  null,
  { timeout: 90000 },
);

const v = VIEWS[VIEW] ?? VIEWS.side;

/**
 * Park the swimmer, floating and still, at the pose the strip is shot from.
 *
 * `__citySwim(0)` means no forward input, so they hold station and the camera
 * frames the same patch of sea every frame — but the stroke is driven by the
 * frozen phase, not by their speed, so they still swim on the spot.
 */
for (let i = 0; i < 40; i++) {
  await page.evaluate(
    ([d, p, y, speed, first]) => {
      window.__cityDay(true);
      // Warped ONCE. Re-placing the swimmer on every poll re-triggers the entry
      // splash, and a contact sheet with four expanding rings across it is a
      // contact sheet of rings.
      if (first) window.__cityWarp(430, 0, 40);
      window.__citySwim(0);
      window.__citySwimPose(0, speed);
      window.__cityCam(d, p, y);
    },
    [v.dist, v.pitch, v.yaw, SPEED, i === 0],
  );
  await page.waitForTimeout(700);
  const st = await page.evaluate(() => window.__citySwimState());
  const pose = await page.evaluate(() => window.__cityDebug.camPose());
  const real = Math.hypot(pose.x - pose.px, pose.y - pose.py, pose.z - pose.pz);
  if (st.swimming && Math.abs(st.y - st.floatY) < 0.2 && Math.abs(real - v.dist) < 1) break;
}

for (let i = 0; i < FRAMES; i++) {
  const t = (i / FRAMES) * CYCLE;
  await page.evaluate(
    ([tt, speed, d, p, y]) => {
      // Re-asserted per frame. Time of day is a shared world setting and a
      // peer or the Supabase row will drag it to night part-way through a run.
      window.__cityDay(true);
      window.__citySwimPose(tt, speed);
      window.__cityCam(d, p, y);
    },
    [t, SPEED, v.dist, v.pitch, v.yaw],
  );
  // The pose is written in the frame loop, so the shot has to land after it.
  await page.waitForTimeout(900);
  // Canvas only, through the debug hook: `page.screenshot` composites the DOM
  // HUD over it, and a control hint across the swimmer's legs is not helpful
  // in a contact sheet.
  const png = await page.evaluate(() => window.__cityDebug.snapshot());
  writeFileSync(`${OUT}/${VIEW}-${String(i).padStart(2, "0")}.png`, Buffer.from(png.split(",")[1], "base64"));
}
console.log(`· ${FRAMES} frames of ${VIEW} written to ${OUT}`);

await page.evaluate(() => window.__citySwimPose(null));
if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 8).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
server?.kill();
