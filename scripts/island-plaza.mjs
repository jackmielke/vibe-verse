#!/usr/bin/env node
/**
 * island-plaza — look at the Vibe Island plaza from the air.
 *
 *     node scripts/island-plaza.mjs [outDir]
 *
 * Everything that costs or gives Vibecoin was scattered across a 110-unit
 * island — the character portal alone was sixty units and a jetpack ride from
 * the shop it dresses you for. They now sit in one arc. Whether that actually
 * reads as a plaza is a question about a picture, not about coordinates, so:
 * take the picture.
 *
 * Uses the DEV-only `__cityCam(dist, pitch, yaw)` hook rather than trying to
 * fly there, for the same reason `city-flyover.mjs` does — scripted drags are
 * slow and unreliable under software GL.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/island-plaza");
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));

await page.route("**/functions/v1/**", (route) =>
  route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { balance: 250, ledger: [] } }),
  }),
);

console.log("· loading Vibe Island");
await page.goto(`${BASE}/city?spawn=island`, { waitUntil: "domcontentloaded", timeout: 200000 });
await page.waitForFunction(() => !!window.__cityGoto, null, { timeout: 240000 });
await page.waitForTimeout(9000);

// Stand in the middle of the new plaza — roughly between the shop and the
// arcade — so the orbit camera actually has the plaza to orbit.
console.log("· standing in the plaza");
await page.evaluate(() => window.__cityGoto(18, 32));
await page.waitForTimeout(1500);

for (const [name, dist, pitch, yaw] of [
  ["01-plaza-wide", 40, 0.66, 0.0],
  ["02-plaza-eye", 22, 0.30, 0.0],
  ["03-plaza-from-sea", 34, 0.42, 3.14],
]) {
  // Re-assert: an arrival swoop or a physics tick can fight a single pose.
  for (let i = 0; i < 5; i++) {
    await page.evaluate(
      ([d, p, y]) => {
        window.__cityGoto(18, 32);
        window.__cityCam(d, p, y);
      },
      [dist, pitch, yaw],
    );
    await page.waitForTimeout(220);
  }
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`   → ${name}.png`);
}

if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 6).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno page errors.");
}

await browser.close();
