/**
 * The Midnight Zone — the submersible.
 *
 * The hull, the lamps, and the physics of a thing that is very nearly the same
 * density as the water it is in.
 *
 * The movement model is not a spaceship's. A submersible has enormous drag and
 * almost no inertia to fight, so thrust maps closely to *speed* rather than to
 * acceleration — you stop within a metre of releasing the stick. What it does
 * have is buoyancy: trimmed heavy, so with the controls untouched you sink.
 *
 * The sink is a *current*, not the journey. That distinction was the first
 * build's central mistake: it made the drift the intended way down, at a rate
 * that needed three and a half hours, and told players so in the briefing.
 * Descending is something you do — hold the dive control and the floor is two
 * minutes away, one if you spend the boost.
 *
 * The lamps are the other half of the design. Two spotlights, and the entire
 * game is what they do and do not reach. They no longer cost more power than
 * they can earn: darkness has to be a thing you *choose*, by switching them
 * off, because darkness that creeps up on you is indistinguishable from a
 * broken renderer — which is exactly how it was reported.
 */
import * as THREE from "three";
import { depthOf, FLOOR_DEPTH, type DeepCtx, type SubService, type System } from "../types";

/**
 * Speeds, in metres per second of *terminal* velocity.
 *
 * These are the numbers that decide whether the world is playable, and the
 * first build got them badly wrong by reasoning about the accelerations rather
 * than measuring the result. Because the integrator is `v += a·dt` followed by
 * `v *= exp(-DRAG·dt)`, terminal velocity is `a / DRAG` — so an acceleration
 * that *looks* brisk lands somewhere else entirely. What shipped was a free
 * sink of 0.65 m/s, which is three and a half hours to the floor, in a world
 * whose own briefing tells you it sinks on its own. Holding the dive key was
 * eleven minutes.
 *
 * So they are quoted as terminal velocities now, and converted at the point of
 * use. The arithmetic is in `deep.test.ts`, which fails if the full descent
 * ever creeps back over a few minutes — a number nobody notices going wrong by
 * reading the code, and everybody notices while playing.
 */
export const SPEEDS = {
  /** Sink rate with nothing held down. */
  ballast: 11,
  /** Forward thrust. */
  surge: 34,
  /** Ballast controls, up or down. */
  heave: 60,
  /** Multiplier on surge and heave alike while boosting. */
  boost: 2,
} as const;

const BALLAST_SINK = SPEEDS.ballast;
const SURGE_SPEED = SPEEDS.surge;
const HEAVE_SPEED = SPEEDS.heave;
const BOOST_MULT = SPEEDS.boost;
/** How hard the water fights back. High: it is water. */
const DRAG = 3.1;
const YAW_RATE = 1.5;

/** Below here the hull starts to complain, then to fail. */
export const CRUSH_DEPTH = 7400;

/**
 * The visible beam.
 *
 * A `SpotLight` lights surfaces; it does not light *water*. In clear air that
 * is fine, but a submersible's lamps are famous for the cone itself — the
 * shaft of green-white you can see hanging in the water in front of the sub —
 * and without it the lamps read as two bright dots on the hull rather than as
 * headlights.
 *
 * Real volumetrics for this cost a depth prepass and a raymarch. A cone mesh
 * with alpha baked into its vertex colours costs one draw call, and at the
 * angles you ever see it from, it is indistinguishable.
 */
function buildBeam(length: number, radius: number): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(0.06, radius, length, 18, 6, true);
  // The lathe runs along +Y; the lamps point along +Z.
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, length / 2);

  const colors: number[] = [];
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const t = z / length; // 0 at the lamp, 1 at the far end
    // Bright at the lamp, gone by the end. The shoulder near the lamp is what
    // makes it look like it is being *emitted* rather than just fading in.
    const a = Math.pow(1 - t, 2.2) * (1 - Math.pow(t, 8));
    colors.push(a, a, a);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

  const mat = new THREE.MeshBasicMaterial({
    color: 0xbfe9ff,
    vertexColors: true,
    transparent: true,
    opacity: 0.1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Fogging the beam would make it vanish exactly where it is doing its job.
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return mesh;
}

function buildHull(): {
  root: THREE.Group;
  lampL: THREE.SpotLight;
  lampR: THREE.SpotLight;
  beams: THREE.Mesh[];
  fill: THREE.PointLight;
} {
  const root = new THREE.Group();

  const hullMat = new THREE.MeshStandardMaterial({ color: 0xf0b429, roughness: 0.45, metalness: 0.55 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x1c2431, roughness: 0.6, metalness: 0.7 });
  /**
   * The viewport dome — deliberately *not* `transmission`.
   *
   * A material with transmission makes three render the whole scene a second
   * time, into a transmission target, every frame. That is a defensible price
   * for a pane of glass you stand in front of; it is an indefensible one for a
   * half-metre dome on the back of your own submersible, in a world where the
   * scene behind it is near-black anyway. It doubled the cost of every frame
   * for an effect nobody can see, on top of a bloom and a grade pass — which
   * is a strong candidate for "very glitchy" on anything without a discrete
   * GPU. Plain transparency is indistinguishable here and free.
   */
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x9fe8ff,
    roughness: 0.08,
    metalness: 0.1,
    transparent: true,
    opacity: 0.42,
  });

  // Pressure sphere forward, faired body behind — the Alvin/Limiting Factor
  // silhouette. Yellow because every submersible anyone can picture is yellow.
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 1.5, 8, 18), hullMat);
  body.rotation.x = Math.PI / 2;
  root.add(body);

  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.52, 20, 16), glassMat);
  dome.position.z = 1.05;
  root.add(dome);

  // Sail.
  const sail = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.9), trimMat);
  sail.position.set(0, 0.62, -0.25);
  root.add(sail);

  // Thruster ducts either side.
  for (const s of [-1, 1]) {
    const duct = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.42, 12, 1, true), trimMat);
    duct.rotation.x = Math.PI / 2;
    duct.position.set(s * 0.82, -0.12, -0.9);
    root.add(duct);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.05), trimMat);
    blade.position.copy(duct.position);
    blade.name = s < 0 ? "propL" : "propR";
    root.add(blade);
  }

  // Skids, so it has somewhere to stand when it reaches the floor.
  for (const s of [-1, 1]) {
    const skid = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 2.2), trimMat);
    skid.position.set(s * 0.62, -0.86, -0.1);
    root.add(skid);
  }

  // The lamps. Wide and slightly toed-in and nose-down, so their pools overlap
  // a few metres ahead — which is where the thing you are looking at will be,
  // and where the seafloor comes up to meet you.
  const beams: THREE.Mesh[] = [];
  const mk = (x: number) => {
    const l = new THREE.SpotLight(0xdff2ff, 260, 90, 0.62, 0.45, 1.1);
    l.position.set(x, -0.18, 1.0);
    const t = new THREE.Object3D();
    t.position.set(x * 0.3, -4.2, 24);
    root.add(t);
    l.target = t;
    root.add(l);

    // Short and narrow. At 30 m long and 8.4 m across these stopped being
    // shafts and became a wall: additive, unfogged, and filling the lower two
    // thirds of the frame with a pale dome you descend *inside* of. That never
    // showed up while the sub was parked next to a seafloor that caught the
    // light — only once you travelled far enough through open water to spend a
    // minute looking at nothing else.
    const beam = buildBeam(17, 2.9);
    beam.position.copy(l.position);
    // Point the cone the same way as the light: down the line to its target.
    beam.lookAt(t.position);
    beam.name = x < 0 ? "beamL" : "beamR";
    root.add(beam);
    beams.push(beam);

    // The housing, so the lamp is visibly a thing on the hull.
    const can = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.16, 0.22, 10),
      new THREE.MeshStandardMaterial({ color: 0xe8f6ff, emissive: 0xdff2ff, emissiveIntensity: 3 }),
    );
    can.rotation.x = Math.PI / 2;
    can.position.copy(l.position);
    can.name = x < 0 ? "canL" : "canR";
    root.add(can);
    return l;
  };
  const lampL = mk(-0.66);
  const lampR = mk(0.66);

  /**
   * A dim fill on the hull itself.
   *
   * Physically there is nothing down here to bounce light back onto the sub,
   * and rendering that honestly gives you a black hole where your vehicle
   * should be. The player's own craft is the one thing that must always read —
   * it is the anchor for every judgement about speed, attitude and distance —
   * so it gets a small light nobody is meant to notice.
   */
  const fill = new THREE.PointLight(0x9fd8f0, 26, 12, 2);
  fill.position.set(0, 2.4, -2.6);
  root.add(fill);

  return { root, lampL, lampR, beams, fill };
}

export default function createSub(ctx: DeepCtx): System {
  const { root, lampL, lampR, beams, fill } = buildHull();
  root.position.set(0, -4, 0);
  ctx.scene.add(root);

  const velocity = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  let yaw = 0;
  let pitch = 0;
  let roll = 0;
  let lightsOn = true;
  let power = 1;
  let hull = 1;
  let landed = false;

  const service: SubService = {
    object: root,
    position: root.position,
    velocity,
    speed: 0,
    depth: 4,
    lightsOn: true,
    power: 1,
    hull: 1,
    setLights(on) {
      lightsOn = on;
      service.lightsOn = on;
    },
  };
  ctx.services.sub = service;

  return {
    update(dt) {
      const input = ctx.input;

      if (input.lightsPressed) service.setLights(!lightsOn);

      // -- attitude ---------------------------------------------------------
      // Yaw from the stick and from look-drag together, so a mouse and a
      // keyboard steer the same vehicle rather than fighting over it.
      yaw -= input.yaw * YAW_RATE * dt;
      yaw -= input.lookYaw;
      pitch = THREE.MathUtils.clamp(pitch - input.lookPitch, -1.05, 1.05);
      input.lookYaw = 0;
      input.lookPitch = 0;

      // Bank into the turn. Cosmetic, and it is most of what makes the sub
      // feel like it has mass.
      const wantRoll = -input.yaw * 0.32;
      roll += (wantRoll - roll) * Math.min(1, dt * 3.4);

      root.rotation.set(0, 0, 0);
      root.rotateY(yaw);
      root.rotateX(pitch * 0.5);
      root.rotateZ(roll);

      forward.set(0, 0, 1).applyQuaternion(root.quaternion);
      right.set(1, 0, 0).applyQuaternion(root.quaternion);

      // -- thrust -----------------------------------------------------------
      const boosting = input.boost && power > 0.02;
      const mult = boosting ? BOOST_MULT : 1;
      const drive = power > 0.01 ? 1 : 0.4; // A flat battery still coasts.

      // `speed * DRAG` is the acceleration whose terminal velocity is `speed`.
      velocity.addScaledVector(forward, input.surge * SURGE_SPEED * mult * drive * DRAG * dt);
      // Boost helps the *descent* too. It only ever helped forward thrust,
      // which is the one axis the descent does not use.
      velocity.y += input.heave * HEAVE_SPEED * mult * drive * DRAG * dt;
      // Ballast. Always there, always down.
      velocity.y -= BALLAST_SINK * DRAG * dt;

      // Water drag. Exponential, so releasing the stick stops you promptly and
      // there is no space-sim glide.
      const damp = Math.exp(-DRAG * dt);
      velocity.multiplyScalar(damp);

      root.position.addScaledVector(velocity, dt);

      // -- the floor, and the ceiling ---------------------------------------
      const floorY = -FLOOR_DEPTH;
      if (root.position.y < floorY + 1.6) {
        root.position.y = floorY + 1.6;
        if (velocity.y < 0) velocity.y = 0;
        if (!landed) {
          landed = true;
          ctx.emit("sub:landed", { depth: FLOOR_DEPTH });
        }
      } else if (landed && root.position.y > floorY + 3) {
        landed = false;
      }
      // You cannot leave. Breaching would show the sky, and there is no sky.
      if (root.position.y > -1.6) {
        root.position.y = -1.6;
        if (velocity.y > 0) velocity.y = 0;
      }

      const depth = depthOf(root.position.y);
      service.depth = depth;
      service.speed = velocity.dot(forward);

      // -- power ------------------------------------------------------------
      // Lamps are the main draw; thrust costs a little; everything trickles
      // back. Tuned so a careful pilot never runs out and a heavy-handed one
      // has to go dark for a while, which is its own kind of scene.
      // Lamps are *sustainable*. They were not: 0.0125/s of draw against
      // 0.0075/s of regen is a net loss no pilot can win, so the battery
      // emptied after about three minutes and the lamps sat at 35 % for the
      // rest of the dive — which is most of what "the screen is black a lot"
      // turned out to mean. Being in the dark should be a thing you choose, by
      // switching the lamps off, not a thing that creeps up on you. Boost is
      // the only real cost now, and it is the only one you can feel.
      const draw = (lightsOn ? 0.006 : 0) + Math.abs(input.surge) * 0.002 + (boosting ? 0.055 : 0);
      power = THREE.MathUtils.clamp(power - draw * dt + 0.02 * dt, 0, 1);
      service.power = power;

      // -- pressure ---------------------------------------------------------
      if (depth > CRUSH_DEPTH) {
        const over = (depth - CRUSH_DEPTH) / (FLOOR_DEPTH - CRUSH_DEPTH);
        hull = Math.max(0, hull - over * 0.035 * dt);
        if (ctx.rng() < over * dt * 2.2) ctx.emit("sub:groan", { depth, hull });
      } else if (hull < 1) {
        hull = Math.min(1, hull + 0.012 * dt);
      }
      service.hull = hull;

      // -- lamps ------------------------------------------------------------
      // Brightness follows power, so a dying battery dims rather than snapping
      // off — you get to watch it happen and decide what to do about it.
      const want = lightsOn ? 260 * (0.35 + 0.65 * Math.min(1, power * 2.2)) : 0;
      lampL.intensity += (want - lampL.intensity) * Math.min(1, dt * 5);
      lampR.intensity = lampL.intensity;
      // The visible cone follows the lamps, and thickens with depth: there is
      // more to scatter off down there, and it is the clearest signal the
      // player has that the lamps are the only thing left working.
      const beamAlpha = (lampL.intensity / 260) * (0.03 + Math.min(1, depth / 1600) * 0.035);
      for (const b of beams) {
        const bm = b.material as THREE.MeshBasicMaterial;
        bm.opacity = beamAlpha;
        b.visible = beamAlpha > 0.004;
      }
      fill.intensity = 18 + (lightsOn ? 10 : 0);
      const canGlow = lightsOn ? 3 * (0.3 + 0.7 * power) : 0;
      for (const n of ["canL", "canR"]) {
        const can = root.getObjectByName(n) as THREE.Mesh | undefined;
        if (can) (can.material as THREE.MeshStandardMaterial).emissiveIntensity = canGlow;
      }

      // Props spin with thrust.
      const spin = (Math.abs(input.surge) * mult + 0.12) * dt * 14;
      for (const n of ["propL", "propR"]) {
        const p = root.getObjectByName(n);
        if (p) p.rotation.z += spin;
      }
    },

    dispose() {
      ctx.scene.remove(root);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
        if (mat) for (const one of Array.isArray(mat) ? mat : [mat]) one.dispose();
      });
      if (ctx.services.sub === service) delete ctx.services.sub;
    },
  };
}
