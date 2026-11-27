#!/usr/bin/env node
/**
 * hoops-online: two tabs in one browser on the `local` transport. One makes a
 * room, the other opens the invite link, the host tips off, and both should
 * be playing the same game.
 *
 *     node scripts/hoops-online.mjs [port]
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = `http://127.0.0.1:${process.argv[2] ?? "5185"}`;
const browser = await chromium.launch(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
const host = await ctx.newPage();
const guest = await ctx.newPage();
for (const p of [host, guest]) p.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
await host.goto(`${BASE}/hoops?net=local&lq`, { waitUntil: "domcontentloaded" });
await host.click('[data-testid="hoops-online"]');
await host.click('[data-testid="hoops-host"]');
await host.waitForSelector('[data-testid="hoops-code"]');
const code = (await host.textContent('[data-testid="hoops-code"]')).trim();
console.log("room", code);
await guest.goto(`${BASE}/hoops?net=local&lq&room=${encodeURIComponent(code)}`, { waitUntil: "domcontentloaded" });
await guest.waitForSelector('[data-testid="hoops-lobby"]', { timeout: 60000 });
await host.waitForFunction(() => document.querySelector('[data-testid="hoops-lobby"]')?.textContent?.includes("2/"), null, { timeout: 30000 }).catch(() => console.log("lobby text did not show 2 players"));
await host.click('[data-testid="hoops-online-tip"]');
await guest.waitForFunction(() => window.__hoops?.state().screen === "playing", null, { polling: 500, timeout: 90000 });
const read = (p) => p.evaluate(() => { const s = window.__hoops.state(); return { screen: s.screen, phase: s.phase, ctrls: s.ctrls, ball: [s.ball.x.toFixed(1), s.ball.y.toFixed(1)], clock: s.clock.toFixed(1) }; });
let ok = false;
for (let k = 0; k < 14 && !ok; k++) {
  await host.waitForTimeout(15000);
  const h = await read(host);
  const g = await read(guest);
  console.log("host ", JSON.stringify(h));
  console.log("guest", JSON.stringify(g));
  ok = h.phase === "play" && g.phase === "play" && g.ctrls.length === 2;
}
console.log(ok ? "PASS both tabs are playing the same game" : "FAIL");
process.exitCode = ok ? 0 : 1;
await browser.close();
