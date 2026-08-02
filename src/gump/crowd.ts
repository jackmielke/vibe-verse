/**
 * The people running behind you.
 *
 * By the end of the finale there are forty of them, and forty copies of the
 * box rig in `rig.ts` would be roughly eight hundred meshes — enough to put a
 * phone on the floor for a crowd nobody is looking at closely. So the crowd is
 * six InstancedMeshes (torso, head, two legs, two arms) and one dummy matrix
 * reused for every limb of every follower: six draw calls whether there is one
 * of them or a hundred.
 *
 * They are not clones of each other. Each follower carries a stride offset, a
 * lane, a lag and a height, all fixed at birth, so the crowd breathes instead
 * of pulsing as one animal — which is the only thing you would actually notice
 * about it from in front.
 */
import * as THREE from "three";

export interface Crowd {
  group: THREE.Group;
  /** How many are following. Ramped by the chapter as you pick people up. */
  setCount(n: number): void;
  /**
   * How far back the last of them is running, in metres. The camera needs
   * this: a chase camera nearer than the back row leaves most of the crowd
   * behind the lens and the rest below the bottom of the frame.
   */
  depth(): number;
  update(dt: number, phase: number, playerX: number, effort: number): void;
  dispose(): void;
}

interface Follower {
  lane: number;
  lag: number;
  height: number;
  offset: number;
  /** Their own wander, so the pack is not a lattice. */
  wander: number;
}

const SHIRTS = [
  0xb8452c, 0x2f5d7a, 0xd8cfa8, 0x3a5a3a, 0xe0b53a, 0x7a4a7a, 0xc96f3a, 0x4a6f8a,
  0xdedad0, 0x8a3a3a,
];

export function makeCrowd(max: number): Crowd {
  const group = new THREE.Group();

  /* Geometry is pre-translated so each piece hangs *below* its own origin.
     That is what lets one dummy matrix drive a hip joint: set the position to
     the hip and the rotation to the swing, and the limb pivots correctly with
     no parent transform anywhere. */
  const torsoGeo = new THREE.BoxGeometry(0.42, 0.6, 0.24);
  const headGeo = new THREE.BoxGeometry(0.23, 0.27, 0.23);
  const legGeo = new THREE.BoxGeometry(0.14, 0.82, 0.14).translate(0, -0.41, 0);
  const armGeo = new THREE.BoxGeometry(0.11, 0.62, 0.11).translate(0, -0.31, 0);

  const skinMat = new THREE.MeshLambertMaterial({ color: 0xd9a37a });
  const shirtMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const pantMat = new THREE.MeshLambertMaterial({ color: 0x3b4a63 });

  const torso = new THREE.InstancedMesh(torsoGeo, shirtMat, max);
  const head = new THREE.InstancedMesh(headGeo, skinMat, max);
  const legL = new THREE.InstancedMesh(legGeo, pantMat, max);
  const legR = new THREE.InstancedMesh(legGeo, pantMat, max);
  const armL = new THREE.InstancedMesh(armGeo, shirtMat, max);
  const armR = new THREE.InstancedMesh(armGeo, shirtMat, max);
  const parts = [torso, head, legL, legR, armL, armR];
  for (const p of parts) {
    p.count = 0;
    p.frustumCulled = false;
    group.add(p);
  }

  const col = new THREE.Color();
  const dummy = new THREE.Object3D();

  /*
   * Ranks: wide and shallow, not a long column.
   *
   * Both halves of that matter, and both were learned the hard way. A chase
   * camera sits behind the runner, so everyone following him is *between* the
   * lens and him — a deep column needs the camera thirty metres back before
   * the last rank is even in shot, by which point the man you are playing is a
   * speck. Rows that get wider as they go back (five, then seven, then nine)
   * fit forty people into sixteen metres of road, which is a camera pull-back
   * you can afford.
   */
  const people: Follower[] = [];
  const ROW0 = 7.5;
  const ROW_GAP = 2.2;
  for (let i = 0, row = 0; i < max; row++) {
    const cap = 5 + row * 2;
    for (let k = 0; k < cap && i < max; k++, i++) {
      people.push({
        lane: (k - (cap - 1) / 2) * 1.55 + Math.sin(i * 12.9898) * 0.45,
        lag: ROW0 + row * ROW_GAP + Math.abs(Math.sin(i * 78.233)) * 1.1,
        height: 0.86 + Math.abs(Math.sin(i * 4.1)) * 0.28,
        offset: (i * 1.7) % (Math.PI * 2),
        wander: Math.sin(i * 33.7) * 0.9,
      });
      col.setHex(SHIRTS[i % SHIRTS.length]);
      torso.setColorAt(i, col);
      armL.setColorAt(i, col);
      armR.setColorAt(i, col);
      col.setHSL(0.08, 0.3, 0.3 + ((i * 37) % 5) * 0.08);
      legL.setColorAt(i, col);
      legR.setColorAt(i, col);
    }
  }
  for (const p of parts) if (p.instanceColor) p.instanceColor.needsUpdate = true;

  let count = 0;
  let t = 0;

  function setCount(n: number) {
    count = THREE.MathUtils.clamp(Math.round(n), 0, max);
    for (const p of parts) p.count = count;
  }

  function update(dt: number, phase: number, playerX: number, effort: number) {
    if (!count) return;
    t += dt;
    const swing = 0.4 + effort * 0.7;

    for (let i = 0; i < count; i++) {
      const f = people[i];
      const ph = phase * (0.94 + (i % 5) * 0.03) + f.offset;
      const sw = Math.sin(ph);
      // They follow where you *were*, not where you are — a crowd that tracks
      // your steering frame-for-frame reads as a rigid formation glued to your
      // back. The lag scales with how far back they are.
      const x = playerX * (1 - f.lag * 0.02) + f.lane + Math.sin(t * 0.7 + f.wander * 4) * 0.35;
      const z = f.lag + Math.sin(t * 1.3 + f.offset) * 0.4;
      const bob = Math.abs(sw) * 0.05 * effort;
      const s = f.height;

      dummy.position.set(x, 0.92 * s + 0.3 * s + bob, z);
      dummy.rotation.set(0.12 + effort * 0.16, Math.PI, 0);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      torso.setMatrixAt(i, dummy.matrix);

      dummy.position.y = 0.92 * s + 0.75 * s + bob;
      dummy.rotation.set(0, Math.PI, 0);
      dummy.updateMatrix();
      head.setMatrixAt(i, dummy.matrix);

      for (const [k, leg] of [legL, legR].entries()) {
        const dir = k === 0 ? 1 : -1;
        dummy.position.set(x + dir * 0.12 * s, 0.92 * s + bob, z);
        dummy.rotation.set(sw * dir * swing, Math.PI, 0);
        dummy.updateMatrix();
        leg.setMatrixAt(i, dummy.matrix);
      }

      for (const [k, arm] of [armL, armR].entries()) {
        const dir = k === 0 ? -1 : 1;
        dummy.position.set(x + (k === 0 ? -1 : 1) * 0.27 * s, 0.92 * s + 0.56 * s + bob, z);
        dummy.rotation.set(sw * dir * swing * 0.85, Math.PI, (k === 0 ? -1 : 1) * 0.15);
        dummy.updateMatrix();
        arm.setMatrixAt(i, dummy.matrix);
      }
    }
    for (const p of parts) p.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    for (const p of parts) p.dispose();
    torsoGeo.dispose();
    headGeo.dispose();
    legGeo.dispose();
    armGeo.dispose();
    skinMat.dispose();
    shirtMat.dispose();
    pantMat.dispose();
    group.removeFromParent();
  }

  function depth() {
    let d = 0;
    for (let i = 0; i < count; i++) d = Math.max(d, people[i].lag);
    return d;
  }

  return { group, setCount, depth, update, dispose };
}
