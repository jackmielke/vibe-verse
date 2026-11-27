#!/usr/bin/env node
/**
 * city-golf — Vibe Links, the mini golf islet off Vibe Island's east rim.
 *
 *     node scripts/city-golf.mjs <outDir>
 *
 * Needs a dev server (`npx vite --port 5184 --strictPort --host 127.0.0.1`).
 * Photographs the islet and the bridge, walks to hole 1's tee, presses E,
 * putts once with the real keys (hold W, let go), then plays the rest of the
 * round through `__cityGolf.putt(angle, power)` + `settle()`, aiming each
 * stroke straight at the cup, and reads the scorecard. Frames come from
 * `__cityDebug.snapshot()`.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-golf";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(300000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 400)));
await page.goto("http://127.0.0.1:5184/city?spawn=hub", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityGolf && !!window.__cityDebug?.snapshot, null, { polling: 1000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.__cityDay(true));
const snap = async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); };
const G = (fn, ...a) => page.evaluate(([fn, a]) => window.__cityGolf[fn](...a), [fn, a]);
const ent = await G("entrance");
await page.evaluate(([x, y, z]) => window.__cityLandmarks.shot({ eye: [x - 30, y + 26, z + 34], look: [x + 26, y, z], fov: 55 }), ent);
await page.waitForTimeout(2500);
await snap("islet");
await page.evaluate(() => window.__cityLandmarks.shot(null));
const st0 = await G("state");
const [sx, sz] = st0.signs[0];
await page.evaluate(([x, y, z]) => window.__cityWarp(x, y + 0.4, z), [sx - 1, ent[1], sz]);
await page.waitForTimeout(3000);
console.log("tee pill:", !!(await page.$("text=Play Vibe Links")));
await page.keyboard.press("KeyE");
await page.waitForTimeout(2500);
let st = await G("state");
console.log("started:", st.playing, "hole", st.hole);
await snap("tee-1");
// One real stroke: hold W, let go.
await page.keyboard.down("KeyW");
await page.waitForTimeout(2500);
await page.keyboard.up("KeyW");
await page.waitForTimeout(2500);
st = await G("state");
console.log("after a real putt: strokes", st.strokes, "rolling", st.rolling, "ball", st.ball.map((v) => v.toFixed(1)).join(","));
await snap("rolling");
await G("settle");
await page.evaluate(() => window.__cityCrash.render(false));
for (let guard = 0; guard < 400; guard++) {
  st = await G("state");
  if (!st.playing) break;
  if (st.sunk > 0 || st.rolling) { await page.waitForTimeout(300); continue; }
  const a = Math.atan2(st.cup[0] - st.ball[0], st.cup[1] - st.ball[1]);
  const d = Math.hypot(st.cup[0] - st.ball[0], st.cup[1] - st.ball[1]);
  await G("putt", a, Math.min(1, 0.12 + d * 0.055));
  await G("settle");
  await page.waitForTimeout(600);
  const s2 = await G("state");
  if (s2.hole >= 4) console.log(JSON.stringify({ r: s2.rolling, sunk: s2.sunk, b: s2.ball })); console.log(`hole ${s2.hole} stroke ${s2.strokes} ball ${s2.ball.map((v) => v.toFixed(2)).join(",")} sunk ${s2.sunk > 0}`);
}
await page.evaluate(() => window.__cityCrash.render(true));
await page.waitForTimeout(2500);
st = await G("state");
console.log("card:", JSON.stringify(st.card), "done:", JSON.stringify(st.done));
await page.screenshot({ path: `${OUT}/card.png` });
await browser.close();
