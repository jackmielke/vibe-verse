#!/usr/bin/env node
/**
 * mines-probe — play-test the Gremlin Mines headlessly.
 *
 * The mines are the one world you cannot judge from a still: the entry
 * flash, the gremlin clan and the boss's charge cycle all only show up
 * over time. This drops into /city?spawn=mines, samples the run state
 * for a while, and reports what actually happened — did the arrival
 * flash clear, did the boss ever charge, did anything land a hit.
 *
 * Usage: node scripts/mines-probe.mjs [seconds] [outDir]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const SECONDS = Number(process.argv[2] ?? 45);
const OUT = process.argv[3] ?? ".";
const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server = (await up(BASE, 1200))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, BROWSER: "none" },
    });
if (server && !(await up(BASE, 180000))) {
  console.error("dev server never came up");
  process.exit(1);
}

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
// Small viewport on purpose: swiftshader rasterises every pixel on the
// CPU, and the City tick clamps dt to 50 ms, so a slow frame rate makes
// the whole cavern run in slow motion. Fewer pixels, closer to real time.
const page = await browser.newPage({
  viewport: { width: Number(process.env.PROBE_W ?? 800), height: Number(process.env.PROBE_H ?? 500) },
});
const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto(`${BASE}/city?spawn=mines`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.mouse.click(640, 400).catch(() => {});

// Tolerates a mid-run reload: editing any source file while the probe
// is up sends vite's HMR through here, and a destroyed execution
// context should skip one sample, not end the play-test.
const sample = async () => {
  try {
    return await page.evaluate(() => ({
      flash: document.body.innerText.includes("Purple mist"),
      run: window.__cityDebug?.minesRun?.() ?? null,
      hud: document.body.innerText.includes("🥷 You"),
      ko: document.body.innerText.includes("THE GREMLINS WIN"),
    }));
  } catch {
    return { flash: false, run: null, hud: false, ko: false };
  }
};

const phases = new Set();
let flashLast = -1;
let minHearts = 99;
let koSeen = false;
let hudSeen = false;

// First half: walk a slow circle, so the clan has something to chase
// and the boss has a reason to line up a charge. Second half: stand
// still and let them have you — that is the only way to see the
// knock-out and the eject back to the surface.
const KEYS = ["KeyW", "KeyD", "KeyS", "KeyA"];
const t0 = Date.now();
let i = 0;
while ((Date.now() - t0) / 1000 < SECONDS) {
  const elapsed = (Date.now() - t0) / 1000;
  const running = elapsed < SECONDS * 0.5;
  // Last quarter: walk straight into the boss, over and over, to force
  // the three hits that end a run. Headless runs at a few frames a
  // second, so waiting for it to happen naturally takes all afternoon.
  if (elapsed > SECONDS * (Number(process.env.PROBE_KO_AT ?? 0.75))) {
    await page
      .evaluate(() => {
        const run = window.__cityDebug?.minesRun?.();
        if (run) window.__cityDebug?.teleport?.(run.bossAt[0], run.bossAt[1] + 0.2, run.bossAt[2]);
      })
      .catch(() => {});
  }
  const key = KEYS[i % KEYS.length];
  if (running) {
    await page.keyboard.down(key);
    await page.waitForTimeout(700);
    await page.keyboard.press("Space").catch(() => {});
    await page.waitForTimeout(700);
    await page.keyboard.up(key);
  } else {
    await page.waitForTimeout(1400);
  }
  const s = await sample();
  const t = Math.round((Date.now() - t0) / 1000);
  if (s.flash) flashLast = t;
  if (s.hud) hudSeen = true;
  if (s.ko) koSeen = true;
  if (s.run) {
    phases.add(s.run.boss);
    minHearts = Math.min(minHearts, s.run.hearts);
  }
  if (process.env.MINES_TRACE) {
    console.log(
      `t=${t}s hud=${s.hud ? 1 : 0} hearts=${s.run?.hearts ?? "-"} ` +
        `bossHp=${s.run?.bossHp ?? "-"} phase=${s.run?.boss ?? "-"} ` +
        `dist=${s.run ? s.run.bossDist.toFixed(1) : "-"}${s.ko ? " KO" : ""}`,
    );
  }
  i++;
}

const png = await page.screenshot();
writeFileSync(`${OUT}/mines-play.png`, png);

console.log(`arrival flash last seen at: ${flashLast < 0 ? "never" : flashLast + "s"} (of ${SECONDS}s)`);
console.log(`run HUD rendered: ${hudSeen}`);
console.log(`boss phases observed: ${[...phases].join(", ") || "none"}`);
console.log(`hearts dropped to: ${minHearts === 99 ? "n/a" : minHearts}`);
console.log(`knock-out screen seen: ${koSeen}`);
console.log(`wrote ${OUT}/mines-play.png`);
if (errors.length) console.log("page errors:\n" + errors.slice(-6).join("\n"));

await browser.close();
if (server) server.kill();
