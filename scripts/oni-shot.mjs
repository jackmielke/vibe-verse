#!/usr/bin/env node
/**
 * oni-shot — several players in one square, in one headless browser.
 *
 * Opens N player tabs on the `local` transport (a BroadcastChannel, so every
 * tab of this one browser context is in the same room) plus, with SHOW=1,
 * the projector. Starts a round, walks the oni into a runner with
 * `__oni.teleport`, and prints what every tab believes: the round, who has
 * horns, the phase. Frames come from `__oni.snapshot()` because
 * `page.screenshot()` cannot composite a software WebGL canvas.
 *
 * Usage:
 *   node scripts/oni-shot.mjs            # 3 players, oni-*.jpg
 *   N=4 SHOW=1 OUT=dir node scripts/oni-shot.mjs
 *   BOTS=6 node scripts/oni-shot.mjs     # one player against local bots
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const N = Number(process.env.N ?? 3);
const BOTS = Number(process.env.BOTS ?? 0);
const OUT = process.env.OUT ?? ".";
const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = `t${Date.now().toString(36)}`;
mkdirSync(OUT, { recursive: true });

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
const server = (await up(BASE, 1200)) ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, BROWSER: "none" } });
if (server && !(await up(BASE, 120000))) { console.error("dev server never came up"); process.exit(1); }

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
});
// One context: BroadcastChannel does not cross browser contexts.
const ctx = await browser.newContext({ viewport: { width: Number(process.env.W ?? 960), height: Number(process.env.H ?? 540) } });
const errors = [];
const names = ["Jack", "Maya", "Sam", "Ren", "Ivy", "Kai"];
const chars = ["Pug", "Wizard", "flux", "Cow", "Ninja_Female", "webslinger"];
const pages = [];
const open = async (url, label) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${label}: ${String(e)}`));
  p.on("console", (m) => {
    const t = m.text();
    if (/Router Future Flag|ERR_CERT|ERR_TUNNEL|Failed to load resource|WebSocket connection|GPU stall|swiftshader/i.test(t)) return;
    if (m.type() === "error") errors.push(`${label} [error] ${t.slice(0, 300)}`);
  });
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => !!window.__oni, null, { timeout: 90000 });
  return p;
};
const count = BOTS ? 1 : N;
for (let i = 0; i < count; i++) {
  const q = BOTS ? `bots=${BOTS}` : `net=local&room=${ROOM}`;
  pages.push(await open(`${BASE}/oni?go=1&${q}&name=${names[i]}&char=${chars[i % chars.length]}`, names[i]));
}
const show = process.env.SHOW === "1" && !BOTS ? await open(`${BASE}/oni?show&net=local&room=${ROOM}`, "show") : null;

const state = (p) => p.evaluate(() => window.__oni.state());
const shoot = async (p, name) => {
  const data = await p.evaluate(() => window.__oni.snapshot(0.85));
  writeFileSync(join(OUT, name), Buffer.from(data.split(",")[1], "base64"));
  console.log("wrote", join(OUT, name));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Let presence go round and bodies load.
await wait(8000);
for (const p of pages) { const s = await state(p); console.log(s.id, "sees", s.peers.map((x) => x.name).join(", ") || "nobody", "| net", s.net, s.connected); }
await shoot(pages[0], "oni-lobby.jpg");

// Start a round from the first tab.
await pages[0].evaluate(() => window.__oni.start());
await wait(1500);
const rounds = await Promise.all(pages.map(async (p) => (await state(p)).round?.id));
console.log("round ids:", rounds.join(" "), new Set(rounds).size === 1 ? "(agree)" : "(DISAGREE)");
await wait(6000);
let s0 = await state(pages[0]);
console.log("phase", s0.phase, "first oni", s0.round?.first);
await shoot(pages[0], "oni-play.jpg");

if (!BOTS && pages.length >= 2) {
  // Walk the oni onto a runner.
  const all = await Promise.all(pages.map(state));
  const oniIdx = all.findIndex((s) => s.me.oni);
  const runIdx = all.findIndex((s) => !s.me.oni);
  const target = all[runIdx].me;
  await pages[oniIdx].evaluate(([x, z]) => window.__oni.teleport(x + 0.6, z), [target.x, target.z]);
  await wait(4000);
  const after = await Promise.all(pages.map(state));
  for (const s of after) console.log(s.id, "oni?", s.me.oni, "| thinks oni:", [s.id, ...s.peers.map((p) => p.id)].filter((id, k) => (k === 0 ? s.me.oni : s.peers[k - 1].oni)).join(","), "| tags", s.tags.length, "| phase", s.phase);
  await shoot(pages[oniIdx], "oni-tag.jpg");
} else {
  await wait(20000);
  s0 = await state(pages[0]);
  console.log("after 20 s with bots: phase", s0.phase, "tags", s0.tags.length, "me oni", s0.me.oni);
  await shoot(pages[0], "oni-bots.jpg");
}
if (show) await shoot(show, "oni-show.jpg");

console.log(errors.length ? `errors:\n${errors.join("\n")}` : "no page errors");
await browser.close();
server?.kill();
process.exit(errors.some((e) => /pageerror|Error|shader/i.test(e)) ? 1 : 0);
