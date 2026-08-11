#!/usr/bin/env node
/**
 * glb-compare — photograph two GLBs from the same camera, side by side.
 *
 * The only honest test of an asset optimisation. `gltf-transform` will happily
 * report "40 MB → 2.7 MB" for a file it has quietly turned into a smear, and
 * the number is the part you want to believe. So: same scene, same lights, same
 * framing, two renders, one picture, and a person looks at it.
 *
 *   node scripts/glb-compare.mjs before.glb after.glb [out.png]
 *
 * It drives the app's own dev server, for the same reason `character-shots.mjs`
 * does: the three.js that renders the comparison is then the exact build the
 * game ships, including which glTF extensions its GLTFLoader understands —
 * which is the whole question when the optimiser has just added one.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const [a, b, out = "compare.png"] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: glb-compare.mjs <before.glb> <after.glb> [out.png]");
  process.exit(1);
}

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
/* The two models are served by intercepting their requests rather than by
   copying them into public/: a 40 MB GLB is 54 MB of base64 if you post it
   into the page, and dropping files into public/ under a running Vite raced
   its static middleware — the second model 404'd to index.html and arrived at
   GLTFLoader as "<!doctype". Interception has neither problem. */
const stage = ["__cmp_a.glb", "__cmp_b.glb"];
const cleanup = () => {};

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
if (server && !(await up(BASE, 120000))) {
  console.error("dev server never came up");
  cleanup();
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
const page = await browser.newPage({ viewport: { width: 1400, height: 760 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
for (const [i, f] of [a, b].entries()) {
  await page.route(`**/${stage[i]}`, (route) =>
    route.fulfill({ status: 200, contentType: "model/gltf-binary", body: readFileSync(f) }),
  );
}
await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded", timeout: 90000 });

const shots = await page.evaluate(async (urls) => {
  const THREE = await import("/node_modules/three/build/three.module.js");
  const { GLTFLoader } = await import(
    "/node_modules/three/examples/jsm/loaders/GLTFLoader.js"
  );
  const out = [];
  for (const src of urls) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(660, 620);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdff0ff, 0x35406a, 2.4));
    const key = new THREE.DirectionalLight(0xfff4dc, 2.6);
    key.position.set(3, 5, 2);
    scene.add(key);
    let err = "";
    const gltf = await new Promise((res) =>
      new GLTFLoader().load(src, res, undefined, (e) => {
        err = String(e?.message ?? e);
        res(null);
      }),
    );
    let tris = 0;
    if (gltf) {
      scene.add(gltf.scene);
      gltf.scene.traverse((o) => {
        /* A SkinnedMesh carries the bounding volume of its *bind pose*, which
           for these characters is a T-pose the renderer then culls against a
           camera framed on something else — both sides of the comparison came
           back as empty frames until this line, which is a harness bug that
           looks exactly like the optimiser having deleted the model. */
        o.frustumCulled = false;
        if (o.isMesh) {
          tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
        }
      });
      /* Framed from the model's own bounds so both renders fill the same
         box on screen, whatever the optimiser did to the hierarchy. */
      /* Measured off the geometry rather than off `setFromObject`, for the
         same reason: on a skinned mesh the object-space box is the bind pose's
         and can be nowhere near where the thing actually is. */
      const box = new THREE.Box3();
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox();
        box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
      });
      if (box.isEmpty()) box.setFromObject(gltf.scene);
      const size = box.getSize(new THREE.Vector3()).length() || 1;
      const centre = box.getCenter(new THREE.Vector3());
      const cam = new THREE.PerspectiveCamera(38, 660 / 620, size / 800, size * 14);
      cam.position.copy(centre).add(
        new THREE.Vector3(size * 0.5, size * 0.34, size * 0.58),
      );
      cam.lookAt(centre);
      renderer.render(scene, cam);
    }
    out.push({ url: renderer.domElement.toDataURL("image/png"), tris: Math.round(tris), err });
    renderer.dispose();
  }
  return out;
}, stage.map((f) => `/${f}`));

const mb = (f) => (statSync(f).size / 1048576).toFixed(2);
const label = (f, s) =>
  `${f.split("/").pop()} · ${mb(f)} MB · ${s.tris.toLocaleString()} tris${s.err ? ` · FAILED: ${s.err}` : ""}`;

await page.setContent(
  `<body style="margin:0;background:#0d1424;display:flex;gap:8px;padding:8px;font:600 15px system-ui;color:#9fe">
${[a, b]
  .map(
    (f, i) =>
      `<div style="text-align:center"><img src="${shots[i].url}" style="display:block;border-radius:8px"/><div style="padding:6px">${label(f, shots[i])}</div></div>`,
  )
  .join("")}
</body>`,
);
await page.waitForTimeout(400);
await page.screenshot({ path: out, fullPage: true });
console.log(`${label(a, shots[0])}\n  →  ${label(b, shots[1])}`);
if (shots.some((s) => s.err)) process.exitCode = 1;

await browser.close();
if (server) server.kill();
cleanup();
process.exit(process.exitCode ?? 0);
