/**
 * The Globetrotter deck — real places on the real Earth.
 *
 * Three tiers, drawn together so a run mixes "oh I know this" with
 * "I have no idea":
 *   hub      — the Vibe network's own footprint (SF, Lisbon, Vermont,
 *              Patagonia, Edge Esmeralda). Landing on one of these is
 *              the whole point: the studio's map IS the game board.
 *   landmark — globally famous, gettable from the skyline alone.
 *   wild     — beautiful and disorienting; you're guessing continents.
 *
 * Every coordinate is a real spot with real satellite imagery. `pitch`
 * and `bearing` frame the opening shot so each drop reads like a
 * postcard rather than a random patch of ground.
 */

export type PlaceTier = "hub" | "landmark" | "wild";

export interface Place {
  id: string;
  /** Revealed only after the guess — never leak it into the DOM early. */
  name: string;
  country: string;
  lat: number;
  lng: number;
  /** Opening camera. zoom ~15-16.5 reads as "standing there". */
  zoom: number;
  pitch: number;
  bearing: number;
  tier: PlaceTier;
  /** Shown on the reveal card — a reason this place is on the board. */
  blurb: string;
}

export const PLACES: Place[] = [
  // ---- The Vibe network's own footprint ----
  {
    id: "edge-esmeralda",
    name: "Healdsburg Plaza · Edge Esmeralda",
    country: "California, USA",
    lat: 38.6108,
    lng: -122.87007,
    zoom: 16.4,
    pitch: 62,
    bearing: 20,
    tier: "hub",
    blurb:
      "The plaza the whole Vibeverse is modeled on — Edge Esmeralda's home block, and the anchor of the city you can walk around in /city.",
  },
  {
    id: "sf-embarcadero",
    name: "The Embarcadero, San Francisco",
    country: "California, USA",
    lat: 37.7955,
    lng: -122.3937,
    zoom: 15.6,
    pitch: 60,
    bearing: 300,
    tier: "hub",
    blurb: "A studio home base — where a lot of this gets built between residencies.",
  },
  {
    id: "lisbon-alfama",
    name: "Alfama, Lisbon",
    country: "Portugal",
    lat: 38.7118,
    lng: -9.1287,
    zoom: 16.2,
    pitch: 65,
    bearing: 145,
    tier: "hub",
    blurb: "The oldest quarter of a studio hub city — tiled roofs all the way down to the Tagus.",
  },
  {
    id: "vermont-burlington",
    name: "Burlington, Vermont",
    country: "Vermont, USA",
    lat: 44.4759,
    lng: -73.2121,
    zoom: 15.2,
    pitch: 58,
    bearing: 270,
    tier: "hub",
    blurb: "Lake Champlain on one side, the Green Mountains on the other. A studio hub, and a quiet one.",
  },
  {
    id: "patagonia-san-martin",
    name: "San Martín de los Andes · Edge City Patagonia",
    country: "Argentina",
    lat: -40.1579,
    lng: -71.3532,
    zoom: 14.6,
    pitch: 70,
    bearing: 45,
    tier: "hub",
    blurb:
      "Lakeside in the Andes — where the Vibe Code Residency ran, and where Pac-Man Patagónico came from.",
  },

  // ---- Famous enough to be gettable ----
  {
    id: "manhattan-central-park",
    name: "Central Park, New York",
    country: "USA",
    lat: 40.7739,
    lng: -73.9712,
    zoom: 14.6,
    pitch: 65,
    bearing: 200,
    tier: "landmark",
    blurb: "843 acres of deliberate wilderness, walled in by one of the densest skylines on Earth.",
  },
  {
    id: "paris-eiffel",
    name: "Champ de Mars, Paris",
    country: "France",
    lat: 48.8566,
    lng: 2.2975,
    zoom: 15.8,
    pitch: 68,
    bearing: 130,
    tier: "landmark",
    blurb: "Built to last twenty years, kept because the radio antenna on top turned out to be useful.",
  },
  {
    id: "venice-grand-canal",
    name: "The Grand Canal, Venice",
    country: "Italy",
    lat: 45.4371,
    lng: 12.3345,
    zoom: 16.0,
    pitch: 60,
    bearing: 25,
    tier: "landmark",
    blurb: "A city built on a hundred small islands, held up by wooden piles driven into the mud.",
  },
  {
    id: "tokyo-shibuya",
    name: "Shibuya, Tokyo",
    country: "Japan",
    lat: 35.6595,
    lng: 139.7004,
    zoom: 16.2,
    pitch: 66,
    bearing: 310,
    tier: "landmark",
    blurb: "Up to three thousand people cross at once. Somehow nobody collides.",
  },
  {
    id: "rio-sugarloaf",
    name: "Sugarloaf Mountain, Rio de Janeiro",
    country: "Brazil",
    lat: -22.9492,
    lng: -43.1545,
    zoom: 14.8,
    pitch: 72,
    bearing: 280,
    tier: "landmark",
    blurb: "A granite monolith at the mouth of Guanabara Bay — the city wrapped around it.",
  },
  {
    id: "sydney-harbour",
    name: "Sydney Harbour",
    country: "Australia",
    lat: -33.8568,
    lng: 151.2153,
    zoom: 15.4,
    pitch: 64,
    bearing: 340,
    tier: "landmark",
    blurb: "The shells of the Opera House were solved by slicing them all from one imaginary sphere.",
  },
  {
    id: "giza",
    name: "The Pyramids of Giza",
    country: "Egypt",
    lat: 29.9773,
    lng: 31.1325,
    zoom: 15.0,
    pitch: 70,
    bearing: 100,
    tier: "landmark",
    blurb: "Four and a half thousand years old, and the suburbs of Cairo now come right up to the fence.",
  },
  {
    id: "hong-kong-victoria",
    name: "Victoria Harbour, Hong Kong",
    country: "China",
    lat: 22.2867,
    lng: 114.1585,
    zoom: 15.2,
    pitch: 66,
    bearing: 20,
    tier: "landmark",
    blurb: "More skyscrapers than any other city on Earth, stacked against a mountain.",
  },

  // ---- Where are you even ----
  {
    id: "iceland-vik",
    name: "Vík í Mýrdal",
    country: "Iceland",
    lat: 63.4187,
    lng: -19.0069,
    zoom: 14.4,
    pitch: 70,
    bearing: 190,
    tier: "wild",
    blurb: "Black sand, green cliffs, and the wettest village in Iceland.",
  },
  {
    id: "namib-sossusvlei",
    name: "Sossusvlei, Namib Desert",
    country: "Namibia",
    lat: -24.7269,
    lng: 15.3486,
    zoom: 13.8,
    pitch: 68,
    bearing: 75,
    tier: "wild",
    blurb: "Dunes up to 300m tall, red from iron oxide that's been oxidizing for a few million years.",
  },
  {
    id: "swiss-lauterbrunnen",
    name: "Lauterbrunnen Valley",
    country: "Switzerland",
    lat: 46.5934,
    lng: 7.9089,
    zoom: 14.6,
    pitch: 74,
    bearing: 180,
    tier: "wild",
    blurb: "Seventy-two waterfalls into one U-shaped glacial trench. Tolkien walked it and drew Rivendell.",
  },
  {
    id: "peru-machu-picchu",
    name: "Machu Picchu",
    country: "Peru",
    lat: -13.1631,
    lng: -72.545,
    zoom: 15.2,
    pitch: 72,
    bearing: 320,
    tier: "wild",
    blurb: "Built without mortar, on a saddle between two peaks, and never found by the Spanish.",
  },
  {
    id: "norway-lofoten",
    name: "Lofoten Islands",
    country: "Norway",
    lat: 68.0875,
    lng: 13.2401,
    zoom: 13.6,
    pitch: 70,
    bearing: 120,
    tier: "wild",
    blurb: "Above the Arctic Circle, and still ice-free all winter thanks to the Gulf Stream.",
  },
  {
    id: "nz-milford",
    name: "Milford Sound",
    country: "New Zealand",
    lat: -44.6414,
    lng: 167.8974,
    zoom: 13.8,
    pitch: 72,
    bearing: 60,
    tier: "wild",
    blurb: "A fjord, not a sound — carved by glaciers, and it rains about 180 days a year.",
  },
  {
    id: "morocco-chefchaouen",
    name: "Chefchaouen",
    country: "Morocco",
    lat: 35.1688,
    lng: -5.2636,
    zoom: 16.0,
    pitch: 66,
    bearing: 240,
    tier: "wild",
    blurb: "The blue city in the Rif Mountains — nobody fully agrees on why it's blue.",
  },
  {
    id: "utah-monument-valley",
    name: "Monument Valley",
    country: "Utah/Arizona, USA",
    lat: 36.9980,
    lng: -110.0985,
    zoom: 14.0,
    pitch: 74,
    bearing: 200,
    tier: "wild",
    blurb: "Sandstone buttes on Navajo land — the visual grammar of basically every Western ever shot.",
  },
];

/** Fisher-Yates over a copy — no seeding, every run is a fresh deck. */
export function dealRounds(n: number): Place[] {
  const deck = [...PLACES];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  // Guarantee at least one studio hub in every run — the network is
  // the point, and a 5-round deal can otherwise miss them entirely.
  const picked = deck.slice(0, n);
  if (!picked.some((p) => p.tier === "hub")) {
    const hub = deck.find((p) => p.tier === "hub");
    if (hub) picked[Math.floor(Math.random() * picked.length)] = hub;
  }
  return picked;
}

/** Great-circle distance in kilometers. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * 5000 points for a bullseye, decaying exponentially with distance.
 * ~2500 at 750km, ~1000 at ~2000km, near zero past 8000km — tuned so a
 * right-continent guess still feels rewarded.
 */
export function scoreFor(distanceKm: number): number {
  return Math.round(5000 * Math.exp(-distanceKm / 1400));
}

export const ROUNDS_PER_GAME = 5;
export const MAX_SCORE = ROUNDS_PER_GAME * 5000;
