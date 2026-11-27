/**
 * The BB gun. There is always another BB.
 *
 * (The file is still called `bricks` because that is what it threw first. It
 * threw snowballs for a while after that.)
 *
 * Shooting at people who are robbing your house is the one piece of pure
 * uncomplicated wish fulfilment in the whole game. Three decisions make it
 * feel good rather than fiddly.
 *
 * **It is a real projectile.** It is fast and nearly flat, but it is a thing
 * in the air: it pings off a wall, it rattles across the floor, and a man who
 * steps behind a doorframe is behind a doorframe.
 *
 * **It aims itself, a bit.** There is no crosshair on a phone and there never
 * will be, so a shot that would pass anywhere near somebody bends onto his
 * chest. See `AIM_CONE`. Aim assist is usually a smell; here it is the
 * difference between a toy that works with a thumb and one that does not.
 *
 * **It stings, and it does not floor.** Every BB costs him a little nerve and
 * stops him for a beat, so the gun is a real way to wear somebody down while
 * you back away from him. What it will not do is throw him across the room:
 * that is what the traps are for, and a man who is stuck or blind when the BB
 * arrives goes down as hard as if a trap had hit him.
 */
import * as THREE from "three";

/** Anything a brick can hit and hurt. */
export interface BrickTarget {
  x: number;
  y: number;
  z: number;
  /** Standing height, so the hit volume is a capsule and not a dot. */
  height: number;
  /** Returns true if the hit counted — false for someone already flat out. */
  hit(): boolean;
}

export interface BrickWorld {
  /** Highest floor under a point, for the bounce. */
  groundAt(x: number, z: number, ceiling: number): number;
  /** Is this point inside a wall? */
  blocked(x: number, y: number, z: number): boolean;
}

/** How far off a perfect throw can be and still bend onto a burglar. */
const AIM_CONE = 0.42;
const AIM_RANGE = 16;
const GRAVITY = 5.5;
const SPEED = 27;
const MAX_LIVE = 24;

interface Brick {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  /** Seconds left before it fades. Bricks on the floor are set dressing. */
  life: number;
  landed: boolean;
  /** A brick cannot hit the same man twice on one flight. */
  spent: boolean;
}

export interface BrickRig {
  group: THREE.Group;
  /** Fire from a point along a direction. */
  hurl(from: THREE.Vector3, dir: THREE.Vector3, targets: BrickTarget[]): void;
  update(dt: number, world: BrickWorld, targets: BrickTarget[], onHit: (t: BrickTarget) => void): void;
  clear(): void;
  dispose(): void;
}

export function makeBricks(parent: THREE.Object3D): BrickRig {
  const owned: Array<{ dispose(): void }> = [];
  const group = new THREE.Group();
  parent.add(group);

  // Bigger and brighter than a real BB, because a real BB is invisible and a
  // shot you cannot see leave the barrel is a button that does nothing.
  const geo = new THREE.SphereGeometry(0.038, 8, 6);
  owned.push(geo);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffd9a0, roughness: 0.3, metalness: 0.6, emissive: 0xffb040, emissiveIntensity: 1.6 });
  owned.push(mat);

  const live: Brick[] = [];
  const tmp = new THREE.Vector3();

  function hurl(from: THREE.Vector3, dir: THREE.Vector3, targets: BrickTarget[]) {
    // Retire the oldest rather than growing without bound — somebody *will*
    // stand in the hall and throw fifty.
    while (live.length >= MAX_LIVE) {
      const old = live.shift();
      if (old) group.remove(old.mesh);
    }

    const aim = dir.clone().normalize();
    const speed = SPEED;

    /*
     * Aim assist. Find the burglar closest to the line of the throw, inside a
     * cone, and re-aim at his chest with the drop already compensated. The
     * throw still misses if you were not pointing near him at all — the cone
     * is deliberately narrow enough that you cannot hit somebody behind you.
     */
    let best: BrickTarget | null = null;
    let bestAngle = AIM_CONE;
    for (const t of targets) {
      tmp.set(t.x - from.x, t.y + t.height * 0.6 - from.y, t.z - from.z);
      const dist = tmp.length();
      if (dist > AIM_RANGE || dist < 0.3) continue;
      const angle = tmp.normalize().angleTo(aim);
      if (angle < bestAngle) {
        bestAngle = angle;
        best = t;
      }
    }
    if (best) {
      const dx = best.x - from.x;
      const dz = best.z - from.z;
      const flat = Math.hypot(dx, dz);
      const time = flat / speed;
      // Aim at where he will be standing, plus the drop over the flight.
      const dy = best.y + best.height * 0.6 - from.y + 0.5 * GRAVITY * time * time;
      aim.set(dx, dy, dz).normalize();
    } else {
      // A touch of loft, so a shot down a corridor does not bury itself in
      // the carpet half-way.
      aim.y += 0.03;
      aim.normalize();
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(from);
    mesh.castShadow = true;
    group.add(mesh);
    live.push({
      mesh,
      vel: aim.multiplyScalar(speed),
      life: 2.4,
      landed: false,
      spent: false,
    });
  }

  function update(dt: number, world: BrickWorld, targets: BrickTarget[], onHit: (t: BrickTarget) => void) {
    for (let i = live.length - 1; i >= 0; i--) {
      const b = live[i];
      b.life -= dt;
      if (b.life <= 0) {
        group.remove(b.mesh);
        live.splice(i, 1);
        continue;
      }
      if (b.landed) {
        // Lying on the floor. Shrink away so it does not blink out.
        if (b.life < 1) b.mesh.scale.setScalar(Math.max(0.01, b.life));
        continue;
      }

      // Twenty-seven metres a second is most of a metre a frame, and a man
      // is half a metre wide: step it in pieces or it passes straight through
      // him between one frame and the next.
      const steps = Math.max(1, Math.ceil((b.vel.length() * dt) / 0.2));
      const h = dt / steps;
      for (let k = 0; k < steps && !b.landed; k++) {
        b.vel.y -= GRAVITY * h;
        const p = b.mesh.position;
        const nx = p.x + b.vel.x * h;
        const ny = p.y + b.vel.y * h;
        const nz = p.z + b.vel.z * h;

        // Somebody in the way?
        if (!b.spent) {
          for (const t of targets) {
            const dx = nx - t.x;
            const dz = nz - t.z;
            if (dx * dx + dz * dz > 0.16) continue;
            if (ny < t.y + 0.1 || ny > t.y + t.height + 0.1) continue;
            b.spent = true;
            if (t.hit()) onHit(t);
            // It drops at his feet rather than passing through him.
            b.vel.set(b.vel.x * 0.05, 1.0, b.vel.z * 0.05);
            break;
          }
        }

        // Walls.
        if (world.blocked(nx, ny, nz)) {
          // Bounce off whichever axis actually moved into something.
          if (world.blocked(nx, p.y, p.z)) b.vel.x *= -0.3;
          if (world.blocked(p.x, p.y, nz)) b.vel.z *= -0.3;
          if (world.blocked(p.x, ny, p.z)) b.vel.y *= -0.3;
          b.vel.multiplyScalar(0.5);
          // A ricochet is harmless. It would otherwise be a way to shoot
          // round corners, by accident, about once a night.
          b.spent = true;
        } else {
          p.set(nx, ny, nz);
        }

        // Floor.
        const g = world.groundAt(p.x, p.z, p.y + 0.4);
        if (p.y <= g + 0.04) {
          p.y = g + 0.04;
          b.spent = true;
          if (Math.abs(b.vel.y) > 1.2) {
            b.vel.y = Math.abs(b.vel.y) * 0.3;
            b.vel.x *= 0.5;
            b.vel.z *= 0.5;
          } else {
            b.landed = true;
            b.life = Math.min(b.life, 1.2);
          }
        }
      }
    }
  }

  return {
    group,
    hurl,
    update,
    clear() {
      for (const b of live) group.remove(b.mesh);
      live.length = 0;
    },
    dispose() {
      for (const b of live) group.remove(b.mesh);
      live.length = 0;
      for (const o of owned) o.dispose();
      group.parent?.remove(group);
    },
  };
}
