#!/usr/bin/env node
/**
 * dz-ground — ask the world what is actually under a dark pixel.
 *
 * Three captures in a row came back with a large near-black field across the
 * near-to-middle ground and correctly-lit terrain beyond it, and reading the
 * frame is not enough to say what that field IS: dark terrain, dark ground
 * cover, a canopy underside and a shadow-map artifact all photograph the same.
 * Every theory about it was wrong at least once, so this script stops
 * theorising and raycasts.
 *
 * For a grid of screen points it reports, per point:
 *   - the FIRST scene object the ray hits (name, type, instanced or not)
 *   - that object's material colour, and the emissive/AO it carries
 *   - the framebuffer luminance actually rendered at that pixel
 *   - the world position and distance of the hit
 *
 * Rendered luminance next to material albedo is the whole point: albedo tells
 * you what the surface is supposed to be, luminance tells you what the
 * lighting did to it, and the ratio says whether the fault is the texture or
 * the light. Reading either alone is how the first two theories survived.
 *
 * Do not add a "fix" here. This file only ever reports.
 *
 *   DZ_PORT=5195 node scripts/dz-ground.mjs street
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

const PORT = Number(process.env.DZ_PORT ?? 5195);
const BASE = `http://127.0.0.1:${PORT}`;
const QUALITY = process.env.DZ_QUALITY ?? "high";
const SETTLE = Number(process.env.DZ_SETTLE ?? 25000);
const WAIT = Number(process.env.DZ_WAIT ?? 300000);
const SHOT = process.argv[2] ?? "street";
const OUT = process.env.DZ_OUT ?? "shots/probe";

const V = (e, x, y, z) => new (e.ctx.camera.position.constructor)(x, y, z);
const aim = (from, to) => ({
  yaw: Math.atan2(-(to.x - from.x), -(to.z - from.z)),
  pitch: Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z)),
});

/** The same vantages `dz-shot.mjs` uses, so a report lines up with a frame. */
const POSES = {
  street: (e) => {
    const list = e.ctx.services.pois ?? [];
    const t = list.find((x) => x.tier === "landmark") ?? list[0];
    const terrain = e.ctx.services.terrain;
    const cx = t ? t.center.x : 0;
    const cz = t ? t.center.z : 0;
    const r = t ? Math.max(t.radius, 40) * 0.62 : 46;
    const a = 2.3;
    const gx = cx + Math.cos(a) * r;
    const gz = cz + Math.sin(a) * r;
    const pos = V(e, gx, (terrain?.heightAt?.(gx, gz) ?? 0) + 0.06, gz);
    return { pos, ...aim(pos, V(e, cx, pos.y + 2.2, cz)) };
  },
  lidodeck: (e) => {
    const l = e.ctx.services.lido;
    if (!l) return null;
    const r = Math.max(l.radius, 40) * 0.6;
    const a = 2.3;
    const gx = l.center.x + Math.cos(a) * r;
    const gz = l.center.z + Math.sin(a) * r;
    const pos = V(e, gx, l.decks.main + 0.06, gz);
    return { pos, ...aim(pos, V(e, l.center.x, pos.y + 2.2, l.center.z)) };
  },
};

function installPose(fn) {
  return `(() => {
    const e = window.__dz;
    if (!e) return;
    const V = ${V.toString()};
    const aim = ${aim.toString()};
    const pose = ${fn.toString()};
    if (e.__dzPin) clearInterval(e.__dzPin);
    const apply = () => {
      const p = e.ctx.services.player;
      if (!p) return;
      const want = pose(e);
      if (!want) return;
      p.teleport(want.pos);
      p.velocity.set(0, 0, 0);
      if (typeof want.yaw === "number") p.yaw = want.yaw;
      if (typeof want.pitch === "number") p.pitch = want.pitch;
      p.health = p.maxHealth;
      p.shield = p.maxShield;
    };
    apply();
    e.__dzPin = setInterval(apply, 8);
  })()`;
}

/**
 * Sample points, in normalised screen space (0..1 from top-left).
 *
 * Chosen off `shots/gnd/street.png`: a column down the dark field on the left,
 * and a control column on the ground that renders correctly. A probe with no
 * control is how you conclude "everything is black" from a frame that is half
 * correctly lit.
 */
/*
 * A GRID, not hand-picked coordinates.
 *
 * The first version of this listed points read off a frame from an earlier
 * run, and the frame did not match: same vantage, different heading, so every
 * "dark near" label pointed at a wall. Sweeping the frame costs one raycast
 * per cell and removes the step where a human decides in advance where the
 * problem is — which is the step that was wrong.
 */
const COLS = 7;
const ROWS = 5;
const POINTS = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const u = (c + 0.5) / COLS;
    const v = (r + 0.5) / ROWS;
    POINTS.push([`r${r}c${c}`, Math.round(u * 1000) / 1000, Math.round(v * 1000) / 1000]);
  }
}

/*
 * The engine publishes itself as `window.__dz` but not the three namespace, and
 * a runtime `import("three")` is not rewritten by Vite (it only transforms
 * imports it sees at transform time), so the bare specifier does not resolve in
 * the page. The dev server does serve the real file, so ask for it by path.
 *
 * A SECOND three instance is fine here and it is worth saying why, because it
 * looks like the kind of thing that silently returns nothing: `intersectObject`
 * dispatches to `object.raycast()`, which is the APP's implementation on the
 * APP's geometry. All this instance supplies is the ray plus some plain
 * numbers. `setFromCamera` likewise reads only `.x`/`.y` off its argument, so a
 * plain object stands in for Vector2.
 */
async function probe(points) {
  const e = window.__dz;
  let THREE = null;
  for (const url of ["/node_modules/three/build/three.module.js", "/node_modules/.vite/deps/three.js"]) {
    try { THREE = await import(url); if (THREE?.Raycaster) break; } catch (err) { THREE = null; }
  }
  if (!THREE?.Raycaster) return { ok: false, why: "could not load a Raycaster into the page" };
  const cam = e.ctx.camera;
  const rc = new THREE.Raycaster();
  rc.far = 4000;
  /*
   * Find the renderer defensively and REPORT where it was found. __dz is a
   * debug hook, not an API — it has been the Engine and it has been the boot
   * result, and a probe that assumes one shape dies with a TypeError that says
   * nothing about the world. The shape goes in the output so the next person
   * does not have to guess either.
   */
  const shape = { e: Object.keys(e ?? {}), ctx: Object.keys(e?.ctx ?? {}) };
  const renderer = e?.ctx?.renderer ?? e?.renderer ?? e?.engine?.ctx?.renderer ?? null;
  const canvas = renderer?.domElement ?? document.querySelector("canvas");
  const gl = renderer ? renderer.getContext() : (canvas?.getContext("webgl2") ?? canvas?.getContext("webgl") ?? null);
  const W = canvas?.width ?? 0;
  const H = canvas?.height ?? 0;

  /*
   * Read the pixels back inside a rAF callback, before the browser composites.
   * The engine's canvas is created without preserveDrawingBuffer, so outside
   * that window the drawing buffer is already gone and readPixels returns a
   * frame of zeros — which is indistinguishable from "the ground really is
   * black" and would have confirmed whichever theory was being tested.
   */
  await new Promise((r) => requestAnimationFrame(() => r()));

  const out = [];
  for (const [label, u, v] of points) {
    // ---- what the RENDERER put there -------------------------------------
    // Framebuffer origin is bottom-left; screen v is top-down.
    const px = Math.min(W - 1, Math.max(0, Math.round(u * W)));
    const py = Math.min(H - 1, Math.max(0, Math.round((1 - v) * H)));
    const buf = new Uint8Array(4);
    // Not fatal: the raycast half of this report is the half that identifies
    // the object, and it is worth having even with no readback.
    try { if (gl) gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf); } catch {}
    const srgb = [buf[0] / 255, buf[1] / 255, buf[2] / 255];
    const lum = 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];

    // ---- what the SCENE has there ----------------------------------------
    rc.setFromCamera({ x: u * 2 - 1, y: -(v * 2 - 1) }, cam);
    const hits = rc.intersectObjects(e.ctx.scene.children, true);
    // The sky dome is not an answer to "what is this ground", and neither is
    // anything the player is wearing — both sit in front of every ray.
    const hit = hits.find((h) => {
      const n = (h.object.name || "").toLowerCase();
      if (n.includes("sky") || n.includes("cloud") || n.includes("rain")) return false;
      if (h.distance < 1.2) return false;
      return h.object.visible !== false;
    });

    const rec = { label, u, v, px, py, srgb: srgb.map((x) => Math.round(x * 1000) / 1000), lum: Math.round(lum * 1000) / 1000 };
    if (!hit) { rec.hit = null; out.push(rec); continue; }

    const o = hit.object;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const chain = [];
    for (let p = o; p && chain.length < 6; p = p.parent) chain.push(p.name || p.type);
    rec.hit = {
      name: o.name || "(unnamed)",
      type: o.type,
      chain,
      instanced: o.isInstancedMesh === true,
      count: o.isInstancedMesh ? o.count : undefined,
      dist: Math.round(hit.distance * 10) / 10,
      at: { x: Math.round(hit.point.x), y: Math.round(hit.point.y * 10) / 10, z: Math.round(hit.point.z) },
      mat: m ? {
        type: m.type,
        color: m.color ? [m.color.r, m.color.g, m.color.b].map((x) => Math.round(x * 1000) / 1000) : null,
        map: !!m.map,
        vertexColors: !!m.vertexColors,
        rough: m.roughness,
        metal: m.metalness,
        aoMapIntensity: m.aoMapIntensity,
        emissive: m.emissive ? [m.emissive.r, m.emissive.g, m.emissive.b].map((x) => Math.round(x * 1000) / 1000) : null,
        // Map presence, because metalness/roughness read 1 on materials that
        // are plainly not mirrors: the glTF convention is to leave the scalar
        // at 1 and let a map modulate it. Without these two booleans the
        // scalar alone says "everything in this world is polished metal",
        // which is a very convincing wrong answer.
        metalMap: !!m.metalnessMap,
        roughMap: !!m.roughnessMap,
        aoMap: !!m.aoMap,
        normalMap: !!m.normalMap,
        transparent: m.transparent,
        opacity: m.opacity,
        side: m.side,
      } : null,
    };
    out.push(rec);
  }

  // Light budget, so "the ground is dark" can be separated from "the sun is off".
  const lights = [];
  e.ctx.scene.traverse((o) => {
    if (o.isLight) lights.push({
      type: o.type, name: o.name || "", intensity: Math.round(o.intensity * 1000) / 1000,
      color: [o.color.r, o.color.g, o.color.b].map((x) => Math.round(x * 100) / 100),
      ground: o.groundColor ? [o.groundColor.r, o.groundColor.g, o.groundColor.b].map((x) => Math.round(x * 100) / 100) : undefined,
      castShadow: o.castShadow === true,
    });
  });

  return {
    ok: true, out, lights, shape,
    rendererFound: !!renderer,
    toneMapping: renderer?.toneMapping ?? null,
    exposure: renderer ? Math.round(renderer.toneMappingExposure * 1000) / 1000 : null,
    envSet: !!e.ctx.scene.environment,
    fog: e.ctx.scene.fog ? { type: e.ctx.scene.fog.type ?? "Fog", color: [e.ctx.scene.fog.color.r, e.ctx.scene.fog.color.g, e.ctx.scene.fog.color.b].map((x) => Math.round(x*1000)/1000), near: e.ctx.scene.fog.near, far: e.ctx.scene.fog.far, density: e.ctx.scene.fog.density } : null,
  };
}

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  stdio: ["ignore", "pipe", "pipe"],
});
vite.stdout.on("data", () => {});
vite.stderr.on("data", () => {});
if (!(await up(BASE, 120000))) {
  console.error("vite never came up");
  vite.kill();
  process.exit(1);
}

// Same launch as `dz-shot.mjs`: the pinned Chromium in the image, and ANGLE
// over SwiftSHADER, which is the only renderer this container has.
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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  class Deaf extends EventTarget {
    constructor() { super(); this.readyState = 1; this.url = ""; this.protocol = "vite-hmr"; }
    send() {} close() { this.readyState = 3; }
  }
  window.WebSocket = new Proxy(Real, {
    construct(t, a) {
      const p = a[1];
      const hmr = Array.isArray(p) ? p.includes("vite-hmr") : p === "vite-hmr";
      return hmr ? new Deaf() : new t(...a);
    },
  });
});

await page.goto(`${BASE}/drop-zero?shot=1&q=${QUALITY}`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction("window.__dzReady === true", null, { timeout: WAIT });
await page.evaluate(`(() => { const m = window.__dz?.ctx?.services?.match; m?.skipToLive?.(); })()`);
await page.waitForFunction(
  `(() => { const e = window.__dz, p = e?.ctx?.services?.player, m = e?.ctx?.services?.match;
    return !!p && !!m && m.phase === "live" && p.state !== "bus" && p.state !== "skydive" && p.state !== "glide"; })()`,
  null, { timeout: 60000 },
);

const pose = POSES[SHOT];
if (!pose) { console.error(`no pose "${SHOT}"`); await browser.close(); vite.kill(); process.exit(1); }
await page.evaluate(installPose(pose));
await page.waitForTimeout(SETTLE);

/*
 * Everything from here in a finally: a probe that throws used to leave its
 * `vite` behind, and a morning of runs left seven dev servers alive on seven
 * ports, each holding a module graph of this repo in memory.
 */
let res = null;
try {
  res = await page.evaluate(probe, POINTS);
  /*
   * Photograph the same instant the numbers came from.
   *
   * Reading sample coordinates off a frame captured by a DIFFERENT run is how
   * the first pass of this probe ended up describing a patch of ground that
   * was not the patch being argued about — the vantage matched, the frame did
   * not. One run, one frame, one table.
   */
  await mkdir(OUT, { recursive: true });
  // 600 s, matching dz-shot. Under SwiftSHADER a frame is ~50 ms and
  // Playwright waits for a stable one; the 30 s default expires first and
  // takes the whole probe down with it after the numbers are already in hand.
  await page.screenshot({ path: `${OUT}/${SHOT}.png`, timeout: 600000, animations: "disabled" });
  console.log(`frame: ${OUT}/${SHOT}.png`);
} catch (err) {
  console.error("probe threw:", err.message);
} finally {
  await browser.close().catch(() => {});
  vite.kill("SIGTERM");
}

if (!res) {
  process.exitCode = 1;
} else if (!res.ok) {
  console.error("probe failed:", res.why);
} else {
  console.log(`\n=== ${SHOT} — lights ===`);
  for (const l of res.lights) console.log(" ", JSON.stringify(l));
  console.log(`shape: __dz=${JSON.stringify(res.shape.e)} ctx=${JSON.stringify(res.shape.ctx)}`);
  console.log(`renderer=${res.rendererFound} tone=${res.toneMapping} exposure=${res.exposure} env=${res.envSet} fog=${JSON.stringify(res.fog)}`);
  console.log(`\n=== grid (${COLS}x${ROWS}) — one line per cell ===`);
  for (const r of res.out) {
    const h = r.hit;
    const what = h ? `${h.name} [${h.type}${h.instanced ? " xI" : ""}] ${h.dist}m` : "sky";
    console.log(`${r.label.padEnd(6)} lum=${String(r.lum).padEnd(6)} ${what}`);
  }
  console.log(`\n=== darkest six, in full ===`);
  const dark = res.out.filter((r) => r.hit).sort((a, b) => a.lum - b.lum).slice(0, 6);
  for (const r of dark) {
    const h = r.hit;
    console.log(`${r.label} u=${r.u} v=${r.v} lum=${r.lum} rgb=${JSON.stringify(r.srgb)}`);
    console.log(`   ${h.name} [${h.type}${h.instanced ? ` x${h.count}` : ""}] d=${h.dist}m at ${JSON.stringify(h.at)}`);
    console.log(`   chain ${h.chain.join(" < ")}`);
    console.log(`   mat ${JSON.stringify(h.mat)}`);
  }
}

