import { chromium } from "playwright";
const BASE = "http://127.0.0.1:5177";
const b = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage"],
});
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
await p.goto(`${BASE}/empyrean`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(8000);
try { await p.getByRole("button", { name: /arrive/i }).click({ timeout: 8000 }); } catch { /* in */ }
await p.waitForTimeout(12000);
const ok = await p.evaluate(() => {
  const w = window.__empyrean;
  if (!w) return false;
  for (const n of ["buildings", "props", "streets", "crowd", "interiors", "activities", "weather", "vehicles"]) w.hide(n, false);
  w.warp(0, 1180, 0);
  w.look(0, 1.35);
  w.dist(30);
  return true;
}).catch((e) => String(e));
console.log("setup", ok);
await p.waitForTimeout(6000);
await p.screenshot({ path: ".shots/traffic-only.jpg", type: "jpeg", quality: 92 });
console.log("shot done");
await b.close();
