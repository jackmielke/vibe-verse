#!/usr/bin/env node
/**
 * city-phone-hud — does anything on a phone cover the joystick?
 *
 *     node scripts/city-phone-hud.mjs [outDir]
 *
 * Opens /city on an emulated iPhone, portrait and landscape, gets on the
 * pegasus and then into a kart, and checks the on-screen buttons against the
 * joystick and the jump button. Exits non-zero on any overlap.
 */
import { chromium, devices } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "/tmp/city-phone");
const BASE = `http://127.0.0.1:${Number(process.env.ORBIT_PORT ?? 5184)}`;
mkdirSync(OUT, { recursive: true });
const exe = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
let bad = 0;
for (const [label, dev] of [["portrait", devices["iPhone 13"]], ["landscape", devices["iPhone 13 landscape"]]]) {
  const ctx = await browser.newContext({ ...dev });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  await page.route("**/functions/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  await page.goto(`${BASE}/city?spawn=island`, { waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForFunction(() => !!window.__cityCrash && !!window.__cityMounts, null, { timeout: 300000 });
  await page.waitForTimeout(6000);
  const check = async (what) => {
    const r = await page.evaluate(() => {
      const rect = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
      const stick = document.querySelector(".touch-none.w-32.h-32");
      const jump = document.querySelector(".touch-none.w-20.h-20");
      const stack = document.querySelector('[data-testid="action-stack"]');
      const kids = stack ? [...stack.querySelectorAll("button, span.glass-panel")].map(rect) : [];
      return { stick: stick && rect(stick), jump: jump && rect(jump), kids };
    });
    const hit = (a, b) => a && b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
    const over = r.kids.filter((k) => hit(k, r.stick) || hit(k, r.jump)).length;
    console.log(`${label} ${what}: ${r.kids.length} controls, stick ${r.stick ? "shown" : "missing"}, ${over} overlapping`);
    if (!r.stick || over) bad++;
    await page.screenshot({ path: `${OUT}/${label}-${what}.png`, timeout: 180000 });
  };
  await check("near-mounts");
  // Walk up to Pegasus: the ride prompt should appear only once you are close.
  const prompt = page.getByRole("button", { name: /Ride Pegasus/ });
  console.log(`   ride prompt before walking up: ${await prompt.count()}`);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => { const [x, y, z] = window.__cityMounts().pegasus; window.__cityWarp(x + 3, y + 0.5, z); });
    await page.waitForTimeout(1500);
  }
  await prompt.waitFor({ timeout: 60000 }).catch(() => {});
  console.log(`   ride prompt next to Pegasus: ${await prompt.count()}`);
  await check("next-to-pegasus");
  await prompt.click().catch(() => { console.log("   (no Ride Pegasus button)"); bad++; });
  await page.waitForTimeout(4000);
  await check("riding");
  await page.evaluate(() => window.__cityCrash.drive(2, -7, 8, 0, 0, 0));
  await page.waitForTimeout(3000);
  await check("driving");
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
