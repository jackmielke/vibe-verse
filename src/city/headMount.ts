/**
 * A place to hang a hat that is actually attached to the head.
 *
 * Hats used to be parented to the model holder at a fixed 1.78 m — "just above
 * a ~1.85 m model's head" — which is true of a character standing still and of
 * nothing else. Every character in the catalogue is a different GLB fitted to
 * the same height, so their heads are at different places inside that height;
 * a hat sat at one number floats over a short one and cuts through a tall one.
 * And because the mount never moved, the hat stayed bolt upright while the
 * head nodded, turned to breathe mid-crawl, or leaned through a dance.
 *
 * This parents it to the head bone instead, through a corrective group, and
 * that group is the whole trick:
 *
 *   headBone
 *     └─ align      rotation = inverse of the bone's REST world rotation
 *     │             scale    = inverse of the bone's world scale
 *     └── mount     position  = (0, gap, 0) in the model's own units
 *          └─ hat
 *
 * At rest the two inverses cancel the bone's bind transform exactly, so the hat
 * sits upright, at its authored size, `gap` metres above the bone — which is
 * where a hat goes. The moment the bone moves, everything under it moves with
 * it, because that is what parenting does. No per-frame work, no matrix copy,
 * nothing to keep in sync.
 *
 * Rigs are not consistent enough to skip the correction: a bone's rest
 * orientation is whatever its author left it at, and plenty of them are rolled
 * ninety degrees or scaled by the import fit. Parenting a hat straight to the
 * bone gives you a hat lying on its side, at the wrong scale, on maybe half of
 * the cast.
 */
import * as THREE from "three";
import type { DanceSkeleton } from "@/components/city/dances";
import { alignToBone, boxInHolder } from "@/city/boneMount";

export interface HeadMount {
  /** Parent hats here. Empty until a model with a head bone is bound. */
  readonly group: THREE.Group;
  /**
   * Re-home onto a freshly loaded character. `holder` is the object the model
   * was added to, and everything is measured in ITS space, so the answer does
   * not change when the player is scaled up or down.
   */
  attach(sk: DanceSkeleton | null, model: THREE.Object3D | null, holder: THREE.Object3D): void;
  dispose(): void;
}

/**
 * How far above the head bone a hat sits, as a fraction of the distance from
 * that bone to the top of the model.
 *
 * Slightly under 1: the top of the bounding box is the crown of the head (or
 * the tip of an ear, or a hair spike), and a hat wants to sit ON the skull, not
 * balanced on the highest vertex.
 */
const CROWN_FRACTION = 0.86;
/** Fallback when a rig has no head bone at all — the old fixed mount, kept. */
const FALLBACK_Y = 1.78;

export function createHeadMount(): HeadMount {
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

      const bone = sk?.head?.obj ?? null;
      if (!bone || !model) {
        // No head to hang it off: back to the old fixed mount rather than no
        // hat at all. Flux and anything else rigless lands here.
        group.position.y = FALLBACK_Y;
        holder.add(align);
        return;
      }

      // The bind-pose correction and the parenting; see `boneMount`.
      const fit = alignToBone(align, bone, holder);
      // The model's extent, in the same space as the bone.
      boxInHolder(box, model, holder);
      // Measured from the bone to the crown, in holder units. A rig whose head
      // bone sits at the very top (some do — the "head" is the mesh's pivot,
      // not its base) still gets a sane gap rather than a hat inside the skull.
      group.position.y = Math.max(0.08, (box.max.y - fit.pos.y) * CROWN_FRACTION);
    },
    dispose() {
      align.removeFromParent();
    },
  };
}
