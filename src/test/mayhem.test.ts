import { describe, expect, it } from "vitest";
import { blastThreshold, copsFor, isVolatile, pickTarget, starsFor } from "@/city/mayhem";

describe("GTA Junior rules", () => {
  it("shows no stars until there is heat, then rounds up", () => {
    expect(starsFor(0)).toBe(0);
    expect(starsFor(0.3)).toBe(1);
    expect(starsFor(2)).toBe(2);
    expect(starsFor(9)).toBe(5);
  });

  it("sends more police as the heat rises, and always some for a loose heist", () => {
    expect(copsFor(0.5, false)).toBe(0);
    expect(copsFor(1, false)).toBe(1);
    expect(copsFor(2.5, false)).toBe(2);
    expect(copsFor(5, false)).toBe(5);
    expect(copsFor(0, true)).toBe(2);
  });

  it("makes about a third of buildings volatile, and they go up sooner", () => {
    let n = 0;
    for (let i = 0; i < 300; i++) if (isVolatile({ minX: i * 40 - 160, minZ: (i % 9) * 40 - 160 })) n++;
    expect(n).toBeGreaterThan(60);
    expect(n).toBeLessThan(140);
    expect(blastThreshold(true)).toBeLessThan(blastThreshold(false));
  });

  it("aims at what is in front, not behind", () => {
    const cands = [{ x: 0, z: -10 }, { x: 1, z: 20 }, { x: 30, z: 0 }];
    expect(pickTarget(0, 0, 0, 50, 0.3, cands)).toBe(1);
    expect(pickTarget(0, 0, Math.PI / 2, 50, 0.3, cands)).toBe(2);
    expect(pickTarget(0, 0, 0, 10, 0.3, cands)).toBe(-1);
  });
});

describe("forgiveness", () => {
  it("is Jack's minute and three seconds", async () => {
    const { FORGIVE_AFTER } = await import("@/city/mayhem");
    expect(FORGIVE_AFTER).toBe(63);
  });
});
