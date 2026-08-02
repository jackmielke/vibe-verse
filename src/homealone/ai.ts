/**
 * Harry and Marv.
 *
 * Five states and one graph. Everything the pair do — casing the house,
 * splitting up, hearing you run, cornering you in the dining room, limping out
 * of the front door with no nerve left — comes out of those five.
 *
 *   PROWL   walking a route they chose, looking around
 *   HUNT    they can see you, and they are coming
 *   SEARCH  they saw you and lost you; heading for where you were
 *   DOWN    a trap got them; face up on the floor for a few seconds
 *   FLEE    out of nerve, out of the house
 *
 * The one rule that makes it fair: **they have to actually see you.** Vision is
 * a distance, a cone, and a segment test against the same wall boxes the player
 * collides with. Standing behind the sofa in the dark genuinely works, and if
 * it did not, the whole trap game would be pointless — you cannot lead someone
 * into a trap if he already knows where you are.
 *
 * The one rule that makes it frightening: **sound carries.** Sprinting on bare
 * boards is loud, doors are loud, and a trap going off is loud enough to bring
 * the other one running from two rooms away. Half of playing this well is
 * walking.
 */
import * as THREE from "three";
import { makeCharacter, type Character } from "./characters";
import { FLOOR, NAV, nearestNode, pathBetween, type NavNode } from "./house";
import { line as banterLine, type Beat } from "./banter";
import type { Collider } from "./build";

export type BurglarState = "prowl" | "hunt" | "search" | "down" | "flee" | "gone";

export interface SightContext {
  colliders: Collider[];
}

/** Rooms a prowling burglar will pick between, roughly in the order they would. */
const PROWL_ROUTE = [
  "g_front", "g_living", "g_hall", "g_dining", "g_kitchen_e", "g_kitchen_w",
  "g_backhall", "g_family", "g_midhall", "g_stairbay", "u_landing", "u_kevin",
  "u_parents", "u_buzz", "u_corr_e", "u_guest", "b_furnace", "g_den",
];

export class Burglar {
  readonly who: "harry" | "marv";
  readonly char: Character;
  readonly pos = new THREE.Vector3();
  yaw = 0;
  /** 100 down to 0. Two good traps take one of them out of the fight. */
  nerve = 100;
  state: BurglarState = "prowl";
  /** Seconds left of a pratfall. */
  stun = 0;
  /** Where he last had eyes on the player. */
  lastSeen = new THREE.Vector3();
  /** Set when a trap fires or something loud happens — he investigates. */
  private alert = 0;
  private path: NavNode[] = [];
  private pathI = 0;
  private routeI = 0;
  private repathIn = 0;
  private lookAbout = 0;
  private speed = 0;
  /** Ramps 0→1 as he closes; the HUD turns it into a heartbeat. */
  proximity = 0;
  /** What he is saying right now, and until when. */
  says: string | null = null;
  private saysUntil = 0;
  private nextLineAt = 0;
  /** Knocked sideways by a BB, but still on his feet. */
  private flinch = 0;

  /**
   * Say something, if he has not said something too recently.
   *
   * `force` is for the beats that must land — taking a trap in the face, or
   * giving up. Everything else is opportunistic, because a burglar who never
   * shuts up stops being funny about ninety seconds in.
   */
  speak(t: number, beat: Beat, force = false) {
    if (!force && t < this.nextLineAt) return;
    const l = banterLine(this.who, beat);
    if (!l) return;
    this.says = l;
    this.saysUntil = t + (force ? 3.4 : 2.6);
    this.nextLineAt = t + (force ? 2.4 : 6 + Math.random() * 6);
  }

  constructor(who: "harry" | "marv") {
    this.who = who;
    this.char = makeCharacter(who);
    this.routeI = who === "harry" ? 0 : 9;
  }

  spawn(x: number, y: number, z: number, yaw = 0) {
    this.pos.set(x, y, z);
    this.yaw = yaw;
    this.nerve = 100;
    this.state = "prowl";
    this.stun = 0;
    this.alert = 0;
    this.says = null;
    this.saysUntil = 0;
    this.nextLineAt = 0;
    this.flinch = 0;
    this.path = [];
    this.pathI = 0;
    this.char.down = 0;
    this.char.root.position.copy(this.pos);
    this.char.root.rotation.y = yaw;
    this.char.root.visible = true;
  }

  /** A trap landed. Down he goes, and it costs him. */
  hit(stun: number, damage: number) {
    this.stun = stun;
    this.state = "down";
    this.nerve = Math.max(0, this.nerve - damage);
    this.path = [];
  }

  /**
   * A BB in the shoulder. Not a knockdown — a stumble.
   *
   * This is the whole design of the gun: it never takes anybody out of the
   * fight, it buys you about a second and a half of a head start. If it
   * knocked them down it would replace the traps, and the traps are the game.
   */
  sting(t: number) {
    if (this.state === "down" || this.state === "gone" || this.state === "flee") return false;
    this.flinch = 1.5;
    this.nerve = Math.max(0, this.nerve - 5);
    this.speak(t, "trap", true);
    return true;
  }

  /** Something loud, somewhere. Louder than `radius` away and he never hears it. */
  hear(x: number, y: number, z: number, radius: number) {
    if (this.state === "down" || this.state === "flee" || this.state === "gone") return;
    const d = Math.hypot(this.pos.x - x, (this.pos.y - y) * 1.4, this.pos.z - z);
    if (d > radius) return;
    this.lastSeen.set(x, y, z);
    this.alert = 1;
    if (this.state === "prowl") {
      this.state = "search";
      this.path = [];
    }
  }

  private routeTo(id: string) {
    const from = nearestNode(this.pos.x, this.pos.y, this.pos.z);
    this.path = pathBetween(from.id, id);
    this.pathI = this.path.length > 1 ? 1 : 0;
  }

  private routeToPoint(x: number, y: number, z: number) {
    const to = nearestNode(x, y, z);
    this.routeTo(to.id);
  }

  update(
    dt: number,
    t: number,
    player: THREE.Vector3,
    ctx: SightContext,
    opts: { aggression: number; playerHidden: boolean },
  ) {
    if (this.state === "gone") return;
    if (this.says && t > this.saysUntil) this.says = null;

    // A sting does not floor him; it stops him for a beat and turns him round.
    if (this.flinch > 0) {
      this.flinch -= dt;
      this.speed = 0;
      this.yaw += Math.sin(t * 22) * dt * 2.2;
      this.apply(dt, t);
      return;
    }

    const eye = this.pos.clone();
    eye.y += this.char.eyeY;
    const target = player.clone();
    target.y += 1.0;

    /* ---- stun ------------------------------------------------------- */
    if (this.state === "down") {
      this.stun -= dt;
      this.char.down = Math.min(1, this.char.down + dt * 5);
      this.speed = 0;
      if (this.stun <= 0) {
        this.state = this.nerve <= 0 ? "flee" : "search";
        this.speak(t, this.nerve <= 0 ? "flee" : "hurt", true);
        this.lastSeen.copy(player);
        this.path = [];
      }
      this.apply(dt, t);
      return;
    }
    this.char.down = Math.max(0, this.char.down - dt * 3.5);
    if (this.char.down > 0.15) {
      // Still getting up. He is not chasing anybody on his back.
      this.speed = 0;
      this.apply(dt, t);
      return;
    }

    /* ---- flee -------------------------------------------------------- */
    if (this.state === "flee") {
      if (!this.path.length) this.routeTo("out_front");
      this.follow(dt, this.char.runSpeed * 0.95);
      if (this.pos.z > 8.0) {
        this.state = "gone";
        this.char.root.visible = false;
      }
      this.apply(dt, t);
      return;
    }

    /* ---- can he see you? --------------------------------------------- */
    const dx = player.x - this.pos.x;
    const dz = player.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const dy = Math.abs(player.y - this.pos.y);
    let sees = false;
    if (!opts.playerHidden && dy < 2.2 && dist < 15) {
      const toward = Math.atan2(dx, dz);
      let diff = toward - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // A wide cone, but not a full circle — you can get behind them.
      const cone = this.state === "hunt" ? 2.4 : 1.5;
      if (Math.abs(diff) < cone || dist < 2.2) sees = clearLine(eye, target, ctx.colliders);
    }

    if (sees) {
      if (this.state !== "hunt") this.speak(t, "spot", true);
      else this.speak(t, "chase");
      this.state = "hunt";
      this.lastSeen.copy(player);
      this.alert = 1;
    } else if (this.state === "hunt") {
      this.state = "search";
      this.speak(t, "lost", true);
      this.path = [];
      this.repathIn = 0;
    } else if (this.state === "prowl") {
      this.speak(t, "prowl");
    }

    this.alert = Math.max(0, this.alert - dt * 0.12);
    this.proximity = Math.max(0, 1 - dist / 9) * (this.state === "hunt" ? 1 : 0.45);

    /* ---- act --------------------------------------------------------- */
    switch (this.state) {
      case "hunt": {
        this.repathIn -= dt;
        if (this.repathIn <= 0 || !this.path.length) {
          this.routeToPoint(player.x, player.y, player.z);
          this.repathIn = 0.45;
        }
        // Inside the same room, go straight at him rather than via a node.
        if (dist < 5 && dy < 1.2 && clearLine(eye, target, ctx.colliders)) {
          this.step(dt, player.x, player.y, player.z, this.char.runSpeed * (0.82 + opts.aggression * 0.24));
        } else {
          this.follow(dt, this.char.runSpeed * (0.78 + opts.aggression * 0.22));
        }
        break;
      }
      case "search": {
        if (!this.path.length) {
          this.routeToPoint(this.lastSeen.x, this.lastSeen.y, this.lastSeen.z);
          this.lookAbout = 0;
        }
        const arrived = this.follow(dt, this.char.walkSpeed * 1.25);
        if (arrived) {
          this.lookAbout += dt;
          // Sweep the room for a couple of seconds, then give up and prowl.
          this.yaw += Math.sin(t * 2.2) * dt * 2.4;
          this.speed = 0;
          if (this.lookAbout > 2.6) {
            this.state = "prowl";
            this.path = [];
          }
        }
        break;
      }
      case "prowl": {
        if (!this.path.length) {
          this.routeI = (this.routeI + 1) % PROWL_ROUTE.length;
          this.routeTo(PROWL_ROUTE[this.routeI]);
        }
        const arrived = this.follow(dt, this.char.walkSpeed * (0.85 + opts.aggression * 0.3));
        if (arrived) {
          this.yaw += Math.sin(t * 1.6 + this.routeI) * dt * 1.6;
          this.speed = 0;
          this.path = [];
        }
        break;
      }
    }

    this.apply(dt, t);
  }

  /** Walk one step toward a world point. Returns true once it is reached. */
  private step(dt: number, x: number, y: number, z: number, speed: number) {
    const dx = x - this.pos.x;
    const dz = z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.16) {
      this.pos.y += (y - this.pos.y) * Math.min(1, dt * 8);
      this.speed = 0;
      return true;
    }
    const want = Math.atan2(dx, dz);
    let diff = want - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * Math.min(1, dt * 7);
    // He only makes full speed once he is pointing where he is going, which is
    // what stops a corner turning into a slide.
    const facing = Math.max(0.25, 1 - Math.abs(diff) / 2.4);
    const v = speed * facing;
    const move = Math.min(d, v * dt);
    this.pos.x += (dx / d) * move;
    this.pos.z += (dz / d) * move;
    this.pos.y += (y - this.pos.y) * Math.min(1, dt * 6);
    this.speed = v;
    return false;
  }

  /** Advance along the current path. Returns true at the end of it. */
  private follow(dt: number, speed: number) {
    if (!this.path.length) return true;
    const n = this.path[Math.min(this.pathI, this.path.length - 1)];
    if (this.step(dt, n.x, n.y, n.z, speed)) {
      if (this.pathI >= this.path.length - 1) {
        this.path = [];
        return true;
      }
      this.pathI++;
    }
    return false;
  }

  private apply(dt: number, t: number) {
    this.char.root.position.copy(this.pos);
    this.char.root.rotation.y = this.yaw;
    this.char.update(dt, t, this.speed);
  }

  dispose() {
    this.char.dispose();
  }
}

/**
 * Is there a clear line between two points?
 *
 * A slab test against every wall box. There are a few hundred of them and this
 * runs twice a frame, which is nothing — and it is the difference between a
 * game where hiding works and a game where it does not.
 */
export function clearLine(a: THREE.Vector3, b: THREE.Vector3, colliders: Collider[]): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  for (const c of colliders) {
    // Skip anything shorter than knee height; you cannot hide behind a footstool.
    if (c.y1 - c.y0 < 0.75) continue;
    let t0 = 0;
    let t1 = 1;
    let blocked = true;
    for (const [o, d, lo, hi] of [
      [a.x, dx, c.x0, c.x1],
      [a.y, dy, c.y0, c.y1],
      [a.z, dz, c.z0, c.z1],
    ] as const) {
      if (Math.abs(d) < 1e-6) {
        if (o < lo || o > hi) {
          blocked = false;
          break;
        }
        continue;
      }
      let n = (lo - o) / d;
      let f = (hi - o) / d;
      if (n > f) [n, f] = [f, n];
      t0 = Math.max(t0, n);
      t1 = Math.min(t1, f);
      if (t0 > t1) {
        blocked = false;
        break;
      }
    }
    if (blocked) return false;
  }
  return true;
}

/** Somewhere sensible to put a burglar at the start of a level. */
export function spawnPoint(which: "front" | "back" | "street", who: "harry" | "marv") {
  const off = who === "harry" ? -0.5 : 0.5;
  if (which === "street") return { x: -14 + off * 2, y: 0, z: 11.0, yaw: Math.PI };
  if (which === "back") return { x: 3.2 + off, y: FLOOR.ground, z: -7.4, yaw: 0 };
  return { x: 0.4 + off, y: FLOOR.ground, z: 7.4, yaw: Math.PI };
}

export const NAV_NODE_COUNT = NAV.length;
