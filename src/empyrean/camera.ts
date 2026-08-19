/**
 * The camera rig.
 *
 * A third-person boom that has to work in two worlds at once, and they want
 * opposite things. On the ground it is a shoulder camera in a street eleven
 * metres wide with four-hundred-metre buildings on both sides, so it is
 * constantly about to be inside a wall. In the air it is a chase camera over a
 * six-hundred-metre drop with nothing near it at all, where the only job is to
 * convey speed and let you see where you are going.
 *
 * The whole file is the handful of tricks that make one rig do both:
 *
 *  - **Aim above the head, not at the feet.** Aiming at the body and lifting
 *    the lens tips the view down and the world opens on three-quarters of a
 *    frame of paving. The first build did exactly that.
 *  - **A shoulder offset**, so the character is not parked over the thing you
 *    are trying to look at. It swings to whichever side has more room.
 *  - **Pull in when blocked**, sampled along the boom rather than swept. A
 *    camera that ducks around every one of two hundred buildings never stops
 *    moving; this only fires when the shot is genuinely inside something.
 *  - **FOV rides speed.** Nothing else in the toolbox conveys 34 m/s as
 *    cheaply, and it costs one lerp.
 *  - **The target leads the velocity while flying**, so you are looking where
 *    you are going rather than at where you were.
 */
import * as THREE from "three";

export type CameraMode = "third" | "first";

export interface CameraWorld {
  /** True if a body at (x, z, y) would be inside something solid. */
  blockedAt(x: number, z: number, y: number): boolean;
  /** Highest standable surface at or below `fromY`. */
  supportAt(x: number, z: number, fromY: number): number;
}

export interface CameraInput {
  /** Accumulated look delta in CSS pixels, drained each frame. */
  lookX: number;
  lookY: number;
  /** Multiplied into the boom length. 1 = default. */
  zoom: number;
}

export interface RigTarget {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  grounded: boolean;
  burn: number;
}

const MIN_DIST = 2.2;
const MAX_DIST = 90;
const BASE_FOV = 58;

export class CameraRig {
  yaw: number;
  pitch = 0.14;
  dist = 8.5;
  mode: CameraMode = "third";

  /** How far the camera is allowed to sit right of the boom, metres. */
  private shoulder = 0;
  private shoulderTarget = 0;
  private placed = false;

  private readonly target = new THREE.Vector3();
  private readonly want = new THREE.Vector3();
  private readonly lead = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();

  constructor(yaw: number) {
    this.yaw = yaw;
  }

  reset(yaw: number) {
    this.yaw = yaw;
    this.pitch = 0.14;
    this.dist = 8.5;
    this.placed = false;
  }

  /** Mouse or touch drag. Sensitivity is per CSS pixel, so it is frame-rate
   *  independent and independent of device pixel ratio. */
  look(dx: number, dy: number) {
    this.yaw -= dx * 0.0042;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.0042, -1.05, 1.25);
  }

  zoom(deltaY: number) {
    this.dist = THREE.MathUtils.clamp(this.dist * Math.exp(deltaY * 0.0011), MIN_DIST, MAX_DIST);
    // Dropping under the minimum boom is how you get into first person, and
    // pulling back out is how you leave. No key to remember.
    this.mode = this.dist <= MIN_DIST + 0.01 ? "first" : "third";
  }

  update(
    camera: THREE.PerspectiveCamera,
    p: RigTarget,
    world: CameraWorld,
    dt: number,
  ) {
    /* ---- where we are looking ----
     * Two and a half metres over the character's feet: the horizon lands where
     * a person standing there would find it, and the body sits in the lower
     * third where a third-person camera wants it. */
    this.target.copy(p.position);
    this.target.y += this.mode === "first" ? 1.62 : 2.6;

    if (this.mode === "first") {
      camera.position.copy(this.target);
      const e = new THREE.Euler(this.pitch, this.yaw + Math.PI, 0, "YXZ");
      camera.quaternion.setFromEuler(e);
      this.applyFov(camera, p, dt);
      return;
    }

    /* Lead the velocity while flying. Only in the air, and only at speed —
     * doing it on the ground makes a walk feel like it is being dragged. */
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    const leadAmt = p.grounded ? 0 : Math.min(speed / 34, 1) * 3.2;
    this.lead.set(p.velocity.x, p.velocity.y * 0.35, p.velocity.z);
    if (this.lead.lengthSq() > 0.01) this.lead.normalize().multiplyScalar(leadAmt);
    else this.lead.set(0, 0, 0);
    this.target.add(this.lead);

    /* ---- the boom ---- */
    const cp = Math.cos(this.pitch);
    const bx = Math.sin(this.yaw) * cp;
    const bz = Math.cos(this.yaw) * cp;
    const by = Math.sin(this.pitch);

    /* Shoulder: pick whichever side has room, and ease between them so it
     * does not snap when you turn into an alley. */
    this.right.set(bz, 0, -bx).normalize();
    const trial = (sign: number) => {
      this.probe
        .copy(this.target)
        .addScaledVector(this.right, sign * 1.1)
        .add(
          new THREE.Vector3(bx * this.dist * 0.6, by * this.dist * 0.6, bz * this.dist * 0.6),
        );
      return world.blockedAt(this.probe.x, this.probe.z, this.probe.y) ? 0 : sign;
    };
    this.shoulderTarget = trial(1) || trial(-1) || 0;
    this.shoulder += (this.shoulderTarget * 1.1 - this.shoulder) * Math.min(1, dt * 4);

    this.want.set(
      this.target.x + bx * this.dist + this.right.x * this.shoulder,
      this.target.y + by * this.dist,
      this.target.z + bz * this.dist + this.right.z * this.shoulder,
    );

    /* ---- do not stand in the floor ---- */
    const floor = world.supportAt(this.want.x, this.want.z, this.want.y) + 1.1;
    if (this.want.y < floor) this.want.y = floor;

    /* ---- do not stand in a wall ----
     * Six samples back along the boom, first clear one wins. A real sweep
     * against two hundred buildings would have the camera in permanent motion;
     * this fires only when the shot is actually inside something, which on a
     * street this narrow is often enough that without it the world opens on
     * the inside of a wall. */
    if (world.blockedAt(this.want.x, this.want.z, this.want.y)) {
      let found = false;
      for (let step = 1; step <= 6; step++) {
        const k = 1 - step / 7;
        const tx = this.target.x + (this.want.x - this.target.x) * k;
        const tz = this.target.z + (this.want.z - this.target.z) * k;
        const ty = this.target.y + (this.want.y - this.target.y) * k;
        if (!world.blockedAt(tx, tz, ty)) {
          this.want.set(tx, ty, tz);
          found = true;
          break;
        }
      }
      if (!found) this.want.copy(this.target).addScaledVector(this.right, 0.4);
    }

    /* ---- ease ----
     * The first frame is placed, not lerped. A camera that eases in from the
     * origin spends its first second flying through the mountains. */
    if (this.placed) {
      // Faster when the gap is large (you were teleported) than when it is
      // small (you are walking), so it is both responsive and calm.
      const gap = camera.position.distanceTo(this.want);
      const rate = gap > 25 ? 14 : 8;
      camera.position.lerp(this.want, Math.min(1, dt * rate));
    } else {
      camera.position.copy(this.want);
      this.placed = true;
    }
    camera.lookAt(this.target);
    this.applyFov(camera, p, dt);
  }

  /**
   * Field of view rides speed.
   *
   * Nothing else in the toolbox conveys 34 m/s for one lerp a frame. The
   * numbers are small on purpose: a big FOV punch reads as a fisheye and makes
   * people motion sick, and this world is one you are meant to stay in.
   */
  private applyFov(camera: THREE.PerspectiveCamera, p: RigTarget, dt: number) {
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    const want = BASE_FOV + Math.min(speed / 34, 1.15) * 9 + p.burn * 2.5;
    const next = camera.fov + (want - camera.fov) * Math.min(1, dt * 3);
    if (Math.abs(next - camera.fov) > 0.01) {
      camera.fov = next;
      camera.updateProjectionMatrix();
    }
  }
}
