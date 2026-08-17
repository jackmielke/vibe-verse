/**
 * The Midnight Zone is a game about a single number going up.
 *
 * Depth drives the fog, the colour, the ambient light, the grade, which
 * animals can appear and whether the seafloor exists. Every one of those reads
 * the same two functions, so if `zoneAt`/`waterAt` are wrong they are wrong
 * everywhere at once, and the symptom is "the ocean looks a bit off" — which
 * is not a symptom anyone can debug.
 *
 * These check the properties that actually matter to the look: that the water
 * only ever gets darker and thicker going down, that nothing snaps at a zone
 * boundary, and that the bestiary covers the whole column with no dead bands
 * where a dive would be empty.
 */
import { describe, it, expect } from "vitest";
import {
  FLOOR_DEPTH,
  ZONES,
  depthOf,
  mixHex,
  waterAt,
  yOfDepth,
  zoneAt,
} from "@/deep/types";
import { SPECIES, speciesAt } from "@/deep/life/species";
import { SPEEDS } from "@/deep/play/sub";

const luminance = (hex: number) => {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe("depth", () => {
  it("treats the surface as zero and down as positive", () => {
    /* The sign of this is the easiest bug in the world to write: the scene is
       +Y up, so every depth is a negated Y, and one missed minus puts the
       whole dive in the sky. */
    expect(depthOf(0)).toBe(0);
    expect(depthOf(-1200)).toBe(1200);
    expect(depthOf(50)).toBe(0); // above the surface is still the surface
    expect(yOfDepth(1200)).toBe(-1200);
    expect(depthOf(yOfDepth(3456))).toBe(3456);
  });
});

describe("the zones", () => {
  it("tile the whole column with no gap and no overlap", () => {
    for (let i = 1; i < ZONES.length; i++) {
      expect(ZONES[i].from, `${ZONES[i].id} does not start where ${ZONES[i - 1].id} ends`).toBe(
        ZONES[i - 1].to,
      );
    }
    expect(ZONES[0].from).toBe(0);
    expect(ZONES[ZONES.length - 1].to).toBe(FLOOR_DEPTH);
  });

  it("names the right layer either side of every boundary", () => {
    for (const z of ZONES) {
      expect(zoneAt(z.from).id).toBe(z.id);
      expect(zoneAt(z.to - 1).id).toBe(z.id);
    }
    // The floor itself is still the hadal zone, not undefined.
    expect(zoneAt(FLOOR_DEPTH).id).toBe("hadal");
    expect(zoneAt(FLOOR_DEPTH + 500).id).toBe("hadal");
  });
});

describe("the water", () => {
  it("only ever gets darker going down", () => {
    /* This is the whole world in one assertion. If any step down the column
       gets brighter, the descent stops reading as a descent. */
    let prev = Infinity;
    for (let d = 0; d <= FLOOR_DEPTH; d += 25) {
      const l = luminance(waterAt(d).color);
      expect(l, `water got brighter at ${d} m`).toBeLessThanOrEqual(prev + 0.001);
      prev = l;
    }
  });

  it("gets clearer going down, not murkier", () => {
    /* The intuitive curve — turbidity rising with depth — is both wrong about
       the ocean (abyssal water is among the clearest on Earth) and wrong for
       the game: it blinds the lamps at exactly the depth where the lamps are
       the only thing you have. The first build shipped it that way and the
       seafloor was invisible from twenty metres. */
    let prev = Infinity;
    for (let d = 0; d <= FLOOR_DEPTH; d += 25) {
      const density = waterAt(d).density;
      expect(density, `fog thickened at ${d} m`).toBeLessThanOrEqual(prev + 1e-9);
      prev = density;
    }
  });

  it("always leaves the lamps somewhere to reach", () => {
    /* FogExp2 falls off as exp(-(density·distance)²), so visibility to 10% is
       1.517/density metres. The lamps throw 90 m; if the fog eats them before
       that, the world is a black rectangle with a HUD on it. */
    for (let d = 0; d <= FLOOR_DEPTH; d += 100) {
      const visibility = 1.517 / waterAt(d).density;
      expect(visibility, `you can only see ${visibility.toFixed(0)} m at ${d} m`).toBeGreaterThan(90);
    }
  });

  it("runs the sunlight out and never brings it back", () => {
    let prev = Infinity;
    for (let d = 0; d <= FLOOR_DEPTH; d += 25) {
      const sun = waterAt(d).sun;
      expect(sun).toBeLessThanOrEqual(prev + 1e-9);
      expect(sun).toBeGreaterThanOrEqual(0);
      prev = sun;
    }
    expect(waterAt(0).sun).toBe(1);
    expect(waterAt(5000).sun).toBe(0);
  });

  it("does not snap at a zone boundary", () => {
    /* Stepping the colour per zone reads as five walls of coloured glass. The
       ramp is what makes eight kilometres feel like one movement, so a
       discontinuity here is a visual bug with no stack trace. */
    for (const z of ZONES.slice(1)) {
      const before = waterAt(z.from - 0.5);
      const after = waterAt(z.from + 0.5);
      expect(Math.abs(luminance(before.color) - luminance(after.color))).toBeLessThan(6);
      expect(Math.abs(before.density - after.density)).toBeLessThan(0.001);
    }
  });
});

describe("the bestiary", () => {
  it("has something to meet at every depth of the dive", () => {
    /* A band with no species in it is a stretch of dive where nothing ever
       happens, and at these speeds that is a minute of empty water. */
    for (let d = 0; d <= FLOOR_DEPTH; d += 50) {
      expect(speciesAt(d).length, `nothing lives at ${d} m`).toBeGreaterThan(0);
    }
  });

  it("gives every species a sane band, size and note", () => {
    for (const s of SPECIES) {
      expect(s.from, `${s.id} band is inverted`).toBeLessThan(s.to);
      expect(s.from).toBeGreaterThanOrEqual(0);
      expect(s.to).toBeLessThanOrEqual(FLOOR_DEPTH);
      expect(s.size).toBeGreaterThan(0);
      expect(s.weight).toBeGreaterThan(0);
      // The note is the entire reward for scanning. An empty one is a bug.
      expect(s.note.length, `${s.id} has no note`).toBeGreaterThan(30);
      expect(s.latin.length).toBeGreaterThan(3);
    }
  });

  it("keeps every id unique, because the log is keyed on it", () => {
    const ids = SPECIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("saves something for the bottom", () => {
    /* If everything were findable in the first kilometre there would be no
       reason to keep going down, and going down is the game. */
    const shallowOnly = SPECIES.filter((s) => s.from < 1000);
    expect(shallowOnly.length).toBeLessThan(SPECIES.length);
    expect(SPECIES.some((s) => s.from >= 6000)).toBe(true);
  });
});

describe("colour mixing", () => {
  it("returns the endpoints exactly", () => {
    expect(mixHex(0x112233, 0xaabbcc, 0)).toBe(0x112233);
    expect(mixHex(0x112233, 0xaabbcc, 1)).toBe(0xaabbcc);
  });

  it("stays inside the channel range", () => {
    for (let i = 0; i <= 10; i++) {
      const c = mixHex(0x000000, 0xffffff, i / 10);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(0xffffff);
    }
  });
});

describe("how long the dive takes", () => {
  /**
   * The complaint that sent this back for a second pass: "8 km takes too long."
   *
   * It did. The first build quoted its speeds as accelerations, and because the
   * integrator applies exponential drag the terminal velocity is `a / DRAG` —
   * so a ballast sink that read as 1.9 in the source was 0.65 m/s in the water,
   * which is **three and a half hours** to the floor. The briefing told players
   * to let it sink. Holding the dive key was still eleven minutes.
   *
   * Nobody catches that by reading the constants, and no build or typecheck has
   * an opinion about it. So the arithmetic lives here, in the units a player
   * actually experiences.
   */
  const terminal = {
    free: SPEEDS.ballast,
    dive: SPEEDS.heave + SPEEDS.ballast,
    boosted: SPEEDS.heave * SPEEDS.boost + SPEEDS.ballast,
  };
  const minutes = (mps: number) => FLOOR_DEPTH / mps / 60;

  it("gets a committed pilot to the bottom in a couple of minutes", () => {
    expect(minutes(terminal.dive)).toBeLessThan(3);
  });

  it("rewards the boost with a run under ninety seconds", () => {
    expect(minutes(terminal.boosted) * 60).toBeLessThan(90);
  });

  it("does not make the descent so fast that the zones blur past", () => {
    /* The other failure mode. Under about forty seconds the five layers stop
       being places you travel through and become a loading screen, and the
       creatures cannot spawn in fast enough to be met. */
    expect(minutes(terminal.boosted) * 60).toBeGreaterThan(40);
  });

  it("keeps drifting slower than driving, but not by an hour", () => {
    expect(terminal.free).toBeLessThan(terminal.dive);
    expect(minutes(terminal.free)).toBeLessThan(20);
  });

  it("lets the thrusters out-climb the ballast", () => {
    /* If ballast beat heave you could never go back up to re-scan something
       you missed, and the sink would be a trap rather than a current. */
    expect(SPEEDS.heave).toBeGreaterThan(SPEEDS.ballast * 2);
  });
});
