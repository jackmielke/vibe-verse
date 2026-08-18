/**
 * Walking.
 *
 * First Light has no objective, so the movement *is* the experience and it gets
 * more care than a shooter's would. Three things do most of the work:
 *
 *  - **Acceleration, not teleportation.** Velocity is eased toward the wanted
 *    direction rather than set to it. Instant response feels precise and reads
 *    as weightless; a ~150 ms ramp reads as a body.
 *  - **The step, not the bob.** The head rises and falls on a sine, but it also
 *    *rolls* very slightly and the rate is tied to speed rather than to time.
 *    A pure vertical bob at a fixed rate is the seasick one.
 *  - **Wading.** Walk into the shallows and you slow down and sink. It costs
 *    twelve lines and it is the single strongest signal that the water is a
 *    place rather than a texture.
 *
 * Everything is framerate-independent: `1 - exp(-k·dt)` smoothing rather than a
 * fixed lerp factor, which would make the player faster on a 144 Hz monitor.
 */
import * as THREE from "three";
import { WATER_LEVEL, WORLD_SIZE, type Terrain } from "./terrain";

/** Half the basin, which is as far out as anything is placed. */
const WORLD_EDGE = WORLD_SIZE * 0.5;

export interface Player {
  object: THREE.Object3D;
  update(dt: number): void;
  /** How deep the camera is standing in water, in metres. 0 on dry land. */
  readonly wadeDepth: number;
  readonly speed: number;
  setLook(yaw: number, pitch: number): void;
  onMouseMove(dx: number, dy: number): void;
  setKey(code: string, down: boolean): void;
  teleport(x: number, z: number): void;
  dispose(): void;
}

const EYE_HEIGHT = 1.68;
const WALK = 3.1;
const JOG = 6.4;

export function createPlayer(opts: { terrain: Terrain; sensitivity?: number }): Player {
  const { terrain } = opts;
  const sensitivity = opts.sensitivity ?? 0.0022;

  const object = new THREE.Object3D();
  const keys = new Set<string>();
  const velocity = new THREE.Vector3();
  const wanted = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();

  let yaw = Math.PI * 0.82;
  let pitch = -0.04;
  let bobPhase = 0;
  let wade = 0;
  let groundY = 0;
  let smoothY = 0;
  let first = true;

  /* Spawn on the shore, looking across the water.
     Both halves of that matter. The first capture of this world put the player
     on the right patch of ground facing directly away from the lake, up a
     hillside — a world about a lake in which no water was visible. So the
     position is searched for rather than hard-coded (the basin shape has been
     retuned four times and a literal would be stale each time), and the yaw is
     then *derived* from it to point at the origin, which is where the lake is
     by construction. */
  let px = 0;
  let pz = 0;
  const spawn = () => {
    const bearing = Math.PI * 0.82;
    for (let r = 0.46; r > 0.16; r -= 0.008) {
      const x = Math.cos(bearing) * r * WORLD_EDGE;
      const z = Math.sin(bearing) * r * WORLD_EDGE;
      const y = terrain.heightAt(x, z);
      if (y > WATER_LEVEL + 0.35 && y < WATER_LEVEL + 2.6) {
        px = x;
        pz = z;
        break;
      }
    }
    if (px === 0 && pz === 0) {
      px = Math.cos(bearing) * 0.3 * WORLD_EDGE;
      pz = Math.sin(bearing) * 0.3 * WORLD_EDGE;
    }
    /* forward = (-sin(yaw), 0, -cos(yaw)), and we want it pointing at (0,0). */
    yaw = Math.atan2(px, pz);
  };
  spawn();

  const update = (dt: number) => {
    const step = Math.min(dt, 0.05);

    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));

    wanted.set(0, 0, 0);
    if (keys.has("KeyW") || keys.has("ArrowUp")) wanted.add(forward);
    if (keys.has("KeyS") || keys.has("ArrowDown")) wanted.sub(forward);
    if (keys.has("KeyD") || keys.has("ArrowRight")) wanted.add(right);
    if (keys.has("KeyA") || keys.has("ArrowLeft")) wanted.sub(right);

    const jogging = keys.has("ShiftLeft") || keys.has("ShiftRight");
    /* Wading costs you most of your speed. Chest-deep and you are barely
       moving, which is both true and a gentle way of keeping the player out of
       the middle of the lake without an invisible wall. */
    const drag = 1 - Math.min(0.82, wade * 0.62);
    const targetSpeed = (jogging ? JOG : WALK) * drag;

    if (wanted.lengthSq() > 0) wanted.normalize().multiplyScalar(targetSpeed);

    /* Framerate-independent approach. k is higher for stopping than starting:
       you plant a foot faster than you push off. */
    const k = wanted.lengthSq() > 0 ? 9 : 13;
    const t = 1 - Math.exp(-k * step);
    velocity.x += (wanted.x - velocity.x) * t;
    velocity.z += (wanted.z - velocity.z) * t;

    px += velocity.x * step;
    pz += velocity.z * step;

    /* Keep the player inside the bowl. */
    const rad = Math.hypot(px, pz);
    const limit = 355;
    if (rad > limit) {
      px = (px / rad) * limit;
      pz = (pz / rad) * limit;
      velocity.multiplyScalar(0.4);
    }

    groundY = terrain.heightAt(px, pz);
    wade = Math.max(0, WATER_LEVEL - groundY);

    /* The camera follows the ground through a low-pass filter, so walking over
       rough terrain is a gentle rise rather than a staircase of the height
       field's own resolution. */
    const targetY = Math.max(groundY, WATER_LEVEL - 1.35) + EYE_HEIGHT;
    if (first) {
      smoothY = targetY;
      first = false;
    } else {
      smoothY += (targetY - smoothY) * (1 - Math.exp(-11 * step));
    }

    const speed = Math.hypot(velocity.x, velocity.z);
    bobPhase += step * speed * 1.85;
    const bobAmount = Math.min(1, speed / JOG) * 0.055;
    const bobY = Math.sin(bobPhase * 2) * bobAmount;
    const roll = Math.sin(bobPhase) * bobAmount * 0.16;

    object.position.set(px, smoothY + bobY, pz);
    object.rotation.set(pitch, yaw, roll, "YXZ");
  };

  return {
    object,
    update,
    get wadeDepth() {
      return wade;
    },
    get speed() {
      return Math.hypot(velocity.x, velocity.z);
    },
    setLook(y, p) {
      yaw = y;
      pitch = p;
    },
    onMouseMove(dx, dy) {
      yaw -= dx * sensitivity;
      pitch -= dy * sensitivity;
      /* Just short of straight up and down. Exactly ±π/2 gimbal-flips the roll
         term above and snaps the horizon. */
      pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, pitch));
    },
    setKey(code, down) {
      if (down) keys.add(code);
      else keys.delete(code);
    },
    teleport(x, z) {
      px = x;
      pz = z;
      first = true;
    },
    dispose() {
      keys.clear();
    },
  };
}
