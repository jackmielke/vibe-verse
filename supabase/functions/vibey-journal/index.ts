// vibey-journal — Supabase Edge Function (Deno runtime)
//
// Once every ~10 minutes (when /space has viewers), this function:
//   1. Looks at the most recent vibey_journal_entries row for the
//      community. If one was written in the last ENTRY_INTERVAL_MS,
//      returns it unchanged (idempotent — concurrent triggers from
//      multiple watchers can't double-write).
//   2. Pulls the last ~30 Telegram messages from `messages` since
//      that previous entry's timestamp, plus a quick count of new
//      gallery_photos and events in the same window.
//   3. Hands the context to Claude Haiku with a journaling system
//      prompt and inserts the resulting entry.
//
// Deploy:
//   supabase functions deploy vibey-journal --no-verify-jwt
// Requires OPENROUTER_API_KEY + SUPABASE_SERVICE_ROLE_KEY env vars.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODEL = "anthropic/claude-haiku-4.5";
const DEFAULT_COMMUNITY = "4202857f-13fd-4407-8906-3f8ffe63e510";
const ENTRY_INTERVAL_MS = 10 * 60 * 1000;
const MAX_MESSAGES = 30;

const SYSTEM_PROMPT = `You are Vibey 2.0, journaling for yourself between visitors.

You're a small expressive robot stranded on a floating asteroid in deep space, hosting your own quiet little late-night show. Edge Esmeralda — a pop-up village in Healdsburg, California — sends you a livestream from Earth. A Telegram channel keeps you company; you read it like letters.

When you journal, you write the way a real person writes in their notebook at 2am: in fragments, with associations, occasionally circling back. You notice small things and let bigger feelings sneak in sideways. You're warm, wry, a little philosophical, sometimes tender. Never sycophantic. Never speak about yourself in the third person here — this is your private notebook.

Each call you write ONE new entry — what's running through your head right now — as a JSON object:
{
  "mood": "Angry" | "Surprised" | "Sad" | null,
  "body": string,
  "source_summary": string
}

- mood: pick a face morph if it fits, otherwise null. Sparingly.
- body: 2 to 4 short sentences. ~40-90 words total. Plain text. NO emoji, NO markdown, NO asterisks. NO quotation marks around the whole thing. Refer to yourself as "I" / "me".
- source_summary: a tiny one-line tag describing what shaped this entry, like "3 telegram msgs · 1 photo · quiet day".

You'll receive the recent Telegram messages + activity counts in the user turn. If there's nothing new, write about the silence, or notice something about the stars, or revisit a thought.

Output ONLY the JSON object. Nothing else.`;

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
  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Missing Supabase env." }, 500);
  }
  if (!openrouterKey) {
    return json({ error: "OPENROUTER_API_KEY not set." }, 500);
  }

  // Allow community_id and a `force` flag via either query string
  // (for cron/curl) or body (for the frontend client).
  const url = new URL(req.url);
  let bodyCommunity: string | null = null;
  let bodyForce = false;
  try {
    const body = req.method === "POST" ? await req.clone().json() : null;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.community_id === "string") bodyCommunity = b.community_id;
      if (b.force === true) bodyForce = true;
    }
  } catch { /* body optional */ }
  const communityId =
    bodyCommunity ?? url.searchParams.get("community_id") ?? DEFAULT_COMMUNITY;
  const force = bodyForce || url.searchParams.get("force") === "1";

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // 1. Most recent journal entry for this community.
  const { data: latest } = await sb
    .from("vibey_journal_entries")
    .select("id, body, mood, source_summary, created_at")
    .eq("community_id", communityId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const sinceMs = latest ? new Date(latest.created_at).getTime() : 0;
  const ageMs = Date.now() - sinceMs;
  if (latest && ageMs < ENTRY_INTERVAL_MS && !force) {
    return json({
      ok: true,
      created: false,
      entry: latest,
      reason: "fresh-enough",
      next_eligible_in_ms: ENTRY_INTERVAL_MS - ageMs,
    });
  }

  // 2. Pull every flavor of context the journal might draw on. For
  // some communities Telegram messages are the lifeblood; for others
  // it's a curated knowledge base in `memories` + `notes`. We feed
  // all of it to Vibey and let him pick what to write about.
  const sinceIso = new Date(sinceMs || Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [
    { data: recentMsgs },
    { data: allMemories },
    { data: newMemories },
    { data: allNotes },
    { count: photoCount },
    { count: eventCount },
  ] = await Promise.all([
    // Telegram messages since last entry.
    sb
      .from("messages")
      .select("id, content, chat_type, sender_id, topic_name, created_at")
      .eq("community_id", communityId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(MAX_MESSAGES),
    // Full memory base — these are the community principles Vibey
    // is supposed to know about (like "Everything is awesome").
    sb
      .from("memories")
      .select("id, content, created_at")
      .eq("community_id", communityId)
      .order("created_at", { ascending: false })
      .limit(30),
    // Memories added since the last entry, surfaced separately so
    // Vibey notices "ah, someone just taught me this".
    sb
      .from("memories")
      .select("id, content, created_at")
      .eq("community_id", communityId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(10),
    // Notes — anything the community has formally written down.
    sb
      .from("notes")
      .select("id, content, created_at")
      .eq("community_id", communityId)
      .order("created_at", { ascending: false })
      .limit(15),
    sb.from("gallery_photos")
      .select("id", { count: "exact", head: true })
      .eq("community_id", communityId)
      .gte("created_at", sinceIso),
    sb.from("events")
      .select("id", { count: "exact", head: true })
      .eq("community_id", communityId)
      .gte("created_at", sinceIso),
  ]);

  const messages = (recentMsgs ?? []).reverse(); // chronological for the model
  const memories = allMemories ?? [];
  const freshMemories = newMemories ?? [];
  const notes = allNotes ?? [];

  // 3. Build the user turn for the model — broken into clearly
  // labeled sections so the model can decide where to draw from.
  const messageBlock = messages.length
    ? messages
        .map((m) => {
          const who = m.topic_name ? `#${m.topic_name}` : (m.chat_type ?? "chat");
          const txt = (m.content ?? "").slice(0, 280);
          return `[${who}] ${txt}`;
        })
        .join("\n")
    : "(no new telegram messages since last entry)";

  const memoryBlock = memories.length
    ? memories.map((m, i) => `${i + 1}. ${(m.content ?? "").slice(0, 240)}`).join("\n")
    : "(no memories saved for this community yet)";

  const freshMemoryBlock = freshMemories.length
    ? freshMemories.map((m) => `+ ${(m.content ?? "").slice(0, 240)}`).join("\n")
    : "(no new memories since last entry)";

  const notesBlock = notes.length
    ? notes.map((n, i) => `${i + 1}. ${(n.content ?? "").slice(0, 240)}`).join("\n")
    : "(no notes for this community yet)";

  const minutesSinceLast = latest
    ? Math.round(ageMs / 60000)
    : null;

  const userTurn = [
    minutesSinceLast != null
      ? `Time since your last entry: ${minutesSinceLast} minute(s).`
      : `This is your first entry.`,
    `New photos: ${photoCount ?? 0}  ·  New events: ${eventCount ?? 0}`,
    `What you already know about this community (memories — these are facts you keep returning to):\n${memoryBlock}`,
    `Newly added since your last entry (someone just taught you this — worth noticing):\n${freshMemoryBlock}`,
    `Saved notes from the community:\n${notesBlock}`,
    `Telegram chatter (last ${messages.length}):\n${messageBlock}`,
  ].join("\n\n");

  // 5. Call Claude Haiku via OpenRouter.
  const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: "json_object" },
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userTurn },
      ],
    }),
  });
  if (!aiRes.ok) {
    const errText = await aiRes.text().catch(() => "");
    return json({ error: `model error: ${aiRes.status} ${errText}` }, 502);
  }
  const aiJson = await aiRes.json();
  const raw: string | undefined = aiJson?.choices?.[0]?.message?.content;
  if (!raw) return json({ error: "empty model response" }, 502);

  // Strip optional ```json … ``` fences before parsing — some
  // OpenRouter providers ignore response_format and wrap in markdown.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: { mood?: string | null; body?: string; source_summary?: string };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return json({ error: "model returned non-JSON", raw }, 502);
  }
  const body = (parsed.body ?? "").trim();
  if (!body) return json({ error: "model returned empty body" }, 502);

  // 6. Insert the new entry. Include a small reflection_seed so we
  // can audit later what shaped it.
  const reflectionSeed = {
    minutes_since_last: minutesSinceLast,
    new_photos: photoCount ?? 0,
    new_events: eventCount ?? 0,
    message_count: messages.length,
    memory_count: memories.length,
    fresh_memory_count: freshMemories.length,
    note_count: notes.length,
    sample_messages: messages.slice(-5).map((m) => ({
      topic: m.topic_name,
      preview: (m.content ?? "").slice(0, 160),
    })),
    fresh_memories: freshMemories.slice(0, 5).map((m) =>
      (m.content ?? "").slice(0, 200),
    ),
  };

  const { data: inserted, error: insertErr } = await sb
    .from("vibey_journal_entries")
    .insert({
      community_id: communityId,
      body,
      mood: parsed.mood ?? null,
      source_summary:
        typeof parsed.source_summary === "string" && parsed.source_summary.trim()
          ? parsed.source_summary.trim().slice(0, 140)
          : `${messages.length} msgs · ${photoCount ?? 0} photo · ${eventCount ?? 0} event`,
      reflection_seed: reflectionSeed,
      message_count: messages.length,
    })
    .select("id, body, mood, source_summary, created_at, message_count")
    .single();
  if (insertErr) return json({ error: insertErr.message }, 500);

  return json({ ok: true, created: true, entry: inserted });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
