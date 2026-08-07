#!/usr/bin/env node
/**
 * index-shot — photograph `/game` and `/join`, the two pages people are sent to.
 *
 *     node scripts/index-shot.mjs [outDir]
 *
 * Both are pure layout, so the thing worth checking is what a person sees:
 * do the "updated" dates fit on a card without shoving the blurb around, does
 * the sort toggle actually reorder the grid, and does the wink sit somewhere
 * that ornaments rather than competes. None of that is visible in a diff.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/index-shots");
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/supabase|websocket|ERR_CONNECTION|tunnel|realtime/i.test(t)) {
    errors.push(`console: ${t}`);
  }
});

// No round, so /join renders without waiting on a network that is not there.
await page.route("**/functions/v1/vibe-rounds", (route) => {
  const b = JSON.parse(route.request().postData() ?? "{}");
  const data =
    b.action === "invite_peek"
      ? { valid: true, grant: 250, remaining: 4, note: "Opening Night — welcome to the Vibeverse", expired: false }
      : { round: null, leaderboard: [], you: null };
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
});
await page.route("**/functions/v1/vibe-economy", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { balance: 250, ledger: [] } }),
  }),
);

const shot = async (n, opts = {}) => {
  await page.screenshot({ path: `${OUT}/${n}.png`, ...opts });
  console.log(`   → ${n}.png`);
};

console.log("· /game, featured order");
await page.goto(`${BASE}/game`, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(2500);
await shot("01-game-featured");

const firstFeatured = await page.locator("h3").allInnerTexts();
console.log(`   first six: ${firstFeatured.slice(0, 6).join(" · ")}`);

// Every card should carry a date, and it should be words rather than a number.
const dates = await page.evaluate(() =>
  [...document.querySelectorAll("a[href] .font-mono")]
    .map((e) => e.textContent.trim())
    .filter((t) => /ago|today|yesterday|last (week|month)|\d{4}/.test(t)),
);
console.log(`   cards showing a date: ${dates.length}`);
console.log(`   sample: ${[...new Set(dates)].slice(0, 8).join(" | ")}`);

console.log("· /game, recently updated");
await page.getByRole("button", { name: /Recently updated/ }).click();
await page.waitForTimeout(1200);
await shot("02-game-recent");
const firstRecent = await page.locator("h3").allInnerTexts();
console.log(`   first six: ${firstRecent.slice(0, 6).join(" · ")}`);
console.log(`   order actually changed: ${firstRecent[0] !== firstFeatured[0]}`);

console.log("· a phone");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(900);
await shot("03-game-phone");

console.log("· /join with the wink");
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(`${BASE}/join/ORBIT-B2`, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(2200);
await shot("04-join", { fullPage: true });

if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 10).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
