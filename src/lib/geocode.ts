// Tiny geocoding helper. We use OpenStreetMap's Nominatim because
// Mapbox's Geocoding API doesn't have small-town POIs like
// "Healdsburg Plaza" or "CraftWork" mapped — Nominatim does.
//
// Results are cached in localStorage so the same query never hits
// the network twice. A 1s in-memory throttle keeps us well within
// Nominatim's usage policy (1 req/sec).
//
// Usage:
//   const coord = await geocode("Healdsburg Plaza");
//   if (coord) console.log(coord.lng, coord.lat);

export type Coord = { lng: number; lat: number; displayName: string };

const CACHE_KEY = "geocode.cache.v1";
let lastRequestAt = 0;

function readCache(): Record<string, Coord> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, Coord>;
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, Coord>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota exceeded — ignore */
  }
}

export async function geocode(query: string): Promise<Coord | null> {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  const cache = readCache();
  if (cache[key]) return cache[key];

  // Throttle: at most 1 request per 1.1s.
  const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  try {
    const res = await fetch(url, {
      headers: { "Accept-Language": "en" },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
    }>;
    const first = rows[0];
    if (!first) return null;
    const coord: Coord = {
      lat: Number(first.lat),
      lng: Number(first.lon),
      displayName: first.display_name,
    };
    cache[key] = coord;
    writeCache(cache);
    return coord;
  } catch {
    return null;
  }
}
