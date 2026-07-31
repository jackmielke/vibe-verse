import type { GameModule } from "../ModuleTypes";
import { Effects } from "../systems/Effects";

/**
 * Installs the pooled particle/tracer system as the world's FX bus. Built at
 * order 0 so every later module can spawn effects during its own build.
 */
const mod: GameModule = {
  id: "effects",
  order: 0,
  build(ctx) {
    const fx = new Effects(ctx.scene, ctx.camera, ctx.profile, (x, z) =>
      Math.max(ctx.terrain.height(x, z), ctx.water.sampleHeight(x, z)),
    );
    ctx.fx = fx;
    return {
      update: (dt) => fx.update(dt),
      dispose: () => fx.dispose(),
    };
  },
};

export default mod;
