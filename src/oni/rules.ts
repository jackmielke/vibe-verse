/**
 * Oni: infection tag, the rules.
 *
 * Tag is *oni-gokko* in Japan, "playing demon". One player starts the round
 * as the oni, wearing horns. Anybody an oni touches grows horns too and joins
 * the hunt. The last person without horns wins; if the minute runs out
 * first, everybody still without them wins together.
 *
 * Everything here is pure so it can be tested and so that every device in
 * the room, fed the same messages, reaches the same answer. There is no host:
 *
 *  - A round is a start time and the ids of the first oni. Whoever sorts
 *    first among the players (the "referee") announces the next one, and if
 *    two are ever announced the later start wins everywhere.
 *  - A tag is decided by either side of it, the runner or the oni, from
 *    what that device sees. Tags only ever get added and the earliest time
 *    for a victim wins, so the order messages arrive in does not matter.
 *  - A player's own presence also says whether they are oni, so a lost tag
 *    message heals itself on the next presence packet.
 */

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Chasing time. The round is also over the moment nobody is left to catch. */
export const ROUND_MS = 60_000;
/** Between the announcement and the chase: everybody is placed, the oni waits. */
export const COUNTDOWN_MS = 5_000;
/** Results on screen before the next round is announced. */
export const INTERMISSION_MS = 12_000;
/** The first round of a fresh room waits this long for people to arrive. */
export const LOBBY_MS = 15_000;
/** A player is gone after this long without a presence packet. */
export const PEER_TIMEOUT_MS = 7_000;

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export const RUN_SPEED = 6.2;
/** Oni are a touch faster, so a round of one oni and twenty runners ends. */
export const ONI_SPEED = 6.9;
export const JUMP_SPEED = 6.4;
export const GRAVITY = 18;
/** Centre to centre. Generous: at four packets a second everybody is a little behind. */
export const TAG_RADIUS = 1.45;
/** The oni's own check uses a smaller one, since it sees runners later than they see themselves. */
export const TAG_RADIUS_ONI = 1.2;
/** Freshly tagged players can't tag anybody for a moment, so a pile-up reads. */
export const TAG_GRACE_MS = 1_200;
export const PLAYER_RADIUS = 0.45;

// ---------------------------------------------------------------------------
// The square
// ---------------------------------------------------------------------------

export const ARENA_R = 24;

export interface Obstacle { x: number; z: number; r: number; kind: string }

/**
 * A summer festival square. The yagura (the drum tower Bon dancers circle)
 * in the middle is the thing to run round; trees, stone lanterns and stalls
 * are the things to dodge behind.
 */
export const OBSTACLES: Obstacle[] = (() => {
  const out: Obstacle[] = [{ x: 0, z: 0, r: 2.9, kind: "yagura" }];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    out.push({ x: Math.cos(a) * 10.5, z: Math.sin(a) * 10.5, r: 0.7, kind: "sakura" });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6;
    out.push({ x: Math.cos(a) * 16, z: Math.sin(a) * 16, r: 0.55, kind: "lantern" });
  }
  const stalls = [Math.PI * 0.9, Math.PI * 1.25, Math.PI * 1.75, Math.PI * 0.1];
  for (const a of stalls) out.push({ x: Math.cos(a) * 19.5, z: Math.sin(a) * 19.5, r: 1.6, kind: "stall" });
  out.push({ x: 7, z: -5, r: 1.0, kind: "well" });
  out.push({ x: -2.3, z: 21, r: 0.35, kind: "torii" }, { x: 2.3, z: 21, r: 0.35, kind: "torii" });
  return out;
})();

/** Push a point out of every obstacle and back inside the square. */
export function solve(x: number, z: number, r = PLAYER_RADIUS): { x: number; z: number } {
  for (let pass = 0; pass < 2; pass++) {
    for (const o of OBSTACLES) {
      const dx = x - o.x, dz = z - o.z;
      const min = o.r + r;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min) {
        const d = Math.sqrt(d2) || 1e-4;
        x = o.x + (dx / d) * min;
        z = o.z + (dz / d) * min;
      }
    }
    const d = Math.hypot(x, z);
    const max = ARENA_R - r;
    if (d > max) { x = (x / d) * max; z = (z / d) * max; }
  }
  return { x, z };
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

export interface Round {
  id: string;
  /** Epoch ms the chase begins. The countdown runs up to it. */
  start: number;
  /** Epoch ms the clock runs out. */
  end: number;
  /** The first oni. */
  first: string[];
}

export interface Tag {
  victim: string;
  by: string;
  at: number;
}

export type Phase = "lobby" | "countdown" | "play" | "over";

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** How many start as oni. Enough that a big room does not spend a minute on one chaser. */
export function firstOniCount(players: number): number {
  if (players < 2) return 0;
  if (players < 8) return 1;
  if (players < 16) return 2;
  return 3;
}

export function makeRound(now: number, players: string[], rand: () => number = Math.random): Round {
  const pool = [...players];
  const first: string[] = [];
  const n = firstOniCount(pool.length);
  for (let i = 0; i < n; i++) first.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  const start = now + COUNTDOWN_MS;
  return { id: `${start.toString(36)}-${Math.floor(rand() * 1e6).toString(36)}`, start, end: start + ROUND_MS, first };
}

/** Which of two announced rounds everybody should play: the later one, ties by id. */
export function laterRound(a: Round | null, b: Round): Round {
  if (!a) return b;
  if (b.start !== a.start) return b.start > a.start ? b : a;
  return b.id > a.id ? b : a;
}

export function isRound(v: unknown): v is Round {
  if (!v || typeof v !== "object") return false;
  const r = v as Round;
  return typeof r.id === "string" && Number.isFinite(r.start) && Number.isFinite(r.end) && Array.isArray(r.first) && r.first.every((f) => typeof f === "string") && r.end > r.start && r.end - r.start <= ROUND_MS * 2;
}

/** Add a tag. Idempotent; the earliest time for a victim wins. Returns whether anything changed. */
export function addTag(tags: Map<string, Tag>, t: Tag, round: Round): boolean {
  if (round.first.includes(t.victim)) return false;
  if (t.at > round.end + 2_000) return false;
  const at = Math.max(t.at, round.start);
  const had = tags.get(t.victim);
  if (had && had.at <= at) return false;
  tags.set(t.victim, { victim: t.victim, by: t.by, at });
  return true;
}

export function isOni(id: string, round: Round | null, tags: Map<string, Tag>): boolean {
  if (!round) return false;
  return round.first.includes(id) || tags.has(id);
}

/** When the round finished: the clock, or the moment the last runner still here was caught. */
export function roundEndsAt(round: Round, tags: Map<string, Tag>, players: string[]): number {
  if (players.length < 2) return round.end;
  let last = 0;
  for (const p of players) {
    if (round.first.includes(p)) continue;
    const t = tags.get(p);
    if (!t) return round.end;
    last = Math.max(last, t.at);
  }
  // Nobody to catch in the first place (everybody left but the oni).
  if (last === 0) return round.end;
  return Math.min(round.end, last);
}

export function phaseOf(now: number, round: Round | null, tags: Map<string, Tag>, players: string[]): Phase {
  if (!round) return "lobby";
  if (now < round.start) return "countdown";
  if (now < roundEndsAt(round, tags, players)) return "play";
  return "over";
}

export interface Result {
  /** Everybody caught: the last one standing. */
  lastStanding: { id: string; survived: number } | null;
  /** The clock ran out: everybody still free. */
  survivors: string[];
  /** Who caught the most. */
  topOni: { id: string; count: number } | null;
  caught: number;
}

export function resultOf(round: Round, tags: Map<string, Tag>, players: string[]): Result {
  const endAt = roundEndsAt(round, tags, players);
  const runners = players.filter((p) => !round.first.includes(p));
  const survivors = runners.filter((p) => !tags.has(p) || tags.get(p)!.at > endAt);
  let lastStanding: Result["lastStanding"] = null;
  if (!survivors.length && runners.length) {
    let best: Tag | null = null;
    for (const p of runners) { const t = tags.get(p); if (t && (!best || t.at > best.at)) best = t; }
    if (best) lastStanding = { id: best.victim, survived: best.at - round.start };
  }
  const counts = new Map<string, number>();
  for (const t of tags.values()) if (t.by && t.by !== "?") counts.set(t.by, (counts.get(t.by) ?? 0) + 1);
  let topOni: Result["topOni"] = null;
  for (const [id, count] of counts) if (!topOni || count > topOni.count || (count === topOni.count && id < topOni.id)) topOni = { id, count };
  return { lastStanding, survivors, topOni, caught: [...tags.values()].filter((t) => t.at <= endAt).length };
}

/** The player who announces rounds: the lowest id. Everybody agrees without talking. */
export function referee(players: string[]): string | null {
  if (!players.length) return null;
  return [...players].sort()[0];
}

/**
 * Should the referee announce a round now? After the lobby wait when a room
 * first has two players, and after the intermission when a round is over.
 */
export function shouldAnnounce(now: number, round: Round | null, endedAt: number | null, readySince: number | null, players: number): boolean {
  if (players < 2 || readySince === null) return false;
  if (!round) return now - readySince >= LOBBY_MS;
  if (endedAt === null) return false;
  return now - endedAt >= INTERMISSION_MS && now - readySince >= INTERMISSION_MS;
}

/** Where a player stands when a round is announced: oni by the tower, runners out round the edge. */
export function spawnFor(id: string, round: Round): { x: number; z: number; yaw: number } {
  const h = hash(id + round.id);
  const oni = round.first.includes(id);
  const a = (h % 3600) / 3600 * Math.PI * 2;
  const r = oni ? 4.2 : 14 + ((h >>> 12) % 50) / 10;
  const p = solve(Math.cos(a) * r, Math.sin(a) * r);
  // Face the middle (runners) or outward (oni), which is where the action is.
  const yaw = Math.atan2(-p.x, -p.z) + (oni ? Math.PI : 0);
  return { x: p.x, z: p.z, yaw };
}

/**
 * How often to send presence so the whole room stays under a safe message
 * rate: about seventy packets a second across everybody, between three and
 * ten per player.
 */
export function presenceHz(players: number): number {
  return Math.max(3, Math.min(10, 72 / Math.max(1, players)));
}
