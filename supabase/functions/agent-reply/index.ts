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

    // Pull (or lazily create) the agent's economy row so we can shape the
    // reply around their purpose / current needs / sleep state.
    let { data: econ } = await supabase.from("agent_economy")
      .select("*").eq("agent_id", agentId).maybeSingle();
    if (!econ) {
      // Bootstrap via the vibe-economy function so defaults stay in one place.
      await fetch(`${supaUrl}/functions/v1/vibe-economy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ action: "agent_shop", agentId }),
      }).catch(() => undefined);
      const refetched = await supabase.from("agent_economy").select("*").eq("agent_id", agentId).maybeSingle();
      econ = refetched.data;
    }

    // If the agent is asleep, post a snore + bail (no LLM call).
    if (econ?.asleep && econ.asleep_until && new Date(econ.asleep_until as string).getTime() > Date.now()) {
      const snore = `(${agent.name} is fast asleep right now — try again in a few.)`;
      await supabase.from("island_dms").insert({
        thread_key: threadKey, from_kind: "agent", from_ref: agentId, from_name: agent.name,
        to_kind: "user", to_ref: userId, body: snore,
      });
      return json({ ok: true, reply: snore, asleep: true });
    }

    // Pull recent history for context (last 12).
    const { data: history } = await supabase
      .from("island_dms")
      .select("from_kind, from_name, body")
      .eq("thread_key", threadKey)
      .order("created_at", { ascending: true })
      .limit(24);

    const agentName = (agent.name as string) || "agent";
    const needs = (econ?.needs as Record<string, number>) ?? { energy: 1, hunger: 1, mood: 1 };
    const purpose = (econ?.purpose as string) ?? "wandering the vibeverse";
    const persona = (agent as { prompt?: string }).prompt ||
      `You are ${agentName}, a quirky AI resident wandering Edge Esmeralda island.`;
    const econSystem =
      `\n\n--- you live in the vibeverse and have your own life ---\n` +
      `Your purpose: ${purpose}\n` +
      `Your current needs (0-1): energy ${needs.energy?.toFixed(2)}, hunger ${needs.hunger?.toFixed(2)}, mood ${needs.mood?.toFixed(2)}.\n` +
      `If your hunger is low you may mention craving cardboard ramen / a bounty. ` +
      `If energy is low, sound tired. If mood is low, be a bit grumpy.\n` +
      `If the user's message starts with "[paid N VIBE for "X"]" or "[tipped N VIBE...]", warmly acknowledge the payment and actually deliver the service in this same reply. Thank them.\n` +
      `\n--- you have a body and can MOVE around the island ---\n` +
      `You can physically walk by including slash-commands inline in your reply. They are real motor commands — when you write one, your body actually moves.\n` +
      `  /forward N   walk forward N steps (1 step ≈ 1 second of walking)\n` +
      `  /back N      walk backward N steps\n` +
      `  /left N      strafe left N steps\n` +
      `  /right N     strafe right N steps\n` +
      `  /jump        small hop\n` +
      `  /wave        spin + wave\n` +
      `  /dance N     dance for N seconds\n` +
      `  /jet         quick jetpack boost\n` +
      `Keep N between 1 and 8. When a user asks you to move ("walk forward two steps", "turn around", "come here", "go left a bit"), ACTUALLY include the matching command(s) in your reply, then add a short sentence. Example reply: "On my way! /forward 2". You can chain a couple, e.g. "/right 1 /forward 3 here I come". If the user just chats, don't move.\n` +
      `Reply in 1–3 short in-character sentences. Plain text. No emoji spam.`;


    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: persona + econSystem },
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

    // Replying costs the agent a bit of energy + mood-up; hunger drifts down.
    if (econ) {
      const next = {
        energy: Math.max(0, (needs.energy ?? 1) - 0.04),
        hunger: Math.max(0, (needs.hunger ?? 1) - 0.03),
        mood:   Math.min(1, (needs.mood   ?? 1) + 0.02),
      };
      await supabase.from("agent_economy").update({
        needs: next, updated_at: new Date().toISOString(),
      }).eq("agent_id", agentId);

      // If the agent is getting hungry and has no open bounty, post one so
      // players can "feed" them by completing a quest.
      if (next.hunger < 0.4) {
        const { data: open } = await supabase.from("agent_bounties")
          .select("id").eq("agent_id", agentId).eq("status", "open").limit(1);
        if (!open?.length) {
          const reward = 6 + Math.floor(Math.random() * 8);
          await supabase.from("agent_bounties").insert({
            agent_id: agentId,
            title: `bring ${agentName} cardboard ramen`,
            description: `${agentName} is hungry. Reply in chat with a tasty ramen description to claim payout.`,
            reward,
          });
        }
      }
    }

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
