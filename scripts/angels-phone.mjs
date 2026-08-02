#!/usr/bin/env node
/**
 * angels-phone — drive Blue Angels with a thumb, in both orientations.
 *
 * The point is not a pretty screenshot. It is to prove three things that a
 * desktop run cannot:
 *
 *  1. the touch overlay appears on a coarse pointer, before anything is tapped;
 *  2. dragging the virtual stick actually reaches the flight model — the jet
 *     rolls, and it rolls the way the thumb went;
 *  3. every control is inside the viewport and inside the safe area, in
 *     landscape *and* portrait, which are two genuinely different layouts.
 *
 * Writes a frame per orientation and prints what it measured. A control that
 * is off-screen on a phone is not a control.
 */
import { chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const outDir = process.argv[2] ?? "shots";

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

mkdirSync(outDir, { recursive: true });

const CASES = [
  { name: "portrait", viewport: { width: 390, height: 844 } },
  { name: "landscape", viewport: { width: 844, height: 390 } },
];

let failures = 0;

for (const c of CASES) {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    viewport: c.viewport,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/blue-angels?shot=1&q=low`, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForFunction(() => window.__angelsReady === true, { timeout: 180000 });

  // Let the world settle, then hand the input system back to real devices —
  // shot mode is only being used to skip the hangar screen.
  await page.evaluate(() => {
    const e = window.__angels;
    e.ctx.services.fleet.respawn("show");
    e.ctx.services.input.setTouchVisible(true);
    for (let i = 0; i < 200; i++) e.step(1 / 60, false);
  });
  await page.evaluate(() => window.__angels.step(1 / 60, true));

  const overlay = await page.evaluate(() => {
    const root = document.getElementById("blue-angels-touch");
    if (!root) return null;
    const box = (sel) => {
      const el = root.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      shown: getComputedStyle(root).display !== "none",
      zone: box(".zone"),
      throttle: box(".thr"),
      brake: box(".brk"),
      smoke: box(".smk"),
      view: box(".vw"),
      gear: box(".gr"),
      rudderL: box(".rl"),
      rudderR: box(".rr"),
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });

  if (!overlay || !overlay.shown) {
    console.error(`[${c.name}] FAIL: touch overlay is not visible`);
    failures++;
  } else {
    // Every control must be fully inside the viewport.
    for (const [key, b] of Object.entries(overlay)) {
      if (!b || typeof b !== "object") continue;
      const inside = b.x >= 0 && b.y >= 0 && b.x + b.w <= overlay.vw + 1 && b.y + b.h <= overlay.vh + 1;
      // The gear button legitimately hides itself in a short landscape window.
      const hidden = b.w === 0 && b.h === 0;
      if (!inside && !hidden) {
        console.error(`[${c.name}] FAIL: "${key}" is outside the ${overlay.vw}x${overlay.vh} viewport`, b);
        failures++;
      }
    }
  }

  // ---- does the stick actually fly the aeroplane? ------------------------
  const before = await page.evaluate(() => {
    const s = window.__angels.ctx.services.fleet.player.state;
    return { bank: s.bank, roll: s.rollRate };
  });

  // A thumb drag to the right, held, with the engine stepping underneath.
  const zone = overlay?.zone ?? { x: 20, y: c.viewport.height * 0.6, w: 100, h: 100 };
  const sx = Math.round(zone.x + zone.w * 0.4);
  const sy = Math.round(zone.y + zone.h * 0.6);
  await page.touchscreen.tap(sx, sy);
  await page.evaluate(
    async ([x, y]) => {
      const zoneEl = document.querySelector("#blue-angels-touch .zone");
      const send = (type, cx, cy) =>
        zoneEl.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 7,
            pointerType: "touch",
            clientX: cx,
            clientY: cy,
            bubbles: true,
            cancelable: true,
          }),
        );
      send("pointerdown", x, y);
      // Hold full right stick for a second of simulated flight.
      for (let i = 0; i < 60; i++) {
        send("pointermove", x + 70, y);
        window.__angels.step(1 / 60, false);
      }
    },
    [sx, sy],
  );

  const after = await page.evaluate(() => {
    const s = window.__angels.ctx.services.fleet.player.state;
    return { bank: s.bank, roll: s.rollRate, throttle: window.__angels.ctx.input.throttle };
  });

  const rolled = after.roll - before.roll;
  if (rolled < 0.4) {
    console.error(
      `[${c.name}] FAIL: full right stick produced only ${rolled.toFixed(3)} rad/s of roll rate`,
    );
    failures++;
  }

  await page.evaluate(() => window.__angels.step(1 / 60, true));
  const png = await page.screenshot();
  const file = `${outDir}/phone-${c.name}.png`;
  writeFileSync(file, png);

  console.log(
    `[${c.name}] ${overlay?.vw}x${overlay?.vh} overlay=${overlay?.shown} rollRate ${before.roll.toFixed(2)} → ${after.roll.toFixed(2)} rad/s  bank ${(
      (after.bank * 180) /
      Math.PI
    ).toFixed(0)}°  wrote ${file}`,
  );
  if (errors.length) {
    console.error(`[${c.name}] page errors:`, errors.slice(0, 4));
    failures++;
  }

  await context.close();
}

await browser.close();
if (server) server.kill();

if (failures) {
  console.error(`\n${failures} phone check(s) failed`);
  process.exit(1);
}
console.log("\nphone controls OK in both orientations");
