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
 *
 * That guard is not enough on its own, and this is the interesting part: a
 * shallow clone deep enough to have *some* history is worse than one with
 * none. Git presents the graft boundary as the commit that created every file
 * in the tree, so `git log -- src/pages/About.tsx` answers confidently with the
 * boundary's date. Nothing looks missing. Every world that has not been touched
 * inside the shallow window silently adopts the same wrong date, and it is a
 * plausible-looking recent one, so the diff reads like normal churn. A clone
 * with 71 of 247 commits flattened thirty worlds' dates onto one afternoon
 * before anybody noticed. So: in a shallow clone this refuses to write at all.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.argv[2] ?? ".");
const OUT = join(ROOT, "src/worlds/updated.ts");
const CHANGES_OUT = join(ROOT, "src/worlds/changes.ts");
const REPO_URL = "https://github.com/jackmielke/vibe-verse";
/** How many recent commits each world remembers. */
const CHANGE_COUNT = 6;

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

/**
 * The last few commits that touched any of these paths.
 *
 * Read from git at build time rather than fetched from GitHub at runtime, for
 * the same reasons the dates are: the browser has no git, an API call would put
 * a rate-limited third party between a card and a tooltip, and the answer would
 * be wrong with the network down. Six is enough to say what has been happening
 * without becoming a changelog nobody scrolls.
 *
 * NUL separators because commit subjects in this repo contain every other
 * punctuation mark there is, em dashes and colons included.
 */
function recentCommits(paths) {
  if (!paths.length) return [];
  try {
    const out = execFileSync(
      "git",
      ["log", `-${CHANGE_COUNT}`, "--format=%h%x00%cI%x00%s", "--", ...paths],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, iso, ...rest] = line.split("\0");
        return { sha, iso, subject: rest.join("\0") };
      })
      .filter((c) => c.sha && c.iso);
  } catch {
    return [];
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

/**
 * Is this clone missing history?
 *
 * If it is, every date this script would produce is untrustworthy in a way
 * that looks fine — see the header. Better to fail than to write.
 */
function isShallowClone() {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch {
    /* Not a git repo, or a git too old to know the flag. Nothing to say. */
    return false;
  }
}

if (isShallowClone()) {
  console.error(
    "stamp-worlds: this is a shallow clone, so git will date every untouched\n" +
      "world to the graft boundary and the dates on every card will be wrong.\n" +
      "Refusing to write. Run `git fetch --unshallow` first.",
  );
  process.exit(1);
}

const worlds = await loadWorlds();
if (!worlds.length) {
  console.error("stamp-worlds: the registry came back empty — refusing to write");
  process.exit(1);
}

const previous = readExisting();
const stamps = {};
const changes = {};
const missing = [];
const kept = [];

for (const w of worlds) {
  const log = recentCommits(pathsOf(w.source));
  if (log.length) {
    stamps[w.key] = log[0].iso;
    changes[w.key] = log;
  } else if (previous[w.key]) {
    // Shallow clone: keep the committed date, and leave the changelog to the
    // committed file rather than blanking it.
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

/* Only rewrite the changelog when git actually answered. In a shallow clone
   `changes` comes back empty for everything, and overwriting a good file with
   an empty one is the silent-erasure failure the dates already guard against. */
if (Object.keys(changes).length) {
  const blocks = Object.entries(changes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, list]) => {
      const rows = list
        .map(
          (c) =>
            `    { sha: ${JSON.stringify(c.sha)}, iso: ${JSON.stringify(c.iso)}, ` +
            `subject: ${JSON.stringify(c.subject)} },`,
        )
        .join("\n");
      return `  ${JSON.stringify(k)}: [\n${rows}\n  ],`;
    })
    .join("\n");

  writeFileSync(
    CHANGES_OUT,
    `/**
 * What changed in each world lately — GENERATED, do not edit by hand.
 *
 * Regenerate with \`npm run stamp\`. The last ${CHANGE_COUNT} commits touching each
 * world's \`source\` paths, so a card can answer "what actually changed?" without
 * calling GitHub from the browser.
 *
 * Kept apart from \`updated.ts\` on purpose: every card reads a date, almost
 * nobody opens the history, and this file is twenty times the size.
 */
export interface WorldChange {
  /** Short hash — links to the commit on GitHub. */
  sha: string;
  iso: string;
  /** The commit subject line, verbatim. */
  subject: string;
}

export const REPO_URL = ${JSON.stringify(REPO_URL)};

export const WORLD_CHANGES: Record<string, WorldChange[]> = {
${blocks}
};
`,
  );
  console.log(`stamp-worlds: wrote history for ${Object.keys(changes).length} worlds to src/worlds/changes.ts`);
}

console.log(`stamp-worlds: wrote ${Object.keys(stamps).length} dates to src/worlds/updated.ts`);
if (kept.length) {
  console.log(`  kept ${kept.length} from the committed file (no git history here): ${kept.join(", ")}`);
}
if (missing.length) {
  console.log(`  no date for ${missing.length}: ${missing.join(", ")}`);
}
