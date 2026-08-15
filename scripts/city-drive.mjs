#!/usr/bin/env node
/**
 * city-drive — get into a city car and drive it.
 *
 *     node scripts/city-drive.mjs [outDir] [night]
 *
 * The traffic harnesses take pictures of cars going past. This one is for the
 * half that a still frame cannot answer: does the prompt actually appear when
 * a car stops for you, does the car move when you press W, does the camera end
 * up somewhere you can see from, and does the thing you get out of stay where
 * you left it.
 *
 * It walks into the road, waits for the prompt, clicks it, holds W, and takes a
 * picture at each stage. Real key events rather than a debug hook, because the
 * hop-in flow is the part being tested and half of it is UI.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/city-drive");
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
await page.goto(`${BASE}/city?spawn=hub`, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__cityWarp, null, { timeout: 300000 });
await page.waitForTimeout(14000);
await page.evaluate((night) => window.__cityDay(!night), NIGHT);

// Stand in the middle of a lane. Cars brake for anybody in the road, so this
// is also how you make one stop — no need to find a red light.
console.log("· standing in the road");
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => {
    window.__cityWarp(20 - 2.6, 0, -10);
    window.__cityCam(11, 0.14, 0);
  });
  await page.waitForTimeout(500);
}

const shot = async (name) => {
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 180000 });
  console.log(`   → ${name}.png`);
};

// Wait for a car to stop and the prompt to appear.
const wheel = page.getByRole("button", { name: /Take the wheel/i });
try {
  await wheel.waitFor({ state: "visible", timeout: 90000 });
  console.log("· a car stopped — prompt is up");
} catch {
  console.log("!! no 'Take the wheel' prompt appeared");
}
await shot("01-a-car-stops");

if (await wheel.isVisible().catch(() => false)) {
  await wheel.click();
  await shot("02-at-the-wheel");

  console.log("· driving");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(2600);
  await shot("03-driving");
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(1600);
  await page.keyboard.up("KeyD");
  await page.waitForTimeout(1200);
  await shot("04-turning");
  await page.keyboard.up("KeyW");

  const out = page.getByRole("button", { name: /Hop out/i });
  if (await out.isVisible().catch(() => false)) {
    await out.click();
    await shot("05-back-out");
  } else {
    console.log("!! no 'Hop out' button while driving");
  }
}

if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 6).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno page errors.");
}
await browser.close();
