/**
 * The aeroplane, as a spec sheet.
 *
 * A Boeing 707-320B, because that is what Trans American 209 is in the film —
 * the exterior shots are a 707 even though the cabin set was a 747, and the
 * flight deck you sit in here is a 707's.
 *
 * Everything in this file is a real number or derived from one. That matters
 * for exactly one reason: the numbers are what make the aeroplane behave like
 * an airliner rather than like a large fighter. An airliner is *slow to
 * respond and hard to stop* — a 90-tonne wing has enormous inertia in roll,
 * the engines take eight seconds to spool, and the drag at approach speed is
 * so low that pulling the thrust levers back does almost nothing for half a
 * mile. Every one of those is a consequence of numbers below, not of a
 * handling constant someone typed.
 */

/** Wing, tail and mass properties. */
export const AIRFRAME = {
  name: "Boeing 707-320B",
  operator: "Trans American",
  flightNumber: "209",

  /** Wing area, m². */
  wingArea: 283.4,
  /** Span, m. */
  span: 44.42,
  /** Mean aerodynamic chord, m. */
  chord: 7.0,
  /** Overall length, m. */
  length: 46.61,
  /** Aspect ratio, derived — never typed. */
  get aspectRatio(): number {
    return (this.span * this.span) / this.wingArea;
  },
  /** Oswald efficiency. A swept wing of this era, with engine pylons on it. */
  oswald: 0.78,

  /** Operating empty + payload + the fish, kg. This is the landing weight. */
  massEmpty: 84000,
  /** Fuel aboard at the start of the game, kg. LAX–ORD with reserves. */
  fuelStart: 9000,
  /** Fuel burn at full thrust, kg/s, all four. */
  fuelBurn: 1.45,

  /**
   * Moments of inertia, kg·m². These are the reason a 707 rolls like a 707.
   *
   * Roll inertia is the small one because the mass is in the fuselage; yaw is
   * the large one because the engines are hung out on the wing. The ratio
   * Izz/Ixx ≈ 3 is what gives a swept-wing jet its slow, wallowing Dutch roll,
   * and it falls straight out of these three numbers without anyone modelling
   * a Dutch roll at all.
   */
  ixx: 1.32e7,
  iyy: 3.05e7,
  izz: 4.15e7,

  /** Four JT3D-3B turbofans. Static sea-level thrust, N, each. */
  thrustPerEngine: 80100,
  /** Engine spool time constant, seconds. Long, and it is the point. */
  spoolUp: 4.2,
  spoolDown: 2.6,

  /** Limits. */
  vmo: 189,        // m/s IAS — 367 kt, the barber pole
  mmo: 0.9,
  gLimit: 2.5,
  gLimitNeg: -1.0,
  /** Gear and flap extension limits, m/s IAS. */
  vlo: 143,        // 278 kt
  vfe: [189, 118, 108, 103, 92, 87], // per flap detent

  /** Undercarriage. */
  gearTravel: 10.0,          // seconds up or down
  wheelHeight: 3.9,          // main gear contact below the cockpit datum, m
  gearTrack: 6.73,
  gearBase: 17.98,
  /** Oleo spring and damping, per main leg. */
  oleoK: 1.9e6,
  oleoC: 2.6e5,
  brakeForce: 3.1e5,         // N with full brakes on a dry runway
  rollingFriction: 0.018,
} as const;

/**
 * Aerodynamic coefficients.
 *
 * Calibrated against three numbers a 707 pilot would know: clean stall at
 * about 129 kt at 93 tonnes, Vref about 128 kt with full flap at the same
 * weight, and a clean L/D around 17. Everything else follows.
 */
export const AERO = {
  /** Lift-curve slope, per radian. Reduced from the 2D value by sweep. */
  clAlpha: 4.6,
  /** Lift at zero angle of attack, clean — the wing is set at an incidence. */
  cl0: 0.15,
  /** Maximum lift coefficient, clean. */
  clMaxClean: 1.15,
  /** Extra CLmax per flap detent, indexed like `FLAP_DETENTS`. */
  clMaxFlap: [0, 0.30, 0.50, 0.62, 0.78, 0.90],
  /** Extra CL0 per flap detent — flaps camber the wing as well as extend it. */
  cl0Flap: [0, 0.20, 0.34, 0.42, 0.53, 0.61],
  /**
   * How far past the stall angle the wing keeps producing anything.
   *
   * A swept wing does not drop lift off a cliff; it sheds it from the tips
   * inboard over several degrees, pitching up as it goes. That last part is
   * what makes a jet transport stall dangerous and is modelled explicitly in
   * `pitchUpAtStall`.
   */
  stallWidth: 0.14,          // radians of alpha over which lift collapses
  pitchUpAtStall: 0.55,      // nose-up Cm added at full stall

  /** Parasite drag, clean, gear and flaps up. */
  cd0: 0.0205,
  /** Extra CD0 per flap detent. */
  cdFlap: [0, 0.012, 0.028, 0.040, 0.068, 0.092],
  /** Extra CD0 with the gear down and locked. */
  cdGear: 0.021,
  /** Extra CD0 with the speedbrake fully out. */
  cdSpeedbrake: 0.055,
  /** Extra CD once the wing is stalled. */
  cdStall: 0.32,
  /** Compressibility drag rise. Starts biting at the drag-divergence Mach. */
  machDrag: 0.78,

  /** Side force from sideslip, per radian. The fin and the fuselage. */
  cyBeta: -0.72,

  // --- moments, all per radian or per unit control deflection -------------
  /** Longitudinal static stability. Negative = stable. */
  cmAlpha: -0.85,
  /** Pitch damping from the tailplane. */
  cmQ: -22.0,
  /** Elevator power at full yoke. Positive: aft yoke pitches the nose up. */
  cmElevator: 1.35,
  /** Nose-down moment from full flap — the pitch change nobody expects. */
  cmFlap: -0.055,
  /** Stabiliser trim authority, per unit of trim. Positive is nose up. */
  cmTrim: 1.9,

  /**
   * Roll from aileron at full wheel.
   *
   * Set by the helix angle it implies rather than picked: `clAileron/|clP|` is
   * the steady-state `pb/2V`, and 0.085 is where a swept-wing transport lives.
   * A fighter is nearer 0.09 with a tenth of the roll inertia, which is why
   * this number looks similar and the aeroplane feels nothing like one.
   */
  clAileron: 0.040,
  /** Roll damping. This is what stops a roll input becoming a barrel roll. */
  clP: -0.47,
  /** Dihedral effect — sideslip rolls you away from it. Negative = stable. */
  clBeta: -0.13,
  /** Roll from yaw rate. */
  clR: 0.09,

  /** Rudder power at full pedal. Positive: right pedal yaws the nose right. */
  cnRudder: 0.098,
  /** Weathercock stability — the fin. Positive = stable. */
  cnBeta: 0.145,
  /** Yaw damping. */
  cnR: -0.20,
  /** Adverse yaw from aileron. Why the rudder exists. */
  cnAileron: -0.012,
} as const;

/**
 * A crew that is no longer flying the aeroplane.
 *
 * Kept here because the flight model reads `AIRFRAME` and this is the only
 * other thing about the aircraft that is fixed at boot.
 */
export const FLIGHT = {
  callsign: "Trans American two-oh-nine",
  shortCallsign: "two-oh-nine",
  from: "Los Angeles",
  to: "Chicago",
  souls: 187,
} as const;
