/**
 * Scores and playtime for every world: lore, fun, smooth, and hours played.
 *
 * ## Anonymous by construction, not by policy
 *
 * There is no table of sessions or players to delete later, because none is
 * ever written. This browser counts its own active seconds in memory, adds
 * them to the world's running total about once a minute, and forgets them.
 * The database row is one line per world: sums and counts, nothing else.
 *
 * - **Players** is a tally. The first time this device opens a world it sends
 *   `newPlayer: true` once and remembers, in its own localStorage, that it
 *   already counted. The server cannot tell one +1 from another.
 * - **Every call uses the anon key and nothing else**, through a plain fetch,
 *   so a signed-in visitor's token never rides along and the functions could
 *   not read `auth.uid()` even if somebody later wanted them to.
 * - **Ratings** are three running sums and three counts. "Already rated" is a
 *   flag on this device, not a row anywhere.
 *
 * Smoothness has two halves: what players say (1 to 5) and what their browser
 * measured (the average frame rate while they played). The scoreboard shows
 * both, because a world can feel smooth at 40 fps and stutter at 90.
 */
import { WORLDS, worldByRoute, type WorldEntry } from "@/worlds/registry";

const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** The world a location belongs to, or undefined for the app's own pages. */
export function worldForLocation(pathname: string, search = ""): WorldEntry | undefined {
  const path = pathname.replace(/\/+$/, "") || "/";
  const w =
    (search && worldByRoute(path + search)) ||
    worldByRoute(path) ||
    // `/play/blob-battle`, `/homes/xyz`: a world owns everything under its route.
    WORLDS.find((x) =>
      [x.route, ...(x.aliases ?? [])].some((r) => {
        const base = r.split("?")[0];
        return base !== "/" && path.startsWith(base + "/");
      }),
    );
  if (!w || w.kind === "tool") return undefined;
  return w;
}

/** Whether this browser should report at all: never from a test runner. */
export function trackingEnabled(): boolean {
  if (typeof window === "undefined" || !URL_BASE || !ANON) return false;
  if (navigator.webdriver && !safeGet("vv.stats.force")) return false;
  return true;
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private window: we just count this device again next time */
  }
}

/** True exactly once per device per world. */
export function claimNewPlayer(worldKey: string): boolean {
  const k = `vv.played.${worldKey}`;
  if (safeGet(k)) return false;
  safeSet(k, "1");
  return true;
}

export function hasPlayed(worldKey: string): boolean {
  return !!safeGet(`vv.played.${worldKey}`);
}

export function hasRated(worldKey: string): boolean {
  return !!safeGet(`vv.rated.${worldKey}`);
}

/** "Not now" quiets the prompt for a world for a week. */
export function snoozeRating(worldKey: string) {
  safeSet(`vv.rate.snooze.${worldKey}`, String(Date.now() + 7 * 864e5));
}
export function ratingSnoozed(worldKey: string): boolean {
  const until = Number(safeGet(`vv.rate.snooze.${worldKey}`) ?? 0);
  return until > Date.now();
}

/** A world played long enough to have an opinion about, waiting for one. */
export const PENDING_KEY = "vv.rate.pending";
export const RATE_AFTER_SECONDS = 120;

async function rpc(fn: string, body: Record<string, unknown>, keepalive = false) {
  if (!URL_BASE || !ANON) return;
  try {
    await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
      method: "POST",
      keepalive,
      headers: {
        "content-type": "application/json",
        apikey: ANON,
        authorization: `Bearer ${ANON}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    /* offline: those seconds are lost, which is the honest failure */
  }
}

export interface PlayIncrement {
  world: string;
  seconds: number;
  newPlayer?: boolean;
  newSession?: boolean;
  fps?: number | null;
}

export function sendPlay(p: PlayIncrement, keepalive = false) {
  return rpc(
    "world_stats_add_play",
    {
      p_world: p.world,
      p_seconds: Math.max(0, Math.min(120, Math.round(p.seconds))),
      p_new_player: !!p.newPlayer,
      p_new_session: !!p.newSession,
      p_fps: p.fps && Number.isFinite(p.fps) ? Math.round(p.fps * 10) / 10 : null,
    },
    keepalive,
  );
}

export interface Rating {
  lore?: number | null;
  fun?: number | null;
  smooth?: number | null;
}

export async function sendRating(worldKey: string, r: Rating) {
  const v = (n?: number | null) => (n && n >= 1 && n <= 5 ? Math.round(n) : null);
  await rpc("world_stats_rate", {
    p_world: worldKey,
    p_lore: v(r.lore),
    p_fun: v(r.fun),
    p_smooth: v(r.smooth),
  });
  safeSet(`vv.rated.${worldKey}`, "1");
  try {
    if (localStorage.getItem(PENDING_KEY) === worldKey) localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

export interface WorldStatsRow {
  world_key: string;
  play_seconds: number;
  players: number;
  sessions: number;
  fps_sum: number;
  fps_n: number;
  lore_sum: number;
  lore_n: number;
  fun_sum: number;
  fun_n: number;
  smooth_sum: number;
  smooth_n: number;
}

export async function fetchStats(): Promise<WorldStatsRow[]> {
  if (!URL_BASE || !ANON) return [];
  const res = await fetch(`${URL_BASE}/rest/v1/world_stats?select=*`, {
    headers: { apikey: ANON, authorization: `Bearer ${ANON}` },
  });
  if (!res.ok) throw new Error(`world_stats ${res.status}`);
  return (await res.json()) as WorldStatsRow[];
}

/** Average of a sum and a count, or null when nobody has said anything. */
export const avg = (sum: number, n: number): number | null => (n > 0 ? sum / n : null);

/**
 * The one number a world is ranked by: the mean of whichever of lore, fun and
 * smooth have any votes. Null until at least one does.
 */
export function overall(r: WorldStatsRow): number | null {
  const parts = [avg(r.lore_sum, r.lore_n), avg(r.fun_sum, r.fun_n), avg(r.smooth_sum, r.smooth_n)].filter(
    (x): x is number => x !== null,
  );
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

export function formatHours(seconds: number): string {
  if (seconds < 60) return seconds > 0 ? "<1m" : "0";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = seconds / 3600;
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h).toLocaleString()}h`;
}
