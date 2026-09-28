#!/usr/bin/env node
/**
 * magician-memory: two visits from one device. The first casts a spell and
 * leaves; the second should be greeted by name, have its favourite offered
 * back, and get the old look from "like last time".
 *
 *   node scripts/magician-memory.mjs   (needs the dev server on 5177)
 */
import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://127.0.0.1:5177";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function visit(first) {
  await p.goto(`${BASE}/magician?net=off&nointro`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("input[placeholder='Your name']", { timeout: 240000 });
  console.log(first ? "first splash:" : "second splash:", (await p.textContent(".magician-splash__premise"))?.trim());
  if (first) await p.fill("input[placeholder='Your name']", "Jack");
  await p.getByRole("button", { name: /enter hoshimura/i }).click({ noWaitAfter: true });
  await p.waitForFunction(() => !!window.__magician?.cast, null, { timeout: 240000 });
  await p.waitForFunction(() => document.body.innerText.match(/Welcome|Hello|new face|Hoshimura\. Wish|Back already|old friend/), null, { timeout: 120000 }).catch(() => undefined);
  const said = await p.evaluate(() => (document.body.innerText.match(/[^\n]*(Welcome|Hello|new face|Back already|old friend)[^\n]*/) ?? [""])[0]);
  console.log("  vibey said:", said);
}
await visit(true);
await p.evaluate(() => { window.__magician.cast("northern lights"); window.__magician.cast("northern lights"); window.__magician.cast("make it snow"); });
await wait(5000);
console.log("  memory:", await p.evaluate(() => localStorage.getItem("magician.memory")));
await visit(false);
console.log("  before:", JSON.stringify(await p.evaluate(() => { const s = window.__magician.state(); return { weather: s.weather, aurora: s.aurora }; })));
console.log("  like last time:", JSON.stringify(await p.evaluate(() => window.__magician.cast("like last time").map((r) => r.output))));
console.log("  after:", JSON.stringify(await p.evaluate(() => { const s = window.__magician.state(); return { weather: s.weather, aurora: s.aurora }; })));
console.log(errs.join("\n") || "no errors");
await browser.close();
