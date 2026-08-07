// trek-comms — the voice of everyone in STRANGE NEW WORLDS.
//
// A thin proxy in front of OpenRouter, same shape as `unit7-chat`, with one
// difference that matters: the persona is supplied by the caller instead of
// being baked in here. Sixteen characters — three officers on the bridge and
// thirteen people scattered across the chart — share this one function, and
// adding a seventeenth is a client-side edit in
// `src/starfleet/crew/characters.ts`. No redeploy, and no way for the character
// the surface renders to drift out of step with the character the model plays.
//
// The client never depends on this succeeding. `crew/comms.ts` falls back to a
// hand-written bank in the same voice if this is missing, unset, slow or
// unreachable, so the world is playable with no key and no network. This
// function makes the conversations *good*; it is not what makes them exist.
//
// Deploy:
//   supabase functions deploy trek-comms
// The OPENROUTER_API_KEY secret is already set on this project for unit7-chat
// and is shared by every function in it.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = "anthropic/claude-haiku-4.5";

// Short replies, and a hard ceiling on them. These are spoken lines on a comm
// channel: a character who answers a question with four paragraphs is not a
// character, and no amount of prompting is as reliable as simply not giving
// the model the room.
const MAX_TOKENS = 220;
const TEMPERATURE = 0.9;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ChatTurn = { role: "user" | "assistant"; content: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    return json({ error: "OPENROUTER_API_KEY is not set on the server." }, 500);
  }

  let payload: { persona?: string; name?: string; history?: ChatTurn[]; text?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  // The persona is caller-supplied, so it is bounded here rather than trusted.
  // 6 KB is roughly four times the longest character in the game.
  const persona = typeof payload.persona === "string" ? payload.persona.slice(0, 6000) : "";
  const text = typeof payload.text === "string" ? payload.text.trim().slice(0, 800) : "";
  if (!persona) return json({ error: "`persona` is required." }, 400);
  if (!text) return json({ error: "`text` is required." }, 400);

  const history = (Array.isArray(payload.history) ? payload.history : [])
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .slice(-12)
    .map((t) => ({ role: t.role, content: String(t.content).slice(0, 1200) }));

  const messages = [
    { role: "system", content: persona },
    ...history,
    { role: "user", content: text },
  ];

  let upstream: Response;
  try {
    upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://vibeverse.app",
        "X-Title": "Strange New Worlds",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      }),
    });
  } catch (err) {
    return json({ error: `upstream unreachable: ${err}` }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return json({ error: `upstream ${upstream.status}`, detail: detail.slice(0, 400) }, 502);
  }

  const body = await upstream.json().catch(() => null);
  const raw = body?.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) {
    return json({ error: "empty completion" }, 502);
  }

  return json({ say: clean(raw), name: payload.name ?? null });
});

/**
 * Strip the things a chat model adds that a person standing in front of you
 * does not: stage directions in asterisks, a name prefix it has decided to
 * write, surrounding quotes, and markdown emphasis. The client renders this as
 * plain speech and hands it to a speech synthesiser, and a synthesiser reading
 * "asterisk leans forward asterisk" out loud is the end of the illusion.
 */
function clean(s: string): string {
  let out = s.trim();
  out = out.replace(/\*[^*]*\*/g, " ");           // *stage directions*
  out = out.replace(/^\s*[A-Z' -]{2,24}:\s*/, ""); // "K'VREL: ..."
  out = out.replace(/[*_`#]/g, "");
  out = out.replace(/^["“](.*)["”]$/s, "$1");
  out = out.replace(/\s+/g, " ").trim();
  return out.slice(0, 700);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
