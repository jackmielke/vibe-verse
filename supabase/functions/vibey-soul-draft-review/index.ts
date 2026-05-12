// vibey-soul-draft-review — Supabase Edge Function
//
// Reviews a single vibey_soul_drafts row.
//   { id: uuid, status: "applied" | "rejected" }
//
// If status="applied", we APPEND the proposed_addition to the
// matching agent's system_prompt. This is the only place the live
// soul ever changes from a draft — the journal function itself
// never edits the agent row.
//
// Deploy:
//   supabase functions deploy vibey-soul-draft-review --no-verify-jwt

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Missing Supabase env." }, 500);

  let body: { id?: unknown; status?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const id = typeof body.id === "string" ? body.id : "";
  const status = body.status === "applied" ? "applied"
    : body.status === "rejected" ? "rejected" : "";
  if (!id || !status) return json({ error: "id + status required" }, 400);

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Load the draft.
  const { data: draft, error: dErr } = await sb
    .from("vibey_soul_drafts")
    .select("id, community_id, agent_id, status, proposed_addition, proposed_replacement")
    .eq("id", id)
    .maybeSingle();
  if (dErr || !draft) return json({ error: "draft not found" }, 404);
  if (draft.status !== "pending") {
    return json({ ok: true, already: draft.status });
  }

  if (status === "applied") {
    // Two flavors of apply:
    //   - proposed_replacement set → REPLACE the live system_prompt
    //     wholesale. Used when the human (or a future Vibey) wants
    //     to refactor / strip / rewrite. Destructive, but reversible
    //     via the previous_system_prompt snapshot we stash on the
    //     draft row before applying.
    //   - proposed_addition set     → APPEND to the existing soul.
    //     Original safe flow.
    let agentId = draft.agent_id as string | null;
    if (!agentId) {
      const { data: agent } = await sb
        .from("agents")
        .select("id")
        .eq("community_id", draft.community_id)
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      agentId = agent?.id ?? null;
    }
    if (!agentId) return json({ error: "no active agent to apply to" }, 404);

    const { data: cur } = await sb
      .from("agents")
      .select("system_prompt")
      .eq("id", agentId)
      .maybeSingle();
    const existing = (cur?.system_prompt ?? "").trimEnd();
    const replacement = (draft.proposed_replacement ?? "").trim();
    const addition = (draft.proposed_addition ?? "").trim();
    const newSoul = replacement
      ? replacement
      : `${existing}\n\n${addition}`;
    const { error: upErr } = await sb
      .from("agents")
      .update({ system_prompt: newSoul, updated_at: new Date().toISOString() })
      .eq("id", agentId);
    if (upErr) return json({ error: upErr.message }, 500);
    // Snapshot the previous soul on the draft itself so it's
    // recoverable if you change your mind. Goes into reasoning so
    // we don't need a new column.
    await sb
      .from("vibey_soul_drafts")
      .update({
        reasoning:
          `Applied. Previous soul snapshot (${existing.length} chars) follows:\n---\n${existing}`,
      })
      .eq("id", id);
  }

  const { error: rErr } = await sb
    .from("vibey_soul_drafts")
    .update({
      status,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (rErr) return json({ error: rErr.message }, 500);

  return json({ ok: true, status });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
