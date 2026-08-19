#!/usr/bin/env node
/**
 * empyrean-shot — photograph The Empyrean from a named place, at a named hour.
 *
 * `route-shot.mjs` is the blunt instrument for every route in the repo: boot
 * it, click something, wait, grab the frame. That is the right tool for a card
 * and the wrong one for building a city, because the thing you need forty
 * times a day is "show me the Bazaar at eye level at dusk" and there is no
 * combination of a click and a mouse drag that gets you there.
 *
 * This drives the world's own debug hooks instead — `__empyrean.warp`,
 * `.look`, `.zoom`, `.day` — so a viewpoint is three numbers in a table below
 * rather than a sequence of synthetic inputs that stops working the moment the
 * camera is retuned.
 *
 * It also prints `__empyrean.counts()`: draw calls, triangles, programs and
 * the collision totals. Those are exact even under SwiftShader — they are what
 * the page asked the driver to do — so they are the numbers to optimise
 * against, unlike frame rate, which in this container is meaningless.
 *
 * ## Usage
 *
 *   node scripts/empyrean-shot.mjs                       # every viewpoint
 *   node scripts/empyrean-shot.mjs plaza                 # one
 *   node scripts/empyrean-shot.mjs plaza out.jpg         # …to a path
 *   EMP_DAY=0.05 node scripts/empyrean-shot.mjs bazaar   # …at night
 *   EMP_CHAR=flux node scripts/empyrean-shot.mjs plaza   # …as somebody else
 *   EMP_WAIT=40000 node scripts/empyrean-shot.mjs        # slower machines
 *
 * The shots land in `.shots/` by default, which is gitignored.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number(process.env.EMP_WAIT ?? 26000);
const DAY = process.env.EMP_DAY;
const CHAR = process.env.EMP_CHAR ?? "";
const OUT_DIR = process.env.EMP_DIR ?? ".shots";

/**
 * The viewpoints.
 *
 * `at` is where the body is put, `look` is [yaw, pitch] for the camera rig,
 * and `dist` is the boom length — 2.2 or below is first person, which is what
 * you want for anything about how the ground reads under your feet.
 *
 * The city deck is at y=620 and 340 m across; the Beacon is at the origin.
 */
const VIEWS = {
  /** Standing on the Halo, looking up the north avenue at the Beacon. */
  plaza: { at: [0, 621, 78], look: [0, 0.06], dist: 9 },
  /** Eye level in a Bazaar street: the test of whether the ground is real. */
  bazaar: { at: [-120, 621, 118], look: [2.35, 0.02], dist: 2.2 },
  /** A pavement in the core, looking up between the towers. */
  spires: { at: [0, 621, 96], look: [0, -0.55], dist: 4 },
  /** The rim by the Observatory, looking out over the edge. */
  rim: { at: [0, 621, -300], look: [Math.PI, 0.1], dist: 7 },
  /** The promenade one deck down, under the overhang. */
  promenade: { at: [0, 599, 352], look: [0.9, 0.05], dist: 6 },
  /** Three hundred metres up, looking down the avenues. */
  air: { at: [180, 900, 180], look: [-2.35, 0.62], dist: 14 },
  /** Under the keel, looking up at the city through the stalactites. */
  under: { at: [0, 300, 260], look: [0, -0.85], dist: 12 },
  /** On the ice, looking back up at the whole thing. */
  ice: { at: [0, 2, 1200], look: [0, -0.42], dist: 26 },
  /** The card composition, from the shot-mode camera. */
  card: null,
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

const args = process.argv.slice(2);
const names = args.length && VIEWS[args[0]] !== undefined ? [args[0]] : Object.keys(VIEWS);
const explicitOut = args[1];

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

mkdirSync(OUT_DIR, { recursive: true });

for (const name of names) {
  const view = VIEWS[name];
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`PAGEERROR ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/ERR_TUNNEL|ERR_CONNECTION|favicon/.test(t)) {
      errs.push(`console ${t}`);
    }
  });
  if (CHAR) {
    await page.addInitScript((c) => {
      try {
        localStorage.setItem("lobby.character", c);
      } catch {
        /* private mode is not an error */
      }
    }, CHAR);
  }

  // `card` uses the world's own capture camera; everything else is the real
  // playable world driven to a place.
  const url = view === null ? `${BASE}/empyrean?shot=1` : `${BASE}/empyrean`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });

  if (view !== null) {
    await page
      .getByText("Arrive", { exact: false })
      .first()
      .click({ timeout: 60000 })
      .catch(() => console.log(`${name}: no Arrive button — the shot may be a menu`));
  }

  // The world builds a city on the main thread; give it real time under a
  // software rasteriser before asking it to do anything.
  await page.waitForTimeout(WAIT);

  if (view !== null) {
    await page.evaluate(
      ([v, day]) => {
        const d = window.__empyrean;
        if (!d) return;
        d.warp(v.at[0], v.at[1], v.at[2]);
        d.look(v.look[0], v.look[1]);
        // zoom() takes a wheel delta; solve for the boom length we want.
        for (let i = 0; i < 60; i++) d.zoom(v.dist > 9 ? 60 : -60);
        if (day !== undefined) d.day(Number(day));
      },
      [view, DAY],
    );
    // Settle: the camera eases, the crowd repaths, the shadows refit.
    await page.waitForTimeout(6000);
  } else if (DAY !== undefined) {
    await page.evaluate((day) => window.__empyrean?.day(Number(day)), DAY);
    await page.waitForTimeout(4000);
  }

  const counts = await page.evaluate(() => window.__empyrean?.counts?.() ?? null);
  const state = await page.evaluate(() => window.__empyrean?.state?.() ?? null);

  const out =
    explicitOut && names.length === 1
      ? explicitOut
      : `${OUT_DIR}/${name}${DAY !== undefined ? `-d${DAY}` : ""}.jpg`;
  writeFileSync(out, await page.screenshot({ type: "jpeg", quality: 88 }));

  console.log(
    `${name.padEnd(10)} → ${out}` +
      (counts ? `  draws ${counts.calls} tris ${(counts.tris / 1000).toFixed(0)}k progs ${counts.programs}` : "") +
      (state ? `  on ${state.surface} @ ${state.place}` : ""),
  );
  if (errs.length) console.log(`  errors: ${errs.slice(0, 4).join(" | ")}`);
  await page.close();
}

await browser.close();
if (server) server.kill();
