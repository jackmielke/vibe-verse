// Avatar Proxy — Supabase Edge Function
//
// Returns a user's avatar image bytes by user id, hiding the source
// URL (which for Telegram-uploaded avatars contains the bot token in
// the path). The client requests:
//   GET /functions/v1/avatar-proxy?u=<user_id>
// and gets back the image with permissive CORS so a CanvasTexture can
// composite it without tainting.
//
// Deploy:
//   supabase functions deploy avatar-proxy

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return placeholder("missing env");
  }
  const url = new URL(req.url);
  const userId = url.searchParams.get("u");
  if (!userId) return placeholder("no user id");

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await sb
    .from("users")
    .select("profile_picture_url, avatar_url, telegram_photo_url")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return placeholder("no row");

  const candidates = [
    (data as { profile_picture_url?: string | null }).profile_picture_url,
    (data as { avatar_url?: string | null }).avatar_url,
    (data as { telegram_photo_url?: string | null }).telegram_photo_url,
  ].filter((s): s is string => !!s);

  if (!candidates.length) return placeholder("no avatar");

  // Try each candidate URL until one fetches successfully. Telegram
  // URLs contain a bot token — that token is what lets us fetch the
  // bytes here, but we never echo the URL back to the client.
  for (const src of candidates) {
    try {
      const resp = await fetch(src, {
        // No 'Accept' restriction — Telegram serves jpeg as
        // application/octet-stream sometimes; we forward whatever
        // the upstream sends.
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) continue;
      const bytes = await resp.arrayBuffer();
      const ct = resp.headers.get("content-type") ?? "image/jpeg";
      return new Response(bytes, {
        status: 200,
        headers: {
          ...CORS,
          "content-type": ct,
          "cache-control": "public, max-age=3600, s-maxage=86400",
        },
      });
    } catch {
      // try next candidate
    }
  }
  return placeholder("all fetches failed");
});

// 1x1 transparent png so the client gets a valid image even on miss.
function placeholder(reason: string) {
  const empty = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
    ),
    (c) => c.charCodeAt(0),
  );
  return new Response(empty, {
    status: 200,
    headers: {
      ...CORS,
      "content-type": "image/png",
      "cache-control": "public, max-age=300",
      "x-avatar-miss": reason,
    },
  });
}
