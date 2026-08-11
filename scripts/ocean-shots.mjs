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
const ONLY = process.env.SHOT_ONLY;
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
await page.waitForFunction(
  () => typeof window.__cityDay === "function" && window.__cityDebug?.camPose,
  null,
  { timeout: 90000 },
);

// Pinned through the DEV hook rather than the toggle button: the time of day
// is a shared world setting, so a Supabase row or any peer's toggle overwrites
// a button click part-way through a run.
async function setDay(day) {
  await page.evaluate((d) => window.__cityDay(d), day);
  await page.waitForTimeout(2000);
}

/**
 * Hold the pose until the camera has actually arrived at it.
 *
 * `__cityCam` is a request, not a guarantee: the arrival swoop, fast travel
 * and the kart chase all drive the camera too, and the chase camera EASES to
 * its target rather than snapping. Firing the shutter on a fixed timer is how
 * half of these came back framed on the player's back at nine metres instead
 * of the shot that was asked for. `dist` is what the camera was asked for; the
 * distance from the player is what it currently is, and those have to agree.
 */
async function hold(shot, day) {
  // State first, once. `__cityDay` goes through a React setState, and calling
  // it in the poll loop re-rendered the page every iteration — on software GL
  // that is a meaningful slice of the frame budget the camera needs to close.
  await page.evaluate(
    ([at, d, p, y, isDay]) => {
      window.__cityDay(isDay);
      window.__cityWarp(at[0], at[1], at[2]);
      window.__cityCam(d, p, y);
    },
    [shot.at, shot.dist, shot.pitch, shot.yaw, day],
  );

  // Then wait for the camera to arrive. It closes on its target by about 30%
  // per tick, and a tick here can be seconds, so a 700 m zoom needs real
  // wall-clock — the fixed four-second wait this replaced was routinely
  // shooting a shot that was still tens of metres from where it was asked to
  // be. Polls out early the moment it lands, so a real machine pays nothing.
  let last = "";
  for (let i = 0; i < 45; i++) {
    await page.evaluate(
      ([at, d, p, y]) => {
        const pose = window.__cityDebug.camPose();
        // Only re-place the player if something moved them; teleporting every
        // poll would keep resetting the target the camera is closing on.
        if (Math.hypot(pose.px - at[0], pose.py - at[1], pose.pz - at[2]) > 1.5) {
          window.__cityWarp(at[0], at[1], at[2]);
        }
        window.__cityCam(d, p, y);
      },
      [shot.at, shot.dist, shot.pitch, shot.yaw],
    );
    await page.waitForTimeout(700);
    const a = await page.evaluate(() => window.__cityDebug.camPose());
    const real = Math.hypot(a.x - a.px, a.y - a.py, a.z - a.pz);
    if (Math.abs(a.dist - shot.dist) < 1 && Math.abs(real - shot.dist) < Math.max(1.5, shot.dist * 0.06)) {
      return;
    }
    last = `asked ${shot.dist}, camDist ${a.dist.toFixed(1)}, actually ${real.toFixed(1)} m from the player`;
  }
  console.log(`  ! camera never settled on ${shot.name} (${last}); shooting anyway`);
}

for (const mode of MODES) {
  console.log(`\n=== ${mode} ===`);
  await setDay(mode === "day");
  for (const s of SHOTS.filter((x) => !ONLY || x.name.includes(ONLY))) {
    await hold(s, mode === "day");
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
