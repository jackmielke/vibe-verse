#!/usr/bin/env node
/**
 * dz-eval — boot a game, put it on the ground, evaluate one expression in the
 * page, print the result as JSON. The smallest possible question to the
 * running world, for when a frame shows something wrong and the next step is
 * a number rather than another frame.
 *
 *   DZ_ROUTE=/better-fortnite DZ_LOCAL='{"lobby.character":"flux"}' \
 *     node scripts/dz-eval.mjs 's.player.position.toArray()'
 *
 * `e` is the engine, `s` its services, `THREE` is not available — read
 * numbers off objects instead. Settles DZ_SETTLE ms (default 20000) first.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.DZ_PORT ?? 5250);
const BASE = `http://127.0.0.1:${PORT}`;
const ROUTE = process.env.DZ_ROUTE ?? "/drop-zero";
const SETTLE = Number(process.env.DZ_SETTLE ?? 20000);
const expr = process.argv[2] ?? "s.player.state";

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
const up = async () => {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(BASE); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
if (!(await up())) { console.error("vite never came up"); vite.kill(); process.exit(1); }
const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  if (process.env.DZ_LOCAL) {
    await page.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, String(v));
    }, JSON.parse(process.env.DZ_LOCAL));
  }
  await page.goto(`${BASE}${ROUTE}${ROUTE.includes("?") ? "&" : "?"}shot=1&q=low`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction("window.__dzReady === true", null, { timeout: 600000 });
  await page.evaluate("window.__dz.ctx.services.match?.skipToLive?.()");
  await page.waitForTimeout(SETTLE);
  const out = await page.evaluate(`(() => { const e = window.__dz; const s = e.ctx.services; return (${expr}); })()`);
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close().catch(() => {});
  vite.kill();
}
