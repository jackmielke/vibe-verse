#!/usr/bin/env node
/**
 * THE VIBEVERSE — screenshot harness for the contested landing site.
 *
 * Boots /vibeverse in headless Chromium with SwiftShader, folds to Redline,
 * lands on it, steps out of the ship, poses the on-foot camera and writes a
 * PNG. It exists because `world/Battlefield.js` and `world/Troopers.js` are
 * the only parts of this route that cannot be judged from their numbers: a
 * base that sits a metre under the terrain and a base that sits on it produce
 * the same array of instance matrices.
 *
 *   node tools/longsilence-shot.mjs --shot ramp --out shots/ls-ramp.png
 *   node tools/longsilence-shot.mjs --all --outdir shots
 *
 * Poses are in the ground scene's own metres, the frame the whole fight is
 * authored in: the ship is at the origin with its nose at z = -42, you step out
 * at (30, -62), the allied line forms at z = -100 and the hostile line at -128.
 * Yaw 0 is looking downrange (-Z), which is the convention `disembark` uses.
 *
 * SwiftShader is a software rasteriser and this is the heaviest scene in the
 * repository: budget one to three minutes per frame, and never read the frame
 * rate here as anything but a smoke test.
 */

import { chromium } from "playwright";
import { createServer } from "vite";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : (args[i + 1] ?? true);
};
const has = (name) => args.includes(`--${name}`);

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** x, z and yaw in ground metres; `up` lifts the eye above the terrain. */
const SHOTS = {
  // What the player sees on the frame the ramp comes down. This is the shot
  // that matters most: both lines, both bases and the cover between them.
  ramp: { x: 30.2, z: -62.2, yaw: 0, pitch: -0.04 },
  // Over the allied compound, looking downrange past your own line.
  allybase: { x: -14, z: -50, yaw: -0.35, pitch: -0.12, up: 26 },
  // Down in the cover, where the fight actually is.
  midfield: { x: 26, z: -104, yaw: 0.1, pitch: 0.0 },
  // The hostile compound, from the far side of no man's land.
  enemybase: { x: 34, z: -140, yaw: 0.0, pitch: -0.02, up: 4 },
  // The whole engagement from above, for checking the layout rather than the look.
  plan: { x: 30, z: -110, yaw: 0, pitch: -1.2, up: 150 },
};

const width = Number(flag("width", 1600));
const height = Number(flag("height", 900));
const settleMs = Number(flag("settle", 6000));

async function main() {
  const server = await createServer({
    root: ROOT,
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  /* The listening socket, never `config.server.port`. With `port: 0` the
     resolved config still reports Vite's default 5173, and if anything else on
     the machine is already serving there the harness cheerfully drives someone
     else's app and reports a broken build. */
  const port = server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}/vibeverse`;

  const browser = await chromium.launch({
    executablePath:
      process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  });

  const names = has("all") ? Object.keys(SHOTS) : [flag("shot", "ramp")];
  const outdir = flag("outdir", "shots");
  let failures = 0;

  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  page.setDefaultNavigationTimeout(300000);
  page.setDefaultTimeout(180000);

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    // Pointer-lock refusals are expected without a real user gesture, and the
    // fleet socket is not running under the harness.
    const t = m.text();
    if (m.type() === "error" && !t.includes("Pointer Lock") && !t.includes("fleet")) errors.push(t);
  });

  /* Every wait is bounded and announced.
     The first version of this file awaited a `page.evaluate` that folded,
     landed and disembarked in one call. `evaluate` has no timeout, so when the
     software rasteriser took longer than expected over the ground scene the
     harness sat silent for half an hour with nothing to say about which step it
     was in. Anything that can block is now its own stage with its own deadline
     and its own line of output. */
  const t0 = Date.now();
  const stage = (msg) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);
  const deadline = Number(flag("deadline", 900)) * 1000;
  const guard = (p, ms, what) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms)),
  ]);

  try {
    stage("loading the route");
    await page.goto(base, { waitUntil: "load" });
    /* The boot screen has two panels with the same class. The first is the
       mobile gate, which a desktop viewport never sees; the second shows WAKE
       only once the world is assembled — which under SwiftShader is minutes,
       not the 30 s a default timeout would allow. */
    const wake = page.locator("button.boot-start", { hasText: "WAKE" });
    await wake.waitFor({ timeout: deadline });
    stage("assembled — waking");
    await wake.click();
    await page.waitForFunction(() => !!window.__game && window.__game.started, { timeout: 240000 });

    stage("folding to Redline");
    await guard(page.evaluate(async () => {
      const g = window.__game;
      const id = g.galaxy.findIndex((s) => s.world && s.world.key === "redline");
      if (id < 0) throw new Error("no redline system on the chart");
      if (id !== g.currentSystemId) await g.loadSystem(id);
    }), deadline, "the fold");

    stage("landing");
    const landed = await guard(page.evaluate(async () => {
      const g = window.__game;
      const body = g.bodies.find((b) => b.spec && b.spec.contested);
      if (!body) return "no contested body in this system";
      /* Straight to within landing range rather than flying there. `canLand`
         wants the ship inside 2.6 radii and nothing else, and the approach is
         not what this harness is for. */
      g.ship.absPos.set(body.absPos.x, body.absPos.y + body.radius * 1.4, body.absPos.z);
      g.ship.vel.set(0, 0, 0);
      g.target = body;
      await g.land(body, { now: true });
      // `disembark` refuses while a sequence is playing, and `land({now:true})`
      // still queues the touchdown shots even though it skips the wait.
      g.director.stop();
      g.disembark();
      if (!g.landed || !g.landed.onFoot) return "did not step out";
      return g.battlefield ? null : "landed, but no battlefield was built";
    }), deadline, "the landing");
    if (landed) throw new Error(landed);
    stage("on the ground");

    await page.waitForTimeout(settleMs);

    for (const name of names) {
      const pose = SHOTS[name];
      if (!pose) {
        console.error(`unknown shot "${name}" — have: ${Object.keys(SHOTS).join(", ")}`);
        failures++;
        continue;
      }
      const out = resolve(ROOT, has("all") ? `${outdir}/ls-${name}.png` : flag("out", `${outdir}/ls-${name}.png`));
      mkdirSync(dirname(out), { recursive: true });

      await page.evaluate((p) => {
        const g = window.__game;
        const surf = g.surface;
        const lift = p.up || 0;
        /* The walk controller re-samples the terrain every frame and clamps the
           eye to it, so an overview is taken by lying to it about where the
           ground is rather than by moving the camera — which the controller
           would put back on the next frame. */
        g.player.groundHeight = (x, z) => (surf && surf.heightAt ? surf.heightAt(x, z, 1.0) : 0) + lift;
        g.player.pos.set(p.x, 0, p.z);
        g.player.vel.set(0, 0, 0);
        g.player.yaw = p.yaw;
        g.player.pitch = p.pitch;
        g.player.groundY = g.player.groundHeight(p.x, p.z);
      }, pose);

      stage(`posing ${name}`);
      await page.waitForTimeout(Number(flag("hold", 3000)));
      await page.screenshot({ path: out });

      /* A half-failed run still writes a plausible-looking file, and a critic
         handed an all-black PNG will confidently grade the darkness. Measure
         the file, not the canvas: reading a WebGL canvas back through
         drawImage returns an empty buffer without preserveDrawingBuffer, so a
         canvas-side probe reports black for every healthy frame. */
      const bytes = statSync(out).size;
      const floor = Math.max(12000, width * height * 0.004);
      if (bytes < floor) {
        failures++;
        console.error(`✗ ${name} looks BLANK (${(bytes / 1024).toFixed(0)} kB) — treat as invalid.`);
      } else {
        console.log(`✓ ${name} -> ${out} (${(bytes / 1024).toFixed(0)} kB)`);
      }
    }
    if (errors.length) console.error(errors.slice(0, 8).join("\n"));
  } catch (err) {
    failures++;
    console.error(`✗ FAILED: ${err.message}`);
    if (errors.length) console.error(errors.slice(0, 8).join("\n"));
    try {
      mkdirSync(resolve(ROOT, outdir), { recursive: true });
      await page.screenshot({ path: resolve(ROOT, outdir, "ls-failed.png") });
      console.error(`  (wrote the failed frame to ${outdir}/ls-failed.png)`);
    } catch { /* page is gone */ }
  }

  await page.close();
  await browser.close();
  await server.close();
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
