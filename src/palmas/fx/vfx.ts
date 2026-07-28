/**
 * San Palmas — visual effects.
 *
 * Explosions, tracers, impacts, smoke, debris. Publishes VfxService.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import * as THREE from "three";
import type { System, SystemFactory, VfxService } from "../types";

const createVfx: SystemFactory = (ctx) => {
  const service: VfxService = {
    explosion(_p: THREE.Vector3) {},
    impact() {},
    tracer() {},
    muzzleFlash() {},
    smoke() {},
  };
  ctx.services.vfx = service;
  const sys: System = { name: "vfx" };
  return sys;
};

export default createVfx;
