/**
 * A place to hang a jetpack that is actually on somebody's back.
 *
 * It used to be parented to the model holder at a fixed (0, 1.06, −0.24) with
 * the comment "on the pilot's back", which is true of one character standing
 * upright and of nothing else:
 *
 *  - **Every rig is a different shape.** Fifty-eight GLBs are fitted to a
 *    common height, so a number that lands between the shoulder blades on one
 *    of them lands on the back of a neck or in the small of a back on the
 *    others.
 *  - **It never moved.** The swim stroke pitches the rig's ROOT eighty-one
 *    degrees to lay the body along the surface, and the model holder is not
 *    part of that — so a swimmer went flat and the jetpack stayed bolt
 *    upright, floating in the water above and behind them, still pointing at
 *    the sky. Dances do the same thing more subtly.
 *
 * So it goes on a bone, through the shared bind-pose correction in
 * `boneMount`. What is specific to a back — and the only real content of this
 * file — is deciding where "the back" is on a skeleton nobody measured.
 */
import * as THREE from "three";
import type { DanceSkeleton } from "@/components/city/dances";
import { alignToBone, boxInHolder } from "@/city/boneMount";

export interface BackMount {
  /** Parent a jetpack here. Empty until a model with a spine is bound. */
  readonly group: THREE.Group;
  /** Re-home onto a freshly loaded character. See `HeadMount.attach`. */
  attach(sk: DanceSkeleton | null, model: THREE.Object3D | null, holder: THREE.Object3D): void;
  dispose(): void;
}

/**
 * How far back from the spine bone the pack sits, as a fraction of the
 * distance from that bone to the back of the model.
 *
 * Over 1 on purpose: the bounding box's back face is the backmost VERTEX of
 * the whole character, which is usually a heel, a tail or a swept-back hairdo
 * rather than the spine — so a fraction under one buries the pack inside the
 * ribcage on most of the cast. Sitting slightly proud of the box reads as worn
 * rather than embedded.
 */
const BACK_FRACTION = 1.15;
/** Floor on that, so a rig whose spine is already at the back still clears it. */
const MIN_BACK = 0.14;
/** And a ceiling, so a character with a long tail does not tow its jetpack. */
const MAX_BACK = 0.5;
/**
 * Up from the spine bone, as a fraction of bone-to-crown.
 *
 * Rigs disagree wildly about what "spine" means — some put it at the navel,
 * some between the shoulders — so this is measured against the head rather
 * than assumed.
 */
const RISE_FRACTION = 0.34;
/** The old fixed mount, kept for anything with no spine at all. */
const FALLBACK = { y: 1.06, z: -0.24 };

export function createBackMount(): BackMount {
  const group = new THREE.Group();
  const align = new THREE.Group();
  align.add(group);
  const box = new THREE.Box3();

  return {
    group,
    attach(sk, model, holder) {
      align.removeFromParent();
      align.position.set(0, 0, 0);
      align.quaternion.identity();
      align.scale.setScalar(1);
      group.position.set(0, 0, 0);

      /**
       * Chest first, then spine, then hips.
       *
       * A pack wants the highest rigid part of the torso. Falling back to the
       * hips is a compromise and it is the right one — a jetpack that swings
       * slightly wrong with the waist is a great deal better than one that
       * ignores the body completely, which is what the fixed mount did.
       */
      const bone = sk?.torso?.obj ?? sk?.spine?.obj ?? sk?.hips?.obj ?? null;
      if (!bone || !model) {
        group.position.set(0, FALLBACK.y, FALLBACK.z);
        holder.add(align);
        return;
      }

      const fit = alignToBone(align, bone, holder);
      boxInHolder(box, model, holder);

      // Backwards is −Z: the player's forward is (sin yaw, cos yaw), so at yaw
      // zero the character faces +Z. The old fixed mount's −0.24 agrees.
      const depth = Math.abs(fit.pos.z - box.min.z);
      const back = THREE.MathUtils.clamp(depth * BACK_FRACTION, MIN_BACK, MAX_BACK);
      const rise = Math.max(0, (box.max.y - fit.pos.y) * RISE_FRACTION);

      group.position.set(0, rise, -back);
      bone.add(align);
    },
    dispose() {
      align.removeFromParent();
    },
  };
}
