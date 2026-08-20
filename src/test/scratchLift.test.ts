import { describe, it } from "vitest";
import { buildCollision, type Deck } from "@/empyrean/collide";
import { makeFlyer, stepFlyer } from "@/empyrean/flight";
import { ISLAND_Y, KILL_Y, SPAWN } from "@/empyrean/config";

/** Ride a deck that rises at `speed`, stepping at `dt`, and report the outcome. */
function ride(speed: number, dt: number, cap = Infinity) {
  const car: Deck = { y: ISLAND_Y, x: 0, z: 0, hx: 2.5, hz: 2.5 };
  const world = buildCollision([], [car]);
  const s = makeFlyer({ x: 0, y: ISLAND_Y, z: 0, yaw: 0 });
  const w = {
    supportAt: world.supportAt,
    blockedAt: (x: number, z: number, y: number) => world.blockedAt(x, z, y),
    killY: KILL_Y,
    spawn: SPAWN,
  };
  let worstGap = 0;
  let detached = false;
  for (let i = 0; i < Math.ceil(300 / (speed * dt)); i++) {
    stepFlyer(s, { forward: 0, strafe: 0, run: false, jet: false, camYaw: 0 }, w, dt);
    // then the system moves the car (systems update after the body in world.ts)
    car.y += Math.min(speed * dt, cap);
    const gap = car.y - s.position.y;
    if (gap > worstGap) worstGap = gap;
    if (gap > 3) { detached = true; break; }
  }
  return { rose: s.position.y - ISLAND_Y, carRose: car.y - ISLAND_Y, worstGap, detached, grounded: s.grounded };
}

describe("lift speed limit", () => {
  it("finds where a rising deck leaves the body behind", () => {
    for (const dt of [1 / 60, 1 / 30, 0.05]) {
      for (const speed of [3, 6, 9, 11, 12, 12.4, 13, 15, 20, 30]) {
        const r = ride(speed, dt);
        console.log(
          `dt=${dt.toFixed(4)} v=${speed}`,
          "rose", r.rose.toFixed(2), "car", r.carRose.toFixed(2),
          "gap", r.worstGap.toFixed(3), r.detached ? "DETACHED" : "ok", "grounded", r.grounded,
        );
      }
      console.log("---");
    }
  });
  it("checks the per-frame cap makes any speed safe", () => {
    for (const dt of [1 / 60, 0.05]) {
      for (const speed of [11, 20, 60]) {
        const r = ride(speed, dt, 0.45);
        console.log(`capped dt=${dt.toFixed(4)} v=${speed}`, "rose", r.rose.toFixed(2), "car", r.carRose.toFixed(2), "gap", r.worstGap.toFixed(3), r.detached ? "DETACHED" : "ok");
      }
    }
  });
  it("measures the sag on the way down", () => {
    for (const speed of [2, 3, 3.5, 4, 6, 9, 11]) {
      const car: Deck = { y: ISLAND_Y + 300, x: 0, z: 0, hx: 2.5, hz: 2.5 };
      const world = buildCollision([], [car]);
      const s = makeFlyer({ x: 0, y: ISLAND_Y + 300, z: 0, yaw: 0 });
      const w = { supportAt: world.supportAt, blockedAt: (x: number, z: number, y: number) => world.blockedAt(x, z, y), killY: KILL_Y, spawn: SPAWN };
      const dt = 1 / 60;
      let worst = 0; let ungrounded = 0;
      for (let i = 0; i < 300 / (speed * dt); i++) {
        stepFlyer(s, { forward: 0, strafe: 0, run: false, jet: false, camYaw: 0 }, w, dt);
        car.y -= speed * dt;
        const sag = s.position.y - car.y;
        if (sag > worst) worst = sag;
        if (!s.grounded) ungrounded++;
      }
      console.log(`down v=${speed} worstSag=${worst.toFixed(3)} ungroundedFrames=${ungrounded}`);
    }
  });
});
