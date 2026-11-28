import { describe, expect, it } from "vitest";
import { HOSTS, dayNumber, placementFor, placementOn, secondsUntilItMoves, today } from "@/monolith/schedule";

describe("the Monolith's schedule", () => {
  it("puts everybody in the same place on the same UTC day", () => {
    const a = today(new Date("2026-11-28T00:00:01Z"));
    const b = today(new Date("2026-11-28T23:59:59Z"));
    expect(a.host.key).toBe(b.host.key);
    expect(a.spot).toEqual(b.spot);
  });

  it("never stands in the same world two days running", () => {
    const start = dayNumber(new Date("2026-01-01T12:00:00Z"));
    for (let d = start; d < start + 1500; d++) {
      expect(placementOn(d).host.key, `day ${d}`).not.toBe(placementOn(d + 1).host.key);
    }
  });

  it("visits every host world in every cycle", () => {
    const n = HOSTS.length;
    for (let c = 7000; c < 7100; c++) {
      const seen = new Set<string>();
      for (let i = 0; i < n; i++) seen.add(placementOn(c * n + i).host.key);
      expect(seen.size).toBe(n);
    }
  });

  it("only offers spots a host actually has", () => {
    for (let d = 20000; d < 20400; d++) {
      const p = placementOn(d);
      expect(p.host.spots).toContain(p.spot);
    }
  });

  it("can be forced into any host with ?monolith", () => {
    for (const h of HOSTS) {
      const p = placementFor(h.key, "?monolith");
      expect(p?.host.key).toBe(h.key);
      expect(p?.spot).toBe(h.spots[0]);
    }
  });

  it("is absent from every host but today's", () => {
    const here = HOSTS.filter((h) => placementFor(h.key, "") !== null);
    expect(here.map((h) => h.key)).toEqual([today().host.key]);
  });

  it("counts down to the next UTC midnight", () => {
    expect(secondsUntilItMoves(new Date("2026-11-28T23:00:00Z"))).toBeCloseTo(3600, 3);
  });
});
