/**
 * San Palmas — the bay.
 *
 * Tropical water: waves, refraction, foam, shoreline.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import type { System, SystemFactory } from "../types";

const createWater: SystemFactory = (_ctx) => {
  const sys: System = { name: "water" };
  return sys;
};

export default createWater;
