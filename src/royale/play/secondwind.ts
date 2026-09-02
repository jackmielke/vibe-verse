/**
 * BETTER FORTNITE — second wind.
 *
 * Your first down of the match is not the end of it. The player system asks
 * this one, at the moment it would start the bleed-out, whether the death is
 * taken; if it is, a countdown runs here and at zero the player is put back
 * on the glider over the safe zone with full health and everything in the bag.
 * Once. The second down is a real one.
 *
 * Two clocks were the obvious design — the player's `downTimer` and one here —
 * and two clocks disagree, so there is one: this file counts, and the player
 * system, once it has handed the death over, simply does not count at all
 * until `redeploy` returns it to the sky.
 *
 * `alive` never moves for a second wind. `match.reportDeath` was never called,
 * so as far as the lobby is concerned you were never out — which is the
 * truth of it.
 */
import type { SecondWindService, SystemFactory } from "../types";
import { SECOND_WIND } from "../mode/better";

interface PlayerLike {
  redeploy?(altitude: number, health: number): void;
  state: string;
}

const createSecondWind: SystemFactory = (ctx) => {
  let uses = SECOND_WIND.uses;
  let countdown = 0;
  let pending = false;
  let lastShown = -1;

  const service: SecondWindService = {
    get available() {
      return uses > 0;
    },
    get countdown() {
      return countdown;
    },
    claim() {
      if (uses <= 0 || pending) return false;
      const player = ctx.services.player as unknown as PlayerLike | undefined;
      if (!player || typeof player.redeploy !== "function") return false;
      uses--;
      pending = true;
      countdown = SECOND_WIND.countdown;
      lastShown = -1;
      ctx.services.audio?.play("second-wind", { volume: 0.85 });
      ctx.emit("dz:second-wind", { phase: "countdown", seconds: countdown, remaining: uses });
      return true;
    },
  };
  ctx.services.secondWind = service;

  // Tell the HUD it is armed once the match is live, so the player knows it
  // exists before they need it.
  let announced = false;

  return {
    name: "second-wind",

    fixed(dt) {
      if (!pending) return;
      countdown = Math.max(0, countdown - dt);
      const whole = Math.ceil(countdown);
      if (whole !== lastShown) {
        lastShown = whole;
        ctx.emit("dz:second-wind", { phase: "countdown", seconds: countdown, remaining: uses });
        if (whole > 0 && whole <= 3) ctx.services.audio?.play("second-wind-tick", { volume: 0.5 });
      }
      if (countdown <= 0) {
        pending = false;
        const player = ctx.services.player as unknown as PlayerLike | undefined;
        player?.redeploy?.(SECOND_WIND.altitude, SECOND_WIND.health);
        ctx.services.audio?.play("second-wind-launch", { volume: 0.9 });
        ctx.emit("dz:second-wind", { phase: "launch", seconds: 0, remaining: uses });
      }
    },

    update() {
      if (announced) return;
      if (ctx.services.match?.phase === "live") {
        announced = true;
        ctx.emit("dz:second-wind", { phase: "armed", seconds: 0, remaining: uses });
      }
    },

    dispose() {
      if (ctx.services.secondWind === service) ctx.services.secondWind = undefined;
    },
  };
};

export default createSecondWind;
