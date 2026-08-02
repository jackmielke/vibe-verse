/**
 * The fleet: every hull in the sector, how it moves, how it breaks, and — for
 * everything that is not the player — what it decides to do next.
 *
 * The combat model is built backwards from what the show looks like rather
 * than from what a space battle would be. Three decisions follow from that and
 * they are the whole feel of the thing:
 *
 * **Ships are slow and turn badly.** 340 m/s and about fourteen degrees a
 * second. You cannot dogfight a starship, and you are not supposed to: you
 * commit to a pass, and once you have committed you live with it for the ten
 * seconds it takes to come round again. Every dramatic beat in a Star Trek
 * battle happens in that ten seconds.
 *
 * **Shields are four numbers, not one.** Fore, aft, port, starboard — the four
 * the show names out loud. A single shield bar is a health bar; four of them
 * make *which way you are pointing* the central tactical question, which is
 * exactly the question the Enterprise's bridge crew is always arguing about.
 *
 * **Damage is reported, not displayed.** Hits pick a system and break it, and
 * the crew tells you which one. Losing the sensors is much worse than losing
 * eight percent of a hull bar, and it is worse in a way you feel rather than
 * read.
 */
import * as THREE from "three";
import { buildHull, buildShieldBubble } from "../ships/hulls";
import {
  clamp,
  FACING_NAMES,
  type FleetService,
  type HullClass,
  type Ship,
  type ShipAI,
  type SpawnSpec,
  type System,
  type TrekCtx,
} from "../types";

/** Per-class handling and toughness. Hull points, not fractions. */
const CLASS_STATS: Record<HullClass, { hull: number; speed: number; agility: number; radius: number; torpedoes: number }> = {
  constitution: { hull: 1000, speed: 340, agility: 0.25, radius: 150, torpedoes: 24 },
  miranda: { hull: 780, speed: 360, agility: 0.3, radius: 130, torpedoes: 18 },
  d7: { hull: 820, speed: 355, agility: 0.27, radius: 130, torpedoes: 14 },
  birdOfPrey: { hull: 520, speed: 400, agility: 0.42, radius: 80, torpedoes: 8 },
  freighter: { hull: 300, speed: 130, agility: 0.1, radius: 100, torpedoes: 0 },
  planetKiller: { hull: 9000, speed: 90, agility: 0.05, radius: 700, torpedoes: 0 },
  // Fast and extremely nimble, and made of rock rather than duranium. It can
  // out-turn anything else in this file and it cannot take a single volley.
  creature: { hull: 240, speed: 520, agility: 1.1, radius: 100, torpedoes: 0 },
  shuttle: { hull: 90, speed: 260, agility: 0.7, radius: 12, torpedoes: 0 },
};

let nextId = 1;

export function createFleet(ctx: TrekCtx): System {
  const { space, rng } = ctx;
  const ships: Ship[] = [];
  /** Cached so cloaking and damage do not traverse a hundred meshes a frame. */
  const meshCache = new WeakMap<THREE.Object3D, THREE.Mesh[]>();
  const bubbles = new WeakMap<Ship, THREE.Mesh>();

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();

  function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
    let list = meshCache.get(root);
    if (!list) {
      list = [];
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) list!.push(o as THREE.Mesh);
      });
      meshCache.set(root, list);
    }
    return list;
  }

  function spawn(spec: SpawnSpec): Ship {
    const stats = CLASS_STATS[spec.hull];
    const object = buildHull(spec.hull, spec.registry ?? "", spec.name);
    object.position.copy(spec.position);
    if (spec.lookAt) object.lookAt(spec.lookAt);
    space.add(object);

    const maxHull = spec.hullStrength ?? stats.hull;
    const ai: ShipAI | undefined = spec.isPlayer
      ? undefined
      : {
          aggression: spec.ai?.aggression ?? 0.6,
          skill: spec.ai?.skill ?? 0.5,
          think: 0,
          state: spec.ai?.state ?? "approach",
          offset: new THREE.Vector3(),
          cloakTimer: spec.ai?.cloakTimer ?? 6,
        };

    const ship: Ship = {
      id: nextId++,
      name: spec.name,
      registry: spec.registry ?? "",
      hull: spec.hull,
      allegiance: spec.allegiance,
      object,
      position: object.position,
      quaternion: object.quaternion,
      velocity: new THREE.Vector3(),
      angular: new THREE.Vector3(),
      throttle: spec.isPlayer ? 0.25 : 0.5,
      maxSpeed: stats.speed,
      agility: stats.agility,
      mass: maxHull,
      shields: [1, 1, 1, 1],
      shieldsUp: !spec.isPlayer && spec.allegiance !== "neutral",
      shieldRegen: 0.028,
      hull_: 1,
      maxHull,
      systems: { warp: 1, impulse: 1, phasers: 1, torpedoes: 1, sensors: 1, shields: 1, lifeSupport: 1 },
      phaserCooldown: 0,
      torpedoCooldown: 0,
      torpedoes: spec.torpedoes ?? stats.torpedoes,
      phaserCharge: 1,
      cloaked: spec.cloaked ?? false,
      cloakLevel: spec.cloaked ? 1 : 0,
      canCloak: spec.canCloak ?? false,
      targetId: null,
      alive: true,
      dyingFor: 0,
      ai,
      radius: stats.radius,
      arriving: spec.arriving ?? 0,
    };

    if (spec.hull !== "planetKiller" && spec.hull !== "freighter") {
      // Hugging the hull rather than englobing it. A bubble at 1.5× radius is
      // a visible sphere the ship rattles around inside; at 1.15× it reads as
      // a skin over the hull, which is what it is meant to be.
      const bubble = buildShieldBubble(stats.radius * 1.15);
      object.add(bubble);
      bubbles.set(ship, bubble);
    }

    ships.push(ship);
    return ship;
  }

  function remove(ship: Ship): void {
    const i = ships.indexOf(ship);
    if (i >= 0) ships.splice(i, 1);
    space.remove(ship.object);
    ship.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const m = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) mm.dispose();
    });
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  const SYSTEM_KEYS = ["warp", "impulse", "phasers", "torpedoes", "sensors", "shields", "lifeSupport"] as const;

  /**
   * Which shield takes the hit.
   *
   * Worked in the ship's own frame: the hit direction is rotated into local
   * space and then it is just a question of which axis dominates. Forward and
   * aft win ties against the beam because a starship is long, and a shot from
   * thirty degrees off the bow is a bow shot.
   */
  function facingFor(ship: Ship, from: THREE.Vector3): 0 | 1 | 2 | 3 {
    tmpV.copy(from).sub(ship.position).normalize();
    tmpQ.copy(ship.quaternion).invert();
    tmpV.applyQuaternion(tmpQ);
    const fore = -tmpV.z;
    const stbd = tmpV.x;
    if (Math.abs(fore) * 1.25 >= Math.abs(stbd)) return fore >= 0 ? 0 : 1;
    return stbd >= 0 ? 3 : 2;
  }

  function damage(ship: Ship, amount: number, from: THREE.Vector3, kind: "beam" | "torpedo" | "collision"): number {
    if (!ship.alive) return 0;
    const facing = facingFor(ship, from);
    let toHull = amount;

    const capacity = ship.maxHull * 0.62;
    if (ship.shieldsUp && ship.shields[facing] > 0.02 && ship.systems.shields > 0.15) {
      const absorbed = Math.min(amount * 0.92, ship.shields[facing] * capacity);
      ship.shields[facing] = clamp(ship.shields[facing] - absorbed / capacity, 0, 1);
      toHull = amount - absorbed;
      const bubble = bubbles.get(ship);
      if (bubble) {
        const u = (bubble.material as THREE.ShaderMaterial).uniforms;
        tmpV2.copy(from).sub(ship.position).normalize().applyQuaternion(tmpQ.copy(ship.quaternion).invert());
        (u.uHit.value as THREE.Vector3).copy(tmpV2);
        u.uHitAge.value = 0;
        u.uStrength.value = 1;
      }
      ctx.emit("trek:shieldHit", { ship, facing, amount: absorbed });
    }

    if (toHull > 0.01) {
      ship.hull_ = clamp(ship.hull_ - toHull / ship.maxHull, 0, 1);
      // A hit that reaches the hull breaks something. Which one is random —
      // that is the point of it, and it is why "we've lost the sensors" lands
      // as news rather than as a number going down.
      if (kind !== "collision" || rng.chance(0.6)) {
        const key = SYSTEM_KEYS[rng.int(0, SYSTEM_KEYS.length - 1)];
        const loss = clamp((toHull / ship.maxHull) * rng.range(1.6, 4.2), 0, 0.6);
        ship.systems[key] = clamp(ship.systems[key] - loss, 0, 1);
        ctx.emit("trek:systemDamage", { ship, system: key, level: ship.systems[key] });
      }
      ctx.emit("trek:hullHit", { ship, amount: toHull, facing });
      if (ship.hull_ <= 0 && ship.alive) {
        ship.alive = false;
        ship.dyingFor = 0;
        ctx.emit("trek:destroyed", { ship });
      }
    }
    return toHull;
  }

  // -------------------------------------------------------------------------
  // Motion
  // -------------------------------------------------------------------------

  const FORWARD = new THREE.Vector3(0, 0, -1);

  /** Turn toward a point, respecting the ship's agility and its damaged helm. */
  function steer(ship: Ship, point: THREE.Vector3, dt: number, gain = 1): number {
    tmpV.copy(point).sub(ship.position);
    const dist = tmpV.length();
    if (dist < 1e-3) return 0;
    tmpV.divideScalar(dist);
    tmpQ.copy(ship.quaternion).invert();
    tmpV.applyQuaternion(tmpQ);

    // Local: -Z forward. Yaw from x, pitch from y.
    const yawErr = Math.atan2(tmpV.x, -tmpV.z);
    const pitchErr = Math.asin(clamp(tmpV.y, -1, 1));
    const agility = ship.agility * (0.35 + 0.65 * ship.systems.impulse) * gain;

    const yawRate = clamp(yawErr * 1.6, -1, 1) * agility;
    const pitchRate = clamp(pitchErr * 1.6, -1, 1) * agility;

    const k = 1 - Math.exp(-4 * dt);
    ship.angular.y += (-yawRate - ship.angular.y) * k;
    ship.angular.x += (pitchRate - ship.angular.x) * k;
    // Bank into the turn. Nothing in space requires it; every starship on
    // television does it, because it is how the eye reads a turn.
    ship.angular.z += (-yawRate * 1.4 - ship.angular.z) * k;
    return Math.abs(yawErr) + Math.abs(pitchErr);
  }

  function integrate(ship: Ship, dt: number): void {
    const q = ship.object.quaternion;
    const e = new THREE.Euler(ship.angular.x * dt, ship.angular.y * dt, ship.angular.z * dt * 0.35, "XYZ");
    q.multiply(tmpQ.setFromEuler(e)).normalize();

    const speed = ship.maxSpeed * ship.throttle * (0.25 + 0.75 * ship.systems.impulse);
    tmpV.copy(FORWARD).applyQuaternion(q).multiplyScalar(speed);
    // Starships have inertia and no atmosphere to bleed it into, so the
    // velocity chases the commanded vector rather than snapping to it. This is
    // the difference between "flying" and "sliding a decal around".
    const k = 1 - Math.exp(-0.9 * dt);
    ship.velocity.lerp(tmpV, k);
    ship.object.position.addScaledVector(ship.velocity, dt);
  }

  // -------------------------------------------------------------------------
  // AI
  // -------------------------------------------------------------------------

  function hostilesOf(ship: Ship): Ship[] {
    return ships.filter(
      (s) => s.alive && s !== ship && s.allegiance !== ship.allegiance && s.allegiance !== "neutral",
    );
  }

  function think(ship: Ship, dt: number): void {
    const ai = ship.ai!;
    ai.think -= dt;

    let target = ship.targetId != null ? ships.find((s) => s.id === ship.targetId && s.alive) : undefined;
    if (!target) {
      // Prefer whatever is closest, unless something is shooting at us.
      const options = hostilesOf(ship);
      target = options.sort((a, b) => a.position.distanceToSquared(ship.position) - b.position.distanceToSquared(ship.position))[0];
      ship.targetId = target?.id ?? null;
    }
    if (!target) {
      ship.throttle = 0.15;
      return;
    }

    const range = ship.position.distanceTo(target.position);
    const preferred = 2600 + ai.aggression * -900;

    if (ai.think <= 0) {
      ai.think = 1.4 + rng.range(0, 1.6);
      // A badly hurt ship runs. Klingons run later than most, Romulans cloak
      // instead — see the cloak block below.
      if (ship.hull_ < 0.22 && !ship.canCloak && rng.chance(0.7)) ai.state = "flee";
      else if (ai.state === "break" && range > preferred * 1.7) ai.state = "approach";
      else if (range > preferred * 1.45) ai.state = "approach";
      else if (range < preferred * 0.55) ai.state = "break";
      else ai.state = "attack";

      // Attack runs come in off the axis rather than straight down the
      // throat, which is both harder to shoot at and what looks right.
      ai.offset.set(rng.gauss() * 900, rng.gauss() * 600, rng.gauss() * 900);
    }

    switch (ai.state) {
      case "approach":
      case "attack": {
        tmpV2.copy(target.position).add(ai.offset);
        steer(ship, tmpV2, dt);
        ship.throttle = ai.state === "attack" ? 0.32 : 0.8;
        break;
      }
      case "break": {
        // Away from the target, and slightly across it, so the pass reads.
        tmpV2.copy(ship.position).sub(target.position).normalize().multiplyScalar(6000).add(ship.position).add(ai.offset);
        steer(ship, tmpV2, dt);
        ship.throttle = 0.95;
        break;
      }
      case "flee": {
        tmpV2.copy(ship.position).sub(target.position).normalize().multiplyScalar(40000).add(ship.position);
        steer(ship, tmpV2, dt);
        ship.throttle = 1;
        break;
      }
      default:
        ship.throttle = 0.2;
        break;
    }

    // The Romulan cycle: cloak, close, decloak, fire, cloak again. Canon says
    // a cloaked ship cannot fire, and that single rule is the entire game of
    // "Balance of Terror" — the window where it is visible is the only window
    // you have.
    if (ship.canCloak) {
      ai.cloakTimer -= dt;
      if (ship.cloaked && range < 4200 && ai.cloakTimer <= 0) {
        ship.cloaked = false;
        ai.cloakTimer = 9 + rng.range(0, 5);
        ctx.emit("trek:decloak", { ship });
      } else if (!ship.cloaked && ai.cloakTimer <= 0) {
        ship.cloaked = true;
        ai.cloakTimer = 12 + rng.range(0, 8);
        ctx.emit("trek:cloak", { ship });
      }
    }

    // Firing. A cloaked ship never shoots; a ship with a broken weapon cannot;
    // and something with no aggression at all never opens fire on anybody,
    // which is the entire characterisation of one of the things in this game.
    if (ship.cloakLevel > 0.05 || ai.aggression <= 0) return;
    const weapons = ctx.services.weapons;
    if (!weapons) return;

    tmpV.copy(target.position).sub(ship.position).normalize();
    tmpV2.copy(FORWARD).applyQuaternion(ship.quaternion);
    const onTarget = tmpV.dot(tmpV2);

    const sensorPenalty = 1 - (ctx.services.space?.interference ?? 0) * 0.55;
    // Evasive manoeuvres are worth something concrete: a gunner tracking a
    // ship that is jinking gives up the shot about half the time.
    const game = ctx.services.game;
    const evading = game && target === ctx.services.fleet?.player && ctx.elapsed < game.evasiveUntil ? 0.45 : 1;
    const willFire = rng.chance(clamp(ai.skill * sensorPenalty * evading, 0.05, 1));

    if (onTarget > 0.86 && range < 7000 && ship.phaserCooldown <= 0 && ship.systems.phasers > 0.2 && willFire) {
      weapons.firePhasers(ship, target);
      ship.phaserCooldown = 1.6 + rng.range(0, 2.2) * (1.6 - ai.aggression);
    }
    if (
      onTarget > 0.93 &&
      range < 5200 &&
      ship.torpedoCooldown <= 0 &&
      ship.torpedoes > 0 &&
      ship.systems.torpedoes > 0.2 &&
      rng.chance(0.5 * ai.aggression)
    ) {
      weapons.fireTorpedo(ship, target);
      ship.torpedoCooldown = 3.4 + rng.range(0, 3);
    }
  }

  // -------------------------------------------------------------------------

  const service: FleetService = {
    ships,
    player: null as unknown as Ship,
    spawn(spec) {
      const s = spawn(spec);
      if (spec.isPlayer) service.player = s;
      return s;
    },
    remove,
    byId: (id) => ships.find((s) => s.id === id),
    hostilesOf,
    damage,
    clearAll() {
      for (const s of [...ships]) {
        if (s === service.player) continue;
        remove(s);
      }
    },
  };
  ctx.services.fleet = service;

  // The hero ship exists from boot. Every mission repositions it rather than
  // rebuilding it, because rebuilding a 288-metre lathe between episodes is
  // half a second of stall for nothing.
  service.player = spawn({
    name: "U.S.S. VIBEVERSE",
    registry: "NCC-1701-V",
    hull: "constitution",
    allegiance: "starfleet",
    position: new THREE.Vector3(0, 0, 0),
    isPlayer: true,
  });
  service.player.shieldsUp = false;

  return {
    fixedUpdate(dt) {
      const interference = ctx.services.space?.interference ?? 0;

      for (const ship of ships) {
        if (!ship.alive) {
          ship.dyingFor += dt;
          // The wreck keeps its momentum and tumbles. It is removed by the
          // effects system once the fire has burned out.
          ship.object.rotation.x += ship.angular.x * dt * 0.4;
          ship.object.rotation.z += ship.angular.z * dt * 0.4;
          ship.object.position.addScaledVector(ship.velocity, dt);
          ship.velocity.multiplyScalar(1 - 0.15 * dt);
          continue;
        }

        if (ship.ai) think(ship, dt);
        integrate(ship, dt);

        ship.phaserCooldown = Math.max(0, ship.phaserCooldown - dt);
        ship.torpedoCooldown = Math.max(0, ship.torpedoCooldown - dt);

        // Shield regeneration. Slower in a nebula, slower with a broken
        // shield generator, and nothing at all when the screens are down.
        if (ship.shieldsUp) {
          const rate = ship.shieldRegen * ship.systems.shields * (1 - interference * 0.85) * dt;
          for (let f = 0; f < 4; f++) ship.shields[f] = clamp(ship.shields[f] + rate, 0, 1);
        }

        // Cloak transition. Two full seconds either way, and the ship is
        // visible for all of it.
        const wantCloak = ship.cloaked ? 1 : 0;
        const speed = 0.5;
        ship.cloakLevel = clamp(
          ship.cloakLevel + Math.sign(wantCloak - ship.cloakLevel) * speed * dt,
          0,
          1,
        );

        // Damage control: a crew is working on it the whole time.
        for (const key of SYSTEM_KEYS) {
          if (ship.systems[key] < 1) ship.systems[key] = clamp(ship.systems[key] + 0.012 * dt, 0, 1);
        }
      }

      // Keep hulls out of one another. Two 289-metre ships intersecting is the
      // single fastest way to break the illusion, and a real collision is a
      // legitimate — and very expensive — thing to do on purpose.
      for (let i = 0; i < ships.length; i++) {
        const a = ships[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < ships.length; j++) {
          const b = ships[j];
          if (!b.alive) continue;
          const min = a.radius + b.radius;
          const d = a.position.distanceTo(b.position);
          if (d > min * 2.2) continue;
          if (d < min) {
            tmpV.copy(a.position).sub(b.position).normalize();
            const push = (min - d) * 0.5;
            a.object.position.addScaledVector(tmpV, push);
            b.object.position.addScaledVector(tmpV, -push);
            const impact = a.velocity.distanceTo(b.velocity);
            if (impact > 60) {
              damage(a, impact * 1.4, b.position, "collision");
              damage(b, impact * 1.4, a.position, "collision");
              ctx.emit("trek:collision", { a, b });
            }
          } else {
            // Gentle separation before it becomes a collision — an AI that
            // grinds along a hull looks broken even when it is not.
            tmpV.copy(a.position).sub(b.position).normalize().multiplyScalar((min * 2.2 - d) * 0.6 * dt);
            if (a.ai) a.object.position.add(tmpV);
            if (b.ai) b.object.position.sub(tmpV);
          }
        }
      }
    },

    update(dt) {
      for (const ship of ships) {
        // Any hull may declare a per-frame animation of its own. Nothing here
        // needs to know what it does — see buildCreature.
        (ship.object.userData.animate as ((t: number) => void) | undefined)?.(ctx.elapsed);

        // Cloak, applied to the materials. A ship at cloakLevel 1 is gone;
        // between 0 and 1 it is a ghost, and the ghost is the tell.
        const bubble = bubbles.get(ship);
        if (ship.cloakLevel > 0.001 || ship.object.userData.wasCloaked) {
          const opacity = Math.max(0, 1 - ship.cloakLevel);
          for (const mesh of meshesOf(ship.object)) {
            if (mesh === bubble) continue;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of mats) {
              const mat = m as THREE.MeshStandardMaterial;
              if (mat.userData.baseOpacity === undefined) mat.userData.baseOpacity = mat.opacity;
              mat.transparent = ship.cloakLevel > 0.001 || mat.userData.baseOpacity < 1;
              mat.opacity = mat.userData.baseOpacity * opacity;
            }
          }
          ship.object.visible = ship.cloakLevel < 0.995;
          ship.object.userData.wasCloaked = ship.cloakLevel > 0.001;
        }

        if (bubble) {
          const u = (bubble.material as THREE.ShaderMaterial).uniforms;
          u.uTime.value = ctx.elapsed;
          u.uHitAge.value = Math.min(9, (u.uHitAge.value as number) + dt);
          const want = ship.alive && ship.shieldsUp && ship.cloakLevel < 0.1 ? 0.35 + 0.65 * avg(ship.shields) : 0;
          u.uStrength.value += (want - (u.uStrength.value as number)) * Math.min(1, dt * 3);
          bubble.visible = (u.uStrength.value as number) > 0.01 || (u.uHitAge.value as number) < 1.2;
        }
      }
    },

    dispose() {
      for (const s of [...ships]) remove(s);
      ships.length = 0;
    },
  };
}

function avg(v: number[]): number {
  return (v[0] + v[1] + v[2] + v[3]) / 4;
}

export { FACING_NAMES };
