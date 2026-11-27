#!/usr/bin/env node
/**
 * city-quests: play Vibe City's side quests the way a player does and
 * photograph each one.
 *
 *     node scripts/city-quests.mjs <outDir> [granny|fishing|race|sprint ...]
 *
 * Dev server on 5184 (`npx vite --port 5184`). Frames come from
 * `__cityDebug.snapshot()` because page.screenshot() does not composite the
 * canvas under SwiftShader. Hooks: `window.__cityQuests` (ui, log, act,
 * choose, hold, dev, hat), `__cityWarp`, `__cityLandmarks.shot`.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-quests";
const ONLY = process.argv.slice(3);
const want = (k) => !ONLY.length || ONLY.includes(k);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(300000);
const errors = [];
page.on("pageerror", (e) => {
  errors.push(String(e));
  console.log("pageerror", String(e).slice(0, 400));
});
await page.addInitScript(() => { try { if (!localStorage.getItem("city.vibecoinBalance")) localStorage.setItem("city.vibecoinBalance", "500"); } catch {} });
await page.goto("http://127.0.0.1:5184/city?spawn=hub", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityQuests && !!window.__cityDebug?.snapshot, null, { polling: 1000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.__cityDay?.(true));
const snap = async (name) => {
  const url = await page.evaluate(() => window.__cityDebug.snapshot());
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64"));
  console.log("→", name);
};
const Q = (fn, a) => page.evaluate(([fn, a]) => window.__cityQuests[fn](a), [fn, a]);
const warp = (x, y, z) => page.evaluate(([x, y, z]) => window.__cityWarp(x, y, z), [x, y, z]);
const shot = (eye, look, fov = 50) => page.evaluate((s) => window.__cityLandmarks.shot(s), { eye, look, fov });
const unshot = () => page.evaluate(() => window.__cityLandmarks.shot(null));
const render = (on) => page.evaluate((v) => window.__cityCrash.render(v), on);
/** Run the simulation without drawing, which is ten times faster here. */
const settle = async (ms) => { await render(false); await page.waitForTimeout(ms); await render(true); };
const ui = async () => JSON.stringify(await Q("ui"));

if (want("granny")) {
  await warp(8.6, 0.2, 4.2);
  await settle(3000);
  console.log("near granny:", await ui());
  await shot([6.5, 2.0, 3.5], [10.5, 1, 5], 45);
  await settle(2500);
  await snap("granny");
  await unshot();
  console.log("act:", await Q("act"));
  await settle(500);
  console.log("dialog:", await ui());
  console.log("accept:", await Q("act"));
  await settle(800);
  const dev = await Q("dev");
  console.log("state:", JSON.stringify(dev.granny));
  const [px, , pz] = dev.granny.petPos;
  await warp(px + 1.6, 0.2, pz + 1.6);
  await settle(3000);
  await shot([px + 3, 1.6, pz + 3], [px, 0.3, pz], 40);
  await settle(2500);
  await snap("pet-found");
  await unshot();
  // SwiftShader's long frames can read a warp's settling as a sprint; chase it once more.
  for (let i = 0; i < 3 && !(await Q("ui")).prompt; i++) {
    const [qx, , qz] = (await Q("dev")).granny.petPos;
    await warp(qx + 1.2, 0.2, qz + 1.2);
    await settle(2500);
  }
  console.log("at pet:", await ui());
  console.log("scoop:", await Q("act"));
  await settle(800);
  console.log("carry:", JSON.stringify((await Q("dev")).granny.state), await ui());
  await warp(8.8, 0.2, 4.6);
  await settle(4000);
  console.log("home:", await ui());
  console.log("log:", JSON.stringify(await Q("log")));
  await page.evaluate(() => window.__cityCam(4.5, 0.15, 2.2));
  await settle(2500);
  await snap("hat-reward");
  await Q("act");
}

if (want("fishing")) {
  await warp(-222, 1.8, 60.9);
  await settle(3000);
  console.log("pier:", await ui());
  await Q("act");
  await settle(1500);
  console.log("cast:", await ui());
  const f = await page.evaluate(() => window.__cityQuests.dev().fishing("force:golden"));
  for (let i = 0; i < 5 && (await Q("ui")).fishing?.phase !== "wait"; i++) await settle(800);
  console.log("forced:", JSON.stringify(f.phase));
  await settle(2500);
  await page.evaluate(() => window.__cityQuests.dev().fishing("bite"));
  await settle(1200);
  console.log("bite?:", await ui());
  await Q("act");
  await settle(800);
  console.log("reel:", await ui(), JSON.stringify((await Q("dev")).last));
  await page.evaluate(() => window.__cityCam(7, 0.3, Math.PI * 0.8));
  await settle(2500);
  await snap("fishing-reel");
  await page.evaluate(() => window.__cityQuests.dev().fishing("win"));
  await settle(1500);
  console.log("result:", await ui());
  await snap("fishing-golden");
  await unshot();
}

if (want("race")) {
  const drive = (x, z, yaw, v = 0) => page.evaluate(([x, z, yaw, v]) => window.__cityDrive(x, 0.3, z, yaw, v, 0), [x, z, yaw, v]);
  const R = (op) => page.evaluate((op) => window.__cityQuests.dev().racing(op), op);
  await drive(-103, 24, Math.PI);
  await settle(3000);
  await page.evaluate(() => window.__cityCam(10, 0.3, 0.6));
  await settle(1500);
  await snap("race-vinnie");
  console.log("near vinnie:", await ui());
  await Q("act");
  await settle(600);
  console.log("dialog:", JSON.stringify((await Q("ui")).dialog?.options));
  await Q("choose", "bet:25");
  await settle(800);
  await drive(-100, 16, Math.PI);
  await settle(5000);
  console.log("grid:", JSON.stringify((await Q("ui")).race), JSON.stringify(await R()).slice(0, 300));
  await page.evaluate(() => window.__cityCam(9, 0.25, 0.2));
  await settle(1500);
  await snap("race-grid");
  await R("slow");
  // Drive the course gate by gate, the way a player's car would pass them.
  const st = await R();
  const course = [[-100, -45], [-100, -100], [-40, -100], [30, -100], [100, -100], [100, -30], [100, 40], [100, 100], [30, 100], [-40, 100], [-100, 100], [-100, 55], [-100, 10]];
  for (let lap = 0; lap < 2; lap++) {
    for (const [i, [x, z]] of course.entries()) {
      await drive(x, z, 0, 5);
      await settle(1200);
      if (lap === 0 && i === 9) {
        await page.evaluate(() => window.__cityCam(9, 0.3, 2.4));
        await settle(1200);
        await snap("race-eiffel");
        console.log("mid:", JSON.stringify((await Q("ui")).race));
      }
    }
  }
  console.log("finish:", JSON.stringify(await Q("ui")).slice(0, 600));
  console.log("log:", JSON.stringify((await Q("log")).quests[2]));
}

if (want("sprint")) {
  const S = (op) => page.evaluate((op) => window.__cityQuests.dev().sprint(op), op);
  // Gail at the Empire State's south doors: (-31.5, -65.8).
  await warp(-31.5, 0.2, -63.5);
  await settle(3000);
  console.log("near gail:", await ui());
  await Q("act");
  await settle(500);
  console.log("dialog:", JSON.stringify((await Q("ui")).dialog?.options));
  await Q("choose", "sprint");
  // Face the podium's south face (z = -68) and hold W.
  await warp(-46, 0.2, -66.8);
  await page.evaluate(() => window.__cityCam(9, 0.2, 0));
  await settle(1500);
  await page.keyboard.down("KeyW");
  await settle(2500);
  console.log("cling:", JSON.stringify(await S()).slice(0, 300));
  await settle(3000);
  await page.evaluate(() => window.__cityCam(9, 0.15, 0));
  await settle(1500);
  await snap("sprint-climb");
  await S("y:11.97");
  await settle(1500);
  console.log("ledge:", JSON.stringify((await Q("ui")).sprint), JSON.stringify((await Q("dev")).last));
  // Up on the crown, against the mast's south face (z = cz + 2.2 = -77.8).
  await page.keyboard.up("KeyW");
  await warp(-40, 133.3, -77.0);
  await settle(1500);
  await page.keyboard.down("KeyW");
  await settle(2500);
  console.log("crown:", JSON.stringify(await S()).slice(0, 200));
  await S("y:150");
  await settle(1200);
  await page.evaluate(() => window.__cityCam(10, 0.3, 0.3));
  await settle(1500);
  await snap("sprint-mast");
  await S("y:152.97");
  await settle(2500);
  await page.keyboard.up("KeyW");
  console.log("top:", JSON.stringify((await Q("ui")).sprint), JSON.stringify((await Q("dev")).last));
  console.log("log:", JSON.stringify((await Q("log")).quests[3]));
}

console.log("errors:", errors.length);
await browser.close();
