#!/usr/bin/env node
/**
 * island-look — a set of close, deliberate looks at Vibe Island.
 *
 *     node scripts/island-look.mjs [outDir]
 *
 * `island-plaza.mjs` answers "does the plaza read as a plaza". This one is
 * for the material pass: the lawn from ankle height, a shop front from the
 * street, the rim where grass meets dirt. Those are the frames where
 * "realistic" is either true or it isn't, and none of them are visible from
 * an orbit-cam 40 units up.
 *
 * Software GL renders this scene at a few frames a second, so every wait and
 * every screenshot timeout here is deliberately generous — a 30s screenshot
 * timeout (Playwright's default) fails on a frame that simply took longer.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/island-look");
/* Day by default: the lawn and the paint are the point, and at night the
   whole island is a silhouette with lamps on it. `night` for the other half. */
const NIGHT = process.argv.includes("night");
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
page.setDefaultTimeout(180000);

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));

await page.route("**/functions/v1/**", (route) =>
  route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { balance: 250, ledger: [] } }),
  }),
);

console.log("· loading Vibe Island");
await page.goto(`${BASE}/city?spawn=island`, { waitUntil: "domcontentloaded", timeout: 240000 });
await page.waitForFunction(() => !!window.__cityGoto, null, { timeout: 300000 });
await page.waitForTimeout(12000);
await page.evaluate((night) => window.__cityDay(!night), NIGHT);
await page.waitForTimeout(3000);

/* [name, standX, standZ, camDist, camPitch, camYaw] — stand coords are
   island-local; __cityGoto takes them relative to the island surface. */
const SHOTS = [
  ["01-lawn-ankle", 20, 20, 4.5, 0.06, 1.0],
  ["02-lawn-mid", 14, 26, 12, 0.16, 2.2],
  ["03-trader-joes", -22, -6, 14, 0.14, 1.6],
  ["03b-wall-closeup", -20, -8, 3.2, 0.05, 1.57],
  ["04-ninja-palace", 18, -16, 15, 0.18, -1.2],
  ["05-rim-edge", 44, 6, 12, 0.02, 0.4],
  ["06-plaza-wide", 0, 10, 40, 0.55, 0.0],
];

for (const [name, sx, sz, dist, pitch, yaw] of SHOTS) {
  for (let i = 0; i < 5; i++) {
    await page.evaluate(
      ([x, z, d, p, y]) => {
        window.__cityGoto(x, z);
        window.__cityCam(d, p, y);
      },
      [sx, sz, dist, pitch, yaw],
    );
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 180000 });
  console.log(`   → ${name}.png`);
}

if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 6).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno page errors.");
}

await browser.close();
