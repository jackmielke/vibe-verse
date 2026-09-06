/**
 * coast-probe: open /coast-road in headless Chromium, report what the engine
 * says about itself (rider, camera, ride state, console errors) and take a
 * frame at a few points along the road. Software rendering makes a frame take
 * seconds, so the probe jumps the ride with `window.__coast.jump(s)` rather
 * than riding there.
 *
 * Usage: node scripts/coast-probe.mjs painted|lens out-dir [s1,s2,...]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const style = process.argv[2] ?? "painted";
const outDir = process.argv[3] ?? "shots";
const stops = (process.argv[4] ?? "12,700,1500,2450").split(",").map(Number);
const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
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
const server = (await up(BASE, 1200))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, BROWSER: "none" },
    });
if (server && !(await up(BASE, 120000))) {
  console.error("dev server never came up");
  process.exit(1);
}
const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") {
    const t = m.text();
    if (!/Failed to load resource|ERR_TUNNEL|ERR_CONNECTION/.test(t)) errors.push(t.slice(0, 600));
  }
});
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 400)));
await page.goto(`${BASE}/coast-road?shot=${style}${process.env.START ? `&s=${process.env.START}` : ""}`, { waitUntil: "domcontentloaded", timeout: 90000 });

if (process.env.CLICK) await page.mouse.click(800, 450).catch(() => {});
const waitFrames = async (n, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = await page.evaluate(() => window.__coast?.frames?.() ?? -1).catch(() => -1);
    if (f >= n) return f;
    await new Promise((r) => setTimeout(r, 500));
  }
  return -1;
};
if (process.env.WAIT) {
  await page.waitForTimeout(Number(process.env.WAIT));
  const info = await page.evaluate(() => {
    const r = window.__coast.ride();
    return { frames: window.__coast.frames(), s: r.s.toFixed(1), speed: r.speed.toFixed(2), z: r.z.toFixed(2), lat: r.lat.toFixed(2), lean: r.lean.toFixed(2), rider: window.__coast.rider().map((v) => +v.toFixed(2)), cam: window.__coast.camera().map((v) => +v.toFixed(2)), canvases: document.querySelectorAll("canvas").length };
  });
  console.log("after wait", JSON.stringify(info));
  await page.screenshot({ path: `${outDir}/${style}-wait.jpg`, type: "jpeg", quality: 82 });
  console.log("console errors:", errors.length ? "\n" + errors.join("\n---\n") : "none");
  await browser.close();
  server?.kill();
  process.exit(0);
}
console.log("frames after boot:", await waitFrames(3, 120000));
for (const s of stops) {
  if (s >= 0) await page.evaluate((s) => window.__coast.jump(s), s);
  const f0 = await page.evaluate(() => window.__coast.frames());
  await waitFrames(f0 + 3, 90000);
  const info = await page.evaluate(() => {
    const r = window.__coast.ride();
    return { s: r.s.toFixed(1), speed: r.speed.toFixed(1), lat: r.lat.toFixed(2), rider: window.__coast.rider().map((v) => +v.toFixed(1)), cam: window.__coast.camera().map((v) => +v.toFixed(1)) };
  });
  console.log(`s=${s}`, JSON.stringify(info));
  await page.screenshot({ path: `${outDir}/${style}-${s}.jpg`, type: "jpeg", quality: 82 });
}
console.log("console errors:", errors.length ? "\n" + errors.join("\n---\n") : "none");
await browser.close();
server?.kill();
