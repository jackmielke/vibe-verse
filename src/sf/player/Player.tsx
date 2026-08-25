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
import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type * as THREE from "three";
import { frame } from "../state/store";
import { initSfPhysics, isPhysicsReady, physics, updateSfPhysics } from "../physics";
import Avatar from "./Avatar";
import { cameraRig } from "./camera";
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
  /**
   * Draw the body and swing the camera out behind it. This is the default:
   * San Francisco is a place you are *in*, and a city you can see yourself
   * standing in reads at its real scale in a way a floating pair of hands
   * never does. First person is still a keypress away.
   */
  thirdPerson?: boolean;
  /** Which Vibeverse character the body wears. */
  charId?: string;
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

/**
 * Watches for the camera key.
 *
 * Its own component so the `useFrame` subscribes after `PlayerSim`'s and reads
 * an input snapshot the controller has already advanced this frame — polling
 * before it would see the previous frame's presses and drop one every time the
 * frame rate dipped.
 */
function ViewToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  useFrame(() => {
    if (!enabled || frame.paused) return;
    if (input.pressed("camera")) onToggle();
  });
  return null;
}

export default function Player({
  enabled = true,
  drivePhysics = "auto",
  showViewmodel = true,
  showVisuals = true,
  thirdPerson = true,
  charId = "vibey",
}: PlayerProps) {
  // The prop is the *starting* view; the player owns it from then on.
  const [third, setThird] = useState(thirdPerson);
  useEffect(() => setThird(thirdPerson), [thirdPerson]);

  // The rig owns the blend; this only states the intent. Setting it in an
  // effect rather than every frame leaves the camera free to crush the boom
  // against a wall without this fighting it back out.
  useEffect(() => {
    cameraRig.setThirdPerson(third);
  }, [third]);

  return (
    <>
      {/* Simulation first — see the header. */}
      <PlayerSim enabled={enabled} drivePhysics={drivePhysics} />
      <ViewToggle enabled={enabled} onToggle={() => setThird((v) => !v)} />
      <Avatar charId={charId} visible={showVisuals} />
      <GrappleView visible={showVisuals} />
      <WingsuitView visible={showVisuals} />
      <ParachuteView visible={showVisuals} />
      {/* The arms belong to the eyes. In third person the body has its own. */}
      <ViewModel visible={showVisuals && showViewmodel && !third} />
    </>
  );
}
