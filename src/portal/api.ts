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
