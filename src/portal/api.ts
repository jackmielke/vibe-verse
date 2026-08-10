/**
 * Talking to `vibe-portal` — the four calls, typed.
 *
 * Same shape as `src/lib/vibecoin.ts`: the browser never moves a balance, it
 * asks a function that holds the service-role key to consider moving one. The
 * difference is who is doing the asking. Here it is, ultimately, somebody
 * else's game — so read `host.ts` next, because the interesting part of this
 * feature is what that game is *not* given.
 */
import { supabase } from "@/integrations/supabase/client";

export interface PortalGame {
  slug: string;
  title: string;
  tagline: string | null;
  author: string | null;
  authorUrl: string | null;
  embedUrl: string;
  /** The one origin allowed to talk to us, or `self` for a game in this repo. */
  origin: string;
  maxAward: number;
  /**
   * Does the game include `vibeverse.js`?
   *
   * Not a permission — a game without it is welcome and playable, it simply
   * never asks for anything, so its budget is never spent. The play page reads
   * this to avoid promising a player coins that are not coming.
   */
  usesSdk?: boolean;
}

export interface PortalGameListing extends PortalGame {
  sessionBudget: number;
  playerDaily: number;
  dailyBudget: number;
  /** What this game has left to give everybody, today. */
  remainingToday: number;
}

export interface PortalSession {
  sessionId: string;
  game: PortalGame;
  /** What this player can still earn here today. Not a promise — a ceiling. */
  headroom: number;
  remainingToday: number;
}

export interface PortalAward {
  amount: number;
  balance: number;
  /** True when the amount paid was less than the amount asked for. */
  capped: boolean;
  headroom: number;
  asked: number;
}

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vibe-portal", {
    body: { action, ...payload },
  });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? "vibe-portal error");
  return data.data as T;
}

export function listPortalGames(): Promise<{ games: PortalGameListing[] }> {
  return call("list");
}

export function openPortalSession(
  slug: string,
  ownerKind: string,
  ownerRef: string,
): Promise<PortalSession> {
  return call("open", { slug, ownerKind, ownerRef });
}

export function awardFromPortal(
  sessionId: string,
  amount: number,
  reason?: string,
): Promise<PortalAward> {
  return call("award", { sessionId, amount, reason });
}

export function closePortalSession(
  sessionId: string,
): Promise<{ awarded: number; awards: number }> {
  return call("close", { sessionId });
}

// ---------------------------------------------------------------------------
// The submission desk — `vibe-portal-submit`, a different function
// ---------------------------------------------------------------------------
//
// Split from `vibe-portal` because they have nothing in common but a table.
// One is called by every player of every game and must stay small and fast;
// the other is called a few times a week, talks to GitHub, and copies files
// around. Putting the slow, chatty half behind the same entry point as the
// award path would mean a bad afternoon at GitHub could make paying a player
// slow, which is exactly backwards.

export type SubmissionStatus = "pending" | "approved" | "rejected" | "failed";

export interface PortalSubmission {
  id: string;
  submitted_url: string;
  kind: "github" | "hosted";
  slug: string | null;
  title: string | null;
  tagline: string | null;
  author: string | null;
  author_url: string | null;
  repo: string | null;
  repo_ref: string | null;
  repo_sha: string | null;
  entry_path: string | null;
  license: string | null;
  file_count: number | null;
  total_bytes: number | null;
  embed_url: string | null;
  origin: string | null;
  uses_sdk: boolean;
  status: SubmissionStatus;
  status_note: string | null;
  max_award: number | null;
  session_budget: number | null;
  player_daily: number | null;
  daily_budget: number | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface SubmitResult {
  submission: PortalSubmission;
  /** The mirrored (or hosted) URL, playable before anybody approves anything. */
  preview?: string;
  failed?: boolean;
  alreadyKnown?: boolean;
  note?: string;
  mirror?: { uploaded: number; bytes: number; failed: { path: string; why: string }[] };
}

/** A row in the admin queue's second list: games already in the arcade. */
export interface PortalGameAdminRow {
  slug: string;
  title: string;
  active: boolean;
  source_kind: "manual" | "hosted" | "github";
  repo: string | null;
  repo_ref: string | null;
  repo_sha: string | null;
  mirrored_at: string | null;
  uses_sdk: boolean;
  max_award: number;
  daily_budget: number;
}

async function callSubmit<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vibe-portal-submit", {
    // `action` last, so a payload can never overwrite the envelope's own key.
    // It is the belt to `decision`'s braces: naming the fields apart is the
    // fix, and this makes the whole class of mistake impossible rather than
    // merely absent today.
    body: { ...payload, action },
  });
  // A non-2xx from an edge function arrives as a FunctionsHttpError whose
  // message is the useless "Edge Function returned a non-2xx status code".
  // The message we actually want — "there is no HTML page in that repository"
  // — is in the body, so it is dug out here rather than in three call sites.
  if (error) {
    const body = await readFunctionError(error);
    throw new Error(body ?? error.message);
  }
  if (!data?.ok) throw new Error(data?.error ?? "vibe-portal-submit error");
  return data.data as T;
}

async function readFunctionError(error: unknown): Promise<string | null> {
  const res = (error as { context?: Response })?.context;
  if (!res || typeof res.json !== "function") return null;
  try {
    const body = await res.json();
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/** Offer a game. One field: a repo link or a deployed link. */
export function submitPortalGame(url: string, label?: string): Promise<SubmitResult> {
  return callSubmit("submit", { url, label });
}

export function myPortalSubmissions(): Promise<{ submissions: PortalSubmission[] }> {
  return callSubmit("mine");
}

export function portalQueue(
  status: SubmissionStatus | "all" = "pending",
): Promise<{ submissions: PortalSubmission[]; games: PortalGameAdminRow[] }> {
  return callSubmit("queue", { status });
}

/**
 * Approve or reject.
 *
 * The verdict travels as `decision`, not as `action`, and that is not a style
 * choice: `callSubmit` puts the envelope's action into the same object, so a
 * payload with its own `action` key silently overwrites it and the function
 * receives `action: "approve"` — an unknown action — instead of `review`. It
 * did exactly that until a browser test clicked the button and nothing
 * happened.
 */
export function reviewPortalSubmission(
  id: string,
  decision: "approve" | "reject",
  extra: {
    note?: string;
    maxAward?: number;
    sessionBudget?: number;
    playerDaily?: number;
    dailyBudget?: number;
  } = {},
): Promise<{ submission: PortalSubmission; route?: string }> {
  return callSubmit("review", { id, decision, ...extra });
}

/** Re-pin a mirrored game to whatever its branch points at now. */
export function resyncPortalGame(slug: string): Promise<{
  changed: boolean;
  from?: string;
  sha: string;
  uploaded?: number;
  usesSdk?: boolean;
  note?: string;
}> {
  return callSubmit("resync", { slug });
}

/**
 * `keepalive` close, for the one moment a promise will not survive.
 *
 * A player closing the tab unmounts nothing and awaits nothing — `pagehide`
 * fires and the page is gone before `functions.invoke` reaches the network. So
 * that path posts the request directly with `keepalive: true`, which is the
 * only way to ask a browser to finish a request after the document is dead.
 *
 * Leaving a session open is not a disaster — it expires in three hours and its
 * budget is already spent — but a session that closes when you close the tab
 * is what somebody reading the sessions table would expect to see, and a table
 * that matches expectations is worth a few lines.
 */
export function closePortalSessionBeacon(sessionId: string): void {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/vibe-portal`;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return;
  try {
    void fetch(url, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ action: "close", sessionId }),
    });
  } catch {
    /* The tab is going away regardless. */
  }
}
