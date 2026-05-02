import * as THREE from "three";
import type { CollisionWorld, InputState } from "./types";

export interface PlayerHandles {
  group: THREE.Group;
  position: THREE.Vector3;
  heading: number;
  speed: number;
  active: boolean;
  setActive: (a: boolean) => void;
  update: (dt: number, input: InputState, collision: CollisionWorld) => void;
}

const RADIUS = 0.6;
const WALK_SPEED = 5.5;
const RUN_SPEED = 10.5;
const JUMP_VEL = 7.5;
const GRAVITY = 24;

export function createPlayer(scene: THREE.Scene): PlayerHandles {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshLambertMaterial({ color: "#2dd4a8" });
  const headMat = new THREE.MeshLambertMaterial({ color: "#f0fdf9" });
  const limbMat = new THREE.MeshLambertMaterial({ color: "#0d1b2a" });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 6, 12), bodyMat);
  body.position.y = 0.9;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), headMat);
  head.position.y = 1.85;
  head.castShadow = true;
  group.add(head);

  const armGeom = new THREE.CapsuleGeometry(0.13, 0.6, 4, 8);
  const armL = new THREE.Mesh(armGeom, limbMat);
  armL.position.set(-0.5, 1.0, 0);
  armL.castShadow = true;
  group.add(armL);
  const armR = armL.clone();
  armR.position.x = 0.5;
  group.add(armR);

  const legGeom = new THREE.CapsuleGeometry(0.18, 0.6, 4, 8);
  const legL = new THREE.Mesh(legGeom, limbMat);
  legL.position.set(-0.22, 0.3, 0);
  legL.castShadow = true;
  group.add(legL);
  const legR = legL.clone();
  legR.position.x = 0.22;
  group.add(legR);

  group.position.set(0, 0, 18);
  scene.add(group);

  const position = group.position;
  let heading = 0;
  let velY = 0;
  let onGround = true;
  let bobPhase = 0;
  let speed = 0;
  let active = true;

  return {
    group,
    position,
    get heading() {
      return heading;
    },
    set heading(v) {
      heading = v;
    },
    get speed() {
      return speed;
    },
    set speed(_) {
      // intentional setter no-op (read mostly via getter)
    },
    get active() {
      return active;
    },
    set active(a) {
      active = a;
      group.visible = a;
    },
    setActive(a) {
      active = a;
      group.visible = a;
    },
    update(dt, input, collision) {
      if (!active) return;

      // Yaw is driven by mouse via input.yaw (consumed each tick)
      heading = input.yaw;

      const targetSpeed = (input.run ? RUN_SPEED : WALK_SPEED);
      const f = input.forward;
      const s = input.strafe;
      const len = Math.hypot(f, s) || 1;
      const fwdN = f / len;
      const strN = s / len;
      const moving = Math.abs(f) > 0.05 || Math.abs(s) > 0.05;
      const desired = moving ? targetSpeed * Math.min(1, Math.hypot(f, s)) : 0;
      speed += (desired - speed) * Math.min(1, dt * 8);

      const sinH = Math.sin(heading);
      const cosH = Math.cos(heading);
      const dx = (sinH * fwdN + cosH * strN) * speed * dt;
      const dz = (cosH * fwdN - sinH * strN) * speed * dt;

      let nx = position.x + dx;
      let nz = position.z + dz;
      const r = collision.resolve(nx, nz, RADIUS);
      nx = r.x;
      nz = r.z;
      position.x = nx;
      position.z = nz;

      // Jump + gravity
      if (input.jump && onGround) {
        velY = JUMP_VEL;
        onGround = false;
      }
      velY -= GRAVITY * dt;
      position.y += velY * dt;
      if (position.y <= 0) {
        position.y = 0;
        velY = 0;
        onGround = true;
      }

      // Face heading
      group.rotation.y = heading;

      // Walk bob
      if (moving && onGround) {
        bobPhase += dt * (input.run ? 14 : 9);
        const bob = Math.sin(bobPhase) * (input.run ? 0.08 : 0.05);
        body.position.y = 0.9 + bob;
        head.position.y = 1.85 + bob;
        armL.rotation.x = Math.sin(bobPhase) * 0.7;
        armR.rotation.x = -Math.sin(bobPhase) * 0.7;
        legL.rotation.x = -Math.sin(bobPhase) * 0.7;
        legR.rotation.x = Math.sin(bobPhase) * 0.7;
      } else {
        // ease back to neutral
        armL.rotation.x *= 0.85;
        armR.rotation.x *= 0.85;
        legL.rotation.x *= 0.85;
        legR.rotation.x *= 0.85;
      }
    },
  };
}
