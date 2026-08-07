#!/usr/bin/env node
/**
 * auth-shot — walk the sign-in dialog and prove the code box submits itself.
 *
 *     node scripts/auth-shot.mjs [outDir]
 *
 * The auto-submit rule is unit-tested in `otp.test.ts`; what this checks is the
 * wiring around it — that the effect is actually connected to the input, that a
 * rejected code does not loop against a live endpoint, and that the box carries
 * the attributes iOS looks for. Those are all things that can be correct in
 * isolation and unplugged in the component.
 *
 * Supabase auth is stubbed at the network layer, so nothing here sends mail or
 * spends a real verification attempt.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/auth-shots");
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
});
const page = await browser.newPage({ viewport: { width: 1100, height: 980 } });

let otpSends = 0;
let verifyAttempts = [];
let verifyShouldFail = true;

await page.route("**/auth/v1/otp**", (route) => {
  otpSends += 1;
  return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});
await page.route("**/auth/v1/verify**", (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  verifyAttempts.push(body.token);
  if (verifyShouldFail) {
    return route.fulfill({
      status: 403, contentType: "application/json",
      body: JSON.stringify({ error: "invalid_grant", error_description: "Token has expired or is invalid" }),
    });
  }
  return route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ access_token: "x", refresh_token: "y", user: { id: "u1" } }),
  });
});
await page.route("**/functions/v1/**", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: {} }) }),
);

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/supabase|websocket|ERR_CONNECTION|tunnel|realtime|403|invalid_grant/i.test(t)) {
    errors.push(`console: ${t}`);
  }
});

const shot = async (n) => {
  await page.screenshot({ path: `${OUT}/${n}.png` });
  console.log(`   → ${n}.png`);
};

console.log("· open the sign-in dialog");
await page.goto(`${BASE}/join/ORBIT-D4`, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(1800);
await page.getByRole("button", { name: /Make an account/i }).click();
await page.waitForTimeout(1200);
await shot("01-email");

console.log("· ask for a code");
await page.getByPlaceholder("your@email.com").fill("jack@example.com");
await page.getByRole("button", { name: /Send me a code/i }).click();
await page.waitForTimeout(1400);
await shot("02-code-box");
console.log(`   code requested: ${otpSends === 1}`);

const attrs = await page.evaluate(() => {
  const el = document.querySelector('input[placeholder="123456"]');
  if (!el) return null;
  return {
    autocomplete: el.getAttribute("autocomplete"),
    inputmode: el.getAttribute("inputmode"),
    name: el.getAttribute("name"),
    maxlength: el.getAttribute("maxlength"),
    type: el.getAttribute("type"),
    count: document.querySelectorAll('input[placeholder="123456"]').length,
  };
});
console.log(`   input: ${JSON.stringify(attrs)}`);

console.log("· five digits — must not submit yet");
await page.getByPlaceholder("123456").fill("12345");
await page.waitForTimeout(700);
console.log(`   attempts so far: ${verifyAttempts.length} (want 0)`);

console.log("· the sixth digit lands — it should go by itself");
await page.getByPlaceholder("123456").fill("123456");
await page.waitForTimeout(2000);
console.log(`   attempts: ${verifyAttempts.length} (want 1) ${JSON.stringify(verifyAttempts)}`);
await shot("03-auto-submitted");

console.log("· the code was rejected — sit still and watch for a loop");
await page.waitForTimeout(3500);
console.log(`   attempts after 3.5s idle: ${verifyAttempts.length} (want 1)`);

console.log("· correct it — should submit again on its own");
verifyShouldFail = false;
await page.getByPlaceholder("123456").fill("65432");
await page.waitForTimeout(300);
await page.getByPlaceholder("123456").fill("654321");
await page.waitForTimeout(2200);
console.log(`   attempts: ${verifyAttempts.length} (want 2) ${JSON.stringify(verifyAttempts)}`);
await shot("04-accepted");

if (errors.length) {
  console.log(`\n!! ${errors.length} errors:`);
  [...new Set(errors)].slice(0, 8).forEach((e) => console.log(`   ${e}`));
} else {
  console.log("\nno console errors.");
}

await browser.close();
