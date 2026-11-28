import { chromium } from "playwright";
/**
 * monolith-shot: photograph the Monolith and the Beyond.
 *
 *     node scripts/monolith-shot.mjs [outDir] [which...]
 *
 * which: beyond | thalassa | summit | magician | island (default: all).
 * Needs a dev server on 5173 (PORT=… to change). Every host is opened with
 * `?monolith`, which stands it there whatever today's date says. Frames come
 * from each world's own snapshot hook: page.screenshot() is blank under
 * SwiftShader.
 */
import { writeFileSync, mkdirSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/monolith-shot";
const WHICH = process.argv.slice(3);
const PORT = process.env.PORT ?? "5173";
const want = (k) => WHICH.length === 0 || WHICH.includes(k);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
// STAR=1: arrive already starborn, to see the skin in a host world.
if (process.env.STAR) await ctx.addInitScript(() => localStorage.setItem("monolith.starborn", JSON.stringify({ earned: true, on: true, since: "2026-11-28", touches: 1 })));
let errors = 0;
const open = async (path) => {
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => { errors++; console.log("pageerror", String(e).slice(0, 400)); });
  page.on("console", (m) => { if (m.type() === "error" && /shader|WebGL|THREE/i.test(m.text())) { errors++; console.log("console", m.text().slice(0, 300)); } });
  await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: "domcontentloaded" });
  return page;
};
const save = async (page, name, expr) => {
  const url = await page.evaluate(expr);
  writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(url.split(",")[1], "base64"));
  console.log("→", name);
};

if (want("beyond")) {
  const page = await open("/beyond?from=/thalassa");
  await page.waitForFunction(() => window.__beyond?.state().rig, null, { timeout: 120000 }).catch(() => undefined);
  await page.evaluate(() => window.__beyond.settle(1.5));
  await save(page, "beyond-01-arrive", () => window.__beyond.snapshot());
  await page.evaluate(() => { window.__beyond.teleport(0, 22); window.__beyond.settle(1); });
  await save(page, "beyond-02-near", () => window.__beyond.snapshot());
  // Walk into the light.
  await page.evaluate(() => window.__beyond.settle(3.5, ["KeyW"]));
  console.log("state", JSON.stringify(await page.evaluate(() => window.__beyond.state())));
  await page.evaluate(() => window.__beyond.settle(2.5));
  console.log("state", JSON.stringify(await page.evaluate(() => window.__beyond.state())));
  await page.evaluate(() => { window.__beyond.look(0.9, 0.15); window.__beyond.settle(1.5); });
  await save(page, "beyond-03-starborn", () => window.__beyond.snapshot());
  console.log("stored", await page.evaluate(() => localStorage.getItem("monolith.starborn")));
  await page.close();
}

if (want("thalassa")) {
  const page = await open("/thalassa?go&monolith");
  await page.waitForFunction(() => !!window.__thalassa && !!window.__monolith);
  await page.waitForTimeout(4000);
  const pl = await page.evaluate(() => window.__monolith.placement());
  console.log("thalassa", JSON.stringify(pl));
  await page.evaluate((p) => { window.__thalassa.pose(p.x - 9, p.y + 2.2, p.z - 6, p.x, p.y + 3, p.z, 60); }, pl);
  await page.evaluate(() => window.__thalassa.settle(0.5));
  await save(page, "thalassa-monolith", () => window.__thalassa.snapshot());
  await page.evaluate(() => window.__thalassa.free());
  await page.close();
}

if (want("summit")) {
  const page = await open("/summit?go&monolith");
  await page.waitForFunction(() => !!window.__summit?.rigLoaded() && !!window.__monolith, null, { timeout: 180000 });
  const pl = await page.evaluate(() => window.__monolith.placement());
  console.log("summit", JSON.stringify(pl));
  await page.evaluate((p) => { window.__summit.teleport(p.x - 2, p.z - 9); window.__summit.settle(1.5); }, pl);
  await page.waitForTimeout(3000);
  await save(page, "summit-monolith", () => window.__summit.snapshot());
  await page.close();
}

if (want("magician")) {
  const page = await open("/magician?monolith&net=off");
  await page.getByRole("button", { name: /enter (the valley|hoshimura)/i }).click({ timeout: 60000 });
  await page.waitForFunction(() => !!window.__magician && !!window.__monolith, null, { timeout: 180000 });
  await page.waitForTimeout(6000);
  const pl = await page.evaluate(() => window.__monolith.placement());
  console.log("magician", JSON.stringify(pl));
  // Stand south of it, facing north (-z), so it is in front of the camera.
  await page.evaluate((p) => window.__magician.teleport(p.x + 1, p.z + 8, 0), pl);
  await page.evaluate(() => window.__magician.settle?.(2));
  await page.waitForTimeout(3000);
  await save(page, "magician-monolith", () => window.__magician.snapshot());
  await page.close();
}

if (want("island")) {
  const page = await open("/city?spawn=island&monolith");
  await page.waitForFunction(() => !!window.__cityDebug?.snapshot && !!window.__monolith, null, { timeout: 240000 });
  await page.waitForTimeout(12000);
  // The character GLB takes a while under SwiftShader.
  await page.waitForFunction(() => window.__monolith.debug().avatar, null, { timeout: 240000 });
  const pl = await page.evaluate(() => window.__monolith.placement());
  console.log("island", JSON.stringify(pl));
  await page.evaluate(() => window.__cityDay?.(true));
  await page.evaluate((p) => window.__cityGoto?.(p.x - 330 - 3, p.z + 30 + 7), pl);
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.__cityCam?.(12, 0.3, -0.4));
  await page.waitForTimeout(8000);
  console.log("distance", await page.evaluate(() => window.__monolith.distance()), JSON.stringify(await page.evaluate(() => window.__monolith.debug())));
  await save(page, "island-monolith", () => window.__cityDebug.snapshot());
  await page.evaluate(() => window.__cityCam?.(5, 0.2, -0.4));
  await page.waitForTimeout(8000);
  await save(page, "island-close", () => window.__cityDebug.snapshot());
  await page.close();
}

await browser.close();
console.log(errors ? `${errors} errors` : "no errors");
process.exit(errors ? 1 : 0);
