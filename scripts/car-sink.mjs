#!/usr/bin/env node
/**
 * car-sink — drive a kart into the bay and watch what the sea does about it.
 *
 *     node scripts/car-sink.mjs [outDir]
 *
 * The bug this replaced is invisible in a screenshot and obvious in one
 * second of play: `CollisionWorld` floors everything at y=0 so nothing can
 * fall out of the world, and over open water that floor is a phantom plate
 * with no mesh under it. Every ground query a car makes therefore answers
 * "sea level, go ahead", so a kart driven off the quay carried on driving
 * across the bay at thirty miles an hour, on top of the waves, wheels
 * spinning. A still of that is a still of a car near some water.
 *
 * Four claims, and the first one is the whole feature:
 *
 *   1. The car goes UNDER. Its y ends up well below sea level and keeps
 *      going until the seabed stops it — rather than pinning at 0 forever,
 *      which is precisely what the old behaviour looks like in this log.
 *   2. The driver ends up in the water, swimming, not standing on a
 *      submerged roof being carried to the bottom.
 *   3. The car comes back. A world that loses one of its two karts to the
 *      bay every time somebody tries this runs out of karts, and swimming
 *      down to push it home is not a thing you can do.
 *   4. Arriving fast is worth more than arriving slowly — the impact scales
 *      off the speed it actually hit at.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/car-sink");
const PORT = Number(process.env.CITY_PORT ?? 5190);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * On the beach face east of the city, pointed out to sea.
 *
 * The plate is 360 m across and the dry sand runs about 30 m past it, so
 * x = 215 is below the berm and still dry; water deep enough to drown a car
 * starts around x = 234. Twenty metres of run-up, which at 26 m/s is a
 * launch rather than a paddle.
 */
const START = { x: 215, y: 0.4, z: 0, yaw: Math.PI / 2, speed: 26 };

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
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));

console.log("· booting the city (software GL, this is slow)");
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(22000);
await page.waitForFunction(
  () => typeof window.__cityDrive === "function" && window.__cityDebug?.snapshot,
  null,
  { timeout: 90000 },
);

const shot = async (name) => {
  const png = await page.evaluate(() => window.__cityDebug.snapshot());
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(png.split(",")[1], "base64"));
};
const state = () => page.evaluate(() => window.__cityKartState());
const swim = () => page.evaluate(() => window.__citySwimState());

await page.evaluate(() => window.__cityDay(true));
await page.waitForTimeout(600);

// ---- Launch --------------------------------------------------------------
console.log(`· driving off the beach at ${START.speed} m/s`);
/**
 * Throttle pinned open through the dev hook, not through a real keypress.
 *
 * The first version pressed W with Playwright and lost the race: placing the
 * kart, clicking the canvas for focus and getting the key delivered took about
 * a second, coasting drag is 1.5/s, and the kart touched the water at 3 m/s
 * instead of 26. The impact scales off arrival speed, so every verdict
 * downstream was measuring a crawl.
 */
await page.evaluate((s) => {
  window.__cityDay(true);
  window.__cityDrive(s.x, s.y, s.z, s.yaw, s.speed, 1);
  // Third-person, level-ish, so the camera can follow the car under rather
  // than hanging above the surface watching it leave.
  window.__cityCam(8, 0.28, 0);
}, START);

let hitAt = -1;
let hitSpeed = 0;
let firstShotDone = false;
let deepestY = 0;
let ejectedAt = -1;
let restedDepth = 0;
let avatarAfterBail = null;
let avatarLater = null;

/**
 * Catch the entry speed before it is gone.
 *
 * The impact scales off how fast the car arrived, so that number is the input
 * the whole effect is a function of — and the first version of this loop
 * polled every 550 ms and found the car already in the water on its very first
 * sample, so it reported an arrival speed of zero and a verdict that read like
 * the impact scaling was broken. Poll hard until it hits, then relax.
 */
let launchShot = false;
/**
 * Was there anything at all between the waterline and the plunge?
 *
 * There used to be nothing: you drove into the sea, the sea ignored you for
 * twenty metres, and then a wall of water arrived out of nowhere. `wet` is the
 * ploughing phase — first touch, spray off the wheels, water dragging on you —
 * and catching it means sampling hard, because at 26 m/s the car crosses from
 * ankle-deep to sinking in well under a second.
 */
let wadedFrames = 0;
let wadeShot = false;
for (let i = 0; i < 400; i++) {
  const k = await state();
  if (k.sink > 0) break;
  hitSpeed = Math.max(hitSpeed, k.speed);
  if (k.wet) {
    wadedFrames++;
    if (!wadeShot) {
      await shot("00b-first-touch");
      wadeShot = true;
    }
  }
  if (!launchShot && k.speed > 12) {
    await shot("00-launch");
    launchShot = true;
  }
  await page.waitForTimeout(60);
}

/**
 * Photograph the impact, not the aftermath.
 *
 * The crown lives about a second and the flat blast about half of one, so the
 * whole thing is over in the time the main loop below takes to come round
 * once — its first sample lands 0.44 s after the hit, by which point the fast
 * particles have already dragged to a stop and fallen. Three earlier passes at
 * tuning this were judged on that frame, which is a picture of foam sitting on
 * water and says nothing at all about whether the impact reads as an impact.
 *
 * So: poll hard and trip the shutter on the sink clock itself.
 */
for (const [mark, name] of [
  [0.06, "01a-hit"], [0.16, "01b-crown"], [0.3, "01c-fireball"], [0.9, "01d-smoke"],
]) {
  for (let i = 0; i < 120; i++) {
    const k = await state();
    if (k.sink >= mark) break;
    await page.waitForTimeout(25);
  }
  await shot(name);
}

for (let i = 0; i < 70; i++) {
  await page.evaluate(() => window.__cityDay(true));
  await page.waitForTimeout(550);
  const k = await state();
  deepestY = Math.min(deepestY, k.y);
  if (hitAt < 0 && k.sink > 0) {
    hitAt = i;
    console.log(
      `   splash at x ${k.x.toFixed(1)} over ${k.depth.toFixed(1)} m of water, ` +
        `doing ~${hitSpeed.toFixed(0)} m/s`,
    );
  }
  if (ejectedAt < 0 && hitAt >= 0 && !k.driving) {
    ejectedAt = i;
    // The moment the vanishing act used to start. Bailing out left the car
    // claimed so it could keep sinking, which left `insideACar()` true, which
    // left the avatar hidden — for the eleven seconds until the wreck was
    // recovered, the player swam as nobody.
    avatarAfterBail = await page.evaluate(() => window.__cityAvatar());
  }
  // Only while it is still in the water. Tracked to the end of the loop, this
  // picks up the depth AFTER recovery has teleported the kart back to its
  // parking spot in the city — and reports the wreck as resting in minus
  // eighty centimetres of water, which is a number that should stop anybody
  // reading it, and did.
  if (k.sink > 0) restedDepth = k.depth;
  if (i % 4 === 0 || (hitAt >= 0 && i - hitAt < 4)) {
    console.log(
      `   t+${(i * 0.55).toFixed(1)}s  x ${k.x.toFixed(1)}  y ${k.y.toFixed(2)}  ` +
        `vy ${k.vy.toFixed(2)}  speed ${k.speed.toFixed(1)}  pitch ${k.pitch.toFixed(2)}  ` +
        `sink ${k.sink.toFixed(2)}  bed ${(-k.depth).toFixed(1)}  driving ${k.driving ? "yes" : "no"}`,
    );
  }
  // The frame right after the hit is the one with the plume in it.
  if (hitAt >= 0 && !firstShotDone) {
    await shot("01-impact");
    firstShotDone = true;
  }
  if (hitAt >= 0 && i - hitAt === 5) await shot("02-going-under");
  // Settled on the bottom and stopped: nothing more to watch.
  if (hitAt >= 0 && i > hitAt + 8 && Math.abs(k.vy) < 0.02 && k.speed < 0.3) break;
}

await shot("03-settled");

const rest = await state();
const sw = await swim();
// And still there several seconds later, while the wreck is still on the
// bottom and still claimed. This is the frame the bug lived in.
avatarLater = await page.evaluate(() => window.__cityAvatar());

// ---- Recovery ------------------------------------------------------------
// Swim away first: the recovery deliberately waits for nobody to be watching,
// so testing it from on top of the wreck tests the wrong branch.
console.log("\n· recovery (player moved away, sink clock wound forward)");
await page.evaluate(() => window.__cityWarp(60, 2, 60));
await page.waitForTimeout(900);
await page.evaluate(() => window.__cityKartAge(11.5));
let back = rest;
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(500);
  back = await state();
  if (back.sink === 0) break;
}
const recovered =
  back.sink === 0 && back.home != null &&
  Math.hypot(back.x - back.home.x, back.z - back.home.z) < 2;
console.log(`   kart is now at x ${back.x.toFixed(1)} z ${back.z.toFixed(1)}`);

// ---- Verdicts ------------------------------------------------------------
const sank = hitAt >= 0;
// Under means UNDER: the kart stands about 1.6 m to the handlebar, so a roof
// awash in 1.7 m of water is not what anybody means by driving into the sea.
const wentUnder = deepestY < -2.2;
const bailed = ejectedAt >= 0;
const arrivedFast = hitSpeed > 15;

console.log("\n· verdicts");
console.log(`   hit the water                ${sank ? "yes" : "NO — still driving on it"}`);
console.log(
  `   arrived at speed             ${hitSpeed.toFixed(1)} m/s — ` +
    `${arrivedFast ? "a real impact" : "TOO SLOW TO TEST THE IMPACT"}`,
);
console.log(
  `   went under (deepest y)       ${deepestY.toFixed(2)} in ${restedDepth.toFixed(1)} m of ` +
    `water — ${wentUnder ? "under" : "STAYED IN THE SHALLOWS"}`,
);
console.log(
  `   driver got out               ${bailed ? `yes, ${((ejectedAt - hitAt) * 0.55).toFixed(1)}s after the hit` : "NO — rode it down"}`,
);
console.log(`   driver is swimming           ${sw.swimming ? "yes" : "no"}`);
console.log(
  `   kart recovered               ${recovered ? "yes, back at its parking spot" : "NO — lost to the bay"}`,
);
const wadedFirst = wadedFrames > 0;
console.log(
  `   splashed before the plunge   ${wadedFirst ? `yes, ploughing for ${wadedFrames} samples` : "NO — nothing until the big one"}`,
);
const avatarKept =
  !!avatarAfterBail?.visible && !!avatarLater?.visible;
console.log(
  `   avatar still drawn           ` +
    `${avatarAfterBail?.visible ? "yes at bail-out" : "NO at bail-out"}, ` +
    `${avatarLater?.visible ? "yes later" : "NO later — the player vanished"}`,
);

/**
 * And again, in deep water.
 *
 * The beach shelves gently on purpose — that is what gives the surf zone room
 * to shoal and break — so driving off it lands a car in two or three metres,
 * which is honest and is not the dramatic case. Off the island, or off any
 * edge that is not a beach, it is twelve. Worth checking separately, because
 * that is where the seabed clamp has to hold and where the underwater world
 * the car sinks into is actually visible.
 */
console.log("\n· again, straight into deep water");
const DEEP = { x: 420, y: 1.0, z: 40, yaw: Math.PI / 2, speed: 22 };
await page.evaluate((s) => {
  window.__cityDay(true);
  window.__cityDrive(s.x, s.y, s.z, s.yaw, s.speed, 1);
  window.__cityCam(9, 0.3, 0);
}, DEEP);
let deepLow = 0;
let deepBed = 0;
// Long enough to actually get there. Twelve metres at the ~0.33 m per
// wall-second this manages under software GL is about forty seconds, and the
// first version of this loop gave up at thirty — while the car was still
// descending at a steady 3.3 m/s — and reported that it never reached the
// bottom. Same mistake the dive harness made, same fix: let it finish.
for (let i = 0; i < 120; i++) {
  await page.evaluate(() => window.__cityDay(true));
  await page.waitForTimeout(550);
  const d = await state();
  deepLow = Math.min(deepLow, d.y);
  deepBed = d.depth;
  if (i % 5 === 0) {
    console.log(
      `   t+${(i * 0.55).toFixed(1)}s  y ${d.y.toFixed(2)}  vy ${d.vy.toFixed(2)}  ` +
        `sink ${d.sink.toFixed(2)}  bed ${(-d.depth).toFixed(1)}`,
    );
  }
  if (i === 4) await shot("04-deep-impact");
  if (i === 14) await shot("05-deep-sinking");
  if (d.sink > 0.5 && Math.abs(d.vy) < 0.02 && d.y < -3) break;
}
await shot("06-deep-wreck");
// Landed on the seabed rather than passing through it or stopping short.
const deepOk = deepLow < -6 && deepLow > -deepBed - 1;
console.log(
  `   deepest y ${deepLow.toFixed(2)} against a seabed at ${(-deepBed).toFixed(2)} — ` +
    `${deepOk ? "on the bottom" : "DID NOT REACH THE BOTTOM"}`,
);

if (errors.length) {
  console.log(`\n!! ${errors.length} page errors:`);
  [...new Set(errors)].slice(0, 6).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno page errors.");
}
console.log(`shots in ${OUT}`);

await browser.close();
server?.kill();
process.exit(
  sank && wentUnder && bailed && recovered && arrivedFast && deepOk &&
  wadedFirst && avatarKept
    ? 0
    : 1,
);
