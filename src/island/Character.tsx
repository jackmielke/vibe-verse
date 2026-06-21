import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { InputState } from "./useInput";
import type { CharacterOption } from "./characters";
import type { World } from "./world";

type LoadedChar = {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
};

async function loadCharacter(url: string): Promise<LoadedChar | null> {
  const loader = new GLTFLoader();
  try {
    const gltf = await loader.loadAsync(url);
    return { scene: gltf.scene, clips: gltf.animations };
  } catch (e) {
    console.warn("Character load failed", e);
    return null;
  }
}

function findClip(clips: THREE.AnimationClip[], names: string[]): THREE.AnimationClip | null {
  for (const n of names) {
    const c = clips.find((x) => x.name.toLowerCase().includes(n.toLowerCase()));
    if (c) return c;
  }
  return null;
}

export type CharacterHandle = {
  group: THREE.Group;
  position: THREE.Vector3;
  yaw: number;
};

export function Character({
  character,
  world,
  inputRef,
  onUpdate,
  shells,
  onCollectShell,
  controlsEnabled,
}: {
  character: CharacterOption;
  world: World;
  inputRef: React.MutableRefObject<InputState>;
  onUpdate: (h: CharacterHandle) => void;
  shells: { id: number; pos: THREE.Vector3; collected: boolean }[];
  onCollectShell: (id: number) => void;
  controlsEnabled: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const [loaded, setLoaded] = useState<LoadedChar | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionsRef = useRef<{
    idle?: THREE.AnimationAction;
    walk?: THREE.AnimationAction;
    run?: THREE.AnimationAction;
  }>({});
  const velocityY = useRef(0);
  const grounded = useRef(true);
  const pos = useRef(new THREE.Vector3(world.spawn.x, world.spawn.y, world.spawn.z));
  const yaw = useRef(world.spawn.yaw);
  const { camera } = useThree();

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    loadCharacter(character.url).then((c) => {
      if (alive) setLoaded(c);
    });
    return () => {
      alive = false;
    };
  }, [character.url]);

  const characterScene = useMemo(() => {
    if (!loaded) return null;
    const cloned = SkeletonUtils.clone(loaded.scene) as THREE.Group;
    cloned.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    cloned.scale.setScalar(character.scale);
    cloned.position.y = character.yOffset;
    return cloned;
  }, [loaded, character]);

  useEffect(() => {
    if (!characterScene || !loaded) return;
    const mixer = new THREE.AnimationMixer(characterScene);
    mixerRef.current = mixer;
    const idleClip = findClip(loaded.clips, ["idle"]);
    const walkClip = findClip(loaded.clips, ["walk"]);
    const runClip = findClip(loaded.clips, ["run"]);
    const a: any = {};
    if (idleClip) {
      a.idle = mixer.clipAction(idleClip);
      a.idle.setEffectiveWeight(1).play();
    }
    if (walkClip) {
      a.walk = mixer.clipAction(walkClip);
      a.walk.setEffectiveWeight(0).play();
    }
    if (runClip) {
      a.run = mixer.clipAction(runClip);
      a.run.setEffectiveWeight(0).play();
    }
    actionsRef.current = a;
    return () => {
      mixer.stopAllAction();
    };
  }, [characterScene, loaded]);

  const { gl, scene } = useThree();

  // VR dolly: parent of the camera while presenting. We move the dolly,
  // never the camera, so the headset pose stays authoritative (this is
  // the #1 nausea-prevention rule for WebXR).
  const dollyRef = useRef<THREE.Group | null>(null);
  if (!dollyRef.current) dollyRef.current = new THREE.Group();
  const xrYawRef = useRef(0); // accumulated snap-turn yaw applied to dolly
  const snapTurnLatch = useRef(false);
  const xrAttachedRef = useRef(false);

  useEffect(() => {
    const dolly = dollyRef.current!;
    scene.add(dolly);
    return () => {
      // Re-parent camera back to scene root before unmount so we don't strand it.
      if (camera.parent === dolly) scene.add(camera);
      scene.remove(dolly);
    };
  }, [scene, camera]);

  useFrame((_, dt) => {
    dt = Math.min(dt, 0.05);
    const input = inputRef.current;
    const dolly = dollyRef.current!;
    const presenting = !!gl.xr?.isPresenting;

    // Attach/detach camera to dolly when entering/leaving XR.
    if (presenting && !xrAttachedRef.current) {
      dolly.add(camera);
      camera.position.set(0, 0, 0);
      camera.rotation.set(0, 0, 0); // headset will overwrite each frame
      xrAttachedRef.current = true;
    } else if (!presenting && xrAttachedRef.current) {
      scene.add(camera);
      xrAttachedRef.current = false;
    }

    // ---- Input → movement direction --------------------------------------
    let forwardX: number, forwardZ: number, rightX: number, rightZ: number;
    let stickX = input.strafe;
    let stickY = input.forward;
    let runFlag = input.run;
    let jumpFlag = input.jump;

    if (presenting) {
      // Use headset facing (yaw only) for movement direction. Keeps the
      // horizon level and matches what the player physically sees.
      const headDir = new THREE.Vector3();
      camera.getWorldDirection(headDir);
      headDir.y = 0;
      if (headDir.lengthSq() < 1e-6) headDir.set(0, 0, -1);
      headDir.normalize();
      forwardX = headDir.x;
      forwardZ = headDir.z;
      rightX = -headDir.z;
      rightZ = headDir.x;

      // Read XR thumbsticks: left = locomotion, right = snap-turn.
      const session = gl.xr.getSession?.();
      if (session) {
        for (const src of session.inputSources) {
          const gp = src.gamepad;
          if (!gp) continue;
          const ax = gp.axes;
          const a0 = ax[0] ?? 0, a1 = ax[1] ?? 0, a2 = ax[2] ?? 0, a3 = ax[3] ?? 0;
          const useHigh = Math.hypot(a2, a3) >= Math.hypot(a0, a1);
          const rx = useHigh ? a2 : a0;
          const ry = useHigh ? a3 : a1;
          if (src.handedness === "right") {
            // Snap-turn: 30° flick with hysteresis (no smooth rotation
            // because smooth-turn is the biggest VR motion-sickness source).
            if (Math.abs(rx) > 0.7 && !snapTurnLatch.current) {
              xrYawRef.current -= Math.sign(rx) * (Math.PI / 6);
              snapTurnLatch.current = true;
            } else if (Math.abs(rx) < 0.3) {
              snapTurnLatch.current = false;
            }
            // Button 4 (A on Quest) = jump.
            if (gp.buttons[4]?.pressed) jumpFlag = true;
          } else {
            // Left stick = move; squeeze trigger (button 0) = run.
            if (Math.abs(rx) > 0.15) stickX = rx;
            if (Math.abs(ry) > 0.15) stickY = -ry;
            if (gp.buttons[0]?.pressed || gp.buttons[1]?.pressed) runFlag = true;
          }
        }
      }
    } else {
      const camYaw = input.cameraYaw;
      forwardX = -Math.sin(camYaw); forwardZ = -Math.cos(camYaw);
      rightX = Math.cos(camYaw);     rightZ = -Math.sin(camYaw);
    }

    const move = new THREE.Vector3();
    if (controlsEnabled) {
      move.x = forwardX * stickY + rightX * stickX;
      move.z = forwardZ * stickY + rightZ * stickX;
    }

    const moving = move.lengthSq() > 0.001;
    const speed = runFlag ? 6.5 : 3.0;
    if (moving) {
      move.normalize();
      pos.current.x += move.x * speed * dt;
      pos.current.z += move.z * speed * dt;
      const targetYaw = Math.atan2(move.x, move.z);
      let dy = targetYaw - yaw.current;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      yaw.current += dy * Math.min(1, dt * 12);
    }

    const rawGround = world.heightAt(pos.current.x, pos.current.z);
    const groundY = rawGround < -50 ? rawGround : Math.max(0.0, rawGround);
    velocityY.current -= 18 * dt;
    pos.current.y += velocityY.current * dt;
    if (pos.current.y <= groundY) {
      pos.current.y = groundY;
      velocityY.current = 0;
      grounded.current = true;
    } else {
      grounded.current = false;
    }
    if (pos.current.y < -30) {
      pos.current.set(world.spawn.x, world.spawn.y, world.spawn.z);
      velocityY.current = 0;
      yaw.current = world.spawn.yaw;
    }
    if (controlsEnabled && jumpFlag && grounded.current) {
      velocityY.current = 7.5;
      grounded.current = false;
    }
    input.jump = false;

    if (groupRef.current) {
      groupRef.current.position.copy(pos.current);
      groupRef.current.rotation.y = yaw.current;
    }

    const a = actionsRef.current;
    if (mixerRef.current) {
      mixerRef.current.update(dt);
      const idleW = moving ? 0 : 1;
      const walkW = moving && !runFlag ? 1 : 0;
      const runW = moving && runFlag ? 1 : 0;
      const lerp = (cur: number, tgt: number) => cur + (tgt - cur) * Math.min(1, dt * 8);
      if (a.idle) a.idle.setEffectiveWeight(lerp(a.idle.getEffectiveWeight(), idleW));
      if (a.walk) a.walk.setEffectiveWeight(lerp(a.walk.getEffectiveWeight(), walkW));
      if (a.run) a.run.setEffectiveWeight(lerp(a.run.getEffectiveWeight(), runW));
    }

    // ---- Camera --------------------------------------------------------
    if (presenting) {
      // Snap (no lerp) the dolly to first-person head position. Lerping
      // here causes "swim" — the world drifts under a stationary head.
      dolly.position.set(pos.current.x, pos.current.y + 1.6, pos.current.z);
      dolly.rotation.set(0, xrYawRef.current, 0); // horizon locked, snap-turn only
    } else {
      const pitch = input.cameraPitch;
      const dist = input.cameraDist;
      const camYaw = input.cameraYaw;
      const camOffset = new THREE.Vector3(
        Math.sin(camYaw) * Math.cos(pitch) * dist,
        Math.sin(pitch) * dist + 1.5,
        Math.cos(camYaw) * Math.cos(pitch) * dist
      );
      const target = pos.current.clone().add(new THREE.Vector3(0, 1.4, 0));
      const desired = target.clone().add(camOffset);
      const lerpAmt = controlsEnabled ? Math.min(1, dt * 6) : Math.min(1, dt * 4);
      camera.position.lerp(desired, lerpAmt);
      camera.lookAt(target);
    }

    if (controlsEnabled) {
      for (const s of shells) {
        if (s.collected) continue;
        if (pos.current.distanceTo(s.pos) < 1.2) onCollectShell(s.id);
      }
    }

    onUpdate({ group: groupRef.current!, position: pos.current, yaw: yaw.current });
  });

  return (
    <group ref={groupRef} position={[0, 2, 8]}>
      {characterScene ? (
        <primitive object={characterScene} />
      ) : (
        <group>
          <mesh position={[0, 0.9, 0]} castShadow>
            <capsuleGeometry args={[0.3, 0.8, 4, 8]} />
            <meshStandardMaterial color="#b46a3a" />
          </mesh>
          <mesh position={[0, 1.7, 0]} castShadow>
            <sphereGeometry args={[0.25, 16, 16]} />
            <meshStandardMaterial color="#e2b58a" />
          </mesh>
        </group>
      )}
    </group>
  );
}
