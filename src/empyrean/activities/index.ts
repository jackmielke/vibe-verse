/**
 * ACTIVITIES — the things there are to do in The Empyrean, and the one small
 * machine that runs them.
 *
 * Four of them: ring races, courier runs, a photo hunt, and forty-eight
 * sunmotes scattered over every part of the island. Three are *activities* in
 * the strict sense — they start, they occupy the HUD's one activity slot, and
 * exactly one can be running at a time. The sunmotes are not: they are always
 * live, they need no prompt, and they are the thing a player who has read
 * nothing at all trips over in the first thirty seconds.
 *
 * ## What this module promises the engine
 *
 * - `interactables()` — a **stable array**, built once. The engine may hold on
 *   to it and read `x/y/z/enabled()` every frame; the "give up" entry moves
 *   with the player by having its coordinates written in `update`, which is
 *   why the array must never be rebuilt.
 * - `activity()` — the HUD's readout, or null. Allocates a few short strings,
 *   so call it at HUD rate (~10 Hz), not per frame.
 * - `drainToasts()` — empties a queue. Returns a shared empty array when there
 *   is nothing, so the common case costs nothing.
 * - `earned` / `found` — counters for the HUD.
 * - `interact(id)` — what to do when the interact key is pressed on a prompt.
 * - `abort()` — stop everything. The engine calls this on recall and on any
 *   teleport, because a race whose next gate is now behind you is worse than
 *   no race.
 *
 * ## What this module never does
 *
 * It does not move the player, it does not read the keyboard, and it does not
 * touch the network. Coins are counted here and banked by whoever owns the
 * wallet: `drainBanked()` hands over everything not yet paid out, and if
 * nobody ever calls it, the world still works and the HUD still counts.
 */
import * as THREE from "three";
import type { BuildContext, FrameContext, Interactable, System, Toast } from "../types";
import { ISLAND_Y } from "../config";
import { LANDMARKS } from "../cityplan";
import { Chimes, DEG, Toaster } from "./common";
import { buildRaces, COURSES, type RaceRunner } from "./races";
import { buildCourier, type CourierRunner } from "./courier";
import { buildPhotoHunt, type PhotoRunner } from "./photo";
import { buildFinds, type FindsField } from "./finds";

export type { Course, Gate } from "./races";
export type { Shot } from "./photo";
export type { Find, FindKind } from "./finds";
export { COURSES, gatePoints, gateNormals, racePayout, RACE_KEY } from "./races";
export { SHOTS, PHOTO_KEY } from "./photo";
export { placeFinds, FINDS_KEY, PICKUP_R } from "./finds";
export { buildChain, chainSeed, legPay, tierMultiplier, COURIER_KEY, REACH, REACH_Y } from "./courier";

export interface ActivitiesHandle extends System {
  interactables(): Interactable[];
  /** null when nothing is running. */
  activity(): { title: string; lines: string[]; progress?: number } | null;
  /** Drained by the engine each frame and pushed to the HUD. */
  drainToasts(): Toast[];
  /** Coins earned this session. */
  readonly earned: number;
  readonly found: { got: number; total: number };
  /** Called by the engine on the interact key when a prompt is showing. */
  interact(id: string): void;
  /** Abort whatever is running — the engine calls this on recall/teleport. */
  abort(): void;
  /**
   * Coins earned but not yet handed to the wallet, zeroed by the call.
   *
   * Nothing in this directory talks to Supabase; whoever owns the page decides
   * when and whether to bank. Ignoring this entirely is a supported way to run
   * the world.
   */
  drainBanked(): number;
}

/* -------------------------------------------------------------------------
 * Where the prompts stand
 * ---------------------------------------------------------------------- */

const landmark = (id: string) => LANDMARKS.find((l) => l.id === id)!;

/** A point `out` metres further from the axis than a landmark, on its bearing. */
function offAxis(id: string, out: number): { x: number; y: number; z: number } {
  const l = landmark(id);
  const a = Math.atan2(l.z, l.x);
  const r = Math.hypot(l.x, l.z) + out;
  return { x: Math.cos(a) * r, y: ISLAND_Y + 1.1, z: Math.sin(a) * r };
}

/** And one shifted along the street rather than across it. */
function alongStreet(id: string, side: number): { x: number; y: number; z: number } {
  const l = landmark(id);
  const a = Math.atan2(l.z, l.x);
  return {
    x: l.x - Math.sin(a) * side,
    y: ISLAND_Y + 1.1,
    z: l.z + Math.cos(a) * side,
  };
}

/**
 * Every prompt in the world, and where it stands.
 *
 * Kept at least eighteen metres apart on purpose: the engine shows the nearest
 * prompt and nothing else, so two of these on top of each other is one of them
 * being unreachable. Each also sits *outside* its landmark's footprint, where
 * there is pavement, rather than inside the building the landmark will become.
 */
export const STATIONS = {
  // Each race is offered where its own first gate is, which sounds obvious and
  // was not: the circuit's prompt sat on the Launch Terrace for a while with
  // its opening gate six hundred metres away over the Observatory.
  sprint: alongStreet("launch", 11),
  circuit: offAxis("observatory", -36),
  climb: offAxis("fountain", 16),
  slalom: offAxis("tram-halo", 20),
  courierStation: offAxis("tram-halo", -20),
  courierMarket: offAxis("market-hall", 36),
  // On the rim pavement beside the telescope, a step from the parapet.
  photo: offAxis("observatory", 24),
} as const;

/* -------------------------------------------------------------------------
 * The shell
 * ---------------------------------------------------------------------- */

type Slot = "race" | "courier" | "photo" | null;

export function buildActivities(ctx: BuildContext): ActivitiesHandle {
  const group = new THREE.Group();
  group.name = "empyrean-activities";

  const toaster = new Toaster();
  const chimes = new Chimes();

  let earned = 0;
  let banked = 0;
  let slot: Slot = null;
  let opened = false;

  const pay = (coins: number) => {
    if (!(coins > 0)) return;
    earned += coins;
    banked += coins;
  };
  const toast = (text: string, tone: Toast["tone"] = "info", ttl = 3.6) =>
    toaster.push(text, tone, ttl);
  const chime = (f: number, d?: number, g?: number) => chimes.play(f, d, g);
  const ended = () => {
    slot = null;
  };

  const races: RaceRunner = buildRaces({ toast, pay, ended, chime });
  const courier: CourierRunner = buildCourier({ toast, pay, ended, chime });
  const photo: PhotoRunner = buildPhotoHunt({ toast, pay, ended, chime });
  const finds: FindsField = buildFinds({
    toast,
    pay,
    chime,
    fanfare: () => chimes.arpeggio(523.25, [0, 4, 7, 12], 0.05),
  });

  group.add(races.group, courier.group, photo.group, finds.group);

  /* ---- the interactables, built once and mutated in place ---- */
  const idle = () => slot === null;
  const list: Interactable[] = [];

  for (const course of COURSES) {
    const spot = STATIONS[course.id as keyof typeof STATIONS] ?? course.startAt;
    list.push({
      id: `race.${course.id}`,
      x: spot.x,
      y: spot.y,
      z: spot.z,
      radius: 7,
      label: `Fly ${course.name}`,
      detail: course.blurb,
      enabled: idle,
      activate() {
        startRace(course.id);
      },
    });
  }

  list.push({
    id: "courier.market",
    x: STATIONS.courierMarket.x,
    y: STATIONS.courierMarket.y,
    z: STATIONS.courierMarket.z,
    radius: 7,
    label: "Take a courier run",
    detail: "The Market Hall always has something that should already be somewhere else.",
    enabled: idle,
    activate() {
      startCourier("Market Hall", STATIONS.courierMarket);
    },
  });

  list.push({
    id: "courier.station",
    x: STATIONS.courierStation.x,
    y: STATIONS.courierStation.y,
    z: STATIONS.courierStation.z,
    radius: 7,
    label: "Take a courier run",
    detail: "Halo Station's parcel window. Two drops to start with.",
    enabled: idle,
    activate() {
      startCourier("Halo Station", STATIONS.courierStation);
    },
  });

  list.push({
    id: "photo.hunt",
    x: STATIONS.photo.x,
    y: STATIONS.photo.y,
    z: STATIONS.photo.z,
    radius: 7,
    label: "Borrow the Observatory's camera",
    detail: "Eight views of the island somebody has described but not photographed.",
    enabled: idle,
    activate() {
      startPhoto();
    },
  });

  /**
   * The way out.
   *
   * Follows the player, and only offers itself when you are standing still on
   * something — mid-flight it would be a prompt you fumble into at 30 m/s
   * halfway round a race, which is exactly the moment you least want it.
   */
  let stopReady = false;
  const stop: Interactable = {
    id: "activity.stop",
    x: 0,
    y: 0,
    z: 0,
    radius: 3.5,
    label: "Call it off",
    detail: "Whatever you are in the middle of, stop it here.",
    enabled: () => stopReady,
    activate() {
      abort("player");
    },
  };
  list.push(stop);

  function startRace(id: string): void {
    if (slot) return;
    if (races.start(id, lastTime)) slot = "race";
  }
  function startCourier(name: string, where: { x: number; z: number }): void {
    if (slot) return;
    if (courier.start({ x: where.x, z: where.z, name: `${name}-${ctx.seedSalt}` }, lastTime)) {
      slot = "courier";
    }
  }
  function startPhoto(): void {
    if (slot) return;
    if (photo.start(lastTime)) slot = "photo";
  }

  function abort(reason: "recall" | "player"): void {
    if (slot === "race") races.abort(reason);
    else if (slot === "courier") courier.abort(reason);
    else if (slot === "photo") photo.abort(reason);
    slot = null;
  }

  let lastTime = 0;

  return {
    name: "activities",
    group,
    // The DETAIL graph. None of this belongs in the island's silhouette, and a
    // race gate reflected in the lake would be a race gate in the lake.
    reflected: false,

    update(frame: FrameContext) {
      lastTime = frame.time;
      finds.update(frame);
      races.update(frame);
      courier.update(frame);
      photo.update(frame);

      const p = frame.player.position;
      stop.x = p.x;
      stop.y = p.y;
      stop.z = p.z;
      const speed = Math.hypot(frame.player.velocity.x, frame.player.velocity.z);
      stopReady = slot !== null && frame.player.grounded && speed < 2.5;

      /* One line of onboarding, once, a few seconds in: enough to know there
       * is something here, not enough to be a tutorial.
       *
       * It leads with the aircraft because the aircraft is *visible from
       * where you are standing* — it is parked on a lit pad twenty metres up
       * the avenue from the arrival point, on purpose — and because getting
       * into it is one keypress. A first line that names something you can
       * see and act on immediately is worth three that describe the world. */
      if (!opened && frame.time > 6) {
        opened = true;
        toaster.push(
          `That aircraft on the pad flies — walk over and press E. ${finds.total - finds.got} sunmotes still out there.`,
          "info",
          7,
        );
      }
    },

    interactables() {
      return list;
    },

    activity() {
      if (slot === "race") return races.view();
      if (slot === "courier") return courier.view();
      if (slot === "photo") return photo.view();
      return null;
    },

    drainToasts() {
      return toaster.drain();
    },

    get earned() {
      return earned;
    },

    get found() {
      return { got: finds.got, total: finds.total };
    },

    interact(id: string) {
      for (const item of list) {
        if (item.id !== id) continue;
        if (item.enabled && !item.enabled()) return;
        item.activate();
        return;
      }
    },

    abort() {
      abort("recall");
    },

    drainBanked() {
      const n = banked;
      banked = 0;
      return n;
    },

    dispose() {
      abort("recall");
      races.dispose();
      courier.dispose();
      photo.dispose();
      finds.dispose();
      chimes.dispose();
      group.clear();
    },
  };
}

/** Degrees, for anybody laying out content against this module. */
export { DEG };
