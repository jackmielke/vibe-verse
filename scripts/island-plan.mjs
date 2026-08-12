#!/usr/bin/env node
/**
 * island-plan — Vibe Island from directly overhead, as a site plan.
 *
 *     node scripts/island-plan.mjs [outDir] [night]
 *
 * Every other harness here photographs the island from inside it, which is the
 * right way to judge materials and the wrong way to judge a town. "Does this
 * layout make sense" is a question about where things are relative to each
 * other, and the only view that answers it is the one from above with the
 * whole island in frame.
 *
 * Pitch is clamped to 1.25 rad in `__cityCam` (about 72°), so this is a steep
 * oblique rather than a true plan — close enough to read the streets, and it
 * keeps the buildings' elevations visible, which a true plan would not.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/island-plan");
const NIGHT = process.argv.includes("night");
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
page.setDefaultTimeout(240000);

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));

await page.route("**/functions/v1/**", (route) =>
  route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { balance: 250, ledger: [] } }),
  }),
);

console.log("· loading Vibe Island");
await page.goto(`${BASE}/city?spawn=island`, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__cityGoto, null, { timeout: 300000 });
await page.waitForTimeout(14000);
await page.evaluate((night) => window.__cityDay(!night), NIGHT);
await page.waitForTimeout(3000);

/* Four bearings, because a single overhead shot hides whatever is behind the
   God Orb and the light beam, and "is this building on the road" is a question
   you can only answer looking down the road. */
for (const [name, dist, pitch, yaw] of [
  ["plan-N", 150, 1.25, 0],
  ["plan-E", 150, 1.25, Math.PI / 2],
  ["plan-S", 150, 1.25, Math.PI],
  ["plan-W", 150, 1.25, -Math.PI / 2],
  ["plan-oblique", 130, 0.85, 0.6],
]) {
  for (let i = 0; i < 6; i++) {
    await page.evaluate(
      ([d, p, y]) => {
        window.__cityGoto(0, 0);
        window.__cityCam(d, p, y);
      },
      [dist, pitch, yaw],
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
