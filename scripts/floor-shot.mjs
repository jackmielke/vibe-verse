#!/usr/bin/env node
/**
 * floor-shot — photograph the dance floor, idle and busy.
 *
 *   node scripts/floor-shot.mjs
 *
 * Two things here can only be judged by looking. Whether the floor is *in* a
 * sensible place — the plaza already has portals, a marquee, a roster board
 * and a spawn point, and a set of coordinates that seemed clear in a file can
 * put a dance floor through the middle of one of them. And whether the panels
 * read as a dance floor at all, which is a question about light rather than
 * about geometry.
 *
 * Writes `.dance-shots/floor-*.png`: an overhead of the plaza, the floor idle,
 * and the floor with the crew dancing.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.SF_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(process.cwd(), ".dance-shots");
// Where the floor was placed. Kept here so the shot follows the world rather
// than the other way round.
const FLOOR = { x: 15, z: 4 };

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server = (await up(BASE, 1200))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, BROWSER: "none" },
    });
if (server && !(await up(BASE, 120000))) {
  console.error("dev server never came up");
  process.exit(1);
}

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

console.log("· booting /city (software GL, this is slow)");
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForSelector("canvas", { timeout: 180000 });
await page.waitForTimeout(30000);
await page.waitForFunction(() => typeof window.__cityWarp === "function", null, { timeout: 60000 });

mkdirSync(OUT_DIR, { recursive: true });

// Overhead of the plaza: is the floor somewhere sensible, or on top of
// something that was already there?
await page.evaluate(() => window.__cityCam(46, 1.15, Math.PI));
await page.waitForTimeout(4000);
await page.screenshot({ path: resolve(OUT_DIR, "floor-0-plaza.png") });

// Stand ON it. An earlier version of this stood eleven metres north, which
// put the player on the transcendence portal's disc — so the harness
// teleported itself into the sky and reported that the crew never joined.
await page.evaluate(([x, z]) => window.__cityWarp(x, 0.2, z), [FLOOR.x, FLOOR.z]);
await page.waitForTimeout(2500);
await page.evaluate(() => window.__cityCam(13, 0.42, Math.PI));
await page.evaluate(() => window.__cityDay?.(false));
await page.waitForTimeout(4000);
await page.screenshot({ path: resolve(OUT_DIR, "floor-1-idle.png") });

// Dance, and let the crew join. The stagger is a bar apart at 120bpm, so the
// last of them is in after about eight seconds.
await page.keyboard.press("KeyT");
await page.waitForTimeout(12000);
/* Three frames a bar and a bit apart, because the one thing a single still
   cannot show is that the floor is cycling: the colour follows the four-bar
   chord and the checkerboard flips every beat, and a lone screenshot of a
   green floor is indistinguishable from a floor that is only ever green. */
for (const n of [2, 3, 4]) {
  await page.screenshot({ path: resolve(OUT_DIR, `floor-${n}-busy.png`) });
  await page.waitForTimeout(2200);
}
const crowd = await page.evaluate(() => {
  const el = [...document.querySelectorAll("span")].find((s) => /dancing/.test(s.textContent ?? ""));
  return el?.textContent?.trim() ?? "(no crowd HUD)";
});
console.log(`· ${crowd}`);

// And in daylight, which is how most people will first see it.
await page.evaluate(() => window.__cityDay?.(true));
await page.waitForTimeout(4000);
await page.screenshot({ path: resolve(OUT_DIR, "floor-5-day.png") });

console.log(`wrote ${OUT_DIR}/floor-*.png`);
await browser.close();
if (server) server.kill();
