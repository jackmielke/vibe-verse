/**
 * Vibe Golf — aiming.
 *
 * Slingshot aiming: press anywhere, drag away from the ball, release. The
 * shot fires opposite the drag, with power from the drag length. Identical
 * gesture on mouse and touch, which is the whole reason it's a slingshot and
 * not a click-the-power-bar.
 *
 * Publishes nothing; drives `RulesService.takeShot` and emits aim state for
 * the HUD and the trajectory preview.
 */
import type { System, SystemFactory, Vec2 } from "../types";
import { v2 } from "../types";

/** Drag length in metres that corresponds to full power. */
const FULL_POWER_DRAG = 9.5;
/** Below this the release is treated as a tap, not a shot. */
const MIN_DRAG = 0.7;

const createAim: SystemFactory = (ctx) => {
  let aiming = false;
  let dir = v2(1, 0);
  let power = 0;

  const sys: System = {
    name: "aim",
    update() {
      const input = ctx.input;
      const rules = ctx.services.rules;
      const phys = ctx.services.physics;
      if (!rules || !phys) return;

      const ball = phys.balls.find((b) => b.active);
      if (!ball || !rules.canShoot) {
        if (aiming) {
          aiming = false;
          ctx.emit("golf:aim", { aiming: false, power: 0, angle: 0 });
        }
        return;
      }

      if (input.dragging && input.dragStart && input.pointer) {
        // Pull *away* from the target: the shot fires opposite the drag,
        // exactly like pulling back a slingshot.
        const dx = input.dragStart.x - input.pointer.x;
        const dy = input.dragStart.y - input.pointer.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-4) {
          dir = v2(dx / len, dy / len);
          power = Math.min(1, len / FULL_POWER_DRAG);
          aiming = true;
          ctx.emit("golf:aim", {
            aiming: true,
            power,
            angle: Math.atan2(dir.y, dir.x),
            from: { x: ball.pos.x, y: ball.pos.y },
            dir: { x: dir.x, y: dir.y },
          });
        }
      } else if (input.released && aiming) {
        aiming = false;
        if (power > MIN_DRAG / FULL_POWER_DRAG) {
          rules.takeShot(dir as Vec2, power);
        }
        power = 0;
        ctx.emit("golf:aim", { aiming: false, power: 0, angle: 0 });
      }
    },
  };
  return sys;
};

export default createAim;
