/**
 * San Palmas — vegetation.
 *
 * Palms, jungle canopy, ferns, wind. The tropical half of tropical-SF.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import type { System, SystemFactory } from "../types";

const createVegetation: SystemFactory = (_ctx) => {
  const sys: System = { name: "vegetation" };
  return sys;
};

export default createVegetation;
