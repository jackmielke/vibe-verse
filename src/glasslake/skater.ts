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
// Steering authority, radians per second at a standstill.
//
// This was 3.1 with the falloff below capped at 0.62, which left 1.2 rad/s
// at speed — a ninety-degree turn took a second and a third, and the lake
// is only three hundred and eighty metres across. It read as a boat. The
// carve is supposed to come from the *edges* biting, not from the steering
// being sluggish, so the rate went up and the falloff came down: you can
// always point where you want, and the ice still decides how fast you get
// there.
const TURN_RATE = 4.4;
const TURN_FALLOFF = 0.42;
const HOP_V = 5.2;
const GRAVITY = 18;

export interface SkaterHandle {
  group: THREE.Group;
  /** Added to the scene alongside `group` — see buildMesh's note. */
  scarfGroup: THREE.Group;
  /**
   * Put a body on the skates. Called once the character rig has loaded —
   * the world starts without one rather than waiting, so the lake is
   * skateable the moment it paints.
   */
  mount(object: THREE.Object3D, height: number): void;
  unmount(): void;
  /** 0 when gliding, 1 when pushing — drives the rig's walk cycle. */
  readonly effort: number;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly heading: number;
  readonly speed: number;
  readonly airborne: boolean;
  update(dt: number, input: SkaterInput, camYaw: number, lakeRadius: number): void;
  reset(): void;
  dispose(): void;
}

/**
 * The rider: whoever you already are, on a pair of blades.
 *
 * The body is not built here. It is the character you picked in the
 * vibeverse — `loadCharacterRig` fits any of the fifty-odd catalog
 * models (or the code-built ones, which have no file at all) to a
 * height, plants its feet at y=0 and hands back a rig that animates
 * itself. This world adds the two things that make that character a
 * skater rather than a walker: blades under the feet and a scarf that
 * lags behind the neck.
 *
 * The rig arrives asynchronously and the world does not wait for it, so
 * everything below is built and posed whether or not a body has turned
 * up yet. A skater with no model is a scarf and two blades skating on
 * their own, which is a better failure than a blank lake.
 */
function buildMesh(): {
  group: THREE.Group;
  /**
   * The scarf lives in world space, so it is a *sibling* of the skater
   * rather than a child. A trailing chain is solved in world coordinates
   * by definition — each link chases where the last one actually is —
   * and writing those coordinates into children of a group that is
   * itself moving and rotating applies the skater's transform twice.
   * The visible result was six red blocks dropped on the ice in a line
   * behind you, which is a convincing bug report for parenting.
   */
  scarfGroup: THREE.Group;
  scarf: THREE.Mesh[];
  lean: THREE.Group;
  blades: THREE.Mesh[];
  mount(object: THREE.Object3D, height: number): void;
  unmount(): void;
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

  const glow = keep(
    new THREE.MeshBasicMaterial({ color: "#8ef7d2", transparent: true, opacity: 0.95 }),
  );

  const blades: THREE.Mesh[] = [];
  for (const dx of [-0.14, 0.14]) {
    const blade = new THREE.Mesh(keep(new THREE.BoxGeometry(0.05, 0.045, 0.52)), glow);
    blade.position.set(dx, 0.03, 0.02);
    lean.add(blade);
    blades.push(blade);
  }

  // The scarf is six free bodies chasing the neck. It is the only thing in
  // the world that shows your speed without a number on the screen — and it
  // is the one piece of costume every character gets, so the pug and the
  // knight are recognisably in the same sport.
  const scarfMat = keep(
    new THREE.MeshStandardMaterial({ color: "#e8465f", roughness: 0.8, side: THREE.DoubleSide }),
  );
  const scarfGeo = keep(new THREE.BoxGeometry(0.16, 0.1, 0.24));
  const scarfGroup = new THREE.Group();
  const scarf: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const seg = new THREE.Mesh(scarfGeo, scarfMat);
    seg.position.set(0, 1.22, -0.1 * i);
    seg.scale.setScalar(1 - i * 0.09);
    scarfGroup.add(seg);
    scarf.push(seg);
  }

  let body: THREE.Object3D | null = null;

  return {
    group,
    scarfGroup,
    scarf,
    lean,
    blades,
    mount(object, height) {
      if (body) lean.remove(body);
      body = object;
      // Blades ride under the feet, and the scarf sits at the shoulders of
      // whoever turned up — a pug and an alien do not wear it in the same
      // place, so it is measured off the fitted height rather than fixed.
      object.position.set(0, 0.06, 0);
      lean.add(object);
      scarf.forEach((seg, i) => seg.position.set(0, height * 0.72, -0.1 * i));
    },
    unmount() {
      if (body) lean.remove(body);
      body = null;
    },
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
  const scarfDir = new THREE.Vector3();
  const scarfTmp = new THREE.Vector3();
  let neckY = 1.22;
  let effort = 0;
  const scarfTargets = mesh.scarf.map(() => new THREE.Vector3(0, neckY, 0));

  return {
    group: mesh.group,
    scarfGroup: mesh.scarfGroup,
    mount(object, height) {
      mesh.mount(object, height);
      neckY = height * 0.72;
    },
    unmount: () => mesh.unmount(),
    get effort() {
      return effort;
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

    update(dt, input, camYaw, lakeRadius) {
      const mag = Math.min(1, Math.hypot(input.x, input.y));
      // A skater pushing is doing something a walk cycle reads well; a
      // skater gliding is not. Ease it so the legs do not flicker on and
      // off with the stick.
      const wantEffort = airborne ? 0 : mag > 0.06 ? (input.boost ? 1 : 0.72) : 0.06;
      effort += (wantEffort - effort) * (1 - Math.exp(-7 * dt));

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
        const authority =
          TURN_RATE * (1 - Math.min(TURN_FALLOFF, speed / 46)) * (airborne ? 0.4 : 1);
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

      // Scarf: a chain, not a queue of laggards.
      //
      // Each link sits exactly one segment-length from the one in front,
      // in whatever direction it already lies, pulled down by gravity and
      // straightened out by the air you are moving through. The distance
      // is a *constraint* — the previous version eased each link toward
      // the one ahead and then shoved it backwards by velocity × drag
      // every frame, which is an offset applied sixty times a second and
      // never repaid. At speed the tail simply left, and six red blocks
      // went skidding across the lake behind you.
      const SEG = 0.24;
      for (let i = 0; i < mesh.scarf.length; i++) {
        const target = scarfTargets[i];
        if (i === 0) {
          // The neck, a little behind the collarbone.
          target.set(position.x - fx * 0.12, position.y + neckY, position.z - fz * 0.12);
        } else {
          const prev = scarfTargets[i - 1];
          scarfDir.subVectors(target, prev);
          if (scarfDir.lengthSq() < 1e-6) scarfDir.set(-fx, 0, -fz);
          scarfDir.normalize();
          // Hangs at rest, streams flat at speed, and always trails the
          // direction of travel rather than the direction you face.
          scarfDir.y += -0.9 + Math.min(0.86, speed * 0.062);
          scarfDir.x -= velocity.x * 0.035;
          scarfDir.z -= velocity.z * 0.035;
          if (scarfDir.lengthSq() < 1e-6) scarfDir.set(-fx, -0.5, -fz);
          scarfDir.normalize();
          scarfTmp.copy(prev).addScaledVector(scarfDir, SEG);
          target.lerp(scarfTmp, 1 - Math.exp(-24 * dt));
        }
        mesh.scarf[i].position.copy(target);
        // Point each link at the one in front so the scarf reads as cloth
        // rather than as a row of separate blocks.
        if (i > 0) mesh.scarf[i].lookAt(scarfTargets[i - 1]);
        else mesh.scarf[i].rotation.set(0, heading, 0);
        mesh.scarf[i].rotation.z += Math.sin(bob * 0.9 + i * 0.7) * 0.22;
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
      scarfTargets.forEach((t) => t.set(0, neckY, 0));
    },

    dispose() {
      mesh.dispose();
    },
  };
}
