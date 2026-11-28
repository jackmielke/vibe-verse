#!/usr/bin/env node
// entry-film: film the /city picker over its flyover, UI included.
//   node scripts/entry-film.mjs <outDir> <look> [query] [w] [h]
// Frozen clock (film/clock.js) so SwiftShader still gives smooth frames. Each
// frame is the canvases (city + character) plus a transparent DOM screenshot
// of the picker laid on top. FRAMES, DT (seconds of flyover per frame).
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const [OUT, LOOK, Q = "", W = "1280", H = "800"] = process.argv.slice(2);
const FRAMES = +process.env.FRAMES || 120, DT = +process.env.DT || 1 / 12;
mkdirSync(`${OUT}/${LOOK}`, { recursive: true });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: +W, height: +H } });
await ctx.addInitScript(readFileSync(new URL("./film/clock.js", import.meta.url), "utf8"));
const page = await ctx.newPage();
page.setDefaultTimeout(600000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:5184/city?entry=${LOOK}${Q}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityDebug?.snapshot, null, { polling: 1000 });
await page.waitForTimeout(+process.env.WAIT || 120000);
await page.addStyleTag({ content: "html,body,#root,.bg-black{background:transparent!important}" });
await page.evaluate(() => window.__film.freeze());
for (let i = 0; i < 6; i++) await page.evaluate((d) => window.__film.step(d), DT);
for (let f = 0; f < FRAMES; f++) {
  const g = await page.evaluate(([d, w]) => window.__film.step(d, w, 0.9), [DT, +W]);
  writeFileSync(`${OUT}/${LOOK}/c${String(f).padStart(4, "0")}.jpg`, Buffer.from(g.url.split(",")[1], "base64"));
  await page.evaluate(() => document.querySelectorAll("canvas").forEach((c) => (c.style.visibility = "hidden")));
  await page.screenshot({ path: `${OUT}/${LOOK}/u${String(f).padStart(4, "0")}.png`, omitBackground: true });
  await page.evaluate(() => document.querySelectorAll("canvas").forEach((c) => (c.style.visibility = "")));
  if (f % 10 === 0) console.log(LOOK, f);
}
await browser.close();
