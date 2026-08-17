#!/usr/bin/env node
/**
 * dance-live — press T in the actual city and photograph what happens.
 *
 *   node scripts/dance-live.mjs            # a few frames of one dance
 *   node scripts/dance-live.mjs floss      # a named one
 *
 * `dance-shots.mjs` photographs the rigs in a bare scene, which proves the
 * poses are right and proves nothing about the wiring: whether the key is
 * bound, whether the mixer stamps over the dance a frame later, whether the
 * pose survives the walk-cycle state machine. This drives `/city` for real —
 * same route, same keyboard event, same frame loop — and writes the frames to
 * `.dance-shots/live-*.png`.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.SF_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(process.cwd(), ".dance-shots");
const want = process.argv.slice(2).filter((a) => !a.startsWith("-"))[0] ?? null;

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
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/supabase|websocket|ERR_|tunnel/i.test(t)) console.log("  console:", t);
});

console.log("· booting /city (software GL, this is slow)");
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForSelector("canvas", { timeout: 180000 });
await page.waitForTimeout(30000);

// Close in on the player: the default orbit is a city view and a dancing
// character is forty pixels tall in it.
await page.waitForFunction(() => typeof window.__cityCam === "function", null, { timeout: 60000 });
await page.evaluate(() => window.__cityCam(4.4, 0.16, Math.PI));
await page.waitForTimeout(1500);
// Daylight: the shots are unreadable at the city's default night.
await page.evaluate(() => window.__cityDay?.(true));
await page.waitForTimeout(2500);

mkdirSync(OUT_DIR, { recursive: true });
await page.screenshot({ path: resolve(OUT_DIR, "live-0-before.png") });

// The real thing: a keyboard event on the window, exactly as a player sends.
await page.keyboard.press("KeyT");
// Six seconds, not one. Software GL runs this route at roughly a frame a
// second, so a short wait can land entirely inside a single frame: React has
// already re-rendered the HUD while the world has not ticked once, and every
// world-side reading below is then a pre-keypress one. That cost an hour.
await page.waitForTimeout(6000);

const label = await page.evaluate(() => {
  const el = [...document.querySelectorAll("span")].find((s) => /walk to stop/.test(s.textContent ?? ""));
  return el?.textContent?.trim() ?? "(no dance HUD found)";
});
console.log(`· dancing: ${label}`);

// The music. Headless Chromium renders no audio to a device, so "did it play"
// is not observable here — what IS observable, and what actually breaks, is
// whether the graph was built, the context left "suspended", or the scheduler
// threw. A silent AudioContext still advances its clock and still reports its
// state.
const crowd = await page.evaluate(() => {
  const el = [...document.querySelectorAll("span")].find((s) => /dancing/.test(s.textContent ?? ""));
  return el?.textContent?.trim() ?? "(no crowd HUD found)";
});
console.log(`· crowd: ${crowd}`);

// A dance is motion, so one frame proves nothing — take a burst and compare.
for (let i = 1; i <= 5; i++) {
  await page.screenshot({ path: resolve(OUT_DIR, `live-${i}.png`) });
  await page.waitForTimeout(230);
}

// And that walking ends it.
await page.keyboard.down("KeyW");
await page.waitForTimeout(700);
await page.keyboard.up("KeyW");
await page.waitForTimeout(600);
await page.screenshot({ path: resolve(OUT_DIR, "live-9-after-walk.png") });
const still = await page.evaluate(() =>
  [...document.querySelectorAll("span")].some((s) => /walk to stop/.test(s.textContent ?? "")),
);
console.log(still ? "· FAIL: still dancing after walking" : "· walking stopped the dance");

// The other door in: the emote wheel's dance shelf.
await page.getByTitle("Emote wheel (B)").click().catch(async () => {
  await page.getByRole("button", { name: "⋯" }).click();
  await page.getByTitle("Emote wheel (B)").click();
});
await page.waitForTimeout(600);
await page.screenshot({ path: resolve(OUT_DIR, "live-8-wheel.png") });
const named = want ?? "The Floss";
await page.getByTitle(/./).filter({ hasText: named }).first().click().catch(() => {});
await page.waitForTimeout(900);
await page.screenshot({ path: resolve(OUT_DIR, "live-8b-picked.png") });

if (want) console.log(`(note: T picks at random; asked for ${want}, got ${label})`);
console.log(`wrote ${OUT_DIR}/live-*.png`);

await browser.close();
if (server) server.kill();
