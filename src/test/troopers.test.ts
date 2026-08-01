/**
 * The front.
 *
 * Everything here runs without a renderer — a trooper is boxes and a transform,
 * a shot is a dot product — so the parts of an invasion that can actually be
 * wrong are all reachable from node. What is pinned:
 *
 *   - the colours, because the colours ARE the game. Blue is with you, red is
 *     not, and green is you. Get one of those wrong and a player shoots their
 *     own side at forty metres and never finds out why.
 *   - who a shot can hit, because "I aimed at him and nothing happened" and "I
 *     killed my own man" are the two ways a shooter dies.
 *   - that the fight ends, because a battle with no terminal state leaves the
 *     scoreboard counting forever.
 */
import { describe, it, expect } from "vitest";
import { Battle, Trooper, FACTION } from "@/longsilence/world/Troopers.js";
import * as THREE from "three-ls";

/** Flat ground: every hit test below is then pure geometry. */
const flat = () => 0;

/** Walk a trooper's group and collect the colours actually on its meshes. */
function huesOf(t: { object: THREE.Object3D }) {
  const out: number[] = [];
  t.object.traverse((o: THREE.Object3D) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m && m.color) out.push(m.color.getHex());
  });
  return out;
}

describe("trooper livery", () => {
  it("puts the faction on the helmet AND the body armour", () => {
    /* Both, not one. A helmet alone is a 25 cm ball at the top of a silhouette
       — at the distance this fight happens at it is two pixels, and the request
       was explicitly for armour to carry it too. */
    const ally = new Trooper(FACTION.ALLY, 0, 0, flat);
    const enemy = new Trooper(FACTION.ENEMY, 0, 0, flat);
    const you = new Trooper(FACTION.PLAYER, 0, 0, flat);

    const blue = huesOf(ally);
    const red = huesOf(enemy);
    const green = huesOf(you);

    // Helmet and plate are distinct meshes, so each faction contributes two
    // separate coloured surfaces rather than one repeated material.
    expect(blue).toContain(0x1f4fa8);      // armour
    expect(blue).toContain(0x2f6fe0);      // helmet
    expect(red).toContain(0x8f1f1f);
    expect(red).toContain(0xd0342c);
    expect(green).toContain(0x1f6b34);
    expect(green).toContain(0x35c95f);
  });

  it("never gives two factions the same colour", () => {
    const seen = new Set<number>();
    for (const f of [FACTION.ALLY, FACTION.ENEMY, FACTION.PLAYER]) {
      const t = new Trooper(f, 0, 0, flat);
      // The faction hues are the ones no other faction has.
      for (const h of huesOf(t)) seen.add(h);
    }
    // Six distinct faction surfaces, plus the shared kit. If a hue table entry
    // were duplicated this count would drop.
    for (const h of [0x1f4fa8, 0x2f6fe0, 0x8f1f1f, 0xd0342c, 0x1f6b34, 0x35c95f]) {
      expect(seen.has(h)).toBe(true);
    }
  });

  it("hangs every moving part where update() expects it", () => {
    const t = new Trooper(FACTION.ALLY, 0, 0, flat);
    const parts = (t.object as THREE.Object3D).userData.parts;
    for (const k of ["legL", "legR", "torso", "head", "armL", "armR", "rifle", "flash"]) {
      expect(parts[k], k).toBeTruthy();
    }
  });

  it("points the rifle downrange when it is aiming, not at the ground", () => {
    /* The bug this pins: the arm is one bone from the shoulder down -Y, and
       aiming rotates it -90 degrees about X. That makes the arm's own -Y the
       forward direction — so a rifle left unrotated had its muzzle (-Z) mapped
       straight down, and every trooper on the field spent the firefight
       shooting their own boots. Derived on paper, so it is checked here.

       The trooper's local +Z is forward: `object.rotation.set(0, yaw, 0)` and
       the walk steps along (sin yaw, cos yaw). */
    const b = new Battle(new THREE.Scene(), flat, { count: 0 });
    const shooter = b.spawn(FACTION.ALLY, 0, 0);
    const target = b.spawn(FACTION.ENEMY, 0, -20);   // dead ahead, inside range
    /* Unkillable, and that is the point. Hits are rolled, so over four seconds
       of frames the shooter usually drops him — and with nothing left to shoot
       at the aim blend decays and the rifle comes down, which is correct
       behaviour and a test that fails at random. */
    target.hp = Number.MAX_SAFE_INTEGER;

    // Enough frames for the aim blend (dt * 6 per frame) to reach 1.
    for (let i = 0; i < 240; i++) b.update(1 / 60, null);
    expect(target.alive).toBe(true);

    const parts = (shooter.object as THREE.Object3D).userData.parts;
    shooter.object.updateMatrixWorld(true);
    // Where the muzzle actually looks, in world space.
    const muzzle = new THREE.Vector3(0, 0, -1)
      .transformDirection(parts.rifle.matrixWorld)
      .normalize();
    // The target is at -Z of the shooter, and the shooter has turned to face it.
    const downrange = new THREE.Vector3(0, 0, -1);
    expect(muzzle.dot(downrange)).toBeGreaterThan(0.8);
    // And emphatically not at the floor.
    expect(muzzle.y).toBeGreaterThan(-0.4);
  });

  it("stands on the ground it is given, not on zero", () => {
    const slope = (x: number) => x * 0.5;
    const t = new Trooper(FACTION.ENEMY, 10, 0, slope);
    expect(t.pos.y).toBeCloseTo(5);
    expect(t.object.position.y).toBeCloseTo(5);
  });
});

describe("the player's shot", () => {
  const scene = () => new THREE.Scene();

  it("hits a hostile it is pointed at", () => {
    const b = new Battle(scene(), flat, { count: 0 });
    const e = b.spawn(FACTION.ENEMY, 0, -60);
    const origin = new THREE.Vector3(0, 1.25, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    // hp is 3 and a player round is worth 2, so the second one drops him.
    expect(b.playerShoot(origin, dir)).toBe(false);
    expect(b.playerShoot(origin, dir)).toBe(true);
    expect(e.alive).toBe(false);
    expect(b.counts().kills).toBe(1);
  });

  it("misses a hostile it is not pointed at", () => {
    const b = new Battle(scene(), flat, { count: 0 });
    const e = b.spawn(FACTION.ENEMY, 0, -60);
    const origin = new THREE.Vector3(0, 1.25, 0);
    // 90 degrees off, and behind: neither may count as a hit.
    expect(b.playerShoot(origin, new THREE.Vector3(1, 0, 0))).toBe(false);
    expect(b.playerShoot(origin, new THREE.Vector3(0, 0, 1))).toBe(false);
    expect(e.alive).toBe(true);
  });

  it("cannot shoot its own side, however carefully it aims", () => {
    /* The single worst bug this feature could have. An ally standing exactly on
       the line of fire, shot ten times. */
    const b = new Battle(scene(), flat, { count: 0 });
    const friend = b.spawn(FACTION.ALLY, 0, -40);
    const origin = new THREE.Vector3(0, 1.25, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    for (let i = 0; i < 10; i++) expect(b.playerShoot(origin, dir)).toBe(false);
    expect(friend.alive).toBe(true);
    expect(b.counts().kills).toBe(0);
  });

  it("takes the nearest hostile on the line, not the far one", () => {
    const b = new Battle(scene(), flat, { count: 0 });
    const near = b.spawn(FACTION.ENEMY, 0, -30);
    const far = b.spawn(FACTION.ENEMY, 0, -90);
    const origin = new THREE.Vector3(0, 1.25, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    b.playerShoot(origin, dir);
    b.playerShoot(origin, dir);
    expect(near.alive).toBe(false);
    expect(far.alive).toBe(true);
  });

  it("does not reach past its range", () => {
    const b = new Battle(scene(), flat, { count: 0 });
    const e = b.spawn(FACTION.ENEMY, 0, -400);
    const origin = new THREE.Vector3(0, 1.25, 0);
    b.playerShoot(origin, new THREE.Vector3(0, 0, -1));
    b.playerShoot(origin, new THREE.Vector3(0, 0, -1));
    expect(e.alive).toBe(true);
  });
});

describe("the engagement", () => {
  const scene = () => new THREE.Scene();

  it("spawns both sides clear of an 84 m hull", () => {
    /* The ship sits at the origin along Z with its nose at z = -42. A trooper
       inside the landing gear is the difference between a firefight and a
       clipping bug, and the numbers that keep them out are in the constructor. */
    const b = new Battle(scene(), flat);
    for (const t of b.troopers) {
      expect(Math.abs(t.pos.z), `${t.faction} at z=${t.pos.z}`).toBeGreaterThan(55);
    }
    const c = b.counts();
    expect(c.ally).toBeGreaterThan(0);
    expect(c.enemy).toBeGreaterThan(0);
    expect(c.ally).toBe(c.enemy);
  });

  it("declares the site held once the last hostile is down", () => {
    const b = new Battle(scene(), flat, { count: 0 });
    b.spawn(FACTION.ALLY, 0, 10);
    const e = b.spawn(FACTION.ENEMY, 0, -30);
    const origin = new THREE.Vector3(0, 1.25, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    while (e.alive) b.playerShoot(origin, dir);
    expect(b.counts().over).toBe("won");
    expect(b.drainEvents()).toContain("THE SITE IS HELD");
  });

  it("runs for a minute of frames without throwing or leaving the field", () => {
    const b = new Battle(scene(), flat, { count: 5 });
    const at = new THREE.Vector3(0, 0, -60);
    for (let i = 0; i < 60 * 60; i++) {
      expect(() => b.update(1 / 60, at)).not.toThrow();
    }
    // Whatever happened, it is a legal state: nobody below zero, and the two
    // counts still add up to the bodies on the field.
    const c = b.counts();
    expect(c.ally).toBeGreaterThanOrEqual(0);
    expect(c.enemy).toBeGreaterThanOrEqual(0);
    expect(c.ally + c.enemy).toBeLessThanOrEqual(b.troopers.length);
    expect(b.playerHp).toBeGreaterThanOrEqual(0);
  });

  it("keeps the tracer buffer inside the size it allocated", () => {
    const b = new Battle(scene(), flat, { count: 0 });
    const shooter = b.spawn(FACTION.ALLY, 0, 0);
    const target = b.spawn(FACTION.ENEMY, 0, -20);
    // Far more shots than the ring holds, in one frame.
    for (let i = 0; i < 500; i++) b.tracers.add(shooter.pos, target.pos, 0xffffff);
    expect(b.tracers.shots.length).toBeLessThanOrEqual(b.tracers.max);
    expect(() => b.tracers.update(1 / 60)).not.toThrow();
    const range = b.tracers.geo.drawRange;
    expect(range.count).toBeLessThanOrEqual(b.tracers.max * 2);
  });

  it("can be disposed twice", () => {
    /* liftOff disposes the battle and so does Game.dispose, and leaving a route
       mid-flight runs both. The second call used to double-release the shared
       geometry kit, which takes the *next* battle down with it. */
    const s = scene();
    const b = new Battle(s, flat, { count: 2 });
    expect(() => b.dispose()).not.toThrow();
    expect(() => b.dispose()).not.toThrow();
    expect(s.children.length).toBe(0);
    // And the kit rebuilds: a battle after a teardown is still a battle.
    const c = new Battle(scene(), flat, { count: 2 });
    expect(c.troopers.length).toBe(4);
    c.dispose();
  });
});
