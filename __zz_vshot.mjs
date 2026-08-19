import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const BASE = "http://127.0.0.1:5177";
const VIEWS = {
  lifter: { at: [29.7, 621, -29.7], look: [-Math.PI / 4, 0.16], dist: 13 },
  skiff:  { at: [188.5, 621, 227.6], look: [Math.PI / 4, 0.14], dist: 14 },
  glider: { at: [-243.6, 605, -243.6], look: [Math.PI / 4, 0.10], dist: 17 },
  far:    { at: [0, 640, 120], look: [0.6, -0.10], dist: 70 },
};
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--no-sandbox","--disable-dev-shm-usage"],
});
mkdirSync(".shots", { recursive: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errs = [];
let PADS = null;
page.on("pageerror", (e) => errs.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" && !/ERR_TUNNEL|favicon/.test(m.text())) errs.push(m.text()); });
await page.goto(`${BASE}/empyrean`, { waitUntil: "domcontentloaded", timeout: 180000 });
let up = false;
for (let a = 0; a < 6 && !up; a++) {
  await page.getByText("Arrive", { exact: false }).first().click({ timeout: 20000 }).catch(() => {});
  const dl = Date.now() + 26000;
  while (Date.now() < dl) { up = await page.evaluate(() => typeof window.__empyrean === "object").catch(() => false); if (up) break; await page.waitForTimeout(1500); }
}
console.log("world up:", up);
PADS = await page.evaluate(() => (window.__empyrean?.vehiclePads?.() ?? null));
console.log("pads", JSON.stringify(PADS));
await page.waitForTimeout(6000);
for (const [name, v] of Object.entries(VIEWS)) {
  await page.evaluate((v) => { const d = window.__empyrean; d.freeze(true); d.warp(...v.at); d.look(v.look[0], v.look[1]); d.dist(v.dist); }, v);
  await page.waitForTimeout(4000);
  await page.evaluate((v) => { const d = window.__empyrean; d.warp(...v.at); d.look(v.look[0], v.look[1]); d.dist(v.dist); }, v);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `.shots/veh-${name}.jpg`, type: "jpeg", quality: 88 });
  console.log(name, "shot", JSON.stringify(await page.evaluate(() => window.__empyrean?.counts?.() ?? null)));
}
console.log("errors:", errs.slice(0, 5));
await browser.close();
