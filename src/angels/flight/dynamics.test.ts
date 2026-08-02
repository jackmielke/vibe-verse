/**
 * The flight model is the one part of this world that is objectively right or
 * wrong, so it is the one part that gets tested. Everything here is a claim a
 * pilot would recognise: a trimmed jet does not wander off, pulling costs energy,
 * a wing that runs out of air stops working, and a heavy transport does not
 * out-turn a Skyhawk.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { aircraft } from "./aircraft";
import {
  assistsFor,
  createFlightState,
  neutralControls,
  stepFlight,
  trimLevel,
  type Controls,
  type FlightEnvironment,
} from "./dynamics";
import { GRAVITY, atmosphere, indicatedAirspeed } from "./atmosphere";

const FLAT: FlightEnvironment = {
  terrainHeight: () => 0,
  wind: (_p, out) => out.set(0, 0, 0),
};

const DT = 1 / 120;

function fly(
  jetId: Parameters<typeof aircraft>[0],
  seconds: number,
  controls: Partial<Controls> = {},
  opts: { altitude?: number; speed?: number; heading?: number; assist?: "rookie" | "angel" | "ace" } = {},
) {
  const spec = aircraft(jetId);
  const state = createFlightState(spec);
  const assists = assistsFor(opts.assist ?? "angel");
  trimLevel(
    state,
    spec,
    new THREE.Vector3(0, opts.altitude ?? 1500, 0),
    opts.heading ?? 0,
    opts.speed ?? 200,
  );
  const c: Controls = { ...neutralControls(), ...controls };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepFlight(state, spec, c, assists, FLAT, DT);
  return { state, spec };
}

describe("atmosphere", () => {
  it("thins out with altitude", () => {
    expect(atmosphere(0).density).toBeCloseTo(1.225, 2);
    expect(atmosphere(5000).density).toBeLessThan(0.75);
    expect(atmosphere(11000).density).toBeLessThan(0.4);
  });

  it("gets colder up to the tropopause and then stops", () => {
    expect(atmosphere(0).temperature).toBeCloseTo(288.15, 1);
    expect(atmosphere(11000).temperature).toBeCloseTo(216.65, 0);
    expect(atmosphere(15000).temperature).toBeCloseTo(216.65, 0);
  });

  it("reads indicated below true once the air is thin", () => {
    const air = atmosphere(10000);
    expect(indicatedAirspeed(250, air.sigma)).toBeLessThan(160);
  });
});

describe("trimmed flight", () => {
  // A load-factor command law holds *G*, not altitude: leave the throttle above
  // trim and the jet accelerates and drifts up, exactly as a real one does. The
  // claim under test is therefore "it does not diverge", not "it is an
  // autopilot" — a wandering hundred metres is flying, a thousand is a bug.
  it("stays in controlled flight for a minute without pilot input", () => {
    const { state } = fly("superhornet", 60, { throttle: 0.62 });
    expect(Math.abs(state.altitude - 1500)).toBeLessThan(400);
    expect(Math.abs(state.climb)).toBeLessThan(14);
    expect(Math.abs(state.bank)).toBeLessThan(0.12);
    expect(state.stalled).toBe(false);
  });

  it("keeps its heading when nothing asks it to turn", () => {
    const { state } = fly("superhornet", 30, { throttle: 0.62 }, { heading: Math.PI / 2 });
    const drift = Math.abs(state.heading - Math.PI / 2);
    expect(Math.min(drift, Math.PI * 2 - drift)).toBeLessThan(0.25);
  });
});

describe("energy", () => {
  it("trades speed for G in a sustained turn", () => {
    // Roll to about 75 degrees of bank, then hold it and pull. Levelling is off
    // so the bank stays where it is put — this is a turn, not a barrel roll.
    const spec = aircraft("superhornet");
    const state = createFlightState(spec);
    const assists = assistsFor("ace");
    trimLevel(state, spec, new THREE.Vector3(0, 3000, 0), 0, 260);
    const c: Controls = { ...neutralControls(), throttle: 0.7 };
    for (let i = 0; i < 120 * 0.65; i++) {
      c.roll = 1;
      stepFlight(state, spec, c, assists, FLAT, DT);
    }
    c.roll = 0;
    c.pitch = 1;
    for (let i = 0; i < 120 * 14; i++) stepFlight(state, spec, c, assists, FLAT, DT);

    const level = fly("superhornet", 14.65, { throttle: 0.7 }, { altitude: 3000, speed: 260 });

    // Compare specific energy, not speed. A hard turn can end pointed downhill
    // and be *faster* than where it started while having thrown away hundreds
    // of metres of altitude to buy it; height plus speed is the honest ledger.
    const energy = (s: { airspeed: number; altitude: number }) =>
      0.5 * s.airspeed * s.airspeed + GRAVITY * s.altitude;

    expect(Math.abs(state.bank)).toBeGreaterThan(0.9);
    expect(state.gLoad).toBeGreaterThan(3);
    expect(energy(state)).toBeLessThan(energy(level.state) * 0.9);
  });

  it("accelerates in afterburner and decelerates at idle", () => {
    const burner = fly("superhornet", 20, { throttle: 1 });
    const idle = fly("superhornet", 20, { throttle: 0 });
    expect(burner.state.airspeed).toBeGreaterThan(220);
    expect(idle.state.airspeed).toBeLessThan(190);
  });

  it("burns fuel faster in afterburner", () => {
    const burner = fly("superhornet", 30, { throttle: 1 });
    const cruise = fly("superhornet", 30, { throttle: 0.6 });
    expect(burner.state.fuel).toBeLessThan(cruise.state.fuel);
  });
});

describe("the wing has limits", () => {
  it("stalls when flown too slowly with the stick back", () => {
    const { state } = fly(
      "superhornet",
      25,
      { throttle: 0, pitch: 1 },
      { speed: 90, altitude: 3000, assist: "ace" },
    );
    expect(state.alpha).toBeGreaterThan(0.3);
    expect(state.climb).toBeLessThan(0);
  });

  it("refuses to stall under rookie envelope protection", () => {
    const { state } = fly(
      "superhornet",
      25,
      { throttle: 0.3, pitch: 1 },
      { speed: 110, altitude: 3000, assist: "rookie" },
    );
    expect(state.stalled).toBe(false);
  });

  it("cannot pull its structural limit at low speed", () => {
    const { state } = fly(
      "superhornet",
      2,
      { throttle: 0.5, pitch: 1 },
      { speed: 110, altitude: 2000, assist: "angel" },
    );
    expect(state.gLoad).toBeLessThan(4.5);
  });

  it("can pull hard when it is fast", () => {
    const { state } = fly(
      "superhornet",
      2,
      { throttle: 1, pitch: 1 },
      { speed: 300, altitude: 2000, assist: "angel" },
    );
    expect(state.gLoad).toBeGreaterThan(4);
  });
});

describe("the hangar flies differently", () => {
  it("rolls a Skyhawk faster than a Phantom", () => {
    const a4 = fly("skyhawk", 1.5, { roll: 1, throttle: 0.8 }, { speed: 200 });
    const f4 = fly("phantom", 1.5, { roll: 1, throttle: 0.8 }, { speed: 200 });
    expect(Math.abs(a4.state.rollRate)).toBeGreaterThan(Math.abs(f4.state.rollRate) * 1.5);
  });

  it("does not let Fat Albert pull fighter G", () => {
    const bert = fly("albert", 4, { pitch: 1, throttle: 1 }, { speed: 150 });
    expect(bert.state.gLoad).toBeLessThan(3.2);
  });

  it("gives the burner jets more top end than the ones without", () => {
    const hornet = fly("hornet", 45, { throttle: 1 }, { altitude: 6000, speed: 250 });
    const panther = fly("panther", 45, { throttle: 1 }, { altitude: 6000, speed: 250 });
    expect(hornet.state.mach).toBeGreaterThan(panther.state.mach);
  });
});

describe("ground", () => {
  it("settles onto the runway and stops with the brakes on", () => {
    const spec = aircraft("superhornet");
    const state = createFlightState(spec);
    const assists = assistsFor("angel");
    trimLevel(state, spec, new THREE.Vector3(0, 40, 0), 0, 70);
    const c: Controls = { ...neutralControls(), throttle: 0, gear: true, wheelBrake: 1 };
    for (let i = 0; i < 120 * 40; i++) stepFlight(state, spec, c, assists, FLAT, DT);
    expect(state.onGround).toBe(true);
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeLessThan(3);
  });

  it("does not fall through the terrain", () => {
    const env: FlightEnvironment = {
      terrainHeight: () => 300,
      wind: (_p, out) => out.set(0, 0, 0),
    };
    const spec = aircraft("hornet");
    const state = createFlightState(spec);
    trimLevel(state, spec, new THREE.Vector3(0, 320, 0), 0, 60);
    const c = { ...neutralControls(), throttle: 0 };
    for (let i = 0; i < 120 * 20; i++)
      stepFlight(state, spec, c, assistsFor("angel"), env, DT);
    expect(state.position.y).toBeGreaterThan(299);
  });
});

describe("writing one off", () => {
  /**
   * Arrive at the ground with exactly the sink, attitude and gear asked for.
   *
   * The jet is placed already touching and stepped once, rather than flown
   * down an approach. Flying it down is the wrong test twice over: the
   * fly-by-wire holds 1 G with the stick centred, so a commanded sink rate is
   * mostly gone by the time the wheels get there, and whether the jet arrives
   * at all inside the loop depends on the throttle setting. What is under test
   * here is the contact rule, and the contact rule reads the state it is given.
   */
  function arrive(opts: {
    sink: number;
    gear: boolean;
    bank?: number;
    speed?: number;
    water?: boolean;
  }) {
    const spec = aircraft("superhornet");
    const state = createFlightState(spec);
    const env: FlightEnvironment = {
      terrainHeight: () => 0,
      wind: (_p, out) => out.set(0, 0, 0),
      isWater: () => opts.water === true,
    };
    trimLevel(state, spec, new THREE.Vector3(0, 200, 0), 0, opts.speed ?? 80);
    state.gearPos = opts.gear ? 1 : 0;
    if (opts.bank) {
      state.orientation.setFromEuler(new THREE.Euler(0, 0, -opts.bank, "YXZ"));
    }
    // Just touching: gear height for the gear position set above.
    state.position.y = spec.height * 0.42 * Math.max(state.gearPos, 0.35) - 0.2;
    state.velocity.y = -opts.sink;
    state.onGround = false;

    const c: Controls = { ...neutralControls(), throttle: 0.2, gear: opts.gear };
    stepFlight(state, spec, c, assistsFor("angel"), env, DT);
    return { crashed: state.crashed, state };
  }

  it("a wheels-down arrival at two metres a second is a landing", () => {
    expect(arrive({ sink: 2, gear: true }).crashed).toBe(false);
  });

  it("a firm one at seven is still a landing, just a bad one", () => {
    // The band between "ouch" and "scrap" is the whole point: a heavy arrival
    // should rattle the airframe and the camera without ending the flight.
    expect(arrive({ sink: 7, gear: true }).crashed).toBe(false);
  });

  it("but arriving at fifteen metres a second is not", () => {
    expect(arrive({ sink: 15, gear: true }).crashed).toBe(true);
  });

  it("nor is a belly landing, however gentle", () => {
    expect(arrive({ sink: 1, gear: false }).crashed).toBe(true);
  });

  it("nor is one on a wingtip", () => {
    expect(arrive({ sink: 2, gear: true, bank: 1.0 }).crashed).toBe(true);
  });

  it("and nothing here floats", () => {
    expect(arrive({ sink: 2, gear: true, water: true }).crashed).toBe(true);
  });

  it("a jet parked below flying speed sits on its gear, not at the stall angle", () => {
    // A trim solution at zero knots wants infinite lift coefficient, and the
    // clamp used to hand back 85% of the stall angle — a Super Hornet on the
    // Boeing Field ramp pointing thirty degrees at the sky. Once arriving
    // nose-high became a crash, that spawned a fireball on the concrete.
    const spec = aircraft("superhornet");
    const state = createFlightState(spec);
    trimLevel(state, spec, new THREE.Vector3(0, 8, 0), 0, 0);
    expect(Math.abs(state.pitchAttitude)).toBeLessThan(0.1);

    const env: FlightEnvironment = {
      terrainHeight: () => 8 - spec.height * 0.42,
      wind: (_p, out) => out.set(0, 0, 0),
      isWater: () => false,
    };
    const c: Controls = { ...neutralControls(), throttle: 0, gear: true, wheelBrake: 1 };
    state.gearPos = 1;
    for (let i = 0; i < 120; i++) {
      stepFlight(state, spec, c, assistsFor("angel"), env, DT);
      expect(state.crashed).toBe(false);
    }
  });

  it("does not judge an arrival by the attitude of the previous flight", () => {
    // `pitchAttitude` is published at the bottom of stepFlight, so on the first
    // step after a respawn it still holds the last flight's numbers. Reusing a
    // state that ended in a dive must not condemn the jet that replaces it.
    const spec = aircraft("superhornet");
    const state = createFlightState(spec);
    state.pitchAttitude = -1.2;
    state.bank = 2.4;
    const env: FlightEnvironment = {
      terrainHeight: () => 0,
      wind: (_p, out) => out.set(0, 0, 0),
      isWater: () => false,
    };
    trimLevel(state, spec, new THREE.Vector3(0, spec.height * 0.42, 0), 0, 0);
    state.gearPos = 1;
    const c: Controls = { ...neutralControls(), throttle: 0, gear: true, wheelBrake: 1 };
    stepFlight(state, spec, c, assistsFor("angel"), env, DT);
    expect(state.crashed).toBe(false);
  });
});

describe("numbers stay finite", () => {
  it("survives ten minutes of violent random input", () => {
    const spec = aircraft("superhornet");
    const state = createFlightState(spec);
    const assists = assistsFor("ace");
    trimLevel(state, spec, new THREE.Vector3(0, 4000, 0), 1, 240);
    const c = neutralControls();
    let seed = 1234567;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 120 * 600; i++) {
      if (i % 24 === 0) {
        c.pitch = rnd() * 2 - 1;
        c.roll = rnd() * 2 - 1;
        c.yaw = rnd() * 2 - 1;
        c.throttle = rnd();
        c.brake = rnd() > 0.8 ? 1 : 0;
      }
      stepFlight(state, spec, c, assists, FLAT, DT);
    }
    expect(Number.isFinite(state.position.x)).toBe(true);
    expect(Number.isFinite(state.position.y)).toBe(true);
    expect(Number.isFinite(state.velocity.length())).toBe(true);
    expect(Number.isFinite(state.gLoad)).toBe(true);
    expect(Math.abs(state.orientation.length() - 1)).toBeLessThan(1e-3);
  });
});

describe("compass headings mean what they say", () => {
  // The bug this pins: `trimLevel` and the heading readback were both off by
  // pi, consistently, so every test that compared one against the other passed
  // while a jet trimmed on 160 flew due 340. Compare against the *world*.
  const CARDINALS: Array<[string, number, number, number]> = [
    // name, heading deg, expected +x (east), expected -z (north)
    ["north", 0, 0, 1],
    ["east", 90, 1, 0],
    ["south", 180, 0, -1],
    ["west", 270, -1, 0],
  ];

  for (const [name, deg, ex, en] of CARDINALS) {
    it(`flies ${name} when trimmed on ${deg}`, () => {
      const spec = aircraft("superhornet");
      const state = createFlightState(spec);
      trimLevel(state, spec, new THREE.Vector3(0, 2000, 0), (deg * Math.PI) / 180, 200);
      const start = state.position.clone();
      const c = { ...neutralControls(), throttle: 0.62 };
      for (let i = 0; i < 120 * 8; i++) stepFlight(state, spec, c, assistsFor("angel"), FLAT, DT);

      const moved = state.position.clone().sub(start);
      expect(moved.length()).toBeGreaterThan(800);
      moved.normalize();
      expect(moved.x).toBeCloseTo(ex, 1);
      expect(-moved.z).toBeCloseTo(en, 1);

      // And the instrument agrees with the ground track.
      const reported = (state.heading * 180) / Math.PI;
      const err = Math.abs(((reported - deg + 540) % 360) - 180);
      expect(err).toBeLessThan(4);
    });
  }
});
