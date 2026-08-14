#!/usr/bin/env node
/**
 * route-gif — record a world playing itself, as an animated GIF.
 *
 *   node scripts/route-gif.mjs "/coil?shot" src/assets/worlds/coil.gif
 *   node scripts/route-gif.mjs "/coil?shot" out.gif --ms 3000 --fps 12.5 --width 400
 *
 * The sibling of `route-shot.mjs`, and it works the same way: drive the real
 * dev server in a real browser, because the only honest picture of a world is
 * the world running. The difference is that a still can be taken from any
 * frame, and a *loop* has to come from a world that is doing something
 * without a player.
 *
 * That is the whole trick, and it is not this script's: several worlds already
 * have a `?shot` mode for the still captures — COIL's hands the player to an
 * AI brain, hides the menu and respawns on death, because "an empty arena is
 * not a card shot". A world with an attract mode can be recorded. A world that
 * waits at a title screen records three seconds of a title screen.
 *
 * Encoding happens in the page (`src/dev/routeGif.ts`) rather than here: the
 * frames are read straight off the game's canvas as raw RGBA, so nothing has
 * to decode a PNG, which matters because this container has no image codecs
 * at all beyond the browser's own.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

const route = positional[0];
const outArg = positional[1];
if (!route || !outArg) {
  console.error('usage: node scripts/route-gif.mjs "/coil?shot" src/assets/worlds/coil.gif');
  process.exit(1);
}

const MS = flag("ms", 3000);
const FPS = flag("fps", 12.5);
const WIDTH = flag("width", 400);
const COLORS = flag("colors", 128);
/** Settle time before the shutter — worlds boot, load models and fade in. */
const WARMUP = flag("warmup", 6000);
/**
 * Viewport size relative to the output width.
 *
 * Bigger is sharper and slower. This container renders in software, and the
 * frame rate a world manages here is the frame rate the recording gets — at 2×
 * COIL painted about five distinct frames a second, which is a slideshow. The
 * downscale is worth less than the smoothness, so the default is close to 1:1.
 */
const SCALE = flag("scale", 1.25);

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const out = resolve(process.cwd(), outArg);

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

const server = (await up(BASE, 1500))
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

/* 16:9, sized off the output width — see `SCALE`. */
const vw = Math.round(WIDTH * SCALE);
const page = await browser.newPage({
  viewport: { width: vw, height: Math.round((vw * 9) / 16) },
  deviceScaleFactor: 1,
});
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

const url = BASE + (route.startsWith("/") ? route : `/${route}`);
console.log(`recording ${url} — ${MS}ms at ${FPS}fps, ${WIDTH}px wide`);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

// Let the world boot, load whatever it loads, and get past any intro fade.
await page.waitForTimeout(WARMUP);

await page.evaluate(async () => {
  await import("/src/dev/routeGif.ts");
});

const canvas = await page.evaluate(() => {
  const all = [...document.querySelectorAll("canvas")];
  if (!all.length) return null;
  const c = all.reduce((b, x) =>
    x.clientWidth * x.clientHeight > b.clientWidth * b.clientHeight ? x : b,
  );
  return { w: c.clientWidth, h: c.clientHeight };
});
if (!canvas) {
  console.error(`no canvas on ${route} — there is nothing to record`);
  await browser.close();
  if (server) server.kill();
  process.exit(1);
}
console.log(`  canvas ${canvas.w}×${canvas.h}`);

const ticker = setInterval(async () => {
  const p = await page.evaluate(() => window.__gifProgress).catch(() => null);
  if (p) process.stdout.write(`\r  ${p.phase} ${p.done}/${p.total}   `);
}, 700);

const dataUrl = await page.evaluate(
  (o) => window.__recordGif(o),
  { ms: MS, fps: FPS, width: WIDTH, colors: COLORS },
);
clearInterval(ticker);
process.stdout.write("\r");

const b64 = dataUrl.split(",")[1];
if (!b64 || b64.length < 2000) {
  console.error("the recording came back empty");
  await browser.close();
  if (server) server.kill();
  process.exit(1);
}
const buf = Buffer.from(b64, "base64");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${out} (${Math.round(buf.length / 1024)} kB)`);

await browser.close();
if (server) server.kill();
process.exit(0);
