// vibey-identity — Supabase Edge Function
//
// Returns the live agent config for the community's active Vibey:
// system prompt (the "soul"), skills, model, temperature, intro
// message, avatar. The journal's "Notes to Self" page reads this
// so visitors see exactly the instructions Vibey is operating from
// in real time — and any tweaks to the agent row propagate instantly.
//
// Deploy:
//   supabase functions deploy vibey-identity --no-verify-jwt

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_COMMUNITY = "4202857f-13fd-4407-8906-3f8ffe63e510";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Missing Supabase env." }, 500);
  }

  // Accept community_id via query OR body for flexibility.
  const url = new URL(req.url);
  let bodyCommunity: string | null = null;
  try {
    const body = req.method === "POST" ? await req.clone().json() : null;
    if (body && typeof (body as Record<string, unknown>).community_id === "string") {
      bodyCommunity = (body as { community_id: string }).community_id;
    }
  } catch { /* body optional */ }
  const communityId =
    bodyCommunity ?? url.searchParams.get("community_id") ?? DEFAULT_COMMUNITY;

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Prefer the active agent; fall back to most-recent if none is flagged active.
  const { data: active, error: aErr } = await sb
    .from("agents")
    .select(
      "id, name, avatar_url, intro_message, model, temperature, skills, telegram_enabled, system_prompt, updated_at",
    )
    .eq("community_id", communityId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (aErr) return json({ error: aErr.message }, 500);

  let agent = active;
  if (!agent) {
    const { data: fallback } = await sb
      .from("agents")
      .select(
        "id, name, avatar_url, intro_message, model, temperature, skills, telegram_enabled, system_prompt, updated_at",
      )
      .eq("community_id", communityId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    agent = fallback ?? null;
  }
  if (!agent) {
    return json({ error: "no agent configured for this community" }, 404);
  }

  // The soul = system_prompt. We don't transform it server-side; we
  // let the client paginate or render it however it wants.
  return json({
    ok: true,
    community_id: communityId,
    agent: {
      id: agent.id,
      name: agent.name,
      avatar_url: agent.avatar_url,
      intro_message: agent.intro_message,
      model: agent.model,
      temperature: agent.temperature,
      skills: agent.skills ?? [],
      telegram_enabled: agent.telegram_enabled,
      system_prompt: agent.system_prompt,
      updated_at: agent.updated_at,
    },
  });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
