/**
 * The front, from where the player is actually standing.
 *
 * `troopers.test.ts` pins the things a trooper is — colours, hit tests, that
 * the fight terminates. This file pins the things the *fight* is, and it exists
 * because of a bug report that was wrong about its own cause: "the blue allies
 * are not spawning".
 *
 * They were spawning. A hundred simulated battles had all nine allies alive ten
 * seconds in and the median engagement ran a minute and a half. What they were
 * not was in frame — the allied line formed six to eighteen metres ahead of the
 * ramp with a 76 m lateral spread centred on the hull, i.e. up to sixty-eight
 * metres off to the player's left at almost no depth, which is sixty to
 * eighty-five degrees off the view axis. Two or three of nine were on screen.
 * The hostile line, seventy metres downrange, was entirely on screen. So: a
 * full red line, no blue, and a report that the allies never turned up.
 *
 * Everything below is therefore measured from the camera rather than from the
 * origin, and the camera's numbers are re-derived here from `Game.js` rather
 * than imported from `Troopers.js` — a framing test that reads its own frame
 * out of the thing it is testing proves nothing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Battle, Trooper, FACTION } from "@/longsilence/world/Troopers.js";
import * as THREE from "three-ls";

const flat = () => 0;
const scene = () => new THREE.Scene();

/* Game.disembark, on a contested world: boardAt = (R * 0.36, -R * 0.74) for an
   84 m hull, yaw 0 — which is looking straight down -Z. Game.updateCamera puts
   the on-foot eye there and settles the FOV to 68. */
const HULL = 84;
const EYE = new THREE.Vector3(HULL * 0.36, 1.7, -HULL * 0.74);
const ON_FOOT_FOV = 68;

/** The frustum the player is actually looking through when the ramp drops. */
function ramp(aspect: number) {
  const cam = new THREE.PerspectiveCamera(ON_FOOT_FOV, aspect, 0.5, 4000);
  cam.position.copy(EYE);
  cam.updateMatrixWorld(true);
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
  );
}

const _p = new THREE.Vector3();
function inFrame(b: Battle, frustum: THREE.Frustum, faction: string) {
  return b.troopers.filter((t: Trooper) => t.faction === faction && frustum.containsPoint(t.chest(_p))).length;
}

describe("both lines are where the player is looking", () => {
  it("puts every allied trooper on screen when the ramp comes down", () => {
    /* The regression. Under the old layout this averaged 2.4 of 9 and was
       frequently 2 — which is the whole bug report. It is asserted as *every*
       one rather than as a majority because the layout is deterministic enough
       to promise that: the widest ally sits about 36 degrees off axis and the
       frame is 50 either side. */
    const wide = ramp(16 / 9);
    for (let n = 0; n < 40; n++) {
      const b = new Battle(scene(), flat, {});
      const allies = inFrame(b, wide, FACTION.ALLY);
      const hostiles = inFrame(b, wide, FACTION.ENEMY);
      expect(allies, "allies in frame").toBe(9);
      expect(hostiles, "hostiles in frame").toBe(9);
      b.dispose();
    }
  });

  it("keeps both lines readable in a phone's portrait frame", () => {
    /* A 9:16 frame is 22 degrees either side, so nobody sees the whole field on
       a phone and that is fine — turning your head is one swipe. What must not
       happen is the desktop failure in miniature: a screenful of red and no
       blue. So the test is symmetry, not headcount. */
    const tall = ramp(9 / 16);
    for (let n = 0; n < 40; n++) {
      const b = new Battle(scene(), flat, { count: 6 });    // the mobile budget
      const allies = inFrame(b, tall, FACTION.ALLY);
      const hostiles = inFrame(b, tall, FACTION.ENEMY);
      expect(allies, "allies in frame").toBeGreaterThanOrEqual(2);
      expect(Math.abs(allies - hostiles), "one line far better represented than the other")
        .toBeLessThanOrEqual(2);
      b.dispose();
    }
  });

  it("stands blue between you and red, at a distance you can read", () => {
    /* Depth along the view axis, which is the axis the old layout got wrong:
       the allies were nearer than the hostiles, but by six metres rather than
       thirty, so they were beside the player rather than in front. Twenty
       metres is the floor at which a whole soldier fits in frame; the hostiles
       have to be beyond every one of them or the colours stop meaning near and
       far. */
    for (let n = 0; n < 40; n++) {
      const b = new Battle(scene(), flat, {});
      let nearestEnemy = Infinity;
      let farthestAlly = 0;
      for (const t of b.troopers) {
        const depth = -(t.pos.z - EYE.z);
        if (t.faction === FACTION.ALLY) {
          expect(depth, "an ally is standing on top of you").toBeGreaterThan(20);
          farthestAlly = Math.max(farthestAlly, depth);
        } else {
          nearestEnemy = Math.min(nearestEnemy, depth);
        }
      }
      expect(farthestAlly).toBeLessThan(nearestEnemy);
      b.dispose();
    }
  });
});

describe("the fight moves", () => {
  it("bounds: somebody is always moving, and never the whole side at once", () => {
    /* The old fight had exactly one movement phase. Both lines walked until
       they were inside 45 m — a few seconds — and then stood perfectly still
       for the remaining eighty, which is a shooting gallery with two ends.
       Sampled from t = 20 s so the opening advance cannot be what passes it. */
    const b = new Battle(scene(), flat, {});
    let t = 0;
    const moved = { ally: 0, enemy: 0 };
    const most = { ally: 0, enemy: 0 };
    while (t < 45 && !b.over) {
      b.update(1 / 30, null);
      t += 1 / 30;
      if (t < 20) continue;
      const now = { ally: 0, enemy: 0 };
      for (const tr of b.troopers) {
        if (tr.alive && tr.state === "bound") now[tr.faction as "ally" | "enemy"]++;
      }
      for (const side of ["ally", "enemy"] as const) {
        if (now[side]) moved[side]++;
        most[side] = Math.max(most[side], now[side]);
      }
    }
    expect(moved.ally, "no ally moved in twenty-five seconds of fighting").toBeGreaterThan(0);
    expect(moved.enemy, "no hostile moved in twenty-five seconds of fighting").toBeGreaterThan(0);
    // A side that stands up all at once is charging, not bounding.
    expect(most.ally).toBeLessThanOrEqual(5);
    expect(most.enemy).toBeLessThanOrEqual(5);
    b.dispose();
  });

  it("holds the lane it was given rather than walking out of frame", () => {
    /* Bounds may take ground and may sidestep. What they may not do is let the
       line drift sideways for ninety seconds until the fight is happening
       somewhere the player is not looking. */
    const b = new Battle(scene(), flat, {});
    const home = new Map(b.troopers.map((t: Trooper) => [t, t.home.x]));
    for (let i = 0; i < 30 * 90 && !b.over; i++) b.update(1 / 30, null);
    for (const t of b.troopers) {
      expect(Math.abs(t.pos.x - (home.get(t) as number)), `${t.faction} drifted`).toBeLessThan(14);
    }
    b.dispose();
  });

  it("stops short of walking into their rifles", () => {
    const b = new Battle(scene(), flat, {});
    for (let i = 0; i < 30 * 120 && !b.over; i++) b.update(1 / 30, null);
    for (const t of b.troopers) {
      if (!t.alive || !t.target || !t.target.alive) continue;
      // STANDOFF is 28; a bound in progress is allowed to be short of settling.
      expect(t.pos.distanceTo(t.target.pos), "the lines merged").toBeGreaterThan(18);
    }
    b.dispose();
  });
});

describe("cover, if the battlefield has any", () => {
  /** Roughly what world/Battlefield.js is expected to hand over. */
  const sandbags = (axis: number) => {
    const out = [];
    for (let i = 0; i < 8; i++) {
      out.push({ x: axis + (i / 7 - 0.5) * 40, z: -104, r: 1.4, faction: FACTION.ALLY });
      out.push({ x: axis + (i / 7 - 0.5) * 70, z: -124, r: 1.4, faction: FACTION.ENEMY });
    }
    return out;
  };

  it("gets troopers behind it", () => {
    const b = new Battle(scene(), flat, { cover: sandbags(HULL * 0.36) });
    let ally = 0;
    let enemy = 0;
    for (let i = 0; i < 30 * 60 && !b.over; i++) {
      b.update(1 / 30, null);
      for (const t of b.troopers) {
        if (!t.inCover) continue;
        if (t.faction === FACTION.ALLY) ally++; else enemy++;
      }
    }
    expect(ally, "no ally ever reached cover").toBeGreaterThan(0);
    expect(enemy, "no hostile ever reached cover").toBeGreaterThan(0);
    b.dispose();
  });

  it("never lets a trooper claim the other side's sandbags", () => {
    const cover = sandbags(HULL * 0.36);
    const b = new Battle(scene(), flat, { cover });
    let claims = 0;
    for (let i = 0; i < 30 * 60 && !b.over; i++) {
      b.update(1 / 30, null);
      for (const t of b.troopers) {
        if (!t.coverSpot) continue;
        claims++;
        expect(t.coverSpot.faction).toBe(t.faction);
      }
    }
    expect(claims, "nobody claimed anything, so the check above proved nothing").toBeGreaterThan(0);
    b.dispose();
  });

  it("survives a battlefield that supplies none, or supplies rubbish", () => {
    /* Battlefield.js is a separate module on a separate schedule. Every one of
       these is a shape this file may genuinely be handed. */
    for (const cover of [
      undefined,
      null,
      [],
      "sandbags",
      [null, undefined, {}, { x: "seven", z: 3 }, { x: NaN, z: 0 }],
      () => { throw new Error("not built yet"); },
      () => [{ x: 20, z: -104 }],
    ] as unknown[]) {
      const b = new Battle(scene(), flat, { count: 3, cover });
      expect(() => { for (let i = 0; i < 300; i++) b.update(1 / 30, null); }).not.toThrow();
      b.dispose();
    }
  });
});

describe("posture decides how hard you are to kill", () => {
  afterEach(() => vi.restoreAllMocks());

  /** One roll, one outcome — `fire` is the only thing that consumes randomness here. */
  const shootOnce = (roll: number, pose: (t: Trooper) => void) => {
    const b = new Battle(scene(), flat, { count: 0 });
    const shooter = b.spawn(FACTION.ALLY, 0, 0);
    const target = b.spawn(FACTION.ENEMY, 0, -30);
    target.hp = 1;
    pose(target);
    const dice = vi.spyOn(Math, "random").mockReturnValue(roll);
    b.fire(shooter, target);
    const alive = target.alive;
    dice.mockRestore();
    b.dispose();
    return alive;
  };

  it("makes a man behind sandbags survive the round that kills a man in the open", () => {
    const roll = 0.12;                       // under the base chance, over the covered one
    expect(shootOnce(roll, () => {})).toBe(false);
    expect(shootOnce(roll, (t) => { t.inCover = true; })).toBe(true);
  });

  it("makes a man up and running easier to hit than a man holding", () => {
    const roll = 0.25;                       // over the base chance, under the bounding one
    expect(shootOnce(roll, () => {})).toBe(true);
    expect(shootOnce(roll, (t) => { t.state = "bound"; })).toBe(false);
  });
});

describe("a death you can see land", () => {
  it("staggers before it falls", () => {
    /* One beat is a mannequin tipping over. The round lands, he rocks back, and
       then he goes down — so at a tenth of a second the group is pitched the
       *wrong* way, which is what makes the hit legible from thirty metres. */
    const b = new Battle(scene(), flat, { count: 0 });
    const t = b.spawn(FACTION.ENEMY, 0, -30);
    t.hp = 1;
    t.hit(1);
    expect(t.alive).toBe(false);

    for (let i = 0; i < 3; i++) b.update(1 / 30, null);         // 0.1 s
    expect(t.object.rotation.x, "he went straight over").toBeGreaterThan(0.1);

    for (let i = 0; i < 60; i++) b.update(1 / 30, null);        // 2.1 s
    expect(t.object.rotation.x).toBeCloseTo(-Math.PI * 0.5, 1);
    // And he is where he fell, not where he was standing.
    expect(t.object.position.z).toBeLessThan(t.pos.z - 0.3);
    b.dispose();
  });

  it("flinches on a round that does not kill, without moving the hit box", () => {
    const b = new Battle(scene(), flat, { count: 0 });
    const t = b.spawn(FACTION.ENEMY, 0, -30);
    b.spawn(FACTION.ALLY, 0, 0);                                 // someone to face
    const before = t.pos.clone();
    expect(t.hit(1)).toBe(false);
    b.update(1 / 60, null);

    const parts = (t.object as THREE.Object3D).userData.parts;
    expect(parts.torso.rotation.x, "no reaction to being shot").toBeLessThan(-0.2);
    /* The stumble is on the object, never on `pos`. Hit tests and tracer
       endpoints read `pos`, and a soldier who becomes briefly un-shootable
       because he is being shot is the worst possible reward for hitting him. */
    expect(t.pos.distanceTo(before)).toBeLessThan(1e-9);
    expect(t.object.position.distanceTo(t.pos)).toBeGreaterThan(0.05);
    b.dispose();
  });

  it("puts every death in the feed, both ways round", () => {
    const b = new Battle(scene(), flat, { count: 0 });
    const ally = b.spawn(FACTION.ALLY, 0, -20);
    const enemy = b.spawn(FACTION.ENEMY, 0, -40);
    b.spawn(FACTION.ALLY, 30, -20);            // so neither death ends the battle
    b.spawn(FACTION.ENEMY, 30, -40);
    ally.hp = 1; enemy.hp = 1;
    const dice = vi.spyOn(Math, "random").mockReturnValue(0);
    b.fire(b.troopers[3], ally);
    b.fire(b.troopers[2], enemy);
    dice.mockRestore();
    const feed = b.drainEvents();
    expect(feed).toContain("ALLY DOWN");
    expect(feed.some((e: string) => e.startsWith("HOSTILE DOWN"))).toBe(true);
    b.dispose();
  });
});

describe("neither side is a foregone conclusion", () => {
  /**
   * The tuning, sampled. `troopers.test.ts` already pins the median duration
   * and the win rate; what this adds is the shape of the *start* — no line may
   * collapse while the player is still walking towards it, because a battle
   * whose outcome was fixed before you arrived is a cutscene.
   */
  it("never loses a whole line inside the first twenty-five seconds", () => {
    for (let n = 0; n < 25; n++) {
      const b = new Battle(scene(), flat, {});
      for (let i = 0; i < 30 * 25; i++) b.update(1 / 30, null);
      const c = b.counts();
      expect(c.over, "decided before anyone could walk over").toBe(null);
      expect(c.ally).toBeGreaterThan(0);
      expect(c.enemy).toBeGreaterThan(0);
      b.dispose();
    }
  });

  it("says so in the feed when a line starts to go", () => {
    const b = new Battle(scene(), flat, {});
    let said = false;
    for (let i = 0; i < 30 * 400 && !b.over; i++) {
      b.update(1 / 30, null);
      if (b.drainEvents().some((e: string) => e === "HOSTILE LINE IS THINNING" || e === "OUR LINE IS TAKING IT")) {
        said = true;
      }
    }
    expect(said).toBe(true);
    b.dispose();
  });
});
