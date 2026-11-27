import { chromium } from "playwright";
/**
 * wizard-shot: draw stored Wizard rows on /city offline and photograph them.
 *
 *     node scripts/wizard-shot.mjs <rows.json> [outDir]
 *
 * rows.json is `[{ id, ops }]` as `wizard_edits` stores it (absolute
 * coordinates). Needs a dev server on 5184. Frames come from
 * `__cityDebug.snapshot()`, because page.screenshot() is blank under SwiftShader.
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
const OUT = process.argv[3] ?? "/tmp/wizard-shot";
mkdirSync(OUT, { recursive: true });
const rows = JSON.parse(readFileSync(process.argv[2], "utf8"));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(300000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 400)));
await page.goto("http://127.0.0.1:5184/city?spawn=hub&wizard=local", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__wizard && !!window.__cityDebug?.snapshot);
await page.waitForTimeout(10000);
await page.evaluate(() => window.__cityDay?.(true));
const snap = async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); };
console.log("count", await page.evaluate((r) => window.__wizard.rows(r), rows));
await page.evaluate(() => window.__cityGoto(-15, -2));
await page.waitForTimeout(3000);
await page.evaluate(() => window.__cityCam(9, 0.3, 0));
await page.waitForTimeout(6000);
await snap("04-home-and-duck");
await page.evaluate(() => window.__cityGoto(0, -20));
await page.waitForTimeout(2000);
await page.evaluate(() => window.__cityCam(14, 0.45, 0));
await page.waitForTimeout(6000);
await snap("05-village");
await browser.close();
