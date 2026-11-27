#!/usr/bin/env node
/**
 * city-thanks — photograph Thanksgiving on Vibe Island and ride the turkey.
 *
 *     node scripts/city-thanks.mjs [outDir] [W]
 *
 * Needs a dev server on port 5184 (the hooks are dev-only). Shots: the plaza
 * and banner, the turkey on its lawn, the parade float, riding the turkey,
 * and the town plaza below. Prints whether the ride prompt showed and whether
 * the turkey got off the ground.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/city-thanks");
const W = Number(process.argv[3] ?? 1200);
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });
const exe = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: W, height: Math.round(W * 0.625) } });
page.setDefaultTimeout(240000);
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => { if (m.type() === "error" && /shader|THREE|WebGL/i.test(m.text())) errors.push(m.text().slice(0, 300)); });
await page.route("**/functions/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
await page.goto(`${BASE}/city?spawn=island&thanksgiving`, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__cityCrash && !!window.__cityMounts && !!window.__cityWarp, null, { timeout: 300000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.__cityDay(true));
const render = (on) => page.evaluate((v) => window.__cityCrash.render(v), on);
const shot = async (name, wait = 2500) => {
  await render(true);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 180000 });
  console.log(`   → ${name}.png`);
  await render(false);
};
const warp = async (x, y, z, cam) => {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(([x, y, z, cam]) => { window.__cityWarp(x, y, z); if (cam) window.__cityCam(...cam); }, [x, y, z, cam]);
    await page.waitForTimeout(500);
  }
};
const IX = 330, IY = 120, IZ = -30;

console.log("· plaza and banner");
await warp(IX + 0, IY + 0.4, IZ + 6, [18, 0.28, 0.25]);
await shot("01-plaza-banner");

console.log("· the turkey on the north lawn");
const t = await page.evaluate(() => window.__cityMounts().turkey);
console.log(`   turkey at ${t?.map((v) => v.toFixed(1)).join(", ")}`);
await warp(t[0] - 2, t[1] - 2, t[2] + 6, [9, 0.2, 0.4]);
await page.waitForTimeout(1500);
const prompt = page.getByRole("button", { name: /Ride the turkey/ });
console.log(`   ride prompt: ${await prompt.count()}`);
await shot("02-turkey");

console.log("· the parade float");
await warp(IX + 7, IY + 0.4, IZ + 24, [14, 0.25, Math.PI * 0.4]);
await shot("03-parade");

console.log("· riding the turkey");
await warp(t[0] - 2, t[1] - 2, t[2] + 4, null);
await page.waitForTimeout(1500);
await page.keyboard.press("KeyF");
await page.waitForTimeout(1500);
const y0 = await page.evaluate(() => window.__cityCrash.state().y ?? 0);
await page.keyboard.down("Space");
await page.waitForTimeout(6000);
await page.keyboard.up("Space");
const st = await page.evaluate(() => ({ s: window.__cityCrash.state(), m: window.__cityMounts().turkey }));
console.log(`   turkey now at y=${st.m[1].toFixed(1)} (rest was ${t[1].toFixed(1)})`);
await shot("04-riding", 1500);
await page.keyboard.press("KeyF");
await page.waitForTimeout(3000);
const after = await page.evaluate(() => window.__cityMounts().turkey);
console.log(`   after hopping off, turkey at ${after.map((v) => v.toFixed(1)).join(", ")}`);

console.log("· the town plaza below");
await warp(0, 0.2, 10, [16, 0.3, 0]);
await shot("05-town");

// The world-controls toggle is gone (Nov 27 2026, it became the camera
// mode); `?thanksgiving=off` is the way to see it switched off now.

console.log(errors.length ? `!! ${errors.length} errors:\n${errors.slice(0, 8).join("\n")}` : "· no page errors");
await browser.close();
