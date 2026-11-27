// Drive /summit in headless Chromium and write a JPEG per step.
//   node scripts/summit-shot.mjs <outdir> [base]
// Each step runs the simulation through window.__summit.settle, so it does
// not depend on the frame rate (SwiftShader draws about one frame a second).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "/tmp/summit";
const base = process.argv[3] ?? "http://localhost:5190";
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--headless=new"] });
const W = Number(process.env.W ?? 1280), Hh = Number(process.env.H ?? 720);
const page = await browser.newPage({ viewport: { width: W, height: Hh } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/summit?go`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__summit, null, { timeout: 120000 });
await page.waitForTimeout(4000);
const shot = async (name) => {
  const data = await page.evaluate(() => window.__summit.snapshot());
  fs.writeFileSync(path.join(out, name + ".jpg"), Buffer.from(data.split(",")[1], "base64"));
  const st = await page.evaluate(() => window.__summit.state());
  console.log(name, JSON.stringify(st, (k, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v)));
};
const settle = (s, keys = []) => page.evaluate(([s, k]) => window.__summit.settle(s, k), [s, keys]);
const plan = (process.env.PLAN ?? "deck,ski,wingsuit,paraglider,skyway,village").split(",");
for (const step of plan) {
  if (step === "deck") { await settle(0.5); await shot("01-deck"); }
  if (step === "ski") {
    await page.evaluate(() => window.__summit.choose("ski"));
    await settle(6); await shot("02-ski-start");
    await settle(20, ["w"]); await shot("03-ski-run");
    await settle(40, ["w"]); await shot("04-ski-low");
  }
  if (step === "wingsuit") {
    await page.evaluate(() => window.__summit.travel("summit"));
    await page.evaluate(() => window.__summit.choose("wingsuit"));
    await settle(3); await shot("05-wingsuit-launch");
    await settle(15); await shot("06-wingsuit-glide");
    await settle(30); await shot("06b-wingsuit-low");
    await settle(40); await shot("06c-wingsuit-end");
  }
  if (step === "paraglider") {
    await page.evaluate(() => window.__summit.travel("summit"));
    await page.evaluate(() => window.__summit.choose("paraglider"));
    await settle(10); await shot("07-paraglider");
  }
  if (step === "skyway") {
    await page.evaluate(() => window.__summit.choose("skyway"));
    await settle(1.5); await shot("08-beam");
    await settle(3); await shot("09-skyway-start");
    await settle(12, ["w"]); await shot("10-skyway-drive");
  }
  if (step === "art") {
    await page.evaluate(() => window.__summit.travel("summit"));
    await page.evaluate(() => window.__summit.choose("paraglider"));
    await settle(14); await shot("art-paraglider");
    await page.evaluate(() => window.__summit.choose("skyway"));
    await settle(5);
    await settle(30, ["w"]); await shot("art-skyway-a");
    await settle(25, ["w"]); await shot("art-skyway-b");
  }
  if (step === "village") {
    await page.evaluate(() => window.__summit.travel("village"));
    await settle(1); await shot("11-village");
  }
}
console.log("errors:", errors.slice(0, 8));
await browser.close();
