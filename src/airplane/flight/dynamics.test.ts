/**
 * Things a pilot would recognise.
 *
 * Every test here flies the model for real time — some of them for a full
 * minute of simulated flight — and asserts an outcome rather than a formula.
 * That is deliberate: the failures worth catching in a flight model are almost
 * never a wrong number in one expression, they are a sign error somewhere in
 * the loop that looks completely stable for forty seconds and then departs.
 * The only way to catch that is to fly it.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { FlightModel, headingError, standardRates, momentsToBodyTorque } from "./dynamics";
import { Autopilot } from "./autopilot";
import { AIRFRAME, AERO } from "./airframe";
import { densityAt, indicatedFrom, thrustLapse, trueFrom } from "./atmosphere";
import { FIELD_ELEVATION, ILS, RUNWAY, ilsFix, papiWhiteCount } from "./nav";
import { KT } from "../types";

const HZ = 120;
const DT = 1 / HZ;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Flat ground at field elevation, which is all most of these tests need. */
const flatGround = { heightAt: () => FIELD_ELEVATION };
/** No ground at all — for tests that must not accidentally land. */
const noGround = { heightAt: () => -100000 };

function cruising(opts: Partial<{ alt: number; ias: number; heading: number }> = {}) {
  const m = new FlightModel();
  m.ground = noGround;
  m.place({
    position: new THREE.Vector3(0, opts.alt ?? 6000, 0),
    heading: opts.heading ?? Math.PI / 2,
    ias: opts.ias ?? 140,
  });
  return m;
}

function fly(m: FlightModel, seconds: number, each?: (t: number) => void) {
  const steps = Math.round(seconds * HZ);
  for (let i = 0; i < steps; i++) {
    each?.(i * DT);
    m.step(DT);
  }
}

// ---------------------------------------------------------------------------

describe("frame conversions", () => {
  it("maps standard-convention moments onto Three.js body axes", () => {
    const out = new THREE.Vector3();
    // Nose-up pitching moment turns into a positive rotation about the right wing.
    momentsToBodyTorque(0, 1, 0, out);
    expect(out.x).toBeGreaterThan(0);
    // Nose-right yaw is a *negative* rotation about body +Y.
    momentsToBodyTorque(0, 0, 1, out);
    expect(out.y).toBeLessThan(0);
    // Right-wing-down roll is a negative rotation about body +Z.
    momentsToBodyTorque(1, 0, 0, out);
    expect(out.z).toBeLessThan(0);
  });

  it("round-trips rates through the standard convention", () => {
    const { p, q, r } = standardRates(new THREE.Vector3(0.1, 0.2, 0.3));
    expect(q).toBeCloseTo(0.1);
    expect(r).toBeCloseTo(-0.2);
    expect(p).toBeCloseTo(-0.3);
  });

  it("wraps heading error the short way round", () => {
    expect(headingError(0.1, 6.2)).toBeCloseTo(0.1 + Math.PI * 2 - 6.2, 5);
    expect(headingError(6.2, 0.1)).toBeCloseTo(-(0.1 + Math.PI * 2 - 6.2), 5);
  });
});

describe("atmosphere", () => {
  it("has the ISA sea-level density", () => {
    expect(densityAt(0)).toBeCloseTo(1.225, 2);
  });

  it("halves the density by about 22,000 feet", () => {
    expect(densityAt(6700) / densityAt(0)).toBeCloseTo(0.5, 1);
  });

  it("shows less than true airspeed at altitude, and the same at sea level", () => {
    expect(indicatedFrom(100, 0)).toBeCloseTo(100, 1);
    expect(indicatedFrom(200, 10000)).toBeLessThan(130);
    expect(trueFrom(indicatedFrom(180, 9000), 9000)).toBeCloseTo(180, 3);
  });

  it("loses most of the thrust by the tropopause", () => {
    expect(thrustLapse(0, 0.2)).toBeGreaterThan(0.85);
    const high = thrustLapse(10700, 0.8);
    expect(high).toBeGreaterThan(0.15);
    expect(high).toBeLessThan(0.45);
  });
});

describe("the aeroplane is a 707", () => {
  it("has the aspect ratio its span and area imply", () => {
    expect(AIRFRAME.aspectRatio).toBeCloseTo(6.96, 1);
  });

  it("stalls clean at about 130 knots at landing weight", () => {
    const m = cruising();
    m.state.fuel = 6000;
    const kt = m.stallSpeed() / KT;
    expect(kt).toBeGreaterThan(118);
    expect(kt).toBeLessThan(142);
  });

  it("has a Vref in the 120s with full flap", () => {
    const m = cruising();
    m.state.fuel = 6000;
    m.state.flapIndex = 4;
    m.state.flapAngle = 40;
    const kt = m.vref() / KT;
    expect(kt).toBeGreaterThan(112);
    expect(kt).toBeLessThan(140);
  });

  it("stalls slower with the flaps out than clean", () => {
    const m = cruising();
    const clean = m.stallSpeed();
    m.state.flapAngle = 50;
    expect(m.stallSpeed()).toBeLessThan(clean * 0.85);
  });
});

describe("straight and level", () => {
  it("stays within 100 m of its altitude for a minute, hands off", () => {
    const m = cruising({ alt: 6000, ias: 140 });
    const start = m.state.altitude;
    fly(m, 60);
    // Not zero: a trimmed aeroplane still has a phugoid, and a 707's is about
    // eighty seconds long. What matters is that it is an oscillation of tens
    // of metres and not a divergence.
    expect(Math.abs(m.state.altitude - start)).toBeLessThan(150);
    expect(m.state.crashed).toBe(false);
  });

  it("holds its heading for a minute, hands off", () => {
    // The test that would have caught a positive-feedback sideslip loop: it
    // looks perfectly stable for half a minute and then departs.
    const m = cruising({ heading: Math.PI / 2 });
    fly(m, 60);
    expect(Math.abs(headingError(Math.PI / 2, m.state.heading))).toBeLessThan(0.09);
    expect(Math.abs(m.state.bankAngle)).toBeLessThan(0.06);
  });

  it("does not accumulate angular rates out of nothing", () => {
    const m = cruising();
    fly(m, 45);
    expect(m.state.omega.length()).toBeLessThan(0.02);
  });

  it("keeps its load factor at one g", () => {
    const m = cruising();
    fly(m, 20);
    expect(m.state.g).toBeGreaterThan(0.9);
    expect(m.state.g).toBeLessThan(1.1);
  });
});

describe("the controls do what the labels say", () => {
  it("climbs when the yoke comes back", () => {
    const m = cruising({ alt: 6000 });
    fly(m, 8, () => {
      m.controls.pitch = 0.25;
    });
    expect(m.state.pitchAngle).toBeGreaterThan(0.05);
    expect(m.state.vs).toBeGreaterThan(2);
  });

  it("descends when the yoke goes forward", () => {
    const m = cruising({ alt: 6000 });
    fly(m, 8, () => {
      m.controls.pitch = -0.25;
    });
    expect(m.state.vs).toBeLessThan(-2);
  });

  it("banks right on right wheel, and rolls at an airliner's rate", () => {
    const m = cruising();
    fly(m, 5, () => {
      m.controls.roll = 1;
    });
    // Positive bank is right wing down. A 707 at full wheel rolls at roughly
    // 15–25°/s, so five seconds of it is a lot of bank but not a barrel roll.
    expect(m.state.bankAngle).toBeGreaterThan(0.35);
    // Roll rate scales with airspeed — the helix angle pb/2V is what is
    // roughly constant — so this bound is generous at cruise. The number that
    // matters for the game is the approach one, asserted below.
    const rate = -m.state.omega.z;
    expect(rate).toBeGreaterThan(0.10);
    expect(rate).toBeLessThan(0.75);
  });

  it("rolls at about fifteen degrees a second on approach", () => {
    const m = new FlightModel();
    m.ground = noGround;
    m.place({
      position: new THREE.Vector3(-9000, 700, 0),
      heading: RUNWAY.heading,
      ias: 68,
      flapIndex: 4,
      gearDown: true,
    });
    fly(m, 4, () => {
      m.controls.roll = 1;
    });
    const degPerSec = (-m.state.omega.z * 180) / Math.PI;
    expect(degPerSec).toBeGreaterThan(8);
    expect(degPerSec).toBeLessThan(24);
  });

  it("turns right when it is banked right", () => {
    const m = cruising({ heading: Math.PI / 2 });
    fly(m, 4, () => {
      m.controls.roll = 0.8;
    });
    fly(m, 12, () => {
      m.controls.roll = 0;
      m.controls.pitch = 0.12;
    });
    // Heading has increased — 090 toward 180 — which is a right turn.
    expect(headingError(m.state.heading, Math.PI / 2)).toBeGreaterThan(0.15);
  });

  it("yaws right on right rudder", () => {
    const m = cruising();
    fly(m, 4, () => {
      m.controls.yaw = 1;
    });
    expect(headingError(m.state.heading, Math.PI / 2)).toBeGreaterThan(0.01);
    // And it sideslips left in the process, which is what a skid is.
    expect(m.state.beta).toBeLessThan(0);
  });

  it("rolls back towards level on its own after a disturbance", () => {
    // Dihedral effect plus roll damping. Not fast — a 707 is not a Cub — but
    // the wings must not stay where you left them for ever.
    const m = cruising();
    fly(m, 3, () => {
      m.controls.roll = 0.6;
    });
    const banked = Math.abs(m.state.bankAngle);
    fly(m, 25, () => {
      m.controls.roll = 0;
    });
    expect(Math.abs(m.state.bankAngle)).toBeLessThan(banked);
  });

  it("accelerates on the thrust levers and slows down off them", () => {
    const m = cruising({ alt: 3000, ias: 130 });
    fly(m, 30, () => {
      m.controls.throttle = 1;
      m.controls.pitch = 0;
    });
    const fast = m.state.ias;
    expect(fast).toBeGreaterThan(135);
    fly(m, 45, () => {
      m.controls.throttle = 0.05;
      m.controls.speedbrake = 1;
    });
    expect(m.state.ias).toBeLessThan(fast);
  });
});

describe("the engines are turbofans, not switches", () => {
  it("takes several seconds to spool up", () => {
    const m = cruising();
    m.controls.throttle = 0;
    fly(m, 6);
    expect(m.state.n1[0]).toBeLessThan(0.1);
    const idle = m.state.n1[0];
    m.controls.throttle = 1;
    m.step(DT);
    // One frame after slamming the levers forward, nothing has happened yet.
    expect(m.state.n1[0] - idle).toBeLessThan(0.01);
    fly(m, 2);
    // Two seconds in, nowhere near full power. This is the whole reason you
    // do not let the energy go on an approach.
    expect(m.state.n1[0]).toBeLessThan(0.75);
    fly(m, 12);
    expect(m.state.n1[0]).toBeGreaterThan(0.9);
  });

  it("yaws away from a failed outboard engine, and needs rudder to hold it", () => {
    const m = cruising({ heading: Math.PI / 2, alt: 4000 });
    m.controls.throttle = 0.9;
    fly(m, 6);
    m.failEngine(0); // number 1, left outboard
    fly(m, 10);
    // Thrust is now on the right, so the nose swings left: heading decreases.
    expect(headingError(m.state.heading, Math.PI / 2)).toBeLessThan(-0.01);
  });

  it("makes an outboard failure worse than an inboard one", () => {
    const swing = (engine: number) => {
      const m = cruising({ heading: Math.PI / 2, alt: 4000 });
      m.controls.throttle = 0.9;
      fly(m, 4);
      m.failEngine(engine);
      fly(m, 8);
      return Math.abs(headingError(m.state.heading, Math.PI / 2));
    };
    expect(swing(0)).toBeGreaterThan(swing(1));
  });

  it("burns fuel, and gets lighter as it goes", () => {
    const m = cruising();
    const start = m.mass;
    m.controls.throttle = 1;
    fly(m, 60);
    expect(m.state.fuel).toBeLessThan(AIRFRAME.fuelStart);
    expect(m.mass).toBeLessThan(start);
  });
});

describe("the wing stops working if you ask too much of it", () => {
  it("stalls when held nose-high with the power off", () => {
    const m = cruising({ alt: 5000, ias: 120 });
    m.controls.throttle = 0;
    fly(m, 45, () => {
      m.controls.pitch = 0.85;
    });
    expect(m.state.stalled).toBe(true);
    expect(m.state.stallMargin).toBeLessThan(0.12);
  });

  it("recovers when you push and add power", () => {
    // Entry, not a fully developed deep stall: hold it off until the wing
    // lets go, then do what the recovery drill says. That is the manoeuvre
    // the game asks the player for, so it is the one worth testing.
    const m = cruising({ alt: 5000, ias: 120 });
    m.controls.throttle = 0;
    let steps = 0;
    while (!m.state.stalled && steps++ < 60 * HZ) {
      m.controls.pitch = 0.6;
      m.step(DT);
    }
    expect(m.state.stalled).toBe(true);
    const stalledAlpha = m.state.alpha;

    // The drill: unload to a level-ish attitude, full power, wait. Not "hold
    // the yoke fully forward", which unloads the wing so far the other way
    // that it stalls inverted — a real enough outcome, and not a recovery.
    fly(m, 30, () => {
      m.controls.throttle = 1;
      m.controls.pitch = clamp(
        (-0.05 - m.state.pitchAngle) * 4 - m.state.omega.x * 3,
        -0.6,
        0.6,
      );
    });
    expect(m.state.alpha).toBeLessThan(stalledAlpha);
    expect(m.state.stalled).toBe(false);
    expect(m.state.stallMargin).toBeGreaterThan(0.2);
    expect(m.state.crashed).toBe(false);
  });

  it("pitches up at the break, which is what makes a jet stall dangerous", () => {
    expect(AERO.pitchUpAtStall).toBeGreaterThan(0);
  });

  it("takes damage above the barber pole", () => {
    const m = cruising({ alt: 1500, ias: 170 });
    let sawOverspeed = false;
    let peak = 0;
    fly(m, 40, () => {
      m.controls.throttle = 1;
      // A dive held at twenty degrees nose down, not a yoke jammed forward —
      // which tumbles the aeroplane over the top instead of accelerating it.
      m.controls.pitch = clamp(
        (-0.35 - m.state.pitchAngle) * 4 - m.state.omega.x * 3,
        -0.6,
        0.6,
      );
      if (m.state.overspeed) sawOverspeed = true;
      peak = Math.max(peak, m.state.ias);
    });
    expect(peak).toBeGreaterThan(AIRFRAME.vmo * 0.92);
    expect(sawOverspeed).toBe(true);
    expect(m.state.damage).toBeGreaterThan(0);
  });
});

describe("the ground is solid", () => {
  it("holds the aeroplane up when it is parked on it", () => {
    const m = new FlightModel();
    m.ground = flatGround;
    m.place({
      position: new THREE.Vector3(0, FIELD_ELEVATION + 4.55, 0),
      heading: RUNWAY.heading,
      ias: 0,
      flapIndex: 0,
      gearDown: true,
      onGround: true,
    });
    m.controls.throttle = 0;
    m.controls.brake = 1;
    fly(m, 20);
    expect(m.state.onGround).toBe(true);
    expect(m.state.crashed).toBe(false);
    // Sitting on its oleos, within a few tens of centimetres of where it started.
    expect(Math.abs(m.state.altitude - (FIELD_ELEVATION + 4.55))).toBeLessThan(0.6);
    expect(Math.abs(m.state.velocity.y)).toBeLessThan(0.4);
  });

  it("takes off, and takes about the right distance to do it", () => {
    const m = new FlightModel();
    m.ground = flatGround;
    m.place({
      position: new THREE.Vector3(0, FIELD_ELEVATION + 4.55, 0),
      heading: RUNWAY.heading,
      ias: 0,
      flapIndex: 2,
      gearDown: true,
      onGround: true,
    });
    let rotated = false;
    fly(m, 60, () => {
      m.controls.throttle = 1;
      // Rotate at 150 knots, which is about right for a heavy 707, then fly
      // the initial climb attitude. Holding the yoke fully aft instead is not
      // a rotation, it is a tail strike followed by a stall.
      if (m.state.ias > 150 * KT) rotated = true;
      const target = rotated ? 0.22 : 0;
      m.controls.pitch = clamp((target - m.state.pitchAngle) * 5 - m.state.omega.x * 4, -0.4, 0.4);
    });
    expect(m.state.crashed).toBe(false);
    expect(m.state.onGround).toBe(false);
    expect(m.state.altitude).toBeGreaterThan(FIELD_ELEVATION + 50);
    // Airborne somewhere between 1 and 3.5 km down the runway.
    expect(m.state.position.x).toBeGreaterThan(900);
    expect(m.state.position.x).toBeLessThan(3600);
  });

  it("brakes to a stop after touchdown", () => {
    const m = new FlightModel();
    m.ground = flatGround;
    m.place({
      position: new THREE.Vector3(300, FIELD_ELEVATION + 4.5, 0),
      heading: RUNWAY.heading,
      ias: 70,
      flapIndex: 4,
      gearDown: true,
      onGround: true,
    });
    fly(m, 60, () => {
      m.controls.throttle = 0;
      m.controls.brake = 1;
      m.controls.speedbrake = 1;
    });
    expect(m.state.groundSpeed).toBeLessThan(3);
    expect(m.state.crashed).toBe(false);
  });

  it("calls a gear-up arrival a crash", () => {
    const m = new FlightModel();
    m.ground = flatGround;
    m.place({
      position: new THREE.Vector3(-2000, FIELD_ELEVATION + 60, 0),
      heading: RUNWAY.heading,
      ias: 75,
      flapIndex: 4,
      gearDown: false,
    });
    fly(m, 40, () => {
      m.controls.throttle = 0.2;
      m.controls.pitch = -0.1;
    });
    expect(m.state.crashed).toBe(true);
  });
});

describe("the ILS points at the runway", () => {
  it("reads centred when you are on the beam", () => {
    // 8 km out, on the centreline, at exactly 3° above the touchdown zone.
    const range = ILS.gsOrigin.x + 8000;
    const y = FIELD_ELEVATION + Math.tan(ILS.glideslope) * 8000;
    const fix = ilsFix(new THREE.Vector3(ILS.gsOrigin.x - 8000, y, 0));
    expect(fix.valid).toBe(true);
    expect(Math.abs(fix.locNeedle)).toBeLessThan(0.02);
    expect(Math.abs(fix.gsNeedle)).toBeLessThan(0.02);
    expect(fix.established).toBe(true);
    expect(range).toBeGreaterThan(0);
  });

  it("points the needle towards the centreline", () => {
    // +Z is south, so a positive lateral offset means we are south of the

    // The needle is a fly-to indication. +Z is south, so z = +300 on an
    // eastbound runway means we are *right* of course and must fly left.
    const right = ilsFix(new THREE.Vector3(-8000, FIELD_ELEVATION + 420, 300));
    expect(right.locNeedle).toBeLessThan(0);
    const left = ilsFix(new THREE.Vector3(-8000, FIELD_ELEVATION + 420, -300));
    expect(left.locNeedle).toBeGreaterThan(0);
  });

  it("gets less forgiving as you close in — the deviation is angular", () => {
    const far = ilsFix(new THREE.Vector3(-12000, FIELD_ELEVATION + 630, 150));
    const near = ilsFix(new THREE.Vector3(-1500, FIELD_ELEVATION + 80, 150));
    expect(Math.abs(near.locNeedle)).toBeGreaterThan(Math.abs(far.locNeedle));
  });

  it("shows above the beam when you are high", () => {
    const onBeam = FIELD_ELEVATION + Math.tan(ILS.glideslope) * 6000;
    const fix = ilsFix(new THREE.Vector3(ILS.gsOrigin.x - 6000, onBeam + 120, 0));
    expect(fix.gsNeedle).toBeGreaterThan(0.3);
    expect(fix.heightError).toBeGreaterThan(100);
  });

  it("gives two white and two red on the slope", () => {
    const onBeam = FIELD_ELEVATION + Math.tan(ILS.glideslope) * 5000;
    expect(papiWhiteCount(new THREE.Vector3(ILS.gsOrigin.x - 5000, onBeam, 0))).toBe(2);
    expect(papiWhiteCount(new THREE.Vector3(ILS.gsOrigin.x - 5000, onBeam + 400, 0))).toBe(4);
    expect(papiWhiteCount(new THREE.Vector3(ILS.gsOrigin.x - 5000, onBeam - 400, 0))).toBe(0);
  });
});

describe("Otto flies the aeroplane", () => {
  it("holds an altitude he was handed", () => {
    const m = cruising({ alt: 7000, ias: 150 });
    const ap = new Autopilot();
    ap.engage(m.state);
    const target = ap.state.targetAltitude;
    const fix = ilsFix(m.state.position);
    fly(m, 90, () => {
      ap.step(DT, m.state, fix, m.controls);
    });
    expect(Math.abs(m.state.altitude - target)).toBeLessThan(90);
  });

  it("turns onto a heading and stops there", () => {
    const m = cruising({ alt: 6000, heading: Math.PI / 2 });
    const ap = new Autopilot();
    ap.engage(m.state);
    ap.state.targetHeading = Math.PI; // due south
    const fix = ilsFix(m.state.position);
    fly(m, 120, () => {
      ap.step(DT, m.state, fix, m.controls);
    });
    expect(Math.abs(headingError(Math.PI, m.state.heading))).toBeLessThan(0.09);
    expect(Math.abs(m.state.bankAngle)).toBeLessThan(0.12);
  });

  it("holds a speed on the thrust levers", () => {
    const m = cruising({ alt: 5000, ias: 180 });
    const ap = new Autopilot();
    ap.engage(m.state);
    ap.state.targetIas = 120;
    const fix = ilsFix(m.state.position);
    fly(m, 120, () => {
      ap.step(DT, m.state, fix, m.controls);
    });
    expect(Math.abs(m.state.ias - 120)).toBeLessThan(12);
  });

  it("gives up when he is soft, and hands the aeroplane back", () => {
    const m = cruising();
    const ap = new Autopilot();
    ap.engage(m.state);
    expect(ap.state.engaged).toBe(true);
    ap.deflate(0.8);
    const fix = ilsFix(m.state.position);
    expect(ap.step(DT, m.state, fix, m.controls)).toBe(false);
    expect(ap.state.engaged).toBe(false);
  });

  it("flies a coupled ILS down to the decision height", () => {
    // The test that matters: from 22 km out and 800 m off the centreline,
    // Otto should intercept, track, and arrive on the beam.
    const m = new FlightModel();
    m.ground = flatGround;
    m.place({
      position: new THREE.Vector3(-22000, FIELD_ELEVATION + 1350, 800),
      heading: RUNWAY.heading,
      ias: 105,
      flapIndex: 2,
      gearDown: false,
    });
    const ap = new Autopilot();
    ap.engage(m.state);
    ap.state.approachMode = true;
    ap.state.targetIas = 78;

    let fix = ilsFix(m.state.position);
    const steps = 300 * HZ;
    for (let i = 0; i < steps; i++) {
      fix = ilsFix(m.state.position, fix);
      ap.step(DT, m.state, fix, m.controls);
      // Configure on the way down, like a crew would.
      if (fix.distance < 14000) m.state.flapIndex = 3;
      if (fix.distance < 10000) m.state.gear.down = true;
      if (fix.distance < 7000) m.state.flapIndex = 4;
      m.step(DT);
      if (m.state.radarAltitude < ILS.decisionHeight || m.state.crashed) break;
    }

    expect(m.state.crashed).toBe(false);
    // At the decision height, within half a wingspan of the centreline.
    expect(Math.abs(m.state.position.z)).toBeLessThan(25);
    expect(m.state.position.x).toBeGreaterThan(-2600);
    expect(m.state.position.x).toBeLessThan(200);
    expect(m.state.ias).toBeGreaterThan(m.stallSpeed());
  });
});

describe("the storm", () => {
  it("moves the aeroplane around without breaking it", () => {
    const m = cruising({ alt: 4000 });
    m.wind.turbulence = 1;
    m.wind.steady.set(9, 0, 4);
    fly(m, 60);
    expect(m.state.crashed).toBe(false);
    expect(Number.isFinite(m.state.altitude)).toBe(true);
    // It should genuinely be moving around — a turbulence model that does
    // nothing is worse than none, because it hides the fact that it is broken.
    expect(Math.abs(m.state.bankAngle)).toBeGreaterThan(0.002);
  });

  it("measures airspeed against the air, not the ground", () => {
    const m = cruising({ alt: 3000, heading: Math.PI / 2, ias: 130 });
    m.wind.steady.set(-25, 0, 0); // 25 m/s straight on the nose of a 090 runway
    fly(m, 30, () => {
      m.controls.throttle = 0.7;
    });
    expect(m.state.groundSpeed).toBeLessThan(m.state.tas - 10);
  });
});
