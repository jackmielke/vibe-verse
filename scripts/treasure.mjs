#!/usr/bin/env node
/**
 * treasure — is there anything down there, and can you get it?
 *
 *     node scripts/treasure.mjs [outDir]
 *
 * A hunt is the one feature you genuinely cannot photograph. The sites are not
 * written down anywhere: they are placed by walking out along a fixed bearing
 * until the water is deeper than five metres, which depends on a scalloped
 * p-norm coastline, so where they actually land is emergent. And "the chest
 * paid out" is a number in a wallet.
 *
 * Four claims:
 *
 *   1. The sites exist, and every one of them is in water deep enough to have
 *      to dive for. A chest in ankle-deep water on the beach is not treasure,
 *      it is litter — and it is exactly what a bearing walk produces if the
 *      depth search is wrong.
 *   2. They are spread out. Five chests within sight of each other is one
 *      chest.
 *   3. Swimming into one pays, once.
 *   4. Swimming into it again pays nothing. The find is persisted, so the
 *      second visit — and every visit after a reload — is empty.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/treasure");
const PORT = Number(process.env.CITY_PORT ?? 5199);
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
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(22000);
await page.waitForFunction(
  () => typeof window.__cityWrecks === "function" && window.__cityDebug?.snapshot,
  null,
  { timeout: 90000 },
);

const shot = async (name) => {
  const png = await page.evaluate(() => window.__cityDebug.snapshot());
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(png.split(",")[1], "base64"));
};

// A clean slate: this browser profile is reused across runs and the finds are
// persisted on purpose, so without this the second run has nothing to collect.
await page.evaluate(() => window.__cityWrecksReset());
await page.evaluate(() => window.__cityDay(true));
await page.waitForTimeout(600);

const sites = await page.evaluate(() => window.__cityWrecks());
console.log(`\n· ${sites.length} sites`);
for (const s of sites) {
  console.log(
    `   ${s.id}  x ${s.x.toFixed(0).padStart(5)} z ${s.z.toFixed(0).padStart(5)}  ` +
      `seabed ${s.y.toFixed(1).padStart(6)} m  ${s.reward} ✦  ${s.label}`,
  );
}

const deepEnough = sites.every((s) => s.y < -5);
let minGap = Infinity;
for (let i = 0; i < sites.length; i++) {
  for (let j = i + 1; j < sites.length; j++) {
    minGap = Math.min(minGap, Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z));
  }
}

// ---- Swim to one ---------------------------------------------------------
const target = sites[0];
console.log(`\n· diving on ${target.id}`);
const before = await page.evaluate(() => window.__cityVibe());

/**
 * Dropped in just above it rather than swum across the bay.
 *
 * The search is the feature and it is exactly what a harness must not spend
 * its time on: this world runs at a few percent of real time under software
 * GL, so crossing two hundred metres at 3 m/s is most of an hour. What is
 * being tested is that reaching the chest pays, not that a bot can navigate.
 */
await page.evaluate((t) => {
  window.__cityDay(true);
  window.__cityWarp(t.x, t.y + 2.2, t.z);
  window.__cityCam(7, 0.9, 0);
}, target);

let collectedAt = -1;
let after = before;
for (let i = 0; i < 90; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    // Held down and swimming, so buoyancy does not float us off it.
    window.__cityDive(1);
    window.__citySwim(0.2);
  });
  await page.waitForTimeout(500);
  const now = await page.evaluate(() => window.__cityVibe());
  const st = await page.evaluate(() => window.__citySwimState());
  if (i % 8 === 0) {
    console.log(`   y ${st.y.toFixed(2)}  seabed ${target.y.toFixed(2)}  ✦ ${now}`);
  }
  if (now > before) {
    after = now;
    collectedAt = i;
    console.log(`   collected at y ${st.y.toFixed(2)} — ✦ ${before} -> ${now}`);
    await shot("00-collected");
    break;
  }
}
await page.evaluate(() => window.__cityDive(null));

const paid = after - before;

// ---- And again -----------------------------------------------------------
console.log("\n· swimming back into the same chest");
const beforeSecond = await page.evaluate(() => window.__cityVibe());
await page.evaluate((t) => {
  window.__cityWarp(t.x, t.y + 2.2, t.z);
}, target);
for (let i = 0; i < 20; i++) {
  await page.evaluate(() => {
    window.__cityDay(true);
    window.__cityDive(1);
    window.__citySwim(0.2);
  });
  await page.waitForTimeout(500);
}
await page.evaluate(() => window.__cityDive(null));
const afterSecond = await page.evaluate(() => window.__cityVibe());
const stayedEmpty = afterSecond === beforeSecond;
const marked = (await page.evaluate(() => window.__cityWrecks())).find((s) => s.id === target.id);

/**
 * Now actually look at it, and at the ceiling.
 *
 * The collection shot above is taken the instant the wallet changes, which is
 * whatever the camera happened to be doing — a chase camera at a steep pitch,
 * i.e. pointed at the underside of the surface from above it. Useful as proof,
 * useless as a picture.
 *
 * The second of these is the one that matters: a NEGATIVE camera pitch, which
 * was illegal until now. Snell's window sits directly overhead and the chase
 * camera could only ever look down at you, so the best-looking thing in the
 * world was unreachable. If this frame is dark blue with a bright circle in
 * it, the camera change worked.
 */
console.log("\n· framing the site");
/**
 * Did the eye actually get UNDER the swimmer?
 *
 * A negative pitch that is accepted and then overridden downstream looks
 * identical in `camPitch` and produces the same picture as no free-look at
 * all. The check that cannot be fooled is where the camera physically ended
 * up relative to the body it is pointed at.
 */
let eyeWentBelow = false;
const FRAMES = [
  { name: "02-chest", dist: 5.5, pitch: 0.18, label: "level, on the bottom" },
  { name: "03-looking-up", dist: 5, pitch: -0.72, label: "aimed up at the surface" },
];
for (const f of FRAMES) {
  await page.evaluate((t) => {
    window.__cityWarp(t.x - 3, t.y + 1.6, t.z);
  }, target);
  for (let i = 0; i < 10; i++) {
    await page.evaluate((p) => {
      window.__cityDay(true);
      window.__cityDive(1);
      window.__citySwim(0.15);
      window.__cityCam(p.dist, p.pitch, 0);
    }, f);
    await page.waitForTimeout(600);
  }
  const pose = await page.evaluate(() => window.__cityDebug.camPose());
  console.log(
    `   ${f.label}: pitch ${pose.pitch.toFixed(2)}, eye y ${pose.y.toFixed(2)}, ` +
      `swimmer y ${pose.py.toFixed(2)} — eye is ${pose.y < pose.py ? "BELOW" : "above"} them`,
  );
  if (f.pitch < 0) eyeWentBelow = pose.y < pose.py;
  await shot(f.name);
}
await page.evaluate(() => window.__cityDive(null));
// The up-look is the claim; a clamp that silently refused it would leave the
// pitch at 0.06 and the shot would just be another view of the seabed.
const lookedUp = (await page.evaluate(() => window.__cityDebug.camPose())).pitch < -0.3;

// ---- Verdicts ------------------------------------------------------------
console.log("\n· verdicts");
console.log(`   sites placed                 ${sites.length}`);
console.log(
  `   all in divable water         ${deepEnough ? "yes" : "NO — one is in the shallows"}`,
);
console.log(
  `   spread out                   nearest pair ${minGap.toFixed(0)} m apart ` +
    `(fog reaches 42 m)`,
);
console.log(
  `   paid on collection           ${collectedAt >= 0 ? `yes, +${paid} ✦` : "NO — nothing happened"}`,
);
console.log(
  `   stays empty afterwards       ${stayedEmpty ? "yes" : "NO — it paid twice"}` +
    `${marked?.found ? " (and is marked found)" : " (NOT marked found)"}`,
);
console.log(
  `   camera can aim up in water   ${lookedUp ? "yes" : "NO — still clamped above you"}`,
);
console.log(
  `   and the eye gets below you   ${eyeWentBelow ? "yes" : "NO — pitch accepted then overridden"}`,
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
  sites.length >= 4 && deepEnough && minGap > 60 &&
  collectedAt >= 0 && paid === target.reward && stayedEmpty && !!marked?.found &&
  lookedUp && eyeWentBelow
    ? 0
    : 1,
);
