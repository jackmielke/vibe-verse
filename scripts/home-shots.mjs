#!/usr/bin/env node
/**
 * home-shots — photograph every candidate front door.
 *
 *   node scripts/home-shots.mjs                # all of them
 *   node scripts/home-shots.mjs midnight zine  # just these
 *
 * Fifteen homepages is more than anybody can hold in their head by scrolling
 * through them one at a time, and it is far more than can be checked by reading
 * the code. This opens each one in a real browser at desktop and phone width,
 * reports whether it actually painted, and writes a picture.
 *
 * `?bare` hides the picker's stepper, so the shot is the design and nothing
 * else. It also reports page errors and how tall the page came out — a theme
 * that renders 400px tall has almost certainly lost its grid.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = resolve(process.cwd(), process.env.HOME_SHOT_DIR ?? "/tmp/home-shots");

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const full = process.argv.includes("--full");

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

const server = (await up(BASE, 1500))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, BROWSER: "none" },
    });
if (server && !(await up(BASE, 120000))) {
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

/* The list comes from the running app rather than a copy here, so this cannot
   drift from `src/home/themes.ts`. */
const probe = await browser.newPage();
await probe.goto(`${BASE}/homes`, { waitUntil: "domcontentloaded" });
await probe.waitForTimeout(3500);
const ids = await probe.evaluate(() =>
  [...document.querySelectorAll('a[href^="/homes/"]')].map((a) => a.getAttribute("href").split("/").pop()),
);
await probe.close();

const list = only.length ? only : ids;
if (!list.length) {
  console.error("no themes found at /homes — is the picker rendering?");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

/* A visitor with some history, so passport counts and stamps are not all zero
   — a theme judged on an empty account is judged on its emptiest state. */
const seed = () => {
  const stamps = {};
  const early = Date.now() - 60 * 86400000;
  [["coil", "/coil"], ["blob", "/blob"], ["city", "/city"], ["golf", "/golf"], ["orbit", "/orbit"]]
    .forEach(([k, route], i) => {
      stamps[route] = { route, name: k, first: early + i * 3600000, last: Date.now(), count: 2 };
    });
  localStorage.setItem("vibe.passport", JSON.stringify({ stamps }));
};

let bad = 0;
for (const id of list) {
  for (const [label, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e.message ?? e).slice(0, 120)));
    try {
      /* Before any script on the page runs, so the very first render already
         has a history to draw. Seeding after `goto` would photograph the empty
         state and quietly pass every passport-driven theme. */
      await page.addInitScript(seed);
      await page.goto(`${BASE}/homes/${id}?bare`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(5200);

      const stat = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href^="/"]').length;
        const imgs = [...document.querySelectorAll("img")];
        return {
          height: document.body.scrollHeight,
          links,
          imgs: imgs.length,
          brokenImgs: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
          text: (document.body.innerText || "").replace(/\s+/g, " ").trim().length,
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
        };
      });

      const thin = stat.height < viewport.height * 0.9;
      const empty = stat.text < 200 || stat.links < 5;
      const flag = errs.length || empty || thin || stat.overflowX || stat.brokenImgs;
      if (flag) bad++;

      await page
        .screenshot({ path: `${OUT}/${id}-${label}.png`, fullPage: full, timeout: 25000 })
        .catch(() => {});

      console.log(
        `${flag ? "!!" : "ok"} ${id.padEnd(12)} ${label.padEnd(7)} ` +
          `h=${stat.height} links=${stat.links} imgs=${stat.imgs}` +
          (stat.brokenImgs ? ` broken=${stat.brokenImgs}` : "") +
          (stat.overflowX ? " OVERFLOW-X" : "") +
          (thin ? " TOO-SHORT" : "") +
          (empty ? " EMPTY" : "") +
          (errs.length ? ` err="${errs[0]}"` : ""),
      );
    } catch (e) {
      bad++;
      console.log(`!! ${id.padEnd(12)} ${label.padEnd(7)} FAILED ${String(e).split("\n")[0]}`);
    }
    await page.close();
  }
}

console.log(`\n${list.length} themes · ${bad ? `${bad} need a look` : "all clean"} · shots in ${OUT}`);
await browser.close();
if (server) server.kill();
process.exit(0);
