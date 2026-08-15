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
 *
 * **Which models those are is read out of the file, never guessed from its
 * name.** See `riggedFlags`. The name-based version of this check let the
 * biggest asset in the repo through untouched for months.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
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

/**
 * A rigged model is one with a skeleton or an animation, and the only way to
 * know that is to look. This used to guess from the filename — `/characters/`
 * plus a regex of words that sounded like characters — which is cheaper and was
 * wrong about the largest file in the repo.
 *
 * `floating-astronaut.glb` matched `/astronaut/`, so it skipped decimation and
 * shipped at **702,760 triangles and 15.9 MB** — for a prop that spins in the
 * distance and has neither a skin nor a single animation channel. It is the
 * `floating-island.glb` story from the header, repeated, and the guess is what
 * repeated it: three files were misclassified and they held 1.13 M of the
 * 1.82 M triangles in the whole model folder.
 *
 * Reading the file costs a JSON parse of the header chunk — the bin payload is
 * never touched — against an optimiser pass that takes minutes. There is no
 * reason to guess.
 */
/**
 * Static models that are nonetheless looked at closely, and so get a much
 * tighter error budget than a background prop.
 *
 * The default 0.0015 is tuned for something 300 px across in the distance. Run
 * Vibey through it and you get 13,559 triangles and a mascot with a visibly
 * faceted shoulder and a dented head — `glb-compare.mjs` shows it plainly, and
 * the file-size number alone would have talked you into shipping it. At 0.0002
 * the same model lands at ~75 k triangles and 1.6 MB, still a third of the
 * original, with the silhouette intact.
 *
 * Match on basename: the same mesh is shipped from two places.
 */
const CLOSE_UP = new Set(["vibey.glb", "expressive-vibey.glb"]);
const CLOSE_UP_ERROR = "0.0002";

function riggedFlags(f) {
  try {
    const buf = readFileSync(f);
    /* GLB: 12-byte header, then chunks. The first is always JSON. */
    if (buf.readUInt32LE(0) !== 0x46546c67) return { rigged: true, why: "not a GLB — assume the careful path" };
    const len = buf.readUInt32LE(12);
    if (buf.readUInt32LE(16) !== 0x4e4f534a) return { rigged: true, why: "no JSON chunk" };
    const j = JSON.parse(buf.subarray(20, 20 + len).toString("utf8"));
    const skins = j.skins?.length ?? 0;
    const anims = j.animations?.length ?? 0;
    if (skins || anims) return { rigged: true, why: `${skins} skin(s), ${anims} animation(s)` };
    return { rigged: false, why: "static" };
  } catch (e) {
    /* Unreadable means unknown, and unknown takes the pass that cannot ruin a
       face. A model that silently lost its rig is far worse than one that
       stayed big. */
    return { rigged: true, why: `unreadable (${String(e).slice(0, 40)})` };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "glbopt-"));
let before = 0;
let after = 0;
const rows = [];

for (const f of files) {
  const src = resolve(f);
  const dst = join(tmp, "out.glb");
  const wasBytes = statSync(src).size;
  const { rigged, why } = riggedFlags(src);
  const closeUp = CLOSE_UP.has(f.split("/").pop());
  const flags = [
    "optimize", src, dst,
    "--compress", "quantize",
    "--texture-compress", "webp",
    "--texture-size", "1024",
    "--simplify", rigged ? "false" : "true",
  ];
  if (!rigged) flags.push("--simplify-error", closeUp ? CLOSE_UP_ERROR : "0.0015");
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
  rows.push([f, wasBytes, nowBytes, rigged ? `rigged — ${why}` : closeUp ? "close-up — gentle" : ""]);
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
