/**
 * ai/enemies.ts — the opposition.
 *
 * A utility-scored behaviour set rather than a state machine, because a state
 * machine that has to answer "I am flanking, but I just took a grenade and my
 * magazine is empty and my squadmate died" needs a transition from every state
 * to every other state, and that is thirteen squared arrows nobody can reason
 * about. Utility AI asks one question every quarter second — *what is the most
 * valuable thing I could be doing right now* — and the answer falls out of a
 * dozen scoring functions that each fit on a screen.
 *
 * The behaviours, and what makes each of them feel right:
 *
 *   PATROL       a slow route along the street graph, head turning. Boring on
 *                purpose: it is the baseline the alert reads against.
 *   SUSPICIOUS   a noise or a half-second glimpse. Weapon up, moving to look,
 *                *not* shooting. The gap between "heard something" and "sees
 *                you" is where stealth lives.
 *   SEARCH       last known position, then a spiral outward from it. Soldiers
 *                who teleport their knowledge of your position are the single
 *                most complained-about thing in shooters.
 *   ENGAGE       fire in bursts with an accuracy that *ramps*. First contact
 *                is deliberately sloppy — 6° of cone — tightening to 1° over
 *                three seconds of held sight. Being laser-beamed the instant
 *                you round a corner is not difficulty, it is a bug.
 *   FLANK        one squad member at a time, granted a token by the squad, goes
 *                wide. Two flanking at once looks like a bug; one looks like a
 *                plan.
 *   SUPPRESS     high rate, low accuracy, aimed at your cover, to hold you
 *                there while the flanker moves. This is the whole reason squads
 *                exist.
 *   COVER        a real geometric query against the building index and parked
 *                traffic: a point that actually breaks the line between the
 *                soldier and the threat, verified by a raycast.
 *   RELOAD       out of the line of fire if possible.
 *   RETREAT      wounded, alone, or the last of a squad. They fall back and
 *                call it in rather than feeding themselves to you one at a time.
 *
 * Perception is honest: a vision cone with real line of sight through the
 * building BVH (batched and cached), plus hearing from the shared perception
 * bus with no occlusion. You can be heard through a wall. You cannot be seen
 * through one.
 *
 * Public API
 * ----------
 *   enemyForce.update / render / spawn / despawn
 *   enemyForce.applyDamage / onGrappled / onVehicleDestroyed
 *   enemyForce.alertArea / forEachHitbox
 */
import { frame, useSfStore } from "../state/store";
import { makeRng, type Rng } from "../math/rng";
import { losPool, makeRayHit, raycast } from "../physics/raycast";
import { isPhysicsReady } from "../physics/world";
import { buildingIndex } from "../world/buildings/spatialIndex";
import type { BuildingRecord } from "../world/buildings/generator";
import { roadNetwork } from "../world/street/roadNetwork";
import type { CharacterBatch } from "./characters";
import { archetypeBody, archetypeMask, makePalette, PALETTE_FLOATS } from "./characters";
import {
  advancePath,
  avoidance,
  findPath,
  groundHeight,
  makeNavPath,
  navGraph,
  pathFinished,
  probeAhead,
  slideAlong,
  type NavPath,
} from "./navigation";
import { emitGunshot, emitNoise, forEachEventNear } from "./perception";
import { trafficSim } from "./traffic";
import {
  ANIM_AIM,
  ANIM_DEAD,
  ANIM_IDLE,
  ANIM_RUN,
  ANIM_WALK,
  LOD_FROZEN,
  LOD_FULL,
  LOD_SIMPLE,
  PLAYER_ENTITY_ID,
  angleDelta,
  approachAngle,
  losKey,
  nextEntityId,
  type AiLod,
  type CharacterArchetype,
  type Faction,
} from "./types";

/* ================================================================== *
 * Loadouts
 * ================================================================== */

export interface EnemyLoadout {
  name: string;
  /** Effective engagement range, metres. */
  range: number;
  /** Rounds per minute while a burst is running. */
  rpm: number;
  burst: number;
  /** Seconds between bursts at full aggression. */
  burstPause: number;
  magazine: number;
  reloadTime: number;
  /** Damage per round at the muzzle. */
  damage: number;
  /** Cone half-angle at first contact and when fully zeroed, radians. */
  spreadCold: number;
  spreadHot: number;
  /** Seconds of held sight to go from cold to hot. */
  rampTime: number;
  /** Carries fragmentation grenades. */
  grenades: number;
  /** Audible radius scale of the report. */
  loud: number;
}

const LOADOUTS: Record<string, EnemyLoadout> = {
  sidearm: {
    name: "sidearm",
    range: 42,
    rpm: 300,
    burst: 2,
    burstPause: 0.85,
    magazine: 15,
    reloadTime: 1.9,
    damage: 11,
    spreadCold: 0.105,
    spreadHot: 0.026,
    rampTime: 2.6,
    grenades: 0,
    loud: 0.85,
  },
  smg: {
    name: "smg",
    range: 58,
    rpm: 780,
    burst: 6,
    burstPause: 0.62,
    magazine: 30,
    reloadTime: 2.2,
    damage: 8,
    spreadCold: 0.12,
    spreadHot: 0.03,
    rampTime: 3.0,
    grenades: 1,
    loud: 0.9,
  },
  rifle: {
    name: "rifle",
    range: 110,
    rpm: 620,
    burst: 4,
    burstPause: 0.75,
    magazine: 30,
    reloadTime: 2.5,
    damage: 13,
    spreadCold: 0.1,
    spreadHot: 0.018,
    rampTime: 3.4,
    grenades: 2,
    loud: 1,
  },
  lmg: {
    name: "lmg",
    range: 120,
    rpm: 700,
    burst: 14,
    burstPause: 1.5,
    magazine: 100,
    reloadTime: 5.2,
    damage: 12,
    spreadCold: 0.14,
    spreadHot: 0.045,
    rampTime: 5,
    grenades: 0,
    loud: 1.2,
  },
};

export type EnemyState =
  | "patrol"
  | "suspicious"
  | "search"
  | "engage"
  | "flank"
  | "suppress"
  | "cover"
  | "reload"
  | "retreat"
  | "stagger"
  | "dead";

export type SquadRole = "anchor" | "flanker" | "suppressor";

export interface Enemy {
  id: number;
  faction: Faction;
  archetype: CharacterArchetype;
  loadout: EnemyLoadout;

  /* transform */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Where the weapon is pointing — lags the body, which is what aiming looks like. */
  aimYaw: number;
  aimPitch: number;
  vx: number;
  vz: number;
  speed: number;
  phase: number;

  /* condition */
  health: number;
  maxHealth: number;
  armour: number;
  suppression: number;
  soak: number;

  /* cognition */
  state: EnemyState;
  stateTime: number;
  suspicion: number;
  /** Sim time the target was last actually seen. */
  lastSeen: number;
  hasContact: boolean;
  lkX: number;
  lkZ: number;
  lkValid: boolean;
  /** How well zeroed on the current target, 0..1. */
  zero: number;
  thinkAt: number;
  calledIn: boolean;

  /* combat */
  ammo: number;
  fireTimer: number;
  burstLeft: number;
  reloadTimer: number;
  grenades: number;
  grenadeTimer: number;

  /* movement */
  path: NavPath;
  pathTimer: number;
  destX: number;
  destZ: number;
  hasDest: boolean;
  coverX: number;
  coverZ: number;
  coverValid: boolean;
  coverTimer: number;

  /* squad */
  squad: Squad | null;
  role: SquadRole;

  /* presentation */
  seed: number;
  mask: number;
  heightScale: number;
  girth: number;
  palette: Float32Array;
  clip: number;
  blend: number;

  lod: AiLod;
  /** This frame's slot in the avoidance field, or −1. */
  avoidHandle: number;
  staggerTimer: number;
  deathTimer: number;
  alive: boolean;
}

/**
 * A squad is four to six soldiers who share what they know and take turns
 * doing the dangerous thing. Without it, six soldiers is one soldier six times;
 * with it, six soldiers is an encounter.
 */
export class Squad {
  members: Enemy[] = [];
  /** Shared last-known-position, refreshed by whoever has eyes on. */
  lkX = 0;
  lkZ = 0;
  lkTime = -1e9;
  /** Who currently holds the right to flank, or 0. */
  flankToken = 0;
  flankUntil = 0;
  /** Sim time reinforcements were last requested. */
  calledAt = -1e9;

  share(x: number, z: number, now: number): void {
    this.lkX = x;
    this.lkZ = z;
    this.lkTime = now;
  }

  /** Try to claim the right to be the one who flanks. */
  claimFlank(e: Enemy, now: number): boolean {
    if (this.flankToken === e.id) {
      this.flankUntil = now + 9;
      return true;
    }
    if (this.flankToken !== 0 && now < this.flankUntil) return false;
    this.flankToken = e.id;
    this.flankUntil = now + 9;
    return true;
  }

  releaseFlank(e: Enemy): void {
    if (this.flankToken === e.id) {
      this.flankToken = 0;
      this.flankUntil = 0;
    }
  }

  aliveCount(): number {
    let n = 0;
    for (const m of this.members) if (m.alive && m.state !== "dead") n++;
    return n;
  }
}

/* ================================================================== *
 * The force
 * ================================================================== */

const EYE_HEIGHT = 1.62;
const _hit = makeRayHit();
const _steer = new Float32Array(2);
const _normal = new Float32Array(3);
const _covers: BuildingRecord[] = [];

class EnemyForce {
  readonly enemies: Enemy[] = [];
  private byId = new Map<number, Enemy>();
  readonly squads: Squad[] = [];
  private rng: Rng = makeRng("sf-enemies");

  maxEnemies = 42;

  /** Fired when an enemy dies: chaos, notifications, ragdolls, loot. */
  onKilled: ((e: Enemy) => void) | null = null;
  /** Fired when a squad calls for help — the police system answers it. */
  onReinforcementsRequested: ((x: number, z: number, faction: Faction) => void) | null = null;
  /** Fired when an enemy shoots, so the weapons/VFX layer can draw a tracer. */
  onShot:
    | ((
        e: Enemy,
        ox: number,
        oy: number,
        oz: number,
        dx: number,
        dy: number,
        dz: number,
        hitPlayer: boolean,
      ) => void)
    | null = null;

  stats = { count: 0, engaged: 0, searching: 0, squads: 0 };

  reset(seed = "sf-enemies"): void {
    this.enemies.length = 0;
    this.byId.clear();
    this.squads.length = 0;
    this.rng = makeRng(seed);
  }

  get(id: number): Enemy | undefined {
    return this.byId.get(id);
  }

  /* ---------------- spawning ---------------- */

  /**
   * Spawn a squad of `size` at a point. Returns the squad, or null if the cap
   * is reached. Members are spread over a few metres so they do not spawn
   * inside one another and immediately start shoving.
   */
  spawnSquad(
    x: number,
    z: number,
    size: number,
    faction: Faction,
    archetype: CharacterArchetype,
    loadoutKey: keyof typeof LOADOUTS,
    now: number,
  ): Squad | null {
    if (this.enemies.length >= this.maxEnemies) return null;
    const squad = new Squad();
    const rng = this.rng;
    for (let i = 0; i < size; i++) {
      if (this.enemies.length >= this.maxEnemies) break;
      const a = (i / size) * Math.PI * 2 + rng.next();
      const r = 1.2 + rng.next() * 3.4;
      const ex = x + Math.cos(a) * r;
      const ez = z + Math.sin(a) * r;
      const e = this.spawn(ex, ez, faction, archetype, loadoutKey, now);
      if (!e) break;
      e.squad = squad;
      // Roles are assigned once and then held: a soldier who re-rolls his job
      // every think tick looks indecisive rather than tactical.
      e.role = i === 0 ? "anchor" : i === 1 ? "flanker" : i === 2 ? "suppressor" : rng.chance(0.5) ? "anchor" : "flanker";
      squad.members.push(e);
    }
    if (squad.members.length === 0) return null;
    this.squads.push(squad);
    return squad;
  }

  spawn(
    x: number,
    z: number,
    faction: Faction,
    archetype: CharacterArchetype,
    loadoutKey: keyof typeof LOADOUTS,
    now: number,
  ): Enemy | null {
    if (this.enemies.length >= this.maxEnemies) return null;
    const rng = this.rng;
    const loadout = LOADOUTS[loadoutKey] ?? LOADOUTS.rifle;
    const [h, g] = archetypeBody(archetype, rng);
    const maxHealth =
      archetype === "swat" ? 165 : archetype === "soldier" ? 145 : archetype === "officer" ? 130 : 110;
    const e: Enemy = {
      id: nextEntityId(),
      faction,
      archetype,
      loadout,
      x,
      y: groundHeight(x, z, 300, 400),
      z,
      yaw: rng.next() * Math.PI * 2,
      aimYaw: 0,
      aimPitch: 0,
      vx: 0,
      vz: 0,
      speed: 0,
      phase: rng.next(),
      health: maxHealth,
      maxHealth,
      armour: archetype === "swat" ? 0.42 : archetype === "soldier" ? 0.3 : 0.14,
      suppression: 0,
      soak: 0,
      state: "patrol",
      stateTime: 0,
      suspicion: 0,
      lastSeen: -1e9,
      hasContact: false,
      lkX: 0,
      lkZ: 0,
      lkValid: false,
      zero: 0,
      thinkAt: now + rng.next() * 0.3,
      calledIn: false,
      ammo: loadout.magazine,
      fireTimer: 0,
      burstLeft: 0,
      reloadTimer: 0,
      grenades: loadout.grenades,
      grenadeTimer: 6 + rng.next() * 6,
      path: makeNavPath(48),
      pathTimer: 0,
      destX: x,
      destZ: z,
      hasDest: false,
      coverX: 0,
      coverZ: 0,
      coverValid: false,
      coverTimer: 0,
      squad: null,
      role: "anchor",
      seed: rng.next(),
      mask: archetypeMask(archetype, rng),
      heightScale: h,
      girth: g,
      palette: makePalette(rng, archetype),
      clip: ANIM_IDLE,
      blend: 0,
      lod: LOD_FULL,
      avoidHandle: -1,
      staggerTimer: 0,
      deathTimer: 0,
      alive: true,
    };
    e.aimYaw = e.yaw;
    this.enemies.push(e);
    this.byId.set(e.id, e);
    return e;
  }

  despawn(id: number): void {
    const i = this.enemies.findIndex((e) => e.id === id);
    if (i < 0) return;
    const e = this.enemies[i];
    e.squad?.releaseFlank(e);
    losPool.forget(losKey(e.id, PLAYER_ENTITY_ID));
    this.byId.delete(id);
    this.enemies[i] = this.enemies[this.enemies.length - 1];
    this.enemies.pop();
  }

  /** Remove anything far away that is not currently fighting. */
  cullFar(cx: number, cz: number, radius: number): number {
    const r2 = radius * radius;
    let n = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const dx = e.x - cx;
      const dz = e.z - cz;
      if (dx * dx + dz * dz < r2) continue;
      if (e.state === "engage" || e.state === "suppress" || e.state === "flank") continue;
      this.despawn(e.id);
      n++;
    }
    // Retire empty squads so the flank token bookkeeping does not accumulate.
    for (let i = this.squads.length - 1; i >= 0; i--) {
      this.squads[i].members = this.squads[i].members.filter((m) => m.alive);
      if (this.squads[i].members.length === 0) {
        this.squads[i] = this.squads[this.squads.length - 1];
        this.squads.pop();
      }
    }
    return n;
  }

  /* ---------------- the tick ---------------- */

  update(dt: number, now: number, cx: number, cy: number, cz: number): void {
    let engaged = 0;
    let searching = 0;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const dx = e.x - cx;
      const dz = e.z - cz;
      const d2 = dx * dx + dz * dz;
      e.lod = d2 < 120 * 120 ? LOD_FULL : d2 < 320 * 320 ? LOD_SIMPLE : LOD_FROZEN;

      if (e.state === "dead") {
        e.deathTimer += dt;
        e.blend = Math.min(1, e.blend + dt * 3);
        if (e.deathTimer > 40) this.despawn(e.id);
        continue;
      }

      e.stateTime += dt;
      e.suppression = Math.max(0, e.suppression - dt * 0.55);
      e.soak = Math.max(0, e.soak - dt * 0.03);
      // Priority 1: civilians step aside for armed men, not the other way round.
      e.avoidHandle = avoidance.add(e.x, e.z, e.vx, e.vz, 0.42, 1);

      if (e.lod === LOD_FROZEN) {
        // Still hears things — a frozen soldier who never notices the firefight
        // he is standing in is worse than one who costs a little.
        if (now > e.thinkAt) {
          e.thinkAt = now + 1.2;
          this.hear(e, now);
        }
        continue;
      }

      this.perceive(e, now, cx, cy, cz);

      if (now >= e.thinkAt) {
        // Think interval is staggered by id so forty soldiers never all
        // re-plan on the same frame.
        e.thinkAt = now + (e.lod === LOD_FULL ? 0.22 : 0.6) + (e.id % 7) * 0.011;
        this.think(e, now, cx, cy, cz);
      }

      this.act(e, dt, now, cx, cy, cz);

      if (e.state === "engage" || e.state === "suppress" || e.state === "flank") engaged++;
      if (e.state === "search" || e.state === "suspicious") searching++;

      const stride = 0.82 * e.heightScale;
      e.phase = (e.phase + (e.speed * dt) / stride) % 1;
    }

    this.stats.count = this.enemies.length;
    this.stats.engaged = engaged;
    this.stats.searching = searching;
    this.stats.squads = this.squads.length;
  }

  /* ---------------- perception ---------------- */

  private perceive(e: Enemy, now: number, px: number, py: number, pz: number): void {
    this.hear(e, now);

    const dx = px - e.x;
    const dz = pz - e.z;
    const dist = Math.hypot(dx, dz);
    // Sight range collapses at night and in the marine layer. This is the same
    // fog the renderer draws, so what the player can see is what can see them.
    const dark = 1 - Math.max(0, Math.sin(((frame.timeOfDay - 6) / 12) * Math.PI));
    const visRange = e.loadout.range * (1.15 - dark * 0.45) * (1 - frame.fogDensity * 0.3);
    if (dist > visRange) {
      e.hasContact = false;
      return;
    }

    // Cone: narrow when calm, wide when already fighting. Peripheral vision
    // exists, and pretending it does not is what makes stealth trivial.
    const bearing = Math.atan2(dz, dx);
    const off = Math.abs(angleDelta(e.aimYaw, bearing));
    const halfFov = e.state === "engage" || e.state === "suppress" ? 1.35 : 0.95;
    // A sprinting, firing target is noticed outside the cone; a crouched still
    // one is not noticed inside it at range.
    const noise = Math.min(1, frame.speed / 8) * 0.5 + (frame.movement === "grappling" ? 0.4 : 0);
    if (off > halfFov + noise) {
      e.hasContact = false;
      return;
    }

    const clear = losPool.query(
      losKey(e.id, PLAYER_ENTITY_ID),
      e.x,
      e.y + EYE_HEIGHT,
      e.z,
      px,
      py,
      pz,
      e.state === "engage" ? 0.12 : 0.3,
    );
    if (!clear) {
      e.hasContact = false;
      return;
    }

    // Recognition takes time at range: closing suspicion, not instant contact.
    const rate = (1 - off / (halfFov + 0.3)) * (1 - dist / visRange) * 3.6 + 0.5;
    e.suspicion = Math.min(1, e.suspicion + rate * 0.22);
    if (e.suspicion >= 0.85 || dist < 14) {
      e.hasContact = true;
      e.lastSeen = now;
      e.lkX = px;
      e.lkZ = pz;
      e.lkValid = true;
      e.squad?.share(px, pz, now);
    }
  }

  /** Hearing: no occlusion, by design. Gunfire carries through walls. */
  private hear(e: Enemy, now: number): void {
    forEachEventNear(e.x, e.z, now - 1.0, (ev, d) => {
      if (ev.sourceId === e.id) return;
      if (ev.source === e.faction && ev.kind !== "explosion") return;
      const strength = ev.threat * (1 - d / Math.max(1, ev.radius));
      if (strength < 0.05) return;
      e.suspicion = Math.min(1, e.suspicion + strength * 0.8);
      if (strength > 0.22) {
        e.lkX = ev.x;
        e.lkZ = ev.z;
        e.lkValid = true;
        if (ev.threat > 0.6) e.squad?.share(ev.x, ev.z, now);
      }
      // Being shot at from an unseen direction is suppressing.
      if (ev.kind === "gunshot" && d < 26) e.suppression = Math.min(1, e.suppression + 0.18);
    });
  }

  /* ---------------- utility scoring ---------------- */

  private think(e: Enemy, now: number, px: number, py: number, pz: number): void {
    if (e.staggerTimer > 0) {
      this.setState(e, "stagger");
      return;
    }

    const healthFrac = e.health / e.maxHealth;
    const dist = Math.hypot(px - e.x, pz - e.z);
    const sinceSeen = now - e.lastSeen;
    const squadStrength = e.squad ? e.squad.aliveCount() : 1;
    const inRange = dist < e.loadout.range;

    let bestState: EnemyState = "patrol";
    let best = 0.05;
    const consider = (s: EnemyState, score: number) => {
      if (score > best) {
        best = score;
        bestState = s;
      }
    };

    // Reload dominates everything: an empty weapon has no other options.
    if (e.ammo <= 0) {
      this.setState(e, "reload");
      return;
    }

    // Investigate a noise or a glimpse.
    consider("suspicious", e.suspicion > 0.25 && !e.hasContact ? e.suspicion * 0.55 : 0);

    // Search the last known position once contact is lost.
    consider(
      "search",
      e.lkValid && !e.hasContact && sinceSeen < 28 ? 0.6 + Math.min(0.2, sinceSeen * 0.01) : 0,
    );

    // Straight fight.
    consider("engage", e.hasContact && inRange ? 0.9 + (1 - dist / e.loadout.range) * 0.25 : 0);

    // Take cover when hurt or suppressed, and there is somewhere to go.
    const wantCover = (1 - healthFrac) * 0.9 + e.suppression * 0.75;
    consider("cover", e.hasContact && wantCover > 0.55 ? 0.55 + wantCover * 0.5 : 0);

    // Flank: only with a squad, only one at a time, only at fighting range.
    if (
      e.role === "flanker" &&
      e.squad &&
      squadStrength >= 2 &&
      e.lkValid &&
      dist > 12 &&
      dist < e.loadout.range * 1.4 &&
      healthFrac > 0.45
    ) {
      consider("flank", 0.95);
    }

    // Suppress: keep the target's head down so the flanker lives.
    if (
      e.role === "suppressor" &&
      e.squad &&
      e.squad.flankToken !== 0 &&
      now < e.squad.flankUntil &&
      e.lkValid &&
      e.ammo > e.loadout.magazine * 0.35
    ) {
      consider("suppress", 1.0);
    }

    // Retreat: badly hurt, or the last man standing against an active threat.
    const alone = squadStrength <= 1;
    consider(
      "retreat",
      healthFrac < 0.28 || (alone && healthFrac < 0.55 && e.hasContact) ? 1.1 - healthFrac : 0,
    );

    // Call it in — once, and only with a real contact.
    if (e.hasContact && !e.calledIn && (!e.squad || now - e.squad.calledAt > 25)) {
      e.calledIn = true;
      if (e.squad) e.squad.calledAt = now;
      emitNoise("shout", e.x, e.y + 1.6, e.z, e.faction, e.id, 60, 0.3);
      this.onReinforcementsRequested?.(e.lkX || px, e.lkZ || pz, e.faction);
    }

    if (bestState !== e.state) this.setState(e, bestState);
  }

  private setState(e: Enemy, s: EnemyState): void {
    if (e.state === s) return;
    if (e.state === "flank") e.squad?.releaseFlank(e);
    e.state = s;
    e.stateTime = 0;
    e.hasDest = false;
    e.pathTimer = 0;
    if (s === "reload") e.reloadTimer = e.loadout.reloadTime;
    if (s === "cover") e.coverValid = false;
  }

  /* ---------------- acting ---------------- */

  private act(e: Enemy, dt: number, now: number, px: number, py: number, pz: number): void {
    switch (e.state) {
      case "stagger":
        e.staggerTimer -= dt;
        e.speed = 0;
        e.vx = 0;
        e.vz = 0;
        e.clip = ANIM_IDLE;
        if (e.staggerTimer <= 0) this.setState(e, e.hasContact ? "engage" : "search");
        break;

      case "reload":
        e.reloadTimer -= dt;
        e.clip = ANIM_AIM;
        e.blend = Math.min(1, e.blend + dt * 4);
        this.holdOrRetreat(e, dt, now, px, pz);
        if (e.reloadTimer <= 0) {
          e.ammo = e.loadout.magazine;
          this.setState(e, e.hasContact ? "engage" : e.lkValid ? "search" : "patrol");
        }
        break;

      case "patrol":
        this.doPatrol(e, dt, now);
        break;

      case "suspicious":
        this.doSuspicious(e, dt, now);
        break;

      case "search":
        this.doSearch(e, dt, now);
        break;

      case "engage":
        this.doEngage(e, dt, now, px, py, pz, false);
        break;

      case "suppress":
        this.doEngage(e, dt, now, px, py, pz, true);
        break;

      case "cover":
        this.doCover(e, dt, now, px, py, pz);
        break;

      case "flank":
        this.doFlank(e, dt, now, px, py, pz);
        break;

      case "retreat":
        this.doRetreat(e, dt, now, px, pz);
        break;

      default:
        break;
    }
    e.zero = Math.max(0, e.zero - dt * 0.35);
  }

  /* ---- individual behaviours ---- */

  private doPatrol(e: Enemy, dt: number, now: number): void {
    e.clip = ANIM_WALK;
    e.blend = 0;
    if (!e.hasDest || pathFinished(e.path)) {
      // Walk to somewhere on the street graph 40–120 m away.
      const a = this.rng.next() * Math.PI * 2;
      const r = 40 + this.rng.next() * 80;
      e.destX = e.x + Math.cos(a) * r;
      e.destZ = e.z + Math.sin(a) * r;
      e.hasDest = findPath(e.x, e.z, e.destX, e.destZ, e.path, { budget: 900 }, now);
    }
    this.followPath(e, dt, 1.6);
    // Head sweep — the tell that a patrol is alive rather than on rails.
    e.aimYaw = approachAngle(e.aimYaw, e.yaw + Math.sin(now * 0.5 + e.seed * 9) * 0.7, dt * 1.4);
  }

  private doSuspicious(e: Enemy, dt: number, now: number): void {
    e.clip = ANIM_AIM;
    e.blend = Math.min(1, e.blend + dt * 3);
    e.suspicion = Math.max(0, e.suspicion - dt * 0.12);
    if (e.lkValid) {
      const bearing = Math.atan2(e.lkZ - e.z, e.lkX - e.x);
      e.aimYaw = approachAngle(e.aimYaw, bearing, dt * 3.2);
      const d = Math.hypot(e.lkX - e.x, e.lkZ - e.z);
      if (d > 8) {
        if (!e.hasDest || pathFinished(e.path) || e.pathTimer <= 0) {
          e.destX = e.lkX;
          e.destZ = e.lkZ;
          e.hasDest = findPath(e.x, e.z, e.destX, e.destZ, e.path, { budget: 900 }, now);
          e.pathTimer = 2.5;
        }
        e.pathTimer -= dt;
        this.followPath(e, dt, 2.4);
      } else {
        this.stand(e, dt);
      }
    } else {
      this.stand(e, dt);
    }
    if (e.suspicion < 0.12 && e.stateTime > 6) this.setState(e, "patrol");
  }

  private doSearch(e: Enemy, dt: number, now: number): void {
    e.clip = ANIM_AIM;
    e.blend = Math.min(1, e.blend + dt * 3);
    // Prefer whatever the squad most recently shared over private knowledge.
    let tx = e.lkX;
    let tz = e.lkZ;
    if (e.squad && e.squad.lkTime > e.lastSeen) {
      tx = e.squad.lkX;
      tz = e.squad.lkZ;
    }
    // Spiral outward: search widens with time, which is what makes hiding in
    // one spot a losing strategy without making the AI omniscient.
    const spread = Math.min(26, e.stateTime * 2.2);
    const a = e.stateTime * 0.8 + e.seed * 6.28;
    const gx = tx + Math.cos(a) * spread;
    const gz = tz + Math.sin(a) * spread;

    e.pathTimer -= dt;
    if (!e.hasDest || pathFinished(e.path) || e.pathTimer <= 0) {
      e.destX = gx;
      e.destZ = gz;
      e.hasDest = findPath(e.x, e.z, gx, gz, e.path, { budget: 1100 }, now);
      e.pathTimer = 3.5;
    }
    this.followPath(e, dt, 3.2);
    e.aimYaw = approachAngle(e.aimYaw, e.yaw + Math.sin(now * 1.6 + e.seed * 4) * 0.85, dt * 2.6);
    if (e.stateTime > 34) {
      e.lkValid = false;
      e.suspicion *= 0.4;
      this.setState(e, "patrol");
    }
  }

  private doEngage(
    e: Enemy,
    dt: number,
    now: number,
    px: number,
    py: number,
    pz: number,
    suppressing: boolean,
  ): void {
    e.clip = ANIM_AIM;
    e.blend = Math.min(1, e.blend + dt * 5);

    // Aim at the target, or at the target's cover when suppressing.
    const tx = suppressing && !e.hasContact ? e.lkX : px;
    const tz = suppressing && !e.hasContact ? e.lkZ : pz;
    const ty = suppressing && !e.hasContact ? e.y + 1.2 : py;
    const bearing = Math.atan2(tz - e.z, tx - e.x);
    const dist = Math.hypot(tx - e.x, tz - e.z);
    // Turn rate falls with suppression: a soldier being shot at tracks worse.
    e.aimYaw = approachAngle(e.aimYaw, bearing, dt * (5.5 - e.suppression * 2.5));
    e.aimPitch = Math.atan2(ty - (e.y + EYE_HEIGHT), Math.max(1, dist));
    e.yaw = approachAngle(e.yaw, e.aimYaw, dt * 4);

    // Reposition: close if too far, back off if far too close, strafe otherwise.
    const ideal = e.loadout.range * 0.55;
    if (dist > ideal * 1.5) {
      this.moveToward(e, dt, tx, tz, now, 3.0);
    } else if (dist < 6) {
      this.moveToward(e, dt, e.x - (tx - e.x), e.z - (tz - e.z), now, 2.6);
    } else {
      // Combat strafe — small, lateral, and it makes them much harder to hit.
      const s = Math.sin(now * 0.9 + e.seed * 12);
      const nx = -Math.sin(bearing);
      const nz = Math.cos(bearing);
      this.stepDirect(e, dt, nx * s * 1.4, nz * s * 1.4, 1.4);
    }

    this.tryGrenade(e, now, tx, tz, dist);
    this.fire(e, dt, now, px, py, pz, dist, suppressing);
  }

  private doCover(e: Enemy, dt: number, now: number, px: number, py: number, pz: number): void {
    e.clip = ANIM_AIM;
    e.blend = Math.min(1, e.blend + dt * 4);
    e.coverTimer -= dt;
    if (!e.coverValid || e.coverTimer <= 0) {
      this.findCover(e, px, py, pz);
      e.coverTimer = 4;
    }
    if (e.coverValid) {
      const d = Math.hypot(e.coverX - e.x, e.coverZ - e.z);
      if (d > 1.4) {
        this.moveToward(e, dt, e.coverX, e.coverZ, now, 4.2);
      } else {
        this.stand(e, dt);
        // Peek and return fire on a rhythm rather than continuously.
        const peek = Math.sin(now * 0.7 + e.seed * 5) > 0.35;
        if (peek && e.hasContact) this.fire(e, dt, now, px, py, pz, Math.hypot(px - e.x, pz - e.z), false);
      }
    } else {
      // Nowhere to hide: fight from where you stand.
      this.doEngage(e, dt, now, px, py, pz, false);
      return;
    }
    const bearing = Math.atan2(pz - e.z, px - e.x);
    e.aimYaw = approachAngle(e.aimYaw, bearing, dt * 4);
    e.yaw = approachAngle(e.yaw, e.aimYaw, dt * 3.5);
    if (e.suppression < 0.15 && e.health / e.maxHealth > 0.5 && e.stateTime > 4) {
      this.setState(e, e.hasContact ? "engage" : "search");
    }
  }

  private doFlank(e: Enemy, dt: number, now: number, px: number, py: number, pz: number): void {
    if (!e.squad || !e.squad.claimFlank(e, now)) {
      this.setState(e, e.hasContact ? "engage" : "search");
      return;
    }
    e.clip = ANIM_RUN;
    e.blend = 0;
    e.pathTimer -= dt;
    if (!e.hasDest || pathFinished(e.path) || e.pathTimer <= 0) {
      // A wide arc: 70–110° off the direct approach, at roughly engagement
      // range. Going *round* rather than *at* is the entire behaviour.
      const bearing = Math.atan2(e.z - pz, e.x - px);
      const side = ((e.id & 1) === 0 ? 1 : -1) as 1 | -1;
      const a = bearing + side * (1.2 + this.rng.next() * 0.6);
      const r = 16 + this.rng.next() * 18;
      e.destX = px + Math.cos(a) * r;
      e.destZ = pz + Math.sin(a) * r;
      e.hasDest = findPath(e.x, e.z, e.destX, e.destZ, e.path, { budget: 1400 }, now);
      e.pathTimer = 3;
    }
    this.followPath(e, dt, 4.6);
    const bearing = Math.atan2(pz - e.z, px - e.x);
    e.aimYaw = approachAngle(e.aimYaw, bearing, dt * 3);
    // Flankers shoot when they arrive, not on the way — running and gunning
    // gets them killed and looks wrong.
    const d = Math.hypot(px - e.x, pz - e.z);
    if (e.hasContact && (pathFinished(e.path) || d < e.loadout.range * 0.5)) {
      e.squad.releaseFlank(e);
      this.setState(e, "engage");
    }
    if (e.stateTime > 12) {
      e.squad.releaseFlank(e);
      this.setState(e, "engage");
    }
  }

  private doRetreat(e: Enemy, dt: number, now: number, px: number, pz: number): void {
    e.clip = ANIM_RUN;
    e.blend = 0;
    e.pathTimer -= dt;
    if (!e.hasDest || pathFinished(e.path) || e.pathTimer <= 0) {
      const a = Math.atan2(e.z - pz, e.x - px);
      e.destX = e.x + Math.cos(a) * 55;
      e.destZ = e.z + Math.sin(a) * 55;
      e.hasDest = findPath(e.x, e.z, e.destX, e.destZ, e.path, { budget: 1000 }, now);
      e.pathTimer = 3;
    }
    this.followPath(e, dt, 4.4);
    if (e.stateTime > 10 && e.health / e.maxHealth > 0.4) {
      this.setState(e, e.hasContact ? "cover" : "search");
    }
  }

  /** Reloading or holding: back away from the threat if it is close. */
  private holdOrRetreat(e: Enemy, dt: number, now: number, px: number, pz: number): void {
    const d = Math.hypot(px - e.x, pz - e.z);
    if (e.hasContact && d < 22) {
      const a = Math.atan2(e.z - pz, e.x - px);
      this.stepDirect(e, dt, Math.cos(a) * 2.6, Math.sin(a) * 2.6, 2.6);
    } else {
      this.stand(e, dt);
    }
  }

  /* ---------------- weapons ---------------- */

  /**
   * Fire control. Bursts, a magazine, and — the part that matters — an accuracy
   * that ramps with time on target and degrades with suppression, movement and
   * range. First contact should miss.
   */
  private fire(
    e: Enemy,
    dt: number,
    now: number,
    px: number,
    py: number,
    pz: number,
    dist: number,
    suppressing: boolean,
  ): void {
    const L = e.loadout;
    e.fireTimer -= dt;
    if (!e.hasContact && !suppressing) return;
    if (dist > L.range * 1.25) return;
    if (e.ammo <= 0) return;

    // Zeroing: held sight tightens the cone. Suppressing fire never zeroes —
    // that is the point of it.
    if (!suppressing) e.zero = Math.min(1, e.zero + dt / L.rampTime);

    if (e.burstLeft <= 0) {
      if (e.fireTimer > 0) return;
      e.burstLeft = suppressing ? L.burst * 2 : L.burst;
      // A soldier who has just been shot at hesitates.
      e.fireTimer = 0;
    }
    if (e.fireTimer > 0) return;

    e.fireTimer = 60 / L.rpm;
    e.burstLeft--;
    e.ammo--;
    if (e.burstLeft <= 0) {
      e.fireTimer = L.burstPause * (0.75 + this.rng.next() * 0.6) + e.suppression * 0.5;
    }

    const ox = e.x + Math.cos(e.aimYaw) * 0.35;
    const oy = e.y + EYE_HEIGHT * e.heightScale;
    const oz = e.z + Math.sin(e.aimYaw) * 0.35;

    // Aim error. Cold → hot by `zero`, widened by suppression, by the shooter's
    // own movement, and by the target's speed.
    const targetMotion = Math.min(1, frame.speed / 12);
    let spread = L.spreadCold + (L.spreadHot - L.spreadCold) * e.zero;
    spread *= 1 + e.suppression * 1.6 + Math.min(1, e.speed / 4) * 0.8 + targetMotion * 0.7;
    if (suppressing) spread *= 2.4;

    const dirX = px - ox;
    const dirY = py - oy;
    const dirZ = pz - oz;
    const len = Math.hypot(dirX, dirY, dirZ) || 1;
    const yawErr = this.rng.gauss() * spread;
    const pitchErr = this.rng.gauss() * spread * 0.7;
    const baseYaw = Math.atan2(dirZ, dirX) + yawErr;
    const basePitch = Math.asin(clamp(dirY / len, -1, 1)) + pitchErr;
    const cp = Math.cos(basePitch);
    const sx = Math.cos(baseYaw) * cp;
    const sy = Math.sin(basePitch);
    const sz = Math.sin(baseYaw) * cp;

    emitGunshot(ox, oy, oz, e.faction, e.id, L.loud);

    // Hit resolution: a cone test against the player capsule, then a wall check.
    let hitPlayer = false;
    if (!suppressing) {
      const t = (px - ox) * sx + (py - oy) * sy + (pz - oz) * sz;
      if (t > 0) {
        const cxp = ox + sx * t;
        const cyp = oy + sy * t;
        const czp = oz + sz * t;
        const miss = Math.hypot(cxp - px, cyp - py, czp - pz);
        if (miss < 0.55) {
          // Confirm nothing solid is in the way before the round lands.
          let blocked = false;
          if (isPhysicsReady()) {
            blocked = raycast(ox, oy, oz, sx, sy, sz, len - 0.4, _hit, { skipSurface: true });
          }
          if (!blocked) {
            hitPlayer = true;
            const falloff = 1 - Math.min(0.6, dist / (L.range * 2));
            const dmg = L.damage * falloff;
            const dirToShooter = Math.atan2(e.z - pz, e.x - px);
            useSfStore.getState().damage(dmg, dirToShooter);
          }
        } else if (miss < 3.5) {
          // A near miss suppresses the *player*, via the view kick the weapon
          // stack already reads.
          frame.viewKick.x += (this.rng.next() - 0.5) * 0.012;
          frame.viewKick.y += (this.rng.next() - 0.5) * 0.008;
        }
      }
    }

    this.onShot?.(e, ox, oy, oz, sx, sy, sz, hitPlayer);
  }

  /** Throw a grenade to flush a target that is dug in and not moving. */
  private tryGrenade(e: Enemy, now: number, tx: number, tz: number, dist: number): void {
    e.grenadeTimer -= 0.22;
    if (e.grenades <= 0 || e.grenadeTimer > 0) return;
    if (dist < 9 || dist > 34) return;
    // Only flush someone who is actually holding still behind something.
    if (frame.speed > 3.2) return;
    if (e.hasContact && now - e.lastSeen > 1.5) return;
    e.grenades--;
    e.grenadeTimer = 14 + this.rng.next() * 10;
    // The grenade itself is the weapon stack's business; the AI publishes the
    // intent as a world event so VFX, audio and the crowd all react to it.
    emitNoise("shout", e.x, e.y + 1.6, e.z, e.faction, e.id, 40, 0.35);
    this.onGrenade?.(e, tx, tz);
  }

  /** Set by the integrator to actually spawn the grenade projectile. */
  onGrenade: ((e: Enemy, tx: number, tz: number) => void) | null = null;

  /* ---------------- movement ---------------- */

  private followPath(e: Enemy, dt: number, speed: number): void {
    if (pathFinished(e.path)) {
      this.moveToward(e, dt, e.destX, e.destZ, 0, speed);
      return;
    }
    advancePath(e.path, e.x, e.z, 3.2);
    const nodeId = e.path.cursor < e.path.count ? e.path.nodes[e.path.cursor] : -1;
    const n = nodeId >= 0 ? roadNetwork.nodes[nodeId] : null;
    if (!n) {
      this.moveToward(e, dt, e.destX, e.destZ, 0, speed);
      return;
    }
    this.moveToward(e, dt, n.x, n.z, 0, speed);
  }

  /** Steer at a world point with avoidance and a wall-slide fallback. */
  private moveToward(e: Enemy, dt: number, tx: number, tz: number, now: number, speed: number): void {
    let dx = tx - e.x;
    let dz = tz - e.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.4) {
      this.stand(e, dt);
      return;
    }
    dx /= d;
    dz /= d;
    this.stepDirect(e, dt, dx * speed, dz * speed, speed);
  }

  /** Integrate a desired velocity: RVO, then a wall probe, then the ground. */
  private stepDirect(e: Enemy, dt: number, vx: number, vz: number, speed: number): void {
    if (e.lod === LOD_FULL) {
      avoidance.solve(e.avoidHandle, e.x, e.z, vx, vz, 0.42, _steer, 1.8, 1);
      vx = _steer[0];
      vz = _steer[1];
    }
    const mag = Math.hypot(vx, vz);
    if (mag > 1e-4) {
      const step = Math.max(0.6, mag * dt * 3);
      const frac = probeAhead(e.x, e.y + 1.0, e.z, vx, vz, step, _normal);
      if (frac < 0.6) {
        slideAlong(vx / mag, vz / mag, _normal[0], _normal[2], _steer);
        vx = _steer[0] * mag;
        vz = _steer[1] * mag;
      }
    }
    e.x += vx * dt;
    e.z += vz * dt;
    e.vx = vx;
    e.vz = vz;
    e.speed = Math.hypot(vx, vz);
    e.y = groundHeight(e.x, e.z, e.y + 2.2, 8);
    if (e.speed > 0.15) e.yaw = approachAngle(e.yaw, Math.atan2(vz, vx), dt * 6);
    e.clip = e.speed > 3.6 ? ANIM_RUN : e.clip === ANIM_AIM ? ANIM_AIM : ANIM_WALK;
  }

  private stand(e: Enemy, dt: number): void {
    e.vx *= Math.max(0, 1 - dt * 8);
    e.vz *= Math.max(0, 1 - dt * 8);
    e.speed = Math.hypot(e.vx, e.vz);
    e.y = groundHeight(e.x, e.z, e.y + 2.2, 8);
  }

  /* ---------------- cover selection ---------------- */

  /**
   * Find a point that genuinely breaks the line to the threat.
   *
   * Candidates come from two real sources — the building index's footprints and
   * parked or stopped traffic — and every one of them is *verified* by a
   * raycast from the candidate's chest height to the threat's eye. Scored
   * candidates that fail the raycast are discarded, which is why soldiers here
   * do not run to the wrong side of a wall.
   */
  private findCover(e: Enemy, px: number, py: number, pz: number): void {
    e.coverValid = false;
    const searchR = 26;
    let bestScore = -Infinity;
    let bx = 0;
    let bz = 0;

    const toX = e.x - px;
    const toZ = e.z - pz;
    const toLen = Math.hypot(toX, toZ) || 1;
    const awayX = toX / toLen;
    const awayZ = toZ / toLen;

    _covers.length = 0;
    buildingIndex.queryAABB(e.x - searchR, e.z - searchR, e.x + searchR, e.z + searchR, _covers);
    for (let i = 0; i < _covers.length && i < 20; i++) {
      const r = _covers[i];
      // Candidate on the far side of the footprint from the threat, one metre
      // clear of the wall so the soldier is not inside it.
      const cx = r.cx + awayX * (Math.max(r.hw, r.hd) + 1.1);
      const cz = r.cz + awayZ * (Math.max(r.hw, r.hd) + 1.1);
      const score = this.scoreCover(e, cx, cz, px, py, pz);
      if (score > bestScore) {
        bestScore = score;
        bx = cx;
        bz = cz;
      }
      // Also the two corners nearest the soldier — corner peeking is the most
      // useful cover shape in a city.
      for (const sgn of [1, -1] as const) {
        const ox = r.cx + awayX * (r.hw + 0.9) + -awayZ * sgn * (r.hd + 0.9);
        const oz = r.cz + awayZ * (r.hd + 0.9) + awayX * sgn * (r.hw + 0.9);
        const s2 = this.scoreCover(e, ox, oz, px, py, pz);
        if (s2 > bestScore) {
          bestScore = s2;
          bx = ox;
          bz = oz;
        }
      }
    }

    trafficSim.forEachNear(e.x, e.z, searchR, (v) => {
      if (v.speed > 2) return; // a moving car is not cover
      const cx = v.x + awayX * (v.spec.width * 0.5 + 0.9);
      const cz = v.z + awayZ * (v.spec.width * 0.5 + 0.9);
      const score = this.scoreCover(e, cx, cz, px, py, pz) - 0.4; // softer than a wall
      if (score > bestScore) {
        bestScore = score;
        bx = cx;
        bz = cz;
      }
    });

    if (bestScore > -Infinity) {
      e.coverX = bx;
      e.coverZ = bz;
      e.coverValid = true;
    }
  }

  /** −∞ when the candidate does not actually block; otherwise nearer is better. */
  private scoreCover(e: Enemy, cx: number, cz: number, px: number, py: number, pz: number): number {
    const dThreat = Math.hypot(cx - px, cz - pz);
    if (dThreat < 7) return -Infinity; // cover you have to run past the enemy for
    const dSelf = Math.hypot(cx - e.x, cz - e.z);
    if (dSelf > 28) return -Infinity;

    if (isPhysicsReady()) {
      const oy = groundHeight(cx, cz, e.y + 4, 12) + 1.15;
      const dx = px - cx;
      const dy = py - oy;
      const dz = pz - cz;
      const len = Math.hypot(dx, dy, dz) || 1;
      const blocked = raycast(cx, oy, cz, dx / len, dy / len, dz / len, len - 0.3, _hit, {
        skipSurface: true,
      });
      if (!blocked) return -Infinity;
    }
    // Prefer close cover that is not too far from the fight.
    return 10 - dSelf * 0.35 - Math.abs(dThreat - e.loadout.range * 0.45) * 0.05;
  }

  /* ---------------- damage + reactions ---------------- */

  /** Returns true if this killed them. */
  applyDamage(id: number, amount: number, now: number, fromX = 0, fromZ = 0, headshot = false): boolean {
    const e = this.byId.get(id);
    if (!e || !e.alive || e.state === "dead") return false;
    const mitigated = headshot ? amount * 2.4 : amount * (1 - e.armour);
    e.health -= mitigated;
    e.soak = Math.min(1, e.soak + mitigated / 90);
    e.suppression = Math.min(1, e.suppression + 0.5);
    // Being shot from an unseen direction is the strongest possible cue.
    if (fromX !== 0 || fromZ !== 0) {
      e.lkX = fromX;
      e.lkZ = fromZ;
      e.lkValid = true;
      e.squad?.share(fromX, fromZ, now);
      e.suspicion = 1;
    }
    if (e.health <= 0) {
      this.kill(e, now);
      return true;
    }
    // A wounded soldier reconsiders immediately rather than at the next tick.
    e.thinkAt = 0;
    return false;
  }

  private kill(e: Enemy, now: number): void {
    e.state = "dead";
    e.alive = false;
    e.clip = ANIM_DEAD;
    e.blend = 0;
    e.speed = 0;
    e.deathTimer = 0;
    e.squad?.releaseFlank(e);
    emitNoise("scream", e.x, e.y + 1.4, e.z, e.faction, e.id, 45, 0.35);
    // The squad learns where the shot came from even when the victim did not.
    if (e.squad && e.lkValid) e.squad.share(e.lkX, e.lkZ, now);
    this.onKilled?.(e);
  }

  /**
   * Yanked off their feet by a grapple. They lose the fight for a moment,
   * drop their zero, and come up looking in the direction they were pulled.
   */
  onGrappled(id: number, now: number, pullX = 0, pullZ = 0): void {
    const e = this.byId.get(id);
    if (!e || !e.alive) return;
    e.staggerTimer = 1.5 + this.rng.next() * 0.9;
    e.zero = 0;
    e.suppression = 1;
    e.state = "stagger";
    e.stateTime = 0;
    if (pullX !== 0 || pullZ !== 0) {
      e.aimYaw = Math.atan2(pullZ, pullX);
      e.lkX = e.x + pullX * 10;
      e.lkZ = e.z + pullZ * 10;
      e.lkValid = true;
    }
    e.thinkAt = now + e.staggerTimer;
  }

  /**
   * Their ride just went up. Everyone inside the blast radius scatters, takes
   * cover, and marks the explosion as the last known threat position.
   */
  onVehicleDestroyed(x: number, z: number, radius: number, now: number): void {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d > radius) continue;
      e.suppression = 1;
      e.suspicion = 1;
      e.lkX = x;
      e.lkZ = z;
      e.lkValid = true;
      e.coverValid = false;
      this.setState(e, "cover");
      e.thinkAt = now + 0.6;
    }
  }

  /** Wake everyone in a radius — used by the heat system on a new crime. */
  alertArea(x: number, z: number, radius: number, now: number): void {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (Math.hypot(e.x - x, e.z - z) > radius) continue;
      e.suspicion = Math.max(e.suspicion, 0.8);
      e.lkX = x;
      e.lkZ = z;
      e.lkValid = true;
      e.thinkAt = Math.min(e.thinkAt, now + 0.1);
    }
  }

  /* ---------------- queries + rendering ---------------- */

  forEachHitbox(
    ax: number,
    az: number,
    radius: number,
    cb: (id: number, x: number, y: number, z: number, height: number, alive: boolean) => void,
  ): void {
    const r2 = radius * radius;
    for (const e of this.enemies) {
      const dx = e.x - ax;
      const dz = e.z - az;
      if (dx * dx + dz * dz > r2) continue;
      cb(e.id, e.x, e.y, e.z, 1.8 * e.heightScale, e.state !== "dead");
    }
  }

  render(batch: CharacterBatch, cx: number, cy: number, cz: number): void {
    for (const e of this.enemies) {
      const dx = e.x - cx;
      const dy = e.y - cy;
      const dz = e.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const loco = e.clip === ANIM_WALK || e.clip === ANIM_RUN || e.clip === ANIM_IDLE;
      batch.push(
        e.x,
        e.y,
        e.z,
        // The body faces where it moves; the *upper* body is snapped to the aim
        // by the shader's aim pose, so passing the aim yaw here reads correctly
        // for a soldier who is strafing while shooting at you.
        e.clip === ANIM_AIM ? e.aimYaw : e.yaw,
        e.phase,
        e.speed,
        loco ? 0 : e.clip,
        loco ? 0 : e.blend,
        e.heightScale,
        e.girth,
        e.mask,
        e.seed,
        e.soak,
        e.palette,
        0,
        d2,
      );
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export const enemyForce = new EnemyForce();
export { EnemyForce, LOADOUTS };
