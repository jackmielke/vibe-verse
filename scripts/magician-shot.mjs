#!/usr/bin/env node
/**
 * magician-shot — boot /magician in headless Chromium, cast some spells, and
 * write what the world actually rendered.
 *
 * `page.screenshot()` cannot composite a software WebGL canvas, so every
 * frame here comes from `window.__magician.snapshot()`, which renders the
 * scene and reads the canvas back. That also means what you see is what the
 * renderer drew, not what the compositor managed.
 *
 * Usage:
 *   node scripts/magician-shot.mjs                       # arrival frame → magician-0.jpg
 *   node scripts/magician-shot.mjs "make it rain" "night"  # one frame per spell
 *   OUT=dir W=960 H=540 node scripts/magician-shot.mjs …   # card-art size
 *   "@teleport x z yaw" as a spell moves the player first.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const spells = process.argv.slice(2);
const OUT = process.env.OUT ?? ".";
const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server = (await up(BASE, 1200))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, BROWSER: "none" } });
if (server && !(await up(BASE, 120000))) { console.error("dev server never came up"); process.exit(1); }

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720) } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  const t = m.text();
  if (/Router Future Flag|ERR_CERT|ERR_TUNNEL|Failed to load resource|WebSocket connection/.test(t)) return;
  if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${t.slice(0, 400)}`);
});

await page.goto(`${BASE}/magician`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /enter (the valley|hoshimura)/i }).click({ timeout: 30000 });
await page.waitForFunction(() => Boolean(window.__magician), null, { timeout: 60000 });
// Let the model load and the first frames settle.
await page.waitForTimeout(Number(process.env.SETTLE ?? 6000));
await page.evaluate(() => window.__magician.settle(8));

async function shot(name) {
  const data = await page.evaluate(() => window.__magician.snapshot());
  const buf = Buffer.from(data.split(",")[1], "base64");
  const file = join(OUT, `${name}.jpg`);
  writeFileSync(file, buf);
  const counts = await page.evaluate(() => window.__magician.counts());
  const st = await page.evaluate(() => { const s = window.__magician.state(); return { time: s.timeOfDay, weather: s.weather, season: s.season, props: s.props.length }; });
  const render = await page.evaluate(() => window.__magician.render?.());
  if (process.env.BUDGET) console.log("budget", JSON.stringify(await page.evaluate(() => window.__magician.budget?.())));
  console.log(file, `${buf.length} bytes`, JSON.stringify({ ...counts, ...st }), render ? `render ${JSON.stringify(render)}` : "");
}

await shot("magician-0");
let i = 1;
for (const spell of spells) {
  if (spell.startsWith("@teleport")) {
    const [, x, z, yaw] = spell.split(/\s+/).map(Number);
    await page.evaluate(([x, z, yaw]) => window.__magician.teleport(x, z, yaw), [x, z, yaw]);
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__magician.settle(3));
    await shot(`magician-${i++}`);
    continue;
  }
  const results = await page.evaluate((s) => window.__magician.cast(s).map((r) => r.output), spell);
  console.log(`cast "${spell}" →`, results.join(" | ") || "(nothing)");
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__magician.settle(8));
  await shot(`magician-${i++}`);
}
// A shader that fails to compile is a silently missing mesh, and three only
// says so on the console. So the console is part of the result.
// EVAL="window.__magician.river()" prints whatever that expression returns.
if (process.env.EVAL) console.log("eval", JSON.stringify(await page.evaluate((e) => eval(e), process.env.EVAL)));
if (errors.length) { console.log("console/page errors:"); for (const e of errors.slice(0, 20)) console.log("  ", e); process.exitCode = 2; }
await browser.close();
server?.kill();
process.exit(0);
