// Downscale the captured skyline into a world-card JPEG using the headless
// browser we already have — no native image tooling required.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
const src = process.argv[2], out = process.argv[3];
const b64 = readFileSync(src).toString("base64");
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const p = await b.newPage();
const data = await p.evaluate(async (d) => {
  const img = new Image();
  img.src = "data:image/png;base64," + d;
  await img.decode();
  const W = 960, H = 540;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, W, H);
  return c.toDataURL("image/jpeg", 0.86);
}, b64);
writeFileSync(out, Buffer.from(data.split(",")[1], "base64"));
await b.close();
console.log("wrote", out);
