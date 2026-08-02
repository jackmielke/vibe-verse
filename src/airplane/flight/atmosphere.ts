/**
 * The air. ISA below the tropopause, and the three things that read from it.
 *
 * Small file, load-bearing for the feel of the whole game. Indicated airspeed
 * is the number on the dial *and* the number the wing stalls at, and it falls
 * away from true airspeed as the square root of density ratio — which is why a
 * 707 that is perfectly happy at 250 knots indicated in the descent is doing
 * 340 knots over the ground at the top of it, and why the approach has to be
 * flown on the indicated number and nothing else.
 */

export const RHO_SL = 1.225;       // kg/m³ at sea level, ISA
export const P_SL = 101325;        // Pa
export const T_SL = 288.15;        // K
const LAPSE = 0.0065;              // K/m, troposphere
const G = 9.80665;
const R_AIR = 287.05287;
const TROPOPAUSE = 11000;          // m

/** Temperature, K, at a geopotential altitude. */
export function temperatureAt(altitude: number): number {
  if (altitude <= TROPOPAUSE) return T_SL - LAPSE * altitude;
  return T_SL - LAPSE * TROPOPAUSE; // 216.65 K, isothermal above
}

/** Pressure, Pa. */
export function pressureAt(altitude: number): number {
  if (altitude <= TROPOPAUSE) {
    return P_SL * Math.pow(1 - (LAPSE * altitude) / T_SL, G / (R_AIR * LAPSE));
  }
  const pTrop = P_SL * Math.pow(1 - (LAPSE * TROPOPAUSE) / T_SL, G / (R_AIR * LAPSE));
  return pTrop * Math.exp((-G * (altitude - TROPOPAUSE)) / (R_AIR * 216.65));
}

/** Density, kg/m³. Clamped below sea level so a crash site cannot divide by zero. */
export function densityAt(altitude: number): number {
  const h = Math.max(altitude, -500);
  return pressureAt(h) / (R_AIR * temperatureAt(h));
}

/** Speed of sound, m/s. */
export function soundSpeedAt(altitude: number): number {
  return Math.sqrt(1.4 * R_AIR * temperatureAt(Math.max(altitude, -500)));
}

/**
 * Equivalent airspeed — what the pitot-static system shows, near enough.
 *
 * The real relationship is compressible and the difference matters above about
 * M0.4, but the number that governs stalling, flap limits and the approach is
 * this one: `V√(ρ/ρ₀)`.
 */
export function indicatedFrom(tas: number, altitude: number): number {
  return tas * Math.sqrt(densityAt(altitude) / RHO_SL);
}

/** The inverse — what true airspeed a given indicated speed is up here. */
export function trueFrom(ias: number, altitude: number): number {
  return ias / Math.sqrt(densityAt(altitude) / RHO_SL);
}

/**
 * How much thrust four turbofans still make up here.
 *
 * A JT3D is a low-bypass engine and loses thrust roughly with density to the
 * 0.8, with a further ram-drag penalty that grows with Mach. The exponent
 * matters more than it looks: get it wrong and the aeroplane either climbs to
 * the tropopause like a fighter or cannot make 10,000 feet.
 */
export function thrustLapse(altitude: number, mach: number): number {
  const sigma = densityAt(altitude) / RHO_SL;
  const density = Math.pow(Math.max(sigma, 0.02), 0.8);
  // Net thrust falls with forward speed at low altitude and recovers a little
  // with ram at high Mach. This is the flat-rated approximation of that curve.
  const ram = 1 - 0.28 * Math.min(mach, 0.9) + 0.10 * Math.max(0, mach - 0.5);
  return density * Math.max(ram, 0.35);
}

/** Pressure altitude for an altimeter set to a non-standard QNH, metres. */
export function pressureAltitude(altitude: number, qnhHpa: number): number {
  return altitude + (1013.25 - qnhHpa) * 8.23;
}
