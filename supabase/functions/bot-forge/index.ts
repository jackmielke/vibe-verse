/**
 * bot-forge: turn an X handle (and whatever the player says about
 * themselves) into a battle bot for /bots, in one model call.
 *
 * Nothing is stored. The bot comes back as JSON, lives in the player's
 * localStorage, and travels inside challenge links, so this function is the
 * only server piece of the whole loop. It never reads X: the handle and the
 * optional bio are all it knows, which is why the prompt asks for a character
 * inspired by them rather than a portrait of the person.
 *
 *   POST { handle, bio? } -> { bot }
 */
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const MODEL = "anthropic/claude-haiku-4.5";
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: JSON_HEADERS });

const SYSTEM = `You design pocket battle bots for a rock-paper-scissors game, like a Pokémon made of software. Given an X (Twitter) handle and maybe a short bio, invent a fun, kind, PG character inspired by the handle's vibe. Never insult the person, never mention politics, religion or real controversies, never claim facts about them.

Reply with ONLY a JSON object:
{
  "name": "2 to 3 words, a creature name",
  "emoji": "one emoji that is its face",
  "species": "a made-up species, 2 to 4 words",
  "color": "a vivid hex color like #ff7a1c",
  "catchphrase": "max 8 words",
  "personality": "one sentence, second person is fine",
  "style": { "rock": 0.0-1.0, "paper": 0.0-1.0, "scissors": 0.0-1.0 },
  "tell": "max 10 words: a hint a sharp coach could read before it throws",
  "win": "max 8 words it says when it wins a round",
  "lose": "max 8 words it says when it loses a round",
  "stats": { "grit": 1-10, "flair": 1-10, "cunning": 1-10 }
}
"style" is how often it favours each throw; make it lopsided so the bot has a readable personality, and make "tell" honestly hint at its favourite.`;

const clean = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  const body = await req.json().catch(() => ({}));
  const handle = clean(body.handle, 30).replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "");
  const bio = clean(body.bio, 200);
  if (!handle) return reply({ error: "handle" }, 400);

  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) return reply({ error: "not configured" }, 503);

  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 1,
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Handle: @${handle}${bio ? `\nBio: ${bio}` : ""}` },
      ],
    }),
  });
  if (!r.ok) return reply({ error: `model ${r.status}` }, 502);
  const text: string = (await r.json())?.choices?.[0]?.message?.content ?? "";
  let b: Record<string, any>;
  try {
    b = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return reply({ error: "model returned junk" }, 502);
  }

  const num = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const bot = {
    v: 1,
    handle,
    name: clean(b.name, 32) || `${handle} bot`,
    emoji: clean(b.emoji, 8) || "🤖",
    species: clean(b.species, 40),
    color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : "#ffb23f",
    catchphrase: clean(b.catchphrase, 60),
    personality: clean(b.personality, 160),
    style: {
      rock: num(b.style?.rock, 0.05, 1, 0.34),
      paper: num(b.style?.paper, 0.05, 1, 0.33),
      scissors: num(b.style?.scissors, 0.05, 1, 0.33),
    },
    tell: clean(b.tell, 80),
    win: clean(b.win, 60) || "Too easy.",
    lose: clean(b.lose, 60) || "Rematch.",
    stats: { grit: num(b.stats?.grit, 1, 10, 5), flair: num(b.stats?.flair, 1, 10, 5), cunning: num(b.stats?.cunning, 1, 10, 5) },
  };
  return reply({ bot });
});
