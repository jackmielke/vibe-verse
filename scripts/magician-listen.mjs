#!/usr/bin/env node
/**
 * magician-listen: record the valley's ambience in headless Chromium, for
 * checking a sound change in a sandbox with no speakers.
 *
 * Each argument is a spell (or "@teleport x z yaw"); after each one the mix
 * analysed for SECONDS (default 8): the page draws a spectrogram of the final
 * mix into listen-N.png (time across, log frequency up, 40 Hz to 24 kHz) and
 * prints the peak and the loudness each second. Wind should show as uneven
 * low energy that swells and falls; a flat band is a hiss.
 *
 *   OUT=dir node scripts/magician-listen.mjs "calm" "strong wind" "night"
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const steps = process.argv.slice(2);
const OUT = process.env.OUT ?? ".";
const SECONDS = Number(process.env.SECONDS ?? 8);
const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
const server = (await up(BASE, 1200)) ? null : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, BROWSER: "none" } });
if (server && !(await up(BASE, 120000))) { console.error("dev server never came up"); process.exit(1); }

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on("pageerror", (e) => console.error("pageerror", String(e)));
await page.goto(`${BASE}/magician`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /enter (the valley|hoshimura)/i }).click({ timeout: 30000 });
await page.waitForFunction(() => Boolean(window.__magician), null, { timeout: 60000 });
await page.waitForTimeout(4000);

let n = 0;
for (const step of ["", ...steps]) {
  if (step.startsWith("@teleport")) {
    const [x, z, yaw] = step.split(/\s+/).slice(1).map(Number);
    await page.evaluate(([x, z, yaw]) => window.__magician.teleport(x, z, yaw), [x, z, yaw]);
  } else if (step) {
    const out = await page.evaluate((s) => window.__magician.cast(s).map((r) => r.output), step);
    console.log(`cast "${step}" → ${out.join(" / ")}`);
  }
  await page.evaluate(() => window.__magician.settle(6));
  const r = await page.evaluate((s) => window.__magician.listen(s), SECONDS);
  const file = join(OUT, `listen-${n}.png`);
  writeFileSync(file, Buffer.from(r.png.split(",")[1], "base64"));
  console.log(`${file} [${r.state}] peak ${r.peak} dBFS, rms per second ${r.rms.join(" ")}`);
  n++;
}
await browser.close();
server?.kill();
process.exit(0);
