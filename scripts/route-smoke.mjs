#!/usr/bin/env node
/**
 * route-smoke — open every route in a real browser and check something appears.
 *
 * ## Why this exists
 *
 * `npm run build` will happily ship a route that renders a black screen, and
 * `npm run typecheck` will happily pass a page whose engine throws on its first
 * frame. Both have happened here. The only thing that catches it is opening the
 * route, and there are fifty-odd of them, so nobody opens them all.
 *
 * It matters more now than it used to: every route in `App.tsx` is `lazy()`, so
 * each one is a separate chunk fetched at click time. A route that used to fail
 * loudly at build time — a bad import, a circular dependency — now fails at
 * *navigation* time, in one world, on somebody else's laptop.
 *
 * ## What counts as passing
 *
 * A route passes if, within its budget, the app renders something: a `<canvas>`
 * with pixels in it, or visible text. That is deliberately a low bar. This is
 * not a screenshot test and it will not notice that a world looks wrong — it
 * notices that a world is *not there*, which is the failure that ships.
 *
 * Uncaught page errors are reported alongside the verdict. Some routes log
 * errors and still work (a missing API key, a blocked third party); a route
 * that errors *and* renders nothing is the one to go and look at.
 *
 * ## Usage
 *
 *   node scripts/route-smoke.mjs                 # every route
 *   node scripts/route-smoke.mjs /sf /kart       # just these
 *   SMOKE_WAIT=20000 node scripts/route-smoke.mjs
 *   SMOKE_CHARACTER=flux node scripts/route-smoke.mjs /city
 *
 * `SMOKE_CHARACTER` picks the saved character before the route opens. It
 * matters because half the catalog (`src/lib/characters.ts`) has an empty
 * `url` — those are built in code rather than fetched, on a *synchronous*
 * path no default run ever takes, and a crash there took /city down for
 * everyone who had picked one. Any id from the catalog works; `flux` is the
 * first procedural one.
 *
 * It runs against the dev server on SF_PORT (5177), starting one if there is
 * not already one up — the same convention as `route-shot.mjs`.
 */
import { chromium } from "playwright";
import { summarise } from "./lib/smokeSummary.mjs";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number(process.env.SMOKE_WAIT ?? 12000);
const CHARACTER = process.env.SMOKE_CHARACTER ?? "";

/**
 * Every route the router serves, read out of `App.tsx`.
 *
 * Matching `path="…"` alone would miss most of them: the worlds with aliases
 * are declared by mapping over an array literal, so their routes never appear
 * next to the word `path`. Any quoted string starting with "/" in that file is
 * a route — module specifiers all start with "." or "@". This is the same
 * reading `src/test/worlds-registry.test.ts` does, for the same reason.
 */
function allRoutes() {
  const src = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const found = [...src.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]);
  return [...new Set(found)]
    /* Dynamic segments need a value to be visitable at all. These two are the
       only ones, and both are "does the page survive an id it has never seen",
       which is worth checking on its own. */
    .map((r) => r.replace(":slug", "coin-drop").replace(":code", "SMOKE"))
    .sort();
}

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

const routes = process.argv.slice(2).length ? process.argv.slice(2) : allRoutes();

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
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

const results = [];
for (const route of routes) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  /* Kept apart from the console noise, because they are a different kind of
     thing and only one of them is a verdict.
     
     A `pageerror` is an uncaught exception: some module threw and whatever it
     was building does not exist. A console error is usually a request that
     did not come back, which in this container is the outbound proxy refusing
     Supabase and is not a fault in the world. */
  const thrown = [];
  page.on("pageerror", (e) => {
    const line = String(e.message).split("\n")[0];
    thrown.push(line);
    errors.push(line);
  });
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().split("\n")[0]);
  });

  let verdict = "blank";
  try {
    if (CHARACTER) {
      /* Both keys, because the hook reads the canonical one and City still
         reads the mirror. Written from the origin's own page, since
         localStorage is per-origin and there is nowhere else to put it — and
         from a static file rather than a route, so seeding does not boot the
         whole app (and log a 404) before the run has started. */
      await page.goto(`${BASE}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.evaluate((id) => {
        localStorage.setItem("lobby.character", id);
        localStorage.setItem("city.character", id);
      }, CHARACTER);
    }
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    /* Most worlds gate their first frame behind a gesture — a title screen, a
       pointer-lock prompt. One click is the difference between "renders" and
       "renders a menu", and both count, but the click gets more of them past
       the menu and into the actual scene. */
    await page.mouse.click(640, 400).catch(() => {});

    const deadline = Date.now() + WAIT;
    while (Date.now() < deadline) {
      const state = await page
        .evaluate(() => {
          const root = document.getElementById("root");
          const text = (root?.innerText ?? "").trim();
          const canvas = document.querySelector("canvas");
          return {
            text: text.length,
            canvas: canvas ? canvas.width * canvas.height : 0,
            crash: document.querySelector("[data-vibe-crash]")?.getAttribute("data-vibe-crash") ?? "",
          };
        })
        .catch(() => ({ text: 0, canvas: 0, crash: "" }));
      /* The crash screen is text and it is on top of everything, so without
         this it scores as a pass. It is also the *worst* verdict — a blank
         route might still be loading; this one has already given up. */
      if (state.crash) {
        verdict = `crash:${state.crash}`;
        break;
      }
      if (state.canvas > 0) {
        verdict = "canvas";
        break;
      }
      if (state.text > 0) {
        verdict = "text";
        /* Text is enough, but a world that is about to raise a canvas usually
           shows a title card first — keep waiting a little for the better
           answer rather than reporting the loading screen. */
        if (Date.now() > deadline - WAIT * 0.35) break;
      }
      await page.waitForTimeout(500);
    }
  } catch (e) {
    errors.push(`navigation: ${String(e.message).split("\n")[0]}`);
  }

  /* An uncaught exception is a failure even when a canvas got raised.
   *
   * This is here because of a real one. A half-written module was committed
   * and pushed to a branch that deploys; `/empyrean` threw
   * `flyerParts is not defined` out of its vehicle builder before the world
   * finished booting — and smoke reported `ok /empyrean canvas`, because the
   * renderer had already appended its canvas by the time the throw happened.
   * A canvas is evidence that something started, not that anything works.
   *
   * The verdict keeps the render result as well, because "threw, and also
   * never drew" and "threw, but drew" are different bugs. */
  if (thrown.length) verdict = `threw:${verdict}`;
  results.push({ route, verdict, errors: [...new Set(errors)] });
  const mark =
    verdict === "blank" || verdict.startsWith("crash") || verdict.startsWith("threw")
      ? "FAIL"
      : "ok  ";
  console.log(
    `${mark} ${route.padEnd(26)} ${verdict}${
      results.at(-1).errors.length ? `  (${results.at(-1).errors.length} console errors)` : ""
    }`,
  );
  await page.close();
}

await browser.close();
if (server) server.kill();

const summary = summarise(results);
console.log(`\n${summary.headline}`);
for (const line of summary.detail) console.log(`   ${line}`);
for (const r of results.filter((x) => x.errors.length)) {
  console.log(`\n${r.route} [${r.verdict}]`);
  for (const e of r.errors.slice(0, 4)) console.log(`   ${e}`);
}
process.exit(summary.exitCode);
