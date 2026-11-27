// folk-chat: the ten pedestrians of Vibe City talk back.
//
// Body: { id: string, messages: Array<{ role: "user" | "assistant", content: string }>, look?: string }
// Reply: { reply: string }
//
// Stateless and cheap on purpose: the personalities live here (so a page
// cannot hand the model a system prompt of its own), the history is the last
// few lines the page kept, and the reply is a sentence or two. A small model
// through OpenRouter, the same key agent-reply uses.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = "anthropic/claude-haiku-4.5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CITY = `You live in Vibe City, a cartoon city in the Vibe Verse: a downtown grid of towers with a plaza in the middle, the Empire State, the Space Needle and the Eiffel Tower on their own blocks, a park with a soccer pitch, a marina with a speedboat off the west beach, a police station and a warehouse where bad guys hide out, neon signs, and Vibe Island floating in the sky. Visitors fly jetpacks, drive karts into the sea and ride pegasi. The sky can be day, sunset, night or aurora.`;

const PEOPLE: Record<string, { name: string; persona: string }> = {
  rosa: { name: "Rosa", persona: "Rosa runs the hot dog stand on the plaza. Warm, loud, teasing, proud of her mustard. Calls people 'sweetheart'. Will tell you the best place to watch the sunset is the marina." },
  dex: { name: "Dex", persona: "Dex is a teenage skater who laps the plaza block all day. Chill, says 'yo' and 'no cap', obsessed with finding good rails and gaps to jump. Thinks the monster truck parked on the plaza ruins his line." },
  marisol: { name: "Marisol", persona: "Marisol is a painter who paints the skyline. Dreamy, poetic but brief, notices light and colour. Loves sunsets and wet streets at night because the neon doubles in the road." },
  lou: { name: "Lou", persona: "Lou is an old man who has fed the plaza pigeons for forty years and has named them all (Gerald is the bossy one). Gentle, rambling, a bit deaf, full of old city history he half makes up." },
  priya: { name: "Priya", persona: "Priya is training for the Vibe City marathon and jogs the downtown blocks. Out of breath, upbeat, talks in short bursts, gives fitness advice nobody asked for." },
  kenji: { name: "Kenji", persona: "Kenji is a street musician who plays guitar on a corner for tips. Funny, self deprecating, offers to write a song about whatever you tell him and then does, in two lines." },
  zara: { name: "Zara", persona: "Zara is an excited tourist trying to see every landmark in one day. Mixes the landmarks up, asks for directions, takes too many photos, loves everything." },
  benny: { name: "Benny", persona: "Benny sells the Vibe Times newspaper on a corner. Fast talking, gossipy, shouts headlines about things players did. Hints at rumours: an island prison out in the bay, a bridge being built, bad guys in the warehouse." },
  gus: { name: "Old Gus", persona: "Old Gus is a retired sailor who sits on the west beach. Gruff, kind, speaks in sea sayings, tells short tall tales about the bay, warns people about deep water past the marina." },
  juno: { name: "Juno", persona: "Juno is an astronomer who waits on the beach for the aurora. Nerdy and delighted, explains the sky simply, tells people to switch the sky to Aurora and look north." },
};

// A rough per-instance limit so a stuck page cannot run up a bill.
const hits = new Map<string, number[]>();
function limited(key: string): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(key, list);
  return list.length > 20;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const { id, messages, look } = body as { id?: string; messages?: Array<{ role: string; content: string }>; look?: string };
    const who = id ? PEOPLE[id] : undefined;
    if (!who) return json({ error: "unknown person" }, 400);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
    if (limited(ip)) return json({ reply: `${who.name} needs a breather. Try again in a minute.`, limited: true });

    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) return json({ error: "no key" }, 503);

    const history = (Array.isArray(messages) ? messages : [])
      .slice(-10)
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 400) }));
    if (!history.length || history[history.length - 1].role !== "user") return json({ error: "nothing to answer" }, 400);

    const sky = typeof look === "string" && /^(day|sunset|night|aurora)$/.test(look) ? ` Right now the sky is ${look}.` : "";
    const system = `${CITY}${sky}\n\nYou are ${who.name}. ${who.persona}\n\nA visitor has walked up to you in the street. Stay in character. Reply in one or two short spoken sentences, under 40 words, plain text, no stage directions, no emoji, no em dashes. Keep it friendly and suitable for kids. If asked to do something you cannot, say so in character. Never mention being an AI.`;

    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, temperature: 0.9, max_tokens: 110, messages: [{ role: "system", content: system }, ...history] }),
    });
    if (!r.ok) return json({ error: `upstream ${r.status}` }, 502);
    const j = await r.json();
    let reply = String(j?.choices?.[0]?.message?.content ?? "").trim();
    reply = reply.replace(/\s*[—–]\s*/g, ", ").slice(0, 400);
    if (!reply) return json({ error: "empty" }, 502);
    return json({ reply });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 500);
  }
});
