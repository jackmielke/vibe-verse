#!/usr/bin/env node
/**
 * gump-deep — run every chapter of RUN, VIBEY, RUN to the end and look at it.
 *
 * `gump-shot.mjs` proves each chapter boots and draws something. This one is
 * the harder question: does the chapter *finish*, and do the beats that fire
 * two thirds of the way through — the braces coming off, the storm arriving,
 * the crowd assembling behind you — actually render?
 *
 * It uses the two dev seams on the engine (`timeScale` and `debug.immortal`)
 * because the alternative is sitting through five kilometres of highway six
 * times, badly, on a software renderer.
 *
 * Usage: node scripts/gump-deep.mjs [outDir]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "/tmp/gump-deep";
const PORT = Number(process.env.GUMP_PORT ?? 5184);
const BASE = `http://127.0.0.1:${PORT}`;
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
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(m.text());
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));

const NAMES = ["greenbow", "football", "vietnam", "pingpong", "shrimp", "america"];
/** Where in each chapter a picture is worth taking. */
const MARKS = [0.3, 0.62, 0.9];

for (const [i, name] of NAMES.entries()) {
  await page.goto(`${BASE}/run?shot=1&chapter=${i}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__gumpReady === true, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => {
    window.__gump.timeScale = 7;
    window.__gump.debug.immortal = true;
  });

  let mark = 0;
  const t0 = Date.now();
  const seen = new Set();
  // Drive it: hold a direction for a beat, tap, swap. Enough to keep the
  // ping-pong rally alive and to prove steering does not wedge anything.
  while (Date.now() - t0 < 150000) {
    const key = Math.random() < 0.5 ? "KeyA" : "KeyD";
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.press("Space");
    await page.waitForTimeout(150);
    await page.keyboard.up(key);

    const s = await page.evaluate(() => window.__gump.snapshot());
    if (s.toast) seen.add(s.toast);
    if (mark < MARKS.length && s.hud.progress >= MARKS[mark]) {
      writeFileSync(
        join(OUT, `${String(i + 1).padStart(2, "0")}-${name}-${Math.round(MARKS[mark] * 100)}.jpg`),
        await page.screenshot({ type: "jpeg", quality: 84 }),
      );
      mark++;
    }
    if (s.phase !== "playing") {
      writeFileSync(
        join(OUT, `${String(i + 1).padStart(2, "0")}-${name}-end.jpg`),
        await page.screenshot({ type: "jpeg", quality: 84 }),
      );
      console.log(`${name}: ${s.phase} — ${s.hud.outcome} — "${s.narration}"`);
      break;
    }
  }
  const s = await page.evaluate(() => window.__gump.snapshot());
  if (s.phase === "playing") console.log(`${name}: TIMED OUT at ${(s.hud.progress * 100) | 0}%`);
  console.log(`  beats seen: ${seen.size}`);
  for (const t of seen) console.log(`   · ${t}`);
}

console.log(problems.length ? `\nerrors:\n${[...new Set(problems)].join("\n")}` : "\nno console errors");
await browser.close();
server?.kill();
