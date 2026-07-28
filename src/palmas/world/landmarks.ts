/**
 * San Palmas — landmarks.
 *
 * Golden Gate, the pyramid, Coit Tower, Alcatraz — the silhouette that says San Francisco.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import type { System, SystemFactory } from "../types";

const createLandmarks: SystemFactory = (_ctx) => {
  const sys: System = { name: "landmarks" };
  return sys;
};

export default createLandmarks;
