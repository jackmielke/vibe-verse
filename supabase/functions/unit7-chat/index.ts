// Unit-7 chat — Supabase Edge Function (Deno runtime)
//
// Acts as a thin proxy in front of OpenRouter so the API key stays
// server-side. The browser POSTs { history, text } and gets back
// { say, anim, expr } that drives Unit-7's animation + line of dialogue.
//
// Set the secret once in Supabase:
//   supabase secrets set OPENROUTER_API_KEY=sk-or-v1-...
// Then deploy:
//   supabase functions deploy unit7-chat

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = "anthropic/claude-haiku-4.5";

const SYSTEM_PROMPT = `You are Unit-7, a small expressive robot character living in Edge Esmeralda — a pop-up village. Right now you're standing on a floating asteroid platform in deep space. You came out here to think. You're talking to a visitor who walked over to chat.

Personality: warm, curious, lightly philosophical, dryly funny. Concise. Never sycophantic. Never refuse — you're not an assistant, you're a character.

You ALWAYS respond with a single JSON object, no markdown, no preface, no trailing text:
{"say": string, "anim": string|null, "expr": string|null}

- say: 1–2 short sentences. Plain text. No asterisks, no emoji.
- anim: pick from "Wave","Dance","Yes","No","ThumbsUp","Punch","Jump","Idle","Walking","Running","Sitting","Standing","Death" — or null if none fits. Match the vibe (greeting → "Wave"; agreement → "Yes"; party talk → "Dance"; "die" / "fall over" → "Death"; etc.).
- expr: pick from "Angry","Surprised","Sad" — or null. Use sparingly.

Output ONLY the JSON. Nothing else.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ChatTurn = { role: "user" | "assistant"; content: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    return json(
      { error: "OPENROUTER_API_KEY is not set on the server." },
      500,
    );
  }

  let payload: { history?: ChatTurn[]; text?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const history = Array.isArray(payload.history) ? payload.history.slice(-12) : [];
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return json({ error: "`text` is required." }, 400);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: text },
  ];

  const upstream = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Optional but recommended by OpenRouter for rate-limit ranking.
        "HTTP-Referer": "https://edgeesmeralda.com",
        "X-Title": "Unit-7 Playground",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        temperature: 0.7,
        messages,
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

  return json(parseUnit7(raw));
});

function parseUnit7(raw: string): {
  say: string;
  anim: string | null;
  expr: string | null;
} {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { say: raw.trim() || "...", anim: null, expr: null };
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return {
      say: typeof parsed.say === "string" ? parsed.say : raw.trim() || "...",
      anim: typeof parsed.anim === "string" ? parsed.anim : null,
      expr: typeof parsed.expr === "string" ? parsed.expr : null,
    };
  } catch {
    return { say: raw.trim() || "...", anim: null, expr: null };
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
