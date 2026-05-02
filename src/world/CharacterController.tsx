import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useKeyboardControls } from "@react-three/drei";
import { Character, type CharacterAction } from "./Character";
import { ISLAND_RADIUS, SEA_LEVEL, heightAt } from "./terrain";

const WALK_SPEED = 3.0; // m/s
const RUN_SPEED = 6.5;
const ROTATE_LERP = 10; // higher = snappier turning
const CAMERA_HEIGHT = 2.6;
const CAMERA_DISTANCE = 5.5;
const CAMERA_LERP = 5;
const PLAYABLE_RADIUS = ISLAND_RADIUS - 2;
const FOOT_OFFSET = 0; // soldier glb already has feet at y=0

/**
 * Owns the player's transform, runs the keyboard input loop, snaps the
 * character to the terrain, and drives the third-person follow camera.
 */
export function Player() {
  const groupRef = useRef<THREE.Group>(null);
  const lookHelper = useMemo(() => new THREE.Object3D(), []);
  const desiredCamPos = useMemo(() => new THREE.Vector3(), []);
  const camLookTarget = useMemo(() => new THREE.Vector3(), []);
  const moveDir = useMemo(() => new THREE.Vector3(), []);
  const camForward = useMemo(() => new THREE.Vector3(), []);
  const camRight = useMemo(() => new THREE.Vector3(), []);

  const cameraAzimuth = useRef(0); // radians; 0 = camera behind looking toward -Z
  const dragState = useRef({ active: false, lastX: 0 });

  const [action, setAction] = useState<CharacterAction>("idle");
  const [, getKeys] = useKeyboardControls();
  const { camera } = useThree();

  // Drag-to-orbit camera
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-hud]")) return;
      dragState.current.active = true;
      dragState.current.lastX = e.clientX;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragState.current.active) return;
      const dx = e.clientX - dragState.current.lastX;
      cameraAzimuth.current -= dx * 0.005;
      dragState.current.lastX = e.clientX;
    };
    const onUp = () => {
      dragState.current.active = false;
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  // Initial spawn: a flat-ish patch slightly inland
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    const startX = 0;
    const startZ = 14;
    g.position.set(startX, heightAt(startX, startZ) + FOOT_OFFSET, startZ);
    g.rotation.y = 0;
    camera.position.set(
      startX,
      g.position.y + CAMERA_HEIGHT,
      startZ + CAMERA_DISTANCE,
    );
    camera.lookAt(g.position.x, g.position.y + 1.4, g.position.z);
  }, [camera]);

  useFrame((_, dt) => {
    const g = groupRef.current;
    if (!g) return;
    const clampedDt = Math.min(dt, 0.1);

    const keys = getKeys();
    const sprint = !!keys.sprint;
    const speed = sprint ? RUN_SPEED : WALK_SPEED;

    const fwd = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0);
    const str = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const inputMag = Math.hypot(fwd, str);

    // Camera-relative movement basis. cameraAzimuth: 0 → camera is at +Z behind player
    // looking toward -Z. World forward direction (in player's "forward" sense) is -Z
    // when azimuth is 0; rotate by azimuth around Y.
    const az = cameraAzimuth.current;
    camForward.set(-Math.sin(az), 0, -Math.cos(az));
    camRight.set(Math.cos(az), 0, -Math.sin(az));

    if (inputMag > 0.01) {
      moveDir
        .set(0, 0, 0)
        .addScaledVector(camForward, fwd)
        .addScaledVector(camRight, str)
        .normalize();
    } else {
      moveDir.set(0, 0, 0);
    }

    let nextX = g.position.x + moveDir.x * speed * clampedDt;
    let nextZ = g.position.z + moveDir.z * speed * clampedDt;

    // Soft circular boundary
    const r = Math.hypot(nextX, nextZ);
    if (r > PLAYABLE_RADIUS) {
      const k = PLAYABLE_RADIUS / r;
      nextX *= k;
      nextZ *= k;
    }

    // Don't let feet go below sea level
    if (heightAt(nextX, nextZ) < SEA_LEVEL + 0.05) {
      nextX = g.position.x;
      nextZ = g.position.z;
    }

    g.position.x = nextX;
    g.position.z = nextZ;
    g.position.y = heightAt(nextX, nextZ) + FOOT_OFFSET;

    // Smooth heading toward movement direction (Soldier model's forward is -Z,
    // so Object3D.lookAt does the right thing).
    if (inputMag > 0.05) {
      lookHelper.position.copy(g.position);
      lookHelper.lookAt(
        g.position.x + moveDir.x,
        g.position.y,
        g.position.z + moveDir.z,
      );
      g.quaternion.slerp(
        lookHelper.quaternion,
        Math.min(1, ROTATE_LERP * clampedDt),
      );
    }

    // Drive animation state
    let nextAction: CharacterAction = "idle";
    if (inputMag > 0.05) nextAction = sprint ? "run" : "walk";
    if (nextAction !== action) setAction(nextAction);

    // Third-person follow camera
    desiredCamPos.set(
      g.position.x + Math.sin(az) * CAMERA_DISTANCE,
      g.position.y + CAMERA_HEIGHT,
      g.position.z + Math.cos(az) * CAMERA_DISTANCE,
    );
    // Keep camera comfortably above water and out of the ground
    const groundUnderCam = heightAt(desiredCamPos.x, desiredCamPos.z);
    desiredCamPos.y = Math.max(
      desiredCamPos.y,
      groundUnderCam + 1.2,
      SEA_LEVEL + 1.6,
    );
    camera.position.lerp(
      desiredCamPos,
      Math.min(1, CAMERA_LERP * clampedDt),
    );
    camLookTarget.set(g.position.x, g.position.y + 1.4, g.position.z);
    camera.lookAt(camLookTarget);
  });

  return (
    <group ref={groupRef}>
      <Character action={action} />
    </group>
  );
}
