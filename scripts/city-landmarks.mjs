#!/usr/bin/env node
/**
 * city-landmarks — photograph the Space Needle, the Empire State Building and
 * the Eiffel Tower in Vibe City, then ride every elevator and look through
 * the binoculars, the way a player does: stand in the car, press E.
 *
 *     node scripts/city-landmarks.mjs <outDir> [needle,empire,eiffel] [--night]
 *
 * Needs a dev server (`npx vite --port 5184 --strictPort --host 127.0.0.1`);
 * `__cityLandmarks` only exists in dev builds. Frames come from
 * `__cityDebug.snapshot()`. Rides run with drawing switched off
 * (`__cityCrash.render(false)`), which is the difference between a ride
 * taking ten seconds of simulation and ten minutes of SwiftShader.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-landmarks";
mkdirSync(OUT, { recursive: true });
const NIGHT = process.argv.includes("--night");
const browser = await chromium.launch({ ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(300000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0,400)));
await page.goto("http://127.0.0.1:5184/city?spawn=hub", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityLandmarks && !!window.__cityDebug?.snapshot);
await page.waitForTimeout(8000);
await page.evaluate(() => window.__cityDay(true));
const sites = await page.evaluate(() => window.__cityLandmarks.sites());
const snap = async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); };
const L = (fn, a) => page.evaluate(([fn, a]) => window.__cityLandmarks[fn](a), [fn, a]);
const render = (on) => page.evaluate((v) => window.__cityCrash.render(v), on);
const waitRide = async () => { await render(false); for (let i=0;i<60;i++){ await page.waitForTimeout(1000); const st = await L("state"); if (!st.riding) break; } await render(true); };
const which = (process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "needle,empire,eiffel").split(",");
// The establishing shots first, from the scripted camera.
for (const night of NIGHT ? [false, true] : [false]) {
  await page.evaluate((d) => window.__cityDay(d), !night);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__cityLandmarks.shot({ eye: [260, 230, 260], look: [10, 20, 0], fov: 50 }));
  await page.waitForTimeout(1500);
  await snap(night ? "aerial-night" : "aerial");
  for (const s of sites.filter((x) => which.includes(x.key))) {
    await page.evaluate((s) => window.__cityLandmarks.shot({ eye: s.eye, look: s.look, fov: 55 }), s);
    await page.waitForTimeout(1500);
    await snap(s.key + (night ? "-night" : ""));
  }
}
await page.evaluate(() => { window.__cityLandmarks.shot(null); window.__cityDay(true); });
for (const key of which) {
  const s = sites.find(x=>x.key===key);
  await page.evaluate(([x,y,z]) => window.__cityWarp(x,y+0.3,z), s.car);
  await page.waitForTimeout(2500);
  console.log(key, "near:", JSON.stringify(await L("near")));
  console.log("act:", await L("act"));
  await render(false); await page.waitForTimeout(3000); await render(true);
  console.log("mid:", JSON.stringify(await L("state")));
  await page.evaluate(() => window.__cityCam(9, 0.25, 0.8));
  await page.waitForTimeout(800); await snap(key+"-mid");
  await waitRide();
  console.log("after:", JSON.stringify(await L("state")));
  await page.evaluate(() => window.__cityCam(9, 0.3, 2.4));
  await page.waitForTimeout(1500); await snap(key+"-deck");
  if (key === "eiffel") {
    await page.evaluate(([x,y,z]) => window.__cityWarp(x+3.4,y+0.3,z), s.central); // into central car
    await page.waitForTimeout(2500);
    console.log("central near:", JSON.stringify(await L("near")));
    await L("act"); await waitRide();
    console.log("summit:", JSON.stringify(await L("state")));
    await page.evaluate(() => window.__cityCam(7, 0.35, 0.5));
    await page.waitForTimeout(1500); await snap("eiffel-summit");
  }
  await page.evaluate(([x,y,z]) => window.__cityWarp(x,y+0.3,z), s.binoculars);
  await page.waitForTimeout(2000);
  console.log("scope near:", JSON.stringify(await L("near")));
  await L("act"); await page.waitForTimeout(2000); await snap(key+"-scope"); await L("act");
}
await browser.close();
