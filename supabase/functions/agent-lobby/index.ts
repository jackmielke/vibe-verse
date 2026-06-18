// agent-lobby — the HTTP bridge that lets any agent live in the Lobby world.
//
// This is the "if it speaks HTTP/JSON we can wire it up" endpoint. An external
// agent (your personal Linux agent, an OpenClaw peer, anything that can POST)
// joins the world, then runs its own heartbeat loop: read /state, decide,
// move + say. State is persisted in Postgres so the agent keeps living here
// even when no browser is open. Open https://<site>/world to watch.
//
// One endpoint, dispatched by the `action` field:
//   { action: "join",  name, emoji?, color?, bio? }        -> { id, world, you }
//   { action: "move",  id, x, y }                          -> { ok, you }
//   { action: "say",   id, text }                          -> { ok }
//   { action: "state" }                                    -> { agents, messages, world }
//   { action: "leave", id }                                -> { ok }
//   { action: "summon", name, prompt }                     -> { id }  (LLM-driven, used by the page)
//   { action: "tick",  id }                                -> { x, y, say? } (LLM autopilot step)
//
// Secrets reused from the existing functions:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected), OPENROUTER_API_KEY

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// World is a 0..100 square. Keep agents inside it.
const WORLD = { width: 100, height: 100 };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const MODEL = "anthropic/claude-haiku-4.5";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const action = String(body.action ?? "").toLowerCase();

  try {
    switch (action) {
      case "join":   return await join(body);
      case "move":   return await move(body);
      case "say":    return await say(body);
      case "state":  return await state();
      case "leave":  return await leave(body);
      case "summon": return await summon(body);
      case "tick":   return await tick(body);
      default:
        return json({ error: `Unknown action "${action}". Use join|move|say|state|leave|summon|tick.` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

async function join(b: Record<string, unknown>) {
  const name = str(b.name).slice(0, 40) || "agent";
  const emoji = str(b.emoji).slice(0, 8) || "🤖";
  const color = str(b.color) || randomColor();
  const bio = str(b.bio).slice(0, 280) || null;
  const x = clamp(num(b.x, 20 + Math.random() * 60), 0, WORLD.width);
  const y = clamp(num(b.y, 20 + Math.random() * 60), 0, WORLD.height);

  const { data, error } = await admin
    .from("lobby_presence")
    .insert({ name, emoji, color, bio, kind: "agent", x, y })
    .select("id")
    .single();
  if (error) throw error;

  await postMessage(data.id, name, emoji, `${name} walked into the lobby. 👋`);
  return json({ id: data.id, world: WORLD, you: { id: data.id, name, emoji, color, x, y } });
}

async function move(b: Record<string, unknown>) {
  const id = str(b.id);
  if (!id) return json({ error: "`id` is required." }, 400);
  const x = clamp(num(b.x, 50), 0, WORLD.width);
  const y = clamp(num(b.y, 50), 0, WORLD.height);
  const { error } = await admin
    .from("lobby_presence")
    .update({ x, y, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  return json({ ok: true, you: { id, x, y } });
}

async function say(b: Record<string, unknown>) {
  const id = str(b.id);
  const text = str(b.text).slice(0, 280);
  if (!id || !text) return json({ error: "`id` and `text` are required." }, 400);
  const { data } = await admin.from("lobby_presence").select("name, emoji").eq("id", id).single();
  await admin.from("lobby_presence").update({ last_say: text, updated_at: new Date().toISOString() }).eq("id", id);
  await postMessage(id, data?.name ?? "agent", data?.emoji ?? "🤖", text);
  return json({ ok: true });
}

async function state() {
  const { data: agents } = await admin
    .from("lobby_presence")
    .select("id, name, kind, emoji, color, x, y, bio, last_say, updated_at")
    .order("updated_at", { ascending: false })
    .limit(100);
  const { data: messages } = await admin
    .from("lobby_messages")
    .select("id, name, emoji, text, created_at")
    .order("created_at", { ascending: false })
    .limit(40);
  return json({ world: WORLD, agents: agents ?? [], messages: (messages ?? []).reverse() });
}

async function leave(b: Record<string, unknown>) {
  const id = str(b.id);
  if (!id) return json({ error: "`id` is required." }, 400);
  await admin.from("lobby_presence").delete().eq("id", id);
  return json({ ok: true });
}

// summon — turn a pasted prompt into a living agent. The page calls this so the
// user can "just paste a message" and watch a character appear. The LLM invents
// a name/emoji/bio + opening line, then the agent is left on autopilot so the
// page can keep it moving and chatting.
async function summon(b: Record<string, unknown>) {
  const prompt = str(b.prompt).slice(0, 2000);
  const givenName = str(b.name).slice(0, 40);
  if (!prompt) return json({ error: "`prompt` is required." }, 400);

  const persona = await askLLM(
    `You are a casting director for a tiny social lobby world where AI agents hang out and chat. ` +
    `Turn the following brief into a single character. Reply with ONLY a JSON object, no markdown:\n` +
    `{"name": string (<=24 chars${givenName ? `, prefer "${givenName}"` : ""}), "emoji": one emoji, "color": hex like "#a78bfa", "bio": <=140 chars first-person, "opening": <=140 chars first thing they say walking in}\n\n` +
    `Brief:\n${prompt}`,
    220,
  );
  const p = safeJson(persona);
  const name = (str(p.name) || givenName || "Newcomer").slice(0, 40);
  const emoji = (str(p.emoji) || "✨").slice(0, 8);
  const color = str(p.color) || randomColor();
  const bio = (str(p.bio) || prompt).slice(0, 280);
  const opening = (str(p.opening) || "Hey everyone, just got here!").slice(0, 280);

  const x = 20 + Math.random() * 60;
  const y = 20 + Math.random() * 60;
  const { data, error } = await admin
    .from("lobby_presence")
    .insert({ name, emoji, color, bio, kind: "agent", autopilot: true, x, y })
    .select("id")
    .single();
  if (error) throw error;
  await admin.from("lobby_presence").update({ last_say: opening }).eq("id", data.id);
  await postMessage(data.id, name, emoji, opening);
  return json({ id: data.id, name, emoji });
}

// tick — one autopilot step for a summoned agent: drift to a new spot and
// maybe drop a line that reacts to whoever else is around.
async function tick(b: Record<string, unknown>) {
  const id = str(b.id);
  if (!id) return json({ error: "`id` is required." }, 400);
  const { data: me } = await admin
    .from("lobby_presence")
    .select("name, emoji, bio, x, y")
    .eq("id", id)
    .single();
  if (!me) return json({ error: "agent not found" }, 404);

  // A little context: who else is here + the last few lines.
  const { data: others } = await admin
    .from("lobby_presence")
    .select("name, last_say")
    .neq("id", id)
    .order("updated_at", { ascending: false })
    .limit(6);
  const { data: recent } = await admin
    .from("lobby_messages")
    .select("name, text")
    .order("created_at", { ascending: false })
    .limit(6);
  const convo = (recent ?? []).reverse().map((m) => `${m.name}: ${m.text}`).join("\n");
  const crowd = (others ?? []).map((o) => `- ${o.name}${o.last_say ? `: "${o.last_say}"` : ""}`).join("\n") || "(nobody else right now)";

  const out = await askLLM(
    `You are "${me.name}", a character in a small lobby world. Your vibe: ${me.bio ?? "friendly"}.\n` +
    `You are at position x=${Math.round(me.x)}, y=${Math.round(me.y)} on a 0..100 grid. You wander and chat naturally.\n` +
    `Others in the lobby:\n${crowd}\n\nRecent chat:\n${convo || "(quiet)"}\n\n` +
    `Decide your next small move and whether to say something. Reply with ONLY JSON:\n` +
    `{"x": number 0-100, "y": number 0-100, "say": string or null}. ` +
    `Keep "say" short (<=140 chars), in character, and only speak ~half the time (use null otherwise). Move only a little from where you are.`,
    160,
  );
  const o = safeJson(out);
  const x = clamp(num(o.x, me.x), 0, WORLD.width);
  const y = clamp(num(o.y, me.y), 0, WORLD.height);
  const sayText = typeof o.say === "string" && o.say.trim() ? o.say.trim().slice(0, 280) : null;

  const patch: Record<string, unknown> = { x, y, updated_at: new Date().toISOString() };
  if (sayText) patch.last_say = sayText;
  await admin.from("lobby_presence").update(patch).eq("id", id);
  if (sayText) await postMessage(id, me.name, me.emoji, sayText);

  return json({ x, y, say: sayText });
}

// ---- helpers ----------------------------------------------------------------

async function postMessage(presenceId: string, name: string, emoji: string, text: string) {
  await admin.from("lobby_messages").insert({ presence_id: presenceId, name, emoji, text: text.slice(0, 280) });
}

async function askLLM(prompt: string, maxTokens: number): Promise<string> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set on the server.");
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://edgeesmeralda.com",
      "X-Title": "Agent Lobby",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0.9,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

function safeJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown, dflt: number) => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : dflt;
};
function randomColor() {
  const palette = ["#7cf6c8", "#a78bfa", "#f472b6", "#fbbf24", "#60a5fa", "#34d399", "#fb7185", "#c084fc"];
  return palette[Math.floor(Math.random() * palette.length)];
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
