#!/usr/bin/env node
/**
 * angels-check — headless smoke test for the parts a screenshot cannot show.
 *
 * Five claims, each of which has been wrong at least once:
 *
 *  1. a ring course loads and its hoops actually register when flown through;
 *  2. the Easter-egg layer fires on the geography it says it fires on;
 *  3. the wingmen converge on their slots instead of oscillating around them;
 *  4. the demo caller advances when you fly what it asked for;
 *  5. `dispose()` releases the WebGL context — a world that leaks one breaks
 *     the *next* world a visitor opens, which is a miserable thing to debug.
 *
 * Exits non-zero on any failure, so it can gate a push.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.SF_PORT ?? 5177);
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
if (server && !(await up(BASE, 120000))) {
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
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`${BASE}/blue-angels?shot=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => window.__angelsReady === true, { timeout: 180000 });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

/**
 * Put the player a little way short of a world point, pointed at it, and fly.
 * Everything below is an integration test of the real systems: no hoop is
 * marked complete by hand.
 */
const flyTo = (target, opts = {}) =>
  page.evaluate(
    ([t, o]) => {
      const e = window.__angels;
      const fleet = e.ctx.services.fleet;
      const s = fleet.player.state;
      const lead = o.lead ?? 900;
      const hdg = (o.heading * Math.PI) / 180;
      const dx = Math.sin(hdg);
      const dz = -Math.cos(hdg);
      s.position.set(t.x - dx * lead, t.y + (o.dy ?? 0), t.z - dz * lead);
      const half = -hdg / 2;
      s.orientation.set(0, Math.sin(half), 0, Math.cos(half));
      s.angular.set(0, 0, 0);
      const spd = o.speed ?? 200;
      s.velocity.set(dx * spd, 0, dz * spd);
      e.ctx.input.pitch = 0;
      e.ctx.input.roll = 0;
      for (let i = 0; i < (o.frames ?? 480); i++) e.step(1 / 120, false);
    },
    [target, opts],
  );

const worldPoint = (lat, lon, y) =>
  page.evaluate(
    ([la, lo, alt]) => {
      const M_LAT = 111182.5;
      const M_LON = 75128.0;
      return { x: (lo - -122.3321) * M_LON, y: alt, z: -(la - 47.6062) * M_LAT };
    },
    [lat, lon, y],
  );

// ---- 1. a ring course loads and counts ------------------------------------
const course = await page.evaluate(() => {
  const e = window.__angels;
  e.ctx.services.game.setMode("course");
  e.ctx.services.courses.load("showline");
  const c = e.ctx.services.courses;
  return { hoops: c.hoops.length, next: c.next, first: c.hoops[0].position };
});
check("a course loads its hoops", course.hoops > 4, `${course.hoops} hoops`);

await flyTo(course.first, { heading: 160, lead: 1100, speed: 190, frames: 1600 });
const afterHoop = await page.evaluate(() => ({
  next: window.__angels.ctx.services.courses.next,
  score: window.__angels.ctx.services.game.score,
}));
check(
  "flying through a hoop advances the course",
  afterHoop.next >= 1,
  `next=${afterHoop.next} score=${afterHoop.score}`,
);

// ---- 2. the Easter eggs fire on real geography ----------------------------
await page.evaluate(() => {
  const e = window.__angels;
  e.ctx.services.game.setMode("free");
  e.ctx.services.courses.load(null);
});
// Under the Aurora Bridge: deck at 50 m, so 26 m is under it.
const aurora = await worldPoint(47.6475, -122.3475, 26);
await flyTo(aurora, { heading: 268, lead: 700, speed: 150, frames: 1400 });
const troll = await page.evaluate(
  () => window.__angels.ctx.services.game.achievements.find((a) => a.id === "troll")?.earned,
);
check("flying under the Aurora Bridge wakes the Troll", troll === true);

// ---- 3. the wingmen hold their slots --------------------------------------
const formation = await page.evaluate(() => {
  const e = window.__angels;
  const fleet = e.ctx.services.fleet;
  fleet.setFormation("diamond");
  fleet.respawn("show");
  for (let i = 0; i < 900; i++) e.step(1 / 120, false);

  // Sample the slot error over a couple of seconds. Converged means small and
  // *steady* — a formation that oscillates has a small mean error too.
  const errs = [];
  for (let k = 0; k < 60; k++) {
    for (let i = 0; i < 4; i++) e.step(1 / 120, false);
    const lead = fleet.player.state;
    let worst = 0;
    for (let i = 1; i <= 3; i++) {
      const a = fleet.all[i];
      const off = [
        [7.2, -0.6, 3.0],
        [-7.2, -0.6, 3.0],
        [0, -2.5, 8.0],
      ][i - 1];
      const q = lead.orientation;
      const ix = q.w * off[0] + q.y * off[2] - q.z * off[1];
      const iy = q.w * off[1] + q.z * off[0] - q.x * off[2];
      const iz = q.w * off[2] + q.x * off[1] - q.y * off[0];
      const iw = -q.x * off[0] - q.y * off[1] - q.z * off[2];
      const vx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
      const vy = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
      const vz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
      worst = Math.max(
        worst,
        Math.hypot(
          a.state.position.x - (lead.position.x + vx),
          a.state.position.y - (lead.position.y + vy),
          a.state.position.z - (lead.position.z + vz),
        ),
      );
    }
    errs.push(worst);
  }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const spread = Math.max(...errs) - Math.min(...errs);
  return { mean, spread, nearest: fleet.nearestSeparation };
});
check(
  "the Diamond closes on its slots",
  formation.mean < 6,
  `mean slot error ${formation.mean.toFixed(2)} m`,
);
check(
  "and holds them instead of hunting",
  formation.spread < 4,
  `error swing ${formation.spread.toFixed(2)} m`,
);

// ---- 4. the demo caller advances ------------------------------------------
const demo = await page.evaluate(() => {
  const e = window.__angels;
  const game = e.ctx.services.game;
  game.setMode("demo");
  const first = game.demoElement?.name ?? null;
  // Fly the run-in it asks for: fast, in the box, above the deck.
  for (let i = 0; i < 120 * 32; i++) {
    e.ctx.input.throttle = 1;
    e.step(1 / 120, false);
  }
  return { first, now: game.demoElement?.name ?? null, index: game.demoIndex, score: game.score };
});
check(
  "the demo caller advances when you fly the element",
  demo.index > 0 && demo.now !== demo.first,
  `"${demo.first}" → "${demo.now}"`,
);

// ---- 5. teardown releases the context -------------------------------------
const torn = await page.evaluate(() => {
  const e = window.__angels;
  const gl = e.ctx.renderer.getContext();
  try {
    e.dispose();
  } catch (err) {
    return { threw: String(err) };
  }
  return {
    threw: null,
    lost: !!(gl.isContextLost && gl.isContextLost()),
    // Three counts what it still holds; after a dispose it should hold nothing.
    geometries: e.ctx.renderer.info.memory.geometries,
    textures: e.ctx.renderer.info.memory.textures,
  };
});
check("dispose() does not throw", torn.threw === null, torn.threw ?? "");
check(
  "dispose() releases the GPU resources",
  torn.geometries === 0 && torn.textures === 0,
  `${torn.geometries} geometries, ${torn.textures} textures still held`,
);

if (pageErrors.length) {
  check("no uncaught page errors", false, pageErrors.slice(0, 3).join(" | "));
}

await browser.close();
if (server) server.kill();

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
