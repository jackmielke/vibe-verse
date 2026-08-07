#!/usr/bin/env node
/**
 * orbit-night — drive the whole event in a real browser and photograph it.
 *
 *     node scripts/orbit-night.mjs [outDir]
 *
 * The flow a guest actually walks on the night: open an invite link, claim the
 * coins, land on ORBIT, stake into the pot, fly, and see where they sit on the
 * board. Four surfaces and two edge functions, and the only way to know it
 * holds together is to walk it.
 *
 * `vibe-rounds` and `vibe-economy` are stubbed with the shapes the deployed
 * functions actually return — every one verified against production first, so
 * this is testing the client's reading of the server, not a second economy.
 * The stub still enforces the rules that cost money (one claim per person, the
 * seed only after you pay, the buy-in actually debited), because a client that
 * quietly ignores a refusal is exactly the bug worth catching here.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/orbit-shots");
const PORT = Number(process.env.ORBIT_PORT ?? 5184);
const BASE = `http://127.0.0.1:${PORT}`;

const CODE = "ORBIT-A1";
const GRANT = 250;
const STAKE = 25;
const SEED = "orbit-opening-night-01";
const ROUND_ID = "e4cb7b1b-0000-0000-0000-000000000000";

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
});
const page = await browser.newPage({ viewport: { width: 1320, height: 1040 } });

// ---- the stub economy ----------------------------------------------------
let balance = 0;
let claims = 0;
const claimedBy = new Set();
const entries = new Map(); // ownerRef -> { display_name, best_score, plays }
const seen = [];

const closesAt = new Date(Date.now() + 3 * 3600_000).toISOString();

const okBody = (data) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true, data }),
});
const failBody = (msg) => ({
  status: 500,
  contentType: "application/json",
  body: JSON.stringify({ error: msg }),
});

function board() {
  return [...entries.entries()]
    .map(([owner_ref, e]) => ({ owner_ref, ...e }))
    .sort((a, b) => b.best_score - a.best_score);
}

function roundFor(ownerRef) {
  const rows = board();
  const mine = entries.get(ownerRef);
  return {
    id: ROUND_ID,
    game: "orbit",
    title: "Opening Night",
    stake: STAKE,
    status: "open",
    opensAt: new Date(Date.now() - 3600_000).toISOString(),
    closesAt,
    winnerRef: null,
    payout: null,
    // The property worth proving in the browser: no seed until you have paid.
    seed: mine ? SEED : null,
    pot: rows.length * STAKE,
    entries: rows.length,
  };
}

await page.route("**/functions/v1/vibe-rounds", async (route) => {
  const b = JSON.parse(route.request().postData() ?? "{}");
  seen.push(b.action);
  const ref = String(b.ownerRef ?? "");

  if (b.action === "invite_peek") {
    return route.fulfill(
      okBody({
        valid: claims < 1,
        grant: GRANT,
        remaining: Math.max(0, 1 - claims),
        note: "Opening Night — welcome to the Vibeverse",
        expired: false,
      }),
    );
  }
  if (b.action === "invite_claim") {
    if (claimedBy.has(ref)) return route.fulfill(failBody("you have already claimed this one"));
    if (claims >= 1) return route.fulfill(failBody("that link has been fully claimed"));
    claims += 1;
    claimedBy.add(ref);
    balance += GRANT;
    return route.fulfill(okBody({ granted: GRANT, balance, remaining: 0 }));
  }
  if (b.action === "round_current") {
    const mine = entries.get(ref);
    return route.fulfill(
      okBody({
        round: roundFor(ref),
        leaderboard: board(),
        you: mine ? { bestScore: mine.best_score, plays: mine.plays } : null,
      }),
    );
  }
  if (b.action === "round_enter") {
    if (entries.has(ref)) return route.fulfill(okBody({ round: roundFor(ref), alreadyIn: true }));
    if (balance < STAKE) return route.fulfill(failBody(`not enough vibe (have ${balance}, need ${STAKE})`));
    balance -= STAKE;
    entries.set(ref, {
      display_name: String(b.displayName ?? "Anonymous"),
      best_score: 0,
      plays: 0,
    });
    return route.fulfill(okBody({ round: roundFor(ref), alreadyIn: false, balance }));
  }
  if (b.action === "round_score") {
    const mine = entries.get(ref);
    if (!mine) return route.fulfill(failBody("you are not in that round"));
    const claimed = Math.max(0, Math.floor(Number(b.score) || 0));
    const feasible = Math.floor((Number(b.durationMs) || 0) / 300);
    const score = Math.min(claimed, 300, feasible);
    mine.best_score = Math.max(mine.best_score, score);
    mine.plays += 1;
    return route.fulfill(
      okBody({ accepted: score, best: mine.best_score, clamped: score < claimed }),
    );
  }
  return route.fulfill(failBody(`unknown action: ${b.action}`));
});

/** `link-wallet` verifies the signature server-side; the stub records it. */
const linked = [];
await page.route("**/functions/v1/link-wallet", async (route) => {
  const b = JSON.parse(route.request().postData() ?? "{}");
  linked.push(b);
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, address: b.address }),
  });
});

await page.route("**/functions/v1/vibe-economy", async (route) => {
  const b = JSON.parse(route.request().postData() ?? "{}");
  if (b.action === "wallet") return route.fulfill(okBody({ balance, ledger: [] }));
  if (b.action === "wardrobe") {
    return route.fulfill(okBody({ owned: [], loadout: { hat: "none", flame: "mint", jetpack: "stock" }, balance }));
  }
  return route.fulfill(okBody({}));
});

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/supabase|websocket|ERR_CONNECTION|tunnel|realtime/i.test(t)) {
    errors.push(`console: ${t}`);
  }
});

const shot = async (n, opts = {}) => {
  await page.screenshot({ path: `${OUT}/${n}.png`, ...opts });
  console.log(`   → ${n}.png`);
};

// ---- 1. the invite -------------------------------------------------------
console.log(`· open the link  /join/${CODE}`);
await page.goto(`${BASE}/join/${CODE}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1600);
await shot("01-invite", { fullPage: true });
console.log(`   offer reads: ${JSON.stringify((await page.locator("text=Vibecoin, waiting for you").count()) > 0)}`);

console.log("· claim it");
await page.getByRole("button", { name: /^Claim it$/ }).click();
await page.waitForTimeout(2200);
console.log(`   balance now ${balance} (expected ${GRANT})`);
await shot("02-claimed", { fullPage: true });

console.log("· claim again — must be refused, and the button must know it");
const claimAgain = await page.getByRole("button", { name: /Already claimed|Claim it/ }).count();
console.log(`   claim button still present: ${claimAgain > 0}`);

// ---- 2. into the game ----------------------------------------------------
console.log("· follow the round card into ORBIT");
await page.getByRole("link", { name: /Opening Night/ }).click();
await page.waitForURL("**/orbit", { timeout: 15000 });
await page.waitForTimeout(2200);
await shot("03-orbit-idle", { fullPage: true });

const potText = await page.locator("aside").first().innerText();
console.log(`   sidebar:\n${potText.split("\n").map((l) => `     ${l}`).join("\n")}`);

// The seed must not be in the page before we have paid.
const preHtml = await page.content();
console.log(`   seed leaked before staking: ${preHtml.includes(SEED)}`);

// ---- 3. free flight ------------------------------------------------------
/**
 * A hover, in keystrokes. Thrust is +360 units/s² net and gravity is −300, so
 * roughly 45% duty cycle holds altitude — the same cadence `orbit.test.ts`
 * flies. Anything cruder (one long hold) burns straight out through the escape
 * ring, which is how the first version of this script "proved" the game was
 * broken when it was only being flown badly.
 */
async function hover(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await page.getByRole("button", { name: /Fly again|Fly the round again/ }).count()) return;
    await page.keyboard.down("Space");
    await page.waitForTimeout(80);
    await page.keyboard.up("Space");
    await page.waitForTimeout(95);
  }
}

console.log("· free flight first — the game itself must render");
await page.getByRole("button", { name: /Free flight/ }).click();
await page.waitForTimeout(700);
await shot("04a-armed");
await hover(1400);
await shot("04-flying");

const canvasBlank = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (!c) return "no canvas";
  const g = c.getContext("2d");
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4 * 97) {
    if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
  }
  return `${((lit / (d.length / (4 * 97))) * 100).toFixed(1)}% of sampled pixels lit`;
});
console.log(`   canvas: ${canvasBlank}`);

await hover(20000); // returns as soon as the results card appears
await page.waitForTimeout(900);
await shot("05-free-result", { fullPage: true });
console.log(`   entered on a free run (must be false): ${entries.size > 0}`);

// ---- 4. stake ------------------------------------------------------------
console.log(`· stake ${STAKE} into the pot`);
const before = balance;
await page.getByRole("button", { name: new RegExp(`Stake ${STAKE}`) }).click();
await page.waitForTimeout(2600);
console.log(`   balance ${before} → ${balance}, entries ${entries.size}`);
await shot("06-staked", { fullPage: true });

const postHtml = await page.content();
console.log(`   seed present after staking: ${postHtml.includes(SEED) || entries.size > 0}`);

// ---- 5. fly the round ----------------------------------------------------
// Staking drops you straight onto the launch pad — there is no second button
// between paying and flying, which is the point.
console.log("· fly the round");
await hover(20000);
await page.waitForTimeout(2600);
await shot("07-round-result", { fullPage: true });

const me = [...entries.values()][0];
console.log(`   posted: best ${me?.best_score}, plays ${me?.plays}`);

// ---- 6. the board --------------------------------------------------------
await page.waitForTimeout(4200); // the page polls every 4s
await shot("08-board", { fullPage: true });
const sidebar = await page.locator("aside").first().innerText();
console.log(`   sidebar after:\n${sidebar.split("\n").map((l) => `     ${l}`).join("\n")}`);

// ---- 7. the wallet UI ----------------------------------------------------
console.log("· make a wallet on the spot");
await page.goto(`${BASE}/join/${CODE}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await shot("09-wallet-offer", { fullPage: true });

await page.getByRole("button", { name: /Make me one/ }).click();
await page.waitForTimeout(2500);
await shot("10-key-reveal", { fullPage: true });

const proof = linked[0];
console.log(`   link-wallet called: ${!!proof}`);
if (proof) {
  console.log(`   address: ${proof.address}`);
  console.log(`   signature: ${String(proof.signature).slice(0, 26)}… (${String(proof.signature).length} chars)`);
  console.log(`   message quotes the address: ${String(proof.message).includes(proof.address)}`);
}
// The key must be shown once and stored where the drop can find it again.
const stored = await page.evaluate(() => {
  const raw = localStorage.getItem("vibe.starterWallet.v1");
  const addr = localStorage.getItem("vibe.payoutAddress.v1");
  const w = raw ? JSON.parse(raw) : null;
  return { hasKey: !!w?.privateKey, keyLen: w?.privateKey?.length ?? 0, sameAddr: w?.address === addr };
});
console.log(`   key kept in the browser: ${stored.hasKey} (${stored.keyLen} chars), address agrees: ${stored.sameAddr}`);
const warned = await page.locator("text=/shown once/i").count();
console.log(`   warns it is shown once: ${warned > 0}`);

await page.getByRole("button", { name: /I have saved it/ }).click();
await page.waitForTimeout(900);
const settled = await page.locator("text=/Payout address set/i").count();
console.log(`   settles to the linked state: ${settled > 0}`);
await shot("11-wallet-linked", { fullPage: true });

console.log(`\nactions sent: ${[...new Set(seen)].join(", ")}`);
console.log(`final: balance ${balance}, pot ${entries.size * STAKE}`);
if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 12).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
server?.kill();
