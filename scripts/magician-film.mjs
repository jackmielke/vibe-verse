#!/usr/bin/env node
/**
 * magician-film — real footage of the valley, one fixed slice of time per
 * frame. The sandbox draws under one frame a second, so a screen recording
 * here is a slideshow; instead the live loop is stopped and the whole engine
 * (weather, spells, Vibey, water, grass) is stepped exactly 1/FPS seconds
 * per frame through `window.__magician.film()`. Stitch the JPEGs with ffmpeg.
 *
 *   node scripts/magician-film.mjs <out-dir> '<plan json>'
 *   plan: [{"at":[x,z,yaw]}, {"hold":1.5}, {"cast":"make it rain"}, {"hold":4}]
 *   FPS=24 W=1280 H=720 CHAR=Mage
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [OUT, PLAN] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const FPS = Number(process.env.FPS ?? 24);
const plan = JSON.parse(PLAN);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const p = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720) } });
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(`http://127.0.0.1:${process.env.SF_PORT ?? 5177}/magician?net=off&nointro&char=${process.env.CHAR ?? "Mage"}`, { waitUntil: "domcontentloaded" });
await p.getByRole("button", { name: /enter hoshimura/i }).click({ timeout: 120000, noWaitAfter: true });
await p.waitForFunction(() => !!window.__magician?.film, null, { timeout: 240000 });
await p.waitForTimeout(Number(process.env.SETTLE ?? 12000));
let n = 0;
const shoot = async () => {
  const d = await p.evaluate((dt) => window.__magician.film(dt, 0.9), 1 / FPS);
  writeFileSync(join(OUT, `f${String(n++).padStart(4, "0")}.jpg`), Buffer.from(d.split(",")[1], "base64"));
};
// Let everything settle into the first frame before recording.
for (let i = 0; i < Number(process.env.WARM ?? 24); i++) await p.evaluate((dt) => window.__magician.film(dt, 0.3), 1 / FPS);
for (const step of plan) {
  if (step.at) await p.evaluate((a) => window.__magician.teleport(a[0], a[1], a[2]), step.at);
  if (step.cast) console.log(`${(n / FPS).toFixed(2)}s cast "${step.cast}" →`, await p.evaluate((s) => window.__magician.cast(s).map((r) => r.output).join(" | "), step.cast));
  if (step.warm) for (let i = 0; i < step.warm * FPS; i++) await p.evaluate((dt) => window.__magician.film(dt, 0.3), 1 / FPS);
  if (step.hold) { const k = Math.round(step.hold * FPS); for (let i = 0; i < k; i++) await shoot(); console.log(`${(n / FPS).toFixed(2)}s`); }
}
console.log(`${n} frames`, errors.length ? `errors: ${errors.join(" | ")}` : "no errors");
await browser.close();
