#!/usr/bin/env node
/**
 * hoops-shot: boot /hoops, look at the title's attract mode, start a game
 * against the computer, and write a JPEG of each moment worth seeing (the
 * walk-out, the tip, play, a dunk, its replay, the final) through
 * `window.__hoops.snapshot()`, because page.screenshot() cannot see this
 * WebGL canvas under SwiftShader.
 *
 *     node scripts/hoops-shot.mjs <outDir> [port] [--phone]
 */
import { chromium, devices } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const OUT = args[0] ?? "/tmp/hoops-shot";
const BASE = `http://127.0.0.1:${args[1] ?? "5185"}`;
const PHONE = process.argv.includes("--phone");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
const ctx = await browser.newContext(PHONE ? { ...devices["iPhone 13"] } : { viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => (errors.push(String(e)), console.log("pageerror", String(e).slice(0, 400))));
page.on("console", (m) => {
  if (m.type() === "error") console.log("console", m.text().slice(0, 300));
});
const H = (fn, ...a) => page.evaluate(([fn, a]) => window.__hoops[fn](...a), [fn, a]);
const snap = async (name) => {
  const url = await H("snapshot");
  writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(url.split(",")[1], "base64"));
  console.log("→", name);
};
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(`${BASE}/hoops${process.argv.includes("--shot") ? "?shot" : ""}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__hoops, null, { polling: 250, timeout: 60000 });
await page.waitForFunction(() => window.__hoops.state().ready, null, { polling: 500, timeout: 120000 });
await wait(4000);
await snap("0-title");

await H("start", { mode: "cpu", club: process.env.CLUB ?? "volts", rival: process.env.RIVAL ?? "junkyard", difficulty: "normal" });
await page.waitForFunction(() => window.__hoops.state().ready && window.__hoops.state().screen === "playing", null, { polling: 500, timeout: 120000 });
await H("auto", true);
await H("frame", 1 / 30);
await snap("1-intro");
await H("until", "tip", 10, 0.3);
await H("frame", 1 / 30);
await snap("2-tip");
await H("settle", 6);
await H("until", "pass", 30, 0.4);
await H("frame", 1 / 30);
await snap("3-play");
const hit = await H("until", "dunk", 160, 0.25);
console.log("dunk?", hit);
await H("frame", 1 / 30);
await snap("4-dunk");
await H("until", "score", 3, 0.1);
await H("frame", 1 / 30);
await snap("5-score");
// The replay starts a beat after the shout, and plays at half speed.
for (let k = 0; k < 75; k++) await H("frame", 1 / 30);
await snap("6-replay");
await H("until", "final", 400, 1.5);
await H("frame", 1 / 30);
await snap("7-final");
console.log(JSON.stringify(await page.evaluate(() => { const s = window.__hoops.state(); return { screen: s.screen, phase: s.phase, score: s.score }; })));
console.log("errors", errors.length);
await browser.close();
