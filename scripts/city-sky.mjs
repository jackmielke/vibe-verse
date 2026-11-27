#!/usr/bin/env node
/**
 * city-sky: photograph Vibe City's four skies (Day, Sunset, Night, Aurora),
 * the neon signs and the wet streets.
 *
 *     node scripts/city-sky.mjs <outDir> [looks...]
 *
 * Dev server on 5184. Frames come from `__cityDebug.snapshot()`, because
 * page.screenshot() returns white for this canvas under SwiftShader.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-sky";
mkdirSync(OUT, { recursive: true });
const ONLY = process.argv.slice(3);
const browser = await chromium.launch({ ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(300000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 400)));
page.on("console", (m) => { if (m.type() === "error" && /shader|WebGL|THREE/i.test(m.text())) console.log("console", m.text().slice(0, 300)); });
await page.goto("http://127.0.0.1:5184/city?spawn=hub", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__citySky && !!window.__cityDebug?.snapshot && !!window.__cityLandmarks, null, { polling: 1000 });
await page.waitForTimeout(8000);
const snap = async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); };
const shot = (eye, look, fov = 60) => page.evaluate(([eye, look, fov]) => window.__cityLandmarks.shot({ eye, look, fov }), [eye, look, fov]);
const SHOTS = {
  skyline: [[-150, 30, 150], [40, 40, -60], 60],
  street: [[ -21, 2.2, 70 ], [ -21, 6, -60 ], 62],
  sea: [[-200, 12, 40], [-600, 40, 20], 60],
};
const looks = ONLY.length ? ONLY : ["day", "sunset", "night", "aurora", "wet-night", "wet-sunset"];
for (const l of looks) {
  const wet = l.startsWith("wet-");
  const look = wet ? l.slice(4) : l;
  console.log(JSON.stringify(await page.evaluate((lk) => window.__citySky(lk), look)));
  await page.evaluate((w) => window.__cityWet(w), wet ? 1 : null);
  for (const [name, [eye, at, fov]] of Object.entries(SHOTS)) {
    if (wet && name !== "street") continue;
    await shot(eye, at, fov);
    await page.waitForTimeout(2500);
    await snap(`${l}-${name}`);
  }
}
await browser.close();
