/**
 * BLOB — the Supabase Realtime transport.
 *
 * The only file in the world that knows what a socket is. Everything about the
 * protocol lives in `session.ts` behind `NetTransport`, which is what lets the
 * whole thing be tested over an in-process loopback instead of a network.
 *
 * Two properties this has to have, both learned from Soaked:
 *
 * - **Joining is allowed to fail.** A blocked network, a paused project, a
 *   corporate proxy that will not tunnel a WebSocket — none of those are errors
 *   worth showing anybody. `connect` resolves to null, the caller stays single
 *   player, and the dish is exactly what it was.
 * - **The import is dynamic.** A visitor who never types a room code should not
 *   download the Supabase client to find that out.
 */
import type { NetTransport, Wire } from "./session";

/** Wall-clock ceiling on the handshake. Genuinely a network event, so this one
 *  is measured against the real clock rather than sim time. */
const CONNECT_TIMEOUT_MS = 8000;

/** One broadcast topic. Splitting state and events across two would buy nothing
 *  — they are the same size, the same rate, and they want the same ordering. */
const TOPIC = "m";

export async function connectRoom(room: string): Promise<NetTransport | null> {
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const channel = supabase.channel(`blob-${room}`, {
      config: { broadcast: { self: false, ack: false } },
    });

    let handler: ((msg: Wire) => void) | null = null;
    channel.on("broadcast", { event: TOPIC }, ({ payload }) => {
      if (handler) handler(payload as Wire);
    });

    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          window.clearTimeout(timer);
          finish(true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          window.clearTimeout(timer);
          finish(false);
        }
      });
    });

    if (!ok) {
      try {
        await supabase.removeChannel(channel);
      } catch {
        /* nothing to clean up if it never opened */
      }
      return null;
    }

    return {
      send(msg: Wire) {
        // Fire and forget. A dropped state packet is replaced 80 ms later by
        // the next one, and awaiting an ack twelve times a second would put a
        // promise on the hot path for no benefit.
        void channel.send({ type: "broadcast", event: TOPIC, payload: msg });
      },
      receive(fn) {
        handler = fn;
      },
      close() {
        handler = null;
        try {
          void supabase.removeChannel(channel);
        } catch {
          /* already gone */
        }
      },
    };
  } catch (err) {
    console.warn("[BLOB net] could not join the room; playing solo.", err);
    return null;
  }
}
