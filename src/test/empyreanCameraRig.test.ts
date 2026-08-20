/**
 * The third-person rig, and the one thing about it that is a trapdoor.
 *
 * `update` has an early return in it: once the boom is short enough to be
 * first person, the rig sets the camera on the eye and leaves, skipping the
 * whole boom half of the function. That is fine, and it is why first person
 * costs nothing — but it means **anything that decides whether the early
 * return is taken has to be computed before it.**
 *
 * It was not. The carry clamp — which pulls the boom in while you are riding
 * a tram, because a third-person lens would have to hang outside the vehicle
 * you are sitting in — assigned `mode` *below* the early return. So the first
 * frame aboard set `mode` to "first", every frame after that returned early
 * and never reached the assignment again, and stepping off the tram left the
 * camera stuck in first person for the rest of the session. The only way out
 * was to scroll the wheel, which happens to reassign `mode` from `zoom()`.
 *
 * Nothing about that is visible in a build, a typecheck or a still. It is one
 * ordering mistake inside forty lines, and the symptom arrives a minute later
 * somewhere else. So it gets a test that rides and dismounts.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { CameraRig } from "@/empyrean/camera";
import { ISLAND_Y } from "@/empyrean/config";

/** A world with nothing in it: no blockers, ground at the deck. */
const OPEN = {
  blockedAt: () => false,
  supportAt: () => ISLAND_Y,
};

function target(carried: boolean) {
  return {
    position: new THREE.Vector3(0, ISLAND_Y, 0),
    velocity: new THREE.Vector3(),
    yaw: 0,
    grounded: true,
    burn: 0,
    carried,
  };
}

function run(rig: CameraRig, camera: THREE.PerspectiveCamera, carried: boolean, frames: number) {
  for (let i = 0; i < frames; i++) rig.update(camera, target(carried), OPEN, 1 / 60);
}

describe("the boom while you are being carried", () => {
  it("goes to first person aboard and comes back out again", () => {
    const rig = new CameraRig(0);
    const camera = new THREE.PerspectiveCamera(58, 1.6, 0.3, 26000);

    run(rig, camera, false, 5);
    expect(rig.mode).toBe("third");

    /* Aboard. Several frames, because the bug needed more than one: the
       first frame was correct and every frame after it was not. */
    run(rig, camera, true, 30);
    expect(rig.mode).toBe("first");

    /* Off again. This is the assertion that failed. */
    run(rig, camera, false, 5);
    expect(rig.mode).toBe("third");
  });

  it("never touches the distance the player chose", () => {
    const rig = new CameraRig(0);
    const camera = new THREE.PerspectiveCamera(58, 1.6, 0.3, 26000);
    rig.zoom(400);
    const chosen = rig.dist;
    expect(chosen).toBeGreaterThan(3);

    run(rig, camera, true, 30);
    expect(rig.dist).toBe(chosen);

    run(rig, camera, false, 5);
    expect(rig.dist).toBe(chosen);
    expect(rig.mode).toBe("third");
  });

  it("puts the lens where the body is while carried, not out in the air", () => {
    const rig = new CameraRig(0);
    const camera = new THREE.PerspectiveCamera(58, 1.6, 0.3, 26000);
    run(rig, camera, false, 5);
    const outside = camera.position.distanceTo(new THREE.Vector3(0, ISLAND_Y, 0));

    run(rig, camera, true, 30);
    const inside = camera.position.distanceTo(new THREE.Vector3(0, ISLAND_Y, 0));

    /* A tram car is about 2.6 m wide. Anything past that and the lens is
       through the wall, which is the whole failure this clamp exists for. */
    expect(inside).toBeLessThan(2.6);
    expect(inside).toBeLessThan(outside);
  });
});

describe("the rig's frame path", () => {
  it("does not allocate", () => {
    const rig = new CameraRig(0);
    const camera = new THREE.PerspectiveCamera(58, 1.6, 0.3, 26000);
    run(rig, camera, false, 2000);
    const before = process.memoryUsage().heapUsed;
    run(rig, camera, false, 40000);
    const after = process.memoryUsage().heapUsed;
    /* The shoulder probe used to build two fresh vectors a frame. Forty
       thousand frames of that is eighty thousand objects; anything under a
       few megabytes here is the interpreter breathing. */
    expect(after - before).toBeLessThan(8 * 1024 * 1024);
  }, 30000);
});
