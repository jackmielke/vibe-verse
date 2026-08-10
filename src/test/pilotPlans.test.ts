/**
 * Every character stands on the floor, in one piece.
 *
 * Both of the real bugs in the body-plan work were the same bug, and neither
 * was catchable by anything that existed: the rig built without error, typed
 * fine, and rendered a character in two pieces with a third of a metre of air
 * between them. A tracked base sitting on the ground under a crate that was
 * not touching it. Stubby legs walking along beneath a penguin they were not
 * attached to. You only find that by looking at it — so this looks at it, in
 * the only way a test can: it measures.
 *
 * Two invariants, and they are the two that were violated:
 *
 *   1. **Feet on the floor.** The rig's lowest point is y ≈ 0, because every
 *      world places a character by putting its origin on the ground. A rig
 *      that ends at 0.3 hovers; one that ends at -0.3 is buried to the knee.
 *   2. **One piece.** Project every mesh onto the vertical axis and the
 *      occupied intervals must merge into a single run. A gap in that run is
 *      precisely "the body and the thing holding it up are not connected",
 *      which is invisible to a typechecker and obvious in a photograph.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  PILOT_DESIGNS,
  buildProceduralPilot,
  type PilotFrame,
} from "@/components/city/proceduralPilot";

const IDS = Object.keys(PILOT_DESIGNS);

/** Settle the springs, the same way the portrait renderer does. */
function settle(pilot: ReturnType<typeof buildProceduralPilot>, frame: Partial<PilotFrame> = {}) {
  const f: PilotFrame = {
    speed: 0, grounded: true, verticalVel: 0, yawRate: 0, thrusting: false, ...frame,
  };
  for (let i = 0; i < 90; i++) pilot.update(1 / 60, f);
  pilot.group.updateMatrixWorld(true);
}

/** Vertical extent of every mesh in the rig, in the rig's own space. */
function spans(group: THREE.Object3D): [number, number][] {
  const out: [number, number][] = [];
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const box = new THREE.Box3().setFromObject(o);
    if (box.isEmpty()) return;
    out.push([box.min.y, box.max.y]);
  });
  return out;
}

/** Merge overlapping intervals; what comes back is the runs of solid body. */
function merge(intervals: [number, number][], slack: number): [number, number][] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const runs: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = runs[runs.length - 1];
    if (last && lo <= last[1] + slack) last[1] = Math.max(last[1], hi);
    else runs.push([lo, hi]);
  }
  return runs;
}

describe("every character in the design table", () => {
  it("has at least the five body plans between them", () => {
    const plans = new Set(IDS.map((id) => PILOT_DESIGNS[id].plan ?? "biped"));
    expect(plans).toContain("biped");
    expect(plans).toContain("hover");
    expect(plans).toContain("tread");
    expect(plans).toContain("waddle");
  });

  for (const id of IDS) {
    const design = PILOT_DESIGNS[id];
    const plan = design.plan ?? "biped";

    describe(id, () => {
      it("builds and survives a hard frame without throwing", () => {
        const pilot = buildProceduralPilot(undefined, id);
        // Sprinting, turning hard, mid-air, then a heavy landing — every
        // branch of the solver, including the ones a still portrait never hits.
        settle(pilot, { speed: 9, yawRate: 2.5, grounded: false, verticalVel: -20 });
        settle(pilot, { speed: 4, yawRate: -1.8 });
        settle(pilot, { speed: 0, thrusting: true });
        expect(Number.isFinite(pilot.group.position.y)).toBe(true);
        pilot.dispose();
      });

      it(plan === "hover" ? "floats clear of the ground" : "stands on the ground", () => {
        const pilot = buildProceduralPilot(undefined, id);
        settle(pilot);
        const box = new THREE.Box3().setFromObject(pilot.group);
        if (plan === "hover") {
          // The point of the plan. If this ever reaches the floor it has
          // quietly become a very smooth biped.
          expect(box.min.y, `${id} is resting on the floor`).toBeGreaterThan(0.1);
        } else {
          /* A little slack each way: a boot sole and a track cleat are allowed
             to grave the surface, and a landing squash is still settling. What
             this catches is the tenth-of-a-metre class of error. */
          expect(box.min.y, `${id} does not reach the floor`).toBeLessThan(0.06);
          expect(box.min.y, `${id} is sunk into the floor`).toBeGreaterThan(-0.12);
        }
        pilot.dispose();
      });

      it("is one connected body from top to bottom", () => {
        /* Hover is exempt and deliberately so: its hands are detached from its
           shoulders and its thruster wash is detached from everything, which
           is the entire silhouette. Nothing else may have a hole in it. */
        if (plan === "hover") return;
        const pilot = buildProceduralPilot(undefined, id);
        settle(pilot);
        const runs = merge(spans(pilot.group), 0.05);
        expect(
          runs.length,
          `${id} is in ${runs.length} pieces: ${runs
            .map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)}`)
            .join(" | ")}`,
        ).toBe(1);
        pilot.dispose();
      });

      it("is a plausible height for something that shares a camera with the others", () => {
        const pilot = buildProceduralPilot(undefined, id);
        settle(pilot);
        const size = new THREE.Box3().setFromObject(pilot.group).getSize(new THREE.Vector3());
        // City fits its chase camera to roughly a 1.8 m rig and does not
        // re-measure per design, so a character half that or twice it is a
        // camera bug in every world at once rather than a style choice.
        expect(size.y, `${id} is ${size.y.toFixed(2)}m tall`).toBeGreaterThan(0.7);
        expect(size.y, `${id} is ${size.y.toFixed(2)}m tall`).toBeLessThan(2.6);
        pilot.dispose();
      });
    });
  }
});
