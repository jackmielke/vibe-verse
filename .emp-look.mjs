/* Throwaway: like scripts/empyrean-shot.mjs but it insists that the world
   actually started before it photographs anything. Deleted when done. */
import { chromium } from "playwright";
import { writeFileSync, existsSync } from "node:fs";

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWS = {
  plaza: { at: [0, 621, 86], look: [0, -0.42], dist: 11 },
  spires: { at: [0, 621, 100], look: [0, -0.85], dist: 6 },
  bazaar: { at: [178, 621, 0], look: [Math.PI / 2, -0.05], dist: 3.2 },
  ring: { at: [119.5, 621, 69], look: [2.618, -0.12], dist: 5 },
};
const name = process.argv[2];
const out = process.argv[3];
const view = VIEWS[name];

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
         "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("console", m.text().slice(0, 200)); });
await page.goto(`${BASE}/empyrean`, { waitUntil: "domcontentloaded", timeout: 180000 });

for (let attempt = 0; attempt < 6; attempt++) {
  const btn = page.getByText("Arrive", { exact: false }).first();
  if (await btn.count().catch(() => 0)) {
    await btn.click({ timeout: 30000 }).catch((e) => console.log("click failed", String(e).slice(0, 80)));
  }
  await page.waitForTimeout(15000);
  const ok = await page.evaluate(() => !!window.__empyrean).catch(() => false);
  console.log(`attempt ${attempt}: __empyrean ${ok}`);
  if (ok) break;
}
await page.waitForTimeout(20000);
for (let i = 0; i < 2; i++) {
  await page.evaluate((v) => {
    const d = window.__empyrean;
    if (!d) return;
    d.freeze(true);
    d.warp(v.at[0], v.at[1], v.at[2]);
    d.look(v.look[0], v.look[1]);
    d.dist(v.dist);
  }, view).catch((e) => console.log("warp failed", String(e).slice(0, 80)));
  await page.waitForTimeout(6000);
}
const counts = await page.evaluate(() => window.__empyrean?.counts?.() ?? null).catch(() => null);
const state = await page.evaluate(() => window.__empyrean?.state?.() ?? null).catch(() => null);
writeFileSync(out, await page.screenshot({ type: "jpeg", quality: 90 }));
console.log(name, "→", out, JSON.stringify(counts), JSON.stringify(state));
await browser.close();
