/**
 * Bumper cars, and the keyboard.
 *
 * `blockedAt` could always say that something was in the way; it never said
 * WHAT. So running into a parked Nissan and running into a granite office
 * block were the same event — you stopped dead — and the city's ninety-odd
 * vehicles were, as far as the physics was concerned, street furniture.
 *
 * The whole of traffic is lane-space: a car's position is `lane` and `t`, its
 * heading falls out of `axis` and `dir`, and it is level by construction. That
 * is why the fleet is cheap and always exactly where it should be, and it is
 * why there was nowhere to put "tumbling sideways through the air". The fix is
 * a car leaving lane-space for a few seconds, so most of what can go wrong is
 * the rest of the system still believing it is where it was.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const trafficSrc = readFileSync(resolve(__dirname, "../city/traffic.ts"), "utf8");
const citySrc = readFileSync(resolve(__dirname, "../pages/City.tsx"), "utf8");

describe("a car that has been hit", () => {
  it("leaves lane physics entirely rather than being nudged inside them", () => {
    // Lane-space has no representation for airborne. Trying to express a hit
    // as a lane offset gives you a car sliding along a street it is supposed
    // to have been knocked out of.
    expect(trafficSrc).toMatch(/hit: \{[\s\S]*?vx: number; vy: number; vz: number;/);
    expect(trafficSrc).toContain("if (car.hit) {");
  });

  it("is skipped by the queue its neighbours are following", () => {
    // A knocked car's `t` is as stale as a driven one's. Left in the queue,
    // the cars behind brake for a phantom at its old position and a line of
    // traffic sits stopped in an empty street.
    expect(trafficSrc).toMatch(/if \(other === car \|\| other\.driven \|\| other\.hit\) continue;/);
  });

  it("cannot be climbed into while it is in the air", () => {
    // Its `speed` is zero and its `lane`/`t` are stale, so to `nearestRidable`
    // it looks like the most inviting car on the block — parked, at wherever
    // it used to be.
    // Anchored forward from the function's own start — there is an earlier
    // `return best;` in this file, and slicing to it gives an empty string
    // that passes a `not.toContain` and fails a `toContain` for the wrong
    // reason.
    const from = trafficSrc.indexOf("const nearestRidable = (");
    const near = trafficSrc.slice(from, trafficSrc.indexOf("return best;", from));
    expect(near.length).toBeGreaterThan(100);
    expect(near).toContain("if (car.hit) continue;");
  });

  it("carries its collision box with it", () => {
    // Otherwise the box stays behind as an invisible wall in the road and the
    // flying car is something you can drive through.
    const flight = trafficSrc.slice(
      trafficSrc.indexOf("if (car.hit) {"),
      trafficSrc.indexOf("Target speed."),
    );
    expect(flight).toContain("car.box.minX = h.x -");
    expect(flight).toContain("car.box.minZ = h.z -");
  });

  it("rejoins the road on its own, through the same path a released car uses", () => {
    // A car left wherever it stopped drains the fleet one crash at a time.
    // Sharing `rejoin` with `release` means there is one answer to "how does a
    // car get back on a street", not two that can disagree.
    expect(trafficSrc).toMatch(/const rejoin = \(car: Car\) => \{/);
    const flight = trafficSrc.slice(
      trafficSrc.indexOf("if (car.hit) {"),
      trafficSrc.indexOf("Target speed."),
    );
    expect(flight).toContain("rejoin(car);");
  });

  it("waits until it has actually stopped before rejoining", () => {
    // Snapping back to a lane the instant it stops rolling reads as a glitch
    // rather than as the driver restarting and pulling away.
    expect(trafficSrc).toMatch(/if \(still && h\.t > [\d.]+\)/);
  });

  it("settles flat rather than parked at an angle", () => {
    // Nothing else in the fleet is ever non-level, so a car left resting at
    // forty degrees stays that way until somebody hits it again.
    const flight = trafficSrc.slice(
      trafficSrc.indexOf("if (car.hit) {"),
      trafficSrc.indexOf("Target speed."),
    );
    expect(flight).toMatch(/h\.pitch \*= Math\.pow/);
    expect(flight).toMatch(/h\.roll \*= Math\.pow/);
  });
});

describe("hitting one", () => {
  it("asks what was hit before deciding what to do about it", () => {
    // The entire bug: `blockedAt` is true for a wall and for a car, and only
    // one of those should stop you.
    // Probed from the front bumper (`blockedV`), and asked with a pad wide
    // enough to match the collision world's, so a car is never scored a wall.
    expect(citySrc).toMatch(/const hitId = blockedV\(knx, knz\)\s*\n?\s*\? district\.traffic\.carAt\([^)]*, 1\.0\)/);
  });

  it("lets you through rather than stopping you", () => {
    // Being stopped dead by a hatchback is the boring outcome this replaces.
    const bump = citySrc.slice(
      citySrc.indexOf("} else if (hitId >= 0) {"),
      citySrc.indexOf("} else if (!blockedV(knx, knz)) {"),
    );
    expect(bump.length).toBeGreaterThan(100);
    expect(bump).toContain("kart.x = knx;");
    expect(bump).toContain("kart.z = knz;");
    // Costs something, though, or a busy street is free speed.
    expect(bump).toMatch(/kart\.speed \*= 0\.\d+;/);
  });

  it("shoves harder the faster you were going, and never with nothing", () => {
    // A pure speed multiplier would mean fast karts pass through and slow ones
    // are blocked, which is worse than the behaviour it replaced.
    const m = citySrc.match(/(\d+(?:\.\d+)?) \+ impactSpeed \* [\d.]+,/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  it("lifts the car as well as pushing it", () => {
    // Shunted purely horizontally, a car slides like a hockey puck. The bit of
    // air under it is what makes it read as having been hit.
    const shove = trafficSrc.slice(
      trafficSrc.indexOf("shove(id, vx, vz, force) {"),
      trafficSrc.indexOf("debugNear(x, z, r) {"),
    );
    // (`shove` sits after `debugNear` in the object, so search the whole file
    // if the slice came out empty.)
    const body = shove.length > 200 ? shove : trafficSrc;
    expect(body).toMatch(/vy: \(car\.hit\?\.vy \?\? 0\) \+ Math\.min\(/);
  });
});

describe("getting in and out", () => {
  it("has one key that does both", () => {
    // Getting in used to be a small button that appears when you walk near a
    // car, and getting out was that button or Space — which is also the
    // jetpack, so leaving a kart and firing your jetpack were one keystroke.
    expect(citySrc).toMatch(/if \(e\.code === "KeyF"(?: && !e\.repeat)?\) \{/);
    const f = citySrc.slice(citySrc.indexOf('if (e.code === "KeyF"')).slice(0, 800);
    expect(f).toContain("exitKartRef");
    expect(f).toContain("enterKartRef");
    expect(f).toContain("enterRideRef");
    // The same key gets you on and off Pegasus or the dragon.
    expect(f).toContain("mountActionRef");
  });

  it("reads what is in reach from live values, not from React state", () => {
    // A keydown handler registered once closes over the state from the render
    // that created it — the first one, forever. It would read "nothing in
    // reach" for the entire session.
    expect(citySrc).toContain("let nearKartNow = -1;");
    expect(citySrc).toContain("let nearRideNow = -1;");
  });

  it("says so on the buttons, so anybody finds it", () => {
    expect(citySrc).toMatch(/Hop out\{isTouch \? "" : " \(F\)"\}/);
  });
});

describe("the avatar", () => {
  it("is hidden only while you are actually at the wheel", () => {
    // `ride >= 0` alone means "the slot is holding a car", which stays true
    // after the player has left it — and a car sinking in the bay is kept
    // claimed for its whole descent so releasing it does not teleport it back
    // to the road. Without the second half, the player was simply invisible
    // for the eleven seconds that took.
    expect(citySrc).toMatch(
      /kartStates\[RIDE_SLOT\]\.ride >= 0 && drivingKartRef\.current === RIDE_SLOT/,
    );
  });
});
