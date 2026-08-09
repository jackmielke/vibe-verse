/**
 * The host side of the bridge — the part that decides what a stranger's game
 * is allowed to do.
 *
 * The whole third-party story rests on one asymmetry, and it lives in this
 * file rather than on the server, because the server cannot see it:
 *
 *     The game can ASK for an award. It can never TAKE one.
 *
 * Concretely: `vibe-portal open` mints a session id, which is the only
 * capability that can move money. That id stays here, on the vibeverse's own
 * origin, in a closure. It is never posted into the frame, never put in the
 * iframe's `src`, never included in a reply. The game posts
 * `{ type: "vibeverse:award", amount }` at its parent; this module decides
 * whether to attach the session id and call the server. A compromised game
 * gets exactly the reach of the messages below and nothing else.
 *
 * Everything the browser gives us for free is also switched on:
 *
 *   * a game on a third-party origin cannot read our localStorage, our
 *     Supabase session, or anything else of ours, because it is cross-origin.
 *     That is the wall, and it is the browser's, not ours;
 *   * `allow` is empty of everything a 2D game does not need — no camera, no
 *     microphone, no geolocation, no payment;
 *   * the sandbox withholds top-level navigation, popups and downloads, so a
 *     game cannot yank the player off the vibeverse or open anything;
 *   * every inbound message is checked against the ONE origin a human
 *     approved for that slug, not against a list, not against a wildcard.
 *
 * Two things this does NOT stop, both said plainly because a security note
 * that overclaims is worse than none:
 *
 *   * A game registered with `origin: "self"` is served from OUR origin, and
 *     `allow-same-origin` therefore means same as ours. It can read our
 *     localStorage. That is not a leak to be patched — it is what `self`
 *     means, and it is why `self` is only ever correct for a game that lives
 *     in this repository and has been read line by line. A stranger's game
 *     gets a real origin, and a real origin gets the wall above.
 *   * The *player* can open the console on our page and call the award
 *     endpoint themselves. That is the arcade's deal too. Budgets bound it;
 *     the ledger records it.
 */
import { awardFromPortal, type PortalSession } from "./api";

/** Messages a game may send us. Anything else is dropped without a reply. */
type Inbound =
  | { type: "vibeverse:ready"; version?: unknown }
  | { type: "vibeverse:award"; id?: unknown; amount?: unknown; reason?: unknown }
  | { type: "vibeverse:exit" };

export interface HostCallbacks {
  /** A payout landed (or was capped to zero). Move the balance in the chrome. */
  onAward: (r: { amount: number; balance: number; capped: boolean; headroom: number }) => void;
  /** The game asked to be let out. */
  onExit: () => void;
  /** The game said hello. Until this fires, the frame is still a grey box. */
  onReady: () => void;
}

/**
 * Resolve the approved origin for a game into something comparable with
 * `MessageEvent.origin`.
 *
 * `self` means "a game in this repository, served from our own origin". It is
 * stored as a keyword rather than a URL so one row works in dev, in preview
 * and in production without three copies that can drift apart.
 */
export function resolveOrigin(origin: string): string {
  return origin === "self" ? window.location.origin : origin;
}

/**
 * How many award requests we will forward before we stop listening.
 *
 * The server has its own limit and it is the one that matters. This one is
 * here so a game stuck in a loop costs the player's browser a hundred fetches
 * rather than however many frames it can render before they close the tab.
 */
const MAX_REQUESTS = 200;

export interface Bridge {
  /** Detach the listener. Safe to call twice. */
  stop: () => void;
}

/**
 * Start listening for one game, in one frame, for one session.
 *
 * `frame` is checked as well as `origin`: two portal games open in two tabs
 * post to two different windows, but a page that ever mounts two frames at
 * once needs `event.source` to tell them apart, and comparing it now is
 * cheaper than remembering to later.
 */
export function startBridge(
  frame: HTMLIFrameElement,
  session: PortalSession,
  cb: HostCallbacks,
): Bridge {
  const allowed = resolveOrigin(session.game.origin);
  let requests = 0;
  let stopped = false;

  const onMessage = (e: MessageEvent) => {
    if (stopped) return;
    // Both checks, every time. Origin alone would let any *other* frame on an
    // approved origin talk to us; source alone would let a different origin
    // that got a handle to this frame do it.
    if (e.origin !== allowed) return;
    if (e.source !== frame.contentWindow) return;

    const msg = e.data as Inbound;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "vibeverse:ready": {
        cb.onReady();
        // The handshake reply is deliberately thin. It carries what a game
        // needs to draw an honest HUD — the coin's name, what one award can be
        // worth, what is left to earn — and nothing that identifies the player
        // or authorises anything. No session id, no user id, no token.
        post(frame, allowed, {
          type: "vibeverse:hello",
          currency: "Vibey Coins",
          symbol: "✦",
          maxAward: session.game.maxAward,
          headroom: session.headroom,
        });
        return;
      }

      case "vibeverse:award": {
        if (requests++ >= MAX_REQUESTS) return;
        const amount = Math.floor(Number(msg.amount));
        if (!Number.isFinite(amount) || amount <= 0) {
          post(frame, allowed, {
            type: "vibeverse:awarded",
            id: msg.id ?? null,
            ok: false,
            error: "amount must be a positive number",
          });
          return;
        }
        const reason = typeof msg.reason === "string" ? msg.reason.slice(0, 80) : undefined;

        // …and here is the asymmetry, in one line: the session id comes from
        // our closure, not from the message.
        void awardFromPortal(session.sessionId, amount, reason)
          .then((r) => {
            if (stopped) return;
            cb.onAward(r);
            post(frame, allowed, {
              type: "vibeverse:awarded",
              id: msg.id ?? null,
              ok: true,
              // `amount` is what was actually paid, which may be less than
              // what was asked. A game that shows the player a number should
              // show this one, so the HUD and the wallet agree.
              amount: r.amount,
              asked: r.asked,
              capped: r.capped,
              headroom: r.headroom,
            });
          })
          .catch((err: Error) => {
            if (stopped) return;
            post(frame, allowed, {
              type: "vibeverse:awarded",
              id: msg.id ?? null,
              ok: false,
              error: err.message,
            });
          });
        return;
      }

      case "vibeverse:exit":
        cb.onExit();
        return;
    }
  };

  window.addEventListener("message", onMessage);
  return {
    stop: () => {
      stopped = true;
      window.removeEventListener("message", onMessage);
    },
  };
}

/** Always to the approved origin, never to `"*"`. */
function post(frame: HTMLIFrameElement, origin: string, msg: unknown): void {
  frame.contentWindow?.postMessage(msg, origin);
}

/**
 * The sandbox the frame gets.
 *
 * `allow-scripts` with `allow-same-origin` is the pair every guide tells you
 * to avoid, and the guides are right about the case they mean: framing content
 * you do not control *from your own origin*, where a frame can reach out and
 * strip its own sandbox attribute. Here the pair is required — a game needs
 * scripts, and it needs its own storage to save a high score — and the defence
 * is one level up rather than in this string. A third-party game sits on a
 * third-party origin, where `allow-same-origin` means "same as ITS origin" and
 * grants it nothing of ours. The frames that are genuinely same-origin are the
 * ones in this repository, and those are `origin: "self"` by hand.
 *
 * What is deliberately absent, and what each one buys:
 *   allow-top-navigation  — a game cannot move the player off the vibeverse
 *   allow-popups          — …or open a window anywhere else
 *   allow-modals          — …or block the page with alert()/prompt()
 *   allow-downloads       — …or push a file at somebody
 *   allow-forms           — …or POST anywhere on a click
 */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-pointer-lock";

/** No camera, no microphone, no location, no payment, no sensors. */
export const FRAME_ALLOW = "autoplay; fullscreen; gamepad";
