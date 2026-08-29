/**
 * weather/service.ts — asking the internet what it is like outside.
 *
 * The one impure part of this feature, kept as small as it can possibly be:
 * one GET, one parse, one cache. Everything that decides how the city *looks*
 * is in `report.ts` and is a pure function of what comes back.
 *
 * ## It has to be allowed to fail
 *
 * Exactly like `net/transport.ts`, and for the same reason. A player on a
 * plane, behind a corporate proxy, on a phone that has just lost signal, or in
 * a browser extension's blocklist must get San Francisco anyway — so nothing
 * here ever rejects. A failure resolves to `estimateReport()`, the world gets
 * a plausible sky for the month and the hour, and the HUD says "estimated"
 * rather than pretending.
 *
 * That path is not hypothetical and it is not rare: this was written in a
 * sandbox whose egress proxy answers 403 to CONNECT for every weather host
 * there is, so the fallback is the only branch that could be exercised here at
 * all. Which is a good argument for it being the *good* branch rather than an
 * error screen.
 *
 * ## Why Open-Meteo
 *
 * No API key. A key would mean either shipping a secret in a bundle anybody
 * can read, or standing up an edge function and a cache for a number that
 * changes four times an hour. It is CORS-open, it serves NOAA's model for a US
 * point, and it is free for non-commercial use.
 */
import { estimateReport, parseOpenMeteo, type WeatherReport } from "./report";

/** Downtown San Francisco. Two decimals is ~1 km, which is all the model has. */
const LAT = 37.77;
const LON = -122.42;

const FIELDS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation",
  "weather_code",
  "cloud_cover",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "is_day",
].join(",");

export const WEATHER_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
  `&current=${FIELDS}&timezone=America%2FLos_Angeles`;

/** Give up on a slow network rather than leaving the sky undecided. */
const TIMEOUT_MS = 7000;

/** How stale a cached observation may be before it is worth asking again. */
export const MAX_AGE_MS = 12 * 60 * 1000;

/** How often the running game re-asks. */
export const REFRESH_MS = 10 * 60 * 1000;

const CACHE_KEY = "sf.weather.v1";

/* ------------------------------------------------------------------ *
 * A very small store
 * ------------------------------------------------------------------ */

let current: WeatherReport | null = null;
const listeners = new Set<() => void>();

/** The report in force, or null before the first one lands. */
export function currentReport(): WeatherReport | null {
  return current;
}

/** Publish a report. Exported so the debug hook can force weather. */
export function setReport(r: WeatherReport): void {
  current = r;
  for (const fn of listeners) fn();
}

export function subscribeWeather(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

function readCache(): WeatherReport | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as WeatherReport;
    if (typeof r?.tempC !== "number" || !Number.isFinite(r.tempC)) return null;
    if (Date.now() - r.at > MAX_AGE_MS) return null;
    return r;
  } catch {
    // Private mode, a locked-down browser, a corrupted entry. Ask again.
    return null;
  }
}

function writeCache(r: WeatherReport): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(r));
  } catch {
    /* Storage full or refused. The report still works this session. */
  }
}

/* ------------------------------------------------------------------ *
 * The fetch
 * ------------------------------------------------------------------ */

/**
 * Fetch once. Never rejects.
 *
 * `force` skips the cache — used by the refresh timer, which wants the newest
 * observation rather than the one it stored ten minutes ago.
 */
export async function fetchWeather(force = false): Promise<WeatherReport> {
  if (!force) {
    const cached = readCache();
    if (cached) {
      setReport(cached);
      return cached;
    }
  }

  // `AbortController` rather than a `Promise.race`: a race leaves the request
  // running, and a phone on a dying connection would accumulate one hanging
  // socket every ten minutes for as long as the tab is open.
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;

  try {
    const res = await fetch(WEATHER_URL, {
      signal: ctl?.signal,
      // No credentials, no cookies, nothing of ours goes to a third party.
      credentials: "omit",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`weather ${res.status}`);
    const parsed = parseOpenMeteo(await res.json());
    if (!parsed) throw new Error("weather: unrecognised response");
    writeCache(parsed);
    setReport(parsed);
    return parsed;
  } catch {
    /* Offline, blocked, timed out, or the shape changed under us. A stale
       cached reading is still a real observation and beats a guess, so it is
       preferred over climatology even past its refresh age. */
    let stale: WeatherReport | null = null;
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const r = JSON.parse(raw) as WeatherReport;
        if (typeof r?.tempC === "number" && Number.isFinite(r.tempC)) stale = r;
      }
    } catch {
      /* nothing */
    }
    const fallback = stale ?? estimateReport();
    setReport(fallback);
    return fallback;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Keep asking for as long as the game is running. Returns the stopper.
 *
 * Refreshes on `visibilitychange` too: a tab left open overnight and come back
 * to should not still be showing yesterday afternoon.
 */
export function startWeatherPolling(): () => void {
  let stopped = false;
  void fetchWeather();

  const tick = setInterval(() => {
    if (!stopped) void fetchWeather(true);
  }, REFRESH_MS);

  const onVisible = () => {
    if (stopped || document.visibilityState !== "visible") return;
    const r = currentReport();
    if (!r || Date.now() - r.at > MAX_AGE_MS) void fetchWeather(true);
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    stopped = true;
    clearInterval(tick);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
