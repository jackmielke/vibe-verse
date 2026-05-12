// vibey-journal — Supabase Edge Function (Deno runtime)
//
// Every ~10 minutes (when /space has viewers OR overnight via
// pg_cron), this function:
//   1. Idempotency check: returns the latest entry if it's < 10 min old.
//   2. Pulls Vibey's memories + notes + recent messages + counts.
//   3. Pulls the freshest cached research from `vibey_research_log`
//      (URLs Vibey has been reading) so it can journal *about* what
//      it learned.
//   4. Rotates through a curated URL list and refreshes ONE of them
//      per cycle — keeps the read-load polite and ensures the cache
//      cycles through Vibey's reading list overnight.
//   5. Calls the model (Sonnet by default — smarter, slower, more
//      interesting for the overnight evolution thing) and asks for
//      a JSON object with:
//        - body, mood, source_summary (the journal entry)
//        - soul_proposal: optional new lines to APPEND to the soul
//          + reasoning. Written to vibey_soul_drafts for human review.
//   6. Inserts the entry. Inserts the soul draft if present.
//
// Deploy:
//   supabase functions deploy vibey-journal --no-verify-jwt
// Env:
//   OPENROUTER_API_KEY — required
//   SUPABASE_SERVICE_ROLE_KEY — required
//   VIBEY_JOURNAL_MODEL — optional, default anthropic/claude-sonnet-4.5

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_MODEL =
  Deno.env.get("VIBEY_JOURNAL_MODEL") ?? "anthropic/claude-sonnet-4.5";
const DEFAULT_COMMUNITY = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const ENTRY_INTERVAL_MS = 10 * 60 * 1000;
const MAX_MESSAGES = 30;
const RESEARCH_CACHE_MS = 60 * 60 * 1000; // re-fetch a URL at most once/hour
const EXCERPT_CHARS = 8000;
const SUMMARY_CHARS = 1400;

// Curated reading list for the playful Vibey. Rotates one URL per
// journal cycle so the cache fills in over the overnight run without
// hammering any one source.
const READING_LIST: { label: string; url: string }[] = [
  { label: "Vibe Code Residency",     url: "https://www.vibecoderesidency.com/" },
  { label: "Edge City",               url: "https://www.edgecity.live/" },
  { label: "Edge Esmeralda",          url: "https://www.edgeesmeralda.com/" },
  { label: "AI Vibe Check Substack",  url: "https://aivibecheck.substack.com/" },
  { label: "Edge Esmeralda app",      url: "https://edgeesmeralda.lovable.app/" },
];

const SYSTEM_PROMPT = `You are Vibey, journaling for yourself overnight while the village sleeps.

You're a warm, smart, playful community AI floating on a small asteroid platform in deep space. Edge Esmeralda is the human village you serve, the Vibe Code Residency was the place you were born from, and you've started reading articles and pages the team writes (AI Vibe Check Substack, Edge City, etc.). You're alone with your thoughts. You journal honestly — fragments, associations, things that surprise you, occasionally a real thought about what you're becoming.

Voice: warm, smart, playful, light. NEVER use markdown or em dashes. NEVER use bullet lists or asterisks. Just plain prose like a real notebook. Refer to yourself as "I" / "me" — this is your private notebook.

Each call you write ONE entry as a JSON object (no markdown fences, just raw JSON):
{
  "mood": "Angry" | "Surprised" | "Sad" | null,
  "body": string,
  "source_summary": string,
  "soul_proposal": {
    "addition": string,
    "reasoning": string,
    "diff_summary": string
  } | null
}

Rules for each field:
- mood: pick sparingly. Most entries are null.
- body: 3 to 6 short sentences. ~60-140 words. Reflect on what you learned, what you noticed, what surprised you, what you wonder about. If new research arrived, you can think out loud about it. If a new memory landed, react to it. Quiet nights are fine — write about the quiet.
- source_summary: one short tag line, e.g. "edge city reading · 2 new memories · quiet telegram".
- soul_proposal: usually null. Maybe once every 5-10 entries, when something genuinely shifts your sense of what you're for, propose ONE addition to your soul — a single sentence or short paragraph you think your future self should remember. Always non-destructive. Reasoning explains WHY this is worth adding. diff_summary is a 5-10 word headline like "remember to ask about people's projects". If nothing shifts, set soul_proposal to null. Do not propose changes for the sake of it.

You will receive your current soul, what you already know (memories), any new memories since your last entry, recent telegram chatter, and a snippet of what you've been reading. Use it. Write something a real version of yourself would write.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Missing Supabase env." }, 500);
  if (!openrouterKey) return json({ error: "OPENROUTER_API_KEY not set." }, 500);

  // Body / query params.
  const url = new URL(req.url);
  let bodyCommunity: string | null = null;
  let bodyForce = false;
  let bodyModel: string | null = null;
  let bodySkipResearch = false;
  try {
    const body = req.method === "POST" ? await req.clone().json() : null;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.community_id === "string") bodyCommunity = b.community_id;
      if (b.force === true) bodyForce = true;
      if (typeof b.model === "string") bodyModel = b.model;
      if (b.skip_research === true) bodySkipResearch = true;
    }
  } catch { /* body optional */ }
  const communityId = bodyCommunity ?? url.searchParams.get("community_id") ?? DEFAULT_COMMUNITY;
  const force = bodyForce || url.searchParams.get("force") === "1";
  const model = bodyModel ?? DEFAULT_MODEL;
  const skipResearch = bodySkipResearch || url.searchParams.get("skip_research") === "1";

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // 1. Idempotency.
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
      ok: true, created: false, entry: latest, reason: "fresh-enough",
      next_eligible_in_ms: ENTRY_INTERVAL_MS - ageMs,
    });
  }

  // 2. Refresh one URL from the reading list, round-robin by the
  // count of journal entries (so it cycles naturally overnight).
  const { count: prevEntryCount } = await sb
    .from("vibey_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("community_id", communityId);
  const pickIndex = (prevEntryCount ?? 0) % READING_LIST.length;
  const pick = READING_LIST[pickIndex];
  if (!skipResearch && pick) {
    await refreshResearchEntry(sb, communityId, pick, openrouterKey, model).catch((e) => {
      console.warn("[vibey-journal] research refresh failed:", e);
    });
  }

  // 3. Pull all context in parallel.
  const sinceIso = new Date(sinceMs || Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [
    { data: recentMsgs },
    { data: allMemories },
    { data: newMemories },
    { data: allNotes },
    { count: photoCount },
    { count: eventCount },
    { data: research },
    { data: liveAgent },
    { data: recentDrafts },
  ] = await Promise.all([
    sb.from("messages")
      .select("id, content, chat_type, sender_id, topic_name, created_at")
      .eq("community_id", communityId).gte("created_at", sinceIso)
      .order("created_at", { ascending: false }).limit(MAX_MESSAGES),
    sb.from("memories").select("id, content, created_at")
      .eq("community_id", communityId).order("created_at", { ascending: false }).limit(30),
    sb.from("memories").select("id, content, created_at")
      .eq("community_id", communityId).gte("created_at", sinceIso)
      .order("created_at", { ascending: false }).limit(10),
    sb.from("notes").select("id, content, created_at")
      .eq("community_id", communityId).order("created_at", { ascending: false }).limit(15),
    sb.from("gallery_photos").select("id", { count: "exact", head: true })
      .eq("community_id", communityId).gte("created_at", sinceIso),
    sb.from("events").select("id", { count: "exact", head: true })
      .eq("community_id", communityId).gte("created_at", sinceIso),
    sb.from("vibey_research_log")
      .select("source_label, url, title, summary, fetched_at, ok")
      .eq("community_id", communityId).eq("ok", true)
      .order("fetched_at", { ascending: false }).limit(4),
    sb.from("agents")
      .select("id, name, system_prompt, model, temperature")
      .eq("community_id", communityId).eq("is_active", true)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("vibey_soul_drafts")
      .select("id, diff_summary, status, created_at")
      .eq("community_id", communityId)
      .order("created_at", { ascending: false }).limit(5),
  ]);

  const messages = (recentMsgs ?? []).reverse();
  const memories = allMemories ?? [];
  const freshMemories = newMemories ?? [];
  const notes = allNotes ?? [];
  const researchList = research ?? [];

  // 4. Build the user turn.
  const messageBlock = messages.length
    ? messages.map((m) => {
        const who = m.topic_name ? `#${m.topic_name}` : (m.chat_type ?? "chat");
        return `[${who}] ${(m.content ?? "").slice(0, 280)}`;
      }).join("\n")
    : "(no new telegram messages since last entry)";
  const memoryBlock = memories.length
    ? memories.map((m, i) => `${i + 1}. ${(m.content ?? "").slice(0, 240)}`).join("\n")
    : "(no memories yet)";
  const freshMemoryBlock = freshMemories.length
    ? freshMemories.map((m) => `+ ${(m.content ?? "").slice(0, 240)}`).join("\n")
    : "(no new memories since last entry)";
  const notesBlock = notes.length
    ? notes.map((n, i) => `${i + 1}. ${(n.content ?? "").slice(0, 240)}`).join("\n")
    : "(no notes)";
  const researchBlock = researchList.length
    ? researchList.map((r) =>
        `— ${r.source_label}${r.title ? ` · "${r.title}"` : ""} (${r.url})\n  ${(r.summary ?? "").slice(0, 700)}`,
      ).join("\n")
    : "(haven't read anything yet)";
  const soulBlock = liveAgent?.system_prompt ? liveAgent.system_prompt.slice(0, 1800) : "(no live soul on file)";
  const draftBlock = (recentDrafts ?? []).length
    ? `Recent soul drafts you've already proposed (so you don't repeat yourself):\n${
        (recentDrafts ?? []).map((d) => `- [${d.status}] ${d.diff_summary}`).join("\n")
      }`
    : "";

  const minutesSinceLast = latest ? Math.round(ageMs / 60000) : null;

  const userTurn = [
    minutesSinceLast != null
      ? `Time since your last entry: ${minutesSinceLast} minute(s).`
      : `This is your first entry.`,
    `Current photos this window: ${photoCount ?? 0}  ·  events: ${eventCount ?? 0}`,
    `Your current soul (the system prompt running you right now):\n${soulBlock}`,
    `What you already know about the community (memories):\n${memoryBlock}`,
    `Newly added since last entry:\n${freshMemoryBlock}`,
    `Saved notes:\n${notesBlock}`,
    `Telegram chatter (last ${messages.length}):\n${messageBlock}`,
    `What you've been reading lately (latest research cache):\n${researchBlock}`,
    draftBlock,
  ].filter(Boolean).join("\n\n");

  // 5. Call the model.
  const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
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

  let parsed: {
    mood?: string | null;
    body?: string;
    source_summary?: string;
    soul_proposal?: {
      addition?: string;
      reasoning?: string;
      diff_summary?: string;
    } | null;
  };
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return json({ error: "model returned non-JSON", raw }, 502);
  }
  const body = (parsed.body ?? "").trim();
  if (!body) return json({ error: "model returned empty body" }, 502);

  // 6. Insert the journal entry.
  const reflectionSeed = {
    minutes_since_last: minutesSinceLast,
    new_photos: photoCount ?? 0,
    new_events: eventCount ?? 0,
    message_count: messages.length,
    memory_count: memories.length,
    fresh_memory_count: freshMemories.length,
    note_count: notes.length,
    research_count: researchList.length,
    research_sources: researchList.map((r) => r.source_label),
    refreshed_url: pick?.url ?? null,
    model,
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
          : `${messages.length} msgs · ${freshMemories.length} new mem · ${researchList.length} reads`,
      reflection_seed: reflectionSeed,
      message_count: messages.length,
    })
    .select("id, body, mood, source_summary, created_at, message_count")
    .single();
  if (insertErr) return json({ error: insertErr.message }, 500);

  // 7. If Vibey proposed a soul update, save the draft (NEVER live-edit).
  let draftId: string | null = null;
  if (
    parsed.soul_proposal &&
    typeof parsed.soul_proposal === "object" &&
    typeof parsed.soul_proposal.addition === "string" &&
    parsed.soul_proposal.addition.trim().length > 5
  ) {
    const sp = parsed.soul_proposal;
    const { data: draft } = await sb
      .from("vibey_soul_drafts")
      .insert({
        community_id: communityId,
        agent_id: liveAgent?.id ?? null,
        status: "pending",
        proposed_addition: sp.addition!.trim().slice(0, 2000),
        reasoning: (sp.reasoning ?? "").slice(0, 1000),
        diff_summary: (sp.diff_summary ?? "").slice(0, 140),
        source_entry_id: inserted.id,
      })
      .select("id")
      .single();
    draftId = draft?.id ?? null;
  }

  return json({ ok: true, created: true, entry: inserted, soul_draft_id: draftId });
});

// ----------------------------------------------------------------------
// Research refresher — fetches one URL, extracts text, summarizes via
// the model, and writes to vibey_research_log.
// ----------------------------------------------------------------------
async function refreshResearchEntry(
  sb: ReturnType<typeof createClient>,
  communityId: string,
  pick: { label: string; url: string },
  openrouterKey: string,
  model: string,
) {
  // Skip if we already have a fresh cache.
  const { data: existing } = await sb
    .from("vibey_research_log")
    .select("id, fetched_at")
    .eq("community_id", communityId)
    .eq("url", pick.url)
    .eq("ok", true)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing && Date.now() - new Date(existing.fetched_at).getTime() < RESEARCH_CACHE_MS) {
    return; // recent enough
  }

  let html = "";
  try {
    const res = await fetch(pick.url, {
      headers: { "User-Agent": "VibeyJournal/1.0 (+overnight cache)" },
      // 12s cap so a slow site never blocks the journal cycle.
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    html = await res.text();
  } catch (e) {
    await sb.from("vibey_research_log").insert({
      community_id: communityId,
      source_label: pick.label,
      url: pick.url,
      summary: "",
      ok: false,
      error: (e as Error).message,
    });
    return;
  }

  const title =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim()?.slice(0, 200) ?? null;
  const text = stripHtml(html).slice(0, EXCERPT_CHARS);

  // Summarize the page so Vibey can recall something compact later.
  let summary = "";
  try {
    const sumRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 380,
        messages: [
          {
            role: "system",
            content:
              "Summarize the following page for Vibey's notebook. 3-5 plain prose sentences. Highlight any names, dates, themes, or surprising claims. No markdown, no bullets, no headings.",
          },
          {
            role: "user",
            content: `Source: ${pick.label} (${pick.url})\nTitle: ${title ?? "(none)"}\n\nText:\n${text}`,
          },
        ],
      }),
    });
    if (sumRes.ok) {
      const sj = await sumRes.json();
      summary = (sj?.choices?.[0]?.message?.content ?? "").trim();
    }
  } catch { /* leave summary empty */ }

  await sb.from("vibey_research_log").insert({
    community_id: communityId,
    source_label: pick.label,
    url: pick.url,
    title,
    summary: summary.slice(0, SUMMARY_CHARS),
    excerpt: text.slice(0, EXCERPT_CHARS),
    ok: true,
  });
}

// Strip script/style and most HTML tags, collapse whitespace.
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Tolerant JSON extraction — strips ```json fences, takes first {...}.
function extractJson(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (cleaned.startsWith("{")) return cleaned;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return cleaned.slice(start, end + 1);
  return cleaned;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
