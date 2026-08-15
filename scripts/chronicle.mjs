#!/usr/bin/env node
/**
 * chronicle — work out when each world was *born*, from git.
 *
 *     npm run chronicle
 *
 * Sibling of `stamp-worlds.mjs`, which answers "when did this world last
 * change". This one answers the question you can only ask once per world: when
 * did it first exist? Together they bracket a life.
 *
 * Writes `src/worlds/chronicle.ts`, which `/chronicle` renders as the history
 * of the place. Nothing here has to be maintained: add a world with a `source`
 * and it gets a birthday, and the history grows on its own.
 *
 * ## The shallow-clone trap, which is worse here than anywhere
 *
 * `stamp-worlds.mjs` documents it and this script inherits it in a sharper
 * form. In a shallow clone git presents the graft boundary as the commit that
 * created every file in the tree — so `git log` for an untouched path answers,
 * confidently, with the boundary's date. For *last changed* that produces
 * plausible recent dates. For *first appeared* it produces something worse: a
 * history in which fifty worlds were all founded on the same afternoon, which
 * is not a bug anybody would notice by reading it. It looks like a busy week.
 *
 * This container's clone was shallow when the script was written — 458 commits
 * of 1758, everything before July 2026 flattened. `git fetch --unshallow` is
 * the fix and this refuses to write without it, because a chronicle that
 * invents its own dates is worse than no chronicle.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.argv[2] ?? ".");
const OUT = join(ROOT, "src/worlds/chronicle.ts");

/** Load the registry by bundling it — parsing TypeScript with a regex drifts. */
async function loadWorlds() {
  const dir = mkdtempSync(join(tmpdir(), "chronicle-"));
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

/** `"src/pages/City.tsx + src/components/city"` → the paths that exist. */
function pathsOf(source) {
  return String(source ?? "")
    .split("+")
    .map((s) => s.trim())
    .filter((s) => s && existsSync(join(ROOT, s)));
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The first commit that ever touched these paths, and how much work since.
 *
 * `--follow` is deliberately *not* used. It only accepts one path, and it
 * guesses at renames; a world that moved directories would get whichever
 * history git found more convincing. The registry's `source` is the current
 * home, and "first commit at this address" is a claim this can actually
 * support. A world that moved reads as younger than it is, which is a smaller
 * lie than a confident wrong date and is one a human can correct in the
 * registry.
 */
function lifeOf(paths) {
  if (!paths.length) return null;
  const dates = git(["log", "--format=%cI", "--", ...paths])
    .split("\n")
    .filter(Boolean)
    /* Not the scaffold. The repository's root commit is a Lovable template
       dated 2025-01-01T00:00:00 — a placeholder, not a day anybody worked —
       and it contains `src/pages/Index.tsx`, which is Healdsburg Village's
       source. Counting it made the oldest world in the vibeverse look like it
       predated the vibeverse by fifteen months, which is the sort of wrong
       date a chronicle never recovers from because it reads as a fun fact. */
    .filter((d) => d !== TEMPLATE_ISO);
  if (!dates.length) return null;
  const authors = new Set(
    git(["log", "--format=%an", "--", ...paths]).split("\n").map((s) => s.trim()).filter(Boolean),
  );
  return {
    born: dates[dates.length - 1],
    commits: dates.length,
    hands: authors.size,
  };
}

/** Whatever the committed file already knows, so a bad run loses nothing. */
function readExisting() {
  try {
    const src = readFileSync(OUT, "utf8");
    const body = src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1);
    return JSON.parse(body.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return {};
  }
}

if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
  console.error(
    "This clone is shallow, so every date would be the graft boundary and the\n" +
      "history would read as though the whole vibeverse was founded in one week.\n" +
      "Run `git fetch --unshallow` first. Refusing to write.",
  );
  process.exit(1);
}

/**
 * The scaffold commit, excluded from everything below.
 *
 * Identified as the root commit rather than by hard-coding its date: a repo
 * that started some other way should not have a random day deleted from its
 * history because of a constant somebody typed in 2026.
 */
const ROOT_SHA = git(["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n").pop();
const TEMPLATE_ISO = git(["log", "-1", "--format=%cI", ROOT_SHA]).trim();

const worlds = await loadWorlds();
const existing = readExisting();
const out = {};
const missing = [];

for (const w of worlds) {
  const life = lifeOf(pathsOf(w.source));
  if (life) out[w.key] = life;
  else if (existing[w.key]) {
    out[w.key] = existing[w.key];
    missing.push(`${w.key} (kept)`);
  } else missing.push(w.key);
}

/* The repository's own numbers, for the page's opening line. */
const repoFirst = git(["log", "--format=%cI"])
  .split("\n")
  .filter(Boolean)
  .filter((d) => d !== TEMPLATE_ISO)
  .pop();
const repoFirstSubject = git(["log", "--format=%cI%x00%s"])
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\0"))
  .filter(([d]) => d !== TEMPLATE_ISO)
  .pop()?.[1] ?? "";
const repoCommits = Number(git(["rev-list", "--count", "HEAD"]).trim()) - 1;
const repoHands = new Set(git(["log", "--format=%an"]).split("\n").map((s) => s.trim()).filter(Boolean)).size;

/**
 * Commits per calendar day, for the grid.
 *
 * The per-world dates say what was built; this says when anybody was *here*,
 * which is a different and in places better story. A fortnight of silence and
 * then a hundred and ninety-six commits in one day are both facts that no list
 * of birthdays can show.
 *
 * Only days with commits are stored — six hundred zeroes would be most of the
 * file, and the page infers silence from the gaps.
 */
const dayCounts = {};
for (const line of git(["log", "--format=%cI%x00%cd", "--date=short"]).split("\n").filter(Boolean)) {
  const [iso, day] = line.split("\0");
  if (iso === TEMPLATE_ISO) continue;
  dayCounts[day] = (dayCounts[day] ?? 0) + 1;
}
const dayBody = Object.keys(dayCounts)
  .sort()
  .map((d) => `  ${JSON.stringify(d)}: ${dayCounts[d]},`)
  .join("\n");

const sorted = Object.keys(out).sort();
const body = sorted.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`).join("\n");

writeFileSync(
  OUT,
  `/**
 * When each world was born — GENERATED, do not edit by hand.
 *
 * Regenerate with \`npm run chronicle\`. \`born\` is the committer date of the
 * first commit that ever touched the world's \`source\` paths; \`commits\` and
 * \`hands\` are the work and the people since.
 *
 * Committed rather than fetched, for the reason every generated file here is:
 * the browser has no git, and \`/chronicle\` must keep working when there is no
 * network and no server left to ask. See \`scripts/chronicle.mjs\`.
 */

export interface WorldLife {
  /** ISO date of the first commit at this world's current address. */
  born: string;
  /** Commits touching it, ever. */
  commits: number;
  /** Distinct authors who have touched it. */
  hands: number;
}

/** The repository itself, for the page's opening line. */
export const REPO_LIFE = ${JSON.stringify(
    { born: repoFirst, firstWords: repoFirstSubject, commits: repoCommits, hands: repoHands },
    null,
    2,
  )} as const;

export const WORLD_LIFE: Record<string, WorldLife> = {
${body}
};

/**
 * Commits per calendar day, UTC. Only days with commits — a day missing from
 * here had none, which the page reads as silence rather than as absent data.
 */
export const COMMIT_DAYS: Record<string, number> = {
${dayBody}
};
`,
  "utf8",
);

console.log(`wrote ${OUT} — ${sorted.length} worlds`);
console.log(`repo: born ${repoFirst?.slice(0, 10)} — "${repoFirstSubject}"`);
console.log(`      ${repoCommits} commits, ${repoHands} hands (template commit excluded)`);
const busiest = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
console.log(`      ${Object.keys(dayCounts).length} active days, busiest ${busiest?.[0]} with ${busiest?.[1]}`);
if (missing.length) console.log(`no history for: ${missing.join(", ")}`);
