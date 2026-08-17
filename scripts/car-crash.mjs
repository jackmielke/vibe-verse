#!/usr/bin/env node
/**
 * car-crash — ram the traffic, and get in and out with the keyboard.
 *
 *     node scripts/car-crash.mjs [outDir]
 *
 * Two things, both of which look like nothing in a still.
 *
 * **Bumper cars.** `blockedAt` says something is in the way; it never said
 * what. So running into a parked Nissan and running into a granite office
 * block were the same event — you stopped dead — and the city's ninety-odd
 * vehicles were effectively street furniture. A screenshot of the fixed
 * version and a screenshot of the broken one both show a kart next to a car.
 * The difference is entirely in where that car is one second later, so that
 * is what gets measured: a specific car, by id, tracked across the hit.
 *
 * **F to get in and out.** Previously the only ways out of a vehicle were a
 * small on-screen button and Space — which is also the jetpack, so leaving a
 * kart and firing your jetpack were one keystroke and you did both.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/car-crash");
const PORT = Number(process.env.CITY_PORT ?? 5191);
const BASE = `http://127.0.0.1:${PORT}`;

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
  () => typeof window.__cityDrive === "function" && typeof window.__cityCarsNear === "function",
  null,
  { timeout: 90000 },
);

const shot = async (name) => {
  const png = await page.evaluate(() => window.__cityDebug.snapshot());
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(png.split(",")[1], "base64"));
};
const kart = () => page.evaluate(() => window.__cityKartState());
const carsNear = (x, z, r) =>
  page.evaluate(([a, b, c]) => window.__cityCarsNear(a, b, c), [x, z, r]);

await page.evaluate(() => window.__cityDay(true));
await page.waitForTimeout(600);

// ---- Find something to hit ----------------------------------------------
/**
 * Pick a real car off the street rather than driving around hoping.
 *
 * The fleet is always moving, so the target is chosen and then immediately
 * aimed at: the kart is placed twenty metres short of it, pointed at it, with
 * the throttle pinned. Twenty metres at 26 m/s leaves no time for the target
 * to have gone anywhere interesting.
 */
/**
 * A car that is standing still, and a short run-up.
 *
 * Both halves are forced on this by wall-clock. Under software GL the world
 * steps at roughly a thirty-sixth of real time, so a 24 m approach is fifteen
 * seconds of harness time — and the first version chased a car doing 12 m/s
 * away from it down a straight, closed at 11 m/s, and ran out of polls ten
 * metres short. It reported that ramming does not work. Nothing was wrong
 * except the arithmetic of the chase.
 *
 * There are always cars stopped at a red or queued behind one, so this is not
 * a contrived target; it is the one a player actually rear-ends.
 */
let target = null;
for (let i = 0; i < 60; i++) {
  const near = await carsNear(0, 0, 170);
  target = near.find((c) => !c.hit && c.speed < 0.6 && Math.hypot(c.x, c.z) > 30);
  if (target) break;
  await page.waitForTimeout(400);
}
if (!target) {
  console.error("!! no stopped traffic found to hit");
  process.exit(1);
}
console.log(
  `· target is car #${target.id} at x ${target.x.toFixed(1)} z ${target.z.toFixed(1)}, ` +
    `travelling along ${target.axis === 0 ? "Z" : "X"} (dir ${target.dir})`,
);

/**
 * Line up ON the target's own lane, behind it.
 *
 * The first version aimed from a point 22 m back along the ray to the world
 * origin, which sounds like "approach the car" and is really "start inside
 * whichever office block happens to be in the way". The kart spawned in a
 * building, bounced off the wall, and the run reported that ramming does not
 * work — a verdict about my arithmetic, not about the feature.
 *
 * A car's lane is a street. Approaching down it is the only placement
 * guaranteed to be on tarmac.
 */
const alongX = target.axis === 1;
const back = 9;
const startX = alongX ? target.x - target.dir * back : target.x;
const startZ = alongX ? target.z : target.z - target.dir * back;
// Kart forward is (sin yaw, cos yaw).
const aimYaw = alongX ? (target.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (target.dir > 0 ? 0 : Math.PI);

await page.evaluate((s) => {
  window.__cityDay(true);
  window.__cityDrive(s.x, 0.4, s.z, s.yaw, 26, 1);
  window.__cityCam(9, 0.35, 0);
}, { x: startX, z: startZ, yaw: aimYaw });

console.log(`· ramming down the lane from ${back} m back at 26 m/s`);

/**
 * Watch every car around, not just the chosen one.
 *
 * The fleet is moving the whole time, so by the time the kart covers 24 m the
 * car it actually reaches may not be the one that was picked — and a run that
 * only tracks the pick reports "nothing happened" while a different car is
 * cartwheeling past the camera.
 */
const startPos = new Map();
for (const c of await carsNear(target.x, target.z, 80)) startPos.set(c.id, c);

let launched = false;
let sawFlying = false;
let maxY = 0;
let moved = 0;
let flyer = -1;
for (let i = 0; i < 180; i++) {
  await page.waitForTimeout(120);
  // One round-trip, not two. Each `page.evaluate` costs real milliseconds and
  // this loop is racing a simulation that is already running at a thirty-sixth
  // of real time; halving the chatter doubles how far the kart gets per poll.
  const [k, near] = await page.evaluate(
    ([x, z]) => [window.__cityKartState(), window.__cityCarsNear(x, z, 90)],
    [target.x, target.z],
  );
  for (const c of near) {
    if (!c.hit) continue;
    const was = startPos.get(c.id);
    sawFlying = true;
    if (flyer < 0) flyer = c.id;
    if (c.id !== flyer) continue;
    maxY = Math.max(maxY, c.y);
    if (was) moved = Math.max(moved, Math.hypot(c.x - was.x, c.z - was.z));
    if (!launched) {
      console.log(`   contact — car #${c.id} has left its lane`);
      launched = true;
      await shot("00-contact");
    }
  }
  const cur = near.find((c) => c.id === flyer);
  if (launched && i % 5 === 0) {
    console.log(
      `   kart x ${k.x.toFixed(1)} z ${k.z.toFixed(1)} speed ${k.speed.toFixed(1)}  ` +
        `car y ${(cur?.y ?? 0).toFixed(2)} moved ${moved.toFixed(1)} m  ` +
        `airborne ${cur?.hit ? "yes" : "no (rejoined)"}`,
    );
  }
  if (launched && i === 6) await shot("01-flying");
  if (launched && cur && !cur.hit) break;
  if (!launched && i % 10 === 0) {
    console.log(`   closing… kart x ${k.x.toFixed(1)} z ${k.z.toFixed(1)} speed ${k.speed.toFixed(1)}`);
  }
}
await shot("02-after");

const kAfter = await kart();

// ---- F to hop out --------------------------------------------------------
console.log("\n· pressing F to get out");
await page.evaluate(() => window.__cityDay(true));
const drivingBefore = (await kart()).driving;
await page.keyboard.press("KeyF");
await page.waitForTimeout(900);
const drivingAfter = (await kart()).driving;
const avatar = await page.evaluate(() => window.__cityAvatar());
await shot("03-hopped-out");

// ---- Verdicts ------------------------------------------------------------
console.log("\n· verdicts");
console.log(
  `   car was knocked flying       ${sawFlying ? "yes" : "NO — it just stopped us dead"}`,
);
console.log(
  `   it went up as well as away   peak y ${maxY.toFixed(2)}, moved ${moved.toFixed(1)} m`,
);
console.log(
  `   we kept our momentum         kart doing ${kAfter.speed.toFixed(1)} m/s after the hit`,
);
console.log(
  `   F got us out                 ${drivingBefore && !drivingAfter ? "yes" : "NO"}`,
);
console.log(`   avatar drawn after            ${avatar.visible ? "yes" : "NO"}`);

// ---- Standing in the road ------------------------------------------------
/**
 * The other half of bumper cars.
 *
 * Traffic brakes for pedestrians, which is why you can step off the kerb and
 * climb into the next car that stops — a flow nobody designed, it fell out of
 * the braking rule. But a car that is already doing twelve metres a second
 * when it reaches you used to slide you politely sideways, and now that a kart
 * can send a car twenty-four metres down the street, being the one object in
 * the city that traffic cannot move is conspicuous.
 *
 * The braking is also what makes this awkward to test: park in a lane and the
 * approaching car stops for you. So the player is dropped in FRONT of a car
 * that is already moving and close, inside its stopping distance.
 */
console.log("\n· standing in the road");
let bowled = null;
let peak = 0;
for (let attempt = 0; attempt < 6 && !bowled; attempt++) {
  const moving = (await carsNear(0, 0, 170))
    .filter((c) => !c.hit && c.speed > 7)
    .sort((a, b) => b.speed - a.speed)[0];
  if (!moving) {
    await page.waitForTimeout(600);
    continue;
  }
  // Six metres ahead of it, in its lane — closer than it can stop from.
  const ax = moving.axis === 1;
  const px = ax ? moving.x + moving.dir * 6 : moving.x;
  const pz = ax ? moving.z : moving.z + moving.dir * 6;
  await page.evaluate(([x, z]) => {
    window.__cityDay(true);
    window.__cityWarp(x, 0.2, z);
    window.__cityCam(10, 0.3, 0);
  }, [px, pz]);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150);
    const a = await page.evaluate(() => window.__cityAvatar());
    peak = Math.max(peak, a.y);
    if (a.knockdown > 0) {
      bowled = a;
      console.log(
        `   hit — launched at ${Math.hypot(a.vx, a.vz).toFixed(1)} m/s, ` +
          `up ${a.vy.toFixed(1)} m/s, knockdown ${a.knockdown.toFixed(2)}s`,
      );
      await shot("04-bowled-over");
      break;
    }
  }
}
// Steering is dead while you are down, which is the difference between being
// hit and merely being bumped.
/**
 * Long enough for two seconds of WORLD time.
 *
 * The knockdown is just under two seconds and counts down by `dt` in the frame
 * loop, and this world steps at somewhere between a tenth and a thirtieth of
 * real time under software GL — so the obvious twelve-second poll expired with
 * the timer still at 1.5 and reported the player permanently stuck. That is
 * the third time a harness in this repo has measured the frame rate and
 * called it a bug.
 */
let cameBack = false;
let reHit = false;
if (bowled) {
  let prev = bowled.knockdown;
  let fell = 0;
  for (let i = 0; i < 200; i++) {
    await page.waitForTimeout(400);
    const a = await page.evaluate(() => window.__cityAvatar());
    peak = Math.max(peak, a.y);
    // Going UP means something hit them again while they were down. That is
    // the actual stuck-forever failure mode, and it is worth telling apart
    // from "the clock has not finished yet".
    if (a.knockdown > prev + 0.01) reHit = true;
    fell += Math.max(0, prev - a.knockdown);
    prev = a.knockdown;
    if (i % 25 === 0) console.log(`   knockdown ${a.knockdown.toFixed(2)}s  y ${a.y.toFixed(2)}`);
    if (a.knockdown === 0) { cameBack = true; break; }
    /**
     * Or: it has visibly unwound most of the way with nothing re-triggering
     * it, which is the same claim without waiting out the clock.
     *
     * The timer is `max(0, knockdown - dt)` in the frame loop, so once it is
     * monotonically falling the only thing that can stop it reaching zero is
     * another car — and that is exactly what `reHit` watches for. Waiting for
     * the literal zero means waiting ninety-four seconds of wall clock for two
     * seconds of world, because this world runs at two percent of real time
     * under software GL.
     */
    if (!reHit && fell > 1.4) { cameBack = true; break; }
  }
}
console.log(
  `   bowled over                  ${bowled ? "yes" : "NO — traffic still just nudges you"}`,
);
console.log(
  `   left the ground              peak y ${peak.toFixed(2)}`,
);
console.log(
  `   got back up on its own       ${cameBack ? "yes" : "NO — stuck down"}` +
    `${reHit ? " (and was run over again while down)" : ""}`,
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
  sawFlying && moved > 3 && maxY > 0.3 && kAfter.speed > 3 &&
  drivingBefore && !drivingAfter && avatar.visible &&
  !!bowled && peak > 0.8 && cameBack
    ? 0
    : 1,
);
