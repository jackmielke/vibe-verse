#!/usr/bin/env node
/**
 * magician-wands: the projector, a player in the valley, and a phone as a
 * spell remote, all on the local transport in one browser context. The phone
 * presses a few spells; the script prints what the projector and the player
 * heard and saves a frame from each, plus the phone's page.
 *
 *   node scripts/magician-wands.mjs <out-dir>   (needs the dev server on 5177)
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
const OUT = process.argv[2] ?? "magician-wands";
mkdirSync(OUT, { recursive: true });
const ROOM = "w" + Date.now().toString(36);
const BASE = process.env.BASE ?? "http://127.0.0.1:5177";
const SPELLS = (process.env.SPELLS ?? "night,aurora,lanterns,snow").split(",");
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
const ctx = await browser.newContext({ viewport: { width: Number(process.env.W ?? 960), height: Number(process.env.H ?? 540) } });
const errs = [];
const watch = (p, name) => {
  p.on("pageerror", (e) => errs.push(name + ": " + String(e)));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load|ERR_|WebSocket/.test(m.text())) errs.push(name + " console: " + m.text().slice(0, 200)); });
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (p, n) => { const d = await p.evaluate(() => window.__magician.snapshot()); writeFileSync(`${OUT}/${n}`, Buffer.from(d.split(",")[1], "base64")); };

// The projector first, so it is the one that answers everybody's hello.
const proj = await ctx.newPage(); watch(proj, "projector");
await proj.goto(`${BASE}/magician?show&net=local&room=${ROOM}`, { waitUntil: "domcontentloaded" });
await proj.waitForFunction(() => !!window.__magician?.snapshot, null, { timeout: 240000 });

// A player walking in the valley.
const walker = await ctx.newPage(); watch(walker, "walker");
await walker.goto(`${BASE}/magician?net=local&room=${ROOM}&nointro`, { waitUntil: "domcontentloaded" });
await walker.waitForSelector("input[placeholder='Your name']", { timeout: 240000 });
await walker.fill("input[placeholder='Your name']", "Jack", { timeout: 240000 });
await walker.getByRole("button", { name: /enter hoshimura/i }).click({ timeout: 240000, noWaitAfter: true });
await walker.waitForFunction(() => !!window.__magician?.tag, null, { timeout: 240000 });

// The phone: same context, or it would never hear the others (BroadcastChannel is per context).
const remote = await ctx.newPage(); watch(remote, "remote");
await remote.setViewportSize({ width: 390, height: 844 });
await remote.goto(`${BASE}/magician?remote&net=local&room=${ROOM}&name=Maya&go`, { waitUntil: "domcontentloaded" });
await remote.waitForSelector("[data-spell]", { timeout: 120000 });
if (process.env.TRACE) await remote.evaluate((room) => {
  const ch = new BroadcastChannel(`magician-${room}`);
  window.__trace = [];
  ch.onmessage = (e) => { const m = e.data; if (m.t === "s" || m.t === "full") window.__trace.push(`${m.t} from ${m.id}${m.to ? " to " + m.to : ""}: ${Object.keys(m.patch ?? m.state).join(",")} t=${(m.patch ?? m.state).timeOfDay ?? "-"}`); else if (m.t !== "p") window.__trace.push(m.t + " from " + m.id); };
}, ROOM);
await wait(3000);
for (const s of SPELLS) {
  await remote.click(`[data-spell=${s}]`);
  console.log("cast", s, "→ phone says", await remote.textContent("[data-now]"));
  await wait(3400);
}
await wait(4000);
const read = (p) => p.evaluate(() => { const s = window.__magician.state?.() ?? null; return s && { weather: s.weather, time: +s.timeOfDay.toFixed(1), aurora: s.aurora, wishes: s.wishes.length }; });
console.log("projector state", JSON.stringify(await read(proj)));
console.log("walker state   ", JSON.stringify(await read(walker)));
console.log("projector feed ", JSON.stringify(await proj.$$eval("[data-feed] > div", (d) => d.map((x) => x.textContent))));
console.log("remote feed    ", JSON.stringify(await remote.$$eval("[data-feed] > div", (d) => d.map((x) => x.textContent))));
if (process.env.SETTLE) for (const p of [proj, walker]) await p.evaluate((s) => window.__magician.settle?.(s), Number(process.env.SETTLE));
await shot(proj, "projector.jpg");
await shot(walker, "walker.jpg");
try { await remote.screenshot({ path: `${OUT}/remote.png`, timeout: 60000 }); } catch { console.log("remote screenshot timed out"); }
try { await proj.screenshot({ path: `${OUT}/projector-hud.png`, timeout: 90000 }); } catch { console.log("projector hud screenshot timed out"); }
if (process.env.TRACE) console.log((await remote.evaluate(() => window.__trace)).join("\n"));
console.log(errs.join("\n") || "no errors");
await browser.close();
