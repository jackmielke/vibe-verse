/**
 * Avatar — your body, seen from behind.
 *
 * `Walker` was a self-contained third-person character: its own input, its own
 * ground solve, its own chase camera. That made it easy to mount and impossible
 * to drive a car with, because every system that moves the player — vehicles,
 * hijacking, the grapple, the wingsuit — talks to `playerCtrl`, and Walker is
 * not `playerCtrl`. This is the other half of the trade: the simulation stays
 * in the physics controller where the rest of the game can reach it, and this
 * component does nothing but *draw* the result.
 *
 * So there is no input handling here, no collision, no camera. It reads
 * `frame`, it renders the same Vibeverse character the lobby and /city load,
 * and that is the whole job.
 *
 * Two details that are load-bearing:
 *
 *  • **`frame.position` is the capsule's centre, not its feet.** The rig
 *    anchors feet to its own y=0, so it hangs half a body above the pavement
 *    unless it is dropped by `PLAYER.height * 0.5`. That is the entire
 *    difference between walking on Market Street and hovering over it.
 *
 *  • **Facing follows travel, not the camera.** Turning the camera around a
 *    standing character should orbit them, not spin them on the spot; a body
 *    that pirouettes to face wherever the lens went reads as a turret. The
 *    yaw only chases the velocity while there is velocity to chase.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { findCharacter } from "@/lib/characters";
import { PLAYER } from "../config";
import { frame } from "../state/store";
import { clamp01, damp } from "../math/rng";
import { walkableHeight } from "../geo/sfGeo";
import { queryLandmarkColliders } from "../world/landmarks";
import { getShotHook } from "../debug/shotHook";
import { cameraRig } from "./camera";

export interface AvatarProps {
  /** Character id from `@/lib/characters`. */
  charId: string;
  /** Draw at all. Photo mode and the shot harness turn the body off. */
  visible?: boolean;
}

/** Below this ground speed the body is standing, not walking. */
const MOVING = 0.35;

export default function Avatar({ charId, visible = true }: AvatarProps) {
  const group = useRef<THREE.Group>(null);
  const [rig, setRig] = useState<CharacterRig | null>(null);
  const facing = useRef(frame.yaw);
  const locomotion = useRef(0);
  const scratch = useMemo(() => ({ flat: new THREE.Vector2() }), []);

  /* ---------------- the character ---------------- */
  useEffect(() => {
    let live = true;
    let mine: CharacterRig | null = null;
    const spec = findCharacter(charId);
    loadCharacterRig(
      { url: spec.url, id: spec.id },
      // `center: false` — feet at the rig's own origin, so the drop below is
      // the only vertical correction and it is a known quantity.
      { height: PLAYER.height, center: false, castShadow: true, walkSpeed: PLAYER.walkSpeed },
    )
      .then((r) => {
        if (!live) {
          r.dispose();
          return;
        }
        mine = r;
        setRig(r);
      })
      .catch(() => {
        /* Half the cast has no `.glb` and is built in code; the rig loader
           handles both. Anything that still fails leaves you invisible rather
           than taking the city down — see the note in characterRig.ts. */
      });
    return () => {
      live = false;
      setRig(null);
      mine?.dispose();
    };
  }, [charId]);

  useEffect(() => {
    const g = group.current;
    if (!g || !rig) return;
    g.add(rig.object);
    return () => {
      g.remove(rig.object);
    };
  }, [rig]);

  /* ---------------- debug surface ---------------- *
   * `__sf.player()` answers "where is my character, and is it standing on
   * anything" — the question a screenshot cannot answer, because a body
   * buried in a plinth and a body that never loaded look identical. Walker
   * used to install this; the body moved here when the simulation moved to
   * `playerCtrl`, and the harnesses should not have to care which. */
  useEffect(() => {
    const hook = getShotHook();
    hook.player = () => ({
      x: frame.position.x,
      y: frame.position.y,
      z: frame.position.z,
      grounded: frame.grounded,
      support: walkableHeight(frame.position.x, frame.position.z),
      // The settle window belonged to Walker's own ground solve; the physics
      // capsule has no equivalent, and reporting a fake number would be worse
      // than reporting none.
      settling: 0,
      rig: !!rig,
      colliders: queryLandmarkColliders(frame.position.x, frame.position.z, 40, []).length,
      rigHeight: rig ? rig.size.y : 0,
    });
    return () => {
      delete hook.player;
    };
  }, [rig]);

  /* ---------------- the frame ---------------- */
  useFrame((_, delta) => {
    const g = group.current;
    if (!g || !rig) return;
    const dt = Math.min(delta, 1 / 15);

    // Seated in a car, or looking through your own eyes: no body to draw.
    // The boom blend is the honest test rather than a mode flag, because the
    // switch is a half-second move and the head should not pop in halfway.
    const shown =
      visible && frame.vehicleId === null && cameraRig.thirdPersonBlend > 0.35;
    g.visible = shown;
    if (!shown) return;

    /* ---- stance ---- */
    g.position.set(
      frame.position.x,
      frame.position.y - PLAYER.height * 0.5,
      frame.position.z,
    );

    /* ---- facing ---- */
    scratch.flat.set(frame.velocity.x, frame.velocity.z);
    const ground = scratch.flat.length();
    if (ground > MOVING) {
      // atan2(x, z) rather than (z, x): the rig faces -Z, the same convention
      // `frame.yaw` uses, so a body walking north reads as walking north.
      const want = Math.atan2(scratch.flat.x, scratch.flat.y) + Math.PI;
      let d = want - facing.current;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      // Fast enough to look responsive, slow enough that a sidestep is a turn
      // rather than a snap.
      facing.current += d * Math.min(1, dt * 11);
    }
    g.rotation.y = facing.current;

    /* ---- gait ---- */
    // Damped so stepping off a kerb does not stutter the walk cycle. Sprinting
    // drives it past 1, which the rigs read as a run.
    const want = frame.grounded ? clamp01(ground / PLAYER.walkSpeed) : 0;
    locomotion.current = damp(locomotion.current, want, 9, dt);
    rig.setLocomotion(locomotion.current);
    rig.update(dt);
  });

  return <group ref={group} />;
}
