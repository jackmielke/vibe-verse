// vibe-explore — exploring the vibeverse is the thing that pays.
//
// ## Why this exists
//
// The ledger had a faucet and no pipe. Of 495 wallets, 491 sat at exactly the
// 100 coins they were handed on arrival; ONE had ever gone past it; the richest
// wallet in the entire vibeverse held 116. Three cosmetics have ever been
// bought, all on one afternoon. `game_reward` has fired once, ever.
//
// Not because the shop is bad — because every way to EARN was buried inside a
// world almost nobody reached. The sky-island mini-games and the arcade
// cabinets both require you to already be deep inside a specific place. So the
// arcade, the character shop, ORBIT and the staked rounds were all furniture
// sitting downstream of an action that essentially never happened.
//
// Meanwhile the one thing 495 people demonstrably DID do — walk into a world —
// was recorded in `localStorage`, where the server could never see it and
// therefore could never pay for it.
//
// This function pays for that. It is the pipe.
//
// ## Why it is not in vibe-economy
//
// Same reason the staked rounds are not: that file is a thousand lines, every
// deploy re-uploads all of it, and exploring shares nothing with the agent shop
// but a table name. `vibe-rounds` set the precedent and this follows it.
//
// ## No roster, on purpose
//
// This function does NOT keep a list of which worlds exist, and must not grow
// one. The registry lives in the app and ships on push; a copy here would be a
// second list, and the day the two disagree is the day a brand new world
// silently pays nothing. `pickCharacter` in vibe-economy avoids the identical
// trap for the identical reason.
//
// So a world key is anything key-shaped, and what bounds the mint is a CEILING
// rather than a roster: EXPLORE_MAX_WORLDS paid visits per wallet, ever. Worlds
// can be added for years without anybody redeploying this file.
//
// ## What this is honest about
//
// A modified client can claim a world it never opened. There is no server-side
// proof that a browser rendered a route, and manufacturing one — a heartbeat, a
// signed entry token — is a lot of machinery to guard play money that has no
// peg to anything. It is the same trust level as an arcade score, with a
// tighter bound: every world pays ONCE, ever, so the whole exploit is worth
// EXPLORE_MAX_WORLDS × EXPLORE_PER_WORLD plus the milestones, once, and then
// that wallet is finished.
//
// Actions:
//   visits      { ownerKind, ownerRef }   -> which worlds this wallet has been paid for
//   explore     { ownerKind, ownerRef, worlds: [{key,name}] }
//                                         -> pays first arrivals, once per world ever,
//                                            plus any milestone the jump crosses
//   claim_guest { guestRef }              -> carries travel from a guest wallet onto
//                                            the signed-in caller's account

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STARTER_BALANCE = 100;

/** What one world is worth the first time you set foot in it. */
const EXPLORE_PER_WORLD = 25;

/**
 * The ceiling that stands in for a roster.
 *
 * Comfortably above the ~31 worlds that carry a passport page today, so worlds
 * can be added for a long time without a deploy here — and low enough that the
 * most a wallet can ever mint from exploring is a number you can state:
 * 60 × 25 + 1,700 = 3,200.
 */
const EXPLORE_MAX_WORLDS = 60;

/**
 * Crossing a threshold pays a bonus.
 *
 * Counts, not percentages, because this file deliberately does not know how
 * many worlds exist and a fraction of an unknown is not a number. A traveller
 * who sees all ~31 passport worlds collects all four: 1,700 on top of the
 * per-world coins, for about 2,475 total — four or five of the shop's
 * characters, which is the point.
 */
const EXPLORE_MILESTONES: Array<{ at: number; bonus: number; title: string }> = [
  { at: 5,  bonus: 100,  title: "Wanderer" },
  { at: 10, bonus: 200,  title: "Voyager" },
  { at: 20, bonus: 400,  title: "Pathfinder" },
  { at: 30, bonus: 1000, title: "Cartographer" },
];

/** Key-shaped and nothing else — the same shape the registry gives its keys. */
const WORLD_KEY = /^[a-z0-9][a-z0-9-]{0,47}$/;

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
      case "visits":      return ok(await getVisits(supabase, body));
      case "explore":     return ok(await explore(supabase, body));
      case "claim_guest": return ok(await claimGuestVisits(supabase, req, body));
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
// Duplicated from vibe-economy for the same reason vibe-rounds duplicates
// them: an edge function deploys as a unit, so a shared module would be
// uploaded with both anyway, and these two have not changed in months.

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

// ---- reading -------------------------------------------------------------

async function visitedKeys(supabase: Supa, kind: string, ref: string): Promise<string[]> {
  const { data } = await supabase.from("vibe_visits")
    .select("world_key").eq("owner_kind", kind).eq("owner_ref", ref);
  return (data ?? []).map((r: any) => String(r.world_key));
}

/**
 * What this wallet has already been paid for.
 *
 * Also the thing that makes a passport survive a new device: the browser's
 * `localStorage` copy is authoritative about *when* and *how often*, this is
 * authoritative about *whether*, and the client unions them.
 */
async function getVisits(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "");
  const ownerRef = String(b.ownerRef ?? "");
  if (!ownerKind || !ownerRef) throw new Error("owner kind/ref required");
  const { data } = await supabase.from("vibe_visits")
    .select("world_key, name, first_seen, paid")
    .eq("owner_kind", ownerKind).eq("owner_ref", ownerRef);
  const rows = data ?? [];
  return {
    keys: rows.map((r: any) => String(r.world_key)),
    first: Object.fromEntries(
      rows.map((r: any) => [String(r.world_key), Date.parse(r.first_seen) || 0]),
    ),
    visited: rows.length,
    earned: rows.reduce((t: number, r: any) => t + Number(r.paid ?? 0), 0),
    perWorld: EXPLORE_PER_WORLD,
    maxWorlds: EXPLORE_MAX_WORLDS,
    milestones: EXPLORE_MILESTONES,
  };
}

// ---- paying --------------------------------------------------------------

/**
 * Record arrivals and pay for whichever are new.
 *
 * Takes a LIST rather than one world for two reasons. The first sync of a
 * passport that has been quietly filling up in somebody's browser since June is
 * then one request instead of eighteen. And the milestone arithmetic sees the
 * whole jump at once, rather than paying "Wanderer" somewhere in the middle of
 * a burst of concurrent round trips that each think they are first.
 */
async function explore(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "");
  const ownerRef = String(b.ownerRef ?? "");
  if (ownerKind !== "user" || !ownerRef) throw new Error("player wallet required");

  // Dedupe before anything else: a client that sends the same key twice must
  // not be able to turn one world into two rows. Map keeps the last name given.
  const wanted = new Map<string, string>();
  for (const w of (Array.isArray(b.worlds) ? b.worlds : []).slice(0, 200)) {
    const key = String(w?.key ?? "").toLowerCase();
    if (!WORLD_KEY.test(key)) continue;
    wanted.set(key, String(w?.name ?? key).slice(0, 80));
  }

  const balanceBefore = await ensureWallet(supabase, ownerKind, ownerRef);
  const nothing = (visited: number) => ({
    newly: [] as string[], amount: 0, worldCoins: 0, bonusCoins: 0,
    balance: balanceBefore, visited, milestones: [] as typeof EXPLORE_MILESTONES,
    perWorld: EXPLORE_PER_WORLD,
  });
  if (wanted.size === 0) return nothing(0);

  const already = new Set(await visitedKeys(supabase, ownerKind, ownerRef));
  const before = already.size;

  // The ceiling is applied BEFORE the insert, so a wallet at the cap writes no
  // rows at all rather than writing rows that are worth nothing and would then
  // permanently occupy the slots of worlds it has not seen yet.
  const headroom = Math.max(0, EXPLORE_MAX_WORLDS - before);
  const candidates = [...wanted.keys()].filter((k) => !already.has(k)).slice(0, headroom);
  if (candidates.length === 0) return nothing(before);

  /*
   * The primary key is the arbiter, not a check-then-insert.
   *
   * `ignoreDuplicates` compiles to ON CONFLICT DO NOTHING, whose RETURNING
   * clause yields only the rows that were really inserted. So two tabs racing
   * the same first arrival produce exactly one payment, and the loser is told
   * it earned nothing instead of erroring — which is the honest answer, because
   * it did.
   */
  const { data: inserted, error } = await supabase.from("vibe_visits")
    .upsert(
      candidates.map((key) => ({
        owner_kind: ownerKind, owner_ref: ownerRef,
        world_key: key, name: wanted.get(key) ?? key,
        paid: EXPLORE_PER_WORLD,
      })),
      { onConflict: "owner_kind,owner_ref,world_key", ignoreDuplicates: true },
    )
    .select("world_key");
  if (error) throw new Error(error.message);

  const newly = (inserted ?? []).map((r: any) => String(r.world_key));
  if (newly.length === 0) return nothing(before);

  const after = before + newly.length;
  const crossed = EXPLORE_MILESTONES.filter((m) => before < m.at && m.at <= after);
  const worldCoins = newly.length * EXPLORE_PER_WORLD;
  const bonusCoins = crossed.reduce((t, m) => t + m.bonus, 0);
  const amount = worldCoins + bonusCoins;

  // Minted from the treasury, like the starter grant and the game rewards.
  // Exploring creates coins; it does not move them from anybody.
  await setBalance(supabase, ownerKind, ownerRef, balanceBefore + amount);
  await supabase.from("vibe_ledger").insert({
    from_kind: "system", from_ref: "treasury",
    to_kind: ownerKind,  to_ref: ownerRef,
    amount: worldCoins, reason: "explore",
    memo: newly.length === 1
      ? `first visit · ${wanted.get(newly[0]) ?? newly[0]}`
      : `${newly.length} new worlds`,
  });
  // Each milestone gets its own ledger row so it reads as the thing it is,
  // rather than being folded into one suspiciously large visit.
  for (const m of crossed) {
    await supabase.from("vibe_ledger").insert({
      from_kind: "system", from_ref: "treasury",
      to_kind: ownerKind,  to_ref: ownerRef,
      amount: m.bonus, reason: "explore_milestone",
      memo: `${m.title} · ${m.at} worlds`,
    });
  }

  return {
    newly, amount, worldCoins, bonusCoins,
    balance: balanceBefore + amount,
    visited: after,
    milestones: crossed,
    perWorld: EXPLORE_PER_WORLD,
  };
}

// ---- guest → account -----------------------------------------------------

/**
 * Carry travel across when somebody signs in.
 *
 * `vibe-economy`'s `claim_guest` moves the coins, the items and the look. This
 * moves the map, and it matters for more than tidiness: without it the account
 * has no visit rows, so the very next sync would pay it a SECOND time for
 * worlds the guest wallet was already paid for — and `claim_guest` has by then
 * already handed the account the guest's coins.
 *
 * The caller's identity comes from their JWT and never from the body, for the
 * same reason it does over there: the body is the client's to write, and the
 * destination of a merge is not a thing the client may name.
 *
 * Idempotent and safe to retry — a world the account already has is skipped,
 * and moving zero rows is a normal answer rather than an error.
 */
async function claimGuestVisits(supabase: Supa, req: Request, b: any) {
  const guestRef = String(b.guestRef ?? "");
  if (!guestRef) throw new Error("guestRef required");

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await supabase.auth.getUser(token);
  const accountRef = auth?.user?.id;
  if (!accountRef) throw new Error("sign in first");
  if (accountRef === guestRef) throw new Error("that is already your account");

  const guestWorlds = await visitedKeys(supabase, "user", guestRef);
  const accountWorlds = new Set(await visitedKeys(supabase, "user", accountRef));

  // One at a time, skipping collisions — a bulk update would trip the primary
  // key and abandon the whole merge over a single world both wallets had seen.
  let moved = 0;
  for (const key of guestWorlds) {
    if (accountWorlds.has(key)) continue;
    const { error } = await supabase.from("vibe_visits")
      .update({ owner_ref: accountRef })
      .eq("owner_kind", "user").eq("owner_ref", guestRef).eq("world_key", key);
    if (!error) moved += 1;
  }

  return { worldsMoved: moved, visited: accountWorlds.size + moved };
}
