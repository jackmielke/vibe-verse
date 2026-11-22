#!/usr/bin/env node
/**
 * fogcity-check: boot /fogcity in a real browser, play it through its debug
 * hook, and write frames.
 *
 *   node scripts/fogcity-check.mjs <outdir>
 *
 * Needs a dev server on 5177 (`npx vite --port 5177`). The sandbox has no GPU,
 * so the game is stepped with `__fog.run(n)` rather than by waiting: that runs
 * the same simulation the frame loop runs, without drawing.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const out = process.argv[2] ?? "shots";
mkdirSync(out, { recursive: true });
const exe = [process.env.SF_CHROME, "/opt/pw-browsers/chromium"].filter(Boolean).find((p) => existsSync(p));
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if ((m.type() === "error" || /THREE\.WebGL/.test(m.text())) && !/net::|Failed to load resource|WebSocket/.test(m.text())) problems.push(m.text().slice(0, 600)); });
await page.goto(`http://127.0.0.1:${process.env.PORT ?? 5177}/fogcity?go&shot`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__fog, null, { timeout: 120000 });
await page.waitForTimeout(4000);

const state = () => page.evaluate(() => window.__fog.state());
const shot = async (name) => {
  const url = await page.evaluate(() => window.__fog.snapshot());
  writeFileSync(`${out}/${name}.jpg`, Buffer.from(url.split(",")[1], "base64"));
};
const fog = (fn, ...args) => page.evaluate(([f, a]) => window.__fog[f](...a), [fn, args]);

console.log("boot", JSON.stringify(await state()));
await fog("run", 30);
await shot("01-spawn");

// Walk forward for three seconds.
const a = await state();
await fog("key", "w", true);
await fog("run", 180);
await fog("key", "w", false);
const b = await state();
console.log("walked", Math.hypot(b.x - a.x, b.z - a.z).toFixed(1), "m");

// Get in the car parked at the kerb and drive for eight seconds.
await fog("teleport", -3 * 96 - 8.6, 0.72 * 72 - 1, Math.PI / 2);
await fog("key", "f", true); await fog("run", 2); await fog("key", "f", false);
const c = await state();
console.log("in car", c.driving);
await fog("key", "w", true);
await fog("run", 480);
const d = await state();
console.log("drove", Math.hypot(d.x - c.x, d.z - c.z).toFixed(1), "m, speed", d.speed.toFixed(1), "m/s");
await shot("02-driving");
await fog("key", "a", true); await fog("run", 90); await fog("key", "a", false);
await fog("key", "w", false);
await fog("run", 60);
await shot("03-turned");

// Heat: ask for three bars and let the police arrive.
await fog("heat", 3);
await fog("run", 900);
const e = await state();
console.log("heat", e.heat.toFixed(2), "cops", e.cops);
await shot("04-heat");

// The sights.
const views = [
  ["05-ladies", -3 * 96 - 60, 36, 1.75, 0.18, 12, 17.5],
  ["06-downtown", 5 * 96, -3 * 72 + 20, Math.PI, 0.3, 14, 13],
  ["07-bridge", -864, -1010, Math.PI, 0.22, 16, 17.2],
  ["08-on-bridge", -864, -1500, Math.PI, 0.3, 14, 10],
  ["09-twin-peaks", -5 * 96, 9 * 72, 2.3, 0.25, 14, 17.6],
  ["10-night", 6 * 96, -4 * 72 + 20, Math.PI, 0.3, 14, 22],
  ["11-fog", -2 * 96, -5 * 72, 2.0, 0.25, 14, 9],
  ["12-coit", 4 * 96, -10 * 72 + 30, 3.4, 0.3, 30, 16],
];
for (const [name, x, z, yaw, pitch, dist, hour] of views) {
  await fog("teleport", x, z, yaw);
  await fog("setTime", hour);
  await fog("setFog", name === "11-fog" ? 1 : 0.1);
  await fog("setCam", yaw, pitch, dist);
  await fog("run", 40);
  await shot(name);
}
const f = await state();
console.log("end", JSON.stringify(f));
console.log(problems.length ? `problems:\n  ${[...new Set(problems)].slice(0, 12).join("\n  ")}` : "no page errors");
await browser.close();
process.exit(problems.length ? 1 : 0);
