/**
 * The high score wall: top tens, today's champs, and signing your initials.
 *
 * Stored in `arcade_scores` (see `supabase/migrations/…_arcade_scores.sql`):
 * a game, three letters and a number, and nothing else. No user id, no
 * device id, the same rule as `world_stats`: the wall knows that somebody
 * called "JCM" scored 18,400 and has no way to find out who that was.
 *
 * The wall must never be empty or broken. Offline (or before anybody has
 * played) it is the house scores from `games.ts` plus whatever this device
 * signed, and it says so: `live` is false and the wall reads THIS DEVICE.
 */
import { ARCADE_GAMES, arcadeGame, beats, cleanInitials, type ArcadeGame } from "./games";

const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export interface BoardRow {
  initials: string;
  score: number;
  /** ms since epoch */
  at: number;
  house?: boolean;
  mine?: boolean;
}

export interface GameBoard {
  top: BoardRow[];
  today: BoardRow | null;
}

export interface Board {
  live: boolean;
  games: Record<string, GameBoard>;
}

const LOCAL = "arcade.myScores";
const LAST_INITIALS = "arcade.initials";
const TOP = 10;

interface LocalScore { game: string; initials: string; score: number; at: number }

function localScores(): LocalScore[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.game === "string" && typeof x.score === "number") : [];
  } catch {
    return [];
  }
}

export function lastInitials(): string {
  try {
    return localStorage.getItem(LAST_INITIALS) ?? "";
  } catch {
    return "";
  }
}

const sortFor = (g: ArcadeGame) => (a: BoardRow, b: BoardRow) => (g.order === "desc" ? b.score - a.score : a.score - b.score) || a.at - b.at;
const startOfDay = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Build a board from rows, topping up with the house scores so no column is bare. */
function assemble(rows: Array<LocalScore & { mine?: boolean }>, live: boolean): Board {
  const games: Record<string, GameBoard> = {};
  const today = startOfDay();
  const mine = new Set(localScores().map((r) => `${r.game}|${r.initials}|${r.score}`));
  for (const g of ARCADE_GAMES) {
    const real: BoardRow[] = rows
      .filter((r) => r.game === g.key)
      .map((r) => ({ initials: r.initials, score: r.score, at: r.at, mine: r.mine || mine.has(`${g.key}|${r.initials}|${r.score}`) }));
    const house: BoardRow[] = g.house.map(([initials, score]) => ({ initials, score, at: 0, house: true }));
    const top = [...real, ...house].sort(sortFor(g)).slice(0, TOP);
    const todays = real.filter((r) => r.at >= today).sort(sortFor(g));
    games[g.key] = { top, today: todays[0] ?? null };
  }
  return { live, games };
}

export function localBoard(): Board {
  return assemble(localScores().map((r) => ({ ...r, mine: true })), false);
}

async function rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  if (!URL_BASE || !ANON) throw new Error("no backend");
  const ctl = new AbortController();
  const t = window.setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", apikey: ANON, authorization: `Bearer ${ANON}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${fn} ${r.status}`);
    return (await r.json()) as T;
  } finally {
    window.clearTimeout(t);
  }
}

interface RemoteRow { game: string; initials: string; score: number; created_at: string }

/** The whole wall in one request; falls back to this device's board. */
export async function fetchBoard(): Promise<Board> {
  try {
    const rows = await rpc<RemoteRow[]>("arcade_board", {});
    if (!Array.isArray(rows)) throw new Error("bad board");
    const remote = rows.map((r) => ({ game: r.game, initials: r.initials, score: r.score, at: Date.parse(r.created_at) || 0 }));
    // Anything this device signed that the server has not got (signed while
    // offline) still shows, marked as ours.
    const have = new Set(remote.map((r) => `${r.game}|${r.initials}|${r.score}`));
    const pending = localScores().filter((r) => !have.has(`${r.game}|${r.initials}|${r.score}`)).map((r) => ({ ...r, mine: true }));
    return assemble([...remote, ...pending], true);
  } catch {
    return localBoard();
  }
}

/** Where a score would land on the wall, 1-based, or null if it does not make the top ten. */
export function rankOf(board: Board, game: string, score: number): number | null {
  const g = arcadeGame(game);
  const b = board.games[game];
  if (!g || !b) return null;
  // Ties go below whoever got there first.
  const rank = 1 + b.top.filter((r) => !beats(g, score, r.score)).length;
  return rank <= TOP ? rank : null;
}

/** Is it today's best for this game? */
export function isTodaysBest(board: Board, game: string, score: number): boolean {
  const g = arcadeGame(game);
  const t = board.games[game]?.today;
  return !!g && (!t || beats(g, score, t.score));
}

/** Sign the wall. Always kept on this device; sent to the server when it can be. */
export async function submitScore(game: string, initialsRaw: string, score: number): Promise<{ ok: boolean; live: boolean }> {
  const initials = cleanInitials(initialsRaw);
  const g = arcadeGame(game);
  if (!initials || !g || score < 0 || score > g.max) return { ok: false, live: false };
  try {
    localStorage.setItem(LAST_INITIALS, initials);
    const mine = localScores();
    mine.push({ game, initials, score: Math.round(score), at: Date.now() });
    // Keep the best few per game, which is all the wall can show anyway.
    const trimmed = ARCADE_GAMES.flatMap((x) => mine.filter((r) => r.game === x.key).sort((a, b) => (x.order === "desc" ? b.score - a.score : a.score - b.score)).slice(0, TOP));
    localStorage.setItem(LOCAL, JSON.stringify(trimmed));
  } catch {
    /* private mode */
  }
  try {
    await rpc<unknown>("arcade_submit_score", { p_game: game, p_initials: initials, p_score: Math.round(score) });
    return { ok: true, live: true };
  } catch {
    return { ok: true, live: false };
  }
}
