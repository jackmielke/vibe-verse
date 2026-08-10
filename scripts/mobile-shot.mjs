#!/usr/bin/env node
/**
 * mobile-shot — screenshot any route at phone size, and report overflow.
 *
 * The desktop capture harness (dz-shot) says nothing about whether a page
 * FITS. This one opens a route in an iPhone-sized viewport, screenshots the
 * full scrollable page, and — the useful part — lists every element wider than
 * the viewport, because "the layout is broken on mobile" is not actionable and
 * "these six nodes are 480px wide in a 390px window" is.
 *
 * Usage:
 *   node scripts/mobile-shot.mjs /soaked
 *   node scripts/mobile-shot.mjs /soaked out.png 430   # custom width
 */
import { chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const route = process.argv[2] ?? "/";
const out = process.argv[3] ?? "shots/mobile.png";
const width = Number(process.argv[4] ?? 390); // iPhone 14 CSS width
const height = Number(process.env.MOBILE_H ?? 844);
const PORT = Number(process.env.DZ_PORT ?? 5182);
const BASE = `http://127.0.0.1:${PORT}`;

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

mkdirSync("shots", { recursive: true });

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
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
// A real phone context: touch, coarse pointer, device pixel ratio. Without
// these, `(pointer: coarse)` media queries and touch handlers never engage and
// you are testing a narrow desktop, not a phone.
const ctx = await browser.newContext({
  ...devices["iPhone 14"],
  viewport: { width, height },
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message.slice(0, 200)}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text().slice(0, 200)}`);
});

await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(Number(process.env.MOBILE_WAIT ?? 9000));

/** Anything sticking out past the viewport, named well enough to go fix it. */
const report = await page.evaluate(`(() => {
  const vw = document.documentElement.clientWidth;
  const wide = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Fixed/absolute overlays that deliberately cover the screen are fine.
    if (r.width > vw + 1 || r.right > vw + 1) {
      wide.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 90)) || "",
        text: (el.textContent || "").trim().slice(0, 50),
        w: Math.round(r.width),
        right: Math.round(r.right),
      });
    }
  }
  return {
    viewport: vw,
    scrollWidth: document.documentElement.scrollWidth,
    horizontallyScrolls: document.documentElement.scrollWidth > vw + 1,
    offenders: wide.slice(0, 25),
    offenderCount: wide.length,
  };
})()`);

await page.screenshot({ path: out, fullPage: true, timeout: 300000 });
console.log(`wrote ${out}  (${width}x${height})`);
console.log(JSON.stringify(report, null, 1));
if (errors.length) console.log("\npage errors:\n" + [...new Set(errors)].slice(0, 10).join("\n"));

await browser.close();
if (server) server.kill();
process.exit(report.horizontallyScrolls ? 1 : 0);
