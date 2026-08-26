/**
 * transport.ts — the only files in San Francisco that know what a socket is.
 *
 * Two implementations behind one interface, chosen at runtime:
 *
 *  - **`online`** — Supabase Realtime. Everybody on the internet who opens the
 *    same room is in the same city.
 *  - **`local`** — a `BroadcastChannel`. Every tab of the same browser on the
 *    same machine. No server, no account, nothing to configure, works offline
 *    and on a plane.
 *
 * `local` was built to test `online` without a network and then turned out to
 * be worth shipping on its own: two people on one laptop, or one person with
 * the city open twice, is a real thing somebody will do. It is also the only
 * half of this that can be verified in the sandbox, where Realtime is blocked
 * outright — see `net.test.ts` for what is verified instead.
 *
 * The rule both obey, and the reason this file is separate from everything
 * else: **joining is allowed to fail.** A blocked network, a paused Supabase
 * project, a corporate proxy that will not tunnel a WebSocket — none of those
 * is an error worth showing anybody. `open` resolves to null, San Francisco is
 * exactly the city it was a moment ago, and you are simply the only person in
 * it.
 */
import { isWire, type NetTransport, type Wire } from "./protocol";

/** Wall-clock ceiling on the handshake. */
const CONNECT_TIMEOUT_MS = 8000;

/** One broadcast topic. State and events are the same size and rate. */
const TOPIC = "p";

export type NetMode = "off" | "local" | "online";

/**
 * Open a transport, or return null and stay single player.
 *
 * Never rejects. Callers are gameplay code inside a frame loop and must not
 * have to think about this.
 */
export async function openTransport(mode: NetMode, room: string): Promise<NetTransport | null> {
  if (mode === "off") return null;
  try {
    return mode === "local" ? openLocal(room) : await openOnline(room);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Same machine
 * ------------------------------------------------------------------ */

function openLocal(room: string): NetTransport | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(`sf-${room}`);
  let handler: ((msg: Wire) => void) | null = null;

  // BroadcastChannel does not deliver a message back to the context that
  // posted it, so `self: false` comes free here. The peer table drops its own
  // id anyway; both halves of that belt are cheap.
  ch.onmessage = (ev: MessageEvent) => {
    if (handler && isWire(ev.data)) handler(ev.data);
  };

  return {
    send: (msg) => {
      try {
        ch.postMessage(msg);
      } catch {
        /* A closed channel throws on post. Nothing to do and nothing to say. */
      }
    },
    receive: (fn) => {
      handler = fn;
    },
    close: () => {
      handler = null;
      try {
        ch.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * The internet
 * ------------------------------------------------------------------ */

async function openOnline(room: string): Promise<NetTransport | null> {
  // Dynamic, so somebody who never turns multiplayer on does not download the
  // Supabase client to find that out.
  const { supabase } = await import("@/integrations/supabase/client");
  const channel = supabase.channel(`sf-${room}`, {
    config: { broadcast: { self: false, ack: false } },
  });

  let handler: ((msg: Wire) => void) | null = null;
  channel.on("broadcast", { event: TOPIC }, ({ payload }: { payload: unknown }) => {
    // Everything arriving here came off a public channel that anybody may
    // join. `isWire` is the only thing between a stranger's payload and a
    // frame callback.
    if (handler && isWire(payload)) handler(payload);
  });

  const ok = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    channel.subscribe((status: string) => {
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
      /* nothing to clean up */
    }
    return null;
  }

  return {
    send: (msg) => {
      // Fire and forget. `ack: false`, so this does not await a round trip;
      // a failed send is a dropped frame of somebody else's animation and the
      // next one is a whole truth anyway.
      void channel.send({ type: "broadcast", event: TOPIC, payload: msg });
    },
    receive: (fn) => {
      handler = fn;
    },
    close: () => {
      handler = null;
      void supabase.removeChannel(channel);
    },
  };
}
