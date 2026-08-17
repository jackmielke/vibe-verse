/**
 * What you can stand on in Vibe Francisco.
 *
 * This exists because of a bug report that was two words long — "the physics
 * don't really work properly ... if it's a curved building, I don't land
 * right" — and which was completely correct. Every collider in the city was a
 * prism with the footprint of the building's *base*, and a great many of the
 * buildings are not prisms:
 *
 *  - Salesforce Tower is a 42 m circle. Its collider was a 42 m square, so the
 *    four corners — a fifth of the roof area — were floor with nothing under
 *    it. You land on a round building and end up hovering beside it.
 *  - Every generated tower tapers to between 82% and 100%. The margin between
 *    the base outline and the roof outline was solid to the collider and empty
 *    to the eye.
 *  - The Transamerica Pyramid's collider was a 52 m box 212 m tall, which is a
 *    building-sized invisible cube around a spike.
 *
 * None of that is visible in a screenshot and all of it is obvious the moment
 * you jump on something. These run against the real city — nine thousand
 * colliders, built the same way the world builds them — because a synthetic
 * three-box fixture would have passed the whole time.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildCity, type BuildingBox, type CityBuild } from "@/frisco/city";
import { CityCollision } from "@/frisco/collision";
import { walkHeight } from "@/frisco/map";

let city: CityBuild;
let col: CityCollision;

beforeAll(() => {
  city = buildCity();
  col = new CityCollision(city.colliders);
});

/** A point `t` of the way from the centre to the roof edge, at bearing `a`. */
function onRoof(b: BuildingBox, t: number, a: number): { x: number; z: number } {
  const hw = (b.topHw ?? b.hw) * t;
  const hd = (b.topHd ?? b.hd) * t;
  const lx = Math.cos(a) * hw;
  const lz = Math.sin(a) * hd;
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return { x: b.x + lx * c - lz * s, z: b.z + lx * s + lz * c };
}

const SKY = 4000;

describe("Vibe Francisco — standing on things", () => {
  it("holds you up in the middle of every building", () => {
    // Not a sample: every collider in the city. If any one of them cannot
    // support a character standing on its own centre, something is wrong with
    // the shape maths rather than with that building.
    let failures = 0;
    for (const b of city.colliders) {
      const y = col.supportAt(b.x, b.z, SKY);
      if (y < b.roofY - 0.001) failures++;
    }
    expect(failures, `${failures} of ${city.colliders.length} buildings have no roof`).toBe(0);
  });

  it("holds you up at the very edge of a roof, and not past it", () => {
    /* The bug, stated as a test. Just inside the roof outline is floor; well
       outside it is not. Checked at eight bearings, which is what catches a
       round building being treated as a square: the corners of the square are
       at 45 degrees and 41% further out than the circle. */
    let insideFails = 0;
    let outsideFails = 0;
    let checked = 0;
    for (const b of city.colliders) {
      if (b.roofY - b.baseY < 10) continue; // Too short for the distinction to matter.
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        checked++;
        const inn = onRoof(b, 0.9, a);
        if (col.supportAt(inn.x, inn.z, SKY) < b.roofY - 0.001) insideFails++;
        // 1.6× the roof half-extent. Far enough out that no honest roof reaches
        // it, close enough that a neighbour across the street usually does not.
        const out = onRoof(b, 1.6, a);
        const support = col.supportAt(out.x, out.z, SKY);
        // A taller building next door legitimately supports you out here, so
        // the failure is specifically "this building is holding me up".
        if (Math.abs(support - b.roofY) < 0.001 && support > walkHeight(out.x, out.z) + 0.5) {
          outsideFails++;
        }
      }
    }
    expect(checked).toBeGreaterThan(2000);
    expect(insideFails, "roof edges that are not solid").toBe(0);
    // A few will be genuine: two buildings of exactly equal height side by
    // side. It must not be thousands.
    expect(outsideFails / checked).toBeLessThan(0.02);
  });

  it("never leaves you standing inside a wall", () => {
    /* `resolve` is allowed to move you; what it is not allowed to do is finish
       with you still inside something. One pass used to be enough because every
       collider was a box; a round push-out can hand you to a neighbour, so the
       loop runs a few times and this asserts it converges. */
    let stuck = 0;
    let tested = 0;
    for (let i = 0; i < city.colliders.length; i += 37) {
      const b = city.colliders[i];
      // Start at the centre, at knee height, which is as inside as it gets.
      const feet = b.baseY + Math.min(2, (b.roofY - b.baseY) * 0.3);
      const pos = { x: b.x, z: b.z };
      for (let pass = 0; pass < 6; pass++) {
        if (!col.resolve(pos, feet, 0.4)) break;
      }
      tested++;
      if (col.occupied(pos.x, feet + 0.5, pos.z)) stuck++;
    }
    expect(tested).toBeGreaterThan(100);
    // Downtown is dense enough that a handful of centres are inside a
    // neighbour too and there is nowhere to be pushed to.
    expect(stuck / tested).toBeLessThan(0.08);
  });
});

describe("Vibe Francisco — the shapes that were wrong", () => {
  const find = (pred: (b: BuildingBox) => boolean) => city.colliders.find(pred);

  it("makes Salesforce Tower round rather than square", () => {
    const b = find((c) => c.round === true && c.roofY - c.baseY > 200);
    expect(b, "no tall round collider — is Salesforce still built?").toBeDefined();
    if (!b) return;
    // On the diagonal, a circle's edge is at 0.707 of the square's corner.
    // Inside the circle: floor. In the corner of the square: not.
    const inn = onRoof(b, 0.9, Math.PI / 4);
    const corner = onRoof(b, 1.35, Math.PI / 4);
    expect(col.supportAt(inn.x, inn.z, SKY)).toBeCloseTo(b.roofY, 3);
    expect(col.supportAt(corner.x, corner.z, SKY)).toBeLessThan(b.roofY - 100);
  });

  it("gives the Transamerica Pyramid a platform and not a cube", () => {
    const b = find((c) => (c.topHw ?? c.hw) < c.hw * 0.2 && c.roofY - c.baseY > 150);
    expect(b, "no strongly tapered tall collider — is the pyramid still built?").toBeDefined();
    if (!b) return;
    // The tip holds you up.
    expect(col.supportAt(b.x, b.z, SKY)).toBeCloseTo(b.roofY, 3);
    // Twenty metres out — inside the base footprint, nowhere near the top —
    // does not. This is the whole point: you slide off a pyramid.
    const flank = { x: b.x + 20, z: b.z };
    expect(col.supportAt(flank.x, flank.z, SKY)).toBeLessThan(b.roofY - 100);
  });

  it("narrows a tapered tower's roof to the parapet", () => {
    const b = find(
      (c) =>
        c.topHw !== undefined && c.topHw < c.hw * 0.95 && c.topHw > c.hw * 0.2 &&
        c.roofY - c.baseY > 40,
    );
    expect(b, "no tapered generated tower").toBeDefined();
    if (!b) return;
    expect(col.supportAt(b.x, b.z, SKY)).toBeCloseTo(b.roofY, 3);
    /* Halfway between the roof outline and the base outline: comfortably
       inside what the old collider thought was solid, comfortably outside the
       roof you can actually see. Testing exactly ON the base edge is a
       floating-point coin toss and tests nothing. */
    const ratio = b.hw / (b.topHw ?? b.hw);
    const wide = onRoof(b, (1 + ratio) / 2, 0);
    expect(col.supportAt(wide.x, wide.z, SKY)).toBeLessThan(b.roofY - 1);
  });

  it("keeps the camera out of a round tower as well as a square one", () => {
    const b = find((c) => c.round === true && c.roofY - c.baseY > 200);
    if (!b) return;
    const mid = b.baseY + (b.roofY - b.baseY) * 0.5;
    expect(col.occupied(b.x, mid, b.z)).toBe(true);
    // Just outside the wall at that height, on the diagonal.
    const out = onRoof(b, 2.4, Math.PI / 4);
    expect(col.occupied(out.x, mid, out.z)).toBe(false);
  });
});
