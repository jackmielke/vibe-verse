/**
 * The air of Venus, by altitude.
 *
 * The whole game rests on one fact, so it is worth getting the numbers from
 * somewhere real rather than from a pitch: the Venus International Reference
 * Atmosphere (Seiff et al., 1985), equatorial profile. Temperature is
 * interpolated linearly, pressure in log space, which is how both actually
 * behave over a few kilometres.
 *
 * What falls out of the table is the premise. The surface is 462 °C at
 * 92 bar. Fifty kilometres up it is one bar, and by fifty-five it is room
 * temperature. Nowhere else in the solar system, Earth excepted, can you
 * stand outside in a coat and a breathing mask.
 *
 * And because the air is 96 % carbon dioxide (44 g/mol), ordinary breathable
 * air (29 g/mol) floats in it. A dome full of air is a balloon. That is the
 * only mechanic the city needs.
 */

/** [altitude km, temperature K, pressure bar] */
const VIRA: ReadonlyArray<readonly [number, number, number]> = [
  [0, 735.3, 92.1],
  [5, 697.0, 66.65],
  [10, 658.2, 47.39],
  [15, 621.0, 33.04],
  [20, 580.7, 22.52],
  [25, 539.2, 14.93],
  [30, 496.9, 9.851],
  [35, 453.7, 5.917],
  [40, 416.8, 3.501],
  [45, 380.3, 1.979],
  [50, 350.5, 1.066],
  [55, 302.3, 0.5314],
  [60, 262.8, 0.2357],
  [65, 243.2, 0.09765],
  [70, 229.8, 0.0369],
  [80, 197.1, 0.00476],
  [90, 169.4, 0.0003736],
  [100, 175.4, 0.0000266],
];

const R = 8.314;
const M_CO2 = 0.04344; // mean molar mass of the Venusian atmosphere
const M_AIR = 0.02897;

export interface Air {
  altKm: number;
  /** Kelvin. */
  tempK: number;
  /** Celsius, for people. */
  tempC: number;
  /** bar. */
  pressure: number;
  /** kg/m³. */
  density: number;
  /** kg of lift per m³ of breathable air at this altitude. */
  liftPerM3: number;
}

export function airAt(altKm: number): Air {
  const a = Math.max(0, Math.min(100, altKm));
  let i = 0;
  while (i < VIRA.length - 2 && VIRA[i + 1][0] < a) i++;
  const [a0, t0, p0] = VIRA[i];
  const [a1, t1, p1] = VIRA[i + 1];
  const f = (a - a0) / (a1 - a0);
  const tempK = t0 + (t1 - t0) * f;
  const pressure = Math.exp(Math.log(p0) + (Math.log(p1) - Math.log(p0)) * f);
  const density = (pressure * 1e5 * M_CO2) / (R * tempK);
  return {
    altKm: a,
    tempK,
    tempC: tempK - 273.15,
    pressure,
    density,
    liftPerM3: density * (1 - M_AIR / M_CO2),
  };
}

/** The altitude the city is designed around. 30 °C, half a bar. */
export const DESIGN_ALT = 54.5;
const REF_DENSITY = airAt(DESIGN_ALT).density;

/** Density relative to the design altitude. Lift scales with exactly this. */
export function liftFactor(altKm: number): number {
  return airAt(altKm).density / REF_DENSITY;
}

/**
 * Where a city with this much lift (in tonnes, *measured at the design
 * altitude*) and this much mass comes to rest. Lift grows as you sink,
 * because the air thickens, so there is always an answer — the question is
 * only whether you can survive at it.
 */
export function equilibriumAlt(liftAtDesign: number, mass: number): number {
  if (liftAtDesign <= 0) return 0;
  const want = mass / liftAtDesign; // required density ratio
  let lo = 0, hi = 100;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (liftFactor(mid) > want) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The band people can live in without thinking about it: roughly 14 to 40 °C.
 * It used to be wider than the comfort curve, so the altimeter said "in the
 * band" in green at 63 °C while happiness quietly fell apart.
 */
export const BAND = { low: 53.6, high: 57.2 } as const;
/** Below this the hull starts to cook. */
export const HULL_STRESS_ALT = 48;
/** Above this the greenhouses freeze. */
export const FREEZE_ALT = 60;
/** The top of the lower cloud deck, which the renderer draws as the floor. */
export const LOWER_DECK_ALT = 48;
/** The base of the upper deck, which the renderer draws as the ceiling. */
export const UPPER_DECK_ALT = 62;
