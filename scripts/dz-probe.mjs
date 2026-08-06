#!/usr/bin/env node
/**
 * dz-probe — ask the running world about itself.
 *
 * Screenshots tell you a surface is wrong; they do not tell you whether the
 * albedo map is missing, black, or simply unlit. This boots the route and
 * dumps the actual material state of the terrain so a fix targets the cause.
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
await page.waitForTimeout(20000);

const report = await page.evaluate(`(() => {
  const e = window.__dz;
  if (!e) return { error: "no engine" };
  const out = { terrainMaterials: [], counts: {} };

  const texInfo = (t) => {
    if (!t) return null;
    const img = t.image;
    return {
      w: img?.width ?? null,
      h: img?.height ?? null,
      colorSpace: t.colorSpace,
      repeat: t.repeat ? [t.repeat.x, t.repeat.y] : null,
      hasImage: !!img,
    };
  };

  let meshes = 0;
  e.ctx.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    meshes++;
    const name = (o.name || o.parent?.name || "").toLowerCase();
    const isTerrain = name.includes("terrain") || name.includes("chunk") || name.includes("ground");
    if (!isTerrain || out.terrainMaterials.length >= 3) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      out.terrainMaterials.push({
        objectName: o.name,
        parentName: o.parent?.name,
        type: m.type,
        visible: o.visible,
        color: m.color ? "#" + m.color.getHexString() : null,
        vertexColors: m.vertexColors,
        map: texInfo(m.map),
        normalMap: texInfo(m.normalMap),
        roughnessMap: texInfo(m.roughnessMap),
        roughness: m.roughness,
        metalness: m.metalness,
        uniformKeys: m.userData?.shader
          ? Object.keys(m.userData.shader.uniforms || {}).slice(0, 24)
          : null,
        defines: m.defines ? Object.keys(m.defines).slice(0, 12) : null,
      });
    }
  });
  out.counts.meshes = meshes;

  // Materials service sanity: are the ground textures real?
  const ms = e.ctx.services.materials;
  if (ms) {
    out.materialsService = {};
    for (const n of ["grass", "dirt", "rock", "sand"]) {
      try {
        const m = ms.get(n);
        out.materialsService[n] = {
          type: m?.type,
          color: m?.color ? "#" + m.color.getHexString() : null,
          map: texInfo(m?.map),
        };
      } catch (err) {
        out.materialsService[n] = { error: String(err).slice(0, 120) };
      }
    }
  } else {
    out.materialsService = "MISSING";
  }

  out.toneMappingExposure = e.ctx.renderer.toneMappingExposure;
  out.sky = e.ctx.services.sky
    ? { daylight: e.ctx.services.sky.daylight, time: e.ctx.services.sky.time }
    : "MISSING";
  return out;
})()`);

console.log(JSON.stringify(report, null, 1));
const interesting = logs.filter((l) =>
  /terrain|shader|material|warn|error|census|planted/i.test(l),
);
if (interesting.length) console.log("\n--- console ---\n" + interesting.slice(0, 30).join("\n"));

await browser.close();
if (server) server.kill();
