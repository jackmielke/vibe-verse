#!/usr/bin/env node
/**
 * city-hydro: the hydroplanes and the buoy course at Vibe Marina, and the
 * phone helm.
 *
 *     node scripts/city-hydro.mjs <outDir>
 *
 * Desktop: photographs the course, boards a hydroplane from the T-head and
 * runs a lap (the boat is put just short of each gate with
 * `__cityLandmarks.boat([x, z, yaw])` and driven through it on W, because a
 * real lap is minutes of simulation in SwiftShader). Phone: a touch context,
 * taps the boarding pill, holds GO and drags the wheel, and reads back that
 * the boat moved and turned. Same harness as city-landmarks.mjs.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-hydro";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
const open = async (opts) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 400)));
  await page.goto("http://127.0.0.1:5184/city?spawn=hub", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__cityLandmarks && !!window.__cityDebug?.snapshot);
  await page.waitForTimeout(8000);
  await page.evaluate(() => window.__cityDay(true));
  return { ctx, page };
};
const helpers = (page) => ({
  snap: async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); },
  L: (fn, a) => page.evaluate(([fn, a]) => window.__cityLandmarks[fn](a), [fn, a]),
  sim: async (ms) => { await page.evaluate(() => window.__cityCrash.render(false)); await page.waitForTimeout(ms); await page.evaluate(() => window.__cityCrash.render(true)); },
});

// ---- Desktop ------------------------------------------------------------------
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 760 } });
  const { snap, L, sim } = helpers(page);
  const m = (await L("sites")).find((s) => s.key === "marina");
  await L("shot", { eye: [-255, 60, m.gates[0][2] - 150], look: [-350, 0, m.gates[0][2]], fov: 60 });
  await page.waitForTimeout(1500);
  await snap("course");
  await L("shot", { eye: [-252, 7, m.tHead[2] + 16], look: [-268, 0, m.tHead[2] + 3], fov: 55 });
  await page.waitForTimeout(1500);
  await snap("hydroplanes");
  await L("shot", null);

  await page.evaluate(([x, y, z]) => window.__cityWarp(x, y + 0.3, z), m.tHead);
  await page.waitForTimeout(2500);
  console.log("t-head near:", JSON.stringify(await L("near")));
  console.log("act:", await L("act"));
  await page.keyboard.down("KeyW");
  await sim(3000);
  console.log("hydro:", JSON.stringify((await L("state")).ui.ride), JSON.stringify(await L("boat")));
  await page.evaluate(() => window.__cityCam(10, 0.22, 0));
  await page.waitForTimeout(1200);
  await snap("hydro-run");
  // A lap: start just short of each gate, heading round the course.
  const G = m.gates;
  const C = { x: (G[0][0] + G[4][0]) / 2, z: G[0][2] };
  const RX = G[0][0] - C.x;
  const RZ = G[2][2] - C.z;
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i <= 7; i++) {
      const a = (i / 8) * Math.PI * 2 - 0.14;
      const x = C.x + Math.cos(a) * RX;
      const z = C.z + Math.sin(a) * RZ;
      const tx = -Math.sin(a) * RX;
      const tz = Math.cos(a) * RZ;
      await L("boat", [x, z, Math.atan2(tx, tz)]);
      await sim(1500);
    }
  }
  await L("boat", [C.x + Math.cos(-0.14) * RX, C.z + Math.sin(-0.14) * RZ, Math.atan2(Math.sin(0.14) * RX, Math.cos(0.14) * RZ)]);
  await sim(1500);
  console.log("race:", JSON.stringify(await L("boat")), JSON.stringify((await L("state")).ui.ride));
  await page.keyboard.up("KeyW");
  await ctx.close();
}

// ---- Phone ----------------------------------------------------------------------
{
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const { snap, L, sim } = helpers(page);
  console.log("coarse pointer:", await page.evaluate(() => matchMedia("(pointer: coarse)").matches));
  const m = (await L("sites")).find((s) => s.key === "marina");
  await page.evaluate(([x, y, z]) => window.__cityWarp(x, y + 0.3, z), m.finger);
  await page.waitForTimeout(3000);
  await page.locator('[data-testid="landmark-prompt"]').tap();
  await page.waitForTimeout(1500);
  console.log("helm shown:", await page.locator('[data-testid="landmark-helm"]').count());
  const before = await L("boat");
  const gas = page.locator('[data-testid="helm-gas"]');
  const wheel = page.locator('[data-testid="helm-wheel"]');
  const gb = await gas.boundingBox();
  const wb = await wheel.boundingBox();
  await gas.dispatchEvent("pointerdown", { pointerId: 7, clientX: gb.x + gb.width / 2, clientY: gb.y + gb.height / 2, isPrimary: true });
  await sim(3000);
  const mid = await L("boat");
  await wheel.dispatchEvent("pointerdown", { pointerId: 8, clientX: wb.x + wb.width * 0.95, clientY: wb.y + wb.height / 2 });
  await sim(2000);
  const after = await L("boat");
  await wheel.dispatchEvent("pointerup", { pointerId: 8 });
  console.log("phone boat before", JSON.stringify(before.boat), "gas", JSON.stringify(mid.boat), "wheel right", JSON.stringify(after.boat));
  await page.evaluate(() => window.__cityCam(9, 0.25, 0));
  await page.waitForTimeout(1500);
  await snap("phone-helm-frame");
  await page.screenshot({ path: `${OUT}/phone-helm-hud.png` });
  console.log("→ phone-helm-hud");
  await gas.dispatchEvent("pointerup", { pointerId: 7 });
  await ctx.close();
}
await browser.close();
