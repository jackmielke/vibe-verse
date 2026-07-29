/**
 * Player.tsx — the player, assembled.
 *
 * This is the only file the composition root has to know about. Mount it
 * inside the Canvas and the player exists: input is bound to the canvas, the
 * capsule is spawned wherever `frame.position` already is, the controller
 * drives the camera, and the cable, wings, canopy and viewmodel all render.
 *
 * Two structural details that are load-bearing:
 *
 *  • **`<PlayerSim/>` is rendered first, on purpose.** react-three-fiber runs
 *    same-priority `useFrame` callbacks in subscription order, so the
 *    simulation — which writes the camera transform — always runs before the
 *    visuals that copy it. Anything camera-attached that updated first would
 *    lag the camera by a frame and visibly swim. Do not reorder these.
 *
 *  • **Physics driving is auto-detected.** `updateSfPhysics()` must be called
 *    exactly once per frame by exactly one owner. If the composition root
 *    already does it, this component notices the step counter advancing and
 *    stays out of the way; if nothing is stepping the world, it takes over
 *    after a few frames so the player is never left standing on an unstepped
 *    broadphase (which would silently return "nothing hit" to every query,
 *    including the grapple). Pass `drivePhysics={false}` to force it off.
 */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type * as THREE from "three";
import { frame } from "../state/store";
import { initSfPhysics, isPhysicsReady, physics, updateSfPhysics } from "../physics";
import GrappleView from "./Grapple";
import ParachuteView from "./Parachute";
import ViewModel from "./viewmodel";
import WingsuitView from "./Wingsuit";
import { playerCtrl } from "./controller";
import { input } from "./input";

export interface PlayerProps {
  /** Turn the whole player off (shot harness, cutscenes, menus). */
  enabled?: boolean;
  /**
   * Who calls `updateSfPhysics`. "auto" (default) takes over only if nothing
   * else is stepping the world. Set false when the composition root owns it.
   */
  drivePhysics?: boolean | "auto";
  /** Hide the first-person arms without disabling the simulation. */
  showViewmodel?: boolean;
  /** Hide every player-owned visual (photo mode). */
  showVisuals?: boolean;
}

/**
 * The simulation half. Kept as its own component purely so that its
 * `useFrame` subscribes before the visual components' do.
 */
function PlayerSim({ enabled, drivePhysics }: { enabled: boolean; drivePhysics: boolean | "auto" }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  /* ---- input binding ---- */
  useEffect(() => {
    if (!enabled) return;
    const canvas = gl.domElement;
    input.attach(canvas);
    input.enabled = true;
    return () => {
      input.enabled = false;
      input.detach();
    };
  }, [enabled, gl]);

  /* ---- spawn ---- */
  useEffect(() => {
    // `frame.position` has already been placed by the level loader's
    // `resetFrame()`; adopt it rather than inventing a second spawn point.
    playerCtrl.init(frame.position.x, frame.position.y, frame.position.z, frame.yaw);
  }, []);

  /* ---- physics boot ---- */
  const drive = useRef({ own: false, idle: 0, lastStep: -1 });
  useEffect(() => {
    if (drivePhysics === false) return;
    // Idempotent and safe to ignore; every query degrades to "nothing" until
    // it resolves.
    void initSfPhysics();
  }, [drivePhysics]);

  useFrame((_, delta) => {
    if (!enabled) return;
    // The same clamp the composition root uses: a tab restore must not hand
    // the controller a two-second step.
    const dt = Math.min(delta, 1 / 15);

    if (drivePhysics !== false && isPhysicsReady() && !frame.paused) {
      const d = drive.current;
      if (drivePhysics === true) d.own = true;
      if (!d.own) {
        if (physics.stepCount === d.lastStep) {
          d.idle++;
          // Eight frames of a stationary step counter means nobody else is
          // driving. Long enough not to trip on a single dropped frame.
          if (d.idle > 8) d.own = true;
        } else {
          d.idle = 0;
        }
        d.lastStep = physics.stepCount;
      }
      if (d.own) {
        updateSfPhysics(dt, frame.position.x, frame.position.y, frame.position.z);
      }
    }

    playerCtrl.update(dt, camera as THREE.PerspectiveCamera);
  });

  return null;
}

export default function Player({
  enabled = true,
  drivePhysics = "auto",
  showViewmodel = true,
  showVisuals = true,
}: PlayerProps) {
  return (
    <>
      {/* Simulation first — see the header. */}
      <PlayerSim enabled={enabled} drivePhysics={drivePhysics} />
      <GrappleView visible={showVisuals} />
      <WingsuitView visible={showVisuals} />
      <ParachuteView visible={showVisuals} />
      <ViewModel visible={showVisuals && showViewmodel} />
    </>
  );
}
