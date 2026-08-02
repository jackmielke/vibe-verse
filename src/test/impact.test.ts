/**
 * Crashing, and — much more importantly — not crashing.
 *
 * Before `gfx/Impact.js` there was no collision in the vibeverse at all:
 * grepping the engine for crash/collide/impact/explode returned one comment
 * about an anti-collision strobe. `updateProximity` put a repulsion field round
 * every world, bled inward velocity at up to 240% a second and teleported the
 * hull back onto the shell if it ever got past the floor, so a ship could be
 * pointed at a planet at full boost and simply end up parked against it.
 *
 * The field is still there. What is new is that it has an authority limit, and
 * the whole risk of this feature lives in exactly one number: a game that
 * detonates a landing somebody was flying carefully is worse than one that
 * never detonates anything. So the decision is a pure function with no renderer
 * in it and it is pinned here from both sides — what must explode, and what
 * must not.
 *
 * The rest is the explosion itself, which runs headless because everything it
 * does is arithmetic on pooled buffers. What is pinned there is the pooling
 * (nothing may be constructed at the moment of impact), the freeze, and the
 * teardown — this world is entered and left repeatedly.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three-ls";
import {
  Impact, approachVerdict, impactSeverity,
  CRASH_CLOSING, CRASH_CLOSING_HARD,
} from "@/longsilence/gfx/Impact.js";
import { Game } from "@/longsilence/game/Game.js";
import { Ship } from "@/longsilence/ship/Ship.js";

/* A world the size of the ones generate.js grows: 6000 units of radius, the
   1.02 shell and the 1.16 envelope Game.updateProximity uses. */
const R = 6000;
const FLOOR = R * 1.02;
const SOFT = R * 1.16;

describe("the approach envelope's authority limit", () => {
  it("leaves a careful approach exactly as it was", () => {
    /* The regression that matters most. Every one of these is inside the
       envelope and under the limit, which is the case the assist was tuned for
       and which must still return 'assist' — including sitting *on* the floor,
       which is where the old code parked you and where an off-by-one in the
       comparison would now blow you up. */
    for (const d of [SOFT, SOFT * 0.99, R * 1.08, FLOOR, FLOOR * 0.999]) {
      expect(approachVerdict(d, FLOOR, SOFT, CRASH_CLOSING - 0.001), `d=${d}`)
        .toBe("assist");
    }
    // Drifting outward inside the envelope is not a closing speed at all.
    expect(approachVerdict(FLOOR, FLOOR, SOFT, -300)).toBe("assist");
    expect(approachVerdict(FLOOR, FLOOR, SOFT, 0)).toBe("assist");
  });

  it("never fires on anything outside the envelope, however fast", () => {
    expect(approachVerdict(SOFT * 1.0001, FLOOR, SOFT, 9999)).toBe("clear");
    expect(approachVerdict(R * 2.6, FLOOR, SOFT, 9999)).toBe("clear");
  });

  it("stands down, then detonates, when the hull is coming in too fast", () => {
    // Still in the air: warned, not dead. The envelope is 14% of a radius
    // deep, which is 840 units here — there is time to turn.
    expect(approachVerdict(R * 1.10, FLOOR, SOFT, CRASH_CLOSING + 1)).toBe("doomed");
    // ...and through the shell.
    expect(approachVerdict(FLOOR - 1, FLOOR, SOFT, CRASH_CLOSING + 1)).toBe("crash");
    expect(approachVerdict(R, FLOOR, SOFT, 250)).toBe("crash");
  });

  it("reads the radial component, which is also the angle test", () => {
    /* Fast, steep or unaligned all fall out of one dot product, and this is the
       claim that makes that true: a hull crossing the envelope at 200 units a
       second along the *tangent* has no closing speed, is skimming the
       atmosphere, and the field holds it. The same 200 pointed at the centre
       does not survive. Game.updateProximity computes `closing` as
       -vel·radial, so these are the two ends of that projection. */
    const speed = 200;
    const radial = new THREE.Vector3(0, 1, 0);          // outward from the body
    const tangent = new THREE.Vector3(1, 0, 0).multiplyScalar(speed);
    const straightDown = radial.clone().multiplyScalar(-speed);

    expect(approachVerdict(FLOOR - 1, FLOOR, SOFT, -tangent.dot(radial))).toBe("assist");
    expect(approachVerdict(FLOOR - 1, FLOOR, SOFT, -straightDown.dot(radial))).toBe("crash");

    // And the interesting middle: 45 degrees off is half again over the limit
    // at this speed, so a steep-ish dive still kills you.
    const oblique = new THREE.Vector3(1, -1, 0).normalize().multiplyScalar(speed);
    expect(-oblique.dot(radial)).toBeGreaterThan(CRASH_CLOSING);
    expect(approachVerdict(FLOOR - 1, FLOOR, SOFT, -oblique.dot(radial))).toBe("crash");
  });

  it("gives a structure no envelope at all, at a much lower limit", () => {
    /* A station has no atmosphere to brake in and nothing to push you off, so
       Game passes floor === soft and CRASH_CLOSING_HARD. Either you missed it
       or you hit it. */
    const r = 0.9;
    const H = CRASH_CLOSING_HARD;
    expect(approachVerdict(r * 1.001, r, r, 500, H)).toBe("clear");
    expect(approachVerdict(r, r, r, H + 0.01, H)).toBe("crash");
    expect(approachVerdict(r, r, r, H - 0.01, H)).toBe("assist");
    // The default limit is the atmospheric one, so forgetting to pass the
    // structure's is a miss rather than a spurious detonation.
    expect(approachVerdict(r, r, r, H + 0.01)).toBe("assist");
    // ...and it is genuinely stricter than the atmospheric one, or there would
    // be no reason for the second constant to exist.
    expect(CRASH_CLOSING_HARD).toBeLessThan(CRASH_CLOSING);
  });

  it("keeps the limit inside the speeds the ship can actually fly", () => {
    /* Ship.maxSpeed is 60 and boostMul 4.2. A limit above cruise would make
       crashing unreachable without boost; one down at walking pace would make
       every approach fatal. Both have been wrong at some point in the tuning. */
    expect(CRASH_CLOSING).toBeGreaterThan(4);
    expect(CRASH_CLOSING).toBeLessThan(60);
  });
});

describe("severity", () => {
  it("floors at the threshold and saturates, and never leaves 0..1", () => {
    expect(impactSeverity(CRASH_CLOSING)).toBeCloseTo(0.3, 5);
    expect(impactSeverity(0)).toBe(0.3);            // clamped, not negative
    expect(impactSeverity(150)).toBeCloseTo(1, 5);
    expect(impactSeverity(1e6)).toBe(1);            // clamped, not 4000
    expect(impactSeverity(-250)).toBe(1);           // sign is not the question
  });

  it("is monotonic, so a harder hit is always a bigger explosion", () => {
    let prev = -1;
    for (let c = CRASH_CLOSING; c <= 160; c += 5) {
      const s = impactSeverity(c);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});

/* ------------------------------------------------------------ the explosion */

/** Everything Impact hangs off the scene, including the light it keeps outside
 *  its own group. */
function census(scene: THREE.Scene) {
  let meshes = 0, lights = 0, sprites = 0, lines = 0;
  scene.traverse((o) => {
    if ((o as THREE.Light).isLight) lights++;
    else if ((o as THREE.Sprite).isSprite) sprites++;
    else if ((o as THREE.Line).isLine) lines++;
    else if ((o as THREE.Mesh).isMesh) meshes++;
  });
  return { meshes, lights, sprites, lines };
}

const at = () => new THREE.Vector3(1000, 0, 0);
const up = () => new THREE.Vector3(1, 0, 0);

describe("the explosion", () => {
  it("allocates nothing at the moment of impact", () => {
    /* The whole reason this is a pooled object. A hitch on the frame of a
       crash is the one hitch a player will definitely notice, so `fire()` may
       only write into buffers the constructor already made. Counting scene
       nodes is a proxy for construction, and it is the proxy that would
       actually catch the obvious regression: someone adding `new
       THREE.Mesh(...)` inside fire(). */
    const scene = new THREE.Scene();
    const imp = new Impact(scene, { quality: "high" });
    const before = census(scene);
    imp.fire(at(), up(), 1);
    imp.update(0.05, new THREE.Vector3());
    imp.update(0.5, new THREE.Vector3());
    expect(census(scene)).toEqual(before);
    // ...and it really did build something to recycle.
    expect(before.meshes).toBeGreaterThan(3);
    expect(before.sprites).toBeGreaterThan(4);
    expect(before.lines).toBe(1);
    imp.dispose();
  });

  it("keeps its light in the scene from construction, at zero", () => {
    /* Not tidiness. NUM_POINT_LIGHTS is part of every lit material's program
       key, so a light that appears when the ship explodes recompiles the
       entire frame on the one frame that must not stall. It lives outside the
       group — which is toggled invisible — because three skips invisible
       objects when it gathers lights, which would re-key everything just the
       same. */
    const scene = new THREE.Scene();
    const imp = new Impact(scene, { quality: "high" });
    expect(census(scene).lights).toBe(1);
    expect(imp.light.intensity).toBe(0);
    expect(imp.light.parent).toBe(scene);
    expect(imp.group.children).not.toContain(imp.light);

    imp.fire(at(), up(), 1);
    imp.update(0.10, new THREE.Vector3());
    expect(imp.light.intensity).toBeGreaterThan(0);
    // Still exactly one, and still in the scene, once it has burned out.
    imp.update(9, new THREE.Vector3());
    expect(census(scene).lights).toBe(1);
    expect(imp.light.intensity).toBe(0);
    imp.dispose();
  });

  it("scales off the quality flags", () => {
    const a = new Impact(new THREE.Scene(), { quality: "high" });
    const b = new Impact(new THREE.Scene(), { mobile: true });
    expect(b.debrisN).toBeLessThan(a.debrisN);
    expect(b._puff.length).toBeLessThan(a._puff.length);
    expect(b._lobe.length).toBeLessThan(a._lobe.length);
    // The blast sphere and the light are the two things a phone does not get.
    expect(a.shell).toBeTruthy();
    expect(b.shell).toBeFalsy();
    expect(a.light).toBeTruthy();
    expect(b.light).toBeNull();
    a.dispose(); b.dispose();
  });

  it("stops the world for a beat and then gives it back", () => {
    const imp = new Impact(new THREE.Scene(), { quality: "high" });
    expect(imp.timeScale).toBe(1);              // idle costs nothing

    imp.fire(at(), up(), 1);
    expect(imp.timeScale).toBeLessThan(0.1);    // the hit stop
    imp.update(0.3, new THREE.Vector3());
    const mid = imp.timeScale;
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(1);                // still coming back
    imp.update(0.6, new THREE.Vector3());
    expect(imp.timeScale).toBe(1);
    // It must reach 1 long before the smoke does, or the player spends four
    // seconds flying through treacle after the explosion is over.
    expect(imp.live).toBe(true);
    imp.dispose();
  });

  it("never hands back a negative clock", () => {
    /* Game multiplies its frame delta by `timeScale`, and the ramp underneath
       it — FROZEN + (t - FREEZE)/RAMP — is negative for the whole of the
       freeze. Without the bottom clamp the world runs *backwards* for the
       first tenth of a second of every crash: planets orbiting the wrong way,
       the fold charge climbing, the score's phrase clock going into arrears.
       Silent, and only for six frames, which is exactly the kind of thing that
       survives being looked at. */
    const imp = new Impact(new THREE.Scene(), { quality: "high" });
    imp.fire(at(), up(), 1);
    for (let k = 0; k < 240; k++) {
      const s = imp.timeScale;
      expect(s, `t=${(k / 120).toFixed(3)}`).toBeGreaterThanOrEqual(0.05);
      expect(s).toBeLessThanOrEqual(1);
      imp.update(1 / 120, new THREE.Vector3());
    }
    imp.dispose();
  });

  it("hits hard on the first frame and decays, rather than ramping in", () => {
    const imp = new Impact(new THREE.Scene(), { quality: "high" });
    imp.fire(at(), up(), 1);
    imp.update(1 / 60, new THREE.Vector3());
    const peak = imp.shake;
    // Well past the 0..1 the rest of the game shakes in — this is a crash, not
    // a thruster kick, and Game deliberately skips its own clamps for it.
    expect(peak).toBeGreaterThan(2);
    expect(imp.flash).toBeGreaterThan(0.8);
    expect(imp.desat).toBeGreaterThan(0.5);

    imp.update(0.5, new THREE.Vector3());
    expect(imp.shake).toBeLessThan(peak * 0.4);
    imp.update(1.6, new THREE.Vector3());
    expect(imp.flash).toBe(0);
    expect(imp.desat).toBe(0);
    imp.dispose();
  });

  it("makes a smaller mess of a slower crash", () => {
    const hard = new Impact(new THREE.Scene(), { quality: "high" });
    const soft = new Impact(new THREE.Scene(), { quality: "high" });
    hard.fire(at(), up(), 1);
    soft.fire(at(), up(), impactSeverity(CRASH_CLOSING));
    hard.update(1 / 60, new THREE.Vector3());
    soft.update(1 / 60, new THREE.Vector3());
    expect(soft.shake).toBeLessThan(hard.shake);
    expect(soft.light.intensity).toBeLessThan(hard.light.intensity);
    hard.dispose(); soft.dispose();
  });

  it("stays where it happened while the origin flies away from it", () => {
    /* Floating origin: the scene is redrawn around the ship every frame, so an
       explosion parented at the scene's zero would ride the camera and the
       wreck would appear to follow the player home. */
    const imp = new Impact(new THREE.Scene(), { quality: "high" });
    const point = new THREE.Vector3(4000, -200, 90);
    imp.fire(point, up(), 1);
    imp.update(1 / 60, new THREE.Vector3(4000, -200, 90));
    expect(imp.group.position.length()).toBeCloseTo(0, 6);
    imp.update(1 / 60, new THREE.Vector3(4300, -200, 90));
    expect(imp.group.position.x).toBeCloseTo(-300, 4);
    imp.dispose();
  });

  it("plays the crash out of the pings Audio.js already owns", () => {
    /* The score is not this module's to extend, so the sound is layered: the
       sub-bass thump with the long tail, the crack on top of it, and the ship's
       own alarm afterwards. Queued against this object's clock rather than on
       setTimeout, so leaving the route silences it instead of scheduling noise
       into the next world — which is what the last assertion is about. */
    const played: string[] = [];
    const audio = { ping: (k: string) => played.push(k) };
    const imp = new Impact(new THREE.Scene(), { quality: "high" });
    const o = new THREE.Vector3();
    imp.fire(at(), up(), 1, audio);

    imp.update(1 / 60, o);
    expect(played).toContain("shot");           // the crack
    expect(played).toContain("jump");           // the sub-bass thump and its tail
    const immediate = played.length;
    for (let i = 0; i < 60 * 3; i++) imp.update(1 / 60, o);
    expect(played.length).toBeGreaterThan(immediate);
    expect(played).toContain("alarm");          // the ship, afterwards

    /* Each cue exactly once. A queue that is read but not consumed fires
       every one of its entries on every frame for the length of the
       explosion, which is four hundred overlapping rifle cracks and a wall of
       clipping — audible, unmistakable, and completely invisible to a test
       that only asks whether the sound happened. */
    const count = (k: string) => played.filter((p) => p === k).length;
    expect(count("shot")).toBe(1);
    expect(count("jump")).toBe(1);
    expect(count("fold")).toBe(1);
    expect(count("alarm")).toBe(2);

    imp.dispose();
  });

  it("runs a full explosion's worth of frames and puts itself away", () => {
    const scene = new THREE.Scene();
    const imp = new Impact(scene, { quality: "high" });
    imp.fire(at(), up(), 1);
    const o = new THREE.Vector3();
    for (let i = 0; i < 60 * 8; i++) expect(() => imp.update(1 / 60, o)).not.toThrow();
    expect(imp.live).toBe(false);
    expect(imp.group.visible).toBe(false);
    expect(imp.shake).toBe(0);
    expect(imp.light.intensity).toBe(0);
    // Every fragment is parked at zero scale rather than left hanging in space:
    // an InstancedMesh has a fixed count and a stale matrix draws forever.
    const m = new THREE.Matrix4();
    for (let i = 0; i < imp.debrisN; i++) {
      imp.cold.getMatrixAt(i, m);
      expect(new THREE.Vector3().setFromMatrixScale(m).length()).toBeCloseTo(0, 6);
    }
    imp.dispose();
  });

  it("can be fired again after it has burned out", () => {
    const imp = new Impact(new THREE.Scene(), { quality: "high" });
    imp.fire(at(), up(), 1);
    imp.update(20, new THREE.Vector3());
    expect(imp.live).toBe(false);
    imp.fire(at(), up(), 1);
    expect(imp.live).toBe(true);
    expect(imp.group.visible).toBe(true);
    imp.update(1 / 60, new THREE.Vector3());
    expect(imp.shake).toBeGreaterThan(2);
    imp.dispose();
  });

  it("lets go of everything, twice if it has to", () => {
    /* The route is entered and left repeatedly and Game.dispose runs the whole
       teardown; a second call must not double-free a geometry the renderer may
       still be holding. */
    const scene = new THREE.Scene();
    const imp = new Impact(scene, { quality: "high" });
    imp.fire(at(), up(), 1);
    expect(() => imp.dispose()).not.toThrow();
    expect(() => imp.dispose()).not.toThrow();
    expect(scene.children.length).toBe(0);
  });
});

/* --------------------------------------------------------- the Game hooks

   Game cannot be constructed without a WebGL context, but every method the
   crash added is arithmetic over `this.ship`, `this.bodies` and `this.impact`,
   so they are driven here against a stand-in with those three on it. That is
   the point of keeping the Game-side edit to four small methods: the
   interesting half is reachable.                                            */

type Stub = Record<string, unknown>;

/** A body shaped the way loadSystem builds one. */
function planet(radius = 6000) {
  return {
    kind: "planet", name: "Test", id: "planet:Test", planet: {}, radius,
    absPos: new THREE.Vector3(0, 0, 0),
  };
}

/* One hull, reset between cases. Building it is 90% of this block's runtime
   and none of these tests care what shape it is — only that every field the
   crash writes really exists on the real flight model. */
let _ship: Ship | null = null;
function freshShip() {
  const s = _ship || (_ship = new Ship());
  s.absPos.set(0, 0, 0);
  s.vel.set(0, 0, 0);
  s.angVel.set(0, 0, 0);
  s.quat.identity();
  s.hull = 1;
  s.throttle = 0;
  s.boost = 0;
  s.foldMode = false;
  s.foldCharge = 1;
  return s;
}

function harness(bodies = [planet()]) {
  const logs: string[] = [];
  const pings: string[] = [];
  const g: Stub = {
    ship: freshShip(),
    bodies,
    origin: new THREE.Vector3(),
    camRig: new THREE.Quaternion(),
    impact: new Impact(new THREE.Scene(), { quality: "high" }),
    hud: { log: (t: string) => logs.push(t), narrate: () => {} },
    audio: { ping: (k: string) => pings.push(k) },
    player: { mode: "seated" },
    mode: "pilot",
    shake: 0,
    crash: null,
    autopilot: null,
    proximityWarn: null,
    toggleFold: () => {},
    cancelAutopilot: () => {},
    updateProximity: Game.prototype.updateProximity,
    _crashInto: Game.prototype._crashInto,
    _updateCrash: Game.prototype._updateCrash,
    _respawnFromCrash: Game.prototype._respawnFromCrash,
  };
  return { g, logs, pings };
}

/** The half of Game.update that matters here: integrate, then let the envelope
 *  have its say. Returns how many frames it took to explode, or -1. */
function flyIn(g: Stub, frames = 1200, dt = 1 / 60) {
  const ship = g.ship as Ship;
  for (let i = 0; i < frames; i++) {
    ship.absPos.addScaledVector(ship.vel, dt);
    (g.updateProximity as (d: number) => void).call(g, dt);
    if (g.crash) return i + 1;
  }
  return -1;
}

describe("flying into a planet", () => {
  const R = 6000;

  it("still parks a careful approach against the surface, as it always did", () => {
    /* The old behaviour, and the one that must not have changed: a hull
       drifting in under the limit is caught, bled off and left sitting on the
       shell. If this fails the feature has eaten the game. */
    const { g } = harness();
    const ship = g.ship as Ship;
    ship.absPos.set(R * 1.15, 0, 0);
    ship.vel.set(-(CRASH_CLOSING - 2), 0, 0);
    /* Long enough that an assist which merely *delayed* the impact would not
       get away with it: 780 units of envelope at 18 a second is 43 seconds,
       and this is a minute of frames. */
    expect(flyIn(g, 3600)).toBe(-1);
    expect(ship.hull).toBeGreaterThan(0.9);
    // Arrested, not skimming the floor — the field is what stopped it.
    expect(ship.absPos.length()).toBeGreaterThan(R * 1.03);
    (g.impact as Impact).dispose();
  });

  it("also survives a fast *tangential* pass through the envelope", () => {
    /* Skimming the atmosphere at four times the limit. Nothing about the speed
       makes this a crash; the radial component is zero. */
    const { g } = harness();
    const ship = g.ship as Ship;
    ship.absPos.set(R * 1.10, 0, 0);
    ship.vel.set(0, 0, CRASH_CLOSING * 4);
    expect(flyIn(g, 240)).toBe(-1);
    expect(ship.hull).toBe(1);
    (g.impact as Impact).dispose();
  });

  it("goes in, and explodes, when it is flown straight at the world", () => {
    const { g, logs } = harness();
    const ship = g.ship as Ship;
    ship.absPos.set(R * 1.15, 0, 0);
    ship.vel.set(-60, 0, 0);                    // cruise, dead at the centre
    const frames = flyIn(g);
    expect(frames).toBeGreaterThan(0);
    /* And it took a while to get there — 780 units of envelope at 60 a second.
       That gap is the warning: the assist standing down is not the same event
       as the impact, and the thirteen seconds between them are what make
       "PULL UP" an instruction rather than an obituary. */
    expect(frames / 60).toBeGreaterThan(8);
    expect((g.impact as Impact).live).toBe(true);
    expect(ship.hull).toBe(0);
    expect(ship.vel.length()).toBe(0);
    expect(ship.angVel.length()).toBeGreaterThan(0);      // tumbling, not parked
    // On the shell, not buried in it: the fireball is drawn at the ship.
    expect(ship.absPos.length()).toBeCloseTo(R * 1.02, 0);
    expect(logs.join(" ")).toMatch(/HULL LOST/);
    // Warned first, while there was still time to turn.
    expect(logs.join(" ")).toMatch(/IMPACT WARNING/);
    (g.impact as Impact).dispose();
  });

  it("only detonates once, however many frames it spends inside the shell", () => {
    const { g, logs } = harness();
    const ship = g.ship as Ship;
    ship.absPos.set(R * 0.9, 0, 0);
    ship.vel.set(-90, 0, 0);
    (g.updateProximity as (d: number) => void).call(g, 1 / 60);
    const first = g.crash;
    for (let i = 0; i < 30; i++) (g.updateProximity as (d: number) => void).call(g, 1 / 60);
    expect(g.crash).toBe(first);
    expect(logs.filter((l) => /HULL LOST/.test(l)).length).toBe(1);
    (g.impact as Impact).dispose();
  });

  it("keeps the envelope's clamps off the impact's own shake", () => {
    /* updateProximity ends with two `Math.min(1, shake + …)` calls, and the
       wreck sits inside the envelope for the whole hold — so without the early
       return the crash shake would be filed down to 1 on the frame after it
       peaked, which is most of what makes it read. */
    const { g } = harness();
    const ship = g.ship as Ship;
    ship.absPos.set(R * 0.9, 0, 0);
    ship.vel.set(-90, 0, 0);
    (g.updateProximity as (d: number) => void).call(g, 1 / 60);
    (g.impact as Impact).update(1 / 60, g.origin as THREE.Vector3);
    g.shake = (g.impact as Impact).shake;
    expect(g.shake).toBeGreaterThan(2);
    (g.updateProximity as (d: number) => void).call(g, 1 / 60);
    expect(g.shake).toBeGreaterThan(2);
    (g.impact as Impact).dispose();
  });

  it("puts the ship back, crippled, once the wreck has finished burning", () => {
    const { g, logs } = harness();
    const ship = g.ship as Ship;
    ship.absPos.set(R * 0.9, 0, 0);
    ship.vel.set(-90, 0, 0);
    ship.foldCharge = 1;
    (g.updateProximity as (d: number) => void).call(g, 1 / 60);
    expect(g.crash).toBeTruthy();

    // Two and a half seconds of real frames is not enough...
    for (let i = 0; i < 150; i++) (g._updateCrash as (d: number) => void).call(g, 1 / 60);
    expect(g.crash).toBeTruthy();
    expect(ship.hull).toBe(0);
    // ...three is.
    for (let i = 0; i < 30; i++) {
      if (g.crash) (g._updateCrash as (d: number) => void).call(g, 1 / 60);
    }
    expect(g.crash).toBeNull();

    // Clear of the well, pointed out of it, and visibly broken.
    expect(ship.absPos.length()).toBeCloseTo(R * 2.8, 0);
    expect(ship.hull).toBe(0.35);
    // Under the half a hull updatePost's damage vignette keys off, so the
    // frame keeps saying what state the ship is in the whole way home.
    expect(ship.hull).toBeLessThan(0.5);
    expect(ship.foldCharge).toBeLessThan(0.2);
    expect(ship.vel.length()).toBe(0);
    expect(ship.angVel.length()).toBe(0);
    const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quat);
    expect(nose.dot(ship.absPos.clone().normalize())).toBeGreaterThan(0.9);
    expect(logs.join(" ")).toMatch(/RECONSTITUTED/);
    /* The wreck stays where it happened. The floating origin has just jumped
       three planet radii, and Impact reads it at the *top* of Game's frame —
       so without an explicit re-anchor the smoke is drawn round the ship that
       just left, for one frame, in orbit. */
    expect((g.impact as Impact).group.position.length()).toBeGreaterThan(R);
    (g.impact as Impact).dispose();
  });

  it("hits a station on contact and leaves it no envelope to hide behind", () => {
    const st = {
      kind: "station", name: "Anchorage", id: "station:Anchorage", radius: 0.9,
      absPos: new THREE.Vector3(0, 0, 0),
    };
    const { g } = harness([st]);
    const ship = g.ship as Ship;
    // Just outside: a station does not push you off, so nothing at all happens.
    ship.absPos.set(1.0, 0, 0);
    ship.vel.set(0, 0, 0);
    (g.updateProximity as (d: number) => void).call(g, 1 / 60);
    expect(g.crash).toBeNull();
    expect(ship.vel.length()).toBe(0);        // no repulsion, no bleed

    ship.absPos.set(1.4, 0, 0);
    ship.vel.set(-30, 0, 0);
    expect(flyIn(g, 120)).toBeGreaterThan(0);
    expect(ship.hull).toBe(0);
    (g.impact as Impact).dispose();
  });

  it("does not fire on traffic", () => {
    /* Craft are excluded on purpose: closing speed is measured off the ship's
       own velocity, and a freighter flying its lane through a drifting hull
       would be a detonation the player did nothing to earn. */
    const craft = {
      kind: "craft", name: "Hauler", id: "craft:Hauler", radius: 0.12,
      absPos: new THREE.Vector3(0, 0, 0),
    };
    const { g } = harness([craft]);
    const ship = g.ship as Ship;
    ship.absPos.set(0.05, 0, 0);
    ship.vel.set(-200, 0, 0);
    (g.updateProximity as (d: number) => void).call(g, 1 / 60);
    expect(g.crash).toBeNull();
    (g.impact as Impact).dispose();
  });
});

describe("precompiling", () => {
  it("shows the group to the compiler and hides it again", async () => {
    /* The group is invisible for the whole of a session nobody crashes in, and
       three skips invisible objects when it walks a scene — so its programs
       would otherwise be built on the frame of the impact, which is the one
       frame this module exists to keep smooth. What is checked here is the
       part that could silently go wrong: that the scene handed to the compiler
       actually contains the wreck, and that the wreck is put away afterwards
       rather than left drawing over every frame of the game. */
    const imp = new Impact(new THREE.Scene(), { quality: "high" });
    let sawGroup = false;
    let sawSprite = false;
    const renderer = {
      compileAsync: async (scene: THREE.Scene) => {
        scene.traverseVisible((o) => {
          if (o === imp.group) sawGroup = true;
          if ((o as THREE.Sprite).isSprite) sawSprite = true;
        });
      },
    };
    await imp.prewarm(renderer, null);
    expect(sawGroup).toBe(true);
    expect(sawSprite).toBe(true);
    expect(imp.group.visible).toBe(false);
    expect(imp._puff.every((p: { sp: THREE.Sprite }) => !p.sp.visible)).toBe(true);
    imp.dispose();
  });

  it("only pays for it once, and survives a renderer that refuses", async () => {
    const imp = new Impact(new THREE.Scene(), { quality: "high" });
    let calls = 0;
    const renderer = { compileAsync: async () => { calls++; throw new Error("no context"); } };
    await expect(imp.prewarm(renderer, null)).resolves.toBeUndefined();
    await imp.prewarm(renderer, null);
    expect(calls).toBe(1);
    expect(imp.group.visible).toBe(false);
    imp.dispose();
  });
});
