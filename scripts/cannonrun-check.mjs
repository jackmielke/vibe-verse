#!/usr/bin/env node
/**
 * cannonrun-check: boot /cannon-run in a real browser, play it through its
 * debug hook, and write frames.
 *
 *   node scripts/cannonrun-check.mjs <outdir>
 *
 * Needs a dev server on 5178 (`npx vite --port 5178`). There is no GPU in the
 * sandbox, so the game is stepped with `__chase.run(n)` rather than by waiting.
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
await page.goto(`http://127.0.0.1:${process.env.PORT ?? 5178}/cannon-run?go${process.env.HUD ? "" : "&shot"}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__chase, null, { timeout: 120000 });
await page.waitForTimeout(3000);

const st = () => page.evaluate(() => window.__chase.state());
const c = (fn, ...args) => page.evaluate(([f, a]) => window.__chase[f](...a), [fn, args]);
const shot = async (name) => {
  const url = await page.evaluate(() => window.__chase.snapshot());
  writeFileSync(`${out}/${name}.jpg`, Buffer.from(url.split(",")[1], "base64"));
};

console.log("boot", JSON.stringify(await st()));
await c("run", 40);
await shot("01-intro");
await c("run", 160);
console.log("after intro", JSON.stringify(await st()));
await shot("02-chase");

// Fire at him (auto aim) a few times.
let s0 = await st();
for (let k = 0; k < 6; k++) { await c("aim"); await c("fire"); await c("run", 6); await shot(`03-fire-${k}`).catch(() => {}); await c("run", 50); }
let s1 = await st();
console.log("fired: hits", s1.hits, "foeHp", s1.foeHp, "/", s1.foeMax, "gap", s1.gap, "hull", s1.hull);

// Swerve.
await c("key", "d", true); await c("run", 60); await c("key", "d", false);
console.log("swerved lat", (await st()).lat.toFixed(2));
await c("aim", 0.3, 0.6);
await c("run", 2);
await shot("04-aim-left");

// Level 3 monster pickup, close.
await c("level", 3, 22);
await c("run", 60);
await shot("05-monster");
await c("level", 4, 30);
await c("run", 200);
await shot("06-rig");
const s2 = await st();
console.log("rig", JSON.stringify(s2));
// Let it play out to game over.
for (let k = 0; k < 40 && (await st()).phase !== "over"; k++) await c("run", 120);
console.log("end", JSON.stringify(await st()));
await shot("07-end");

console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "no console errors");
await browser.close();
process.exit(problems.length ? 1 : 0);
