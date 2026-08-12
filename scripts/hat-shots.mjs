#!/usr/bin/env node
/**
 * hat-shots — check that a hat is on the head, and stays there.
 *
 *     node scripts/hat-shots.mjs <outDir>
 *
 * Hats hang off the head bone now (`src/city/headMount.ts`), which is a thing
 * with exactly two failure modes and both of them are silent: the corrective
 * transform is wrong and the hat comes out sideways or the size of a car, or
 * the hat is fine standing still and does not follow when the head moves.
 *
 * So every hat is photographed twice — once idle, once with the head turned
 * hard by a dance — and the pair is what tells you whether it is attached.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/hat-shots");
const PORT = Number(process.env.CITY_PORT ?? 5186);
const BASE = `http://127.0.0.1:${PORT}`;

const HATS = ["cap", "beanie", "party", "tophat", "propeller", "crown", "halo", "bucket", "cans", "visor"];

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
  () => typeof window.__cityHat === "function" && window.__cityDebug?.camPose,
  null,
  { timeout: 90000 },
);

// Close in on the head. The whole question is whether a hat sits ON a skull,
// which a full-body shot cannot answer.
async function pose() {
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => {
      window.__cityDay(true);
      window.__cityWarp(0, 0, 6);
      window.__cityCam(4.5, 0.18, 0.55);
    });
    await page.waitForTimeout(600);
    const p = await page.evaluate(() => window.__cityDebug.camPose());
    const real = Math.hypot(p.x - p.px, p.y - p.py, p.z - p.pz);
    if (Math.abs(real - 4.5) < 1) return;
  }
}

for (const hat of HATS) {
  await page.evaluate((h) => window.__cityHat(h, null), hat);
  await pose();
  await page.screenshot({ path: `${OUT}/${hat}-idle.png` });
  // Now turn the head. `robot` swings it a long way to each side, which is the
  // pose a mount that only looks right at rest gives itself away in.
  await page.evaluate((h) => window.__cityHat(h, "robot"), hat);
  await page.waitForTimeout(2500);
  await pose();
  await page.screenshot({ path: `${OUT}/${hat}-turned.png` });
  await page.evaluate(() => window.__cityHat(null, null));
  console.log(`· ${hat}`);
}

if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 8).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
server?.kill();
