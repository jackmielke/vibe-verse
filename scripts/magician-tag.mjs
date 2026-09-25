#!/usr/bin/env node
/**
 * magician-tag: two players in the valley on the local transport, one browser
 * context. Enters both through the splash, starts a round of tag, walks the
 * oni onto the runner and prints what each tab believes.
 *
 *   node scripts/magician-tag.mjs <out-dir>   (needs the dev server on 5177)
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const OUT = process.argv[2];
const ROOM = "t" + Date.now().toString(36);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
const ctx = await browser.newContext({ viewport: { width: Number(process.env.W ?? 640), height: Number(process.env.H ?? 360) } });
const errs = [];
const pages = [];
for (const [name, i] of [["Jack", 0], ["Maya", 1]]) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(name + ": " + String(e)));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load|ERR_|WebSocket/.test(m.text())) errs.push(name + " console: " + m.text().slice(0, 200)); });
  await p.goto(`http://127.0.0.1:5177/magician?net=local&room=${ROOM}&nointro`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("input[placeholder='Your name']", { timeout: 60000 });
  if (i === 0) { await new Promise((r) => setTimeout(r, 2500)); await p.screenshot({ path: `${OUT}/mag-splash.png` }); }
  await p.fill("input[placeholder='Your name']", name, { timeout: 240000 });
  await p.getByRole("button", { name: /enter hoshimura/i }).click({ timeout: 240000, noWaitAfter: true });
  await p.waitForFunction(() => !!window.__magician?.tag, null, { timeout: 240000 });
  pages.push(p);
}
await new Promise((r) => setTimeout(r, 12000));
for (const p of pages) console.log(JSON.stringify(await p.evaluate(() => { const t = window.__magician.tag(); return { id: t.id, phase: t.phase, peers: t.peers.length }; })));
const shot = async (p, n) => { const d = await p.evaluate(() => window.__magician.snapshot()); writeFileSync(`${OUT}/${n}`, Buffer.from(d.split(",")[1], "base64")); };
await shot(pages[0], "mag-peers.jpg");
console.log("start:", await pages[0].evaluate(() => window.__magician.startTag()));
await new Promise((r) => setTimeout(r, 3000));
for (const p of pages) console.log(JSON.stringify(await p.evaluate(() => { const t = window.__magician.tag(); return { id: t.id, phase: t.phase, oni: t.oni }; })));
await new Promise((r) => setTimeout(r, 4000));
const s = await Promise.all(pages.map((p) => p.evaluate(() => window.__magician.tag())));
const oniI = s.findIndex((x) => x.oni), runI = 1 - oniI;
const runner = await pages[runI].evaluate(() => window.__magician.player());
await pages[oniI].evaluate(([x, z]) => window.__magician.teleport(x + 0.5, z), [runner.x, runner.z]);
await new Promise((r) => setTimeout(r, 6000));
for (const p of pages) console.log(JSON.stringify(await p.evaluate(() => { const t = window.__magician.tag(); return { id: t.id, phase: t.phase, oni: t.oni, peersOni: t.peers.map((x) => x.oni), hud: t.hud && { phase: t.hud.phase, result: t.hud.result } }; })));
await shot(pages[oniI], "mag-tag.jpg");
try { await pages[0].screenshot({ path: `${OUT}/mag-hud.png`, timeout: 60000 }); } catch { console.log("hud screenshot timed out"); }
console.log(errs.join("\n") || "no errors");
await browser.close();
