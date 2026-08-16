#!/usr/bin/env node
/**
 * lake-shot — open The Glass Lake, skate for a bit, and grab frames.
 *
 * A still of the title card proves nothing about this world: the aurora
 * moves, the ice mirrors it, and the carve trails only exist once somebody
 * has skated. So this presses "Step onto the ice", drives the skater
 * through a route, and writes a frame at each stop.
 *
 * Usage: node scripts/lake-shot.mjs [outDir] [seconds-per-leg]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? ".";
const LEG = Number(process.argv[3] ?? 4);
const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const W = Number(process.env.SHOT_W ?? 1280);
const H = Number(process.env.SHOT_H ?? 800);

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
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  const t = m.text();
  // Shader compile failures come through as console errors and are the one
  // thing that must never be swallowed here.
  if (m.type() === "error" && !t.includes("ERR_TUNNEL") && !t.includes("WebSocket")) {
    errors.push(`console: ${t.slice(0, 400)}`);
  }
});

// LAKE_ART=<path> captures world-card art instead of play frames: ?shot=1
// skips the title card and hides the HUD, a few shards go in to warm the
// sky, and the result is written as a downscaled JPEG.
const ART = process.env.LAKE_ART;

await page.goto(`${BASE}/glass-lake${ART ? "?shot=1" : ""}`, {
  waitUntil: "domcontentloaded",
  timeout: 120000,
});

if (!ART) {
  const enter = page.getByRole("button", { name: /step onto the ice/i });
  await enter.waitFor({ timeout: 60000 });
  await enter.click();
}
await page.waitForTimeout(ART ? 12000 : 6000);

if (ART) {
  // Half the shards: the sky has colour in it and the run still has
  // somewhere to go, which is the honest picture of this world.
  for (let i = 0; i < 6; i++) {
    await page
      .evaluate(() => {
        const d = window.__lakeDebug;
        const left = d?.shards() ?? [];
        if (left.length && d) d.warp(left[0][0], left[0][2]);
      })
      .catch(() => {});
    await page.waitForTimeout(600);
  }
  // Then a corner of the lake, and a carve into frame.
  await page.evaluate(() => window.__lakeDebug?.warp(-40, -70)).catch(() => {});
  for (const [key, ms] of [["KeyW", 3200], ["KeyD", 1800], ["KeyW", 2600]]) {
    await page.keyboard.down("ShiftLeft");
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
    await page.keyboard.up("ShiftLeft");
  }
  await page.waitForTimeout(2500);

  // The app's own home button sits over every chromeless world at left-3
  // top-3. It belongs on the route and not in the card, and the page cannot
  // hide it — it is rendered by App, above the router.
  await page
    .evaluate(() => {
      document.querySelectorAll('[class*="z-[45]"]').forEach((el) => {
        el.style.display = "none";
      });
    })
    .catch(() => {});
  await page.waitForTimeout(400);

  const png = await page.screenshot();
  const jpeg = await page.evaluate(async (d) => {
    const img = new Image();
    img.src = "data:image/png;base64," + d;
    await img.decode();
    const W = 960;
    const H = Math.round((img.height / img.width) * W);
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    c.getContext("2d").drawImage(img, 0, 0, W, H);
    return c.toDataURL("image/jpeg", 0.88);
  }, png.toString("base64"));
  writeFileSync(ART, Buffer.from(jpeg.split(",")[1], "base64"));
  console.log(`wrote ${ART}`);
  if (errors.length) console.log("page errors:\n" + errors.slice(-6).join("\n"));
  await browser.close();
  if (server) server.kill();
  process.exit(0);
}

const shot = async (name) => {
  const png = await page.screenshot();
  writeFileSync(`${OUT}/${name}`, png);
  console.log(`wrote ${OUT}/${name}`);
};

const hud = () =>
  page
    .evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 160))
    .catch(() => "");

await shot("lake-arrival.png");
console.log("HUD:", await hud());

// A lap: push forward, carve right, carve left. Long holds, because the
// software rasteriser runs the world in slow motion.
const legs = [
  ["KeyW", LEG * 2],
  ["KeyD", LEG],
  ["KeyW", LEG],
  ["KeyA", LEG],
  ["KeyW", LEG],
];
for (const [key, secs] of legs) {
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down(key);
  await page.waitForTimeout(secs * 1000);
  await page.keyboard.up(key);
  await page.keyboard.up("ShiftLeft");
}
await page.waitForTimeout(1500);
await shot("lake-skating.png");
console.log("HUD:", await hud());

// The loop this world is built on: take a shard, and the sky answers. Every
// pickup below goes through the real collision path — the harness only moves
// the skater onto the shard, it never sets the counter.
const collect = async () => {
  const before = await page.evaluate(() => window.__lakeDebug?.state()?.shards ?? -1);
  const done = await page.evaluate(() => {
    const d = window.__lakeDebug;
    const left = d?.shards() ?? [];
    if (!left.length || !d) return true;
    d.warp(left[0][0], left[0][2]);
    return false;
  });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => window.__lakeDebug?.state()?.shards ?? -1);
  return { done, before, after };
};

let guard = 0;
let last = { done: false, before: -1, after: -1 };
while (!last.done && guard++ < 40) {
  last = await collect();
}
const finalState = await page.evaluate(() => window.__lakeDebug?.state() ?? null);
console.log("after collecting:", JSON.stringify(finalState));
// Let the energy ease all the way in — the sky opens over about a second of
// world time, which is a good deal longer on a software rasteriser.
await page.waitForTimeout(6000);
await shot("lake-complete.png");
console.log("HUD:", await hud());

if (errors.length) console.log("page errors:\n" + errors.slice(-8).join("\n"));
else console.log("no page errors");

await browser.close();
if (server) server.kill();
