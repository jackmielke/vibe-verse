/**
 * The props system's ground truth.
 *
 * The two failures this file exists to catch are both invisible to a build and
 * to a screenshot from a kilometre away:
 *
 * 1. **Something is standing in the road.** A generator that trusts its own
 *    arithmetic instead of asking `surfaceAt()` puts a bench on a carriageway
 *    and a lamp post over the void, and both look fine from the air.
 * 2. **The budget quietly went.** Six thousand objects is only affordable while
 *    they are two dozen draw calls; one family that forgets to instance or to
 *    merge turns that into four hundred and nothing about it errors.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildProps, type PropsHandle } from "@/empyrean/props";
import { PLATEAU_R, DECKS, ISLAND_Y } from "@/empyrean/config";
import { cityPlan, surfaceAt } from "@/empyrean/cityplan";

let high: PropsHandle;
let low: PropsHandle;

beforeAll(() => {
  high = buildProps({ quality: "high", seedSalt: "test" });
  low = buildProps({ quality: "low", seedSalt: "test" });
});

/** Kinds that sit on a lot or a roof rather than on a pavement. */
const OFF_STREET = new Set(["bed", "hedge", "climber", "roof-item", "awning", "sign"]);

describe("empyrean props — placement", () => {
  it("never puts a street prop on the roadway or over the void", () => {
    const bad: string[] = [];
    for (const p of high.placements) {
      if (OFF_STREET.has(p.kind)) continue;
      const s = surfaceAt(p.x, p.z);
      if (s.kind === "road" || s.kind === "void" || s.kind === "parapet") {
        bad.push(`${p.kind} @ ${p.x.toFixed(1)},${p.z.toFixed(1)} on ${s.kind}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("keeps everything inside the island", () => {
    for (const p of high.placements) {
      const r = Math.hypot(p.x, p.z);
      expect(r).toBeLessThanOrEqual(DECKS[DECKS.length - 1].outer + 1);
    }
  });

  it("keeps street props at or above deck height and below the skyline", () => {
    for (const p of high.placements) {
      expect(p.y).toBeGreaterThan(ISLAND_Y - 80);
      expect(p.y).toBeLessThan(ISLAND_Y + 400);
    }
  });

  it("never blocks a doorstep", () => {
    // Awnings and signs hang over the door on purpose; everything on the
    // ground has to leave the way in clear. Bucketed, because the naive
    // cross product is five thousand props against a hundred and forty doors.
    const cell = new Map<string, Array<{ x: number; z: number }>>();
    const key = (x: number, z: number) => `${Math.floor(x / 8)}:${Math.floor(z / 8)}`;
    for (const p of high.placements) {
      if (OFF_STREET.has(p.kind)) continue;
      const k = key(p.x, p.z);
      const l = cell.get(k);
      if (l) l.push(p);
      else cell.set(k, [p]);
    }
    const bad: string[] = [];
    for (const d of cityPlan().doors) {
      const gx = Math.floor(d.x / 8);
      const gz = Math.floor(d.z / 8);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const p of cell.get(`${gx + dx}:${gz + dz}`) ?? []) {
            if (Math.hypot(p.x - d.x, p.z - d.z) < 0.9) bad.push(`${d.lot} blocked`);
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("puts lot furniture inside the lot it belongs to", () => {
    const plan = cityPlan();
    const gardens = plan.lots.filter((l) => l.use === "garden");
    const inAny = (x: number, z: number) =>
      gardens.some((l) => {
        let inside = false;
        const poly = l.poly;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const a = poly[i];
          const b = poly[j];
          if (
            a.z > z !== b.z > z &&
            x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x
          ) {
            inside = !inside;
          }
        }
        return inside;
      });
    for (const p of high.placements) {
      if (p.kind !== "bed") continue;
      expect(inAny(p.x, p.z)).toBe(true);
    }
  });
});

describe("empyrean props — what got placed", () => {
  it("dresses every district and every family the world needs", () => {
    const c = high.counts;
    for (const kind of [
      "lamp-spire",
      "lamp-bracket",
      "lamp-lantern",
      "tree",
      "hedge",
      "bed",
      "climber",
      "stall",
      "crate",
      "awning",
      "sign",
      "planter",
      "menu-board",
      "bench",
      "bollard",
      "bin",
      "cycle-rack",
      "drinking-fountain",
      "notice-column",
      "newsstand",
      "banner-run",
      "banner-mast",
      "string-anchor",
      "pennant",
      "beacon-mast",
      "string-run",
      "fountain",
      "roof-item",
      "telescope",
      "wind-sock",
      "rim-bench",
      "rail-span",
      "light-pool",
      "glow-point",
    ]) {
      expect(c[kind], `missing family: ${kind}`).toBeGreaterThan(0);
    }
  });

  it("puts a lamp roughly every thirty metres of pavement", () => {
    const lamps =
      high.counts["lamp-spire"] + high.counts["lamp-bracket"] + high.counts["lamp-lantern"];
    expect(lamps).toBeGreaterThan(250);
    expect(lamps).toBeLessThan(1400);
    // Every lamp implies a pool of light on the ground.
    expect(high.counts["light-pool"]).toBe(lamps);
  });

  it("makes the Terraces the green district", () => {
    const plan = cityPlan();
    const gardens = plan.lots.filter((l) => l.district === "gardens");
    expect(gardens.length).toBeGreaterThan(0);
    const trees = high.placements.filter((p) => p.kind === "tree");
    const inGardens = trees.filter((p) => {
      const r = Math.hypot(p.x, p.z);
      return r >= 218 && r < 288;
    });
    expect(trees.length).toBeGreaterThan(200);
    // Roughly a quarter of the island's area, and it should be carrying well
    // more than a quarter of its trees.
    expect(inGardens.length / trees.length).toBeGreaterThan(0.3);
  });

  it("keeps the market stalls in the Bazaar", () => {
    for (const p of high.placements) {
      if (p.kind !== "stall") continue;
      const r = Math.hypot(p.x, p.z);
      expect(r).toBeGreaterThanOrEqual(138 - 12);
      expect(r).toBeLessThanOrEqual(218 + 12);
    }
    expect(high.counts["stall"]).toBeGreaterThan(30);
  });

  it("has something human-scale within ten metres of most of the pavement", () => {
    // The whole point of the system: stand on a pavement and turn around.
    const eyeLevel = high.placements.filter(
      (p) => !["roof-item", "rail-span"].includes(p.kind),
    );
    const samples: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2 * 7.3;
      const r = 62 + ((i * 37) % 250);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (surfaceAt(x, z).kind === "walk") samples.push({ x, z });
    }
    expect(samples.length).toBeGreaterThan(40);
    let covered = 0;
    for (const s of samples) {
      for (const p of eyeLevel) {
        if (Math.abs(p.x - s.x) < 12 && Math.abs(p.z - s.z) < 12) {
          covered++;
          break;
        }
      }
    }
    expect(covered / samples.length).toBeGreaterThan(0.9);
  });
});

describe("empyrean props — budget", () => {
  it("stays inside a few dozen draw calls", () => {
    expect(high.drawCalls).toBeGreaterThan(10);
    expect(high.drawCalls).toBeLessThanOrEqual(48);
    expect(low.drawCalls).toBeLessThanOrEqual(48);
  });

  it("cuts counts hard on the low tier without losing the character", () => {
    const total = (h: PropsHandle) =>
      Object.values(h.counts).reduce((a, b) => a + b, 0);
    expect(total(low)).toBeLessThan(total(high) * 0.62);
    // Still a lit city, still a green one.
    expect(low.counts["tree"]).toBeGreaterThan(60);
    expect(low.counts["lamp-lantern"]).toBeGreaterThan(20);
    expect(low.counts["stall"]).toBeGreaterThan(5);
  });

  it("instances the families that run to the hundreds", () => {
    const instanced = new Map<string, number>();
    high.group.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh) instanced.set(m.name, m.count);
    });
    expect(instanced.get("empyrean-lamp-spire")).toBeGreaterThan(20);
    expect(instanced.get("empyrean-tree-trunk")).toBeGreaterThan(200);
    expect(instanced.get("empyrean-tree-canopy")).toBe(
      instanced.get("empyrean-tree-trunk"),
    );
    expect(instanced.get("empyrean-lamp-pools")).toBeGreaterThan(200);
  });

  it("chunks the merged street dressing so culling can do something", () => {
    const chunks: string[] = [];
    high.group.traverse((o) => {
      if (o.name.startsWith("empyrean-props-street")) chunks.push(o.name);
    });
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.length).toBeLessThanOrEqual(8);
  });

  it("declares blockers that are small, solid and above the deck", () => {
    expect(high.blockers!.length).toBeGreaterThan(100);
    for (const b of high.blockers!) {
      expect(b.hx).toBeGreaterThan(0);
      expect(b.hx).toBeLessThan(3);
      expect(b.hz).toBeLessThan(3);
      expect(b.top).toBeGreaterThan(b.bottom);
    }
  });
});

describe("empyrean props — the frame", () => {
  function frame(over: Partial<Parameters<NonNullable<PropsHandle["update"]>>[0]> = {}) {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, ISLAND_Y + 2, 70);
    return {
      time: 12,
      dt: 0.016,
      camera,
      player: {
        position: new THREE.Vector3(0, ISLAND_Y, 70),
        velocity: new THREE.Vector3(),
        yaw: 0,
        grounded: true,
        burn: 0,
        altitude: 1.8,
      },
      quality: "high" as const,
      dayPhase: 0.75,
      sunDir: new THREE.Vector3(0, 0.1, -1).normalize(),
      daylight: 0.5,
      gradeDaylight: 1,
      camRadiusSq: 70 * 70,
      ...over,
    };
  }

  it("switches the lamps on as the daylight goes", () => {
    const lit = () => {
      let found = -1;
      high.group.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        if (m && m.uniforms && m.uniforms.uNight) found = m.uniforms.uNight.value;
      });
      return found;
    };
    high.update!(frame({ daylight: 1 }));
    expect(lit()).toBeLessThan(0.02);
    high.update!(frame({ daylight: 0.02 }));
    expect(lit()).toBeGreaterThan(0.98);
    high.update!(frame({ daylight: 0.24 }));
    const mid = lit();
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.95);
  });

  it("hides the far chunks and shows the near ones", () => {
    const near = new THREE.PerspectiveCamera();
    near.position.set(0, ISLAND_Y + 2, 250);
    high.update!(frame({ camera: near }));
    const vis: boolean[] = [];
    high.group.traverse((o) => {
      if (o.name.startsWith("empyrean-props-street")) vis.push(o.visible);
    });
    expect(vis.some((v) => v)).toBe(true);
    expect(vis.some((v) => !v)).toBe(true);
  });

  it("does not allocate per frame", () => {
    // A proxy for "no allocation": running it a thousand times must not grow
    // any of the arrays the system keeps, and must not throw.
    const before = high.placements.length;
    for (let i = 0; i < 1000; i++) high.update!(frame({ time: i * 0.016 }));
    expect(high.placements.length).toBe(before);
  });
});

describe("empyrean props — teardown", () => {
  it("releases every geometry and material it made", () => {
    const h = buildProps({ quality: "low", seedSalt: "dispose" });
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    h.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) geos.add(m.geometry);
      if (m.material) {
        for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
      }
    });
    expect(geos.size).toBeGreaterThan(3);
    expect(mats.size).toBeGreaterThan(0);

    let disposed = 0;
    const seen = new Set<unknown>();
    for (const g of geos) {
      g.addEventListener("dispose", () => {
        if (!seen.has(g)) {
          seen.add(g);
          disposed++;
        }
      });
    }
    for (const m of mats) {
      m.addEventListener("dispose", () => {
        if (!seen.has(m)) {
          seen.add(m);
          disposed++;
        }
      });
    }

    h.dispose();
    expect(disposed).toBe(geos.size + mats.size);
    expect(h.group.children.length).toBe(0);
  });
});

describe("empyrean props — the plan is the only source", () => {
  it("is deterministic for a given seed and tier", () => {
    const a = buildProps({ quality: "low", seedSalt: "same" });
    const b = buildProps({ quality: "low", seedSalt: "same" });
    expect(a.placements.length).toBe(b.placements.length);
    expect(a.counts).toEqual(b.counts);
    expect(a.placements[17]).toEqual(b.placements[17]);
    a.dispose();
    b.dispose();
  });

  it("does not join the reflection", () => {
    expect(high.reflected).toBeFalsy();
    expect(high.name).toBe("props");
  });

  it("stays under the rim wall", () => {
    for (const p of high.placements) {
      expect(Math.hypot(p.x, p.z)).toBeLessThan(PLATEAU_R + 62);
    }
  });
});
