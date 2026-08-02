#!/usr/bin/env node
/**
 * SEAFAIR 2117 — screenshot harness for the visual-review loop.
 *
 * Boots /seafair in headless Chromium with SwiftShader, drives it into a named
 * camera pose from tools/seafair-shots.json, and writes a PNG. Content agents
 * run this after every change; critic agents grade the PNGs.
 *
 *   node tools/seafair-shot.mjs --shot lakeview --out shots/lakeview.png
 *   node tools/seafair-shot.mjs --all --outdir shots
 *
 * SwiftShader is a software rasteriser, so a frame takes seconds rather than
 * milliseconds. Budget minutes for --all, and never treat the frame rate seen
 * here as representative of real hardware.
 */

import { chromium } from "playwright";
import { createServer } from "vite";
import { readFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : (args[i + 1] ?? true);
};
const has = (name) => args.includes(`--${name}`);

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SHOTS = JSON.parse(readFileSync(resolve(ROOT, "tools/seafair-shots.json"), "utf8"));

const width = Number(flag("width", 1920));
const height = Number(flag("height", 1080));
const settleMs = Number(flag("settle", 7000));
const character = flag("character", "spartan");
const quality = flag("quality", "high");

const CHAR_LABEL = {
  spartan: "SPARTAN-B117",
  street: "RAINIER RUNNER",
  toon: "SALMON BOY",
};

async function main() {
  const server = await createServer({
    root: ROOT,
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  const port = server.config.server.port ?? server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}/seafair`;

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

  const names = has("all") ? Object.keys(SHOTS) : [flag("shot", "lakeview")];
  const outdir = flag("outdir", "shots");
  let failures = 0;

  for (const name of names) {
    const pose = SHOTS[name];
    if (!pose) {
      console.error(`unknown shot "${name}" — have: ${Object.keys(SHOTS).join(", ")}`);
      failures++;
      continue;
    }

    const out = has("all")
      ? resolve(ROOT, outdir, `${name}.png`)
      : resolve(ROOT, flag("out", `${outdir}/${name}.png`));
    mkdirSync(dirname(out), { recursive: true });

    const page = await browser.newPage({
      viewport: { width: pose.width ?? width, height: pose.height ?? height },
      deviceScaleFactor: 1,
    });

    // The dev server has to transform a very large app on the first request;
    // the 30 s default navigation timeout is not close to enough.
    page.setDefaultNavigationTimeout(240000);
    page.setDefaultTimeout(120000);

    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      // Pointer-lock refusals are expected without a real user gesture.
      if (m.type() === "error" && !m.text().includes("Pointer Lock")) errors.push(m.text());
    });

    try {
      await page.goto(`${base}?shot=1`, { waitUntil: "load" });

      // Pin the quality tier before the world is built.
      await page.evaluate(
        (q) =>
          localStorage.setItem(
            "seafair2117:settings",
            JSON.stringify({ tier: q, autoQuality: false, showFps: false, filmGrain: true }),
          ),
        pose.quality ?? quality,
      );
      await page.reload({ waitUntil: "load" });

      await page.getByText("DEPLOY", { exact: false }).first().click({ timeout: 30000 });
      await page.waitForTimeout(400);
      await page
        .getByText(CHAR_LABEL[pose.character ?? character], { exact: false })
        .first()
        .click({ timeout: 30000 });

      await page.waitForFunction(() => !!window.__WORLD__, { timeout: 180000 });
      await page.waitForTimeout(pose.settle ?? settleMs);

      await page.evaluate((p) => {
        const w = window.__WORLD__;
        if (!w) return;
        // noclip first: the controller would otherwise clamp the camera to the
        // ground before the pose is read back.
        if (p.noclip) w.player.noclip = true;
        if (p.pos) {
          w.player.position.set(p.pos[0], p.pos[1], p.pos[2]);
          w.player.velocity.set(0, 0, 0);
        }
        if (typeof p.yaw === "number") w.player.yaw = p.yaw;
        if (typeof p.pitch === "number") w.player.pitch = p.pitch;
        if (typeof p.fov === "number") w.engine.setFov(p.fov);
      }, pose);

      await page.waitForTimeout(pose.hold ?? 2200);
      await page.screenshot({ path: out });

      // A run that half-fails still writes a plausible-looking file, and a
      // critic handed an all-black PNG will confidently grade the darkness.
      //
      // Measure the PNG on disk, not the canvas: reading a WebGL canvas back
      // through drawImage returns an empty buffer unless preserveDrawingBuffer
      // is set, so a canvas-side probe reports black for every healthy frame.
      // Compressed size is a blunt but honest proxy — a real frame of this
      // world is hundreds of kB, a flat fill is a few.
      const bytes = statSync(out).size;
      const floor = Math.max(12000, (pose.width ?? width) * (pose.height ?? height) * 0.004);

      if (bytes < floor) {
        failures++;
        console.error(
          `✗ ${name} looks BLANK (${(bytes / 1024).toFixed(0)} kB < ${(floor / 1024).toFixed(0)} kB floor) — treat as invalid and re-run.`,
        );
        if (errors.length) console.error(errors.slice(0, 8).join("\n"));
      } else {
        console.log(
          `✓ ${name} -> ${out} (${(bytes / 1024).toFixed(0)} kB)${errors.length ? ` (${errors.length} console errors)` : ""}`,
        );
        if (errors.length) console.error(errors.slice(0, 6).join("\n"));
      }
    } catch (err) {
      failures++;
      console.error(`✗ ${name} FAILED: ${err.message}`);
      if (errors.length) console.error(errors.slice(0, 8).join("\n"));
      // Capture whatever is on screen — a broken frame still diagnoses the bug.
      try {
        await page.screenshot({ path: out });
        console.error(`  (wrote the failed frame anyway to ${out})`);
      } catch {
        /* page is gone */
      }
    }

    await page.close();
  }

  await browser.close();
  await server.close();
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
