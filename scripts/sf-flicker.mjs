#!/usr/bin/env node
/**
 * sf-flicker — measure how much of San Francisco is decided by depth rounding
 * rather than by geometry.
 *
 *     node scripts/sf-flicker.mjs <outDir> [shotKey]
 *
 * The same instrument as `city-flicker.mjs`, pointed at /sf, and for the same
 * reason: "it glitches when I move" is not something a screenshot shows, and
 * the obvious tool — diffing consecutive frames — does not work. At street
 * level a fraction of a pixel of camera drift lights up every window edge in
 * the Financial District, so that metric saturates no matter what you do to
 * the depth buffer.
 *
 * The depth probe works instead. Two renders inside ONE synchronous call, with
 * the depth range nudged two parts in ten thousand between them. Nothing has
 * moved: no chunk streamed, no wave advanced, the camera has not shifted by a
 * nanometre. Every pixel that comes out different is a pixel whose winner was
 * decided by depth precision. That is z-fighting, measured directly.
 *
 * WHICH plane gets nudged is the part worth knowing, and getting it wrong
 * makes the instrument lie rather than fail. City nudges its NEAR plane; /sf
 * renders with a logarithmic depth buffer, where depth is `log2(w + 1) * FC`
 * and `FC = 2 / log2(far + 1)`. The near plane is simply not in that
 * expression. The first version of this file nudged it anyway, produced two
 * bit-identical frames, and reported a confident 0.00% for a street whose road
 * markings were visibly fighting the asphalt they are painted on. The renderer
 * picks the right plane now (see `snapshot` in SanFranciscoGame).
 *
 * /sf needs a second measurement City did not, because its LOD system
 * cross-fades with a screen-door dither: **the settle test**. Two frames of the
 * same frozen pose, 700 ms apart, with no input. Anything that differs is the
 * city disagreeing with itself while standing still — a dissolve that never
 * resolves, an impostor tile blinking, geometry still arriving. A world you can
 * stand still in and watch shimmer is the thing being reported here.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/sf-flicker");
const SHOT = process.argv[3] ?? "skyline";
const PORT = Number(process.env.SF_PORT ?? 8080);
const BASE = `http://127.0.0.1:${PORT}`;
/** Poses walked through, in addition to the one named on the command line. */
const TOUR = process.env.SF_TOUR
  ? process.env.SF_TOUR.split(",")
  : [SHOT, "market-street", "skyline", "bay-water"];

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

/**
 * The pixel diff runs in the PAGE, not here.
 *
 * A PNG decoder is a dependency this repo does not have and does not need one
 * for: the browser already has one, the frames are already there as data URLs,
 * and adding a package to count pixels would be a peer-range problem waiting to
 * happen (see the note about `postprocessing` in CLAUDE.md).
 */
const DIFF_FN = `(async (ua, ub) => {
  const load = (u) => new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.src = u;
  });
  const [a, b] = await Promise.all([load(ua), load(ub)]);
  const c = document.createElement("canvas");
  c.width = a.width; c.height = a.height;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(a, 0, 0);
  const pa = g.getImageData(0, 0, a.width, a.height).data;
  g.clearRect(0, 0, a.width, a.height);
  g.drawImage(b, 0, 0);
  const pb = g.getImageData(0, 0, a.width, a.height).data;
  let n = 0;
  const total = a.width * a.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(pa[o] - pb[o]) + Math.abs(pa[o+1] - pb[o+1]) + Math.abs(pa[o+2] - pb[o+2]);
    if (d > 12) n++;
  }
  return (100 * n) / total;
})`;

const diff = (page, ua, ub) =>
  page.evaluate(([fn, x, y]) => eval(fn)(x, y), [DIFF_FN, ua, ub]);

const png = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64");

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
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on("pageerror", (e) => console.log(`PAGEERROR ${e}`));

await page.goto(`${BASE}/sf`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForFunction(() => typeof window.__sf?.snapshot === "function", null, {
  timeout: 120000,
});

/**
 * Hold a pose until the streamer has actually caught up with it.
 *
 * Patience is not politeness here. Chromium runs this on SwiftShader, where a
 * frame costs ~45 ms and the streaming budget is a slice of that — the city
 * arrives roughly six times slower than on a real GPU. Measuring before the
 * queue drains scores "still loading" as "shimmering", which is a different
 * bug with a different fix.
 */
async function settle(key) {
  const pose = POSES[key];
  if (!pose) throw new Error(`no such pose: ${key}`);
  for (let i = 0; i < 150; i++) {
    await page.evaluate(([p, l]) => window.__sf.setPose(p, l), [pose.pos, pose.look]);
    await page.waitForTimeout(700);
    const pending = await page.evaluate(() => window.__sf.pendingChunks);
    if (pending === 0 && i >= 3) {
      console.log(`  (drained after ${((i + 1) * 0.7).toFixed(0)}s)`);
      return page.evaluate(() => window.__sf.camPose());
    }
  }
  console.log(`  (${key} never drained its queue — measuring anyway)`);
  return page.evaluate(() => window.__sf.camPose());
}

/**
 * Poses in absolute world metres. Deliberately NOT read from SHOT_POSES: half
 * of those are ground-relative and resolving them needs the geo layer, which
 * is inside the bundle rather than out here.
 */
const POSES = {
  skyline: { pos: [-620, 236, -1290], look: [220, 70, 340] },
  "market-street": { pos: [40, 22, 30], look: [-600, 40, -420] },
  "bay-water": { pos: [-1400, 60, -2600], look: [-1900, 40, -3680] },
  "golden-gate": { pos: [-6200, 180, -2500], look: [-6800, 120, -2920] },
  hills: { pos: [-2400, 190, 300], look: [200, 60, -600] },
};

const rows = [];
for (const key of TOUR) {
  const pose = await settle(key);
  console.log(
    `· ${key}: near ${pose.near} far ${pose.far} logDepth ${pose.logDepth}`,
  );

  // --- depth probe: same frame twice, two parts in ten thousand apart ---
  const probe = await page.evaluate(() =>
    [window.__sf.snapshot(), window.__sf.snapshot(1.0002)],
  );
  writeFileSync(`${OUT}/${key}-deptha.png`, png(probe[0]));
  writeFileSync(`${OUT}/${key}-depthb.png`, png(probe[1]));
  const zfight = await diff(page, probe[0], probe[1]);

  // --- settle test: same frozen pose, 700 ms apart, no input ---
  const s0 = await page.evaluate(() => window.__sf.snapshot());
  await page.waitForTimeout(700);
  const s1 = await page.evaluate(() => window.__sf.snapshot());
  writeFileSync(`${OUT}/${key}-settle-a.png`, png(s0));
  writeFileSync(`${OUT}/${key}-settle-b.png`, png(s1));
  const unsettled = await diff(page, s0, s1);

  rows.push({ key, zfight, unsettled });
  console.log(
    `  z-fight ${zfight.toFixed(2)}%   unsettled ${unsettled.toFixed(2)}%`,
  );
}

console.log("\n  pose            z-fight   unsettled");
for (const r of rows) {
  console.log(
    `  ${r.key.padEnd(15)} ${r.zfight.toFixed(2).padStart(6)}%  ${r.unsettled.toFixed(2).padStart(7)}%`,
  );
}
console.log(`\nframes in ${OUT}`);

await browser.close();
server?.kill();
