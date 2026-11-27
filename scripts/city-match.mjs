#!/usr/bin/env node
/**
 * city-match: play the Vibe Commons Cup (the 3-a-side match on the park
 * pitch in /city) the way a player does: walk to the scoreboard, press E,
 * dribble, shoot, and let the clock run.
 *
 *     node scripts/city-match.mjs <outDir>
 *
 * Dev server on 5184. Frames come from `__cityDebug.snapshot()` (a plain
 * page screenshot is blank under SwiftShader), and the match is read through
 * `__cityLandmarks.match()`.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-match";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(300000);
const errors = [];
page.on("pageerror", (e) => (errors.push(String(e)), console.log("pageerror", String(e).slice(0, 400))));
await page.goto("http://127.0.0.1:5184/city?spawn=hub", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityLandmarks?.match && !!window.__cityDebug?.snapshot, null, { polling: 1000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.__cityDay(true));
const snap = async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); };
const L = (fn, ...a) => page.evaluate(([fn, a]) => window.__cityLandmarks[fn](...a), [fn, a]);
const render = (on) => page.evaluate((v) => window.__cityCrash.render(v), on);
const sim = async (ms) => { await render(false); await page.waitForTimeout(ms); await render(true); };

const park = (await L("sites")).find((s) => s.key === "park");
const [px, , pz0] = park.pitch;
const pz = pz0 - 4; // pitch centre
// The scoreboard: E starts a match.
await page.evaluate(([x, z]) => window.__cityWarp(x, 0.3, z), [px, pz - 9.4 + 1.2]);
await page.waitForTimeout(2500);
console.log("near:", JSON.stringify((await L("near")).prompt));
console.log("act:", await L("act"));
await page.waitForTimeout(1500);
console.log("after start:", JSON.stringify(await L("match")));
await page.evaluate(() => window.__cityLandmarks.shot({ eye: [0, 0, 0], look: [0, 0, 0] }));
await page.evaluate(([x, z]) => window.__cityLandmarks.shot({ eye: [x - 2, 13, z + 15], look: [x, 0, z], fov: 55 }), [px, pz]);
await page.waitForTimeout(2000);
await snap("01-kickoff");
// Let the AI play for a while.
for (let i = 0; i < 4; i++) {
  await sim(6000);
  const m = await L("match");
  console.log("t", m.clock, "score", m.score, "phase", m.phase, "ball", m.ball.map((v) => v.toFixed(1)).join(","));
}
await snap("02-play");
// Walk onto the ball and shoot.
const m = await L("match");
const [bx, , bz] = m.ball;
await page.evaluate(([x, z]) => window.__cityWarp(x - 0.9, 0.3, z), [bx, bz]);
await page.waitForTimeout(300);
console.log("prompt at ball:", JSON.stringify((await L("near")).prompt));
console.log("shoot:", await L("act"));
await sim(3000);
console.log("after shot:", JSON.stringify(await L("match")));
await page.evaluate(() => window.__cityLandmarks.shot(null));
await page.evaluate(() => window.__cityCam?.(8, 0.35, 1.6));
await page.waitForTimeout(1500);
await snap("03-chase-cam");
console.log("hud:", await page.evaluate(() => document.querySelector('[data-testid="landmark-match"]')?.textContent));
// Fast-forward to full time.
await L("match", "clock", 119);
await sim(4000);
console.log("full time:", JSON.stringify(await L("match")));
console.log("errors:", errors.length);
await browser.close();
