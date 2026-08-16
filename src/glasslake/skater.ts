/**
 * The skater.
 *
 * Skating is not walking with a low friction constant. What makes it feel
 * like skating is that the two axes are wildly different: a blade slides
 * almost freely along its length and barely at all across it. So velocity
 * is split into forward and lateral every frame, forward is left nearly
 * alone, and lateral is bitten off hard. Turn while you have speed and the
 * speed does not scrub away — it curves. That is a carve, and it is the
 * entire reason this world is a lake and not a field.
 *
 * The second half of the feel is that turning gets harder the faster you
 * go. Without it you can pivot on the spot at 25 m/s and the ice may as
 * well be a floor.
 */
import * as THREE from "three";

export interface SkaterInput {
  /** Camera-relative stick, both axes -1..1. */
  x: number;
  y: number;
  boost: boolean;
  hop: boolean;
}

const MAX_SPEED = 21;
const BOOST_SPEED = 30;
const PUSH = 17;
const FORWARD_DRAG = 0.22;   // glide: a long, slow bleed
const LATERAL_BITE = 7.5;    // edges: a fast one
const TURN_RATE = 3.1;
const HOP_V = 5.2;
const GRAVITY = 18;

export interface SkaterHandle {
  group: THREE.Group;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly heading: number;
  readonly speed: number;
  readonly airborne: boolean;
  update(dt: number, input: SkaterInput, camYaw: number, lakeRadius: number): void;
  reset(): void;
  dispose(): void;
}

/** A lantern-lit figure: dark silhouette, glowing blades, a scarf that lags. */
function buildMesh(): {
  group: THREE.Group;
  scarf: THREE.Mesh[];
  lean: THREE.Group;
  blades: THREE.Mesh[];
  dispose(): void;
} {
  const group = new THREE.Group();
  const lean = new THREE.Group();
  group.add(lean);

  const owned: Array<THREE.BufferGeometry | THREE.Material> = [];
  const keep = <T extends THREE.BufferGeometry | THREE.Material>(x: T): T => {
    owned.push(x);
    return x;
  };

  const coat = keep(
    new THREE.MeshStandardMaterial({ color: "#14161f", roughness: 0.85, metalness: 0.05 }),
  );
  const skin = keep(
    new THREE.MeshStandardMaterial({ color: "#d9b48f", roughness: 0.9 }),
  );
  const glow = keep(
    new THREE.MeshBasicMaterial({ color: "#8ef7d2", transparent: true, opacity: 0.95 }),
  );

  const body = new THREE.Mesh(keep(new THREE.CapsuleGeometry(0.26, 0.62, 6, 12)), coat);
  body.position.y = 0.86;
  lean.add(body);

  const head = new THREE.Mesh(keep(new THREE.SphereGeometry(0.19, 16, 12)), skin);
  head.position.y = 1.42;
  lean.add(head);

  const hat = new THREE.Mesh(keep(new THREE.ConeGeometry(0.22, 0.3, 12)), coat);
  hat.position.y = 1.62;
  lean.add(hat);

  const blades: THREE.Mesh[] = [];
  for (const dx of [-0.16, 0.16]) {
    const leg = new THREE.Mesh(keep(new THREE.CapsuleGeometry(0.09, 0.34, 4, 8)), coat);
    leg.position.set(dx, 0.32, 0);
    lean.add(leg);
    const blade = new THREE.Mesh(keep(new THREE.BoxGeometry(0.05, 0.05, 0.5)), glow);
    blade.position.set(dx, 0.05, 0);
    lean.add(blade);
    blades.push(blade);
  }

  // The scarf is six free bodies chasing the neck. It is the only thing in
  // the world that shows your speed without a number on the screen.
  const scarfMat = keep(
    new THREE.MeshStandardMaterial({ color: "#e8465f", roughness: 0.8, side: THREE.DoubleSide }),
  );
  const scarfGeo = keep(new THREE.BoxGeometry(0.16, 0.1, 0.24));
  const scarf: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const seg = new THREE.Mesh(scarfGeo, scarfMat);
    seg.position.set(0, 1.22, -0.1 * i);
    seg.scale.setScalar(1 - i * 0.09);
    group.add(seg);
    scarf.push(seg);
  }

  return {
    group,
    scarf,
    lean,
    blades,
    dispose() {
      owned.forEach((o) => o.dispose());
    },
  };
}

export function buildSkater(): SkaterHandle {
  const mesh = buildMesh();
  const position = new THREE.Vector3(0, 0, 0);
  const velocity = new THREE.Vector3();
  let heading = 0;
  let y = 0;
  let vy = 0;
  let airborne = false;
  let bob = 0;

  const forward = new THREE.Vector3();
  const lateral = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const scarfTargets = mesh.scarf.map(() => new THREE.Vector3(0, 1.22, 0));

  return {
    group: mesh.group,
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

    update(dt, input, camYaw, lakeRadius) {
      const mag = Math.min(1, Math.hypot(input.x, input.y));

      // Stick → world direction, rotated into the camera's frame.
      if (mag > 0.06) {
        const sin = Math.sin(camYaw);
        const cos = Math.cos(camYaw);
        desired.set(input.x * cos - input.y * sin, 0, input.x * sin + input.y * cos);
        desired.normalize();
        const want = Math.atan2(desired.x, desired.z);
        // Turning authority falls away with speed — a carve at pace is a
        // long arc, and a spin on the spot is something you do stopped.
        const speed = Math.hypot(velocity.x, velocity.z);
        const authority = TURN_RATE * (1 - Math.min(0.62, speed / 34)) * (airborne ? 0.35 : 1);
        let delta = want - heading;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        heading += THREE.MathUtils.clamp(delta, -authority * dt, authority * dt);
      }

      const fx = Math.sin(heading);
      const fz = Math.cos(heading);

      // Push off. Only on the ice — you cannot accelerate in mid-air.
      if (mag > 0.06 && !airborne) {
        const cap = input.boost ? BOOST_SPEED : MAX_SPEED;
        const speed = Math.hypot(velocity.x, velocity.z);
        const room = THREE.MathUtils.clamp(1 - speed / cap, 0, 1);
        const a = PUSH * mag * room * (input.boost ? 1.45 : 1);
        velocity.x += fx * a * dt;
        velocity.z += fz * a * dt;
      }

      // The carve: split, damp each axis on its own terms, recombine.
      const along = velocity.x * fx + velocity.z * fz;
      forward.set(fx * along, 0, fz * along);
      lateral.set(velocity.x - forward.x, 0, velocity.z - forward.z);
      const fDamp = Math.exp(-FORWARD_DRAG * dt);
      const lDamp = Math.exp(-(airborne ? 0.4 : LATERAL_BITE) * dt);
      velocity.x = forward.x * fDamp + lateral.x * lDamp;
      velocity.z = forward.z * fDamp + lateral.z * lDamp;

      // Hop.
      if (input.hop && !airborne) {
        vy = HOP_V;
        airborne = true;
      }
      if (airborne) {
        vy -= GRAVITY * dt;
        y += vy * dt;
        if (y <= 0) {
          y = 0;
          vy = 0;
          airborne = false;
        }
      }

      position.x += velocity.x * dt;
      position.z += velocity.z * dt;
      position.y = y;

      // The shore. Push back in and kill the outward component so you skid
      // along the bank instead of grinding into it.
      const r = Math.hypot(position.x, position.z);
      const limit = lakeRadius - 4;
      if (r > limit) {
        const nx = position.x / r;
        const nz = position.z / r;
        position.x = nx * limit;
        position.z = nz * limit;
        const out = velocity.x * nx + velocity.z * nz;
        if (out > 0) {
          velocity.x -= out * nx * 1.4;
          velocity.z -= out * nz * 1.4;
        }
      }

      // ---- Pose -----------------------------------------------------
      mesh.group.position.set(position.x, position.y, position.z);
      mesh.group.rotation.y = heading;

      const speed = Math.hypot(velocity.x, velocity.z);
      // Lean into the turn, proportional to how much lateral force the
      // edges are actually taking.
      const side = (velocity.x * fz - velocity.z * fx) / Math.max(speed, 1);
      mesh.lean.rotation.z = THREE.MathUtils.lerp(
        mesh.lean.rotation.z,
        THREE.MathUtils.clamp(side * 0.85, -0.5, 0.5),
        1 - Math.exp(-9 * dt),
      );
      mesh.lean.rotation.x = THREE.MathUtils.lerp(
        mesh.lean.rotation.x,
        Math.min(0.28, speed * 0.011),
        1 - Math.exp(-6 * dt),
      );
      bob += dt * (4 + speed * 0.4);
      mesh.lean.position.y = airborne ? 0 : Math.abs(Math.sin(bob)) * 0.035 * Math.min(1, speed / 6);

      // Scarf: each segment chases the one in front, with gravity and a
      // shove from the air you are moving through.
      const drag = 0.02 + Math.min(0.10, speed * 0.006);
      for (let i = 0; i < mesh.scarf.length; i++) {
        const target = scarfTargets[i];
        if (i === 0) {
          target.set(
            position.x - fx * 0.1,
            position.y + 1.24,
            position.z - fz * 0.1,
          );
        } else {
          const prev = scarfTargets[i - 1];
          target.lerp(prev, 1 - Math.exp(-14 * dt));
          target.x -= velocity.x * drag;
          target.z -= velocity.z * drag;
          target.y = THREE.MathUtils.lerp(
            target.y,
            position.y + 1.2 - i * 0.06 + Math.min(0.5, speed * 0.02),
            1 - Math.exp(-8 * dt),
          );
        }
        mesh.scarf[i].position.copy(target);
        mesh.scarf[i].rotation.y = heading + Math.sin(bob * 0.7 + i) * 0.25;
        mesh.scarf[i].rotation.z = Math.sin(bob * 0.9 + i * 0.7) * 0.3;
      }

      // Blades brighten as they bite.
      const bite = Math.min(1, Math.abs(side) * 1.6 + speed / 40);
      for (const blade of mesh.blades) {
        (blade.material as THREE.MeshBasicMaterial).opacity = 0.35 + bite * 0.65;
      }
    },

    reset() {
      position.set(0, 0, 0);
      velocity.set(0, 0, 0);
      heading = 0;
      y = 0;
      vy = 0;
      airborne = false;
      scarfTargets.forEach((t) => t.set(0, 1.22, 0));
    },

    dispose() {
      mesh.dispose();
    },
  };
}
