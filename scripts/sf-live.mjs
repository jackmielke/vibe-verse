#!/usr/bin/env node
/**
 * sf-live — drive San Francisco while it is actually playing, and report back.
 *
 * `sf-shot.mjs` freezes the camera at a fixed pose with the crowd, the traffic
 * and the player switched off, because it exists to photograph the *scenery*.
 * That makes it exactly the wrong tool for "is there anyone on the street", "do
 * cars spawn", "can you get in one" — every one of which it answers by turning
 * the thing off first.
 *
 * This boots the real route with nothing disabled, optionally sends real input,
 * and prints the gameplay state the frame cannot show you: crowd and traffic
 * populations, how many vehicles are alive versus stuck waiting on physics,
 * whether the sim is paused, whether input ever arrived.
 *
 * ── A warning about frame rate ───────────────────────────────────────────
 * The sandbox has no GPU. Chromium falls back to SwiftShader and this world
 * renders at well under one frame per second, so **wall-clock time is not
 * simulated time**. Holding a key for two seconds may be two frames. Every
 * population here is also load-shed by the AI director the moment it measures
 * fps below 45 (see `spawner.setRelief`), so the numbers you get locally are
 * the floor, not the budget. Read `stepCount` — physics steps — rather than
 * seconds, and give any interaction tens of seconds to land.
 *
 * Usage:
 *   node scripts/sf-live.mjs                                  boot, sample, report
 *   node scripts/sf-live.mjs --spawn coit --out shots/coit.png
 *   node scripts/sf-live.mjs --keys w --hold 30000            walk forward
 *   node scripts/sf-live.mjs --drive                          get in the nearest car
 *   node scripts/sf-live.mjs --ped --out shots/crowd.png      look at the nearest person
 *   node scripts/sf-live.mjs --look 44,11,60,-20,11,-40       pose the camera
 *   node scripts/sf-live.mjs --vibe mayhem                     the loud version
 *   node scripts/sf-live.mjs --tod 18.6                        set the hour
 *   node scripts/sf-live.mjs --weather fog                     force conditions
 *
 * `--weather` takes `clear`, `fog`, `rain`, `storm` or `wind` and pushes a
 * synthetic report straight into the weather system, bypassing the network.
 * That is not a convenience: no weather API is reachable from the sandbox —
 * the egress proxy answers 403 to CONNECT for every one of them — so this is
 * the only way to see what a given forecast actually renders as.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = { spawn: "market", quality: "high", boot: 45000, hold: 12000, port: 5177 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "drive") out.drive = true;
    else if (key === "wave") out.wave = true;
    else if (key === "ped") out.ped = true;
    else {
      const val = argv[++i];
      out[key] = /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val;
    }
  }
  return out;
}

async function waitForServer(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const args = parseArgs(process.argv);
const base = `http://127.0.0.1:${args.port}`;

let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawn("npx", ["vite", "--port", String(args.port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, BROWSER: "none" },
  });
  if (!(await waitForServer(base, 120000))) {
    console.error("dev server never came up");
    server.kill();
    process.exit(1);
  }
}

// The sandbox ships a pinned Chromium; use the full browser, not headless_shell,
// because this needs real WebGL2.
const pinned = [process.env.SF_CHROME, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].filter(Boolean);
const executablePath = pinned.find((p) => existsSync(p));
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--force-device-scale-factor=1",
  ],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  // Blocked outbound fetches are the sandbox's proxy, not the game's fault.
  if (m.type() === "error" && !/net::/.test(m.text())) problems.push(`console: ${m.text()}`);
});

const url =
  `${base}/sf?spawn=${args.spawn}&quality=${args.quality}` +
  (args.vibe ? `&vibe=${args.vibe}` : "");
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

const state = () =>
  page.evaluate(() => {
    const s = window.__sf?.state ? window.__sf.state() : null;
    return s;
  });

// Boot. Sampled in thirds so a population that is still filling is visibly
// still filling rather than looking like a plateau.
for (let i = 0; i < 3; i++) {
  await page.waitForTimeout(args.boot / 3);
  console.log(`boot ${i + 1}/3  ${JSON.stringify(await state())}`);
}

// Clicking the canvas is what binds pointer lock and focuses the input layer.
await page.mouse.click(800, 450);
await page.waitForTimeout(600);

/** Synthetic reports. Real values, from real San Francisco days. */
const WEATHER = {
  clear: { code: 0, humidity: 42, cloudCover: 4, tempC: 21, precipMm: 0, windKph: 14, gustKph: 22, windFromDeg: 285 },
  fog:   { code: 3, humidity: 96, cloudCover: 100, tempC: 12.4, precipMm: 0, windKph: 10, gustKph: 16, windFromDeg: 265 },
  rain:  { code: 63, humidity: 92, cloudCover: 100, tempC: 12, precipMm: 2.2, windKph: 26, gustKph: 44, windFromDeg: 165 },
  storm: { code: 82, humidity: 95, cloudCover: 100, tempC: 11, precipMm: 9, windKph: 52, gustKph: 88, windFromDeg: 175 },
  wind:  { code: 1, humidity: 55, cloudCover: 20, tempC: 16, precipMm: 0, windKph: 58, gustKph: 92, windFromDeg: 290 },
};

if (args.weather) {
  const spec = WEATHER[args.weather];
  if (!spec) {
    console.error(`unknown --weather ${args.weather}; try ${Object.keys(WEATHER).join(", ")}`);
  } else {
    await page.evaluate((w) => window.__sf.forceReport(w), spec);
    /* The applied state eases toward a new report over ~30 s of wall clock,
       and this is wall clock, not frames — so a minute here is a minute of
       easing however few frames the software rasteriser manages in it.
       Twenty seconds got about half way and rain at half strength over a
       white terrace is invisible. */
    await page.waitForTimeout(70000);
  }
}

console.log(`weather        ${JSON.stringify(await page.evaluate(() => window.__sf.weather?.() ?? null))}`);
console.log(`vfx            ${JSON.stringify(await page.evaluate(() => window.__sf.vfx?.() ?? "NOT MOUNTED"))}`);

if (args.tod !== undefined) {
  /* Jump the clock. The day keeps running from wherever it is put, which is
     what you want for a screenshot and harmless for anything else.

     The fog argument is handed back whatever the weather system has already
     applied: `setWeather` writes `frame.fogDensity` directly, and passing a
     constant here would fight the real weather for one frame and then lose. */
  await page.evaluate(
    (h) => window.__sf.setWeather(h, window.__sf.weather?.()?.fogDensity ?? 0.2),
    Number(args.tod),
  );
  await page.waitForTimeout(7000);
}

if (args.wave) {
  await page.keyboard.press("z");
  await page.waitForTimeout(3000);
  console.log(`self emotes    ${await page.evaluate(() => window.__sf.selfEmotes?.() ?? -1)}`);
}

if (args.look) {
  const [px, py, pz, lx, ly, lz] = String(args.look).split(",").map(Number);
  await page.evaluate(([p, l]) => window.__sf.setPose(p, l), [[px, py, pz], [lx, ly, lz]]);
  await page.waitForTimeout(8000);
}

if (args.ped) {
  // Stand a few metres off and look at whoever is nearest. A crowd of a dozen
  // spread over a 200 m radius is not something you can find by aiming.
  const ped = await page.evaluate(() => window.__sf.nearestPedestrian());
  console.log(`nearest pedestrian ${JSON.stringify(ped)}`);
  if (ped) {
    await page.evaluate((p) => {
      window.__sf.setPose([p.x + 3.2, p.y + 1.7, p.z + 3.2], [p.x, p.y + 0.9, p.z], 55);
    }, ped);
    await page.waitForTimeout(8000);
  }
}

if (args.drive) {
  const car = await page.evaluate(() => window.__sf.nearestVehicle());
  console.log(`nearest vehicle  ${JSON.stringify(car)}`);
  if (car) {
    // Stand beside the driver's door rather than inside the car: spawning
    // inside the collider pushes the capsule out at speed.
    await page.evaluate((c) => window.__sf.teleport(c.x + 2.4, c.y + 1.2, c.z, 0), car);
    await page.waitForTimeout(9000);
    // Interact is a press, not a hold, and at this frame rate a single press
    // can land between frames.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("f");
      await page.waitForTimeout(3500);
    }
    await page.waitForTimeout(4000);
    console.log(`after interact   ${JSON.stringify(await state())}`);
  }
}

if (args.keys) {
  const keys = String(args.keys).split(",");
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(args.hold);
  for (const k of keys) await page.keyboard.up(k);
  await page.waitForTimeout(2000);
  console.log(`after input      ${JSON.stringify(await state())}`);
}

if (args.out) {
  await mkdir(path.dirname(args.out), { recursive: true });
  // `snapshot()` renders synchronously and reads the drawing buffer. Playwright's
  // own page.screenshot does not composite this WebGL canvas in software mode —
  // it returns a blank white page, which looks exactly like a crashed world.
  const dataUrl = await page.evaluate(() => window.__sf.snapshot());
  writeFileSync(args.out, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`wrote ${args.out}`);
}

console.log(problems.length ? `problems:\n  ${problems.slice(0, 10).join("\n  ")}` : "no page errors");

await browser.close();
server?.kill();
