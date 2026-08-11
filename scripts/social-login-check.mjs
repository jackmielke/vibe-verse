#!/usr/bin/env node
/**
 * social-login-check — drive "Continue with MetaMask" and "Continue with
 * Google" in a real browser, end to end, without either one existing.
 *
 *     node scripts/social-login-check.mjs
 *
 * ## Why this and not a unit test
 *
 * `walletAuth.test.ts` asserts the right bytes go to the right place, but it
 * calls `signInWithWallet` directly. Everything between the button and that
 * function is exactly the sort of thing that can be perfect in isolation and
 * unplugged in the component: a handler wired to the wrong button, discovery
 * that never resolves so the button stays disabled, a dialog that does not
 * close, a callback route that spins forever. None of it shows up in a build,
 * a typecheck or a unit test — you have to press the button.
 *
 * ## What is faked, and what is therefore actually proven
 *
 * A fake MetaMask is injected over EIP-6963, and `wallet-auth`, GoTrue and the
 * OAuth authorize endpoint are stubbed at the network layer. So this proves
 * the *client's* half: discovery, the button, the order of calls, the exact
 * string handed to the wallet, the token exchange, and the `/auth/callback`
 * round trip. It cannot prove the edge function verifies a signature — that is
 * `scripts/wallet-auth-sigcheck.mjs`, which signs with a real key.
 *
 * ## It runs against `dist/`, so build first
 *
 * `npm run build && node scripts/social-login-check.mjs`
 *
 * The dev server would work but compiles the route graph on the first request,
 * which on this repo outruns any sane navigation timeout. The built bundle is
 * also the thing that actually ships, which matters here: the dialog hangs off
 * the global nav, so a chunking mistake in these imports shows up in `dist` and
 * nowhere else.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.SOCIAL_PORT ?? 5188);
const BASE = `http://127.0.0.1:${PORT}`;

const NONCE = "0123456789abcdef";
const ADDRESS = "0x7255EcF1020a95FED5323dd4fEb23a54ab1AA7D1";
const SERVER_MESSAGE = [
  "127.0.0.1 wants you to sign in with your Ethereum account:",
  ADDRESS,
  "",
  "Welcome to the Vibeverse. Signing this proves you hold this wallet and",
  "signs you in. It is a signature, not a transaction — nothing moves out of",
  "your wallet and there is no fee.",
  "",
  "Chain: Base (8453)",
  `Nonce: ${NONCE}`,
  "Issued At: 2026-08-11T12:00:00.000Z",
].join("\n");

const SESSION = {
  access_token: "fake-access-token",
  refresh_token: "fake-refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: {
    id: "11111111-2222-3333-4444-555555555555",
    aud: "authenticated",
    role: "authenticated",
    email: `${ADDRESS.toLowerCase()}@wallet.vibeverse.id`,
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  },
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

if (!existsSync(new URL("../dist/index.html", import.meta.url))) {
  console.error("no dist/ — run `npm run build` first");
  process.exit(1);
}

/* stdio fully ignored, not "inherit" for stderr. An inherited fd keeps this
   process's stdout pipe open after we exit, so anything piping us into `tail`
   or a log sees nothing at all until the server is killed by hand. */
const server = (await up(BASE, 1200))
  ? null
  : spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: "ignore",
      env: { ...process.env, BROWSER: "none" },
    });
if (server && !(await up(BASE, 60000))) {
  console.error("preview server never came up");
  process.exit(1);
}
// Including the throw-on-a-failed-check path, which is the one that matters:
// a leaked preview server holds --strictPort and the next run cannot start.
process.on("exit", () => server?.kill());

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`   ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// A wallet that behaves like MetaMask, including announcing itself.
// ---------------------------------------------------------------------------
const FAKE_WALLET = `
  window.__signed = [];
  const provider = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') return ['${ADDRESS}'];
      if (method === 'eth_accounts') return [];
      if (method === 'personal_sign') {
        window.__signed.push(params);
        return '0xdeadbeef';
      }
      throw new Error('unexpected ' + method);
    },
    on: () => {}, removeListener: () => {},
  };
  const detail = Object.freeze({
    info: { uuid: 'aaaa-bbbb', name: 'MetaMask', icon: 'data:image/svg+xml,', rdns: 'io.metamask' },
    provider,
  });
  const announce = () => window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', { detail }),
  );
  window.addEventListener('eip6963:requestProvider', announce);
  window.ethereum = provider;
  announce();
`;

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 980 } });
  await page.addInitScript(FAKE_WALLET);

  page.on("pageerror", (e) => console.log(`   !! pageerror: ${e.message.split("\n")[0]}`));

  // The edge function.
  await page.route("**/functions/v1/wallet-auth", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (body.action === "nonce") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ nonce: NONCE, message: SERVER_MESSAGE }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token_hash: "hashed-token", isNewAccount: true, address: ADDRESS }),
    });
  });

  // GoTrue: redeem the token, then answer the follow-up user fetch.
  await page.route("**/auth/v1/verify**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SESSION),
    }),
  );
  await page.route("**/auth/v1/user**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SESSION.user),
    }),
  );
  await page.route("**/rest/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  return page;
}

// ===========================================================================
console.log("\n· MetaMask");
// ===========================================================================
{
  const page = await newPage();
  const calls = [];
  page.on("request", (r) => {
    if (r.url().includes("/functions/v1/wallet-auth")) {
      calls.push(JSON.parse(r.postData() ?? "{}"));
    }
    if (r.url().includes("/auth/v1/verify")) calls.push({ verify: JSON.parse(r.postData() ?? "{}") });
  });

  await page.goto(`${BASE}/lobby`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Log in" }).first().click();
  await page.waitForTimeout(1500);

  // Discovery has to have resolved, or the button says the wrong thing.
  const label = await page.getByRole("button", { name: /Continue with/ }).first().textContent();
  check("the wallet button names the wallet that answered", /MetaMask/.test(label ?? ""), label?.trim());

  await page.getByRole("button", { name: /Continue with MetaMask/i }).click();
  await page.waitForTimeout(2500);

  const signed = await page.evaluate(() => window.__signed);
  check("the wallet was asked to sign", signed.length === 1);
  check(
    "it signed the server's message, character for character",
    signed[0]?.[0] === SERVER_MESSAGE,
    signed[0]?.[0] === SERVER_MESSAGE ? "" : JSON.stringify(signed[0]?.[0]?.slice(0, 60)),
  );
  check("arguments were [message, address]", signed[0]?.[1] === ADDRESS);

  const nonceCall = calls.find((c) => c.action === "nonce");
  const verifyCall = calls.find((c) => c.action === "verify");
  check("asked the server for a nonce first", Boolean(nonceCall));
  check("posted the nonce back with the signature", verifyCall?.nonce === NONCE);
  check("never posted the message back", verifyCall?.message === undefined);

  const redeem = calls.find((c) => c.verify);
  check("redeemed the token_hash", redeem?.verify?.token_hash === "hashed-token");
  check("redeemed it as a magiclink", redeem?.verify?.type === "magiclink");

  // The visible outcome: dialog gone, nav shows an account.
  const dialogGone = (await page.getByRole("button", { name: /Continue with MetaMask/i }).count()) === 0;
  check("the dialog closed on success", dialogGone);
  const stored = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("sb-") && k.includes("auth-token")),
  );
  check("a session was persisted", stored.length > 0, stored.join(","));
  const booked = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("vibe.walletBook.v1") ?? '{"wallets":[]}').wallets.length,
  );
  check("the address went into the wallet book", booked === 1);

  await page.screenshot({ path: "/tmp/social-login-metamask.png" });
  await page.close();
}

// ===========================================================================
console.log("\n· Google");
// ===========================================================================
{
  const page = await newPage();

  /* Stand in for Google: bounce straight back to /auth/callback with a token
     in the fragment, which is exactly the shape the implicit flow returns. */
  await page.route("**/auth/v1/authorize**", (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location:
          `${BASE}/auth/callback#access_token=${SESSION.access_token}` +
          `&refresh_token=${SESSION.refresh_token}&token_type=bearer&expires_in=3600`,
      },
    }),
  );

  await page.goto(`${BASE}/lobby`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Log in" }).first().click();
  await page.waitForTimeout(1200);

  await page.getByRole("button", { name: /Continue with Google/i }).click();

  /* The click leaves the page entirely: authorize → 302 → a cold boot of the
     whole app on /auth/callback. Waiting a fixed few seconds is not enough on
     a slow box, and — worse — a half-booted nav renders a loading placeholder
     rather than a "Log in" button, so a naive "is the log in button gone?"
     check passes while nothing has actually happened. Wait for the callback to
     hand off instead. */
  let leftCallback = true;
  try {
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/callback"), { timeout: 30000 });
  } catch {
    leftCallback = false;
  }
  check("the callback handed off instead of spinning", leftCallback, page.url());
  check(
    "came back to where the visitor started",
    new URL(page.url()).pathname === "/lobby",
    page.url(),
  );
  check(
    "the tokens are out of the address bar",
    !page.url().includes("access_token"),
    page.url(),
  );

  // Assert the session directly rather than inferring it from a missing
  // button, which is also what a still-loading nav looks like.
  const stored = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("sb-") && k.includes("auth-token")),
  );
  check("a session was persisted", stored.length > 0, stored.join(","));

  await page.screenshot({ path: "/tmp/social-login-google.png" });
  await page.close();
}

// ===========================================================================
console.log("\n· /auth/callback opened by hand");
// ===========================================================================
{
  const page = await newPage();
  await page.goto(`${BASE}/auth/callback`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  // Must not sit on a spinner for the full give-up timeout.
  check(
    "sends you home rather than spinning",
    new URL(page.url()).pathname === "/",
    page.url(),
  );
  await page.close();
}

await browser.close();
if (server) server.kill();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed` +
    (failed.length ? `\nFAILED: ${failed.map((f) => f.name).join(", ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
