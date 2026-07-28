/**
 * San Palmas — weapons.
 *
 * Viewmodel, recoil, ADS, reloads, ballistics.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import type { System, SystemFactory } from "../types";

const createWeapons: SystemFactory = (_ctx) => {
  const sys: System = { name: "weapons" };
  return sys;
};

export default createWeapons;
