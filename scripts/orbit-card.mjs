#!/usr/bin/env node
/**
 * orbit-card — capture ORBIT's world-card art from a run in progress.
 *
 *     node scripts/orbit-card.mjs [out.jpg]
 *
 * `route-shot.mjs` cannot do this one. It boots a route and waits, and what
 * ORBIT shows when you boot it is the "Ready" card sitting over a still canvas
 * — a picture of a menu, not of the game. So this starts a free flight, flies
 * it on the same hover cadence `orbit.test.ts` uses, and grabs the canvas
 * *element* mid-run once there are gates on screen.
 *
 * It shoots the canvas rather than the page because the card is 16:10 art, and
 * the page around it is chrome that every other card already has.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const out = process.argv[2] ?? "src/assets/worlds/orbit.jpg";
const PORT = Number(process.env.ORBIT_PORT ?? 5184);
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
});
// Big viewport so the canvas is captured above the size the card renders at.
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

// No round, so the page shows free flight only and never asks for money.
await page.route("**/functions/v1/vibe-rounds", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { round: null, leaderboard: [], you: null } }),
  }),
);

await page.goto(`${BASE}/orbit`, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(2500);

await page.getByRole("button", { name: /Free flight/ }).click();
await page.waitForTimeout(600);

/* Fly until the score board says gates have been cleared — a frame with the
   trail curving through a passed gate is the one worth putting on a card, and
   the opening frame never has one. Give up after a few seconds and shoot
   whatever is there rather than shipping no art at all. */
const deadline = Date.now() + 9000;
while (Date.now() < deadline) {
  if (await page.getByRole("button", { name: /Fly again/ }).count()) break;
  await page.keyboard.down("Space");
  await page.waitForTimeout(80);
  await page.keyboard.up("Space");
  await page.waitForTimeout(95);
  if (Date.now() > deadline - 5500) break; // ~3.5s in: gates on screen, still alive
}

const canvas = page.locator("canvas").first();
const png = await canvas.screenshot();
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
  return c.toDataURL("image/jpeg", 0.88);
}, b64);
writeFileSync(out, Buffer.from(jpeg.split(",")[1], "base64"));
console.log(`wrote ${out}`);

await browser.close();
server?.kill();
