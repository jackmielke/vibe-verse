/**
 * Seattle, in metres.
 *
 * Everything in this file is real. The lake outlines are traced from their
 * actual shorelines, the towers are at their actual addresses with their actual
 * heights, the runways point where the runways point, and Mount Rainier is 94
 * kilometres away on a bearing of 153°, which is why it sits exactly where it
 * sits in every photograph anyone has ever taken of this city.
 *
 * That accuracy is not pedantry — it is the whole reason the world reads as
 * Seattle from 3,000 feet. A skyline with the right buildings in the wrong
 * places looks like a generic city. The Needle north-west of downtown, the two
 * floating bridges lying parallel across the lake, Mercer Island filling the
 * gap between them, Rainier over your right shoulder on the southbound run:
 * get those five things right and the rest can be procedural.
 *
 * ## Projection
 * A local tangent plane at 47.6062 N, 122.3321 W (downtown). Good to a metre
 * or so over the 44 km box, which is far better than the source data.
 *
 *   +X is east, -Z is north, +Y is up.
 *
 * ## Datums
 * Puget Sound is 0 m. Lake Washington, Lake Union and the Ship Canal sit at
 * +4.9 m (the locks at Ballard are what hold them there). Green Lake is at
 * +21 m. Those three numbers are why the Montlake Cut has current in it.
 */
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export const ORIGIN_LAT = 47.6062;
export const ORIGIN_LON = -122.3321;

/** Metres per degree at 47.6° N, WGS84. */
const M_PER_LAT = 111182.5;
const M_PER_LON = 75128.0;

/** Half-extent of the modelled terrain box, metres. 44 km on a side. */
export const EXTENT = 22000;

export const SEA_LEVEL = 0;
export const LAKE_LEVEL = 4.9;
export const GREEN_LAKE_LEVEL = 21;

export type LatLon = readonly [number, number];

/** World X (east) for a longitude. */
export function lonToX(lon: number): number {
  return (lon - ORIGIN_LON) * M_PER_LON;
}

/** World Z for a latitude. North is -Z, so this negates. */
export function latToZ(lat: number): number {
  return -(lat - ORIGIN_LAT) * M_PER_LAT;
}

export function project(p: LatLon, out = new THREE.Vector2()): THREE.Vector2 {
  return out.set(lonToX(p[1]), latToZ(p[0]));
}

/** Project a whole ring of lat/lon into a flat [x,z,x,z,…] array. */
export function projectRing(ring: readonly LatLon[]): Float64Array {
  const out = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    out[i * 2] = lonToX(ring[i][1]);
    out[i * 2 + 1] = latToZ(ring[i][0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Water bodies
// ---------------------------------------------------------------------------

/**
 * Lake Washington. 35 km long, never more than 4 km wide, and the reason this
 * city has an air show: it is a natural amphitheatre with a grandstand on one
 * side and an island on the other.
 */
export const LAKE_WASHINGTON: LatLon[] = [
  // West shore, north to south
  [47.7565, -122.2665], // north tip at Kenmore, mouth of the Sammamish
  [47.753, -122.278], // Lake Forest Park
  [47.742, -122.274],
  [47.728, -122.2725],
  [47.71, -122.2735],
  [47.697, -122.2725], // Matthews Beach
  [47.69, -122.262],
  [47.6845, -122.2455], // Sand Point — Magnuson Park
  [47.679, -122.253],
  [47.674, -122.261],
  [47.666, -122.27],
  [47.6595, -122.2745], // Webster Point, mouth of Union Bay
  [47.654, -122.28],
  [47.647, -122.279],
  [47.6415, -122.2745], // Foster Island, SR-520 west landing
  [47.636, -122.2765], // Madison Park
  [47.625, -122.279], // Denny Blaine
  [47.611, -122.282], // Madrona
  [47.602, -122.2845], // Leschi
  [47.59, -122.2845], // I-90 west portal, Mount Baker
  [47.585, -122.2835], // Colman Park
  [47.5687, -122.2718], // Stan Sayres Memorial Park — the hydro pits
  [47.5595, -122.2665], // Genesee Park — show centre
  [47.5545, -122.26],
  [47.5495, -122.2495], // Bailey Peninsula / Seward Park tip
  [47.549, -122.26], // Andrews Bay
  [47.54, -122.261],
  [47.532, -122.26],
  [47.524, -122.257], // Rainier Beach
  [47.518, -122.244],
  [47.509, -122.232],
  [47.504, -122.2205], // mouth of the Cedar River
  [47.501, -122.2135], // Renton
  // East shore, south to north
  [47.505, -122.202], // Gene Coulon Park
  [47.523, -122.1985],
  [47.557, -122.2005], // Newcastle Beach
  [47.579, -122.196],
  [47.586, -122.193], // Mercer Slough
  [47.5865, -122.201], // Enatai
  [47.5865, -122.2085], // Beaux Arts
  [47.59, -122.214], // East Channel Bridge east landing
  [47.599, -122.2115],
  [47.6115, -122.21], // Meydenbauer Bay, Bellevue
  [47.62, -122.217],
  [47.628, -122.232], // Medina
  [47.64, -122.244], // Evergreen Point — SR-520 east landing
  [47.644, -122.228], // Hunts Point
  [47.651, -122.22], // Yarrow Point
  [47.66, -122.2065], // Houghton
  [47.676, -122.21], // downtown Kirkland
  [47.7, -122.217], // Juanita Bay
  [47.706, -122.224],
  [47.722, -122.234],
  [47.735, -122.245],
];

/** Mercer Island — a hole in the lake, and the east wall of the show box. */
export const MERCER_ISLAND: LatLon[] = [
  [47.5895, -122.2555], // NW, where I-90 lands
  [47.581, -122.2525],
  [47.57, -122.249],
  [47.557, -122.2455],
  [47.544, -122.242],
  [47.533, -122.238],
  [47.525, -122.231], // south tip
  [47.529, -122.223],
  [47.54, -122.218],
  [47.554, -122.214],
  [47.57, -122.211],
  [47.583, -122.211],
  [47.5905, -122.214], // East Channel Bridge
  [47.598, -122.221],
  [47.6035, -122.233], // north tip
  [47.6, -122.245],
];

/** Bailey Peninsula — Seward Park's forested thumb sticking into the lake. */
export const SEWARD_PARK: LatLon[] = [
  [47.5545, -122.26],
  [47.5565, -122.2545],
  [47.5555, -122.2485],
  [47.5515, -122.2455],
  [47.5478, -122.2495],
  [47.5478, -122.2565],
  [47.5505, -122.2605],
];

/** Lake Union — the float-plane pond with a city built around it. */
export const LAKE_UNION: LatLon[] = [
  [47.6265, -122.337],
  [47.628, -122.327],
  [47.634, -122.3255],
  [47.644, -122.329],
  [47.6465, -122.334], // Gas Works Park on the north shore
  [47.648, -122.342],
  [47.645, -122.346],
  [47.64, -122.343],
  [47.632, -122.342],
];

/**
 * The Ship Canal, as a chain of segments rather than a polygon.
 *
 * It is 60 to 100 metres wide over eight kilometres, which no polygon in this
 * file has the resolution to describe honestly. The terrain builder widens
 * these into a channel instead, which is also how it gets the Montlake Cut —
 * a thousand metres of dead-straight canyon with Husky Stadium on the bank,
 * and the best low pass in the world.
 */
export const SHIP_CANAL: LatLon[] = [
  [47.6656, -122.3972], // Ballard Locks
  [47.665, -122.386], // Salmon Bay
  [47.6585, -122.3765], // Ballard Bridge
  [47.654, -122.366],
  [47.651, -122.356], // Fremont Cut, dead straight
  [47.6478, -122.3496], // Fremont Bridge
  [47.647, -122.334], // into Lake Union
  [47.647, -122.326],
  [47.651, -122.3215],
  [47.6533, -122.3205], // University Bridge
  [47.651, -122.314], // Portage Bay
  [47.648, -122.308],
  [47.6465, -122.3055], // Montlake Cut, west end
  [47.647, -122.304], // Montlake Bridge
  [47.6472, -122.2965], // Montlake Cut, east end
  [47.65, -122.288], // Union Bay
  [47.656, -122.28],
  [47.6595, -122.2745], // Webster Point
];

export const GREEN_LAKE: LatLon[] = [
  [47.6875, -122.339],
  [47.685, -122.3315],
  [47.6805, -122.329],
  [47.6755, -122.3315],
  [47.6725, -122.339],
  [47.6755, -122.3455],
  [47.6825, -122.345],
];

/**
 * Puget Sound. The east edge is the real Seattle shoreline; the west, north
 * and south edges are simply the edge of the world.
 */
export const PUGET_SOUND: LatLon[] = [
  [47.81, -122.46], // off the top of the box
  [47.687, -122.406], // Golden Gardens
  [47.679, -122.409], // Shilshole
  [47.6656, -122.3972], // Ballard Locks
  [47.662, -122.4357], // West Point Light, Discovery Park
  [47.648, -122.42], // Magnolia Bluff
  [47.638, -122.403],
  [47.632, -122.3835], // Smith Cove
  [47.6295, -122.376], // Pier 91
  [47.6215, -122.362], // Myrtle Edwards
  [47.6115, -122.348], // Bell Harbor
  [47.6061, -122.3425], // Pier 57, the Great Wheel
  [47.602, -122.339], // Colman Dock
  [47.595, -122.34],
  [47.59, -122.345], // Harbor Island
  [47.586, -122.352], // mouth of the Duwamish
  [47.5905, -122.38], // Duwamish Head
  [47.586, -122.396],
  [47.581, -122.409], // Alki Beach
  [47.5762, -122.4202], // Alki Point Light
  [47.556, -122.411],
  [47.53, -122.395], // Fauntleroy
  [47.5, -122.39],
  [47.42, -122.42], // off the bottom of the box
  [47.4, -122.62],
  [47.82, -122.62],
];

/** Bainbridge Island — the shape on the horizon behind every ferry photo. */
export const BAINBRIDGE: LatLon[] = [
  [47.715, -122.545],
  [47.7, -122.49],
  [47.66, -122.475],
  [47.625, -122.485],
  [47.59, -122.52],
  [47.6, -122.57],
  [47.66, -122.585],
  [47.7, -122.575],
];

export const VASHON: LatLon[] = [
  [47.498, -122.465],
  [47.47, -122.43],
  [47.4, -122.44],
  [47.38, -122.49],
  [47.42, -122.52],
  [47.47, -122.51],
];

/** Every water polygon, with the height its surface sits at. */
export interface WaterBody {
  name: string;
  outline: LatLon[];
  holes: LatLon[][];
  level: number;
  /** How deep it gets, metres below the surface, well away from shore. */
  depth: number;
  /** Deep-water colour. */
  color: number;
}

export const WATER_BODIES: WaterBody[] = [
  {
    name: "Puget Sound",
    outline: PUGET_SOUND,
    holes: [BAINBRIDGE, VASHON],
    level: SEA_LEVEL,
    depth: 180,
    color: 0x14384f,
  },
  {
    name: "Lake Washington",
    outline: LAKE_WASHINGTON,
    holes: [MERCER_ISLAND, SEWARD_PARK],
    level: LAKE_LEVEL,
    depth: 62,
    color: 0x17415a,
  },
  {
    name: "Lake Union",
    outline: LAKE_UNION,
    holes: [],
    level: LAKE_LEVEL,
    depth: 15,
    color: 0x1b4a60,
  },
  {
    name: "Green Lake",
    outline: GREEN_LAKE,
    holes: [],
    level: GREEN_LAKE_LEVEL,
    depth: 8,
    color: 0x1f5563,
  },
];

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/**
 * Seattle's hills, as Gaussian bumps.
 *
 * The city is a set of north-south glacial drumlins with troughs between them,
 * and from the air that ridge-and-valley grain is more recognisable than any
 * single hill. The city's true high point is 158 m, in West Seattle — this is
 * a place with a lot of relief for somewhere that reads as flat on a map.
 */
export interface Hill {
  at: LatLon;
  height: number;
  /** Gaussian sigma, metres. */
  sigma: number;
  /** Stretch along north-south, since the drumlins are ridges not cones. */
  stretch?: number;
}

export const HILLS: Hill[] = [
  { at: [47.5495, -122.376], height: 158, sigma: 1500, stretch: 1.5 }, // West Seattle
  { at: [47.637, -122.357], height: 141, sigma: 900 }, // Queen Anne
  { at: [47.63, -122.3155], height: 140, sigma: 1100, stretch: 1.6 }, // Capitol Hill
  { at: [47.648, -122.4], height: 119, sigma: 1200 }, // Magnolia
  { at: [47.579, -122.311], height: 111, sigma: 1400, stretch: 2.2 }, // Beacon Hill
  { at: [47.608, -122.323], height: 96, sigma: 700 }, // First Hill
  { at: [47.67, -122.355], height: 107, sigma: 1400, stretch: 1.8 }, // Phinney Ridge
  { at: [47.7, -122.317], height: 128, sigma: 1600, stretch: 1.5 }, // Maple Leaf
  { at: [47.69, -122.29], height: 84, sigma: 1500 }, // View Ridge
  { at: [47.66, -122.29], height: 62, sigma: 900 }, // Laurelhurst
  { at: [47.567, -122.29], height: 92, sigma: 1000 }, // Mount Baker ridge
  { at: [47.545, -122.28], height: 88, sigma: 1300 }, // Columbia City / Hillman
  { at: [47.57, -122.232], height: 66, sigma: 1400 }, // Mercer Island spine
  { at: [47.615, -122.18], height: 74, sigma: 2200 }, // Bellevue plateau
  { at: [47.62, -122.13], height: 132, sigma: 3000 }, // Redmond ridge
  { at: [47.545, -122.15], height: 210, sigma: 3200 }, // Newcastle / Somerset
  { at: [47.532, -122.103], height: 486, sigma: 4200 }, // Cougar Mountain
  { at: [47.49, -122.05], height: 640, sigma: 5000 }, // Squak / Tiger foothills
  { at: [47.45, -122.28], height: 132, sigma: 3000 }, // SeaTac plateau
  { at: [47.66, -122.19], height: 96, sigma: 2000 }, // Kirkland
  { at: [47.74, -122.24], height: 88, sigma: 2400 }, // Bothell
  { at: [47.72, -122.35], height: 116, sigma: 2600 }, // Shoreline
  { at: [47.63, -122.5], height: 140, sigma: 3400 }, // Bainbridge
  { at: [47.43, -122.47], height: 110, sigma: 3200 }, // Vashon
];

/**
 * The industrial trough. Between Beacon Hill and West Seattle the ground is
 * dead flat at three metres for eight kilometres — the Duwamish valley, SODO,
 * Harbor Island. Leaving the Gaussians to fill it in produces a gentle valley
 * where there should be a table, and that one wrong note is enough to make the
 * whole south end stop looking like Seattle.
 */
export interface FlatZone {
  min: LatLon;
  max: LatLon;
  height: number;
  feather: number;
}

export const FLATS: FlatZone[] = [
  { min: [47.5, -122.36], max: [47.595, -122.315], height: 4, feather: 700 }, // Duwamish / SODO
  { min: [47.62, -122.395], max: [47.655, -122.372], height: 6, feather: 400 }, // Interbay
  { min: [47.598, -122.345], max: [47.618, -122.332], height: 22, feather: 500 }, // downtown shelf
  { min: [47.485, -122.23], max: [47.51, -122.19], height: 8, feather: 500 }, // Renton flats
];

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

export type LandmarkKind =
  | "needle"
  | "tower"
  | "stadium"
  | "arena"
  | "wheel"
  | "gasworks"
  | "lighthouse"
  | "locks"
  | "museum"
  | "market"
  | "park";

export interface Landmark {
  id: string;
  name: string;
  at: LatLon;
  /** Structure height above its own base, metres. */
  height: number;
  kind: LandmarkKind;
  /** Footprint radius or half-width, metres. */
  radius?: number;
  /** Shown when you fly close — the Easter-egg layer reads this. */
  note?: string;
}

/**
 * The radius of the vertical cylinder a jet is not allowed inside.
 *
 * Deliberately coarse: a landmark's collision hull is one cylinder, not the
 * dozen primitives it is drawn from. A Space Needle modelled to the metre
 * would mean flying between its three legs at 400 knots and calling it a near
 * miss, and nobody watching would agree with the game about what happened.
 * Round numbers you can see from a mile out are the right amount of accuracy.
 *
 * Parks and the locks are flat, so they get nothing — their `height` is
 * scenery, not structure, and a no-fly cylinder over Discovery Park would be
 * absurd. The callers skip anything that returns zero.
 */
export function landmarkHull(lm: Landmark): number {
  switch (lm.kind) {
    case "needle":
      // Wide enough to include the saucer, which is the bit you aim at.
      return 24;
    case "tower":
      return (lm.radius ?? 24) * 1.15;
    case "wheel":
      return lm.radius ?? 32;
    case "gasworks":
    case "lighthouse":
    case "museum":
    case "market":
      return lm.radius ?? 22;
    case "stadium":
    case "arena":
      return lm.radius ?? 120;
    default:
      return 0;
  }
}

export const LANDMARKS: Landmark[] = [
  {
    id: "needle",
    name: "Space Needle",
    at: [47.62042, -122.34936],
    height: 184.4,
    kind: "needle",
    note: "Built for the 1962 World's Fair in under a year. The observation deck is at 158 m.",
  },
  {
    id: "columbia",
    name: "Columbia Center",
    at: [47.60453, -122.33069],
    height: 284,
    kind: "tower",
    radius: 32,
    note: "933 feet, 76 floors, and still the tallest building in the state.",
  },
  {
    id: "rainier-square",
    name: "Rainier Square Tower",
    at: [47.6092, -122.33497],
    height: 260,
    kind: "tower",
    radius: 28,
  },
  { id: "1201third", name: "1201 Third Avenue", at: [47.60722, -122.33611], height: 235, kind: "tower", radius: 26 },
  { id: "muni", name: "Seattle Municipal Tower", at: [47.6045, -122.33], height: 220, kind: "tower", radius: 24 },
  { id: "two-union", name: "Two Union Square", at: [47.6106, -122.3325], height: 226, kind: "tower", radius: 25 },
  { id: "f5", name: "F5 Tower", at: [47.6107, -122.3372], height: 201, kind: "tower", radius: 22 },
  {
    id: "smith",
    name: "Smith Tower",
    at: [47.60222, -122.33167],
    height: 148.6,
    kind: "tower",
    radius: 17,
    note: "1914, and the tallest building west of the Mississippi for half a century.",
  },
  {
    id: "wheel",
    name: "Seattle Great Wheel",
    at: [47.6061, -122.3425],
    height: 53.3,
    kind: "wheel",
    radius: 26,
    note: "Pier 57. 175 feet of ferris wheel hanging out over Elliott Bay.",
  },
  {
    id: "market",
    name: "Pike Place Market",
    at: [47.60944, -122.34167],
    height: 22,
    kind: "market",
    radius: 60,
    note: "The neon sign has said PUBLIC MARKET CENTER since 1937.",
  },
  {
    id: "lumen",
    name: "Lumen Field",
    at: [47.5952, -122.3316],
    height: 70,
    kind: "stadium",
    radius: 130,
    note: "Loudest stadium in the world, twice over. Try not to wake them.",
  },
  { id: "tmobile", name: "T-Mobile Park", at: [47.5914, -122.3325], height: 65, kind: "stadium", radius: 125 },
  {
    id: "climate",
    name: "Climate Pledge Arena",
    at: [47.622, -122.3541],
    height: 40,
    kind: "arena",
    radius: 90,
    note: "The 1962 roof was kept and the entire building rebuilt underneath it.",
  },
  {
    id: "husky",
    name: "Husky Stadium",
    at: [47.6503, -122.3016],
    height: 58,
    kind: "stadium",
    radius: 120,
    note: "The only stadium in the country you can sail to. Go Dawgs.",
  },
  {
    id: "gasworks",
    name: "Gas Works Park",
    at: [47.64686, -122.33391],
    height: 26,
    kind: "gasworks",
    radius: 55,
    note: "A coal gasification plant that nobody had the heart to tear down.",
  },
  {
    id: "westpoint",
    name: "West Point Light",
    at: [47.66198, -122.43574],
    height: 9,
    kind: "lighthouse",
    radius: 6,
  },
  { id: "alki-light", name: "Alki Point Light", at: [47.57605, -122.42024], height: 11, kind: "lighthouse", radius: 6 },
  {
    id: "locks",
    name: "Ballard Locks",
    at: [47.66556, -122.39722],
    height: 12,
    kind: "locks",
    radius: 60,
    note: "Six and a half metres of lift, and the only reason the lakes are fresh.",
  },
  {
    id: "moflight",
    name: "Museum of Flight",
    at: [47.518, -122.297],
    height: 28,
    kind: "museum",
    radius: 90,
    note: "A Concorde, an SR-71 and the first Air Force One, all parked on the ramp below you.",
  },
  { id: "kerry", name: "Kerry Park", at: [47.62944, -122.36], height: 4, kind: "park", radius: 30 },
  { id: "seward", name: "Seward Park", at: [47.555, -122.25], height: 8, kind: "park", radius: 200 },
  { id: "magnuson", name: "Magnuson Park", at: [47.6808, -122.2481], height: 4, kind: "park", radius: 300 },
  { id: "bellevue600", name: "Bellevue 600", at: [47.61583, -122.195], height: 180, kind: "tower", radius: 24 },
  { id: "bellevue555", name: "555 Tower", at: [47.6155, -122.1942], height: 180, kind: "tower", radius: 23 },
  { id: "bellevue-towers", name: "Bellevue Towers", at: [47.61389, -122.19806], height: 137, kind: "tower", radius: 21 },
  { id: "citycenter", name: "City Center Bellevue", at: [47.61528, -122.19583], height: 109, kind: "tower", radius: 20 },
];

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

export interface Bridge {
  id: string;
  name: string;
  from: LatLon;
  to: LatLon;
  /** Deck height above the water it crosses, metres. */
  deck: number;
  width: number;
  /** Two parallel decks this far apart, metres. 0 = single deck. */
  twin: number;
  /** A raised hump this many metres higher, in the middle third. */
  hump: number;
  note?: string;
}

export const BRIDGES: Bridge[] = [
  {
    id: "i90",
    name: "I-90 Floating Bridges",
    from: [47.5903, -122.2836],
    to: [47.5895, -122.2568],
    deck: 2.6,
    width: 26,
    twin: 32,
    hump: 0,
    note: "Two parallel floating bridges, 2 km of concrete pontoons riding on 60 m of water.",
  },
  {
    id: "sr520",
    name: "SR-520 Evergreen Point Bridge",
    from: [47.6415, -122.2745],
    to: [47.64, -122.244],
    deck: 2.4,
    width: 35,
    twin: 0,
    hump: 0,
    note: "2,350 m of pontoons — the longest floating bridge on Earth.",
  },
  {
    id: "east-channel",
    name: "East Channel Bridge",
    from: [47.59, -122.214],
    to: [47.59, -122.201],
    deck: 20,
    width: 24,
    twin: 0,
    hump: 6,
  },
  {
    id: "west-seattle",
    name: "West Seattle Bridge",
    from: [47.5715, -122.3345],
    to: [47.5712, -122.3665],
    deck: 24,
    width: 22,
    twin: 0,
    hump: 20,
    note: "43 m of clearance over the Duwamish. Threading it is worth extra.",
  },
  {
    id: "aurora",
    name: "Aurora Bridge",
    from: [47.6435, -122.3475],
    to: [47.6515, -122.3474],
    deck: 50,
    width: 18,
    twin: 0,
    hump: 4,
    note: "The George Washington Memorial Bridge. There is a troll under the north end.",
  },
  {
    id: "ballard-br",
    name: "Ballard Bridge",
    from: [47.6555, -122.3766],
    to: [47.6618, -122.3764],
    deck: 14,
    width: 14,
    twin: 0,
    hump: 3,
  },
  {
    id: "fremont-br",
    name: "Fremont Bridge",
    from: [47.6462, -122.3497],
    to: [47.6496, -122.3496],
    deck: 9,
    width: 14,
    twin: 0,
    hump: 0,
    note: "The most-opened drawbridge in the United States. Currently closed. Probably.",
  },
  {
    id: "montlake-br",
    name: "Montlake Bridge",
    from: [47.6455, -122.3041],
    to: [47.6487, -122.304],
    deck: 12,
    width: 14,
    twin: 0,
    hump: 0,
  },
  {
    id: "university-br",
    name: "University Bridge",
    from: [47.6515, -122.3207],
    to: [47.6553, -122.3204],
    deck: 13,
    width: 14,
    twin: 0,
    hump: 0,
  },
];

// ---------------------------------------------------------------------------
// Airports
// ---------------------------------------------------------------------------

export interface Runway {
  id: string;
  /** Threshold you land on when using this name. */
  from: LatLon;
  to: LatLon;
  /** Metres. */
  width: number;
  elevation: number;
}

export interface Airport {
  icao: string;
  name: string;
  elevation: number;
  runways: Runway[];
  note?: string;
}

export const AIRPORTS: Airport[] = [
  {
    icao: "KBFI",
    name: "Boeing Field",
    elevation: 6.4,
    note: "Where the team parks for Seafair. 5.2 km from show centre on a 035 heading.",
    runways: [
      { id: "14R/32L", from: [47.5429, -122.309], to: [47.5171, -122.2948], width: 61, elevation: 6.4 },
      { id: "14L/32R", from: [47.5378, -122.304], to: [47.528, -122.2988], width: 30, elevation: 6.4 },
    ],
  },
  {
    icao: "KRNT",
    name: "Renton Municipal",
    elevation: 9.8,
    note: "Runway 16's threshold is at the water's edge. Every 737 ever built rolled out here.",
    runways: [{ id: "16/34", from: [47.5005, -122.2166], to: [47.4857, -122.215], width: 61, elevation: 9.8 }],
  },
  {
    icao: "KSEA",
    name: "Seattle-Tacoma International",
    elevation: 132,
    runways: [
      { id: "16L/34R", from: [47.46379, -122.3062], to: [47.43117, -122.3062], width: 46, elevation: 132 },
      { id: "16C/34C", from: [47.4637, -122.3094], to: [47.4378, -122.3094], width: 46, elevation: 132 },
      { id: "16R/34L", from: [47.465, -122.3195], to: [47.4417, -122.3195], width: 46, elevation: 132 },
    ],
  },
];

// ---------------------------------------------------------------------------
// The show
// ---------------------------------------------------------------------------

/**
 * Seafair. The box is the real regulated area from 33 CFR 100.1301: bounded by
 * the I-90 bridges to the north, the Seattle shore to the west, and a line
 * tangent to Bailey Peninsula to the south.
 */
export const SHOW_CENTRE: LatLon = [47.564, -122.265];
export const SHOW_BOX = {
  north: 47.59,
  south: 47.552,
  west: -122.2795,
  east: -122.2495,
};
/** Show line axis, true degrees. Runs with the lake, NNW to SSE. */
export const SHOW_LINE_HEADING = 340;
/** Where the crowd is — the Seattle shore from the pits down to Seward Park. */
export const CROWD_LINE: LatLon[] = [
  [47.5687, -122.2718],
  [47.5638, -122.2685],
  [47.5595, -122.2665],
  [47.5545, -122.26],
  [47.552, -122.257],
];
/** The hydroplane course: a 3.2 km oval inside the log booms. */
export const HYDRO_COURSE = {
  centre: [47.568, -122.262] as LatLon,
  halfLength: 1250,
  halfWidth: 350,
  /** Course long axis, degrees true. */
  heading: 342,
};

// ---------------------------------------------------------------------------
// The mountains
// ---------------------------------------------------------------------------

export interface Peak {
  name: string;
  at: LatLon;
  height: number;
  /** Base radius of the cone, metres. */
  radius: number;
  /** Snow line, metres. */
  snow: number;
}

/**
 * These sit outside the terrain box entirely and are drawn as their own
 * geometry. Rainier subtends two and a half degrees of sky from downtown; it
 * is not scenery, it is a character in the story, and every Seattle pilot
 * navigates by it whether they mean to or not.
 */
export const PEAKS: Peak[] = [
  { name: "Mount Rainier", at: [46.8523, -121.7603], height: 4392, radius: 21000, snow: 2100 },
  { name: "Mount Baker", at: [48.7768, -121.8145], height: 3286, radius: 14000, snow: 1900 },
  { name: "Glacier Peak", at: [48.1125, -121.1132], height: 3213, radius: 12000, snow: 2000 },
  { name: "Mount Adams", at: [46.2024, -121.4909], height: 3743, radius: 16000, snow: 2200 },
  { name: "Mount St Helens", at: [46.1912, -122.1944], height: 2549, radius: 11000, snow: 2000 },
  { name: "Mount Olympus", at: [47.8014, -123.71], height: 2432, radius: 15000, snow: 1700 },
  { name: "The Brothers", at: [47.6533, -123.1436], height: 2048, radius: 9000, snow: 1600 },
  { name: "Mount Si", at: [47.4879, -121.7233], height: 1265, radius: 7000, snow: 3000 },
  { name: "Mount Constance", at: [47.7561, -123.1631], height: 2333, radius: 9000, snow: 1650 },
];

/** Ridge lines for the two ranges, so the horizon is not just isolated cones. */
export interface Ridge {
  name: string;
  points: LatLon[];
  height: number;
  variance: number;
  width: number;
}

export const RIDGES: Ridge[] = [
  {
    name: "Olympics",
    points: [
      [48.1, -123.3],
      [47.95, -123.5],
      [47.8, -123.6],
      [47.65, -123.4],
      [47.5, -123.2],
      [47.35, -123.05],
    ],
    height: 1750,
    variance: 520,
    width: 16000,
  },
  {
    name: "Cascades",
    points: [
      [48.6, -121.5],
      [48.3, -121.4],
      [48.0, -121.4],
      [47.7, -121.4],
      [47.4, -121.4],
      [47.1, -121.5],
      [46.8, -121.5],
    ],
    height: 1850,
    variance: 480,
    width: 22000,
  },
  {
    name: "Cascade foothills",
    points: [
      [47.9, -121.9],
      [47.7, -121.85],
      [47.5, -121.85],
      [47.3, -121.9],
    ],
    height: 900,
    variance: 260,
    width: 9000,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True heading, degrees, from one world XZ to another. */
export function headingBetween(x0: number, z0: number, x1: number, z1: number): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  return (Math.atan2(dx, -dz) * 180) / Math.PI;
}

/** Convert a compass heading in degrees to the world-space yaw the sim uses. */
export function headingToRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Magnetic variation at Seattle, 2026. Runway numbers are magnetic; the HUD
 * heading tape is magnetic; everything the physics does is true. This is the
 * bridge between them.
 */
export const MAGNETIC_VARIATION = 15.5;

export function trueToMagnetic(trueDeg: number): number {
  return (trueDeg - MAGNETIC_VARIATION + 360) % 360;
}
