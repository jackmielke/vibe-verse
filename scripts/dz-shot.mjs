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
const V = (e, x, y, z) => new (e.ctx.camera.position.constructor)(x, y, z);
/** Yaw/pitch aiming from a point at a target, in the engine's convention. */
const aim = (from, to) => ({
  yaw: Math.atan2(-(to.x - from.x), -(to.z - from.z)),
  pitch: Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z)),
});

const SHOTS = {
  /** High over the island — reads the whole map's silhouette and layout. */
  aerial: {
    settle: SETTLE,
    pose: (e) => {
      const pos = V(e, -520, 400, 540);
      return { pos, ...aim(pos, V(e, 60, 40, -60)) };
    },
  },
  /** Approach on the marquee POI. Silhouette + roof identity. */
  town: {
    settle: SETTLE,
    pose: (e) => {
      const list = e.ctx.services.pois ?? [];
      const t = list.find((x) => x.tier === "landmark") ?? list[0];
      if (!t) {
        const pos = V(e, 0, 120, 220);
        return { pos, ...aim(pos, V(e, 0, 20, 0)) };
      }
      const r = Math.max(t.radius, 60);
      const pos = V(e, t.center.x - r * 1.2, t.center.y + r * 0.7, t.center.z + r * 1.2);
      return { pos, ...aim(pos, V(e, t.center.x, t.center.y + 8, t.center.z)) };
    },
  },
  /** Eye height in the plaza. Materials, trim, shadows — the hard test. */
  street: {
    settle: SETTLE,
    pose: (e) => {
      const list = e.ctx.services.pois ?? [];
      const t = list.find((x) => x.tier === "landmark") ?? list[0];
      const terrain = e.ctx.services.terrain;
      const cx = t ? t.center.x : 0;
      const cz = t ? t.center.z : 0;
      const gx = cx - 34;
      const gz = cz + 38;
      const pos = V(e, gx, (terrain?.heightAt?.(gx, gz) ?? 0) + 1.0, gz);
      return { pos, ...aim(pos, V(e, cx, pos.y + 5, cz)) };
    },
  },
  /** Treeline at ground level: canopy shading, wind, grass, aerial haze. */
  nature: {
    settle: SETTLE,
    pose: (e) => {
      const terrain = e.ctx.services.terrain;
      const x = -300;
      const z = 340;
      const pos = V(e, x, (terrain?.heightAt?.(x, z) ?? 0) + 1.0, z);
      return { pos, ...aim(pos, V(e, 60, pos.y + 55, -260)) };
    },
  },
  /** The coast: water shading, foam, the shoreline gradient, the horizon. */
  coast: {
    settle: SETTLE,
    pose: (e) => {
      const terrain = e.ctx.services.terrain;
      const r = (terrain?.islandRadius ?? 1155) * 0.94;
      const a = 0.7;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const pos = V(e, x, (terrain?.heightAt?.(x, z) ?? 0) + 1.0, z);
      return { pos, ...aim(pos, V(e, Math.cos(a) * (r + 500), 0, Math.sin(a) * (r + 500))) };
    },
  },
  /** The storm wall — the signature effect of the mode. */
  storm: {
    settle: SETTLE,
    pose: (e) => {
      const s = e.ctx.services.storm;
      const terrain = e.ctx.services.terrain;
      if (!s) {
        const pos = V(e, 0, 60, 300);
        return { pos, ...aim(pos, V(e, 0, 40, 0)) };
      }
      const a = 0.6;
      const r = Math.max(s.radius - 90, 40);
      const x = s.center.x + Math.cos(a) * r;
      const z = s.center.z + Math.sin(a) * r;
      const pos = V(e, x, (terrain?.heightAt?.(x, z) ?? 0) + 2, z);
      const tx = s.center.x + Math.cos(a) * (r + 400);
      const tz = s.center.z + Math.sin(a) * (r + 400);
      return { pos, ...aim(pos, V(e, tx, pos.y + 40, tz)) };
    },
  },
};

/**
 * Pose by driving the PLAYER, not the camera.
 *
 * This is the third design of this function and the first correct one, and
 * the history is worth keeping because it cost four wrong diagnoses.
 *
 * v1 set `camera.position` directly. The player system rewrites the camera in
 * `lateUpdate`, so every shot came back identical — the battle bus, six times.
 *
 * v2 posed inside `renderOverride`, which the engine calls last. The camera
 * then pointed where we asked, but ONLY at draw time: every system that reads
 * the camera during `update`/`lateUpdate` — terrain LOD and culling, grass
 * streaming, the shadow cascade's focus — still saw the player's camera,
 * somewhere else entirely. That produced an island whose 121 terrain chunks
 * all culled themselves (read as "the terrain is white"), a world that looked
 * unplanted, and a frame with no shadows in it. Three bugs that were not bugs.
 *
 * v3: move the player and let the engine derive the camera the way it does in
 * a real match. Everything then agrees, because there is only one camera and
 * one source for it. We pin the player on a fast interval so gravity never
 * accumulates and the pose holds for the whole settle window.
 *
 * The lesson generalises: a capture harness that bypasses the engine measures
 * the harness, not the game.
 */
function installPose(fn) {
  return `(() => {
    const e = window.__dz;
    if (!e) return;
    // The pose bodies close over these in Node; they must exist in the page too.
    const V = ${V.toString()};
    const aim = ${aim.toString()};
    const pose = ${fn.toString()};
    if (e.__dzPin) clearInterval(e.__dzPin);
    const apply = () => {
      const p = e.ctx.services.player;
      if (!p) return;
      const want = pose(e);
      if (!want) return;
      // Teleport rather than assign, so the system can clear its own state
      // (grounded flags, fall damage accumulators) as it sees fit.
      p.teleport(want.pos);
      p.velocity.set(0, 0, 0);
      if (typeof want.yaw === "number") p.yaw = want.yaw;
      if (typeof want.pitch === "number") p.pitch = want.pitch;
    };
    apply();
    e.__dzPin = setInterval(apply, 8);
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
  /**
   * Getting out of the bus is a handshake, not a single call.
   *
   * `match.jump()` only does anything once the phase machine has actually
   * reached `bus` — call it during `warmup` and it is a no-op, which is what
   * happened on the previous run: every "ground level" shot came back as a
   * view from the bus, because the player never left it. And while the player
   * is in the `bus` state their position is driven by the bus, so posing them
   * is ignored too. So: keep asking until the state changes, then land.
   */
  const left = await page
    .evaluate(`(async () => {
      const e = window.__dz;
      const p = e?.ctx?.services?.player;
      const m = e?.ctx?.services?.match;
      if (!p || !m) return "no services";
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 120; i++) {
        if (p.state !== "bus") return "left bus in state " + p.state + " after " + i;
        try { m.jump(); } catch (err) { /* not ready yet */ }
        await sleep(250);
      }
      return "still in bus after 30s, phase=" + m.phase;
    })()`)
    .catch((err) => `jump threw: ${err.message}`);
  if (typeof left === "string" && /still in bus|no services|threw/.test(left)) {
    errors.push(`drop: ${left}`);
  } else {
    console.log(`drop: ${left}`);
  }
  // Skydive/glide has to run itself out before a pose will stick.
  await page.waitForTimeout(10000);
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
  // Playwright's 30s default is not enough here. Compositing a 1600x900 frame
  // of a 3 km island through a software rasteriser on the full-quality shader
  // path takes minutes, and a timeout here throws away the whole run.
  await page.screenshot({ path: file, timeout: 600000, animations: "disabled" });
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
