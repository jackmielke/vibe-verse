/**
 * San Palmas — post-processing stack.
 *
 * Owns the final image: bloom, SSAO, DOF, grade, AA.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import type { System, SystemFactory } from "../types";

const createPostFx: SystemFactory = (_ctx) => {
  const sys: System = { name: "postfx" };
  return sys;
};

export default createPostFx;
