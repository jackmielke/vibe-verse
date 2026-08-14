/**
 * The Chronicle, and the one promise it makes.
 *
 * The page claims to need nothing: no network, no database, no account, no key
 * that expires. That is the entire reason it exists in the shape it does, and
 * it is a promise that decays silently — somebody adds a live "worlds opened
 * this week" counter, it works beautifully, and nobody notices the page has
 * quietly joined everything else that stops working when a server goes away.
 *
 * So the module graph is walked and asserted. This is a real check rather than
 * a comment, because a comment cannot fail.
 *
 * The dates are also checked for the two ways a generated history lies without
 * looking wrong: a world dated before the vibeverse existed (the scaffold
 * commit), and every world sharing one date (a shallow clone's graft
 * boundary). Both produce a page that reads perfectly and is fiction.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { REPO_LIFE, WORLD_LIFE } from "@/worlds/chronicle";
import { WORLDS } from "@/worlds/registry";

const ROOT = resolve(__dirname, "../..");

/** Follow relative and `@/` imports from a file, breadth-first. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  const bare: string[] = [];

  const resolveSpec = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
    else {
      bare.push(spec);
      return null;
    }
    for (const ext of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx"]) {
      const p = base + ext;
      if (existsSync(p) && !p.endsWith("/")) {
        try {
          if (readFileSync(p).length >= 0) return p;
        } catch {
          /* a directory — keep trying */
        }
      }
    }
    return null;
  };

  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
      const next = resolveSpec(file, m[1]);
      if (next) queue.push(next);
    }
  }
  return [...seen].concat(bare.map((b) => `bare:${b}`));
}

describe("the chronicle needs nothing", () => {
  const graph = moduleGraph(join(ROOT, "src/pages/Chronicle.tsx"));
  const local = graph.filter((f) => !f.startsWith("bare:"));
  const packages = graph.filter((f) => f.startsWith("bare:")).map((b) => b.slice(5));

  it("reaches no module that talks to a server", () => {
    /* Supabase is the whole backend — auth, coins, the portal, realtime. If it
       is anywhere in this page's imports then the page has a dependency that
       outlives nothing. */
    const offenders = local.filter((f) =>
      /integrations\/supabase|\/portal\/api|lib\/vibecoin|use-vibecoin|use-wardrobe|vibeTimes/.test(f),
    );
    expect(offenders.map((f) => f.replace(`${ROOT}/`, ""))).toEqual([]);
  });

  it("contains no fetch, XHR or websocket of its own", () => {
    const bad: string[] = [];
    for (const file of local) {
      const src = readFileSync(file, "utf8");
      /* `fetch(` rather than `fetch` — "prefetch" and "fetchPriority" are
         both in this graph and neither goes anywhere. */
      if (/\bfetch\s*\(|XMLHttpRequest|new WebSocket|EventSource/.test(src)) {
        bad.push(file.replace(`${ROOT}/`, ""));
      }
    }
    expect(bad).toEqual([]);
  });

  it("pulls in no package that implies a backend", () => {
    const banned = packages.filter((p) =>
      /^@supabase|^socket\.io|^axios|^firebase|^@tanstack\/react-query$/.test(p),
    );
    expect(banned).toEqual([]);
  });
});

describe("the dates are not fiction", () => {
  const lives = Object.entries(WORLD_LIFE);

  it("covers the registry", () => {
    expect(lives.length).toBeGreaterThan(20);
    const keys = new Set(WORLDS.map((w) => w.key));
    for (const [key] of lives) expect(keys, `${key} is not a world`).toContain(key);
  });

  it("has no world older than the vibeverse", () => {
    /* The repository's root commit is a Lovable scaffold dated 2025-01-01, and
       it contains `src/pages/Index.tsx` — which is a world's `source`. Before
       the generator learned to skip it, the oldest world in here appeared to
       predate the project by fifteen months. It read as a charming fact. */
    for (const [key, life] of lives) {
      expect(
        life.born >= REPO_LIFE.born,
        `${key} claims to be born ${life.born}, before the first commit ${REPO_LIFE.born}`,
      ).toBe(true);
    }
  });

  it("is not one flat date, which is what a shallow clone produces", () => {
    /* In a shallow clone git reports the graft boundary as the commit that
       created every file, so every world lands on the same day and the history
       reads as one heroic week. Distinct days is the cheapest way to notice. */
    const days = new Set(lives.map(([, l]) => l.born.slice(0, 10)));
    expect(days.size).toBeGreaterThan(Math.min(8, lives.length / 4));
  });

  it("counts real work for every world", () => {
    for (const [key, life] of lives) {
      expect(life.commits, `${key} has no commits`).toBeGreaterThan(0);
      expect(life.hands, `${key} has no authors`).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(life.born)), `${key} has an unparseable date`).toBe(false);
    }
  });
});
