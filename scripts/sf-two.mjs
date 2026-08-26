#!/usr/bin/env node
/**
 * sf-two — two people in one San Francisco, in two real browser pages.
 *
 * The only end-to-end test of multiplayer that can run without a network.
 * Supabase Realtime is blocked in the sandbox this is developed in, so the
 * `online` transport cannot be exercised here at all; the `local` one — a
 * `BroadcastChannel` shared by every tab of a browser — runs the identical
 * protocol, peer table, interpolator and renderer, and differs only in the
 * ~60 lines that put bytes on a wire.
 *
 * What it checks, which unit tests cannot:
 *  - two pages discover each other at all
 *  - each sees exactly one other person, not two and not itself
 *  - a peer's body is actually built and placed, not merely tracked
 *  - moving one page moves the other page's copy of it
 *  - closing a page removes it promptly, rather than after the timeout
 *
 * Both pages live in one browser context on purpose: `BroadcastChannel` is
 * scoped to an origin *and* a browsing-context group, and two independent
 * contexts would silently never see each other — which would look exactly
 * like broken netcode.
 *
 * Usage:
 *   node scripts/sf-two.mjs
 *   node scripts/sf-two.mjs --out shots/two.png --boot 60000
 *   node scripts/sf-two.mjs --drive --out shots/two-car.png
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = { boot: 40000, port: 5177, room: `two-${process.pid}` };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "drive") {
      out.drive = true;
      continue;
    }
    const val = argv[++i];
    out[key] = /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val;
  }
  return out;
}

async function waitForServer(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const args = parseArgs(process.argv);
const base = `http://127.0.0.1:${args.port}`;

let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawn("npx", ["vite", "--port", String(args.port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, BROWSER: "none" },
  });
  if (!(await waitForServer(base, 120000))) {
    console.error("dev server never came up");
    server.kill();
    process.exit(1);
  }
}

const pinned = [process.env.SF_CHROME, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].filter(Boolean);
const executablePath = pinned.find((p) => existsSync(p));
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--force-device-scale-factor=1",
  ],
});

// One context: see the header.
// Small frames on purpose. Two copies of a streaming city in a software
// rasteriser is the slowest thing this repo does, and nothing here is
// measured in pixels.
const ctx = await browser.newContext({ viewport: { width: 700, height: 420 } });
const problems = [];

async function openPlayer(label) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/net::/.test(m.text())) problems.push(`${label} console: ${m.text()}`);
  });
  const url = `${base}/sf?net=local&room=${args.room}&spawn=market&quality=low`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  return page;
}

const state = (page) =>
  page.evaluate(() => (window.__sf?.state ? window.__sf.state() : null));

/** How many peer bodies this page has actually built in the scene graph. */
const bodyCount = (page) =>
  page.evaluate(() => (window.__sf?.peerBodies ? window.__sf.peerBodies() : -1));

const a = await openPlayer("A");
const b = await openPlayer("B");

// Both worlds have to stream in before either can report anything useful. At
// SwiftShader frame rates this is the slow part, not the networking.
await a.waitForTimeout(args.boot);

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `  ${detail}`}`);
  if (!ok) fail++;
};

/**
 * Wait for both pages to notice each other.
 *
 * Polled, not slept. Inbound packets land in an event callback, but the roster
 * and the bodies are both built inside the frame loop — and the *second* page
 * gets whatever CPU the first one leaves, which in a software rasteriser
 * running two copies of a streaming city is not much. A fixed boot budget made
 * this test report broken netcode when what it had actually measured was an
 * unlucky page.
 */
async function waitForDiscovery(timeoutMs) {
  const t0 = Date.now();
  let last = [null, null];
  while (Date.now() - t0 < timeoutMs) {
    last = [await state(a), await state(b)];
    if (last[0]?.peers === 1 && last[1]?.peers === 1) return last;
    await b.waitForTimeout(2500);
  }
  return last;
}

const [sa, sb] = await waitForDiscovery(120000);
check("A sees exactly one other person", sa?.peers === 1, JSON.stringify(sa?.peerNames));
check("B sees exactly one other person", sb?.peers === 1, JSON.stringify(sb?.peerNames));

check("A built a body for B", (await bodyCount(a)) >= 1, `bodies=${await bodyCount(a)}`);
check("B built a body for A", (await bodyCount(b)) >= 1, `bodies=${await bodyCount(b)}`);

// Move A a long way and confirm B's copy of A follows. Teleport rather than
// walk: at this frame rate walking anywhere takes minutes.
//
// Polled rather than waited out. B has to receive the packet *and* run a frame
// to place the body, and a frame in a software rasteriser running two copies
// of this city can be three seconds long — a fixed sleep here is a coin toss,
// which is exactly how this check behaved before.
const peerPos = (page) => page.evaluate(() => window.__sf.peerPositions?.()[0] ?? null);
const before = await peerPos(b);
await a.evaluate(() => window.__sf.teleport(300, 40, -300, 0));
let moved = 0;
for (let i = 0; i < 12; i++) {
  await b.waitForTimeout(2500);
  const after = await peerPos(b);
  moved = before && after ? Math.hypot(after[0] - before[0], after[2] - before[2]) : 0;
  if (moved > 50) break;
}
check("B's copy of A followed A across town", moved > 50, `moved ${Math.round(moved)} m`);

if (args.drive) {
  // A gets into a car; B should see a car, not a person in a seated pose
  // skating down Market. This is the only way that path gets looked at.
  const car = await a.evaluate(() => window.__sf.nearestVehicle());
  if (car) {
    await a.evaluate((c) => window.__sf.teleport(c.x + 2.4, c.y + 1.2, c.z, 0), car);
    await a.waitForTimeout(9000);
    for (let i = 0; i < 4; i++) {
      await a.keyboard.press("f");
      await a.waitForTimeout(3500);
    }
    const sa2 = await state(a);
    check("A is driving", sa2?.vehicleId !== null, `vehicleId=${sa2?.vehicleId}`);

    // Let the new state reach B and be drawn, then check what B is drawing —
    // not what A said. Polled, because B needs a frame to do the swap.
    let info = null;
    for (let i = 0; i < 10; i++) {
      await b.waitForTimeout(2500);
      info = await b.evaluate(() => window.__sf.peerInfo?.() ?? []);
      if (info?.[0]?.driving) break;
    }
    check("B draws A as a car, not a person", !!info?.[0]?.driving, JSON.stringify(info));
    // Put B's camera on the car.
    const pos = await b.evaluate(() => window.__sf.peerPositions?.()[0] ?? null);
    if (pos) {
      await b.evaluate(
        (p) => window.__sf.setPose([p[0] + 9, p[1] + 3.4, p[2] + 9], [p[0], p[1] + 0.9, p[2]], 55),
        pos,
      );
      await b.waitForTimeout(7000);
    }
  } else {
    check("A found a car to get into", false, "no vehicle in range");
  }
}

if (args.out) {
  await mkdir(path.dirname(args.out), { recursive: true });
  if (!args.drive) {
    // Put A right next to B and photograph B's view of A.
    const bp = await b.evaluate(() => window.__sf.player());
    await a.evaluate((p) => window.__sf.teleport(p.x + 3, p.y + 1, p.z + 3, 0), bp);
    await a.waitForTimeout(9000);
    await b.evaluate(
      (p) => window.__sf.setPose([p.x + 6, p.y + 2.2, p.z + 6], [p.x + 3, p.y + 1, p.z + 3], 55),
      bp,
    );
    await b.waitForTimeout(7000);
  }
  const dataUrl = await b.evaluate(() => window.__sf.snapshot());
  writeFileSync(args.out, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`wrote ${args.out}`);
}

// A leaves. The goodbye should get there on `pagehide`; the timeout is the
// backstop. Waited generously because both the prune sweep and the roster
// update are frame-gated, and a frame here can be three seconds long.
await a.close();
await b.waitForTimeout(14000);
const sb2 = await state(b);
check("B noticed A leaving", sb2?.peers === 0, `peers=${sb2?.peers}`);

console.log(problems.length ? `problems:\n  ${problems.slice(0, 10).join("\n  ")}` : "no page errors");
console.log(fail === 0 ? "\nall checks passed" : `\n${fail} check(s) failed`);

await browser.close();
server?.kill();
process.exit(fail === 0 ? 0 : 1);
