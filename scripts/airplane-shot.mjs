#!/usr/bin/env node
/**
 * airplane-shot — drive Flight 209 headless and write review frames.
 *
 * The blunt `route-shot` harness cannot photograph this world usefully. The
 * frames worth looking at are eight kilometres down the approach with the
 * runway in the windshield, and no amount of waiting at the spawn point
 * produces one. So this boots the route in `?shot=1`, steps the engine
 * deterministically, poses the aeroplane at named points on the approach, and
 * shoots.
 *
 * It also **refuses to write a blank frame**. On the software rasteriser a
 * lost context or a shader that failed to compile produces a perfectly
 * plausible black PNG, and a black PNG committed as card art is worse than no
 * card art at all. That check is the whole reason this file exists rather than
 * a one-liner with Playwright.
 *
 * Usage:
 *   node scripts/airplane-shot.mjs shots/x.png --pose final
 *   node scripts/airplane-shot.mjs shots/gallery.png --all
 *   node scripts/airplane-shot.mjs src/assets/worlds/airplane.jpg --pose card --jpeg
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const out = args[0] ?? "shots/airplane.png";
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const poseName = flag("pose", "card");
const size = flag("size", "1280x720").split("x").map(Number);
const jpeg = has("jpeg") || out.endsWith(".jpg");
const showUi = has("ui");
const PORT = Number(process.env.SF_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;

/** Field elevation, so poses can be written in feet above the airport. */
const FIELD = 204.8;
const FT = 0.3048;

/**
 * Named viewpoints. `place` puts the aeroplane somewhere on the approach and
 * lets the game's own camera rig frame it, which is deliberate: a harness that
 * poses its own camera can produce a beautiful frame from a rig that is broken
 * in the actual game.
 */
const POSES = {
  // The card: four miles out, just under the cloud base, runway in the
  // windshield with Chicago beyond it. Answers "where is this?" before it
  // answers "what is this?".
  // Note the altitude: the overcast base is 1,000 ft above the field, so any
  // pose higher than that is inside cloud and photographs as grey. On a 3°
  // slope you break out at about 3.5 km from the threshold, and that is where
  // these live.
  card: {
    rig: "cockpit",
    place: { x: -3900, alt: FIELD + 660 * FT, z: 0, ias: 75, flap: 4, gear: true },
    warm: 90,
  },
  // The same moment from outside, which is the one that shows the aeroplane.
  chase: {
    rig: "chase",
    place: { x: -4600, alt: FIELD + 780 * FT, z: 20, ias: 76, flap: 4, gear: true },
    warm: 120,
  },
  // Breaking out of the overcast with the approach lights ahead.
  breakout: {
    rig: "cockpit",
    place: { x: -2400, alt: FIELD + 430 * FT, z: 8, ias: 74, flap: 4, gear: true },
    warm: 60,
  },
  // Over the threshold, in the flare.
  flare: {
    rig: "cockpit",
    place: { x: -120, alt: FIELD + 40 * FT, z: 0, ias: 72, flap: 4, gear: true },
    warm: 30,
  },
  // On top at 29,000 feet, above the storm, before anything has gone wrong.
  cruise: {
    rig: "cockpit",
    place: { x: -78000, alt: 8800, z: 12000, ias: 138, flap: 0, gear: false },
    warm: 90,
  },
  // The same, from outside, in the moonlight over the cloud tops.
  cruiseChase: {
    rig: "chase",
    place: { x: -78000, alt: 8800, z: 12000, ias: 138, flap: 0, gear: false },
    warm: 140,
  },
  // Inside the weather, where the world is grey and the panel is everything.
  weather: {
    rig: "cockpit",
    place: { x: -30000, alt: 2600, z: 3000, ias: 105, flap: 1, gear: false },
    warm: 90,
  },
  // The tower's view of 209 on short final.
  tower: {
    rig: "tower",
    place: { x: -2200, alt: FIELD + 420 * FT, z: 0, ias: 74, flap: 4, gear: true },
    warm: 60,
  },
  // A strike, caught deliberately rather than by accident.
  strike: {
    rig: "chase",
    place: { x: -26000, alt: 3000, z: 2600, ias: 110, flap: 0, gear: false },
    warm: 120,
    flash: 1,
  },
  // The cabin, looking out at a wing in a thunderstorm.
  cabin: {
    rig: "cabin",
    place: { x: -20000, alt: 3000, z: 2000, ias: 110, flap: 0, gear: false },
    warm: 90,
  },
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

const server = (await up(BASE, 1200))
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
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
const logs = [];
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`);
});

const quality = flag("quality", "");
await page.goto(`${BASE}/airplane?shot=1${quality ? `&q=${quality}` : ""}`, {
  waitUntil: "domcontentloaded",
  timeout: 120000,
});
await page.waitForFunction(() => window.__flight209Ready === true, { timeout: 180000 });

// Take the wheel. The page runs its own requestAnimationFrame loop, and if it
// keeps running while the harness places an aeroplane the aeroplane simply
// flies out of the frame between two calls. Everything from here is driven by
// explicit step() calls, which also makes every frame reproducible.
await page.evaluate(() => window.__flight209.stop());
if (!showUi) await page.addStyleTag({ content: "[data-209-ui]{display:none !important}" });

async function step(frames, { dt = 1 / 60, draw = false } = {}) {
  await page.evaluate(
    ([n, d, r]) => {
      const e = window.__flight209;
      for (let i = 0; i < n; i++) e.step(d, r);
    },
    [frames, dt, draw],
  );
}

async function shoot(name, pose) {
  await page.evaluate((p) => {
    const svc = window.__flight209.ctx.services;
    if (p.place) {
      svc.flight.place({
        position: { x: p.place.x, y: p.place.alt, z: p.place.z, isVector3: true },
        heading: Math.PI / 2,
        ias: p.place.ias,
        flapIndex: p.place.flap,
        gearDown: p.place.gear,
      });
      // `place` wants a real Vector3; rebuild it inside the page.
      const THREEVec = svc.flight.state.position.constructor;
      svc.flight.place({
        position: new THREEVec(p.place.x, p.place.alt, p.place.z),
        heading: Math.PI / 2,
        ias: p.place.ias,
        flapIndex: p.place.flap,
        gearDown: p.place.gear,
      });
      svc.flight.state.flapAngle = [0, 14, 25, 30, 40, 50][p.place.flap];
    }
    svc.camera.release();
    svc.camera.setMode(p.rig, { snap: true });
  }, pose);

  // Warm up blind — on SwiftShader a drawn frame costs the better part of a
  // second and a simulated one costs a millisecond.
  await step(pose.warm ?? 60, { draw: false });

  // Freeze the lightning.
  //
  // Strikes arrive on a Poisson process several times a minute, so without
  // this the same pose photographs completely differently from one run to the
  // next and about one frame in six comes out as a white rectangle — which is
  // indistinguishable from a broken shader, and cost an hour of looking for
  // one that was not there.
  //
  // Note that zeroing the uniform is not enough: the sky system rewrites it
  // from its own decay curve on the very next step, so the strike *generator*
  // has to be stubbed out and the live flash allowed to decay first.
  await page.evaluate((flash) => {
    const svc = window.__flight209.ctx.services;
    if (flash > 0) {
      svc.sky.strike(flash);
    } else {
      svc.sky.strike = () => {};
    }
  }, pose.flash ?? 0);
  // A second of simulated time is four times the length of a flash.
  if (!pose.flash) await step(60, { draw: false });
  await step(4, { draw: true });
  return page.screenshot({ type: jpeg ? "jpeg" : "png", quality: jpeg ? 92 : undefined });
}

/** Is there actually a picture here, or did a shader fail and leave black? */
const health = () =>
  page.evaluate(() => {
    const e = window.__flight209;
    const gl = e.ctx.renderer.getContext();
    if (gl.isContextLost && gl.isContextLost()) return { lost: true, max: 0, mean: 0, spread: 0 };
    const c = e.ctx.renderer.domElement;
    const t = document.createElement("canvas");
    t.width = 64;
    t.height = 36;
    const g = t.getContext("2d");
    g.drawImage(c, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let max = 0;
    let sum = 0;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (l > max) max = l;
      if (l > 8) lit++;
      sum += l;
    }
    return { lost: false, max, mean: sum / (d.length / 4), spread: lit / (d.length / 4) };
  });

const write = (file, buf) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
};

const names = has("all") ? Object.keys(POSES) : [poseName];
let failures = 0;

for (const name of names) {
  const pose = POSES[name];
  if (!pose) {
    console.error(`unknown pose "${name}". Known: ${Object.keys(POSES).join(", ")}`);
    process.exit(2);
  }
  const buf = await shoot(name, pose);
  const h = await health();
  const file = names.length > 1 ? out.replace(/(\.\w+)$/, `-${name}$1`) : out;

  // This world is genuinely dark — it is a night flight — so the threshold is
  // on the *brightest* pixel and on how much of the frame is lit at all,
  // rather than on mean luminance, which a correct night frame fails.
  const ok = !h.lost && h.max > 24 && h.spread > 0.004;
  console.log(
    `${name.padEnd(12)} max=${h.max.toFixed(1)} mean=${h.mean.toFixed(2)} lit=${(h.spread * 100).toFixed(1)}% ${ok ? "OK" : "BLANK"} -> ${file}`,
  );
  if (!ok) {
    failures++;
    console.error(`  refusing to write a blank frame for "${name}"`);
    continue;
  }
  write(file, buf);
}

if (logs.length) {
  console.log("\n--- page log ---");
  for (const l of logs.slice(0, 40)) console.log(l);
}

await browser.close();
server?.kill();
process.exit(failures ? 1 : 0);
