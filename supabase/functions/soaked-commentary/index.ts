// SOAKED Commentary — Supabase Edge Function (Deno runtime)
//
// Turns one line of match commentary into speech and streams the audio back.
//
// Deploy:
//   supabase functions deploy soaked-commentary
// Requires ELEVENLABS_API_KEY (the same secret elevenlabs-conversation-token
// uses). Optionally SOAKED_COMMENTARY_VOICE_ID to override the voice.
//
// WHY THIS EXISTS RATHER THAN REUSING elevenlabs-conversation-token
// -----------------------------------------------------------------
// That function mints a signed URL for ElevenLabs *Conversational AI*: a
// two-way agent session with a microphone, turn-taking and a WebSocket. It is
// the right shape for talking to Vibey and the wrong shape for a commentator,
// who never listens, never takes a turn, and must not touch the mic. This is
// plain one-way text-to-speech: post a sentence, get back an mp3.
//
// THE MISSING-KEY CASE IS NOT AN ERROR
// ------------------------------------
// A project without the secret returns 503 and a reason. The caller treats
// that as "the commentator is off tonight" and the match carries on in
// silence — commentary is the last thing that should be able to break a game.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/** Adam — a stock ElevenLabs voice that reads as a broadcast booth. */
const FALLBACK_VOICE_ID = "pNInz6obpgDQGcFmaJgB";

/** Fast enough to land while the moment is still on screen. */
const MODEL_ID = "eleven_flash_v2_5";

/** One line of play-by-play. Anything longer is not commentary. */
const MAX_CHARS = 220;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST a { text } body." }, 405);

  const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
  if (!apiKey) {
    // 503, not 500: the service is unavailable, the request was fine.
    return json({ error: "ELEVENLABS_API_KEY is not set — commentary is off." }, 503);
  }

  let text = "";
  let voiceId = Deno.env.get("SOAKED_COMMENTARY_VOICE_ID") || FALLBACK_VOICE_ID;
  try {
    const body = await req.json();
    if (typeof body?.text === "string") text = body.text.trim().slice(0, MAX_CHARS);
    if (typeof body?.voiceId === "string" && body.voiceId.trim()) voiceId = body.voiceId.trim();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }
  if (!text) return json({ error: "Nothing to say." }, 400);

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        // Low stability and high style is what makes a commentator sound like
        // one: excitable, uneven, leaning into the moment. A narrator read is
        // stable and would flatten every elimination into the same sentence.
        voice_settings: { stability: 0.32, similarity_boost: 0.75, style: 0.55, use_speaker_boost: true },
      }),
    },
  );

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return json({ error: "ElevenLabs refused the line.", status: upstream.status, detail: detail.slice(0, 400) }, 502);
  }

  return new Response(upstream.body, {
    headers: {
      ...CORS,
      "Content-Type": "audio/mpeg",
      // The same line for the same event is worth re-serving from cache; the
      // client also dedupes, but a reload should not re-bill a fresh render.
      "Cache-Control": "public, max-age=3600",
    },
  });
});
