// Walk and drive up the marina ramp from the coast road; prints where you end up (y 1.5 is the deck).
// Dev server on 5184.
import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.setDefaultTimeout(300000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 400)));
await page.goto("http://127.0.0.1:5184/city?spawn=hub", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityPos && !!window.__cityCrash, null, { polling: 1000 });
await page.waitForTimeout(6000);
const render = (on) => page.evaluate((v) => window.__cityCrash.render(v), on);
const pos = () => page.evaluate(() => window.__cityPos());
// Walk: find yaw that makes W go -x.
for (const yaw of [Math.PI/2, -Math.PI/2]) {
  await page.evaluate(() => window.__cityWarp(-166, 0.3, 60));
  await page.evaluate((y) => window.__cityCam(8, 0.3, y), yaw);
  await page.waitForTimeout(1500);
  await render(false);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(6000);
  await page.keyboard.up("KeyW");
  await render(true);
  console.log("walk yaw", yaw.toFixed(2), JSON.stringify(await pos()));
}
// Drive: kart 0, yaw pointing -x.
for (const yaw of [-Math.PI/2, Math.PI/2]) {
  await page.evaluate((y) => window.__cityDrive(-160, 0, 60, y, 6, 0.6), yaw);
  await render(false);
  await page.waitForTimeout(6000);
  await render(true);
  console.log("drive yaw", yaw.toFixed(2), JSON.stringify(await pos()));
}
await browser.close();
