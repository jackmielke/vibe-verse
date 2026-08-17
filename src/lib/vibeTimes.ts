/**
 * Where The Vibe Times comes from.
 *
 * Three surfaces print the paper — the /times page, the strip on the front
 * door, and the newsstand you walk up to in the plaza — and all three used
 * to fetch `/vibe-times.json`, a file somebody had to remember to write.
 * The `vibe-times` edge function writes an issue every morning now, so the
 * live paper is the Supabase row and the static files are the fallback.
 *
 * The fallback is the point. This is the one surface on the site that
 * claims to be current, so it is better for it to show a week-old issue
 * with an honest dateline (the page works out the age itself) than a
 * spinner or a gap where the news should be.
 */

export interface Headline {
  emoji: string;
  headline: string;
  body: string;
}

/** A story from outside the sky. `url` always points at something real. */
export interface Dispatch {
  desk: "ai" | "tech" | "sports" | "culture" | "history" | string;
  emoji: string;
  headline: string;
  body: string;
  source: string;
  url: string;
}

export interface Issue {
  issue: number;
  date: string;
  /** When this edition came off the presses, ISO/UTC. Missing on old issues. */
  printed_at?: string;
  motto: string;
  headlines: Headline[];
  gossip: string;
  weather: string;
  quote: { text: string; author: string };
  stats: Record<string, number | string>;
  /** Everything below arrived with the daily edition; older issues lack it. */
  dispatches?: Dispatch[];
  vibey_says?: string;
  /** `text` is the reader's own words; `note` is the editor answering back. */
  letters?: { author: string; text: string; note: string }[];
  forecast?: { emoji: string; label: string; text: string }[];
  sources?: { label: string; url: string }[];
}

export interface Paper {
  current: Issue | null;
  archive: Issue[];
  /** Where this copy came from, for the footer to be honest about. */
  live: boolean;
}

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/vibe-times`;

/**
 * The hour an edition was printed, on the reader's own clock — "6:02 am".
 *
 * The presses run at 13:00 UTC, which is a different time of day depending
 * on where you are reading, so the stored timestamp is UTC and the
 * conversion happens here. Returns null for the issues written by hand,
 * which have no press time and should simply not claim one.
 */
export function printedAt(iso?: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
}

function looksLikeIssue(v: unknown): v is Issue {
  const i = v as Issue | null;
  return !!i && typeof i.issue === "number" && Array.isArray(i.headlines) && i.headlines.length > 0;
}

async function withTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The static files, which ship with the site and are always there. */
async function fromDisk(): Promise<Paper> {
  const [current, archive] = await Promise.all([
    fetch("/vibe-times.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("/vibe-times-archive.json").then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  return {
    current: looksLikeIssue(current) ? current : null,
    archive: Array.isArray(archive) ? archive.filter(looksLikeIssue) : [],
    live: false,
  };
}

/**
 * Today's paper plus the back issues, newest first.
 *
 * Tries the presses, falls back to the committed copy. Never throws: a
 * newspaper failing to load must not take a page down with it.
 */
export async function loadPaper(limit = 14): Promise<Paper> {
  try {
    const res = await withTimeout(`${FUNCTION_URL}?limit=${limit}`, 6000);
    if (res.ok) {
      const data = await res.json();
      if (looksLikeIssue(data?.current)) {
        return {
          current: data.current,
          archive: Array.isArray(data.archive) ? data.archive.filter(looksLikeIssue) : [],
          live: true,
        };
      }
    }
  } catch {
    /* the presses are unreachable; the committed copy will do */
  }
  return fromDisk();
}

/** Just the front page, for surfaces that only show a teaser. */
export async function loadCurrentIssue(): Promise<Issue | null> {
  return (await loadPaper(1)).current;
}

/**
 * Write to the editor.
 *
 * The line goes in the postbag and up on the graffiti wall in the plaza, and
 * the next morning's edition may print it — verbatim, under this name, with
 * the editor's reply underneath. Resolves with an error string rather than
 * throwing, because "the editor is not taking letters right now" is
 * something the page should say out loud rather than swallow.
 */
export async function sendLetter(author: string, body: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "letter", author, body }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? "the postbag is jammed" };
    return { ok: true };
  } catch {
    return { ok: false, error: "couldn't reach the letterbox" };
  }
}
