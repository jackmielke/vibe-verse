/*!
 * vibeverse.js — put your game in the Vibeverse and let it pay its players.
 *
 * One file. No build step, no dependency, no account, no key. Drop it next to
 * your game, add one script tag, and call three functions. (The `/build` page
 * on the vibeverse prints this snippet with the right host already in it —
 * copy it from there rather than from here.)
 *
 *     <script src="https://<the-vibeverse>/vibeverse.js"></script>
 *     <script>
 *       const vibe = await Vibeverse.ready();
 *       // …your game…
 *       await Vibeverse.award(5, "cleared level 2");
 *       Vibeverse.exit();
 *     </script>
 *
 * That is the entire API. It is small on purpose: everything that decides how
 * much a player actually gets lives on the vibeverse's server, and nothing you
 * write here can change it. `award(5)` is a *request* — the answer tells you
 * what was really paid, which may be less, and your HUD should show that
 * number rather than the one you asked for.
 *
 * Which is the deal, stated once, so nothing about it is a surprise later:
 *
 *   * Your game runs on YOUR domain, in a sandboxed frame. You do not get a
 *     key, and you do not need one. You never see the player's identity, their
 *     wallet, their email, or their balance.
 *   * You cannot mint. Your game is given a daily allowance by a person who
 *     played it, and every award spends from that. When it runs out, `award()`
 *     starts returning zero and your game should keep being fun anyway.
 *   * Nothing here can navigate the player away, open a window, or read
 *     anything of ours. That is enforced by the browser, not by trust.
 *
 * **Running standalone.** Open your game directly — not in a frame — and every
 * call still resolves. `Vibeverse.inVibeverse` is false, `ready()` hands you a
 * sensible stub, and `award()` reports zero paid. So you can build and test
 * the whole thing on localhost before anybody has heard of you.
 */
(function (global) {
  "use strict";

  var TIMEOUT = 8000;

  var framed = (function () {
    try { return global.parent && global.parent !== global; } catch (_) { return true; }
  })();

  var pending = Object.create(null);
  var seq = 0;
  var helloResolve = null;
  var hello = null;

  /* The host only ever posts to the exact origin it approved for this game,
     so anything arriving from somewhere else is not the vibeverse and is
     dropped without a reply. */
  function onMessage(e) {
    var msg = e.data;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    if (msg.type === "vibeverse:hello") {
      hello = {
        currency: msg.currency || "Vibey Coins",
        symbol: msg.symbol || "✦",
        maxAward: Number(msg.maxAward) || 0,
        headroom: Number(msg.headroom) || 0,
      };
      if (helloResolve) { helloResolve(hello); helloResolve = null; }
      return;
    }

    if (msg.type === "vibeverse:awarded") {
      var entry = pending[msg.id];
      if (!entry) return;
      delete pending[msg.id];
      clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve({
          amount: Number(msg.amount) || 0,
          asked: Number(msg.asked) || 0,
          capped: !!msg.capped,
          headroom: Number(msg.headroom) || 0,
        });
      } else {
        entry.reject(new Error(String(msg.error || "the vibeverse said no")));
      }
    }
  }

  if (framed) global.addEventListener("message", onMessage);

  function send(msg) {
    try { global.parent.postMessage(msg, "*"); } catch (_) { /* not framed */ }
  }

  /* Why `"*"` is safe going out, when the host is so careful going in: nothing
     the game sends is a secret. It is a request for money that only the host
     can grant, and the host grants it against a session id the game has never
     seen. There is nothing here to leak to a wrong listener. */

  var Vibeverse = {
    /** True when this game is running inside the vibeverse. */
    inVibeverse: framed,

    /**
     * Say hello, and find out what this game can pay today.
     *
     * Resolves with `{ currency, symbol, maxAward, headroom }`:
     *   maxAward — the most any single `award()` can pay.
     *   headroom — the most this player can still earn here today.
     *
     * Call it once, at startup, before you show a coin anywhere in your UI.
     */
    ready: function () {
      if (!framed) {
        return Promise.resolve({
          currency: "Vibey Coins", symbol: "✦", maxAward: 0, headroom: 0,
        });
      }
      if (hello) return Promise.resolve(hello);
      return new Promise(function (resolve) {
        helloResolve = resolve;
        send({ type: "vibeverse:ready", version: 1 });
        // If the host never answers, resolve with zeroes rather than hanging.
        // A game that waits forever for a handshake is a black rectangle, and
        // a black rectangle is the worst possible failure mode.
        setTimeout(function () {
          if (helloResolve) {
            helloResolve({ currency: "Vibey Coins", symbol: "✦", maxAward: 0, headroom: 0 });
            helloResolve = null;
          }
        }, TIMEOUT);
      });
    },

    /**
     * Ask for coins.
     *
     *     const paid = await Vibeverse.award(5, "cleared level 2");
     *     hud.show(paid.amount);   // what actually landed — not 5
     *
     * `reason` shows up in the player's ledger next to your game's name, so
     * write it for them: "cleared level 2", not "LVL_CLEAR_EVT".
     *
     * Batch. One award per coin per frame will hit the request ceiling long
     * before it hits the budget — keep a running total in your game and flush
     * it every few seconds, or at the end of a round.
     *
     * Resolves `{ amount, asked, capped, headroom }`. `amount` is 0 when the
     * day's allowance is gone, and that is not an error: it is the normal
     * end-state of a game somebody has played a lot. Keep playing.
     */
    award: function (amount, reason) {
      var n = Math.floor(Number(amount));
      if (!isFinite(n) || n <= 0) {
        return Promise.reject(new Error("award(amount): amount must be a positive number"));
      }
      if (!framed) {
        return Promise.resolve({ amount: 0, asked: n, capped: true, headroom: 0 });
      }
      var id = "a" + (++seq);
      return new Promise(function (resolve, reject) {
        pending[id] = {
          resolve: resolve,
          reject: reject,
          timer: setTimeout(function () {
            delete pending[id];
            reject(new Error("the vibeverse did not answer"));
          }, TIMEOUT),
        };
        send({ type: "vibeverse:award", id: id, amount: n, reason: reason || "" });
      });
    },

    /**
     * Ask to be let out — back to the vibeverse.
     *
     * Wire this to your own "quit" button if you have one. The vibeverse
     * always draws its own way back too, so a game that never calls this is
     * not trapping anybody.
     */
    exit: function () { send({ type: "vibeverse:exit" }); },
  };

  global.Vibeverse = Vibeverse;
})(typeof window !== "undefined" ? window : this);
