/**
 * helicopter — a little red chopper on a helipad in Vibe City that you can
 * fly.
 *
 * It is a mount, like Pegasus and the turkey, so it rides on exactly the same
 * flight code (`stepMount` with the "helicopter" tune): W/S is forward and
 * back, A/D turns, Space climbs and C comes down. The tune is what makes it a
 * helicopter rather than a bird: it does not cruise, so with your hands off
 * the keys it hovers where it is, and it does not sink, so it holds its
 * height. It sits 0.6 m off the ground on its skids instead of the 2.5 m a
 * flying horse hovers at.
 *
 * Built facing +Z with its origin at the skids' rest height, same pose shape
 * as `PegasusWorld`, so the city treats it as one more creature.
 */
import * as THREE from "three";
import type { PegasusWorld } from "./pegasus";

export function buildHelicopter(rest: { x: number; y: number; z: number; yaw: number }): PegasusWorld {
  const group = new THREE.Group();
  group.name = "helicopter";
  const body = new THREE.Group();
  group.add(body);
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const mat = <M extends THREE.Material>(m: M) => {
    mats.push(m);
    return m;
  };
  const red = mat(new THREE.MeshStandardMaterial({ color: 0xd8342c, roughness: 0.4, metalness: 0.25 }));
  const white = mat(new THREE.MeshStandardMaterial({ color: 0xf1f2f4, roughness: 0.45, metalness: 0.2 }));
  const dark = mat(new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6, metalness: 0.5 }));
  const glass = mat(new THREE.MeshStandardMaterial({
    color: 0x9fd4ff, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false,
  }));
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = m !== glass;
    parent.add(mesh);
    return mesh;
  };

  // The tub you sit in, the bubble over it, and the engine hump behind.
  add(new THREE.BoxGeometry(1.7, 0.9, 2.6), red, 0, 0.75, 0.1);
  add(new THREE.BoxGeometry(1.72, 0.18, 2.62), white, 0, 1.05, 0.1);
  const bubble = add(new THREE.SphereGeometry(1, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), glass, 0, 1.2, 0.35);
  bubble.scale.set(0.95, 1.35, 1.45);
  add(new THREE.BoxGeometry(1.2, 0.9, 1.3), red, 0, 1.55, -1.25);
  // Tail boom, fin and tail rotor.
  add(new THREE.CylinderGeometry(0.16, 0.3, 4.6, 10).rotateX(Math.PI / 2), red, 0, 1.45, -3.6);
  add(new THREE.BoxGeometry(0.1, 1.1, 0.7), white, 0, 1.95, -5.7);
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.16, 1.95, -5.75);
  body.add(tailRotor);
  add(new THREE.BoxGeometry(0.04, 1.3, 0.14), dark, 0, 0, 0, tailRotor);
  // Mast and main rotor.
  add(new THREE.CylinderGeometry(0.09, 0.09, 0.7, 8), dark, 0, 2.25, -0.9);
  const rotor = new THREE.Group();
  rotor.position.set(0, 2.62, -0.9);
  body.add(rotor);
  add(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 10), dark, 0, 0, 0, rotor);
  for (let i = 0; i < 2; i++) {
    const blade = add(new THREE.BoxGeometry(9, 0.05, 0.3), dark, 0, 0.04, 0, rotor);
    blade.rotation.y = (i * Math.PI) / 2;
  }
  // Skids.
  for (const sx of [-0.95, 0.95]) {
    add(new THREE.CylinderGeometry(0.07, 0.07, 3.4, 8).rotateX(Math.PI / 2), dark, sx, -0.55, 0.05);
    for (const sz of [-0.8, 0.9]) {
      const strut = add(new THREE.CylinderGeometry(0.05, 0.05, 0.95, 6), dark, sx * 0.85, -0.1, sz);
      strut.rotation.z = sx * 0.25;
    }
  }

  // The pad it waits on: a white ring and an H, flat on the ground.
  const pad = new THREE.Group();
  pad.position.set(rest.x, rest.y - 0.58, rest.z);
  group.add(pad);
  const padMat = mat(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
  const ring = add(new THREE.RingGeometry(4.2, 4.6, 48), padMat, 0, 0, 0, pad);
  ring.rotation.x = -Math.PI / 2;
  for (const [w, d, x] of [[0.45, 3.2, -1], [0.45, 3.2, 1], [2, 0.45, 0]] as const) {
    const bar = add(new THREE.PlaneGeometry(w, d), padMat, x, 0, 0, pad);
    bar.rotation.x = -Math.PI / 2;
  }

  let spin = 0;
  const world: PegasusWorld = {
    group,
    body,
    pose: null,
    update(dt) {
      const pose = this.pose;
      if (pose) {
        body.position.set(pose.x, pose.y, pose.z);
        // Nose down a touch when climbing hard, bank into turns.
        body.rotation.set(pose.flap ? -0.05 : 0.04, pose.yaw, pose.bank * 0.6, "YXZ");
        spin = Math.min(42, spin + dt * 30);
      } else {
        body.position.set(rest.x, rest.y, rest.z);
        body.rotation.set(0, rest.yaw, 0);
        spin = Math.max(0, spin - dt * 10);
      }
      rotor.rotation.y += spin * dt;
      tailRotor.rotation.x += spin * 1.6 * dt;
    },
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      group.removeFromParent();
    },
  };
  world.update(0, 0);
  return world;
}
