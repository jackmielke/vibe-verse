#!/usr/bin/env node
/**
 * vibecup-cup: play the Vibe Cup tournament the way a player does. Pick the
 * Paint Pads, play a round as their midfielder, watch another match mid-way,
 * then run the rest of the Cup through to a champion, and finally a Cup you
 * only watch. Also checks two-player and the online QR are still there.
 *
 *     node scripts/vibecup-cup.mjs <outDir> [port]
 */
import { chromium, devices } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/vibecup-cup";
const BASE = `http://127.0.0.1:${process.argv[3] ?? "5184"}`;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => (errors.push(String(e)), console.log("pageerror", String(e).slice(0, 300))));
const cup = (op, ...a) => page.evaluate(([op, a]) => window.__vibecup.cup[op](...a), [op, a]);
const shot = async (name, p = page) => {
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log("→", name);
};

await page.goto(`${BASE}/vibe-cup`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__vibecup, null, { polling: 250 });
await page.evaluate(() => localStorage.removeItem("vibecup.cup"));
await page.click('[data-testid="vibecup-mode-cup"]');
await page.click('[data-testid="vibecup-cup-club-paintpads"]');
await page.click("text=Midfield");
await shot("0-title-cup");
await page.click('[data-testid="vibecup-cup-start"]');
await page.waitForSelector('[data-testid="vibecup-hub"]');
await shot("1-hub-round1");
await page.click('[data-testid="vibecup-cup-kickoff"]');
await page.waitForFunction(() => window.__vibecup.state().screen === "playing", null, { polling: 250 });
let s = await cup("state");
const mine = s.live.find((l) => l.mine);
console.log("round", s.round, "live", s.live.length, "my lock", mine.lock, "active", mine.active);

// Play a little: run, call for it, run.
await page.keyboard.down("KeyD");
await page.waitForTimeout(1500);
await page.keyboard.up("KeyD");
await page.keyboard.press("KeyJ");
await page.keyboard.down("KeyW");
await page.waitForTimeout(2500);
await page.keyboard.up("KeyW");
await shot("2-my-match");
s = await cup("state");
const me2 = s.live.find((l) => l.mine);
console.log("still the same player:", me2.active === me2.lock, me2.active, "clock", me2.clock);

// Watch somebody else's match; ours waits.
const other = s.live.find((l) => !l.mine);
await page.click('[data-testid="vibecup-ticker"] button >> nth=' + s.live.findIndex((l) => l.id === other.id));
await page.waitForTimeout(3000);
s = await cup("state");
console.log("watching", s.focus, "mine clock", s.live.find((l) => l.mine).clock, "theirs", s.live.find((l) => l.id === other.id).clock);
await shot("3-watching-bots");

// The rest of the round passes.
await cup("settle", 220);
await page.click('[data-testid="vibecup-ticker"] button >> text=Cup');
await page.waitForTimeout(800);
await shot("4-hub-round1-done");
await cup("next");

// The rest of the Cup.
for (let i = 0; i < 6; i++) {
  s = await cup("state");
  if (s.champion) break;
  await cup("kickoff");
  await page.waitForTimeout(300);
  await cup("settle", 220);
  await page.evaluate(() => window.__vibecup.cup.state());
  await cup("next");
}
await page.evaluate(() => window.__vibecup.cup.state());
s = await cup("state");
console.log("champion", s.champion, "played", s.played, "table", JSON.stringify(s.table));
await page.waitForSelector('[data-testid="vibecup-hub"]');
await shot("5-champion");

// A Cup you only watch.
await page.click('[data-testid="vibecup-cup-new"]');
await page.click('[data-testid="vibecup-cup-watch"]');
await page.click('[data-testid="vibecup-cup-start"]');
await page.click('[data-testid="vibecup-cup-kickoff"]');
await page.waitForTimeout(2500);
s = await cup("state");
console.log("watch-only: live", s.live.map((l) => `${l.id}:${l.mine}`).join(" "), "focus", s.focus);
await shot("6-watch-only");

// Two players and the online QR are still on the menu.
await page.goto(`${BASE}/vibe-cup?net=local`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__vibecup, null, { polling: 250 });
console.log("two-player button:", await page.locator('[data-testid="vibecup-mode-versus"]').count());
await page.click('[data-testid="vibecup-mode-online"]');
await page.click('[data-testid="vibecup-host"]');
await page.waitForSelector('[data-testid="vibecup-lobby"] svg');
console.log("QR code:", await page.locator('[data-testid="vibecup-lobby"] svg path').count());

// The hub on a phone.
const phone = await ctx.newPage();
await phone.setViewportSize(devices["iPhone 13"].viewport);
await phone.goto(`${BASE}/vibe-cup`, { waitUntil: "domcontentloaded" });
await phone.waitForFunction(() => !!window.__vibecup, null, { polling: 250 });
await phone.evaluate(() => window.__vibecup.cup.start("paintpads", "fw"));
await phone.waitForSelector('[data-testid="vibecup-hub"]');
await shot("7-phone-hub", phone);
console.log("errors:", errors.length);
await browser.close();
process.exit(errors.length ? 1 : 0);
