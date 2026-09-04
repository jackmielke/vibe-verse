// Open /mars?shot on the running dev server and grab a frame at noon, at
// night and inside a dust storm, so the sky can be looked at before the card
// is accepted. Usage: SF_PORT=5182 node mars-probe.mjs <outdir>
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const PORT = Number(process.env.SF_PORT ?? 5182);
const out = process.argv[2] ?? ".";
const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message).split("\n")[0]));
await page.goto(`http://127.0.0.1:${PORT}/mars?shot`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__mars, null, { timeout: 120000 });
const frames = [
  ["noon", { part: "morning", partT: 0.95 }],
  ["night", { part: "night", partT: 0.5 }],
  ["storm", { part: "afternoon", partT: 0.3, storm: true }],
  ["warning", { part: "afternoon", partT: 0.3, storm: false, warning: true }],
];
for (const [name, opts] of frames) {
  await page.evaluate((o) => window.__mars.set(o), opts);
  await page.waitForTimeout(12000);
  await page.screenshot({ path: `${out}/mars-${name}.png` });
  console.log("wrote", name);
}
console.log("state", JSON.stringify(await page.evaluate(() => { const s = window.__mars.state(); return { day: s.day, part: s.part, storm: s.storm }; })));
if (errors.length) console.log("page errors:", errors);
await browser.close();
