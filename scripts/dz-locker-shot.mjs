#!/usr/bin/env node
/**
 * dz-locker-shot — photograph the entry veil and the locker.
 *
 * `dz-shot.mjs` boots the world in `?shot=1`, which deliberately drops the
 * veil; this is the opposite: the veil IS the subject. It seeds a character,
 * waits for the veil's "Dropping as" card, opens the locker, picks a tile by
 * name, closes it, and reads the card back — so the last line of output is
 * whether the pick actually landed, not just whether the screen drew.
 *
 *   DZ_PORT=5231 node scripts/dz-locker-shot.mjs [route] [seedCharacter] [pickCharacter]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const PORT = Number(process.env.DZ_PORT ?? 5231);
const BASE = `http://127.0.0.1:${PORT}`;
const route = process.argv[2] ?? "/better-fortnite";
const seed = process.argv[3] ?? "Pirate_Anne";
const pick = process.argv[4] ?? "Wizard";
const OUT = process.env.DZ_OUT ?? "shots/locker";
mkdirSync(OUT, { recursive: true });

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
  await page.addInitScript((id) => { localStorage.setItem("lobby.character", id); localStorage.removeItem("royale.suit"); }, seed);
  await page.goto(`${BASE}${route}?q=low`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("text=Dropping as", { timeout: 900000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/veil.png`, timeout: 600000 });
  console.log(`wrote ${OUT}/veil.png`);

  await page.click("text=Dropping as");
  await page.waitForSelector("text=Choose your character", { timeout: 60000 });
  // The preview is its own WebGL canvas under SwiftSHADER; give it a few frames.
  await page.waitForTimeout(15000);
  await page.screenshot({ path: `${OUT}/locker.png`, timeout: 600000 });
  console.log(`wrote ${OUT}/locker.png`);

  await page.click(`button:has-text("${pick.replace(/_/g, " ")}")`);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${OUT}/locker-pick.png`, timeout: 600000 });
  console.log(`wrote ${OUT}/locker-pick.png`);

  await page.click("text=Done");
  await page.waitForTimeout(1500);
  const stored = await page.evaluate("localStorage.getItem('lobby.character')");
  const card = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("button")).find((b) => /Dropping as/i.test(b.textContent ?? ""));
    return el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : null;
  });
  console.log(`picked ${pick}: localStorage lobby.character=${stored}; veil card: ${card}`);
  process.exitCode = stored === pick ? 0 : 2;
} finally {
  await browser.close().catch(() => {});
  vite.kill();
}
