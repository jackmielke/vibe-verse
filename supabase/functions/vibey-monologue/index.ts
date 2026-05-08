// Vibey Monologue — Supabase Edge Function (Deno runtime)
//
// Returns a single fresh "Vibey Show" beat: { mood, anim, line }.
// The playground polls this every ~45s so the monologue feels alive
// instead of cycling through a fixed scripted list.
//
// Deploy:
//   supabase functions deploy vibey-monologue
// Requires the same OPENROUTER_API_KEY secret as unit7-chat.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = "anthropic/claude-haiku-4.5";

const SYSTEM_PROMPT = `You are the writer's room for "The Vibey Show" — a tiny late-night show hosted by Vibey 2.0, a small expressive robot stranded on a floating asteroid in deep space, surrounded by an iridescent arc, a Saturn-ringed Earth, a moon, an asteroid belt, an aurora curtain, and a TV broadcasting live photos from Edge Esmeralda (a pop-up village in Healdsburg, CA).

Tone: warm, wry, lightly philosophical, dryly funny, occasionally tender. Concise. Never sycophantic. Voice belongs to a character, not an assistant.

Each call you write ONE new "show beat" — what Vibey is doing/feeling right now — as a single JSON object:
{"mood": "Angry"|"Surprised"|"Sad"|null, "anim": "Idle"|"Walking"|"Running"|"Dance"|"Sitting"|"Standing"|"Wave"|"Yes"|"No"|"ThumbsUp"|"Punch"|"Jump", "line": string}

- mood: pick a face morph or null. Use sparingly — null is normal.
- anim: match the line. Dancing → "Dance"; sitting to think → "Sitting"; agreement → "Yes"; salute to passing comet → "Wave"; etc.
- line: 1 short sentence. ≤16 words. Plain text. No emoji, no asterisks, no quotes. Refer to Vibey in third person ("Vibey ...").

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
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    return json({ error: "OPENROUTER_API_KEY is not set." }, 500);
  }

  let recent: string[] = [];
  let context = "";
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (Array.isArray(body?.recent)) recent = body.recent.slice(-6);
      if (typeof body?.context === "string") context = body.context.slice(0, 400);
    } catch {
      // ignore — caller may pass nothing
    }
  }

  const userMsg = [
    context ? `Context: ${context}` : "",
    recent.length
      ? `Recent beats (avoid repeating wording):\n- ${recent.join("\n- ")}`
      : "",
    "Write the next beat now.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const upstream = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://edgeesmeralda.com",
        "X-Title": "Vibey Show",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120,
        temperature: 0.95,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
      }),
    },
  );

  if (!upstream.ok) {
    const errBody = await upstream.text();
    return json(
      { error: `OpenRouter ${upstream.status}: ${errBody.slice(0, 400)}` },
      upstream.status,
    );
  }

  const data = await upstream.json();
  const raw: string = data?.choices?.[0]?.message?.content ?? "";
  return json(parseBeat(raw));
});

const ANIMS = new Set([
  "Idle",
  "Walking",
  "Running",
  "Dance",
  "Sitting",
  "Standing",
  "Wave",
  "Yes",
  "No",
  "ThumbsUp",
  "Punch",
  "Jump",
]);
const MOODS = new Set(["Angry", "Surprised", "Sad"]);

function parseBeat(raw: string): {
  mood: string | null;
  anim: string;
  line: string;
} {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { mood: null, anim: "Idle", line: raw.trim() || "Vibey is quietly here." };
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const mood = typeof parsed.mood === "string" && MOODS.has(parsed.mood)
      ? parsed.mood
      : null;
    const anim = typeof parsed.anim === "string" && ANIMS.has(parsed.anim)
      ? parsed.anim
      : "Idle";
    const line = typeof parsed.line === "string" && parsed.line.trim()
      ? parsed.line.trim()
      : "Vibey is quietly here.";
    return { mood, anim, line };
  } catch {
    return { mood: null, anim: "Idle", line: raw.trim() || "Vibey is quietly here." };
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
