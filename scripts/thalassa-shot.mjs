#!/usr/bin/env node
/**
 * thalassa-shot — boot /thalassa in headless Chromium and write what the
 * world actually rendered, through `window.__thalassa.snapshot()` (a software
 * WebGL canvas cannot be screenshotted by the page).
 *
 * Usage:
 *   node scripts/thalassa-shot.mjs                         # the painting's view → thalassa-0.jpg
 *   node scripts/thalassa-shot.mjs quay temple             # walk to named places, one frame each
 *   node scripts/thalassa-shot.mjs "@-150,150,230,40,0,10" # a free camera: eye then target
 *   OUT=dir W=960 H=540 node scripts/thalassa-shot.mjs …
 * Exits non-zero if the page logged an error or a shader failed to compile.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const shots = process.argv.slice(2);
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
  if (/Router Future Flag|ERR_CERT|ERR_TUNNEL|Failed to load resource|WebSocket connection|supabase|vibe-explore/i.test(t)) return;
  if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${t.slice(0, 600)}`);
});

const t0 = Date.now();
await page.goto(`${BASE}/thalassa?go`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__thalassa), null, { timeout: 180000 });
console.log("booted in", ((Date.now() - t0) / 1000).toFixed(1), "s");
await page.waitForTimeout(Number(process.env.SETTLE ?? 8000));
await page.evaluate(() => window.__thalassa.settle(1));

async function shot(name) {
  const data = await page.evaluate(() => window.__thalassa.snapshot());
  const buf = Buffer.from(data.split(",")[1], "base64");
  const file = join(OUT, `${name}.jpg`);
  writeFileSync(file, buf);
  const stats = await page.evaluate(() => window.__thalassa.stats());
  console.log(file, `${buf.length} bytes`, JSON.stringify(stats));
}

const list = shots.length ? shots : ["@-170,140,250,40,0,10"];
let i = 0;
for (const s of list) {
  if (s.startsWith("@")) {
    const v = s.slice(1).split(",").map(Number);
    await page.evaluate((v) => window.__thalassa.pose(v[0], v[1], v[2], v[3], v[4], v[5], v[6] || 60), v);
  } else if (s.startsWith("walk:")) {
    const [x, z, yaw] = s.slice(5).split(",").map(Number);
    await page.evaluate(([x, z, yaw]) => { window.__thalassa.free(); window.__thalassa.teleport(x, z, yaw); }, [x, z, yaw]);
  } else {
    await page.evaluate((id) => { window.__thalassa.free(); window.__thalassa.goTo(id); }, s);
  }
  await page.evaluate(() => window.__thalassa.settle(0.2));
  await shot(`thalassa-${i++}`);
}

if (errors.length) {
  console.log("errors:");
  for (const e of errors.slice(0, 20)) console.log("  ", e);
}
await browser.close();
server?.kill();
process.exit(errors.some((e) => /shader|error/i.test(e)) ? 1 : 0);
