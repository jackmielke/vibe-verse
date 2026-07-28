#!/usr/bin/env node
/**
 * sf-shot — offline screenshot harness for San Francisco: FREE FALL.
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
  skyline: {
    label: "Downtown skyline from Telegraph Hill at golden hour",
    pos: [-620, 236, -1290],
    look: [220, 70, 340],
    tod: 18.1,
    fog: 0.32,
    fov: 55,
  },
  "golden-gate": {
    label: "Golden Gate Bridge through the marine layer",
    pos: [-6200, 180, -2500],
    look: [-6800, 120, -2920],
    tod: 17.2,
    fog: 0.72,
    fov: 60,
  },
  "market-street": {
    label: "Street level on Market — asphalt, traffic, crowd",
    pos: [40, 3.2, 30],
    look: [-600, 30, -420],
    tod: 12.0,
    fog: 0.18,
    fov: 72,
  },
  "transamerica-base": {
    label: "Looking up the Transamerica Pyramid",
    pos: [-60, 2.0, -120],
    look: [-120, 240, -180],
    tod: 15.0,
    fog: 0.15,
    fov: 80,
  },
  wingsuit: {
    label: "Wingsuit dive down the face of Twin Peaks",
    pos: [-3900, 320, 4100],
    look: [-1200, 40, 900],
    tod: 8.4,
    fog: 0.45,
    fov: 92,
  },
  "night-fidi": {
    label: "Financial District at night — window lights, wet asphalt",
    pos: [220, 46, 260],
    look: [-200, 160, -300],
    tod: 22.3,
    fog: 0.4,
    fov: 62,
  },
  "painted-ladies": {
    label: "Painted Ladies with the skyline behind",
    pos: [-2980, 24, 2110],
    look: [-400, 120, -200],
    tod: 16.4,
    fog: 0.22,
    fov: 58,
  },
  "bay-water": {
    label: "Bay water + Alcatraz from the waterline",
    pos: [-1400, 4, -2600],
    look: [-1900, 40, -3680],
    tod: 10.2,
    fog: 0.5,
    fov: 65,
  },
  "chinatown-alley": {
    label: "Chinatown at dusk — signage, lanterns, narrow street",
    pos: [-330, 3.0, 240],
    look: [-420, 14, -320],
    tod: 19.6,
    fog: 0.3,
    fov: 70,
  },
  combat: {
    label: "Firefight — muzzle flash, tracers, explosion, debris",
    pos: [-500, 8, -220],
    look: [-80, 12, -60],
    tod: 14.2,
    fog: 0.2,
    fov: 76,
    action: "combat",
  },
  hud: {
    label: "Full HUD in flight — the whole player-facing frame",
    pos: [-1500, 210, -1200],
    look: [200, 60, 200],
    tod: 17.7,
    fog: 0.34,
    fov: 84,
    hud: true,
  },
  "fog-roll": {
    label: "Karl the Fog rolling over the hills",
    pos: [-2400, 240, -400],
    look: [-5200, 180, -2200],
    tod: 6.8,
    fog: 0.9,
    fov: 66,
  },
};

function parseArgs(argv) {
  const out = { width: 1920, height: 1080, wait: 9000, port: 5177 };
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
      fog: String(args.fog ?? shot.fog),
      fov: String(args.fov ?? shot.fov),
      hud: String(args.hud ?? shot.hud ?? false),
      action: String(shot.action ?? ""),
      headless: "1",
    });

    try {
      await page.goto(`${base}/sf?${params}`, { waitUntil: "domcontentloaded", timeout: 90000 });

      // The level installs window.__sf and flips ready once the first fully
      // populated frame has been rendered and all streaming chunks resolved.
      await page.waitForFunction(() => window.__sf?.ready === true, null, {
        timeout: Number(args.wait) * 6,
      }).catch(() => logs.push("warn: __sf.ready never became true; capturing anyway"));

      // Let TAA converge and streaming settle.
      await page.waitForTimeout(Number(args.wait));

      const outPath = args.out && shotKeys.length === 1
        ? args.out
        : path.join(outdir, `${key}.png`);
      await mkdir(path.dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath });

      const stats = await page.evaluate(() => window.__sf?.stats ?? null).catch(() => null);
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
