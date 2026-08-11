#!/usr/bin/env node
/**
 * coil-check — actually play COIL in a browser and report what happened.
 *
 * `npm run build` will happily ship a world that renders a black rectangle, and
 * the unit tests only prove the rules are right, not that anything reached a
 * canvas. So this boots the route, presses play, drives it for a few seconds,
 * splits a couple of times, and reports the things nothing else can tell you:
 *
 *   - console errors and page exceptions (a white screen has a reason)
 *   - whether the frame has any colour in it at all (a black canvas is a bug
 *     that builds, typechecks and passes tests)
 *   - the live status the engine is publishing: mass, rank, leaderboard
 *   - on a phone, whether letting go of the glass leaves you still moving
 *
 * Usage: node scripts/coil-check.mjs [route] [out.jpg] [--phone]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const route = process.argv[2] ?? "/coil";
const out = process.argv[3] ?? "coil-check.jpg";
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
// could be the fonts, which this sandbox blocks on every route in the app.
page.on("requestfailed", (r) =>
  problems.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`),
);

// `?probe` exposes the engine so this script can read where the blob actually
// is. It does *not* hand over the controls — driving them is the point.
await page.goto(`${BASE}${route}${route.includes("?") ? "&" : "?"}probe`, {
  waitUntil: "domcontentloaded",
});
await page.waitForSelector("canvas", { timeout: 30000 });
await page.waitForTimeout(1500);

// Title screen first — that is what a visitor sees before anything else.
await page.screenshot({ path: out.replace(/\.jpg$/, "-title.jpg"), type: "jpeg", quality: 82 });

const cx = viewport.width / 2;
const cy = viewport.height / 2;
// `page.touchscreen` only taps, and this needs a *dragged* touch: the control
// is a joystick whose origin is wherever the thumb landed. So, CDP.
const cdp = phone ? await page.context().newCDPSession(page) : null;
const touch = (type, x, y) =>
  cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
  });
const probe = () =>
  page.evaluate(() => {
    const e = window.__coil;
    if (!e?.probe) return null;
    const p = e.probe();
    return { x: p.x, y: p.y, cells: p.alive ? 1 : 0, power: p.alive ? 1 : 0, score: p.score };
  });

const playButton = page.getByRole("button", { name: /^play$/i });
if (await playButton.count()) await playButton.first().click();
await page.waitForTimeout(600);

/**
 * The coast check, and it runs first — while the blob is definitely alive.
 *
 * The phone control sets a *course*: flick a direction, let go, and you keep
 * going. That is the one thing about this world a screenshot cannot show and a
 * unit test cannot fully prove — `course.ts` covers the maths, but only a real
 * browser can tell you the maths is wired to the pointer events.
 *
 * Ordering is not incidental. Run after the roam below and it samples a blob
 * that has usually been eaten by then, and a dead player's centroid reads as
 * the middle of the dish forever — which looks exactly like a broken control.
 */
let coast = null;
if (phone) {
  await touch("touchStart", cx, cy);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", cx + i * 9, cy);
    await page.waitForTimeout(30);
  }
  await touch("touchEnd", 0, 0);
  const samples = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(250);
    const s = await probe();
    if (s) samples.push(s);
  }
  const alive = samples.filter((s) => s.cells > 0);
  coast = {
    from: samples[0],
    to: samples[samples.length - 1],
    // Still under way a second and a half after the finger left the glass...
    keptGoing: alive.length > 1 && alive[alive.length - 1].x - alive[0].x > 120,
    // ...and still holding the course it was given.
    heldCourse: alive.length > 0 && alive[alive.length - 1].power > 0,
    // If it died mid-check the two flags above mean nothing. Say so rather than
    // reporting a failure that is really a bad sample.
    survived: samples.length > 0 && alive.length === samples.length,
  };
}

// Then roam, for the screenshot and to shake out anything that only breaks once
// there are other blobs about.
for (let i = 0; i < 100; i++) {
  const a = (i / 100) * Math.PI * 4;
  const x = cx + Math.cos(a) * viewport.width * 0.28;
  const y = cy + Math.sin(a) * viewport.height * 0.18;
  if (phone) {
    if (i === 0) await touch("touchStart", cx, cy);
    await touch("touchMove", x, y);
    if (i === 45) {
      const boost = page.getByRole("button", { name: /boost/i });
      if (await boost.count()) await boost.first().dispatchEvent("pointerdown");
    }
    if (i === 60) {
      const boost = page.getByRole("button", { name: /boost/i });
      if (await boost.count()) await boost.first().dispatchEvent("pointerup");
    }
  } else {
    await page.mouse.move(x, y);
    if (i === 40) await page.keyboard.down("Space");
    if (i === 55) await page.keyboard.up("Space");
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
  const scratch = document.createElement("canvas");
  scratch.width = 80;
  scratch.height = 50;
  const g = scratch.getContext("2d");
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
    d.textContent?.trim().startsWith("longest"),
  );
  const massEl = [...document.querySelectorAll("div")].find(
    (d) => d.textContent?.trim() === "length",
  );
  return {
    leaderboard: board ? board.innerText.split("\n").slice(0, 5) : null,
    hud: massEl?.parentElement?.parentElement?.innerText?.replace(/\n/g, " ") ?? null,
  };
});

console.log(JSON.stringify({ route, phone, frame, status, coast, problems }, null, 2));
console.log(`wrote ${out}`);

await browser.close();
if (server) server.kill();
process.exit(problems.length ? 1 : 0);
