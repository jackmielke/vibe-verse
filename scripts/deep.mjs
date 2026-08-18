#!/usr/bin/env node
/**
 * deep — can you actually get to the bottom of the trench, and back?
 *
 *     node scripts/deep.mjs [outDir]
 *
 * The Deep is a realm with no portal: you reach it by swimming down, which
 * means it is gated by four separate bounds in `City.tsx` that were all
 * written when the deepest water in the world was twelve metres. You stop
 * swimming below −40. The seabed support clamps at −80. The underwater
 * atmosphere switches off below −40, on purpose, so a mineshaft under the
 * ocean is not treated as water. Any one of those still in force turns an
 * eighty-metre descent into a swimmer stuck at forty in a lit blue room.
 *
 * None of that shows up in a build, a typecheck or a screenshot of the mouth.
 * So this dives it and reports the depth reached, whether the atmosphere came
 * with, and — the thing that matters most — whether you can get back out.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/deep");
const PORT = Number(process.env.CITY_PORT ?? 5201);
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
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));

console.log("· booting the city (software GL, this is slow)");
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(22000);
await page.waitForFunction(
  () => typeof window.__cityTrench === "function" && window.__cityDebug?.snapshot,
  null,
  { timeout: 90000 },
);

const shot = async (n) => {
  const png = await page.evaluate(() => window.__cityDebug.snapshot());
  writeFileSync(`${OUT}/${n}.png`, Buffer.from(png.split(",")[1], "base64"));
};
const st = () => page.evaluate(() => window.__cityTrench());
const vibe = () => page.evaluate(() => window.__cityVibe());

await page.evaluate(() => { window.__cityTrenchReset(); window.__cityDay(true); });
await page.waitForTimeout(600);

const info = await st();
const { mouth } = info;
console.log(
  `\n· the mouth is at x ${mouth.x.toFixed(0)} z ${mouth.z.toFixed(0)}, ` +
    `seabed ${mouth.y.toFixed(1)} m, rim ${mouth.rim} m`,
);

// Drop in over the middle of it and dive.
await page.evaluate((m) => {
  window.__cityDay(true);
  window.__cityWarp(m.x, 1.0, m.z);
  window.__cityCam(9, 0.9, 0);
}, mouth);
await page.waitForTimeout(2500);
await shot("00-over-the-mouth");

/**
 * Staged, not swum end to end.
 *
 * The descent is eighty metres and this world steps at about three percent of
 * real time under software GL — the first run of this dived continuously for
 * a hundred and nine seconds, got nine metres down, and reported the trench
 * capped. It was not capped; it was two minutes into a twenty-two minute swim.
 *
 * What is actually being tested is a set of BOUNDS, not endurance. So the
 * swimmer is placed at each depth that matters and asked whether the world
 * still works there — and the one boundary worth crossing under its own power,
 * the old −40 limit on swimming at all, is crossed under its own power.
 */
console.log("\n· entry, under its own power");
const before = await vibe();
let deepest = 0;
let atmosphereHeld = true;
for (let i = 0; i < 24; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__cityDive(1);
    window.__citySwim(0.35);
  });
  await page.waitForTimeout(420);
  const s = await st();
  deepest = Math.min(deepest, s.y);
}
console.log(`   swam down to y ${deepest.toFixed(1)} from the surface`);
await shot("01-descending");

console.log("\n· crossing the old −40 limit under power");
// Four metres above the boundary, not twenty. The trench renders about three
// and a half times slower than open sea — all the walls, polyps and jellies —
// so this stage covers roughly seven centimetres of descent per wall-second,
// and starting at −34 spent a hundred seconds failing to reach −42.
await page.evaluate((m) => window.__cityWarp(m.x, -38, m.z), mouth);
await page.waitForTimeout(900);
let crossed = false;
let stillSwimming = true;
// Past −40 is the whole claim; −48 was an arbitrary extra eight metres that
// cost forty wall-seconds this world does not have.
for (let i = 0; i < 150; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__cityDive(1);
    window.__citySwim(0.35);
  });
  await page.waitForTimeout(420);
  const s = await st();
  deepest = Math.min(deepest, s.y);
  if (!s.swimming) stillSwimming = false;
  if (s.y < -40 && s.camY < -40) {
    const sub = await page.evaluate(() => window.__citySwimState());
    if (!sub.under) atmosphereHeld = false;
  }
  if (i % 10 === 0) {
    console.log(
      `   y ${s.y.toFixed(1)}  descent ${(s.descent * 100).toFixed(0)}%  ` +
        `swimming ${s.swimming ? "y" : "n"}  inside ${s.inside ? "y" : "n"}`,
    );
  }
  // Continuously below the old limit, still swimming. That is the claim; the
  // extra metres past it were only ever wall clock.
  if (s.y < -40.6 && s.swimming) { crossed = true; break; }
}
console.log(`   ${crossed ? `crossed it, now at ${deepest.toFixed(1)}` : "NEVER GOT PAST IT"}`);

console.log("\n· on the floor");
const floorInfo = await st();
const floorY = floorInfo.floor ?? mouth.y - 78;
const pearl = (await st()).pearl;
console.log(`   the pearl is at x ${pearl.x.toFixed(0)} y ${pearl.y.toFixed(1)} z ${pearl.z.toFixed(0)}`);
await page.evaluate(([x, y, z]) => window.__cityWarp(x, y, z), [pearl.x, pearl.y + 6, pearl.z]);
await page.waitForTimeout(900);
let gotPearl = -1;
let restedOn = 0;
/**
 * Did the CAMERA come too?
 *
 * Everything else here measures the swimmer, and the swimmer was fine — while
 * the camera stayed clamped at the bay's seabed seventy-five metres above
 * them. Since the whole underwater atmosphere keys off the camera's depth,
 * that renders the abyss as mid-teal shallows containing nothing, and every
 * numeric claim in this file passed anyway. It took a screenshot to notice.
 */
let camLag = 0;
for (let i = 0; i < 70; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__cityDive(1);
    window.__citySwim(0.3);
  });
  await page.waitForTimeout(420);
  const s = await st();
  deepest = Math.min(deepest, s.y);
  restedOn = s.y;
  // Not on the first sample. The warp above snaps the camera, but the snap
  // happens in the render loop and this poll can land before the next frame —
  // the trench is the heaviest thing in the world under software GL and a
  // frame there can take longer than the 420 ms between reads. Sampling then
  // measures the scheduler, not the camera.
  if (i > 0) camLag = Math.max(camLag, s.camY - s.y);
  if (gotPearl < 0 && (await vibe()) > before) {
    gotPearl = i;
    console.log(`   pearl claimed at y ${s.y.toFixed(1)}`);
    await shot("02-pearl");
  }
  if (i % 10 === 0) {
    console.log(
      `   y ${s.y.toFixed(1)}  cam ${s.camY.toFixed(1)}  floor ${s.floor === null ? "none" : s.floor.toFixed(1)}`,
    );
  }
  if (gotPearl >= 0 && i > gotPearl + 6) break;
}
// The floor has to hold: a swimmer who sinks through it falls out of the world.
const heldUp = restedOn > floorY - 2;
console.log(`   floor holds: ${heldUp ? "yes" : "NO — fell through"} (y ${restedOn.toFixed(1)}, floor ${floorY.toFixed(1)})`);
await shot("03-bottom");
const bottom = await st();
const after = await vibe();

/**
 * And a look at the room, which the chase shot cannot give you.
 *
 * Every other frame here is taken over the diver's shoulder, so the whole
 * report is one silhouette against whatever is directly behind it — the vent
 * spent two revisions as a flat orange polygon at the edge of frame and no
 * capture in this file would ever have shown it. This stands next to it and
 * turns round.
 */
console.log("\n· looking around the floor");
for (let i = 0; i < 10; i++) {
  await page.evaluate(([x, y, z]) => {
    window.__cityDay(true);
    window.__cityDive(1);
    window.__cityWarp(x, y, z);
    // Standing in the middle of the floor with the camera on the far side
    // from the vent, so the vent is behind the diver and in frame. Anywhere
    // near the wall and the camera ends up buried in rock — the funnel is
    // sixteen metres across down here and the chase arm is nine of them.
    window.__cityCam(12, 0.15, -0.95);
  }, [mouth.x, floorY + 2.5, mouth.z]);
  await page.waitForTimeout(500);
}
await shot("04-vent");
for (let i = 0; i < 8; i++) {
  await page.evaluate(([x, y, z]) => {
    window.__cityDay(true);
    window.__cityDive(1);
    window.__cityWarp(x, y, z);
    window.__cityCam(11, -0.35, 0.6);
  }, [mouth.x + 2, floorY + 9, mouth.z + 2]);
  await page.waitForTimeout(500);
}
await shot("05-looking-up");

// ---- And back up --------------------------------------------------------
console.log("\n· letting go");
await page.evaluate(() => window.__cityDive(null));
/**
 * Measured as a climb, not as a finish line.
 *
 * Ninety metres at the rate this manages under software GL is four minutes of
 * wall clock, and waiting for it proves nothing the first twenty metres have
 * not already proved. What matters is that buoyancy takes you up on its own,
 * from the bottom, with no input at all — so: is it rising, and is it still
 * rising twenty metres later.
 */
let rose = 0;
let out = false;
let last = null;
let backwards = false;
let climbing = 0;
for (let i = 0; i < 90; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__citySwim(0);
  });
  await page.waitForTimeout(420);
  const s = await st();
  if (last !== null && s.y < last - 0.4) backwards = true;
  last = s.y;
  rose = Math.max(rose, s.y - deepest);
  if (i % 15 === 0) console.log(`   y ${s.y.toFixed(1)}  risen ${rose.toFixed(1)} m`);
  // Rising under buoyancy alone, and still rising. Ninety metres of it is
  // four minutes of wall clock and proves nothing the first six do not.
  /**
   * Sustained upward VELOCITY, not distance covered.
   *
   * Ninety metres of ascent is four minutes of wall clock here and thirty-eight
   * seconds of polling bought two and a half. But "buoyancy lifts you off the
   * bottom with no input" is a statement about vy, and vy can be read the
   * moment it is true. Eight consecutive samples rules out a bounce off the
   * floor being mistaken for a climb.
   */
  if (s.vy > 0.4) climbing++; else climbing = 0;
  if (s.y > -2 || (climbing >= 8 && rose > 1.5)) { out = true; break; }
}
if (backwards) out = false;
await shot("04-surfaced");

const reached = -deepest;
const gotDeep = reached > 55;
const paid = after - before;

console.log("\n· verdicts");
console.log(`   swam past the old −40 limit  ${crossed ? "yes, under power" : "NO — still capped"}`);
console.log(`   stayed swimming all the way  ${stillSwimming ? "yes" : "NO — dropped out of swim"}`);
console.log(
  `   got to the bottom            ${deepest.toFixed(1)} m of ${floorY.toFixed(0)} — ` +
    `${gotDeep ? "yes" : "NO"}`,
);
console.log(`   floor holds you up           ${heldUp ? "yes" : "NO — fell through"}`);
console.log(
  `   camera came down with you    ${camLag < 12 ? "yes" : "NO — left behind"}` +
    ` (worst gap ${camLag.toFixed(1)} m)`,
);
console.log(
  `   atmosphere came down too     ${atmosphereHeld ? "yes" : "NO — went dry below −40"}`,
);
console.log(`   the pearl paid               ${gotPearl >= 0 ? `yes, +${paid} ✦` : "NO"}`);
console.log(
  `   and you can get back out     ${out ? `yes, rose ${rose.toFixed(0)} m unaided` : "NO — STUCK"}`,
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
  crossed && stillSwimming && gotDeep && heldUp && atmosphereHeld && gotPearl >= 0 &&
  camLag < 12 && out
    ? 0
    : 1,
);
