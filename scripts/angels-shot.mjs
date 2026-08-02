#!/usr/bin/env node
/**
 * angels-shot — drive Blue Angels headless and write review frames.
 *
 * The blunt `route-shot` harness cannot photograph this world usefully: the
 * interesting frames are 3 km up over Lake Washington with the Diamond in
 * shot, and no amount of waiting at the spawn point produces one. So this
 * boots the route in `?shot=1`, steps the engine deterministically, and poses
 * the camera at named viewpoints.
 *
 * It also refuses to write a blank frame. On the software rasteriser a lost
 * context or a failed shader produces a perfectly plausible black JPEG, and a
 * black JPEG that gets committed as card art is worse than no card art.
 *
 * Usage:
 *   node scripts/angels-shot.mjs shots/x.png --pose lake --warm 300
 *   node scripts/angels-shot.mjs shots/gallery.png --all
 *   node scripts/angels-shot.mjs src/assets/worlds/blue-angels.jpg --pose card --jpeg
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const out = args[0] ?? "shots/angels.png";
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const poseName = flag("pose", "card");
const warm = Number(flag("warm", 240));
const size = flag("size", "1280x720").split("x").map(Number);
const jpeg = has("jpeg") || out.endsWith(".jpg");
const showHud = has("hud");
const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Named viewpoints, in lat/lon so they can be checked against a map.
 * `from` is the camera, `to` is what it looks at; `follow` aims at the player
 * instead, which is what you want for anything with a jet in it.
 */
const POSES = {
  // Jet shots use the game's own camera rigs rather than a hand-rolled offset.
  // That is deliberate: a harness that poses its own camera can produce a
  // beautiful frame from a rig that is broken in the actual game.
  // The card: run in over Elliott Bay with the skyline dead ahead, so the
  // frame answers "where is this?" before it answers "what is this?".
  // The card runs the *northbound* leg of the show line. Southbound puts the
  // afternoon sun straight down the lens and the jets come out as pale blue
  // silhouettes in a white haze; turned around, the same light is over your
  // right shoulder and the Diamond reads.
  card: { rig: "chase", jet: true, warm: 900, smoke: true, place: [47.541, -122.259, 520, 340, 210] },
  chase: { rig: "chase", jet: true, warm: 300 },
  cockpit: { rig: "cockpit", jet: true, warm: 300 },
  wing: { rig: "wing", jet: true, warm: 300 },
  tower: { rig: "tower", jet: true, warm: 300 },
  lake: { from: [47.545, -122.235, 900], to: [47.6, -122.31, 300] },
  downtown: { from: [47.585, -122.36, 700], to: [47.61, -122.335, 180] },
  needle: { from: [47.6155, -122.3585, 260], to: [47.6205, -122.3494, 150] },
  rainier: { from: [47.5, -122.2, 4200], to: [46.86, -121.77, 3000] },
  bridges: { from: [47.605, -122.31, 900], to: [47.59, -122.268, 20] },
  sound: { from: [47.63, -122.34, 1600], to: [47.62, -122.46, 100] },
  cut: { from: [47.6465, -122.315, 120], to: [47.647, -122.296, 30] },
  bfi: { from: [47.552, -122.315, 500], to: [47.528, -122.3, 20] },
  // The Seafair course itself: hydroplanes, log booms and the spectator fleet.
  hydro: { from: [47.5735, -122.2695, 90], to: [47.5665, -122.2625, 5] },
};

const M_LAT = 111182.5;
const M_LON = 75128.0;
const O_LAT = 47.6062;
const O_LON = -122.3321;
const world = ([lat, lon, alt]) => [(lon - O_LON) * M_LON, alt, -(lat - O_LAT) * M_LAT];

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
await page.goto(`${BASE}/blue-angels?shot=1${quality ? `&q=${quality}` : ""}`, {
  waitUntil: "domcontentloaded",
  timeout: 120000,
});
await page.waitForFunction(() => window.__angelsReady === true, { timeout: 180000 });

// Take the wheel. The page starts its own requestAnimationFrame loop, and if it
// keeps running while the harness poses a camera the jet simply flies out of
// frame between the two calls — at 230 m/s a quarter of a second is sixty
// metres. Everything from here is driven by explicit `step()` calls, which also
// makes every frame reproducible.
await page.evaluate(() => window.__angels.stop());
if (!showHud) {
  await page.addStyleTag({ content: "[data-angels-hud]{display:none !important}" });
}

/**
 * Step the engine forward without waiting for real time to pass.
 *
 * `draw: false` simulates without rendering — on SwiftShader a drawn frame of
 * this world costs seconds and a simulated one costs a millisecond, so the
 * warm-up runs blind and only the last few frames are painted.
 */
async function step(frames, { dt = 1 / 60, draw = false } = {}) {
  await page.evaluate(
    ([n, d, r]) => {
      const e = window.__angels;
      for (let i = 0; i < n; i++) e.step(d, r);
    },
    [frames, dt, draw],
  );
}

async function shoot(name, pose, file) {
  await page.evaluate((p) => {
    const cam = window.__angels.ctx.services.camera;
    if (p.rig) {
      cam.release();
      cam.setMode(p.rig, { snap: true });
    } else {
      cam.pose(p.fromW, p.toW);
    }
  }, pose);

  // A few drawn frames: the rigs smooth toward their target and the first
  // frame after a snap is still settling.
  await step(3, { draw: true });
  const png = await page.screenshot();
  return { name, png, file };
}

const health = async () =>
  page.evaluate(() => {
    const e = window.__angels;
    const gl = e.ctx.renderer.getContext();
    if (gl.isContextLost && gl.isContextLost()) return { lost: true, max: 0, mean: 0 };
    const c = e.ctx.renderer.domElement;
    const t = document.createElement("canvas");
    t.width = 64;
    t.height = 36;
    const g = t.getContext("2d");
    g.drawImage(c, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (l > max) max = l;
      sum += l;
    }
    return { lost: false, max, mean: sum / (d.length / 4) };
  });

// Warm up: let the boot settle and the jets fly a little so the smoke trails
// and the formation are actually established.
await page.evaluate(() => {
  const e = window.__angels;
  const fleet = e.ctx.services.fleet;
  fleet.setWingmanCount(5);
  fleet.all.forEach((a) => {
    a.smoke = true;
    a.controls.smoke = true;
  });
  e.ctx.input.throttle = 0.8;
});
await step(warm);

// ---------------------------------------------------------------------------
// Hangar portraits
// ---------------------------------------------------------------------------
//
// One three-quarter view of each aircraft against clean sky, for the jet
// picker. They are real renders of the same meshes you fly, which is the whole
// point: the picker promises seven different aeroplanes and the pictures have
// to be able to back that up.
if (has("portraits")) {
  const jets = await page.evaluate(() => window.__angels.ctx.services.fleet.all.length && null);
  void jets;
  const ids = ["superhornet", "hornet", "skyhawk", "phantom", "tiger", "panther", "albert"];
  mkdirSync(out, { recursive: true });

  for (const id of ids) {
    await page.evaluate((jetId) => {
      const e = window.__angels;
      const fleet = e.ctx.services.fleet;
      const cam = e.ctx.services.camera;
      cam.release();
      fleet.setJet(jetId);
      fleet.setWingmanCount(0);
      // High over the Sound, pointed south-west so the afternoon sun rakes
      // across the nose rather than flattening it.
      // High over Puget Sound, pointed south-west. High enough that the
      // horizon sits low in frame, so the aeroplane is read against sky.
      fleet.place({ x: -16000, y: 6200, z: -1000 }, 215, 230);
      for (const a of fleet.all) {
        a.smoke = false;
        a.controls.smoke = false;
      }
      for (let i = 0; i < 240; i++) e.step(1 / 120, false);
    }, id);

    await page.evaluate(() => {
      const e = window.__angels;
      const s = e.ctx.services.fleet.player.state;
      const spec = e.ctx.services.fleet.player.spec;
      // Three-quarter from the front left, a little above the wing line, at a
      // distance that scales with the airframe so a Skyhawk and a Hercules
      // both fill the same fraction of the frame.
      // Three-quarter from the front left and slightly *below* the wing line.
      // Below matters: it puts sky behind the aeroplane instead of the ground,
      // and it is the angle every air-to-air photograph of this team is taken
      // from. The distance scales with the airframe so a Skyhawk and a
      // Hercules fill the same fraction of the frame.
      const d = spec.length;
      const off = [-d * 0.78, -d * 0.16, -d * 0.98];
      const q = s.orientation;
      const ix = q.w * off[0] + q.y * off[2] - q.z * off[1];
      const iy = q.w * off[1] + q.z * off[0] - q.x * off[2];
      const iz = q.w * off[2] + q.x * off[1] - q.y * off[0];
      const iw = -q.x * off[0] - q.y * off[1] - q.z * off[2];
      const vx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
      const vy = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
      const vz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
      e.ctx.services.camera.pose(
        { x: s.position.x + vx, y: s.position.y + vy, z: s.position.z + vz },
        { x: s.position.x, y: s.position.y, z: s.position.z },
      );
      e.step(1 / 60, true);
      e.step(1 / 60, true);
    });

    const png = await page.screenshot();
    const h = await health();
    if (h.max < 6) throw new Error(`portrait ${id} is blank — refusing to write it`);
    const b64 = png.toString("base64");
    const data = await page.evaluate(async (d) => {
      const img = new Image();
      img.src = "data:image/png;base64," + d;
      await img.decode();
      const W = 640;
      const H = Math.round((img.height / img.width) * W);
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      c.getContext("2d").drawImage(img, 0, 0, W, H);
      return c.toDataURL("image/jpeg", 0.86);
    }, b64);
    const file = `${out}/${id}.jpg`;
    writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
    console.log(`wrote ${file}  (luma max ${h.max.toFixed(0)})`);
  }

  await browser.close();
  if (server) server.kill();
  process.exit(0);
}

const list = has("all")
  ? Object.keys(POSES)
  : [poseName];

mkdirSync(dirname(out) || ".", { recursive: true });

for (const name of list) {
  const raw = POSES[name];
  if (!raw) {
    console.error(`unknown pose "${name}" — try: ${Object.keys(POSES).join(", ")}`);
    continue;
  }
  const pose = raw.rig ? raw : { ...raw, fromW: vec(world(raw.from)), toW: vec(world(raw.to)) };

  if (raw.jet) {
    // Put the flight somewhere photogenic, then let the formation actually
    // form up before framing it. Six jets converging on their slots is not a
    // picture of the Blue Angels.
    await page.evaluate((place) => {
      const e = window.__angels;
      e.ctx.services.camera.release();
      const fleet = e.ctx.services.fleet;
      if (place) {
        // The engine owns formation placement; the harness just names a point.
        const [lat, lon, alt, hdg, spd] = place;
        const x = (lon - -122.3321) * 75128.0;
        const z = -(lat - 47.6062) * 111182.5;
        fleet.place({ x, y: alt, z }, hdg, spd);
      } else {
        fleet.respawn("show");
      }
    }, raw.place ?? null);
    // Smoke on *after* the respawn — respawn deliberately clears it, and a
    // Diamond without smoke is a photograph of four aeroplanes.
    if (raw.smoke) {
      await page.evaluate(() => {
        for (const a of window.__angels.ctx.services.fleet.all) {
          a.smoke = true;
          a.controls.smoke = true;
        }
      });
    }
    await step(raw.warm ?? 300);
  }

  const file =
    list.length > 1 ? out.replace(/(\.\w+)$/, `-${name}$1`) : out;
  const { png } = await shoot(name, pose, file);

  const h = await health();
  if (h.lost) throw new Error(`WebGL context lost before ${file} — refusing to write a black frame`);
  if (h.max < 6) throw new Error(`${file} is a blank frame (max luma ${h.max.toFixed(1)}) — refusing to write it`);

  if (jpeg) {
    const b64 = png.toString("base64");
    const data = await page.evaluate(async (d) => {
      const img = new Image();
      img.src = "data:image/png;base64," + d;
      await img.decode();
      const W = 960;
      const H = Math.round((img.height / img.width) * W);
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      c.getContext("2d").drawImage(img, 0, 0, W, H);
      return c.toDataURL("image/jpeg", 0.88);
    }, b64);
    writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
  } else {
    writeFileSync(file, png);
  }
  console.log(`wrote ${file}  (luma max ${h.max.toFixed(0)} mean ${h.mean.toFixed(1)})`);
}

function vec(a) {
  return { x: a[0], y: a[1], z: a[2] };
}

const state = await page.evaluate(() => {
  const e = window.__angels;
  const s = e.ctx.services.fleet.player.state;
  return {
    fps: Math.round(e.stats.fps),
    frameMs: +e.stats.frameMs.toFixed(1),
    alt: Math.round(s.altitude),
    kias: Math.round(s.ias * 1.94384),
    camRange: Math.round(e.ctx.camera.position.distanceTo(s.position)),
    spread: Math.round(
      Math.max(
        ...e.ctx.services.fleet.all.map((a) => a.state.position.distanceTo(s.position)),
      ),
    ),
    camMode: e.ctx.services.camera.mode,
    mach: +s.mach.toFixed(2),
    g: +s.gLoad.toFixed(2),
    aoa: +((s.alpha * 180) / Math.PI).toFixed(1),
    calls: e.ctx.renderer.info.render.calls,
    tris: e.ctx.renderer.info.render.triangles,
  };
});
console.log("state:", JSON.stringify(state));
if (logs.length) console.log("page log:\n" + logs.slice(-16).join("\n"));

await browser.close();
if (server) server.kill();
