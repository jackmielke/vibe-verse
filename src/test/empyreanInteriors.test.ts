import { describe, expect, it } from "vitest";
import { cityPlan, LANDMARKS } from "@/empyrean/cityplan";

describe("scratch", () => {
  it("dumps", () => {
    const plan = cityPlan();
    const obs = LANDMARKS.find((l) => l.id === "observatory")!;
    const cand = plan.lots.filter((l) => l.district === "gardens" || l.district === "rim");
    const info = cand.map((l) => {
      let depth = 0;
      for (const p of l.poly) {
        const d = -((p.x - l.frontMid.x) * l.frontNormal.x + (p.z - l.frontMid.z) * l.frontNormal.z);
        depth = Math.max(depth, d);
      }
      return { id: l.id, use: l.use, d: +Math.hypot(l.centroid.x - obs.x, l.centroid.z - obs.z).toFixed(1), fl: +l.frontLen.toFixed(1), dep: +depth.toFixed(1), h: +l.height.toFixed(1) };
    }).filter((i) => i.use === "shop" || i.use === "pavilion");
    info.sort((a, b) => a.d - b.d);
    console.log(JSON.stringify(info.slice(0, 14)));
    expect(1).toBe(1);
  });
});
