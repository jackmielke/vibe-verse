/**
 * San Palmas — combat routing.
 *
 * Damage, explosions and target registry. Publishes CombatService.
 *
 * STUB: placeholder implementation. Replaced by the dedicated module author.
 */
import * as THREE from "three";
import type { CombatService, DamageTarget, System, SystemFactory } from "../types";

const createCombat: SystemFactory = (ctx) => {
  const targets = new Set<DamageTarget>();

  const service: CombatService = {
    registerTarget(t) { targets.add(t); return () => targets.delete(t); },
    queryTargets(point, radius) {
      const out: DamageTarget[] = [];
      for (const t of targets) {
        if (t.object.position.distanceTo(point) <= radius + t.radius) out.push(t);
      }
      return out;
    },
    damageAt(point, amount, source) {
      let any = false;
      for (const t of this.queryTargets(point, 0.6)) {
        t.onDamage(amount, point, source);
        any = true;
      }
      return any;
    },
    explode(point, radius, force) {
      ctx.services.vfx?.explosion(point, radius / 8);
      ctx.services.audio?.play("explosion", { position: point });
      for (const t of this.queryTargets(point, radius)) {
        const d = t.object.position.distanceTo(point);
        const falloff = Math.max(0, 1 - d / radius);
        t.onDamage(force * falloff, point, "explosion");
      }
      const player = ctx.services.player;
      if (player) {
        const d = player.position.distanceTo(point);
        if (d < radius) player.damage(force * 0.5 * (1 - d / radius), point);
      }
    },
  };
  ctx.services.combat = service;

  const sys: System = { name: "combat" };
  return sys;
};

export default createCombat;
