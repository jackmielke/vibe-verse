/**
 * proceduralPilot — "Flux", a playable character with no model file.
 *
 * Every other pilot on Vibe Island is a GLB: a mesh someone sculpted, a
 * skeleton someone rigged, and three or four baked clips (idle / walk /
 * run / jump) that we cross-fade between. That works, but the seams show
 * — the walk clip plays at one speed forever, so at 3 m/s the feet skate,
 * and the cross-fade into "run" is a visible pop.
 *
 * Flux is built the other way round. The geometry is assembled here out
 * of primitives, the skeleton is a plain hierarchy of Groups, and there
 * are no clips at all: every joint angle is evaluated from the pilot's
 * actual motion each frame. The stride is a phase accumulator driven by
 * real horizontal speed, so stride *length* grows with speed and the feet
 * never skate — walk becomes run continuously, with nothing to blend.
 *
 * What that buys, beyond not skating:
 *
 *   - Banking. Turn hard and Flux leans into it, because the lean is a
 *     function of yaw rate, not a "turn left" clip.
 *   - Squash and stretch on landing, scaled by how hard you actually hit.
 *   - Secondary motion — crest and scarf are damped springs fed by the
 *     body's own acceleration, so they whip on direction changes and
 *     settle when you stand still. Nothing authored that.
 *   - Idle that isn't a loop: breathing, weight shifts onto alternating
 *     hips, and the occasional look-around, all on different periods so
 *     they never resynchronise into an obvious cycle.
 *
 * Feet sit at local y = 0 and the whole rig stands about 1.8m, matching
 * what City's GLB fit produces, so the pilot swaps in without retuning
 * the camera.
 */
import * as THREE from "three";

export interface PilotFrame {
  /** Horizontal speed, m/s. */
  speed: number;
  /** Standing on something. */
  grounded: boolean;
  /** Vertical velocity, m/s (+up). */
  verticalVel: number;
  /** Yaw change rate, rad/s — drives the bank into turns. */
  yawRate: number;
  /** Jetpack held down: switches to a hover pose. */
  thrusting: boolean;
}

export interface ProceduralPilot {
  /** Feet at local y = 0, facing +Z, ~1.8m tall. */
  group: THREE.Group;
  update(dt: number, frame: PilotFrame): void;
  /** Re-tint the emissive accents (visor, crest, scarf, chest core). */
  setAccent(hex: string): void;
  dispose(): void;
}

/** Critically-ish damped spring toward a target. Returns the new velocity. */
function spring(cur: number, target: number, vel: number, stiffness: number, damping: number, dt: number) {
  return vel + ((target - cur) * stiffness - vel * damping) * dt;
}

/** Frame-rate independent exponential approach — the lerp we actually want. */
const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

export function buildProceduralPilot(accent = "#73ffb8"): ProceduralPilot {
  const group = new THREE.Group();

  // ---- Materials ----------------------------------------------------
  // Shell is flat-shaded so the low-poly facets read as a deliberate
  // style rather than a budget; the accent is emissive so Flux stays
  // legible at night and against the cloud deck.
  // The first pass was several stops too dark: against Vibe Island's
  // bright green lawn and pale sky, a 0x2b3346 shell rendered as a black
  // cut-out with no readable form at all. These are lifted well into the
  // midtones, with a genuinely light plate so the joints separate from
  // the limbs at chase-camera distance.
  const shell = new THREE.MeshStandardMaterial({
    color: 0x4d5a80, roughness: 0.6, metalness: 0.15, flatShading: true,
  });
  const plate = new THREE.MeshStandardMaterial({
    color: 0x9fb0d4, roughness: 0.45, metalness: 0.25, flatShading: true,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent), emissive: new THREE.Color(accent),
    emissiveIntensity: 1.5, roughness: 0.35, metalness: 0,
  });
  // Visor glass: dark, but with enough of the accent in its emissive to
  // stay a *face* at night rather than a hole in the head.
  const dark = new THREE.MeshStandardMaterial({
    color: 0x141a28, emissive: new THREE.Color(accent), emissiveIntensity: 0.22,
    roughness: 0.25, metalness: 0.4,
  });
  const cloth = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent), emissive: new THREE.Color(accent),
    emissiveIntensity: 0.7, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
  });
  const materials = [shell, plate, glow, dark, cloth];
  const geometries: THREE.BufferGeometry[] = [];

  const track = <T extends THREE.BufferGeometry>(g: T): T => { geometries.push(g); return g; };
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => {
    const o = new THREE.Mesh(track(g), m);
    o.castShadow = true;
    return o;
  };
  /** A tapered segment hanging DOWN from its parent's origin. */
  const limb = (len: number, rTop: number, rBot: number, m: THREE.Material) => {
    const o = mesh(new THREE.CylinderGeometry(rTop, rBot, len, 7), m);
    o.position.y = -len / 2;
    return o;
  };

  // ---- Skeleton ------------------------------------------------------
  // Each joint is a Group whose origin IS the pivot, so animating means
  // writing rotations and nothing else.
  const HIP_Y = 0.78;
  const root = new THREE.Group();       // squash/stretch + bob live here
  group.add(root);

  const hips = new THREE.Group();
  hips.position.y = HIP_Y;
  root.add(hips);

  const pelvis = mesh(new THREE.BoxGeometry(0.34, 0.18, 0.24), plate);
  pelvis.position.y = 0.02;
  hips.add(pelvis);

  const torso = new THREE.Group();      // counter-twist + lean
  hips.add(torso);
  const chestMesh = mesh(new THREE.CapsuleGeometry(0.2, 0.26, 3, 8), shell);
  chestMesh.position.y = 0.29;
  chestMesh.scale.set(1.12, 1, 0.82);
  torso.add(chestMesh);
  // Chest core — a slow pulse that doubles as a "you are here" marker.
  const core = mesh(new THREE.IcosahedronGeometry(0.062, 0), glow);
  core.position.set(0, 0.32, 0.17);
  torso.add(core);
  // Shoulder yoke.
  const yoke = mesh(new THREE.BoxGeometry(0.46, 0.09, 0.2), plate);
  yoke.position.y = 0.5;
  torso.add(yoke);

  // Head.
  const neck = new THREE.Group();
  neck.position.y = 0.55;
  torso.add(neck);
  const head = new THREE.Group();
  neck.add(head);
  const skull = mesh(new THREE.CapsuleGeometry(0.15, 0.1, 3, 10), shell);
  skull.position.y = 0.15;
  skull.scale.set(1, 0.95, 1.05);
  head.add(skull);
  // Wraparound visor, with the eyes standing PROUD of the glass. The
  // first cut sank them inside it, which from the front produced a
  // featureless dark blob — the character had no face at all.
  const visor = mesh(new THREE.CapsuleGeometry(0.132, 0.085, 3, 14), dark);
  visor.position.set(0, 0.155, 0.05);
  visor.scale.set(1.02, 0.55, 1.0);
  head.add(visor);
  // Eye slits rather than dots: a horizontal bar keeps its shape at the
  // distance the chase camera actually sits at, where a dot is one pixel.
  const eyeGeo = track(new THREE.BoxGeometry(0.052, 0.026, 0.03));
  const eyes: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, glow);
    eye.position.set(side * 0.058, 0.163, 0.166);
    eye.rotation.z = side * -0.16; // a slight scowl, so it has an attitude
    head.add(eye);
    eyes.push(eye);
  }
  // Chin light — catches the underside of the visor and gives the head a
  // second point of interest from below, which is where the camera is
  // whenever you're jumping.
  const chin = mesh(new THREE.BoxGeometry(0.1, 0.014, 0.02), glow);
  chin.position.set(0, 0.098, 0.14);
  head.add(chin);

  // Crest — three tapering fins with independent spring lag. This is the
  // single loudest piece of secondary motion; it sells acceleration.
  // Three fins running front-to-back along the crown, not stacked end to
  // end — stacking merged them into one thin antenna, which read as a
  // stray wire rather than as part of the character.
  const crestJoints: THREE.Group[] = [];
  {
    let parent: THREE.Object3D = head;
    for (let i = 0; i < 3; i++) {
      const j = new THREE.Group();
      j.position.set(0, i === 0 ? 0.245 : 0, i === 0 ? 0.055 : -0.072);
      parent.add(j);
      // Flattened cones, tallest in front, so the crown has a profile.
      const fin = mesh(new THREE.ConeGeometry(0.045, 0.16 - i * 0.028, 4), glow);
      fin.position.y = (0.16 - i * 0.028) / 2;
      fin.scale.z = 1.5;
      fin.scale.x = 0.42;
      fin.rotation.x = -0.12 - i * 0.06;
      j.add(fin);
      crestJoints.push(j);
      parent = j;
    }
  }

  // Arms: shoulder → elbow → hand.
  type Arm = { shoulder: THREE.Group; elbow: THREE.Group; side: number };
  const arms: Arm[] = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.245, 0.48, 0);
    torso.add(shoulder);
    shoulder.add(mesh(new THREE.SphereGeometry(0.075, 8, 6), plate));
    shoulder.add(limb(0.26, 0.062, 0.05, shell));

    const elbow = new THREE.Group();
    elbow.position.y = -0.26;
    shoulder.add(elbow);
    elbow.add(mesh(new THREE.SphereGeometry(0.052, 8, 6), plate));
    elbow.add(limb(0.24, 0.05, 0.042, shell));

    const hand = mesh(new THREE.IcosahedronGeometry(0.068, 0), plate);
    hand.position.y = -0.26;
    elbow.add(hand);
    // Wrist band, so the arm swing has something bright to trace.
    const band = mesh(new THREE.TorusGeometry(0.055, 0.014, 6, 12), glow);
    band.position.y = -0.225;
    band.rotation.x = Math.PI / 2;
    elbow.add(band);

    arms.push({ shoulder, elbow, side });
  }

  // Legs: hip → knee → foot.
  type Leg = { hip: THREE.Group; knee: THREE.Group; foot: THREE.Group; side: number };
  const legs: Leg[] = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.115, -0.04, 0);
    hips.add(hip);
    hip.add(mesh(new THREE.SphereGeometry(0.078, 8, 6), plate));
    hip.add(limb(0.36, 0.075, 0.058, shell));

    const knee = new THREE.Group();
    knee.position.y = -0.36;
    hip.add(knee);
    knee.add(mesh(new THREE.SphereGeometry(0.058, 8, 6), plate));
    knee.add(limb(0.34, 0.055, 0.045, shell));

    const foot = new THREE.Group();
    foot.position.y = -0.34;
    knee.add(foot);
    const boot = mesh(new THREE.BoxGeometry(0.13, 0.075, 0.235), plate);
    boot.position.set(0, -0.035, 0.045);
    foot.add(boot);
    const sole = mesh(new THREE.BoxGeometry(0.135, 0.022, 0.24), glow);
    sole.position.set(0, -0.074, 0.045);
    foot.add(sole);

    legs.push({ hip, knee, foot, side });
  }

  // Scarf — a chain of quads, each lagging the one above it. Cheap, and
  // it turns every direction change into something you can read.
  // Scarf. It hangs off the LEFT shoulder rather than down the spine —
  // City straps a jetpack to the player's back, which swallowed a
  // centred scarf whole, so the one piece of secondary motion you'd see
  // most often was invisible exactly when the pack was equipped.
  const scarfJoints: THREE.Group[] = [];
  {
    let parent: THREE.Object3D = torso;
    const SEGS = 6;
    for (let i = 0; i < SEGS; i++) {
      const j = new THREE.Group();
      j.position.set(i === 0 ? -0.17 : 0, i === 0 ? 0.48 : -0.145, i === 0 ? -0.05 : 0);
      if (i === 0) j.rotation.z = -0.3; // sweep it clear of the arm
      parent.add(j);
      const w = 0.22 * (1 - i * 0.1);
      const panel = new THREE.Mesh(track(new THREE.PlaneGeometry(w, 0.155)), cloth);
      panel.position.y = -0.078;
      j.add(panel);
      scarfJoints.push(j);
      parent = j;
    }
    // Collar, so the scarf reads as worn rather than stuck on.
    const collar = mesh(new THREE.TorusGeometry(0.115, 0.028, 6, 14), cloth);
    collar.position.y = 0.5;
    collar.rotation.x = Math.PI / 2;
    collar.scale.set(1, 0.8, 1);
    torso.add(collar);
  }

  group.add(root);

  // ---- Animation state ----------------------------------------------
  let stridePhase = 0;      // radians; one full cycle = two steps
  let t = 0;                // seconds since spawn
  let bank = 0, bankV = 0;  // roll into turns
  let lean = 0, leanV = 0;  // pitch from acceleration
  let squash = 1;           // 1 = neutral; <1 compressed after a landing
  let squashV = 0;
  let smoothSpeed = 0;
  let prevSpeed = 0;
  let prevGrounded = true;
  let airTime = 0;
  // Crest/scarf springs: angle + velocity per joint.
  const crestA = crestJoints.map(() => 0), crestV = crestJoints.map(() => 0);
  const scarfA = scarfJoints.map(() => 0), scarfV = scarfJoints.map(() => 0);
  // Rest pose the scarf was built in — the bank is applied on top of it,
  // not instead of it.
  const scarfRestZ = scarfJoints.map((j) => j.rotation.z);
  // Idle direction: blinks and glances fire on their own irregular clocks
  // so the idle never resolves into a visible loop.
  let blinkAt = 2 + Math.random() * 3;
  let blinkFor = 0;
  let glanceAt = 4 + Math.random() * 5;
  let glanceYaw = 0, glanceHold = 0;
  let weightShift = 0;

  const update = (dt: number, f: PilotFrame) => {
    // Guard against tab-switch hitches — a 4-second dt would fling every
    // spring in the rig to infinity.
    dt = Math.min(dt, 0.05);
    t += dt;

    smoothSpeed = approach(smoothSpeed, f.speed, 12, dt);
    const accel = (f.speed - prevSpeed) / Math.max(dt, 1e-4);
    prevSpeed = f.speed;

    // ---- Gait ---------------------------------------------------------
    // Stride frequency rises with the SQUARE ROOT of speed, which is how
    // legs actually work: doubling speed lengthens the stride more than
    // it quickens it. That's what keeps the feet from skating.
    const gait = Math.min(smoothSpeed / 9, 1.35);          // 0..1.35 walk→sprint
    const freq = 2.1 * Math.sqrt(Math.max(gait, 0.0001)) + gait * 1.5;
    if (f.grounded && !f.thrusting) stridePhase += dt * freq * Math.PI * 2;
    const moving = gait > 0.035;
    const swing = Math.min(gait * 1.05, 0.95);              // stride amplitude

    if (!f.grounded) airTime += dt; else airTime = 0;

    // ---- Landing squash ------------------------------------------------
    if (f.grounded && !prevGrounded) {
      // Impact scales with the fall we just absorbed, capped so a long
      // drop doesn't fold Flux into the floor.
      const impact = Math.min(Math.abs(f.verticalVel) / 26, 1);
      squash = 1 - 0.32 * impact;
      squashV = 0;
    }
    prevGrounded = f.grounded;
    squashV = spring(squash, 1, squashV, 210, 16, dt);
    squash += squashV * dt;
    // Volume-preserving-ish: what the body loses in height it gains in width.
    root.scale.set(1 + (1 - squash) * 0.55, squash, 1 + (1 - squash) * 0.55);

    // ---- Bank + lean ---------------------------------------------------
    // Bank comes from yaw rate (lean into the corner), lean from
    // acceleration (lean into the launch, rock back on the brakes).
    const bankTarget = THREE.MathUtils.clamp(-f.yawRate * 0.16, -0.42, 0.42) * Math.min(gait * 1.6, 1);
    bankV = spring(bank, bankTarget, bankV, 90, 13, dt);
    bank += bankV * dt;
    const leanTarget = f.thrusting
      ? 0.22
      : THREE.MathUtils.clamp(accel * 0.012, -0.22, 0.3) + gait * 0.16;
    leanV = spring(lean, leanTarget, leanV, 80, 13, dt);
    lean += leanV * dt;

    // ---- Hips ----------------------------------------------------------
    // Vertical bob peaks twice per stride (once per footfall); lateral
    // sway peaks once, on the loaded leg.
    const bob = moving ? Math.sin(stridePhase * 2) * 0.035 * swing : 0;
    const sway = moving ? Math.sin(stridePhase) * 0.03 * swing : 0;
    // Idle weight shift: settle onto alternating hips on a slow, prime-ish
    // period so it never lines up with the breathing.
    weightShift = approach(weightShift, moving ? 0 : Math.sin(t * 0.55) * 0.028, 3, dt);
    const breathe = moving ? 0 : Math.sin(t * 1.35) * 0.012;

    hips.position.set(sway + weightShift, HIP_Y + bob + breathe, 0);
    hips.rotation.z = bank + (moving ? Math.sin(stridePhase) * 0.05 * swing : weightShift * 1.6);
    hips.rotation.y = moving ? Math.sin(stridePhase) * 0.22 * swing : 0;
    hips.rotation.x = lean * 0.35;

    // Torso counter-twists against the hips — the thing that separates a
    // walk from a shuffle.
    torso.rotation.y = moving ? -Math.sin(stridePhase) * 0.3 * swing : 0;
    torso.rotation.x = lean * 0.5 + (moving ? 0 : Math.sin(t * 1.35) * 0.01);
    torso.rotation.z = -bank * 0.35;

    // ---- Legs -----------------------------------------------------------
    for (const leg of legs) {
      const ph = stridePhase + (leg.side < 0 ? 0 : Math.PI);
      if (f.thrusting) {
        // Hover: knees tucked, feet trailing.
        leg.hip.rotation.x = approach(leg.hip.rotation.x, -0.55 + Math.sin(t * 2 + leg.side) * 0.05, 8, dt);
        leg.knee.rotation.x = approach(leg.knee.rotation.x, 0.95, 8, dt);
        leg.foot.rotation.x = approach(leg.foot.rotation.x, 0.35, 8, dt);
      } else if (!f.grounded) {
        // Airborne: tuck on the way up, reach for the ground on the way
        // down. Blended by airtime so a hop doesn't snap into a skydive.
        const falling = THREE.MathUtils.clamp(-f.verticalVel / 14, 0, 1);
        const blend = Math.min(airTime * 5, 1);
        const tuck = -0.75 + falling * 1.0;
        const bend = 1.15 - falling * 0.85;
        const split = leg.side * 0.12 * (1 - falling);
        leg.hip.rotation.x = approach(leg.hip.rotation.x, tuck + split, 9 * blend + 2, dt);
        leg.knee.rotation.x = approach(leg.knee.rotation.x, bend, 9 * blend + 2, dt);
        leg.foot.rotation.x = approach(leg.foot.rotation.x, -0.15 + falling * 0.4, 8, dt);
      } else if (moving) {
        const s = Math.sin(ph), c = Math.cos(ph);
        // Thigh swings fore/aft; the knee only bends on the return arc
        // (max(0, ...)), which is what stops the classic "wading" look.
        leg.hip.rotation.x = s * 0.72 * swing;
        leg.knee.rotation.x = Math.max(0, -c * 0.5 + 0.28) * 1.35 * swing;
        // Toe-off at the back of the stride, heel-strike at the front.
        leg.foot.rotation.x = (-s * 0.3 - Math.max(0, c) * 0.22) * swing;
        leg.hip.rotation.z = leg.side * 0.02;
      } else {
        // Idle: a soft stance, weight rocking between the legs.
        const load = leg.side * weightShift * 6;
        leg.hip.rotation.x = approach(leg.hip.rotation.x, 0.03 + load * 0.1, 6, dt);
        leg.knee.rotation.x = approach(leg.knee.rotation.x, 0.09 - load * 0.12, 6, dt);
        leg.foot.rotation.x = approach(leg.foot.rotation.x, -0.05, 6, dt);
        leg.hip.rotation.z = approach(leg.hip.rotation.z, leg.side * 0.045, 6, dt);
      }
    }

    // ---- Arms -------------------------------------------------------------
    for (const arm of arms) {
      const ph = stridePhase + (arm.side < 0 ? Math.PI : 0); // opposite the leg
      if (f.thrusting) {
        // Arms back and out, like the thrust is coming off the palms.
        arm.shoulder.rotation.x = approach(arm.shoulder.rotation.x, 0.9, 8, dt);
        arm.shoulder.rotation.z = approach(arm.shoulder.rotation.z, arm.side * 0.5, 8, dt);
        arm.elbow.rotation.x = approach(arm.elbow.rotation.x, -0.5, 8, dt);
      } else if (!f.grounded) {
        const falling = THREE.MathUtils.clamp(-f.verticalVel / 14, 0, 1);
        // Up: arms tight. Down: arms out for balance.
        arm.shoulder.rotation.x = approach(arm.shoulder.rotation.x, -0.5 + falling * 0.35, 9, dt);
        arm.shoulder.rotation.z = approach(arm.shoulder.rotation.z, arm.side * (0.18 + falling * 0.75), 9, dt);
        arm.elbow.rotation.x = approach(arm.elbow.rotation.x, -0.9 + falling * 0.55, 9, dt);
      } else {
        const s = Math.sin(ph);
        arm.shoulder.rotation.x = s * 0.62 * swing + (moving ? 0 : Math.sin(t * 1.35 + arm.side) * 0.02);
        // Elbows stay bent and bend MORE on the forward swing — arms that
        // stay ruler-straight are the giveaway of a cheap walk cycle.
        arm.elbow.rotation.x = -0.22 - Math.max(0, s) * 0.75 * swing;
        arm.shoulder.rotation.z = approach(
          arm.shoulder.rotation.z,
          arm.side * (0.13 + swing * 0.1) + bank * 0.3,
          8, dt,
        );
      }
    }

    // ---- Head -------------------------------------------------------------
    // Counter the bob so the head stays level (real necks stabilise the
    // eyes), then add the glance and a small lead into turns.
    glanceAt -= dt;
    if (glanceAt <= 0 && moving === false) {
      glanceYaw = (Math.random() - 0.5) * 1.0;
      glanceHold = 0.9 + Math.random() * 1.4;
      glanceAt = 5 + Math.random() * 7;
    }
    if (glanceHold > 0) glanceHold -= dt; else glanceYaw = approach(glanceYaw, 0, 3, dt);
    if (moving) glanceYaw = approach(glanceYaw, 0, 6, dt);

    neck.rotation.x = approach(
      neck.rotation.x,
      -lean * 0.65 - bob * 1.4 + (f.grounded ? 0 : THREE.MathUtils.clamp(-f.verticalVel / 30, -0.25, 0.25)),
      10, dt,
    );
    neck.rotation.y = approach(neck.rotation.y, glanceYaw - THREE.MathUtils.clamp(f.yawRate * 0.09, -0.3, 0.3), 8, dt);
    neck.rotation.z = approach(neck.rotation.z, -bank * 0.45, 8, dt);

    // Blink — eyelids are just the eye spheres squashing flat.
    blinkAt -= dt;
    if (blinkAt <= 0) {
      blinkFor = 0.11;
      // Double-blinks happen; a fixed cadence never looks alive.
      blinkAt = Math.random() < 0.22 ? 0.22 : 2.2 + Math.random() * 4;
    }
    if (blinkFor > 0) blinkFor -= dt;
    const lid = blinkFor > 0 ? 0.12 : 1;
    for (const eye of eyes) eye.scale.y = approach(eye.scale.y, lid, 40, dt);

    // Chest core pulse — faster when you're moving, like it's working.
    const pulse = 1 + Math.sin(t * (2.2 + gait * 3)) * 0.14;
    core.scale.setScalar(pulse);
    glow.emissiveIntensity = 1.35 + Math.sin(t * (2.2 + gait * 3)) * 0.3;

    // ---- Secondary motion: crest + scarf ------------------------------------
    // Both chains are driven by the same inputs (acceleration, speed,
    // turn) but with different stiffness, so they never move in lockstep.
    const drag = -Math.min(smoothSpeed * 0.055, 0.55) - THREE.MathUtils.clamp(accel * 0.01, -0.3, 0.3);
    const airLift = f.grounded ? 0 : THREE.MathUtils.clamp(f.verticalVel * 0.02, -0.35, 0.35);
    for (let i = 0; i < crestJoints.length; i++) {
      const target = drag * (0.55 + i * 0.3) + airLift * (0.5 + i * 0.4) + Math.sin(t * 3.1 + i) * 0.02;
      crestV[i] = spring(crestA[i], target, crestV[i], 150 - i * 30, 11, dt);
      crestA[i] += crestV[i] * dt;
      crestJoints[i].rotation.x = crestA[i];
      crestJoints[i].rotation.z = -bank * (0.3 + i * 0.2);
    }
    for (let i = 0; i < scarfJoints.length; i++) {
      // Each segment chases the one above it, which is what produces the
      // whip rather than a rigid flag.
      const upstream = i === 0 ? 0 : scarfA[i - 1];
      const target =
        upstream * 0.55 +
        drag * (0.9 + i * 0.22) +
        airLift * (0.6 + i * 0.3) +
        Math.sin(t * (2.4 + i * 0.37) + i) * (0.035 + smoothSpeed * 0.006);
      scarfV[i] = spring(scarfA[i], target, scarfV[i], 120 - i * 14, 9.5, dt);
      scarfA[i] += scarfV[i] * dt;
      scarfJoints[i].rotation.x = scarfA[i];
      scarfJoints[i].rotation.y = THREE.MathUtils.clamp(-f.yawRate * 0.06 * (i + 1), -0.4, 0.4);
      // Keep the shoulder sweep the rig was built with; bank on top of it.
      scarfJoints[i].rotation.z = scarfRestZ[i] - bank * (0.2 + i * 0.12);
    }
  };

  return {
    group,
    update,
    setAccent(hex: string) {
      const c = new THREE.Color(hex);
      glow.color.copy(c);
      glow.emissive.copy(c);
      cloth.color.copy(c);
      cloth.emissive.copy(c);
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      geometries.length = 0;
    },
  };
}
