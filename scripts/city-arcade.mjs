#!/usr/bin/env node
/**
 * city-arcade — walk into the Vibe Arcade in Vibe City and play a cabinet.
 *
 *     node scripts/city-arcade.mjs <outDir> [pool,hoops,...]
 *
 * Needs a dev server (`npx vite --port 5184 --strictPort --host 127.0.0.1`).
 * Photographs the front and the hall through `__cityDebug.snapshot()`, then
 * for each station: warps the player beside it, checks `__cityArcade.near()`,
 * presses E, waits for the game to load inside the cabinet and takes a page
 * screenshot (the city's WebGL canvas comes out white there, which is fine:
 * the cabinet covers it), then Escape back to the floor.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-arcade";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(300000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 400)));
await page.goto("http://127.0.0.1:5184/city?spawn=hub", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityArcade && !!window.__cityDebug?.snapshot, null, { polling: 1000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.__cityDay(true));
const snap = async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); };
const shot = (s) => page.evaluate((s) => window.__cityLandmarks.shot(s), s);
await shot({ eye: [-2, 9, 14], look: [27, 4, 0], fov: 55 });
await page.waitForTimeout(2000);
await snap("front");
await page.evaluate(() => window.__cityDay(false));
await page.waitForTimeout(1500);
await snap("front-night");
await page.evaluate(() => window.__cityDay(true));
await shot({ eye: [29.5, 5.5, -10], look: [46, 0.5, 4], fov: 70 });
await page.waitForTimeout(2000);
await snap("hall");
await shot({ eye: [29.5, 5.5, 10], look: [48, 0.5, -3], fov: 70 });
await page.waitForTimeout(2000);
await snap("hall-2");
await shot(null);
const stations = await page.evaluate(() => window.__cityArcade.stations());
console.log(JSON.stringify(stations));
const which = (process.argv[3] ?? stations.map((s) => s.key).join(",")).split(",");
for (const key of which) {
  const s = stations.find((x) => x.key === key);
  // Stand a step west of it, on the open floor.
  const dx = s.key.match(/mortmaze|boxing|2048|hoops/) ? -0.6 : -1.8;
  await page.evaluate(([x, z]) => window.__cityWarp(x, 0.3, z), [s.at[0] + dx, s.at[2]]);
  await page.waitForTimeout(2500);
  const near = await page.evaluate(() => window.__cityArcade.near());
  console.log(key, "near:", near);
  await page.keyboard.press("KeyE");
  await page.waitForSelector(`[data-arcade-cabinet="${key}"] iframe`, { timeout: 20000 }).catch(() => console.log("no cabinet for", key));
  await page.waitForTimeout(15000);
  const frame = page.frames().find((f) => f.url().includes(s.route));
  const text = frame ? (await frame.evaluate(() => document.body.innerText.slice(0, 160)).catch((e) => "ERR " + e)) : "no frame";
  console.log(key, "frame:", frame?.url(), "|", JSON.stringify(text));
  await page.screenshot({ path: `${OUT}/cabinet-${key}.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  console.log(key, "closed:", !(await page.$("[data-arcade-cabinet]")));
}
await browser.close();
