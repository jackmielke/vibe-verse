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

/**
 * Every `page.evaluate` here can lose its execution context, and it is not a
 * flake: the dev server is watching the same files you are editing, so a save
 * during a capture run triggers an HMR reload and destroys the context out
 * from under the very next call. Retrying once against the reloaded page is
 * the whole fix; without it a twenty-minute run over nine viewpoints dies on
 * whichever one happened to be open when you hit save.
 */
async function evalSafe(page, fn, arg, settle = 3000) {
  try {
    return await page.evaluate(fn, arg);
  } catch (e) {
    if (!/context was destroyed|Target closed|Execution context/i.test(String(e))) throw e;
    await page.waitForTimeout(settle);
    try {
      return await page.evaluate(fn, arg);
    } catch {
      return null;
    }
  }
}

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number(process.env.EMP_WAIT ?? 26000);
const DAY = process.env.EMP_DAY;
const CHAR = process.env.EMP_CHAR ?? "";
const WEATHER = process.env.EMP_WEATHER;
/** Comma-separated system names to hide, for bisecting an occlusion. */
const HIDE = process.env.EMP_HIDE;
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
  /* Aiming, which is the whole trick.
   *
   * `look[0]` is the camera's yaw, and the rig puts the lens at
   * `target + (sin(yaw), cos(yaw)) * dist` looking back at the target — so to
   * look INWARD from a point, yaw is `atan2(x, z)` of that point. `look[1]` is
   * pitch, and it is positive DOWNWARD: negative pitch puts the lens below the
   * target and looks up.
   *
   * Both of those were wrong in the first table and it cost an hour of
   * diagnosing a bug that was not there. Standing at the foot of a
   * three-hundred-metre tower looking level shows you a wall; a tower at 78 m
   * range subtends 77 degrees, so a level shot of the Spires is a shot of
   * their plinths and nothing else.
   */

  /** On the Halo, looking up the north avenue at the Beacon. */
  plaza: { at: [0, 621, 86], look: [0, -0.42], dist: 11 },
  /** Eye level on a Bazaar avenue, looking in. The ground-truth street shot. */
  bazaar: { at: [178, 621, 0], look: [Math.PI / 2, -0.05], dist: 3.2 },
  /** On the market ring road, looking along it. */
  ring: { at: [119.5, 621, 69], look: [2.618, -0.12], dist: 5 },
  /** Under the towers of the core, looking straight up them. */
  spires: { at: [0, 621, 100], look: [0, -0.85], dist: 6 },
  /** The west avenue's end at the rim, looking back up it at the city.
      Not the Observatory: r=306 on that bearing is the *middle* of it, and
      this used to be a very nice photograph of the inside of its staircase. */
  rim: { at: [-330, 621, 0], look: [-Math.PI / 2, 0.16], dist: 8 },
  /** The first promenade ring, under the overhang. r must be inside the
      ring's own 7 m band (341–348) and y a metre above its deck; at 352/598
      this hung in the step face between two rings, photographing a fascia
      from a foot away. The rings moved when the skirt was halved. */
  promenade: { at: [-344, 605, 0], look: [0, 0.02], dist: 3 },
  /** The whole skyline from off the south rim, at deck height. */
  skyline: { at: [0, 700, 640], look: [0, 0.05], dist: 18 },
  /** High and outside, looking down the avenues at the plan. */
  air: { at: [430, 1010, 430], look: [Math.PI / 4, 0.36], dist: 22 },
  /** Outside the rock and below the rim, looking up at the keel. At 300,300
      this was *inside* the rock — the whole frame was one unlit flank. */
  under: { at: [0, 250, 700], look: [0, -0.34], dist: 20 },
  /** On the ice, looking back up at the whole thing. */
  ice: { at: [0, 3, 1250], look: [0, -0.30], dist: 30 },
  /* Standing on the Kestrel's rooftop pad in the Bazaar — the flyer, its
     markings and its light column, with the city behind them. The height is
     the roof of lot b1-0-11 and is not a round number on purpose: it is
     `lot.y + lot.height`, which is where `buildings.ts` puts the deck, and a
     metre either way is a shot of a parapet or of nothing. */
  flypad: { at: [188, 669.3, 56.7], look: [2.0, -0.16], dist: 13 },
  /** Off the Bazaar at roof height, so the pads' light columns line up. */
  flyroofs: { at: [250, 700, 250], look: [Math.PI * 0.78, 0.12], dist: 26 },
  /* ---- The Meridian ----------------------------------------------------
   *
   * The one tower you can go inside. These five are given in the *tower's*
   * own frame rather than in world coordinates, and resolved in the page from
   * `__empyreanLift.plan()`, because the tower is chosen from the city plan
   * by a rule ("the tallest tower whose footprint will hold a lobby") and
   * moves the moment that plan is reseeded. A hardcoded pair of coordinates
   * here is a photograph of whatever ended up standing there instead.
   *
   * `lx` is across the front, `lz` is out through the front door, `ly` is
   * above the lobby floor, and `out: true` faces the street rather than the
   * back of the room. `lift` puts the car at a height first — there is no
   * other way to photograph a car halfway up a three-hundred-metre shaft on a
   * rasteriser that draws one frame a second.
   */

  /** The front door, from the pavement. */
  meridian: { spire: { lx: 0, lz: 21, ly: 1.0, out: false, pitch: -0.30, dist: 9 } },
  /** Inside the lobby, looking back at the reception desk. */
  lobby: { spire: { lx: 0, lz: 6.5, ly: 0.6, out: false, pitch: 0.02, dist: 5.5 } },
  /** In the car, halfway up, with the city going by. */
  lift: { spire: { bay: true, ly: 150, out: true, pitch: 0.08, dist: 4.0, lift: 150 } },
  /** On the sky deck, looking out over the Spires. */
  skydeck: { spire: { deck: true, ly: "deck", out: true, pitch: -0.10, dist: 8 } },
  /** Standing on the glass floor, looking straight down at the street. */
  glassfloor: { spire: { ledge: true, ly: "deck", out: true, pitch: 0.70, dist: 4 } },

  /** The card composition, from the shot-mode camera. */
  card: null,
};

/**
 * Turn a tower-frame viewpoint into the `at`/`look`/`dist` the rig wants.
 *
 * Runs in the page, because the only place the tower's position is known is
 * the module that chose it. Returns null if the tower is not there, which is
 * itself the answer to "did the lift survive the last change".
 */
function resolveSpire(spec) {
  const hook = window.__empyreanLift;
  if (!hook) return null;
  const p = hook.plan();
  const s = Math.sin(p.yaw);
  const c = Math.cos(p.yaw);
  let lx = spec.lx ?? 0;
  let lz = spec.lz ?? 0;
  if (spec.bay) {
    lx = p.bay.cx;
    lz = p.bay.cz;
  } else if (spec.deck) {
    lx = p.deck.cx;
    lz = p.deck.cz - p.deck.hz + 3.0;
  } else if (spec.ledge) {
    lx = p.ledge.cx;
    lz = p.ledge.cz;
  } else {
    lx += p.lobby.cx;
  }
  const ly = spec.ly === "deck" ? p.deckY : spec.ly;
  if (spec.lift !== undefined) hook.set(spec.lift);
  // The lens sits behind whichever way the body is facing.
  const dx = spec.out ? c : -c;
  const dz = spec.out ? s : -s;
  return {
    at: [p.x + lx * s + lz * c, p.y + ly, p.z - lx * c + lz * s],
    look: [Math.atan2(-dx, -dz), spec.pitch ?? 0],
    dist: spec.dist ?? 6,
  };
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
  /* The tower-frame resolver, installed in the page rather than serialised
   * into each evaluate. `new Function` on a stringified function survives
   * neither a minifier nor a page that has reloaded under you, and the second
   * of those happens here every time Vite re-optimises a dependency. */
  await page.addInitScript(`window.__resolveSpire = ${resolveSpire.toString()};`);
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
    /* Click until the world is actually up, not once and hope.
     *
     * One click plus a fixed wait photographs the title card perhaps a third
     * of the time under load: the button can be clicked before its handler is
     * attached, the dynamic import of the engine takes as long as it takes on
     * a software rasteriser, and a blocked character fetch can stall the boot
     * past any fixed timeout. The world publishes `window.__empyrean` at the
     * end of its constructor, so that is the thing to wait for — and a shot of
     * the menu is worse than a slow shot, because it looks like a finished
     * frame of a world that is not there. */
    let up = false;
    for (let attempt = 0; attempt < 6 && !up; attempt++) {
      await page
        .getByText("Arrive", { exact: false })
        .first()
        .click({ timeout: 20000 })
        .catch(() => {});
      const deadline = Date.now() + WAIT;
      while (Date.now() < deadline) {
        up = await page.evaluate(() => typeof window.__empyrean === "object").catch(() => false);
        if (up) break;
        await page.waitForTimeout(1500);
      }
    }
    if (!up) {
      // Loud, and on stderr: a menu photographed as if it were the world is
      // the single most misleading artefact this script can produce.
      console.error(`!! ${name}: the world never came up — THIS SHOT IS THE MENU`);
    }
    // Built, but not settled: the city is still compiling shaders and the
    // crowd has not yet found the pavement.
    await page.waitForTimeout(6000);
  } else {
    // The capture camera boots itself; there is nothing to click.
    await page.waitForTimeout(WAIT);
  }

  if (view !== null) {
    await evalSafe(
      page,
      ([v, day, wx, hide]) => {
        const d = window.__empyrean;
        if (!d) return;
        if (v.spire) {
          const r = window.__resolveSpire(v.spire);
          if (!r) return;
          Object.assign(v, r);
        }
        // Freeze first, warp second. Gravity undoes a warp in about a second
        // and a half, which is why every aerial viewpoint used to be a
        // photograph of the pavement the player landed on.
        d.freeze(true);
        d.warp(v.at[0], v.at[1], v.at[2]);
        d.look(v.look[0], v.look[1]);
        d.dist(v.dist);
        if (day !== undefined) d.day(Number(day));
        if (wx !== undefined) d.weather(wx === "auto" ? null : wx);
        if (hide) for (const n of hide.split(",")) d.hide(n.trim(), false);
      },
      [view, DAY, WEATHER, HIDE],
      WAIT / 2,
    );
    // Settle: the camera eases, the crowd repaths, the shadows refit.
    await page.waitForTimeout(6000);
    // …and re-assert the pose, in case anything moved it while it settled.
    await evalSafe(
      page,
      (v) => {
        const d = window.__empyrean;
        if (!d) return;
        if (v.spire) {
          const r = window.__resolveSpire(v.spire);
          if (r) Object.assign(v, r);
        }
        if (!v.at) return;
        d.warp(v.at[0], v.at[1], v.at[2]);
        d.look(v.look[0], v.look[1]);
        d.dist(v.dist);
      },
      view,
    );
    await page.waitForTimeout(2500);
  } else if (DAY !== undefined) {
    await evalSafe(page, (day) => window.__empyrean?.day(Number(day)), DAY);
    await page.waitForTimeout(4000);
  }

  const counts = await evalSafe(page, () => window.__empyrean?.counts?.() ?? null);
  const state = await evalSafe(page, () => window.__empyrean?.state?.() ?? null);

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
