/**
 * weather/report.ts — the real weather, and what San Francisco does about it.
 *
 * Everything in this file is pure. That is not tidiness; it is the only way
 * any of it could be checked. The sandbox this was written in denies outbound
 * CONNECT to every weather API there is, so the fetch itself could not be run
 * once — but the part that actually decides what the city looks like is a
 * function from a JSON blob to four numbers, and that part is exercised
 * exhaustively in `weather.test.ts`.
 *
 * ## Where the numbers come from
 *
 * Open-Meteo. No key, no sign-up, CORS open, and it serves the NOAA/NWS model
 * for a US point — which for San Francisco is the same forecast the weather
 * service publishes. `service.ts` does the asking; this file only reads the
 * answer.
 *
 * ## The interesting part is the marine layer
 *
 * Anywhere else, "weather" in a game means rain or not-rain. San Francisco's
 * signature is neither: it is a low stratus deck that pours in off the Pacific,
 * sits at 300 m, drops the temperature ten degrees in twenty minutes and
 * swallows the top half of the towers. Nothing in a WMO code says "Karl is
 * in", so it is inferred here from the combination that actually produces it —
 * humid, overcast, cool, and not much wind — and that inference is most of
 * what makes the sky agree with the window.
 */
import { clamp01, smoothstep } from "../math/rng";

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

/** Where a report came from. The HUD says so, because it matters. */
export type WeatherSource = "live" | "estimate";

/** One observation of the real city. Units are metric and unambiguous. */
export interface WeatherReport {
  /** Air temperature, °C. */
  tempC: number;
  /** What it feels like, °C — wind chill matters a lot on this peninsula. */
  apparentC: number;
  /** Relative humidity, percent. */
  humidity: number;
  /** Total cloud cover, percent. */
  cloudCover: number;
  /** Precipitation in the last hour, mm. */
  precipMm: number;
  /** WMO present-weather code. */
  code: number;
  /** Sustained wind, km/h. */
  windKph: number;
  /** Gusts, km/h. */
  gustKph: number;
  /**
   * The direction the wind blows *from*, degrees clockwise from true north.
   * This is the meteorological convention and it is the opposite of what a
   * renderer wants; `worldWeather` does the flip exactly once.
   */
  windFromDeg: number;
  /** True while the sun is up at the observation point. */
  isDay: boolean;
  /** Epoch ms the observation is for. */
  at: number;
  source: WeatherSource;
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Read Open-Meteo's `current` block.
 *
 * Defensive in the same way `net/protocol.ts` is defensive: this is a third
 * party's JSON arriving over the internet into a frame loop, and a missing
 * field must produce a slightly wrong sky rather than a NaN that propagates
 * into every particle position in the world and blanks the screen.
 */
export function parseOpenMeteo(json: unknown): WeatherReport | null {
  if (!json || typeof json !== "object") return null;
  const cur = (json as { current?: unknown }).current;
  if (!cur || typeof cur !== "object") return null;
  const c = cur as Record<string, unknown>;

  // Temperature is the one field with no sensible default: if it is missing,
  // this is not a weather response and guessing would be worse than falling
  // back to climatology.
  if (typeof c.temperature_2m !== "number" || !Number.isFinite(c.temperature_2m)) return null;

  const tempC = c.temperature_2m;
  const t = typeof c.time === "string" ? Date.parse(c.time) : NaN;

  return {
    tempC,
    apparentC: num(c.apparent_temperature, tempC),
    humidity: Math.max(0, Math.min(100, num(c.relative_humidity_2m, 75))),
    cloudCover: Math.max(0, Math.min(100, num(c.cloud_cover, 50))),
    precipMm: Math.max(0, num(c.precipitation, 0)),
    code: Math.round(num(c.weather_code, 3)),
    windKph: Math.max(0, num(c.wind_speed_10m, 12)),
    gustKph: Math.max(0, num(c.wind_gusts_10m, num(c.wind_speed_10m, 12) * 1.5)),
    windFromDeg: ((num(c.wind_direction_10m, 270) % 360) + 360) % 360,
    isDay: num(c.is_day, 1) > 0.5,
    at: Number.isFinite(t) ? t : Date.now(),
    source: "live",
  };
}

/* ------------------------------------------------------------------ *
 * Climatology — what to do when the internet says no
 * ------------------------------------------------------------------ */

/**
 * Mean conditions by month, from the 1991–2020 normals for downtown SF.
 * `[high °C, low °C, fog tendency 0..1, rain days/30, mean wind km/h]`.
 *
 * The fog column is the one worth arguing about, and it is why this table is
 * not just a temperature curve: San Francisco's foggiest months are July and
 * August, which are also its driest. A naive fallback that ties fog to rain
 * gets the city exactly backwards for a quarter of the year — bright, dry,
 * and 13 °C with the Golden Gate invisible is the single most recognisable
 * thing this place does.
 */
const NORMALS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [13.9, 8.0, 0.20, 11, 17], // Jan — wet, clear between fronts
  [15.3, 9.1, 0.20, 10, 18], // Feb
  [16.2, 9.7, 0.25, 9, 20],  // Mar — the windy month
  [17.0, 10.1, 0.30, 6, 21], // Apr
  [17.6, 11.0, 0.45, 3, 21], // May — the marine layer arrives
  [18.9, 12.2, 0.62, 1, 20], // Jun
  [18.7, 12.8, 0.78, 0, 19], // Jul — Karl's month
  [19.2, 13.3, 0.76, 0, 18], // Aug
  [20.9, 13.2, 0.55, 1, 16], // Sep — the actual summer
  [20.4, 12.5, 0.38, 3, 15], // Oct
  [17.1, 10.5, 0.25, 7, 15], // Nov
  [13.9, 8.2, 0.22, 11, 16], // Dec
];

/** Local calendar month (0–11) and hour in San Francisco, via `Intl`. */
function sanFranciscoParts(now: Date): { month: number; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      month: "numeric",
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    const month = Number(parts.find((p) => p.type === "month")?.value ?? NaN);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
    if (!Number.isFinite(month) || !Number.isFinite(hour)) throw new Error("no tz");
    return { month: (month - 1) % 12, hour: hour % 24 };
  } catch {
    return { month: now.getUTCMonth(), hour: now.getUTCHours() };
  }
}

/**
 * A plausible San Francisco from the calendar alone.
 *
 * Used when the fetch fails — offline, a blocked network, a browser that has
 * decided it does not like the request. It is marked `estimate` and the HUD
 * says so, because presenting a guess as an observation is the one thing this
 * feature must not do.
 */
export function estimateReport(now: Date = new Date()): WeatherReport {
  const { month, hour } = sanFranciscoParts(now);
  const [high, low, fogTendency, rainDays, wind] = NORMALS[month];

  // Diurnal curve: coldest just before dawn, warmest around 15:00.
  const warm = Math.cos(((hour - 15) / 24) * Math.PI * 2) * 0.5 + 0.5;
  const tempC = low + (high - low) * warm;

  /* The marine layer is nocturnal. It pushes in through the Gate in the
     evening, is thickest at dawn, and burns back to the coast by lunchtime —
     so the fog term is a function of hour as much as of month, and a July
     afternoon in this model is bright while a July 6 a.m. is not. */
  const nocturnal = 1 - smoothstep(7, 12, hour) + smoothstep(16, 21, hour);
  const fog = clamp01(fogTendency * (0.35 + 0.65 * clamp01(nocturnal)));

  // Rain is a coin weighted by the month, and it must not flicker frame to
  // frame — so it is decided by the day, not by the moment.
  const dayKey = Math.floor(now.getTime() / 86_400_000);
  const wet = ((dayKey * 2654435761) % 30) / 30 < rainDays / 30;

  return {
    tempC,
    apparentC: tempC - (wind > 18 ? 1.5 : 0.5),
    humidity: 62 + fog * 30 + (wet ? 8 : 0),
    cloudCover: wet ? 92 : 18 + fog * 65,
    precipMm: wet ? 0.7 : 0,
    code: wet ? 61 : fog > 0.5 ? 45 : fog > 0.25 ? 3 : 1,
    windKph: wind,
    gustKph: wind * 1.6,
    // Onshore, out of the west-northwest, which is where it comes from here
    // essentially always outside a winter storm.
    windFromDeg: wet ? 160 : 285,
    isDay: hour >= 6 && hour < 20,
    at: now.getTime(),
    source: "estimate",
  };
}

/* ------------------------------------------------------------------ *
 * Report -> world
 * ------------------------------------------------------------------ */

/**
 * The thickest fog this city is allowed to have. See `worldWeather`.
 */
export const MAX_FOG = 0.93;

/** What the renderer needs. All 0..1 except the wind, which is metres/second. */
export interface WorldWeather {
  /** Rain intensity for the streak field and the splashes. */
  rain: number;
  /** Low wisps lying along the ground. */
  groundFog: number;
  /** Dry airborne haze — an offshore day, when the air goes brown-gold. */
  haze: number;
  /** `frame.fogDensity`: the atmospheric depth cue the sky and postfx read. */
  fogDensity: number;
  /** Unit vector in world XZ pointing where the wind is *going*. */
  windX: number;
  windZ: number;
  /** Metres per second. */
  windSpeed: number;
  /** 0..1 cloud cover, for whatever wants to dim the sun. */
  cloud: number;
}

/** Rain intensity implied by a WMO present-weather code, 0..1. */
export function rainFromCode(code: number): number {
  if (code >= 95) return 0.95;             // thunderstorm
  if (code >= 85) return 0.7;              // snow showers — visually, heavy
  if (code >= 80) return code === 80 ? 0.45 : code === 81 ? 0.7 : 0.95; // showers
  if (code >= 71) return 0.5;              // snow
  if (code >= 66) return 0.7;              // freezing rain
  if (code >= 61) return code === 61 ? 0.4 : code === 63 ? 0.7 : 0.95;  // rain
  if (code >= 56) return 0.35;             // freezing drizzle
  if (code >= 51) return code === 51 ? 0.16 : code === 53 ? 0.3 : 0.45; // drizzle
  return 0;
}

/** True for the two codes that mean the observer cannot see very far. */
export function isFogCode(code: number): boolean {
  return code === 45 || code === 48;
}

/**
 * The whole mapping, in one pure function.
 *
 * Deliberately not a lookup on the WMO code alone. The code is a single
 * category chosen by a model, and it is at its worst exactly where this city
 * is at its most characteristic: a 13 °C, 94 %-humidity, fully overcast, dead
 * calm morning in the Sunset gets reported as plain "overcast" about as often
 * as it gets reported as "fog". So fog here is the *maximum* of what the code
 * says and what the conditions imply, and the conditions usually win.
 */
export function worldWeather(r: WeatherReport): WorldWeather {
  const cloud = clamp01(r.cloudCover / 100);

  // --- rain ---
  // The code is the primary signal; measured precipitation raises it, so a
  // downpour that the model called "slight rain" still looks like a downpour.
  const rain = clamp01(Math.max(rainFromCode(r.code), smoothstep(0, 4, r.precipMm)));

  /* --- the marine layer ---
     Three ingredients, all necessary: saturated air, a lid of cloud, and cool
     temperatures. Any two without the third is just a grey day. */
  const damp = smoothstep(72, 96, r.humidity);
  const cool = 1 - smoothstep(15, 22, r.tempC);
  const lid = smoothstep(0.35, 0.95, cloud);
  const marine = clamp01(damp * cool * (0.35 + 0.65 * lid));

  // A hard fog code is worth more than any inference from it.
  const declared = isFogCode(r.code) ? 0.85 : 0;

  /* Strong wind scours the fog out. This is the reason a 40 km/h afternoon in
     the Marina is crystal clear and the same air at dawn is a wall. */
  const scour = 1 - smoothstep(28, 55, r.windKph) * 0.55;

  const murk =
    /* The floor: this world has never looked right with zero depth cue, and
       on the clearest day here you are still looking through ten kilometres
       of ocean air. */
    0.07
    /* The marine layer is weighted to 0.74 rather than 1 on purpose. At full
       strength `fogDensity` pulls the fog's far plane in to 1.8 km, and a
       thick-but-real Karl was arriving at exactly 1.0 — which is the value
       that erases the Golden Gate from Twin Peaks, and Twin Peaks is where
       this world now asks you to stand and look at it. 0.74 leaves the
       worst genuine morning at about 0.9, which is still a proper pea-souper
       and still lets the bridge exist as a shape in it. */
    + Math.max(declared, marine) * scour * 0.74
    // Rain has its own murk, and overcast alone still shortens the view.
    + rain * 0.18 + cloud * 0.09;

  /* And a hard ceiling on the total, because the terms are independent and
     several of them can pile up: a thunderstorm inside a marine layer sums
     past 1.0 and lands on a flat white screen. `MAX_FOG` is a design
     constraint rather than a clamp that happens to be there — above about
     0.95 the Golden Gate stops existing from Twin Peaks, and Twin Peaks is
     where this world now asks you to stand and look at it. */
  const fogDensity = Math.min(MAX_FOG, clamp01(murk));

  // Ground fog is the part that lies in the streets: the same layer, but only
  // once it is thick enough to have reached sea level.
  const groundFog = clamp01(smoothstep(0.3, 0.85, Math.max(declared, marine)) * scour);

  /* --- haze ---
     The opposite weather, and San Francisco's other one: a dry offshore
     autumn day, or the smoke that comes with it. Dry, warm, clear, and the
     light goes flat and golden. */
  const haze = clamp01(
    (1 - smoothstep(40, 70, r.humidity)) * smoothstep(17, 26, r.tempC) * (1 - cloud) * 0.8,
  );

  /* --- wind ---
     `windFromDeg` is where it comes from; the renderer wants where it goes.
     World axes are +X east, +Z south, so a heading H maps to
     (sin H, -cos H) — and a 180° flip of the meteorological bearing collapses
     to (-sin deg, cos deg). Getting this backwards is invisible in a still
     and obviously wrong the moment a flag moves. */
  const rad = (r.windFromDeg * Math.PI) / 180;
  const windX = -Math.sin(rad);
  const windZ = Math.cos(rad);

  /* Two-thirds sustained, one-third gust: the vegetation and the rain read
     this as a constant, and a constant set to the mean of a gusty day looks
     dead while one set to the gust looks like a hurricane. */
  const windSpeed = (r.windKph * 0.67 + r.gustKph * 0.33) / 3.6;

  return { rain, groundFog, haze, fogDensity, windX, windZ, windSpeed, cloud };
}

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

const CODE_LABEL: ReadonlyArray<readonly [number, string]> = [
  [0, "Clear"], [1, "Mostly clear"], [2, "Partly cloudy"], [3, "Overcast"],
  [45, "Fog"], [48, "Freezing fog"],
  [51, "Light drizzle"], [53, "Drizzle"], [55, "Heavy drizzle"],
  [56, "Freezing drizzle"], [57, "Freezing drizzle"],
  [61, "Light rain"], [63, "Rain"], [65, "Heavy rain"],
  [66, "Freezing rain"], [67, "Freezing rain"],
  [71, "Light snow"], [73, "Snow"], [75, "Heavy snow"], [77, "Snow grains"],
  [80, "Showers"], [81, "Showers"], [82, "Heavy showers"],
  [85, "Snow showers"], [86, "Snow showers"],
  [95, "Thunderstorm"], [96, "Thunderstorm"], [99, "Thunderstorm"],
];

/** Compass point the wind is blowing *from*, the way a forecast says it. */
export function compassFrom(deg: number): string {
  const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                 "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * A short line for the HUD.
 *
 * "Karl" is not a joke inserted for flavour: the fog here is named, locally,
 * by everyone, and a San Franciscan reading "Overcast" on a morning the whole
 * city calls Karl would find the label wrong rather than dry. It is used only
 * when the model is genuinely a thick marine layer, not for any grey sky.
 */
export function describeWeather(r: WeatherReport, w: WorldWeather): string {
  /* Rain first. A winter storm here is also low, cold and saturated, so the
     marine-layer inference fires on it too — and a downpour reported as
     "Karl is in" is wrong in a way a San Franciscan would notice immediately.
     Fog is the answer only when it is the *whole* answer. */
  if (w.rain > 0.55) return "Pouring";
  if (w.groundFog > 0.55 && w.rain < 0.2) return "Karl is in";
  if (w.rain > 0.3) return "Raining";
  for (let i = CODE_LABEL.length - 1; i >= 0; i--) {
    if (r.code >= CODE_LABEL[i][0]) return CODE_LABEL[i][1];
  }
  return "Clear";
}

/** "13° · WNW 22 km/h" — the detail line under the label. */
export function weatherDetail(r: WeatherReport): string {
  return `${Math.round(r.tempC)}° · ${compassFrom(r.windFromDeg)} ${Math.round(r.windKph)} km/h`;
}
