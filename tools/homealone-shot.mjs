#!/usr/bin/env node
/**
 * homealone-shot — pose the camera inside 671 Lincoln Avenue and grab a frame.
 *
 * `npm run build` will not tell you the hall renders black, the bowl cut is
 * inside Kevin's skull, or that the landing has no floor. Driving the route is
 * the only thing that will, so this is the harness that does it: boot the world
 * with `?shot=1`, teleport the player wherever you want to look, point the
 * camera, and write a JPEG.
 *
 *   node tools/homealone-shot.mjs <name> [x] [y] [z] [yaw] [pitch] [level]
 *   node tools/homealone-shot.mjs --set          # the whole sheet
 *
 * Shots land in /tmp/ha/ unless OUT is set.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.HA_PORT ?? 5183);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.OUT ?? "/tmp/ha";

/** name, x, y, z, camera yaw, pitch, level, [body yaw — omit to match camera] */
const SHEET = [
  ["street", 0.4, 0, 20.0, Math.PI, 0.06, 6],
  ["front", 0.4, 0, 10.5, Math.PI, 0.02, 6],
  ["kevin-face", 0.4, 0, 9.2, Math.PI, -0.06, 6, 0],
  ["hall", 0.4, 0, 3.2, Math.PI, -0.06, 6],
  ["living", 3.6, 0, 2.2, 0.9, -0.04, 6],
  ["stairs", -2.6, 0, 4.4, 0.0, 0.14, 6],
  ["landing", -2.4, 3.15, -0.4, 1.6, -0.04, 6],
  ["kevins-room", 0.4, 3.15, 2.6, Math.PI, -0.04, 6],
  ["kitchen", 2.0, 0, -3.4, 0.4, -0.04, 6],
  ["basement", -3.4, -2.95, -2.4, 1.4, -0.02, 6],
  ["backyard", -6.0, 0, -11.0, 0.5, 0.02, 6],
  ["burglars", 0.4, 0, 4.4, Math.PI, -0.03, 4],
];

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 400));
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

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome"].find((p) =>
  existsSync(p),
);
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const shots =
  args[0] === "--set" || args.length === 0
    ? SHEET
    : [[args[0], ...args.slice(1, 6).map(Number), Number(args[6] ?? 6), args[7] ? Number(args[7]) : undefined]];

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") logs.push(`error: ${m.text()}`);
});

for (const [name, x, y, z, yaw, pitch, level, bodyYaw] of shots) {
  await page.goto(`${BASE}/home-alone?shot=1&level=${level ?? 6}`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  // Wait for the handle, and do NOT swallow the timeout: a silent miss here
  // renders every shot at the spawn point and looks like a lighting bug.
  await page.waitForFunction(() => window.__homeAloneReady, null, { timeout: 90000 });
  if (process.env.HA_DIST) await page.evaluate((d) => (window.__haDist = d), Number(process.env.HA_DIST));
  if (process.env.HA_BURGLAR) await page.evaluate((w) => (window.__haBurglar = w), process.env.HA_BURGLAR);
  // Card art wants the world, not the interface.
  if (process.env.HA_NOHUD)
    await page.addStyleTag({ content: "body > #root > div > *:not(canvas){display:none!important}" });
  await page.waitForTimeout(1800);
  // Reach straight into the engine. Its fields are private to TypeScript, not
  // to the runtime, and posing a camera by walking there is a waste of a life.
  await page.evaluate(
    ([px, py, pz, yw, pt, by]) => {
      const e = window.__homeAlone;
      if (!e) return;
      e.pos.set(px, py, pz);
      e.vel.set(0, 0, 0);
      e.yaw = by === undefined || by === null ? yw : by;
      e.camYaw = yw;
      e.camPitch = pt;
      e.shotDist = window.__haDist ?? null;
      e.settleCamera(0.999);
    },
    [x, y, z, yaw, pitch, bodyYaw ?? null],
  );
  await page.waitForTimeout(2200);
  // Optionally park a burglar nose-to-nose for a portrait.
  await page.evaluate(
    ([px, pz, yw]) => {
      const which = window.__haBurglar;
      if (!which) return;
      const e = window.__homeAlone;
      const b = e.burglars.find((x) => x.who === which);
      if (!b) return;
      // Off to one side and behind, so Kevin's head is not in front of his.
      b.spawn(px + Math.sin(yw) * 2.2 + Math.cos(yw) * 1.5, e.pos.y, pz + Math.cos(yw) * 2.2 - Math.sin(yw) * 1.5, yw + Math.PI);
      b.state = "prowl";
      b.char.root.visible = true;
    },
    [x, z, yaw],
  );
  await page.waitForTimeout(500);
  // Hold him still: the controller re-aims him at his velocity when he moves.
  await page.evaluate(
    (by) => {
      const e = window.__homeAlone;
      if (e && by !== null) {
        e.yaw = by;
        e.kevin.root.rotation.y = by;
      }
    },
    bodyYaw ?? null,
  );
  const where = await page.evaluate(() => {
    const e = window.__homeAlone;
    return e ? [+e.pos.x.toFixed(2), +e.pos.y.toFixed(2), +e.pos.z.toFixed(2), +e.camDist.toFixed(2)] : null;
  });
  const png = await page.screenshot();
  writeFileSync(`${OUT}/${name}.png`, png);
  console.log(`wrote ${OUT}/${name}.png  at ${JSON.stringify(where)}`);
}

if (logs.length) console.log("page errors:\n" + logs.slice(-16).join("\n"));

await browser.close();
if (server) server.kill();
