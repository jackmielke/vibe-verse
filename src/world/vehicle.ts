import * as THREE from "three";
import type { CollisionWorld, InputState } from "./types";

export interface VehicleHandles {
  group: THREE.Group;
  position: THREE.Vector3;
  heading: number;
  speed: number;
  active: boolean;
  driverSeat: () => THREE.Vector3;
  setActive: (a: boolean) => void;
  update: (dt: number, input: InputState, collision: CollisionWorld) => void;
  setHeadlightsOn: (on: boolean) => void;
}

const MAX_FWD = 32; // m/s, ~115 km/h
const MAX_REV = 9;
const ACCEL = 14;
const BRAKE = 26;
const FRICTION = 1.6;
const STEER_RATE = 1.6;
const RADIUS = 1.6;

export function createVehicle(scene: THREE.Scene, start: THREE.Vector3): VehicleHandles {
  const group = new THREE.Group();

  const chassisMat = new THREE.MeshLambertMaterial({
    color: "#d83a3a",
    emissive: "#220000",
  });
  const accentMat = new THREE.MeshLambertMaterial({
    color: "#0d1b2a",
  });
  const glassMat = new THREE.MeshLambertMaterial({
    color: "#3a4a5a",
    emissive: "#0a1018",
  });
  const wheelMat = new THREE.MeshLambertMaterial({ color: "#0a0a0a" });
  const rimMat = new THREE.MeshLambertMaterial({ color: "#7a7a7a" });
  const tailMat = new THREE.MeshBasicMaterial({ color: "#ff2233" });
  const headMat = new THREE.MeshBasicMaterial({ color: "#fff3c2" });

  // Chassis lower
  const lower = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.6, 4.4), chassisMat);
  lower.position.y = 0.55;
  lower.castShadow = true;
  group.add(lower);

  // Chassis upper (cabin)
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.7, 2.4), chassisMat);
  cabin.position.set(0, 1.15, -0.1);
  cabin.castShadow = true;
  group.add(cabin);

  // Windshield + rear glass (one mesh each)
  const front = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 0.05), glassMat);
  front.position.set(0, 1.15, 1.05);
  front.rotation.x = -0.3;
  group.add(front);
  const rear = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 0.05), glassMat);
  rear.position.set(0, 1.18, -1.25);
  rear.rotation.x = 0.3;
  group.add(rear);

  // Bumpers
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.25, 0.2), accentMat);
  bumperF.position.set(0, 0.3, 2.15);
  group.add(bumperF);
  const bumperR = bumperF.clone();
  bumperR.position.z = -2.15;
  group.add(bumperR);

  // Wheels
  const wheelGeom = new THREE.CylinderGeometry(0.45, 0.45, 0.32, 16);
  const rimGeom = new THREE.CylinderGeometry(0.22, 0.22, 0.34, 12);
  const wheels: THREE.Object3D[] = [];
  const positions: [number, number, number][] = [
    [-1.0, 0.45, 1.45],
    [1.0, 0.45, 1.45],
    [-1.0, 0.45, -1.45],
    [1.0, 0.45, -1.45],
  ];
  for (const [x, y, z] of positions) {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(wheelGeom, wheelMat);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    w.add(tire);
    const rim = new THREE.Mesh(rimGeom, rimMat);
    rim.rotation.z = Math.PI / 2;
    w.add(rim);
    w.position.set(x, y, z);
    group.add(w);
    wheels.push(w);
  }

  // Headlights / tails
  const headL = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), headMat);
  headL.position.set(-0.7, 0.65, 2.2);
  group.add(headL);
  const headR = headL.clone();
  headR.position.x = 0.7;
  group.add(headR);
  const tailL = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), tailMat);
  tailL.position.set(-0.75, 0.7, -2.2);
  group.add(tailL);
  const tailR = tailL.clone();
  tailR.position.x = 0.75;
  group.add(tailR);

  // Spotlight cones (visible at night, fake — just cones)
  const coneMat = new THREE.MeshBasicMaterial({
    color: "#fff3c2",
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
  });
  const coneL = new THREE.Mesh(new THREE.ConeGeometry(2, 12, 12, 1, true), coneMat);
  coneL.rotation.x = -Math.PI / 2;
  coneL.position.set(-0.7, 0.65, 8);
  group.add(coneL);
  const coneR = coneL.clone();
  coneR.position.x = 0.7;
  group.add(coneR);

  group.position.copy(start);
  scene.add(group);

  const position = group.position;
  let heading = 0;
  let speed = 0;
  let wheelSpin = 0;
  let active = false;
  let headlightsOn = false;

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
    set speed(v) {
      speed = v;
    },
    get active() {
      return active;
    },
    set active(a) {
      active = a;
    },
    setActive: (a: boolean) => {
      active = a;
    },
    driverSeat: () => {
      // World-space point a meter to the right of the chassis (driver door)
      const local = new THREE.Vector3(1.4, 0, 0);
      return group.localToWorld(local);
    },
    setHeadlightsOn: (on: boolean) => {
      headlightsOn = on;
      (headL.material as THREE.MeshBasicMaterial).color.set(on ? "#fff8d8" : "#a09a78");
      (headR.material as THREE.MeshBasicMaterial).color.set(on ? "#fff8d8" : "#a09a78");
      coneMat.opacity = on ? 0.18 : 0.0;
    },
    update(dt, input, collision) {
      if (!active) {
        // Idle: wheels still, friction slows any residual speed
        speed *= Math.max(0, 1 - FRICTION * dt * 0.5);
      } else {
        // Throttle / brake
        const f = input.forward;
        if (f > 0.05) {
          speed += ACCEL * f * dt;
        } else if (f < -0.05) {
          // Reverse if nearly stopped, otherwise brake
          if (speed > 0.5) {
            speed -= BRAKE * dt;
          } else {
            speed -= ACCEL * 0.7 * dt;
          }
        } else {
          // Coasting
          if (speed > 0) speed = Math.max(0, speed - FRICTION * dt);
          else if (speed < 0) speed = Math.min(0, speed + FRICTION * dt);
        }
        if (input.jump) {
          // Handbrake
          if (speed > 0) speed = Math.max(0, speed - BRAKE * 1.4 * dt);
          else speed = Math.min(0, speed + BRAKE * 1.4 * dt);
        }
        speed = Math.max(-MAX_REV, Math.min(MAX_FWD, speed));

        // Steering — yaw rate scales with absolute speed up to a cap
        const sgn = speed >= 0 ? 1 : -1;
        const yawRate = STEER_RATE * Math.min(1, Math.abs(speed) / 6) * sgn;
        heading += -input.strafe * yawRate * dt;
      }

      // Integrate forward
      const sinH = Math.sin(heading);
      const cosH = Math.cos(heading);
      let nx = position.x + sinH * speed * dt;
      let nz = position.z + cosH * speed * dt;

      const r = collision.resolve(nx, nz, RADIUS);
      if (r.hit) {
        // crunch — bleed speed
        speed *= 0.4;
      }
      nx = r.x;
      nz = r.z;
      position.x = nx;
      position.z = nz;

      // Visuals
      group.rotation.y = heading;
      wheelSpin += (speed / 0.45) * dt;
      const steerAngle = -input.strafe * 0.45;
      // Front wheels steer; all spin
      wheels[0].rotation.y = steerAngle;
      wheels[1].rotation.y = steerAngle;
      wheels.forEach((w) => {
        const tire = w.children[0] as THREE.Mesh;
        tire.rotation.x = wheelSpin;
        const rim = w.children[1] as THREE.Mesh;
        rim.rotation.x = wheelSpin;
      });

      // Subtle pitch under accel/brake
      const targetPitch = -input.forward * 0.04;
      group.rotation.x += (targetPitch - group.rotation.x) * Math.min(1, dt * 4);

      void headlightsOn;
    },
  };
}
