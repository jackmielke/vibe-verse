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
  market: [120, 26, 150, 2.35, -0.12],
  street: [-150, 4, -60, 1.1, -0.05],
  waterfront: [640, 120, -420, 3.6, -0.35],
  hills: [-560, 210, -330, 1.5, -0.38],
  wide: [0, 420, 900, 3.3, -0.62],
};

const wanted = (process.argv[3] ?? "skyline,downtown,market,street,waterfront,hills,wide").split(",");

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

await page.goto(`${BASE}/frisco`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForFunction(() => typeof window.__frisco?.setPose === "function", null, {
  timeout: 180000,
});
// The character arrives a moment after the world does.
await page.waitForTimeout(6000);

const stats = await page.evaluate(() => window.__frisco.stats());
console.log(
  `city: ${stats.buildings} buildings, ${stats.triangles} triangles, built in ${stats.buildMs} ms`,
);

for (const name of wanted) {
  const pose = POSES[name];
  if (!pose) {
    console.log(`no such pose: ${name}`);
    continue;
  }
  // Re-assert the pose across several frames — gravity is still running, and a
  // single set followed by a wait photographs a character mid-fall.
  for (let i = 0; i < 12; i++) {
    await page.evaluate(([a, b, c, d, e]) => window.__frisco.setPose(a, b, c, d, e), pose);
    await page.waitForTimeout(400);
  }
  writeFileSync(`${OUT}/${name}.png`, await page.screenshot());
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
