#!/usr/bin/env node
/**
 * arcade-shot — put a coin in every cabinet, in a real browser, and photograph
 * what happens.
 *
 *     node scripts/arcade-shot.mjs [outDir]
 *
 * The arcade's whole point is a round trip to the ledger, so a screenshot of
 * the floor proves almost nothing on its own — the frames that matter are the
 * ones after a coin has been taken. This intercepts `vibe-economy` and answers
 * with the same shapes the deployed function returns, so the run exercises the
 * real insert → play → settle path through the real client without spending
 * anybody's actual balance.
 *
 * The stub is deliberately dumb and must never grow into a second economy: the
 * server's copy of the payout curve is the authority, and
 * `src/test/arcade.test.ts` is what holds the two together.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/arcade-shots");
const PORT = Number(process.env.ARCADE_PORT ?? 5178);
const BASE = `http://127.0.0.1:${PORT}`;

/** Mirrors CABINETS in src/arcade/cabinets.ts. Order matches the floor. */
const CABS = [
  { key: "stacker", cost: 10, payout: (s) => (s <= 0 ? 0 : s * 4 + (s >= 12 ? 40 : 0)) },
  { key: "pattern", cost: 8, payout: (s) => (s < 3 ? 0 : Math.round(s * s * 0.6)) },
  { key: "reflex", cost: 6, payout: (s) => Math.round(s * 2.4) },
];
const byKey = Object.fromEntries(CABS.map((c) => [c.key, c]));

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
if (server && !(await up(BASE, 120000))) {
  console.error("dev server never came up");
  process.exit(1);
}

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

let balance = 100;
const ledger = [];
let plays = 0;
const seen = [];

await page.route("**/functions/v1/vibe-economy", async (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  seen.push(body.action);
  /* Echo the client's own owner ref back on every row. The chip decides
     whether a movement was a credit or a debit by asking "is `to_ref` me?", so
     a stub that invents its own ref draws every payout as a loss — which is a
     bug in the harness that looks exactly like a bug in the app. */
  const kind = body.ownerKind ?? "user";
  const ref = body.ownerRef ?? "me";
  let data = {};
  if (body.action === "wallet") {
    data = { balance, ledger };
  } else if (body.action === "arcade_insert") {
    const cab = byKey[body.game];
    if (balance < cab.cost) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: `not enough vibe (have ${balance}, need ${cab.cost})` }),
      });
    }
    balance -= cab.cost;
    const playId = `play-${++plays}`;
    ledger.unshift({
      id: playId, from_kind: kind, from_ref: ref, to_kind: "system", to_ref: "arcade",
      amount: cab.cost, reason: "arcade_play", memo: body.game,
      created_at: new Date().toISOString(),
    });
    data = { playId, cost: cab.cost, balance };
  } else if (body.action === "arcade_settle") {
    const amount = byKey[body.game].payout(body.score);
    balance += amount;
    if (amount > 0) {
      ledger.unshift({
        id: `win-${plays}`, from_kind: "system", from_ref: "treasury",
        to_kind: kind, to_ref: ref, amount, reason: "arcade_win",
        memo: `${body.game} · score ${body.score}`, created_at: new Date().toISOString(),
      });
    }
    data = { amount, balance, capped: false, remainingToday: 400 - amount };
  } else if (body.action === "arcade_allowance") {
    const granted = Math.max(0, 30 - balance);
    balance = Math.max(balance, 30);
    data = { granted, balance, nextAt: null };
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
});

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`   → ${name}.png`);
};

console.log("· the floor");
await page.goto(`${BASE}/arcade`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await shot("01-floor");

const navCoin = (await page.locator("[data-vibecoin-pop] button").first().innerText()).trim();
console.log(`   nav chip reads: ${JSON.stringify(navCoin)}`);

const results = [];
for (let i = 0; i < CABS.length; i++) {
  const cab = CABS[i];
  console.log(`· ${cab.key}`);
  const before = balance;

  await page.getByRole("button", { name: /^Insert /i }).nth(i).click();
  await page.waitForSelector("canvas", { timeout: 8000 });
  await page.waitForTimeout(600);
  await shot(`02-${cab.key}-playing`);
  console.log(`   coin taken: ${before} → ${balance}`);

  // Play it. Space is the one button; Digit1 hits a pad on Pattern. Every
  // cabinet ends on its own, so this is a bounded loop either way.
  const deadline = Date.now() + 30000;
  while ((await page.locator("canvas").count()) > 0 && Date.now() < deadline) {
    await page.keyboard.press("Space");
    await page.keyboard.press("Digit1");
    await page.waitForTimeout(110);
  }
  await page.waitForTimeout(1200);
  await shot(`03-${cab.key}-result`);

  const overShown = (await page.locator("text=/run over/i").count()) > 0;
  const scoreText = overShown
    ? (await page.locator("text=/run over/i").locator("xpath=following-sibling::*[1]").innerText().catch(() => "?"))
    : "—";
  console.log(`   results card: ${overShown ? "shown" : "MISSING"}  score ${scoreText}  balance now ${balance}`);
  results.push({ cab: cab.key, overShown, balance });

  await page.getByRole("button", { name: /Back to the floor/i }).click().catch(() => {});
  await page.waitForTimeout(500);
}

console.log("· the ledger popover");
await page.locator("[data-vibecoin-pop] button").first().click();
await page.waitForTimeout(700);
await shot("04-ledger");

console.log(`\nactions the client sent: ${[...new Set(seen)].join(", ")}`);
console.log(`balance after three runs: ${balance} (started at 100)`);
console.log(`ledger rows written: ${ledger.length}`);
console.log(`cabinets that reached a results card: ${results.filter((r) => r.overShown).length}/3`);
if (errors.length) {
  console.log(`\n!! ${errors.length} console/page errors:`);
  [...new Set(errors)].slice(0, 12).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
server?.kill();
