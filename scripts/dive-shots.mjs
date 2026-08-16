#!/usr/bin/env node
/**
 * dive-shots — does the sea actually have an inside, and can you get out of it?
 *
 *     node scripts/dive-shots.mjs [outDir]
 *
 * Two things are being checked here and only one of them is a picture.
 *
 * The picture is whether the underwater world renders at all: a caustic-lit
 * seabed, shafts, motes, fish, and Snell's window overhead. That last one is
 * the reason this script exists rather than a couple of manual screenshots —
 * the sea is a single-sided sheet wound to face UP, so before this change a
 * camera below the waterline saw the ocean vanish entirely and looked straight
 * out at the sky through where the water should have been. A screenshot of that
 * failure looks like a screenshot of a nice day.
 *
 * The measurement is the part a picture cannot make. Two claims:
 *
 *   1. Aiming down and swimming forward puts the CAMERA under the surface.
 *      Not the player — the camera. A swimmer six metres down with the chase
 *      camera still up in the sunshine is, as far as every renderer in this
 *      file is concerned, above water.
 *   2. Letting go floats you back up. There is no air meter and no fail state
 *      down there, so the only thing standing between a curious player and
 *      being stuck at the bottom of the bay is buoyancy being turned DOWN
 *      rather than off. That is a claim about a number in a physics step, and
 *      it is worth watching actually happen.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/dive-shots");
const PORT = Number(process.env.CITY_PORT ?? 5189);
const BASE = `http://127.0.0.1:${PORT}`;

/** Open water off the city, well clear of the beach shelf. */
const SPOT = { x: 430, z: 40 };

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
page.on("console", (m) => {
  const t = m.text();
  if (/error|fail|undefined is not|cannot read/i.test(t)) errors.push(`console: ${t}`);
});

console.log("· booting the city (software GL, this is slow)");
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(22000);
await page.waitForFunction(
  () => typeof window.__citySwimState === "function" && window.__cityDebug?.snapshot,
  null,
  { timeout: 90000 },
);

const shot = async (name) => {
  const png = await page.evaluate(() => window.__cityDebug.snapshot());
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(png.split(",")[1], "base64"));
};

// ---- Get in the water ----------------------------------------------------
await page.evaluate(([x, z]) => {
  window.__cityDay(true);
  window.__cityWarp(x, 0.5, z);
}, [SPOT.x, SPOT.z]);

let st = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__cityDay(true));
  st = await page.evaluate(() => window.__citySwimState());
  if (st.swimming && Math.abs(st.y - st.floatY) < 0.3) break;
}
if (!st?.swimming) {
  console.error(`!! never started swimming at (${SPOT.x}, ${SPOT.z}) — state ${JSON.stringify(st)}`);
  process.exit(1);
}
console.log(`· floating. seabed ${(-st.depth).toFixed(1)} m, camera at y ${st.camY.toFixed(2)}`);
await shot("00-surface");

// ---- Claim 1: aiming down and swimming forward submerges the camera ------
// Full downward aim, full forward. Nothing else — this is the same input a
// player has, not a debug teleport.
/**
 * Run until it CONVERGES, not for a fixed number of polls.
 *
 * Under software GL this world steps at roughly a fifteenth of real time, so a
 * descent that takes three seconds in a browser takes the better part of a
 * minute here — and a fixed poll count reports "stalled" for a dive that was
 * still going perfectly well when the loop ran out. It did exactly that twice:
 * once on the poll count, and once on a "gained less than ten centimetres
 * between polls" rule, which sounds like a physics test and is really a frame
 * rate test — adding the offshore seabed slowed rendering enough to trip it on
 * a dive that reached the bottom moments later.
 *
 * So ask the physics directly. `vy` is the swimmer's vertical velocity: a real
 * stall is buoyancy having cancelled the sink rate, and that is vy going to
 * zero no matter how many frames a second the machine can manage.
 */
console.log("\n· diving (aim down + forward)");
const down = [];
let stalled = 0;
for (let i = 0; i < 90; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__cityCam(9, 1.25, 0);
    window.__citySwim(1);
  });
  await page.waitForTimeout(650);
  st = await page.evaluate(() => window.__citySwimState());
  down.push(st);
  if (i % 5 === 0) {
    console.log(
      `   t+${(i * 0.65).toFixed(1)}s  dive ${st.dive.toFixed(2)}  body y ${st.y.toFixed(2)}  ` +
        `vy ${st.vy.toFixed(2)}  cam y ${st.camY.toFixed(2)}  under ${st.under ? "YES" : "no"}`,
    );
  }
  // On the bottom? Then we are done and it worked.
  if (st.y <= -st.depth + 0.35) {
    console.log(`   t+${(i * 0.65).toFixed(1)}s  on the seabed at y ${st.y.toFixed(2)}`);
    break;
  }
  // Only count a stall once the dive itself has actually spun up.
  if (st.dive > 0.9) stalled = st.vy > -0.2 ? stalled + 1 : 0;
  if (stalled >= 4) {
    console.log(
      `   t+${(i * 0.65).toFixed(1)}s  stopped descending at y ${st.y.toFixed(2)} (vy ${st.vy.toFixed(2)})`,
    );
    break;
  }
}
const deepest = down.reduce((a, b) => (b.camY < a.camY ? b : a), down[0]);
const submerged = down.some((s) => s.under);
const reached = deepest.sea - deepest.camY;
console.log(
  `   → camera reached ${reached.toFixed(2)} m below the surface of a ` +
    `${deepest.depth.toFixed(1)} m bay; underwater ${submerged ? "ENGAGED" : "NEVER ENGAGED"}`,
);
/**
 * The claim is "no invisible ceiling", and the way to test it is the sink RATE,
 * not the finish line.
 *
 * Buoyancy is a spring, so its pull grows with depth; a constant sink rate
 * against a growing spring settles at an equilibrium, and the first cut of this
 * settled at five metres in a twelve-metre bay. That failure has a signature —
 * |vy| shrinking as the dive gets deeper — and it shows up in the first few
 * metres, long before the bottom. Comparing the start of the descent to the end
 * of it catches that in a short window, on any machine, which is the whole
 * point: waiting to touch the seabed makes the test a measure of frame rate.
 */
const deepestBody = down.reduce((a, b) => Math.min(a, b.y), 0);
const committed = down.filter((s) => s.dive > 0.9);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const third = Math.max(1, Math.floor(committed.length / 3));
const early = mean(committed.slice(0, third).map((s) => -s.vy));
const late = mean(committed.slice(-third).map((s) => -s.vy));
const sustained = committed.length >= 6 && late > 1 && late > early * 0.9;
console.log(
  `   → body reached y ${deepestBody.toFixed(2)} (seabed ${(-deepest.depth).toFixed(2)}); ` +
    `sink rate ${early.toFixed(2)} m/s early vs ${late.toFixed(2)} m/s deep — ` +
    `${sustained ? "no ceiling" : "BUOYANCY IS WINNING"}`,
);
const reachedBottom = sustained;
await shot("01-diving");

// A moment held at depth, so the shafts and the fish have somewhere to be.
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__cityCam(9, 1.25, 0);
    window.__citySwim(1);
  });
  await page.waitForTimeout(700);
}
await shot("02-deep");
{
  const a = await page.evaluate(() => window.__cityDebug.atmos());
  console.log("\n· atmosphere at depth");
  for (const [k, v] of Object.entries(a)) console.log(`   ${k.padEnd(16)} ${v}`);
}

/**
 * Looking UP from underneath: Snell's window, and the one shot that proves the
 * sea has an underside at all.
 *
 * `__cityDive` holds the dive while the camera is levelled off. Without it
 * this shot is impossible to take: diving is driven BY aiming down, so tilting
 * the camera up to see the ceiling cancels the thing holding you under it and
 * the swimmer surfaces before the shutter opens. Which is a perfectly good
 * control scheme and a useless one to photograph through.
 */
await page.evaluate(() => window.__cityDive(1));
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__citySwim(1);
    window.__cityCam(5, 0.06, 0);
  });
  await page.waitForTimeout(700);
}
st = await page.evaluate(() => window.__citySwimState());
console.log(`\n· looking up from ${(st.sea - st.camY).toFixed(2)} m down (dive held)`);
await shot("03-looking-up");
await page.evaluate(() => window.__cityDive(null));

// ---- Claim 2: letting go floats you back out -----------------------------
console.log("\n· released (no input at all)");
const upAgain = [];
for (let i = 0; i < 60; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__cityCam(9, 0.3, 0);
    window.__citySwim(0);
  });
  await page.waitForTimeout(650);
  st = await page.evaluate(() => window.__citySwimState());
  upAgain.push(st);
  if (i % 4 === 0) {
    console.log(
      `   t+${(i * 0.65).toFixed(1)}s  dive ${st.dive.toFixed(2)}  body y ${st.y.toFixed(2)}  ` +
        `cam y ${st.camY.toFixed(2)}  under ${st.under ? "YES" : "no"}`,
    );
  }
  if (st.camY > st.sea && Math.abs(st.y - st.floatY) < 0.35) break;
}
const back = upAgain[upAgain.length - 1];
// The claim is about the BODY and the camera being out of the water. The
// underwater atmosphere itself is deliberately eased — it takes about a second
// of world time to unwind so that bobbing through a swell does not strobe it —
// so `under` lagging a moment behind is the feature, not a player being stuck.
const surfaced = back.camY > back.sea && Math.abs(back.y - back.floatY) < 0.5;
console.log(
  `   → ${surfaced ? "back at the surface" : "STILL UNDER — a player could be stuck"}` +
    ` (atmosphere ${back.under ? "still unwinding" : "cleared"})`,
);
await shot("04-surfaced");

console.log(`\nshots in ${OUT}`);
if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 8).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("no console errors.");
}

await browser.close();
server?.kill();
process.exit(submerged && surfaced && reachedBottom ? 0 : 1);
