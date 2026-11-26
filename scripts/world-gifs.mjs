#!/usr/bin/env node
/**
 * world-gifs — try to record every world that might play itself, keep the ones
 * that do.
 *
 *   node scripts/world-gifs.mjs                 # every candidate
 *   node scripts/world-gifs.mjs coil blob       # just these
 *
 * The list below is worlds with a `?shot` mode, which is the closest thing the
 * repo has to "this route can run without a person". It is a list of
 * *candidates*, not of clips: `route-gif.mjs` rejects anything with too few
 * distinct frames, so a world that turns out to sit still simply keeps its
 * still and says so here. That is the point of running it over a list — nobody
 * has to know in advance which worlds have an attract mode, and nobody has to
 * remember to look at fifteen GIFs to check.
 *
 * Serial on purpose. Four of these at once on a software renderer would each
 * record the others' frame drops, and the whole exercise is measuring what a
 * world does per second.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/** Worlds with a `?shot` mode, and the route that puts them into it. */
const CANDIDATES = [
  { key: "coil", route: "/coil?shot" },
  { key: "blob", route: "/blob?shot" },
  { key: "splash-royale", route: "/splash-royale?shot" },
  { key: "drop-zero", route: "/drop-zero?shot" },
  { key: "i-spy", route: "/i-spy?shot" },
  { key: "run", route: "/run?shot" },
  { key: "home-alone", route: "/house-rules?shot" },
  { key: "fnaf", route: "/fnaf?shot" },
  { key: "sf", route: "/sf?shot" },
  /* Vibe Francisco has a real attract mode — a slow crane over the Financial
     District — and it is rejected here anyway, at six distinct frames out of
     the eight this asks for. Not because nothing moves but because a 737 000
     triangle city renders at under two frames a second on the software
     renderer this runs on, so three seconds of wall clock is six frames of
     film. It stays on the list: the world is filmable, this machine is not the
     one that can film it, and the day it runs somewhere with a GPU it will
     pass without anybody editing this file. */
  { key: "frisco", route: "/frisco?shot" },
  { key: "san-palmas", route: "/san-palmas?shot" },
  { key: "seafair", route: "/seafair?shot" },
  { key: "island-2", route: "/island-2?shot" },
  { key: "golf", route: "/golf?shot" },
  { key: "twenty48", route: "/2048?shot" },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = only.length ? CANDIDATES.filter((c) => only.includes(c.key)) : CANDIDATES;

const kept = [];
const rejected = [];
const broke = [];

for (const c of list) {
  const out = `src/assets/worlds/${c.key}.gif`;
  console.log(`\n=== ${c.key} — ${c.route}`);
  const r = spawnSync(
    "node",
    [
      "scripts/route-gif.mjs",
      c.route,
      out,
      "--ms", "2600",
      "--width", "320",
      "--fps", "12.5",
      "--colors", "64",
    ],
    { stdio: "inherit", timeout: 240000 },
  );
  if (r.status === 0 && existsSync(out)) {
    kept.push({ key: c.key, kb: Math.round(statSync(out).size / 1024) });
  } else if (r.status === 2) {
    rejected.push(c.key);
  } else {
    broke.push(`${c.key} (exit ${r.status ?? "timeout"})`);
  }
}

console.log("\n────────── result ──────────");
console.log(`kept     (${kept.length}): ${kept.map((k) => `${k.key} ${k.kb}kB`).join(", ") || "—"}`);
console.log(`too still(${rejected.length}): ${rejected.join(", ") || "—"}`);
console.log(`failed   (${broke.length}): ${broke.join(", ") || "—"}`);
if (kept.length) {
  console.log("\nAdd the kept ones to src/worlds/motion.ts.");
}
