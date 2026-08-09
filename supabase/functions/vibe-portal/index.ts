// vibe-portal — the money side of games the vibeverse did not write.
//
// The premise is in the migration and worth repeating here, because this file
// is where it is either true or not:
//
//   **A game never mints. It spends an allowance we hold.**
//
// Nothing in this function takes an amount from a caller and pays it. Every
// path takes a *request* for an amount and pays the smallest of it and four
// ceilings. Which means the interesting question about a new game stops being
// "do we trust the developer" and becomes "what is the most this can cost us
// today" — a number, in a column, that a person can change.
//
// Actions:
//   list   {}                                   -> active games + what each has left today
//   open   { slug, ownerKind, ownerRef }         -> a session id, and this player's headroom
//   award  { sessionId, amount, reason? }        -> pays min(amount, four ceilings)
//   close  { sessionId }                         -> seals it; returns the visit's total
//
// The session id returned by `open` is the only thing that can move money, and
// the host page never posts it into the game's frame. See `src/portal/host.ts`
// — that half of the contract is not enforceable from here, so it is written
// down in both places.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Two more limits live in `vibe_portal_award` rather than up here, because
// they have to be checked under the same lock as the money:
//
//   * a visit goes stale after 180 minutes — long enough for a real session,
//     short enough that a session id left in a closed tab is not a standing
//     line of credit;
//   * a visit may ask 120 times. That is a bound on the *number* of awards,
//     not their size: a game paying a coin per frame is a bug in the game,
//     and it would otherwise cost us a thousand round trips before any
//     budget noticed.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");

    switch (action) {
      case "list":  return ok(await listGames(supabase));
      case "open":  return ok(await openSession(supabase, body));
      case "award": return ok(await award(supabase, body));
      case "close": return ok(await closeSession(supabase, body));
      default: return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 400);
  }
});

function ok(data: unknown) { return json({ ok: true, data }); }
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Supa = ReturnType<typeof createClient>;

interface Game {
  slug: string;
  title: string;
  tagline: string | null;
  author: string | null;
  author_url: string | null;
  embed_url: string;
  origin: string;
  max_award: number;
  session_budget: number;
  player_daily: number;
  daily_budget: number;
  active: boolean;
}

/** Today in UTC as a `date` literal. The sessions table stores the same thing,
 *  fixed at open, so daily sums are an index lookup rather than a range scan
 *  and a session cannot straddle midnight into tomorrow's allowance. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getGame(supabase: Supa, slug: string): Promise<Game> {
  if (!slug) throw new Error("slug required");
  const { data } = await supabase.from("vibe_portal_games")
    .select("*").eq("slug", slug).maybeSingle();
  if (!data) throw new Error(`no game called ${slug}`);
  const game = data as unknown as Game;
  if (!game.active) throw new Error(`${game.title} is not open right now`);
  return game;
}

/** What a game has already paid today, and to this one player. Both come from
 *  the same rows, so they are one query, not two. */
async function spentToday(supabase: Supa, slug: string, ownerRef?: string) {
  const { data } = await supabase.from("vibe_portal_sessions")
    .select("owner_ref, awarded")
    .eq("slug", slug).eq("day", today());
  const rows = (data ?? []) as { owner_ref: string; awarded: number }[];
  let all = 0, mine = 0;
  for (const r of rows) {
    all += Number(r.awarded) || 0;
    if (ownerRef && r.owner_ref === ownerRef) mine += Number(r.awarded) || 0;
  }
  return { all, mine };
}

// ---- list ----------------------------------------------------------------

async function listGames(supabase: Supa) {
  const { data } = await supabase.from("vibe_portal_games")
    .select("*").eq("active", true).order("created_at", { ascending: true });
  const games = (data ?? []) as unknown as Game[];

  // One sum for every game rather than one query per game: the list is short
  // now and this stops it becoming an N+1 the day it isn't.
  const { data: sess } = await supabase.from("vibe_portal_sessions")
    .select("slug, awarded").eq("day", today());
  const spent = new Map<string, number>();
  for (const r of (sess ?? []) as { slug: string; awarded: number }[]) {
    spent.set(r.slug, (spent.get(r.slug) ?? 0) + (Number(r.awarded) || 0));
  }

  return {
    games: games.map((g) => ({
      slug: g.slug,
      title: g.title,
      tagline: g.tagline,
      author: g.author,
      authorUrl: g.author_url,
      embedUrl: g.embed_url,
      origin: g.origin,
      maxAward: g.max_award,
      sessionBudget: g.session_budget,
      playerDaily: g.player_daily,
      dailyBudget: g.daily_budget,
      remainingToday: Math.max(0, g.daily_budget - (spent.get(g.slug) ?? 0)),
    })),
  };
}

// ---- open ----------------------------------------------------------------

async function openSession(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "");
  const ownerRef = String(b.ownerRef ?? "");
  if (ownerKind !== "user" || !ownerRef) throw new Error("player wallet required");
  const game = await getGame(supabase, String(b.slug ?? ""));

  const { all, mine } = await spentToday(supabase, game.slug, ownerRef);
  const gameLeft = Math.max(0, game.daily_budget - all);
  const playerLeft = Math.max(0, game.player_daily - mine);

  // Opening a new visit retires this player's older ones for this game. A
  // refresh is the common case and it would otherwise leave a live session id
  // behind in every tab they ever opened; each of those is a key to the same
  // allowance, and there is no reason for more than one to turn.
  await supabase.from("vibe_portal_sessions")
    .update({ closed_at: new Date().toISOString() })
    .eq("slug", game.slug).eq("owner_ref", ownerRef).is("closed_at", null);

  // A session opens even when the headroom is zero. The game should still be
  // playable when the coins have run out — telling somebody "come back
  // tomorrow" is a better experience than a locked door, and a game that only
  // works while it is paying is a slot machine.
  const { data, error } = await supabase.from("vibe_portal_sessions").insert({
    slug: game.slug, owner_kind: ownerKind, owner_ref: ownerRef,
  }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "could not open a session");

  return {
    sessionId: data.id,
    game: {
      slug: game.slug,
      title: game.title,
      tagline: game.tagline,
      author: game.author,
      authorUrl: game.author_url,
      embedUrl: game.embed_url,
      origin: game.origin,
      maxAward: game.max_award,
    },
    headroom: Math.min(game.session_budget, playerLeft, gameLeft),
    remainingToday: gameLeft,
  };
}

// ---- award ---------------------------------------------------------------

// All four ceilings, the wallet credit, the ledger row and the session
// bookkeeping happen inside `vibe_portal_award`, in Postgres, holding a lock
// on the session row. Doing it here in four awaits looked fine and had a real
// race: two tabs of the same game read the same `awarded` and both spent
// against it. The rule the whole feature rests on cannot be the thing with a
// timing hole in it, so it lives where a transaction can hold it.
async function award(supabase: Supa, b: any) {
  const sessionId = String(b.sessionId ?? "");
  if (!sessionId) throw new Error("sessionId required");

  const asked = Math.floor(Number(b.amount));
  if (!Number.isFinite(asked) || asked <= 0) throw new Error("amount must be > 0");

  const reason = String(b.reason ?? "").slice(0, 80).replace(/[\r\n]+/g, " ").trim();

  const { data, error } = await supabase.rpc("vibe_portal_award", {
    p_session: sessionId,
    p_amount: asked,
    p_reason: reason || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

// ---- close ---------------------------------------------------------------

async function closeSession(supabase: Supa, b: any) {
  const sessionId = String(b.sessionId ?? "");
  if (!sessionId) throw new Error("sessionId required");
  const { data } = await supabase.from("vibe_portal_sessions")
    .update({ closed_at: new Date().toISOString() })
    .eq("id", sessionId).is("closed_at", null)
    .select("awarded, awards").maybeSingle();
  // Already closed is not an error — the host closes on unmount and on
  // pagehide, and both firing is the normal case, not a bug.
  return { awarded: Number(data?.awarded ?? 0), awards: Number(data?.awards ?? 0) };
}
