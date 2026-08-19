#!/usr/bin/env node
/**
 * build-log — publish this repo's construction record as a static file.
 *
 * The Vibe Times is written from what actually happened, and the richest
 * half of "what happened" is this repo's own commit log: the subjects are
 * already written like headlines, and the first paragraph of each body is
 * the reasoning. `tools/vibe-times-brief.mjs` reads that straight out of
 * git, because it runs on a machine that has the repo.
 *
 * The daily edge function does not. It runs on Supabase, and this repo is
 * private, so the GitHub API is closed to it without a token. So the build
 * record is *published*: this writes `public/build-log.json`, the site
 * deploys it like any other asset, and the function fetches
 * https://myvibeverse.com/build-log.json.
 *
 * It runs as `prebuild`, so every deploy refreshes it. If git history is
 * unavailable or incomplete — a tarball, or the shallow clone most CI does
 * by default — it leaves the committed file alone rather than overwriting a
 * good record with a truncated one. That is not hypothetical: a shallow
 * checkout here could see 62 of the 120 commits in the committed log, and
 * regenerating would have quietly thrown half the paper's memory away. A
 * stale build log makes a slightly stale paper; a truncated one makes the
 * paper forget what it was building last week.
 *
 * Usage:
 *   node tools/build-log.mjs           # write public/build-log.json
 *   node tools/build-log.mjs --days 45 # window (default 45)
 */
import { execSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "build-log.json");

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const DAYS = Number(opt("days") ?? 45);
const MAX_COMMITS = 120;

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// Which directory belongs to which world, so the paper can say WHERE
// something happened. Same table the brief tool uses.
const WORLD_DIRS = [
  ["src/pages/City.tsx", "Vibe Island"],
  ["src/components/city/", "Vibe Island"],
  ["src/city/", "Vibe Island"],
  ["src/island2/", "the second island"],
  ["src/seafair/", "Seafair"],
  ["src/sanpalmas/", "San Palmas"],
  ["src/longsilence/", "The Long Silence"],
  ["src/kart/", "Vibe Kart"],
  ["src/golf/", "Vibe Golf"],
  ["src/sf/", "San Francisco"],
  ["src/soaked/", "Soaked"],
  ["src/orbit/", "Orbit"],
  ["src/fivenights/", "Five Nights at Vibey's"],
  ["src/pages/FiveNights", "Five Nights at Vibey's"],
  ["src/pages/MemoryGarden", "the Memory Garden"],
  ["src/pages/VibeArcade", "the Arcade"],
  ["src/pages/VibeWallet", "the Wallet"],
  ["src/pages/VibeTimes", "this newspaper"],
  ["src/lib/characters", "the character roster"],
  ["supabase/functions/", "the machinery underneath"],
];

const SEP = "";

function collect() {
  const raw = sh(
    `git log --since="${DAYS} days ago" --no-merges -n ${MAX_COMMITS} ` +
      `--pretty=format:"%H${SEP}%ad${SEP}%s${SEP}%b${SEP}END" --date=short`,
  );
  if (!raw) return [];

  return raw
    .split(`${SEP}END`)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, date, subject, body = ""] = chunk.split(SEP);
      const sha = hash.replace(/^\n/, "").trim();
      let files = [];
      try {
        files = sh(`git show --name-only --pretty=format: ${sha}`).split("\n").filter(Boolean);
      } catch {
        /* a commit we can't read is still a commit */
      }
      const places = new Set();
      for (const f of files) {
        for (const [prefix, label] of WORLD_DIRS) if (f.startsWith(prefix)) places.add(label);
      }
      return {
        sha: sha.slice(0, 8),
        date,
        subject,
        // The first paragraph of a commit body is where the reasoning lives
        // in this repo, and it is usually the actual story.
        lede: body.trim().split("\n\n")[0]?.replace(/\s+/g, " ").slice(0, 420) ?? "",
        places: [...places],
        files: files.length,
      };
    })
    .filter((c) => c.subject);
}

/** A shallow clone knows only the tip of the history, and cannot speak for it. */
function shallow() {
  try {
    return sh("git rev-parse --is-shallow-repository") === "true";
  } catch {
    return true; // no git at all is at least as untrustworthy
  }
}

/**
 * Keeping the committed file on a shallow clone is right — the alternative is
 * publishing a log truncated at the graft boundary — but it was trusting that
 * file blindly, and that is how a bad merge shipped `<<<<<<< HEAD` inside a
 * public JSON endpoint and kept shipping it. Every deploy is a shallow clone,
 * so every deploy took this branch, kept the corrupt file, and exited 0.
 *
 * So: only keep it if it is actually JSON. A truncated log is a worse log; an
 * unparseable one is not a log at all, and regenerating whatever this clone can
 * see beats serving something no client can read.
 */
if (shallow() && existsSync(OUT)) {
  let intact = false;
  try {
    JSON.parse(readFileSync(OUT, "utf8"));
    intact = true;
  } catch (e) {
    console.warn(`build-log: committed build-log.json does not parse (${e.message}) — regenerating`);
  }
  if (intact) {
    console.warn("build-log: shallow clone — keeping the committed build-log.json");
    process.exit(0);
  }
}

let commits;
try {
  commits = collect();
} catch (e) {
  console.warn(`build-log: no git history here (${String(e.message ?? e).slice(0, 80)})`);
  commits = [];
}

if (!commits.length) {
  if (existsSync(OUT)) {
    console.warn("build-log: nothing to read — keeping the committed build-log.json");
    process.exit(0);
  }
  console.warn("build-log: nothing to read and nothing committed — writing an empty log");
}

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      window_days: DAYS,
      commits,
    },
    null,
    2,
  )}\n`,
);
console.log(`build-log: wrote ${commits.length} commits to public/build-log.json`);
