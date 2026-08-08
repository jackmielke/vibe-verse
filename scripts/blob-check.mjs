#!/usr/bin/env node
/**
 * blob-check — actually play BLOB in a browser and report what happened.
 *
 * `npm run build` will happily ship a world that renders a black rectangle, and
 * the unit tests only prove the rules are right, not that anything reached a
 * canvas. So this boots the route, presses play, drives the mouse around the
 * dish for a few seconds, splits a couple of times, and then reports three
 * things nothing else can tell you:
 *
 *   - console errors and page exceptions (a white screen has a reason)
 *   - whether the frame has any colour in it at all (a black canvas is a bug
 *     that builds, typechecks and passes tests)
 *   - the live status the engine is publishing: mass, rank, fps
 *
 * Usage: node scripts/blob-check.mjs [route] [out.jpg]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const route = process.argv[2] ?? "/blob";
const out = process.argv[3] ?? "blob-check.jpg";
const phone = process.argv.includes("--phone");
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
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const viewport = phone ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const page = await browser.newPage({
  viewport,
  hasTouch: phone,
  isMobile: phone,
  deviceScaleFactor: phone ? 2 : 1,
});

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
// Name the URL. "ERR_CONNECTION_RESET" on its own could be this world or it
// could be the radio calling a third party the sandbox cannot reach.
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));

await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 30000 });
await page.waitForTimeout(1500);

// Title screen first — that is what a visitor sees before anything else.
await page.screenshot({ path: out.replace(/\.jpg$/, "-title.jpg"), type: "jpeg", quality: 82 });

// Press play, however this device would.
const playButton = page.getByRole("button", { name: /^play$/i });
if (await playButton.count()) await playButton.first().click();
await page.waitForTimeout(600);

// Drive. A circle around the middle of the screen is enough to make the camera
// move, eat pellets, and put the player next to somebody.
//
// On a phone that has to be a *dragged* touch, not a tap: the control is a
// joystick whose origin is wherever your thumb landed, so a tap followed by
// mouse moves leaves the player standing perfectly still while the dish comes
// to eat it. `page.touchscreen` only taps, so this goes through CDP.
const cx = viewport.width / 2;
const cy = viewport.height / 2;
const cdp = phone ? await page.context().newCDPSession(page) : null;
const touch = async (type, x, y) =>
  cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
  });
if (phone) await touch("touchStart", cx, cy);
for (let i = 0; i < 110; i++) {
  const a = (i / 110) * Math.PI * 4;
  const x = cx + Math.cos(a) * viewport.width * 0.28;
  const y = cy + Math.sin(a) * viewport.height * 0.18;
  if (phone) await touch("touchMove", x, y);
  else await page.mouse.move(x, y);
  if (!phone && (i === 40 || i === 70)) await page.keyboard.press("Space");
  if (phone && (i === 45 || i === 80)) {
    const split = page.getByRole("button", { name: /split/i });
    if (await split.count()) await split.first().dispatchEvent("pointerdown");
  }
  await page.waitForTimeout(55);
}
if (phone) await touch("touchEnd", 0, 0);

await page.waitForTimeout(400);
await page.screenshot({ path: out, type: "jpeg", quality: 82 });

// Is there a picture, or a black rectangle with a HUD on it?
const frame = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return { ok: false, why: "no canvas" };
  const probe = document.createElement("canvas");
  probe.width = 80;
  probe.height = 50;
  const g = probe.getContext("2d");
  g.drawImage(canvas, 0, 0, 80, 50);
  const d = g.getImageData(0, 0, 80, 50).data;
  let lit = 0;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] + d[i + 1] + d[i + 2];
    sum += v;
    if (v > 120) lit++;
  }
  return {
    ok: true,
    size: `${canvas.width}x${canvas.height}`,
    litPixels: lit,
    meanBrightness: Math.round(sum / (d.length / 4) / 3),
  };
});

const status = await page.evaluate(() => {
  const board = [...document.querySelectorAll("div")].find((d) =>
    d.textContent?.trim().startsWith("leaderboard"),
  );
  const massEl = [...document.querySelectorAll("div")].find(
    (d) => d.textContent?.trim() === "mass",
  );
  return {
    leaderboard: board ? board.innerText.split("\n").slice(0, 5) : null,
    hud: massEl?.parentElement?.parentElement?.innerText?.replace(/\n/g, " ") ?? null,
  };
});

console.log(JSON.stringify({ route, phone, frame, status, problems }, null, 2));
console.log(`wrote ${out}`);

await browser.close();
if (server) server.kill();
process.exit(problems.length ? 1 : 0);
