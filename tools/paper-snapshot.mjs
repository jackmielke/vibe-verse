#!/usr/bin/env node
/**
 * paper-snapshot — bake the latest edition into the build.
 *
 * `src/lib/vibeTimes.ts` falls back to `public/vibe-times.json` whenever the
 * presses cannot be reached: a cold Supabase, a network the reader is behind,
 * a function that is mid-deploy. That fallback is the right design and it had
 * one bad property — somebody had to remember to write it. Nobody did. It sat
 * at issue №2 while the live paper reached №13, so the one moment the fallback
 * exists for was also the moment it printed a front page seventeen days old.
 *
 * So it runs as `prebuild`, next to `build-log.mjs`, and every deploy ships
 * with that morning's edition already in `public/`. The fallback is now at
 * worst one deploy behind instead of unboundedly behind, which is the
 * difference between "the presses are unreachable, here is this morning's
 * paper" and "the presses are unreachable, here is a paper from last month".
 *
 * Three refusals, all of them the same instinct as build-log.mjs — never
 * overwrite a good file with a worse one:
 *
 *   - no network, no credentials, a non-200, a timeout → keep what is committed
 *   - the response does not look like an issue → keep what is committed
 *   - the fetched issue is OLDER than the committed one → keep what is
 *     committed. A build machine that reaches a stale replica, or a function
 *     briefly serving its own fallback, must not be able to walk the paper
 *     backwards.
 *
 * It therefore always exits 0. A snapshot is an improvement to the build, not
 * a precondition for it, and failing a deploy because a newspaper was
 * unreachable would be a worse outcome than a slightly older fallback.
 *
 * Usage:
 *   node tools/paper-snapshot.mjs
 *   node tools/paper-snapshot.mjs --archive 8   # how many back issues to bake
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT = join(ROOT, "public", "vibe-times.json");
const ARCHIVE = join(ROOT, "public", "vibe-times-archive.json");

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const KEEP = Number(opt("archive") ?? 6);
const TIMEOUT_MS = 20_000;

const say = (msg) => console.log(`paper-snapshot: ${msg}`);

/** The same .env reader the brief tool uses; there is no dotenv here. */
function readEnv() {
  const p = join(ROOT, ".env");
  const fromFile = existsSync(p)
    ? Object.fromEntries(
        readFileSync(p, "utf8")
          .split("\n")
          .filter((l) => l.trim() && !l.trim().startsWith("#"))
          .map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
          }),
      )
    : {};
  // The deploy has the variables in the environment rather than in a file,
  // and the environment wins — a .env checked into a build image would be
  // the wrong project.
  return { ...fromFile, ...process.env };
}

const looksLikeIssue = (v) =>
  !!v &&
  typeof v === "object" &&
  typeof v.issue === "number" &&
  typeof v.date === "string" &&
  Array.isArray(v.headlines) &&
  v.headlines.length > 0;

const committedIssueNo = () => {
  try {
    const v = JSON.parse(readFileSync(CURRENT, "utf8"));
    return looksLikeIssue(v) ? v.issue : 0;
  } catch {
    return 0;
  }
};

async function main() {
  const env = readEnv();
  const base = (env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    say("no VITE_SUPABASE_URL — keeping the committed edition");
    return;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let paper;
  try {
    const r = await fetch(`${base}/functions/v1/vibe-times?limit=${KEEP}`, { signal: ctl.signal });
    if (!r.ok) {
      say(`presses answered ${r.status} — keeping the committed edition`);
      return;
    }
    paper = await r.json();
  } catch (e) {
    say(`could not reach the presses (${e?.name ?? "error"}) — keeping the committed edition`);
    return;
  } finally {
    clearTimeout(timer);
  }

  const current = paper?.current;
  if (!looksLikeIssue(current)) {
    say("that did not look like an issue — keeping the committed edition");
    return;
  }

  const have = committedIssueNo();
  if (current.issue < have) {
    say(`fetched №${current.issue} but №${have} is committed — refusing to go backwards`);
    return;
  }

  const archive = Array.isArray(paper.archive) ? paper.archive.filter(looksLikeIssue) : [];

  writeFileSync(CURRENT, `${JSON.stringify(current, null, 2)}\n`);
  writeFileSync(ARCHIVE, `${JSON.stringify(archive.slice(0, KEEP), null, 2)}\n`);
  say(`baked №${current.issue} (${current.date}) and ${archive.length} back issues`);
}

await main();
