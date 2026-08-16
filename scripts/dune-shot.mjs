#!/usr/bin/env node
/**
 * dune-shot — open The Dune Sea, ride it, and report what happened.
 *
 * Three things here can only be judged by running the world: whether the
 * board sits on the sand the shader draws (the terrain is one function, and
 * this is the check that says so), whether the slope actually accelerates
 * you without a push, and whether the sun going down changes the light.
 *
 * Usage: node scripts/dune-shot.mjs [outDir] [seconds-per-leg]
 *   DUNE_ART=<path>       capture world-card art instead of play frames
 *   DUNE_CHARACTER=<id>   seed the vibeverse-wide character pick first
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? ".";
const LEG = Number(process.argv[3] ?? 5);
const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const W = Number(process.env.SHOT_W ?? 1280);
const H = Number(process.env.SHOT_H ?? 800);
const ART = process.env.DUNE_ART;

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
  if (m.type() === "error" && !t.includes("ERR_TUNNEL") && !t.includes("WebSocket")) {
    errors.push(`console: ${t.slice(0, 400)}`);
  }
});

if (process.env.DUNE_CHARACTER) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.evaluate((id) => localStorage.setItem("lobby.character", id), process.env.DUNE_CHARACTER);
}

await page.goto(`${BASE}/dunes${ART ? "?shot=1" : ""}`, {
  waitUntil: "domcontentloaded",
  timeout: 120000,
});
if (!ART) {
  const enter = page.getByRole("button", { name: /drop in/i });
  await enter.waitFor({ timeout: 60000 });
  await enter.click();
}
// The terrain mesh is built on the main thread from ~45,000 samples of the
// height function, and the shadow march runs over every one of them. On a
// software rasteriser that is a long first frame.
await page.waitForTimeout(ART ? 16000 : 10000);

const shot = async (name) => {
  const png = await page.screenshot();
  writeFileSync(`${OUT}/${name}`, png);
  console.log(`wrote ${OUT}/${name}`);
};
const state = () => page.evaluate(() => window.__duneDebug?.state() ?? null).catch(() => null);

const hideChrome = () =>
  page
    .evaluate(() => {
      document.querySelectorAll('[class*="z-[45]"]').forEach((el) => {
        el.style.display = "none";
      });
    })
    .catch(() => {});

if (ART) {
  // Partway down the field, in the last of the light, with air under the
  // board — the honest picture of what this world is.
  await page.evaluate(() => window.__duneDebug?.warp(300, 420)).catch(() => {});
  await page.evaluate(() => window.__duneDebug?.setSun(0.34)).catch(() => {});
  for (const [key, ms] of [["KeyW", 5200], ["KeyD", 1500], ["KeyW", 4200]]) {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
  }
  // Off a crest: the camera pulls back and up for air, which is the only
  // pose in this world that puts the horizon and the sun in the same frame
  // as the board.
  await page.keyboard.press("Space");
  await page.waitForTimeout(900);
  await hideChrome();
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

await shot("dune-drop.png");
console.log("at the rim:", JSON.stringify(await state()));
console.log(
  "postfx:",
  await page.evaluate(() => JSON.stringify(window.__duneDebug?.postfx?.() ?? null)).catch(() => "?"),
);
// The same pose with the veil dialled out, so a washed frame can be blamed
// on the right pass rather than argued about.
if (process.env.DUNE_PROBE) {
  for (const mode of ["front", "double"]) {
    await page.evaluate((m) => window.__duneDebug?.probeSand(m), mode).catch(() => {});
    await page.waitForTimeout(1600);
    await shot(`dune-probe-${mode}.png`);
  }
  await page.evaluate(() => window.__duneDebug?.probeSand("off")).catch(() => {});
  await page.waitForTimeout(1200);
}

if (process.env.DUNE_NOGLOW) {
  await page.evaluate(() => window.__duneDebug?.setGlow(0)).catch(() => {});
  await page.waitForTimeout(1500);
  await shot("dune-noglow.png");
  await page.evaluate(() => window.__duneDebug?.setGlow(0.45)).catch(() => {});
  await page.waitForTimeout(1200);
}
console.log(
  "character:",
  await page
    .evaluate(() => ({
      stored: localStorage.getItem("lobby.character"),
      inWorld: window.__duneDebug?.character?.() ?? null,
    }))
    .then(JSON.stringify),
);

// Point downhill and let go: no pushing, only the slope. Speed at the end
// of this is the thing that proves gravity is wired to the terrain.
const before = await state();
await page.keyboard.down("KeyW");
await page.waitForTimeout(LEG * 1000);
await page.keyboard.up("KeyW");
await page.waitForTimeout(500);
const rolling = await state();
console.log("after a straight run:", JSON.stringify(rolling));
console.log(
  `slope did the work: ${(before?.speed ?? 0).toFixed(1)} → ${(rolling?.speed ?? 0).toFixed(1)} m/s`,
);
await shot("dune-riding.png");

// The board must be on the sand, not in it or above it. Sampled while
// moving, because a static check would pass on a flat pan.
let worstError = 0;
for (let i = 0; i < 12; i++) {
  await page.keyboard.down(i % 2 ? "KeyD" : "KeyA");
  await page.waitForTimeout(500);
  await page.keyboard.up(i % 2 ? "KeyD" : "KeyA");
  const s = await state();
  if (s && !s.airborne) worstError = Math.max(worstError, Math.abs(s.groundError));
}
console.log(`worst ground error while riding: ${worstError.toFixed(4)} m`);

// Then the end of the run: the oasis, at the bottom, in the last light.
await page.evaluate(() => window.__duneDebug?.setSun(0.05)).catch(() => {});
await page.evaluate(() => window.__duneDebug?.warp(70, 80)).catch(() => {});
await page.keyboard.down("KeyW");
await page.waitForTimeout(4000);
await page.keyboard.up("KeyW");
await page.waitForTimeout(2500);
console.log("at the oasis:", JSON.stringify(await state()));
await shot("dune-oasis.png");

if (errors.length) console.log("page errors:\n" + errors.slice(-8).join("\n"));
else console.log("no page errors");

await browser.close();
if (server) server.kill();
