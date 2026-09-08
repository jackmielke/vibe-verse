/**
 * beck-probe: boot /beck-road in real Chromium, jump to named viewpoints and
 * write a frame of each, so the reconstruction can be judged against the
 * reference map without playing it at one frame a second.
 *
 * Usage: SF_PORT=5177 node scripts/beck-probe.mjs <outDir> [preset,preset,...] [weather]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const outDir = process.argv[2] ?? "beck-shots";
const wanted = (process.argv[3] ?? "").split("|").map((s) => s.trim()).filter(Boolean);
const weather = process.argv[4] ?? "sun";
mkdirSync(outDir, { recursive: true });

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
const server = (await up(BASE, 1200)) ? null : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, BROWSER: "none" } });
if (server && !(await up(BASE, 120000))) {
  console.error("dev server never came up");
  process.exit(1);
}
const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ ...(existsSync(exe) ? { executablePath: exe } : {}), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: Number(process.env.SHOT_W ?? 1280), height: Number(process.env.SHOT_H ?? 720) } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text());
});
await page.goto(`${BASE}/beck-road?shot&weather=${weather}${process.env.FULL ? "" : "&lite"}`, { waitUntil: "domcontentloaded", timeout: 90000 });
const t0 = Date.now();
while (Date.now() - t0 < 300000) {
  const ok = await page.evaluate(() => !!window.__beck && window.__beck.ready()).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(1000);
}
console.log("ready after", ((Date.now() - t0) / 1000).toFixed(0), "s");
const presets = await page.evaluate(() => window.__beck.presets());
console.log("debug:", JSON.stringify(await page.evaluate(() => window.__beck.debug && window.__beck.debug())));
console.log("presets:", presets.join(" | "));
async function frames(n, ms) {
  const f0 = await page.evaluate(() => window.__beck.frames());
  const s = Date.now();
  while (Date.now() - s < ms) {
    const f = await page.evaluate(() => window.__beck.frames());
    if (f - f0 >= n) return f - f0;
    await page.waitForTimeout(500);
  }
  return -1;
}
const list = wanted.length ? wanted : presets;
for (const name of list) {
  const custom = name.match(/^xz:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)(,fly)?$/);
  if (custom) await page.evaluate(([x, z, y, p, fly]) => window.__beck.teleport(x, z, y, p, !!fly), [+custom[1], +custom[2], +custom[3], +custom[4], custom[5]]);
  else await page.evaluate((n) => window.__beck.preset(n), name);
  const got = await frames(3, 180000);
  const st = await page.evaluate(() => window.__beck.state());
  const file = `${outDir}/${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.jpg`;
  await page.screenshot({ path: file, type: "jpeg", quality: 84, timeout: 300000 });
  console.log(name, "frames", got, JSON.stringify({ x: +st.x.toFixed(1), y: +st.y.toFixed(1), z: +st.z.toFixed(1) }), "->", file);
}
console.log("errors:", errors.length ? "\n" + errors.slice(0, 12).join("\n---\n") : "none");
await browser.close();
server?.kill();
