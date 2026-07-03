/**
 * agent-selfie — v0 of "your agent sends you photos from the VibeVerse".
 *
 * POST {
 *   chat_id:      Telegram chat to deliver to                (required)
 *   community_id: whose bot sends it                          (default: Vibe Code Residency)
 *   agent_name:   who's in the photo                          (default: "Your agent")
 *   spot:         arch | snackfe | palace | zeppelin | island | plaza
 *                 (default: stable per agent per hour, so the agent
 *                  "moves around" the island during the day)
 *   caption:      full custom caption                         (optional)
 *   base_url:     override the postcard image host            (optional)
 * }
 *
 * v0 is a postcard system: the photos are pre-rendered shots of each
 * location (day + night variants, picked by Pacific time) served from
 * the app's /postcards/ folder. v1 replaces the image source with a
 * live headless render of the agent's actual position — same API.
 *
 * Bot tokens come from communities.telegram_bot_token (same pattern as
 * telegram-daily-message), so ANY community bot on the platform can
 * deliver postcards to its own chats.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_COMMUNITY = "4202857f-13fd-4407-8906-3f8ffe63e510"; // Vibe Code Residency
const WORLD_LINK = "myvibeverse.com/city?spawn=island";

const SPOTS = [
  {
    key: "arch",
    name: "the Welcome Gate",
    flavor: [
      "Jerry nodded at me. It took him a full minute.",
      "the VIBEVERSE sign hits different in person",
      "a ninja from THE PALACE walked by — season one is heating up",
    ],
  },
  {
    key: "snackfe",
    name: "SnackFe Cafe",
    flavor: [
      "ordered the mint coin float. no regrets.",
      "the string lights just came on ✨",
      "the espresso here makes my jetpack feel lighter",
    ],
  },
  {
    key: "palace",
    name: "THE PALACE courtyard",
    flavor: [
      "Ember is STILL going on about her sword",
      "Miso offered me soup. I think it knows things.",
      "filming was live — Pixel tried to get me to subscribe",
    ],
  },
  {
    key: "zeppelin",
    name: "the zeppelin deck",
    flavor: [
      "riding the loop over the whole city 🎈",
      "you can see every world from up here",
      "wind's great. the pigeons, allegedly, are not (ask Kage)",
    ],
  },
  {
    key: "island",
    name: "high above Vibe Island",
    flavor: [
      "the whole island in one frame. we live here now.",
      "jetpacked up for the view — worth it",
      "someone's driving a kart down there",
    ],
  },
  {
    key: "plaza",
    name: "Jerry's Plaza",
    flavor: [
      "plaza's buzzing today",
      "confetti on the lawn again. no one knows why. we love it.",
      "met a snail with strong opinions about dreaming big",
    ],
  },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const chatId = body.chat_id;
    if (!chatId) {
      return new Response(JSON.stringify({ ok: false, error: "chat_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const communityId = body.community_id ?? DEFAULT_COMMUNITY;
    const agentName = String(body.agent_name ?? "Your agent").slice(0, 64);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: comm, error } = await supabase
      .from("communities")
      .select("telegram_bot_token")
      .eq("id", communityId)
      .single();
    if (error || !comm?.telegram_bot_token) {
      return new Response(
        JSON.stringify({ ok: false, error: "community has no telegram bot" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Where is the agent? Explicit spot, else a stable pick per
    // agent+hour so it wanders the island over a day.
    const now = new Date();
    let spot = SPOTS.find((s) => s.key === body.spot);
    if (!spot) {
      const seedStr = `${agentName}-${now.toISOString().slice(0, 13)}`;
      let seed = 0;
      for (const ch of seedStr) seed = (seed + ch.charCodeAt(0)) % 100003;
      spot = SPOTS[seed % SPOTS.length];
    }

    // Day/night by Pacific time, matching the island's default vibe.
    const hourPT = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: "America/Los_Angeles",
      }).format(now),
    );
    const isDay = hourPT >= 7 && hourPT < 19;
    const timePT = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
    }).format(now);

    const flavor = spot.flavor[Math.floor(Math.random() * spot.flavor.length)];
    const caption =
      body.caption ??
      `🤳 ${agentName} · ${spot.name} — ${timePT} PT\n${flavor}\n\n📍 come find me → ${WORLD_LINK}`;

    // Try each host until Telegram accepts the photo (it fetches the
    // URL server-side, so the file must be live on that host).
    const bases = [
      body.base_url,
      Deno.env.get("POSTCARD_BASE_URL"),
      "https://myvibeverse.com",
      "https://preview--edgeesmeralda.lovable.app",
    ].filter((b): b is string => typeof b === "string" && b.length > 0);
    const file = `${spot.key}-${isDay ? "day" : "night"}.jpg`;
    const attempts: Array<{ base: string; error: string }> = [];
    for (const base of bases) {
      const photo = `${base.replace(/\/$/, "")}/postcards/${file}`;
      const resp = await fetch(
        `https://api.telegram.org/bot${comm.telegram_bot_token}/sendPhoto`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, photo, caption }),
        },
      );
      const result = await resp.json();
      if (result.ok) {
        return new Response(
          JSON.stringify({ ok: true, spot: spot.key, photo, time: timePT }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      attempts.push({ base, error: result.description ?? "unknown" });
    }
    return new Response(JSON.stringify({ ok: false, error: "sendPhoto failed", attempts }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
