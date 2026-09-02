#!/usr/bin/env node
/**
 * dz-refitprobe — run `measureRenderedBounds`/`refitByRender` on characters in
 * a real page and print what they computed. For when a turntable is blank
 * and the question is what the render-measured fit decided.
 *
 *   node scripts/dz-refitprobe.mjs Pirate_Anne Wizard
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const PORT = Number(process.env.DZ_PORT ?? 5275);
const BASE = `http://127.0.0.1:${PORT}`;
const ids = process.argv.slice(2);
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
const up = async () => { for (let i = 0; i < 240; i++) { try { const r = await fetch(BASE); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 500)); } return false; };
if (!(await up())) { vite.kill(); process.exit(1); }
const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ ...(existsSync(exe) ? { executablePath: exe } : {}), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("console.error", m.text()); });
  await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded", timeout: 120000 });
  const out = await page.evaluate(async (ids) => {
    const THREE = await import("/node_modules/three/build/three.module.js");
    const { CHARACTERS } = await import("/src/lib/characters.ts");
    const { loadCharacterRig, measureRenderedBounds, refitByRender } = await import("/src/lib/characterRig.ts");
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setSize(64, 64, false);
    const res = {};
    const fmt = (b) => ({ min: b.min.toArray().map((v) => +v.toFixed(3)), size: b.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3)) });
    for (const id of ids) {
      const spec = CHARACTERS.find((c) => c.id === id);
      const rig = await loadCharacterRig(spec, { height: 1.78, center: true, castShadow: false });
      const holder = new THREE.Group(); holder.add(rig.object);
      rig.update(0);
      rig.object.updateMatrixWorld(true);
      const before = new THREE.Box3().setFromObject(rig.object);
      const m = measureRenderedBounds(renderer, rig.object, before);
      const ok = refitByRender(renderer, rig, 1.78);
      rig.object.updateMatrixWorld(true);
      const after = new THREE.Box3().setFromObject(rig.object);
      const m2 = measureRenderedBounds(renderer, rig.object, after);
      res[id] = { before: fmt(before), measured: m, refit: ok, scale: +rig.object.scale.x.toFixed(4), posY: +rig.object.position.y.toFixed(3), after: fmt(after), measuredAfter: m2, size: rig.size.toArray().map((v) => +v.toFixed(2)) };
    }
    return res;
  }, ids);
  console.log(JSON.stringify(out, null, 1));
} finally { await browser.close().catch(() => {}); vite.kill(); }
