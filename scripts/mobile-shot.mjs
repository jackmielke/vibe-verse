#!/usr/bin/env node
/**
 * mobile-shot — phone-viewport captures of any route, and an overflow report.
 *
 * Boots vite, opens a route in a touch-emulating Chromium sized like a phone
 * (coarse pointer, device pixel ratio — without them `(pointer: coarse)`
 * never matches and you are testing a narrow desktop, not a phone), walks the
 * route's entry steps with taps, and screenshots. After every frame it lists
 * every element wider than the viewport, because "the layout is broken on
 * mobile" is not actionable and "these six nodes are 480 px wide in a 390 px
 * window" is. It exits non-zero if any frame scrolled sideways.
 *
 *   node scripts/mobile-shot.mjs --route /better-fortnite --orient landscape
 *   node scripts/mobile-shot.mjs --route /sf --orient portrait --out shots/m-sf
 *   node scripts/mobile-shot.mjs --route /splash-royale --orient portrait --build
 *   node scripts/mobile-shot.mjs /soaked                # plain page, full height
 *
 * Steps are picked from the route: a royale route taps its way past the veil
 * and, with --build, into build mode; /sf waits for the HUD, opens the
 * tactical map, closes it with a real touch and says whether that worked.
 * Anything else is a full-page capture. The canvas under a HUD renders through
 * SwiftShader and can come out white with no error — that is the renderer
 * dying under load, so run one of these at a time.
 */
import { chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const flag = (name) => args.includes(`--${name}`);

const route = opt("route", args[0] && !args[0].startsWith("--") ? args[0] : "/better-fortnite");
const orient = opt("orient", "landscape");
const OUT = opt("out", `shots/mobile/${route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root"}-${orient}`);
const PORT = Number(process.env.DZ_PORT ?? opt("port", "5320"));
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
const up = async () => {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
if (!(await up())) {
  console.error("vite never came up");
  vite.kill();
  process.exit(1);
}

const base = devices["iPhone 14 Pro Max"];
const portrait = orient === "portrait";
const viewport = portrait ? { width: 430, height: 932 } : { width: 932, height: 430 };
const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});

/** Anything sticking out past the viewport, named well enough to go fix it. */
const OVERFLOW = `(() => {
  const vw = document.documentElement.clientWidth;
  const wide = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
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
    offenders: wide.slice(0, 12),
    offenderCount: wide.length,
  };
})()`;

let scrolled = false;
const shot = async (page, name, fullPage = false) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage, timeout: 600000 });
  console.log(`wrote ${OUT}/${name}.png`);
  const report = await page.evaluate(OVERFLOW).catch(() => null);
  if (!report) return;
  if (report.horizontallyScrolls) scrolled = true;
  console.log(
    `${name}: viewport ${report.viewport}, scrollWidth ${report.scrollWidth}, ` +
      `${report.offenderCount} node(s) past the right edge${report.horizontallyScrolls ? " — PAGE SCROLLS SIDEWAYS" : ""}`,
  );
  for (const o of report.offenders) console.log(`   ${o.tag} ${o.w}px → ${o.right}  ${o.cls.slice(0, 60)}  "${o.text}"`);
};

let exit = 0;
try {
  const context = await browser.newContext({
    ...base,
    viewport,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  // A white frame with no error in the log is this, every time.
  page.on("crash", () => console.error("PAGE CRASHED (renderer died — usually memory or GPU under load)"));
  page.on("console", (m) => {
    if (m.type() === "error" && !/ERR_TUNNEL|supabase|ERR_CONNECTION/.test(m.text())) console.error("console.error", m.text());
  });
  const seed = opt("character", "");
  if (seed) await page.addInitScript((id) => localStorage.setItem("lobby.character", id), seed);

  const join = route.includes("?") ? "&" : "?";
  const royale = /^\/(better-fortnite|better|bf|better-royale|splash-royale|splash|drop-zero|dz)(\/|$|\?)/.test(route);
  const sf = /^\/sf(\/|$|\?)/.test(route);

  if (royale) {
    await page.goto(`${BASE}${route}${join}q=low`, { waitUntil: "domcontentloaded", timeout: 120000 });
    const enter = page.locator("button", { hasText: /^(Drop in|Get soaked)$/i }).first();
    await enter.waitFor({ timeout: 900000 });
    await page.waitForTimeout(2500);
    await shot(page, "veil");
    await enter.scrollIntoViewIfNeeded().catch(() => {});
    await enter.tap({ force: true, timeout: 120000 });
    // The touch layer mounts on engage, and its FIRE pad is there in every
    // game and every layout — the HUD's own labels are not.
    await page.locator("button", { hasText: /^FIRE$/ }).first().waitFor({ timeout: 180000 });
    // A few frames under SwiftShader so the map, bars and the bus overlay
    // all paint at least once.
    await page.waitForTimeout(Number(opt("settle", "12000")));
    await shot(page, "play");
    if (flag("build")) {
      const build = page.locator("button", { hasText: /^BUILD$/ }).first();
      if (await build.count()) {
        await build.tap({ force: true, timeout: 60000 });
        await page.waitForTimeout(1500);
        await shot(page, "build");
      }
    }
  } else if (sf) {
    await page.goto(`${BASE}${route}${join}quality=low&net=off`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.locator(".sf-cluster").first().waitFor({ timeout: 900000 });
    await page.waitForTimeout(Number(opt("settle", "15000")));
    await shot(page, "play");
    const map = page.locator("button", { hasText: /^MAP$/ }).first();
    if (await map.count()) {
      await map.tap({ force: true, timeout: 60000 });
      await page.waitForTimeout(4000);
      await shot(page, "map");
    }
    // Close it with a real touch at the button's centre — the one gesture a
    // phone has — and say whether it worked, because a map that will not
    // close on a phone is a phone that has to reload the page.
    const close = page.locator("button", { hasText: /^CLOSE$/ }).first();
    if (await close.count()) {
      const box = await close.boundingBox();
      if (box) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      const gone = await page
        .locator("text=TACTICAL MAP")
        .first()
        .waitFor({ state: "hidden", timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      console.log(`map closed by touch: ${gone}`);
    }
    const spawnChip = page.locator("button", { hasText: /Go$/ }).first();
    if (await spawnChip.count()) {
      await page.waitForTimeout(800);
      const box = await spawnChip.boundingBox();
      if (box) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1500);
      await shot(page, "go");
    }
  } else {
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(Number(opt("settle", "8000")));
    await shot(page, "page", true);
  }
} catch (err) {
  console.error(err);
  exit = 1;
} finally {
  await browser.close();
  vite.kill();
}
process.exit(exit || (scrolled ? 1 : 0));
