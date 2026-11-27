#!/usr/bin/env node
/**
 * city-chopper — five stars in Vibe City: the police chopper comes out, shoots
 * and fires rockets, you get taken down, then it gets shot down. Also cycles
 * the camera mode toggle and photographs each mode.
 *
 *     node scripts/city-chopper.mjs [outDir]
 *
 * Needs a dev server on 5184 (`npx vite --port 5184 --strictPort --host 127.0.0.1`).
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/city-chopper");
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
page.on("console", (m) => { if (m.type() === "error" && /shader|THREE|WebGL|chopper/i.test(m.text())) errors.push(m.text().slice(0, 300)); });
await page.route("**/functions/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
await page.addInitScript(() => { try { localStorage.removeItem("city.camMode"); } catch { /* */ } });

console.log("· loading Vibe City");
await page.goto(`${BASE}/city?spawn=hub`, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__cityCrash && !!window.__cityMayhem && !!window.__cityWarp, null, { timeout: 300000, polling: 1000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.__cityDay?.(true));
const render = (on) => page.evaluate((v) => window.__cityCrash.render(v), on);
const shot = async (name, wait = 2500) => {
  await render(true);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 180000 });
  console.log(`   → ${name}.png`);
  await render(false);
};
const dbg = () => page.evaluate(() => {
  const d = window.__cityMayhem.debug();
  return { heat: d.heat, hp: Math.round(d.hp), downs: d.downs, chopper: d.chopper };
});
const warp = async (x, y, z, cam) => {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(([x, y, z, cam]) => { window.__cityWarp(x, y, z); if (cam) window.__cityCam(...cam); }, [x, y, z, cam]);
    await page.waitForTimeout(400);
  }
};

await warp(0, 0, 14, [14, 0.45, Math.PI]);
console.log("· five stars");
await page.evaluate(() => { window.__cityMayhem.setHeat(5); window.__cityMayhem.spawnChopper(30, 30); });
for (let i = 0; i < 8; i++) {
  await page.evaluate(() => window.__cityMayhem.setHeat(5));
  await page.waitForTimeout(5000);
  const d = await dbg();
  console.log("  ", JSON.stringify(d));
  if (i === 2) await shot("01-chopper-hunting", 2000);
}
await shot("02-under-fire", 2000);
console.log("· shoot it down");
await page.evaluate(() => window.__cityMayhem.hurtChopper(1000));
await page.waitForTimeout(6000);
console.log("  ", JSON.stringify(await dbg()));
await shot("03-chopper-down", 1500);

console.log("· camera modes");
await page.evaluate(() => window.__cityMayhem.setHeat(0));
for (const name of ["chase", "first"]) {
  await page.getByTestId("camera-mode-toggle").click({ force: true });
  await page.waitForTimeout(800);
  console.log(`   toggle reads "${await page.getByTestId("camera-mode-toggle").innerText()}", saved=${await page.evaluate(() => localStorage.getItem("city.camMode"))}`);
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(6000);
  await page.keyboard.up("KeyD");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(6000);
  await page.keyboard.up("KeyW");
  await shot(`04-${name}`, 2000);
}
console.log(errors.length ? `!! ${errors.length} errors:\n${errors.slice(0, 8).join("\n")}` : "· no page errors");
await browser.close();
