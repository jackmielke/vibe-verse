#!/usr/bin/env node
/**
 * dz-probe — ask the running world about itself.
 *
 * CURRENTLY POINTED AT: the SPLASH ROYALE elimination burst, `vfx.soakBurst()`,
 * measured AGAINST the shipped `vfx.balloonBurst()` in the same frame.
 *
 * Two things make a naive "fire it and screenshot" useless here, and this file
 * is shaped around both.
 *
 * 1. TIME. The simulation runs a few hundred times slower than wall clock
 *    (SwiftSHADER; `core.ts` clamps dt to 1/15 and takes six fixed steps at
 *    most) while a composite takes minutes, so a screenshot lands at an
 *    unknown particle age — one frame old, or long over, and which one you got
 *    is a coin flip.
 *
 *    Two ways of pinning the moment were tried here and BOTH are traps, which
 *    is worth writing down because each produces a completely convincing
 *    photograph of a broken effect:
 *
 *      `engine.stop()` + our own `renderer.render()` rAF — bypasses the
 *      engine's `renderOverride`, so the frame is composed without the postfx
 *      pass, and the ground-hugging half of a water effect vanishes from the
 *      capture while opaque meshes (debris, the puddle) survive.
 *
 *      Pinning `ctx.elapsed` behind a no-op setter — the engine keeps
 *      composing, but every system that integrates against elapsed (sky,
 *      exposure) sits on a frozen input and the whole frame comes back
 *      mis-graded: crimson brick, neon grass.
 *
 *    So: do not touch the engine. RE-FIRE the effect on a simulated-time
 *    cadence instead, and let the capture land wherever it lands — there is
 *    always fresh water in the air, the frame is composed exactly the way it
 *    ships, and what you are looking at is what a player would see.
 *
 * 2. THE HARNESS ITSELF. Thirteen "bugs" in this world turned out to be the
 *    measurement rather than the game, so a lone capture of a new effect
 *    proves nothing: if it comes out empty, that is equally consistent with a
 *    broken effect and with a probe that posed, timed or framed it wrong. So
 *    every run fires a KNOWN-GOOD effect — `balloonBurst`, which ships and is
 *    verified — at a second point in the SAME frame, and reports both. If the
 *    control is empty too, the fault is in here.
 *
 * The readback is the part that decides it. After freezing we `gl.readPixels`
 * a box around each burst, before and after, and print how many pixels moved,
 * which way, and how warm they are — because "is the crown there" and "is any
 * of this red" are not answerable by eye at two metres across a 900 px street.
 *
 * Usage:
 *   node scripts/dz-probe.mjs [age] [out.png]
 *   DZ_PROBE_AGE=0.28 node scripts/dz-probe.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.DZ_PORT ?? 5178);
const BASE = `http://127.0.0.1:${PORT}`;
/** Simulated seconds after the burst to freeze at. */
const AGE = Number(process.argv[2] ?? process.env.DZ_PROBE_AGE ?? 0.3);
const SHOT = process.argv[3] ?? process.env.DZ_PROBE_SHOT ?? "shots/soak-burst.png";
const W = Number(process.env.DZ_PROBE_W ?? 900);
const H = Number(process.env.DZ_PROBE_H ?? 540);

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
    "--js-flags=--max-old-space-size=4096",
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message.slice(0, 300)}`));

await page.goto(`${BASE}/drop-zero?shot=1&q=high`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction("window.__dzReady === true", null, { timeout: 60000 }).catch(() => {});

const live = await page
  .evaluate(`(async () => {
    const e = window.__dz;
    const m = e?.ctx?.services?.match;
    const list = e?.ctx?.services?.pois ?? [];
    if (!m) return "no match service";
    const t = (list.find && list.find((x) => x.tier === "landmark")) || (list[0] ?? null);
    const V = e.ctx.camera.position.constructor;
    const spot = t ? new V(t.center.x - 34, t.center.y, t.center.z + 38) : new V(0, 0, 0);
    try { m.skipWarmup(); } catch (err) { /* optional */ }
    try { m.skipToLive(spot); } catch (err) { return "skipToLive threw: " + err.message; }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if (m.phase === "live") return "live after " + i + " ticks, mode=" + e.ctx.mode;
    }
    return "phase stuck at " + m.phase;
  })()`)
  .catch((err) => `skipToLive threw: ${err.message}`);
console.log("live:", live);
await page.waitForTimeout(8000);

const posed = await page.evaluate(`(() => {
  const e = window.__dz;
  if (!e) return "no engine";
  if (e.__dzPin) clearInterval(e.__dzPin);
  const list = e.ctx.services.pois ?? [];
  const t = (list.find && list.find((x) => x.tier === "landmark")) || (list[0] ?? null);
  const terrain = e.ctx.services.terrain;
  const cx = t ? t.center.x : 0;
  const cz = t ? t.center.z : 0;
  const gx = cx - 34;
  const gz = cz + 38;
  const y = (terrain?.heightAt?.(gx, gz) ?? 0) + 1.0;
  const apply = () => {
    const p = e.ctx.services.player;
    if (!p) return;
    const V = e.ctx.camera.position.constructor;
    p.teleport(new V(gx, y, gz));
    p.velocity.set(0, 0, 0);
    p.yaw = Math.atan2(-(cx - gx), -(cz - gz));
    p.pitch = -0.06;
  };
  apply();
  e.__dzPin = setInterval(apply, 8);
  return { poi: t ? t.name ?? "(unnamed)" : "NONE", stand: [+gx.toFixed(1), +y.toFixed(1), +gz.toFixed(1)] };
})()`);
console.log("posed:", JSON.stringify(posed));
await page.waitForTimeout(25000);

const fired = await page
  .evaluate(`(async (age) => {
    const e = window.__dz;
    if (!e) return { error: "no engine" };
    const ctx = e.ctx;
    const vfx = ctx.services.vfx;
    if (!vfx) return { error: "no vfx service" };
    const out = { mode: ctx.mode, quality: ctx.quality };
    out.hasSoakBurst = typeof vfx.soakBurst === "function";
    out.hasBalloonBurst = typeof vfx.balloonBurst === "function";
    if (!out.hasSoakBurst) return Object.assign(out, { error: "vfx.soakBurst missing" });

    const cam = ctx.services.player?.camera ?? ctx.camera;
    out.camIsPlayerCam = cam === ctx.camera;
    const V = ctx.camera.position.constructor;
    const fwd = new V();
    cam.getWorldDirection(fwd);
    fwd.y = 0; fwd.normalize();
    // Right-hand side vector in the ground plane.
    const right = new V(-fwd.z, 0, fwd.x);

    const place = (side) => {
      const x = cam.position.x + fwd.x * 8 + right.x * side * 3.2;
      const z = cam.position.z + fwd.z * 8 + right.z * side * 3.2;
      const y = (ctx.services.terrain?.heightAt?.(x, z) ?? 0) + 1.0;
      return new V(x, y, z);
    };
    const control = place(-1);   // balloonBurst: the known-good reference
    const subject = place(+1);   // soakBurst: what is on trial

    // Where each burst lands ON SCREEN, in top-left pixel coordinates, so the
    // capture can be cropped and measured afterwards with dz-crop. Reading the
    // framebuffer here instead is a trap: with preserveDrawingBuffer off,
    // gl.readPixels is only valid inside the same task as the draw that filled
    // it, and the engine's draws happen in its own rAF — so anything we read
    // from a task of ours is either stale or blank. Measure the PNG.
    const gl = ctx.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const cssW = ctx.renderer.domElement.clientWidth || w;
    const boxOf = (p) => {
      const q = p.clone().project(cam);
      const scale = cssW / w;
      return {
        x: Math.round((q.x * 0.5 + 0.5) * w * scale),
        y: Math.round((1 - (q.y * 0.5 + 0.5)) * h * scale),
      };
    };
    const boxes = { control: boxOf(control), subject: boxOf(subject) };

    const wet = ctx.services.wetness;
    const puddlesBefore = wet ? wet.puddleCount : null;

    const t0 = ctx.elapsed;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Re-fire on a SIMULATED-time cadence, forever, so whenever Playwright
    // finishes compositing there is water in the air of a useful age. The
    // cadence is deliberately shorter than the effect's own life, so a frame
    // also catches the tail of the previous burst hanging in the air, which
    // is what a real elimination looks like a beat later.
    let fires = 0;
    let last = ctx.elapsed - age;
    const pump = () => {
      if (ctx.elapsed - last >= age) {
        last = ctx.elapsed;
        fires++;
        vfx.balloonBurst(control);
        vfx.soakBurst(subject, 1.2);
      }
      e.__dzPump = requestAnimationFrame(pump);
    };
    pump();
    // Let a few cycles run so the scene settles into its steady state.
    let waited = 0;
    while (ctx.elapsed - t0 < age * 6 && waited < 900) { await sleep(100); waited++; }
    out.cadence = age;
    out.fires = fires;
    out.simSecondsRun = +(ctx.elapsed - t0).toFixed(3);
    out.wallPolls = waited;
    out.drawCalls = ctx.renderer.info.render.calls;

    return Object.assign(out, {
      controlAt: [+control.x.toFixed(1), +control.y.toFixed(1), +control.z.toFixed(1)],
      subjectAt: [+subject.x.toFixed(1), +subject.y.toFixed(1), +subject.z.toFixed(1)],
      buffer: [w, h],
      screen: boxes,
      puddlesBefore, puddlesAfter: wet ? wet.puddleCount : null,
    });
  })(${AGE})`)
  .catch((err) => ({ error: "evaluate threw: " + err.message }));
console.log("fired:", JSON.stringify(fired, null, 2));

await page.waitForTimeout(4000);
await page.screenshot({ path: SHOT, timeout: 900000, animations: "disabled" });
console.log("wrote", SHOT);

if (logs.length) console.log("logs:\n" + logs.slice(-25).join("\n"));

await browser.close();
if (server) server.kill();
