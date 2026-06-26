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
