/**
 * The rider, built from primitives so it works in both looks with no model.
 * Painted: the girl from the frame, bob hair, blue shirt, orange backpack, an
 * orange board on green wheels. Lens: helmet, dark tee, baggy light jeans, a
 * black board, and a carve with one hand reaching for the road.
 */
import * as THREE from "three";
import type { Style } from "./road";

export interface Rider {
  group: THREE.Group;
  /** lean -1..1, crouch 0..1, air 0..1 (height above the road in metres, roughly), t seconds. */
  pose(lean: number, crouch: number, air: number, t: number, speed: number): void;
  dispose(): void;
}

function toon3(): THREE.DataTexture {
  const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export function buildRider(style: Style): Rider {
  const painted = style === "painted";
  const grad = toon3();
  const mat = (color: number) => (painted ? new THREE.MeshToonMaterial({ color, gradientMap: grad }) : new THREE.MeshLambertMaterial({ color }));

  const skin = mat(painted ? 0xf3c9a2 : 0xe4b895);
  const shirt = mat(painted ? 0x2f6fd6 : 0x2b2e36);
  const shorts = mat(painted ? 0x2a5cb8 : 0xa9bfd6);
  const hair = mat(painted ? 0x5a3220 : 0x1f2126);
  const pack = mat(0xd9862e);
  const deck = mat(painted ? 0xe8632b : 0x1a1a1a);
  const wheel = mat(painted ? 0x8fd63a : 0x8a8a8a);
  const shoe = mat(painted ? 0x2b3b8f : 0xf0f0f0);

  const group = new THREE.Group();
  const body = new THREE.Group(); // everything that leans
  group.add(body);

  // Board. Forward is +z.
  const board = new THREE.Group();
  const deckMesh = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, 1.0, 1, 1, 4), deck);
  deckMesh.position.y = 0.11;
  board.add(deckMesh);
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 10), deck);
  nose.position.set(0, 0.11, 0.5);
  const tail = nose.clone();
  tail.position.z = -0.5;
  board.add(nose, tail);
  const wg = new THREE.CylinderGeometry(0.045, 0.045, 0.05, 10);
  wg.rotateZ(Math.PI / 2);
  for (const [x, z] of [
    [-0.14, 0.34],
    [0.14, 0.34],
    [-0.14, -0.34],
    [0.14, -0.34],
  ]) {
    const w = new THREE.Mesh(wg, wheel);
    w.position.set(x, 0.045, z);
    board.add(w);
  }
  body.add(board);

  // Legs.
  const legGeo = new THREE.CylinderGeometry(0.07, 0.06, 0.62, 8);
  legGeo.translate(0, 0.31, 0);
  const legL = new THREE.Mesh(legGeo, painted ? skin : shorts);
  const legR = new THREE.Mesh(legGeo, painted ? skin : shorts);
  legL.position.set(-0.12, 0.13, 0.2);
  legR.position.set(0.12, 0.13, -0.18);
  legL.rotation.y = 0.5;
  legR.rotation.y = 0.5;
  const shoeGeo = new THREE.BoxGeometry(0.11, 0.07, 0.25);
  const shoeL = new THREE.Mesh(shoeGeo, shoe);
  const shoeR = new THREE.Mesh(shoeGeo, shoe);
  shoeL.position.set(-0.12, 0.16, 0.2);
  shoeR.position.set(0.12, 0.16, -0.18);
  shoeL.rotation.y = 0.5;
  shoeR.rotation.y = 0.5;
  body.add(legL, legR, shoeL, shoeR);

  // Hips and torso.
  const torso = new THREE.Group();
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.26, 0.24), shorts);
  hips.position.y = 0.86;
  const chest = new THREE.Mesh(new THREE.BoxGeometry(painted ? 0.42 : 0.44, 0.5, 0.26), shirt);
  chest.position.y = 1.22;
  torso.add(hips, chest);
  if (painted) {
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.2), pack);
    bag.position.set(0, 1.18, -0.22);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.06), mat(0xc0702a));
    flap.position.set(0, 1.34, -0.34);
    torso.add(bag, flap);
  }
  // Arms.
  const armGeo = new THREE.CylinderGeometry(0.05, 0.045, 0.56, 8);
  armGeo.translate(0, -0.28, 0);
  const armL = new THREE.Mesh(armGeo, painted ? shirt : skin);
  const armR = new THREE.Mesh(armGeo, painted ? shirt : skin);
  armL.position.set(-0.27, 1.42, 0);
  armR.position.set(0.27, 1.42, 0);
  torso.add(armL, armR);
  // Head.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 12), skin);
  head.position.y = 1.64;
  torso.add(head);
  if (painted) {
    const bob = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), hair);
    bob.position.y = 1.67;
    bob.scale.set(1, 1.05, 1.05);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.16), hair);
    back.position.set(0, 1.56, -0.08);
    torso.add(bob, back);
  } else {
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.175, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), hair);
    helmet.position.y = 1.655;
    torso.add(helmet);
  }
  body.add(torso);

  const parts: THREE.Mesh[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) parts.push(o as THREE.Mesh);
  });

  return {
    group,
    pose(lean, crouch, air, t, speed) {
      const l = Math.max(-1, Math.min(1, lean));
      // The board tilts with the carve, the body leans further into it.
      board.rotation.z = -l * 0.22;
      body.rotation.z = -l * 0.34;
      const c = Math.max(0, Math.min(1, crouch));
      const airK = Math.min(1, air / 1.2);
      // Crouch: torso comes down, knees bend (legs shorten).
      const legScale = 1 - c * 0.28 - airK * 0.3;
      legL.scale.y = legScale;
      legR.scale.y = legScale;
      torso.position.y = -(1 - legScale) * 0.62;
      torso.rotation.x = c * 0.55 + Math.sin(t * 2.2) * 0.02 + Math.min(0.25, speed * 0.012);
      // In the air the board comes up with the feet.
      board.position.y = airK * 0.22;
      shoeL.position.y = 0.16 + airK * 0.22;
      shoeR.position.y = 0.16 + airK * 0.22;
      legL.position.y = 0.13 + airK * 0.22;
      legR.position.y = 0.13 + airK * 0.22;
      if (painted) {
        // Relaxed arms that swing a little with the wind and the lean.
        armL.rotation.z = 0.25 + l * 0.35 + Math.sin(t * 1.7) * 0.06;
        armR.rotation.z = -0.25 + l * 0.35 - Math.sin(t * 1.9) * 0.06;
        armL.rotation.x = 0.15;
        armR.rotation.x = 0.15;
      } else {
        // The carve: one arm out, the other reaching for the road on a hard lean.
        const hard = Math.max(0, Math.abs(l) - 0.45) / 0.55;
        armL.rotation.z = 0.9 + l * 0.6 + (l < 0 ? hard * 1.4 : 0);
        armR.rotation.z = -0.9 + l * 0.6 - (l > 0 ? hard * 1.4 : 0);
        armL.rotation.x = 0.4 + c * 0.3;
        armR.rotation.x = 0.4 + c * 0.3;
      }
    },
    dispose() {
      for (const p of parts) {
        p.geometry.dispose();
        (p.material as THREE.Material).dispose();
      }
      grad.dispose();
    },
  };
}
