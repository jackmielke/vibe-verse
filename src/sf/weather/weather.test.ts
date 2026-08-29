/**
 * The weather mapping.
 *
 * The fetch itself cannot be run here — the sandbox's egress proxy answers 403
 * to CONNECT for api.open-meteo.com, api.weather.gov and wttr.in alike — so
 * everything that decides what the city looks like was made a pure function of
 * a parsed report, and this is where that decision is paid off. What is
 * checked is not "does it return a number" but the handful of judgements that
 * would actually be wrong in a way somebody in San Francisco would notice.
 */
import { describe, expect, it } from "vitest";
import {
  compassFrom,
  describeWeather,
  estimateReport,
  isFogCode,
  parseOpenMeteo,
  rainFromCode,
  weatherDetail,
  worldWeather,
  type WeatherReport,
} from "./report";

function report(over: Partial<WeatherReport> = {}): WeatherReport {
  return {
    tempC: 15, apparentC: 14, humidity: 78, cloudCover: 50, precipMm: 0,
    code: 3, windKph: 18, gustKph: 28, windFromDeg: 270, isDay: true,
    at: 1_700_000_000_000, source: "live",
    ...over,
  };
}

describe("parsing what Open-Meteo sends", () => {
  const live = {
    current: {
      time: "2026-08-29T06:00",
      temperature_2m: 13.4,
      apparent_temperature: 11.9,
      relative_humidity_2m: 93,
      precipitation: 0,
      weather_code: 45,
      cloud_cover: 100,
      wind_speed_10m: 14.8,
      wind_direction_10m: 272,
      wind_gusts_10m: 25.9,
      is_day: 1,
    },
  };

  it("reads a real response", () => {
    const r = parseOpenMeteo(live)!;
    expect(r.tempC).toBe(13.4);
    expect(r.humidity).toBe(93);
    expect(r.code).toBe(45);
    expect(r.windFromDeg).toBe(272);
    expect(r.isDay).toBe(true);
    expect(r.source).toBe("live");
  });

  it("refuses anything that is not a weather response", () => {
    // This is third-party JSON going into a frame loop. A NaN that reaches
    // `frame.windDirection` reaches every particle position in the world.
    expect(parseOpenMeteo(null)).toBeNull();
    expect(parseOpenMeteo("sorry")).toBeNull();
    expect(parseOpenMeteo({})).toBeNull();
    expect(parseOpenMeteo({ current: {} })).toBeNull();
    expect(parseOpenMeteo({ current: { temperature_2m: "13" } })).toBeNull();
    expect(parseOpenMeteo({ current: { temperature_2m: NaN } })).toBeNull();
  });

  it("fills in a field that went missing rather than giving up", () => {
    const r = parseOpenMeteo({ current: { temperature_2m: 16 } })!;
    expect(r.apparentC).toBe(16);
    expect(Number.isFinite(r.humidity)).toBe(true);
    expect(Number.isFinite(r.windFromDeg)).toBe(true);
    expect(Number.isFinite(r.gustKph)).toBe(true);
  });

  it("wraps a wind bearing into 0..360", () => {
    expect(parseOpenMeteo({ current: { temperature_2m: 1, wind_direction_10m: -90 } })!.windFromDeg)
      .toBe(270);
    expect(parseOpenMeteo({ current: { temperature_2m: 1, wind_direction_10m: 450 } })!.windFromDeg)
      .toBe(90);
  });
});

describe("wind direction", () => {
  /* The single easiest thing to get backwards, invisible in a still frame,
     and obviously wrong the moment a tree moves. World axes: +X east, +Z
     south. `windFromDeg` is where it blows FROM. */
  it("blows away from where it comes from", () => {
    const north = worldWeather(report({ windFromDeg: 0 }));
    expect(north.windX).toBeCloseTo(0, 6);
    expect(north.windZ).toBeCloseTo(1, 6); // from the north, heading south (+Z)

    const west = worldWeather(report({ windFromDeg: 270 }));
    expect(west.windX).toBeCloseTo(1, 6);  // from the west, heading east (+X)
    expect(west.windZ).toBeCloseTo(0, 6);

    const south = worldWeather(report({ windFromDeg: 180 }));
    expect(south.windZ).toBeCloseTo(-1, 6);
  });

  it("is a unit vector whatever the bearing", () => {
    for (let d = 0; d < 360; d += 17) {
      const w = worldWeather(report({ windFromDeg: d }));
      expect(Math.hypot(w.windX, w.windZ)).toBeCloseTo(1, 6);
    }
  });

  it("is metres per second, between the sustained speed and the gust", () => {
    const w = worldWeather(report({ windKph: 36, gustKph: 72 }));
    expect(w.windSpeed).toBeGreaterThan(36 / 3.6);
    expect(w.windSpeed).toBeLessThan(72 / 3.6);
  });

  it("names the compass point a forecast would name", () => {
    expect(compassFrom(0)).toBe("N");
    expect(compassFrom(90)).toBe("E");
    expect(compassFrom(292.5)).toBe("WNW");
    expect(compassFrom(-90)).toBe("W");
    expect(compassFrom(360)).toBe("N");
  });
});

describe("rain", () => {
  it("gets heavier with the code", () => {
    expect(rainFromCode(0)).toBe(0);
    expect(rainFromCode(3)).toBe(0);
    expect(rainFromCode(51)).toBeLessThan(rainFromCode(55));
    expect(rainFromCode(61)).toBeLessThan(rainFromCode(65));
    expect(rainFromCode(80)).toBeLessThan(rainFromCode(82));
    expect(rainFromCode(95)).toBeGreaterThan(rainFromCode(61));
  });

  it("believes the rain gauge over the label", () => {
    // The model said "slight rain" and 6 mm fell in the hour. It is pouring.
    const mild = worldWeather(report({ code: 61, precipMm: 0 }));
    const soaked = worldWeather(report({ code: 61, precipMm: 6 }));
    expect(soaked.rain).toBeGreaterThan(mild.rain);
    expect(soaked.rain).toBeGreaterThan(0.9);
  });

  it("stays at zero on a dry day however grey it is", () => {
    expect(worldWeather(report({ code: 3, cloudCover: 100, precipMm: 0 })).rain).toBe(0);
  });
});

describe("the marine layer", () => {
  /** A real July morning in the Sunset. */
  const karl = report({ tempC: 12.8, humidity: 95, cloudCover: 100, windKph: 11, code: 3 });

  it("finds fog that the weather code never mentions", () => {
    // The whole reason fog is inferred rather than looked up: this exact
    // reading is reported as plain "overcast" about half the time.
    const w = worldWeather(karl);
    expect(w.fogDensity).toBeGreaterThan(0.6);
    expect(w.groundFog).toBeGreaterThan(0.5);
    expect(describeWeather(karl, w)).toBe("Karl is in");
  });

  it("needs all three ingredients, not two", () => {
    const clear = worldWeather(report({ tempC: 12.8, humidity: 40, cloudCover: 100 }));
    const warm = worldWeather(report({ tempC: 27, humidity: 95, cloudCover: 100 }));
    const open = worldWeather(report({ tempC: 12.8, humidity: 95, cloudCover: 5 }));
    for (const w of [clear, warm, open]) expect(w.groundFog).toBeLessThan(0.3);
  });

  it("is scoured out by a strong wind", () => {
    const calm = worldWeather({ ...karl, windKph: 8, gustKph: 12 });
    const blowing = worldWeather({ ...karl, windKph: 55, gustKph: 75 });
    expect(blowing.fogDensity).toBeLessThan(calm.fogDensity);
    expect(blowing.groundFog).toBeLessThan(calm.groundFog);
  });

  it("takes a declared fog code at its word", () => {
    expect(isFogCode(45)).toBe(true);
    expect(isFogCode(48)).toBe(true);
    expect(isFogCode(3)).toBe(false);
    // Dry and warm, but the observer says fog. The observer wins.
    const w = worldWeather(report({ code: 45, humidity: 55, tempC: 20, cloudCover: 30 }));
    expect(w.fogDensity).toBeGreaterThan(0.6);
  });
});

describe("haze", () => {
  it("shows up on a dry warm offshore day and nowhere else", () => {
    const offshore = worldWeather(report({ tempC: 27, humidity: 28, cloudCover: 5, code: 0 }));
    expect(offshore.haze).toBeGreaterThan(0.4);
    expect(worldWeather(report({ tempC: 12, humidity: 95, cloudCover: 100 })).haze)
      .toBeLessThan(0.05);
  });
});

describe("the whole mapping stays in range", () => {
  it("never produces a value a shader would choke on", () => {
    // Every combination that could arrive, including several that cannot.
    for (const code of [0, 3, 45, 48, 55, 61, 65, 75, 82, 95, 999, -1]) {
      for (const humidity of [0, 50, 100]) {
        for (const tempC of [-10, 15, 45]) {
          for (const windKph of [0, 25, 120]) {
            const w = worldWeather(report({ code, humidity, tempC, windKph, cloudCover: 60 }));
            for (const v of [w.rain, w.groundFog, w.haze, w.fogDensity, w.cloud]) {
              expect(Number.isFinite(v)).toBe(true);
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(1);
            }
            expect(Number.isFinite(w.windSpeed)).toBe(true);
            expect(Number.isFinite(w.windX)).toBe(true);
            expect(Number.isFinite(w.windZ)).toBe(true);
          }
        }
      }
    }
  });

  it("never erases the city, even in the worst fog it can produce", () => {
    /* `frame.fogDensity` drives the fog's far plane. At 1.0 the Golden Gate
       stops existing from Twin Peaks, which is where the Terraces now ask you
       to stand and look at it — so the ceiling is a design constraint, not a
       clamp that happens to be there. Every combination, including several
       that cannot occur together. */
    let worst = 0;
    for (const code of [0, 3, 45, 48, 65, 82, 95]) {
      for (const humidity of [0, 60, 90, 100]) {
        for (const tempC of [-5, 10, 14, 30]) {
          for (const cloudCover of [0, 50, 100]) {
            for (const precipMm of [0, 3, 20]) {
              for (const windKph of [0, 20, 90]) {
                worst = Math.max(
                  worst,
                  worldWeather(report({ code, humidity, tempC, cloudCover, precipMm, windKph }))
                    .fogDensity,
                );
              }
            }
          }
        }
      }
    }
    expect(worst).toBeLessThan(0.96);
    // And it does get properly thick — a ceiling that is never approached is
    // not a ceiling, it is a coincidence.
    expect(worst).toBeGreaterThan(0.8);
  });

  it("keeps a depth cue even on the clearest possible day", () => {
    const w = worldWeather(report({ code: 0, humidity: 20, cloudCover: 0, tempC: 24 }));
    expect(w.fogDensity).toBeGreaterThan(0.05);
    expect(w.fogDensity).toBeLessThan(0.25);
  });
});

describe("the climatology fallback", () => {
  const at = (iso: string) => estimateReport(new Date(iso));

  it("is marked as a guess", () => {
    expect(at("2026-07-15T14:00:00Z").source).toBe("estimate");
  });

  it("puts the fog in July and not in October", () => {
    // 13:00 UTC is 06:00 in San Francisco — the foggiest hour of the year's
    // foggiest month, against the same hour in its clearest.
    const july = worldWeather(at("2026-07-15T13:00:00Z"));
    const october = worldWeather(at("2026-10-15T13:00:00Z"));
    expect(july.fogDensity).toBeGreaterThan(october.fogDensity);
  });

  it("burns the fog off by the afternoon", () => {
    const dawn = worldWeather(at("2026-07-15T13:00:00Z"));  // 06:00 local
    const noon = worldWeather(at("2026-07-15T22:00:00Z"));  // 15:00 local
    expect(noon.fogDensity).toBeLessThan(dawn.fogDensity);
  });

  it("is colder before dawn than in the afternoon", () => {
    expect(at("2026-07-15T12:00:00Z").tempC).toBeLessThan(at("2026-07-15T22:00:00Z").tempC);
  });

  it("blows onshore, out of the west, like it actually does", () => {
    const w = worldWeather(at("2026-07-15T22:00:00Z"));
    expect(w.windX).toBeGreaterThan(0.7); // heading east, off the ocean
  });

  it("produces something valid for every hour of every month", () => {
    for (let m = 0; m < 12; m++) {
      for (let h = 0; h < 24; h++) {
        const d = new Date(Date.UTC(2026, m, 15, h));
        const r = estimateReport(d);
        expect(Number.isFinite(r.tempC)).toBe(true);
        expect(r.tempC).toBeGreaterThan(-5);
        expect(r.tempC).toBeLessThan(40);
        const w = worldWeather(r);
        expect(w.fogDensity).toBeGreaterThanOrEqual(0);
        expect(w.fogDensity).toBeLessThanOrEqual(1);
      }
    }
  });

  it("does not flicker between two calls a second apart", () => {
    // Rain is decided per day, not per moment: a shower that appears and
    // vanishes every time the sky is re-read is worse than no rain at all.
    const a = estimateReport(new Date("2026-01-15T13:00:00Z"));
    const b = estimateReport(new Date("2026-01-15T13:00:01Z"));
    expect(a.precipMm).toBe(b.precipMm);
    expect(a.code).toBe(b.code);
  });
});

describe("words for the HUD", () => {
  it("says the obvious thing for the obvious codes", () => {
    const say = (over: Partial<WeatherReport>) => {
      const r = report(over);
      return describeWeather(r, worldWeather(r));
    };
    expect(say({ code: 0, humidity: 40, cloudCover: 0, tempC: 20 })).toBe("Clear");
    expect(say({ code: 3, humidity: 40, cloudCover: 90, tempC: 20 })).toBe("Overcast");
    expect(say({ code: 65, humidity: 90, tempC: 11 })).toBe("Pouring");
    expect(say({ code: 51, humidity: 50, tempC: 18 })).toBe("Light drizzle");
  });

  it("calls a storm a storm, even though a storm is also fog", () => {
    /* A San Francisco winter storm is low, cold and saturated, so the
       marine-layer inference fires on it as well — and the first version
       reported a downpour as "Karl is in", which is the one label a local
       would immediately know was wrong. */
    const wet = report({ code: 63, humidity: 92, cloudCover: 100, tempC: 12, precipMm: 2.2 });
    const w = worldWeather(wet);
    expect(w.groundFog).toBeGreaterThan(0.55);
    expect(describeWeather(wet, w)).toBe("Pouring");
  });

  it("writes a detail line a person can read at a glance", () => {
    expect(weatherDetail(report({ tempC: 13.4, windFromDeg: 272, windKph: 14.8 })))
      .toBe("13° · W 15 km/h");
  });
});
