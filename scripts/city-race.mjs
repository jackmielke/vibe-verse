#!/usr/bin/env node
/**
 * city-race — the Vibe Kart GP in Vibe City, start to podium.
 *
 *     node scripts/city-race.mjs <outDir>
 *
 * Needs a dev server (`npx vite --port 5184 --strictPort --host 127.0.0.1`).
 * Walks to the kiosk, presses E, takes the free race, checks the kart is held
 * on the grid through the countdown with the throttle down, then drives the
 * course by putting the kart through every gate in order for three laps
 * (drawing off, so the world steps quickly in SwiftShader) and reads the
 * result. Frames come from `__cityDebug.snapshot()`.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-race";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(300000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 400)));
await page.goto("http://127.0.0.1:5184/city?spawn=hub", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityRace && !!window.__cityDebug?.snapshot, null, { polling: 1000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.__cityDay(true));
const snap = async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); };
const R = (fn, ...a) => page.evaluate(([fn, a]) => window.__cityRace[fn](...a), [fn, a]);
const kiosk = await R("kiosk");
await page.evaluate(([x, z]) => window.__cityWarp(x - 1.5, 0.3, z), [kiosk[0], kiosk[2]]);
await page.waitForTimeout(3000);
const pill = await page.$("text=Race the Vibe Kart GP");
console.log("kiosk pill:", !!pill);
await page.keyboard.press("KeyE");
await page.waitForSelector("text=VIBE KART GP", { timeout: 60000 });
await page.screenshot({ path: `${OUT}/board.png` });
await page.click("button:has-text('Free')");
await page.evaluate(() => window.__cityCrash.throttle(1));
const g0 = await page.evaluate(() => window.__cityCrash.state());
await page.waitForTimeout(1500);
const g1 = await page.evaluate(() => window.__cityCrash.state());
console.log("countdown:", JSON.stringify(await R("ui")).slice(0, 120));
console.log("held on grid:", Math.hypot(g1.x - g0.x, g1.z - g0.z).toFixed(2), "m moved, driving", g1.driving);
await page.evaluate(() => window.__cityCam(9, 0.3, 0.4));
await snap("grid");
// Wait out the countdown.
for (let i = 0; i < 40; i++) { const u = await R("ui"); if (u.phase === "racing") break; await page.waitForTimeout(1000); }
let g2;
for (let i = 0; i < 20; i++) { await page.waitForTimeout(1000); g2 = await page.evaluate(() => window.__cityCrash.state()); if (g2.speed > 1) break; }
console.log("after GO:", Math.hypot(g2.x - g1.x, g2.z - g1.z).toFixed(2), "m moved, speed", g2.speed.toFixed(1));
await snap("go");
await page.evaluate(() => window.__cityCrash.throttle(null));
const gates = await R("gates");
await page.evaluate(() => window.__cityCrash.render(false));
for (let lap = 1; lap <= 3; lap++) {
  for (let g = 1; g <= gates.length; g++) {
    const [x, z] = gates[g % gates.length];
    await page.evaluate(([x, z]) => window.__cityDrive(x, 0, z, 0, 0, null), [x, z]);
    for (let i = 0; i < 30; i++) { await page.waitForTimeout(300); const u = await R("ui"); if (u.gate !== g % gates.length || u.phase !== "racing") break; }
  }
  const u = await R("ui");
  console.log("lap", lap, "->", u.phase, "lap", u.lap, "place", u.place, "time", u.time.toFixed(1));
  if (lap === 2) { await page.evaluate(() => window.__cityCrash.render(true)); await page.waitForTimeout(1500); await snap("gate-beam"); await page.evaluate(() => window.__cityCrash.render(false)); }
}
await page.evaluate(() => window.__cityCrash.render(true));
await page.waitForTimeout(1500);
const u = await R("ui");
console.log("result:", JSON.stringify(u.result), "phase", u.phase);
await page.screenshot({ path: `${OUT}/result.png` });
await browser.close();
