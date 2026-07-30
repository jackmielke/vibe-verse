/**
 * Vibe Golf — particles and effects. Publishes VfxService2.
 *
 * STUB: placeholder. Replaced by the dedicated module author.
 */
import type { System, SystemFactory, VfxService2 } from "../types";

const createVfx: SystemFactory = (ctx) => {
  const service: VfxService2 = {
    burst() {}, splash() {}, ring() {}, trailPuff() {}, screenShake() {},
  };
  ctx.services.vfx = service;
  return { name: "vfx" } as System;
};

export default createVfx;
