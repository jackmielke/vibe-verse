/**
 * Chicago, the runway, and the ILS that gets you onto it.
 *
 * The single source of truth for where anything is. The terrain, the city
 * lights, the approach lighting, the tower's callouts and the needles on the
 * panel all read from here, which is the only way they can be guaranteed to
 * agree — an ILS that points four hundred metres left of the runway you can
 * see out of the window is the sort of bug that makes a whole game feel wrong
 * without ever being identifiable.
 *
 * Geometry: **+X east, −Z north, +Y up.** Runway 09 starts at the world origin
 * and runs due east, which makes "distance from the threshold" and "metres
 * along the runway" the same number — worth more than it sounds when you are
 * scoring a touchdown point.
 */
import * as THREE from "three";

/** Field elevation, metres. O'Hare sits at 672 feet. */
export const FIELD_ELEVATION = 204.8;

export const RUNWAY = {
  /** Runway 09 — heading 090°, landing eastbound. */
  designator: "09",
  heading: Math.PI / 2,
  /** Threshold, at the origin, at field elevation. */
  threshold: new THREE.Vector3(0, FIELD_ELEVATION, 0),
  length: 3350,
  width: 61,
  /** Where the touchdown-zone markings are: 300 m in, as they always are. */
  aimPoint: 300,
  /** Displaced threshold lighting and the piano keys extend this far. */
  thresholdBar: 30,
} as const;

export const ILS = {
  /** Glideslope angle. Three degrees, like everywhere. */
  glideslope: (3 * Math.PI) / 180,
  /**
   * The glideslope aerial sits abeam the touchdown zone, not at the threshold,
   * which is why a correctly flown 3° slope puts the wheels 300 m in rather
   * than on the numbers.
   */
  gsOrigin: new THREE.Vector3(RUNWAY.aimPoint, FIELD_ELEVATION, 0),
  /** The localizer aerial is past the far end, looking back down the runway. */
  locOrigin: new THREE.Vector3(RUNWAY.length + 300, FIELD_ELEVATION, 0),
  /** Full-scale deflection, radians. ±2.5° and ±0.7°, per ICAO. */
  locFullScale: (2.5 * Math.PI) / 180,
  gsFullScale: (0.7 * Math.PI) / 180,
  /** Decision height for a Cat I approach: 200 feet above the touchdown zone. */
  decisionHeight: 61,
  /** The outer marker, five miles out. */
  outerMarker: -9260,
  middleMarker: -1050,
  frequency: "109.9",
  identifier: "IORD",
} as const;

/**
 * Where the "skip to the approach" shortcut puts you: 19 km west, 4,000 feet,
 * and 1.6 km left of the centreline.
 *
 * Not *on* the localizer, deliberately. Being handed a perfectly-set-up
 * approach teaches nothing and feels like a cutscene; being handed one that
 * needs a thirty-degree intercept and a descent is a real piece of flying that
 * takes about four minutes, which is the right length for the thing this
 * shortcut exists to get you to.
 */
export const APPROACH_START = new THREE.Vector3(-24000, 1372 + FIELD_ELEVATION, -1900);
/** And the speed it starts at: already slowing, flaps out, gear still up. */
export const APPROACH_SPEED = 82;

/**
 * Where the flight picks up: 70 km west, 12,000 feet, already in the descent.
 *
 * Not at cruise altitude, and the reason is arithmetic rather than taste. The
 * three-to-one rule says 29,000 feet needs eighty-seven nautical miles to lose,
 * which is a hundred and sixty kilometres and about eighteen minutes of holding
 * a heading — and the film's drama is the *arrival*, not the cruise. Starting
 * in the descent gives an eight-minute flight in which every minute has
 * something in it, and the descent profile from here is a real 4.7% gradient
 * rather than a dive.
 */
export const CRUISE_START = new THREE.Vector3(-70000, 3660 + FIELD_ELEVATION, 4200);
/** What the tower clears you down to, metres MSL. Five thousand feet. */
export const APPROACH_ALTITUDE = 1524 + FIELD_ELEVATION;

/**
 * Downtown Chicago, east-south-east of the field.
 *
 * The real bearing from O'Hare to the Loop is about 118° at 27 km, and putting
 * it there is what makes the last two minutes work: rolling out on final for
 * 09 you get the runway dead ahead, the skyline stack beyond it and slightly
 * right, and behind that the completely black hole of Lake Michigan. Three
 * layers of depth, all of them true, and none of them costing anything.
 */
export const DOWNTOWN = new THREE.Vector3(23800, 0, 12700);

/** The shoreline, as a function of north–south position. Chicago's runs NNE. */
export function shorelineX(z: number): number {
  return 31500 + z * 0.16;
}

export function isOverLake(x: number, z: number): boolean {
  return x > shorelineX(z);
}

// ---------------------------------------------------------------------------

export interface IlsFix {
  /** Signed angular localizer deviation, radians. Positive = fly right to regain the centreline. */
  locDeviation: number;
  /** −1..+1 needle, saturating at full scale. */
  locNeedle: number;
  /** Signed glideslope deviation, radians. Positive = you are above the beam. */
  gsDeviation: number;
  gsNeedle: number;
  /** Distance to the threshold along the ground, metres. */
  distance: number;
  /** Metres left (−) or right (+) of the extended centreline. */
  lateralOffset: number;
  /** Height above the beam at this range, metres. Positive = high. */
  heightError: number;
  /** True when the aeroplane is in front of the aerials and can receive them. */
  valid: boolean;
  /** True when both needles are within half scale — the ILS is "captured". */
  established: boolean;
}

const _rel = new THREE.Vector3();

/**
 * Where you are relative to the beams.
 *
 * Both deviations are *angular*, which is what makes an ILS behave the way it
 * does: a hundred metres off the centreline is nothing at ten miles and is a
 * full-scale deflection at half a mile, so the approach gets progressively
 * less forgiving exactly as you get closer to the ground. Modelling it as a
 * fixed lateral distance instead — which is the tempting shortcut — produces
 * an approach that is uniformly easy and teaches nothing.
 */
export function ilsFix(position: THREE.Vector3, out?: IlsFix): IlsFix {
  const fix: IlsFix = out ?? {
    locDeviation: 0,
    locNeedle: 0,
    gsDeviation: 0,
    gsNeedle: 0,
    distance: 0,
    lateralOffset: 0,
    heightError: 0,
    valid: false,
    established: false,
  };

  // Along-runway distance from the threshold. Negative before it.
  const along = position.x - RUNWAY.threshold.x;
  fix.distance = Math.abs(along);
  fix.lateralOffset = position.z - RUNWAY.threshold.z;

  // Range to each aerial, along the runway axis.
  const locRange = ILS.locOrigin.x - position.x;
  const gsRange = ILS.gsOrigin.x - position.x;
  fix.valid = locRange > 400 && gsRange > 200 && fix.distance < 46000;

  if (!fix.valid) {
    fix.locDeviation = 0;
    fix.gsDeviation = 0;
    fix.locNeedle = 0;
    fix.gsNeedle = 0;
    fix.heightError = 0;
    fix.established = false;
    return fix;
  }

  // The needle is a fly-to indication: positive means "the centreline is to
  // your right, turn right". +Z is south, so being south of the centreline on
  // an eastbound runway puts you right of course and the needle goes left.
  fix.locDeviation = Math.atan2(-fix.lateralOffset, locRange);
  fix.locNeedle = clampUnit(fix.locDeviation / ILS.locFullScale);

  const beamHeight = FIELD_ELEVATION + Math.tan(ILS.glideslope) * gsRange;
  fix.heightError = position.y - beamHeight;
  const actualAngle = Math.atan2(position.y - FIELD_ELEVATION, gsRange);
  fix.gsDeviation = actualAngle - ILS.glideslope;
  fix.gsNeedle = clampUnit(fix.gsDeviation / ILS.gsFullScale);

  fix.established = Math.abs(fix.locNeedle) < 0.5 && Math.abs(fix.gsNeedle) < 0.5;
  return fix;
}

/**
 * The PAPI, as the pilot sees it: how many of the four lights are white.
 *
 * A real PAPI is set to 3.0° with 20-minute steps between the units, so you
 * get two white and two red in the middle of a correctly flown approach, and
 * that is the single best "am I high or low" cue in aviation — you can read it
 * from four miles out with one glance, in weather, at night.
 */
export function papiWhiteCount(position: THREE.Vector3): number {
  const range = ILS.gsOrigin.x - position.x;
  if (range < 30) return 2;
  const angle = Math.atan2(position.y - FIELD_ELEVATION, range);
  const step = (20 / 60) * (Math.PI / 180);
  const lowest = ILS.glideslope - 1.5 * step;
  let white = 0;
  for (let i = 0; i < 4; i++) if (angle > lowest + i * step) white++;
  return white;
}

/** How far, in nautical miles, to the threshold. What the DME shows. */
export function dme(position: THREE.Vector3): number {
  const dx = position.x - RUNWAY.threshold.x;
  const dz = position.z - RUNWAY.threshold.z;
  const dy = position.y - FIELD_ELEVATION;
  return Math.sqrt(dx * dx + dz * dz + dy * dy) / 1852;
}

/** True once the wheels are on the paved surface, laterally and lengthwise. */
export function onRunway(position: THREE.Vector3): boolean {
  const along = position.x - RUNWAY.threshold.x;
  return (
    along > -RUNWAY.thresholdBar &&
    along < RUNWAY.length &&
    Math.abs(position.z - RUNWAY.threshold.z) < RUNWAY.width / 2
  );
}

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
