/**
 * Bricks. Infinite bricks.
 *
 * This is the roof of the brownstone in *Lost in New York*, imported wholesale
 * into Winnetka, and it earns its place because it is the one thing in the
 * whole film that is pure uncomplicated wish fulfilment: no setup, no clock,
 * no plan — just a boy with a brick and a man who deserves it.
 *
 * Three decisions make it feel good rather than fiddly.
 *
 * **It is a real projectile.** It arcs, it spins, it bounces off the floor and
 * skitters, it thumps off a wall. A hitscan brick would be easier and would
 * feel like nothing; the half-second the brick is in the air, while you watch
 * to see whether you led him enough, *is* the mechanic.
 *
 * **It aims itself, a bit.** There is no crosshair on a phone and there never
 * will be, so a throw that lands anywhere near a burglar bends towards his
 * chest — see `AIM_CONE`. Aim assist is usually a smell; here it is the
 * difference between a toy that works with a thumb and one that does not.
 *
 * **There are infinitely many.** Kevin's supply is not a resource to manage.
 * The moment you make somebody count bricks they stop throwing them, and the
 * entire point of this feature is that you throw one at Marv because you can.
 */
import * as THREE from "three";
import * as T from "./textures";

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
const GRAVITY = 15.5;
const MAX_LIVE = 24;

interface Brick {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  /** Seconds left before it fades. Bricks on the floor are set dressing. */
  life: number;
  landed: boolean;
  /** A brick cannot hit the same man twice on one flight. */
  spent: boolean;
}

export interface BrickRig {
  group: THREE.Group;
  /** Throw from a point along a direction. Returns the brick's initial speed. */
  hurl(from: THREE.Vector3, dir: THREE.Vector3, targets: BrickTarget[]): void;
  update(dt: number, world: BrickWorld, targets: BrickTarget[], onHit: (t: BrickTarget) => void): void;
  clear(): void;
  dispose(): void;
}

export function makeBricks(parent: THREE.Object3D): BrickRig {
  const owned: Array<{ dispose(): void }> = [];
  const group = new THREE.Group();
  parent.add(group);

  const geo = new THREE.BoxGeometry(0.21, 0.09, 0.1);
  owned.push(geo);
  const tex = T.brick().clone();
  tex.needsUpdate = true;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // One brick should be one brick, not a wall of them shrunk down.
  tex.repeat.set(0.17, 0.06);
  owned.push(tex);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, color: 0xd8b0a0 });
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
    const speed = 11.5;

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
      // A free throw gets a little loft, so it arcs rather than dribbling.
      aim.y += 0.14;
      aim.normalize();
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(from);
    mesh.castShadow = true;
    group.add(mesh);
    live.push({
      mesh,
      vel: aim.multiplyScalar(speed),
      spin: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, 12 + Math.random() * 8),
      life: 9,
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
        // Lying on the floor. Fade the last second so it does not blink out.
        if (b.life < 1) b.mesh.scale.setScalar(Math.max(0.01, b.life));
        continue;
      }

      b.vel.y -= GRAVITY * dt;
      const p = b.mesh.position;
      const nx = p.x + b.vel.x * dt;
      const ny = p.y + b.vel.y * dt;
      const nz = p.z + b.vel.z * dt;

      // Somebody in the way?
      if (!b.spent) {
        for (const t of targets) {
          const dx = nx - t.x;
          const dz = nz - t.z;
          if (dx * dx + dz * dz > 0.19) continue;
          if (ny < t.y + 0.15 || ny > t.y + t.height + 0.1) continue;
          b.spent = true;
          if (t.hit()) onHit(t);
          // It drops at his feet rather than passing through him.
          b.vel.set(b.vel.x * 0.12, 1.2, b.vel.z * 0.12);
          break;
        }
      }

      // Walls.
      if (world.blocked(nx, ny, nz)) {
        // Bounce off whichever axis actually moved into something.
        if (world.blocked(nx, p.y, p.z)) b.vel.x *= -0.35;
        if (world.blocked(p.x, p.y, nz)) b.vel.z *= -0.35;
        if (world.blocked(p.x, ny, p.z)) b.vel.y *= -0.3;
        b.vel.multiplyScalar(0.7);
        b.spin.multiplyScalar(0.5);
      } else {
        p.set(nx, ny, nz);
      }

      // Floor.
      const g = world.groundAt(p.x, p.z, p.y + 0.4);
      if (p.y <= g + 0.05) {
        p.y = g + 0.05;
        if (Math.abs(b.vel.y) > 1.6) {
          // A real bounce, then it settles.
          b.vel.y = Math.abs(b.vel.y) * 0.28;
          b.vel.x *= 0.55;
          b.vel.z *= 0.55;
          b.spin.multiplyScalar(0.4);
        } else {
          b.landed = true;
          b.life = Math.min(b.life, 5);
          b.mesh.rotation.set(0, b.mesh.rotation.y, 0);
          continue;
        }
      }

      b.mesh.rotation.x += b.spin.x * dt;
      b.mesh.rotation.y += b.spin.y * dt;
      b.mesh.rotation.z += b.spin.z * dt;
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
