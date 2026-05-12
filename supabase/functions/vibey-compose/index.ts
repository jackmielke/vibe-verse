// vibey-compose — Supabase Edge Function
//
// Single endpoint humans use to compose alongside Vibey. Three kinds:
//
//   POST { kind: "seed", text, community_id?, author_name? }
//     → inserts a row into vibey_seeds. The journal function picks
//       up active seeds in its next cycle, mentions them in the
//       prompt, and marks them consumed once an entry references
//       them (or after 24h regardless).
//
//   POST { kind: "draft", addition, reasoning?, diff_summary?,
//          community_id?, author_name? }
//     → inserts a human-authored row into vibey_soul_drafts as
//       status='pending'. Reviewable from the Overnight tab just
//       like Vibey-authored drafts.
//
//   POST { kind: "memory", content, community_id?, author_name? }
//     → inserts a row into the public memories table for the
//       community. Becomes permanent context Vibey draws on.
//
// Auth is soft — we forward the caller's JWT and stamp author info
// when present, but anonymous use is allowed so the frontend stays
// simple. (RLS on the underlying tables is the real gate.)
//
// Deploy: supabase functions deploy vibey-compose --no-verify-jwt

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_COMMUNITY = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

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
  if (!supabaseUrl || !serviceKey)
    return json({ error: "Missing Supabase env." }, 500);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const kind = typeof body.kind === "string" ? body.kind : "";
  const communityId =
    typeof body.community_id === "string" ? body.community_id : DEFAULT_COMMUNITY;
  const authorName =
    typeof body.author_name === "string" ? body.author_name.slice(0, 80) : null;

  // Try to identify the caller from their JWT (if present). We don't
  // require it — but if they're logged in, we stamp their auth user
  // id on the row so audit logs are honest.
  let authUserId: string | null = null;
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const userClient = createClient(supabaseUrl, authHeader.slice(7), {
        auth: { persistSession: false },
      });
      const { data } = await userClient.auth.getUser();
      authUserId = data?.user?.id ?? null;
    } catch { /* anonymous is fine */ }
  }

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  if (kind === "seed") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text required" }, 400);
    const { data, error } = await sb
      .from("vibey_seeds")
      .insert({
        community_id: communityId,
        author_user_id: authUserId,
        author_name: authorName,
        text: text.slice(0, 2000),
      })
      .select("id, text, created_at")
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, seed: data });
  }

  if (kind === "draft") {
    // Two shapes:
    //   { addition }    → append-style (default).
    //   { replacement } → full soul rewrite. Lands in proposed_replacement
    //                     so the review function knows to swap, not append.
    const addition = typeof body.addition === "string" ? body.addition.trim() : "";
    const replacement = typeof body.replacement === "string" ? body.replacement.trim() : "";
    if (!addition && !replacement) {
      return json({ error: "addition or replacement required" }, 400);
    }
    const reasoning =
      typeof body.reasoning === "string" ? body.reasoning.slice(0, 1000) : null;
    const diffSummary =
      typeof body.diff_summary === "string"
        ? body.diff_summary.slice(0, 140)
        : replacement
        ? `Full soul rewrite from ${authorName ?? "a human"}`
        : `From ${authorName ?? "a human"}`;

    const { data: agent } = await sb
      .from("agents")
      .select("id")
      .eq("community_id", communityId)
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const insertRow: Record<string, unknown> = {
      community_id: communityId,
      agent_id: agent?.id ?? null,
      status: "pending",
      reasoning: reasoning ?? `Suggested by ${authorName ?? "a human"}`,
      diff_summary: diffSummary,
    };
    if (replacement) {
      insertRow.proposed_replacement = replacement.slice(0, 10_000);
    } else {
      insertRow.proposed_addition = addition.slice(0, 2000);
    }

    const { data, error } = await sb
      .from("vibey_soul_drafts")
      .insert(insertRow)
      .select("id, proposed_addition, proposed_replacement, diff_summary, created_at")
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, draft: data });
  }

  if (kind === "memory") {
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) return json({ error: "content required" }, 400);
    const { data, error } = await sb
      .from("memories")
      .insert({
        community_id: communityId,
        content: content.slice(0, 2000),
      })
      .select("id, content, created_at")
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, memory: data });
  }

  return json({ error: `unknown kind: ${kind}` }, 400);
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
