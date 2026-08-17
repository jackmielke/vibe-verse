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
import { BOUNDS, isRoad, isWater, roadAt, shoreSDF, walkHeight } from "./map";

/** Body colours. Muted, because a street of primary-coloured cars reads as a toy shop. */
const CAR_PAINT = [
  0xd9534f, 0x4a6fa5, 0xe8c05a, 0xe8e4dc, 0x4f5b66,
  0x6fa07a, 0xcf7f4a, 0x8e6fa8, 0xd8d3c6, 0x3f4a58,
] as const;

const CAR_COUNT = 190;
const BOAT_COUNT = 15;

interface Car {
  x: number;
  z: number;
  dx: number;
  dz: number;
  speed: number;
  /** Metres left before this one gives up and reseeds — a fuse, not a plan. */
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
    if (isWater(x, z) || !isRoad(x, z)) continue;
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
    car.speed = rng.range(7, 15);
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
  car.life = 1;
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

export class CityLife {
  readonly group = new THREE.Group();

  private cars: Car[] = [];
  private boats: Boat[] = [];
  private carMesh: THREE.InstancedMesh;
  private boatMesh: THREE.InstancedMesh;
  private carGeo: THREE.BufferGeometry;
  private boatGeo: THREE.BufferGeometry;
  private rng: Rng;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);

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

    const paint = new THREE.Color();
    for (let i = 0; i < CAR_COUNT; i++) {
      const car: Car = { x: 0, z: 0, dx: 1, dz: 0, speed: 0, life: 0 };
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
  }

  update(dt: number, elapsed: number): void {
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      c.x += c.dx * c.speed * dt;
      c.z += c.dz * c.speed * dt;
      c.life -= c.speed * dt;
      /* Reseed when the road runs out. Checking `isRoad` every frame is the
         cheap version of a road network — it is a pure function of position,
         so "am I still on a street" costs the same as asking where the nearest
         one is, and a car that drifts off the grid at a wedge junction gets
         picked up within a frame. */
      if (
        c.life <= 0 ||
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
  }

  dispose(): void {
    this.group.removeFromParent();
    this.carGeo.dispose();
    this.boatGeo.dispose();
    this.carMesh.dispose();
    this.boatMesh.dispose();
  }
}
