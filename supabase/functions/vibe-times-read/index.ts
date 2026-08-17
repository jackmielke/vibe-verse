// vibe-times-read — Supabase Edge Function
//
// Vibey reads the paper out loud.
//
// The front-door strip has said "brought to you by Vibey" since before the
// presses ran themselves, and Vibey did not, in fact, read anything. This
// is the part that makes that line true: it turns the morning's issue into
// a ninety-second bulletin and hands back an mp3.
//
// The important thing here is the caching. An edition is the same edition
// for everybody, so it is synthesised ONCE — the first person to press play
// pays the two seconds, and every reader after them gets a static file off
// the CDN. Without that, a paper that anyone can listen to is a paper that
// bills per listener, and the button would have to be hidden or metered.
//
// The script is built HERE, from the stored issue, and never taken from the
// caller. Otherwise this is an open text-to-speech endpoint with somebody
// else's API key behind it, and the internet would find it by Tuesday.
//
// Routes:
//   POST /vibe-times-read {issue?: number}  → { url, cached, script }
//
// Deploy:
//   supabase functions deploy vibe-times-read --no-verify-jwt
// Env:
//   ELEVENLABS_API_KEY        — required (falls back to browser speech)
//   SUPABASE_SERVICE_ROLE_KEY — required
//   VIBE_TIMES_VOICE_ID       — optional, ElevenLabs voice
//   VIBE_TIMES_VOICE_MODEL    — optional, default eleven_turbo_v2_5

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "vibe-times-audio";
// "Rachel" — a warm, unhurried reading voice, and one every ElevenLabs
// account has. Override with VIBE_TIMES_VOICE_ID once Vibey has its own.
const VOICE = Deno.env.get("VIBE_TIMES_VOICE_ID") ?? "21m00Tcm4TlvDq8ikWAM";
const VOICE_MODEL = Deno.env.get("VIBE_TIMES_VOICE_MODEL") ?? "eleven_turbo_v2_5";
// 22kHz mono at 32kbps. The default is CD-ish stereo, which turned a
// ninety-second bulletin into a 3.5 MB download; this is under a megabyte
// and sounds identical for one person talking.
const AUDIO_FORMAT = "mp3_22050_32";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Issue {
  issue: number;
  date: string;
  motto?: string;
  headlines?: { headline: string; body: string }[];
  dispatches?: { headline: string; body: string; source: string }[];
  letters?: { author: string; text: string; note: string }[];
  weather?: string;
  vibey_says?: string;
}

/**
 * The bulletin.
 *
 * Not the paper read cover to cover — a minute and a half of it, in the
 * order a person would actually want it: what happened here, then one thing
 * from outside, then a letter if anyone wrote, then Vibey. Emoji, urls and
 * the stats block are all left out, because none of them can be spoken.
 */
function readingScript(issue: Issue): string {
  const spoken = (s?: string) =>
    (s ?? "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();

  const day = new Date(`${issue.date}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
  });

  const lines: string[] = [
    `This is The Vibe Times for ${day}. ${spoken(issue.motto)}.`,
  ];

  const [lead, ...rest] = issue.headlines ?? [];
  if (lead) lines.push(`Our lead story. ${spoken(lead.headline)}. ${spoken(lead.body)}`);
  for (const h of rest.slice(0, 2)) lines.push(`${spoken(h.headline)}. ${spoken(h.body)}`);

  const wire = (issue.dispatches ?? [])[0];
  if (wire) lines.push(`From outside the sky. ${spoken(wire.headline)}. ${spoken(wire.body)}`);

  const letter = (issue.letters ?? [])[0];
  if (letter) {
    lines.push(`A letter, from ${spoken(letter.author)}. ${spoken(letter.text)}`);
    if (letter.note) lines.push(`The editor replies. ${spoken(letter.note)}`);
  }

  if (issue.weather) lines.push(`And the sky. ${spoken(issue.weather)}`);
  if (issue.vibey_says) lines.push(`One more thing, from me. ${spoken(issue.vibey_says)}`);
  lines.push("That was the paper. Go and look at something.");

  return lines.filter(Boolean).join("\n\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "missing Supabase env" }, 500);
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const body = (await req.json().catch(() => ({}))) as { issue?: number };

  // Which edition. Only ever one that is actually published — this reads
  // out of the same table the page does, so there is nothing to read that
  // a reader could not already see in print.
  const query = sb
    .from("vibe_times_issues")
    .select("issue,payload")
    .eq("status", "published")
    .order("edition_date", { ascending: false })
    .limit(1);
  const { data, error } = await (typeof body.issue === "number"
    ? sb.from("vibe_times_issues").select("issue,payload").eq("status", "published").eq("issue", body.issue).limit(1)
    : query);
  if (error) return json({ error: error.message }, 500);
  const row = (data ?? [])[0];
  if (!row) return json({ error: "no issue to read" }, 404);

  const issue = row.payload as Issue;
  const script = readingScript(issue);
  // The encoding is part of the key. Change the bitrate and every edition
  // re-renders on next play instead of quietly serving the old file back
  // forever — which is exactly what happened when this was just the issue
  // number and the first day's audio was four times the size it needed.
  const path = `issue-${row.issue}-${AUDIO_FORMAT}.mp3`;
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;

  // Already read this one? Hand back the same file. This is the whole
  // reason the button is safe to leave on a public page.
  const { data: existing } = await sb.storage.from(BUCKET).list("", { search: path });
  if ((existing ?? []).some((f: { name: string }) => f.name === path)) {
    return json({ url: publicUrl, cached: true, script });
  }

  const key = Deno.env.get("ELEVENLABS_API_KEY");
  if (!key) return json({ error: "no voice configured", script }, 503);

  const tts = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=${AUDIO_FORMAT}`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: script,
        model_id: VOICE_MODEL,
        voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.2 },
      }),
    },
  );
  if (!tts.ok) {
    // The page can still read it in the browser's own voice, so this is a
    // downgrade rather than a failure. Say which, so it is debuggable.
    const detail = (await tts.text()).slice(0, 200);
    console.error("elevenlabs:", tts.status, detail);
    return json({ error: `voice unavailable (${tts.status})`, script }, 503);
  }

  const audio = new Uint8Array(await tts.arrayBuffer());
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, audio, {
    contentType: "audio/mpeg",
    upsert: true,
  });
  if (upErr) {
    console.error("upload:", upErr.message);
    return json({ error: "could not store the recording", script }, 500);
  }

  return json({ url: publicUrl, cached: false, script, bytes: audio.length });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
