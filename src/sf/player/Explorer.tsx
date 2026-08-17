/**
 * Explorer — the free-flying camera for San Francisco: FREE FALL.
 *
 * The grapple/wingsuit controller is not built yet, and `Walker` is now the
 * default way in, so this is the *other* mode: a free-flying observer for
 * covering nine kilometres of map in a few seconds, and for looking at the
 * city from where nobody can stand.
 *
 * It writes into `frame` exactly the way the real controller will — position,
 * yaw, pitch, velocity, movement state — so when the controller lands this can
 * be deleted without anything downstream noticing.
 *
 * The input layer it used to own now lives in `traversalInput.ts`, shared with
 * the walking controller — see that file for the touch design notes.
 */
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PLAYER } from "../config";
import { frame } from "../state/store";
import { WORLD, clampToWorld, walkableHeight } from "../geo/sfGeo";
import { clamp, damp } from "../math/rng";
import { readMove, useTraversalInput } from "./traversalInput";

/** How fast the observer flies, m/s. It is a 9.5 km map; slow is unusable. */
const BASE_SPEED = 34;
const BOOST_MULTIPLIER = 4.5;
const SLOW_MULTIPLIER = 0.22;

export interface ExplorerProps {
  /** Disabled while the screenshot harness or the walking controller owns the camera. */
  enabled?: boolean;
}

export default function Explorer({ enabled = true }: ExplorerProps) {
  const { camera } = useThree();
  const input = useTraversalInput({ enabled });

  // Scratch vectors — allocating these per frame is exactly the mistake this
  // codebase bans elsewhere.
  const scratch = useMemo(
    () => ({
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      move: new THREE.Vector3(),
      euler: new THREE.Euler(0, 0, 0, "YXZ"),
    }),
    [],
  );

  const speedRef = useRef(BASE_SPEED);

  useFrame((_, delta) => {
    if (!enabled) return;
    const dt = Math.min(delta, 1 / 15);

    /* ---- look ---- */
    // movementX is in CSS pixels; the sensitivity constant is per-pixel, so
    // this is naturally frame-rate independent.
    frame.yaw -= input.lookX * PLAYER.mouseSensitivity;
    frame.pitch -= input.lookY * PLAYER.mouseSensitivity;
    frame.pitch = clamp(frame.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    input.lookX = 0;
    input.lookY = 0;

    /* ---- movement ---- */
    const { x: mx, z: mz, y: my, boost, slow } = readMove(input);

    /* ---- integrate ---- */
    const target =
      BASE_SPEED * (boost ? BOOST_MULTIPLIER : 1) * (slow ? SLOW_MULTIPLIER : 1);
    speedRef.current = damp(speedRef.current, target, 6, dt);

    const cy = Math.cos(frame.yaw);
    const sy = Math.sin(frame.yaw);
    const cp = Math.cos(frame.pitch);
    const sp = Math.sin(frame.pitch);
    scratch.forward.set(-sy * cp, sp, -cy * cp).normalize();
    scratch.right.set(cy, 0, -sy).normalize();

    scratch.move
      .set(0, 0, 0)
      .addScaledVector(scratch.forward, -mz)
      .addScaledVector(scratch.right, mx);
    scratch.move.y += my;
    if (scratch.move.lengthSq() > 1) scratch.move.normalize();

    frame.velocity.copy(scratch.move).multiplyScalar(speedRef.current);
    frame.position.addScaledVector(frame.velocity, dt);

    // Keep the observer inside the map and above the ground — falling through
    // the world with no collision system is a bad first impression.
    const clamped = clampToWorld(frame.position.x, frame.position.z);
    frame.position.x = clamped.x;
    frame.position.z = clamped.z;
    const floor = walkableHeight(frame.position.x, frame.position.z) + 1.7;
    if (frame.position.y < floor) frame.position.y = floor;
    if (frame.position.y > WORLD.skyCeiling) frame.position.y = WORLD.skyCeiling;

    frame.movement = "airborne";
    frame.grounded = false;

    camera.position.copy(frame.position);
    scratch.euler.set(frame.pitch, frame.yaw, 0);
    camera.quaternion.setFromEuler(scratch.euler);
  });

  return null;
}
