#!/usr/bin/env node
/**
 * city-die — Vibe City's "Can die" toggle: off you can not be hurt; on, the
 * police take your health, and at zero WIPED OUT and a respawn outside the
 * police station with the heat cleared.
 *
 *     node scripts/city-die.mjs [outDir]      (W=390 TOUCH=1 for a phone)
 *
 * Needs a dev server on 5184 (`npx vite --port 5184 --strictPort --host 127.0.0.1`).
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/city-die");
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });
const exe = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const W = Number(process.env.W ?? 1200);
const touch = !!process.env.TOUCH;
const page = await browser.newPage({
  viewport: { width: W, height: touch ? Math.round(W * 2.1) : Math.round(W * 0.625) },
  hasTouch: touch, isMobile: touch,
});
page.setDefaultTimeout(240000);
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
await page.route("**/functions/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
await page.addInitScript(() => { try { localStorage.removeItem("city.canDie"); } catch { /* */ } });

await page.goto(`${BASE}/city?spawn=hub`, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__cityCrash && !!window.__cityMayhem && !!window.__cityWarp, null, { timeout: 300000, polling: 1000 });
await page.waitForTimeout(6000);
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
  return { heat: d.heat, mortal: d.mortal, hp: d.hp, downs: d.downs, copShots: d.copShots, cops: d.cops.length };
});
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) fails.push(what); };

await page.evaluate(() => window.__cityWarp(0, 0, 14));
await page.evaluate(() => { window.__cityMayhem.setHeat(4); window.__cityMayhem.hurtPlayer(60); });
let d = await dbg();
check(!d.mortal && d.hp === 100, `off by default, a hit does nothing (hp ${d.hp})`);

const btn = page.getByTestId("can-die-toggle");
if (await btn.isVisible().catch(() => false)) await btn.click();
else await page.evaluate(() => (document.querySelector('[data-testid="can-die-toggle"]'))?.click());
await page.waitForTimeout(800);
d = await dbg();
check(d.mortal, "toggle turns it on");
check(await btn.textContent().then((t) => /on/.test(t ?? "")), "button says on");

await page.evaluate(() => { window.__cityMayhem.setHeat(4); window.__cityMayhem.hurtPlayer(55); });
await page.waitForTimeout(1500);
d = await dbg();
check(d.hp === 45, `hit takes health (hp ${d.hp})`);
check(await page.getByTestId("player-hp").isVisible(), "health bar shows");
await shot("hurt");

// Let the cruisers come and shoot for a while.
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(4000);
  d = await dbg();
  if (d.copShots > 0) break;
}
console.log("  ", JSON.stringify(d));
check(d.copShots > 0 || d.cops === 0, `cops shoot at four stars (${d.copShots} shots, ${d.cops} cops)`);

const downs0 = d.downs;
if (downs0 > 0) console.log(`   (the cruisers already wiped you out ${downs0}x)`);
await page.evaluate(() => window.__cityMayhem.hurtPlayer(200));
await page.waitForTimeout(600);
d = await dbg();
check(d.downs === downs0 + 1 && d.heat === 0 && d.hp === 100, `wiped out: downs ${d.downs}, heat ${d.heat}, hp ${d.hp}`);
check(await page.getByTestId("wiped-out").isVisible().catch(() => false), "WIPED OUT overlay");
await page.screenshot({ path: `${OUT}/wiped.png`, timeout: 180000 });
await page.waitForTimeout(3500);
await shot("respawned", 800);

await btn.click().catch(() => page.evaluate(() => document.querySelector('[data-testid="can-die-toggle"]')?.click()));
await page.waitForTimeout(500);
await page.evaluate(() => window.__cityMayhem.hurtPlayer(200));
const downs1 = d.downs;
d = await dbg();
check(!d.mortal && d.downs === downs1 && d.hp === 100, "off again, nothing hurts");

console.log(errors.length ? errors.join("\n") : "no page errors");
await browser.close();
process.exit(fails.length || errors.length ? 1 : 0);
