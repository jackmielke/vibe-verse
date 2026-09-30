#!/usr/bin/env node
/**
 * venus-two — two cities on one wind.
 *
 * Opens /venus twice in ONE browser context on the `local` transport (a
 * BroadcastChannel, which is scoped to a browsing-context group: two contexts
 * silently never see each other, which looks exactly like broken netcode).
 * Checks each sees the other, that a gift arrives, and writes a frame of B
 * with A's city on its horizon to .shots/venus-two.jpg.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
const BASE = `http://127.0.0.1:${process.env.SF_PORT ?? 5177}`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 640 } });
const open = async (name) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(`[${name}]`, e.message));
  await p.goto(`${BASE}/venus?quality=low&net=local&room=test&fresh&play`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => window.__venus?.phase === "play", null, { timeout: 120000 });
  await p.evaluate((n) => {
    const v = window.__venus; v.sim.s.cityName = n;
    for (const id of ["dome", "bladder", "solar", "dome", "greenhouse", "jazz"]) { v.sim.s.res.carbon = 500; v.sim.s.res.air = 300; const s = v.sim.freeSlots()[0]; v.sim.build(id, s.q, s.r); }
  }, name);
  return p;
};
const a = await open("Ishtar Station");
const b = await open("Lakshmi");
let ok = false;
for (let i = 0; i < 20 && !ok; i++) {
  await a.waitForTimeout(1500);
  const [pa, pb] = await Promise.all([a.evaluate(() => window.__venus.api.peers().map((p) => p.name)), b.evaluate(() => window.__venus.api.peers().map((p) => p.name))]);
  console.log("A sees", pa, "B sees", pb);
  ok = pa.includes("Lakshmi") && pb.includes("Ishtar Station");
}
const before = await b.evaluate(() => window.__venus.sim.s.res.carbon);
await a.evaluate(() => { const v = window.__venus; v.sim.s.res.carbon = 200; const p = v.api.peers()[0]; v.api.gift(p.id); });
await b.waitForTimeout(1500);
const after = await b.evaluate(() => window.__venus.sim.s.res.carbon);
console.log(`gift: B carbon ${Math.round(before)} -> ${Math.round(after)}`);
mkdirSync(".shots", { recursive: true });
const url = await b.evaluate(() => { const v = window.__venus; v.day(0.44); v.view(2.3, 0.18, 900, 300, 30, 300); v.settle(1); return v.snapshot(0.85); });
writeFileSync(".shots/venus-two.jpg", Buffer.from(url.split(",")[1], "base64"));
await browser.close();
if (!ok || after <= before) { console.error("FAILED"); process.exit(1); }
console.log("two cities, one wind: ok");
