/**
 * Vibe Golf — camera.
 *
 * Follows the live ball with a lead based on its velocity, frames the cup
 * when the ball is at rest, and pulls back on big shots so a 60 m drive stays
 * on screen. Clamped to the hole bounds so you never see past the level.
 */
import type { System, SystemFactory } from "../types";
import type { GolfEngine } from "./core";
import { BASE_VIEW_HEIGHT } from "./core";

export interface GolfCameraSystem extends System {
  attachEngine(e: GolfEngine): void;
}

const createCamera: SystemFactory = (ctx) => {
  let engine: GolfEngine | null = null;
  let zoom = 1;
  let tx = 0;
  let ty = 0;
  let userZoom = 1;

  /**
   * An override target, published by the jetpack system while the player is
   * flying the golfer around. Cleared by emitting null.
   */
  let override: { x: number; y: number } | null = null;
  const offTarget = ctx.on("golf:cameraTarget", (p) => {
    override = p && typeof p === "object" ? (p as { x: number; y: number }) : null;
  });

  const sys: GolfCameraSystem = {
    name: "camera",
    attachEngine(e) {
      engine = e;
      tx = e.target.x;
      ty = e.target.y;
    },
    dispose() {
      offTarget();
    },
    update(dt) {
      if (!engine) return;
      const phys = ctx.services.physics;
      const hole = ctx.services.course?.current;
      if (!phys || !hole) return;

      userZoom = Math.max(0.45, Math.min(2.2, userZoom + ctx.input.zoomDelta));

      const ball = phys.balls.find((b) => b.active);
      let wantX: number;
      let wantY: number;
      let wantZoom = userZoom;

      if (override) {
        // Someone else owns the framing (the jetpack, a cutscene).
        wantX = override.x;
        wantY = override.y;
      } else if (ball && !ball.resting) {
        // Lead the ball so you can see where it's going, not where it was.
        wantX = ball.pos.x + ball.vel.x * 0.32;
        wantY = ball.pos.y + ball.vel.y * 0.22;
        const speed = Math.hypot(ball.vel.x, ball.vel.y);
        wantZoom = userZoom * Math.max(0.55, 1 - speed / 90);
      } else if (ball) {
        // At rest: bias toward the cup so the player can read the shot.
        wantX = ball.pos.x * 0.68 + hole.cup.x * 0.32;
        wantY = ball.pos.y * 0.74 + hole.cup.y * 0.26;
        const spread = Math.hypot(hole.cup.x - ball.pos.x, hole.cup.y - ball.pos.y);
        wantZoom = userZoom * Math.max(0.5, Math.min(1, 42 / Math.max(24, spread)));
      } else {
        wantX = hole.cup.x;
        wantY = hole.cup.y;
      }

      // Critically-damped-ish follow: fast enough to keep up, smooth enough
      // not to jitter on bounces.
      const k = 1 - Math.exp(-dt * 5.2);
      tx += (wantX - tx) * k;
      ty += (wantY - ty) * k;
      zoom += (wantZoom - zoom) * (1 - Math.exp(-dt * 3.4));

      // Clamp to the hole so the camera never reveals the void.
      const aspect = window.innerWidth / Math.max(1, window.innerHeight);
      const halfH = (BASE_VIEW_HEIGHT / 2) / zoom;
      const halfW = halfH * aspect;
      const { min, max } = hole.bounds;
      const cx = Math.min(Math.max(tx, min.x + halfW), Math.max(min.x + halfW, max.x - halfW));
      const cy = Math.min(Math.max(ty, min.y + halfH), Math.max(min.y + halfH, max.y - halfH));

      engine.zoom = zoom;
      engine.target.set(cx, cy);
    },
  };
  return sys;
};

export default createCamera;
