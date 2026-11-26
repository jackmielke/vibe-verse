import { describe, expect, it } from "vitest";
import { CHARACTER_REACH } from "@/lib/characterReach";
import { worldByKey } from "@/worlds/registry";

describe("character reach", () => {
  it("names only worlds that exist in the registry", () => {
    const missing = CHARACTER_REACH.filter((r) => !worldByKey(r.key)).map((r) => r.key);
    expect(missing).toEqual([]);
  });

  it("lists each world once", () => {
    const keys = CHARACTER_REACH.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
