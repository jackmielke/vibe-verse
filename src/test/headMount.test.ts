/**
 * The head mount cancels a bone's bind transform so a hat sits upright.
 *
 * That correction is the whole feature and it is invisible when it is wrong on
 * only some characters — which is exactly how it will be wrong, because a
 * bone's rest orientation is whatever its author left it at and the cast is
 * three dozen GLBs from three dozen authors. A hat lying on its side on one
 * character is not something a build, a typecheck or a screenshot of a
 * different character will ever mention.
 *
 * So the awkward rigs are built here — rolled bones, scaled bones, bones with
 * a parent chain — and the mount is asked to put a hat on them.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createHeadMount } from "@/city/headMount";
import type { DanceSkeleton } from "@/components/city/dances";

/** A minimal rig: holder → model → root bone → head bone, plus a body mesh. */
function rig(opts: {
  headRot?: THREE.Euler;
  headPos?: THREE.Vector3;
  modelScale?: number;
  holderScale?: number;
}) {
  const holder = new THREE.Group();
  holder.scale.setScalar(opts.holderScale ?? 1);
  const model = new THREE.Group();
  model.scale.setScalar(opts.modelScale ?? 1);
  holder.add(model);

  // Something with extent, so the mount has a crown to measure to. A 1.85 m
  // body standing on the model's origin.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.85, 0.3));
  body.position.y = 0.925;
  model.add(body);

  const rootBone = new THREE.Bone();
  rootBone.position.set(0, 1.4, 0);
  model.add(rootBone);
  const head = new THREE.Bone();
  head.position.copy(opts.headPos ?? new THREE.Vector3(0, 0.2, 0));
  if (opts.headRot) head.rotation.copy(opts.headRot);
  rootBone.add(head);

  holder.updateWorldMatrix(true, true);
  const sk = { head: { obj: head } } as unknown as DanceSkeleton;
  return { holder, model, head, sk };
}

/** The mount's world rotation and scale, once a hat would be hanging on it. */
function mountWorld(mount: THREE.Object3D, holder: THREE.Object3D) {
  holder.updateWorldMatrix(true, true);
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  mount.matrixWorld.decompose(p, q, s);
  return { p, q, s };
}

/** Degrees between two orientations. */
const angleBetween = (a: THREE.Quaternion, b: THREE.Quaternion) =>
  THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))));

describe("the head mount", () => {
  it("puts a hat upright on a bone that is rolled ninety degrees", () => {
    // The case that motivated the correction: parent a hat straight to this
    // bone and it comes out lying on its side.
    const { holder, model, sk } = rig({ headRot: new THREE.Euler(0, 0, Math.PI / 2) });
    const mount = createHeadMount();
    mount.attach(sk, model, holder);
    const { q } = mountWorld(mount.group, holder);
    expect(angleBetween(q, new THREE.Quaternion())).toBeLessThan(0.5);
  });

  it("keeps a hat its authored size on a scaled rig", () => {
    // Every character is fitted to the same height, so the import scale varies
    // wildly. A hat that inherits it is a hat the size of a car.
    for (const modelScale of [0.35, 1, 4.2]) {
      const { holder, model, sk } = rig({ modelScale });
      const mount = createHeadMount();
      mount.attach(sk, model, holder);
      const { s } = mountWorld(mount.group, holder);
      expect(s.x, `model scale ${modelScale}`).toBeCloseTo(1, 3);
      expect(s.y).toBeCloseTo(1, 3);
    }
  });

  it("measures against the holder, so the player's own scale does not move it", () => {
    // The shop can scale the player. If the mount measured in world space the
    // hat would drift off the head every time somebody grew.
    const heights: number[] = [];
    for (const holderScale of [1, 3]) {
      const { holder, model, sk } = rig({ holderScale });
      const mount = createHeadMount();
      mount.attach(sk, model, holder);
      holder.updateWorldMatrix(true, true);
      const local = mount.group.matrixWorld
        .clone()
        .premultiply(holder.matrixWorld.clone().invert());
      heights.push(new THREE.Vector3().setFromMatrixPosition(local).y);
    }
    expect(heights[0]).toBeCloseTo(heights[1], 3);
  });

  it("sits above the head bone but not above the character", () => {
    const { holder, model, sk } = rig({});
    const mount = createHeadMount();
    mount.attach(sk, model, holder);
    const { p } = mountWorld(mount.group, holder);
    // Above the bone at 1.6...
    expect(p.y).toBeGreaterThan(1.6);
    // ...and not floating over the 1.85 m crown.
    expect(p.y).toBeLessThan(1.9);
  });

  it("follows the head when the head moves", () => {
    const { holder, model, head, sk } = rig({});
    const mount = createHeadMount();
    mount.attach(sk, model, holder);
    const before = mountWorld(mount.group, holder);
    // Turn to look over one shoulder, the way a dance or a swim breath does.
    head.rotation.y = 1.1;
    const after = mountWorld(mount.group, holder);
    expect(angleBetween(before.q, after.q)).toBeGreaterThan(50);
  });

  it("falls back to a fixed height on a rig with no head bone", () => {
    // Flux is built rather than rigged. A hat that vanishes is worse than a
    // hat that is approximately placed.
    const holder = new THREE.Group();
    const mount = createHeadMount();
    mount.attach(null, null, holder);
    const { p } = mountWorld(mount.group, holder);
    expect(p.y).toBeCloseTo(1.78, 3);
  });
});
