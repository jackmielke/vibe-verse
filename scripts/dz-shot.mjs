#!/usr/bin/env node
/**
 * dz-shot — the Drop Zero capture harness.
 *
 * `route-shot.mjs` is the blunt version: boot a route, wait, grab the frame.
 * That is not enough for a 3 km island, because the one frame it can get is
 * the spawn frame, and the spawn frame is never the picture you want. This
 * one boots `/drop-zero?shot=1`, waits for the engine to appear on `window`,
 * then poses the camera at a series of named vantage points and captures each
 * one — so a visual critic gets the skyline, a street, the storm and the HUD
 * rather than one lucky angle.
 *
 * Usage:
 *   node scripts/dz-shot.mjs                     # every shot, into shots/
 *   node scripts/dz-shot.mjs town street         # only those two
 *   DZ_OUT=/tmp/x node scripts/dz-shot.mjs       # elsewhere
 *
 * Exits non-zero if the page threw, so a loop can tell "ugly" from "broken".
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.DZ_PORT ?? 5178);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.DZ_OUT ?? "shots";
const WAIT = Number(process.env.DZ_WAIT ?? 30000);
/**
 * How long to let the world rebuild itself after each pose.
 *
 * This was 2.5 s and that was measurably wrong. Under SwiftSHADER the engine
 * runs at roughly one frame per second, so 2.5 s is two or three frames —
 * and camera-driven streaming (grass, tree cells, terrain LOD) needs dozens
 * to refill after the camera teleports across the island. The first capture
 * runs photographed a world that had planted about a thousand instances of a
 * possible seven thousand, and I read that as "vegetation is broken".
 *
 * It is not enough for the frame to be rendered; the frame has to be FINISHED.
 */
const SETTLE = Number(process.env.DZ_SETTLE ?? 25000);
/** Force the tier a real visitor gets. See the note in DropZero.tsx. */
const QUALITY = process.env.DZ_QUALITY ?? "high";

/**
 * Vantage points. `pose` runs in the page with the live engine, so a shot can
 * put the camera anywhere and read the world's own state to aim itself.
 * Keep each one describing a DIFFERENT quality question:
 *   - does the island read as designed from the air?
 *   - do the buildings hold up close?
 *   - does the ground detail survive at eye height?
 *   - do the signature effects (storm, loot, build) look expensive?
 */
const SHOTS = {
  /** The bus view — first thing a player ever sees. Whole-island silhouette. */
  aerial: {
    settle: SETTLE,
    pose: (e) => {
      const c = e.ctx.camera;
      c.position.set(-620, 470, 640);
      c.lookAt(60, 40, -60);
    },
  },
  /** Golden-hour approach on the marquee POI. Silhouette + roof identity. */
  town: {
    settle: SETTLE,
    pose: (e) => {
      const p = e.ctx.services.pois ?? [];
      const t = p.find((x) => x.tier === "landmark") ?? p[0];
      const c = e.ctx.camera;
      if (!t) {
        c.position.set(0, 120, 220);
        c.lookAt(0, 20, 0);
        return;
      }
      const r = Math.max(t.radius, 60);
      c.position.set(t.center.x - r * 1.5, t.center.y + r * 0.85, t.center.z + r * 1.5);
      c.lookAt(t.center.x, t.center.y + 8, t.center.z);
    },
  },
  /** Eye height in the street. Materials, trim, shadows, grass — the hard test. */
  street: {
    settle: SETTLE,
    pose: (e) => {
      const p = e.ctx.services.pois ?? [];
      const t = p.find((x) => x.tier === "landmark") ?? p[0];
      const terrain = e.ctx.services.terrain;
      const c = e.ctx.camera;
      const cx = t ? t.center.x : 0;
      const cz = t ? t.center.z : 0;
      const gx = cx - 30;
      const gz = cz + 34;
      const y = (terrain?.heightAt?.(gx, gz) ?? 0) + 1.7;
      c.position.set(gx, y, gz);
      c.lookAt(cx, y + 6, cz);
    },
  },
  /** Treeline at ground level: canopy shading, wind, grass, aerial haze. */
  nature: {
    settle: SETTLE,
    pose: (e) => {
      const terrain = e.ctx.services.terrain;
      const c = e.ctx.camera;
      // Somewhere off the road, looking at the highlands.
      const x = -260;
      const z = 300;
      const y = (terrain?.heightAt?.(x, z) ?? 0) + 1.8;
      c.position.set(x, y, z);
      c.lookAt(120, y + 90, -420);
    },
  },
  /** The coast: water shading, foam, the shoreline gradient, the horizon. */
  coast: {
    settle: SETTLE,
    pose: (e) => {
      const terrain = e.ctx.services.terrain;
      const size = terrain?.worldSize ?? 1500;
      const c = e.ctx.camera;
      c.position.set(size * 0.72, 46, size * 0.2);
      c.lookAt(size * 1.4, 0, size * 0.1);
    },
  },
  /** The storm wall, up close — the signature effect of the whole mode. */
  storm: {
    settle: 3000,
    pose: (e) => {
      const s = e.ctx.services.storm;
      const terrain = e.ctx.services.terrain;
      const c = e.ctx.camera;
      if (!s) {
        c.position.set(0, 80, 300);
        c.lookAt(0, 40, 0);
        return;
      }
      // Stand just inside the wall looking along it, so it fills the frame
      // without becoming a flat purple screen.
      const a = 0.6;
      const r = Math.max(s.radius - 40, 40);
      const x = s.center.x + Math.cos(a) * r;
      const z = s.center.z + Math.sin(a) * r;
      const y = (terrain?.heightAt?.(x, z) ?? 0) + 12;
      c.position.set(x, y, z);
      c.lookAt(s.center.x + Math.cos(a + 0.9) * (r + 120), y, s.center.z + Math.sin(a + 0.9) * (r + 120));
    },
  },
};

/**
 * Install the pose as a camera override.
 *
 * Setting `camera.position` from the outside does nothing: the player system
 * owns the camera and rewrites it in `lateUpdate`, every frame, after any
 * value we could poke in. The first run of this harness produced three
 * byte-identical screenshots of the battle bus for exactly that reason.
 *
 * `renderOverride` is the hook that works. The engine calls it last, after
 * every update and lateUpdate have run, so posing the camera inside it lands
 * after the player rig has had its say. Camera-driven systems (grass
 * streaming, terrain LOD) read the posed position on the FOLLOWING frame,
 * which is why every shot still gets a settle window rather than one frame.
 */
function installPose(fn) {
  return `(() => {
    const e = window.__dz;
    if (!e) return;
    if (!e.__dzBaseRender) e.__dzBaseRender = e.renderOverride;
    const pose = ${fn.toString()};
    e.renderOverride = (dt) => {
      pose(e);
      e.ctx.camera.updateMatrixWorld();
      if (e.__dzBaseRender) e.__dzBaseRender(dt);
      else e.ctx.renderer.render(e.ctx.scene, e.ctx.camera);
    };
  })()`;
}

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

const wanted = process.argv.slice(2).filter((a) => SHOTS[a]);
const names = wanted.length ? wanted : Object.keys(SHOTS);
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
    // SwiftSHADER is the only renderer available in this container. It is a
    // software rasteriser, so it is slow but pixel-honest: what it draws is
    // what a real GPU draws, just at two frames a minute.
    "--js-flags=--max-old-space-size=4096",
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") errors.push(`console.error: ${t}`);
  if (t.includes("failed to boot")) errors.push(t);
});

await page.goto(`${BASE}/drop-zero?shot=1&q=${QUALITY}`, { waitUntil: "domcontentloaded", timeout: 120000 });

let booted = true;
try {
  await page.waitForFunction("window.__dzReady === true", null, { timeout: WAIT });
} catch {
  booted = false;
  errors.push(`engine never signalled ready within ${WAIT}ms`);
}

/**
 * Skip the drop and put the match on the ground.
 *
 * Every shot in the first two runs was taken during the bus phase, which is
 * the one phase where the player is deliberately OUTSIDE the safe zone — so
 * the storm veil was full-screen in all six, and the island underneath was
 * judged through a purple filter that no real player ever sees for more than
 * thirty seconds. Jump, land, and let the match go live before posing.
 */
if (booted) {
  await page
    .evaluate(`(() => {
      const e = window.__dz;
      const m = e?.ctx?.services?.match;
      const p = e?.ctx?.services?.player;
      const t = e?.ctx?.services?.terrain;
      if (m && typeof m.jump === "function") m.jump();
      // Put the player on solid ground near the middle of the island rather
      // than waiting out a 40-second skydive in software rendering.
      if (p && t) {
        const x = 0;
        const z = 0;
        p.teleport(new (e.ctx.camera.position.constructor)(x, t.heightAt(x, z) + 2, z));
      }
    })()`)
    .catch((err) => errors.push(`match skip threw: ${err.message}`));
  // Let the phase machine settle into `live` before anything is captured.
  await page.waitForTimeout(8000);
}

// Let the first frames land: shadows, LOD selection, grass population and any
// lazily-compiled shader all resolve over the first second or two of running.
await page.waitForTimeout(booted ? 6000 : 2000);

const written = [];
for (const name of names) {
  const shot = SHOTS[name];
  if (booted) {
    try {
      await page.evaluate(installPose(shot.pose));
    } catch (err) {
      errors.push(`pose "${name}" threw: ${err.message}`);
    }
    await page.waitForTimeout(shot.settle);
  }
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  written.push(file);
  console.log(`wrote ${file}`);
}

// Frame telemetry, so a critic can tell "looks cheap" from "cannot afford it".
if (booted) {
  const stats = await page.evaluate("JSON.stringify(window.__dz.stats)").catch(() => null);
  if (stats) console.log(`stats ${stats}`);
}

await browser.close();
if (server) server.kill();

if (errors.length) {
  console.log("\npage errors:\n" + [...new Set(errors)].slice(0, 20).join("\n"));
}
console.log(`\n${written.length} shots in ${OUT}`);
process.exit(booted && !errors.length ? 0 : 1);
