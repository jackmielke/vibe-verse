#!/usr/bin/env node
/**
 * route-perf — open routes in a real browser and measure what they *cost*.
 *
 * ## Why this exists
 *
 * `route-smoke.mjs` answers "is the world there". It cannot tell you that the
 * world is there and running at 19 fps on a laptop, which is the complaint that
 * actually arrives. This answers that, and it answers it with numbers you can
 * diff between two commits rather than an impression from driving it around.
 *
 * ## What it measures, and which numbers you can trust
 *
 * CI and this container have no GPU — Chromium falls back to SwiftShader, which
 * rasterises on the CPU. So:
 *
 *  - **draws, tris, programs, textures, contexts, heap are exact.** They are
 *    counts of what the page asked the driver to do, and they are identical on
 *    a real GPU. These are the numbers to optimise against.
 *  - **fps / p95 are relative only.** SwiftShader is perhaps 50–100× slower than
 *    a discrete GPU at fill, so treat them as a ranking between routes and
 *    between commits, never as a prediction of what a MacBook will do.
 *
 * Counting happens at the WebGL layer rather than through `renderer.info`,
 * because forty-odd worlds build their renderer in forty-odd different places
 * and most never expose it. Wrapping `drawElements` catches all of them,
 * including the mapbox custom layers and anything drawn by a library.
 *
 * ## Usage
 *
 *   node scripts/route-perf.mjs                  # the worlds in the registry
 *   node scripts/route-perf.mjs /city /sf        # just these
 *   PERF_WAIT=20000 node scripts/route-perf.mjs  # longer settle per route
 *   PERF_DPR=2 node scripts/route-perf.mjs       # emulate a retina display
 *   PERF_JSON=perf.json node scripts/route-perf.mjs
 *   PERF_ENTER=Arrive node scripts/route-perf.mjs /empyrean   # click past a menu
 *
 * `PERF_ENTER` is for a world that gates its first frame behind a named
 * button. Without it the click at the middle of the viewport misses, the world
 * never boots, and the row comes back **60.1 fps, 0 draws, 0 triangles** — a
 * perfect score for a title card. Zero draws with a live WebGL context is
 * called out as `menu?` for that reason: a world that drew nothing did not
 * pass, whatever its frame rate says. A world with no context at all is a
 * different thing — Seafair and 2048 are drawn in the DOM — and is left alone.
 *
 * `PERF_DPR=2` is the interesting one: it is the single biggest cost multiplier
 * in the repo and the reason a Retina MacBook struggles where an external
 * monitor does not. Run it at 1 and at 2 and compare the fill-bound routes.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = Number(process.env.PERF_WAIT ?? 9000);
const SAMPLE = Number(process.env.PERF_SAMPLE ?? 6000);
const DPR = Number(process.env.PERF_DPR ?? 1);
const JSON_OUT = process.env.PERF_JSON ?? "";
const ENTER = process.env.PERF_ENTER ?? "";

/** Routes worth profiling: the worlds, read out of the registry. */
function registryRoutes() {
  const src = readFileSync(new URL("../src/worlds/registry.ts", import.meta.url), "utf8");
  return [...new Set([...src.matchAll(/path:\s*"(\/[^"]*)"/g)].map((m) => m[1]))].sort();
}

/**
 * Injected before any page script. Wraps the draw entry points on both WebGL
 * prototypes and buckets the counts per animation frame.
 *
 * Triangle counts come from the draw mode and vertex count, so they include
 * geometry drawn several times (shadow passes, post-FX, reflection probes) —
 * which is the point. A world with one 200k-triangle mesh and four shadow
 * cascades is doing a million triangles of work, and that is the number that
 * matters, not the number in the .glb.
 */
const PROBE = `
(() => {
  const S = {
    frames: [], draws: 0, tris: 0, programs: 0, texUploads: 0, texBytes: 0,
    contexts: 0, maxDraws: 0, maxTris: 0, shaderMs: 0,
  };
  window.__perf = S;

  const TRIS = { 4: (n) => n / 3, 5: (n) => Math.max(0, n - 2), 6: (n) => Math.max(0, n - 2) };
  const tally = (mode, count, inst = 1) => {
    S.draws += 1;
    const f = TRIS[mode];
    if (f) S.tris += f(count) * inst;
  };

  for (const proto of [
    typeof WebGLRenderingContext !== "undefined" && WebGLRenderingContext.prototype,
    typeof WebGL2RenderingContext !== "undefined" && WebGL2RenderingContext.prototype,
  ].filter(Boolean)) {
    const de = proto.drawElements, da = proto.drawArrays;
    proto.drawElements = function (m, c, t, o) { tally(m, c); return de.call(this, m, c, t, o); };
    proto.drawArrays = function (m, f, c) { tally(m, c); return da.call(this, m, f, c); };
    if (proto.drawElementsInstanced) {
      const i = proto.drawElementsInstanced;
      proto.drawElementsInstanced = function (m, c, t, o, n) { tally(m, c, n); return i.call(this, m, c, t, o, n); };
    }
    if (proto.drawArraysInstanced) {
      const i = proto.drawArraysInstanced;
      proto.drawArraysInstanced = function (m, f, c, n) { tally(m, c, n); return i.call(this, m, f, c, n); };
    }
    /* Shader link time is a stall, not a per-frame cost, but it is the reason a
       world hitches for two seconds the first time you look at something. */
    const lp = proto.linkProgram;
    proto.linkProgram = function (p) {
      const t0 = performance.now();
      const r = lp.call(this, p);
      S.shaderMs += performance.now() - t0;
      S.programs += 1;
      return r;
    };
    /* Texture bytes: the dominant term in GPU memory, and the thing that makes
       a laptop swap rather than merely render slowly. */
    const t2 = proto.texImage2D;
    proto.texImage2D = function (...a) {
      S.texUploads += 1;
      try {
        const src = a[a.length - 1];
        let w = 0, h = 0;
        if (typeof a[3] === "number" && typeof a[4] === "number") { w = a[3]; h = a[4]; }
        else if (src && src.width) { w = src.width; h = src.height; }
        if (w && h) S.texBytes += w * h * 4;
      } catch {}
      return t2.apply(this, a);
    };
  }

  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (typeof type === "string" && type.indexOf("webgl") === 0) S.contexts += 1;
    return gc.call(this, type, ...rest);
  };

  let last = performance.now(), d0 = 0, t0 = 0;
  const tick = () => {
    const now = performance.now();
    S.frames.push(now - last);
    const fd = S.draws - d0, ft = S.tris - t0;
    if (fd > S.maxDraws) S.maxDraws = fd;
    if (ft > S.maxTris) S.maxTris = ft;
    d0 = S.draws; t0 = S.tris; last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.__perfReset = () => {
    S.frames.length = 0; S.draws = 0; S.tris = 0; S.maxDraws = 0; S.maxTris = 0;
    d0 = 0; t0 = 0; last = performance.now();
  };
})();
`;

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

const routes = process.argv.slice(2).length ? process.argv.slice(2) : registryRoutes();

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
    "--js-flags=--expose-gc",
  ],
});

const rows = [];
for (const route of routes) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: DPR,
  });
  await ctx.addInitScript(PROBE);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).split("\n")[0]));

  const row = { route, ok: false, fps: 0, p95: 0, draws: 0, tris: 0, programs: 0, shaderMs: 0, texMB: 0, contexts: 0, heapMB: 0, errors: [] };
  try {
    const t0 = Date.now();
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (ENTER) {
      /* Named, and retried: under SwiftShader the button can be on screen
         before its handler is attached, and one click that lands on nothing
         is indistinguishable from a world that boots slowly. */
      for (let attempt = 0; attempt < 4; attempt++) {
        const hit = await page
          .getByText(ENTER, { exact: false })
          .first()
          .click({ timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        if (hit) break;
        await page.waitForTimeout(2000);
      }
    } else {
      await page.mouse.click(640, 400).catch(() => {});
    }
    await page.waitForTimeout(WAIT);
    row.bootMs = Date.now() - t0;

    /* Settle first, then measure: the first seconds are compile and upload, and
       averaging them in tells you about loading rather than about playing. */
    await page.evaluate(() => window.__perfReset?.());
    await page.waitForTimeout(SAMPLE);

    const s = await page.evaluate(() => {
      const S = window.__perf;
      const f = [...S.frames].sort((a, b) => a - b);
      const mean = S.frames.reduce((a, b) => a + b, 0) / Math.max(1, S.frames.length);
      const mem = performance.memory;
      return {
        n: S.frames.length,
        fps: mean > 0 ? 1000 / mean : 0,
        p95: f.length ? f[Math.floor(f.length * 0.95)] : 0,
        draws: S.frames.length ? S.maxDraws : 0,
        tris: S.frames.length ? S.maxTris : 0,
        programs: S.programs,
        shaderMs: S.shaderMs,
        texMB: S.texBytes / 1048576,
        contexts: S.contexts,
        heapMB: mem ? mem.usedJSHeapSize / 1048576 : 0,
      };
    });
    Object.assign(row, {
      ok: s.n > 0,
      fps: +s.fps.toFixed(1),
      p95: +s.p95.toFixed(1),
      draws: s.draws,
      tris: Math.round(s.tris),
      programs: s.programs,
      shaderMs: Math.round(s.shaderMs),
      texMB: +s.texMB.toFixed(1),
      contexts: s.contexts,
      heapMB: +s.heapMB.toFixed(1),
    });
  } catch (e) {
    errors.push(`navigation: ${String(e.message).split("\n")[0]}`);
  }
  row.errors = [...new Set(errors)].slice(0, 3);
  rows.push(row);

  /* A live GL context that drew nothing is a world that never started —
     almost always a menu nobody clicked past. It is not a fast world. */
  row.menu = row.ok && row.contexts > 0 && row.draws === 0;
  console.log(
    `${row.menu ? "menu" : row.ok ? "ok  " : "FAIL"} ${route.padEnd(20)} ` +
      `${String(row.fps).padStart(6)}fps  p95 ${String(row.p95).padStart(6)}ms  ` +
      `${String(row.draws).padStart(5)} draws  ${String(row.tris).padStart(9)} tris  ` +
      `${String(row.programs).padStart(4)} prog  ${String(row.texMB).padStart(7)}MB tex  ` +
      `${String(row.contexts).padStart(2)} ctx  ${String(row.heapMB).padStart(6)}MB heap` +
      (row.menu ? "   <- drew nothing; try PERF_ENTER=<button text>" : ""),
  );
  await ctx.close();
}

await browser.close();
if (server) server.kill();

console.log(`\n--- worst by draw calls ---`);
for (const r of [...rows].sort((a, b) => b.draws - a.draws).slice(0, 10)) {
  console.log(`  ${String(r.draws).padStart(5)} draws  ${r.route}`);
}
console.log(`--- worst by triangles/frame ---`);
for (const r of [...rows].sort((a, b) => b.tris - a.tris).slice(0, 10)) {
  console.log(`  ${String(r.tris).padStart(9)} tris  ${r.route}`);
}
console.log(`--- worst by texture memory ---`);
for (const r of [...rows].sort((a, b) => b.texMB - a.texMB).slice(0, 10)) {
  console.log(`  ${String(r.texMB).padStart(7)} MB  ${r.route}`);
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ dpr: DPR, rows }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
