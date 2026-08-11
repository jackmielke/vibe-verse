#!/usr/bin/env node
/**
 * glb-verify — did the optimiser keep everything that moves?
 *
 *   node scripts/glb-verify.mjs <ref> [paths...]
 *
 * Compares each file on disk against the same path at a git ref, and reports
 * anything that would break a world rather than merely look slightly different:
 * a lost animation clip, a dropped skin, a vanished morph target, a mesh that
 * is not there any more.
 *
 * Size is easy to check and is not the risk. The risk is that `join` quietly
 * merges two primitives and takes a morph target with it, or that a skin is
 * pruned because nothing appeared to reference it — and the failure then shows
 * up as a character standing in a T-pose in one world, weeks later.
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

async function stats(bytes) {
  const doc = await io.readBinary(new Uint8Array(bytes));
  const root = doc.getRoot();
  let morphs = 0;
  let prims = 0;
  for (const m of root.listMeshes()) {
    for (const p of m.listPrimitives()) {
      prims++;
      morphs += p.listTargets().length;
    }
  }
  return {
    anims: root.listAnimations().length,
    /* Channel count, not just clip count: a clip that survives with half its
       channels dropped animates half a character. */
    channels: root.listAnimations().reduce((n, a) => n + a.listChannels().length, 0),
    skins: root.listSkins().length,
    meshes: root.listMeshes().length,
    prims,
    morphs,
    textures: root.listTextures().length,
  };
}

const [ref = "HEAD", ...only] = process.argv.slice(2);
const files = only.length
  ? only
  : execFileSync("git", ["ls-files", "*.glb"], { encoding: "utf8" }).trim().split("\n");

let bad = 0;
for (const f of files) {
  let before;
  try {
    before = await stats(execFileSync("git", ["show", `${ref}:${f}`], {
      encoding: "buffer",
      maxBuffer: 1 << 30,
    }));
  } catch {
    continue; // new file, nothing to compare against
  }
  const after = await stats(readFileSync(f));
  const lost = [];
  for (const k of ["anims", "channels", "skins", "meshes", "morphs"]) {
    if (after[k] < before[k]) lost.push(`${k} ${before[k]}→${after[k]}`);
  }
  if (lost.length) {
    bad++;
    console.log(`LOST  ${f}\n        ${lost.join("  ")}`);
  }
}
console.log(
  bad
    ? `\n${bad} file(s) lost something. Restore them with: git checkout ${ref} -- <path>`
    : `\n${files.length} files checked, nothing lost.`,
);
process.exitCode = bad ? 1 : 0;
