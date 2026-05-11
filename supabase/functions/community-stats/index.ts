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
  let profileLimit = 36;
  try {
    const body = req.method === "GET" ? null : await req.clone().json();
    const requested = Number((body as { profiles_limit?: unknown } | null)?.profiles_limit);
    if (Number.isFinite(requested)) {
      profileLimit = Math.max(1, Math.min(60, Math.floor(requested)));
    }
  } catch {
    // Body is optional; default to a generous profile sample.
  }

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const [members, photos, events, memberRows, agentRow, memoryRows] =
    await Promise.all([
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
        .limit(200),
      sb
        .from("agents")
        .select("name, system_prompt, intro_message, model")
        .eq("community_id", communityId)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle(),
      // Memories aren't always tagged with a community_id — most rows
      // are about Edge Esmeralda but live globally. Pull recent ones
      // either way so Vibey's "knowledge orbit" actually has content.
      sb
        .from("memories")
        .select("content, tags, created_at")
        .order("created_at", { ascending: false })
        .limit(60),
    ]);

  // Two-step lookup avoids relying on a PostgREST foreign-key relationship.
  const userIds = (memberRows.data ?? [])
    .map((r) => (r as { user_id?: string }).user_id)
    .filter((x): x is string => Boolean(x));
  const roleByUserId = new Map<string, string>();
  for (const r of (memberRows.data ?? []) as Array<{ user_id?: string; role?: string }>) {
    if (r.user_id) roleByUserId.set(r.user_id, (r.role ?? "member").toString());
  }
  let userRows: Array<{
    id: string;
    name: string;
    avatar_url: string | null;
    profile_picture_url: string | null;
  }> = [];
  if (userIds.length) {
    const u = await sb
      .from("users")
      .select("id, name, avatar_url, profile_picture_url")
      .in("id", userIds)
      .not("name", "is", null);
    userRows = (u.data ?? []) as typeof userRows;
  }

  // We never echo raw avatar URLs to the client — Telegram-uploaded
  // ones embed the bot token in the path. Instead, return a stable
  // proxied URL pointing at the avatar-proxy edge function, which
  // resolves the user id server-side and streams back the bytes.
  const proxyBase = `${supabaseUrl}/functions/v1/avatar-proxy?u=`;
  const hasAnyAvatar = (u: { profile_picture_url: string | null; avatar_url: string | null }) =>
    !!(u.profile_picture_url || u.avatar_url);

  const profiles: {
    id: string;
    name: string;
    role: string;
    avatar: string | null;
  }[] = [];
  const seen = new Set<string>();
  for (const u of userRows) {
    if (!u?.id || !u?.name) continue;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    profiles.push({
      id: u.id,
      name: u.name,
      role: roleByUserId.get(u.id) ?? "member",
      avatar: hasAnyAvatar(u) ? `${proxyBase}${u.id}` : null,
    });
  }
  // Shuffle once, then prefer profiles with safe avatars at the front
  // so the visible orbit shows real photos when available.
  profiles.sort(() => Math.random() - 0.5);
  profiles.sort((a, b) => Number(!!b.avatar) - Number(!!a.avatar));

  // Vibey's "soul" — pull the active agent's name + system prompt.
  const agent = agentRow.data
    ? {
        name: (agentRow.data as { name?: string }).name ?? "Vibey",
        system_prompt:
          ((agentRow.data as { system_prompt?: string }).system_prompt ?? "")
            .slice(0, 4000),
        intro_message:
          (agentRow.data as { intro_message?: string }).intro_message ?? "",
        model: (agentRow.data as { model?: string }).model ?? "",
      }
    : null;

  // Vibey's "knowledge" — recent community memories, trimmed.
  const memories = ((memoryRows.data ?? []) as Array<{
    content?: string;
    tags?: string[] | null;
    created_at?: string;
  }>)
    .filter((m) => typeof m.content === "string" && m.content.trim())
    .slice(0, 24)
    .map((m) => ({
      content: m.content!.trim().slice(0, 280),
      tags: Array.isArray(m.tags) ? m.tags.slice(0, 4) : [],
      created_at: m.created_at ?? null,
    }));

  return json({
    stats: {
      members: members.count ?? 0,
      photos: photos.count ?? 0,
      events: events.count ?? 0,
    },
    profiles: profiles.slice(0, profileLimit),
    agent,
    memories,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
