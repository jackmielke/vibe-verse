/**
 * Teaching it on screen.
 *
 * Half the "I can't work out how to fly this" problem is the HUD, and the
 * failure mode is not silence — it is volume. The key row carried ten chips
 * (scan, autopilot, free-look, view, stand, the number keys) and a new player
 * read all of them and learned none. Meanwhile the two things that actually
 * blocked people were never said at all: that the pointer has to be captured
 * before it flies anything, and that L is how you get onto a planet.
 *
 * These are the pure halves of that layer, tested for what they leave out.
 */
import { describe, it, expect } from "vitest";
import { flightHints, coachStep, keyReference } from "@/longsilence/ui/HUD.js";

type Chip = [string, string];
const keysOf = (rows: Chip[]) => rows.map((r) => r[0]);
const textOf = (rows: Chip[]) => rows.map((r) => r.join(" ")).join(" | ");

describe("the flight key row", () => {
  it("is short enough to read in one glance", () => {
    // Ten chips is a list. The old row had eight before either conditional.
    expect(flightHints({ scheme: "simple" }).length).toBeLessThanOrEqual(6);
    expect(flightHints({ scheme: "sim", canLand: true }).length).toBeLessThanOrEqual(7);
  });

  it("names the pointer, the throttle and the strafe keys under the default", () => {
    const rows = flightHints({ scheme: "simple" }) as Chip[];
    expect(keysOf(rows)).toContain("MOUSE");
    expect(keysOf(rows)).toContain("W/S");
    expect(keysOf(rows)).toContain("A/D");
    expect(textOf(rows)).toMatch(/slide/);
    // ...and does not tell a laptop pilot to pitch with the arrow keys
    expect(textOf(rows)).not.toMatch(/↑↓/);
  });

  it("describes the sim layout when the sim layout is the one in force", () => {
    const rows = flightHints({ scheme: "sim" }) as Chip[];
    expect(textOf(rows)).toMatch(/A\/D yaw/);
    expect(keysOf(rows)).toContain("↑↓");
  });

  it("offers the rest of the keys rather than listing them", () => {
    expect(keysOf(flightHints({ scheme: "simple" }) as Chip[])).toContain("?");
  });

  it("says what L will actually do, the moment it will do it", () => {
    expect(textOf(flightHints({ scheme: "simple" }) as Chip[])).not.toMatch(/\bL\b/);
    const land = flightHints({ scheme: "simple", canLand: true, landVerb: "enter world" }) as Chip[];
    expect(land).toContainEqual(["L", "enter world"]);
    const fight = flightHints({ scheme: "simple", canLand: true, landVerb: "invade" }) as Chip[];
    expect(fight).toContainEqual(["L", "invade"]);
  });
});

/** A player with the pointer captured, at the helm, mid-system. */
const flyer = (over: Record<string, unknown> = {}) => ({
  flying: true, touch: false, locked: true, throttle: 0.5,
  steered: true, scheme: "simple", taught: false, canLand: false,
  ...over,
});

describe("the coach line", () => {
  it("says nothing when there is nothing the player can act on", () => {
    expect(coachStep(flyer({ flying: false, locked: false }))).toBeNull();
  });

  it("asks for the click whenever the pointer is not captured", () => {
    /* The one that was missing entirely. Game calls exitPointerLock() the
       moment a panel opens, so every player who picks a world off the star map
       comes back to a dead mouse — an expert included. */
    const s = coachStep(flyer({ locked: false }));
    expect(s.text).toMatch(/CLICK/);
    expect(s.sticky).toBe(true);
  });

  it("does not ask a phone to click anything", () => {
    const s = coachStep(flyer({ touch: true, locked: false, taught: true }));
    expect(s).toBeNull();
  });

  it("walks a first-time pilot through throttle, then steering, then the fold", () => {
    const a = coachStep(flyer({ throttle: 0, steered: false }));
    expect(a.id).toBe("throttle");
    expect(a.text).toMatch(/\bW\b/);

    const b = coachStep(flyer({ throttle: 0.5, steered: false }));
    expect(b.id).toBe("steer");

    const c = coachStep(flyer({ throttle: 0.5, steered: true }));
    expect(c.id).toBe("go");
    expect(c.text).toMatch(/\bJ\b/);
  });

  it("tells a touch player to drag, not to move the mouse", () => {
    const s = coachStep(flyer({ touch: true, locked: false, throttle: 0.5, steered: false }));
    expect(s.text).toMatch(/DRAG/);
  });

  it("describes the layout the player is actually on", () => {
    expect(coachStep(flyer({ steered: false })).sub).toMatch(/slide/);
    expect(coachStep(flyer({ steered: false, scheme: "sim" })).sub).toMatch(/yaw/);
  });

  it("stops lecturing somebody who has flown before", () => {
    expect(coachStep(flyer({ taught: true, throttle: 0, steered: false }))).toBeNull();
  });

  it("still tells them how to land, because that is the whole game", () => {
    /* Conditional and therefore undiscoverable: L only works inside 2.6 radii,
       so a player who tried every key from further out concluded it did not
       exist. It survives `taught` for the same reason. */
    const s = coachStep(flyer({ taught: true, canLand: true, landVerb: "enter world", targetName: "Seafair" }));
    expect(s.text).toMatch(/PRESS L/);
    expect(s.text).toMatch(/ENTER WORLD/);
    expect(s.sub).toMatch(/SEAFAIR/);
  });

  it("puts the dead pointer ahead of the landing, because nothing works without it", () => {
    expect(coachStep(flyer({ locked: false, canLand: true })).id).toBe("lock");
  });

  it("changes id when the world in reach changes, so the prompt fires again", () => {
    const a = coachStep(flyer({ canLand: true, targetName: "Seafair" }));
    const b = coachStep(flyer({ canLand: true, targetName: "Redline" }));
    expect(a.id).not.toBe(b.id);
  });
});

describe("the reference behind ?", () => {
  const flat = (c: Record<string, unknown>) =>
    keyReference(c).flatMap(([, rows]: [string, Chip[]]) => rows.map((r) => r.join(" ")));

  it("is the only place the settings keys are written down", () => {
    const rows = flat({ scheme: "simple", schemeLabel: "SIMPLE", assist: true, flySens: 1 });
    expect(rows.join(" | ")).toMatch(/O layout — now SIMPLE/);
    expect(rows.join(" | ")).toMatch(/Z flight assist — now ON/);
    expect(rows.join(" | ")).toMatch(/\[ \/ ] steering sensitivity — now 100%/);
  });

  it("quotes the settings as they currently are, not as they shipped", () => {
    const rows = flat({ scheme: "sim", schemeLabel: "SIM · 6DOF", assist: false, flySens: 1.75 }).join(" | ");
    expect(rows).toMatch(/now SIM · 6DOF/);
    expect(rows).toMatch(/assist — now OFF/);
    expect(rows).toMatch(/now 175%/);
  });

  it("describes the layout in force rather than both of them", () => {
    const simple = flat({ scheme: "simple", schemeLabel: "SIMPLE", assist: true, flySens: 1 }).join(" | ");
    expect(simple).toMatch(/A \/ D slide/);
    expect(simple).not.toMatch(/A \/ D yaw/);
    const sim = flat({ scheme: "sim", schemeLabel: "SIM", assist: true, flySens: 1 }).join(" | ");
    expect(sim).toMatch(/A \/ D yaw/);
  });

  it("carries the things the short row dropped", () => {
    // Matched on the key itself, not on the line: "E" also occurs inside
    // "Q / E roll", and a substring check would have called that a hit.
    const bound = keyReference({ scheme: "simple", schemeLabel: "SIMPLE", assist: true, flySens: 1 })
      .flatMap(([, rows]: [string, Chip[]]) => rows.map((r) => r[0]));
    for (const k of ["V", "F", "G", "T", "M", "E", "1 - 5", "TAB", "X", "SHIFT"]) {
      expect(bound).toContain(k);
    }
  });
});
