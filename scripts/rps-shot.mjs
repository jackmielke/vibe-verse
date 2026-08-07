#!/usr/bin/env node
/**
 * rps-shot — play a hand of rock-paper-scissors in a real browser.
 *
 *     node scripts/rps-shot.mjs [outDir]
 *
 * The table is a proximity trigger on Vibe Island, so this opens it through
 * the DEV hook rather than walking there. `vibe-rounds` is stubbed with the
 * shapes the deployed function actually returns — every one verified against
 * production first — and the stub *commits properly*, hashing its throw with
 * real WebCrypto before the browser picks. That matters: the thing under test
 * is the client's verification, and a stub that returned an arbitrary hash
 * would make a passing check meaningless.
 */
import { chromium } from "playwright";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/rps-shots");
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
const STAKE = 25;
mkdirSync(OUT, { recursive: true });

const sha = (s) => createHash("sha256").update(s).digest("hex");
const THROWS = ["rock", "paper", "scissors"];
const beats = { rock: "scissors", paper: "rock", scissors: "paper" };

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });

let balance = 100;
let hand = null;
const dealt = [];

await page.route("**/functions/v1/vibe-rounds", async (route) => {
  const b = JSON.parse(route.request().postData() ?? "{}");
  const okBody = (data) => ({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
  const fail = (m) => ({
    status: 500, contentType: "application/json",
    body: JSON.stringify({ error: m }),
  });

  if (b.action === "rps_table") {
    return route.fulfill(okBody({
      stake: STAKE, vibePriceUsd: 0.000147,
      open: hand ? { id: hand.id, commit_hash: hand.commit, stake: STAKE, opened_at: "" } : null,
      history: [], record: { win: 0, lose: 0, push: 0 },
    }));
  }
  if (b.action === "rps_open") {
    if (hand) return route.fulfill(okBody({ handId: hand.id, commit: hand.commit, stake: STAKE, resumed: true }));
    if (balance < STAKE) return route.fulfill(fail(`not enough vibe (have ${balance}, need ${STAKE})`));
    const houseThrow = THROWS[Math.floor(Math.random() * 3)];
    const nonce = randomBytes(16).toString("hex");
    hand = { id: "hand-1", houseThrow, nonce, commit: sha(`${houseThrow}:${nonce}`) };
    balance -= STAKE;
    dealt.push(houseThrow);
    return route.fulfill(okBody({ handId: hand.id, commit: hand.commit, stake: STAKE, balance, resumed: false }));
  }
  if (b.action === "rps_throw") {
    if (!hand) return route.fulfill(fail("that hand is not yours"));
    const p = b.playerThrow;
    const outcome = p === hand.houseThrow ? "push" : beats[p] === hand.houseThrow ? "win" : "lose";
    const payout = STAKE * (outcome === "win" ? 2 : outcome === "push" ? 1 : 0);
    balance += payout;
    const reveal = { throw: hand.houseThrow, nonce: hand.nonce, commit: hand.commit };
    hand = null;
    return route.fulfill(okBody({
      outcome, playerThrow: p, houseThrow: reveal.throw, payout, stake: STAKE, balance, reveal,
    }));
  }
  return route.fulfill(okBody({ round: null, leaderboard: [], you: null }));
});

await page.route("**/functions/v1/vibe-economy", (route) =>
  route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { balance, ledger: [] } }),
  }),
);

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/supabase|websocket|ERR_CONNECTION|tunnel|realtime|WebGL/i.test(t)) {
    errors.push(`console: ${t}`);
  }
});

const shot = async (n) => {
  await page.screenshot({ path: `${OUT}/${n}.png` });
  console.log(`   → ${n}.png`);
};

console.log("· load Vibe Island");
await page.goto(`${BASE}/city?spawn=island`, { waitUntil: "domcontentloaded", timeout: 180000 });
// Third argument, not second — the second is the value passed into the page,
// so options given there are silently ignored and the default 30s applies.
await page.waitForFunction(() => !!window.__openRpsTable, null, { timeout: 240000 });
await page.waitForTimeout(6000);
await shot("01-island");

console.log("· open the table");
await page.evaluate(() => window.__openRpsTable());
await page.waitForTimeout(1600);
await shot("02-table");

const sealed = await page.locator("text=/sealed before you choose/i").count();
console.log(`   shows the seal before you pick: ${sealed > 0}`);

console.log(`· ante ${STAKE}`);
await page.getByRole("button", { name: new RegExp(`Ante ${STAKE}`) }).click();
await page.waitForTimeout(1800);
console.log(`   balance ${balance + STAKE} → ${balance}`);
await shot("03-anted");

console.log("· throw rock");
await page.getByRole("button", { name: /^✊\s*Rock$/ }).click().catch(async () => {
  await page.locator("button", { hasText: "Rock" }).first().click();
});
await page.waitForTimeout(900);
await shot("04-countdown");

await page.waitForTimeout(2600);
await shot("05-result");

const verdict = await page.locator("text=/Seal checked out|does not match|Could not check/").first().innerText();
console.log(`   house threw: ${dealt[0]}`);
console.log(`   verification line: "${verdict}"`);
console.log(`   balance after: ${balance}`);

const again = await page.getByRole("button", { name: /Play another/ }).count();
console.log(`   offers another hand: ${again > 0}`);

if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 8).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
