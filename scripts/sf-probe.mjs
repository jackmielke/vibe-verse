#!/usr/bin/env node
/**
 * sf-probe — attach to a running /sf page and dump scene diagnostics.
 *
 * The screenshot harness tells you *that* something looks wrong. This tells
 * you why: how many chunks are resident, what is actually in the scene graph,
 * how much geometry each system contributed, and every console error the page
 * produced on the way there.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.SF_PORT ?? 5178);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT = process.argv[2] ?? "skyline";
const WAIT = Number(process.argv[3] ?? 14000);

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server = (await up(BASE, 1000))
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
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}\n${e.stack ?? ""}`));

await page.goto(`${BASE}/sf?shot=${SHOT}&headless=1&quality=high`, {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
await page.waitForTimeout(WAIT);

const report = await page.evaluate(() => {
  const out = { hook: null, scene: [], totals: {}, camera: null };
  const hook = window.__sf;
  if (hook) out.hook = { ready: hook.ready, pendingChunks: hook.pendingChunks, stats: hook.stats };

  // Walk every WebGLRenderer-owned scene we can reach through R3F's store.
  const canvas = document.querySelector("canvas");
  const key = canvas && Object.keys(canvas).find((k) => k.startsWith("__r3f"));
  const root = key ? canvas[key]?.root?.getState?.() : null;
  if (!root) return { ...out, error: "no r3f root" };

  out.camera = root.camera.position.toArray().map((v) => Math.round(v));

  const byName = {};
  let meshes = 0;
  let tris = 0;
  root.scene.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    const n = g?.index ? g.index.count / 3 : (g?.attributes?.position?.count ?? 0) / 3;
    tris += n;
    // Attribute the triangles to the nearest named ancestor.
    let p = o;
    let name = "(unnamed)";
    while (p) {
      if (p.name) { name = p.name; break; }
      p = p.parent;
    }
    byName[name] = byName[name] ?? { meshes: 0, tris: 0, visible: 0 };
    byName[name].meshes++;
    byName[name].tris += n;
    if (o.visible) byName[name].visible++;
  });

  out.totals = { meshes, tris: Math.round(tris) };
  out.scene = Object.entries(byName).map(([name, v]) => ({
    name,
    meshes: v.meshes,
    visible: v.visible,
    tris: Math.round(v.tris),
  }));
  return out;
});

console.log(JSON.stringify(report, null, 2));
console.log("\n--- console (last 40) ---");
for (const l of logs.slice(-40)) console.log(l);

await browser.close();
if (server) server.kill();
