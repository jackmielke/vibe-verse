/**
 * COURIER RUNS — pick something up at a shop door, get it across the island.
 *
 * ## Doorsteps, not walls
 *
 * Every address in a run is a `door` from the plan, and that is deliberate to
 * the point of being the reason this file reads the plan at all. A block is
 * held clear of the pavement it faces and a lot is inset inside its block
 * again, so between a shopfront and the kerb there are two or three metres of
 * dead ground with nothing walkable in it. `Lot.frontMid` is the wall;
 * `Lot.door` is the first point outward that a body can actually stand on, and
 * `CityPlan.doors` is the list of them. A delivery target on a wall is a
 * delivery target you cannot reach on foot, and half of this activity is
 * running the last thirty metres because the alley is too tight to fly.
 *
 * ## No fail state, only a smaller envelope
 *
 * The clock never cancels a run. Past the allowance the legs simply pay less,
 * down to a floor of about half, and the run still completes and still pays
 * its bonus. A hard landing jolts the parcel and costs a quarter of that one
 * leg — once, not repeatedly, because being punished twice for one mistake is
 * how a generous game turns mean.
 *
 * ## Escalation
 *
 * The first run of a session is two drops. Each completed run adds one, up to
 * five, and the tier multiplier climbs with it. A good courier ends the
 * evening on a five-drop chain worth three times their first.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import type { FrameContext } from "../types";
import { ISLAND_Y } from "../config";
import { cityPlan, districtAt, type Lot } from "../cityplan";
import {
  buildPillar,
  clamp,
  formatDist,
  formatTime,
  readStore,
  writeStore,
  type Pillar,
} from "./common";

export const COURIER_KEY = "empyrean.courier.v1";

export interface CourierRecord {
  runs: number;
  drops: number;
  bestRun: number;
}

/** What is in the box. Nothing in this world is heavier than a wedding cake. */
const GOODS = [
  "a crate of lamp oil",
  "sixty pastries, still warm",
  "orchid cuttings",
  "a violin, mended",
  "a telescope lens",
  "somebody's laundry",
  "a wedding cake",
  "two hundred paper lanterns",
  "a box of very quiet kittens",
  "spare glass for the Beacon",
  "a bag of coffee and an apology",
  "one enormous cheese",
] as const;

export interface Stop {
  /** Lot id, so a test can find the doorstep again. */
  lot: string;
  x: number;
  z: number;
  /** The address, said out loud. */
  label: string;
  /** Seconds this leg is worth full price inside. */
  allowance: number;
  /** Metres from the previous stop. */
  dist: number;
}

/** How near the doorstep counts as arriving. Metres, horizontal. */
export const REACH = 9;
/** And how far above the deck. You have to come down to the door. */
export const REACH_Y = 16;

/* -------------------------------------------------------------------------
 * Building a chain
 * ---------------------------------------------------------------------- */

function addressFor(lot: Lot, n: number): string {
  return `No. ${n}, ${districtAt(lot.r).name}`;
}

/**
 * A chain of doors, each a decent flight from the last.
 *
 * Seeded per run rather than random: two players who take the same run number
 * from the same dispatch get the same chain, which makes a bug reproducible
 * and costs the player nothing they would notice.
 */
export function buildChain(
  seed: string,
  drops: number,
  near: { x: number; z: number },
): Stop[] {
  const plan = cityPlan();
  const lots = plan.lots.filter((l) => l.use !== "garden");
  const rng = makeRng(seed);
  const chain: Stop[] = [];
  const used = new Set<string>();

  const pushStop = (lot: Lot, from: { x: number; z: number } | null) => {
    const dist = from ? Math.hypot(lot.door.x - from.x, lot.door.z - from.z) : 0;
    chain.push({
      lot: lot.id,
      x: lot.door.x,
      z: lot.door.z,
      label: addressFor(lot, 3 + Math.floor(lot.seed * 96)),
      allowance: dist / 15 + 12,
      dist,
    });
    used.add(lot.id);
  };

  // The pickup: the nearest handful of doors to the dispatch, one of them.
  const byNear = lots
    .slice()
    .sort(
      (a, b) =>
        Math.hypot(a.door.x - near.x, a.door.z - near.z) -
        Math.hypot(b.door.x - near.x, b.door.z - near.z),
    )
    .slice(0, 8);
  pushStop(rng.pick(byNear), null);

  for (let i = 0; i < drops; i++) {
    const from = chain[chain.length - 1];
    // Somewhere between a hundred and four hundred metres away, so every leg
    // is worth taking off for and none of them crosses the island twice.
    const want = 130 + rng.next() * 260;
    let best: Lot | null = null;
    let bestScore = Infinity;
    for (const lot of lots) {
      if (used.has(lot.id)) continue;
      const d = Math.hypot(lot.door.x - from.x, lot.door.z - from.z);
      const score = Math.abs(d - want) + rng.next() * 40;
      if (score < bestScore) {
        bestScore = score;
        best = lot;
      }
    }
    if (!best) break;
    pushStop(best, from);
  }
  return chain;
}

/* -------------------------------------------------------------------------
 * What a leg is worth
 * ---------------------------------------------------------------------- */

export function legPay(dist: number, took: number, allowance: number, jolted: boolean): number {
  const base = 6 + dist / 45;
  const t = took / Math.max(allowance, 1);
  const timeliness =
    t <= 0.6 ? 1.35 : t <= 1 ? 1.35 - (0.35 * (t - 0.6)) / 0.4 : Math.max(0.6, 1 - 0.25 * (t - 1));
  return Math.max(3, Math.round(base * timeliness * (jolted ? 0.75 : 1)));
}

export function tierMultiplier(drops: number): number {
  return 1 + 0.15 * Math.max(0, drops - 2);
}

/* -------------------------------------------------------------------------
 * The runner
 * ---------------------------------------------------------------------- */

export interface CourierHooks {
  toast(text: string, tone?: "info" | "good" | "warn"): void;
  pay(coins: number): void;
  ended(): void;
  chime(freq: number, dur?: number, gain?: number): void;
}

export interface CourierRunner {
  group: THREE.Object3D;
  start(dispatch: { x: number; z: number; name: string }, time: number): boolean;
  abort(reason: "recall" | "player"): void;
  running(): boolean;
  update(ctx: FrameContext): void;
  view(): { title: string; lines: string[]; progress?: number } | null;
  dispose(): void;
}

export function buildCourier(hooks: CourierHooks): CourierRunner {
  const group = new THREE.Group();
  group.name = "empyrean-courier";
  group.visible = false;

  const pillar: Pillar = buildPillar();

  /* The doorstep marker: a slow-turning diamond over the address, and a disc
   * on the pavement under it so you can find the door from directly above,
   * which is how a jetpack arrives at everything. */
  const markGeo = new THREE.OctahedronGeometry(1.5, 0);
  const markMat = new THREE.MeshBasicMaterial({
    color: 0xffc978,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mark = new THREE.Mesh(markGeo, markMat);
  mark.frustumCulled = false;

  const discGeo = new THREE.RingGeometry(3.4, 4.6, 28);
  discGeo.rotateX(-Math.PI / 2);
  const disc = new THREE.Mesh(discGeo, markMat);
  disc.frustumCulled = false;

  /* The parcel itself, carried behind the player's shoulder. It is drawn, not
   * attached: this module reads `ctx.player` and never touches it. */
  const parcelGeo = new THREE.BoxGeometry(0.62, 0.62, 0.62);
  const parcelMat = new THREE.MeshBasicMaterial({ color: 0xf6d9a0 });
  const parcel = new THREE.Mesh(parcelGeo, parcelMat);
  parcel.visible = false;

  group.add(pillar.object, mark, disc, parcel);

  const lines: string[] = ["", "", ""];
  let chain: Stop[] = [];
  let at = 0;
  let carrying = false;
  let jolted = false;
  let legStart = 0;
  let runStart = 0;
  let earnedThisRun = 0;
  let good = "";
  let drops = 2;
  let record = readStore<CourierRecord>(COURIER_KEY, { runs: 0, drops: 0, bestRun: 0 });
  let sessionRuns = 0;
  let active = false;
  let now = 0;
  let wasGrounded = true;
  let prevVy = 0;

  function aim(): void {
    if (at >= chain.length) return;
    const s = chain[at];
    pillar.set(s.x, ISLAND_Y, s.z, carrying ? 0x9ce8a8 : 0xffc978);
    mark.position.set(s.x, ISLAND_Y + 6.5, s.z);
    disc.position.set(s.x, ISLAND_Y + 0.35, s.z);
    (markMat.color as THREE.Color).set(carrying ? 0x9ce8a8 : 0xffc978);
  }

  function stop(): void {
    active = false;
    carrying = false;
    chain = [];
    group.visible = false;
    parcel.visible = false;
    pillar.hide();
    hooks.ended();
  }

  return {
    group,

    start(dispatch, time) {
      drops = clamp(2 + sessionRuns, 2, 5);
      chain = buildChain(`empyrean-courier-${dispatch.name}-${record.runs + sessionRuns}`, drops, dispatch);
      if (chain.length < 2) return false;
      at = 0;
      carrying = false;
      jolted = false;
      earnedThisRun = 0;
      runStart = time;
      legStart = time;
      good = GOODS[(record.runs + sessionRuns) % GOODS.length];
      active = true;
      group.visible = true;
      aim();
      hooks.toast(
        `${drops}-drop run · collect ${good} at ${chain[0].label}`,
        "info",
        5,
      );
      return true;
    },

    abort(reason) {
      if (!active) return;
      // Half of what the run has earned so far, and never nothing.
      const consolation = Math.max(0, Math.round(earnedThisRun * 0.5));
      if (consolation > 0) hooks.pay(consolation);
      hooks.toast(
        reason === "recall"
          ? `Run abandoned — the parcel found its own way${consolation ? ` · +${consolation} ✦` : ""}`
          : `Run handed back${consolation ? ` · +${consolation} ✦` : ""}`,
        "info",
      );
      stop();
    },

    running() {
      return active;
    },

    update(ctx) {
      pillar.update(ctx.time);
      now = ctx.time;
      if (!active) return;

      mark.rotation.y += ctx.dt * 1.1;
      mark.position.y = ISLAND_Y + 6.5 + Math.sin(ctx.time * 1.7) * 0.5;

      const p = ctx.player.position;

      if (carrying) {
        // Over the left shoulder, in the body's frame, with a little float.
        const s = Math.sin(ctx.player.yaw);
        const c = Math.cos(ctx.player.yaw);
        parcel.position.set(
          p.x + c * 0.55 - s * 0.15,
          p.y + 1.35 + Math.sin(ctx.time * 2.3) * 0.05,
          p.z - s * 0.55 - c * 0.15,
        );
        parcel.rotation.y = ctx.player.yaw + Math.sin(ctx.time * 0.9) * 0.2;

        /* A hard landing jolts the box. `PlayerView` has no impact field, so
         * the touchdown is caught the way the eye catches it: airborne one
         * frame, grounded the next, and falling fast on the frame before. */
        if (!wasGrounded && ctx.player.grounded && prevVy < -15 && !jolted) {
          jolted = true;
          hooks.toast("Hard landing — something in there rattled", "warn");
          hooks.chime(180, 0.3, 0.05);
        }
      }
      wasGrounded = ctx.player.grounded;
      prevVy = ctx.player.velocity.y;

      if (at >= chain.length) return;
      const target = chain[at];
      const dx = p.x - target.x;
      const dz = p.z - target.z;
      const flat = Math.hypot(dx, dz);
      const near = flat < REACH && Math.abs(p.y - ISLAND_Y) < REACH_Y;
      if (!near) return;

      if (!carrying) {
        carrying = true;
        parcel.visible = true;
        legStart = ctx.time;
        at++;
        aim();
        hooks.toast(`Collected ${good} · ${chain[at].label} next`, "good");
        hooks.chime(520, 0.25, 0.045);
        return;
      }

      const took = ctx.time - legStart;
      const coins = Math.round(legPay(target.dist, took, target.allowance, jolted) * tierMultiplier(drops));
      earnedThisRun += coins;
      hooks.pay(coins);
      jolted = false;
      legStart = ctx.time;
      at++;
      hooks.chime(660, 0.25, 0.045);

      if (at >= chain.length) {
        const bonus = Math.round(5 * drops * tierMultiplier(drops));
        earnedThisRun += bonus;
        hooks.pay(bonus);
        sessionRuns++;
        record = {
          runs: record.runs + 1,
          drops: record.drops + drops,
          bestRun: Math.max(record.bestRun, earnedThisRun),
        };
        writeStore(COURIER_KEY, record);
        hooks.toast(
          `Run complete in ${formatTime(ctx.time - runStart)} · +${coins + bonus} ✦`,
          "good",
          5,
        );
        hooks.chime(880, 0.5, 0.05);
        stop();
        return;
      }
      aim();
      hooks.toast(`Delivered · +${coins} ✦ · ${chain[at].label} next`, "good");
    },

    view() {
      if (!active) return null;
      const target = chain[at];
      if (!target) return null;
      lines[0] = carrying ? `Deliver to ${target.label}` : `Collect at ${target.label}`;
      const left = target.allowance - (now - legStart);
      lines[1] = `${formatDist(target.dist || 0)} leg · ${
        left > 0 ? `${formatTime(left)} for full rate` : "over — still paying"
      }`;
      lines[2] = `${Math.max(0, at - 1)} of ${drops} delivered · ${earnedThisRun} ✦ so far`;
      return {
        title: carrying ? `Carrying ${good}` : "Courier run",
        lines,
        progress: clamp((at - 1) / drops, 0, 1),
      };
    },

    dispose() {
      pillar.dispose();
      markGeo.dispose();
      markMat.dispose();
      discGeo.dispose();
      parcelGeo.dispose();
      parcelMat.dispose();
      group.clear();
    },
  };
}
