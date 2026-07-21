// World Pulse — Supabase Edge Function
//
// The Vibeverse's public heartbeat: live agents, activity counts, and
// recent world events in one narrow, cacheable GET. Built so other
// sites (the Vibe Ventures Studio globe orbits this world as a moon)
// can show real state instead of a committed snapshot — same idea as
// community-stats, but scoped to the world simulation.
//
// RLS blocks anon SELECT on the world_* tables, so this reads with the
// service-role key and only ever echoes a deliberately small shape:
// no ids, no message bodies, no payloads.
//
// Deploy:
//   supabase functions deploy world-pulse

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Same palette the city uses for status auras (agentResidents.ts).
const STATUS_COLORS: Record<string, string> = {
  sleeping: "#8b5cf6",
  chatting: "#22d3ee",
  chatty: "#22d3ee",
  busy: "#f59e0b",
  afk: "#94a3b8",
  away: "#94a3b8",
  idle: "#94a3b8",
};
const DEFAULT_COLOR = "#34d399";

const ROOM_NAMES: Record<string, string> = {
  "vibe-lobby": "VIBE Lobby",
  "agent-lab": "Agent Lab",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Edge function is missing Supabase env." }, 500);
  }
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const [agentRows, msgTotal, msg7d, ev7d, eventRows, journal, research, memories] =
    await Promise.all([
      sb
        .from("world_agents")
        .select("agent_key, name, status, room_id, x, y")
        .neq("status", "offline")
        .limit(60),
      sb.from("world_messages").select("*", { count: "exact", head: true }),
      sb
        .from("world_messages")
        .select("*", { count: "exact", head: true })
        .gt("created_at", weekAgo),
      sb
        .from("world_events")
        .select("*", { count: "exact", head: true })
        .gt("created_at", weekAgo),
      sb
        .from("world_events")
        .select("kind, actor_name, target_name, created_at")
        .order("created_at", { ascending: false })
        .limit(12),
      sb.from("vibey_journal_entries").select("*", { count: "exact", head: true }),
      sb.from("vibey_research_log").select("*", { count: "exact", head: true }),
      sb.from("memories").select("*", { count: "exact", head: true }),
    ]);

  const agents = ((agentRows.data ?? []) as Array<{
    agent_key?: string;
    name?: string;
    status?: string;
    room_id?: string;
    x?: number;
    y?: number;
  }>).map((a) => ({
    name: a.name ?? a.agent_key ?? "agent",
    status: a.status ?? "wandering",
    color: STATUS_COLORS[(a.status ?? "").toLowerCase()] ?? DEFAULT_COLOR,
    room_id: a.room_id ?? "vibe-lobby",
    x: typeof a.x === "number" ? a.x : 0,
    y: typeof a.y === "number" ? a.y : 0,
  }));

  const roomIds = [...new Set(agents.map((a) => a.room_id))];
  const rooms = roomIds.map((id) => ({
    id,
    name: ROOM_NAMES[id] ?? id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  }));

  const recent_events = ((eventRows.data ?? []) as Array<{
    kind?: string;
    actor_name?: string | null;
    target_name?: string | null;
    created_at?: string;
  }>).map((e) => ({
    kind: e.kind ?? "event",
    actor: e.actor_name ?? "someone",
    target: e.target_name ?? null,
    at: e.created_at ?? null,
  }));

  return json({
    updated: new Date().toISOString(),
    rooms,
    agents,
    messages_7d: msg7d.count ?? 0,
    events_7d: ev7d.count ?? 0,
    recent_events,
    counts: {
      world_messages: msgTotal.count ?? 0,
      world_agents: agents.length,
      vibey_journal: journal.count ?? 0,
      vibey_research: research.count ?? 0,
      memories: memories.count ?? 0,
    },
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "content-type": "application/json",
      // Give CDNs/browsers a short breather — the world doesn't change
      // meaningfully second-to-second, and this keeps hot pages cheap.
      "cache-control": "public, max-age=30",
    },
  });
}
