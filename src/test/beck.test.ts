import { describe, expect, it } from "vitest";
import data from "@/beck/data/neighbourhood.json";
import { decodeTerrain, nearestAddress, nearestRoad, orientedBox, point, ringArea, signName, type Neighbourhood } from "@/beck/geo";

const d = data as unknown as Neighbourhood;

describe("the data under Beck Road", () => {
  it("is centred on 8330 NE Beck Rd and has the whole street", () => {
    const a = d.addresses.find((x) => x.n === "8330" && x.st?.toLowerCase().includes("beck"));
    expect(a).toBeTruthy();
    const p = point(a!.g)!;
    expect(Math.hypot(p[0], p[1])).toBeLessThan(1);
    const beck = d.addresses.filter((x) => x.st?.toLowerCase().includes("beck")).map((x) => x.n);
    expect(beck.length).toBeGreaterThanOrEqual(25);
    for (const n of ["7931", "8000", "8250", "8330", "8368", "8416", "8490"]) expect(beck).toContain(n);
  });

  it("has the roads someone who grew up there would name", () => {
    const names = new Set(d.roads.map((r) => r.name).filter(Boolean));
    for (const n of ["Northeast Beck Road", "Lytle Road Northeast", "Blakely Avenue Northeast", "Pleasant Beach Drive Northeast", "Mattson Place Northeast", "Northeast Oddfellows Road"]) expect(names.has(n)).toBe(true);
    expect(d.roads.filter((r) => r.cls === "service").length).toBeGreaterThan(100);
  });

  it("has every building on a footprint, the school and the beach", () => {
    expect(d.buildings.length).toBeGreaterThan(450);
    expect(d.buildings.filter((b) => b.h).length).toBeGreaterThan(300);
    expect(d.places.some((p) => (p.name || "").includes("Blakely Elementary"))).toBe(true);
    expect(d.places.some((p) => (p.name || "").includes("Lytle Beach"))).toBe(true);
    expect(d.land.filter((l) => l.sub === "forest").length).toBeGreaterThan(5);
    expect(d.infra.filter((l) => l.cls === "minor_line").length).toBeGreaterThan(0);
  });

  it("finds the nearest address and road from a point", () => {
    const a = nearestAddress(d, 0, 0)!;
    expect(a.address.n).toBe("8330");
    const r = nearestRoad(d, 0, 0, ["residential", "tertiary", "secondary"])!;
    expect(["Northeast Beck Road", "Mattson Place Northeast"]).toContain(r.road.name);
    expect(r.d).toBeLessThan(80);
    const beck = nearestRoad(d, 0, 0, ["residential", "tertiary", "secondary"], "beck road")!;
    expect(beck.road.name).toBe("Northeast Beck Road");
    expect(beck.d).toBeLessThan(80);
  });

  it("signs roads the way the county does", () => {
    expect(signName("Northeast Beck Road")).toBe("NE Beck Rd");
    expect(signName("Blakely Avenue Northeast")).toBe("Blakely Ave NE");
    expect(signName("Pleasant Beach Drive Northeast")).toBe("Pleasant Beach Dr NE");
  });
});

describe("geometry", () => {
  it("decodes terrain heights and samples between cells", () => {
    const meta = { w: 2, h: 2, tl: [0, 0], br: [10, 10], png: "" };
    const v = (h: number) => Math.round((h + 512) * 16);
    const px = (h: number) => [v(h) >> 8, v(h) & 255, 0, 255];
    const rgba = new Uint8ClampedArray([...px(10), ...px(20), ...px(30), ...px(40)]);
    const t = decodeTerrain(meta, rgba);
    expect(t.at(0, 0)).toBeCloseTo(10, 1);
    expect(t.at(10, 0)).toBeCloseTo(20, 0);
    expect(t.at(5, 5)).toBeCloseTo(25, 0);
  });

  it("boxes a rotated rectangle tightly", () => {
    const c = Math.cos(0.4);
    const s = Math.sin(0.4);
    const rect = [
      [-5, -2],
      [5, -2],
      [5, 2],
      [-5, 2],
      [-5, -2],
    ].map(([x, z]) => [x * c - z * s + 100, x * s + z * c - 50]);
    const b = orientedBox(rect);
    expect(Math.max(b.w, b.d)).toBeCloseTo(10, 1);
    expect(Math.min(b.w, b.d)).toBeCloseTo(4, 1);
    expect(b.cx).toBeCloseTo(100, 1);
    expect(b.cz).toBeCloseTo(-50, 1);
    expect(Math.abs(ringArea(rect))).toBeCloseTo(40, 1);
  });
});
