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
 *    is a coin flip. The fix is to freeze the clock instead of chasing it:
 *    poll `ctx.elapsed` — never wall clock — until the age we want, then
 *    `engine.stop()`. That halts `ctx.elapsed`, which pins the vfx layer's
 *    `uTime` uniform, and since every particle integrates its own position
 *    from `uTime - spawn` in the vertex shader, a frozen `uTime` is a frozen,
 *    fully-posed burst. We then keep rendering it on our own rAF loop, so the
 *    canvas holds an identical valid frame however long Playwright takes.
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

    const gl = ctx.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const boxOf = (p) => {
      const q = p.clone().project(cam);
      const sx = Math.round((q.x * 0.5 + 0.5) * w);
      // readPixels is bottom-up; keep everything in GL space.
      const sy = Math.round((q.y * 0.5 + 0.5) * h);
      const r = Math.round(Math.min(w, h) * 0.24);
      const x0 = Math.max(0, sx - r), x1 = Math.min(w, sx + r);
      const y0 = Math.max(0, sy - r), y1 = Math.min(h, sy + r);
      return { x0, y0, bw: Math.max(1, x1 - x0), bh: Math.max(1, y1 - y0), sx, sy };
    };
    const boxes = { control: boxOf(control), subject: boxOf(subject) };

    const grab = (b) => {
      const px = new Uint8Array(b.bw * b.bh * 4);
      gl.readPixels(b.x0, b.y0, b.bw, b.bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const render = () => ctx.renderer.render(ctx.scene, ctx.camera);

    // Baseline. Render first so the buffer we read is the one we just drew:
    // with preserveDrawingBuffer off, readPixels is only valid inside the
    // same task as the draw that filled it.
    render();
    const base = { control: grab(boxes.control), subject: grab(boxes.subject) };

    const wet = ctx.services.wetness;
    const puddlesBefore = wet ? wet.puddleCount : null;

    const t0 = ctx.elapsed;
    vfx.balloonBurst(control);
    vfx.soakBurst(subject, 1.2);
    const puddlesAfter = wet ? wet.puddleCount : null;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let waited = 0;
    while (ctx.elapsed - t0 < age && waited < 900) { await sleep(100); waited++; }
    out.frozenAtAge = +(ctx.elapsed - t0).toFixed(3);
    out.wallPolls = waited;
    out.drawCalls = ctx.renderer.info.render.calls;

    // Freeze, then take the "after" read from a render we control.
    e.stop();
    render();
    const after = { control: grab(boxes.control), subject: grab(boxes.subject) };

    const stat = (a, b) => {
      let moved = 0, warm = 0, cool = 0, brighter = 0, n = a.length / 4;
      let dr = 0, dg = 0, db = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d0 = b[i] - a[i], d1 = b[i + 1] - a[i + 1], d2 = b[i + 2] - a[i + 2];
        if (Math.abs(d0) + Math.abs(d1) + Math.abs(d2) > 24) {
          moved++;
          dr += d0; dg += d1; db += d2;
          if (d2 > d0 + 6) cool++;
          if (d0 > d2 + 6) warm++;
          if (d0 + d1 + d2 > 0) brighter++;
        }
      }
      return {
        pixels: n,
        movedPct: +((moved / n) * 100).toFixed(2),
        meanDelta: moved ? [Math.round(dr / moved), Math.round(dg / moved), Math.round(db / moved)] : [0, 0, 0],
        coolPctOfMoved: moved ? +((cool / moved) * 100).toFixed(1) : 0,
        warmPctOfMoved: moved ? +((warm / moved) * 100).toFixed(1) : 0,
        brighterPctOfMoved: moved ? +((brighter / moved) * 100).toFixed(1) : 0,
      };
    };

    // Hand the render loop over so the canvas stays valid for the capture.
    const loop = () => { render(); e.__dzHold = requestAnimationFrame(loop); };
    loop();

    return Object.assign(out, {
      controlAt: [+control.x.toFixed(1), +control.y.toFixed(1), +control.z.toFixed(1)],
      subjectAt: [+subject.x.toFixed(1), +subject.y.toFixed(1), +subject.z.toFixed(1)],
      buffer: [w, h],
      boxes,
      puddlesBefore, puddlesAfter,
      control: stat(base.control, after.control),
      subject: stat(base.subject, after.subject),
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
