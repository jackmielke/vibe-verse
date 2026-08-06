#!/usr/bin/env node
/**
 * city-card — the hero frame of Vibe City, for the world card.
 *
 *     node scripts/city-card.mjs [out.jpg] [dist] [pitch] [yaw]
 *
 * `route-shot.mjs` is the blunt tool for this and it screenshots the *page*,
 * which for the city means a picture two-thirds covered by the jetpack HUD, the
 * chat pill and a toast about a getaway kart. This asks the world for a frame
 * instead: `__cityDebug.snapshot()` renders one fresh frame and reads the
 * canvas back, so what comes out is the world and nothing else. (It exists for
 * exactly this — see the comment on it in City.tsx.)
 *
 * The camera is posed through `__cityCam` first, because the frame the arrival
 * cinematic lands on is a shot of the player's back.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "src/assets/worlds/city.jpg");
const DIST = Number(process.argv[3] ?? 210);
const PITCH = Number(process.argv[4] ?? 0.42);
const YAW = Number(process.argv[5] ?? 0.95);
const PORT = Number(process.env.CITY_PORT ?? 5181);
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
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(25000);

await page.waitForFunction(
  () => typeof window.__cityCam === "function" && window.__cityDebug?.snapshot,
  null,
  { timeout: 60000 },
);
for (let i = 0; i < 5; i++) {
  await page.evaluate(([d, p, y]) => window.__cityCam(d, p, y), [DIST, PITCH, YAW]);
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
