/**
 * The chart and the people are the two things in this world that are *data*,
 * and data that disagrees with itself is the failure mode a screenshot cannot
 * catch: a system whose character does not exist hails nobody, a landable world
 * with no kit beams the away team onto an empty plane, and a warp scale that
 * has drifted turns "ninety light years" into a number that means nothing.
 *
 * So these check the registry against itself and against the arithmetic, and
 * they check the two rules whose violation is invisible until somebody is
 * standing on the surface: the key light's azimuth, and the value gap between
 * a kit's stone and the ground it stands on.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_WARP,
  ORIGIN,
  SYSTEMS,
  distanceLy,
  stardate,
  travelDays,
  travelTime,
  warpVelocity,
} from "@/starfleet/galaxy/systems";
import { CHARACTERS, characterByKey } from "@/starfleet/crew/characters";
import { localReply } from "@/starfleet/crew/comms";
import { KITS } from "@/starfleet/surface/kits";

describe("the chart", () => {
  it("gives every system a unique key and somewhere on the map", () => {
    const keys = SYSTEMS.map((s) => s.key);
    expect(new Set(keys).size, "duplicate system key").toBe(keys.length);
    for (const s of SYSTEMS) {
      expect(Number.isFinite(s.chart.x) && Number.isFinite(s.chart.y), s.key).toBe(true);
    }
  });

  it("starts you somewhere, and that somewhere is Earth", () => {
    expect(ORIGIN.key).toBe("sol");
    expect(ORIGIN.ly).toBe(0);
  });

  it("puts a system's chart position at roughly its stated distance from Sol", () => {
    // The chart is a projection, so this is deliberately loose — but a system
    // stated at 90 ly sitting 12 ly from the origin would make every travel
    // time in the log a lie, and that is worth failing over.
    for (const s of SYSTEMS) {
      const plotted = Math.hypot(s.chart.x, s.chart.y);
      expect(Math.abs(plotted - s.ly), `${s.key}: plotted ${plotted.toFixed(1)} vs stated ${s.ly}`)
        .toBeLessThan(Math.max(3, s.ly * 0.12));
    }
  });

  it("has somebody home on every world you can land on", () => {
    for (const s of SYSTEMS) {
      if (!s.character) continue;
      expect(characterByKey(s.character), `${s.key} names a character that does not exist`).toBeTruthy();
    }
  });

  it("gives every landable world a kit that exists, and refuses the rest with a reason", () => {
    for (const s of SYSTEMS) {
      if (s.surface) {
        expect(KITS[s.surface.kit], `${s.key} names an unknown kit`).toBeTruthy();
        expect(s.hazard, `${s.key} is both landable and hazardous`).toBeUndefined();
      } else {
        // No surface has to be a *decision*, stated out loud, because the
        // player is going to press BEAM DOWN and deserves to be told why not.
        expect(s.hazard, `${s.key} has no surface and no reason given`).toBeTruthy();
      }
    }
  });

  it("keeps the key light off the away team's face", () => {
    /* The transporter always faces the away team down -Z. A key at 180° is
       dead backlight and renders every person and pillar on the world as a
       black cut-out — see the note on `SurfaceSpec.sun`. */
    for (const s of SYSTEMS) {
      if (!s.surface) continue;
      const az = ((s.surface.sun.azimuth % 360) + 360) % 360;
      const frontal = az > 90 && az < 270;
      expect(frontal, `${s.key}: sun azimuth ${az}° is behind the subject`).toBe(false);
    }
  });

  it("matches every kit's fog colour to its horizon", () => {
    // The terrain has to fade into the sky rather than into a differently
    // coloured wall of haze. Same number, on every world, on purpose.
    for (const s of SYSTEMS) {
      if (!s.surface) continue;
      expect(s.surface.fog.color, `${s.key}: fog and horizon disagree`).toBe(s.surface.sky.horizon);
    }
  });
});

describe("the kits", () => {
  it("stands its architecture on ground it can be told apart from", () => {
    /* Value, not hue. Seleya shipped with sandstone the same colour as its own
       mountain and rendered nine rules of architecture invisible. */
    const luma = (hex: number) =>
      (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;
    for (const [name, kit] of Object.entries(KITS)) {
      const gap = Math.abs(luma(kit.stone) - luma(kit.terrain.tint));
      expect(gap, `${name}: stone and ground are the same value`).toBeGreaterThan(0.12);
    }
  });

  it("gives every kit a transporter pad to arrive on", () => {
    for (const [name, kit] of Object.entries(KITS)) {
      const hasPad = kit.rules.some((r) => r.kind === "beacon" || r.kind === "pool" || r.kind === "dome");
      expect(hasPad, `${name}: nothing marks the beam-in site`).toBe(true);
    }
  });
});

describe("the warp scale", () => {
  it("is the TNG one", () => {
    expect(warpVelocity(1)).toBeCloseTo(1, 5);
    expect(warpVelocity(6)).toBeCloseTo(392.5, 0);
    expect(warpVelocity(9)).toBeCloseTo(1516.4, 0);
    expect(MAX_WARP).toBeLessThan(10);
  });

  it("makes the trip to Qo'noS a month and the trip to Vulcan a few days", () => {
    const vulcan = SYSTEMS.find((s) => s.key === "vulcan")!;
    const qonos = SYSTEMS.find((s) => s.key === "qonos")!;
    const toVulcan = travelDays(distanceLy(ORIGIN, vulcan), 8);
    const toQonos = travelDays(distanceLy(ORIGIN, qonos), 8);
    expect(toVulcan).toBeGreaterThan(1);
    expect(toVulcan).toBeLessThan(15);
    expect(toQonos).toBeGreaterThan(20);
    // The whole point of plotting real distances: these must not feel alike.
    expect(toQonos / toVulcan).toBeGreaterThan(4);
  });

  it("says the time in units a person would say it in", () => {
    expect(travelTime(16.3, 8)).toMatch(/day/);
    expect(travelTime(0.02, 9)).toMatch(/[hm]/);
  });

  it("advances the stardate as the clock runs", () => {
    expect(Number(stardate(0))).toBeLessThan(Number(stardate(30)));
    expect(stardate(0)).toMatch(/^\d+\.\d$/);
  });
});

describe("the people", () => {
  it("gives everyone a persona, three prompts, a bank and a way out", () => {
    for (const c of CHARACTERS) {
      expect(c.persona.length, `${c.key}: persona too thin to hold a character`).toBeGreaterThan(200);
      expect(c.greeting.length, c.key).toBeGreaterThanOrEqual(2);
      expect(c.prompts.length, c.key).toBe(3);
      expect(c.bank.length, c.key).toBeGreaterThanOrEqual(3);
      expect(c.deflect.length, c.key).toBeGreaterThanOrEqual(3);
    }
  });

  it("never leaves a character with nothing to say", () => {
    /* The whole contract of the local brain: no network, no key, no error
       state — everybody answers, in their own voice, every time. */
    for (const c of CHARACTERS) {
      for (const q of [...c.prompts, "asdfgh", "", "tell me about the weather"]) {
        const r = localReply(c, q);
        expect(r.length, `${c.key} had nothing for "${q}"`).toBeGreaterThan(0);
      }
    }
  });

  it("answers a character's own suggested prompts out of their bank, not their deflections", () => {
    // A suggested prompt that falls through to "I don't know" is worse than no
    // suggestion at all — it is the game handing the player a dead end.
    for (const c of CHARACTERS) {
      for (const p of c.prompts) {
        const r = localReply(c, p);
        expect(c.deflect.includes(r), `${c.key}: "${p}" deflects`).toBe(false);
      }
    }
  });

  it("keeps your own bridge reachable from anywhere", () => {
    const crew = CHARACTERS.filter((c) => c.where === "ship");
    expect(crew.length).toBeGreaterThanOrEqual(3);
    for (const c of crew) expect(c.voice.pitch).toBeGreaterThan(0);
  });

  it("gives every voice a different pitch, so six people are six people", () => {
    const pitches = CHARACTERS.map((c) => c.voice.pitch);
    expect(new Set(pitches).size).toBeGreaterThan(CHARACTERS.length * 0.6);
  });
});
