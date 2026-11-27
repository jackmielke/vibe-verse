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
//   wardrobe       { ownerKind, ownerRef }                -> what you own and what you're wearing
//   buy_cosmetic   { ownerKind, ownerRef, kind, id }      -> spends the CATALOG price, grants the item
//   set_loadout    { ownerKind, ownerRef, hat?, flame?, jetpack?, character? }
//                                                         -> equips things you actually own
//   claim_guest    { guestRef }                           -> one-way merge of a guest wallet into
//                                                            the signed-in caller's account
//
// Staked rounds and invite codes live in the sibling `vibe-rounds` function.
// They were briefly here and moved out: this file is already a thousand lines,
// every deploy re-uploads all of it, and "the pot" shares nothing with "the
// agent shop" but a table name.
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
      case "wardrobe":       return ok(await getWardrobe(supabase, body));
      case "buy_cosmetic":   return ok(await buyCosmetic(supabase, body));
      case "set_loadout":    return ok(await setLoadout(supabase, body));
      case "claim_guest":    return ok(await claimGuest(supabase, req, body));
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

// ---- the wardrobe -------------------------------------------------------
//
// Hats, jetpack flames and jetpack shells. They already existed, they already
// had prices printed on them, and nothing had ever charged one — the catalog
// said "currently free during early access" and unlocks were an array in
// localStorage. So the only currency SINK the vibeverse had was switched off,
// and the only thing resembling a personal possession evaporated when you
// cleared your browser or opened the app on a different device.
//
// So ownership moves here. Three rules:
//
//   * THE PRICE IS THE SERVER'S. `COSMETICS` below is the authority and the
//     client's copy exists to draw a shelf label. A browser cannot name its
//     own price any more than it can name its own arcade payout.
//   * ONE OF EACH. The unique index on (owner_kind, owner_ref, item_key) is
//     the lock, not a check-then-insert — a double-tapped buy button is a race
//     and a race that charges twice is the worst kind.
//   * FREE IS OWNED. Anything priced 0 is stock issue: never bought, never
//     stored, always equippable. Otherwise every wallet starts with three rows
//     recording that it owns nothing in particular.

interface CosmeticSpec { price: number; title: string }

const COSMETICS: Record<string, Record<string, CosmeticSpec>> = {
  hat: {
    none:      { price: 0,   title: "No Hat" },
    cap:       { price: 25,  title: "Mint Cap" },
    beanie:    { price: 35,  title: "Pom Beanie" },
    party:     { price: 60,  title: "Party Cone" },
    tophat:    { price: 75,  title: "Top Hat" },
    propeller: { price: 90,  title: "Propeller" },
    crown:     { price: 250, title: "Crown" },
    halo:      { price: 400, title: "Halo" },
    sticker:   { price: 0,   title: "Holo Sticker" },
    bucket:    { price: 45,  title: "Bucket Hat" },
    cans:      { price: 120, title: "Studio Cans" },
    visor:     { price: 180, title: "Neon Visor" },
  },
  flame: {
    mint:    { price: 0,   title: "Mint Stock" },
    fire:    { price: 50,  title: "Fire Boost" },
    violet:  { price: 80,  title: "Violet Pulse" },
    magma:   { price: 120, title: "Magma Roar" },
    ion:     { price: 150, title: "Ion Cyan" },
    rainbow: { price: 300, title: "Rainbow" },
  },
  jetpack: {
    stock:  { price: 0,   title: "Stock Pack" },
    sunset: { price: 80,  title: "Sunset Pack" },
    violet: { price: 110, title: "Violet Pack" },
    ion:    { price: 140, title: "Ion Pack" },
    magma:  { price: 180, title: "Magma Pack" },
    gold:   { price: 260, title: "Gold Pack" },
    none:   { price: 0,   title: "Return Pack" },
  },
  // The arcade's character shop. Six code-built designs that did not exist
  // before it did — see src/lib/characterShop.ts for why nothing from the
  // free roster has a price on it.
  //
  // This group breaks the rule the other three follow, deliberately. For hats
  // an id that is absent is an ERROR; for characters an id that is absent is
  // FREE. There are sixty-odd free characters behind an `import.meta.glob`
  // over a folder of GLBs, and a copy of that list here would be a second
  // place to forget one — a new character would then be unequippable until
  // somebody redeployed this file. So: in this table means you must own it.
  // `pickCharacter` in setLoadout is the one place that rule is applied.
  character: {
    pixel:        { price: 150, title: "Pixel" },
    bumble:       { price: 150, title: "Bumble" },
    sable:        { price: 300, title: "Sable" },
    chrome:         { price: 300, title: "Chrome" },
    eddie:          { price: 200, title: "Eddie" },
    "vibe-police":  { price: 350, title: "Vibe Police" },
    "space-rex":    { price: 450, title: "Space Rex" },
    grimlock:     { price: 600, title: "Grimlock" },
    aurora:       { price: 600, title: "Aurora" },
    bolt: { price: 400, title: "Bolt" },
    pip: { price: 400, title: "Pip" },
    gilt: { price: 350, title: "Gilt" },
    sentry: { price: 250, title: "Sentry" },
    warden: { price: 600, title: "Warden" },
    bounty: { price: 550, title: "Bounty" },
    bramble: { price: 350, title: "Bramble" },
    elder: { price: 300, title: "Elder" },
    gonk: { price: 150, title: "Gonk" },
    medic: { price: 175, title: "Medic" },
    magnate: { price: 650, title: "Magnate" },
    bulwark: { price: 400, title: "Bulwark" },
    emerald: { price: 300, title: "Emerald" },
    voltaic: { price: 350, title: "Voltaic" },
    seraph: { price: 600, title: "Seraph" },
    vantablack: { price: 300, title: "Vantablack" },
    crimson: { price: 500, title: "Crimson" },
    stinger: { price: 175, title: "Stinger" },
    titan: { price: 550, title: "Titan" },
    phase: { price: 450, title: "Phase" },
    cinder: { price: 400, title: "Cinder" },
    frostbite: { price: 350, title: "Frostbite" },
    mothling: { price: 300, title: "Mothling" },
    jelly: { price: 250, title: "Jelly" },
    prickle: { price: 150, title: "Prickle" },
    origami: { price: 250, title: "Origami" },
    ridgeback: { price: 450, title: "Ridgeback" },
    strider: { price: 500, title: "Strider" },
    hauler: { price: 350, title: "Hauler" },
    marshmallow: { price: 300, title: "Marshmallow" },
    scrap: { price: 400, title: "Scrap" },
    ovoid: { price: 450, title: "Ovoid" },
    tuxedo: { price: 250, title: "Tuxedo" },
    sprout: { price: 175, title: "Sprout" },
  },
  // Vibe City's weapons counter (Vibe Arms on the plaza, and the island's
  // Vibe Shop). Bought once, never runs out. See src/lib/weaponCatalog.ts.
  weapon: {
    water:     { price: 60,  title: "Super Soaker" },
    glock:     { price: 150, title: "Glock 19" },
    paint:     { price: 120, title: "Paintball Marker" },
    pineapple: { price: 250, title: "Pineapple Bombs" },
    blaster:   { price: 500, title: "Nova Blaster" },
  },
};

/** `hat:crown`. Namespaced because "violet" is both a flame and a jetpack. */
const itemKey = (kind: string, id: string) => `${kind}:${id}`;

function cosmeticSpec(kind: string, id: string): CosmeticSpec {
  const spec = COSMETICS[kind]?.[id];
  if (!spec) throw new Error(`no such cosmetic: ${kind}/${id}`);
  return spec;
}

async function ownedKeys(supabase: Supa, kind: string, ref: string): Promise<string[]> {
  const { data } = await supabase.from("vibe_inventory")
    .select("item_key").eq("owner_kind", kind).eq("owner_ref", ref);
  return (data ?? []).map((r: any) => String(r.item_key));
}

async function loadoutOf(supabase: Supa, kind: string, ref: string) {
  const { data } = await supabase.from("vibe_loadout")
    .select("hat, flame, jetpack, char_id").eq("owner_kind", kind).eq("owner_ref", ref).maybeSingle();
  return {
    hat: String(data?.hat ?? "none"),
    flame: String(data?.flame ?? "mint"),
    jetpack: String(data?.jetpack ?? "stock"),
    // `char_id` in the column, `character` on the wire — CHARACTER is a SQL
    // keyword, and the client should still see the word it means.
    character: String(data?.char_id ?? "vibey"),
  };
}

async function getWardrobe(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "");
  const ownerRef = String(b.ownerRef ?? "");
  if (!ownerKind || !ownerRef) throw new Error("owner kind/ref required");
  const balance = await ensureWallet(supabase, ownerKind, ownerRef);
  return {
    owned: await ownedKeys(supabase, ownerKind, ownerRef),
    loadout: await loadoutOf(supabase, ownerKind, ownerRef),
    balance,
  };
}

async function buyCosmetic(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "");
  const ownerRef = String(b.ownerRef ?? "");
  const kind = String(b.kind ?? "");
  const id = String(b.id ?? "");
  if (ownerKind !== "user" || !ownerRef) throw new Error("player wallet required");
  const spec = cosmeticSpec(kind, id);
  if (spec.price <= 0) throw new Error("that one is stock issue — you already have it");

  const key = itemKey(kind, id);
  const balance = await ensureWallet(supabase, ownerKind, ownerRef);
  if (balance < spec.price) {
    throw new Error(`not enough vibe (have ${balance}, need ${spec.price})`);
  }

  // Claim the item FIRST. The unique index is what makes a double-tap safe:
  // the second insert loses, and losing before any money moves is the only
  // ordering where a race cannot charge someone twice.
  const { error: dupe } = await supabase.from("vibe_inventory").insert({
    owner_kind: ownerKind, owner_ref: ownerRef,
    item_key: key, item_title: spec.title, cosmetic_key: id,
  });
  if (dupe) throw new Error("you already own that one");

  const { error: debit } = await supabase.from("vibe_balances")
    .update({ balance: balance - spec.price, updated_at: new Date().toISOString() })
    .eq("owner_kind", ownerKind).eq("owner_ref", ownerRef);
  if (debit) {
    // Hand it back rather than leave them owning something they were not
    // charged for — the inventory row is only real once it is paid for.
    await supabase.from("vibe_inventory").delete()
      .eq("owner_kind", ownerKind).eq("owner_ref", ownerRef).eq("item_key", key);
    throw new Error(debit.message);
  }

  await supabase.from("vibe_ledger").insert({
    from_kind: ownerKind, from_ref: ownerRef,
    to_kind: "system",    to_ref: "shop",
    amount: spec.price, reason: "cosmetic", memo: spec.title,
  });

  return {
    balance: balance - spec.price,
    owned: await ownedKeys(supabase, ownerKind, ownerRef),
    bought: { kind, id, title: spec.title, price: spec.price },
  };
}

async function setLoadout(supabase: Supa, b: any) {
  const ownerKind = String(b.ownerKind ?? "");
  const ownerRef = String(b.ownerRef ?? "");
  if (ownerKind !== "user" || !ownerRef) throw new Error("player wallet required");

  const current = await loadoutOf(supabase, ownerKind, ownerRef);
  const owned = new Set(await ownedKeys(supabase, ownerKind, ownerRef));

  // Equipping is checked against ownership too, not just buying. Otherwise the
  // shop is a formality: anyone can put a crown on by posting `set_loadout`.
  const pick = (kind: string, want: unknown, fallback: string): string => {
    if (want == null) return fallback;
    const id = String(want);
    const spec = cosmeticSpec(kind, id);
    if (spec.price > 0 && !owned.has(itemKey(kind, id))) {
      throw new Error(`you do not own the ${spec.title}`);
    }
    return id;
  };

  // Characters invert the rule: absent from the priced table means FREE, not
  // unknown. See the comment on COSMETICS.character. The id still has to be
  // something that could plausibly be a character — it goes into a text column
  // and comes back out into a URL-ish lookup, and "anything at all" is not a
  // shape worth storing.
  const pickCharacter = (want: unknown, fallback: string): string => {
    if (want == null) return fallback;
    const id = String(want);
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(id)) throw new Error("not a character id");
    const spec = COSMETICS.character[id];
    if (spec && spec.price > 0 && !owned.has(itemKey("character", id))) {
      throw new Error(`you do not own ${spec.title}`);
    }
    return id;
  };

  const next = {
    hat: pick("hat", b.hat, current.hat),
    flame: pick("flame", b.flame, current.flame),
    jetpack: pick("jetpack", b.jetpack, current.jetpack),
    character: pickCharacter(b.character, current.character),
  };

  const { error } = await supabase.from("vibe_loadout").upsert(
    {
      owner_kind: ownerKind, owner_ref: ownerRef,
      hat: next.hat, flame: next.flame, jetpack: next.jetpack,
      char_id: next.character,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_kind,owner_ref" },
  );
  if (error) throw new Error(error.message);
  return { loadout: next };
}

// ---- guest → account -----------------------------------------------------
//
// The break this closes: the ledger is keyed by a browser-local guest id OR an
// auth id, never both, so signing in used to move you to a brand new empty
// wallet while your coins sat on the old key forever. Nothing merged them
// because nothing could — there was no moment at which the app knew both keys
// belonged to one person. Signing in is that moment.
//
// One way, once. The guest wallet is drained rather than deleted, and the
// `vibe_guest_claims` row — keyed by the guest ref — is what stops it being
// claimed a second time, by this account or any other. Inserting that row
// FIRST makes the lock a primary-key violation instead of a select-then-insert,
// so two tabs racing the same merge cannot both win and double the balance.
//
// The caller's identity comes from their JWT, NOT from the request body. Every
// other action in this file trusts a client-supplied ownerRef, which is fine
// when the worst case is paying for your own arcade run; here the worst case is
// naming somebody else's account as the destination for a wallet you drained.
async function claimGuest(supabase: Supa, req: Request, b: any) {
  const guestRef = String(b.guestRef ?? "");
  if (!guestRef) throw new Error("guestRef required");

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await supabase.auth.getUser(token);
  const accountRef = auth?.user?.id;
  if (!accountRef) throw new Error("sign in first");
  if (accountRef === guestRef) throw new Error("that is already your account");

  const guestBalance = await balanceOf(supabase, "user", guestRef);

  // The lock. Taken before any money moves, so a failure here means nothing
  // has happened yet.
  const { error: locked } = await supabase.from("vibe_guest_claims").insert({
    guest_ref: guestRef, account_ref: accountRef, amount: guestBalance,
  });
  if (locked) throw new Error("that guest wallet has already been claimed");

  const accountBalance = await ensureWallet(supabase, "user", accountRef);
  if (guestBalance > 0) {
    await setBalance(supabase, "user", guestRef, 0);
    await setBalance(supabase, "user", accountRef, accountBalance + guestBalance);
    // Only when something actually moved: vibe_ledger CHECKs amount > 0, and
    // an empty guest wallet is the ordinary case rather than an error.
    await supabase.from("vibe_ledger").insert({
      from_kind: "user", from_ref: guestRef,
      to_kind: "user",   to_ref: accountRef,
      amount: guestBalance, reason: "guest_claim", memo: "brought a guest wallet across",
    });
  }

  // Inventory moves item by item, skipping anything the account already owns —
  // a bulk update would trip the unique index and abort the whole merge over
  // one duplicate hat.
  const guestItems = await ownedKeys(supabase, "user", guestRef);
  const accountItems = new Set(await ownedKeys(supabase, "user", accountRef));
  let moved = 0;
  for (const key of guestItems) {
    if (accountItems.has(key)) continue;
    const { error } = await supabase.from("vibe_inventory")
      .update({ owner_ref: accountRef })
      .eq("owner_kind", "user").eq("owner_ref", guestRef).eq("item_key", key);
    if (!error) moved += 1;
  }
  await supabase.from("vibe_guest_claims")
    .update({ items_moved: moved }).eq("guest_ref", guestRef);

  // The look comes across only if the account has never set one, so signing in
  // on a borrowed laptop cannot restyle an established character.
  const { data: existingLook } = await supabase.from("vibe_loadout")
    .select("owner_ref").eq("owner_kind", "user").eq("owner_ref", accountRef).maybeSingle();
  if (!existingLook) {
    const guestLook = await loadoutOf(supabase, "user", guestRef);
    await supabase.from("vibe_loadout").upsert(
      {
        owner_kind: "user", owner_ref: accountRef,
        hat: guestLook.hat, flame: guestLook.flame, jetpack: guestLook.jetpack,
        // Spelled out rather than spread: `loadoutOf` returns `character` and
        // the column is `char_id`, and a spread would post a column that does
        // not exist and fail the whole merge at the last step.
        char_id: guestLook.character,
      },
      { onConflict: "owner_kind,owner_ref" },
    );
  }

  return {
    claimed: guestBalance,
    itemsMoved: moved,
    balance: accountBalance + guestBalance,
  };
}

