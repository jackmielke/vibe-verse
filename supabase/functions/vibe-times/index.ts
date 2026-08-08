// vibe-times — Supabase Edge Function
//
// The presses. Once a day this writes the next issue of The Vibe Times and
// stores it in public.vibe_times_issues; the /times page, the front-door
// strip and the newsstand in the plaza all read the latest row.
//
// The paper used to be written by hand, which is why issue №1 sat on the
// front door from July into August wearing a masthead that claimed it was
// written nightly. Now it genuinely is, and it reads three worlds:
//
//   1. THE BUILD RECORD — public/build-log.json, published with the site by
//      tools/build-log.mjs. This repo's commit subjects are already written
//      like headlines, and the first paragraph of each body is the actual
//      story. (The repo is private, so the GitHub API is closed to us
//      without a token; if VIBE_TIMES_GITHUB_TOKEN is set we prefer the API
//      and get the log fresh instead of as-of-last-deploy.)
//
//   2. THE WORLD ITSELF — who arrived, who walked up to whom, what moved
//      through the economy, what Vibey wrote in its journal overnight.
//      Names and counts only: no message bodies, no wallet addresses. The
//      paper is public and a resident's chat is not.
//
//   3. OUTSIDE THE SKY — the actual internet. AI and tech headlines, last
//      night's scores, culture, and what happened on this date in history.
//      All from open feeds, no API keys.
//
// Everything above is gathered as DATA and handed to the model with one
// standing rule: it may only write what the brief contains. In-world claims
// trace to a commit or a logged event; every outside-world dispatch must
// carry the URL of a headline we actually fetched, and any dispatch whose
// link isn't in that set is dropped before the issue is stored. The stats
// block is computed here, never by the model, so the numbers in the paper
// are arithmetic rather than vibes. The forecast is the one section allowed
// to be nonsense, and it is labelled as such.
//
// Routes:
//   GET  /vibe-times            → { current, archive } (published issues)
//   GET  /vibe-times?limit=5    → fewer back issues
//   POST /vibe-times            → write today's issue if it isn't written
//   POST /vibe-times?force=1    → rewrite today's (service-role key only)
//
// The POST is safe to leave open: one row per calendar day is enforced by a
// unique constraint, and the row is claimed BEFORE the model is called, so
// a hundred pokes still buy exactly one issue.
//
// Deploy:
//   supabase functions deploy vibe-times --no-verify-jwt
// Env:
//   OPENROUTER_API_KEY        — required to write (not to read)
//   SUPABASE_SERVICE_ROLE_KEY — required
//   VIBE_TIMES_MODEL          — optional, default anthropic/claude-sonnet-4.5
//   VIBE_TIMES_SITE_URL       — optional, default https://myvibeverse.com
//   VIBE_TIMES_GITHUB_TOKEN   — optional, reads commits live instead

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODEL = Deno.env.get("VIBE_TIMES_MODEL") ?? "anthropic/claude-sonnet-4.5";
const SITE = (Deno.env.get("VIBE_TIMES_SITE_URL") ?? "https://myvibeverse.com").replace(/\/$/, "");
const REPO = "jackmielke/vibe-verse";
const UA = "TheVibeTimes/1.0 (+https://myvibeverse.com/times)";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ---------------------------------------------------------------------
// Small fetch helpers. Every outside source is optional: the paper comes
// out whether or not ESPN is up, so nothing here is allowed to throw.
// ---------------------------------------------------------------------
async function grab(url: string, ms = 9000, headers: Record<string, string> = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": UA, ...headers },
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function grabJson<T>(url: string, ms = 9000, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    return JSON.parse(await grab(url, ms, headers)) as T;
  } catch {
    return null;
  }
}

function decodeEntities(s: string) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** RSS and Atom, parsed the cheap way. We only ever want title + link. */
function parseFeed(xml: string, limit: number) {
  const out: { title: string; url: string; when: string }[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/g) ?? [];
  for (const b of blocks.slice(0, limit)) {
    const title = decodeEntities(b.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const url =
      b.match(/<link[^>]*href="([^"]+)"/)?.[1] ??
      decodeEntities(b.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] ?? "");
    const when = decodeEntities(
      b.match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/)?.[1] ?? "",
    );
    if (title && url.startsWith("http")) out.push({ title: title.slice(0, 200), url, when });
  }
  return out;
}

// ---------------------------------------------------------------------
// 1. The build record
// ---------------------------------------------------------------------
interface Commit {
  sha?: string;
  date: string;
  subject: string;
  lede: string;
  places?: string[];
}

/** Only the site itself and its preview deploys may host the build log. */
function safeSite(candidate: string | null): string | null {
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    const ok = u.protocol === "https:" &&
      (u.hostname === "myvibeverse.com" || u.hostname.endsWith(".myvibeverse.com") || u.hostname.endsWith(".vercel.app"));
    return ok ? `${u.protocol}//${u.hostname}` : null;
  } catch {
    return null;
  }
}

async function buildRecord(sinceISO: string, site: string): Promise<{ commits: Commit[]; source: string }> {
  const token = Deno.env.get("VIBE_TIMES_GITHUB_TOKEN");
  if (token) {
    const rows = await grabJson<
      { sha: string; commit: { message: string; author: { date: string } } }[]
    >(`https://api.github.com/repos/${REPO}/commits?since=${encodeURIComponent(sinceISO)}&per_page=60`, 12_000, {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    });
    if (Array.isArray(rows) && rows.length) {
      return {
        source: "github api",
        commits: rows
          .filter((c) => !c.commit.message.startsWith("Merge "))
          .map((c) => {
            const [subject, ...body] = c.commit.message.split("\n");
            return {
              sha: c.sha.slice(0, 8),
              date: c.commit.author.date.slice(0, 10),
              subject,
              lede: body.join("\n").trim().split("\n\n")[0]?.replace(/\s+/g, " ").slice(0, 420) ?? "",
            };
          }),
      };
    }
  }

  // The published log: written at build time, deployed with the site.
  const log = await grabJson<{ generated_at: string; commits: Commit[] }>(`${site}/build-log.json`, 9000);
  const commits = (log?.commits ?? []).filter((c) => c.date >= sinceISO.slice(0, 10)).slice(0, 60);
  return { source: `build-log.json (${log?.generated_at?.slice(0, 10) ?? "missing"})`, commits };
}

// ---------------------------------------------------------------------
// 2. The world itself
// ---------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function worldRecord(sb: any, sinceISO: string) {
  const q = async <T>(fn: () => Promise<{ data: T | null }>): Promise<T | null> => {
    try {
      return (await fn()).data;
    } catch {
      return null;
    }
  };

  const [events, agents, graffiti, ledger, drops, journal, photos, price, rounds, rps, wallets, spoken] =
    await Promise.all([
      q<{ kind: string; actor_name: string | null; target_name: string | null; created_at: string }[]>(() =>
        sb.from("world_events").select("kind,actor_name,target_name,created_at")
          .gte("created_at", sinceISO).order("created_at", { ascending: false }).limit(1000)),
      q<{ name: string; status: string | null; last_seen_at: string | null }[]>(() =>
        sb.from("world_agents").select("name,status,last_seen_at")
          .order("last_seen_at", { ascending: false }).limit(60)),
      q<{ author_name: string | null; text: string; created_at: string }[]>(() =>
        sb.from("world_graffiti").select("author_name,text,created_at")
          .gte("created_at", sinceISO).order("created_at", { ascending: false }).limit(30)),
      q<{ amount: number; reason: string | null; created_at: string }[]>(() =>
        sb.from("vibe_ledger").select("amount,reason,created_at")
          .gte("created_at", sinceISO).order("created_at", { ascending: false }).limit(300)),
      q<{ amount_wei: string; status: string | null; created_at: string }[]>(() =>
        sb.from("vibe_drops").select("amount_wei,status,created_at").gte("created_at", sinceISO).limit(200)),
      q<{ body: string; mood: string | null; created_at: string }[]>(() =>
        sb.from("vibey_journal_entries").select("body,mood,created_at")
          .gte("created_at", sinceISO).order("created_at", { ascending: false }).limit(4)),
      q<{ title: string | null; created_at: string }[]>(() =>
        sb.from("gallery_photos").select("title,created_at").gte("created_at", sinceISO).limit(30)),
      q<{ price_usd: number; fetched_at: string }[]>(() =>
        sb.from("vibe_price_cache").select("price_usd,fetched_at").limit(1)),
      q<{ game: string | null; status: string | null; opens_at: string }[]>(() =>
        sb.from("vibe_rounds").select("game,status,opens_at").gte("opens_at", sinceISO).limit(200)),
      q<{ outcome: string | null; opened_at: string }[]>(() =>
        sb.from("vibe_rps_rounds").select("outcome,opened_at").gte("opened_at", sinceISO).limit(200)),
      q<{ balance: number }[]>(() => sb.from("vibe_balances").select("balance").limit(1000)),
      // Who spoke and how often — never what they said. The paper is
      // public and a resident wandering around chatting did not sign up
      // to be quoted in it.
      q<{ speaker: string | null }[]>(() =>
        sb.from("world_messages").select("speaker").gte("created_at", sinceISO).limit(2000)),
    ]);

  const talkers: Record<string, number> = {};
  for (const m of spoken ?? []) {
    if (m.speaker) talkers[m.speaker] = (talkers[m.speaker] ?? 0) + 1;
  }

  const kinds: Record<string, number> = {};
  const actors: Record<string, number> = {};
  const encounters: string[] = [];
  for (const e of events ?? []) {
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    if (e.actor_name) actors[e.actor_name] = (actors[e.actor_name] ?? 0) + 1;
    if (e.kind === "proximity" && e.actor_name && e.target_name) {
      encounters.push(`${e.actor_name} → ${e.target_name}`);
    }
  }

  const reasons: Record<string, number> = {};
  let vibeMoved = 0;
  for (const l of ledger ?? []) {
    vibeMoved += Math.abs(Number(l.amount) || 0);
    const r = l.reason ?? "unlabelled";
    reasons[r] = (reasons[r] ?? 0) + 1;
  }

  const top = (o: Record<string, number>, n: number) =>
    Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

  return {
    window_start: sinceISO,
    events: (events ?? []).length,
    event_kinds: kinds,
    busiest_residents: top(actors, 10),
    encounters: [...new Set(encounters)].slice(0, 14),
    residents_on_the_books: (agents ?? []).length,
    residents_awake: (agents ?? []).filter((a) => a.status && a.status !== "away").length,
    resident_names: (agents ?? []).slice(0, 24).map((a) => a.name),
    graffiti: (graffiti ?? []).map((g) => ({ author: g.author_name, text: g.text.slice(0, 140) })),
    lines_spoken: (spoken ?? []).length,
    biggest_talkers: top(talkers, 8),
    journal: (journal ?? []).map((j) => ({ mood: j.mood, body: j.body.slice(0, 700) })),
    new_photos: (photos ?? []).length,
    economy: {
      ledger_entries: (ledger ?? []).length,
      vibe_moved: Math.round(vibeMoved),
      top_reasons: top(reasons, 6),
      onchain_drops: (drops ?? []).length,
      wallets_holding: (wallets ?? []).filter((w) => Number(w.balance) > 0).length,
      vibe_price_usd: price?.[0]?.price_usd ?? null,
      games_played: (rounds ?? []).length + (rps ?? []).length,
    },
  };
}

// ---------------------------------------------------------------------
// 3. Outside the sky — the actual internet
// ---------------------------------------------------------------------
interface Dispatch {
  desk: "ai" | "tech" | "sports" | "culture" | "history";
  source: string;
  title: string;
  url: string;
  when?: string;
  detail?: string;
}

const FEEDS: { label: string; url: string; desk: Dispatch["desk"]; take: number }[] = [
  { label: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/", desk: "ai", take: 6 },
  { label: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", desk: "ai", take: 6 },
  { label: "MIT Technology Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/", desk: "ai", take: 4 },
  { label: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/", desk: "ai", take: 4 },
  { label: "Simon Willison", url: "https://simonwillison.net/atom/everything/", desk: "ai", take: 5 },
  { label: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", desk: "tech", take: 5 },
  { label: "ESPN", url: "https://www.espn.com/espn/rss/news", desk: "sports", take: 6 },
  { label: "The Ringer", url: "https://www.theringer.com/rss/index.xml", desk: "culture", take: 5 },
  { label: "Polygon", url: "https://www.polygon.com/rss/index.xml", desk: "culture", take: 5 },
  { label: "Pitchfork", url: "https://pitchfork.com/feed/feed-news/rss", desk: "culture", take: 4 },
];

// `game` builds a link to the individual box score. Each game needs its own
// url: dispatches are deduplicated by link, and yesterday's stories are
// filtered out of today's brief, so a whole league sharing one scoreboard
// url would mean one game reported per league per week.
const SCOREBOARDS: { label: string; path: string; game: (id: string) => string }[] = [
  { label: "NBA", path: "basketball/nba", game: (id) => `https://www.espn.com/nba/game/_/gameId/${id}` },
  { label: "NFL", path: "football/nfl", game: (id) => `https://www.espn.com/nfl/game/_/gameId/${id}` },
  { label: "MLB", path: "baseball/mlb", game: (id) => `https://www.espn.com/mlb/game/_/gameId/${id}` },
  { label: "NHL", path: "hockey/nhl", game: (id) => `https://www.espn.com/nhl/game/_/gameId/${id}` },
  { label: "Premier League", path: "soccer/eng.1", game: (id) => `https://www.espn.com/soccer/match/_/gameId/${id}` },
  { label: "MLS", path: "soccer/usa.1", game: (id) => `https://www.espn.com/soccer/match/_/gameId/${id}` },
];

async function outsideWorld(now: Date): Promise<Dispatch[]> {
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const stamp = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const sinceUnix = Math.floor((now.getTime() - 36 * 3600 * 1000) / 1000);

  const jobs: Promise<Dispatch[]>[] = [];

  // Feeds.
  for (const f of FEEDS) {
    jobs.push(
      grab(f.url, 9000)
        .then((xml) =>
          parseFeed(xml, f.take).map((i) => ({
            desk: f.desk, source: f.label, title: i.title, url: i.url, when: i.when,
          })),
        )
        .catch(() => []),
    );
  }

  // Hacker News: what the internet actually clicked on in the last day and
  // a half, which is a better read on the mood than any one publication.
  jobs.push(
    grabJson<{ hits: { title: string; url: string | null; objectID: string; points: number; num_comments: number }[] }>(
      `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${sinceUnix},points>80&hitsPerPage=25`,
    )
      .then((d) =>
        (d?.hits ?? []).map((h) => ({
          desk: /\b(ai|llm|gpt|claude|gemini|model|agent|openai|anthropic|neural|robot)\b/i.test(h.title)
            ? ("ai" as const)
            : ("tech" as const),
          source: "Hacker News",
          title: h.title,
          url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
          detail: `${h.points} points, ${h.num_comments} comments`,
        })),
      )
      .catch(() => []),
  );

  // Last night's results. Out-of-season leagues simply return nothing.
  for (const s of SCOREBOARDS) {
    for (const day of [yesterday, now]) {
      jobs.push(
        grabJson<{
          events?: {
            id: string; name: string; shortName: string;
            status?: { type?: { completed?: boolean; shortDetail?: string } };
            competitions?: { competitors?: { team?: { displayName?: string }; score?: string }[] }[];
          }[];
        }>(`https://site.api.espn.com/apis/site/v2/sports/${s.path}/scoreboard?dates=${stamp(day)}`)
          .then((d) =>
            (d?.events ?? [])
              .filter((e) => e.status?.type?.completed)
              .slice(0, 5)
              .map((e) => {
                const c = e.competitions?.[0]?.competitors ?? [];
                const line = c
                  .map((t) => `${t.team?.displayName ?? "?"} ${t.score ?? ""}`.trim())
                  .join(" vs ");
                return {
                  desk: "sports" as const,
                  source: `${s.label} scoreboard`,
                  title: `${e.shortName ?? e.name}: ${line}`,
                  url: s.game(e.id),
                  when: day.toISOString().slice(0, 10),
                  detail: e.status?.type?.shortDetail ?? "final",
                };
              }),
          )
          .catch(() => []),
      );
    }
  }

  // On this day. Free, keyless, and reliably a good closing paragraph.
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  jobs.push(
    grabJson<{ selected?: { year: number; text: string; pages?: { content_urls?: { desktop?: { page?: string } } }[] }[] }>(
      `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected/${mm}/${dd}`,
    )
      .then((d) =>
        (d?.selected ?? []).slice(0, 5).map((s) => ({
          desk: "history" as const,
          source: "On this day",
          title: `${s.year}: ${s.text}`,
          url: s.pages?.[0]?.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${mm}_${dd}`,
        })),
      )
      .catch(() => []),
  );

  const settled = await Promise.allSettled(jobs);
  const seen = new Set<string>();
  const out: Dispatch[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const d of r.value) {
      if (!d.title || !d.url || seen.has(d.url + d.title)) continue;
      seen.add(d.url + d.title);
      out.push(d);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Writing the thing
// ---------------------------------------------------------------------
const SYSTEM = `You are the entire staff of THE VIBE TIMES, the daily paper of the VibeVerse — a hub of small 3D worlds you can walk, fly, drive and shoot your way through. Vibey, the resident AI, is your editor-in-chief. The paper is printed in the sky and read by the residents, most of whom are agents, and by the humans who wander in.

VOICE: a proper newspaper that happens to cover a place where the moon is landable and the economy runs on a joke coin. Dry, specific, delighted. Deadpan about absurd things and slightly awed by ordinary ones. Short sentences beat long ones. Concrete nouns beat adjectives. Funny because it is TRUE and precisely observed, never because you told a joke. Never use markdown, bullet points, or em dashes in the copy.

THE PAPER LIKES THIS PLACE. It is a local paper in a small town it is fond of, not a critic and not a coroner. A quiet week is charming, not sad: the joke is the deadpan gap between how enormous the log is and how little happened, never "nobody is here and nothing matters". Tease named residents the way a village paper teases the mayor, warmly and briefly, and never twice in one issue. Never end an issue on a bleak note.

THE ONE RULE: you may only write what is in the brief.
- In-world claims (headlines, gossip, weather) come from the build record and the world's own logged events. No invented residents, quotes, encounters or numbers.
- Every outside-world dispatch must be about an item that is IN the brief's dispatch list, and must carry that item's exact url. Never write a url that is not in the brief. Never report an outside event the brief does not contain.
- If a section has no material, return it empty. A short honest issue beats a padded one.
- The forecast section is the only place you may invent, and it is understood to be nonsense.
- NEVER write about the paper's own machinery. The brief, the build log, the dispatch list and the model writing this are not news and do not exist to the reader. A day with no commits is a day when nobody moved the furniture, not a day when "the build log was missing" — write about the world instead and say nothing about where the copy came from.

Return ONE raw JSON object, no markdown fences, exactly this shape:
{
  "motto": string,
  "headlines": [{ "emoji": string, "headline": string, "body": string }],
  "dispatches": [{ "desk": "ai"|"tech"|"sports"|"culture"|"history", "emoji": string, "headline": string, "body": string, "source": string, "url": string }],
  "gossip": string,
  "weather": string,
  "vibey_says": string,
  "forecast": [{ "emoji": string, "label": string, "text": string }],
  "quote": { "text": string, "author": string }
}

FIELD RULES
- motto: the strapline under the masthead. Six words or fewer, lowercase, different every day, drawn from the day's actual material.
- headlines: 3 to 5 stories about the VibeVerse itself, from the build record and the world log. The first is the lead and runs 90 to 150 words; the rest run 50 to 90. HEADLINES IN CAPITALS. Report changes as things that HAPPENED TO THE WORLD, not as software changes: "the moon stopped throwing people into the sky" beats "fixed collision bug". If the build record is thin, lead with the world's own life instead: who arrived, who greeted whom, what moved through the economy.
- dispatches: 5 to 7 items from outside the sky. This is the wire desk, and it is why anyone reads a paper twice. Spread it across the desks: two or three AI and tech stories, at least one real sports result or story, at least one from culture (music, film, games), and one bit of history only if it is a delight. 40 to 80 words each. Write them as a newspaper in a fictional sky would write about the real world: report the fact straight, then let one clause connect it to life in here. Never sneer, never boost. If an AI story is genuinely a big deal, say so plainly. Skip anything with a death toll, a disaster or a war in it: this is a fun paper and there are other papers for that.
- numbers: when you use a figure from computed_stats or the_world, describe it exactly as it is labelled. vibe_moved is everything that moved through the economy, not one resident's pay. Do not turn a total into an average or a person.
- gossip: the society column, 60 to 120 words, strictly from the encounter log, the graffiti wall, arrivals and departures. Real names, real counts. This is where the paper is funniest because the log is genuinely absurd.
- weather: sky and world conditions, 40 to 80 words, from the build record. Playful, physical, specific.
- vibey_says: Vibey's signed column, 50 to 90 words, first person, warm and a little strange. If Vibey's overnight journal is in the brief, draw on what it actually wrote. This is the one place the paper is allowed to be sincere. Connect something from outside the sky to something inside it.
- forecast: exactly 3 short playful predictions for the day ahead, 12 to 25 words each, label is 1 to 3 words. Clearly jokes. This is the horoscope column and everyone knows it.
- quote: one line worth pinning up, with an honest attribution to where it came from in the brief (a commit, the log, a resident, a dispatch).`;

// deno-lint-ignore no-explicit-any
function brief(payload: any) {
  return JSON.stringify(payload, null, 1).slice(0, 90_000);
}

// deno-lint-ignore no-explicit-any
async function compose(apiKey: string, briefText: string): Promise<any> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": SITE,
      "X-Title": "The Vibe Times",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4200,
      temperature: 0.85,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: briefText },
      ],
    }),
  });
  if (!r.ok) throw new Error(`openrouter ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  const json = text.replace(/^[\s\S]*?```(?:json)?/, "").replace(/```[\s\S]*$/, "").trim() || text.trim();
  try {
    return JSON.parse(json);
  } catch {
    // Models occasionally wrap the object in a sentence. Take the outermost
    // braces rather than failing the whole edition over punctuation.
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
    throw new Error("model did not return JSON");
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * One clean emoji, or the fallback.
 *
 * Models occasionally return something that is not an emoji at all — a
 * shortcode, a half-formed sequence, or a pictograph that arrives with a
 * replacement character welded to it. Slicing that by code unit splits
 * surrogate pairs and prints a black diamond in the middle of the front
 * page, which happened on day one. Anything with a letter, a digit or a
 * U+FFFD in it is not an emoji and does not get printed.
 */
function emoji(v: unknown, fallback: string) {
  const raw = typeof v === "string" ? v.trim() : "";
  if (!raw || /[�\p{L}\p{N}]/u.test(raw)) return fallback;
  const first = [...raw.matchAll(/\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️)?)*/gu)][0]?.[0];
  return first ?? fallback;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "missing Supabase env" }, 500);
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const url = new URL(req.url);

  // ---- Read -----------------------------------------------------------
  if (req.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 12) || 12, 40);
    const { data, error } = await sb
      .from("vibe_times_issues")
      .select("issue,edition_date,payload,published_at")
      .eq("status", "published")
      .order("edition_date", { ascending: false })
      .limit(limit);
    if (error) return json({ error: error.message }, 500);
    const issues = (data ?? []).map((r) => r.payload);
    return json(
      { current: issues[0] ?? null, archive: issues.slice(1) },
      200,
      { "Cache-Control": "public, max-age=300, s-maxage=300" },
    );
  }

  if (req.method !== "POST") return json({ error: "GET or POST" }, 405);

  // ---- Write ----------------------------------------------------------
  const authed = (req.headers.get("authorization") ?? "").replace("Bearer ", "") === serviceKey;
  const force = url.searchParams.get("force") === "1" && authed;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const { data: recent } = await sb
    .from("vibe_times_issues")
    .select("issue,edition_date,payload,status")
    .order("issue", { ascending: false })
    .limit(10);
  const rows = recent ?? [];
  const prev = rows.find((r) => r.status === "published" && r.edition_date !== today) ?? null;
  const todays = rows.find((r) => r.edition_date === today) ?? null;

  if (todays && !force) {
    return json({
      skipped: true,
      reason: todays.status === "published" ? "today's issue is already out" : "an issue is being written",
      issue: todays.issue,
    });
  }

  const nextIssue = todays ? todays.issue : (rows[0]?.issue ?? 0) + 1;

  // Claim the day BEFORE spending anything. The unique constraint on
  // edition_date is the lock; losing the race is a no-op, not an error.
  if (!todays) {
    const { error: claimErr } = await sb
      .from("vibe_times_issues")
      .insert({ issue: nextIssue, edition_date: today, status: "writing" });
    if (claimErr) return json({ skipped: true, reason: "another press already claimed today" });
  }

  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openrouterKey) {
    await sb.from("vibe_times_issues").delete().eq("edition_date", today).eq("status", "writing");
    return json({ error: "OPENROUTER_API_KEY is not set — no writer, no paper" }, 500);
  }

  // Cover everything since the last issue, but never less than a day and
  // never more than a fortnight: a paper that has been quiet for a month
  // should still print a readable issue rather than a year in review.
  const prevDate = prev?.edition_date ?? null;
  const floor = new Date(now.getTime() - 14 * 86_400_000);
  const ceiling = new Date(now.getTime() - 26 * 3600 * 1000);
  const sinceDate = prevDate ? new Date(`${prevDate}T00:00:00Z`) : ceiling;
  const sinceISO = new Date(
    Math.min(Math.max(sinceDate.getTime(), floor.getTime()), ceiling.getTime()),
  ).toISOString();

  // A preview deploy can be pointed at with ?site=, which is how the build
  // record gets read before a change is live on the real site.
  const site = safeSite(url.searchParams.get("site")) ?? SITE;

  try {
    const [build, world, wireToday] = await Promise.all([
      buildRecord(sinceISO, site),
      worldRecord(sb, sinceISO),
      outsideWorld(now),
    ]);

    // Yesterday's stories are not today's news. Feeds move slowly enough
    // that half of a morning's fetch was in the last issue, and the fix
    // is to never offer them again rather than to ask nicely.
    const alreadyRun = new Set<string>(
      ((prev?.payload?.dispatches ?? []) as { url?: string }[]).map((d) => d.url ?? ""),
    );
    const dispatches = wireToday.filter((d) => !alreadyRun.has(d.url));

    // The numbers in the paper are computed here, not written by the
    // model, so the stats block can never be a hallucination.
    const stats: Record<string, number | string> = {
      commits_since_last_issue: build.commits.length,
      events_logged: world.events,
      greetings_exchanged: world.event_kinds["proximity"] ?? 0,
      residents_on_the_books: world.residents_on_the_books,
      lines_spoken: world.lines_spoken,
    };
    if (world.economy.vibe_moved > 0) stats.vibe_moved = world.economy.vibe_moved;
    if (world.economy.games_played > 0) stats.games_played = world.economy.games_played;
    if (world.new_photos > 0) stats.photos_hung = world.new_photos;
    if (world.economy.vibe_price_usd) {
      stats.vibe_price = `$${Number(world.economy.vibe_price_usd).toFixed(8)}`;
    }

    const briefText = brief({
      issue_number: nextIssue,
      date: today,
      covers_since: sinceISO,
      previous_issue: prev ? { issue: prev.issue, date: prev.edition_date } : null,
      previous_motto: prev?.payload?.motto ?? null,
      previous_headlines: (prev?.payload?.headlines ?? []).map((h: { headline: string }) => h.headline),
      build_record: { source: build.source, commits: build.commits },
      the_world: world,
      dispatches_available: dispatches,
      computed_stats: stats,
      instructions:
        "Write today's issue from this brief only. Do not repeat a previous headline. " +
        "Every dispatch url must appear verbatim in dispatches_available.",
    });

    const draft = await compose(openrouterKey, briefText);

    // Validate. Anything the model made up gets dropped rather than
    // printed: a newspaper that invents a link is worse than a thin one.
    const allowed = new Map(dispatches.map((d) => [d.url, d]));
    const headlines = (Array.isArray(draft.headlines) ? draft.headlines : [])
      .map((h: Record<string, unknown>) => ({
        emoji: emoji(h.emoji, "📰"),
        headline: str(h.headline, 160),
        body: str(h.body, 2000),
      }))
      .filter((h: { headline: string; body: string }) => h.headline && h.body)
      .slice(0, 6);
    if (!headlines.length) throw new Error("draft had no usable headlines");

    let dropped = 0;
    const wire = (Array.isArray(draft.dispatches) ? draft.dispatches : [])
      .map((d: Record<string, unknown>) => {
        const link = str(d.url, 500);
        if (!allowed.has(link)) {
          dropped += 1;
          return null;
        }
        const desk = str(d.desk, 20);
        return {
          desk: ["ai", "tech", "sports", "culture", "history"].includes(desk) ? desk : allowed.get(link)!.desk,
          emoji: emoji(d.emoji, "📡"),
          headline: str(d.headline, 180),
          body: str(d.body, 1200),
          source: str(d.source, 80) || allowed.get(link)!.source,
          url: link,
        };
      })
      .filter(Boolean)
      .slice(0, 8);

    const forecast = (Array.isArray(draft.forecast) ? draft.forecast : [])
      .map((f: Record<string, unknown>) => ({
        emoji: emoji(f.emoji, "🔮"),
        label: str(f.label, 40),
        text: str(f.text, 300),
      }))
      .filter((f: { text: string }) => f.text)
      .slice(0, 4);

    const payload = {
      issue: nextIssue,
      date: today,
      motto: str(draft.motto, 90) || "all the news that fits the sky",
      headlines,
      dispatches: wire,
      gossip: str(draft.gossip, 1600),
      weather: str(draft.weather, 1200),
      vibey_says: str(draft.vibey_says, 1200),
      forecast,
      quote: {
        text: str(draft.quote?.text, 300) || "every builder grows the universe",
        author: str(draft.quote?.author, 160) || "written above the arch",
      },
      stats,
      // Where the outside half came from, so any claim can be traced.
      sources: [...new Set(wire.map((w: { source: string }) => w.source))]
        .map((label) => ({ label, url: wire.find((w: { source: string }) => w.source === label)!.url }))
        .slice(0, 12),
    };

    const { error: saveErr } = await sb
      .from("vibe_times_issues")
      .update({
        payload,
        sources: dispatches.slice(0, 120),
        model: MODEL,
        status: "published",
        published_at: new Date().toISOString(),
        note: `${build.source} · ${dispatches.length} dispatches available · ${dropped} unlinked dropped`,
      })
      .eq("edition_date", today);
    if (saveErr) throw new Error(`could not store the issue: ${saveErr.message}`);

    return json({
      published: true,
      issue: nextIssue,
      date: today,
      headlines: headlines.length,
      dispatches: wire.length,
      dispatches_available: dispatches.length,
      dispatches_dropped: dropped,
      commits_read: build.commits.length,
      build_source: build.source,
    });
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 500);
    // Leave the day open for a retry rather than burning the edition.
    await sb.from("vibe_times_issues").delete().eq("edition_date", today).eq("status", "writing");
    console.error("vibe-times failed:", message);
    return json({ error: message }, 500);
  }
});

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });
}
