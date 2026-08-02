/**
 * International Standard Atmosphere, troposphere + lower stratosphere.
 *
 * Everything downstream of the flight model wants four numbers from an
 * altitude: how thick the air is (lift and drag scale with it), how fast sound
 * travels through it (Mach drives the transonic drag rise and the vapour cone),
 * how cold it is (contrails), and how much of the engine's sea-level thrust
 * survives (a jet at 12 km makes roughly a quarter of its sea-level push).
 *
 * Units are SI throughout the whole world: metres, seconds, kilograms, newtons,
 * radians. Anything the pilot reads in knots or feet is converted at the HUD,
 * never in here.
 */

export const SEA_LEVEL_DENSITY = 1.225; // kg/m^3
export const SEA_LEVEL_PRESSURE = 101325; // Pa
export const SEA_LEVEL_TEMP = 288.15; // K
export const GRAVITY = 9.80665; // m/s^2

const LAPSE = 0.0065; // K/m
const R_AIR = 287.05287; // J/(kg K)
const GAMMA = 1.4;
const TROPOPAUSE = 11000; // m
const TROPOPAUSE_TEMP = 216.65; // K
const TROPOPAUSE_PRESSURE = 22632.06; // Pa

export interface AirState {
  /** Air density, kg/m^3. */
  density: number;
  /** Static pressure, Pa. */
  pressure: number;
  /** Static air temperature, K. */
  temperature: number;
  /** Speed of sound, m/s. */
  speedOfSound: number;
  /** density / sea-level density — the number engines and wings actually care about. */
  sigma: number;
}

/** Air state at a geometric altitude in metres above mean sea level. */
export function atmosphere(altitude: number): AirState {
  const h = Math.max(-500, Math.min(altitude, 30000));

  let temperature: number;
  let pressure: number;

  if (h < TROPOPAUSE) {
    temperature = SEA_LEVEL_TEMP - LAPSE * h;
    pressure = SEA_LEVEL_PRESSURE * Math.pow(temperature / SEA_LEVEL_TEMP, 5.25588);
  } else {
    temperature = TROPOPAUSE_TEMP;
    pressure =
      TROPOPAUSE_PRESSURE * Math.exp((-GRAVITY * (h - TROPOPAUSE)) / (R_AIR * TROPOPAUSE_TEMP));
  }

  const density = pressure / (R_AIR * temperature);

  return {
    density,
    pressure,
    temperature,
    speedOfSound: Math.sqrt(GAMMA * R_AIR * temperature),
    sigma: density / SEA_LEVEL_DENSITY,
  };
}

/**
 * Fraction of sea-level static thrust a turbofan still makes at this density.
 *
 * The textbook approximation is thrust ∝ sigma^0.7 for a low-bypass military
 * engine. It is close enough that a Super Hornet in this sim runs out of climb
 * at a believable altitude instead of accelerating forever.
 */
export function thrustLapse(sigma: number): number {
  return Math.pow(Math.max(sigma, 0.02), 0.7);
}

/**
 * Indicated airspeed from true airspeed — what the cockpit tape shows.
 *
 * Pilots fly IAS, not TAS: the wing feels dynamic pressure, and so does the
 * needle. At 10 km a jet doing 900 km/h true reads about 500 km/h indicated,
 * and the HUD should say so.
 */
export function indicatedAirspeed(trueAirspeed: number, sigma: number): number {
  return trueAirspeed * Math.sqrt(Math.max(sigma, 0));
}

/** Dynamic pressure, Pa. */
export function dynamicPressure(density: number, speed: number): number {
  return 0.5 * density * speed * speed;
}

/**
 * Whether the air is cold and damp enough here to pull a contrail.
 *
 * A real appraisal wants humidity we do not simulate, so this is the honest
 * half of the Appleman criterion: cold enough, high enough. Around 8 km the
 * jets start writing on the sky, which is where they do it over Seattle too.
 */
export function contrailFactor(altitude: number): number {
  return smoothstep(7200, 9000, altitude);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export const KNOTS_PER_MPS = 1.943844;
export const FEET_PER_METER = 3.280839895;
export const MPH_PER_MPS = 2.2369363;
