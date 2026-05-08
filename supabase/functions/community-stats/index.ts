// Community Stats — Supabase Edge Function
//
// Returns live counts + a sample of named members for the playground
// to render around the platform. RLS on community_members blocks anon
// SELECT, so we use the service-role key here to read public-ish data
// in a controlled, narrow shape (id + name + role only).
//
// Deploy:
//   supabase functions deploy community-stats

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
};

const DEFAULT_COMMUNITY = "4202857f-13fd-4407-8906-3f8ffe63e510";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Edge function is missing Supabase env." }, 500);
  }

  const url = new URL(req.url);
  const communityId = url.searchParams.get("community_id") ?? DEFAULT_COMMUNITY;

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const [members, photos, events, memberRows] = await Promise.all([
    sb
      .from("community_members")
      .select("*", { count: "exact", head: true })
      .eq("community_id", communityId),
    sb
      .from("gallery_photos")
      .select("*", { count: "exact", head: true })
      .eq("community_id", communityId)
      .eq("is_visible", true),
    sb
      .from("events")
      .select("*", { count: "exact", head: true })
      .eq("community_id", communityId),
    sb
      .from("community_members")
      .select("user_id, role")
      .eq("community_id", communityId)
      .limit(120),
  ]);

  // Two-step lookup avoids relying on a PostgREST foreign-key relationship.
  const userIds = (memberRows.data ?? [])
    .map((r) => (r as { user_id?: string }).user_id)
    .filter((x): x is string => Boolean(x));
  const roleByUserId = new Map<string, string>();
  for (const r of (memberRows.data ?? []) as Array<{ user_id?: string; role?: string }>) {
    if (r.user_id) roleByUserId.set(r.user_id, (r.role ?? "member").toString());
  }
  let userRows: Array<{ id: string; name: string }> = [];
  if (userIds.length) {
    const u = await sb
      .from("users")
      .select("id, name")
      .in("id", userIds)
      .not("name", "is", null);
    userRows = (u.data ?? []) as Array<{ id: string; name: string }>;
  }
  const profiles: { id: string; name: string; role: string }[] = [];
  const seen = new Set<string>();
  for (const u of userRows) {
    if (!u?.id || !u?.name) continue;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    profiles.push({
      id: u.id,
      name: u.name,
      role: roleByUserId.get(u.id) ?? "member",
    });
  }
  // Shuffle and trim to 14.
  profiles.sort(() => Math.random() - 0.5);

  return json({
    stats: {
      members: members.count ?? 0,
      photos: photos.count ?? 0,
      events: events.count ?? 0,
    },
    profiles: profiles.slice(0, 14),
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
