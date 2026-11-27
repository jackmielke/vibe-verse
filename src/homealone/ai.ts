/**
 * The intruders.
 *
 * Ten states and one graph. Everything they do comes out of these:
 *
 *   PROWL    nothing to do; pick something to steal, or wander
 *   LOOT     walking to a valuable he has picked
 *   GRAB     standing over it, filling his bag
 *   CARRY    it is on his back and he is leaving by the door he came in
 *   HUNT     he can see you, and he is coming
 *   SEARCH   he heard something, or lost you; heading for where it was
 *   DISARM   kneeling over one of your traps, taking it apart
 *   DOWN     something got him; face up on the floor for a few seconds
 *   FLEE     out of nerve, out of the house
 *   GONE     off the property, one way or the other
 *
 * The one rule that makes it fair: **they have to actually see you.** Vision is
 * a distance, a cone, and a segment test against the same wall boxes the player
 * collides with. Standing behind the sofa in the dark genuinely works, and if
 * it did not, the whole trap game would be pointless: you cannot lead someone
 * onto a trap if he already knows where you are.
 *
 * The one rule that makes it a plan: **they want something.** An intruder left
 * alone walks to a valuable, takes it and leaves by his own door. That route is
 * knowable before the night starts, which is what makes laying a trap a
 * decision rather than a decoration. Shouting, being seen, and a ringing alarm
 * clock all pull him off that route and onto one of yours.
 *
 * Being thrown is not a state. A trap hands back a direction and a distance,
 * the engine carries the body along it (walls, stairs and other traps are its
 * problem), and all this file has to know is `flung`: while it is set he is a
 * projectile, and nothing he was thinking matters.
 */
import * as THREE from "three";
import { makeCharacter, type Character } from "./characters";
import { NAV, nearestNode, pathBetween, type NavNode } from "./house";
import { line as banterLine, type Beat } from "./banter";
import type { Collider } from "./build";
import type { Entry, IntruderKind } from "./nights";

const HONEY_GEO = new THREE.SphereGeometry(1, 10, 8);
const HONEY_MAT = new THREE.MeshStandardMaterial({
  color: 0xf0a81c, roughness: 0.12, metalness: 0.35, emissive: 0x7a4a00, emissiveIntensity: 0.55,
});

export type BurglarState =
  | "prowl" | "loot" | "grab" | "carry" | "hunt" | "search" | "disarm" | "down" | "flee" | "gone";

export interface Fling {
  /** Unit direction. */
  tx: number;
  tz: number;
  /** Metres still to travel. */
  left: number;
  total: number;
  mode: "slide" | "fly";
  /** Height at the start, so a fall down the stairs can be told from a slide. */
  startY: number;
  /** The trap that threw him, which cannot be the next thing he hits. */
  from: number | null;
}

/** What the world tells an intruder, and what he tells it back. */
export interface WorldCtx {
  colliders: Collider[];
  /** Is the light on where this point is? Dark rooms halve how far they see. */
  litAt(x: number, y: number, z: number): boolean;
  /** Something worth taking that nobody else is already going for. */
  pickLoot(b: Burglar): { id: string; node: string } | null;
  /** A trap he would notice from where he stands, if he is the sort who looks. */
  spotTrap(b: Burglar): { id: number; x: number; y: number; z: number } | null;
  /** He has finished filling his bag. */
  onGrab(b: Burglar, lootId: string): void;
  /** He has finished taking a trap apart. */
  onDisarm(b: Burglar, trapId: number): void;
  /** He has left the property. */
  onGone(b: Burglar): void;
}

export interface UpdateOpts {
  aggression: number;
  /** Nobody can see the player at all (the first seconds of a night). */
  playerHidden: boolean;
}

/** Rooms a prowling intruder wanders through when there is nothing to steal. */
const PROWL_ROUTE = [
  "g_front", "g_living", "g_hall", "g_dining", "g_kitchen_e", "g_kitchen_w",
  "g_backhall", "g_family", "g_midhall", "g_stairfoot", "u_landing", "u_kid",
  "u_parents", "u_brother", "u_corr_e", "u_guest", "b_furnace", "g_den",
];

const EXIT: Record<Entry, string> = { front: "out_front", back: "out_back" };

export class Burglar {
  readonly kind: IntruderKind;
  readonly char: Character;
  readonly entry: Entry;
  readonly pos = new THREE.Vector3();
  yaw = 0;
  nerve: number;
  state: BurglarState = "prowl";
  /** Seconds left of a pratfall. */
  stun = 0;
  /** Seconds stuck to the floor. */
  rooted = 0;
  /** Seconds unable to see anything. */
  blind = 0;
  /** Seconds slowed to a hobble: honey on his boots, a mousetrap on his toe. */
  slowed = 0;
  /** Seconds he is visibly covered in honey. */
  honeyed = 0;
  private honeyFx: THREE.Group | null = null;
  /** A BB cannot stop him again until this time: no standing there stun-locking. */
  private flinchFree = 0;
  /** Set while a trap is carrying him across the room. */
  flung: Fling | null = null;
  /** Links in the chain he is currently part of, and when it goes cold. */
  chain = 0;
  chainUntil = 0;
  /** The valuable he is walking to, and the one on his back. */
  lootId: string | null = null;
  carrying: string | null = null;
  /** The trap he is kneeling over. */
  disarmId: number | null = null;
  /** Where he last had eyes on the player, or heard something. */
  lastSeen = new THREE.Vector3();
  /** Ramps 0→1 as he closes; the HUD turns it into a heartbeat. */
  proximity = 0;
  /** What he is saying right now. */
  says: string | null = null;

  private timer = 0;
  private exact = false;
  /** In SEARCH: he has walked as far as the graph takes him. */
  private reached = false;
  private path: NavNode[] = [];
  private pathI = 0;
  private routeI = 0;
  private repathIn = 0;
  private lookAbout = 0;
  private speed = 0;
  private saysUntil = 0;
  private nextLineAt = 0;
  /** Knocked sideways by a snowball, but still on his feet. */
  private flinch = 0;
  private disarmAt = new THREE.Vector3();

  constructor(kind: IntruderKind, entry: Entry, seat: number) {
    this.kind = kind;
    this.entry = entry;
    this.nerve = kind.nerve;
    this.char = makeCharacter(kind.rig, { coat: kind.coat, scale: kind.scale });
    this.routeI = (seat * 5) % PROWL_ROUTE.length;
  }

  get name() {
    return this.kind.name;
  }

  /** Still in the house and still a problem. */
  get active() {
    return this.state !== "gone";
  }

  /** On his feet and able to do something about you. */
  get upright() {
    return this.state !== "down" && this.state !== "gone" && !this.flung;
  }

  /** The way he is travelling, as a unit vector. */
  heading() {
    if (this.flung) return { hx: this.flung.tx, hz: this.flung.tz };
    return { hx: Math.sin(this.yaw), hz: Math.cos(this.yaw) };
  }

  /**
   * Say something, if he has not said something too recently.
   *
   * `force` is for the beats that must land: taking a trap in the face, or
   * giving up. Everything else is opportunistic, because an intruder who never
   * shuts up stops being funny about ninety seconds in.
   */
  speak(t: number, beat: Beat, force = false) {
    if (!force && t < this.nextLineAt) return;
    const l = banterLine(this.kind.rig, beat);
    if (!l) return;
    this.says = l;
    this.saysUntil = t + (force ? 3.4 : 2.6);
    this.nextLineAt = t + (force ? 2.4 : 6 + Math.random() * 6);
  }

  spawn(x: number, y: number, z: number, yaw = 0) {
    this.pos.set(x, y, z);
    this.yaw = yaw;
    this.nerve = this.kind.nerve;
    this.state = "prowl";
    this.stun = 0;
    this.rooted = 0;
    this.blind = 0;
    this.slowed = 0;
    this.honeyed = 0;
    this.flinchFree = 0;
    if (this.honeyFx) this.honeyFx.visible = false;
    this.flung = null;
    this.chain = 0;
    this.lootId = null;
    this.carrying = null;
    this.disarmId = null;
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

  /** Something landed. Down he goes, and it costs him. */
  hit(stun: number, damage: number) {
    this.nerve = Math.max(0, this.nerve - damage);
    this.lootId = null;
    this.disarmId = null;
    this.path = [];
    if (stun > 0) {
      this.stun = Math.max(this.stun, stun);
      this.state = "down";
    } else if (this.nerve <= 0 && this.state !== "down") {
      this.state = "flee";
    }
  }

  /** Thrown. The engine moves him; this only records that he is airborne. */
  fling(f: Fling) {
    this.flung = f;
    this.rooted = 0;
    this.path = [];
  }

  /**
   * A BB. It stings: it costs him a little nerve every time, and it stops him
   * for a beat, though not twice in quick succession, or standing in a doorway
   * holding the trigger would be the whole game. Somebody already stuck or
   * blind cannot roll with it and goes down.
   */
  pelt(t: number, damage: number): "stagger" | "floor" | null {
    if (this.state === "down" || this.state === "gone" || this.flung) return null;
    this.speak(t, "trap", true);
    this.disarmId = null;
    if (this.state === "disarm") {
      this.state = "search";
      this.reached = true;
      this.lookAbout = 0;
    }
    if (this.state !== "flee" && (this.rooted > 0 || this.blind > 0)) return "floor";
    if (t >= this.flinchFree) {
      this.flinch = 0.55;
      this.flinchFree = t + 1.7;
    }
    this.nerve = Math.max(0, this.nerve - damage);
    if (this.nerve <= 0 && this.state !== "flee") {
      this.state = "flee";
      this.path = [];
      this.lootId = null;
    }
    return "stagger";
  }

  /** Covered in honey: a golden mess on his head and shoulders until it wears off. */
  honey(seconds: number) {
    this.honeyed = Math.max(this.honeyed, seconds);
    if (!this.honeyFx) {
      const g = new THREE.Group();
      const h = this.char.height;
      const spots: Array<[number, number, number, number]> = [
        [0, h * 1.0, 0, 0.17], [0.13, h * 0.86, 0.06, 0.11], [-0.14, h * 0.84, 0.04, 0.12],
        [0.2, h * 0.74, 0, 0.1], [-0.2, h * 0.72, 0.02, 0.1], [0.05, h * 0.6, 0.14, 0.12],
        [-0.08, h * 0.45, 0.13, 0.09], [0.1, 0.05, 0.05, 0.13], [-0.1, 0.05, 0.02, 0.13],
      ];
      for (const [x, y, z, r] of spots) {
        const m = new THREE.Mesh(HONEY_GEO, HONEY_MAT);
        m.position.set(x, y, z);
        m.scale.set(r, r * 0.8, r);
        g.add(m);
      }
      this.char.root.add(g);
      this.honeyFx = g;
    }
    this.honeyFx.visible = true;
  }

  /**
   * Something loud, somewhere. Further than `radius` away and he never hears
   * it. He goes to the exact spot, not just the nearest doorway, which is what
   * makes a noise something you can aim.
   */
  hear(x: number, y: number, z: number, radius: number) {
    if (this.state === "down" || this.state === "flee" || this.state === "gone") return false;
    if (this.state === "carry" || this.state === "hunt" || this.flung) return false;
    const d = Math.hypot(this.pos.x - x, (this.pos.y - y) * 1.4, this.pos.z - z);
    if (d > radius) return false;
    this.lastSeen.set(x, y, z);
    this.exact = true;
    this.reached = false;
    this.state = "search";
    this.lootId = null;
    this.disarmId = null;
    this.path = [];
    this.lookAbout = 0;
    return true;
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

  update(dt: number, t: number, player: THREE.Vector3, ctx: WorldCtx, opts: UpdateOpts) {
    if (this.state === "gone") return;
    if (this.says && t > this.saysUntil) this.says = null;
    if (this.chain && t > this.chainUntil) this.chain = 0;
    this.blind = Math.max(0, this.blind - dt);
    this.slowed = Math.max(0, this.slowed - dt);
    if (this.honeyed > 0) {
      this.honeyed = Math.max(0, this.honeyed - dt);
      if (this.honeyed <= 0 && this.honeyFx) this.honeyFx.visible = false;
    }

    /* ---- in the air --------------------------------------------------- */
    if (this.flung) {
      this.char.down = Math.min(1, this.char.down + dt * 9);
      this.speed = 0;
      this.apply(dt, t);
      return;
    }

    // A BB does not floor him; it stops him for a beat while he swears about it.
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

    /* ---- on the floor -------------------------------------------------- */
    if (this.state === "down") {
      this.stun -= dt;
      this.char.down = Math.min(1, this.char.down + dt * 5);
      this.speed = 0;
      if (this.stun <= 0) {
        this.state = this.nerve <= 0 ? "flee" : "search";
        this.speak(t, this.nerve <= 0 ? "flee" : "hurt", true);
        this.lastSeen.copy(this.pos);
        this.exact = false;
        this.reached = true;
        this.lookAbout = 1.4;
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

    /* ---- leaving ------------------------------------------------------- */
    if (this.state === "flee" || this.state === "carry") {
      if (!this.path.length) this.routeTo(EXIT[this.entry]);
      // Nobody in this house runs. Leaving in a hurry is a brisk walk, and
      // walking out with a television is a slow one: that trip back down the
      // route he came in by is your second go at him.
      const pace =
        this.state === "flee"
          ? this.char.walkSpeed * this.kind.speed * 1.3
          : this.char.walkSpeed * this.kind.speed * 0.7;
      const out = this.rooted > 0 ? (this.stuck(dt), false) : this.follow(dt, pace * (this.blind > 0 ? 0.5 : 1));
      if (out) {
        this.state = "gone";
        this.char.root.visible = false;
        ctx.onGone(this);
        return;
      }
      this.proximity = 0;
      this.apply(dt, t);
      return;
    }

    /* ---- stuck --------------------------------------------------------- */
    if (this.rooted > 0) {
      this.stuck(dt);
      this.apply(dt, t);
      return;
    }

    /* ---- can he see you? ----------------------------------------------- */
    const dx = player.x - this.pos.x;
    const dz = player.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const dy = Math.abs(player.y - this.pos.y);
    let sees = false;
    // A dark room is worth half the distance. Turning a light off is a move.
    const range = ctx.litAt(player.x, player.y, player.z) ? 15 : 8;
    if (!opts.playerHidden && this.blind <= 0 && dy < 2.2 && dist < range) {
      const toward = Math.atan2(dx, dz);
      let diff = toward - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // A wide cone, but not a full circle: you can get behind them.
      const cone = this.state === "hunt" ? 2.4 : 1.5;
      if (Math.abs(diff) < cone || dist < 2.2) sees = clearLine(eye, target, ctx.colliders);
    }

    if (sees) {
      if (this.state !== "hunt") this.speak(t, "spot", true);
      else this.speak(t, "chase");
      this.state = "hunt";
      this.lootId = null;
      this.disarmId = null;
      this.lastSeen.copy(player);
      this.exact = false;
    } else if (this.state === "hunt") {
      this.state = "search";
      this.speak(t, "lost", true);
      this.path = [];
      this.repathIn = 0;
      this.lookAbout = 0;
      this.reached = false;
    } else if (this.state === "prowl" || this.state === "loot") {
      this.speak(t, "prowl");
    }

    this.proximity = Math.max(0, 1 - dist / 9) * (this.state === "hunt" ? 1 : 0.45);

    /* ---- does she see what is on the floor? ---------------------------- */
    if (
      this.kind.careful && this.blind <= 0 &&
      (this.state === "prowl" || this.state === "loot" || this.state === "search")
    ) {
      const trap = ctx.spotTrap(this);
      if (trap) {
        this.state = "disarm";
        this.disarmId = trap.id;
        this.disarmAt.set(trap.x, trap.y, trap.z);
        this.timer = 2.6;
        this.lootId = null;
        this.path = [];
        this.speak(t, "disarm", true);
      }
    }

    const walk = this.char.walkSpeed * this.kind.speed * (this.blind > 0 ? 0.55 : 1);
    // "Run" is a brisk walk. They used to sprint at better than four metres a
    // second, which is faster than a small boy and faster than anybody can
    // aim at; now coming for you is a stride, and you can back away from it
    // with the gun up.
    const run = walk * 1.12;

    /* ---- act ----------------------------------------------------------- */
    switch (this.state) {
      case "hunt": {
        this.repathIn -= dt;
        if (this.repathIn <= 0 || !this.path.length) {
          this.routeToPoint(player.x, player.y, player.z);
          this.repathIn = 0.45;
        }
        // Inside the same room, go straight at him rather than via a node.
        if (dist < 5 && dy < 1.2 && clearLine(eye, target, ctx.colliders)) {
          this.step(dt, player.x, player.y, player.z, run * (0.94 + opts.aggression * 0.12));
        } else {
          this.follow(dt, run * (0.92 + opts.aggression * 0.12));
        }
        break;
      }
      case "search": {
        if (!this.reached) {
          if (!this.path.length) this.routeToPoint(this.lastSeen.x, this.lastSeen.y, this.lastSeen.z);
          if (this.follow(dt, walk * 1.1)) this.reached = true;
        } else if (this.exact) {
          // The last few metres, straight to the noise itself.
          const far = Math.hypot(this.lastSeen.x - this.pos.x, this.lastSeen.z - this.pos.z);
          const near = Math.abs(this.lastSeen.y - this.pos.y) < 1.2;
          const aim = this.lastSeen.clone();
          aim.y += 0.9;
          if (!near || far < 0.5 || far > 9 || !clearLine(eye, aim, ctx.colliders)) this.exact = false;
          else if (this.step(dt, this.lastSeen.x, this.pos.y, this.lastSeen.z, walk * 1.1)) this.exact = false;
        } else {
          this.lookAbout += dt;
          // Sweep the room for a couple of seconds, then go back to work.
          this.yaw += Math.sin(t * 2.2) * dt * 2.4;
          this.speed = 0;
          if (this.lookAbout > 2.6) {
            this.state = "prowl";
            this.lookAbout = 0;
            this.reached = false;
            this.path = [];
          }
        }
        break;
      }
      case "prowl": {
        const loot = ctx.pickLoot(this);
        if (loot) {
          this.state = "loot";
          this.lootId = loot.id;
          this.routeTo(loot.node);
          break;
        }
        if (!this.path.length) {
          this.routeI = (this.routeI + 1) % PROWL_ROUTE.length;
          this.routeTo(PROWL_ROUTE[this.routeI]);
        }
        const arrived = this.follow(dt, walk * (0.85 + opts.aggression * 0.3));
        if (arrived) {
          this.yaw += Math.sin(t * 1.6 + this.routeI) * dt * 1.6;
          this.speed = 0;
          this.path = [];
        }
        break;
      }
      case "loot": {
        if (this.follow(dt, walk * 0.7)) {
          this.state = "grab";
          this.timer = 4;
          this.speak(t, "grab", true);
        }
        break;
      }
      case "grab": {
        this.speed = 0;
        this.yaw += Math.sin(t * 5) * dt * 0.8;
        this.timer -= dt;
        if (this.timer <= 0 && this.lootId) {
          const id = this.lootId;
          this.lootId = null;
          this.carrying = id;
          this.state = "carry";
          this.path = [];
          ctx.onGrab(this, id);
        } else if (!this.lootId) {
          this.state = "prowl";
        }
        break;
      }
      case "disarm": {
        const d = Math.hypot(this.disarmAt.x - this.pos.x, this.disarmAt.z - this.pos.z);
        if (d > 1.05) {
          this.step(dt, this.disarmAt.x, this.pos.y, this.disarmAt.z, walk);
        } else {
          this.speed = 0;
          this.timer -= dt;
          if (this.timer <= 0 && this.disarmId !== null) {
            const id = this.disarmId;
            this.disarmId = null;
            this.state = "prowl";
            ctx.onDisarm(this, id);
          }
        }
        break;
      }
    }

    this.apply(dt, t);
  }

  /** Feet glued down: he pulls at them and goes nowhere. */
  private stuck(dt: number) {
    this.rooted = Math.max(0, this.rooted - dt);
    this.speed = 0;
    this.yaw += Math.sin(this.rooted * 14) * dt * 1.4;
  }

  /** Walk one step toward a world point. Returns true once it is reached. */
  private step(dt: number, x: number, y: number, z: number, speed: number) {
    if (this.slowed > 0) speed *= 0.5;
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

/** Where somebody comes in. Outside the door, facing it. */
export function spawnPoint(which: Entry, seat = 0) {
  const off = ((seat % 3) - 1) * 0.55;
  if (which === "back") return { x: 3.2 + off, y: 0, z: -7.6, yaw: 0 };
  return { x: 0.4 + off, y: 0, z: 8.2, yaw: Math.PI };
}

/** The door a route starts at, as a nav node. */
export function entryNode(which: Entry) {
  return EXIT[which];
}

export const NAV_NODE_COUNT = NAV.length;
