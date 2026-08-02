/**
 * The three things in RUN, VIBEY, RUN that fail quietly.
 *
 * All three of these produce a game that boots, renders a perfectly nice
 * screenshot, and is wrong — which is exactly the failure mode a canvas world
 * cannot be checked for by looking at it.
 *
 * 1. **A road with no way through.** Obstacles are placed in lanes derived
 *    from the chapter's own half-width and the obstacle's radius. Widen one
 *    obstacle past the road and the lane count collapses to a single lane the
 *    obstacle completely fills, and the chapter becomes unwinnable somewhere
 *    around the two-hundred-metre mark, on a machine that is not yours.
 *
 * 2. **A line nobody hears.** The world drifts gently under the title card, so
 *    a beat pinned too near zero fires before the player has pressed RUN and
 *    its line is discarded — the chapter simply opens without its opening
 *    line, silently, forever.
 *
 * 3. **A crowd that is off the road.** The finale's followers are laid out in
 *    ranks that get wider the further back they are. Widen them a little too
 *    much and the back rank is running through the desert forty metres out.
 */
import { describe, expect, it } from "vitest";
import { CHAPTERS, RUN_SPECS_FOR_TEST } from "@/gump/chapters";
import { makeCrowd } from "@/gump/crowd";

const SPECS = Object.entries(RUN_SPECS_FOR_TEST);

describe("every road has a way through it", () => {
  it.each(SPECS)("%s leaves a gap beside every obstacle", (_name, spec) => {
    for (const kind of spec.obstacles) {
      // Mirrors the lane maths in RunChapter.spawnAhead.
      const lanes = Math.max(2, Math.floor((spec.halfWidth * 2) / (kind.radius * 2.6)));
      expect(lanes, `${kind.key} leaves no second lane`).toBeGreaterThanOrEqual(2);
      // And the obstacle in one lane must not reach into the next one: the
      // player's own collision half-width is 0.55, so a gap has to beat that.
      const laneWidth = (spec.halfWidth * 2) / lanes;
      expect(laneWidth - kind.radius, `${kind.key} fills its lane`).toBeGreaterThan(0.55);
    }
  });

  it.each(SPECS)("%s can be finished before the pickups run out", (_name, spec) => {
    // A chapter whose pickups are spaced further apart than the whole chapter
    // is long shows an empty counter for the entire run.
    expect(spec.pickup.every * 3).toBeLessThan(spec.goal);
  });

  it.each(SPECS)("%s can actually reach its own top speed", (_name, spec) => {
    expect(spec.max).toBeGreaterThan(spec.start);
    expect(spec.accel).toBeGreaterThan(0);
    expect(spec.lives).toBeGreaterThan(0);
  });
});

describe("the beats", () => {
  it.each(SPECS)("%s fires every line where it can be seen", (_name, spec) => {
    let previous = 0;
    for (const beat of spec.beats ?? []) {
      // 0.03 is the floor: the world runs at a third speed under the title
      // card, and anything below this can be passed before the card is gone.
      expect(beat.at, `"${beat.say}" fires behind the title card`).toBeGreaterThanOrEqual(0.03);
      expect(beat.at).toBeLessThanOrEqual(1);
      expect(beat.at, `"${beat.say}" is out of order`).toBeGreaterThan(previous);
      previous = beat.at;
    }
  });

  it("gives every chapter on the timeline a spec or a game of its own", () => {
    const ids = CHAPTERS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Ping-pong is the one beat that is not a RunSpec; everything else is.
    const specced = new Set(Object.keys(RUN_SPECS_FOR_TEST));
    for (const id of ids) {
      if (id === "pingpong") continue;
      expect(specced.has(id), `${id} has no run spec`).toBe(true);
    }
    expect(specced.size).toBe(ids.length - 1);
  });

  it("gives every chapter the copy the cards need", () => {
    for (const c of CHAPTERS) {
      for (const field of ["title", "where", "card", "outro", "fail", "how", "tab"] as const) {
        expect(c[field].length, `${c.id} has no ${field}`).toBeGreaterThan(0);
      }
      expect(c.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("the crowd behind you", () => {
  it("keeps forty people on the road and in front of the camera", () => {
    const crowd = makeCrowd(40);
    crowd.setCount(40);
    // The camera stands `depth() + 7` back, so the pack has to be shallow
    // enough that pulling back that far still frames the runner.
    const depth = crowd.depth();
    expect(depth).toBeGreaterThan(0);
    expect(depth, "the pack is too deep to frame").toBeLessThan(20);
    crowd.dispose();
  });

  it("gets deeper as people join, never shallower", () => {
    const crowd = makeCrowd(40);
    let previous = 0;
    for (const n of [1, 5, 12, 25, 40]) {
      crowd.setCount(n);
      const d = crowd.depth();
      expect(d).toBeGreaterThanOrEqual(previous);
      previous = d;
    }
    crowd.dispose();
  });
});
