/**
 * BETTER FORTNITE — augments.
 *
 * A few times a match the player is handed three perks and takes one. This
 * system owns the clock that decides when, the roll that decides which, and the
 * ledger of what was taken. It does not apply anything: every system that has
 * a number an augment can turn multiplies its own constant by
 * `augments.factor(key)` (or adds `augments.bonus(key)`) at the moment it uses
 * it, and reads 1 (or 0) when this system is absent. That is the whole reason
 * classic mode is unchanged by this file existing — it never boots there, and
 * a factor nobody publishes is 1.
 *
 * Choosing is a key or a tap. The digit keys already mean "inventory slot",
 * so while an offer is open this system boots FIRST in the frame, eats
 * `input.slot` for 1..3, and the inventory sees null — the same trick the
 * build hotkeys play with the number row. Touch and mouse arrive as
 * `dz:augment-choose` from the HUD, which is the one direction the HUD is
 * allowed to talk (it emits, it never reaches into a system).
 *
 * Bots do not take augments. Ninety-nine of them rolling perks would be
 * invisible to the player and expensive to simulate, and the fairness argument
 * cuts the other way: the point of a perk is that YOU chose it.
 */
import type { AugmentKey, AugmentsService, SystemFactory } from "../types";
import { AUGMENTS, OFFER_SCHEDULE, augment, bonusOf, factorOf, rollOffer } from "../mode/better";

const createAugments: SystemFactory = (ctx) => {
  const owned: string[] = [];
  let offer: string[] = [];
  /** Offers still to come from the clock. */
  let clockOffers = OFFER_SCHEDULE.max;
  let liveT = 0;
  let nextAt = OFFER_SCHEDULE.firstAt;
  /** Elimination milestones already paid out. */
  const paidMilestones = new Set<number>();
  let lastElims = 0;
  /** Milestone offers wait behind an open hand. */
  let queued = 0;
  let wasLive = false;

  /* Memoised factors: `factor()` is called per bullet and per fixed step, and
     the answer only changes when the ledger does. */
  const factorCache = new Map<AugmentKey, number>();
  const bonusCache = new Map<AugmentKey, number>();
  const invalidate = () => {
    factorCache.clear();
    bonusCache.clear();
  };

  const service: AugmentsService = {
    factor(key) {
      let v = factorCache.get(key);
      if (v === undefined) {
        v = factorOf(owned, key);
        factorCache.set(key, v);
      }
      return v;
    },
    bonus(key) {
      let v = bonusCache.get(key);
      if (v === undefined) {
        v = bonusOf(owned, key);
        bonusCache.set(key, v);
      }
      return v;
    },
    get owned() {
      return owned;
    },
    get offer() {
      return offer;
    },
    choose(index) {
      return choose(index);
    },
    offerNow() {
      if (offer.length > 0) return false;
      open();
      return offer.length > 0;
    },
  };
  ctx.services.augments = service;

  function publish(): void {
    ctx.emit("dz:augment", {
      offer: offer.map(card),
      owned: owned.map(card),
      remaining: clockOffers + queued,
    });
  }

  function card(id: string) {
    const a = augment(id);
    return a
      ? { id, name: a.name, blurb: a.blurb, icon: a.icon, accent: a.accent }
      : { id, name: id, blurb: "", icon: "?", accent: 0xffffff };
  }

  function open(): void {
    if (offer.length > 0) {
      queued++;
      return;
    }
    offer = rollOffer(owned, ctx.rng);
    if (offer.length === 0) return;
    ctx.services.audio?.play("augment-offer", { volume: 0.7 });
    publish();
  }

  function choose(index: number): boolean {
    const id = offer[index];
    if (!id) return false;
    owned.push(id);
    invalidate();
    offer = [];
    const a = augment(id);
    ctx.services.audio?.play("augment-pick", { volume: 0.8 });
    ctx.emit("dz:augment-picked", { id, name: a?.name ?? id, icon: a?.icon ?? "", accent: a?.accent ?? 0xffffff });

    // Bulwark fills what it adds, right now — a perk that raises a ceiling
    // you then have to go and find shield for is a perk you cannot feel.
    const shieldNow = a?.bonuses?.maxShield ?? 0;
    const player = ctx.services.player;
    if (shieldNow > 0 && player) {
      player.maxShield += shieldNow;
      player.heal(0, shieldNow);
    }

    publish();
    if (queued > 0) {
      queued--;
      open();
    }
    return true;
  }

  const offChoose = ctx.on("dz:augment-choose", (p) => {
    const i = typeof p === "number" ? p : Number((p as { index?: number } | undefined)?.index);
    if (Number.isFinite(i)) choose(i);
  });

  // Vampire. `dz:eliminate` fires for every line in the feed; only the
  // player's own eliminations count, and only while they can use the health.
  const offElim = ctx.on("dz:eliminate", (p) => {
    const d = (p ?? {}) as { byPlayer?: boolean; onPlayer?: boolean };
    if (!d.byPlayer || d.onPlayer) return;
    const heal = service.bonus("healOnElim");
    if (heal > 0) ctx.services.player?.heal(heal, 0);
  });

  return {
    name: "augments",

    update(dt) {
      const match = ctx.services.match;
      const live = match?.phase === "live";
      if (live && !wasLive) {
        liveT = 0;
        lastElims = match?.eliminations ?? 0;
      }
      wasLive = live;
      if (!live) return;

      // Only the digit keys we mean. Anything past 3 is a slot as usual.
      const slot = ctx.input.slot;
      if (offer.length > 0 && slot !== null && slot >= 1 && slot <= offer.length) {
        choose(slot - 1);
        ctx.input.slot = null;
      }

      // Match time, not `ctx.elapsed`: the drop is a minute and a half, and
      // an augment offered on the bus is an augment nobody has landed for.
      // Simulated seconds, so the schedule holds under a slow renderer.
      liveT += dt;

      if (clockOffers > 0 && liveT >= nextAt) {
        clockOffers--;
        nextAt += OFFER_SCHEDULE.every;
        open();
      }

      const elims = match?.eliminations ?? 0;
      if (elims !== lastElims) {
        lastElims = elims;
        for (const m of OFFER_SCHEDULE.elimMilestones) {
          if (elims >= m && !paidMilestones.has(m)) {
            paidMilestones.add(m);
            open();
          }
        }
      }
    },

    dispose() {
      offChoose();
      offElim();
      if (ctx.services.augments === service) ctx.services.augments = undefined;
    },
  };
};

export default createAugments;
export { AUGMENTS };
