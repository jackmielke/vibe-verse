#!/usr/bin/env node
/**
 * dz-crop — zoom into a region of a capture, and measure its palette.
 *
 * A companion to dz-probe. The probe's frames are 1000x600 of a whole street,
 * and the thing under test is a two-metre burst inside it: at that size "is
 * the crown there" and "is any of it red" are both unanswerable by eye. This
 * blows a region up 4x for looking at, and prints the numbers for deciding.
 *
 * No WebGL — it is a 2D canvas in a headless page, so it runs in seconds
 * rather than the minutes a SwiftSHADER composite costs.
 *
 * Usage: node scripts/dz-crop.mjs in.png out.png x y w h [zoom]
 */
import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";

const [inPath, outPath, X, Y, W, H, Z] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("usage: dz-crop.mjs in.png out.png x y w h [zoom]");
  process.exit(1);
}
const x = Number(X ?? 0);
const y = Number(Y ?? 0);
const w = Number(W ?? 320);
const h = Number(H ?? 200);
const z = Number(Z ?? 4);

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: w * z, height: h * z } });
await page.goto("about:blank");

const stats = await page.evaluate(
  async ({ url, x, y, w, h, z }) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("image failed to load"));
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = w * z;
    c.height = h * z;
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.drawImage(img, x, y, w, h, 0, 0, w * z, h * z);
    document.body.style.margin = "0";
    document.body.appendChild(c);

    // Measure off the ORIGINAL pixels, not the upscale.
    const m = document.createElement("canvas");
    m.width = w;
    m.height = h;
    const mg = m.getContext("2d");
    mg.drawImage(img, x, y, w, h, 0, 0, w, h);
    const d = mg.getImageData(0, 0, w, h).data;

    let n = 0;
    let rs = 0;
    let gs = 0;
    let bs = 0;
    // "Warm" = red clearly ahead of blue. That is the thing that must not be
    // in a water effect, and it is a threshold rather than a hue so that a
    // terracotta roof in the corner of the crop is counted honestly too.
    let warm = 0;
    let cool = 0;
    let bright = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const gg = d[i + 1];
      const b = d[i + 2];
      n++;
      rs += r;
      gs += gg;
      bs += b;
      if (r > b + 30) warm++;
      if (b > r + 18) cool++;
      if (r + gg + b > 630) bright++;
    }
    return {
      pixels: n,
      mean: [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)],
      warmPct: +((warm / n) * 100).toFixed(2),
      coolPct: +((cool / n) * 100).toFixed(2),
      brightPct: +((bright / n) * 100).toFixed(2),
    };
  },
  // A data URI rather than a file:// path: an about:blank page is an opaque
  // origin and cannot read a local file into a canvas, which shows up as an
  // image that "fails to load" rather than as a security error.
  { url: "data:image/png;base64," + readFileSync(inPath).toString("base64"), x, y, w, h, z },
);

console.log(JSON.stringify(stats, null, 2));
await page.screenshot({ path: outPath });
console.log("wrote", outPath);
await browser.close();
