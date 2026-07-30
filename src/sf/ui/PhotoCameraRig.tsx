/**
 * The one piece of the UI subsystem that lives inside the R3F tree.
 *
 * Photo mode needs to actually move the camera, and the camera only exists
 * inside `<Canvas>`. Rather than reach into the player rig (which belongs to
 * another system and has its own opinions about where the eye goes), photo
 * mode takes the camera outright while it is active and hands it straight
 * back on exit.
 *
 * Mount it as a direct child of `<Canvas>`, after the player. It is inert —
 * literally zero work per frame — whenever photo mode is off.
 */
import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { photoRig } from "./photo";

/** Hoisted scratch — nothing in a frame loop is allowed to allocate. */
const scratchEuler = new THREE.Euler(0, 0, 0, "YXZ");

export default function PhotoCameraRig() {
  const { camera, gl } = useThree();

  // Register the drawing buffer so the exporter can find it without
  // guessing at the DOM.
  useEffect(() => {
    photoRig.canvas = gl.domElement;
    return () => {
      if (photoRig.canvas === gl.domElement) photoRig.canvas = null;
    };
  }, [gl]);

  useFrame((_, delta) => {
    if (!photoRig.active) return;
    const dt = Math.min(delta, 1 / 15);

    // Direction basis from the rig's own yaw/pitch. Movement is on the
    // camera's plane (forward includes pitch, so a nosed-down camera dollies
    // downward — that is what photographers expect from a fly cam).
    const cy = Math.cos(photoRig.yaw);
    const sy = Math.sin(photoRig.yaw);
    const cp = Math.cos(photoRig.pitch);
    const sp = Math.sin(photoRig.pitch);
    const fx = -sy * cp;
    const fy = sp;
    const fz = -cy * cp;
    const rx = cy;
    const rz = -sy;

    const speed = photoRig.speed;
    const tx = (fx * photoRig.moveZ + rx * photoRig.moveX) * speed;
    const ty = (fy * photoRig.moveZ + photoRig.moveY) * speed;
    const tz = (fz * photoRig.moveZ + rz * photoRig.moveX) * speed;

    // Critically damped-ish glide. A hard snap makes every pan look like a
    // debug camera; 12/s settles in about a fifth of a second.
    const k = 1 - Math.exp(-12 * dt);
    photoRig.vx += (tx - photoRig.vx) * k;
    photoRig.vy += (ty - photoRig.vy) * k;
    photoRig.vz += (tz - photoRig.vz) * k;

    photoRig.x += photoRig.vx * dt;
    photoRig.y += photoRig.vy * dt;
    photoRig.z += photoRig.vz * dt;

    camera.position.set(photoRig.x, photoRig.y, photoRig.z);
    scratchEuler.set(photoRig.pitch, photoRig.yaw, photoRig.roll, "YXZ");
    camera.quaternion.setFromEuler(scratchEuler);

    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera && Math.abs(cam.fov - photoRig.fov) > 0.01) {
      cam.fov = photoRig.fov;
      cam.updateProjectionMatrix();
    }
  }, 5);

  return null;
}
