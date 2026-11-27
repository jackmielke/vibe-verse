import { describe, expect, it } from "vitest";

import {
  cleanOps, fold, LIMITS, placeOps, snapshotOps, toLocal, toWorld, type Here, type Op,
} from "../../supabase/functions/vibe-wizard/spec.ts";

const here: Here = { x: 330, y: 120, z: -60, yaw: 0 };

const duck: Op = {
  op: "add",
  thing: { id: "Rubber Duck!", name: "Duck", at: [0, 0, 8], parts: [{ s: "sphere", size: [2, 2, 2], c: "#ffdd00" }] },
};

describe("the wizard's world format", () => {
  it("puts a wish in front of the wisher, whichever way they face", () => {
    // yaw 0 faces -z in three.
    expect(toWorld([0, 0, 8], here)).toEqual([330, 120, -68]);
    // Facing +x (yaw -90deg): forward is +x, right is +z.
    const east = { ...here, yaw: -Math.PI / 2 };
    const [x, , z] = toWorld([2, 0, 8], east);
    expect(x).toBeCloseTo(338);
    expect(z).toBeCloseTo(-58);
  });

  it("round-trips between the wisher's frame and the island's", () => {
    const h = { x: 10, y: 3, z: -4, yaw: 1.1 };
    const abs = toWorld([3, 1, 7], h);
    const back = toLocal(abs, h);
    expect(back[0]).toBeCloseTo(3, 1);
    expect(back[1]).toBeCloseTo(1, 1);
    expect(back[2]).toBeCloseTo(7, 1);
  });

  it("keeps a wish within reach", () => {
    const [x, , z] = toWorld([0, 0, 99999], here);
    expect(Math.hypot(x - here.x, z - here.z)).toBeLessThanOrEqual(LIMITS.reach + 0.01);
  });

  it("throws away anything that is not a shape", () => {
    const ops = cleanOps([
      { op: "add", thing: { id: "x", at: [0, 0, 0], parts: [{ s: "script", src: "alert(1)" }, { s: "box", c: "red" }] } },
      { op: "delete_everything" },
      { op: "add", thing: { id: "y", at: [0, 0, 0], parts: [] } },
    ]);
    expect(ops).toHaveLength(1);
    const t = (ops[0] as Extract<Op, { op: "add" }>).thing;
    expect(t.parts).toHaveLength(1);
    expect(t.parts[0].s).toBe("box");
    expect(t.parts[0].c).toBe("#cccccc"); // "red" is not a hex colour
  });

  it("scopes new ids, but lets a wish replace a thing it names", () => {
    const placed = placeOps(cleanOps([duck]), here, "ab12", "Jack", "fast", new Set());
    const id = (placed[0] as Extract<Op, { op: "add" }>).thing.id;
    expect(id).toBe("ab12-rubber-duck");
    const again = placeOps(cleanOps([{ ...duck, thing: { ...duck.thing, id } }]), here, "cd34", "Jack", "fast", new Set([id]));
    expect((again[0] as Extract<Op, { op: "add" }>).thing.id).toBe(id);
    // Edits and removes of things that are not nearby are dropped.
    expect(placeOps(cleanOps([{ op: "remove", id: "someone-elses-castle" }]), here, "x", "J", "fast", new Set())).toEqual([]);
  });

  it("caps a fast wish at its budget", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...duck, thing: { ...duck.thing, id: "d" + i } }));
    expect(placeOps(cleanOps(many), here, "p", "J", "fast", new Set())).toHaveLength(LIMITS.fast.things);
  });

  it("folds edits, honours undo, and edits in place", () => {
    const add = placeOps(cleanOps([duck]), here, "a", "J", "fast", new Set());
    const id = (add[0] as Extract<Op, { op: "add" }>).thing.id;
    const rows = [
      { id: 1, ops: add },
      { id: 2, ops: [{ op: "edit", id, tint: "#0000ff", scale: 3 }] },
      { id: 3, ops: [{ op: "remove", id }], undone: true },
    ];
    const s = fold(rows);
    expect(s.things.size).toBe(1);
    const t = s.things.get(id)!;
    expect(t.scale).toBe(3);
    expect(t.parts[0].c).toBe("#0000ff");
    expect(fold([...rows.slice(0, 2), { id: 3, ops: [{ op: "remove", id }] }]).things.size).toBe(0);
  });

  it("forgets the oldest wishes once the world is full", () => {
    const rows = Array.from({ length: LIMITS.worldThings + 5 }, (_, i) => ({
      id: i,
      ops: [{ op: "add", thing: { id: "t" + i, name: "t", at: [0, 0, 0], parts: [{ s: "box" }] } }],
    }));
    const s = fold(rows);
    expect(s.things.size).toBe(LIMITS.worldThings);
    expect(s.things.has("t0")).toBe(false);
    expect(s.things.has("t" + (LIMITS.worldThings + 4))).toBe(true);
  });

  it("a remix is the same world, flattened", () => {
    const rows = [{ id: 1, ops: placeOps(cleanOps([duck]), here, "a", "J", "fast", new Set()) }];
    const s = fold(rows);
    const copy = fold([{ id: 1, ops: snapshotOps(s) }]);
    expect([...copy.things.values()]).toEqual([...s.things.values()]);
  });
});
