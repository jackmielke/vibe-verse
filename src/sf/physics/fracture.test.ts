import { describe, it, expect } from "vitest";
import { fractureBox } from "./destruction";

describe("voronoi fracture", () => {
  it("tessellates the source box", () => {
    const hx = 0.6, hy = 1.1, hz = 0.4;
    const p = fractureBox(hx, hy, hz, 14, "probe-a");
    const boxVol = 8 * hx * hy * hz;
    for (const s of p.shards) {
      expect(s.volume).toBeGreaterThan(0);
      expect(s.hull.length).toBeGreaterThanOrEqual(12);
      expect(Number.isFinite(s.cx + s.cy + s.cz)).toBe(true);
    }
    expect(p.shards.length).toBeGreaterThan(6);
    expect(p.totalVolume).toBeGreaterThan(boxVol * 0.93);
    expect(p.totalVolume).toBeLessThan(boxVol * 1.07);
  });

  it("is deterministic and cached", () => {
    const a = fractureBox(1, 1, 1, 10, "probe-b");
    const b = fractureBox(1, 1, 1, 10, "probe-b");
    expect(a).toBe(b);
  });

  it("handles thin slabs (glass panes)", () => {
    const p = fractureBox(1.2, 1.6, 0.02, 20, "probe-glass");
    const boxVol = 8 * 1.2 * 1.6 * 0.02;
    expect(p.shards.length).toBeGreaterThan(4);
    expect(p.totalVolume).toBeGreaterThan(boxVol * 0.9);
  });
});
