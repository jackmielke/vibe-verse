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
import { createHash } from "node:crypto";

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
/**
 * Fewest distinct frames worth keeping.
 *
 * The gate that makes this safe to point at a list of worlds. "A world that
 * waits at a title screen records a title screen" is not a warning anybody will
 * remember to act on, so it is checked instead: below this the recording is
 * discarded and the world keeps its still. Eight over a couple of seconds is
 * about where a clip reads as motion rather than as a glitching JPEG.
 */
const MIN_FRAMES = flag("min-frames", 8);

/**
 * Frame count, distinct frames and real duration, read back out of the GIF.
 *
 * Checking the encoder's own output rather than trusting what it was asked for.
 * Two of the three bugs in this tool produced a *structurally perfect* GIF with
 * the wrong pictures in it — duplicated frames, and delays describing a rate the
 * capture never achieved — and neither is visible from anything but the bytes.
 */
function gifStats(b) {
  let i = 13;
  const g = b[10];
  if (g & 0x80) i += 3 * 2 ** ((g & 7) + 1);
  const seen = new Set();
  let frames = 0, cs = 0, pending = 0, guard = 0;
  while (i < b.length && guard++ < 200000) {
    const blk = b[i];
    if (blk === 0x3b) break;
    if (blk === 0x21) {
      if (b[i + 1] === 0xf9) pending = b.readUInt16LE(i + 4);
      i += 2;
      while (i < b.length && b[i]) i += b[i] + 1;
      i++;
      continue;
    }
    if (blk === 0x2c) {
      const packed = b[i + 9];
      i += 10;
      if (packed & 0x80) i += 3 * 2 ** ((packed & 7) + 1);
      i++;
      const start = i;
      while (i < b.length && b[i]) i += b[i] + 1;
      i++;
      frames++;
      cs += pending;
      seen.add(createHash("md5").update(b.subarray(start, i)).digest("hex"));
      continue;
    }
    break;
  }
  return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), frames, distinct: seen.size, duration: cs / 100 };
}

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

let dataUrl;
try {
  dataUrl = await page.evaluate(
    (o) => window.__recordGif(o),
    { ms: MS, fps: FPS, width: WIDTH, colors: COLORS },
  );
} catch (e) {
  clearInterval(ticker);
  const why = String(e?.message ?? e);
  /* "nothing moved" is a verdict about the world, not a crash in the tool, so
     it exits the same way a too-still recording does. Reporting it as a failure
     sent Splash Royale and Drop Zero to the "broken" column when what actually
     happened is that their `?shot` mode does its job — it takes a still. */
  if (/nothing on this page moved/.test(why)) {
    console.error(`REJECTED ${route}: nothing moved. It keeps its still.`);
    await browser.close();
    if (server) server.kill();
    process.exit(2);
  }
  throw e;
}
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

const stats = gifStats(buf);
const realFps = stats.duration > 0 ? stats.frames / stats.duration : 0;
console.log(
  `  ${stats.w}x${stats.h} · ${stats.frames} frames (${stats.distinct} distinct) · ` +
    `${stats.duration.toFixed(2)}s · ${realFps.toFixed(1)} fps · ${Math.round(buf.length / 1024)} kB`,
);

if (stats.distinct < MIN_FRAMES) {
  console.error(
    `REJECTED ${route}: ${stats.distinct} distinct frames, need ${MIN_FRAMES}. ` +
      `Not enough happens here without a player — it keeps its still.`,
  );
  await browser.close();
  if (server) server.kill();
  process.exit(2);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${out} (${Math.round(buf.length / 1024)} kB)`);

await browser.close();
if (server) server.kill();
process.exit(0);
