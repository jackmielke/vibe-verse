#!/usr/bin/env node
/**
 * dz-probe — ask the running world about itself.
 *
 * Currently pointed at the shadow pipeline: it poses the world exactly the way
 * `dz-shot aerial` does (by driving the PLAYER, never the camera — see the long
 * note in dz-shot.mjs about why bypassing the engine measures the harness), then
 * dumps the key light, its cascade, and a readback of the shadow map itself.
 *
 * The readback is the decisive bit. three renders directional shadows with a
 * MeshDepthMaterial at RGBADepthPacking into a plain RGBA8 target, so an
 * untouched texel is (255,255,255,255) — the far plane. Any texel below that is
 * a caster that actually rasterised. "Are there shadows?" stops being a matter
 * of squinting at a 1600x900 png.
 *
 * Usage: node scripts/dz-probe.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.DZ_PORT ?? 5178);
const BASE = `http://127.0.0.1:${PORT}`;

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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message.slice(0, 300)}`));

await page.goto(`${BASE}/drop-zero?shot=1&q=high`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction("window.__dzReady === true", null, { timeout: 60000 }).catch(() => {});

/**
 * Put the match ON THE GROUND AND LIVE, with `match.skipToLive()`.
 *
 * This is the fourth thing this probe tried and the only one that works, and
 * the reason is worth writing down because it is the same class of mistake the
 * capture harness has made three times now.
 *
 * `match.jump()` only fires a request that the phase machine services, and the
 * phase machine is held at the title screen until the pointer locks — which a
 * headless page never does. So `jump()` is a no-op, `player.state` never
 * becomes "bus", the "wait until we leave the bus" loop exits on its first
 * iteration believing it succeeded, and the world stays in the warm-up
 * fly-over forever. Every frame captured that way is a bus frame, which is why
 * the HUD in shots/ says "BATTLE BUS 0:35".
 *
 * That also produces a completely convincing false "shadows are broken": while
 * the fly-over runs, match.ts calls sky.focus(cineLook) every fixed step, so
 * the shadow cascade is pinned wherever the cinematic happens to be aimed —
 * repeatedly, in measurement, 2 km out over open water with a seabed 60 m
 * below it. An empty shadow map is the correct output for that input.
 *
 * `skipToLive()` exists for exactly this case; match.ts says so in its own
 * comment. It starts the machine by hand and fast-forwards the warm-up and bus.
 */
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
      if (m.phase === "live") return "live after " + i + " ticks, player=" + e.ctx.services.player?.state;
    }
    return "phase stuck at " + m.phase;
  })()`)
  .catch((err) => `skipToLive threw: ${err.message}`);
console.log("live:", live);
await page.waitForTimeout(8000);

/** Pose: ground level in the landmark POI — where a cast shadow must be obvious. */
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
    p.pitch = 0;
  };
  apply();
  e.__dzPin = setInterval(apply, 8);
  return { poi: t ? t.name ?? "(unnamed)" : "NONE", want: [gx, +y.toFixed(1), gz] };
})()`);
console.log("posed:", JSON.stringify(posed));
await page.waitForTimeout(30000);
// The frame itself, because a shadow-map texel count is evidence and a picture
// is proof, and this file has been wrong about the difference before.
// DZ_PROBE_SHOT=0 skips it — a full 1600x900 SwiftSHADER composite is minutes.
if (process.env.DZ_PROBE_SHOT !== "0") {
  const shot = process.env.DZ_PROBE_SHOT || "shots/probe.png";
  await page.screenshot({ path: shot, timeout: 600000, animations: "disabled" });
  console.log("wrote", shot);
}

const report = await page.evaluate(`(() => {
  const e = window.__dz;
  if (!e) return { error: "no engine" };
  const out = {};
  const renderer = e.ctx.renderer;
  const sky = e.ctx.services.sky;
  const v3 = (v) => v ? [ +v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2) ] : null;

  out.renderer = {
    shadowEnabled: renderer.shadowMap.enabled,
    autoUpdate: renderer.shadowMap.autoUpdate,
    needsUpdate: renderer.shadowMap.needsUpdate,
    type: renderer.shadowMap.type,
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    outputColorSpace: renderer.outputColorSpace,
  };
  out.cam = v3(e.ctx.camera.position);
  out.quality = e.ctx.quality;
  const pl = e.ctx.services.player;
  out.player = pl ? { state: pl.state, pos: v3(pl.position) } : null;

  if (!sky) return Object.assign(out, { error: "no sky service" });
  const key = sky.sun;
  const sh = key.shadow;
  const sc = sh.camera;
  sc.updateMatrixWorld();
  out.sky = {
    time: +sky.time.toFixed(4),
    sunDir: v3(sky.sunDirection),
    sunElevationDeg: +(Math.asin(sky.sunDirection.y) * 180 / Math.PI).toFixed(2),
    daylight: +sky.daylight.toFixed(3),
    sunColor: "#" + sky.sunColor.getHexString(),
    horizonColor: "#" + sky.horizonColor.getHexString(),
    zenithColor: "#" + sky.zenithColor.getHexString(),
    fogColor: e.ctx.scene.fog ? "#" + e.ctx.scene.fog.color.getHexString() : null,
    fogDensity: e.ctx.scene.fog ? e.ctx.scene.fog.density : null,
  };
  out.key = {
    castShadow: key.castShadow,
    visible: key.visible,
    intensity: +key.intensity.toFixed(3),
    position: v3(key.position),
    target: v3(key.target.position),
    inScene: !!key.parent,
    targetInScene: !!key.target.parent,
  };
  out.shadowCam = {
    worldPos: v3(sc.getWorldPosition(new (e.ctx.camera.position.constructor)())),
    left: sc.left, right: sc.right, top: sc.top, bottom: sc.bottom,
    near: sc.near, far: sc.far,
    bias: sh.bias, normalBias: sh.normalBias,
    mapSize: [sh.mapSize.x, sh.mapSize.y],
    hasMap: !!sh.map,
    mapDims: sh.map ? [sh.map.width, sh.map.height] : null,
  };

  // How far along the light ray from the shadow camera does the ground sit?
  const t = e.ctx.services.terrain;
  const tgt = key.target.position;
  out.shadowCam.groundYUnderCentre = t ? +t.heightAt(tgt.x, tgt.z).toFixed(2) : null;
  out.shadowCam.distToCentre = +key.position.distanceTo(tgt).toFixed(1);

  // Census: shadow casters whose centre falls inside the cascade footprint.
  let casters = 0, castersInside = 0, receivers = 0;
  const V = e.ctx.camera.position.constructor;
  const p = new V();
  const R = sc.right;
  e.ctx.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (o.receiveShadow) receivers++;
    if (!o.castShadow || !o.visible) return;
    casters++;
    o.getWorldPosition(p);
    if (Math.abs(p.x - tgt.x) < R + 200 && Math.abs(p.z - tgt.z) < R + 200) castersInside++;
  });
  out.census = { casters, castersInside, receivers };

  // ---- The other half: does anything RECEIVE what the map wrote? ----------
  // A written shadow map proves the depth pass ran. It says nothing about the
  // lit pass. Any receiving material must have compiled with USE_SHADOWMAP and
  // must actually call getShadowMask() — if the world's materials were built
  // before the light existed, or a custom onBeforeCompile dropped the lights
  // chunk, the map is written every frame and read by nobody.
  out.receivers = [];
  const gl = renderer.getContext();
  const seen = new Set();
  e.ctx.scene.traverse((o) => {
    if (!o.receiveShadow || !o.visible || out.receivers.length >= 4) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || seen.has(m.uuid)) return;
    seen.add(m.uuid);
    const rec = { mesh: o.name || "(anon)", mat: m.type, matName: m.name || null };
    try {
      const prog = renderer.properties.get(m).currentProgram;
      if (!prog) { rec.program = "NOT COMPILED (never drawn)"; }
      else {
        const fs = gl.getShaderSource(prog.fragmentShader);
        // NB: this whole evaluate body is a JS template literal, so every
        // backslash has to survive one round of string escaping first.
        rec.useShadowMap = /#define USE_SHADOWMAP/.test(fs);
        rec.callsGetShadowMask = fs.indexOf("getShadowMask") >= 0;
        rec.hasDirLightShadow = fs.indexOf("directionalLightShadows[") >= 0;
        rec.numDirLightShadows = (fs.match(/NUM_DIR_LIGHT_SHADOWS[^0-9]*([0-9]+)/) || [])[1] ?? null;
        rec.shadowMapType = (fs.match(/SHADOWMAP_TYPE_[A-Z_]+/) || [])[0] ?? null;
        rec.shadowUniformBound = !!prog.getUniforms().map.directionalShadowMap;
      }
    } catch (err) { rec.err = String(err).slice(0, 160); }
    out.receivers.push(rec);
  });

  // ---- The decisive test: read the shadow map back. -----------------------
  // RGBADepthPacking, so an untouched texel is (255,255,255,255).
  if (sh.map) {
    const w = sh.map.width, h = sh.map.height;
    const q = Math.floor(w / 4);
    const rects = [
      [q, q, q * 2, q * 2, "centre-half"],
      [0, 0, q, q, "corner-lo"],
      [w - q, h - q, q, q, "corner-hi"],
    ];
    out.shadowMapSamples = [];
    for (const [x, y, rw, rh, name] of rects) {
      try {
        const buf = new Uint8Array(rw * rh * 4);
        renderer.readRenderTargetPixels(sh.map, x, y, rw, rh, buf);
        let written = 0, minR = 255, sum = 0;
        for (let i = 0; i < rw * rh; i++) {
          const r = buf[i*4];
          sum += r;
          if (r < minR) minR = r;
          if (r < 254) written++;
        }
        out.shadowMapSamples.push({
          name, texels: rw*rh, writtenTexels: written,
          pctWritten: +(100 * written / (rw*rh)).toFixed(2),
          minR, meanR: +(sum / (rw*rh)).toFixed(1),
        });
      } catch (err) {
        out.shadowMapSamples.push({ name, err: String(err).slice(0, 160) });
      }
    }
  }
  return out;
})()`);

console.log(JSON.stringify(report, null, 1));
const interesting = logs.filter((l) => /dz-dbg|shadow|shader|PAGEERROR|error/i.test(l));
console.log("logs total:", logs.length, "matched:", interesting.length);
if (interesting.length) console.log("\n--- console ---\n" + interesting.slice(-30).join("\n"));

await browser.close();
if (server) server.kill();
