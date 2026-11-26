#!/usr/bin/env node
/**
 * city-commons: photograph Vibe Commons (the park and soccer pitch) and Vibe
 * Marina, score a goal, and take the speedboat out and back, the way a
 * player does: E at the boat, hold W, steer with A/D, E to step off.
 *
 *     node scripts/city-commons.mjs <outDir> [--night]
 *
 * Same harness as city-landmarks.mjs: a dev server on 5184, frames from
 * `__cityDebug.snapshot()`, and the simulation run with drawing switched
 * off while it needs wall-clock time.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-commons";
mkdirSync(OUT, { recursive: true });
const NIGHT = process.argv.includes("--night");
const browser = await chromium.launch({ ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(300000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 400)));
await page.goto("http://127.0.0.1:5184/city?spawn=hub", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityLandmarks && !!window.__cityDebug?.snapshot);
await page.waitForTimeout(8000);
await page.evaluate(() => window.__cityDay(true));
const sites = await page.evaluate(() => window.__cityLandmarks.sites());
const park = sites.find((s) => s.key === "park");
const marina = sites.find((s) => s.key === "marina");
const snap = async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); };
const L = (fn, a) => page.evaluate(([fn, a]) => window.__cityLandmarks[fn](a), [fn, a]);
const render = (on) => page.evaluate((v) => window.__cityCrash.render(v), on);
const sim = async (ms) => { await render(false); await page.waitForTimeout(ms); await render(true); };

for (const night of NIGHT ? [false, true] : [false]) {
  await page.evaluate((d) => window.__cityDay(d), !night);
  await page.waitForTimeout(1000);
  for (const s of [park, marina]) {
    await page.evaluate((s) => window.__cityLandmarks.shot({ eye: s.eye, look: s.look, fov: 55 }), s);
    await page.waitForTimeout(1500);
    await snap(s.key + (night ? "-night" : ""));
  }
}
await page.evaluate(() => { window.__cityLandmarks.shot(null); window.__cityDay(true); });

// A goal: the ball rolled at the away goal from the penalty spot.
const [px, , pz] = park.pitch; // pitch centre is z - 4 of this
const before = await L("ball");
await L("ball", [px + 7, pz - 4, 14, 0]);
await sim(3000);
const after = await L("ball");
console.log("score before", before.score, "after", after.score);
// Walk into the ball: stand west of it and warp through it.
await L("ball", [px, pz - 4, 0, 0]);
await sim(1500);
await page.evaluate(([x, z]) => window.__cityWarp(x - 3, 0.3, z), [px, pz - 4]);
await page.waitForTimeout(1500);
await page.evaluate(() => window.__cityCam(8, 0.35, 1.6));
await page.waitForTimeout(1500);
await snap("park-pitch");

// The boat.
await page.evaluate(([x, y, z]) => window.__cityWarp(x, y + 0.3, z), marina.finger);
await page.waitForTimeout(2500);
console.log("boat near:", JSON.stringify(await L("near")));
console.log("act:", await L("act"));
await page.waitForTimeout(1500);
await page.evaluate(() => window.__cityCam(9, 0.3, 0));
await page.waitForTimeout(1000);
await snap("boat-board");
await page.keyboard.down("KeyW");
await sim(4000);
console.log("throttle:", JSON.stringify(await L("state")));
await page.keyboard.down("KeyA");
await sim(2500);
await page.keyboard.up("KeyA");
await page.waitForTimeout(1200);
await snap("boat-run");
await sim(3000);
console.log("out:", JSON.stringify(await L("state")));
await page.keyboard.up("KeyW");
await sim(3000);
console.log("drifting:", JSON.stringify(await L("near")));
console.log("act:", await L("act"));
await page.waitForTimeout(2000);
console.log("after:", JSON.stringify(await L("state")));
await snap("boat-overboard");
await browser.close();
