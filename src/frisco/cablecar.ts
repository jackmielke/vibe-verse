/**
 * cablecar.ts — the Powell line, and the only thing in this world you can ride.
 *
 * Two cars run a fixed track from Market Street over Nob Hill to the wharf,
 * back and forth, forever. They are the one piece of the city that is neither
 * scenery nor a collectible: you can stand on the running board and be carried,
 * which is a different verb from anything else here and is most of the reason
 * they exist.
 *
 * Three things make that work and each was a decision:
 *
 * **The car is a dynamic collider.** `CityCollision` is a uniform grid built
 * once from nine thousand static boxes; a moving box in a grid means removing
 * and re-inserting it every frame. Instead the collision system keeps a short
 * `dynamic` list scanned linearly on every query. At two entries that is free
 * and it cannot go stale.
 *
 * **Carrying is a delta, not a parent.** Re-parenting the player to the car is
 * the obvious approach and it fights everything: the camera rig, the collision
 * resolve, the ground query, all of which work in world space. Instead, if the
 * player is standing on a car this frame, the car's own movement since last
 * frame is added to their position. Two lines, and walking about on the deck
 * while it moves works for free.
 *
 * **The track is snapped to the streets.** The waypoints are the real corners
 * of the Powell line, and each is pulled onto the nearest asphalt, so the rails
 * lie in the road on a generated grid that has never heard of Powell Street.
 */
import * as THREE from "three";
import { Batch, rgb, shade } from "./batch";
import type { BuildingBox } from "./city";
import type { CityCollision } from "./collision";
import { COLORS, toon } from "./look";
import { ll, snapToStreet, walkHeight, type Vec2 } from "./map";

/**
 * The Powell–Hyde line, corner by corner, from the turnaround at Market up
 * over Nob Hill and down to the water.
 */
const LINE: Array<[number, number]> = [
  [37.7855, -122.408],
  [37.7889, -122.4085],
  [37.792, -122.409],
  [37.7952, -122.4096],
  [37.7985, -122.4104],
  [37.802, -122.4113],
  [37.8052, -122.4124],
];

const CAR_HALF_LEN = 4.4;
const CAR_HALF_WIDTH = 1.35;
const DECK_HEIGHT = 1.05;
const SPEED = 7.5;

interface Car {
  /** Distance along the track, metres. */
  s: number;
  dir: 1 | -1;
  group: THREE.Group;
  box: BuildingBox;
  prev: THREE.Vector3;
}

export interface CableCarLine {
  group: THREE.Group;
  /** Lay the rails into a static batch. Called once, during the city build. */
  update(dt: number): void;
  /** Move the player if they are riding. Returns true if they were carried. */
  carry(position: THREE.Vector3): boolean;
  dispose(): void;
}

/** The track, as a polyline on the streets, plus its cumulative arc length. */
function track(): { points: Vec2[]; cum: number[] } {
  const points = LINE.map(([la, lo]) => {
    const p = ll(la, lo);
    return snapToStreet(p.x, p.z);
  });
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  return { points, cum };
}

/** Where along the track, and which way it is pointing. */
function at(points: Vec2[], cum: number[], s: number): { x: number; z: number; yaw: number } {
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, s));
  let seg = 1;
  while (seg < cum.length - 1 && cum[seg] < d) seg++;
  const a = points[seg - 1];
  const b = points[seg];
  const span = cum[seg] - cum[seg - 1] || 1;
  const f = (d - cum[seg - 1]) / span;
  return {
    x: a.x + (b.x - a.x) * f,
    z: a.z + (b.z - a.z) * f,
    yaw: Math.atan2(b.z - a.z, b.x - a.x),
  };
}

/** One car: cream body, red trim, an open front, a roof and a grip pole. */
function carMesh(): THREE.Group {
  const b = new Batch();
  const cream = rgb(0xf0e6cf);
  const maroon = rgb(0xa8332b);
  const roof = rgb(0xd8cdb4);
  const metal = rgb(COLORS.metal);
  const glass = rgb(0x9fc9dd);

  // Underframe and deck.
  b.box(0, 0.35, 0, CAR_HALF_LEN, 0.34, CAR_HALF_WIDTH, shade(maroon, 0.8));
  b.box(0, 0.69, 0, CAR_HALF_LEN, 0.36, CAR_HALF_WIDTH, shade(cream, 0.92));
  // The closed rear half, glazed.
  b.bandedBox(-2.0, DECK_HEIGHT, 0, 2.3, 2.1, CAR_HALF_WIDTH * 0.92, cream, glass, 3);
  // The open front: a maroon dash and four corner posts holding the roof up.
  b.box(3.9, DECK_HEIGHT, 0, 0.4, 1.0, CAR_HALF_WIDTH * 0.92, maroon);
  for (const sx of [0.4, 2.2, 3.9]) {
    for (const sz of [-1, 1]) {
      b.box(sx, DECK_HEIGHT, sz * CAR_HALF_WIDTH * 0.86, 0.09, 2.1, 0.09, maroon);
    }
  }
  // The roof, overhanging both ends the way the real ones do.
  b.box(0, DECK_HEIGHT + 2.1, 0, CAR_HALF_LEN * 1.02, 0.16, CAR_HALF_WIDTH * 1.12, roof);
  // The grip lever, which is the single most recognisable thing about them.
  b.box(2.6, DECK_HEIGHT + 0.9, 0, 0.07, 1.0, 0.07, metal);
  // Wheels.
  for (const sx of [-2.8, 2.8]) {
    for (const sz of [-1, 1]) {
      b.box(sx, 0.16, sz * CAR_HALF_WIDTH * 0.82, 0.3, 0.19, 0.12, rgb(0x33383f));
    }
  }

  const geo = b.finish();
  const g = new THREE.Group();
  if (geo) {
    const mesh = new THREE.Mesh(geo, toon(0xffffff, { vertexColors: true, glow: true }));
    mesh.name = "frisco-cablecar";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

/**
 * Lay the rails and the slot between them into a batch. Static geometry, so
 * this goes into the city build rather than into the per-frame group.
 */
export function buildCableTrack(pick: (x: number, z: number) => Batch): void {
  const { points, cum } = track();
  const rail = rgb(0x8d8b84);
  const slot = rgb(0x3a3d44);
  const total = cum[cum.length - 1];
  const STEP = 8;
  for (let s = 0; s < total; s += STEP) {
    const p0 = at(points, cum, s);
    const p1 = at(points, cum, Math.min(total, s + STEP));
    const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    if (len < 0.5) continue;
    const mx = (p0.x + p1.x) / 2;
    const mz = (p0.z + p1.z) / 2;
    const y = (walkHeight(p0.x, p0.z) + walkHeight(p1.x, p1.z)) / 2;
    const b = pick(mx, mz);
    for (const off of [-CAR_HALF_WIDTH * 0.8, CAR_HALF_WIDTH * 0.8]) {
      b.box(
        mx - Math.sin(p0.yaw) * off, y + 0.06, mz + Math.cos(p0.yaw) * off,
        len / 2, 0.05, 0.07, rail, 1, p0.yaw,
      );
    }
    // The cable slot down the middle — the detail that says cable car rather
    // than tram, and it is one dark strip.
    b.box(mx, y + 0.05, mz, len / 2, 0.04, 0.13, slot, 1, p0.yaw);
  }
}

export function createCableCars(scene: THREE.Scene, collision: CityCollision): CableCarLine {
  const { points, cum } = track();
  const total = cum[cum.length - 1];
  const group = new THREE.Group();
  group.name = "frisco-cablecars";

  const cars: Car[] = [];
  for (let i = 0; i < 2; i++) {
    const g = carMesh();
    group.add(g);
    const box: BuildingBox = {
      x: 0, z: 0, hw: CAR_HALF_LEN, hd: CAR_HALF_WIDTH, yaw: 0,
      baseY: 0, roofY: 0,
    };
    collision.dynamic.push(box);
    cars.push({
      // Half a line apart, running opposite ways: you meet one coming down.
      s: i === 0 ? total * 0.2 : total * 0.7,
      dir: i === 0 ? 1 : -1,
      group: g,
      box,
      prev: new THREE.Vector3(),
    });
  }
  scene.add(group);

  const place = (car: Car) => {
    const p = at(points, cum, car.s);
    const y = walkHeight(p.x, p.z);
    car.group.position.set(p.x, y, p.z);
    car.group.rotation.y = -p.yaw;
    car.box.x = p.x;
    car.box.z = p.z;
    car.box.yaw = p.yaw;
    car.box.baseY = y;
    // The deck is what you stand on, not the roof: the roof is 3 m up and
    // reaching it means jumping, which is a different and worse feature.
    car.box.roofY = y + DECK_HEIGHT;
  };
  for (const car of cars) {
    place(car);
    car.prev.copy(car.group.position);
  }

  return {
    group,
    update(dt: number) {
      for (const car of cars) {
        car.prev.copy(car.group.position);
        car.s += SPEED * dt * car.dir;
        // Turn round at the ends, with a pause built in by overshooting and
        // clamping — a car that reverses instantly reads as a glitch.
        if (car.s > total) {
          car.s = total;
          car.dir = -1;
        } else if (car.s < 0) {
          car.s = 0;
          car.dir = 1;
        }
        place(car);
      }
    },
    carry(position: THREE.Vector3): boolean {
      const on = collision.standingOn(position.x, position.y, position.z);
      if (!on) return false;
      const car = cars.find((c) => c.box === on);
      if (!car) return false;
      /* The delta, not a re-parent. Everything else about the player — the
         camera rig, the collision resolve, the ground query — works in world
         space, and hanging them off a moving parent fights all three. */
      position.x += car.group.position.x - car.prev.x;
      position.z += car.group.position.z - car.prev.z;
      position.y += car.group.position.y - car.prev.y;
      return true;
    },
    dispose() {
      group.removeFromParent();
      for (const car of cars) {
        const i = collision.dynamic.indexOf(car.box);
        if (i >= 0) collision.dynamic.splice(i, 1);
        car.group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.geometry?.dispose();
        });
      }
    },
  };
}
