/**
 * player.ts — you, your jetpack, and the camera behind you.
 *
 * The character is whatever you picked in the lobby, loaded through
 * `@/lib/characterRig` — the same path /city, the profile turntable and the
 * memory garden use. That matters for one specific reason worth repeating:
 * roughly half the catalog has no `.glb` file at all and is assembled from
 * primitives in code, on a *synchronous* branch. Every world that has
 * hand-rolled its own `loader.load(spec.url)` instead has silently rendered
 * nothing for anyone who picked one of those, and found out weeks later.
 *
 * Movement constants come from `@/lib/worldPhysics`, which is the Vibeverse's
 * one set: same gravity, same jump, same run speed as Vibe City. A character
 * who jumps differently in two worlds is a character who feels like two
 * different characters.
 *
 * The jetpack is the thing this world is built around, so it gets an actual
 * design rather than "hold to go up":
 *
 *  - **Fuel is a tank, not a cooldown.** Twelve seconds of continuous burn,
 *    refilling in six on the ground. Long enough to cross downtown at height,
 *    short enough that you plan a route between rooftops.
 *  - **Thrust is stronger than gravity but not by much**, so a full-throttle
 *    climb is a decision. Holding it from the street to the top of the
 *    Transamerica costs most of a tank.
 *  - **Forward flight is faster than a climb.** Push the stick and you go, and
 *    the character tilts into it — the tilt is most of what makes flying feel
 *    like flying rather than like being an elevator.
 */
import * as THREE from "three";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { findCharacter } from "@/lib/characters";
import {
  GRAVITY,
  JUMP_VELOCITY,
  MAX_FALL,
  PLAYER_RADIUS,
  RUN_SPEED,
  WALK_SPEED,
} from "@/lib/worldPhysics";
import { COLORS, addOutline, flat, outlineTree, toon } from "./look";
import { BOUNDS, clampToMap, walkHeight } from "./map";
import type { CityCollision } from "./collision";
import { readIntent, type FriscoInput } from "./input";

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/** Jetpack upward acceleration, m/s². Net climb is this minus gravity. */
const THRUST = 38;
/** Horizontal acceleration while flying, m/s². */
const AIR_ACCEL = 26;
/** Cruising and boosting speeds in the air, m/s. */
const FLY_SPEED = 24;
const FLY_BOOST = 40;
/** Seconds of continuous burn, and seconds to refill from empty on the ground. */
const FUEL_SECONDS = 12;
const REFUEL_SECONDS = 6;
/** Vertical speed clamp under thrust, m/s. */
const MAX_CLIMB = 17;
/** Camera. */
const CAM_DIST_WALK = 6.2;
const CAM_DIST_FLY = 9.4;
const CAM_HEIGHT = 1.6;
const CAM_MIN = 1.4;
const CAM_PROBES = 8;
/** Eye height for the toy character. */
const BODY_HEIGHT = 1.85;

export type Stance = "ground" | "air" | "jet";

export interface PlayerState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Camera yaw/pitch, radians. */
  yaw: number;
  pitch: number;
  grounded: boolean;
  stance: Stance;
  /** 0..1. */
  fuel: number;
  /** Metres above the ground directly below. */
  altitude: number;
  speed: number;
  /** Which way the body is facing, radians. */
  facing: number;
}

export interface PlayerOptions {
  charId: string;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  collision: CityCollision;
  input: FriscoInput;
  spawn: { x: number; z: number; y: number; heading: number };
}

/* ------------------------------------------------------------------ *
 * The jetpack model
 * ------------------------------------------------------------------ */

interface Jetpack {
  group: THREE.Group;
  flames: THREE.Mesh[];
  light: THREE.PointLight;
  dispose(): void;
}

/**
 * A backplate, two tanks, two nozzles and two flames — built from primitives
 * so it fits any character in the catalog without a per-character rig, and
 * outlined so it belongs in this world rather than in the one next door.
 */
function buildJetpack(): Jetpack {
  const group = new THREE.Group();
  const body = toon(0x39424f);
  const trim = toon(COLORS.gold, { emissive: COLORS.gold, emissiveIntensity: 0.35 });
  const geos: THREE.BufferGeometry[] = [];

  const plateG = new THREE.BoxGeometry(0.46, 0.54, 0.16);
  const plate = new THREE.Mesh(plateG, body);
  addOutline(plate, 0.012);
  group.add(plate);
  geos.push(plateG);

  const flames: THREE.Mesh[] = [];
  const flameMat = flat(0x7dfce0, { transparent: true, opacity: 0.92 });
  flameMat.blending = THREE.AdditiveBlending;
  flameMat.depthWrite = false;
  for (const sx of [-0.15, 0.15]) {
    const tankG = new THREE.CapsuleGeometry(0.1, 0.36, 4, 10);
    const tank = new THREE.Mesh(tankG, body);
    tank.position.set(sx, 0.02, -0.13);
    addOutline(tank, 0.012);
    group.add(tank);
    geos.push(tankG);

    const collarG = new THREE.CylinderGeometry(0.06, 0.085, 0.09, 8);
    const collar = new THREE.Mesh(collarG, trim);
    collar.position.set(sx, -0.31, -0.13);
    group.add(collar);
    geos.push(collarG);

    const flameG = new THREE.ConeGeometry(0.075, 0.62, 8);
    const flame = new THREE.Mesh(flameG, flameMat);
    flame.rotation.x = Math.PI;
    flame.position.set(sx, -0.68, -0.13);
    flame.visible = false;
    group.add(flame);
    geos.push(flameG);
    flames.push(flame);
  }

  const light = new THREE.PointLight(0x7dfce0, 0, 14, 2);
  light.position.set(0, -0.3, -0.2);
  group.add(light);

  return {
    group,
    flames,
    light,
    dispose() {
      for (const g of geos) g.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 * The player
 * ------------------------------------------------------------------ */

export class Player {
  readonly state: PlayerState;
  /** Feet at the origin of this group. */
  readonly group = new THREE.Group();

  private rig: CharacterRig | null = null;
  private rigGen = 0;
  private readonly jetpack = buildJetpack();
  private readonly modelHolder = new THREE.Group();
  private readonly opts: PlayerOptions;
  private camDist = CAM_DIST_WALK;
  private tilt = 0;
  private bob = 0;
  private flameT = 0;
  private readonly scratch = {
    // Plain {x,z} rather than a Vector2: the collision world speaks in the
    // ground plane, where the second component is z, and a Vector2's is y.
    flat: { x: 0, z: 0 },
    fwd: new THREE.Vector3(),
    right: new THREE.Vector3(),
    move: new THREE.Vector3(),
    target: new THREE.Vector3(),
    boom: new THREE.Vector3(),
    camPos: new THREE.Vector3(),
  };

  constructor(opts: PlayerOptions) {
    this.opts = opts;
    this.state = {
      position: new THREE.Vector3(opts.spawn.x, opts.spawn.y, opts.spawn.z),
      velocity: new THREE.Vector3(),
      yaw: opts.spawn.heading,
      pitch: -0.12,
      grounded: false,
      stance: "air",
      fuel: 1,
      altitude: 0,
      speed: 0,
      facing: opts.spawn.heading,
    };
    this.group.add(this.modelHolder);
    // The jetpack rides on the model holder so it tilts with the body.
    this.modelHolder.add(this.jetpack.group);
    this.jetpack.group.position.set(0, 1.12, -0.2);
    opts.scene.add(this.group);
    void this.loadCharacter(opts.charId);
  }

  /** Swap the character without disturbing anything else. */
  async loadCharacter(charId: string): Promise<void> {
    const gen = ++this.rigGen;
    const spec = findCharacter(charId);
    try {
      const rig = await loadCharacterRig(
        { url: spec.url, id: spec.id },
        // `center: false` — the rig plants feet at y=0 and we want it standing
        // where the controller says it is, not recentred on its silhouette.
        { height: BODY_HEIGHT, center: false, castShadow: true, walkSpeed: WALK_SPEED },
      );
      if (gen !== this.rigGen) {
        rig.dispose();
        return;
      }
      this.rig?.dispose();
      if (this.rig) this.modelHolder.remove(this.rig.object);
      this.rig = rig;
      this.modelHolder.add(rig.object);
      // A cartoon world wants its character outlined like everything else in
      // it. `outlineTree` collects before it mutates — outlining inside a
      // `traverse` outlines the outlines, forever.
      outlineTree(rig.object, 0.008);
    } catch {
      /* A character that will not load leaves you invisible rather than taking
         the world down. /city learned that one the hard way. */
    }
  }

  /** Put the player somewhere, cleanly. */
  teleport(x: number, z: number, heading: number): void {
    const p = clampToMap(x, z);
    this.state.position.set(p.x, walkHeight(p.x, p.z) + 0.2, p.z);
    this.state.velocity.set(0, 0, 0);
    this.state.yaw = heading;
    this.state.facing = heading;
    this.state.grounded = false;
    this.camDist = CAM_DIST_WALK;
  }

  update(dt: number, elapsed: number): void {
    const s = this.state;
    const { input, collision, camera } = this.opts;

    /* ---- look ---- */
    const SENS = 0.0023;
    s.yaw -= input.lookX * SENS;
    s.pitch -= input.lookY * SENS;
    s.pitch = Math.max(-1.25, Math.min(1.0, s.pitch));
    input.lookX = 0;
    input.lookY = 0;

    const intent = readIntent(input);

    /* ---- the jetpack ---- */
    // Space does two jobs: jump from the ground, throttle in the air. Reading
    // them as one control is what makes leaving the ground feel continuous —
    // you jump, you keep holding, you fly.
    const wantsJet = intent.jet && !s.grounded && s.fuel > 0;
    const jumping = s.grounded && input.consumeJump();
    if (jumping) {
      s.velocity.y = JUMP_VELOCITY;
      s.grounded = false;
    }
    if (wantsJet) {
      s.velocity.y = Math.min(s.velocity.y + THRUST * dt, MAX_CLIMB);
      s.fuel = Math.max(0, s.fuel - dt / FUEL_SECONDS);
      s.stance = "jet";
    } else {
      s.stance = s.grounded ? "ground" : "air";
      if (s.grounded) s.fuel = Math.min(1, s.fuel + dt / REFUEL_SECONDS);
    }

    /* ---- horizontal ---- */
    const cy = Math.cos(s.yaw);
    const sy = Math.sin(s.yaw);
    this.scratch.fwd.set(-sy, 0, -cy);
    this.scratch.right.set(cy, 0, -sy);
    this.scratch.move
      .set(0, 0, 0)
      .addScaledVector(this.scratch.fwd, -intent.z)
      .addScaledVector(this.scratch.right, intent.x);
    const push = Math.min(1, this.scratch.move.length());
    if (push > 1e-3) this.scratch.move.normalize();

    if (s.grounded) {
      const speed = intent.boost ? RUN_SPEED : WALK_SPEED;
      s.velocity.x = this.scratch.move.x * speed * push;
      s.velocity.z = this.scratch.move.z * speed * push;
    } else {
      // In the air you accelerate toward a target rather than snapping to it,
      // which is what gives flight its weight.
      const target = intent.boost ? FLY_BOOST : FLY_SPEED;
      const tx = this.scratch.move.x * target * push;
      const tz = this.scratch.move.z * target * push;
      const k = Math.min(1, (AIR_ACCEL * dt) / Math.max(1, Math.hypot(tx - s.velocity.x, tz - s.velocity.z)));
      s.velocity.x += (tx - s.velocity.x) * Math.max(k, dt * 1.4);
      s.velocity.z += (tz - s.velocity.z) * Math.max(k, dt * 1.4);
    }

    /* ---- settle onto whatever is underfoot, before moving ---- */
    // The vertical resolve comes first so that a character standing inside a
    // step is lifted onto it rather than being shoved sideways out of it.
    if (s.grounded) {
      const here = collision.supportAt(s.position.x, s.position.z, s.position.y + 0.65);
      if (here > s.position.y) s.position.y = here;
    }

    /* ---- integrate + resolve ---- */
    this.scratch.flat.x = s.position.x + s.velocity.x * dt;
    this.scratch.flat.z = s.position.z + s.velocity.z * dt;
    collision.resolve(this.scratch.flat, s.position.y, PLAYER_RADIUS);
    const clamped = clampToMap(this.scratch.flat.x, this.scratch.flat.z);
    s.position.x = clamped.x;
    s.position.z = clamped.z;

    if (!wantsJet) s.velocity.y -= GRAVITY * dt;
    s.velocity.y = Math.max(s.velocity.y, -MAX_FALL);
    let y = s.position.y + s.velocity.y * dt;

    const ceiling = s.grounded ? s.position.y + 0.65 : s.position.y;
    const ground = collision.supportAt(s.position.x, s.position.z, ceiling);
    if (y <= ground) {
      y = ground;
      s.velocity.y = 0;
      s.grounded = true;
    } else if (y - ground > 0.08) {
      s.grounded = false;
    }
    s.position.y = Math.min(y, BOUNDS.skyCeiling);
    if (s.position.y >= BOUNDS.skyCeiling) s.velocity.y = Math.min(0, s.velocity.y);

    s.altitude = s.position.y - walkHeight(s.position.x, s.position.z);
    s.speed = Math.hypot(s.velocity.x, s.velocity.z);

    /* ---- the body ---- */
    this.group.position.copy(s.position);
    if (push > 0.05) {
      const want = Math.atan2(this.scratch.move.x, this.scratch.move.z);
      let d = want - s.facing;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      s.facing += d * Math.min(1, dt * 11);
    }
    this.group.rotation.y = s.facing;

    // Tilt into the direction of travel while airborne. This is the single
    // cheapest thing that makes flying read as flying.
    const wantTilt = s.grounded ? 0 : Math.min(0.44, s.speed / FLY_BOOST) * (push > 0.05 ? 1 : 0);
    this.tilt += (wantTilt - this.tilt) * Math.min(1, dt * 6);
    this.modelHolder.rotation.x = this.tilt;
    // A small hover bob so a stationary jetpack does not look frozen.
    if (s.stance === "jet") {
      this.bob += dt * 7;
      this.modelHolder.position.y = Math.sin(this.bob) * 0.05;
    } else {
      this.modelHolder.position.y *= 0.86;
    }

    if (this.rig) {
      this.rig.setLocomotion(s.grounded ? Math.min(1, s.speed / WALK_SPEED) : 0.15);
      if (this.rig.mixer) this.rig.mixer.timeScale = s.speed > WALK_SPEED + 0.5 ? 1.55 : 1;
      this.rig.update(dt);
    }

    /* ---- flames ---- */
    this.flameT += dt;
    const burning = s.stance === "jet";
    for (let i = 0; i < this.jetpack.flames.length; i++) {
      const f = this.jetpack.flames[i];
      f.visible = burning;
      if (burning) {
        const flick = 0.75 + Math.sin(this.flameT * 34 + i * 2.1) * 0.25;
        f.scale.set(1, flick, 1);
      }
    }
    this.jetpack.light.intensity = burning ? 5.5 + Math.sin(this.flameT * 26) * 1.6 : 0;

    /* ---- camera ---- */
    this.updateCamera(dt, camera, collision);
  }

  private updateCamera(dt: number, camera: THREE.PerspectiveCamera, collision: CityCollision): void {
    const s = this.state;
    this.scratch.target.set(s.position.x, s.position.y + CAM_HEIGHT, s.position.z);
    const cp = Math.cos(s.pitch);
    const sp = Math.sin(s.pitch);
    this.scratch.boom.set(Math.sin(s.yaw) * cp, -sp, Math.cos(s.yaw) * cp).normalize();

    // Pull back when flying: you need to see more of where you are going, and
    // a wider shot is what makes the city read as a model you are above.
    const rest = s.grounded ? CAM_DIST_WALK : CAM_DIST_FLY;
    let want = rest;
    for (let i = 1; i <= CAM_PROBES; i++) {
      const d = (rest * i) / CAM_PROBES;
      this.scratch.camPos.copy(this.scratch.target).addScaledVector(this.scratch.boom, d);
      if (collision.occupied(this.scratch.camPos.x, this.scratch.camPos.y, this.scratch.camPos.z)) {
        want = Math.max(CAM_MIN, (rest * (i - 1)) / CAM_PROBES);
        break;
      }
    }
    // Snap in hard, ease out slow: a camera that eases INTO a wall spends the
    // easing inside it.
    this.camDist = want < this.camDist ? want : this.camDist + (want - this.camDist) * Math.min(1, dt * 2.6);
    this.scratch.camPos.copy(this.scratch.target).addScaledVector(this.scratch.boom, this.camDist);
    camera.position.lerp(this.scratch.camPos, Math.min(1, dt * 18));
    camera.lookAt(this.scratch.target);
  }

  dispose(): void {
    this.rigGen++;
    this.rig?.dispose();
    this.rig = null;
    this.jetpack.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
