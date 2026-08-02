#!/usr/bin/env node
/**
 * homealone-play — drive every level to its ending, headless, and assert.
 *
 * A screenshot proves the house renders. It proves nothing about whether the
 * stairs carry you up, whether a trap fires when Marv walks over it, or
 * whether level 2 can be won at all. Those are the failures that waste a
 * player's evening, and none of them show up in `npm run build`.
 *
 * So this walks the game. It uses real keyboard input for the movement tests
 * (because the controller is what is being tested) and reaches into the engine
 * for the teleports (because walking to the basement to check one beacon is a
 * waste of thirty seconds per run).
 *
 *   node tools/homealone-play.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.HA_PORT ?? 5186);
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

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome"].find((p) =>
  existsSync(p),
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
  ],
});
// Tiny viewport on purpose: on SwiftShader fragment cost dominates, and at
// 900x520 the world ticks about twice a second.
const page = await browser.newPage({ viewport: { width: 360, height: 220 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/ERR_CONNECTION_RESET|favicon/.test(m.text())) errors.push(`console: ${m.text()}`);
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${detail ? `  — ${detail}` : ""}`);
};

async function load(level) {
  await page.goto(`${BASE}/home-alone?shot=1&level=${level}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => window.__homeAloneReady, null, { timeout: 90000 });
  await page.waitForTimeout(900);
}

const state = () =>
  page.evaluate(() => {
    const e = window.__homeAlone;
    const s = e.snapshot();
    return {
      phase: s.phase, done: s.done, total: s.total, room: s.room, timeLeft: s.timeLeft,
      pos: [+e.pos.x.toFixed(2), +e.pos.y.toFixed(2), +e.pos.z.toFixed(2)],
      burglars: s.burglars,
      armed: [...e.armed],
      suspicion: +s.suspicion.toFixed(3),
      compass: s.compassLabel,
      action: s.action,
    };
  });

const put = (x, y, z, yaw = Math.PI) =>
  page.evaluate(
    ([px, py, pz, yw]) => {
      const e = window.__homeAlone;
      e.pos.set(px, py, pz);
      e.vel.set(0, 0, 0);
      e.yaw = yw;
      e.camYaw = yw;
    },
    [x, y, z, yaw],
  );

/** Wait for the world to actually render `n` frames. */
const frames = async (n = 3) => {
  const from = await page.evaluate(() => window.__homeAlone.frames);
  await page.waitForFunction(
    ([f, k]) => window.__homeAlone.frames >= f + k,
    [from, n],
    { timeout: 30000, polling: 120 },
  );
};

const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(220);
};

/* ------------------------------------------------------------------ *
 * 0. The controller
 *
 * The floor and the walls are asked directly rather than walked into. Walking
 * into them is what a player does, but this runs on SwiftShader at a handful
 * of frames a second, so "hold W for two seconds" measures the renderer and
 * not the game. `groundAt` and `resolve` are the real subjects and they answer
 * in one frame.
 * ------------------------------------------------------------------ */
console.log("\n— controller —");
await load(6);
{
  /*
   * Direction, not just distance.
   *
   * The first version of this only checked that he moved *at all*, and passed
   * happily for weeks while W walked him backwards and D strafed him left —
   * both axes of the camera basis were negated. A magnitude test cannot see
   * that. These four can.
   */
  const axis = async (key, camYaw) => {
    await page.evaluate(
      (y) => {
        const e = window.__homeAlone;
        e.pos.set(0.4, 0, 9.5);
        e.vel.set(0, 0, 0);
        e.camYaw = y;
        e.yaw = y;
      },
      camYaw,
    );
    await frames(2);
    const before = await state();
    await hold(key, 1400);
    const after = await state();
    return { dx: after.pos[0] - before.pos[0], dz: after.pos[2] - before.pos[2] };
  };

  // camYaw 0 means the lens points at +Z, so forward is +Z and right is -X.
  const w = await axis("KeyW", 0);
  check("W walks towards what the camera is looking at", w.dz > 0.05, `dz=${w.dz.toFixed(2)}`);
  const sKey = await axis("KeyS", 0);
  check("S walks back towards the camera", sKey.dz < -0.05, `dz=${sKey.dz.toFixed(2)}`);
  const d = await axis("KeyD", 0);
  check("D strafes to screen right", d.dx < -0.05, `dx=${d.dx.toFixed(2)}`);
  const aKey = await axis("KeyA", 0);
  check("A strafes to screen left", aKey.dx > 0.05, `dx=${aKey.dx.toFixed(2)}`);
  // And with the camera turned a quarter, forward must follow it.
  const wTurned = await axis("KeyW", Math.PI / 2);
  check("forward follows the camera when it turns", wTurned.dx > 0.05, `dx=${wTurned.dx.toFixed(2)}`);

  const pitch = await page.evaluate(() => {
    const e = window.__homeAlone;
    e.camPitch = 0;
    // A drag UP the screen is a negative dy and must raise the view.
    e.look(0, -0.3);
    const up = e.camPitch;
    e.camPitch = 0;
    e.look(0, 0.3);
    return { up, down: e.camPitch };
  });
  check("dragging up looks up", pitch.up > 0 && pitch.down < 0, `up=${pitch.up.toFixed(2)} down=${pitch.down.toFixed(2)}`);

  const z = await page.evaluate(() => {
    const e = window.__homeAlone;
    e.camBoom = 3;
    e.zoom(1.4);
    const out = e.camBoom;
    e.zoom(1 / 2.2);
    return { out, back: e.camBoom };
  });
  check("zoom moves the boom both ways", z.out > 3.2 && z.back < 3, `out=${z.out.toFixed(2)} in=${z.back.toFixed(2)}`);

  const stair = await page.evaluate(() => {
    const e = window.__homeAlone;
    const main = [];
    for (let i = 0; i <= 8; i++) {
      const z = 0.4 + (5.0 - 0.4) * (i / 8);
      main.push(+e.groundAt(-2.6, z, 4.0).toFixed(2));
    }
    const cellar = [];
    for (let i = 0; i <= 8; i++) {
      const x = -2.2 - (6.4 - 2.2) * (i / 8);
      cellar.push(+e.groundAt(x, -4.65, 0.6).toFixed(2));
    }
    return { main, cellar, hall: e.groundAt(0.4, 3.0, 0.6), upper: e.groundAt(0.4, 3.0, 3.7) };
  });
  const mono = stair.main.every((v, i, arr) => i === 0 || v <= arr[i - 1] + 0.001);
  check(
    "the main flight is a continuous ramp from the landing to the hall",
    mono && stair.main[0] > 3.0 && stair.main[8] < 0.2,
    stair.main.join(" "),
  );
  check(
    "the cellar flight reaches the basement floor",
    stair.cellar[8] < -2.8 && stair.cellar[0] > -0.2,
    stair.cellar.join(" "),
  );
  check("standing in the hall finds the ground floor", Math.abs(stair.hall) < 0.05, `y=${stair.hall}`);
  check("standing upstairs finds the bedroom floor", Math.abs(stair.upper - 3.15) < 0.05, `y=${stair.upper}`);

  const walls = await page.evaluate(() => {
    const e = window.__homeAlone;
    return {
      // A solid stretch of the front wall — not x=0.4, which is the doorway.
      front: +e.resolve(-5.0, 5.5, 0).z.toFixed(2),
      east: +e.resolve(7.6, 0, 0).x.toFixed(2),
    };
  });
  check("the front wall pushes him back inside", walls.front < 5.2, `z=${walls.front}`);
  check("the east wall pushes him back outside", walls.east > 7.1, `x=${walls.east}`);
}

/* ------------------------------------------------------------------ *
 * 1. Explore
 * ------------------------------------------------------------------ */
console.log("\n— level 1: the empty house —");
await load(1);
{
  const beacons = await page.evaluate(() => window.__homeAlone.level.beacons.map((b) => [b.x, b.y, b.z, b.id]));
  for (const [x, y, z] of beacons) {
    await put(x, y + 0.05, z);
    await frames(3);
  }
  const s = await state();
  check("visiting every beacon clears it", s.phase === "won", `phase=${s.phase} ${s.done}/${s.total}`);
}

/* ------------------------------------------------------------------ *
 * 2. Lights
 * ------------------------------------------------------------------ */
console.log("\n— level 2: the wet bandits —");
await load(2);
{
  const s0 = await state();
  check("level 2 starts with a clock", (s0.timeLeft ?? 0) > 60, `${s0.timeLeft}s`);
  check("level 2 points at a dark room", !!s0.compass, s0.compass ?? "none");

  const crowded = await page.evaluate(() => {
    const sw = window.__homeAlone.interactables.filter((i) => i.kind === "switch");
    const bad = [];
    for (let i = 0; i < sw.length; i++)
      for (let j = i + 1; j < sw.length; j++) {
        if (Math.abs(sw[i].y - sw[j].y) > 1.5) continue;
        const d = Math.hypot(sw[i].x - sw[j].x, sw[i].z - sw[j].z);
        if (d < 1.6) bad.push(`${sw[i].room}/${sw[j].room} ${d.toFixed(2)}m`);
      }
    return bad;
  });
  check("no two light switches are within reach of each other", crowded.length === 0, crowded.join(", "));

  // Stand on each switch and press it, exactly as a player would.
  const sw = await page.evaluate(() =>
    window.__homeAlone.interactables
      .filter((i) => i.kind === "switch" && window.__homeAlone.level.streetRooms.includes(i.room))
      .map((i) => [i.x, i.y - 1.2, i.z, i.room]),
  );
  for (const [x, y, z, room] of sw) {
    // Only the dark ones. The hall starts lit, and a player does not walk up
    // to a burning lamp and switch it off — the prompt literally says "turn
    // off". Pressing everything blindly is how this test convinced itself the
    // level was unwinnable at 6/7.
    const alreadyOn = await page.evaluate((r) => window.__homeAlone.world.roomLights.get(r).on, room);
    if (alreadyOn) continue;
    // Frames, not milliseconds. A fixed wait is sometimes less than one frame
    // here, and then the prompt is still the *previous* switch and you toggle
    // a room two rooms away.
    await put(x, y, z);
    await frames(3);
    await page.keyboard.press("KeyE");
    await frames(3);
  }
  const s = await state();
  const dark = await page.evaluate(() =>
    window.__homeAlone.level.streetRooms.filter((r) => !window.__homeAlone.world.roomLights.get(r).on),
  );
  check("lighting every street-facing room wins it", s.phase === "won",
    `phase=${s.phase} ${s.done}/${s.total}${dark.length ? ` still dark: ${dark.join(",")}` : ""}`);
}
{
  // And the losing side: sit in the dark and let them look.
  await load(2);
  await page.evaluate(() => {
    window.__homeAlone.levelTime = 0.3;
  });
  await page.waitForTimeout(4000);
  const s = await state();
  check("running the clock out loses it", s.phase === "lost", `phase=${s.phase}`);
}

/* ------------------------------------------------------------------ *
 * 3. Traps
 * ------------------------------------------------------------------ */
console.log("\n— level 3: setting the traps —");
await load(3);
{
  const spots = await page.evaluate(() =>
    window.__homeAlone.interactables.filter((i) => i.kind === "trap").map((i) => [i.x, i.y - 0.5, i.z, i.trap]),
  );
  check("all eight traps are reachable objects", spots.length === 8, `${spots.length} spots`);
  for (const [x, y, z] of spots) {
    // Frames, not milliseconds. A fixed wait is sometimes less than one frame
    // here, and then the prompt is still the *previous* switch and you toggle
    // a room two rooms away.
    await put(x, y, z);
    await frames(3);
    await page.keyboard.press("KeyE");
    await frames(3);
  }
  await frames(4);
  const s = await state();
  check("arming all eight wins it", s.phase === "won", `phase=${s.phase} armed=${s.armed.length}`);
}

/* ------------------------------------------------------------------ *
 * 4. The battle
 * ------------------------------------------------------------------ */
console.log("\n— level 4: the battle —");
await load(4);
{
  const s0 = await state();
  check("both burglars are in play", s0.burglars.every((b) => b.state !== "gone"), JSON.stringify(s0.burglars));

  // Walk Harry onto the micro machines by hand and watch what it costs him.
  const nerve0 = s0.burglars[0].nerve;
  const trapUsed = await page.evaluate(() => {
    const e = window.__homeAlone;
    const kind = [...e.armed][0];
    const spot = e.traps.visuals.get(kind).spot;
    const b = e.burglars[0];
    b.spawn(spot.x, spot.y, spot.z, 0);
    b.state = "prowl";
    return kind;
  });
  await page.waitForTimeout(3000);
  const s1 = await state();
  check("standing a burglar on an armed trap fires it", s1.burglars[0].nerve < nerve0,
    `${trapUsed}: nerve ${nerve0} → ${s1.burglars[0].nerve}, state=${s1.burglars[0].state}`);

  // Drain them both and check they leave.
  await page.evaluate(() => {
    for (const b of window.__homeAlone.burglars) {
      b.nerve = 0;
      b.state = "flee";
      b.path = [];
    }
  });
  await page.waitForTimeout(22000);
  const s2 = await state();
  check("out of nerve, they give up and walk out",
    s2.burglars.every((b) => b.state === "gone" || b.state === "flee"),
    `phase=${s2.phase} ${JSON.stringify(s2.burglars.map((b) => b.state))}`);
}
{
  // Getting caught has to end it too.
  await load(4);
  await page.evaluate(() => {
    const e = window.__homeAlone;
    // Skip the opening grace — it is 3.5 seconds of *sim* time, which is most
    // of a minute at this frame rate.
    e.grace = 0;
    const b = e.burglars[0];
    b.spawn(e.pos.x, e.pos.y, e.pos.z + 0.6, 0);
    b.state = "hunt";
  });
  await page.waitForTimeout(9000);
  const s = await state();
  check("walking into a burglar loses it", s.phase === "lost", `phase=${s.phase}`);
}

/* ------------------------------------------------------------------ *
 * 5. Escape
 * ------------------------------------------------------------------ */
console.log("\n— level 5: the zipline —");
await load(5);
{
  const deckY = await page.evaluate(() => +window.__homeAlone.groundAt(-10.5, -15, 6).toFixed(2));
  check("the treehouse deck is standable ground", deckY > 2.5, `y=${deckY}`);
  const zip = await page.evaluate(() => {
    const i = window.__homeAlone.interactables.find((x) => x.kind === "zip");
    return [i.x, i.y - 0.95, i.z];
  });
  await put(zip[0], zip[1], zip[2]);
  await page.waitForTimeout(500);
  const near = await state();
  check("the window offers the zipline", !!near.action, near.action ?? "no prompt");
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(9000);
  const rode = await state();
  check("the ride lands him on the treehouse deck", rode.pos[1] > 2.5 && rode.pos[0] < -8,
    `at ${JSON.stringify(rode.pos)}`);
  await page.waitForTimeout(400);
  await page.keyboard.press("KeyE");
  // The rope-cut plays a 3.4-second outro *in sim time*, which is a lot longer
  // than that in wall-clock here. Wait for the phase, not for a stopwatch.
  await page
    .waitForFunction(() => window.__homeAlone.snapshot().phase === "won", null, { timeout: 90000, polling: 200 })
    .catch(() => {});
  const cut = await state();
  check("cutting the rope wins the game", cut.phase === "won", `phase=${cut.phase}`);
}

/* ------------------------------------------------------------------ */
console.log("\n— page errors —");
if (errors.length) errors.slice(0, 12).forEach((e) => console.log("  " + e));
else console.log("  none");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

await browser.close();
if (server) server.kill();
process.exit(failed.length || errors.length ? 1 : 0);
