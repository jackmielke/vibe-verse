#!/usr/bin/env node
/**
 * trek-shot — drive THE FINAL FRONTIER headless and write review frames.
 *
 * The blunt `route-shot` harness cannot photograph this world: the interesting
 * frames are on the bridge with a Klingon on the viewscreen, and the episode
 * does not start until somebody presses "Assume command". So this boots the
 * route in `?shot=1`, dismisses the title card, spawns whatever the pose asks
 * for, steps the engine deterministically, and grabs the frame.
 *
 * It also refuses to write a blank frame. On the software rasteriser a lost
 * context or a failed shader produces a perfectly plausible black JPEG, and a
 * black JPEG committed as card art is worse than no card art.
 *
 * Usage:
 *   node scripts/trek-shot.mjs shots/bridge.png --pose bridge
 *   node scripts/trek-shot.mjs shots/gallery.png --all
 *   node scripts/trek-shot.mjs src/assets/worlds/final-frontier.jpg --pose card --jpeg
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const out = args[0] ?? "shots/trek.png";
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const poseName = flag("pose", "card");
const size = flag("size", "1280x720").split("x").map(Number);
const jpeg = has("jpeg") || out.endsWith(".jpg");
const showHud = has("hud");
const PORT = Number(process.env.TREK_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Named viewpoints.
 *
 * `bridge` poses are shot through the captain's eyes and need `look` to aim
 * the head; `space` poses drive the external camera directly, in metres. Every
 * pose says what it wants spawned, because an empty sector photographs as a
 * grey ship in front of a black rectangle.
 */
const POSES = {
  // The card: the bridge, from the chair, with a D7 on the screen and the
  // room at red alert. It answers "what is this?" before "where is this?",
  // which is the right order for a world whose whole idea is the room.
  card: { view: "bridge", look: [0, -0.02], alert: true, spawn: "d7", range: 2600, warm: 90 },
  bridge: { view: "bridge", look: [0, 0], alert: false, spawn: "none", warm: 40 },
  science: { view: "bridge", look: [-0.78, -0.06], alert: false, spawn: "none", warm: 40 },
  engineering: { view: "bridge", look: [0.85, -0.05], alert: true, spawn: "d7", range: 3000, warm: 60 },
  helm: { view: "bridge", look: [0, -0.3], alert: false, spawn: "none", warm: 40 },
  // External: the ship herself, which is the other thing people came for.
  // The key light comes from (-0.55, +0.42, -0.72), so a hero shot has to be
  // taken from roughly *that* side — forward, left and above. Shot from the
  // other quarter you get a correct model in silhouette, which is how the
  // first pass of these poses went.
  hero: { view: "space", from: [-330, 175, -420], to: [0, 0, -20], warm: 40 },
  bow: { view: "space", from: [-90, 70, -520], to: [0, 10, 60], warm: 40 },
  nacelle: { view: "space", from: [-250, 120, 210], to: [-10, 25, 30], warm: 40 },
  // The enemy spawns at (0.18r, 0.05r, −r), so these sit ~450 m off it on the
  // lit side rather than back at the player, where a 228 m cruiser two
  // kilometres away is four pixels of grey.
  klingon: { view: "space", from: [40, 250, -2620], to: [396, 110, -2200], spawn: "d7", range: 2200, warm: 60 },
  romulan: { view: "space", from: [10, 220, -2290], to: [342, 95, -1900], spawn: "bop", range: 1900, warm: 60 },
  battle: { view: "space", from: [-1450, 560, -520], to: [230, 60, -1450], spawn: "d7", range: 2400, alert: true, fire: true, warm: 120 },
  // Straight down on the saucer, to check the registry actually reads.
  topside: { view: "space", from: [30, 430, -300], to: [0, 0, -30], warm: 40 },
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
await page.goto(`${BASE}/trek?shot=1${quality ? `&q=${quality}` : ""}`, {
  waitUntil: "domcontentloaded",
  timeout: 120000,
});
// The third argument is the options bag; the second is the page function's
// argument. Passing the timeout in the wrong slot silently leaves the default
// 30 s in place, which this world's boot does not fit inside on a software
// rasteriser.
try {
  await page.waitForFunction(() => window.__trekReady === true, null, { timeout: 300000 });
} catch (err) {
  console.error("boot never completed:", err.message);
  for (const l of logs.slice(0, 30)) console.error(l);
  await browser.close();
  server?.kill();
  process.exit(3);
}

// Take the wheel. Everything from here is explicit `step()` calls, which makes
// every frame reproducible and stops a ship drifting between two evaluations.
await page.evaluate(() => window.__trek.stop());

async function step(frames, { dt = 1 / 60, draw = false } = {}) {
  await page.evaluate(
    ([n, d, r]) => {
      const e = window.__trek;
      for (let i = 0; i < n; i++) e.step(d, r);
    },
    [frames, dt, draw],
  );
}

/** Start the episode and put the sector in whatever state the pose wants. */
async function arm(pose) {
  await page.evaluate((p) => {
    const e = window.__trek;
    const s = e.ctx.services;
    const game = s.game;
    const fleet = s.fleet;

    if (game.status === "briefing") game.advance();
    fleet.clearAll();

    const player = fleet.player;
    player.object.position.set(0, 0, 0);
    player.object.quaternion.identity();
    player.velocity.set(0, 0, 0);
    player.angular.set(0, 0, 0);
    player.throttle = 0.3;
    player.hull_ = 1;
    player.shields = [1, 1, 1, 1];

    if (p.spawn === "d7" || p.spawn === "bop") {
      const THREE = e.ctx.space.background ? null : null;
      const range = p.range ?? 2500;
      const enemy = fleet.spawn({
        name: p.spawn === "d7" ? "KLINGON BATTLE CRUISER" : "ROMULAN BIRD-OF-PREY",
        hull: p.spawn === "d7" ? "d7" : "birdOfPrey",
        allegiance: p.spawn === "d7" ? "klingon" : "romulan",
        position: new (Object.getPrototypeOf(player.position).constructor)(range * 0.18, range * 0.05, -range),
        lookAt: player.position,
        ai: { aggression: 0.7, skill: 0.6 },
      });
      enemy.throttle = 0.25;
      game.targetId = enemy.id;
      player.targetId = enemy.id;
      void THREE;
    }

    // Alert is a toggle, so it has to be driven to the state the pose wants
    // rather than simply pressed — otherwise the first red-alert pose leaves
    // every pose after it lit for battle stations.
    const wantRed = Boolean(p.alert);
    if (wantRed !== (game.alert === "red")) e.ctx.input.toggleAlert = true;
    if (p.view === "bridge") {
      s.camera.setMode("viewscreen");
      s.camera.magnification = p.spawn === "none" ? 1 : 4;
    }
  }, pose);
}

async function shoot(pose) {
  await step(pose.warm ?? 40, { draw: false });
  if (pose.fire) {
    await page.evaluate(() => {
      window.__trek.ctx.input.firePhasers = true;
    });
    await step(20, { draw: false });
  }
  await page.evaluate((p) => {
    const e = window.__trek;
    if (p.view === "bridge") {
      e.ctx.input.lookYaw = p.look[0];
      e.ctx.input.lookPitch = p.look[1];
      e.ctx.services.camera.setMode("viewscreen");
    } else {
      const V = Object.getPrototypeOf(e.ctx.services.fleet.player.position).constructor;
      e.ctx.services.camera.pose(new V(p.from[0], p.from[1], p.from[2]), new V(p.to[0], p.to[1], p.to[2]));
    }
  }, pose);
  // A few drawn frames: the bridge camera damps toward its target, and the
  // viewscreen's render target is a frame behind on the first draw.
  await step(6, { draw: true });
  return page.screenshot(jpeg ? { type: "jpeg", quality: 92 } : {});
}

const health = async () =>
  page.evaluate(() => {
    const e = window.__trek;
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

if (!showHud) {
  await page.addStyleTag({ content: "canvas ~ div, canvas ~ button { display: none !important }" });
}

const names = has("all") ? Object.keys(POSES) : [poseName];
let failed = false;

for (const name of names) {
  const pose = POSES[name];
  if (!pose) {
    console.error(`unknown pose "${name}" — have: ${Object.keys(POSES).join(", ")}`);
    process.exit(2);
  }
  await arm(pose);
  const png = await shoot(pose);
  const h = await health();

  const file = names.length > 1 ? out.replace(/(\.\w+)$/, `.${name}$1`) : out;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);

  // The blank-frame guard. A world that renders nothing renders a very
  // convincing nothing.
  const blank = h.lost || h.max < 26 || h.mean < 1.4;
  console.log(
    `${blank ? "BLANK" : "ok   "}  ${file}  max=${h.max.toFixed(0)} mean=${h.mean.toFixed(1)}${h.lost ? " CONTEXT LOST" : ""}`,
  );
  if (blank) failed = true;
}

if (logs.length) {
  console.log("\n--- console ---");
  for (const l of logs.slice(0, 24)) console.log(l);
}

await browser.close();
server?.kill();
process.exit(failed ? 1 : 0);
