#!/usr/bin/env node
/**
 * ocean-shots — photograph Vibe City's sea from the places you actually
 * judge water from.
 *
 *     node scripts/ocean-shots.mjs <outDir> [night|day|both]
 *
 * `city-flyover.mjs` orbits the plaza, which is exactly the view where the
 * ocean is a blue band at the edge of frame. Water is judged from three
 * places instead: standing on the sand with the swell coming at you, low over
 * the surf where the breaking line has to read, and from height where the
 * whole coast has to look like a coast. So this warps the player to each spot
 * (`__cityWarp`, a DEV-only hook in City.tsx) and poses the orbit camera
 * around them.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/ocean-shots");
const MODES = (process.argv[3] ?? "both") === "both" ? ["day", "night"] : [process.argv[3] ?? "day"];
const PORT = Number(process.env.CITY_PORT ?? 5181);
const BASE = `http://127.0.0.1:${PORT}`;

/** `at` is where the player stands; the camera orbits them. */
const SHOTS = [
  { name: "01-beach", at: [196, 1.2, 20], dist: 9, pitch: 0.1, yaw: -1.5708, note: "on the sand, out to sea" },
  { name: "02-surf", at: [200, 1, 20], dist: 52, pitch: 0.16, yaw: 1.5708, note: "off the break, back at the shore" },
  { name: "03-coast", at: [230, 2, 0], dist: 420, pitch: 0.5, yaw: 1.5708, note: "the east coast as a shape" },
  { name: "04-corner", at: [250, 2, 250], dist: 300, pitch: 0.45, yaw: 0.7854, note: "the rounded south-east corner" },
  { name: "05-island", at: [330, 2, -30], dist: 200, pitch: 0.55, yaw: 2.4, note: "the water beneath Vibe Island" },
  { name: "06-god", at: [0, 2, 6], dist: 700, pitch: 1.0, yaw: 0.6, note: "the whole island from above" },
  { name: "07-horizon", at: [600, 2, 0], dist: 22, pitch: 0.06, yaw: -1.5708, note: "open water to the horizon" },
];

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

mkdirSync(OUT, { recursive: true });

const server = (await up(BASE, 1200))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, BROWSER: "none" },
    });
if (server && !(await up(BASE, 180000))) {
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
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/supabase|websocket|ERR_CONNECTION|tunnel|Failed to load/i.test(t)) {
    errors.push(`console: ${t}`);
  }
});

console.log("· booting the city (software GL, this is slow)");
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(22000);
await page.waitForFunction(() => typeof window.__cityDay === "function", null, { timeout: 90000 });

// Pinned through the DEV hook rather than the toggle button: the time of day
// is a shared world setting, so a Supabase row or any peer's toggle overwrites
// a button click part-way through a run.
async function setDay(day) {
  await page.evaluate((d) => window.__cityDay(d), day);
  await page.waitForTimeout(2000);
}

for (const mode of MODES) {
  console.log(`\n=== ${mode} ===`);
  await setDay(mode === "day");
  for (const s of SHOTS) {
    // Re-asserted: the city drives its own camera in several places and any
    // of them firing mid-settle drops the shot back to head height.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(
        ([at, d, p, y, day]) => {
          window.__cityDay(day);
          window.__cityWarp(at[0], at[1], at[2]);
          window.__cityCam(d, p, y);
        },
        [s.at, s.dist, s.pitch, s.yaw, mode === "day"],
      );
      await page.waitForTimeout(900);
    }
    const name = `${mode}-${s.name}`;
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`· ${name} — ${s.note}`);
  }
}

if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 12).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
server?.kill();
