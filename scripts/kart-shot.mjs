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
/**
 * KART_FAST=1 shrinks the viewport and drops the heaviest post passes so an
 * iteration on the software rasteriser takes seconds rather than minutes.
 * The gallery must always be shot WITHOUT it.
 */
const FAST = process.env.KART_FAST === "1";
const [W, H] = String(flag("size", FAST ? "640x360" : "1600x900")).split("x").map(Number);

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
const errors = [];
let page;

/**
 * Open a page and boot the engine on a **fresh WebGL context**.
 *
 * The gallery used to reuse one context for every mark. On the software
 * rasteriser the context is lost partway through a multi-shot run — three.js
 * fails silently when that happens, so every remaining frame came out pure
 * black and the harness cheerfully wrote all eight of them and exited 0. One
 * context per photograph costs a boot and removes the entire failure mode.
 */
async function openPage() {
  page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  // SwiftShader takes minutes per screenshot at full resolution; the default
  // 30 s action timeout is nowhere near enough.
  page.setDefaultTimeout(900000);
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Third-party asset fetches (Google Fonts) are blocked in the CI sandbox
    // and have nothing to do with the game. Cross-origin request failures are
    // reported separately below; do not fail the shot on them.
    if (/Failed to load resource/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  page.on("requestfailed", (r) => {
    const url = r.url();
    if (url.startsWith(BASE)) errors.push(`REQUESTFAILED: ${url} ${r.failure()?.errorText ?? ""}`);
    else console.log(`(ignored offsite fetch failure: ${new URL(url).host})`);
  });

  // Latch context loss so a silently dead renderer cannot be photographed.
  await page.addInitScript(() => {
    window.__kartContextLost = false;
    addEventListener(
      "webglcontextlost",
      () => {
        window.__kartContextLost = true;
      },
      true,
    );
  });

  await page.goto(`${BASE}/kart?shot=1`, { waitUntil: "domcontentloaded", timeout: 180000 });

  try {
    await page.waitForFunction(() => window.__kartReady === true, null, { timeout: 600000 });
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

  if (FAST) {
    await page.evaluate(() => {
      // The 2048² shadow map is the single most expensive thing in the frame
      // on SwiftShader (pure fill — it costs nothing on a real GPU). Shrink it
      // so iteration is bearable.
      const sun = window.__kart?.ctx.services.env?.sun;
      if (sun?.shadow) {
        sun.shadow.mapSize.set(512, 512);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      window.__kart?.ctx.services.postfx?.set({
        ssao: false,
        godRays: false,
        dof: false,
        motionBlur: false,
        taa: false,
        bloom: false,
      });
    });
  }
}

/**
 * Step the engine a fixed number of frames at a fixed dt.
 *
 * `controls` is either a literal input patch, or `"autopilot"` — which steers
 * the player down the centreline each frame. Pinning `steer: 0` for eight
 * seconds just drives the player into the first wall, which makes for a very
 * boring action shot.
 */
async function step(frames, controls, draw = true) {
  await page.evaluate(
    async ({ frames, controls, draw }) => {
      const eng = window.__kart;
      eng.stop();
      const input = eng.ctx.input;
      const auto = controls === "autopilot";
      if (controls && !auto) Object.assign(input, controls);

      // Warm-up and drive frames exist to advance the *simulation* to an
      // interesting moment; nobody looks at them. Drawing them costs ~3 s each
      // on the software rasteriser and the simulation does not read back a
      // single pixel, so skip the draw and restore it before the shutter. The
      // photographed frames are always rendered with the real stack.
      const saved = eng.renderOverride;
      if (!draw) eng.renderOverride = () => {};

      const physics = eng.ctx.services.physics;
      // Attract mode: hand the player kart to the game's own pilot, which
      // knows the racing line, the corner speeds and the jump sections. A
      // hand-rolled "throttle pinned, steer 0" drive just parks the player in
      // the first wall, which makes for a very dull action shot.
      const drive = () => {
        if (physics) physics.playerAi = true;
        input.accel = 1;
        input.brake = 0;
        input.steer = 0;
      };

      for (let i = 0; i < frames; i++) {
        if (auto) drive();
        eng.step(1 / 60);
        // Yield every so often so the rasteriser is not starved.
        if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
      }
      if (!draw) eng.renderOverride = saved;
    },
    { frames, controls, draw },
  );
}

/**
 * Frames rendered with the full stack before the shutter opens, so the
 * temporal passes (TAA history, motion-blur previous-frame) are converged on
 * the pose being photographed rather than on whatever came before it.
 */
const SETTLE = 24;

async function shoot(file, mark) {
  await page.evaluate(
    ({ mark, free }) => {
      const eng = window.__kart;
      const track = eng.ctx.services.track;
      const cam = eng.ctx.services.camera;
      if (free) {
        const [p, l] = free.split("@").map((s) => s.split(",").map(Number));
        cam?.pose({ x: p[0], y: p[1], z: p[2] }, { x: l[0], y: l[1], z: l[2] });
      } else if (mark !== null && track?.scenicPose && cam?.pose) {
        // `mark === null` means "leave the camera where the game put it" —
        // i.e. the chase cam behind the player. Any number, *including 0*,
        // is an authored beauty mark: skipping index 0 quietly dropped one
        // scenic pose out of every gallery.
        const { position, lookAt } = track.scenicPose(mark);
        cam.pose(position, lookAt, track.scenicFov?.(mark));
      }
    },
    { mark, free },
  );
  // Rendered frames, full stack, so the post settles on this pose.
  await step(SETTLE, null, true);

  // A screenshot of a dead renderer looks exactly like a screenshot of a dark
  // scene, and the critic cannot tell the difference. Check before writing.
  const health = await page.evaluate(() => {
    const canvas = window.__kart?.ctx.renderer.domElement;
    if (!canvas) return { lost: true, mean: 0, max: 0 };
    const n = 48;
    const probe = document.createElement("canvas");
    probe.width = n;
    probe.height = Math.max(1, Math.round((n * canvas.height) / canvas.width));
    const g = probe.getContext("2d");
    g.drawImage(canvas, 0, 0, probe.width, probe.height);
    const d = g.getImageData(0, 0, probe.width, probe.height).data;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += v;
      if (v > max) max = v;
    }
    return {
      lost: window.__kartContextLost === true || window.__kart.ctx.renderer.getContext().isContextLost(),
      mean: sum / (d.length / 4),
      max,
    };
  });
  if (health.lost) throw new Error(`WebGL context lost before ${file} — refusing to write a black frame`);
  if (health.max < 6) {
    throw new Error(
      `${file} is a blank frame (mean ${health.mean.toFixed(1)}, max ${health.max}) — refusing to write it`,
    );
  }

  await page.screenshot({ path: file, timeout: 900000 });
  console.log(`wrote ${file} (mean luma ${health.mean.toFixed(1)})`);
}

/** Advance the sim to the moment worth photographing, then take one frame. */
async function session(file, mark) {
  await openPage();
  // Warm and drive advance the simulation only — see `step`.
  await step(warm, null, false);
  if (drive > 0) await step(Math.round(drive * 60), "autopilot", false);
  await shoot(file, mark);
  const s = await page.evaluate(() => window.__kart?.stats ?? null);
  await page.close();
  return s;
}

let stats = null;
if (gallery > 0) {
  const base = out.replace(/\.png$/, "");
  for (let i = 0; i < gallery; i++) stats = await session(`${base}-${i}.png`, i);
} else {
  // No --pose and no --free: shoot whatever the game is showing (chase cam).
  stats = await session(out, has("pose") || free ? pose : null);
}

// Measured over the rendered settle frames only — the warm/drive frames are
// simulation-only and would flatter the number enormously.
if (stats) console.log(`frame budget: ${stats.frameMs.toFixed(1)} ms/frame (software rasteriser)`);

await browser.close();
if (server) server.kill();

if (errors.length) {
  console.log("\npage errors:\n" + errors.slice(-20).join("\n"));
  process.exit(3);
}
