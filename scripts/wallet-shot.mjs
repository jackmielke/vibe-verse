#!/usr/bin/env node
/**
 * wallet-shot — photograph the wallet card, with and without wallets installed.
 *
 *     node scripts/wallet-shot.mjs [outDir]
 *
 * The interesting states are the ones a developer's own browser never shows.
 * This machine has no wallet extension at all, so the "I already have a wallet"
 * branch would silently render its empty case forever. Here a fake extension is
 * injected the way a real one announces itself — an `eip6963:announceProvider`
 * event — so the multi-wallet list can actually be seen.
 *
 * The Base Account button is deliberately NOT clicked: it opens a popup to
 * base.org and asks the operating system for a passkey, neither of which is
 * available to a headless browser. That leg needs a real device.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/wallet-shots");
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
});
const page = await browser.newPage({ viewport: { width: 1180, height: 1000 } });

await page.route("**/functions/v1/vibe-rounds", (route) => {
  const b = JSON.parse(route.request().postData() ?? "{}");
  const data =
    b.action === "invite_peek"
      ? { valid: true, grant: 250, remaining: 6, note: "Opening Night", expired: false }
      : { round: null, leaderboard: [], you: null };
  return route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
});
await page.route("**/functions/v1/vibe-economy", (route) =>
  route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { balance: 250, ledger: [] } }),
  }),
);

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

console.log("· no wallet installed — the default state");
await page.goto(`${BASE}/join/ORBIT-C3`, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(2000);
await shot("01-default", { fullPage: true });

const primary = await page.getByRole("button", { name: /Create a Vibe Wallet/ }).count();
const secondary = await page.getByRole("button", { name: /I already have a wallet/ }).count();
console.log(`   offers a Vibe Wallet: ${primary > 0}`);
console.log(`   offers 'I already have a wallet': ${secondary > 0}`);

console.log("· with nothing installed, the second door explains itself");
await page.getByRole("button", { name: /I already have a wallet/ }).click();
await page.waitForTimeout(900);
const empty = await page.locator("text=/No wallet extension found/i").count();
console.log(`   shows the honest empty state: ${empty > 0}`);
await shot("02-no-extensions", { fullPage: true });

console.log("· now with two wallets installed, announced over EIP-6963");
await page.addInitScript(() => {
  const mk = (rdns, name) => ({
    info: { uuid: `u-${rdns}`, name, rdns, icon: "data:image/svg+xml;base64,PHN2Zy8+" },
    provider: {
      request: async ({ method }) => {
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "personal_sign") return "0xdead";
        return null;
      },
    },
  });
  const wallets = [mk("io.metamask", "MetaMask"), mk("io.rabby", "Rabby")];
  const announce = () => {
    for (const detail of wallets) {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    }
  };
  window.addEventListener("eip6963:requestProvider", announce);
  // Also write the legacy global, the way MetaMask does — the list must not
  // then show the same wallet twice under two different names.
  window.ethereum = wallets[0].provider;
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /I already have a wallet/ }).click();
await page.waitForTimeout(900);

const names = await page.evaluate(() =>
  [...document.querySelectorAll("button")]
    .map((b) => b.textContent.trim())
    .filter((t) => /MetaMask|Rabby|Browser wallet/i.test(t)),
);
console.log(`   wallets listed: ${JSON.stringify(names)}`);
console.log(`   no duplicate 'Browser wallet': ${!names.some((n) => /Browser wallet/i.test(n))}`);
await shot("03-two-wallets", { fullPage: true });

if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 8).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
