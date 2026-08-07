/**
 * Staked rounds and invite links — the browser side of the event.
 *
 * A round is a pot: everyone stakes the same amount, everyone plays the *same*
 * seeded run of ORBIT, and the top score takes the lot. That shape was chosen
 * over one-on-one duels for a party of ten because it needs no matchmaking, no
 * lobby and no presence — latecomers just join, and the leaderboard is the
 * whole social object.
 *
 * The one rule worth knowing when reading this: **the seed is not yours until
 * you have paid.** `vibe_rounds` has no RLS read policy at all, and the server
 * only returns the seed once you are in the round. Otherwise you could practise
 * the exact layout before deciding whether to bet on it, which is the one
 * cheat that would make the whole thing pointless.
 */
import { supabase } from "@/integrations/supabase/client";
import { currentOwner, refreshVibecoin } from "@/lib/vibecoin";

export interface RoundSummary {
  id: string;
  game: string;
  title: string;
  stake: number;
  status: "open" | "settled" | "void";
  opensAt: string;
  closesAt: string;
  winnerRef: string | null;
  payout: number | null;
  /** Null until you have entered. See the header. */
  seed: string | null;
  pot: number;
  entries: number;
}

export interface BoardRow {
  owner_ref: string;
  display_name: string | null;
  best_score: number;
  plays: number;
}

export interface RoundView {
  round: RoundSummary | null;
  leaderboard: BoardRow[];
  you: { bestScore: number; plays: number } | null;
}

/**
 * Rounds and invites live in their own edge function rather than in
 * `vibe-economy`. That file is a thousand lines of agent shops, arcade cabinets
 * and wardrobe; every deploy re-uploads all of it, and the pot shares nothing
 * with Jerry's haiku stand but a table name.
 */
async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vibe-rounds", {
    body: { action, ...payload },
  });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? "vibe-economy error");
  return data.data as T;
}

/** The open round, its board, and where you stand in it. */
export async function fetchRound(): Promise<RoundView> {
  const owner = await currentOwner();
  return call<RoundView>("round_current", { ownerRef: owner.ref });
}

/**
 * Stake in. Throws — "you could not afford the buy-in" is the one failure the
 * player has to be told about in words.
 *
 * Idempotent server-side: a double-tapped button re-enters and hands the seed
 * back rather than taking a second stake.
 */
export async function enterRound(
  displayName: string,
): Promise<{ round: RoundSummary; alreadyIn: boolean }> {
  const owner = await currentOwner();
  const r = await call<{ round: RoundSummary; alreadyIn: boolean }>("round_enter", {
    ownerKind: owner.kind,
    ownerRef: owner.ref,
    displayName,
  });
  void refreshVibecoin();
  return r;
}

/**
 * Report a finished run.
 *
 * `durationMs` is not decoration: the server floors the accepted score at what
 * was physically reachable in that much time, so a client that posts a large
 * number has to have sat there for it. Scores are still self-reported — this is
 * a party game, not an exchange — and that is stated plainly on the page.
 */
export async function submitScore(
  roundId: string,
  score: number,
  durationMs: number,
): Promise<{ accepted: number; best: number; clamped: boolean } | null> {
  try {
    const owner = await currentOwner();
    return await call<{ accepted: number; best: number; clamped: boolean }>("round_score", {
      ownerRef: owner.ref,
      roundId,
      score,
      durationMs,
    });
  } catch {
    // A dropped score is a bad moment but not a broken game — the run still
    // happened, and the next one can be submitted.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export interface InvitePeek {
  valid: boolean;
  grant?: number;
  remaining?: number;
  note?: string | null;
  expired?: boolean;
}

/** What a link is worth, readable before anyone signs in. */
export async function peekInvite(code: string): Promise<InvitePeek> {
  try {
    return await call<InvitePeek>("invite_peek", { code });
  } catch {
    return { valid: false };
  }
}

export async function claimInvite(
  code: string,
): Promise<{ granted: number; balance: number; remaining: number }> {
  const owner = await currentOwner();
  const r = await call<{ granted: number; balance: number; remaining: number }>("invite_claim", {
    ownerKind: owner.kind,
    ownerRef: owner.ref,
    code,
  });
  void refreshVibecoin();
  return r;
}

/** Locally remember which codes this browser already used, to skip a round trip. */
const CLAIMED_KEY = "vibe.invites.claimed.v1";

export function markClaimed(code: string): void {
  try {
    const all = new Set<string>(JSON.parse(localStorage.getItem(CLAIMED_KEY) ?? "[]"));
    all.add(code.toUpperCase());
    localStorage.setItem(CLAIMED_KEY, JSON.stringify([...all]));
  } catch {
    /* storage off */
  }
}

export function hasClaimedLocally(code: string): boolean {
  try {
    const all: string[] = JSON.parse(localStorage.getItem(CLAIMED_KEY) ?? "[]");
    return all.includes(code.toUpperCase());
  } catch {
    return false;
  }
}

/** `2m 14s`, or `closed`. */
export function countdown(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "closed";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  if (d >= 1) return `${d}d ${Math.floor((s % 86400) / 3600)}h`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h}h ${Math.floor((s % 3600) / 60)}m`;
  const m = Math.floor(s / 60);
  return m >= 1 ? `${m}m ${s % 60}s` : `${s}s`;
}
