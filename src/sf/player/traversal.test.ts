/**
 * traversal.test.ts — numeric guards on the three things that decide whether
 * this game is any good.
 *
 * These are not unit tests of implementation detail; they are assertions about
 * *feel* expressed as numbers. A regression that makes freefall terminate at
 * 200 m/s, or a wingsuit with a glide ratio of 0.4, is not a subtle bug — it
 * is an unplayable game — and neither shows up in a typecheck.
 *
 * Everything here runs with Rapier absent, which is also the point: the whole
 * player must remain simulatable against the analytic terrain field alone.
 */
import { describe, expect, it, beforeEach } from "vitest";
import * as THREE from "three";
import { PLAYER, WINGSUIT } from "../config";
import { frame, resetFrame, useSfStore } from "../state/store";
import { playerCtrl } from "./controller";
import { grappleSystem } from "./grapple";
import { wingsuit } from "./wingsuit";
import { parachute } from "./parachute";

const DT = 1 / 60;

function step(seconds: number, camera: THREE.PerspectiveCamera): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    frame.time += DT;
    playerCtrl.update(DT, camera);
  }
}

function fresh(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(PLAYER.fov, 16 / 9, 0.15, 9000);
  useSfStore.getState().respawn();
  grappleSystem.clearAll();
  wingsuit.stow();
  parachute.cutaway();
  // A spot out over the bay well clear of terrain, high enough for anything.
  resetFrame(-1200, 1400, 900, 0);
  playerCtrl.init(-1200, 1400, 900, 0);
  return cam;
}

describe("player traversal", () => {
  beforeEach(() => {
    frame.paused = false;
    frame.time = 0;
  });

  it("freefall terminates at PLAYER.terminalVelocity", () => {
    const cam = fresh();
    step(14, cam);
    expect(Number.isFinite(frame.velocity.y)).toBe(true);
    // Quadratic drag is asymptotic, so allow the last few percent.
    expect(-frame.velocity.y).toBeGreaterThan(PLAYER.terminalVelocity * 0.9);
    expect(-frame.velocity.y).toBeLessThan(PLAYER.terminalVelocity * 1.02);
  });

  it("the wingsuit converts altitude into distance", () => {
    const cam = fresh();
    // Nose slightly down at a realistic entry speed.
    frame.pitch = -0.18;
    frame.velocity.set(0, -18, -42);
    step(0.2, cam);
    expect(wingsuit.deploy()).toBe(true);

    const y0 = frame.position.y;
    const x0 = frame.position.x;
    const z0 = frame.position.z;
    step(6, cam);
    const drop = y0 - frame.position.y;
    const run = Math.hypot(frame.position.x - x0, frame.position.z - z0);

    expect(drop).toBeGreaterThan(0);
    // A wingsuit that does not go at least twice as far forward as it falls is
    // not a wingsuit, it is a slow fall.
    expect(run / drop).toBeGreaterThan(2);
    expect(frame.speed).toBeLessThan(WINGSUIT.maxSpeed * 1.05);
    expect(Number.isFinite(frame.speed)).toBe(true);
  });

  it("a vertical wingsuit dive approaches maxSpeed and not beyond", () => {
    const cam = fresh();
    frame.pitch = -1.45;
    frame.velocity.set(0, -30, 0);
    step(0.2, cam);
    wingsuit.deploy();
    step(12, cam);
    expect(frame.speed).toBeGreaterThan(WINGSUIT.maxSpeed * 0.6);
    expect(frame.speed).toBeLessThan(WINGSUIT.maxSpeed * 1.08);
  });

  it("the parachute arrests a terminal fall to its descent rate", () => {
    const cam = fresh();
    step(10, cam); // reach terminal
    expect(parachute.deploy()).toBe(true);
    step(3, cam);
    expect(parachute.inflation).toBeGreaterThan(0.9);
    // Sink rate should be at the canopy's design descent, not a fall.
    expect(-frame.velocity.y).toBeLessThan(12);
    expect(-frame.velocity.y).toBeGreaterThan(1);
  });

  it("the hook bites terrain without physics and reels the player in", () => {
    const cam = fresh();
    // Downtown, 90 m up, aimed steeply at the street below — well inside
    // GRAPPLE.maxRange even at this angle.
    resetFrame(0, 90, 0, 0);
    playerCtrl.init(0, 90, 0, 0);
    frame.pitch = -1.05;
    step(0.05, cam);

    expect(grappleSystem.fire("swing")).toBe(true);
    // Let the hook fly.
    step(1.2, cam);
    const t = grappleSystem.tethers[0];
    expect(t.shared.active).toBe(true);
    expect(t.shared.flying).toBe(false);

    const before = frame.position.distanceTo(t.shared.anchor);
    grappleSystem.setReeling(true);
    step(0.6, cam);
    const after = frame.position.distanceTo(t.shared.anchor);
    expect(after).toBeLessThan(before);
    expect(Number.isFinite(frame.position.x)).toBe(true);
  });

  it("a swing keeps the player on the arc rather than letting the rope stretch", () => {
    const cam = fresh();
    resetFrame(-500, 300, 400, 0);
    playerCtrl.init(-500, 300, 400, 0);
    const t = grappleSystem.tethers[0];
    // Plant an anchor straight overhead and swing under it.
    t.shared.active = true;
    t.shared.flying = false;
    t.shared.anchor.set(-500, 340, 400);
    t.shared.length = 40;
    t.mode = "swing";
    frame.velocity.set(22, 0, 0);
    step(2.5, cam);
    const d = frame.position.distanceTo(t.shared.anchor);
    // Some stretch is intended; a rope that has grown by half is a bug.
    expect(d).toBeLessThan(40 * 1.2);
    expect(d).toBeGreaterThan(4);
  });

  it("cutting at the bottom of a swing is faster than cutting at the top", () => {
    const cam = fresh();
    resetFrame(-500, 300, 400, 0);
    playerCtrl.init(-500, 300, 400, 0);
    const t = grappleSystem.tethers[0];
    t.shared.active = true;
    t.shared.flying = false;
    t.shared.anchor.set(-500, 340, 400);
    t.shared.length = 40;
    t.mode = "swing";
    frame.velocity.set(30, 0, 0);
    step(0.4, cam);
    const speedBefore = frame.speed;
    grappleSystem.cutAll(true);
    expect(frame.velocity.length()).toBeGreaterThan(speedBefore);
  });

  it("fall damage only starts above PLAYER.safeLandingSpeed", () => {
    const cam = fresh();
    const store = useSfStore.getState();
    store.respawn();
    // Land from a height that produces a survivable but painful impact.
    resetFrame(-1200, 40, 900, 0);
    playerCtrl.init(-1200, 40, 900, 0);
    step(6, cam);
    expect(frame.grounded).toBe(true);
    expect(useSfStore.getState().health).toBeLessThan(PLAYER.maxHealth);

    // And a short hop must not hurt at all.
    useSfStore.getState().respawn();
    resetFrame(-1200, 3, 900, 0);
    playerCtrl.init(-1200, 3, 900, 0);
    step(4, cam);
    expect(useSfStore.getState().health).toBe(PLAYER.maxHealth);
  });
});
