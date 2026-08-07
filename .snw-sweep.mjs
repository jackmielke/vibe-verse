import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
await page.goto("http://127.0.0.1:5179/strange-new-worlds", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__snw, null, { timeout: 40000 });
await page.click("#snw-root .title .go");
const where = process.argv[3] ?? "space";
if (where === "surface") {
  await page.evaluate(() => window.__snw.setCourse("vulcan"));
  await page.waitForFunction(() => window.__snw.state.phase === "idle", null, { timeout: 120000 });
  await page.evaluate(() => window.__snw.beamDown());
  await page.waitForFunction(() => window.__snw.state.mode === "surface" && window.__snw.state.phase === "idle", null, { timeout: 120000 });
} else {
  await page.evaluate(() => window.__snw.setCourse("qonos"));
  await page.waitForFunction(() => window.__snw.state.phase === "idle", null, { timeout: 120000 });
}
await page.evaluate(() => { document.getElementById("snw-root").style.display = "none"; });
await page.waitForTimeout(1500);
/* Mean luminance, mean saturation and the 99th percentile, so the sweep is a
   number rather than a vibe. Read back from the *screenshot*, not from the
   WebGL canvas: drawImage of a canvas without preserveDrawingBuffer gives
   black, which is how the first version of this reported 0.000 for every
   exposure. */
const stat = async () => {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const o = document.createElement("canvas"); o.width = 160; o.height = 90;
    const g = o.getContext("2d"); g.drawImage(img, 0, 0, 160, 90);
    const d = g.getImageData(0, 0, 160, 90).data;
    let l = 0, sat = 0, n = 0; const ls = [];
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]/255, gg = d[i+1]/255, b = d[i+2]/255;
      const mx = Math.max(r,gg,b), mn = Math.min(r,gg,b);
      const lum = 0.2126*r + 0.7152*gg + 0.0722*b;
      l += lum; ls.push(lum); sat += mx > 0.02 ? (mx-mn)/mx : 0; n++;
    }
    ls.sort((a,b) => a-b);
    return { luma: +(l/n).toFixed(3), sat: +(sat/n).toFixed(3),
             p99: +ls[Math.floor(ls.length*0.99)].toFixed(3),
             blown: +(ls.filter(v => v > 0.97).length / n).toFixed(3) };
  }, png);
};
await page.evaluate(() => { window.__snw.tune.post = false; });
await page.waitForTimeout(900);
console.log("post OFF        ", JSON.stringify(await stat()));
await page.screenshot({ path: `${OUT}/${where}-postoff.png` });
await page.evaluate(() => { window.__snw.tune.post = true; });
for (const e of [1.0, 0.7, 0.5, 0.35, 0.25, 0.18]) {
  await page.evaluate(([w, v]) => { window.__snw.tune[w] = v; }, [where, e]);
  await page.waitForTimeout(900);
  console.log(`post exposure ${e}`.padEnd(16), JSON.stringify(await stat()));
  await page.screenshot({ path: `${OUT}/${where}-e${String(e).replace(".","_")}.png` });
}
await browser.close();
