#!/usr/bin/env node
/**
 * island-shot — offline screenshot harness for VIBE ISLAND II.
 *
 * Boots the dev server (or reuses a running one), drives the game into a
 * deterministic camera pose via the debug hook the level installs on
 * `window.__sf`, waits for the frame to settle, and writes a PNG.
 *
 * This is what the art-direction critics look at. It has to be reproducible:
 * same shot key + same seed → same pixels, so "did it get better" is a real
 * question with a real answer.
 *
 * Usage:
 *   node scripts/sf-shot.mjs --shot skyline --out shots/skyline.png
 *   node scripts/sf-shot.mjs --all --outdir shots/
 *   node scripts/sf-shot.mjs --shot skyline --tod 19.5 --fog 0.6
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/* ---------------------------------------------------------------- *
 * The canonical shot list. Each is a fixed camera pose chosen to show
 * one thing clearly. Positions are world metres (see src/sf/geo/sfGeo.ts).
 * ---------------------------------------------------------------- */
export const SHOTS = {
  arrival:              { label: "The Plaza at golden hour", tod: 18.35, haze: 0.42, fov: 68 },
  "island-from-below":  { label: "Under the heart island — keel + cloud sea", tod: 18.1, haze: 0.5, fov: 74 },
  archipelago:          { label: "The whole archipelago in the haze", tod: 18.4, haze: 0.55, fov: 58 },
  "the-spill":          { label: "The lagoon pouring off the rim", tod: 18.2, haze: 0.4, fov: 64 },
  "palace-rock":        { label: "THE PALACE on its rock", tod: 18.5, haze: 0.48, fov: 60 },
  cove:                 { label: "Down at the lagoon", tod: 17.9, haze: 0.35, fov: 70 },
  "blue-hour":          { label: "After the sun goes", tod: 20.3, haze: 0.5, fov: 66 },
  "sun-behind":         { label: "The cool half of the sky", tod: 18.3, haze: 0.45, fov: 62 },
};

function parseArgs(argv) {
  const out = { width: 1920, height: 1080, wait: 9000, port: 5181 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--hud") out.hud = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[++i];
      out[key] = /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val;
    }
  }
  return out;
}

async function waitForServer(url, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv);
  const port = Number(args.port);
  const base = `http://127.0.0.1:${port}`;

  let server = null;
  const alreadyUp = await waitForServer(base, 1200);
  if (!alreadyUp) {
    server = spawn("npx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BROWSER: "none" },
    });
    server.stdout.on("data", () => {});
    server.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
    const ok = await waitForServer(base, 120000);
    if (!ok) {
      console.error("dev server never came up");
      server.kill();
      process.exit(1);
    }
  }

  // The sandbox ships a pinned Chromium that may not match the installed
  // Playwright's expected build number — point at it explicitly, and use the
  // full browser (not headless_shell) because we need real WebGL2.
  const pinned = [
    process.env.SF_CHROME,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  ].filter(Boolean);
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

  const shotKeys = args.all ? Object.keys(SHOTS) : [args.shot ?? "skyline"];
  const outdir = args.outdir ?? "shots";
  await mkdir(outdir, { recursive: true });

  const results = [];

  for (const key of shotKeys) {
    const shot = SHOTS[key];
    if (!shot) {
      console.error(`unknown shot "${key}" — known: ${Object.keys(SHOTS).join(", ")}`);
      continue;
    }
    const page = await browser.newPage({
      viewport: { width: Number(args.width), height: Number(args.height) },
      deviceScaleFactor: 1,
    });

    const logs = [];
    page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));

    const params = new URLSearchParams({
      shot: key,
      quality: args.quality ?? "high",
      tod: String(args.tod ?? shot.tod),
      haze: String(args.haze ?? shot.haze),
      fov: String(args.fov ?? shot.fov),
      headless: "1",
    });

    try {
      await page.goto(`${base}/island-2?${params}`, { waitUntil: "domcontentloaded", timeout: 90000 });

      // The level installs window.__sf and flips ready once the first fully
      // populated frame has been rendered and all streaming chunks resolved.
      await page.waitForFunction(() => window.__island?.ready === true, null, {
        timeout: Number(args.wait) * 6,
      }).catch(() => logs.push("warn: __sf.ready never became true; capturing anyway"));

      // Let TAA converge and streaming settle.
      await page.waitForTimeout(Number(args.wait));

      const outPath = args.out && shotKeys.length === 1
        ? args.out
        : path.join(outdir, `${key}.png`);
      await mkdir(path.dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath });

      const stats = await page.evaluate(() => window.__island?.stats ?? null).catch(() => null);
      results.push({ key, label: shot.label, path: outPath, stats, logs: logs.slice(-25) });
      console.log(`✓ ${key} → ${outPath}${stats ? `  (${stats.fps} fps, ${stats.drawCalls} draws, ${stats.triangles} tris)` : ""}`);
    } catch (err) {
      results.push({ key, label: shot.label, error: String(err), logs: logs.slice(-25) });
      console.error(`✗ ${key}: ${err}`);
    } finally {
      await page.close();
    }
  }

  await writeFile(path.join(outdir, "shots.json"), JSON.stringify(results, null, 2));
  await browser.close();
  if (server) server.kill();

  const failed = results.filter((r) => r.error);
  process.exit(failed.length && failed.length === results.length ? 1 : 0);
}

if (!existsSync("package.json")) {
  console.error("run from the repo root");
  process.exit(1);
}

main();
