#!/usr/bin/env node
/**
 * venus-shot — photograph Venus Rising at each step of the way there, and a
 * built city at any hour.
 *
 * `page.screenshot()` does not composite the WebGL canvas under SwiftShader
 * (it comes back white), so every frame is read through
 * `window.__venus.snapshot()`, which renders once and returns a JPEG.
 * `settle(s)` advances the whole engine in fixed slices without drawing,
 * because SwiftShader draws about one frame a second.
 *
 *   node scripts/venus-shot.mjs                   # everything
 *   node scripts/venus-shot.mjs title moon city   # some
 *   VENUS_Q=high node scripts/venus-shot.mjs city  # with bloom and shadows
 *   VENUS_W=390 VENUS_H=844 node scripts/venus-shot.mjs hud   # a phone
 *
 * Shots land in .shots/venus-<name>.jpg. Exits non-zero on a page error or
 * a three.js shader compile failure, because a shader that does not compile
 * is a silently missing mesh.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const Q = process.env.VENUS_Q ?? "low";
const W = Number(process.env.VENUS_W ?? 1280);
const H = Number(process.env.VENUS_H ?? 720);
const OUT = process.env.VENUS_DIR ?? ".shots";

async function up(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server = (await up(BASE, 1200)) ? null : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, BROWSER: "none" } });
if (server && !(await up(BASE, 180000))) { console.error("dev server never came up"); process.exit(1); }

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage"],
});
mkdirSync(OUT, { recursive: true });

let bad = 0;
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" || /THREE\.WebGLProgram|Shader Error|ERROR:/.test(t)) {
    console.log("[console]", t.slice(0, 600));
    if (/WebGLProgram|Shader|GLSL|ERROR: 0:/.test(t)) bad++;
  }
});
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); bad++; });

async function shot(name) {
  const url = await page.evaluate(() => window.__venus.snapshot(0.88));
  writeFileSync(`${OUT}/venus-${name}.jpg`, Buffer.from(url.split(",")[1], "base64"));
  console.log(`wrote ${OUT}/venus-${name}.jpg`);
}
/** The DOM and the canvas together: the canvas via snapshot, the HUD via a screenshot of the page with the canvas swapped for the frame. */
async function hudShot(name) {
  await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const url = window.__venus.snapshot(0.9);
    let img = document.getElementById("__venus_frame");
    if (!img) {
      img = document.createElement("img");
      img.id = "__venus_frame";
      img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none";
      c.parentElement.appendChild(img);
    }
    img.src = url;
    c.style.visibility = "hidden";
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/venus-${name}.jpg`, type: "jpeg", quality: 88 });
  await page.evaluate(() => {
    document.getElementById("__venus_frame")?.remove();
    document.querySelector("canvas").style.visibility = "";
  });
  console.log(`wrote ${OUT}/venus-${name}.jpg (with HUD)`);
}
const ev = (fn, arg) => page.evaluate(fn, arg);

async function boot(extra = "") {
  await page.goto(`${BASE}/venus?quality=${Q}${extra}`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => !!window.__venus, null, { timeout: 180000 });
  await page.waitForTimeout(1500);
}

/** A city worth looking at: resources and a sensible plan, built by the sim itself. */
async function buildCity(n = 40) {
  await ev((n) => {
    const v = window.__venus;
    const sim = v.sim;
    const plan = ["dome", "bladder", "solar", "harvester", "moxie", "greenhouse", "dome", "bladder", "jazz", "still", "solar", "dome", "skyport", "bladder", "greenhouse", "dome", "biolab", "bladder", "solar", "ballroom", "dome", "bladder", "harvester", "greenhouse", "dome", "moxie", "bladder", "solar", "nanofab", "dome", "bladder", "jazz", "greenhouse", "dome", "bladder", "solar", "dome", "bladder", "still", "dome"];
    sim.s.pop = 400;
    for (let i = 0; i < n; i++) {
      sim.s.res = { carbon: 900, water: 10, air: 400, power: 200, science: 200, culture: 100 };
      const slot = sim.freeSlots()[0];
      if (slot) sim.build(plan[i % plan.length], slot.q, slot.r);
    }
    for (const t of sim.s.tiles.slice(0, 12)) { sim.s.res.carbon = 900; sim.s.res.air = 400; sim.s.res.science = 200; sim.upgrade(t.q, t.r); }
    sim.s.alt = sim.d.eqAlt;
    sim.s.pop = Math.min(sim.d.housing, sim.d.food);
  }, n);
}

const PLAN = {
  async title() {
    await boot();
    await ev(() => window.__venus.settle(2));
    await hudShot("title");
  },
  async moon() {
    await boot();
    await ev(() => { window.__venus.go("moon"); window.__venus.settle(4); });
    await shot("moon-yard");
    await ev(() => { window.__venus.api.fire(); window.__venus.settle(2.6); });
    await shot("moon-rail");
    await ev(() => window.__venus.settle(2.6));
    await shot("moon-muzzle");
  },
  async transfer() {
    await boot();
    await ev(() => { window.__venus.go("transfer"); window.__venus.settle(3); });
    await shot("transfer-a");
    await ev(() => window.__venus.settle(7));
    await shot("transfer-b");
    await ev(() => window.__venus.settle(3.5));
    await shot("transfer-c");
  },
  async entry() {
    await boot();
    await ev(() => { window.__venus.go("entry"); window.__venus.settle(4); });
    await shot("entry-a");
    await ev(() => window.__venus.settle(6));
    await hudShot("entry-b");
  },
  async city() {
    await boot("&fresh");
    await ev(() => window.__venus.go("play"));
    await buildCity(40);
    for (const [name, day] of [["noon", 0.2], ["golden", 0.43], ["sunset", 0.485], ["night", 0.7]]) {
      await ev((d) => { const v = window.__venus; v.day(d); v.view(2.0, 0.22, 520); v.settle(2); }, day);
      await shot(`city-${name}`);
    }
    await ev(() => { const v = window.__venus; v.day(0.44); v.view(2.2, 0.12, 260, 0, 40, 0); v.settle(1); });
    await shot("city-low");
  },
  async walk() {
    await boot("&fresh");
    await ev(() => window.__venus.go("play"));
    await buildCity(40);
    await ev(() => { const v = window.__venus; v.day(0.44); v.settle(1); v.api.setWalk(true); v.settle(2); });
    await hudShot("walk-a");
    await ev(() => { const v = window.__venus; v.walkTo(0.4, 30, 3.0); v.settle(0.5); });
    await shot("walk-b");
    await ev(() => { const v = window.__venus; v.day(0.2); v.api.setWalk(false); v.view(1.2, 0.18, 120, 40, 10, 20); v.settle(1.5); });
    await shot("people");
  },
  async debug() {
    await boot("&fresh");
    await ev(() => window.__venus.go("play"));
    await buildCity(20);
    await ev(() => { const v = window.__venus; v.day(0.7); v.view(0.9, 0.3, 560); v.settle(1); });
    await shot("dbg-all");
    await ev(() => { const v = window.__venus; v.sky.group.children.forEach((c) => { if (c.isSprite) c.visible = false; }); v.settle(0.2); });
    await shot("dbg-nopuff");
  },
  async hud() {
    await boot("&fresh");
    await ev(() => window.__venus.go("play"));
    await buildCity(14);
    await ev(() => { const v = window.__venus; v.day(0.3); v.view(0.9, 0.34, 380); v.settle(2); v.api.setBuild("bladder"); v.settle(0.5); });
    await hudShot("hud");
    await ev(() => { const v = window.__venus; v.api.setBuild(null); v.sim.open("jed"); v.settle(0.3); });
    await page.waitForTimeout(600);
    await hudShot("event");
  },
  async fall() {
    await boot("&fresh");
    await ev(() => window.__venus.go("play"));
    await ev(() => {
      const v = window.__venus;
      const sim = v.sim;
      for (let i = 0; i < 10; i++) { sim.s.res.carbon = 900; const s = sim.freeSlots()[0]; sim.build("harvester", s.q, s.r); }
      sim.s.alt = 47.5;
      sim.s.integrity = 0.05;
      v.day(0.3);
      v.settle(3);
    });
    await shot("fall-a");
    await ev(() => window.__venus.settle(5));
    await hudShot("fall-b");
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PLAN);
for (const n of names) {
  if (!PLAN[n]) { console.error(`no shot called ${n}`); continue; }
  const t0 = Date.now();
  try { await PLAN[n](); } catch (e) { console.log(`[${n}] failed:`, e.message); bad++; }
  console.log(`[${n}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await browser.close();
server?.kill();
if (bad) { console.error(`${bad} error(s)`); process.exit(1); }
