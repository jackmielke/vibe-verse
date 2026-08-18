/**
 * life.ts — the things that move on their own.
 *
 * Two hundred cars on the street grid and a dozen boats on the bay, and they
 * are here for one reason: a city with nothing moving in it reads as a model
 * of a city. You notice it immediately and you cannot say why — the buildings
 * are right, the streets are right, the hills are right, and the whole thing
 * still looks like something under glass. Motion is what tells the eye a place
 * is inhabited, and it turns out to take remarkably little of it.
 *
 * Everything here is deliberately dumb:
 *
 *  - **A car drives in a straight line until it runs out of road.** No
 *    junctions, no turning, no traffic lights, no avoiding each other. The
 *    streets are straight by construction, so a car pointed down one stays on
 *    it for a kilometre, and when it reaches water or the edge of the map it is
 *    quietly reseeded somewhere else. From a jetpack — which is where you will
 *    see them from — a car that never turns is indistinguishable from one that
 *    does, and a junction system would be a hundred times the code to buy a
 *    detail nobody can see.
 *  - **Nothing collides with anything.** Not with each other, not with the
 *    player. Cars pass through each other perhaps twice a minute and the
 *    alternative is a broadphase over two hundred moving boxes every frame, for
 *    a world where the interesting collisions are all with buildings.
 *  - **Two instanced meshes, two draw calls.** Same discipline as `play.ts`.
 *
 * The one thing that is not dumb is which side of the road they drive on: a
 * lane offset to the right of the centreline. Cars sharing one line down the
 * middle of the street is the single detail that gives the whole illusion away.
 */
import * as THREE from "three";
import { makeRng, type Rng } from "@/shared/proc/rng";
import { Batch, rgb, shade } from "./batch";
import { toon } from "./look";
import { BOUNDS, isOpen, isRoad, isSidewalk, isWater, roadAt, shoreSDF, stopLineAhead, walkHeight } from "./map";
import type { SignalHead } from "./street";

/** Body colours. Muted, because a street of primary-coloured cars reads as a toy shop. */
const CAR_PAINT = [
  0xd9534f, 0x4a6fa5, 0xe8c05a, 0xe8e4dc, 0x4f5b66,
  0x6fa07a, 0xcf7f4a, 0x8e6fa8, 0xd8d3c6, 0x3f4a58,
] as const;

/** Coats. Muted and various, which is what a pavement looks like from above. */
const COAT = [
  0x3c4250, 0x8a4f42, 0x4a6a8a, 0xd8d3c6, 0x5f7a5c,
  0x9a6f8a, 0xc4a15a, 0x2f3540, 0xb4675a, 0x6f6f78,
] as const;

const CAR_COUNT = 190;
const BOAT_COUNT = 15;
/* Two hundred and forty people, which sounds like a lot and is nowhere near
   enough for a downtown — and that is fine. A pavement with one person on it
   every forty metres reads as populated; a pavement with the real density reads
   as a crowd simulation, costs twenty times as much, and invites you to notice
   that none of them avoid each other.

   They are clustered on downtown rather than spread evenly, which is both
   cheaper and truer: a fixed number spread over 3.4 by 4.4 km put one person
   every hundred and fifty metres, so Market Street — where you start, and the
   busiest pavement in the city — had about four people on it. */
const WALKER_COUNT = 900;

/* ------------------------------------------------------------------ *
 * Signals
 *
 * One clock for the whole city. Every junction on the grid's local-Z axis goes
 * green together, then every junction on local X, with an all-red beat between
 * them. That sounds like a simplification and is very nearly what a real
 * rectangular grid does: synchronised phases are how you get a green wave down
 * a one-way street, and San Francisco runs them.
 *
 * The payoff is out of all proportion to the code. Cars that queue at a red and
 * pull away together is the thing that makes traffic look like traffic — much
 * more than the cars themselves do. Before this they drove at a constant speed
 * through every junction and through each other, and from the pavement it read
 * as a conveyor belt.
 * ------------------------------------------------------------------ */

/** Seconds for both phases plus both all-red beats. */
const SIGNAL_CYCLE = 28;
/** The all-red beat at the end of each phase. */
const ALL_RED = 2.5;

/** Which axis has a green right now, or -1 during the all-red. */
export function greenAxis(elapsed: number): 0 | 1 | -1 {
  const half = SIGNAL_CYCLE / 2;
  const t = ((elapsed % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  if (t < half - ALL_RED) return 1;
  if (t < half) return -1;
  if (t < SIGNAL_CYCLE - ALL_RED) return 0;
  return -1;
}

/** How hard a car accelerates and brakes, m/s². Braking is the harder of the two. */
const ACCEL = 3.4;
const BRAKE = 7.5;
/** Start braking for a red from here. */
const SIGHT = 30;
/** Cell size for the who-is-in-front-of-me hash. Two car lengths and a bit. */
const CELL = 12;

interface Car {
  x: number;
  z: number;
  dx: number;
  dz: number;
  /** Metres per second right now — braked, queued, or up to `cruise`. */
  speed: number;
  /** What it would do on an empty green street. */
  cruise: number;
  /** Metres left before this one gives up and reseeds — a fuse, not a plan. */
  life: number;
}

interface Walker {
  x: number;
  z: number;
  dx: number;
  dz: number;
  speed: number;
  /** Stride phase, so a pavement is not a chorus line. */
  phase: number;
  /** Metres before this one turns round or is reseeded. */
  life: number;
}

interface Boat {
  x: number;
  z: number;
  dx: number;
  dz: number;
  speed: number;
  /** Wake bob phase. */
  phase: number;
}

/** One car, as geometry: a body, a cabin, and four dark wheels. */
function carGeometry(): THREE.BufferGeometry {
  const b = new Batch();
  const body = rgb(0xffffff); // Tinted per instance; white is the identity.
  const glass = rgb(0x9fc9dd);
  const tyre = rgb(0x2a2a2e);
  b.box(0, 0.35, 0, 1.0, 0.62, 2.25, body);
  b.box(0, 0.97, -0.15, 0.86, 0.5, 1.15, shade(glass, 1.0));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(sx * 0.94, 0.3, sz * 1.5, 0.12, 0.3, 0.3, tyre);
    }
  }
  const geo = b.finish();
  if (!geo) throw new Error("car geometry is empty");
  return geo;
}

/**
 * One person: a body, a head, and two legs that do not move.
 *
 * The legs do not move because at the range you see them from, the *bob* is
 * the animation. A walk cycle on a 1.7 m figure sixty metres away is four
 * pixels of leg travelling behind four pixels of other leg, and it costs a
 * skinned mesh per person. Vertical bob at stride frequency, plus a slight
 * lean, reads as walking from every distance this world ever shows them at.
 */
function walkerGeometry(): THREE.BufferGeometry {
  const b = new Batch();
  const body = rgb(0xffffff); // Tinted per instance.
  const skin = rgb(0xd8ad8a);
  const legs = rgb(0x3c4250);
  b.box(0, 0.42, 0, 0.16, 0.42, 0.14, legs);
  b.box(0, 0.84, 0, 0.22, 0.5, 0.16, body);
  b.box(0, 1.34, 0, 0.13, 0.19, 0.13, skin);
  const geo = b.finish();
  if (!geo) throw new Error("walker geometry is empty");
  return geo;
}

/** One boat: a hull that comes to a point, a cabin, and a mast. */
function boatGeometry(): THREE.BufferGeometry {
  const b = new Batch();
  const hull = rgb(0xffffff);
  const deck = rgb(0xe8e2d4);
  const mast = rgb(0xb9b2a2);
  b.box(0, 0.6, 0, 2.2, 1.2, 6.5, hull);
  b.gable(0, 1.2, -4.2, 2.2, 1.4, 2.0, shade(hull, 0.94), Math.PI / 2);
  b.box(0, 1.2, 1.2, 1.5, 1.5, 2.4, deck);
  b.cylinder(0, 2.7, 1.2, 0.14, 0.1, 5.5, 5, mast, false);
  const geo = b.finish();
  if (!geo) throw new Error("boat geometry is empty");
  return geo;
}

/** Find somewhere on the road network, pointed along it, on the right-hand side. */
function seedCar(rng: Rng, car: Car): void {
  for (let tries = 0; tries < 60; tries++) {
    const x = rng.range(BOUNDS.minX + 60, BOUNDS.maxX - 60);
    const z = rng.range(BOUNDS.minZ + 60, BOUNDS.maxZ - 60);
    // `isOpen` as well as `isRoad`: the grid runs straight through Union
    // Square and the plaza is drawn on top of it, so traffic seeded on the
    // road alone drives across the paving.
    if (isWater(x, z) || !isRoad(x, z) || isOpen(x, z)) continue;
    const r = roadAt(x, z);
    // Half the traffic goes the other way; both use the right-hand lane.
    const s = rng.chance(0.5) ? 1 : -1;
    const dx = r.dir.x * s;
    const dz = r.dir.z * s;
    // Right of travel is (dz, -dx). A lane is about half the half-width out.
    const lane = r.halfWidth * 0.48;
    car.x = x + dz * lane;
    car.z = z - dx * lane;
    car.dx = dx;
    car.dz = dz;
    car.cruise = rng.range(8, 15);
    // Pull away from a standstill rather than materialising at speed — a car
    // that appears already doing 15 m/s reads as a pop-in, which is the exact
    // family of glitch this world exists to not have.
    car.speed = car.cruise * 0.35;
    car.life = rng.range(180, 900);
    return;
  }
  // Nowhere on the road after sixty tries: park it under the map rather than
  // leaving a car sitting in the bay.
  car.x = 0;
  car.z = 0;
  car.dx = 1;
  car.dz = 0;
  car.speed = 0;
  car.cruise = 0;
  car.life = 1;
}

/** Put a person on a pavement, facing along it. */
function seedWalker(rng: Rng, w: Walker): void {
  for (let tries = 0; tries < 70; tries++) {
    /* Two thirds gaussian about the middle of downtown, one third spread over
       the whole map. Purely gaussian was the first version and it left the
       Mission, Hayes Valley and the avenues completely deserted — which is
       fine from a jetpack and wrong the moment somebody spawns down there and
       walks a block without passing a single person. The clustering is still
       most of the distribution, because Market Street with four people on it
       was the bug the gaussian fixed. */
    const wide = rng.chance(0.34);
    const x = Math.max(BOUNDS.minX + 40, Math.min(BOUNDS.maxX - 40,
      wide ? rng.range(BOUNDS.minX, BOUNDS.maxX) : rng.gauss() * 620 - 120));
    const z = Math.max(BOUNDS.minZ + 40, Math.min(BOUNDS.maxZ - 40,
      wide ? rng.range(BOUNDS.minZ, BOUNDS.maxZ) : rng.gauss() * 660 - 120));
    if (isWater(x, z) || !isSidewalk(x, z)) continue;
    const r = roadAt(x, z);
    const s = rng.chance(0.5) ? 1 : -1;
    w.x = x;
    w.z = z;
    w.dx = r.dir.x * s;
    w.dz = r.dir.z * s;
    w.speed = rng.range(1.1, 1.9);
    w.phase = rng.next() * Math.PI * 2;
    w.life = rng.range(40, 260);
    return;
  }
  w.speed = 0;
  w.life = 1;
}

function seedBoat(rng: Rng, boat: Boat): void {
  for (let tries = 0; tries < 80; tries++) {
    const x = rng.range(BOUNDS.minX, BOUNDS.maxX);
    const z = rng.range(BOUNDS.minZ, BOUNDS.maxZ);
    // Well out — a boat that spawns two metres off the seawall looks aground.
    if (!isWater(x, z) || shoreSDF(x, z) > -90) continue;
    const a = rng.range(0, Math.PI * 2);
    boat.x = x;
    boat.z = z;
    boat.dx = Math.cos(a);
    boat.dz = Math.sin(a);
    boat.speed = rng.range(2.5, 6);
    boat.phase = rng.next() * Math.PI * 2;
    return;
  }
  boat.speed = 0;
}

/** A 12 m cell, packed into one integer so the map key needs no string. */
function cellKey(x: number, z: number): number {
  return (Math.floor(x / CELL) + 4096) * 8192 + (Math.floor(z / CELL) + 4096);
}

export class CityLife {
  readonly group = new THREE.Group();

  private cars: Car[] = [];
  private boats: Boat[] = [];
  private walkers: Walker[] = [];
  private carMesh: THREE.InstancedMesh;
  private boatMesh: THREE.InstancedMesh;
  private walkerMesh: THREE.InstancedMesh;
  private carGeo: THREE.BufferGeometry;
  private boatGeo: THREE.BufferGeometry;
  private walkerGeo: THREE.BufferGeometry;
  private rng: Rng;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private zero = new THREE.Vector3(0, 0, 0);
  private density = 1;
  /** Cars by 12 m cell, rebuilt each frame. See `gapAhead`. */
  private cells = new Map<number, number[]>();
  /** The lit lenses, four meshes: red and green, for each of the two axes. */
  private lenses: THREE.InstancedMesh[] = [];
  private lensGeo: THREE.BufferGeometry | null = null;
  private lensMats: THREE.Material[] = [];
  private lastGreen: 0 | 1 | -1 = -1;

  constructor() {
    this.group.name = "frisco-life";
    this.rng = makeRng("frisco-life-v1");

    this.carGeo = carGeometry();
    this.carMesh = new THREE.InstancedMesh(
      this.carGeo,
      toon(0xffffff, { vertexColors: true }),
      CAR_COUNT,
    );
    this.carMesh.name = "frisco-cars";
    this.carMesh.frustumCulled = false;
    this.carMesh.castShadow = true;
    this.group.add(this.carMesh);

    this.boatGeo = boatGeometry();
    this.boatMesh = new THREE.InstancedMesh(
      this.boatGeo,
      toon(0xffffff, { vertexColors: true }),
      BOAT_COUNT,
    );
    this.boatMesh.name = "frisco-boats";
    this.boatMesh.frustumCulled = false;
    this.group.add(this.boatMesh);

    this.walkerGeo = walkerGeometry();
    this.walkerMesh = new THREE.InstancedMesh(
      this.walkerGeo,
      toon(0xffffff, { vertexColors: true }),
      WALKER_COUNT,
    );
    this.walkerMesh.name = "frisco-walkers";
    this.walkerMesh.frustumCulled = false;
    this.walkerMesh.castShadow = true;
    this.group.add(this.walkerMesh);

    const paint = new THREE.Color();
    for (let i = 0; i < CAR_COUNT; i++) {
      const car: Car = { x: 0, z: 0, dx: 1, dz: 0, speed: 0, cruise: 0, life: 0 };
      seedCar(this.rng, car);
      this.cars.push(car);
      paint.setHex(CAR_PAINT[this.rng.int(0, CAR_PAINT.length - 1)]);
      this.carMesh.setColorAt(i, paint);
    }
    if (this.carMesh.instanceColor) this.carMesh.instanceColor.needsUpdate = true;

    for (let i = 0; i < BOAT_COUNT; i++) {
      const boat: Boat = { x: 0, z: 0, dx: 1, dz: 0, speed: 0, phase: 0 };
      seedBoat(this.rng, boat);
      this.boats.push(boat);
      paint.setHex(this.rng.chance(0.5) ? 0xf2efe6 : 0xd9d2c2);
      this.boatMesh.setColorAt(i, paint);
    }
    if (this.boatMesh.instanceColor) this.boatMesh.instanceColor.needsUpdate = true;

    for (let i = 0; i < WALKER_COUNT; i++) {
      const w: Walker = { x: 0, z: 0, dx: 1, dz: 0, speed: 0, phase: 0, life: 0 };
      seedWalker(this.rng, w);
      this.walkers.push(w);
      paint.setHex(COAT[this.rng.int(0, COAT.length - 1)]);
      this.walkerMesh.setColorAt(i, paint);
    }
    if (this.walkerMesh.instanceColor) this.walkerMesh.instanceColor.needsUpdate = true;
  }

  update(dt: number, elapsed: number): void {
    const carCut = Math.ceil(this.cars.length * this.density);
    const green = greenAxis(elapsed);
    this.rehashCars(carCut);
    this.setSignalPhase(green);
    for (let i = 0; i < this.cars.length; i++) {
      if (i >= carCut) {
        this.m.compose(this.v.set(0, -500, 0), this.q.identity(), this.zero);
        this.carMesh.setMatrixAt(i, this.m);
        continue;
      }
      const c = this.cars[i];

      /* ---- what this car would like to be doing ---- */
      let want = c.cruise;

      // A red light ahead. `stopLineAhead` is a modulo over the grid, so this
      // costs the same whether there are two cars or two hundred — no road
      // network, no junction objects, no queue lists.
      const stop = stopLineAhead(c.x, c.z, c.dx, c.dz);
      if (green !== stop.axis && stop.distance > -2 && stop.distance < SIGHT) {
        // Ease down so the car arrives AT the line rather than braking to a
        // halt wherever it happened to notice. Cars that all brake at the same
        // distance and stop short of the junction look like they hit a wall.
        want = Math.min(want, Math.max(0, stop.distance * 0.55));
      }

      // The car in front. Only the two cells it could be in are searched, so
      // this is a handful of comparisons rather than a broadphase over 190.
      const gap = this.gapAhead(i, c);
      if (gap < 14) want = Math.min(want, Math.max(0, (gap - 6.5) * 1.5));

      const d = want - c.speed;
      c.speed += d > 0 ? Math.min(d, ACCEL * dt) : Math.max(d, -BRAKE * dt);
      if (c.speed < 0) c.speed = 0;

      c.x += c.dx * c.speed * dt;
      c.z += c.dz * c.speed * dt;
      c.life -= c.speed * dt;
      /* Reseed when the road runs out. Checking `isRoad` every frame is the
         cheap version of a road network — it is a pure function of position,
         so "am I still on a street" costs the same as asking where the nearest
         one is, and a car that drifts off the grid at a wedge junction gets
         picked up within a frame. */
      if (
        (c.life <= 0 && c.speed > 0.1) ||
        c.x < BOUNDS.minX + 20 || c.x > BOUNDS.maxX - 20 ||
        c.z < BOUNDS.minZ + 20 || c.z > BOUNDS.maxZ - 20 ||
        !isRoad(c.x, c.z) || isWater(c.x, c.z)
      ) {
        seedCar(this.rng, c);
      }
      this.v.set(c.x, walkHeight(c.x, c.z) + 0.08, c.z);
      this.e.set(0, Math.atan2(c.dx, c.dz), 0);
      this.q.setFromEuler(this.e);
      this.m.compose(this.v, this.q, this.one);
      this.carMesh.setMatrixAt(i, this.m);
    }
    this.carMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < this.boats.length; i++) {
      const b = this.boats[i];
      b.x += b.dx * b.speed * dt;
      b.z += b.dz * b.speed * dt;
      if (
        b.speed === 0 ||
        !isWater(b.x, b.z) ||
        b.x < BOUNDS.minX || b.x > BOUNDS.maxX ||
        b.z < BOUNDS.minZ || b.z > BOUNDS.maxZ
      ) {
        seedBoat(this.rng, b);
      }
      const bob = Math.sin(elapsed * 1.1 + b.phase);
      this.v.set(b.x, BOUNDS.seaLevel + 0.1 + bob * 0.18, b.z);
      this.e.set(bob * 0.035, Math.atan2(b.dx, b.dz), bob * 0.05);
      this.q.setFromEuler(this.e);
      this.m.compose(this.v, this.q, this.one);
      this.boatMesh.setMatrixAt(i, this.m);
    }
    this.boatMesh.instanceMatrix.needsUpdate = true;

    const walkCut = Math.ceil(this.walkers.length * this.density);
    for (let i = 0; i < this.walkers.length; i++) {
      if (i >= walkCut) {
        this.m.compose(this.v.set(0, -500, 0), this.q.identity(), this.zero);
        this.walkerMesh.setMatrixAt(i, this.m);
        continue;
      }
      const w = this.walkers[i];
      if (w.speed > 0) {
        w.x += w.dx * w.speed * dt;
        w.z += w.dz * w.speed * dt;
        w.life -= w.speed * dt;
      }
      /* Turn round at the end of the block rather than being reseeded, so a
         street you are standing on does not keep blinking people out of
         existence three metres away. Only a walker who has actually left the
         pavement — a corner, a driveway, the water — gets a new home. */
      if (w.life <= 0 && w.speed > 0) {
        w.dx = -w.dx;
        w.dz = -w.dz;
        w.life = 40 + (i % 7) * 24;
      }
      if (w.speed === 0 || !isSidewalk(w.x, w.z) || isWater(w.x, w.z)) {
        seedWalker(this.rng, w);
      }
      const bob = Math.sin(elapsed * w.speed * 3.4 + w.phase);
      this.v.set(w.x, walkHeight(w.x, w.z) + 0.16 + Math.abs(bob) * 0.055, w.z);
      this.e.set(bob * 0.06, Math.atan2(w.dx, w.dz), bob * 0.045);
      this.q.setFromEuler(this.e);
      this.m.compose(this.v, this.q, this.one);
      this.walkerMesh.setMatrixAt(i, this.m);
    }
    this.walkerMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Hang the lit lenses on the signals the city built.
   *
   * Four instanced meshes and nothing else: red-for-axis-0, green-for-axis-0,
   * and the same pair for axis 1. Every matrix is written once, here, and each
   * frame costs four boolean assignments. The obvious implementation — one mesh
   * and rewrite the colours each frame — is a buffer upload per frame for a
   * thing that only ever has four states.
   */
  mountSignals(signals: SignalHead[]): void {
    if (!signals.length) return;
    const b = new Batch();
    // A lens, drawn as a flat box facing the traffic. Unshaded, so it reads as
    // a light at midnight and at noon — a toon-shaded traffic light goes dark
    // on the side away from the sun, which is exactly backwards.
    b.box(0, -0.11, 0, 0.15, 0.22, 0.08, rgb(0xffffff));
    const geo = b.finish();
    if (!geo) return;
    this.lensGeo = geo;

    for (const axis of [0, 1] as const) {
      const heads = signals.filter((h) => h.axis === axis);
      for (const [colour, high] of [
        [0xff5a46, true],
        [0x5cff86, false],
      ] as const) {
        const mat = new THREE.MeshBasicMaterial({ color: colour });
        this.lensMats.push(mat);
        const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, heads.length));
        mesh.name = `frisco-signal-${axis}-${high ? "red" : "green"}`;
        mesh.frustumCulled = false;
        mesh.count = heads.length;
        for (let i = 0; i < heads.length; i++) {
          const h = heads[i];
          this.e.set(0, h.yaw, 0);
          this.q.setFromEuler(this.e);
          this.v.set(h.x, high ? h.redY : h.greenY, h.z);
          this.m.compose(this.v, this.q, this.one);
          mesh.setMatrixAt(i, this.m);
        }
        mesh.instanceMatrix.needsUpdate = true;
        this.lenses.push(mesh);
        this.group.add(mesh);
      }
    }
  }

  /** Order in `lenses` is [a0-red, a0-green, a1-red, a1-green]. */
  private setSignalPhase(green: 0 | 1 | -1): void {
    this.lastGreen = green;
    if (this.lenses.length !== 4) return;
    this.lenses[0].visible = green !== 0;
    this.lenses[1].visible = green === 0;
    this.lenses[2].visible = green !== 1;
    this.lenses[3].visible = green === 1;
  }

  /** Bucket the live cars into 12 m cells so `gapAhead` can look in two of them. */
  private rehashCars(cut: number): void {
    this.cells.clear();
    for (let i = 0; i < cut && i < this.cars.length; i++) {
      const c = this.cars[i];
      const k = cellKey(c.x, c.z);
      const list = this.cells.get(k);
      if (list) list.push(i);
      else this.cells.set(k, [i]);
    }
  }

  /**
   * Distance to the nearest car directly in front of this one, or Infinity.
   *
   * "Directly in front" is: ahead along the direction of travel, within 2.4 m
   * laterally, and pointed roughly the same way. The lateral test is what keeps
   * a car from braking for oncoming traffic in the other lane two metres away,
   * which was the first version and made every street gridlock instantly.
   */
  private gapAhead(self: number, c: Car): number {
    let best = Infinity;
    // Own cell and the one 12 m ahead: a car further than that is further than
    // the following model cares about anyway.
    for (const [ox, oz] of [[0, 0], [c.dx * CELL, c.dz * CELL]] as const) {
      const list = this.cells.get(cellKey(c.x + ox, c.z + oz));
      if (!list) continue;
      for (const j of list) {
        if (j === self) continue;
        const o = this.cars[j];
        if (c.dx * o.dx + c.dz * o.dz < 0.55) continue;
        const rx = o.x - c.x;
        const rz = o.z - c.z;
        const fwd = rx * c.dx + rz * c.dz;
        if (fwd <= 0) continue;
        const side = Math.abs(rx * c.dz - rz * c.dx);
        if (side > 2.4) continue;
        if (fwd < best) best = fwd;
      }
    }
    return best;
  }

  /**
   * Thin the crowd and the traffic without rebuilding anything.
   *
   * `density` of 0.4 keeps the first 40% of each list and scales the rest to
   * nothing — no geometry is freed and no buffer is rebuilt, which is the whole
   * point: this runs while somebody is playing, in response to a frame rate,
   * and a hitch is exactly what it is trying to avoid. The skipped instances
   * also stop being simulated, which is where most of the saving actually is:
   * `isSidewalk` on nine hundred walkers is more work than drawing them.
   */
  setDensity(density: number): void {
    this.density = Math.max(0.15, Math.min(1, density));
  }

  /**
   * What the traffic is doing right now: the phase, and how many cars are
   * moving versus sitting at a light. The one number that says whether any of
   * the signal work is actually running — a city where `stopped` is always
   * zero has signals that nothing obeys, and a city where it never returns to
   * zero has gridlocked, and neither is visible in a screenshot.
   */
  traffic(): { green: number; moving: number; stopped: number } {
    const cut = Math.ceil(this.cars.length * this.density);
    let moving = 0;
    let stopped = 0;
    for (let i = 0; i < cut && i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.cruise <= 0) continue;
      if (c.speed < 0.5) stopped++;
      else moving++;
    }
    return { green: this.lastGreen, moving, stopped };
  }

  /** How many of each are actually placed and moving. */
  stats(): { cars: number; boats: number; walkers: number; density: number } {
    // What is actually DRAWN, which is the density cut applied to what is
    // actually placed. Reporting the placed count while half of them are
    // scaled to zero is how a quality system becomes invisible.
    const live = (n: number) => Math.ceil(n * this.density);
    return {
      cars: live(this.cars.filter((c) => c.cruise > 0).length),
      boats: this.boats.filter((b) => b.speed > 0).length,
      walkers: live(this.walkers.filter((w) => w.speed > 0).length),
      density: this.density,
    };
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.lenses) m.dispose();
    for (const m of this.lensMats) m.dispose();
    this.lensGeo?.dispose();
    this.carGeo.dispose();
    this.boatGeo.dispose();
    this.walkerGeo.dispose();
    this.carMesh.dispose();
    this.boatMesh.dispose();
    this.walkerMesh.dispose();
  }
}
