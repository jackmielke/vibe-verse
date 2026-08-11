#!/usr/bin/env node
/**
 * island-card — the hero frame of Vibe Island, for its world card.
 *
 *     node scripts/island-card.mjs [out.jpg] [dist] [pitch] [yaw]
 *
 * Same trick as `city-card.mjs` and for the same reason: `route-shot.mjs`
 * screenshots the *page*, and the page over Vibe City is two-thirds jetpack
 * HUD, chat pill and a toast about a getaway kart. `__cityDebug.snapshot()`
 * renders one fresh frame and reads the canvas back, so what lands in the file
 * is the world and nothing else.
 *
 * Spawns straight onto the island (`?spawn=island`), stands off the plaza, and
 * poses the orbit cam high enough to take in the lawn, both shops and the
 * Dream Tree.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "src/assets/worlds/vibe-island.jpg");
const DIST = Number(process.argv[3] ?? 44);
const PITCH = Number(process.argv[4] ?? 0.45);
const YAW = Number(process.argv[5] ?? 0.0);
/* Where to stand, island-local. The camera orbits the *player*, so this is
   what actually frames the shot — from the plaza you get the paths radiating
   out, both shops, and the Dream Tree. Stand by SnackFe instead and you get a
   very sharp photograph of the back of a black kiosk. */
const STAND_X = Number(process.argv[6] ?? 2);
const STAND_Z = Number(process.argv[7] ?? 4);
const PORT = Number(process.env.CITY_PORT ?? 5184);
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
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

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
    "--ignore-gpu-blocklist",
    "--no-sandbox",
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);

await page.goto(`${BASE}/city?spawn=island&fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 180000 });
await page.waitForFunction(
  () => typeof window.__cityCam === "function" && window.__cityDebug?.snapshot,
  null,
  { timeout: 240000 },
);
await page.waitForTimeout(20000);

// Day, pinned: the mode is a shared world setting, so a peer's toggle or the
// Supabase row will happily turn the card into a night shot mid-run.
await page.evaluate(() => window.__cityDay(true));
await page.waitForTimeout(4000);

for (let i = 0; i < 6; i++) {
  await page.evaluate(
    ([d, p, y, sx, sz]) => {
      window.__cityGoto(sx, sz);
      window.__cityCam(d, p, y);
    },
    [DIST, PITCH, YAW, STAND_X, STAND_Z],
  );
  await page.waitForTimeout(1100);
}

const dataUrl = await page.evaluate(() => window.__cityDebug.snapshot());
const jpeg = await page.evaluate(async (d) => {
  const img = new Image();
  img.src = d;
  await img.decode();
  const W = 960;
  const H = Math.round((img.height / img.width) * W);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  c.getContext("2d").drawImage(img, 0, 0, W, H);
  return c.toDataURL("image/jpeg", 0.86);
}, dataUrl);

writeFileSync(OUT, Buffer.from(jpeg.split(",")[1], "base64"));
console.log(`wrote ${OUT}`);

await browser.close();
server?.kill();
