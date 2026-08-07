#!/usr/bin/env node
/**
 * shop-shot — buy a hat in a real browser and photograph what happens.
 *
 *     node scripts/shop-shot.mjs [outDir]
 *
 * The shop is the first surface where a click takes coins off somebody, so the
 * thing worth proving is not that it renders — it is that buy → own → wear is
 * one continuous story in the UI, and that the balance in the corner moves with
 * it. This stubs `vibe-economy` with the shapes the deployed function actually
 * returns (verified against production) and drives the real page.
 *
 * The stub is not a second economy. It holds a balance and a set, because the
 * client's job is to reflect what the server said, and that is what is under
 * test here.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/shop-shots");
const PORT = Number(process.env.SHOP_PORT ?? 5182);
const BASE = `http://127.0.0.1:${PORT}`;

/** Mirrors the server catalog; only what the stub needs to price a purchase. */
const PRICES = {
  "hat:cap": 25, "hat:beanie": 35, "hat:party": 60, "hat:tophat": 75,
  "hat:propeller": 90, "hat:crown": 250, "hat:halo": 400,
  "flame:fire": 50, "flame:violet": 80, "flame:magma": 120,
  "flame:ion": 150, "flame:rainbow": 300,
  "jetpack:sunset": 80, "jetpack:violet": 110, "jetpack:ion": 140,
  "jetpack:magma": 180, "jetpack:gold": 260,
};

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
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

let balance = 300;
const owned = new Set();
const loadout = { hat: "none", flame: "mint", jetpack: "stock" };
const seen = [];

await page.route("**/functions/v1/vibe-economy", async (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  seen.push(body.action);
  const fail = (msg) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: msg }),
    });

  let data = {};
  if (body.action === "wallet") {
    data = { balance, ledger: [] };
  } else if (body.action === "wardrobe") {
    data = { owned: [...owned], loadout, balance };
  } else if (body.action === "buy_cosmetic") {
    const key = `${body.kind}:${body.id}`;
    const price = PRICES[key] ?? 0;
    if (!price) return fail("that one is stock issue — you already have it");
    if (owned.has(key)) return fail("you already own that one");
    if (balance < price) return fail(`not enough vibe (have ${balance}, need ${price})`);
    balance -= price;
    owned.add(key);
    data = { balance, owned: [...owned], bought: { kind: body.kind, id: body.id, price } };
  } else if (body.action === "set_loadout") {
    for (const kind of ["hat", "flame", "jetpack"]) {
      if (body[kind] == null) continue;
      const key = `${kind}:${body[kind]}`;
      if ((PRICES[key] ?? 0) > 0 && !owned.has(key)) return fail(`you do not own that ${kind}`);
      loadout[kind] = body[kind];
    }
    data = { loadout };
  } else if (body.action === "claim_guest") {
    return fail("sign in first");
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
  const t = m.text();
  if (m.type() === "error" && !/supabase|websocket|ERR_CONNECTION|tunnel/i.test(t)) {
    errors.push(`console: ${t}`);
  }
});

const shot = async (n) => {
  await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
  console.log(`   → ${n}.png`);
};

console.log("· the shelves");
await page.goto(`${BASE}/shop`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await shot("01-shelves");

const chip = (await page.locator("[data-vibecoin-pop] button").first().innerText()).trim();
console.log(`   nav chip: ${JSON.stringify(chip)}  ·  stub balance ${balance}`);

console.log("· buy the Top Hat (75)");
const before = balance;
await page.getByRole("button", { name: /^Buy · 75/ }).first().click();
await page.waitForTimeout(2500);
console.log(`   balance ${before} → ${balance}, owned: ${[...owned].join(", ") || "(none)"}`);
console.log(`   loadout after buy: ${JSON.stringify(loadout)}`);
await shot("02-bought");

console.log("· buy something unaffordable (Halo, 400)");
await page.getByRole("button", { name: /Halo|Need 400/ }).first().click().catch(() => {});
await page.waitForTimeout(600);
const haloDisabled = await page
  .getByRole("button", { name: /Need 400/ })
  .first()
  .isDisabled()
  .catch(() => null);
console.log(`   halo button disabled: ${haloDisabled}`);

console.log("· wear something else, then come back");
await page.getByRole("button", { name: /^Wear it$/ }).first().click().catch(() => {});
await page.waitForTimeout(1800);
console.log(`   loadout now: ${JSON.stringify(loadout)}`);
await shot("03-worn");

console.log("· reload — ownership must survive");
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2000);
const wearingCount = await page.locator("text=✓ Wearing").count();
const ownedCount = await page.locator("text=/^owned$/").count();
console.log(`   after reload: ${ownedCount} owned, ${wearingCount} worn`);
await shot("04-after-reload");

console.log(`\nactions sent: ${[...new Set(seen)].join(", ")}`);
console.log(`final: balance ${balance}, owned ${[...owned].join(", ")}`);
if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 10).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
server?.kill();
