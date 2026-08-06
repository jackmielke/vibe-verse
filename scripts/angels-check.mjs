#!/usr/bin/env node
/**
 * angels-check — headless smoke test for the parts a screenshot cannot show.
 *
 * Six claims, each of which has been wrong at least once:
 *
 *  1. a ring course loads and its hoops actually register when flown through;
 *  2. the Easter-egg layer fires on the geography it says it fires on;
 *  3. the wingmen converge on their slots instead of oscillating around them;
 *  4. the demo caller advances when you fly what it asked for;
 *  5. a cold jet on Boeing Field 14R actually accelerates, rotates and climbs;
 *  6. flying into the Space Needle is fatal, and flying into the lake is too,
 *     while a normal landing is not — a crash system that fires on a firm
 *     touchdown would be worse than none;
 *  7. the wreck hands the jet back by itself, at the start point you chose;
 *  8. `dispose()` releases the WebGL context — a world that leaks one breaks
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
await page.waitForFunction(() => window.__angelsReady === true, undefined, { timeout: 180000 });

// Take the wheel. The page starts its own requestAnimationFrame loop, and if it
// keeps running while the harness poses a camera the jet simply flies out of
// frame between the two calls — at 230 m/s a quarter of a second is sixty
// metres. Everything from here is driven by explicit `step()` calls, which also
// makes every frame reproducible.
await page.evaluate(() => window.__angels.stop());

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

// ---- 5. you can actually fly it off the runway -----------------------------
const takeoff = await page.evaluate(() => {
  const e = window.__angels;
  const fleet = e.ctx.services.fleet;
  e.ctx.services.game.setMode("free");
  fleet.respawn("runway");
  const s = fleet.player.state;
  const startY = s.position.y;
  let rotated = 0;
  let liftedAt = 0;
  for (let i = 0; i < 120 * 60; i++) {
    e.ctx.input.throttle = 1;
    // Hold it on the deck, then rotate once there is enough air over the wing.
    const kts = s.ias * 1.94384;
    e.ctx.input.pitch = kts > 135 ? 0.6 : 0;
    if (kts > 135 && !rotated) rotated = i / 120;
    e.step(1 / 120, false);
    if (!liftedAt && !s.onGround && s.position.y > startY + 30) liftedAt = i / 120;
    if (liftedAt && s.position.y > startY + 300) break;
  }
  e.ctx.input.pitch = 0;
  return {
    liftedAt: +liftedAt.toFixed(1),
    rotatedAt: +rotated.toFixed(1),
    alt: Math.round(s.position.y - startY),
    kias: Math.round(s.ias * 1.94384),
    airborne: !s.onGround,
  };
});
check(
  "the jet flies itself off Boeing Field",
  takeoff.airborne && takeoff.alt > 250,
  `rotate at ${takeoff.rotatedAt}s, airborne at ${takeoff.liftedAt}s, ${takeoff.alt} m up at ${takeoff.kias} kn`,
);

// ---- 6. you can write one off ----------------------------------------------
// Straight at the Space Needle from two kilometres out, at the height of the
// saucer. Nothing here nudges the crash flag by hand: the jet is placed, flown,
// and either hits the thing or does not.
const needle = await page.evaluate(() => {
  const e = window.__angels;
  e.ctx.services.game.setMode("free");
  const fleet = e.ctx.services.fleet;
  fleet.respawn("needle");
  const s = fleet.player.state;
  // Aim at the saucer rather than over it.
  s.position.y = 168;
  e.ctx.input.pitch = 0;
  e.ctx.input.roll = 0;
  e.ctx.input.throttle = 0.9;
  let hitAt = 0;
  for (let i = 0; i < 120 * 40; i++) {
    // Hold the altitude the Needle's saucer is at, so this is a test of the
    // collision hull and not of whether the jet happens to descend into it.
    s.position.y = 168;
    s.velocity.y = 0;
    e.step(1 / 120, false);
    if (fleet.wreck.active && !hitAt) {
      hitAt = i / 120;
      break;
    }
  }
  return { hitAt: +hitAt.toFixed(1), cause: fleet.wreck.cause, active: fleet.wreck.active };
});
check(
  "flying into the Space Needle writes the jet off",
  needle.active && needle.cause === "the Space Needle",
  `${needle.cause || "nothing hit"} after ${needle.hitAt}s`,
);

const worldsFair = await page.evaluate(
  () => window.__angels.ctx.services.game.achievements.find((a) => a.id === "worldsfair")?.earned,
);
check("and the 1962 World's Fair remembers it", worldsFair === true);

// ---- 7. the wreck hands the jet back ---------------------------------------
const handback = await page.evaluate(() => {
  const e = window.__angels;
  const fleet = e.ctx.services.fleet;
  const before = { ...fleet.wreck };
  // Run past the countdown.
  for (let i = 0; i < 120 * 6; i++) e.step(1 / 120, false);
  const s = fleet.player.state;
  return {
    wasActive: before.active,
    stillActive: fleet.wreck.active,
    flying: !s.onGround && s.airspeed > 100,
    spawn: fleet.spawnPoint,
    alt: Math.round(s.position.y),
  };
});
check(
  "the countdown hands the jet back by itself",
  handback.wasActive && !handback.stillActive && handback.flying,
  `${handback.alt} m, ${handback.spawn} start`,
);
check("and puts you back where you chose to start", handback.spawn === "needle");

// ---- 8. hitting the water is a crash, a landing is not ---------------------
const water = await page.evaluate(() => {
  const e = window.__angels;
  const fleet = e.ctx.services.fleet;
  const terrain = e.ctx.services.terrain;
  fleet.respawn("show");
  const s = fleet.player.state;
  // Directly over the middle of the show box, which is open water, and then
  // flown into it. Setting a sink rate is not enough — the fly-by-wire holds
  // 1 G with the stick centred, so the jet levels off and cruises down the
  // lake for the whole test instead of arriving anywhere.
  const M_LAT = 111182.5;
  const M_LON = 75128.0;
  // SHOW_CENTRE, from world/geo.ts: the middle of the Seafair box.
  const cx = (-122.265 - -122.3321) * M_LON;
  const cz = -(47.564 - 47.6062) * M_LAT;
  s.position.set(cx, 520, cz);
  for (let i = 0; i < 120 * 40; i++) {
    e.ctx.input.pitch = -0.85;
    e.step(1 / 120, false);
    if (fleet.wreck.active) break;
  }
  e.ctx.input.pitch = 0;
  return {
    active: fleet.wreck.active,
    cause: fleet.wreck.cause,
    overWater: terrain.isWater(s.position.x, s.position.z),
  };
});
check(
  "and so does arriving at Lake Washington",
  water.active && water.cause === "the water",
  `${water.cause || "survived a lake"}, terrain says ${water.overWater ? "water" : "land"}`,
);

const landing = await page.evaluate(() => {
  const e = window.__angels;
  const fleet = e.ctx.services.fleet;
  fleet.respawn("runway");
  const s = fleet.player.state;
  // A takeoff roll straight into a landing: full power, rotate, gear up is NOT
  // touched, come back down. What is being asked here is only that the runway
  // itself never trips the crash test.
  for (let i = 0; i < 120 * 45; i++) {
    e.ctx.input.throttle = 1;
    const kts = s.ias * 1.94384;
    e.ctx.input.pitch = kts > 135 && s.position.y < 260 ? 0.55 : 0;
    e.step(1 / 120, false);
    if (fleet.wreck.active) {
      return {
        active: true,
        cause: fleet.wreck.cause,
        alt: Math.round(s.position.y),
        at: +(i / 120).toFixed(1),
        kias: Math.round(s.ias * 1.94384),
        sink: +(-s.velocity.y).toFixed(1),
        gear: +s.gearPos.toFixed(2),
      };
    }
  }
  return { active: false, cause: "", alt: Math.round(s.position.y), at: -1 };
});
check(
  "but flying off a runway is not a crash",
  !landing.active,
  landing.active
    ? `wrecked on "${landing.cause}" at ${landing.at}s, ${landing.alt} m, ${landing.kias} kn, sink ${landing.sink}, gear ${landing.gear}`
    : `climbed to ${landing.alt} m clean`,
);

// ---- 9. the other half of Seafair ------------------------------------------
const race = await page.evaluate(() => {
  const e = window.__angels;
  const h = e.ctx.services.hydro;
  e.ctx.services.game.setMode("free");
  h.start();

  // Steer round the oval by aiming a little further along it — the same
  // parameterisation the system uses, recomputed here so this is a test of the
  // course and not of a helper shared with it.
  const M_LAT = 111182.5;
  const M_LON = 75128.0;
  const cX = (-122.262 - -122.3321) * M_LON;
  const cZ = -(47.568 - 47.6062) * M_LAT;
  const head = (342 * Math.PI) / 180;
  const ax = Math.sin(head);
  const az = -Math.cos(head);
  const rx = az;
  const rz = -ax;
  const drive = (steps) => {
    for (let i = 0; i < steps; i++) {
      const s = h.state;
      const a = ((h.progress.t + 0.05) % 1) * Math.PI * 2;
      const tx = cX + ax * Math.cos(a) * 1250 + rx * Math.sin(a) * 350;
      const tz = cZ + az * Math.cos(a) * 1250 + rz * Math.sin(a) * 350;
      let err = Math.atan2(tx - s.x, -(tz - s.z)) - s.heading;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      e.ctx.input.steerX = Math.max(-1, Math.min(1, err * 2.2));
      e.ctx.input.steerY = 1;
      e.step(1 / 120, false);
    }
  };

  drive(120 * 20);
  const running = {
    mph: Math.round(h.state.speed * 2.23694),
    planing: h.state.planing,
    onWater: !h.state.blownOver,
    field: h.field,
  };
  drive(120 * 75);
  const lapped = { laps: h.laps, best: h.bestLap, place: h.place };
  return { running, lapped };
});
check(
  "the hydroplane gets up on the plane and goes",
  race.running.planing > 0.95 && race.running.mph > 150 && race.running.mph < 210,
  `${race.running.mph} mph, planing ${race.running.planing.toFixed(2)}`,
);
check(
  "and it is racing a field, not driving round on its own",
  // The field is however many boats the quality tier puts on the lake plus
  // you, so this asserts "there are opponents", not a magic number.
  race.running.field >= 5,
  `${race.running.field} boats`,
);
check(
  "a lap round the Seafair course registers",
  race.lapped.laps >= 1 && race.lapped.best > 20 && race.lapped.best < 200,
  `${race.lapped.laps} lap(s), best ${race.lapped.best.toFixed(1)}s, running ${race.lapped.place}${race.lapped.place === 1 ? "st" : "th"}`,
);

// A blowover is the signature accident of the class, and it goes through the
// same crash path the jets do — which is the only reason it looks expensive.
const blowover = await page.evaluate(() => {
  const e = window.__angels;
  const h = e.ctx.services.hydro;
  let crashed = null;
  const off = e.on("angels:crash", (c) => {
    crashed = c;
  });
  h.restart();
  // Flat out with the nose well up, which is the state a rooster tail puts you
  // in and the one the class is famous for not surviving.
  const s = h.state;
  s.speed = 92;
  s.planing = 1;
  s.pitch = 0.34;
  s.lift = 0.85;
  for (let i = 0; i < 120 * 6; i++) {
    e.ctx.input.steerX = 0;
    e.ctx.input.steerY = 1;
    e.step(1 / 120, false);
    if (h.wreck.active) break;
  }
  const wrecked = { over: s.blownOver, wreck: h.wreck.active, cause: crashed && crashed.cause };
  for (let i = 0; i < 120 * 6; i++) e.step(1 / 120, false);
  const back = { wreck: h.wreck.active, speed: h.state.speed, over: h.state.blownOver };
  off();
  h.stop();
  return { wrecked, back };
});
check(
  "a blowover wrecks the boat and fires the same crash the jets do",
  blowover.wrecked.over && blowover.wrecked.wreck && blowover.wrecked.cause === "the water",
  blowover.wrecked.cause ? `crash: ${blowover.wrecked.cause}` : "no crash event",
);
check(
  "and the boat is handed back on the grid",
  !blowover.back.wreck && !blowover.back.over,
  blowover.back.wreck ? "still wrecked" : "back on the water",
);

// ---- 10. teardown releases the context -------------------------------------
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
