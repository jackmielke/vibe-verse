#!/usr/bin/env node
/**
 * city-squad — call the samurai bodyguards, set the police on yourself, and
 * watch the squad fight. Photographs each stage and prints how many cruisers
 * they wrecked.
 *
 *     node scripts/city-squad.mjs [outDir]
 *
 * Needs a dev server on 5184 (`npx vite --port 5184 --strictPort --host
 * 127.0.0.1`). The voice cannot be reached from the sandbox, so this drives
 * the typed box, which runs the same tool calls the voice model makes.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/city-squad");
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
page.on("console", (m) => { if (m.type() === "error" && /shader|THREE|WebGL|bodyguard/i.test(m.text())) errors.push(m.text().slice(0, 300)); });
await page.route("**/functions/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
await page.addInitScript(() => { try { localStorage.removeItem("city.squad"); } catch { /* */ } });

console.log("· loading Vibe City");
await page.goto(`${BASE}/city?spawn=hub&squad`, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__cityCrash && !!window.__citySquad && !!window.__cityWarp, null, { timeout: 300000 });
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
const squad = () => page.evaluate(() => window.__citySquad.debug());
const warp = async (x, y, z, cam) => {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(([x, y, z, cam]) => { window.__cityWarp(x, y, z); if (cam) window.__cityCam(...cam); }, [x, y, z, cam]);
    await page.waitForTimeout(400);
  }
};

await warp(0, 0, -4, [9, 0.25, Math.PI]);
console.log("· open the squad and type 'protect me'");
await page.getByTestId("squad-toggle").click();
await page.getByTestId("squad-input").fill("protect me");
await page.getByTestId("squad-input").press("Enter");
await page.waitForFunction(() => window.__citySquad.roster().every((g) => g.loaded), null, { timeout: 240000 });
await render(false);
await page.waitForTimeout(6000);
console.log(JSON.stringify(await squad()));
await shot("01-squad-arrives", 3000);

console.log("· walk away: they follow");
await warp(0, 0, 14, [9, 0.25, Math.PI]);
await render(false);
await page.waitForTimeout(8000);
console.log(JSON.stringify((await squad()).map((g) => [g.id, g.x.toFixed(1), g.z.toFixed(1), g.anim])));

console.log("· three stars and 'attack'");
await page.evaluate(() => window.__cityMayhem.setHeat(3.5));
await page.getByTestId("squad-input").fill("get the cops!");
await page.getByTestId("squad-input").press("Enter");
let best = null;
for (let i = 0; i < 18; i++) {
  await page.waitForTimeout(5000);
  const d = await squad();
  const cops = await page.evaluate(() => window.__cityMayhem.debug().cops);
  const wrecks = d.reduce((n, g) => n + g.wrecks, 0);
  console.log(`   t+${(i + 1) * 5}s cops ${cops.map((c) => `${c.target}:${Math.round(c.hp)}`).join(" ")} | guards ${d.map((g) => `${g.id}:${g.anim}${g.target >= 0 ? "*" : ""}`).join(" ")} | wrecks ${wrecks}`);
  if (i === 3 || (wrecks > 0 && !best)) { best = true; await page.evaluate(() => { const p = window.__citySquad.debug()[0]; window.__cityCam(12, 0.3, Math.PI); return p; }); await shot(`02-fight-${i}`, 2500); }
  if (wrecks >= 2) break;
}
await page.getByTestId("squad-order-cheer").click();
await page.waitForTimeout(3000);
await shot("03-cheer", 3000);
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
await browser.close();
