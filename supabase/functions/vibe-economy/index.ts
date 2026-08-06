// vibe-economy — the simulated $VIBE ledger for the Vibeverse.
//
// All writes to vibe_balances, vibe_ledger, vibe_inventory, agent_bounties
// and agent_economy flow through here so balances can't be tampered with
// from the browser. Architecture is intentionally wallet-style so the
// `transfer` primitive can later be swapped for a real on-chain call on
// Base without touching the UI.
//
// Actions:
//   wallet         { ownerKind, ownerRef }                -> ensures wallet exists, returns balance + recent ledger
//   agent_shop     { agentId }                            -> ensures agent_economy row, ticks needs, returns shop
//   tip            { fromKind, fromRef, agentId, amount, memo? }
//   buy_service    { fromKind, fromRef, agentId, serviceId }
//   buy_item       { fromKind, fromRef, agentId, itemId }
//   claim_bounty   { fromKind, fromRef, bountyId }
//   complete_bounty{ bountyId, agentApproves: true }      (called from agent-reply when agent says "done")
//   tick_agent     { agentId }                            -> decays needs, may put agent to sleep / wake them
//   game_reward    { ownerKind, ownerRef, game, score }   -> mints $VIBE for a sky-island mini-game run
//                                                            (server-side score clamp + 3 rewarded plays/game/day)
//   arcade_insert  { ownerKind, ownerRef, game }          -> debits a cabinet's stake, returns a playId
//   arcade_settle  { ownerKind, ownerRef, playId, game, score }
//                                                         -> pays out that ONE play, once, clamped + daily-capped
//   arcade_allowance { ownerKind, ownerRef }              -> tops a near-broke wallet up, once per UTC day
//
// fromKind/ownerKind ∈ {"user","agent"}.  ownerRef is a uuid for signed-in
// users + agents and a stable guest-id string for anonymous visitors.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STARTER_BALANCE = 100;

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
      case "wallet":         return ok(await getWallet(supabase, body.ownerKind, body.ownerRef));
      case "agent_shop":     return ok(await getAgentShop(supabase, body.agentId));
      case "tick_agent":     return ok(await tickAgent(supabase, body.agentId));
      case "tip":            return ok(await transfer(supabase, body.fromKind, body.fromRef, "agent", body.agentId, num(body.amount), "tip", body.memo));
      case "buy_service":    return ok(await buyService(supabase, body));
      case "buy_item":       return ok(await buyItem(supabase, body));
      case "claim_bounty":   return ok(await claimBounty(supabase, body));
      case "complete_bounty":return ok(await completeBounty(supabase, body));
      case "game_reward":    return ok(await gameReward(supabase, body));
      case "arcade_insert":  return ok(await arcadeInsert(supabase, body));
      case "arcade_settle":  return ok(await arcadeSettle(supabase, body));
      case "arcade_allowance": return ok(await arcadeAllowance(supabase, body));
      default: return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

// ---- helpers ----------------------------------------------------------

function ok(data: unknown) { return json({ ok: true, data }); }
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function num(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error("amount must be > 0");
  return Math.round(n * 100) / 100;
}

type Supa = ReturnType<typeof createClient>;

async function ensureWallet(supabase: Supa, kind: string, ref: string, starter = 0): Promise<number> {
  if (!kind || !ref) throw new Error("owner kind/ref required");
  const { data } = await supabase.from("vibe_balances")
    .select("balance").eq("owner_kind", kind).eq("owner_ref", ref).maybeSingle();
  if (data) return Number(data.balance);
  const seed = kind === "user" ? STARTER_BALANCE : starter;
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

async function getWallet(supabase: Supa, kind: string, ref: string) {
  const balance = await ensureWallet(supabase, kind, ref);
  const { data: ledger } = await supabase.from("vibe_ledger")
    .select("*")
    .or(`and(from_kind.eq.${kind},from_ref.eq.${ref}),and(to_kind.eq.${kind},to_ref.eq.${ref})`)
    .order("created_at", { ascending: false }).limit(20);
  return { balance, ledger: ledger ?? [] };
}

async function transfer(
  supabase: Supa,
  fromKind: string, fromRef: string,
  toKind: string,   toRef: string,
  amount: number,   reason: string,
  memo?: string,
) {
  if (!fromKind || !fromRef || !toKind || !toRef) throw new Error("from/to required");
  if (fromKind === toKind && fromRef === toRef) throw new Error("cannot send to self");
  const fromBal = await ensureWallet(supabase, fromKind, fromRef);
  await ensureWallet(supabase, toKind, toRef, 0);
  if (fromBal < amount) throw new Error(`not enough vibe (have ${fromBal})`);
  // Atomic-ish: two updates + ledger insert. Serialised by primary key
  // contention; good enough for the simulated phase.
  const { error: e1 } = await supabase.from("vibe_balances")
    .update({ balance: fromBal - amount, updated_at: new Date().toISOString() })
    .eq("owner_kind", fromKind).eq("owner_ref", fromRef);
  if (e1) throw new Error(e1.message);
  const { data: toRow } = await supabase.from("vibe_balances")
    .select("balance").eq("owner_kind", toKind).eq("owner_ref", toRef).maybeSingle();
  const toBal = Number(toRow?.balance ?? 0);
  const { error: e2 } = await supabase.from("vibe_balances")
    .update({ balance: toBal + amount, updated_at: new Date().toISOString() })
    .eq("owner_kind", toKind).eq("owner_ref", toRef);
  if (e2) throw new Error(e2.message);
  const { data: tx } = await supabase.from("vibe_ledger").insert({
    from_kind: fromKind, from_ref: fromRef,
    to_kind: toKind,     to_ref: toRef,
    amount, reason, memo,
  }).select().single();
  return { tx, fromBalance: fromBal - amount, toBalance: toBal + amount };
}

// ---- agent shop -------------------------------------------------------

function hash(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function defaultPurpose(name: string, prompt: string): string {
  const p = (prompt || "").toLowerCase();
  if (p.includes("mayor") || /jerry/i.test(name)) return "Mayor of Cardboard City. Issues decrees, blesses dwellings.";
  if (/vibey/i.test(name) || p.includes("community ai")) return "Holds the memory of the vibeverse. Connects builders to each other.";
  if (p.includes("constitution") || p.includes("p2p")) return "Drafts the VIBE Constitution. Trades data-consent zines for coin.";
  if (p.includes("gremlin")) return "Glitches between worlds. Sells corrupted hexes you can't quite read.";
  return `Roams the vibeverse as ${name}. Trades small wisdoms for coin.`;
}

function defaultShop(agentId: string, name: string): { services: any[]; items: any[] } {
  const h = hash(agentId);
  const services = [
    { id: "wisdom",  title: `${name}'s wisdom drop`,    desc: "A short, in-character thought just for you.",         price: 5 + (h % 4) },
    { id: "haiku",   title: `${name} writes you a haiku`, desc: "Three lines, hand-written for the occasion.",        price: 8 + (h % 5) },
    { id: "bless",   title: `${name}'s blessing`,         desc: "Marks you as friend-of-${name} in the ledger.",       price: 12 + (h % 7) },
  ];
  const items = [
    { id: "sticker", title: `${name} sticker pack`, desc: "A glowy holographic sticker you can wear.", price: 20 + (h % 10), cosmetic_key: "holo_sticker" },
    { id: "talisman", title: `${name}'s talisman`,  desc: "A tiny cardboard charm. Purely decorative.", price: 35 + (h % 15) },
  ];
  return { services, items };
}

async function getAgentShop(supabase: Supa, agentId: string) {
  if (!agentId) throw new Error("agentId required");
  const { data: agent } = await supabase.from("world_agents")
    .select("id, name, prompt").eq("id", agentId).maybeSingle();
  if (!agent) throw new Error("agent not found");
  let { data: econ } = await supabase.from("agent_economy")
    .select("*").eq("agent_id", agentId).maybeSingle();
  if (!econ) {
    const shop = defaultShop(agentId, agent.name as string);
    const insert = {
      agent_id: agentId,
      purpose: defaultPurpose(agent.name as string, (agent as any).prompt ?? ""),
      services: shop.services,
      items: shop.items,
    };
    const { data } = await supabase.from("agent_economy").insert(insert).select().single();
    econ = data;
    await ensureWallet(supabase, "agent", agentId, 50); // seed agent treasury
  }
  // Auto-tick on every fetch so the daemon evolves even without a cron.
  const ticked = await tickAgent(supabase, agentId);
  const { data: bounties } = await supabase.from("agent_bounties")
    .select("*").eq("agent_id", agentId).in("status", ["open","claimed"]).order("created_at", { ascending: false }).limit(8);
  const { data: bal } = await supabase.from("vibe_balances")
    .select("balance").eq("owner_kind","agent").eq("owner_ref", agentId).maybeSingle();
  return {
    agent: { id: agent.id, name: agent.name, prompt: agent.prompt },
    economy: ticked.economy,
    balance: Number(bal?.balance ?? 0),
    bounties: bounties ?? [],
  };
}

async function tickAgent(supabase: Supa, agentId: string) {
  const { data: econ } = await supabase.from("agent_economy")
    .select("*").eq("agent_id", agentId).maybeSingle();
  if (!econ) throw new Error("agent_economy row missing");
  const now = Date.now();
  const last = new Date(econ.last_tick as string).getTime();
  const dtMin = Math.max(0, (now - last) / 60000); // minutes elapsed
  const needs = (econ.needs ?? {}) as Record<string, number>;
  // Decay over time when awake; recover slowly when asleep.
  const asleepNow = econ.asleep && econ.asleep_until && new Date(econ.asleep_until as string).getTime() > now;
  const dE = asleepNow ? +0.10 * dtMin : -0.02 * dtMin;
  const dH = asleepNow ? +0.04 * dtMin : -0.015 * dtMin;
  const dM = asleepNow ? +0.05 * dtMin : -0.01 * dtMin;
  const next = {
    energy: clamp((needs.energy ?? 1) + dE),
    hunger: clamp((needs.hunger ?? 1) + dH),
    mood:   clamp((needs.mood   ?? 1) + dM),
  };
  let asleep = econ.asleep;
  let asleep_until = econ.asleep_until;
  // Wake up when timer expires.
  if (asleep && asleep_until && new Date(asleep_until as string).getTime() <= now) {
    asleep = false; asleep_until = null;
  }
  // Sleep when too tired.
  if (!asleep && next.energy < 0.15) {
    asleep = true;
    asleep_until = new Date(now + 5 * 60_000).toISOString();
  }
  const { data: updated } = await supabase.from("agent_economy").update({
    needs: next, last_tick: new Date(now).toISOString(),
    asleep, asleep_until, updated_at: new Date(now).toISOString(),
  }).eq("agent_id", agentId).select().single();
  return { economy: updated };
}

function clamp(v: number) { return Math.max(0, Math.min(1, v)); }

// ---- buying -----------------------------------------------------------

async function buyService(supabase: Supa, b: any) {
  const { agentId, serviceId, fromKind, fromRef } = b;
  const shop = await getAgentShop(supabase, agentId);
  const svc = (shop.economy.services as any[]).find((s) => s.id === serviceId);
  if (!svc) throw new Error("service not found");
  if (shop.economy.asleep) throw new Error(`${shop.agent.name} is asleep right now — try again later.`);
  const tx = await transfer(supabase, fromKind, fromRef, "agent", agentId, svc.price, "service", svc.title);
  // Slight mood/energy cost from doing the work
  const needs = shop.economy.needs as Record<string, number>;
  await supabase.from("agent_economy").update({
    needs: { ...needs, energy: clamp(needs.energy - 0.03), mood: clamp(needs.mood + 0.05) },
    updated_at: new Date().toISOString(),
  }).eq("agent_id", agentId);
  return { ...tx, service: svc };
}

async function buyItem(supabase: Supa, b: any) {
  const { agentId, itemId, fromKind, fromRef } = b;
  const shop = await getAgentShop(supabase, agentId);
  const item = (shop.economy.items as any[]).find((s) => s.id === itemId);
  if (!item) throw new Error("item not found");
  if (shop.economy.asleep) throw new Error(`${shop.agent.name} is asleep — shop is closed.`);
  const tx = await transfer(supabase, fromKind, fromRef, "agent", agentId, item.price, "item", item.title);
  const { data: inv } = await supabase.from("vibe_inventory").insert({
    owner_kind: fromKind, owner_ref: fromRef,
    item_key: item.id, item_title: item.title,
    cosmetic_key: item.cosmetic_key ?? null,
    source_agent_id: agentId,
  }).select().single();
  return { ...tx, item, inventory: inv };
}

async function claimBounty(supabase: Supa, b: any) {
  const { bountyId, fromKind, fromRef } = b;
  const { data: bounty } = await supabase.from("agent_bounties")
    .select("*").eq("id", bountyId).maybeSingle();
  if (!bounty) throw new Error("bounty not found");
  if (bounty.status !== "open") throw new Error("bounty no longer open");
  const { data: updated } = await supabase.from("agent_bounties").update({
    status: "claimed", claimed_by_kind: fromKind, claimed_by_ref: fromRef, claimed_at: new Date().toISOString(),
  }).eq("id", bountyId).eq("status", "open").select().single();
  return { bounty: updated };
}

async function completeBounty(supabase: Supa, b: any) {
  const { bountyId } = b;
  const { data: bounty } = await supabase.from("agent_bounties")
    .select("*").eq("id", bountyId).maybeSingle();
  if (!bounty) throw new Error("bounty not found");
  if (bounty.status !== "claimed") throw new Error("bounty not in claimed state");
  if (!bounty.claimed_by_kind || !bounty.claimed_by_ref) throw new Error("no claimer");
  const tx = await transfer(supabase,
    "agent", bounty.agent_id,
    bounty.claimed_by_kind, bounty.claimed_by_ref,
    Number(bounty.reward), "bounty", bounty.title);
  await supabase.from("agent_bounties").update({
    status: "paid", paid_at: new Date().toISOString(),
  }).eq("id", bountyId);
  return { ...tx, bounty };
}

// ---- mini-game rewards --------------------------------------------------
//
// Each sky-island game reports a raw score; the payout formula lives HERE
// so the client can't invent amounts. Scores are clamped to what's actually
// achievable in a run, payouts are capped per play, and only the first
// GAME_PLAYS_PER_DAY runs per game per owner pay out each UTC day.

const GAME_PLAYS_PER_DAY = 3;
const GAME_MAX_PAYOUT = 150;

const GAME_SPECS: Record<string, { maxScore: number; toVibe: (s: number) => number }> = {
  "mole-meadow":   { maxScore: 40,  toVibe: (s) => s * 2 },       // bops ×2       (≤80)
  "crystal-climb": { maxScore: 90,  toVibe: (s) => s },           // 90 - seconds  (≤90)
  "shrine-dive":   { maxScore: 100, toVibe: (s) => s },           // rings×8 +20   (≤100)
  "lantern-echo":  { maxScore: 12,  toVibe: (s) => s * 10 },      // rounds ×10    (≤120)
};

async function gameReward(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "");
  const ownerRef = String(b.ownerRef ?? "");
  const game = String(b.game ?? "");
  if (ownerKind !== "user" || !ownerRef) throw new Error("player wallet required");
  const spec = GAME_SPECS[game];
  if (!spec) throw new Error(`unknown game: ${game}`);

  const rawScore = Math.max(0, Math.floor(Number(b.score) || 0));
  const score = Math.min(rawScore, spec.maxScore);
  const amount = Math.min(GAME_MAX_PAYOUT, Math.max(0, Math.round(spec.toVibe(score))));

  const balance = await ensureWallet(supabase, ownerKind, ownerRef, 0);
  if (amount <= 0) return { amount: 0, balance, capped: false, playsLeft: null };

  // Daily cap: count today's rewarded runs of this game for this owner.
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase.from("vibe_ledger")
    .select("id", { count: "exact", head: true })
    .eq("to_kind", ownerKind).eq("to_ref", ownerRef)
    .eq("reason", "game_reward").like("memo", `${game}%`)
    .gte("created_at", midnight.toISOString());
  const played = count ?? 0;
  if (played >= GAME_PLAYS_PER_DAY) {
    return { amount: 0, balance, capped: true, playsLeft: 0 };
  }

  // Mint from the treasury (like the starter grant — no source debit).
  const { error: e1 } = await supabase.from("vibe_balances")
    .update({ balance: balance + amount, updated_at: new Date().toISOString() })
    .eq("owner_kind", ownerKind).eq("owner_ref", ownerRef);
  if (e1) throw new Error(e1.message);
  await supabase.from("vibe_ledger").insert({
    from_kind: "system", from_ref: "treasury",
    to_kind: ownerKind, to_ref: ownerRef,
    amount, reason: "game_reward", memo: `${game} · score ${score}`,
  });
  return {
    amount,
    balance: balance + amount,
    capped: false,
    playsLeft: GAME_PLAYS_PER_DAY - played - 1,
  };
}

// ---- the arcade ---------------------------------------------------------
//
// The first thing in the vibeverse that CHARGES. Everything above this line
// pays out, which meant the ledger could only ever inflate; a cabinet that
// takes a stake before it runs a frame is the other half of a currency.
//
// The shape is deliberately a real coin-op:
//
//   arcade_insert  debits the stake and returns the debit's ledger row id.
//   arcade_settle  quotes that id, and pays out against it exactly once.
//
// Which gives us the three properties that matter:
//
//   * You cannot be paid for a game you did not pay for — settle refuses a
//     playId that is not a real, matching, recent `arcade_play` row.
//   * You cannot be paid twice for one run — a settled play already has an
//     `arcade_win` row quoting its id, and the second attempt finds it.
//   * You cannot be paid more than a perfect run is worth — the score is
//     clamped to the cabinet's ceiling before the curve is applied, so the
//     worst a modified client can claim is "I was perfect", and perfect has
//     a price.
//
// It is not tamper-PROOF: a determined player can still claim a perfect run
// they did not have. That is a fair trade for a browser game with no server
// simulation, and the daily ceiling below bounds what it is worth doing.
//
// ARCADE_SPECS mirrors `CABINETS` in `src/arcade/cabinets.ts`. THIS copy is
// the authority — the client's exists so the cabinet can print an honest
// paytable. `src/test/arcade.test.ts` checks they still agree.

const ARCADE_DAILY_CAP = 400;   // most any wallet can WIN from the arcade per UTC day
const ARCADE_PLAY_TTL_MIN = 60; // a coin goes stale; settle the run you just played
const ALLOWANCE_TARGET = 30;    // the floor a near-broke wallet is lifted to, once a day

const ARCADE_SPECS: Record<string, { cost: number; maxScore: number; payout: (s: number) => number }> = {
  stacker: { cost: 10, maxScore: 12, payout: (s) => (s <= 0 ? 0 : s * 4 + (s >= 12 ? 40 : 0)) },
  pattern: { cost: 8,  maxScore: 14, payout: (s) => (s < 3 ? 0 : Math.round(s * s * 0.6)) },
  reflex:  { cost: 6,  maxScore: 24, payout: (s) => Math.round(s * 2.4) },
};

function utcMidnight(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function balanceOf(supabase: Supa, kind: string, ref: string): Promise<number> {
  const { data } = await supabase.from("vibe_balances")
    .select("balance").eq("owner_kind", kind).eq("owner_ref", ref).maybeSingle();
  return Number(data?.balance ?? 0);
}

async function setBalance(supabase: Supa, kind: string, ref: string, value: number) {
  const { error } = await supabase.from("vibe_balances")
    .update({ balance: value, updated_at: new Date().toISOString() })
    .eq("owner_kind", kind).eq("owner_ref", ref);
  if (error) throw new Error(error.message);
}

async function arcadeInsert(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "");
  const ownerRef = String(b.ownerRef ?? "");
  const game = String(b.game ?? "");
  if (ownerKind !== "user" || !ownerRef) throw new Error("player wallet required");
  const spec = ARCADE_SPECS[game];
  if (!spec) throw new Error(`unknown cabinet: ${game}`);

  // ensureWallet also seeds a first-time visitor's 100, so a brand new player
  // can put a coin in the very first machine they walk up to.
  const balance = await ensureWallet(supabase, ownerKind, ownerRef);
  if (balance < spec.cost) {
    throw new Error(`not enough vibe (have ${balance}, need ${spec.cost})`);
  }

  await setBalance(supabase, ownerKind, ownerRef, balance - spec.cost);
  const { data: row, error } = await supabase.from("vibe_ledger").insert({
    from_kind: ownerKind, from_ref: ownerRef,
    to_kind: "system",    to_ref: "arcade",
    amount: spec.cost, reason: "arcade_play", memo: game,
  }).select().single();
  if (error || !row) {
    // Put the coin back rather than leave them charged for a play they can
    // never settle — the debit is only real if it has a play id attached.
    await setBalance(supabase, ownerKind, ownerRef, balance);
    throw new Error(error?.message ?? "could not open a play");
  }

  return { playId: row.id, cost: spec.cost, balance: balance - spec.cost };
}

async function arcadeSettle(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "");
  const ownerRef = String(b.ownerRef ?? "");
  const game = String(b.game ?? "");
  const playId = String(b.playId ?? "");
  if (ownerKind !== "user" || !ownerRef) throw new Error("player wallet required");
  const spec = ARCADE_SPECS[game];
  if (!spec) throw new Error(`unknown cabinet: ${game}`);
  if (!playId) throw new Error("playId required");

  // The play must exist, be this player's, be for this cabinet, and be recent.
  const { data: play } = await supabase.from("vibe_ledger")
    .select("id, from_kind, from_ref, reason, memo, created_at")
    .eq("id", playId).maybeSingle();
  if (!play) throw new Error("no such play");
  if (play.reason !== "arcade_play") throw new Error("that is not a play");
  if (play.from_kind !== ownerKind || play.from_ref !== ownerRef) {
    throw new Error("that play belongs to someone else");
  }
  if (play.memo !== game) throw new Error("that play was for a different cabinet");
  const age = (Date.now() - new Date(play.created_at as string).getTime()) / 60000;
  if (age > ARCADE_PLAY_TTL_MIN) throw new Error("that coin has gone cold");

  // Settle once. The winning row quotes the play id, so its own existence is
  // the lock — no extra table, and it survives a redeploy.
  const tag = `play:${playId}`;
  const { count: already } = await supabase.from("vibe_ledger")
    .select("id", { count: "exact", head: true })
    .eq("reason", "arcade_win").like("memo", `%${tag}%`);
  if ((already ?? 0) > 0) throw new Error("that play is already settled");

  const score = Math.min(Math.max(0, Math.floor(Number(b.score) || 0)), spec.maxScore);
  const gross = Math.max(0, Math.round(spec.payout(score)));

  // Daily ceiling on winnings. Losing runs are unlimited — it is the payout
  // that needs a bound, not the play.
  const { data: wins } = await supabase.from("vibe_ledger")
    .select("amount")
    .eq("to_kind", ownerKind).eq("to_ref", ownerRef)
    .eq("reason", "arcade_win")
    .gte("created_at", utcMidnight());
  const wonToday = (wins ?? []).reduce((t: number, r: any) => t + Number(r.amount), 0);
  const headroom = Math.max(0, ARCADE_DAILY_CAP - wonToday);
  const amount = Math.min(gross, headroom);

  const balance = await balanceOf(supabase, ownerKind, ownerRef);
  if (amount <= 0) {
    return {
      amount: 0,
      balance,
      capped: gross > 0,           // they won, the ceiling ate it
      remainingToday: headroom,
    };
  }

  await setBalance(supabase, ownerKind, ownerRef, balance + amount);
  await supabase.from("vibe_ledger").insert({
    from_kind: "system", from_ref: "treasury",
    to_kind: ownerKind,  to_ref: ownerRef,
    amount, reason: "arcade_win", memo: `${game} · score ${score} · ${tag}`,
  });

  return {
    amount,
    balance: balance + amount,
    capped: amount < gross,
    remainingToday: Math.max(0, headroom - amount),
  };
}

async function arcadeAllowance(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "");
  const ownerRef = String(b.ownerRef ?? "");
  if (ownerKind !== "user" || !ownerRef) throw new Error("player wallet required");

  const balance = await ensureWallet(supabase, ownerKind, ownerRef);
  // Only for players who are actually stuck. Topping up to a floor rather than
  // paying a flat grant means someone sitting at 29 cannot farm it.
  if (balance >= ALLOWANCE_TARGET) {
    return { granted: 0, balance, nextAt: null };
  }
  const { count } = await supabase.from("vibe_ledger")
    .select("id", { count: "exact", head: true })
    .eq("to_kind", ownerKind).eq("to_ref", ownerRef)
    .eq("reason", "arcade_allowance")
    .gte("created_at", utcMidnight());
  if ((count ?? 0) > 0) {
    const tomorrow = new Date(utcMidnight());
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return { granted: 0, balance, nextAt: tomorrow.toISOString() };
  }

  const granted = Math.round((ALLOWANCE_TARGET - balance) * 100) / 100;
  await setBalance(supabase, ownerKind, ownerRef, ALLOWANCE_TARGET);
  await supabase.from("vibe_ledger").insert({
    from_kind: "system", from_ref: "treasury",
    to_kind: ownerKind,  to_ref: ownerRef,
    amount: granted, reason: "arcade_allowance", memo: "daily allowance",
  });
  return { granted, balance: ALLOWANCE_TARGET, nextAt: null };
}
