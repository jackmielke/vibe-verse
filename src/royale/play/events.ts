/**
 * BETTER FORTNITE — island events.
 *
 * Each circle brings something with it. The storm publishes `circle`; this
 * system watches it change and fires whatever `ISLAND_EVENTS` says belongs to
 * that circle, runs its clock, and undoes it. The effects are all one-liners
 * against services that already exist — a supply drop the loot system already
 * knows how to spawn, a gravity scale the player already integrates under, a
 * sky preset the sky already grades for — which is why five events fit in one
 * file: the island already knew how to do all of this, nothing was asking.
 *
 * Every effect is reversed in `dispose` as well as on its own timer, so a
 * world torn down mid-nightfall does not hand the next world a dusk.
 */
import type { EventsService, IslandEventId, SystemFactory } from "../types";
import { EVENT_TUNING, ISLAND_EVENTS, eventForCircle, islandEvent } from "../mode/better";

interface SkyLike {
  setPreset?(name: string): void;
}
interface LootLike {
  requestSupplyDrop?(at?: { x: number; y: number; z: number }): boolean;
}
interface StormLike {
  circle: number;
  sampleSafePoint?(): { x: number; y: number; z: number };
}

const createEvents: SystemFactory = (ctx) => {
  let active: IslandEventId | null = null;
  let remaining = 0;
  let stormDamage = 1;
  let lastCircle = 0;
  const fired = new Set<IslandEventId>();
  /** Supply drops are staggered so six beams do not land as one. */
  let dropsLeft = 0;
  let dropTimer = 0;
  let gravityHeld = false;
  let nightHeld = false;

  const service: EventsService = {
    get active() {
      return active;
    },
    get remaining() {
      return remaining;
    },
    get stormDamage() {
      return stormDamage;
    },
    trigger(id) {
      return trigger(id);
    },
  };
  ctx.services.events = service;

  function endActive(): void {
    if (!active) return;
    if (active === "low-gravity" && gravityHeld) {
      const player = ctx.services.player;
      if (player) player.gravityScale = 1;
      gravityHeld = false;
    }
    if (active === "nightfall" && nightHeld) {
      (ctx.services.sky as SkyLike | undefined)?.setPreset?.(EVENT_TUNING.dayPreset);
      nightHeld = false;
    }
    ctx.emit("dz:event", { id: active, phase: "end" });
    active = null;
    remaining = 0;
  }

  function trigger(id: IslandEventId): boolean {
    const def = islandEvent(id);
    if (!def) return false;
    endActive();
    fired.add(id);
    active = id;
    remaining = def.duration;

    switch (id) {
      case "supply-storm": {
        dropsLeft = EVENT_TUNING.supplyDrops;
        dropTimer = 0;
        break;
      }
      case "low-gravity": {
        const player = ctx.services.player;
        if (player) {
          player.gravityScale = EVENT_TUNING.lowGravity;
          gravityHeld = true;
        }
        break;
      }
      case "nightfall": {
        (ctx.services.sky as SkyLike | undefined)?.setPreset?.(EVENT_TUNING.nightPreset);
        nightHeld = true;
        break;
      }
      case "shield-rain": {
        ctx.services.player?.heal(0, EVENT_TUNING.shieldRain);
        break;
      }
      case "sudden-death": {
        stormDamage = EVENT_TUNING.suddenDeath;
        break;
      }
    }

    ctx.services.audio?.play("event-sting", { volume: 0.8 });
    ctx.emit("dz:event", {
      id,
      phase: "start",
      name: def.name,
      sub: def.sub,
      accent: def.accent,
      duration: def.duration,
    });
    // Instants end in the same breath; the banner has its own timer.
    if (def.duration <= 0 && id !== "supply-storm") {
      ctx.emit("dz:event", { id, phase: "end" });
      active = null;
    }
    return true;
  }

  return {
    name: "island-events",

    fixed(dt) {
      // The drops. One every half second, each somewhere inside the circle.
      if (dropsLeft > 0) {
        dropTimer -= dt;
        if (dropTimer <= 0) {
          dropTimer = 0.5;
          dropsLeft--;
          const storm = ctx.services.storm as unknown as StormLike | undefined;
          const loot = ctx.services.loot as unknown as LootLike | undefined;
          const at = storm?.sampleSafePoint?.();
          loot?.requestSupplyDrop?.(at);
          if (dropsLeft === 0 && active === "supply-storm") {
            ctx.emit("dz:event", { id: active, phase: "end" });
            active = null;
          }
        }
      }

      if (active && remaining > 0) {
        remaining = Math.max(0, remaining - dt);
        if (remaining <= 0) endActive();
      }
    },

    update() {
      const match = ctx.services.match;
      if (match?.phase !== "live") return;
      const storm = ctx.services.storm as unknown as StormLike | undefined;
      if (!storm) return;
      const circle = storm.circle;
      if (circle !== lastCircle) {
        lastCircle = circle;
        const def = eventForCircle(circle);
        if (def && !fired.has(def.id)) trigger(def.id);
      }
    },

    dispose() {
      endActive();
      if (ctx.services.events === service) ctx.services.events = undefined;
    },
  };
};

export default createEvents;
export { ISLAND_EVENTS };
