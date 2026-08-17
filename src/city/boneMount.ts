/**
 * Hanging things off a character's bones.
 *
 * Everything a player wears or carries has the same problem. Parent it to the
 * model holder at a fixed offset and it is correct for exactly one character
 * standing exactly still: the cast is fifty-eight GLBs fitted to a common
 * height, so their skeletons sit at different places inside it, and the moment
 * a bone moves the accessory stays where it was. A hat at a fixed 1.78 m
 * floats over a short character and cuts through a tall one. A jetpack at a
 * fixed (0, 1.06, −0.24) is on the back of somebody standing up and hanging in
 * the water behind somebody swimming, because the swim pitches the rig's ROOT
 * eighty-one degrees and the model holder never hears about it.
 *
 * The fix is to parent to the bone — through one corrective group:
 *
 *     bone
 *       └─ align      rotation = inverse of the bone's REST world rotation
 *       │             scale    = inverse of the bone's world scale
 *       └── mount     position = wherever the thing goes, in model units
 *            └─ hat, jetpack, whatever
 *
 * At rest the two inverses cancel the bone's bind transform exactly, so the
 * accessory sits upright and at its authored size. The instant the bone moves,
 * everything under it moves too, because that is what parenting does. No
 * per-frame work and nothing to keep in sync.
 *
 * The correction is not optional. A bone's rest orientation is whatever its
 * author left it at, and plenty of them are rolled ninety degrees or scaled by
 * the import fit — parent straight to the bone and roughly half the cast wears
 * its hat sideways.
 *
 * This module owns that correction so there is one copy of it. The geometry of
 * WHERE a thing sits is the caller's business and differs per accessory; the
 * business of cancelling a bind pose does not.
 */
import * as THREE from "three";

const m = new THREE.Matrix4();
const inv = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scale = new THREE.Vector3();

export interface BoneFit {
  /** The bone's position in the holder's space. */
  pos: THREE.Vector3;
  /** Mean scale along the chain, before correction. */
  scale: number;
}

/**
 * Point `align` at `bone` so its children sit upright and unscaled, and report
 * where the bone is.
 *
 * Everything is measured in `holder` space rather than world space, which is
 * what makes it immune to the player's own scale — the shop can change that at
 * any time.
 */
export function alignToBone(
  align: THREE.Object3D,
  bone: THREE.Object3D,
  holder: THREE.Object3D,
): BoneFit {
  holder.updateWorldMatrix(true, true);
  inv.copy(holder.matrixWorld).invert();
  m.copy(inv).multiply(bone.matrixWorld);
  m.decompose(pos, quat, scale);

  align.quaternion.copy(quat).invert();
  const s = (scale.x + scale.y + scale.z) / 3;
  align.scale.setScalar(s > 1e-4 ? 1 / s : 1);
  align.position.set(0, 0, 0);
  bone.add(align);
  return { pos: pos.clone(), scale: s };
}

/** The model's bounding box in `holder` space, for measuring against a bone. */
export function boxInHolder(
  box: THREE.Box3,
  model: THREE.Object3D,
  holder: THREE.Object3D,
): THREE.Box3 {
  holder.updateWorldMatrix(true, true);
  inv.copy(holder.matrixWorld).invert();
  // `Box3.setFromObject` is world-space; a bone brought through the holder is
  // not. Mixing the two silently works whenever the holder happens to sit at
  // the origin with unit scale, and breaks the moment anything scales.
  return box.setFromObject(model).applyMatrix4(inv);
}
