/**
 * The hangar.
 *
 * Every jet the Blue Angels have ever flown a season in, plus Fat Albert,
 * described in the numbers the flight model actually integrates: mass, wing
 * area, thrust, and the handful of aerodynamic coefficients that decide whether
 * a machine feels like a scalpel or a freight train.
 *
 * The specs are real where real numbers exist. Where a source gives a range,
 * this file takes the demo-team end of it: the Angels fly light — no pylons, no
 * cannon, a smoke tank where the 20 mm gun lives — so the masses here are below
 * the fleet loaded weights you would find in a Jane's entry, deliberately.
 *
 * `feel` is the one honestly invented block. It is what turns a spec sheet into
 * a control law: how fast the fly-by-wire will let you roll, how many G the
 * stick commands at full deflection, how much the airframe resists you. Tuning
 * lives there so the physics above it can stay physics.
 */

export type JetId =
  | "superhornet"
  | "hornet"
  | "skyhawk"
  | "phantom"
  | "tiger"
  | "panther"
  | "albert";

export interface AircraftSpec {
  id: JetId;
  /** Type designation, as painted on the jet. */
  name: string;
  /** The years this airframe carried the team. */
  era: string;
  /** One line of flavour for the hangar screen. */
  blurb: string;
  /** Two or three words a pilot would use: "brutally fast", "a scalpel". */
  character: string;

  // ---- geometry (metres) --------------------------------------------------
  length: number;
  wingspan: number;
  height: number;
  /** Reference wing area, m^2. */
  wingArea: number;

  // ---- mass ---------------------------------------------------------------
  /** Demo-configuration mass with a show fuel load, kg. */
  mass: number;
  /** Moments of inertia about body roll/pitch/yaw axes, kg m^2. */
  inertia: { x: number; y: number; z: number };

  // ---- propulsion ---------------------------------------------------------
  /** Sea-level static military (dry) thrust, all engines, N. */
  thrustMil: number;
  /** Sea-level static afterburning thrust, all engines, N. 0 = no burner. */
  thrustAB: number;
  /** Seconds from idle to full military — spool lag you can feel. */
  spoolTime: number;

  // ---- aerodynamics -------------------------------------------------------
  /** Lift-curve slope, per radian, before stall. */
  clAlpha: number;
  /** Lift at zero angle of attack — wing incidence and camber. */
  cl0: number;
  /** Angle of attack where the wing gives up, radians. */
  stallAlpha: number;
  /** Peak lift coefficient at the stall break. */
  clMax: number;
  /** Zero-lift drag coefficient. */
  cd0: number;
  /** Induced drag factor: CDi = k * CL^2. */
  inducedK: number;
  /** Mach number where wave drag starts to bite. */
  machCrit: number;
  /** Multiplier on cd0 at the transonic peak. */
  waveDrag: number;
  /** Yaw stiffness — how hard the fin fights sideslip. */
  sideForce: number;

  // ---- envelope -----------------------------------------------------------
  /** Never-exceed Mach in level flight at altitude. */
  machMax: number;
  /** Structural G limits the airframe is stressed for. */
  gLimit: { positive: number; negative: number };
  /** Service ceiling, m — where the climb rate goes to nothing. */
  ceiling: number;

  // ---- control feel -------------------------------------------------------
  feel: {
    /** Maximum commanded roll rate at full lateral stick, rad/s. */
    rollRate: number;
    /** How briskly roll rate follows the stick (1/s). Higher = crisper. */
    rollAuthority: number;
    /** Maximum G the stick commands at full aft deflection. */
    pitchG: number;
    /** Pitch response bandwidth (1/s). */
    pitchAuthority: number;
    /** Maximum commanded yaw rate at full rudder, rad/s. */
    yawRate: number;
    yawAuthority: number;
    /** Aerodynamic rate damping about each body axis. */
    damping: { x: number; y: number; z: number };
  };

  // ---- presentation -------------------------------------------------------
  /** How many jets of this type the team flew in the diamond+solos. */
  teamSize: number;
  /** Silhouette hints the mesh builder reads. */
  shape: {
    /** "trapezoid" (Hornet), "delta" (Tiger), "swept" (Phantom), "straight" (Panther), "prop" (Albert). */
    planform: "trapezoid" | "delta" | "swept" | "straight" | "prop";
    /** Number of vertical tails. */
    fins: 1 | 2;
    /** Tails cant outward this many radians (the Hornet's signature). */
    finCant: number;
    /** Nozzle count, for the afterburner cones. */
    nozzles: number;
    /** Has leading-edge extensions running to the canopy. */
    lerx: boolean;
    /** Wing sweep at the quarter chord, radians. */
    sweep: number;
  };
  /** Smoke colour when the smoke system is on. */
  smokeColor: number;
}

const SUPER_HORNET: AircraftSpec = {
  id: "superhornet",
  name: "F/A-18E Super Hornet",
  era: "2021 – present",
  blurb:
    "The jet the team flies today. Big wing, big LERX, and enough thrust to hold the nose up at walking pace.",
  character: "The modern standard",
  length: 18.31,
  wingspan: 13.68,
  height: 4.88,
  wingArea: 46.45,
  mass: 17500,
  inertia: { x: 32000, y: 210000, z: 230000 },
  thrustMil: 115600,
  thrustAB: 195800,
  spoolTime: 1.6,
  clAlpha: 4.6,
  cl0: 0.06,
  stallAlpha: 0.61, // ~35 deg — LERX vortices keep the wing flying absurdly late
  clMax: 1.85,
  cd0: 0.021,
  inducedK: 0.105,
  machCrit: 0.86,
  waveDrag: 3.4,
  sideForce: 1.9,
  machMax: 1.6,
  gLimit: { positive: 7.5, negative: -3 },
  ceiling: 15000,
  feel: {
    rollRate: 3.9,
    rollAuthority: 5.5,
    pitchG: 7.5,
    pitchAuthority: 3.2,
    yawRate: 0.5,
    yawAuthority: 2.4,
    damping: { x: 2.6, y: 2.0, z: 2.2 },
  },
  teamSize: 6,
  shape: {
    planform: "trapezoid",
    fins: 2,
    finCant: 0.35,
    nozzles: 2,
    lerx: true,
    sweep: 0.35,
  },
  smokeColor: 0xf2f6ff,
};

const HORNET: AircraftSpec = {
  ...SUPER_HORNET,
  id: "hornet",
  name: "F/A-18A/C Hornet",
  era: "1986 – 2020",
  blurb:
    "Thirty-four seasons in this jet. Smaller and lighter than the Super, and it turns like it knows it.",
  character: "Lighter, quicker, meaner",
  length: 17.07,
  wingspan: 11.43,
  height: 4.66,
  wingArea: 37.16,
  mass: 13500,
  inertia: { x: 22000, y: 150000, z: 165000 },
  thrustMil: 97800,
  thrustAB: 157400,
  spoolTime: 1.4,
  clAlpha: 4.4,
  stallAlpha: 0.58,
  clMax: 1.8,
  cd0: 0.0215,
  inducedK: 0.115,
  machCrit: 0.85,
  waveDrag: 3.6,
  machMax: 1.8,
  ceiling: 15200,
  feel: {
    ...SUPER_HORNET.feel,
    rollRate: 4.2,
    rollAuthority: 6.0,
    pitchAuthority: 3.5,
    damping: { x: 2.5, y: 1.9, z: 2.1 },
  },
  shape: { ...SUPER_HORNET.shape, sweep: 0.35 },
};

const SKYHAWK: AircraftSpec = {
  id: "skyhawk",
  name: "A-4F Skyhawk II",
  era: "1974 – 1986",
  blurb:
    "Heinemann's Hot Rod. Half the weight of anything else on the ramp and a roll rate that will make you laugh out loud.",
  character: "A scalpel with a wing",
  length: 13.0,
  wingspan: 8.38,
  height: 4.57,
  wingArea: 24.15,
  mass: 7200,
  inertia: { x: 6800, y: 42000, z: 46000 },
  thrustMil: 50000,
  thrustAB: 0, // no burner — the demo jets flew on military power alone
  spoolTime: 2.1,
  clAlpha: 4.0,
  cl0: 0.05,
  stallAlpha: 0.38,
  clMax: 1.35,
  cd0: 0.019,
  inducedK: 0.145,
  machCrit: 0.82,
  waveDrag: 4.2,
  sideForce: 1.6,
  machMax: 0.94,
  gLimit: { positive: 8, negative: -3 },
  ceiling: 12800,
  feel: {
    rollRate: 12.0, // 720 deg/s, and that is not a typo
    rollAuthority: 9.0,
    pitchG: 8,
    pitchAuthority: 4.0,
    yawRate: 0.55,
    yawAuthority: 2.8,
    damping: { x: 2.2, y: 2.2, z: 2.4 },
  },
  teamSize: 6,
  shape: {
    planform: "delta",
    fins: 1,
    finCant: 0,
    nozzles: 1,
    lerx: false,
    sweep: 0.58,
  },
  smokeColor: 0xf2f6ff,
};

const PHANTOM: AircraftSpec = {
  id: "phantom",
  name: "F-4J Phantom II",
  era: "1969 – 1973",
  blurb:
    "Twenty tons of thunder. It does not so much fly as bully the air into getting out of the way.",
  character: "Brute force, beautifully",
  length: 19.2,
  wingspan: 11.71,
  height: 5.0,
  wingArea: 49.24,
  mass: 19500,
  inertia: { x: 42000, y: 260000, z: 285000 },
  thrustMil: 105600,
  thrustAB: 159200,
  spoolTime: 2.4,
  clAlpha: 3.9,
  cl0: 0.04,
  stallAlpha: 0.36,
  clMax: 1.25,
  cd0: 0.024,
  inducedK: 0.16,
  machCrit: 0.88,
  waveDrag: 3.0,
  sideForce: 1.7,
  machMax: 2.2,
  gLimit: { positive: 7.33, negative: -3 },
  ceiling: 18300,
  feel: {
    rollRate: 3.1,
    rollAuthority: 3.4,
    pitchG: 7,
    pitchAuthority: 2.2,
    yawRate: 0.45,
    yawAuthority: 1.8,
    damping: { x: 3.2, y: 2.6, z: 2.8 },
  },
  teamSize: 6,
  shape: {
    planform: "swept",
    fins: 1,
    finCant: 0,
    nozzles: 2,
    lerx: false,
    sweep: 0.79,
  },
  smokeColor: 0xf2f6ff,
};

const TIGER: AircraftSpec = {
  id: "tiger",
  name: "F-11F-1 Tiger",
  era: "1957 – 1968",
  blurb:
    "The first supersonic Blue Angel, and the only fighter ever to shoot itself down. Area-ruled, tiny, and lovely.",
  character: "Sixties cool",
  length: 14.31,
  wingspan: 9.64,
  height: 4.03,
  wingArea: 23.23,
  mass: 8100,
  inertia: { x: 8200, y: 52000, z: 57000 },
  thrustMil: 33400,
  thrustAB: 46700,
  spoolTime: 2.6,
  clAlpha: 3.7,
  cl0: 0.04,
  stallAlpha: 0.34,
  clMax: 1.15,
  cd0: 0.0175,
  inducedK: 0.155,
  machCrit: 0.94,
  waveDrag: 2.6,
  sideForce: 1.4,
  machMax: 1.1,
  gLimit: { positive: 7, negative: -3 },
  ceiling: 12800,
  feel: {
    rollRate: 5.6,
    rollAuthority: 5.2,
    pitchG: 7,
    pitchAuthority: 3.0,
    yawRate: 0.5,
    yawAuthority: 2.2,
    damping: { x: 2.4, y: 2.3, z: 2.5 },
  },
  teamSize: 6,
  shape: {
    planform: "swept",
    fins: 1,
    finCant: 0,
    nozzles: 1,
    lerx: false,
    sweep: 0.61,
  },
  smokeColor: 0xf2f6ff,
};

const PANTHER: AircraftSpec = {
  id: "panther",
  name: "F9F-5 Panther",
  era: "1949 – 1955",
  blurb:
    "The team's first jet, straight-winged and honest. Slow enough that you can actually look at the city going by.",
  character: "Where the show began",
  length: 11.84,
  wingspan: 11.58,
  height: 3.73,
  wingArea: 23.23,
  mass: 6600,
  inertia: { x: 7400, y: 34000, z: 39000 },
  thrustMil: 27800,
  thrustAB: 0,
  spoolTime: 3.2,
  clAlpha: 4.8,
  cl0: 0.09,
  stallAlpha: 0.3,
  clMax: 1.4,
  cd0: 0.021,
  inducedK: 0.09,
  machCrit: 0.76,
  waveDrag: 5.0,
  sideForce: 1.5,
  machMax: 0.79,
  gLimit: { positive: 6.5, negative: -3 },
  ceiling: 13000,
  feel: {
    rollRate: 2.8,
    rollAuthority: 3.8,
    pitchG: 6,
    pitchAuthority: 2.6,
    yawRate: 0.5,
    yawAuthority: 2.0,
    damping: { x: 2.6, y: 2.4, z: 2.6 },
  },
  teamSize: 6,
  shape: {
    planform: "straight",
    fins: 1,
    finCant: 0,
    nozzles: 1,
    lerx: false,
    sweep: 0.05,
  },
  smokeColor: 0xf2f6ff,
};

const FAT_ALBERT: AircraftSpec = {
  id: "albert",
  name: "C-130J Fat Albert",
  era: "Support, and the crowd's favourite",
  blurb:
    "Bert opens the show. Four turboprops, forty metres of wing, and absolutely no business doing what you are about to do with it.",
  character: "Gloriously wrong",
  length: 30.3,
  wingspan: 40.41,
  height: 11.84,
  wingArea: 162.1,
  mass: 45000,
  inertia: { x: 1600000, y: 1400000, z: 2600000 },
  thrustMil: 180000, // four Rolls-Royce AE 2100Ds, expressed as static thrust
  thrustAB: 0,
  spoolTime: 2.8,
  clAlpha: 5.4,
  cl0: 0.22,
  stallAlpha: 0.29,
  clMax: 2.1,
  cd0: 0.028,
  inducedK: 0.05,
  machCrit: 0.62,
  waveDrag: 8.0,
  sideForce: 2.6,
  machMax: 0.64,
  gLimit: { positive: 3, negative: -1 },
  ceiling: 8600,
  feel: {
    rollRate: 0.9,
    rollAuthority: 1.6,
    pitchG: 2.5,
    pitchAuthority: 1.4,
    yawRate: 0.35,
    yawAuthority: 1.2,
    damping: { x: 3.4, y: 3.0, z: 3.2 },
  },
  teamSize: 1,
  shape: {
    planform: "prop",
    fins: 1,
    finCant: 0,
    nozzles: 0,
    lerx: false,
    sweep: 0.02,
  },
  smokeColor: 0xffffff,
};

export const HANGAR: AircraftSpec[] = [
  SUPER_HORNET,
  HORNET,
  SKYHAWK,
  PHANTOM,
  TIGER,
  PANTHER,
  FAT_ALBERT,
];

const BY_ID = new Map(HANGAR.map((a) => [a.id, a]));

export function aircraft(id: JetId): AircraftSpec {
  return BY_ID.get(id) ?? SUPER_HORNET;
}

export const DEFAULT_JET: JetId = "superhornet";
