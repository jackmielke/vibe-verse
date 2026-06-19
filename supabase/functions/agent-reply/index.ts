// agent-reply — generates an AI reply on behalf of a world_agents resident
// and inserts it into public.island_dms so realtime delivers it to both
// participants. Called from the in-world PersonChatPanel after a player
// sends a message to an agent.
//
// Body: { agentId: string, threadKey: string, userId: string, body: string }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MODEL = "anthropic/claude-haiku-4.5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    const supaUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const body = await req.json().catch(() => ({}));
    const { agentId, threadKey, userId, body: text } = body as {
      agentId?: string; threadKey?: string; userId?: string; body?: string;
    };
    if (!agentId || !threadKey || !userId || !text) {
      return json({ error: "Missing fields" }, 400);
    }

    const supabase = createClient(supaUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // Look up the agent we're speaking for.
    const { data: agent } = await supabase
      .from("world_agents")
      .select("id, name, prompt, agent_key")
      .eq("id", agentId)
      .maybeSingle();
    if (!agent) return json({ error: "agent not found" }, 404);

    // Pull recent history for context (last 12).
    const { data: history } = await supabase
      .from("island_dms")
      .select("from_kind, from_name, body")
      .eq("thread_key", threadKey)
      .order("created_at", { ascending: true })
      .limit(24);

    const agentName = (agent.name as string) || "agent";
    const persona = (agent as { prompt?: string }).prompt ||
      `You are ${agentName}, a quirky AI resident wandering Edge Esmeralda island. Reply in 1–2 short, warm, in-character sentences. Plain text. No emoji spam.`;

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: persona },
    ];
    for (const h of history ?? []) {
      messages.push({
        role: h.from_kind === "agent" ? "assistant" : "user",
        content: `${h.from_name}: ${h.body}`,
      });
    }
    // Ensure the latest user line is present even if realtime/inserts race.
    if (!history?.length || history[history.length - 1].body !== text) {
      messages.push({ role: "user", content: text });
    }

    let reply = "…";
    if (apiKey) {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.85,
          max_tokens: 160,
          messages,
        }),
      });
      if (r.ok) {
        const j = await r.json();
        reply = (j?.choices?.[0]?.message?.content as string)?.trim() || reply;
      } else {
        reply = `(${agentName} is offline right now — try again in a minute.)`;
      }
    } else {
      reply = `(${agentName} would love to reply, but the AI key isn't configured yet.)`;
    }

    // Trim to schema limit
    if (reply.length > 1000) reply = reply.slice(0, 1000);

    const { error: insertErr } = await supabase.from("island_dms").insert({
      thread_key: threadKey,
      from_kind: "agent",
      from_ref: agentId,
      from_name: agentName,
      to_kind: "user",
      to_ref: userId,
      body: reply,
    });
    if (insertErr) return json({ error: insertErr.message }, 500);

    return json({ ok: true, reply });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
