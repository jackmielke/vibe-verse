#!/usr/bin/env node
/**
 * ocean-probe — boot /city and interrogate the sea from inside the page.
 *
 * Screenshots tell you something is missing; they do not tell you whether the
 * mesh is absent, the shader linked, or it is simply below the horizon. So
 * this reaches in through the DEV-only `__cityOcean` handle and repaints the
 * two meshes with flat unlit colours: if the flat version appears, the
 * geometry and the transform are right and the problem is in the shading; if
 * it does not, the mesh is not being drawn at all.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.CITY_PORT ?? 5182);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = (process.env.PROBE_SHOT ?? "/tmp/ocean-probe").replace(/\.png$/, "");

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch { /* not yet */ }
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
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
page.on("pageerror", (e) => console.log(`PAGEERROR ${e}`));
page.on("console", (m) => {
  const t = m.text();
  if (/supabase|websocket|ERR_CONNECTION|tunnel|React Router|caniuse|fetch failed/i.test(t)) return;
  if (m.type() === "error" || /THREE|shader|GLSL|ERROR:/i.test(t)) console.log(`${m.type().toUpperCase()} ${t.slice(0, 1600)}`);
});

await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(20000);
await page.waitForFunction(() => typeof window.__cityOcean === "object", null, { timeout: 90000 });
console.log("--- booted ---");

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /Night|Day/.test(b.textContent ?? ""));
  if (btn && /Night/.test(btn.textContent ?? "")) return; // already day
  btn?.click();
});
await page.waitForTimeout(2500);

console.log(
  "ocean:",
  await page.evaluate(() => {
    const g = window.__cityOcean;
    if (!g) return "missing";
    g.updateWorldMatrix(true, true);
    return g.children.map((m) => {
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      return {
        mat: m.material.type,
        visible: m.visible,
        inScene: !!g.parent,
        parent: g.parent?.type,
        verts: m.geometry.getAttribute("position").count,
        bbox: [bb.min.toArray().map((v) => +v.toFixed(1)), bb.max.toArray().map((v) => +v.toFixed(1))],
        world: m.matrixWorld.elements.slice(12, 15).map((v) => +v.toFixed(2)),
        frustumCulled: m.frustumCulled,
        transparent: m.material.transparent,
        opacity: m.material.opacity,
      };
    });
  }),
);

async function pose(at, d, p, y) {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(([a, dd, pp, yy]) => { window.__cityWarp(a[0], a[1], a[2]); window.__cityCam(dd, pp, yy); }, [at, d, p, y]);
    await page.waitForTimeout(900);
  }
}

const GOD = [[0, 2, 6], 700, 1.0, 0.6];
const SHORE = [[250, 1, 20], 46, 0.2, 1.5708];

await pose(...GOD);
await page.screenshot({ path: `${OUT}-a-normal.png` });
console.log("shot a: as shipped");

// Flat-paint both meshes. If the ring and the disc appear now, geometry and
// transforms are fine and the shading is what is hiding them.
await page.evaluate(() => {
  const [sand, water] = window.__cityOcean.children;
  window.__probeSaved = { map: sand.material.map, frag: water.material.fragmentShader };
  sand.material.map = null;
  sand.material.vertexColors = false;
  sand.material.emissive.set(0xff0000);
  sand.material.needsUpdate = true;
  water.visible = false;
});
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}-b-flat.png` });
console.log("shot b: flat red sand / green sea");

// Water back to its own shader, sand still flat: isolates which one is at fault.
// Water back on, painted with its own wave normals: if this is flat grey the
// Gerstner sum is the problem, if it is a rippled pastel it is the shading.
await page.evaluate(() => {
  const [, water] = window.__cityOcean.children;
  water.visible = true;
  water.material.fragmentShader = `
    varying vec3 vWorld; varying vec3 vNormal; varying float vFold;
    varying float vCrest; varying float vCamDist;
    void main(){ gl_FragColor = vec4(normalize(vNormal) * 0.5 + 0.5, 1.0); }`;
  water.material.transparent = false;
  water.material.needsUpdate = true;
});
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}-c-shaderwater.png` });
console.log("shot c: real water over flat sand");

await page.evaluate(() => {
  const [sand, water] = window.__cityOcean.children;
  sand.material.map = window.__probeSaved.map;
  sand.material.vertexColors = true;
  sand.material.emissive.set(0x000000);
  sand.material.needsUpdate = true;
  water.material.fragmentShader = window.__probeSaved.frag;
  water.material.transparent = true;
  water.material.needsUpdate = true;
});
await pose(...SHORE);
await page.screenshot({ path: `${OUT}-d-shore.png` });
console.log("shot d: shore, as shipped");

console.log("shot written");
await browser.close();
server?.kill();
