#!/usr/bin/env node
/**
 * snow-shots — photograph the city under snow, at a range of depths.
 *
 *     node scripts/snow-shots.mjs <outDir>
 *
 * Accumulation is shaded rather than built (see `src/city/snowCover.ts`), so
 * the things that can go wrong are all things a still frame shows and nothing
 * else does: snow on the sides of buildings, a flat white wash instead of
 * drifts, or a bare street in a blizzard because a material was never patched.
 *
 * Depth is set directly through `__citySnow` rather than waited for. Laying a
 * full cover takes half a minute of game time by design, and the software
 * renderer these scripts run on advances at roughly a fifteenth of real time.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/snow-shots");
const PORT = Number(process.env.CITY_PORT ?? 5185);
const BASE = `http://127.0.0.1:${PORT}`;

const SHOTS = [
  { name: "00-bare", depth: 0, at: [0, 2, 6], dist: 60, pitch: 0.55, yaw: 0.6 },
  { name: "01-dusting", depth: 0.35, at: [0, 2, 6], dist: 60, pitch: 0.55, yaw: 0.6 },
  { name: "02-settled", depth: 0.75, at: [0, 2, 6], dist: 60, pitch: 0.55, yaw: 0.6 },
  { name: "03-deep", depth: 1, at: [0, 2, 6], dist: 60, pitch: 0.55, yaw: 0.6 },
  { name: "04-street", depth: 0.8, at: [0, 2, 6], dist: 9, pitch: 0.12, yaw: 0.9 },
  { name: "05-god", depth: 0.9, at: [0, 2, 6], dist: 620, pitch: 0.95, yaw: 0.6 },
  { name: "06-beach", depth: 0.9, at: [196, 1.2, 20], dist: 22, pitch: 0.3, yaw: -1.5708 },
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
  () => typeof window.__citySnow === "function" && window.__cityDebug?.camPose,
  null,
  { timeout: 90000 },
);

for (const s of SHOTS) {
  for (let i = 0; i < 30; i++) {
    await page.evaluate(
      ([at, d, p, y, depth]) => {
        window.__cityDay(true);
        window.__cityWarp(at[0], at[1], at[2]);
        window.__citySnow(depth);
        window.__cityCam(d, p, y);
      },
      [s.at, s.dist, s.pitch, s.yaw, s.depth],
    );
    await page.waitForTimeout(700);
    const pose = await page.evaluate(() => window.__cityDebug.camPose());
    const real = Math.hypot(pose.x - pose.px, pose.y - pose.py, pose.z - pose.pz);
    if (Math.abs(pose.dist - s.dist) < 1 && Math.abs(real - s.dist) < Math.max(1.5, s.dist * 0.06)) break;
  }
  await page.screenshot({ path: `${OUT}/${s.name}.png` });
  console.log(`· ${s.name} — depth ${s.depth}`);
}

await page.evaluate(() => window.__citySnow(0));
if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 10).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
server?.kill();
