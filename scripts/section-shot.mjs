#!/usr/bin/env node
/**
 * section-shot — photograph one part of a page, not the whole thing.
 *
 * `route-shot` gives you the fold and `mobile-shot` gives you the entire
 * scroll, and neither is any use for checking a detail near the bottom of a
 * long page: the full-page capture of `/times` is eighteen thousand pixels
 * tall, so the thing you wanted to look at arrives four megabytes down and a
 * millimetre high.
 *
 * This finds the element containing some text and screenshots that element.
 * It is how the byline under a lead story and the classifieds column at the
 * foot of the paper were actually looked at rather than assumed.
 *
 * Usage:
 *   node scripts/section-shot.mjs /times "The Small Ads" out.png
 *   node scripts/section-shot.mjs /times "JACK MIELKE" out.png 900 article
 *
 * The last two arguments are the viewport width (default 1280) and the
 * selector to search within (default `section`) — pass `article` for a story,
 * or anything else CSS understands.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const [route, needle, out = "shots/section.png", widthArg, sel] = process.argv.slice(2);
if (!route || !needle) {
  console.error('usage: node scripts/section-shot.mjs /route "text in it" out.png [width] [selector]');
  process.exit(1);
}

const width = Number(widthArg ?? 1280);
const PORT = Number(process.env.DZ_PORT ?? 5182);
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
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});

try {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  // networkidle never settles on a page holding a websocket open, and this
  // repo's pages nearly all do. Give it a chance, then carry on regardless.
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(2500);

  const el = page.locator(sel ?? "section").filter({ hasText: needle }).first();
  if (!(await el.count())) {
    console.error(`nothing matching ${JSON.stringify(needle)} in a <${sel ?? "section"}> on ${route}`);
    process.exit(2);
  }
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await el.screenshot({ path: out });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
  server?.kill();
}
