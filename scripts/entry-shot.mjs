// entry-shot: photograph the /city character picker over its live flyover.
//   node scripts/entry-shot.mjs <outDir> <classic|drone|glide|tour> [extra query, e.g. "&sky=day"] [w] [h]
// Dev server on 5184. WAIT=ms before the first frame (the character GLB is slow
// under SwiftShader), N frames GAP ms apart. Every WebGL canvas is swapped for
// a still of itself first, because page.screenshot() cannot composite them.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
const [OUT, LOOK, Q = "", W = "1440", H = "900"] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: +W, height: +H } });
const page = await ctx.newPage();
page.setDefaultTimeout(500000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:5184/city?entry=${LOOK}${Q}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityDebug?.snapshot, null, { polling: 1000 });
await page.waitForTimeout(+process.env.WAIT || 25000);
for (let k = 0; k < (+process.env.N || 1); k++) {
  if (k) await page.waitForTimeout(+process.env.GAP || 9000);
  // Swap every WebGL canvas for a still of itself, so a DOM screenshot composites them.
  await page.evaluate(async () => {
    document.querySelectorAll("img[data-still]").forEach((n) => n.remove());
    document.querySelectorAll("canvas").forEach((c) => (c.style.visibility = ""));
    const city = window.__cityDebug.snapshot();
    const grab = () => new Promise((r) => requestAnimationFrame(() => r([...document.querySelectorAll("canvas")].map((c) => { try { return c.toDataURL("image/png"); } catch { return null; } }))));
    const filled = (url) => new Promise((r) => { const im = new Image(); im.onload = () => { const c = document.createElement("canvas"); c.width = 64; c.height = 64; const g = c.getContext("2d"); g.drawImage(im, 0, 0, 64, 64); const d = g.getImageData(0, 0, 64, 64).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; r(n > 30); }; im.onerror = () => r(false); im.src = url; });
    let urls = await grab();
    for (let t = 0; t < 60; t++) {
      let ok = true;
      for (let i = 1; i < urls.length; i++) if (!urls[i] || !(await filled(urls[i]))) ok = false;
      if (ok) break;
      urls = await grab();
    }
    const all = [...document.querySelectorAll("canvas")];
    all.forEach((c, i) => {
      const url = i === 0 ? city : urls[i];
      if (!url) return;
      const img = document.createElement("img");
      img.dataset.still = "1";
      img.src = url;
      const r = c.getBoundingClientRect();
      Object.assign(img.style, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none" });
      c.parentElement.style.position ||= "relative";
      c.parentElement.insertBefore(img, c);
      c.style.visibility = "hidden";
    });
    await new Promise((r) => setTimeout(r, 400));
  });
  await page.screenshot({ path: `${OUT}/${LOOK}-${W}x${H}-${k}.png` });
  console.log("->", `${OUT}/${LOOK}-${W}x${H}-${k}.png`);
}
await browser.close();
