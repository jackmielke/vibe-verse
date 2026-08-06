#!/usr/bin/env node
/**
 * city-flyover — photograph Vibe City from the air, from a fixed set of
 * angles, so a change to how it looks can be judged instead of guessed at.
 *
 *     node scripts/city-flyover.mjs <outDir>
 *
 * The city's whole problem is that it is judged from above — people pinch out,
 * fly over it, and decide whether it looks like a place. That view is exactly
 * the one you never see while developing, because developing means standing in
 * the plaza. So this drives the real page: enters with `?fresh=1`, drags the
 * orbit camera to a set of altitudes and headings, and writes a frame for each.
 *
 * The shots are deliberately the same every run (fixed seed city, fixed
 * camera), so two runs diff cleanly against each other.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/city-shots");
const PORT = Number(process.env.CITY_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * The angles that matter. `dist` is orbit distance in metres, `pitch` is how
 * far above the horizon (radians, clamped 0.06–1.25 by the page).
 */
const SHOTS = [
  { name: "01-street", dist: 15, pitch: 0.2, yaw: 0.6, note: "eye level in the plaza" },
  { name: "02-flyover", dist: 240, pitch: 0.6, yaw: 0.9, note: "the view people complain about" },
  { name: "03-approach", dist: 300, pitch: 0.2, yaw: 2.2, note: "low approach, skyline against sky" },
  { name: "04-god", dist: 600, pitch: 0.95, yaw: 0.5, note: "the whole island" },
];

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

mkdirSync(OUT, { recursive: true });

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
  // SwiftShader is the software GL this container falls back to. Without
  // these the page gets no WebGL context at all and every frame is black.
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/supabase|websocket|ERR_CONNECTION|tunnel/i.test(t)) {
    errors.push(`console: ${t}`);
  }
});

console.log("· booting the city (this takes a while on software GL)");
await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
// The city streams in GLBs and builds sky islands, the moon and Mars after
// first paint. Nothing signals "settled", so this is a wait — but a shorter
// one than it looks, because the poses below each add four seconds.
await page.waitForTimeout(25000);

/**
 * Pose the orbit camera through the page's dev hook.
 *
 * The first version of this synthesised wheel and drag events, which is what a
 * player does — and it took three minutes a shot on software GL and still
 * landed somewhere else, because the zoom is exponential per notch so a dropped
 * event is a different altitude. `__cityCam` is a `import.meta.env.DEV` block
 * in City.tsx that sets the three numbers directly; it is not in the shipped
 * bundle.
 */
await page.waitForFunction(() => typeof window.__cityCam === "function", null, {
  timeout: 60000,
});

async function pose({ dist, pitch, yaw }) {
  // Re-asserted rather than set once. The city drives its own camera in a few
  // places — the arrival swoop, fast travel, the kart chase — and any of them
  // firing during the settle window silently drops the shot back to head
  // height. Setting it five times over five seconds outlasts a one-shot
  // override, and the chase camera lerps rather than snapping anyway.
  for (let i = 0; i < 5; i++) {
    // The hook can genuinely be missing for a moment: editing a source file
    // while this is running makes Vite hot-reload the page, and City's cleanup
    // deletes `__cityCam` before the next mount re-adds it. Wait rather than
    // throw — a remount is a slow frame, not a failure.
    await page.waitForFunction(() => typeof window.__cityCam === "function", null, {
      timeout: 30000,
    });
    await page.evaluate(([d, p, y]) => window.__cityCam(d, p, y), [dist, pitch, yaw]);
    await page.waitForTimeout(1100);
  }
}

/**
 * Time of day normally comes from a `world_settings` row over Supabase, which
 * this container cannot reach — so the page sits at its built-in night. The day
 * pass drives the same `applyMode` the toggle button does.
 *
 * Both passes matter and for different reasons: night is the city's signature
 * look and where the lighting grid has to read, day is where the shadows and
 * the massing do their work.
 */
async function setDay(day) {
  await page.evaluate((d) => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /Night|Day/.test(b.textContent ?? ""),
    );
    // The button label says what it will switch TO, so "🌙 Night" means it is
    // currently day.
    const isDay = btn ? /Night/.test(btn.textContent ?? "") : false;
    if (btn && isDay !== d) btn.click();
  }, day);
  await page.waitForTimeout(2500);
}

for (const mode of ["night", "day"]) {
  console.log(`\n=== ${mode} ===`);
  await setDay(mode === "day");
  for (const s of SHOTS) {
    const name = `${mode}-${s.name}`;
    console.log(`· ${name} — ${s.note}`);
    await pose(s);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`   → ${name}.png`);
  }
}

if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 10).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
server?.kill();
