/**
 * Vibe Golf — the rules.
 *
 * Strokes, the cup test, hazard resets, hole progression and the power-up
 * inventory. This is the only module that decides what a "shot" means.
 * Publishes `RulesService`.
 */
import type { BallState, BallType, RulesService, System, SystemFactory, Vec2 } from "../types";
import { BALL_TYPES, v2 } from "../types";

const CUP_RADIUS = 0.62;
/** A ball moving faster than this lips out instead of dropping. */
const CUP_CAPTURE_SPEED = 13;
const BALL_RADIUS = 0.32;

function makeBall(pos: Vec2, type: BallType): BallState {
  return {
    pos: v2(pos.x, pos.y),
    vel: v2(0, 0),
    spin: 0,
    radius: BALL_RADIUS,
    type,
    resting: true,
    restTimer: 0,
    stuck: false,
    active: true,
    trail: [],
  };
}

const createRules: SystemFactory = (ctx) => {
  const balls = () => ctx.services.physics?.balls ?? [];
  /** Where the current shot started, for hazard resets. */
  let shotOrigin = v2(0, 0);
  let settleGrace = 0;

  const service: RulesService = {
    strokes: 0,
    totalStrokes: 0,
    canShoot: false,
    holeComplete: false,
    ballType: "standard",
    inventory: { sticky: 3, ice: 3, nitro: 3, super: 3, multi: 2, ghost: 2, heavy: 3 },

    setBallType(t: BallType) {
      if (t !== "standard" && !(this.inventory[t] ?? 0)) return;
      this.ballType = t;
      const arr = balls();
      for (const b of arr) if (b.active) b.type = t;
      ctx.emit("golf:ballType", t);
    },

    takeShot(dir: Vec2, power: number) {
      if (!this.canShoot) return;
      const list = balls();
      const live = list.find((b) => b.active) ?? null;
      if (!live) return;

      shotOrigin = v2(live.pos.x, live.pos.y);
      const shotType = this.ballType;
      const props = BALL_TYPES[shotType];
      const speed = 6 + power * 46 * props.power;

      // Multi-ball splits the shot into a fan; the best resting ball is kept.
      const n = props.split ?? 1;
      list.length = 0;
      for (let i = 0; i < n; i++) {
        const spreadAng = n > 1 ? (i - (n - 1) / 2) * 0.085 : 0;
        const c = Math.cos(spreadAng);
        const s = Math.sin(spreadAng);
        const b = makeBall(shotOrigin, shotType);
        b.vel.x = (dir.x * c - dir.y * s) * speed;
        b.vel.y = (dir.x * s + dir.y * c) * speed;
        b.spin = -dir.x * power * 9;
        b.resting = false;
        list.push(b);
      }

      this.strokes++;
      this.totalStrokes++;
      this.canShoot = false;
      settleGrace = 0.25;

      if (shotType !== "standard") {
        const left = (this.inventory[shotType] ?? 0) - 1;
        this.inventory[shotType] = Math.max(0, left);
        if (left <= 0) this.ballType = "standard";
      }

      ctx.services.audio?.play("swing", { volume: 0.5 + power * 0.5 });
      ctx.emit("golf:shot", { strokes: this.strokes, power, type: shotType });
    },

    resetBall() {
      const list = balls();
      list.length = 0;
      list.push(makeBall(shotOrigin, "standard"));
      this.ballType = "standard";
      this.canShoot = true;
    },
  };

  ctx.services.rules = service;

  /** Place a fresh ball on the tee when a hole loads. */
  const offHole = ctx.on("golf:hole", (payload) => {
    const { hole } = payload as { hole: { tee: Vec2 } };
    const list = balls();
    list.length = 0;
    shotOrigin = v2(hole.tee.x, hole.tee.y);
    list.push(makeBall(hole.tee, "standard"));
    service.strokes = 0;
    service.holeComplete = false;
    service.canShoot = true;
    service.ballType = "standard";
  });

  /** A hazard kills the ball; replay from where the shot was struck. */
  const offHazard = ctx.on("golf:hazard", () => {
    if (service.holeComplete) return;
    ctx.services.vfx?.splash(v2(shotOrigin.x, shotOrigin.y), "water");
    ctx.services.audio?.play("splash");
    // Penalty stroke, then drop back at the previous lie.
    service.strokes++;
    service.totalStrokes++;
    window.setTimeout(() => {
      if (service.holeComplete) return;
      service.resetBall();
      ctx.emit("golf:penalty", { strokes: service.strokes });
    }, 420);
  });

  const sys: System = {
    name: "rules",
    update(dt) {
      const phys = ctx.services.physics;
      const hole = ctx.services.course?.current;
      if (!phys || !hole || service.holeComplete) return;

      if (settleGrace > 0) settleGrace -= dt;

      // Cup test — a slow ball inside the cup radius drops.
      for (const b of phys.balls) {
        if (!b.active) continue;
        const d = Math.hypot(b.pos.x - hole.cup.x, b.pos.y - hole.cup.y);
        const sp = Math.hypot(b.vel.x, b.vel.y);
        if (d < CUP_RADIUS && sp < CUP_CAPTURE_SPEED) {
          b.active = false;
          service.holeComplete = true;
          service.canShoot = false;
          ctx.services.audio?.play("holed");
          ctx.services.vfx?.ring(v2(hole.cup.x, hole.cup.y), 2.2, 0xfbbf24);
          ctx.emit("golf:holed", {
            strokes: service.strokes,
            par: hole.par,
            total: service.totalStrokes,
          });
          return;
        }
      }

      const live = phys.balls.filter((b) => b.active);
      if (live.length === 0) return;

      // Multi-ball: once everything has settled, keep whichever ended nearest
      // the cup and retire the rest.
      const allResting = live.every((b) => b.resting);
      if (allResting && settleGrace <= 0) {
        if (live.length > 1) {
          let best = live[0];
          let bestD = Infinity;
          for (const b of live) {
            const d = Math.hypot(b.pos.x - hole.cup.x, b.pos.y - hole.cup.y);
            if (d < bestD) { bestD = d; best = b; }
          }
          for (const b of live) if (b !== best) b.active = false;
        }
        if (!service.canShoot) {
          service.canShoot = true;
          ctx.emit("golf:ready", { strokes: service.strokes });
        }
      }
    },
    dispose() {
      offHole();
      offHazard();
    },
  };

  return sys;
};

export default createRules;
