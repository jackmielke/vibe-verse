/**
 * Pathfinder 1 — the airship, as geometry and as physics.
 *
 * A 124-metre rigid hull, four fins, a gondola under the bow and two engine
 * pods amidships. Thirteen helium cells give her lift, water ballast gives
 * her weight, and the difference between the two is the only reason she
 * goes up or down. Engines push her forward and the rudder turns her, but
 * slowly — she is a building that flies, and the trick of flying her is
 * that everything you do takes twenty seconds to show.
 */
import * as THREE from "three";

export const HULL_LENGTH = 124;
export const HULL_RADIUS = 10.5;
export const CELLS = 13;

export interface ShipControls {
  /** 0..1 */
  throttle: number;
  /** -1..1, positive turns right. */
  rudder: number;
  /** -1..1, positive noses up. */
  elevator: number;
}

export interface ShipState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  heading: number;
  pitch: number;
  /** Helium, 0..1 of the full 13 cells. */
  helium: number;
  /** Ballast bags remaining. */
  ballast: number;
  /** Cargo pallets aboard. */
  cargo: number;
  airspeed: number;
  verticalSpeed: number;
  /** Net lift as a fraction of weight: +0.1 is 10% light. */
  trim: number;
}

const MASS_EMPTY = 20000; // kg
const CARGO_MASS = 2500;
const BALLAST_MASS = 600;
const MAX_BALLAST = 8;
/** Lift from a full set of cells, kg-force. Sized so full cells + 5 pallets + 4 bags float level. */
const FULL_LIFT = MASS_EMPTY + CARGO_MASS * 5 + BALLAST_MASS * 4;
const G = 9.81;
const THRUST = 90000; // N, both engines
const MAX_SPEED = 32; // m/s, about 60 knots at this scale

export function createShip(): {
  group: THREE.Group;
  props: THREE.Mesh[];
  state: ShipState;
  step(dt: number, controls: ShipControls, wind: THREE.Vector3, groundAt: (x: number, z: number) => number): { grounded: boolean };
  vent(dt: number): void;
  dropBallast(): boolean;
  dropCargo(): boolean;
  reset(x: number, y: number, z: number, heading: number): void;
  dispose(): void;
} {
  const group = new THREE.Group();

  // Hull: a stretched sphere with a slightly pointed tail.
  const hullGeo = new THREE.SphereGeometry(1, 40, 24);
  const pos = hullGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    // x runs -1 (tail) .. 1 (bow). Taper the tail more than the bow.
    const taper = x < 0 ? 1 - 0.35 * x * x : 1 - 0.15 * x * x;
    pos.setY(i, pos.getY(i) * taper);
    pos.setZ(i, pos.getZ(i) * taper);
  }
  hullGeo.computeVertexNormals();
  const hullMat = new THREE.MeshStandardMaterial({
    color: 0xf2f1ec,
    roughness: 0.55,
    metalness: 0.1,
  });
  const hull = new THREE.Mesh(hullGeo, hullMat);
  hull.scale.set(HULL_LENGTH / 2, HULL_RADIUS, HULL_RADIUS);
  group.add(hull);

  // Frame lines: the rigid part of "rigid airship", drawn as rings.
  const ringMat = new THREE.LineBasicMaterial({ color: 0xb9b6ad, transparent: true, opacity: 0.6 });
  for (let i = -5; i <= 5; i++) {
    const x = (i / 6) * (HULL_LENGTH / 2) * 0.95;
    const t = x / (HULL_LENGTH / 2);
    const taper = t < 0 ? 1 - 0.35 * t * t : 1 - 0.15 * t * t;
    const r = HULL_RADIUS * taper * Math.sqrt(Math.max(0, 1 - t * t));
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      pts.push(new THREE.Vector3(x, Math.cos(a) * r, Math.sin(a) * r));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
  }

  // A stripe, because she has one.
  const stripeGeo = new THREE.SphereGeometry(1.004, 40, 24, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.16);
  const stripe = new THREE.Mesh(stripeGeo, new THREE.MeshStandardMaterial({ color: 0xd94a3a, roughness: 0.6 }));
  stripe.scale.copy(hull.scale);
  stripe.rotation.z = Math.PI / 2;
  stripe.position.x = -HULL_LENGTH * 0.28;
  stripe.scale.x *= 0.22;
  group.add(stripe);

  // Fins: four, at the tail.
  const finMat = new THREE.MeshStandardMaterial({ color: 0xe4e2dc, roughness: 0.6, side: THREE.DoubleSide });
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(22, 0);
  finShape.lineTo(20, 7);
  finShape.lineTo(6, 13);
  finShape.lineTo(0, 9);
  finShape.lineTo(0, 0);
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.6, bevelEnabled: false });
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(finGeo, finMat);
    fin.position.set(-HULL_LENGTH / 2 + 2, 0, 0);
    fin.rotation.x = (i * Math.PI) / 2 + Math.PI / 4;
    fin.translateY(HULL_RADIUS * 0.45);
    group.add(fin);
  }

  // Gondola under the bow third.
  const gondola = new THREE.Mesh(
    new THREE.BoxGeometry(14, 3.2, 4.2),
    new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.5, metalness: 0.3 }),
  );
  gondola.position.set(HULL_LENGTH * 0.18, -HULL_RADIUS - 0.9, 0);
  group.add(gondola);
  const windows = new THREE.Mesh(
    new THREE.BoxGeometry(13, 1.2, 4.4),
    new THREE.MeshStandardMaterial({ color: 0x9fd4ff, emissive: 0x2a5a80, roughness: 0.2 }),
  );
  windows.position.set(HULL_LENGTH * 0.18, -HULL_RADIUS - 0.2, 0);
  group.add(windows);

  // Engine pods and props.
  const props: THREE.Mesh[] = [];
  const podGeo = new THREE.CylinderGeometry(1.3, 1.3, 5, 10);
  podGeo.rotateZ(Math.PI / 2);
  const podMat = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.5, metalness: 0.4 });
  const propGeo = new THREE.BoxGeometry(0.3, 7, 0.5);
  const propMat = new THREE.MeshStandardMaterial({ color: 0x222222, transparent: true, opacity: 0.7 });
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(podGeo, podMat);
    pod.position.set(-4, -HULL_RADIUS * 0.55, side * (HULL_RADIUS + 2.4));
    group.add(pod);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.6, 6, 0.6), podMat);
    strut.position.set(-4, -HULL_RADIUS * 0.3, side * (HULL_RADIUS + 1.2));
    strut.rotation.x = side * 0.5;
    group.add(strut);
    const prop = new THREE.Mesh(propGeo, propMat);
    prop.position.set(-7, -HULL_RADIUS * 0.55, side * (HULL_RADIUS + 2.4));
    group.add(prop);
    props.push(prop);
  }

  // Cargo pallets slung under the belly. They disappear as they are dropped.
  const palletMat = new THREE.MeshStandardMaterial({ color: 0xb8863a, roughness: 0.9 });
  const pallets: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(4, 2.6, 4), palletMat);
    p.position.set(-14 + i * 6, -HULL_RADIUS - 1.3, 0);
    group.add(p);
    pallets.push(p);
  }

  const state: ShipState = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    heading: 0,
    pitch: 0,
    helium: 1,
    ballast: 4,
    cargo: 5,
    airspeed: 0,
    verticalSpeed: 0,
    trim: 0,
  };

  const forward = new THREE.Vector3();
  const rel = new THREE.Vector3();

  const mass = () => MASS_EMPTY + state.cargo * CARGO_MASS + state.ballast * BALLAST_MASS;

  return {
    group,
    props,
    state,
    step(dt, controls, wind, groundAt) {
      const m = mass();
      const lift = FULL_LIFT * state.helium * G;
      const weight = m * G;
      state.trim = (lift - weight) / weight;

      forward.set(Math.sin(state.heading), 0, Math.cos(state.heading));
      // Air-relative velocity decides drag and control authority.
      rel.copy(state.velocity).sub(wind);
      const air = rel.length();
      state.airspeed = forward.dot(rel);

      // Thrust along the hull, drag against relative motion, lift up.
      const ax = forward.x * (THRUST * controls.throttle) / m;
      const az = forward.z * (THRUST * controls.throttle) / m;
      const dragK = (THRUST / (MAX_SPEED * MAX_SPEED)) / m;
      state.velocity.x += (ax - dragK * rel.x * air) * dt;
      state.velocity.z += (az - dragK * rel.z * air) * dt;
      // Vertical: buoyancy, a lot of vertical drag (she is fat), and the
      // elevator, which only works with air over it.
      const elevatorLift = controls.elevator * Math.max(0, state.airspeed) * 0.9;
      const vy = (lift - weight) / m + elevatorLift / 10 - state.velocity.y * 0.35 * (1 + Math.abs(state.velocity.y) * 0.4);
      state.velocity.y += vy * dt;
      state.verticalSpeed = state.velocity.y;

      // Rudder: turns with airspeed, and there is a lot of ship to swing.
      const yawRate = controls.rudder * Math.min(1, Math.max(0, state.airspeed) / 12) * 0.16;
      state.heading += yawRate * dt;
      const targetPitch = controls.elevator * 0.14 + THREE.MathUtils.clamp(state.velocity.y * 0.02, -0.12, 0.12);
      state.pitch += (targetPitch - state.pitch) * Math.min(1, dt * 0.8);

      state.position.addScaledVector(state.velocity, dt);

      // The ground. She lands on her gondola and does not go through it.
      // The mast holds her well clear of the ground: the hull is sixty metres
      // each way from here and the field is not flat.
      const floor = Math.max(0, groundAt(state.position.x, state.position.z)) + HULL_RADIUS + 14;
      let grounded = false;
      if (state.position.y < floor) {
        state.position.y = floor;
        if (state.velocity.y < 0) state.velocity.y = 0;
        state.velocity.x *= 1 - Math.min(1, dt * 2);
        state.velocity.z *= 1 - Math.min(1, dt * 2);
        grounded = true;
      }
      if (state.position.y > 900) {
        state.position.y = 900;
        state.velocity.y = Math.min(0, state.velocity.y);
      }

      group.position.copy(state.position);
      group.rotation.set(0, state.heading - Math.PI / 2, 0);
      group.rotateZ(state.pitch);
      // A little bank into the turn, because she does, slowly.
      group.rotateX(-yawRate * 0.9);
      for (const p of props) p.rotation.x += dt * (4 + controls.throttle * 40);
      return { grounded };
    },
    vent(dt) {
      state.helium = Math.max(0.55, state.helium - dt * 0.03);
    },
    dropBallast() {
      if (state.ballast <= 0) return false;
      state.ballast--;
      return true;
    },
    dropCargo() {
      if (state.cargo <= 0) return false;
      state.cargo--;
      const p = pallets[state.cargo];
      p.visible = false;
      return true;
    },
    reset(x, y, z, heading) {
      state.position.set(x, y, z);
      state.velocity.set(0, 0, 0);
      state.heading = heading;
      state.pitch = 0;
      state.helium = 1;
      state.ballast = MAX_BALLAST;
      // Full lift is sized for 4 bags; starting with 8 makes her heavy on the
      // ground, which is how a ship sits before the crew drops two.
      state.cargo = 5;
      for (const p of pallets) p.visible = true;
      group.position.copy(state.position);
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    },
  };
}
