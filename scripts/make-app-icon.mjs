#!/usr/bin/env node
/**
 * make-app-icon — draw the VibeVerse home-screen icon at every size the
 * manifest and iOS ask for.
 *
 * The icon this replaces was the Edge Esmeralda villa: a beautiful piece of
 * art, and a photograph of a building, which is the wrong shape for something
 * rendered at 48 px on a phone home screen. This one is drawn to survive that
 * size — one ringed world, high contrast, no text, nothing thinner than a few
 * pixels at the smallest export.
 *
 * The maskable variant keeps the whole world inside the middle 80% (the safe
 * circle Android may crop to) and lets only the sky bleed to the edges.
 *
 * Usage: node scripts/make-app-icon.mjs
 */
import { chromium } from "playwright";
import { writeFileSync, existsSync } from "node:fs";

/* Sizes the app actually references. `maskable` is a separate drawing, not a
   separate resolution — see the safe-circle note above. */
const EXPORTS = [
  { file: "public/app-icon.png", size: 1024, maskable: false },
  { file: "public/app-icon-512.png", size: 512, maskable: false },
  { file: "public/app-icon-192.png", size: 192, maskable: false },
  { file: "public/app-icon-maskable.png", size: 512, maskable: true },
  { file: "public/apple-touch-icon.png", size: 180, maskable: false },
  { file: "public/apple-touch-icon-precomposed.png", size: 180, maskable: false },
  { file: "public/apple-touch-icon-167.png", size: 167, maskable: false },
  { file: "public/apple-touch-icon-152.png", size: 152, maskable: false },
];

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage();

const draw = async (size, maskable) =>
  page.evaluate(
    ({ size, maskable }) => {
      const S = size;
      const c = document.createElement("canvas");
      c.width = S;
      c.height = S;
      const g = c.getContext("2d");
      const u = S / 1024; // everything below is authored at 1024 and scaled

      /* Sky. The app's own background navy, lifted towards the horizon so the
         world reads as lit from below-left rather than floating in flat black. */
      const sky = g.createLinearGradient(0, 0, S, S);
      sky.addColorStop(0, "#0a1426");
      sky.addColorStop(0.55, "#0d2340");
      sky.addColorStop(1, "#132b4d");
      g.fillStyle = sky;
      g.fillRect(0, 0, S, S);

      /* Aurora — the mint and violet the whole app is built out of. */
      const aur = (x, y, r, colour) => {
        const rg = g.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, colour);
        rg.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = rg;
        g.fillRect(0, 0, S, S);
      };
      aur(S * 0.2, S * 0.16, S * 0.62, "rgba(45,232,178,0.22)");
      aur(S * 0.86, S * 0.1, S * 0.5, "rgba(150,90,255,0.2)");

      // Stars. Fixed positions — a random field re-rolls on every export and
      // the icon should be byte-comparable between runs.
      const stars = [
        [0.12, 0.3, 3], [0.2, 0.72, 2.5], [0.32, 0.14, 2], [0.78, 0.28, 3],
        [0.88, 0.62, 2.5], [0.68, 0.85, 2], [0.46, 0.9, 2.5], [0.08, 0.52, 2],
        [0.92, 0.42, 2], [0.58, 0.08, 2.5],
      ];
      g.fillStyle = "rgba(255,255,255,0.85)";
      for (const [x, y, r] of stars) {
        g.beginPath();
        g.arc(x * S, y * S, r * u * 1.6, 0, Math.PI * 2);
        g.fill();
      }

      /* The world. Smaller on the maskable variant so it survives a circular
         crop with room to spare. */
      const cx = S * 0.5;
      const cy = S * 0.5;
      const R = S * (maskable ? 0.26 : 0.315);

      // Ring, behind the planet.
      const ring = (rx, ry, w, alpha) => {
        g.save();
        g.translate(cx, cy);
        g.rotate(-0.42);
        g.strokeStyle = `rgba(140,240,255,${alpha})`;
        g.lineWidth = w;
        g.beginPath();
        g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      };
      ring(R * 1.62, R * 0.5, 14 * u, 0.55);
      ring(R * 1.86, R * 0.58, 7 * u, 0.3);

      // Glow, so the planet separates from the sky at 48 px.
      const glow = g.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.9);
      glow.addColorStop(0, "rgba(45,232,178,0.35)");
      glow.addColorStop(1, "rgba(45,232,178,0)");
      g.fillStyle = glow;
      g.fillRect(0, 0, S, S);

      // Planet body, lit from the upper left.
      const body = g.createRadialGradient(
        cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R,
      );
      body.addColorStop(0, "#7dffd4");
      body.addColorStop(0.42, "#22c99a");
      body.addColorStop(0.82, "#116a8f");
      body.addColorStop(1, "#0a2a4a");
      g.fillStyle = body;
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.fill();

      /* Continents. Every one of them runs off the limb of the disc, which is
         the whole trick: two tidy ellipses floating in the middle of a green
         sphere read as a face, and the first draft of this icon looked like an
         alien. Land that is clipped by the horizon reads as land. */
      g.save();
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.clip();
      g.fillStyle = "rgba(10,42,74,0.5)";
      const blob = (x, y, rx, ry, rot) => {
        g.beginPath();
        g.ellipse(cx + R * x, cy + R * y, R * rx, R * ry, rot, 0, Math.PI * 2);
        g.fill();
      };
      // A landmass sweeping in from the left limb and up across the equator.
      blob(-0.9, 0.16, 0.66, 0.34, 0.4);
      blob(-0.4, 0.42, 0.44, 0.22, 0.5);
      blob(0.06, 0.62, 0.3, 0.16, 0.35);
      // A second one entering from the top right and running off that limb too.
      blob(0.78, -0.6, 0.6, 0.32, -0.55);
      blob(0.42, -0.28, 0.26, 0.13, -0.5);
      // Terminator, so the sphere has a horizon.
      const term = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      term.addColorStop(0, "rgba(0,0,0,0)");
      term.addColorStop(0.62, "rgba(4,12,26,0)");
      term.addColorStop(1, "rgba(4,12,26,0.62)");
      g.fillStyle = term;
      g.fillRect(cx - R, cy - R, R * 2, R * 2);
      g.restore();

      // Ring in front, closing the ellipse over the planet's lower half.
      g.save();
      g.beginPath();
      g.rect(0, cy, S, S - cy);
      g.clip();
      ring(R * 1.62, R * 0.5, 14 * u, 0.9);
      ring(R * 1.86, R * 0.58, 7 * u, 0.5);
      g.restore();

      return c.toDataURL("image/png");
    },
    { size, maskable },
  );

for (const { file, size, maskable } of EXPORTS) {
  const url = await draw(size, maskable);
  writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
  console.log(`wrote ${file} (${size}px${maskable ? ", maskable" : ""})`);
}

/* favicon.ico. An .ico may carry a PNG payload verbatim, which every browser
   that matters has understood for a decade — 6-byte directory, one 16-byte
   entry, then the file. Beats shipping a stale villa in the tab. */
const faviconPng = Buffer.from((await draw(64, false)).split(",")[1], "base64");
const ico = Buffer.alloc(6 + 16 + faviconPng.length);
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // one image
ico.writeUInt8(64, 6); // width
ico.writeUInt8(64, 7); // height
ico.writeUInt8(0, 8); // palette
ico.writeUInt8(0, 9); // reserved
ico.writeUInt16LE(1, 10); // colour planes
ico.writeUInt16LE(32, 12); // bits per pixel
ico.writeUInt32LE(faviconPng.length, 14);
ico.writeUInt32LE(22, 18); // offset to the payload
faviconPng.copy(ico, 22);
writeFileSync("public/favicon.ico", ico);
console.log("wrote public/favicon.ico");

await browser.close();
