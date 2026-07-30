/**
 * Vibe Golf — progression.
 *
 * Owns everything that outlives a single run: scorecards, stars, course
 * unlocks, the power-up bag you carry between sessions, best-round ghosts,
 * and the (optional) Supabase leaderboard.
 *
 * Two rules shape this file.
 *
 *  1. **Local is the truth.** Every byte of progress lives in `localStorage`
 *     under one key, written behind a dirty flag so a round costs a handful of
 *     writes rather than one per frame. Safari private mode throws on both
 *     `getItem` and `setItem`, so every single call is wrapped — a browser
 *     that refuses storage still plays, it just forgets.
 *
 *  2. **The network is a garnish.** `public.golf_scores` almost certainly does
 *     not exist in your project yet (see the migration shipped alongside this
 *     file). Every remote path is dynamically imported, timeout-raced and
 *     swallowed: a 404, a 401, an RLS rejection or a dead connection all land
 *     in the same place — leaderboards fall back to your own local bests and
 *     nobody sees an error. Submissions that fail are queued and retried on
 *     the next boot, capped so the queue can never grow unbounded.
 *
 * Publishes `ProgressionService` on `ctx.services.progression` (attached
 * structurally — `GolfServices` is owned by types.ts and not ours to edit).
 * Emits `golf:stars`, `golf:unlock`, `golf:leaderboard`, `golf:progression`.
 * Consumes `golf:hole`, `golf:shot`, `golf:aim`, `golf:holed`, `golf:pickup`,
 * `golf:courseComplete`, `golf:requestLeaderboard`, `golf:setPlayerName`.
 */
import type {
  BallType,
  Course,
  GolfCtx,
  Hole,
  System,
  SystemFactory,
  Vec2,
} from "../types";

// ---------------------------------------------------------------------------
// Storage shape
// ---------------------------------------------------------------------------

const STORE_KEY = "vibe.golf.progress.v1";
/** Shared with use-vibe-identity.tsx — same layout, so names round-trip. */
const LS_GUEST_NAME = "vibe.guestName";
const LS_NAME_BY_WORLD = "vibe.nameByWorld";
const WORLD_KEY = "golf";

/** Leaderboard table. Keep in sync with the migration. */
const TABLE = "golf_scores";
/** Any network call that hasn't answered in this long is treated as absent. */
const NET_TIMEOUT_MS = 6000;
/** Remote rows are re-used for this long before we ask again. */
const LEADERBOARD_TTL_MS = 60_000;
/** Failed submissions kept for a later retry. Oldest are dropped first. */
const MAX_PENDING = 8;
/** A ghost longer than this is a player messing about, not a best round. */
const MAX_GHOST_SHOTS = 32;
/** Seconds between background flushes of a dirtied save. */
const FLUSH_INTERVAL = 1.5;

/** Star curve. Under par is the only way to three. */
const STAR_UNDER = 3;
const STAR_PAR = 2;
const STAR_OVER = 1;

/** Ghost shots are stored flat: 5 numbers each, all integers. */
const GHOST_STRIDE = 5;

const BALL_ORDER: BallType[] = [
  "standard", "sticky", "ice", "nitro", "super", "multi", "ghost", "heavy",
];

export interface HoleRecord {
  /** Best strokes ever taken on this hole. */
  best: number;
  /** Stars earned by that best round, 1..3. */
  stars: number;
  /** Par at the time — kept so a re-tuned course can be re-scored. */
  par: number;
  /** Times this hole has been completed. */
  plays: number;
}

export interface CourseRecord {
  /** Best complete-round total. 0 = never finished the course. */
  bestTotal: number;
  /** Par of that best round, for a to-par readout. */
  par: number;
  /** Times the course has been finished end to end. */
  completions: number;
}

/** A recorded round, compact enough to sit in localStorage and in a row. */
export interface GhostRound {
  holeId: string;
  strokes: number;
  /** Flat [x, y, angle, power, ballIndex] × N, quantised to integers. */
  shots: number[];
}

/** A ghost as a consumer wants it — decoded, world units, ready to replay. */
export interface GhostShot {
  from: Vec2;
  dir: Vec2;
  power: number;
  ball: BallType;
}

export interface LeaderboardRow {
  name: string;
  strokes: number;
  par: number;
  /** True for the row belonging to this device. */
  you?: boolean;
  at?: string;
}

interface PendingRound {
  courseId: string;
  courseName: string;
  strokes: number;
  par: number;
  holes: number;
  stars: number;
  at: number;
  ghost?: GhostRound | null;
}

interface SaveData {
  v: 1;
  /** Stable per-device id so a leaderboard can mark "you" without an account. */
  clientId: string;
  /** Name typed into the game when no vibeverse identity is available. */
  name: string;
  holes: Record<string, HoleRecord>;
  courses: Record<string, CourseRecord>;
  /** Courses whose star threshold has been announced, so we only cheer once. */
  unlocked: string[];
  /** Power-up bag carried between sessions. */
  inventory: Partial<Record<BallType, number>>;
  /** Best-round ghost per hole id. */
  ghosts: Record<string, GhostRound>;
  pending: PendingRound[];
  /** Total strokes struck ever — a cheap "hours played" proxy for the HUD. */
  lifetimeStrokes: number;
}

export interface ProgressionService {
  /** Sum of every hole's best stars. The unlock currency. */
  stars: number;
  /** Per-hole bests, keyed by `Hole.id`. */
  holes: Record<string, HoleRecord>;
  /** Per-course bests, keyed by `Course.id`. */
  courses: Record<string, CourseRecord>;
  /** Display name used on the leaderboard. */
  playerName: string;
  setPlayerName(name: string): void;
  /** True when the course's `unlockAt` threshold has been met. */
  isUnlocked(courseId: string): boolean;
  /** Stars still needed for a course, 0 when already open. */
  starsToUnlock(courseId: string): number;
  /** Best stroke count for a hole, or 0 if never holed. */
  bestFor(holeId: string): number;
  /** Decoded best-round ghost for a hole, ready to replay. */
  ghostFor(holeId: string): GhostShot[] | null;
  /** Fetch (remote, falling back to local) and emit `golf:leaderboard`. */
  leaderboard(courseId: string, limit?: number): Promise<LeaderboardRow[]>;
  /** Push the current save to disk immediately. */
  save(): void;
  /** Wipe everything. Used by the HUD's "reset progress". */
  reset(): void;
  /** Snapshot for the HUD; the same payload `golf:progression` carries. */
  snapshot(): ProgressionSnapshot;
}

export interface ProgressionSnapshot {
  stars: number;
  maxStars: number;
  playerName: string;
  lifetimeStrokes: number;
  courses: Array<{
    id: string;
    name: string;
    unlockAt: number;
    unlocked: boolean;
    starsToUnlock: number;
    stars: number;
    maxStars: number;
    bestTotal: number;
    par: number;
    holesDone: number;
    holeCount: number;
  }>;
}

// ---------------------------------------------------------------------------
// Storage helpers — every one of these is allowed to fail silently
// ---------------------------------------------------------------------------

function lsGet(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* private mode, quota, disabled storage — play on regardless */
  }
}

function lsRemove(key: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function makeClientId(rng: () => number): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += Math.floor(rng() * 0x10000).toString(16).padStart(4, "0");
  return s;
}

function emptySave(rng: () => number): SaveData {
  return {
    v: 1,
    clientId: makeClientId(rng),
    name: "",
    holes: {},
    courses: {},
    unlocked: [],
    inventory: {},
    ghosts: {},
    pending: [],
    lifetimeStrokes: 0,
  };
}

/**
 * Read + repair. Anything that isn't the shape we expect is replaced rather
 * than trusted: a half-written save from an older build must never be able to
 * throw inside a hot path later.
 */
function loadSave(rng: () => number): SaveData {
  const base = emptySave(rng);
  const raw = lsGet(STORE_KEY);
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Partial<SaveData> | null;
    if (!parsed || typeof parsed !== "object") return base;

    const holes: Record<string, HoleRecord> = {};
    for (const [id, rec] of Object.entries(parsed.holes ?? {})) {
      const r = rec as Partial<HoleRecord>;
      if (!r || typeof r.best !== "number" || !(r.best > 0)) continue;
      holes[id] = {
        best: Math.round(r.best),
        stars: Math.max(0, Math.min(3, Math.round(r.stars ?? 0))),
        par: Math.round(r.par ?? 3),
        plays: Math.max(0, Math.round(r.plays ?? 1)),
      };
    }

    const courses: Record<string, CourseRecord> = {};
    for (const [id, rec] of Object.entries(parsed.courses ?? {})) {
      const r = rec as Partial<CourseRecord>;
      if (!r) continue;
      courses[id] = {
        bestTotal: Math.max(0, Math.round(r.bestTotal ?? 0)),
        par: Math.max(0, Math.round(r.par ?? 0)),
        completions: Math.max(0, Math.round(r.completions ?? 0)),
      };
    }

    const inventory: Partial<Record<BallType, number>> = {};
    for (const t of BALL_ORDER) {
      const n = (parsed.inventory as Record<string, unknown> | undefined)?.[t];
      if (typeof n === "number" && n >= 0) inventory[t] = Math.min(9, Math.round(n));
    }

    const ghosts: Record<string, GhostRound> = {};
    for (const [id, g] of Object.entries(parsed.ghosts ?? {})) {
      const gr = g as Partial<GhostRound>;
      if (!gr || !Array.isArray(gr.shots) || gr.shots.length % GHOST_STRIDE !== 0) continue;
      ghosts[id] = {
        holeId: id,
        strokes: Math.max(1, Math.round(gr.strokes ?? gr.shots.length / GHOST_STRIDE)),
        shots: gr.shots.slice(0, MAX_GHOST_SHOTS * GHOST_STRIDE).map((n) => Math.round(Number(n) || 0)),
      };
    }

    return {
      v: 1,
      clientId: typeof parsed.clientId === "string" && parsed.clientId ? parsed.clientId : base.clientId,
      name: typeof parsed.name === "string" ? parsed.name.slice(0, 24) : "",
      holes,
      courses,
      unlocked: Array.isArray(parsed.unlocked) ? parsed.unlocked.filter((s) => typeof s === "string") : [],
      inventory,
      ghosts,
      pending: Array.isArray(parsed.pending)
        ? (parsed.pending as PendingRound[]).filter((p) => p && typeof p.courseId === "string").slice(-MAX_PENDING)
        : [],
      lifetimeStrokes: Math.max(0, Math.round(parsed.lifetimeStrokes ?? 0)),
    };
  } catch {
    return base;
  }
}

// ---------------------------------------------------------------------------
// Supabase — structurally typed, lazily imported, never load-bearing
// ---------------------------------------------------------------------------

/**
 * `golf_scores` is not in the generated `Database` types (the table is new, and
 * regenerating types is a deploy-time job), so the client is narrowed to just
 * the four builder calls used here. This is deliberately structural: if the
 * table is missing the calls still typecheck and simply resolve to an error we
 * swallow.
 */
interface LooseFilter {
  eq(column: string, value: string): LooseFilter;
  order(column: string, opts: { ascending: boolean }): LooseFilter;
  limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
}
interface LooseTable {
  insert(values: Record<string, unknown>): PromiseLike<{ error: unknown }>;
  select(columns: string): LooseFilter;
}
interface LooseDb {
  from(table: string): LooseTable;
  auth: { getSession(): PromiseLike<{ data: { session: { user?: { id?: string } } | null } }> };
}

let dbPromise: Promise<LooseDb | null> | null = null;

/**
 * One lazy import, memoised. Static-importing the client would drag auth into
 * the golf bundle and, worse, `createClient` throws when the env vars are
 * absent — which would take the whole game down at module-eval time.
 */
function getDb(): Promise<LooseDb | null> {
  if (dbPromise) return dbPromise;
  dbPromise = import("@/integrations/supabase/client")
    .then((mod) => (mod?.supabase ? (mod.supabase as unknown as LooseDb) : null))
    .catch(() => null);
  return dbPromise;
}

/** Resolve to `fallback` if the promise hasn't answered in `ms`. */
function withTimeout<T>(p: PromiseLike<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; resolve(fallback); }
    }, ms);
    Promise.resolve(p).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve(fallback); } },
    );
  });
}

// ---------------------------------------------------------------------------

const createProgression: SystemFactory = (ctx: GolfCtx) => {
  const save = loadSave(ctx.rng);
  let dirty = false;
  let flushTimer = 0;

  // --- name resolution ----------------------------------------------------
  // Mirrors use-vibe-identity's storage layout so a player called "Birdie" in
  // the golf world stays "Birdie" here, without this module importing React.
  function resolveName(): string {
    try {
      const byWorld = JSON.parse(lsGet(LS_NAME_BY_WORLD) ?? "{}") as Record<string, string>;
      const world = byWorld?.[WORLD_KEY];
      if (typeof world === "string" && world.trim()) return world.trim().slice(0, 24);
    } catch {
      /* malformed override map — fall through */
    }
    if (save.name.trim()) return save.name.trim().slice(0, 24);
    const guest = lsGet(LS_GUEST_NAME);
    if (guest && guest.trim()) return guest.trim().slice(0, 24);
    return "Guest";
  }

  /** Filled in asynchronously from the auth session; null for guests. */
  let authUserId: string | null = null;

  // --- derived tallies ----------------------------------------------------

  function totalStars(): number {
    let n = 0;
    for (const id in save.holes) n += save.holes[id].stars;
    return n;
  }

  function courseOf(id: string): Course | undefined {
    return ctx.services.course?.courses.find((c) => c.id === id);
  }

  function courseStars(course: Course): number {
    let n = 0;
    for (const h of course.holes) n += save.holes[h.id]?.stars ?? 0;
    return n;
  }

  function courseHolesDone(course: Course): number {
    let n = 0;
    for (const h of course.holes) if (save.holes[h.id]) n++;
    return n;
  }

  function isUnlocked(courseId: string): boolean {
    const c = courseOf(courseId);
    const need = c?.unlockAt ?? 0;
    return need <= 0 || totalStars() >= need;
  }

  function starsFor(strokes: number, par: number): number {
    if (strokes < par) return STAR_UNDER;
    if (strokes === par) return STAR_PAR;
    return STAR_OVER;
  }

  function markDirty(): void {
    dirty = true;
  }

  function flush(): void {
    if (!dirty) return;
    dirty = false;
    lsSet(STORE_KEY, JSON.stringify(save));
  }

  // --- unlock announcements ----------------------------------------------

  /**
   * Emit `golf:unlock` for any course whose threshold has just been crossed.
   * `save.unlocked` is the "already cheered" set, so re-opening the game never
   * replays a fanfare the player has seen.
   */
  function checkUnlocks(announce: boolean): void {
    const courses = ctx.services.course?.courses ?? [];
    const stars = totalStars();
    for (const c of courses) {
      const need = c.unlockAt ?? 0;
      const open = need <= 0 || stars >= need;
      if (!open || save.unlocked.includes(c.id)) continue;
      save.unlocked.push(c.id);
      markDirty();
      if (announce) {
        ctx.services.audio?.play("unlock", { volume: 0.7 });
        ctx.emit("golf:unlock", {
          courseId: c.id,
          name: c.name,
          theme: c.theme,
          blurb: c.blurb,
          unlockAt: need,
          totalStars: stars,
        });
      }
    }
  }

  // --- snapshot -----------------------------------------------------------

  function snapshot(): ProgressionSnapshot {
    const courses = ctx.services.course?.courses ?? [];
    const stars = totalStars();
    return {
      stars,
      maxStars: courses.reduce((n, c) => n + c.holes.length * STAR_UNDER, 0),
      playerName: resolveName(),
      lifetimeStrokes: save.lifetimeStrokes,
      courses: courses.map((c) => {
        const rec = save.courses[c.id];
        const need = c.unlockAt ?? 0;
        return {
          id: c.id,
          name: c.name,
          unlockAt: need,
          unlocked: need <= 0 || stars >= need,
          starsToUnlock: Math.max(0, need - stars),
          stars: courseStars(c),
          maxStars: c.holes.length * STAR_UNDER,
          bestTotal: rec?.bestTotal ?? 0,
          par: rec?.par ?? c.holes.reduce((n, h) => n + h.par, 0),
          holesDone: courseHolesDone(c),
          holeCount: c.holes.length,
        };
      }),
    };
  }

  function publishSnapshot(): void {
    ctx.emit("golf:progression", snapshot());
  }

  // --- ghost recording ----------------------------------------------------
  // The aim system publishes `from`/`dir` at frame rate while dragging but
  // `golf:shot` carries only power and type, so we keep the last aim sample
  // and marry the two on the frame the shot fires.

  let lastAim: { from?: Vec2; dir?: Vec2 } = {};
  let liveShots: number[] = [];

  function recordShot(power: number, type: BallType): void {
    if (liveShots.length >= MAX_GHOST_SHOTS * GHOST_STRIDE) return;
    const from = lastAim.from;
    const dir = lastAim.dir ?? { x: 1, y: 0 };
    if (!from) return;
    // Quantise hard: centimetres, milliradians, per-mille power. A nine-hole
    // ghost lands around 1 KB of JSON.
    liveShots.push(
      Math.round(from.x * 100),
      Math.round(from.y * 100),
      Math.round(Math.atan2(dir.y, dir.x) * 1000),
      Math.round(Math.max(0, Math.min(1, power)) * 1000),
      Math.max(0, BALL_ORDER.indexOf(type)),
    );
  }

  function decodeGhost(g: GhostRound | undefined): GhostShot[] | null {
    if (!g || !g.shots.length) return null;
    const out: GhostShot[] = [];
    for (let i = 0; i + GHOST_STRIDE <= g.shots.length; i += GHOST_STRIDE) {
      const ang = g.shots[i + 2] / 1000;
      out.push({
        from: { x: g.shots[i] / 100, y: g.shots[i + 1] / 100 },
        dir: { x: Math.cos(ang), y: Math.sin(ang) },
        power: g.shots[i + 3] / 1000,
        ball: BALL_ORDER[g.shots[i + 4]] ?? "standard",
      });
    }
    return out;
  }

  // --- round accumulation -------------------------------------------------

  let round: { courseId: string; courseName: string; strokes: number; par: number; holes: number; stars: number } | null = null;
  let currentHole: Hole | null = null;
  /** Ghosts for the round in progress, so a course PB can carry its replay. */
  let roundGhosts: GhostRound[] = [];

  // --- leaderboard --------------------------------------------------------

  const lbCache = new Map<string, { at: number; rows: LeaderboardRow[]; source: string }>();

  /** Our own best round for a course, shaped like a leaderboard row. */
  function localRow(courseId: string): LeaderboardRow | null {
    const rec = save.courses[courseId];
    if (!rec || !rec.bestTotal) return null;
    return { name: resolveName(), strokes: rec.bestTotal, par: rec.par, you: true };
  }

  async function leaderboard(courseId: string, limit = 10): Promise<LeaderboardRow[]> {
    const cached = lbCache.get(courseId);
    const now = Date.now();
    if (cached && now - cached.at < LEADERBOARD_TTL_MS) {
      ctx.emit("golf:leaderboard", { courseId, rows: cached.rows, source: cached.source, cached: true });
      return cached.rows;
    }

    const mine = localRow(courseId);
    const fallback: LeaderboardRow[] = mine ? [mine] : [];

    const db = await getDb();
    let rows: LeaderboardRow[] = fallback;
    let source = mine ? "local" : "empty";

    if (db) {
      const res = await withTimeout<{ data: unknown[] | null; error: unknown }>(
        db.from(TABLE)
          .select("player_name,strokes,par,client_id,created_at")
          .eq("course_id", courseId)
          .order("strokes", { ascending: true })
          .order("created_at", { ascending: true })
          .limit(Math.max(1, Math.min(50, limit * 3))),
        NET_TIMEOUT_MS,
        { data: null, error: "timeout" },
      ).catch(() => ({ data: null, error: "threw" }));

      if (!res.error && Array.isArray(res.data)) {
        // One row per player: the table keeps every submission, the board only
        // ever shows a player's best.
        const seen = new Set<string>();
        const remote: LeaderboardRow[] = [];
        for (const raw of res.data) {
          const r = raw as Record<string, unknown>;
          const name = typeof r.player_name === "string" && r.player_name.trim() ? r.player_name.trim() : "Guest";
          const strokes = Number(r.strokes);
          if (!Number.isFinite(strokes) || strokes <= 0) continue;
          const key = `${name.toLowerCase()}|${String(r.client_id ?? "")}`;
          if (seen.has(key)) continue;
          seen.add(key);
          remote.push({
            name,
            strokes: Math.round(strokes),
            par: Math.round(Number(r.par) || 0),
            you: r.client_id === save.clientId,
            at: typeof r.created_at === "string" ? r.created_at : undefined,
          });
          if (remote.length >= limit) break;
        }
        if (remote.length) {
          rows = remote;
          source = "remote";
          // Make sure the player can always see themselves even when they are
          // nowhere near the top — a board you're absent from reads as broken.
          if (mine && !remote.some((r) => r.you)) rows = remote.concat([{ ...mine }]);
        }
      }
    }

    lbCache.set(courseId, { at: now, rows, source });
    ctx.emit("golf:leaderboard", { courseId, rows, source, cached: false });
    return rows;
  }

  // --- submission ---------------------------------------------------------

  function queue(entry: PendingRound): void {
    save.pending.push(entry);
    while (save.pending.length > MAX_PENDING) save.pending.shift();
    markDirty();
  }

  async function submit(entry: PendingRound, requeueOnFail: boolean): Promise<boolean> {
    const db = await getDb();
    if (!db) {
      if (requeueOnFail) queue(entry);
      return false;
    }

    if (authUserId === null) {
      const s = await withTimeout(db.auth.getSession(), NET_TIMEOUT_MS, { data: { session: null } })
        .catch(() => ({ data: { session: null } }));
      authUserId = s?.data?.session?.user?.id ?? "";
    }

    const res = await withTimeout<{ error: unknown }>(
      db.from(TABLE).insert({
        course_id: entry.courseId,
        course_name: entry.courseName.slice(0, 64),
        player_name: resolveName(),
        auth_user_id: authUserId || null,
        client_id: save.clientId,
        strokes: entry.strokes,
        par: entry.par,
        holes: entry.holes,
        stars: entry.stars,
        ghost: entry.ghost ?? null,
      }),
      NET_TIMEOUT_MS,
      { error: "timeout" },
    ).catch(() => ({ error: "threw" }));

    if (res.error) {
      // Missing table, RLS refusal, offline — all identical from here.
      if (requeueOnFail) queue(entry);
      return false;
    }
    lbCache.delete(entry.courseId);
    return true;
  }

  /** Retry anything stranded by a previous session, oldest first. */
  async function flushPending(): Promise<void> {
    if (!save.pending.length) return;
    const batch = save.pending.slice();
    save.pending.length = 0;
    markDirty();
    for (let i = 0; i < batch.length; i++) {
      // eslint-disable-next-line no-await-in-loop -- deliberately serial: this
      // is a background drain, not a latency path, and it keeps the table calm.
      const ok = await submit(batch[i], false);
      if (!ok) {
        // Still offline. Put back everything we haven't managed to send —
        // including the entries we never reached — and stop hammering.
        for (let j = i; j < batch.length; j++) queue(batch[j]);
        break;
      }
    }
    flush();
  }

  // --- service ------------------------------------------------------------

  const service: ProgressionService = {
    get stars() { return totalStars(); },
    holes: save.holes,
    courses: save.courses,
    get playerName() { return resolveName(); },

    setPlayerName(name: string) {
      const clean = (name ?? "").trim().slice(0, 24);
      save.name = clean;
      // Also write the world override so the rest of the vibeverse agrees.
      try {
        const map = JSON.parse(lsGet(LS_NAME_BY_WORLD) ?? "{}") as Record<string, string>;
        if (clean) map[WORLD_KEY] = clean;
        else delete map[WORLD_KEY];
        lsSet(LS_NAME_BY_WORLD, JSON.stringify(map));
      } catch {
        /* ignore a corrupt override map */
      }
      markDirty();
      flush();
      lbCache.clear();
      publishSnapshot();
    },

    isUnlocked,
    starsToUnlock(courseId: string) {
      const need = courseOf(courseId)?.unlockAt ?? 0;
      return Math.max(0, need - totalStars());
    },
    bestFor(holeId: string) {
      return save.holes[holeId]?.best ?? 0;
    },
    ghostFor(holeId: string) {
      return decodeGhost(save.ghosts[holeId]);
    },
    leaderboard,
    save: flush,

    reset() {
      const fresh = emptySave(ctx.rng);
      fresh.clientId = save.clientId;
      fresh.name = save.name;
      Object.assign(save, fresh);
      save.holes = fresh.holes;
      save.courses = fresh.courses;
      service.holes = save.holes;
      service.courses = save.courses;
      lsRemove(STORE_KEY);
      dirty = true;
      flush();
      lbCache.clear();
      ctx.emit("golf:stars", { totalStars: 0, reset: true });
      publishSnapshot();
    },

    snapshot,
  };

  // `GolfServices` lives in types.ts and isn't ours to extend, so attach
  // structurally — consumers import `ProgressionService` from this module.
  (ctx.services as { progression?: ProgressionService }).progression = service;

  // --- restore the ball bag ----------------------------------------------
  // rules.ts seeds a default inventory in its factory and boots before us, so
  // overwriting here is safe and is the only place a carried bag comes from.
  function restoreInventory(): void {
    const rules = ctx.services.rules;
    if (!rules?.inventory) return;
    const saved = save.inventory;
    if (!Object.keys(saved).length) return;
    for (const t of BALL_ORDER) {
      if (t === "standard") continue;
      const n = saved[t];
      if (typeof n === "number") rules.inventory[t] = n;
    }
  }

  function captureInventory(): void {
    const inv = ctx.services.rules?.inventory;
    if (!inv) return;
    for (const t of BALL_ORDER) {
      if (t === "standard") continue;
      save.inventory[t] = Math.max(0, Math.round(inv[t] ?? 0));
    }
    markDirty();
  }

  restoreInventory();

  // --- events -------------------------------------------------------------

  const offs: Array<() => void> = [];

  offs.push(ctx.on("golf:hole", (payload) => {
    const d = payload as { course?: Course; hole?: Hole; holeIndex?: number };
    currentHole = d?.hole ?? null;
    liveShots = [];
    lastAim = {};
    const course = d?.course;
    if (!course) return;
    // A new round starts at the first hole, or whenever the course changes.
    if (!round || round.courseId !== course.id || (d.holeIndex ?? 0) === 0) {
      round = { courseId: course.id, courseName: course.name, strokes: 0, par: 0, holes: 0, stars: 0 };
      roundGhosts = [];
    }
  }));

  offs.push(ctx.on("golf:aim", (payload) => {
    const d = payload as { aiming?: boolean; from?: Vec2; dir?: Vec2 };
    if (d?.aiming && d.from && d.dir) lastAim = { from: { x: d.from.x, y: d.from.y }, dir: { x: d.dir.x, y: d.dir.y } };
  }));

  offs.push(ctx.on("golf:shot", (payload) => {
    const d = payload as { power?: number; type?: BallType };
    recordShot(d?.power ?? 0, d?.type ?? "standard");
    save.lifetimeStrokes++;
    captureInventory();
  }));

  offs.push(ctx.on("golf:pickup", () => captureInventory()));

  offs.push(ctx.on("golf:holed", (payload) => {
    const d = payload as { strokes?: number; par?: number };
    const hole = currentHole ?? ctx.services.course?.current ?? null;
    if (!hole) return;
    const strokes = Math.max(1, Math.round(d?.strokes ?? 0));
    const par = Math.max(1, Math.round(d?.par ?? hole.par));
    const stars = starsFor(strokes, par);

    const prev = save.holes[hole.id];
    const improved = !prev || strokes < prev.best;
    save.holes[hole.id] = {
      best: improved ? strokes : prev.best,
      stars: Math.max(prev?.stars ?? 0, stars),
      par,
      plays: (prev?.plays ?? 0) + 1,
    };

    // Ghost: only a genuine personal best is worth keeping.
    const ghost: GhostRound = { holeId: hole.id, strokes, shots: liveShots.slice() };
    if (improved && ghost.shots.length) save.ghosts[hole.id] = ghost;
    roundGhosts.push(ghost);

    if (round) {
      round.strokes += strokes;
      round.par += par;
      round.holes += 1;
      round.stars += stars;
    }

    captureInventory();
    markDirty();

    const total = totalStars();
    ctx.emit("golf:stars", {
      holeId: hole.id,
      holeName: hole.name,
      strokes,
      par,
      toPar: strokes - par,
      stars,
      best: save.holes[hole.id].best,
      bestStars: save.holes[hole.id].stars,
      improved,
      totalStars: total,
    });

    checkUnlocks(true);
    flush();
    publishSnapshot();
  }));

  offs.push(ctx.on("golf:courseComplete", (payload) => {
    const d = payload as { course?: Course };
    const course = d?.course ?? courseOf(round?.courseId ?? "");
    if (!course || !round) return;

    const rec = save.courses[course.id];
    const best = !rec || !rec.bestTotal || round.strokes < rec.bestTotal;
    save.courses[course.id] = {
      bestTotal: best ? round.strokes : rec.bestTotal,
      par: best ? round.par : rec.par,
      completions: (rec?.completions ?? 0) + 1,
    };
    markDirty();
    flush();

    // Submit fire-and-forget; a failure lands in the pending queue and is
    // retried on the next boot. The player never waits on this.
    const entry: PendingRound = {
      courseId: course.id,
      courseName: course.name,
      strokes: round.strokes,
      par: round.par,
      holes: round.holes,
      stars: round.stars,
      at: Date.now(),
      // Only ship a ghost with a personal best, and only the shot stream.
      ghost: best && roundGhosts.length
        ? { holeId: course.id, strokes: round.strokes, shots: roundGhosts.flatMap((g) => g.shots).slice(0, MAX_GHOST_SHOTS * GHOST_STRIDE * 9) }
        : null,
    };
    void submit(entry, true).then((ok) => {
      if (!ok) flush();
      void leaderboard(course.id);
    });

    round = null;
    roundGhosts = [];
    publishSnapshot();
  }));

  /** HUD hook: `engine.emit("golf:requestLeaderboard", { courseId })`. */
  offs.push(ctx.on("golf:requestLeaderboard", (payload) => {
    const d = payload as { courseId?: string; limit?: number } | string | undefined;
    const id = typeof d === "string" ? d : d?.courseId ?? ctx.services.course?.courses[ctx.services.course.courseIndex]?.id;
    if (!id) return;
    void leaderboard(id, typeof d === "object" ? d?.limit ?? 10 : 10);
  }));

  /** HUD hook: `engine.emit("golf:setPlayerName", "Birdie")`. */
  offs.push(ctx.on("golf:setPlayerName", (payload) => {
    const name = typeof payload === "string" ? payload : (payload as { name?: string })?.name;
    if (typeof name === "string") service.setPlayerName(name);
  }));

  offs.push(ctx.on("golf:resetProgress", () => service.reset()));

  // A backgrounded tab on iOS may never come back; write on the way out.
  const onHide = () => flush();
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onHide);
    window.addEventListener("visibilitychange", onHide);
  }

  // Seed the already-earned unlock set without firing fanfares for progress
  // the player made in a previous session.
  let seeded = false;
  let pendingFlushed = false;

  const sys: System = {
    name: "progression",
    update(dt) {
      if (!seeded && ctx.services.course?.courses.length) {
        seeded = true;
        checkUnlocks(false);
        flush();
        publishSnapshot();
      }
      if (!pendingFlushed && ctx.elapsed > 3) {
        // Give the first hole time to settle before touching the network.
        pendingFlushed = true;
        void flushPending();
      }
      flushTimer += dt;
      if (flushTimer >= FLUSH_INTERVAL) {
        flushTimer = 0;
        flush();
      }
    },
    dispose() {
      flush();
      for (const off of offs) off();
      offs.length = 0;
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onHide);
        window.removeEventListener("visibilitychange", onHide);
      }
      delete (ctx.services as { progression?: ProgressionService }).progression;
    },
  };

  return sys;
};

export default createProgression;
