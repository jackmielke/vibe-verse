/**
 * The director: who moves, when, and whether it kills you.
 *
 * This is the original's design and it is worth stating plainly, because the
 * whole game is three lines of arithmetic. Each character has an *AI level*
 * from 0 to 20. Every few seconds it rolls a d20; if the roll comes in under
 * its level, it takes one step along its route. That's it. Everything that
 * feels like intelligence — the pauses, the sudden rushes, the night where
 * Bonnie will not leave your door — falls out of a dice roll and a graph.
 *
 * What's changed here: a step is a *walk*, not a cut. The character has to
 * physically cross the room, which means the sound of it crossing is real
 * information, and a camera pointed at a hallway can catch one in transit.
 */
import type { AnimKind } from "./animatronics";
import type { RoomId } from "./rooms";

export interface AiConfig {
  freddy: number;
  bonnie: number;
  chica: number;
  foxy: number;
  /** Vibey. He plays by the same rules; he is just nice about it. */
  vibey: number;
}

/**
 * Night difficulty. Not the original's exact table — night 1 there is all
 * zeroes, which is correct for a game you'll play for a week and wrong for one
 * somebody opens from a link. Night 1 here gives you a slow Bonnie so that the
 * first thing you learn is that the doors matter.
 */
export const NIGHTS: AiConfig[] = [
  { freddy: 0, bonnie: 2, chica: 1, foxy: 1, vibey: 2 },
  { freddy: 1, bonnie: 4, chica: 3, foxy: 3, vibey: 3 },
  { freddy: 2, bonnie: 6, chica: 5, foxy: 5, vibey: 4 },
  { freddy: 4, bonnie: 8, chica: 7, foxy: 7, vibey: 5 },
  { freddy: 6, bonnie: 10, chica: 10, foxy: 10, vibey: 6 },
  { freddy: 10, bonnie: 14, chica: 14, foxy: 14, vibey: 9 }, // night 6, once you've earned it
  { freddy: 20, bonnie: 20, chica: 20, foxy: 20, vibey: 20 }, // 5/20. Good luck.
];

export const NIGHT_COUNT = NIGHTS.length;

/** Where each character can go from where it is. Repeats are weights. */
const ROUTES: Record<AnimKind, Partial<Record<RoomId, RoomId[]>>> = {
  bonnie: {
    stage: ["dining"],
    dining: ["backstage", "westHall", "westHall"],
    backstage: ["westHall", "westHall", "dining"],
    westHall: ["westCorner", "westCorner", "supply"],
    supply: ["westHall"],
    westCorner: ["office"],
  },
  chica: {
    stage: ["dining"],
    dining: ["restrooms", "eastHall", "eastHall"],
    restrooms: ["kitchen", "kitchen", "dining"],
    kitchen: ["eastHall", "eastHall", "restrooms"],
    eastHall: ["eastCorner", "eastCorner", "kitchen"],
    eastCorner: ["office"],
  },
  /*
   * Freddy goes anywhere. He used to own one corridor — stage, dining,
   * restrooms, kitchen, east hall, east door — which meant that once you knew
   * the game you never checked the west side for him and he was really just a
   * slower Chica. He can now reach every room in the building, including the
   * supply closet and the kitchen, and he can come to *either* door.
   *
   * The weighting still leans forward: hall entries repeat, so he drifts
   * towards a door rather than wandering the dining room all night.
   */
  freddy: {
    stage: ["dining", "dining", "backstage"],
    dining: ["restrooms", "eastHall", "westHall", "cove", "stage"],
    restrooms: ["kitchen", "kitchen", "dining"],
    kitchen: ["eastHall", "eastHall", "restrooms"],
    eastHall: ["eastCorner", "eastCorner", "kitchen", "dining"],
    eastCorner: ["office"],
    westHall: ["westCorner", "westCorner", "supply", "dining"],
    westCorner: ["office"],
    supply: ["westHall", "westHall", "dining"],
    backstage: ["dining", "westHall"],
    cove: ["dining", "westHall"],
  },
  foxy: {},
  /*
   * Vibey wanders the whole building too, but he is not hunting — he drifts,
   * doubles back, and visits rooms with nothing in them. Every room links to
   * most of its neighbours with no forward weighting, which is what makes him
   * read as pottering about rather than closing in.
   */
  vibey: {
    stage: ["dining", "backstage"],
    dining: ["stage", "cove", "restrooms", "westHall", "eastHall"],
    backstage: ["stage", "dining"],
    cove: ["dining", "westHall"],
    restrooms: ["dining", "kitchen"],
    kitchen: ["restrooms", "eastHall"],
    westHall: ["dining", "supply", "westCorner"],
    supply: ["westHall"],
    eastHall: ["dining", "kitchen", "eastCorner"],
    westCorner: ["office", "westHall"],
    eastCorner: ["office", "eastHall"],
  },
};

/**
 * Exposed for `src/test/fnaf.test.ts`, which checks these against the floor
 * plan's navmesh. The two are separate structures that have to agree, and a
 * route to an unreachable room does not throw — it walks through a wall.
 */
export const ROUTES_FOR_TEST = ROUTES;

/** Seconds between d20 rolls. Freddy thinks faster and moves less far. */
const INTERVAL: Record<AnimKind, number> = {
  freddy: 3.4,
  bonnie: 4.9,
  chica: 5.1,
  foxy: 5.4,
  vibey: 4.2,
};

export interface Agent {
  kind: AnimKind;
  level: number;
  room: RoomId;
  timer: number;
  /** Ticking down while stood in a doorway, deciding whether to come in. */
  doorTimer: number;
  atDoor: boolean;
  /** Foxy only: 0 peeking, 1 leaning out, 2 stood up, 3 about to run. */
  coveStage: number;
  running: boolean;
}

export interface DirectorHooks {
  /** Is the monitor up, and on which room? */
  watching: () => RoomId | null;
  /** Left/right office doors — true when shut. */
  doorClosed: (side: "left" | "right") => boolean;
  /** Move a character to a room; the engine turns this into a walk. */
  moveTo: (kind: AnimKind, room: RoomId) => void;
  /** Arrived-at-door, blocked, and the kill. */
  onArriveAtDoor: (kind: AnimKind, side: "left" | "right") => void;
  onBlocked: (kind: AnimKind, side: "left" | "right") => void;
  onKill: (kind: AnimKind) => void;
  /** Foxy's sprint, and the power he costs you when the door holds. */
  onFoxyRun: () => void;
  onFoxyBlocked: (penalty: number) => void;
  /** True while a character is still physically walking. */
  isWalking: (kind: AnimKind) => boolean;
}

export class Director {
  agents: Record<AnimKind, Agent>;
  private hooks: DirectorHooks;
  /** How long since the player last looked at any camera. Foxy counts. */
  private sinceCamera = 0;
  private foxyRuns = 0;
  /** Freddy stays on stage until he has the place to himself. */
  private freddyReleased = false;
  private over = false;

  constructor(cfg: AiConfig, hooks: DirectorHooks) {
    this.hooks = hooks;
    const mk = (kind: AnimKind, level: number): Agent => ({
      kind,
      level,
      room: kind === "foxy" ? "cove" : kind === "vibey" ? "dining" : "stage",
      timer: INTERVAL[kind] * (0.6 + Math.random() * 0.8),
      doorTimer: 0,
      atDoor: false,
      coveStage: 0,
      running: false,
    });
    this.agents = {
      freddy: mk("freddy", cfg.freddy),
      bonnie: mk("bonnie", cfg.bonnie),
      chica: mk("chica", cfg.chica),
      foxy: mk("foxy", cfg.foxy),
      vibey: mk("vibey", cfg.vibey),
    };
  }

  /** Called on the hour: everybody gets a little worse. */
  escalate(hour: number) {
    if (hour === 2 || hour === 4) {
      for (const a of Object.values(this.agents)) a.level = Math.min(20, a.level + 1);
    }
  }

  stop() {
    this.over = true;
  }

  update(dt: number, monitorUp: boolean) {
    if (this.over) return;
    this.sinceCamera = monitorUp ? 0 : this.sinceCamera + dt;
    const watched = this.hooks.watching();

    for (const a of Object.values(this.agents)) {
      if (a.kind === "foxy") this.tickFoxy(a, dt, watched);
      else this.tickWalker(a, dt, watched);
    }
  }

  private sideOf(room: RoomId): "left" | "right" {
    return room === "westCorner" ? "left" : "right";
  }

  private tickWalker(a: Agent, dt: number, watched: RoomId | null) {
    // Standing in your doorway: a countdown you answer with a button.
    if (a.atDoor) {
      const side = this.sideOf(a.room);
      a.doorTimer -= dt;
      if (this.hooks.doorClosed(side)) {
        // The door came down in time. Back down the hall, and try again.
        a.atDoor = false;
        a.doorTimer = 0;
        a.room = side === "left" ? "westHall" : "eastHall";
        a.timer = INTERVAL[a.kind] * 2;
        this.hooks.moveTo(a.kind, a.room);
        this.hooks.onBlocked(a.kind, side);
        return;
      }
      if (a.doorTimer <= 0) {
        this.over = true;
        this.hooks.onKill(a.kind);
      }
      return;
    }

    // Still crossing the last room — no rolling mid-stride.
    if (this.hooks.isWalking(a.kind)) return;

    a.timer -= dt;
    if (a.timer > 0) return;
    a.timer = INTERVAL[a.kind];

    // Freddy is shy: he will not move while you are looking at him, and he
    // will not leave the stage until one of the others already has.
    if (a.kind === "freddy") {
      if (watched === a.room) return;
      if (!this.freddyReleased) {
        this.freddyReleased =
          this.agents.bonnie.room !== "stage" || this.agents.chica.room !== "stage";
        if (!this.freddyReleased) return;
      }
    }

    if (Math.random() * 20 >= a.level) return;

    const options = ROUTES[a.kind][a.room];
    if (!options?.length) return;
    const next = options[Math.floor(Math.random() * options.length)];

    if (next === "office") {
      // Arrived in the doorway. The countdown starts now.
      a.atDoor = true;
      a.doorTimer = 5.5 + Math.random() * 4;
      this.hooks.onArriveAtDoor(a.kind, this.sideOf(a.room));
      return;
    }

    a.room = next;
    this.hooks.moveTo(a.kind, next);
  }

  private tickFoxy(a: Agent, dt: number, watched: RoomId | null) {
    if (a.running) {
      // The engine reports the sprint's outcome through foxyArrived().
      return;
    }
    if (this.hooks.isWalking("foxy")) return;

    a.timer -= dt;
    if (a.timer > 0) return;
    a.timer = INTERVAL.foxy;

    // Watching Pirate Cove holds him back. Ignoring the cameras entirely is
    // how you get a fox in your office, and it is the reason to check cams
    // even on a night when nobody else is moving.
    if (watched === "cove") return;
    const neglect = Math.min(8, this.sinceCamera / 4);
    if (Math.random() * 20 >= a.level + neglect) return;

    a.coveStage += 1;
    if (a.coveStage >= 4) {
      a.running = true;
      a.room = "westHall";
      this.foxyRuns += 1;
      this.hooks.onFoxyRun();
    }
  }

  /** Called by the engine when Foxy reaches the west door. */
  foxyArrived() {
    const a = this.agents.foxy;
    a.running = false;
    if (this.hooks.doorClosed("left")) {
      a.coveStage = 0;
      a.room = "cove";
      a.timer = INTERVAL.foxy * 3;
      this.hooks.moveTo("foxy", "cove");
      // Every trip costs a little more than the last: he leans harder. Kept
      // small — the battery is a budget of presses now, not a clock.
      this.hooks.onFoxyBlocked(3 + this.foxyRuns);
    } else {
      this.over = true;
      this.hooks.onKill("foxy");
    }
  }

  /** For the HUD's debug line and the "who's at the door" checks. */
  atDoor(side: "left" | "right"): AnimKind | null {
    for (const a of Object.values(this.agents)) {
      if (a.atDoor && this.sideOf(a.room) === side) return a.kind;
    }
    return null;
  }
}
