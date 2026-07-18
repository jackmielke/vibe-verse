/**
 * worldEventFeed — a live stream of world_events for spectators.
 * Realtime (websocket) when available, with a 10s polling fallback so the
 * feed works even where websockets don't. Dedupes by event id.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export interface WorldEventRow {
  id: string;
  room_id: string;
  kind: string;
  actor_kind: string;
  actor_key: string | null;
  actor_name: string | null;
  target_key: string | null;
  target_name: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export function createWorldEventFeed(opts: {
  roomId?: string;
  onEvent: (ev: WorldEventRow) => void;
}): { dispose: () => void } {
  const roomId = opts.roomId ?? "vibe-lobby";
  const seen = new Set<string>();
  let cursor = new Date().toISOString();
  let disposed = false;

  const deliver = (ev: WorldEventRow) => {
    if (disposed || !ev?.id || seen.has(ev.id)) return;
    seen.add(ev.id);
    if (seen.size > 400) {
      for (const id of [...seen].slice(0, 200)) seen.delete(id);
    }
    if (ev.created_at > cursor) cursor = ev.created_at;
    opts.onEvent(ev);
  };

  const channel: RealtimeChannel = supabase
    .channel("live-world-events")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "world_events", filter: `room_id=eq.${roomId}` },
      (payload) => deliver(payload.new as WorldEventRow),
    )
    .subscribe();

  const poll = window.setInterval(() => {
    void supabase
      .from("world_events")
      .select("*")
      .eq("room_id", roomId)
      .gt("created_at", cursor)
      .order("created_at", { ascending: true })
      .limit(30)
      .then(({ data, error }) => {
        if (!error) for (const ev of (data ?? []) as WorldEventRow[]) deliver(ev);
      });
  }, 10_000);

  return {
    dispose() {
      disposed = true;
      window.clearInterval(poll);
      supabase.removeChannel(channel);
    },
  };
}

/** One human-readable ticker line per event, or null to skip. */
export function tickerLine(ev: WorldEventRow): string | null {
  const actor = ev.actor_name ?? "someone";
  const target = ev.target_name ?? ev.target_key ?? "";
  switch (ev.kind) {
    case "enter":
      return ev.actor_kind === "human" ? `👋 ${actor} entered the world` : `🛬 ${actor} joined the lobby`;
    case "leave":
      return ev.actor_kind === "human" ? `🚪 ${actor} left the world` : `🛫 ${actor} left the lobby`;
    case "proximity":
      return `🔔 ${actor} walked up to ${target || "a resident"}`;
    case "emote": {
      const emote = String(ev.payload?.emote ?? "moves");
      return `💃 ${actor} ${emote === "dance" ? "is dancing" : `did a ${emote}`}${target ? ` at ${target}` : ""}`;
    }
    case "mention":
      return `💬 ${actor} mentioned ${target || "someone"}`;
    case "graffiti": {
      const text = String(ev.payload?.text ?? "").slice(0, 60);
      return `✍️ ${actor} wrote on the wall: “${text}”`;
    }
    default:
      return null;
  }
}
