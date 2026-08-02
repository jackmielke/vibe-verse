#!/usr/bin/env node
/**
 * gump-shot — drive RUN, VIBEY, RUN in a real browser and look at the frames.
 *
 * The house rule is that a world that builds and renders a black screen is a
 * broken demo and the build will not tell you. So this boots each chapter in
 * turn, plays it for a few seconds with the keyboard held down, and writes a
 * JPEG per beat plus every console error it saw. It is the thing that has to
 * pass before this route goes anywhere near main.
 *
 * Usage: node scripts/gump-shot.mjs [outDir] [secondsPerChapter]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "/tmp/gump";
const PLAY_MS = Number(process.argv[3] ?? 6) * 1000;
const PORT = Number(process.env.GUMP_PORT ?? 5183);
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = process.env.GUMP_PHONE === "1";

mkdirSync(OUT, { recursive: true });

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

const viewport = PHONE ? { width: 390, height: 844 } : { width: 1440, height: 810 };
const page = await browser.newPage({ viewport, deviceScaleFactor: 1, hasTouch: PHONE });

const problems = [];
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning") problems.push(`[${msg.type()}] ${msg.text()}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));

const CHAPTERS = ["greenbow", "football", "vietnam", "pingpong", "shrimp", "america"];

/* The bench, first — it is the title screen and the thing most likely to be
   a black rectangle nobody noticed. */
await page.goto(`${BASE}/run`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
writeFileSync(join(OUT, "00-bench.jpg"), await page.screenshot({ type: "jpeg", quality: 84 }));
console.log("bench ✓");

for (const [i, name] of CHAPTERS.entries()) {
  await page.goto(`${BASE}/run?shot=1&chapter=${i}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__gumpReady === true, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Play it like a person: hold a direction, jump and swing on a rhythm.
  const t0 = Date.now();
  let flip = 0;
  while (Date.now() - t0 < PLAY_MS) {
    const key = flip % 2 ? "KeyA" : "KeyD";
    await page.keyboard.down(key);
    await page.waitForTimeout(280);
    await page.keyboard.press("Space");
    await page.waitForTimeout(340);
    await page.keyboard.up(key);
    flip++;
  }

  const shot = await page.screenshot({ type: "jpeg", quality: 84 });
  writeFileSync(join(OUT, `${String(i + 1).padStart(2, "0")}-${name}.jpg`), shot);

  const st = await page.evaluate(() => {
    const e = window.__gump;
    return e ? JSON.stringify(e.snapshot()) : "no engine";
  });
  console.log(`${name} ✓ ${st}`);
}

if (problems.length) {
  console.log("\n--- console ---");
  for (const p of [...new Set(problems)].slice(0, 40)) console.log(p);
} else {
  console.log("\nno console errors");
}

await browser.close();
server?.kill();
