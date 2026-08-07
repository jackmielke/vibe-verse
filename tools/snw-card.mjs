#!/usr/bin/env node
/**
 * snw-card — capture STRANGE NEW WORLDS' card art from the running world.
 *
 * The registry's rule is that a world's card is a real frame from that world,
 * and that a world whose capture only ever produces a broken frame ships
 * without art — misleading card art is worse than none. So this refuses to
 * write a blank JPEG: on a software rasteriser a lost context produces a
 * perfectly plausible black frame, and a black frame committed as card art is
 * the exact failure the rule exists to prevent.
 *
 * The pose is Vulcan from standard orbit, chrome hidden, because that shot is
 * the world's whole promise in one frame.
 *
 * Usage:
 *   node tools/snw-card.mjs src/assets/worlds/strange-new-worlds.jpg
 * Expects a dev server on SNW_PORT (default 5179).
 */
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "src/assets/worlds/strange-new-worlds.jpg";
const BASE = `http://127.0.0.1:${Number(process.env.SNW_PORT ?? 5179)}`;

const browser = await chromium.launch({
  executablePath: process.env.SNW_CHROMIUM || undefined,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${BASE}/strange-new-worlds`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__snw, null, { timeout: 40000 });
await page.click("#snw-root .title .go");
await page.evaluate(() => window.__snw.setCourse("vulcan"));
await page.waitForFunction(() => window.__snw.state.phase === "idle", null, { timeout: 120000 });
await page.waitForTimeout(4000);
// Hide the overlay: the card is the world, not the world's HUD.
const stray = await page.evaluate(() => {
  document.getElementById("snw-root").style.display = "none";
  const found = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const cs = getComputedStyle(el);
    if ((cs.position === "fixed" || cs.position === "absolute") && !el.querySelector("canvas") && el.id !== "snw-root") {
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4 && r.width < innerWidth * 0.6) {
        found.push(`${el.tagName}.${el.className}`.slice(0, 60));
        el.style.display = "none";
      }
    }
  }
  return found;
});
console.log("hid:", stray);
await page.waitForTimeout(1200);
const buf = await page.screenshot({ type: "jpeg", quality: 88 });
/* Refuse a black frame. A JPEG of a lost WebGL context compresses to almost
   nothing, so the byte count is a perfectly good blankness test and needs no
   image library to run. */
console.log("bytes", buf.length);
if (buf.length < 20000) {
  console.error("frame looks blank — refusing to write card art");
  process.exit(1);
}
const { writeFileSync } = await import("node:fs");
writeFileSync(OUT, buf);
console.log("wrote", OUT);
await browser.close();
