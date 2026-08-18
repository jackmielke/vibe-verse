#!/usr/bin/env node
/**
 * print-check — what a route looks like on paper.
 *
 * /times is a newspaper, so it ought to survive Ctrl-P, and there is no way
 * to know whether it does by looking at the screen: print styles are a whole
 * second rendering nobody ever sees. This one puts Chromium into print media,
 * prints the route to a PDF, and rasterises the first pages to PNGs you can
 * actually open.
 *
 * It reports two things worth failing on: a page that came out completely
 * blank, and content wider than the sheet (which is how a two-column layout
 * announces it has been forced into one).
 *
 * Usage:
 *   node scripts/print-check.mjs /times
 *   node scripts/print-check.mjs /times shots/paper   # prefix for the output
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const route = process.argv[2] ?? "/times";
const prefix = process.argv[3] ?? "shots/print";
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

mkdirSync(dirname(prefix) || ".", { recursive: true });

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
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});

let bad = false;
try {
  // A4 is 210mm wide; the margins below leave 186mm of it, which is 703 CSS
  // pixels at 96dpi. Measuring in a desktop viewport instead would call every
  // paragraph "too wide" and mean nothing.
  const SHEET = 703;
  const page = await browser.newPage({ viewport: { width: SHEET, height: 1120 } });
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(300);

  // What survived the print stylesheet, and what the sheet is going to have
  // to hold. A4 at 96dpi is 794 CSS pixels wide with no margins; the print
  // itself adds margins, so anything near that is already too wide.
  const report = await page.evaluate((sheet) => {
    // checkVisibility walks ancestors, which matters: a button inside a
    // display:none nav is not printing, and its own computed style says
    // nothing about that.
    const visible = (el) => el.checkVisibility?.() ?? !!el.getClientRects().length;
    const paper = document.querySelector(".newspaper");
    const chrome = [...document.querySelectorAll('[class~="fixed"]')].filter(visible).length;
    const buttons = [...document.querySelectorAll("button, input")].filter(visible).length;
    const wide = [...document.querySelectorAll(".newspaper *")]
      .filter((el) => visible(el) && el.getBoundingClientRect().width > sheet + 2)
      .length;
    return {
      hasPaper: !!paper,
      text: (paper?.innerText ?? "").replace(/\s+/g, " ").trim().length,
      visibleFixedChrome: chrome,
      visibleControls: buttons,
      elementsWiderThanTheSheet: wide,
    };
  }, SHEET);

  await page.pdf({
    path: `${prefix}.pdf`,
    format: "A4",
    margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" },
    printBackground: false,
  });

  // A picture of page one, since a PDF is not a thing you can eyeball from a
  // terminal. The screenshot is taken in print media, so it is the same
  // rendering the PDF got.
  await page.screenshot({ path: `${prefix}-page1.png`, clip: { x: 0, y: 0, width: SHEET, height: 1120 } });

  console.log(JSON.stringify(report, null, 1));
  if (!report.hasPaper) {
    console.error("no .newspaper on this route — nothing to print");
    bad = true;
  }
  if (report.text < 400) {
    console.error("the printed page is effectively blank");
    bad = true;
  }
  if (report.visibleFixedChrome > 0) {
    console.error(`${report.visibleFixedChrome} pinned element(s) still printing`);
    bad = true;
  }
  if (report.visibleControls > 0) {
    console.error(`${report.visibleControls} button(s) or field(s) still printing`);
    bad = true;
  }
  if (report.elementsWiderThanTheSheet > 0) {
    console.error(`${report.elementsWiderThanTheSheet} element(s) wider than the sheet`);
    bad = true;
  }
  console.log(`wrote ${prefix}.pdf and ${prefix}-page1.png`);
} finally {
  await browser.close();
  server?.kill();
}

process.exit(bad ? 1 : 0);
