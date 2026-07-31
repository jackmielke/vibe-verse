#!/usr/bin/env node
/**
 * kart-shot — pose Vibe Kart and photograph it.
 *
 * The critic loop lives on this script, so it does more than `route-shot`:
 * it boots the engine in `?shot` mode, waits for `window.__kartReady`, steps
 * the simulation a fixed number of frames (deterministic — a screenshot must
 * not depend on how loaded the software rasteriser was), poses the camera at
 * one of the course's scenic marks, and writes a full-resolution PNG.
 *
 * Usage:
 *   node scripts/kart-shot.mjs <outfile> [--pose N] [--warm 240] [--drive 6]
 *                              [--size 1600x900] [--hud] [--free x,y,z@x,y,z]
 *
 *   --pose N     scenic camera mark N from the track (default 0)
 *   --warm F     simulation frames to step before shooting (default 180)
 *   --drive S    seconds of full-throttle AI-style driving before the shot
 *   --hud        keep the React HUD on (default: hidden, for clean art shots)
 *   --free a@b   free camera: position@lookAt, comma-separated metres
 *   --gallery N  write N shots, one per scenic mark, as out-0.png … out-N.png
 *
 * Exit code is non-zero if the page threw — a screenshot of a black canvas is
 * worse than no screenshot, because the critic will happily review it.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const out = args[0] ?? "kart.png";
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const pose = Number(flag("pose", 0));
const warm = Number(flag("warm", 180));
const drive = Number(flag("drive", 0));
const gallery = Number(flag("gallery", 0));
const free = flag("free", null);
const [W, H] = String(flag("size", "1600x900")).split("x").map(Number);

const PORT = Number(process.env.KART_PORT ?? 5178);
const BASE = `http://127.0.0.1:${PORT}`;

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 400));
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

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome"].find(
  (p) => existsSync(p),
);
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--js-flags=--max-old-space-size=4096",
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
});

await page.goto(`${BASE}/kart?shot=1`, { waitUntil: "domcontentloaded", timeout: 180000 });

try {
  await page.waitForFunction(() => window.__kartReady === true, null, { timeout: 300000 });
} catch {
  console.error("engine never signalled ready");
  console.error(errors.slice(-20).join("\n"));
  await page.screenshot({ path: out });
  await browser.close();
  if (server) server.kill();
  process.exit(2);
}

if (!has("hud")) {
  await page.addStyleTag({ content: "[data-kart-hud]{display:none !important}" });
}

/** Step the engine a fixed number of frames at a fixed dt. */
async function step(frames, controls) {
  await page.evaluate(
    async ({ frames, controls }) => {
      const eng = window.__kart;
      eng.stop();
      const input = eng.ctx.input;
      if (controls) Object.assign(input, controls);
      for (let i = 0; i < frames; i++) {
        eng.step(1 / 60);
        // Yield every so often so the rasteriser is not starved.
        if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
      }
    },
    { frames, controls },
  );
}

async function shoot(file, mark) {
  await page.evaluate(
    ({ mark, free }) => {
      const eng = window.__kart;
      const track = eng.ctx.services.track;
      const cam = eng.ctx.services.camera;
      if (free) {
        const [p, l] = free.split("@").map((s) => s.split(",").map(Number));
        cam?.pose({ x: p[0], y: p[1], z: p[2] }, { x: l[0], y: l[1], z: l[2] });
      } else if (mark > 0 && track?.scenicPose && cam?.pose) {
        const { position, lookAt } = track.scenicPose(mark);
        cam.pose(position, lookAt);
      }
    },
    { mark, free },
  );
  // A couple of frames so the post stack (TAA, motion blur) settles on the pose.
  await step(8, null);
  await page.screenshot({ path: file });
  console.log(`wrote ${file}`);
}

await step(warm, null);
if (drive > 0) await step(Math.round(drive * 60), { accel: 1, steer: 0 });

if (gallery > 0) {
  const base = out.replace(/\.png$/, "");
  for (let i = 0; i < gallery; i++) await shoot(`${base}-${i}.png`, i);
} else {
  await shoot(out, pose);
}

const fps = await page.evaluate(() => window.__kart?.stats ?? null);
if (fps) console.log(`frame budget: ${fps.frameMs.toFixed(1)} ms/frame (software rasteriser)`);

await browser.close();
if (server) server.kill();

if (errors.length) {
  console.log("\npage errors:\n" + errors.slice(-20).join("\n"));
  process.exit(3);
}
