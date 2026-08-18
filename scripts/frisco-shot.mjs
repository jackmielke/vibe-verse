#!/usr/bin/env node
/**
 * frisco-shot — drive Vibe Francisco and photograph it.
 *
 *     node scripts/frisco-shot.mjs <outDir> [poseA,poseB,...]
 *
 * A world you fly around cannot be checked from one screenshot, and the two
 * things most likely to be wrong about it — is the geography recognisable, and
 * does the city actually draw at range — are only visible from the air. So this
 * walks a set of named poses and writes a frame for each.
 *
 * It also prints the render stats, which is the part that earns its keep. The
 * hardest bug in this world's history was invisible in a screenshot and obvious
 * in the numbers: 218 000 triangles submitted every frame and a black screen,
 * because the depth range was too wide for the buffer and the whole city was
 * being crushed into the last quarter of one percent of it. If a frame comes
 * out empty, read the triangle count before you touch the geometry.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/frisco-shot");
const PORT = Number(process.env.FRISCO_PORT ?? 8080);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * pose: [x, y, z, yaw, pitch] — absolute world metres and radians.
 *
 * `card` is the one the world's art in `src/worlds/art.ts` is cut from:
 *
 *     FRISCO_JPEG=src/assets/worlds/frisco.jpg node scripts/frisco-shot.mjs /tmp/x card
 *
 * It is up in the air over Nob Hill looking down at the bay, because the
 * default street-level spawn makes a card that could be any city — the thing
 * that says *San Francisco* at a glance is the grid running downhill into the
 * water, and you cannot see that from the pavement.
 */
const POSES = {
  card: [-560, 130, -180, 1.4, -0.28],
  skyline: [420, 300, 620, 4.1, -0.44],
  downtown: [-40, 190, -140, 2.3, -0.5],
  // Standing on Market at Montgomery, which is where the world opens. The
  // old value was 26 m up over SoMa and ended up inside a building the day the
  // city got denser — a street-level pose has to be a place a spawn actually
  // resolves to, not a number that looked about right once.
  market: [0, 3, 0, 2.35, -0.04],
  // On the Embarcadero north of the Ferry Building — (693,-212) is the
  // building itself, and became an inside-the-wall shot the day it was built.
  embarcadero: [686, 3, -330, 2.1, -0.02],
  chinatown: [-372, 3, -300, 1.15, -0.03],
  street: [-537, 3, 635, 1.1, -0.03],
  waterfront: [640, 120, -420, 3.6, -0.35],
  hills: [-560, 210, -330, 1.5, -0.38],
  wide: [0, 420, 900, 3.3, -0.62],
};

const wanted = (process.argv[3] ?? "skyline,downtown,market,street,waterfront,hills,wide").split(",");
// `POSES` is extended below with one entry per landmark when asked for.

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

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
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage({
  viewport: {
    width: Number(process.env.FRISCO_W ?? 1280),
    height: Number(process.env.FRISCO_H ?? 760),
  },
});
page.on("pageerror", (e) => console.log(`PAGEERROR ${String(e).slice(0, 300)}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("net::") && !t.includes("Failed to load resource")) {
    console.log(`CONSOLE ${t.slice(0, 300)}`);
  }
});

if (process.env.FRISCO_CHARACTER) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((c) => {
    localStorage.setItem("lobby.character", c);
    localStorage.setItem("city.character", c);
  }, process.env.FRISCO_CHARACTER);
}

/* `?quality=high` pins the detail. The world steps its own quality down when
   the frame rate will not hold, and this runs on a software renderer at under
   twenty frames a second — so without the pin, every screenshot this harness
   has ever taken would silently be of the lowest-detail version of the city. */
await page.goto(`${BASE}/frisco?quality=high`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForFunction(() => typeof window.__frisco?.landmarks === "function", null, {
  timeout: 180000,
});
// The character arrives a moment after the world does.
await page.waitForTimeout(6000);

const stats = await page.evaluate(() => window.__frisco.stats());
console.log(
  `city: ${stats.buildings} buildings, ${stats.triangles} triangles, built in ${stats.buildMs} ms`,
);

/**
 * `landmarks` walks all twelve hand-built buildings and photographs each one
 * from the same three-quarter angle.
 *
 * There is no other way to check them. A landmark is wrong in ways a wide shot
 * hides completely — inside out, sunk into the hill, at the wrong scale, or
 * simply not built because its key does not match its builder — and every one
 * of those reads as "a slightly odd blob on the horizon" from anywhere else.
 */
const marks = wanted.includes("landmarks")
  ? await page.evaluate(() => window.__frisco.landmarks())
  : [];
for (const m of marks) {
  // Back off proportionally to how tall it is, and look at its middle.
  const dist = Math.max(70, m.height * 1.5);
  const eye = m.ground + m.height * 0.62 + 18;
  const yaw = 2.5;
  POSES[`lm-${m.key}`] = [
    m.x - Math.cos(yaw) * dist,
    eye,
    m.z - Math.sin(yaw) * dist,
    yaw,
    Math.atan2(m.ground + m.height * 0.45 - eye, dist),
  ];
}
const shots = wanted.flatMap((w) =>
  w === "landmarks" ? marks.map((m) => `lm-${m.key}`) : [w],
);

/**
 * `FRISCO_TIME=night` shoots at a named time of day.
 *
 * Night is the one that matters: nine thousand lit window courses are a
 * per-vertex glow channel and a shader injection, and there is no way to know
 * either of them landed except by looking at the city with the lights on.
 */
if (process.env.FRISCO_FOG) {
  await page.evaluate((a) => window.__frisco.setFog(Number(a)), process.env.FRISCO_FOG);
  await page.waitForTimeout(600);
}
if (process.env.FRISCO_TIME) {
  await page.evaluate((t) => window.__frisco.setTime(t), process.env.FRISCO_TIME);
  await page.waitForTimeout(900);
}

for (const name of shots) {
  /* `spawn:market` photographs a real spawn point instead of a fixed pose.
     Hard-coded street-level poses go stale: they are three numbers that were
     on a road on the day they were written, and the city keeps getting denser.
     Half the street shots in this file's history ended up inside a wall that
     way, which reads as a rendering bug and is not one. A spawn snaps itself
     to asphalt at load, so it cannot. */
  if (name.startsWith("spawn:")) {
    await page.evaluate((k) => window.__frisco.goTo(k), name.slice(6));
    await page.waitForTimeout(2200);
    writeFileSync(`${OUT}/${name.replace(":", "-")}.png`, await page.screenshot());
    const st = await page.evaluate(() => window.__frisco.stats());
    console.log(`${name.padEnd(16)} ${st.drawCalls} draws, ${st.drawnTriangles} tris, ${st.fps} fps`);
    continue;
  }
  const pose = POSES[name];
  if (!pose) {
    console.log(`no such pose: ${name}`);
    continue;
  }
  // Hold the world still while the pose settles. Traffic, walkers and the
  // cable cars all move on `dt`, so a pose set and then waited on photographs
  // them somewhere else — there is no wait long enough to fix that.
  await page.evaluate(() => window.__frisco.freeze?.(true));
  // Re-assert the pose across several frames — gravity is still running, and a
  // single set followed by a wait photographs a character mid-fall.
  for (let i = 0; i < 12; i++) {
    await page.evaluate(([a, b, c, d, e]) => window.__frisco.setPose(a, b, c, d, e), pose);
    await page.waitForTimeout(400);
  }
  /* Check the pose actually took. `setPose` writes the player's position and
     the camera follows it — but the camera follows by exponential smoothing on
     `dt`, and `freeze` sets `dt` to zero, so for a while the camera did not
     move at all and every frame here was a photograph of the spawn point. Each
     one still looked like a picture of a city, which is why it survived. */
  const at = await page.evaluate(() => window.__frisco.player());
  const drift = Math.hypot(at.x - pose[0], at.y - pose[1], at.z - pose[2]);
  if (drift > 25) {
    console.log(`  ! ${name} asked for ${pose.slice(0, 3).map(Math.round).join(",")} and is at ${[at.x, at.y, at.z].map(Math.round).join(",")} (${Math.round(drift)} m)`);
  }
  writeFileSync(`${OUT}/${name}.png`, await page.screenshot());
  await page.evaluate(() => window.__frisco.freeze?.(false));
  if (process.env.FRISCO_JPEG) {
    writeFileSync(
      resolve(process.env.FRISCO_JPEG),
      await page.screenshot({ type: "jpeg", quality: 86 }),
    );
    console.log(`card art -> ${process.env.FRISCO_JPEG}`);
  }
  const s = await page.evaluate(() => window.__frisco.stats());
  console.log(`${name.padEnd(11)} ${s.drawCalls} draws, ${s.drawnTriangles} tris, ${s.fps} fps`);
}

console.log(`frames in ${OUT}`);
await browser.close();
server?.kill();
