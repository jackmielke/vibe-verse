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
 *
 * The retry covers the `evaluate` calls and it cannot cover the screenshot:
 * a save timed badly enough lands the capture on a page that has reloaded and
 * not yet painted, which comes out as a flat sheet of the renderer's clear
 * colour or of white. Both look exactly like a broken world and neither is.
 * Do not edit while a run is in flight.
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
  /* ---- Mirrorfoot, the camp on the ice ---------------------------------
   *
   * 880 m out on bearing 27°, which is 45° off the sunset — the island reads
   * as a silhouette between gold sky and blue instead of being washed flat by
   * the sun's own disc. All four are given in world coordinates because the
   * camp is at a fixed place, unlike the tower, which is chosen by a rule.
   */
  /* Two traps live down here and both cost a shot before they were written
   * down.
   *
   * **The lens will not go below `supportAt + 1.1`,** and the lake is now a
   * real standable surface rather than the void, so a third-person shot that
   * wants to look *up* from ice level has its lens shoved above the target
   * and photographs the planks. Float the body instead — which is what
   * `under` and `skyline` already do, for the same reason.
   *
   * **First person reverses both signs.** At `dist` 2.2 or under the rig
   * drops the boom and puts the lens on the character's head, where the yaw
   * is the direction you are looking rather than the side the lens sits on,
   * and positive pitch looks UP rather than placing the lens above. So a
   * first-person view is the third-person numbers with `Math.PI` on the yaw
   * and the pitch negated. Written the third-person way, the two below
   * photographed the deck from above and the inside of the rock. Nothing here
   * uses first person now; the note is what it cost to find out. */

  /** The camp from eighty metres out, with the rock hanging over the top. */
  mirrorfoot: { at: [400, 20, 784], look: [0.4713, -0.19], dist: 78 },
  /** Over the Long Look, looking up past it at the island. The whole point. */
  longlook: { at: [388.2, 6, 760.8], look: [0.4713, -0.24], dist: 14 },
  /** The approach: 280 m up and 700 m out, camp below and island above. */
  descent: { at: [491, 236, 964], look: [0.4713, 0.0873], dist: 500 },
  /** Off the rim at deck height, looking down at the camp. Does it read? */
  overrim: { at: [175, 592, 344], look: [3.613, 0.45], dist: 12 },
  /* Standing on the Kestrel's rooftop pad in the Bazaar — the flyer, its
     markings and its light column, with the city behind them. The height is
     the roof of lot b1-0-11 and is not a round number on purpose: it is
     `lot.y + lot.height`, which is where `buildings.ts` puts the deck, and a
     metre either way is a shot of a parapet or of nothing. */
  flypad: { at: [188, 669.3, 56.7], look: [2.0, -0.16], dist: 13 },
  /** Off the Bazaar at roof height, so the pads' light columns line up. */
  flyroofs: { at: [250, 700, 250], look: [Math.PI * 0.78, 0.12], dist: 26 },
  /* ---- The four rooms you can walk into ---------------------------------
   *
   * Given in each room's own frame and resolved in the page from
   * `__empyreanRooms()`, which `interiors.ts` publishes for the same reason the Meridian's five are: every
   * one of these lots is chosen by a rule over the city plan, so a pair of
   * world coordinates here is a photograph of whatever ends up standing there
   * after the next reseed.
   *
   * `lx` is across the room, `lz` is out through its own front door — so a
   * positive `lz` is outside on the pavement and a negative one is at the back
   * wall — and `out: true` faces the street rather than the back of the room.
   *
   * **The boom lands at `lz + (out ? -dist : +dist)`, and that has to still be
   * inside the room.** It is the arithmetic that decides whether a viewpoint
   * is a photograph of a room or of the pavement behind it: the rooms here are
   * nine to nineteen metres deep, and the default eight-and-a-half-metre boom
   * is longer than half of them. The lens height is `ly + 2.6 + sin(pitch) *
   * dist` and wants to stay half a metre clear of the ceiling for the same
   * reason — `camera.ts` aims 2.6 m above the feet and collapses the boom onto
   * that target whenever it is blocked, which indoors is most of the time.
   */

  /** Twelve Anchor Row, from the pavement: the lit flat in the dark block. */
  home: { room: { id: "home", lz: 9.5, ly: 0.2, out: false, pitch: -0.22, dist: 9 } },
  /** Standing in the middle of it, looking at the table and the kitchen. */
  homein: { room: { id: "home", lz: -1.0, ly: 0, out: false, pitch: 0.05, dist: 4.5 } },
  /** From the back of the room looking out of the window at the street. */
  homeout: { room: { id: "home", lx: 0.8, lz: 1.0, ly: 0, out: true, pitch: 0.04, dist: 5.0 } },
  /** The Glasshouse from the door end, down the length of it. */
  glasshouse: { room: { id: "glasshouse", lz: 2.0, ly: 0, out: false, pitch: 0.02, dist: 5 } },
  /** Under the fig, looking up into the vault. */
  glassvault: { room: { id: "glasshouse", lz: -1.0, ly: 0, out: false, pitch: -0.45, dist: 6 } },
  /** The Armature, from just inside the shutter. */
  armature: { room: { id: "armature", lz: 2.5, ly: 0, out: false, pitch: 0.02, dist: 5 } },
  /** At the bench, with the arc and the wall of names. */
  armbench: { room: { id: "armature", lx: 2.0, lz: -1.0, ly: 0, out: false, pitch: 0.0, dist: 4.5 } },
  /** The Rimbath, looking out through the glass wall at the drop. */
  bath: { room: { id: "bath", lx: 0, lz: 1.2, ly: 0, out: true, pitch: 0.06, dist: 3.4 } },
  /** Standing in the water, with the sunset coming in off the rim. */
  bathwater: { room: { id: "bath", lx: -5.0, lz: 0.2, ly: 0.2, out: true, pitch: 0.04, dist: 3.0 } },

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

  /* ---- The ring tram ---------------------------------------------------
   *
   * Both of these are the Launch Terrace stop, at 45 degrees, and both are
   * timed rather than placed: the tram *starts* stood at that platform and
   * dwells there for seven seconds of world time. Under this container's
   * rasteriser that is about three quarters of a minute of wall clock, which
   * is comfortably longer than the boot and the settle above — so the train
   * is in frame. On real hardware it will have left, and the shot is then a
   * perfectly honest photograph of an empty stop.
   *
   * The lens is placed by hand rather than by a viewpoint name because it has
   * to stand off the *track*: the boom sits at target + (sin yaw, cos yaw) *
   * dist, so yaw is the atan2 of the direction from the tram to the camera. */
  /** Alongside the leading car, from the outside of the ring. */
  tram: {
    at: [Math.cos(Math.PI / 4) * 218, 621.4, Math.sin(Math.PI / 4) * 218],
    look: [Math.atan2(Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)), 0.10],
    dist: 11,
  },
  /** Standing on the platform where you wait for it. */
  tramstop: {
    at: [Math.cos(Math.PI / 4) * 212, 620.9, Math.sin(Math.PI / 4) * 212],
    look: [Math.atan2(-Math.cos(Math.PI / 4), -Math.sin(Math.PI / 4)), 0.06],
    dist: 9,
  },

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
/**
 * Turn a room-frame viewpoint into the `at`/`look`/`dist` the rig wants.
 *
 * Same trick as `resolveSpire`, and for the same reason: the only place a
 * room's position is known is the module that chose the lot it stands on.
 * Returns null if the room is gone, which is itself the answer to "did that
 * survive the last change".
 */
function resolveRoom(spec) {
  const hook = window.__empyreanRooms;
  if (typeof hook !== "function") return null;
  const r = hook().find((k) => k.id === spec.id);
  if (!r) return null;
  const s = Math.sin(r.yaw);
  const c = Math.cos(r.yaw);
  const lx = spec.lx ?? 0;
  const lz = spec.lz ?? 0;
  const dx = spec.out ? c : -c;
  const dz = spec.out ? s : -s;
  return {
    at: [r.x + lx * s + lz * c, r.y + (spec.ly ?? 1.0), r.z - lx * c + lz * s],
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
  await page.addInitScript(`window.__resolveRoom = ${resolveRoom.toString()};`);
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
        if (v.room) {
          const r = window.__resolveRoom(v.room);
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
        if (v.room) {
          const r = window.__resolveRoom(v.room);
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
