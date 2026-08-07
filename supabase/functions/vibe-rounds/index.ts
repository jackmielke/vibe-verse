// vibe-rounds — the pot, and the invite codes that fund people to enter it.
//
// Split from `vibe-economy` on purpose. That file is a thousand lines of agent
// shops, arcade cabinets and wardrobe, every deploy re-uploads all of it, and
// "the pot" shares nothing with "Jerry's haiku stand" but a table name. The two
// write to the same balances through the same rules; they are just different
// concerns.
//
// Actions:
//   round_current { ownerRef }                            -> the open round, the board, your entry
//   round_enter   { ownerKind, ownerRef, displayName }    -> stakes in, returns the shared seed
//   round_score   { ownerRef, roundId, score, durationMs} -> records a run, best-of, clamped
//   invite_peek   { code }                                -> what a link is worth, before signing in
//   invite_claim  { ownerKind, ownerRef, code }           -> grants it, once per person, capped
//
// ## The bet
//
// Everyone stakes the same amount into one pot, everyone plays the SAME seeded
// run of ORBIT, and the top score takes it. A pool beats a duel for a party of
// ten: nobody has to be matched with anybody, latecomers just join, and the
// leaderboard is the whole social object. It is also far less to get wrong —
// no lobby, no presence, no disconnect handling, and one person can test the
// entire thing in two browser tabs.
//
// Three properties that make it worth betting on:
//
//   * ONE SKY. The seed is per round, so everyone attempts the identical gate
//     layout. A wager on a game where the obstacles differ is a raffle.
//   * THE SEED IS NOT PUBLIC UNTIL YOU PAY. `vibe_rounds` has no RLS select
//     policy at all; the seed comes back from `round_enter`, and from
//     `round_current` only once you are in. Otherwise you could practise the
//     exact run before deciding whether to stake on it.
//   * THE POT IS THE STAKES. Nothing is minted. What goes in is what comes out,
//     so a round cannot inflate the currency however popular it gets.
//
// Scores are client-reported, same as the arcade. A wager deserves more than a
// clamp, so `round_score` also floors the accepted score at what was reachable
// in the time the run actually took — see MIN_MS_PER_GATE. That is not proof
// and the UI says so; it turns "post any number" into "post any number and sit
// there for it", which is the right amount of rigour for play money.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STARTER_BALANCE = 100;
const ROUND_MAX_SCORE = 300;
/** Fastest a gate can physically be cleared: narrowest spacing ÷ top angular
 *  rate, from `src/orbit/orbit.ts`. Anything quicker did not happen. */
const MIN_MS_PER_GATE = 300;

type Supa = ReturnType<typeof createClient>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const body = await req.json().catch(() => ({}));
    const action = (body?.action ?? "") as string;

    switch (action) {
      case "round_current": return ok(await roundCurrent(supabase, body));
      case "round_enter":   return ok(await roundEnter(supabase, body));
      case "round_score":   return ok(await roundScore(supabase, body));
      case "invite_peek":   return ok(await invitePeek(supabase, body));
      case "invite_claim":  return ok(await inviteClaim(supabase, body));
      default: return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

function ok(data: unknown) { return json({ ok: true, data }); }
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ---- wallet helpers ------------------------------------------------------
// Deliberately duplicated from vibe-economy rather than shared: an edge
// function is deployed as a unit, so a shared module would have to be uploaded
// with both anyway, and these three are twenty lines that have not changed in
// months. If they start drifting, that is the signal to extract them properly.

async function ensureWallet(supabase: Supa, kind: string, ref: string): Promise<number> {
  if (!kind || !ref) throw new Error("owner kind/ref required");
  const { data } = await supabase.from("vibe_balances")
    .select("balance").eq("owner_kind", kind).eq("owner_ref", ref).maybeSingle();
  if (data) return Number(data.balance);
  const seed = kind === "user" ? STARTER_BALANCE : 0;
  await supabase.from("vibe_balances").insert({ owner_kind: kind, owner_ref: ref, balance: seed });
  if (seed > 0) {
    await supabase.from("vibe_ledger").insert({
      from_kind: "system", from_ref: "treasury",
      to_kind: kind, to_ref: ref,
      amount: seed, reason: "starter", memo: "welcome to the vibeverse",
    });
  }
  return seed;
}

async function setBalance(supabase: Supa, kind: string, ref: string, value: number) {
  const { error } = await supabase.from("vibe_balances")
    .update({ balance: value, updated_at: new Date().toISOString() })
    .eq("owner_kind", kind).eq("owner_ref", ref);
  if (error) throw new Error(error.message);
}

// ---- rounds --------------------------------------------------------------

async function currentRoundRow(supabase: Supa) {
  const { data } = await supabase.from("vibe_rounds")
    .select("*").eq("status", "open").order("closes_at", { ascending: true }).limit(1).maybeSingle();
  return data;
}

async function leaderboardOf(supabase: Supa, roundId: string) {
  const { data } = await supabase.from("vibe_round_entries")
    .select("owner_ref, display_name, best_score, plays")
    .eq("round_id", roundId)
    .order("best_score", { ascending: false })
    .order("updated_at", { ascending: true })   // first to reach a score wins ties
    .limit(50);
  return data ?? [];
}

/** Shape a round for the client, hiding the seed unless they are in it. */
function publicRound(row: any, entered: boolean) {
  return {
    id: row.id,
    game: row.game,
    title: row.title,
    stake: Number(row.stake),
    status: row.status,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    winnerRef: row.winner_ref,
    payout: row.payout == null ? null : Number(row.payout),
    seed: entered ? row.seed : null,
  };
}

async function roundCurrent(supabase: Supa, b: any) {
  const ownerRef = String(b.ownerRef ?? "");
  // Settle anything out of time before answering, so results appear without
  // anybody having to trigger them and without a cron.
  await settleDueRounds(supabase);

  const row = await currentRoundRow(supabase);
  if (!row) return { round: null, leaderboard: [], you: null };

  const { data: mine } = await supabase.from("vibe_round_entries")
    .select("best_score, plays").eq("round_id", row.id).eq("owner_ref", ownerRef).maybeSingle();
  const board = await leaderboardOf(supabase, row.id);
  const pot = board.length * Number(row.stake);

  return {
    round: { ...publicRound(row, !!mine), pot, entries: board.length },
    leaderboard: board,
    you: mine ? { bestScore: Number(mine.best_score), plays: Number(mine.plays) } : null,
  };
}

async function roundEnter(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "user");
  const ownerRef = String(b.ownerRef ?? "");
  const displayName = String(b.displayName ?? "").slice(0, 40) || "Anonymous";
  if (ownerKind !== "user" || !ownerRef) throw new Error("player wallet required");

  const row = await currentRoundRow(supabase);
  if (!row) throw new Error("no round is open right now");
  if (new Date(row.closes_at as string).getTime() < Date.now()) {
    throw new Error("that round just closed");
  }

  const { data: already } = await supabase.from("vibe_round_entries")
    .select("owner_ref").eq("round_id", row.id).eq("owner_ref", ownerRef).maybeSingle();
  if (already) {
    // Idempotent: re-entering hands the seed back. A double-tapped button must
    // never take a second stake.
    return { round: publicRound(row, true), alreadyIn: true };
  }

  const stake = Number(row.stake);
  const balance = await ensureWallet(supabase, ownerKind, ownerRef);
  if (balance < stake) throw new Error(`not enough vibe (have ${balance}, need ${stake})`);

  // Take the entry FIRST — the primary key is the lock. Losing the race before
  // any money moves is the only safe ordering.
  const { error: dupe } = await supabase.from("vibe_round_entries").insert({
    round_id: row.id, owner_kind: ownerKind, owner_ref: ownerRef,
    display_name: displayName, staked: stake,
  });
  if (dupe) return { round: publicRound(row, true), alreadyIn: true };

  await setBalance(supabase, ownerKind, ownerRef, balance - stake);
  await supabase.from("vibe_ledger").insert({
    from_kind: ownerKind, from_ref: ownerRef,
    to_kind: "system",    to_ref: "round",
    amount: stake, reason: "round_stake", memo: row.title,
  });

  return { round: publicRound(row, true), alreadyIn: false, balance: balance - stake };
}

async function roundScore(supabase: Supa, b: any) {
  const ownerRef = String(b.ownerRef ?? "");
  const roundId = String(b.roundId ?? "");
  if (!ownerRef || !roundId) throw new Error("round and player required");

  const { data: entry } = await supabase.from("vibe_round_entries")
    .select("owner_ref").eq("round_id", roundId).eq("owner_ref", ownerRef).maybeSingle();
  if (!entry) throw new Error("you are not in that round");

  const { data: row } = await supabase.from("vibe_rounds")
    .select("status, closes_at").eq("id", roundId).maybeSingle();
  if (!row || row.status !== "open") throw new Error("that round is closed");
  if (new Date(row.closes_at as string).getTime() < Date.now()) {
    throw new Error("that round is closed");
  }

  const claimed = Math.max(0, Math.floor(Number(b.score) || 0));
  const durationMs = Math.max(0, Number(b.durationMs) || 0);
  // A run cannot have cleared more gates than there was time for.
  const feasible = Math.floor(durationMs / MIN_MS_PER_GATE);
  const score = Math.min(claimed, ROUND_MAX_SCORE, feasible);

  // `greatest(best_score, ...)` inside one UPDATE, not read-then-write here:
  // two tabs finishing at once would both read the old best, and the worse run
  // — landing second — would clobber the better one. Under the row lock the
  // best only ever climbs, and both plays are counted.
  const { data: after, error } = await supabase.rpc("vibe_round_record_score", {
    p_round_id: roundId, p_owner_ref: ownerRef, p_score: score,
  });
  if (error) throw new Error(error.message);
  const best = Number(after?.[0]?.best_score ?? score);

  return { accepted: score, best, clamped: score < claimed };
}

/**
 * Pay out every round whose clock has run out.
 *
 * Idempotent by the status flip: the update that marks a round settled is
 * filtered on `status = 'open'`, so two callers racing cannot both pay.
 */
async function settleDueRounds(supabase: Supa) {
  const { data: due } = await supabase.from("vibe_rounds")
    .select("*").eq("status", "open").lt("closes_at", new Date().toISOString());
  for (const row of due ?? []) {
    const board = await leaderboardOf(supabase, row.id);
    const pot = board.length * Number(row.stake);
    const winner = board.find((e: any) => Number(e.best_score) > 0);

    const { data: claimed } = await supabase.from("vibe_rounds").update({
      status: "settled",
      settled_at: new Date().toISOString(),
      winner_ref: winner?.owner_ref ?? null,
      payout: winner ? pot : 0,
    }).eq("id", row.id).eq("status", "open").select("id").maybeSingle();
    if (!claimed) continue;

    if (winner && pot > 0) {
      const bal = await ensureWallet(supabase, "user", String(winner.owner_ref));
      await setBalance(supabase, "user", String(winner.owner_ref), bal + pot);
      await supabase.from("vibe_ledger").insert({
        from_kind: "system", from_ref: "round",
        to_kind: "user",     to_ref: String(winner.owner_ref),
        amount: pot, reason: "round_win",
        memo: `${row.title} · ${winner.best_score} gates`,
      });
    } else if (!winner && pot > 0) {
      // Nobody scored. Hand every stake back rather than keep it — a house that
      // wins when the game breaks is not a good look for a party.
      for (const e of board) {
        const bal = await ensureWallet(supabase, "user", String(e.owner_ref));
        await setBalance(supabase, "user", String(e.owner_ref), bal + Number(row.stake));
        await supabase.from("vibe_ledger").insert({
          from_kind: "system", from_ref: "round",
          to_kind: "user",     to_ref: String(e.owner_ref),
          amount: Number(row.stake), reason: "round_refund", memo: row.title,
        });
      }
    }
  }
}

// ---- invites -------------------------------------------------------------
//
// A code, a grant, and a cap. "The first ten people through this link get 100 ✦"
// is the whole feature, and the only interesting part is that it is enforced
// per PERSON rather than per click — which is why the claims table has
// (code, owner_ref) as its primary key and the insert is the lock.
//
// `invite_peek` is unauthenticated and thin on purpose: the landing page needs
// to say "100 ✦, six left" before anyone signs in, and it must not become an
// oracle that tells a stranger anything they could not already read off the
// link they were sent.

async function invitePeek(supabase: Supa, b: any) {
  const code = String(b.code ?? "").trim().toUpperCase();
  if (!code) throw new Error("code required");
  const { data } = await supabase.from("vibe_invites")
    .select("code, grant_amount, max_claims, claims, note, expires_at").eq("code", code).maybeSingle();
  if (!data) return { valid: false };
  const expired = data.expires_at != null && new Date(data.expires_at as string).getTime() < Date.now();
  return {
    valid: !expired && Number(data.claims) < Number(data.max_claims),
    grant: Number(data.grant_amount),
    remaining: Math.max(0, Number(data.max_claims) - Number(data.claims)),
    note: data.note,
    expired,
  };
}

async function inviteClaim(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "user");
  const ownerRef = String(b.ownerRef ?? "");
  const code = String(b.code ?? "").trim().toUpperCase();
  if (ownerKind !== "user" || !ownerRef) throw new Error("player wallet required");
  if (!code) throw new Error("code required");

  const { data: inv } = await supabase.from("vibe_invites")
    .select("*").eq("code", code).maybeSingle();
  if (!inv) throw new Error("that code does not exist");
  if (inv.expires_at && new Date(inv.expires_at as string).getTime() < Date.now()) {
    throw new Error("that link has expired");
  }
  if (Number(inv.claims) >= Number(inv.max_claims)) {
    throw new Error("that link has been fully claimed");
  }

  const amount = Number(inv.grant_amount);
  // One per person, enforced by the primary key rather than by a count.
  const { error: dupe } = await supabase.from("vibe_invite_claims").insert({
    code, owner_ref: ownerRef, amount,
  });
  if (dupe) throw new Error("you have already claimed this one");

  // Re-read the count under the claim we just took: if the cap filled while we
  // were writing, hand the slot back rather than over-issue.
  const { count } = await supabase.from("vibe_invite_claims")
    .select("code", { count: "exact", head: true }).eq("code", code);
  if ((count ?? 0) > Number(inv.max_claims)) {
    await supabase.from("vibe_invite_claims").delete().eq("code", code).eq("owner_ref", ownerRef);
    throw new Error("that link has been fully claimed");
  }
  await supabase.from("vibe_invites").update({ claims: count ?? 0 }).eq("code", code);

  const balance = await ensureWallet(supabase, ownerKind, ownerRef);
  await setBalance(supabase, ownerKind, ownerRef, balance + amount);
  await supabase.from("vibe_ledger").insert({
    from_kind: "system", from_ref: "treasury",
    to_kind: ownerKind,  to_ref: ownerRef,
    amount, reason: "invite", memo: String(inv.note ?? code),
  });

  return {
    granted: amount,
    balance: balance + amount,
    remaining: Math.max(0, Number(inv.max_claims) - (count ?? 0)),
  };
}
