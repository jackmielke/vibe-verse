/**
 * god-orb-wish — the God Orb's request line to the universe.
 *
 * POST { text, author?, owner_ref? }
 *
 * Players click the sky orb on Vibe Island and ask for anything. Each
 * wish is logged to public.universe_requests (the build queue) and
 * pinged straight to the builder's Telegram so it can be pasted into a
 * coding agent and granted. In-world promise: ~10 hours to exist;
 * the roadmap says ~10 minutes.
 *
 * Telegram delivery reuses the platform's community-bot plumbing
 * (communities.telegram_bot_token). Defaults are env-overridable:
 *   WISH_COMMUNITY_ID — whose bot pings (default: Memethology)
 *   WISH_CHAT_ID      — who gets pinged   (default: Jack)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_WISH_COMMUNITY = "ef5a123a-9e2a-4e0c-aeed-81d15aa56b0e";
const DEFAULT_WISH_CHAT = "5780091237";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const text = String(body.text ?? "").trim().slice(0, 500);
    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: "text required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const author = String(body.author ?? "anonymous").slice(0, 64);
    const ownerRef = body.owner_ref ? String(body.owner_ref).slice(0, 128) : null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Log the wish to the build queue.
    const { data: row, error: insErr } = await supabase
      .from("universe_requests")
      .insert({ text, author, owner_ref: ownerRef })
      .select("id, created_at")
      .single();
    if (insErr) throw insErr;

    // 2. Ping the builder on Telegram (best-effort — the wish is
    // already safely queued even if the ping fails).
    let pinged = false;
    try {
      const communityId = Deno.env.get("WISH_COMMUNITY_ID") ?? DEFAULT_WISH_COMMUNITY;
      const chatId = Deno.env.get("WISH_CHAT_ID") ?? DEFAULT_WISH_CHAT;
      const { data: comm } = await supabase
        .from("communities")
        .select("telegram_bot_token")
        .eq("id", communityId)
        .single();
      if (comm?.telegram_bot_token) {
        const msg =
          `🔮 God Orb wish from ${author}:\n\n` +
          `“${text}”\n\n` +
          `Paste it to your coding agent and grant it — the island promised ~10 hours.\n` +
          `id: ${row.id}`;
        const resp = await fetch(
          `https://api.telegram.org/bot${comm.telegram_bot_token}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: msg }),
          },
        );
        const result = await resp.json();
        pinged = !!result.ok;
      }
    } catch {
      /* queue insert already succeeded */
    }

    return new Response(JSON.stringify({ ok: true, id: row.id, pinged }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
