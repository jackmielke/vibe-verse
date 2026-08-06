#!/usr/bin/env node
/**
 * dz-probe — ask the running world about itself.
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
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message.slice(0, 300)}`));

await page.goto(`${BASE}/drop-zero?shot=1&q=high`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction("window.__dzReady === true", null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(15000);

// Pose exactly like `dz-shot town`, so the state we dump is the state that
// produced the white frame — not the battle-bus spawn frame.
await page.evaluate(`(() => {
  const e = window.__dz;
  if (!e) return;
  if (!e.__dzBaseRender) e.__dzBaseRender = e.renderOverride;
  const pose = (e) => {
    const p = e.ctx.services.pois ?? [];
    const t = p.find((x) => x.tier === "landmark") ?? p[0];
    const c = e.ctx.camera;
    if (!t) { c.position.set(0, 120, 220); c.lookAt(0, 20, 0); return; }
    const r = Math.max(t.radius, 60);
    c.position.set(t.center.x - r * 1.5, t.center.y + r * 0.85, t.center.z + r * 1.5);
    c.lookAt(t.center.x, t.center.y + 8, t.center.z);
  };
  e.renderOverride = (dt) => {
    pose(e);
    e.ctx.camera.updateMatrixWorld();
    if (e.__dzBaseRender) e.__dzBaseRender(dt);
    else e.ctx.renderer.render(e.ctx.scene, e.ctx.camera);
  };
})()`);
await page.waitForTimeout(25000);

const report = await page.evaluate(`(() => {
  const e = window.__dz;
  if (!e) return { error: "no engine" };
  const out = { visibleTerrain: [], notes: [] };
  const renderer = e.ctx.renderer;
  const gl = renderer.getContext();

  const texInfo = (t) => {
    if (!t) return null;
    if (!t.isTexture) return { NOT_A_TEXTURE: String(t).slice(0,80) };
    const img = t.image;
    return { w: img?.width ?? null, h: img?.height ?? null, cs: t.colorSpace, uuid: t.uuid.slice(0,8) };
  };

  let terrainMat = null;
  const attrStats = (geom, name) => {
    const a = geom.attributes[name];
    if (!a) return "ABSENT";
    const arr = a.array;
    const n = a.itemSize;
    const mn = new Array(n).fill(Infinity), mx = new Array(n).fill(-Infinity);
    let sum = new Array(n).fill(0);
    const count = Math.min(a.count, 4000);
    for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) {
      const v = arr[i*n+k]; if (v<mn[k]) mn[k]=v; if (v>mx[k]) mx[k]=v; sum[k]+=v;
    }
    return { type: arr.constructor.name, normalized: a.normalized, itemSize: n,
             count: a.count, min: mn, max: mx, mean: sum.map(s=>+(s/count).toFixed(2)) };
  };

  e.ctx.scene.traverse((o) => {
    if (!o.isMesh) return;
    const nm = (o.name || "") + "|" + (o.parent?.name || "");
    if (!/terrain/i.test(nm)) return;
    if (o.material) terrainMat = o.material;
    if (!o.visible || out.visibleTerrain.length >= 3) return;
    out.visibleTerrain.push({
      name: o.name, visible: o.visible,
      matUuid: o.material?.uuid.slice(0,8),
      color: o.material?.color ? "#"+o.material.color.getHexString() : null,
      hasUserDataShader: !!o.material?.userData?.shader,
      defines: o.material?.defines ? Object.keys(o.material.defines) : null,
      aSplat: attrStats(o.geometry, "aSplat"),
      aAux: attrStats(o.geometry, "aAux"),
    });
  });
  out.visibleTerrainCount = out.visibleTerrain.length;

  if (terrainMat) {
    const props = renderer.properties.get(terrainMat);
    out.matProps = { keys: Object.keys(props) };
    const u = props.uniforms;
    if (u) {
      out.uniforms = {};
      for (const k of Object.keys(u)) {
        const v = u[k]?.value;
        if (v && v.isTexture) out.uniforms[k] = texInfo(v);
        else if (v && v.isColor) out.uniforms[k] = "col#"+v.getHexString();
        else if (v && v.isVector4) out.uniforms[k] = [v.x,v.y,v.z,v.w];
        else if (typeof v === "number") out.uniforms[k] = v;
        else out.uniforms[k] = v === null ? "NULL" : (v === undefined ? "UNDEFINED" : typeof v);
      }
    } else out.uniforms = "NO props.uniforms";

    const prog = props.currentProgram;
    if (prog) {
      out.program = { cacheKey: String(prog.cacheKey).slice(0,120) };
      try {
        const fs = gl.getShaderSource(prog.fragmentShader);
        const vs = gl.getShaderSource(prog.vertexShader);
        out.program.fsLen = fs.length;
        out.program.fsHasDzSurface = fs.includes("void dzSurface");
        out.program.fsCallsDzSurface = fs.includes("dzSurface( dzAlbedo");
        out.program.fsHasDzCheap = /#define DZ_CHEAP/.test(fs);
        out.program.vsHasASplat = /aSplat/.test(vs);
        out.program.fsInfoLog = gl.getShaderInfoLog(prog.fragmentShader).slice(0,600);
        out.program.vsInfoLog = gl.getShaderInfoLog(prog.vertexShader).slice(0,600);
        out.program.progInfoLog = gl.getProgramInfoLog(prog.program).slice(0,600);
        out.program.linked = gl.getProgramParameter(prog.program, gl.LINK_STATUS);
        // What the map_fragment slot actually turned into.
        const i = fs.indexOf("dzAlbedo; float dzRough");
        out.program.mapSlot = i >= 0 ? fs.slice(i-80, i+220) : "NOT FOUND";
        // Which sampler units are bound
        const au = prog.getUniforms();
        out.program.uniformNames = Object.keys(au.map || {}).filter(n=>/^u[A-Z]/.test(n));
      } catch (err) { out.program.err = String(err).slice(0,200); }
    } else out.program = "NO currentProgram";
  }

  const ms = e.ctx.services.materials;
  if (ms) {
    out.materialsService = {};
    for (const n of ["grass", "dirt", "rock", "sand"]) {
      try {
        const m = ms.get(n);
        out.materialsService[n] = { map: texInfo(m?.map), normalMap: texInfo(m?.normalMap) };
      } catch (err) { out.materialsService[n] = { error: String(err).slice(0, 120) }; }
    }
  }

  out.toneMappingExposure = renderer.toneMappingExposure;
  out.toneMapping = renderer.toneMapping;
  out.outputColorSpace = renderer.outputColorSpace;
  out.quality = e.ctx.quality;
  out.ready = window.__dzReady;
  out.systems = (e.systems || []).map(s => s.name);
  out.hasRenderOverride = !!e.renderOverride;
  out.running = e.running;
  out.sceneUuid = e.ctx.scene.uuid.slice(0,8);
  // Terrain census
  let tTotal = 0, tVis = 0;
  const root = e.ctx.scene.getObjectByName("dz.terrain");
  out.rootFound = !!root;
  if (root) {
    out.rootVisible = root.visible;
    out.rootChildren = root.children.length;
    for (const c of root.children) { tTotal++; if (c.visible) tVis++; }
  }
  out.terrainMeshes = { total: tTotal, visible: tVis };
  out.cam = e.ctx.camera ? [ +e.ctx.camera.position.x.toFixed(1), +e.ctx.camera.position.y.toFixed(1), +e.ctx.camera.position.z.toFixed(1) ] : null;
  // Big non-terrain meshes that could be the white sheet
  out.bigMeshes = [];
  e.ctx.scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const g = o.geometry;
    if (!g) return;
    if (!g.boundingSphere) { try { g.computeBoundingSphere(); } catch {} }
    const r = g.boundingSphere?.radius ?? 0;
    if (r > 400 && out.bigMeshes.length < 14) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      out.bigMeshes.push({ name: o.name || "(anon)", parent: o.parent?.name, r: Math.round(r),
        matType: m?.type, matName: m?.name, col: m?.color ? "#"+m.color.getHexString() : null,
        hasMap: !!m?.map, y: +o.position.y.toFixed(1) });
    }
  });
  return out;
})()`);

console.log(JSON.stringify(report, null, 1));
const interesting = logs.filter((l) =>
  /dz-dbg|terrain|shader|PAGEERROR/i.test(l),
);
console.log("logs total:", logs.length, "matched:", interesting.length);
if (interesting.length) console.log("\n--- console ---\n" + interesting.slice(-40).join("\n"));

await browser.close();
if (server) server.kill();
