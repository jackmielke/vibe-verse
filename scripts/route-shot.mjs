#!/usr/bin/env node
/**
 * route-shot — screenshot any route in the app and write a downscaled JPEG.
 *
 * The SF harness (`sf-shot.mjs`) knows how to pose a camera inside San
 * Francisco; this is the blunt version for everything else — boot the route,
 * wait for it to settle, grab the frame. Used to generate world-card art from
 * the games themselves rather than shipping hand-drawn placeholders that lie
 * about what the world looks like.
 *
 * Usage: node scripts/route-shot.mjs /san-palmas src/assets/worlds/x.jpg [waitMs]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const route = process.argv[2] ?? "/";
const out = process.argv[3] ?? "shot.jpg";
const wait = Number(process.argv[4] ?? 20000);
const PORT = Number(process.env.SF_PORT ?? 5177);
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
if (server && !(await up(BASE, 120000))) {
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
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") logs.push(`error: ${m.text()}`);
});

await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 90000 });
// Click once — pointer-locked shooters usually gate their first frame behind a
// user gesture, and a start screen is not the picture we want on the card.
await page.mouse.click(800, 450).catch(() => {});
// Optional: walk the player somewhere more photogenic than the spawn point.
// Spawn frames are usually the worst frame in the game — clipped into
// geometry, mid-fall, or facing a wall.
const walk = process.env.ROUTE_SHOT_WALK;
if (walk) {
  await page.waitForTimeout(Math.max(2000, wait * 0.5));
  // Nudge the view first. Spawn pitch is frequently left staring at the sky.
  const look = process.env.ROUTE_SHOT_LOOK;
  if (look) {
    const [dx, dy] = look.split(":").map(Number);
    for (let i = 0; i < 24; i++) {
      await page.mouse.move(800 + (dx / 24) * i, 450 + (dy / 24) * i, { steps: 2 });
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(600);
  }
  for (const step of walk.split(",")) {
    const [key, ms] = step.split(":");
    await page.keyboard.down(key);
    await page.waitForTimeout(Number(ms ?? 1200));
    await page.keyboard.up(key);
  }
  await page.waitForTimeout(2500);
} else {
  await page.waitForTimeout(wait);
}

const png = await page.screenshot();
const b64 = png.toString("base64");
const jpeg = await page.evaluate(async (d) => {
  const img = new Image();
  img.src = "data:image/png;base64," + d;
  await img.decode();
  const W = 960;
  const H = Math.round((img.height / img.width) * W);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  c.getContext("2d").drawImage(img, 0, 0, W, H);
  return c.toDataURL("image/jpeg", 0.86);
}, b64);
writeFileSync(out, Buffer.from(jpeg.split(",")[1], "base64"));

console.log(`wrote ${out}`);
if (logs.length) console.log("page errors:\n" + logs.slice(-12).join("\n"));

await browser.close();
if (server) server.kill();
