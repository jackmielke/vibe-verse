/**
 * San Palmas — the player.
 *
 * A capsule character controller tuned for the Just Cause feel: fast ground
 * speed, generous air control, momentum you keep between traversal states.
 * Owns the camera; the grapple/wingsuit systems steer it by writing straight
 * into `velocity` and flipping `state`.
 *
 * Publishes PlayerService.
 */
import * as THREE from "three";
import type { PlayerService, System, SystemFactory } from "../types";

const EYE_HEIGHT = 1.68;
const CROUCH_EYE = 1.05;
const RADIUS = 0.42;
const WALK_SPEED = 6.2;
const SPRINT_SPEED = 11.5;
const CROUCH_SPEED = 2.8;
const SWIM_SPEED = 4.4;
const ACCEL_GROUND = 62;
const ACCEL_AIR = 14;
const FRICTION = 11;
const GRAVITY = -26;
const JUMP_SPEED = 9.4;
const MAX_STEP = 0.62;
const MAX_SLOPE = Math.cos(THREE.MathUtils.degToRad(52));

const createPlayer: SystemFactory = (ctx) => {
  const camera = ctx.camera;
  /**
   * Read live rather than captured. Systems register in an order that is not
   * guaranteed, and if terrain registers after the player then a captured
   * `const terrain` stays undefined for the entire session — every heightAt
   * falls back to 0, the player stands at y=2 while the city sits tens of
   * metres above, and you spend the game underneath the terrain looking up at
   * the underside of the streets.
   */
  const getTerrain = () => ctx.services.terrain;

  const position = new THREE.Vector3(0, 0, 0);
  const velocity = new THREE.Vector3();
  let yaw = 0;
  let pitch = 0;
  let grounded = false;
  let eyeHeight = EYE_HEIGHT;
  let bobPhase = 0;
  let landingDip = 0;
  let coyote = 0;
  let jumpBuffer = 0;

  // Spawn on the ground near the origin so we never start inside a hill.
  const spawnY = (getTerrain()?.heightAt(0, 0) ?? 0) + 2;
  position.set(0, spawnY, 0);

  /**
   * The origin is downtown, and downtown is where the buildings are — so
   * spawning at (0,0) reliably put the player *inside* one, staring at an
   * interior wall with no way to tell which direction was out. The collision
   * service is not built yet at construction time, so the real spawn is
   * resolved on the first frame that has it.
   *
   * `resolveCapsule` returns true when it had to push the capsule out of
   * something, which is exactly the test for "this spot is occupied". Walk a
   * widening spiral until a clear one turns up; the spiral keeps the player
   * near the intended start rather than teleporting them across the map.
   */
  let spawnResolved = false;
  const findClearSpawn = (): void => {
    const collision = ctx.services.collision;
    const terrain = getTerrain();
    if (!collision || !terrain) return;
    spawnResolved = true;

    // Whatever happens below, get the player onto the ground first.
    position.y = terrain.heightAt(position.x, position.z) + 2;

    const probe = new THREE.Vector3();
    /**
     * Clear means *roomy*, not merely non-overlapping. Testing the capsule
     * alone finds spots flush against a wall, where you spawn nose-to-render
     * with a facade and cannot tell which way is out. Sweeping a capsule four
     * times the player's radius asks for a spot with elbow room — which in a
     * gridded city means the street rather than the gap between two buildings.
     */
    const settle = (x: number, z: number): boolean => {
      probe.set(x, (getTerrain()?.heightAt(x, z) ?? 0) + 2, z);
      return !collision.resolveCapsule(probe, RADIUS * 4, 1.8);
    };

    if (settle(0, 0)) return; // origin was fine after all

    // ~8 m steps out to 160 m, sixteen bearings per ring. Streets in this city
    // are well under 160 m apart, so a clear spot is always within reach.
    for (let r = 8; r <= 160; r += 8) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (settle(x, z)) {
          position.set(x, (getTerrain()?.heightAt(x, z) ?? 0) + 2, z);
          // Face back toward the middle of the map: whatever pushed us out is
          // behind us, and the interesting silhouette is ahead.
          yaw = Math.atan2(x, z);
          return;
        }
      }
    }
  };

  const service: PlayerService = {
    position,
    velocity,
    camera,
    health: 100,
    maxHealth: 100,
    state: "ground",
    damage(amount, from) {
      if (amount <= 0 || this.health <= 0) return;
      this.health = Math.max(0, this.health - amount);
      ctx.emit("palmas:damage", { amount, from: from?.toArray(), health: this.health });
      if (this.health <= 0) ctx.emit("palmas:death");
    },
    teleport(p) {
      position.copy(p);
      velocity.set(0, 0, 0);
    },
  };
  ctx.services.player = service;

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const wish = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();

  /** Accelerate toward `wishDir` — Quake-style, so air-strafing works. */
  function accelerate(dir: THREE.Vector3, wishSpeed: number, accel: number, dt: number) {
    const current = velocity.x * dir.x + velocity.z * dir.z;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const amount = Math.min(accel * dt * wishSpeed, add);
    velocity.x += dir.x * amount;
    velocity.z += dir.z * amount;
  }

  const sys: System = {
    name: "player",
    update(dt) {
      const input = ctx.input;
      const externallyDriven =
        service.state === "grapple" ||
        service.state === "wingsuit" ||
        service.state === "parachute" ||
        service.state === "vehicle";

      // --- Look ---------------------------------------------------------
      yaw += input.lookX;
      pitch += input.lookY;
      pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, pitch));

      // --- Wish direction ----------------------------------------------
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      right.set(Math.cos(yaw), 0, -Math.sin(yaw));
      wish.set(0, 0, 0)
        .addScaledVector(forward, input.moveZ)
        .addScaledVector(right, input.moveX);
      const wishLen = wish.length();
      if (wishLen > 0.0001) wish.divideScalar(wishLen);

      const groundY = getTerrain()?.heightAt(position.x, position.z) ?? 0;
      const seaLevel = getTerrain()?.seaLevel ?? 0;
      const inWater = position.y < seaLevel - 0.4 && groundY < seaLevel;

      if (!externallyDriven) {
        const crouching = input.crouch && grounded;
        const targetEye = crouching ? CROUCH_EYE : EYE_HEIGHT;
        eyeHeight += (targetEye - eyeHeight) * Math.min(1, dt * 14);

        let speed = crouching ? CROUCH_SPEED : input.sprint && input.moveZ > 0 ? SPRINT_SPEED : WALK_SPEED;

        if (inWater) {
          // --- Swimming -------------------------------------------------
          service.state = "water";
          speed = SWIM_SPEED;
          accelerate(wish, speed * wishLen, ACCEL_GROUND * 0.5, dt);
          velocity.y += (input.jump ? 6 : -1.4) * dt * 4;
          velocity.y = THREE.MathUtils.clamp(velocity.y, -6, 5);
          velocity.x -= velocity.x * 2.4 * dt;
          velocity.z -= velocity.z * 2.4 * dt;
        } else if (grounded) {
          // --- Ground ---------------------------------------------------
          service.state = "ground";
          const sp = Math.hypot(velocity.x, velocity.z);
          if (sp > 0.001) {
            // Friction only when there's no input, so stopping is crisp but
            // strafing at speed doesn't feel like mud.
            const drop = Math.max(sp, 4) * FRICTION * dt * (wishLen > 0.1 ? 0.25 : 1);
            const scale = Math.max(0, sp - drop) / sp;
            velocity.x *= scale;
            velocity.z *= scale;
          }
          accelerate(wish, speed * wishLen, ACCEL_GROUND, dt);
          velocity.y = Math.max(velocity.y, -1);
        } else {
          // --- Air ------------------------------------------------------
          service.state = "air";
          accelerate(wish, speed * wishLen, ACCEL_AIR, dt);
          velocity.y += GRAVITY * dt;
        }

        // --- Jump (with coyote time + input buffering) -------------------
        coyote = grounded ? 0.12 : Math.max(0, coyote - dt);
        jumpBuffer = input.pressed.has("Space") ? 0.15 : Math.max(0, jumpBuffer - dt);
        if (jumpBuffer > 0 && coyote > 0 && !inWater) {
          velocity.y = JUMP_SPEED;
          grounded = false;
          coyote = 0;
          jumpBuffer = 0;
          ctx.services.audio?.play("jump", { volume: 0.4 });
        }
      }

      // --- Integrate -----------------------------------------------------
      position.addScaledVector(velocity, dt);

      // --- Collide against city geometry ---------------------------------
      if (!spawnResolved) findClearSpawn();
      ctx.services.collision?.resolveCapsule(position, RADIUS, 1.8);

      // --- Ground / terrain resolve --------------------------------------
      const gy = getTerrain()?.heightAt(position.x, position.z) ?? 0;
      const wasAirborne = !grounded;
      if (position.y <= gy) {
        const slope = getTerrain()?.normalAt(position.x, position.z, normal) ?? normal.set(0, 1, 0);
        if (slope.dot(up) < MAX_SLOPE) {
          // Too steep to stand on — slide down it.
          const slide = normal.clone().projectOnPlane(up).normalize().multiplyScalar(18 * dt);
          velocity.x += slide.x;
          velocity.z += slide.z;
          grounded = false;
          position.y = gy;
          velocity.y = Math.max(velocity.y, GRAVITY * dt);
        } else {
          if (wasAirborne && velocity.y < -8) {
            // Landing: dip the camera, and hurt on a genuinely bad fall.
            landingDip = Math.min(0.42, -velocity.y * 0.022);
            ctx.services.audio?.play("land", { volume: 0.5 });
            if (velocity.y < -24) service.damage((-velocity.y - 24) * 3.4);
          }
          position.y = gy;
          velocity.y = 0;
          grounded = true;
        }
      } else if (position.y > gy + MAX_STEP) {
        grounded = false;
      }

      // Never let the player leave the island bowl.
      const limit = (getTerrain()?.worldSize ?? 3000) * 1.35;
      position.x = THREE.MathUtils.clamp(position.x, -limit, limit);
      position.z = THREE.MathUtils.clamp(position.z, -limit, limit);

      // --- Camera --------------------------------------------------------
      const speedNow = Math.hypot(velocity.x, velocity.z);
      if (grounded && speedNow > 0.6) bobPhase += dt * speedNow * 1.15;
      const bobAmt = grounded ? Math.min(speedNow / SPRINT_SPEED, 1) * 0.055 : 0;
      landingDip *= Math.max(0, 1 - dt * 7);

      camera.position.set(
        position.x + Math.cos(bobPhase * 2) * bobAmt * 0.4,
        position.y + eyeHeight + Math.sin(bobPhase * 4) * bobAmt - landingDip,
        position.z,
      );
      camera.rotation.set(pitch, yaw, Math.sin(bobPhase * 2) * bobAmt * 0.12, "YXZ");

      // Speed-scaled FOV — cheap, and does a lot of the "fast" feeling.
      const targetFov = 68 + THREE.MathUtils.clamp((speedNow - WALK_SPEED) * 0.9, 0, 14);
      if (Math.abs(camera.fov - targetFov) > 0.01) {
        camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 5);
        camera.updateProjectionMatrix();
      }

      ctx.emit("palmas:player", {
        health: service.health,
        speed: speedNow,
        altitude: position.y - gy,
        state: service.state,
        position: [position.x, position.y, position.z],
        yaw,
      });
    },
  };

  return sys;
};

export default createPlayer;
