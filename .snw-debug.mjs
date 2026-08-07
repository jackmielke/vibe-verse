import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox"] });
const page = await b.newPage({ viewport: { width: 900, height: 520 } });
await page.goto("http://127.0.0.1:5179/strange-new-worlds", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__snw, null, { timeout: 40000 });
await page.click("#snw-root .title .go");
await page.evaluate(() => window.__snw.setCourse("vulcan"));
await page.waitForFunction(() => window.__snw.state.phase === "idle", null, { timeout: 120000 });
await page.evaluate(() => window.__snw.beamDown());
await page.waitForFunction(() => window.__snw.state.mode === "surface" && window.__snw.state.phase === "idle", null, { timeout: 120000 });
await page.evaluate(() => { document.getElementById("snw-root").style.display = "none"; });
console.log("quality:", await page.evaluate(() => window.__snw.state && document.querySelector("canvas") && "ok"));
// Walk up to whoever is waiting and look them in the face — the shot that
// matters, because it is where every conversation in this game happens.
await page.evaluate(() => window.__snw.input.down.add("w"));
for (let i = 0; i < 40 && !(await page.evaluate(() => !!window.__snw.state.near)); i++) {
  await page.waitForTimeout(500);
}
console.log("   near:", await page.evaluate(() => window.__snw.state.near?.key ?? "none"));
// Keep closing until she fills the frame; grab a few so one of them is right.
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/portrait-${i}.png` });
}
await page.evaluate(() => window.__snw.input.down.delete("w"));
await page.waitForTimeout(600);
console.log("   portraits");
for (const [name, d] of [["frame",0],["ao",1],["bloom",2],["depth",3]]) {
  await page.evaluate((v) => { window.__snw.tune.debug = v; }, d);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("  ", name);
}
await b.close();
