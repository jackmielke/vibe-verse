#!/usr/bin/env node
/**
 * vibe-times-brief — gather the facts for the next issue of The Vibe Times.
 *
 * The paper prints itself now: the `vibe-times` edge function writes an issue
 * every morning from the same two sources this reads, plus the wire from
 * outside the sky (see docs/vibe-times.md). This stays for writing an issue
 * by hand from a local checkout, and because it is where the shape of the
 * brief was worked out.
 *
 * The paper's masthead has always claimed it was "written nightly by the
 * autonomous build loop". It wasn't: issue №1 shipped in July and sat
 * there. This is the half of that loop that can be made deterministic —
 * it collects what actually happened and prints a brief. Something with
 * a voice then writes the issue from the brief (see
 * .claude/skills/vibe-times/SKILL.md).
 *
 * Splitting it this way matters. A reporter that invents its own facts is
 * the failure mode for a newspaper written by a language model, so the
 * facts arrive here as data — commit subjects, event counts, real names —
 * and the writing step is told, in as many words, that it may only work
 * from what this prints.
 *
 * Two sources:
 *
 *   1. Git history since the last issue. This repo's commit subjects are
 *      already written like headlines ("Only clouds bounce; the Moon and
 *      Mars are ground again"), because the world is built by writing
 *      them. It is the single richest thing the paper can report on.
 *
 *   2. The live world — residents arriving, leaving, walking up to each
 *      other — from Supabase. Optional: the REST host is not on every
 *      environment's egress allowlist, so a failure here downgrades the
 *      brief rather than killing it. Run with --require-world to make it
 *      a hard error instead.
 *
 * Usage:
 *   node tools/vibe-times-brief.mjs              # brief since last issue
 *   node tools/vibe-times-brief.mjs --days 3     # force a window
 *   node tools/vibe-times-brief.mjs --json       # machine-readable
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT = join(ROOT, "public", "vibe-times.json");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();

// ---------------------------------------------------------------------
// Where the last issue left off
// ---------------------------------------------------------------------
function lastIssue() {
  if (!existsSync(CURRENT)) return null;
  try {
    return JSON.parse(readFileSync(CURRENT, "utf8"));
  } catch {
    return null;
  }
}

const prev = lastIssue();
const forcedDays = opt("days") ? Number(opt("days")) : null;
// Start from the morning after the last issue, so a day's news is never
// printed twice and never silently skipped.
const since = forcedDays
  ? `${forcedDays} days ago`
  : prev?.date
    ? prev.date
    : "7 days ago";

// ---------------------------------------------------------------------
// 1. What got built
// ---------------------------------------------------------------------
// Commits are the construction record. Merges are dropped — "Merge X into
// Y" is bookkeeping, not news.
const RAW_SEP = "";
const commits = sh(
  `git log --since="${since}" --no-merges --pretty=format:"%H${RAW_SEP}%ad${RAW_SEP}%s${RAW_SEP}%b${RAW_SEP}END" --date=short`,
)
  .split(`${RAW_SEP}END`)
  .map((chunk) => chunk.trim())
  .filter(Boolean)
  .map((chunk) => {
    const [hash, date, subject, body = ""] = chunk.split(RAW_SEP);
    return { hash: hash.replace(/^\n/, "").trim(), date, subject, body: body.trim() };
  })
  .filter((c) => c.subject);

// Which worlds each commit touched, so the paper can say WHERE something
// happened rather than just that it did.
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
  ["src/pages/MemoryGarden", "the Memory Garden"],
  ["src/pages/VibeTimes", "this newspaper"],
  ["src/lib/characters", "the character roster"],
  ["src/components/city/proceduralPilot", "the character roster"],
];

for (const c of commits) {
  let files = [];
  try {
    files = sh(`git show --name-only --pretty=format: ${c.hash}`).split("\n").filter(Boolean);
  } catch {
    /* a commit we can't read is still a commit */
  }
  c.files = files.length;
  const places = new Set();
  for (const f of files) {
    for (const [prefix, label] of WORLD_DIRS) if (f.startsWith(prefix)) places.add(label);
  }
  c.places = [...places];
}

const byPlace = {};
for (const c of commits) {
  for (const p of c.places.length ? c.places : ["elsewhere"]) {
    byPlace[p] = (byPlace[p] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------
// 2. Who was in the world
// ---------------------------------------------------------------------
function readEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return {};
  return Object.fromEntries(
    readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
}

async function worldActivity(sinceISO) {
  const env = readEnv();
  const url = (env.VITE_SUPABASE_URL ?? "").replace(/^["']|["']$/g, "");
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!url || !key) return { ok: false, reason: "no Supabase credentials in .env" };

  const get = async (path) => {
    const r = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    return r.json();
  };

  try {
    const [events, agents, graffiti] = await Promise.all([
      get(`world_events?select=kind,actor_name,target_name,created_at&created_at=gte.${sinceISO}&order=created_at.desc&limit=500`),
      get(`world_agents?select=name,status,last_seen_at&order=last_seen_at.desc&limit=50`),
      get(`world_graffiti?select=author_name,text,created_at&created_at=gte.${sinceISO}&order=created_at.desc&limit=50`),
    ]);

    const kinds = {};
    const actors = {};
    const greetings = [];
    for (const e of events) {
      kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
      if (e.actor_name) actors[e.actor_name] = (actors[e.actor_name] ?? 0) + 1;
      if (e.kind === "proximity" && e.actor_name && e.target_name) {
        greetings.push(`${e.actor_name} → ${e.target_name}`);
      }
    }
    return {
      ok: true,
      events: events.length,
      kinds,
      actors,
      // Who walked up to whom — the society page writes itself.
      encounters: [...new Set(greetings)].slice(0, 12),
      residents: agents.map((a) => ({ name: a.name, status: a.status, lastSeen: a.last_seen_at })),
      graffiti: graffiti.map((g) => ({ author: g.author_name, text: g.text })),
    };
  } catch (e) {
    return { ok: false, reason: String(e.message ?? e) };
  }
}

// ---------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------
const sinceISO = (() => {
  if (prev?.date && !forcedDays) return `${prev.date}T00:00:00Z`;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (forcedDays ?? 7));
  return d.toISOString();
})();

const world = await worldActivity(sinceISO);
// Today, in UTC — the date the issue is stamped with.
const today = new Date().toISOString().slice(0, 10);

const brief = {
  nextIssue: (prev?.issue ?? 0) + 1,
  date: today,
  since,
  previousIssue: prev ? { issue: prev.issue, date: prev.date } : null,
  build: {
    commits: commits.length,
    byPlace,
    entries: commits.map((c) => ({
      date: c.date,
      subject: c.subject,
      // The first paragraph of a commit body is where the reasoning
      // lives in this repo, and it is usually the actual story.
      lede: c.body.split("\n\n")[0]?.replace(/\s+/g, " ").slice(0, 400) ?? "",
      places: c.places,
      files: c.files,
    })),
  },
  world,
};

if (flag("json")) {
  console.log(JSON.stringify(brief, null, 2));
  process.exit(0);
}

if (flag("require-world") && !world.ok) {
  console.error(`world activity unavailable: ${world.reason}`);
  process.exit(1);
}

// ---- Human/agent-readable brief --------------------------------------
const L = [];
L.push(`# Brief for The Vibe Times, issue №${brief.nextIssue} — ${brief.date}`);
L.push("");
L.push(
  prev
    ? `Covers everything since issue №${prev.issue} (${prev.date}).`
    : `Covers the last ${forcedDays ?? 7} days.`,
);
L.push("");
L.push(`## What got built — ${commits.length} commits`);
if (Object.keys(byPlace).length) {
  L.push("");
  L.push(
    "By place: " +
      Object.entries(byPlace)
        .sort((a, b) => b[1] - a[1])
        .map(([p, n]) => `${p} (${n})`)
        .join(", "),
  );
}
L.push("");
for (const e of brief.build.entries) {
  L.push(`- **${e.subject}** _(${e.date}${e.places.length ? `, ${e.places.join(" + ")}` : ""})_`);
  if (e.lede) L.push(`  ${e.lede}`);
}

L.push("");
L.push("## The world itself");
if (!world.ok) {
  L.push("");
  L.push(`_Unavailable this issue: ${world.reason}_`);
  L.push(
    "_Write the issue from the build record alone. Do NOT invent in-world events, residents, or quotes to fill the gap._",
  );
} else {
  L.push("");
  L.push(`${world.events} events recorded.`);
  if (Object.keys(world.kinds).length) {
    L.push(
      "Kinds: " +
        Object.entries(world.kinds)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k} ×${n}`)
          .join(", "),
    );
  }
  const busiest = Object.entries(world.actors).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (busiest.length) {
    L.push("Busiest residents: " + busiest.map(([n, c]) => `${n} (${c})`).join(", "));
  }
  if (world.encounters.length) {
    L.push("");
    L.push("Encounters (who walked up to whom):");
    for (const e of world.encounters) L.push(`- ${e}`);
  }
  if (world.graffiti.length) {
    L.push("");
    L.push("New on the graffiti wall:");
    for (const g of world.graffiti) L.push(`- ${g.author}: "${g.text}"`);
  } else {
    L.push("");
    L.push("Graffiti wall: nothing new.");
  }
  const online = world.residents.filter((r) => r.status && r.status !== "away");
  L.push("");
  L.push(`Residents on the books: ${world.residents.length} (${online.length} not marked away).`);
}

L.push("");
L.push("## Rules for writing this issue");
L.push("");
L.push("- Every claim must trace to something above. No invented residents, quotes, or events.");
L.push("- The build record is the world's own history — report changes as things that HAPPENED to the world, not as software changes. 'The Moon stopped bouncing' beats 'fixed a collision bug'.");
L.push("- If a section has no material, cut it. A short honest issue beats a padded one.");
console.log(L.join("\n"));
