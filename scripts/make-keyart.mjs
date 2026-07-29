#!/usr/bin/env node
/**
 * make-keyart — draw a stylised world card for a world that cannot yet be
 * captured cleanly.
 *
 * This is deliberately *illustration*, not a fake screenshot: flat colour,
 * silhouettes, a sun. Nobody will mistake it for gameplay, which is the point.
 * Replace it with a real capture the moment the world can produce one.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { existsSync } from "node:fs";

const out = process.argv[2] ?? "keyart.jpg";
const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const b = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--no-sandbox"],
});
const p = await b.newPage();
const data = await p.evaluate(() => {
  const W = 960, H = 540;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");

  // Sky: tropical dusk, warm at the horizon into deep teal above.
  const sky = g.createLinearGradient(0, 0, 0, H * 0.72);
  sky.addColorStop(0, "#123047");
  sky.addColorStop(0.45, "#3f6f7d");
  sky.addColorStop(0.78, "#e8a24c");
  sky.addColorStop(1, "#f6cf82");
  g.fillStyle = sky; g.fillRect(0, 0, W, H);

  // Sun.
  g.fillStyle = "#ffd489";
  g.beginPath(); g.arc(W * 0.68, H * 0.60, 58, 0, Math.PI * 2); g.fill();
  const glow = g.createRadialGradient(W * 0.68, H * 0.60, 40, W * 0.68, H * 0.60, 190);
  glow.addColorStop(0, "rgba(255,196,96,.55)");
  glow.addColorStop(1, "rgba(255,196,96,0)");
  g.fillStyle = glow; g.fillRect(0, 0, W, H);

  // Water.
  const sea = g.createLinearGradient(0, H * 0.70, 0, H);
  sea.addColorStop(0, "#c98a4a");
  sea.addColorStop(0.25, "#2c5566");
  sea.addColorStop(1, "#14313f");
  g.fillStyle = sea; g.fillRect(0, H * 0.70, W, H * 0.30);
  // Sun glitter on the water: broken dashes that widen and fade toward the
  // viewer. A solid taper reads as a drawn triangle, which is worse than none.
  const jitter = (() => { let s = 19; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  for (let y = H * 0.71; y < H; y += 4) {
    const t = (y - H * 0.71) / (H * 0.29);
    const w = 26 + t * 190;
    const alpha = 0.34 * (1 - t * 0.85);
    g.fillStyle = `rgba(255,214,150,${alpha.toFixed(3)})`;
    let dx = -w / 2;
    while (dx < w / 2) {
      const seg = 4 + jitter() * 22;
      if (jitter() > 0.32) g.fillRect(W * 0.68 + dx, y, seg, 2);
      dx += seg + 3 + jitter() * 12;
    }
  }

  // Skyline silhouette.
  g.fillStyle = "#0c1b26";
  let x = 0;
  const rnd = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  while (x < W) {
    const w = 26 + rnd() * 54;
    const h = 40 + rnd() * 150;
    g.fillRect(x, H * 0.70 - h, w, h);
    x += w + 5;
  }

  // Palms in the foreground — the "Palmas" part.
  const palm = (px, py, s, flip) => {
    g.save(); g.translate(px, py); g.scale(flip ? -s : s, s);
    g.strokeStyle = "#08131a"; g.lineWidth = 7; g.lineCap = "round";
    g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(14, -70, 4, -140); g.stroke();
    g.fillStyle = "#08131a";
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI * 0.92 + i * 0.30;
      g.beginPath(); g.moveTo(4, -140);
      g.quadraticCurveTo(4 + Math.cos(a) * 52, -140 + Math.sin(a) * 46,
                         4 + Math.cos(a) * 96, -140 + Math.sin(a) * 30);
      g.quadraticCurveTo(4 + Math.cos(a) * 54, -140 + Math.sin(a) * 66, 4, -140);
      g.fill();
    }
    g.restore();
  };
  palm(96, H, 1.0, false);
  palm(150, H, 0.66, true);
  palm(W - 78, H, 0.86, true);

  // Ground.
  g.fillStyle = "#08131a"; g.fillRect(0, H - 26, W, 26);

  return c.toDataURL("image/jpeg", 0.9);
});
writeFileSync(out, Buffer.from(data.split(",")[1], "base64"));
console.log("wrote", out);
await b.close();
