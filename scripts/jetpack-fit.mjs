#!/usr/bin/env node
/**
 * jetpack-fit — is the jetpack on anybody's back, or just near it?
 *
 *     node scripts/jetpack-fit.mjs [outDir]
 *
 * It was parented to the model holder at a fixed (0, 1.06, −0.24) with the
 * comment "on the pilot's back", and standing upright on the character it was
 * authored against, it was. Two things it was not:
 *
 *  - **On anybody else.** Fifty-eight GLBs are fitted to a common height, so
 *    their skeletons sit at different places inside it. One number cannot be
 *    between the shoulder blades on all of them.
 *  - **Attached.** The swim stroke pitches the rig's ROOT eighty-one degrees
 *    to lay the body along the surface. The model holder is not part of that,
 *    so the swimmer went flat and the pack stayed bolt upright, hanging in the
 *    water behind them, still pointing at the sky.
 *
 * Both are invisible in a still of somebody standing in a plaza, which is what
 * every screenshot of this world has ever been. So this measures the two
 * numbers that matter — how far the pack is from the spine it is strapped to,
 * and how far it has tilted — across several characters, standing and swimming.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/jetpack-fit");
const PORT = Number(process.env.CITY_PORT ?? 5200);
const BASE = `http://127.0.0.1:${PORT}`;
/** Open water off the city, deep enough to swim. */
const SEA = { x: 430, z: 40 };

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
const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));

console.log("· booting the city (software GL, this is slow)");
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(22000);
await page.waitForFunction(
  () => typeof window.__cityJetpack === "function" && window.__cityDebug?.snapshot,
  null,
  { timeout: 90000 },
);

const shot = async (name) => {
  const png = await page.evaluate(() => window.__cityDebug.snapshot());
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(png.split(",")[1], "base64"));
};
const jet = () => page.evaluate(() => window.__cityJetpack());

/**
 * A handful of the cast, not all of it.
 *
 * `rig-audit` already proved every rigged character binds; what is being
 * checked here is that the MOUNT lands sanely on skeletons of different
 * proportions, and four of those is enough to catch a fixed offset pretending
 * to be a fit.
 */
const CAST = await page.evaluate(async () => {
  const m = await import("/src/lib/characters.ts");
  return m.CHARACTERS.filter((c) => c.url).slice(0, 4).map((c) => c.id);
});
console.log(`· testing ${CAST.length} characters: ${CAST.join(", ")}`);

const rows = [];
for (const name of CAST) {
  await page.evaluate((n) => window.__cityChar(n), name);
  // Wait for the model, and therefore the mount, to be rebound.
  let st = null;
  for (let i = 0; i < 26; i++) {
    await page.waitForTimeout(500);
    st = await jet();
    if (st.bound) break;
  }
  rows.push({ name, ...st });
  console.log(
    `   ${name.padEnd(22)} bound ${st.bound ? "y" : "n"}  ` +
      `gap ${st.gap.toFixed(2)} m  tilt ${st.tilt.toFixed(2)}`,
  );
}

// ---- Standing ------------------------------------------------------------
await page.evaluate(() => {
  window.__cityDay(true);
  window.__cityWarp(6, 0.5, 24);
  window.__cityCam(6, 0.25, 2.4);
});
await page.waitForTimeout(3500);
const standing = await jet();
await shot("00-standing");
console.log(
  `\n· standing: gap ${standing.gap.toFixed(2)} m, tilt ${standing.tilt.toFixed(2)}`,
);

// ---- Swimming ------------------------------------------------------------
/**
 * The case that was broken.
 *
 * The swimmer's root pitches ~1.42 rad. A pack riding the spine goes with it;
 * a pack bolted to the model holder does not, and the tilt below stays near
 * zero while the body lies flat.
 */
console.log("\n· in the water");
await page.evaluate(([x, z]) => {
  window.__cityDay(true);
  window.__cityWarp(x, 0.5, z);
}, [SEA.x, SEA.z]);
let swim = null;
for (let i = 0; i < 40; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__citySwim(1);
    window.__cityCam(6, 0.3, 1.6);
  });
  await page.waitForTimeout(600);
  const st = await page.evaluate(() => window.__citySwimState());
  swim = await jet();
  if (i % 6 === 0) {
    console.log(
      `   prone ${st.prone.toFixed(2)}  gap ${swim.gap.toFixed(2)} m  tilt ${swim.tilt.toFixed(2)}`,
    );
  }
  if (st.prone > 0.85) break;
}
const prone = await page.evaluate(() => window.__citySwimState());
/**
 * Framed from behind, on a frozen stroke.
 *
 * The wide shot above proves nothing to a human: the swimmer is forty pixels
 * tall and the pack is on the side of them you cannot see. `__citySwimPose`
 * freezes the stroke at an exact phase — it is a pure function of speed and
 * phase — so the camera has something that holds still to look at, and yaw
 * zero puts it behind a swimmer heading toward −Z.
 */
for (let i = 0; i < 8; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__citySwim(0);
    window.__citySwimPose(0.35, 3.2);
    window.__cityCam(4.2, 0.5, 0);
  });
  await page.waitForTimeout(700);
}
await shot("01-swimming");
await page.evaluate(() => window.__citySwimPose(null));
await page.evaluate(() => window.__citySwim(0));

// ---- Verdicts ------------------------------------------------------------
/**
 * The gap is the fit; the tilt is the attachment.
 *
 * A pack strapped to a spine sits a fixed short distance from it whatever the
 * body does — so the gap must be small AND must not change between standing
 * and swimming. The tilt must FOLLOW the prone pitch; a pack that stays level
 * while the swimmer goes flat is the exact bug being fixed, and it is the one
 * a screenshot of somebody standing up cannot show.
 */
const allBound = rows.every((r) => r.bound);
const allClose = rows.every((r) => r.gap > 0 && r.gap < 0.75);
const gapHeld = Math.abs(swim.gap - standing.gap) < 0.2;
const tilted = Math.abs(swim.tilt) > 0.6;

console.log("\n· verdicts");
console.log(
  `   bound to a spine bone        ${allBound ? "yes, on every character" : "NO — fell back to the fixed mount"}`,
);
console.log(
  `   sits close to the spine      ${allClose ? "yes" : "NO — one of them is off in space"}` +
    ` (gaps ${rows.map((r) => r.gap.toFixed(2)).join(", ")})`,
);
console.log(
  `   keeps that gap when swimming ${gapHeld ? "yes" : "NO — it came loose"}` +
    ` (${standing.gap.toFixed(2)} -> ${swim.gap.toFixed(2)})`,
);
console.log(
  `   tilts with the body          ${tilted ? "yes" : "NO — still pointing at the sky"}` +
    ` (prone ${prone.prone.toFixed(2)}, tilt ${swim.tilt.toFixed(2)})`,
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
process.exit(allBound && allClose && gapHeld && tilted ? 0 : 1);
