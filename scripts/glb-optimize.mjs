#!/usr/bin/env node
/**
 * glb-optimize — put the model files through gltf-transform, in place.
 *
 *   node scripts/glb-optimize.mjs                 # everything, dry run
 *   node scripts/glb-optimize.mjs --write         # everything, for real
 *   node scripts/glb-optimize.mjs --write src/assets/glb/rocky.glb
 *
 * ## Why this exists
 *
 * None of these files had ever been through an optimiser. `floating-island.glb`
 * was 38.7 MB and **1,049,034 triangles** — for a decorative island that renders
 * about 300 px across, behind a menu. That is not a download problem, it is a
 * frame-rate problem on every phone that opens the hub, and it is what a Meshy
 * export looks like when nobody runs the last step.
 *
 * ## The recipe, and what is deliberately not in it
 *
 * `optimize` with:
 *   - **weld + join + simplify** — the big one. These meshes are already
 *     low-poly *stylistically*; they were merely exported at absurd density, so
 *     decimation removes vertices that were describing a flat facet with two
 *     hundred triangles. The island came out visually identical at 7% of the
 *     triangles; `glb-compare.mjs` is how that was established rather than
 *     hoped.
 *   - **texture-compress webp, capped at 1024** — three.js reads
 *     `EXT_texture_webp` natively, and a 2048² albedo on a background prop is
 *     22 MB of VRAM for something nobody looks at closely.
 *   - **quantize** — `KHR_mesh_quantization`, which GLTFLoader also supports
 *     with no decoder to register.
 *
 * **Draco and meshopt are deliberately absent.** They need a decoder installed
 * on the loader at runtime, and only three of the loaders in this repo register
 * one — `SpawnableLayer`, `MapView`, and the ship's interior. Compressing a
 * character with Draco would make it load in Vibe City and fail silently in the
 * shop, which is precisely the class of bug that is invisible until somebody
 * opens the other page. Quantization needs nothing.
 *
 * Rigged characters get a gentler pass (`--simplify` off): decimating a skinned
 * mesh moves vertices that are weighted to bones, and a 3% error budget that is
 * invisible on a rock shows up on a face.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const write = args.includes("--write");
const only = args.filter((a) => !a.startsWith("--"));

/** Everything the app ships, minus the vendored ship's own kit. */
function allModels() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".glb")) out.push(p);
    }
  };
  walk("src/assets/glb");
  walk("public/models");
  return out;
}

const files = only.length ? only : allModels();
/* A rigged character is anything with a skeleton. Cheaper to detect by where it
   lives than to parse every file: the two rigged folders are known. */
const isRigged = (f) =>
  f.includes("/characters/") ||
  /vibey|alien|astronaut|robot/i.test(f.split("/").pop());

const tmp = mkdtempSync(join(tmpdir(), "glbopt-"));
let before = 0;
let after = 0;
const rows = [];

for (const f of files) {
  const src = resolve(f);
  const dst = join(tmp, "out.glb");
  const wasBytes = statSync(src).size;
  const rigged = isRigged(f);
  const flags = [
    "optimize", src, dst,
    "--compress", "quantize",
    "--texture-compress", "webp",
    "--texture-size", rigged ? "1024" : "1024",
    "--simplify", rigged ? "false" : "true",
  ];
  if (!rigged) flags.push("--simplify-error", "0.0015");
  try {
    execFileSync("npx", ["gltf-transform", ...flags], { stdio: "pipe" });
  } catch (e) {
    console.error(`  ${f}: FAILED — ${String(e.stderr ?? e).slice(0, 200)}`);
    continue;
  }
  const nowBytes = statSync(dst).size;
  /* An "optimisation" that made the file bigger is a no-op, not a result.
     Quantizing an already-tiny mesh can do exactly that. */
  if (nowBytes >= wasBytes) {
    rows.push([f, wasBytes, wasBytes, "skipped (no gain)"]);
    before += wasBytes;
    after += wasBytes;
    continue;
  }
  if (write) copyFileSync(dst, src);
  rows.push([f, wasBytes, nowBytes, rigged ? "rigged" : ""]);
  before += wasBytes;
  after += nowBytes;
}
rmSync(tmp, { recursive: true, force: true });

const mb = (n) => (n / 1048576).toFixed(2).padStart(8);
for (const [f, a, b, note] of rows.sort((x, y) => y[1] - y[2] - (x[1] - x[2]))) {
  if (a === b) continue;
  console.log(`${mb(a)} → ${mb(b)} MB  ${((1 - b / a) * 100).toFixed(0).padStart(3)}%  ${f} ${note}`);
}
console.log(
  `\n${files.length} files · ${mb(before)} → ${mb(after)} MB · saved ${mb(before - after)} MB (${((1 - after / before) * 100).toFixed(1)}%)`,
);
if (!write) console.log("\ndry run — pass --write to apply, and compare a few with glb-compare.mjs first");
