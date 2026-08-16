/**
 * The boarder.
 *
 * Same two-axis idea as the skater on the Glass Lake — a board slides
 * along its length and bites across it — but where the lake was flat and
 * you made your own speed, here the *terrain* is the engine. Gravity is
 * projected onto the surface, so a steep lee face accelerates you and a
 * windward slope bleeds it off. You never push. You choose a line.
 *
 * That difference is the whole sport: on ice the question is how hard you
 * can carve, and on a dune it is whether you can hold the fall line long
 * enough to make the next crest with air under you.
 *
 * The ground comes from `duneHeight`, the same function the mesh was built
 * from, so the board is never inside the sand it looks like it is on.
 */
import * as THREE from "three";
import { duneHeight, duneNormal, DUNE_RADIUS } from "./terrain";

export interface RiderInput {
  x: number;
  y: number;
  /** Tuck: less drag, no steering. */
  tuck: boolean;
  jump: boolean;
}

/** How hard gravity pulls along the slope. Tuned, not measured. */
const GRAVITY = 24;
const AIR_GRAVITY = 20;
/** Sliding friction along the board. Sand is not ice. */
const SLIDE_DRAG = 0.55;
const TUCK_DRAG = 0.26;
/** Across the board — the edge. Lower than ice: sand lets go. */
const EDGE_BITE = 4.6;
const TURN_RATE = 3.6;
const TURN_FALLOFF = 0.45;
const MAX_SPEED = 46;
const JUMP_V = 7.5;

export interface RiderHandle {
  group: THREE.Group;
  mount(object: THREE.Object3D, height: number): void;
  unmount(): void;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly heading: number;
  readonly speed: number;
  readonly airborne: boolean;
  /** Seconds of continuous air on the current jump, 0 when landed. */
  readonly airTime: number;
  /** How hard the edge is biting, 0..1 — drives the sand spray. */
  readonly carve: number;
  update(dt: number, input: RiderInput, camYaw: number): void;
  reset(x: number, z: number): void;
  dispose(): void;
}

export function buildRider(): RiderHandle {
  const group = new THREE.Group();
  // The board tilts with the slope; the character stands on the board. Two
  // groups because the body should lean into a turn without the board
  // leaving the sand.
  const deck = new THREE.Group();
  group.add(deck);
  const lean = new THREE.Group();
  deck.add(lean);

  const owned: Array<THREE.BufferGeometry | THREE.Material> = [];
  const keep = <T extends THREE.BufferGeometry | THREE.Material>(x: T): T => {
    owned.push(x);
    return x;
  };

  // The board. Wide, short, and turned up at both ends — a sandboard, not
  // a snowboard: it has to plane on something that is not solid.
  const boardMat = keep(
    new THREE.MeshStandardMaterial({ color: "#f0642f", roughness: 0.5, metalness: 0.1 }),
  );
  const board = new THREE.Mesh(keep(new THREE.BoxGeometry(0.42, 0.06, 1.55)), boardMat);
  board.position.y = 0.05;
  deck.add(board);
  for (const z of [-0.78, 0.78]) {
    const tip = new THREE.Mesh(keep(new THREE.BoxGeometry(0.42, 0.055, 0.3)), boardMat);
    tip.position.set(0, 0.1, z);
    tip.rotation.x = z > 0 ? -0.5 : 0.5;
    deck.add(tip);
  }
  const baseMat = keep(new THREE.MeshBasicMaterial({ color: "#2a1408" }));
  const base = new THREE.Mesh(keep(new THREE.BoxGeometry(0.4, 0.02, 1.5)), baseMat);
  base.position.y = 0.015;
  deck.add(base);

  let body: THREE.Object3D | null = null;

  const position = new THREE.Vector3(0, 0, 0);
  const velocity = new THREE.Vector3();
  let heading = 0;
  let vy = 0;
  let airborne = false;
  let airTime = 0;
  let carve = 0;

  const normal = { x: 0, y: 1, z: 0 };
  const desired = new THREE.Vector3();
  const surfaceUp = new THREE.Vector3();
  const q = new THREE.Quaternion();

  return {
    group,
    mount(object, _height) {
      if (body) lean.remove(body);
      body = object;
      object.position.set(0, 0.09, 0);
      // Riders stand across the board, not along it.
      object.rotation.y = Math.PI / 2;
      lean.add(object);
    },
    unmount() {
      if (body) lean.remove(body);
      body = null;
    },
    position,
    velocity,
    get heading() {
      return heading;
    },
    get speed() {
      return Math.hypot(velocity.x, velocity.z);
    },
    get airborne() {
      return airborne;
    },
    get airTime() {
      return airTime;
    },
    get carve() {
      return carve;
    },

    update(dt, input, camYaw) {
      const mag = Math.min(1, Math.hypot(input.x, input.y));
      duneNormal(position.x, position.z, 1.2, normal);

      // ---- Steering ----------------------------------------------------
      if (mag > 0.06 && !input.tuck) {
        const sin = Math.sin(camYaw);
        const cos = Math.cos(camYaw);
        desired.set(input.x * cos - input.y * sin, 0, input.x * sin + input.y * cos).normalize();
        const want = Math.atan2(desired.x, desired.z);
        const speed = Math.hypot(velocity.x, velocity.z);
        const authority =
          TURN_RATE * (1 - Math.min(TURN_FALLOFF, speed / 70)) * (airborne ? 0.5 : 1);
        let delta = want - heading;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        heading += THREE.MathUtils.clamp(delta, -authority * dt, authority * dt);
      }

      const fx = Math.sin(heading);
      const fz = Math.cos(heading);

      if (!airborne) {
        // ---- Gravity along the slope -----------------------------------
        // The component of straight-down that survives being projected onto
        // the surface. On a flat pan it is zero and you coast to a stop; on
        // a slip face it is most of g.
        //
        //   g_t = g - (g·N)N,  g = (0, -G, 0)
        //       → horizontal part = +G·N.y·(N.x, N.z)
        //
        // The sign matters more than it looks. Negated, this is a perfectly
        // stable simulation of a board that climbs: the run started at the
        // rim and rode 65 m *up* it, shedding speed, which reads as heavy
        // sand rather than as inverted gravity until you check the numbers.
        const gx = normal.x * normal.y * GRAVITY;
        const gz = normal.z * normal.y * GRAVITY;
        velocity.x += gx * dt;
        velocity.z += gz * dt;

        // ---- Edges -------------------------------------------------------
        const along = velocity.x * fx + velocity.z * fz;
        const latX = velocity.x - fx * along;
        const latZ = velocity.z - fz * along;
        const drag = input.tuck ? TUCK_DRAG : SLIDE_DRAG;
        const fDamp = Math.exp(-drag * dt);
        const lDamp = Math.exp(-EDGE_BITE * dt);
        velocity.x = fx * along * fDamp + latX * lDamp;
        velocity.z = fz * along * fDamp + latZ * lDamp;

        carve += (Math.min(1, Math.hypot(latX, latZ) / 7) - carve) * (1 - Math.exp(-8 * dt));
      } else {
        airTime += dt;
        carve += (0 - carve) * (1 - Math.exp(-4 * dt));
      }

      const speedNow = Math.hypot(velocity.x, velocity.z);
      if (speedNow > MAX_SPEED) {
        velocity.x *= MAX_SPEED / speedNow;
        velocity.z *= MAX_SPEED / speedNow;
      }

      position.x += velocity.x * dt;
      position.z += velocity.z * dt;

      // ---- Ground ---------------------------------------------------------
      const ground = duneHeight(position.x, position.z);
      if (airborne || input.jump) {
        if (input.jump && !airborne) {
          vy = JUMP_V;
          airborne = true;
          airTime = 0;
        }
        vy -= AIR_GRAVITY * dt;
        position.y += vy * dt;
        if (position.y <= ground) {
          position.y = ground;
          vy = 0;
          airborne = false;
          airTime = 0;
        }
      } else {
        // Leaving the ground is not a jump input: it is the sand falling
        // away from under you faster than you are falling. Comparing this
        // frame's drop to what gravity could manage is the whole test, and
        // it is why a crest at speed throws you and a crest at a crawl
        // does not.
        const drop = position.y - ground;
        const fall = 0.5 * AIR_GRAVITY * dt * dt + Math.abs(vy) * dt;
        if (drop > fall + 0.35) {
          airborne = true;
          airTime = 0;
          vy = 0;
        } else {
          position.y = ground;
          vy = 0;
        }
      }

      // ---- The rim ---------------------------------------------------------
      const r = Math.hypot(position.x, position.z);
      const limit = DUNE_RADIUS * 0.985;
      if (r > limit) {
        const nx = position.x / r;
        const nz = position.z / r;
        position.x = nx * limit;
        position.z = nz * limit;
        const out = velocity.x * nx + velocity.z * nz;
        if (out > 0) {
          velocity.x -= out * nx * 1.5;
          velocity.z -= out * nz * 1.5;
        }
      }

      // ---- Pose -------------------------------------------------------------
      group.position.copy(position);
      group.rotation.y = heading;
      // The deck lies on the surface. Airborne, it eases back to level so a
      // jump does not freeze the last slope you were on.
      surfaceUp.set(normal.x, normal.y, normal.z);
      if (airborne) surfaceUp.lerp(new THREE.Vector3(0, 1, 0), 0.6);
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), surfaceUp);
      deck.quaternion.slerp(q, 1 - Math.exp(-9 * dt));
      // Undo the group's yaw inside the deck so the tilt is the slope's and
      // not the slope's rotated by wherever you happen to be pointing.
      deck.quaternion.premultiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading),
      );

      const side = (velocity.x * fz - velocity.z * fx) / Math.max(speedNow, 1);
      lean.rotation.z = THREE.MathUtils.lerp(
        lean.rotation.z,
        THREE.MathUtils.clamp(-side * 0.75, -0.5, 0.5),
        1 - Math.exp(-8 * dt),
      );
      lean.rotation.x = THREE.MathUtils.lerp(
        lean.rotation.x,
        input.tuck ? 0.55 : Math.min(0.3, speedNow * 0.008),
        1 - Math.exp(-6 * dt),
      );
    },

    reset(x, z) {
      position.set(x, duneHeight(x, z), z);
      velocity.set(0, 0, 0);
      vy = 0;
      heading = Math.atan2(-x, -z);
      airborne = false;
      airTime = 0;
      carve = 0;
    },

    dispose() {
      owned.forEach((o) => o.dispose());
    },
  };
}
