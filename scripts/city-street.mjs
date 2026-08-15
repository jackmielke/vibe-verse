#!/usr/bin/env node
/**
 * city-street — Vibe City from the pavement, where the traffic is.
 *
 *     node scripts/city-street.mjs [outDir] [night]
 *
 * The city harnesses that existed before this one all look at the skyline:
 * `city-card` poses a hero frame, `city-flyover` runs the camera over the
 * grid. Both are the wrong altitude for judging cars. A box with a colour on
 * it is a perfectly good car from 200 m up, which is exactly why the traffic
 * stayed boxes for so long — nobody had a picture of it from the kerb.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/city-street");
const NIGHT = process.argv.includes("night");
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
page.setDefaultTimeout(240000);

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
await page.route("**/functions/v1/**", (route) =>
  route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { balance: 250, ledger: [] } }),
  }),
);

console.log("· loading Vibe City");
/* `?spawn=hub` skips the character picker. Without it the harness photographs
   a "Pick your vibe" dialog and reports no page errors, which is exactly as
   useless as it sounds. */
await page.goto(`${BASE}/city?spawn=hub`, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__cityWarp, null, { timeout: 300000 });
await page.waitForTimeout(14000);
await page.evaluate((night) => window.__cityDay(!night), NIGHT);
await page.waitForTimeout(3000);

/* World coordinates. The grid is 9 cells of 40 m centred on the origin, so a
   street centreline sits at ±20, ±60, ±100 … and a junction is where two of
   those cross. */
for (const [name, x, y, z, dist, pitch, yaw] of [
  /* Yaw stays near 0 or π — along the street. The orbit camera sits `dist`
     behind the player on that bearing, and a bearing across the street puts it
     inside the block, at which point the city shoves it up onto a roof and you
     get four photographs of a skyline. */
  ["01-kerb", 20, 0, -6, 14, 0.08, 0.0],
  ["02-crossing", 20, 0, 13, 13, 0.18, Math.PI],
  ["03-down-the-street", 20, 0, -30, 16, 0.1, 0.0],
  ["04-from-a-window", 26, 22, 10, 30, 0.6, 1.0],
]) {
  for (let i = 0; i < 5; i++) {
    await page.evaluate(
      ([px, py, pz, d, p, yw]) => {
        window.__cityWarp(px, py, pz);
        window.__cityCam(d, p, yw);
      },
      [x, y, z, dist, pitch, yaw],
    );
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2200);
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
