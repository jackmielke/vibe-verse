#!/usr/bin/env node
/**
 * stamp-worlds — record when each world was last actually touched.
 *
 *     npm run stamp
 *
 * Writes `src/worlds/updated.ts` from the git history of each world's `source`
 * paths, which the registry already carries. Nothing new to maintain: add a
 * world with a `source` and it gets a date, move its code and the date follows.
 *
 * ## Why this is generated and committed rather than read at runtime
 *
 * The browser has no git. It could be an API call to GitHub, but then every
 * card on the page waits on a rate-limited third party to render a date, and
 * the date is wrong the moment the network is down. A build artifact costs one
 * commit and is right offline.
 *
 * ## Why the build does not regenerate it blindly
 *
 * Deploys often use a shallow clone (`--depth=1`), where `git log` for a path
 * touched five commits ago returns nothing at all. Regenerating there would
 * quietly erase every date. So a path that resolves to nothing keeps whatever
 * the committed file already said, and the script says so loudly.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.argv[2] ?? ".");
const OUT = join(ROOT, "src/worlds/updated.ts");

/** Load the registry by bundling it — parsing TypeScript with a regex drifts. */
async function loadWorlds() {
  const dir = mkdtempSync(join(tmpdir(), "stamp-"));
  const file = join(dir, "registry.mjs");
  try {
    await build({
      entryPoints: [join(ROOT, "src/worlds/registry.ts")],
      outfile: file,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
    });
    const mod = await import(pathToFileURL(file).href);
    return mod.WORLDS ?? mod.default?.WORLDS ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `source` is prose as much as a path — "src/pages/City.tsx + src/components/city"
 * is one world in two places, and that is more useful in the UI than a rigid
 * array would be. Split it here rather than reshaping the registry.
 */
function pathsOf(source) {
  return String(source)
    .split("+")
    .map((s) => s.trim())
    .filter((s) => s && existsSync(join(ROOT, s)));
}

/** Committer date of the newest commit touching any of these paths. */
function lastTouched(paths) {
  if (!paths.length) return null;
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", ...paths],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Whatever the committed file already knows, so a shallow clone loses nothing. */
function readExisting() {
  try {
    const src = readFileSync(OUT, "utf8");
    const body = src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1);
    const out = {};
    for (const m of body.matchAll(/"([^"]+)":\s*"([^"]+)"/g)) out[m[1]] = m[2];
    return out;
  } catch {
    return {};
  }
}

const worlds = await loadWorlds();
if (!worlds.length) {
  console.error("stamp-worlds: the registry came back empty — refusing to write");
  process.exit(1);
}

const previous = readExisting();
const stamps = {};
const missing = [];
const kept = [];

for (const w of worlds) {
  const iso = lastTouched(pathsOf(w.source));
  if (iso) {
    stamps[w.key] = iso;
  } else if (previous[w.key]) {
    stamps[w.key] = previous[w.key];
    kept.push(w.key);
  } else {
    missing.push(`${w.key} (${w.source})`);
  }
}

const rows = Object.entries(stamps)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `  "${k}": "${v}",`)
  .join("\n");

writeFileSync(
  OUT,
  `/**
 * When each world was last touched — GENERATED, do not edit by hand.
 *
 * Regenerate with \`npm run stamp\`. The dates are committer dates from git for
 * the \`source\` paths in \`registry.ts\`, so they answer "when did this world
 * last change", not "when did anyone last deploy".
 *
 * See \`scripts/stamp-worlds.mjs\` for why this is committed rather than
 * fetched, and why a build in a shallow clone will not erase it.
 */
export const WORLD_UPDATED: Record<string, string> = {
${rows}
};
`,
);

console.log(`stamp-worlds: wrote ${Object.keys(stamps).length} dates to src/worlds/updated.ts`);
if (kept.length) {
  console.log(`  kept ${kept.length} from the committed file (no git history here): ${kept.join(", ")}`);
}
if (missing.length) {
  console.log(`  no date for ${missing.length}: ${missing.join(", ")}`);
}
