#!/usr/bin/env node
/**
 * city-crash — drive the monster truck through traffic, put the Comet into a
 * wall, and watch bots lose it. Photographs each stage and prints what the
 * damage model says happened.
 *
 *     node scripts/city-crash.mjs [outDir]
 *
 * Needs a dev server (`npx vite --port 5184 --strictPort --host 127.0.0.1`);
 * the `__cityCrash` hooks only exist in dev builds. Under SwiftShader the
 * world steps at a few frames a second, so every wait here is long.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/city-crash");
const ONLY = process.argv[3] ?? "all";
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });

const exe = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const W = Number(process.env.W ?? 1200);
const page = await browser.newPage({ viewport: { width: W, height: Math.round(W * 0.625) } });
page.setDefaultTimeout(240000);
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => {
  if (m.type() === "error" && /shader|THREE|WebGL/i.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`);
});
await page.route("**/functions/v1/**", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { balance: 250, ledger: [] } }) }),
);

console.log("· loading Vibe City");
await page.goto(`${BASE}/city?spawn=hub&comet`, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__cityCrash && !!window.__cityWarp, null, { timeout: 300000 });
await page.waitForTimeout(12000);
await page.evaluate(() => window.__cityDay(true));

const render = (on) => page.evaluate((v) => window.__cityCrash.render(v), on);
const shot = async (name, wait = 1500) => {
  await render(true);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 180000 });
  console.log(`   → ${name}.png`);
  await render(false);
};
const state = () => page.evaluate(() => window.__cityCrash.state());
const fps = async () => {
  const a = await page.evaluate(() => performance.now());
  let frames = 0;
  await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n >= 5 ? r(n) : requestAnimationFrame(f)); requestAnimationFrame(f); }));
  frames = 5;
  const b = await page.evaluate(() => performance.now());
  return (frames * 1000) / (b - a);
};
console.log(`· ~${(await fps()).toFixed(1)} fps drawing`);
await render(false);
console.log(`· ~${(await fps()).toFixed(1)} fps not drawing`);

if (ONLY === "all" || ONLY === "parked") {
  console.log("· the plaza: monster truck and Comet parked");
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => { window.__cityWarp(0, 0, -4); window.__cityCam(16, 0.32, Math.PI); });
    await page.waitForTimeout(400);
  }
  await shot("01-parked", 4000);
}

if (ONLY === "all" || ONLY === "monster") {
  console.log("· monster truck down a lane of traffic");
  const before = await state();
  // Street x = 20, heading +z, in the lane cars heading +z use.
  await page.evaluate(() => window.__cityCrash.drive(2, 20 - 2.64, -110, 0, 16, 1));
  await page.evaluate(() => window.__cityCam(14, 0.3, Math.PI));
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(5000);
    const s = await state();
    console.log(`   t+${(i + 1) * 5}s z=${s.z.toFixed(1)} speed=${s.speed.toFixed(1)} hp=${s.hp?.toFixed(0)} wrecks=${s.traffic.wrecks} propsDown=${s.propsDown}`);
    if (i === 2 || i === 5) await shot(`02-monster-${i}`, 0);
  }
  const after = await state();
  console.log(`   crushed/wrecked ${after.traffic.wrecks - before.traffic.wrecks} cars, props down ${after.propsDown}`);
  await page.evaluate(() => window.__cityCrash.throttle(0));
}

if (ONLY === "all" || ONLY === "comet") {
  console.log("· the Comet into a building");
  // Along the z = 20 street heading -z, straight at the block at (40, 0).
  await page.evaluate(() => window.__cityCrash.drive(3, 40, 34, Math.PI, 44, 1));
  await page.evaluate(() => window.__cityCam(12, 0.25, 0));
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1500);
    const s = await state();
    const comet = s.vehicles[3];
    console.log(`   hp=${comet.hp.toFixed(0)} wreck=${comet.wreck.toFixed(2)} driving=${s.driving} explosions=${s.fxExplosions}`);
    if (comet.wreck > 0) {
      await shot("03-comet-boom", 0);
      await page.evaluate(() => { const s = window.__cityCrash.state().vehicles[3]; window.__cityWarp(s.x - 9, 0.2, s.z + 9); window.__cityCam(10, 0.35, Math.PI * 1.75); });
      await shot("04-comet-wreck", 5000);
      break;
    }
  }
}

if (ONLY === "all" || ONLY === "water") {
  console.log("· the monster truck into the sea");
  await page.evaluate(() => window.__cityCrash.drive(2, 200, 0, Math.PI / 2, 18, 1));
  await page.evaluate(() => window.__cityCam(13, 0.22, -Math.PI / 2 + 0.5));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const k = await page.evaluate(() => window.__cityCrash.state());
    if (k.x > 224) { console.log(`   wading at x=${k.x.toFixed(1)} speed=${k.speed.toFixed(1)}`); break; }
  }
  await shot("06-monster-wade", 0);
  await page.evaluate(() => window.__cityCrash.throttle(0));
}

if (ONLY === "all" || ONLY === "bots") {
  console.log("· bots losing it");
  await page.evaluate(() => { window.__cityWarp(20 - 6.5, 0.2, 0); window.__cityCam(26, 0.5, Math.PI * 0.75); });
  for (let i = 0; i < 6; i++) {
    const id = await page.evaluate(() => window.__cityCrash.skid());
    if (id < 0) { await page.waitForTimeout(2000); continue; }
    await page.waitForTimeout(2200);
    const c = await page.evaluate((id) => window.__cityCarsNear(0, 0, 400).find((x) => x.id === id), id);
    console.log(`   skid → car ${id} at ${c?.x.toFixed(0)},${c?.z.toFixed(0)} dmg=${c?.dmg.toFixed(0)} wreck=${c?.wreck}`);
    if (c && i < 2) {
      await page.evaluate((c) => { window.__cityWarp(c.x + 9, 0.2, c.z + 9); window.__cityCam(9, 0.3, Math.PI * 0.25); }, c);
      await shot(`05-bot-${i}`, 0);
      await page.evaluate(() => { window.__cityWarp(20 - 6.5, 0.2, 0); });
    }
  }
  const s = await state();
  console.log("   traffic", JSON.stringify(s.traffic));
}

console.log(errors.length ? `!! ${errors.length} errors:\n${errors.slice(0, 8).join("\n")}` : "· no page errors");
await browser.close();
