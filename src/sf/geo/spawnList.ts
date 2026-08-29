/**
 * Where you can start, and where "Go" can take you.
 *
 * This is a separate module from `sfGeo` on purpose, and the purpose is bundle
 * size. The /sf *page* — the chrome that has to paint before the world does —
 * wants nothing from the geo layer except a list of place names, and importing
 * `sfGeo` to get it would pull a thousand lines of terrain, districts, road
 * network and landmark tables into the eagerly-loaded chunk, undoing the lazy
 * import the page exists to keep. So the places live here in lat/lon, with no
 * dependencies at all, and `sfGeo` is the one that projects them into world
 * metres (see `SPAWNS` there).
 */

export interface SpawnDef {
  key: string;
  name: string;
  /** Real-world position. `market` is the world origin, so it has none. */
  lat?: number;
  lon?: number;
  /** Used when there is no lat/lon: world metres directly. */
  x?: number;
  z?: number;
  /** Height above terrain for the FLYING camera, metres. On foot it is ignored. */
  yOffset: number;
  /**
   * Height above terrain for a WALKING spawn, metres. Almost always absent:
   * on foot you start on the ground, and `yOffset` is deliberately ignored so
   * that "Transamerica" does not drop a character 266 m onto a roof.
   *
   * The exception is a place whose floor is not the terrain. The Terraces put
   * a hundred and ten metres of built structure over the Twin Peaks plateau,
   * so the ground under that spawn is inside the mountain; this is how a spawn
   * says "the deck, not the dirt".
   */
  walkY?: number;
  heading: number;
  blurb: string;
}

export const SPAWN_DEFS: SpawnDef[] = [
  {
    key: "market",
    name: "Market Street",
    x: 0,
    z: 0,
    yOffset: 2,
    heading: 2.4,
    blurb: "Street level, downtown. Start here and walk.",
  },
  {
    key: "union-square",
    name: "Union Square",
    lat: 37.7879,
    lon: -122.4075,
    yOffset: 2,
    heading: 1.2,
    blurb: "The shopping district, the palms and the Dewey column.",
  },
  {
    key: "ferry",
    name: "Ferry Building",
    lat: 37.7955,
    lon: -122.3937,
    yOffset: 2,
    heading: 4.6,
    blurb: "The clock tower and the whole Embarcadero waterfront.",
  },
  {
    key: "chinatown",
    name: "Chinatown Gate",
    lat: 37.7908,
    lon: -122.4056,
    yOffset: 2,
    heading: 3.3,
    blurb: "Grant Avenue, through the paifang and up the hill.",
  },
  {
    key: "lombard",
    name: "Lombard Street",
    lat: 37.8021,
    lon: -122.4187,
    yOffset: 3,
    heading: 1.6,
    blurb: "The crooked block. Walk down the switchbacks.",
  },
  {
    key: "painted-ladies",
    name: "Painted Ladies",
    lat: 37.7763,
    lon: -122.4328,
    yOffset: 2,
    heading: 0.9,
    blurb: "Alamo Square, the row, and the skyline behind it.",
  },
  {
    key: "haight",
    name: "Haight-Ashbury",
    lat: 37.7699,
    lon: -122.4469,
    yOffset: 2,
    heading: 1.5,
    blurb: "The Victorians, and the park at the end of the street.",
  },
  {
    key: "castro",
    name: "The Castro",
    lat: 37.7621,
    lon: -122.4348,
    yOffset: 2,
    heading: 1.5,
    blurb: "The theatre marquee and the flag over the intersection.",
  },
  {
    key: "dolores",
    name: "Mission Dolores",
    lat: 37.7645,
    lon: -122.4268,
    yOffset: 2,
    heading: 0.4,
    blurb: "The park slope, the palms, and the oldest building in the city.",
  },
  {
    key: "wharf",
    name: "Fisherman's Wharf",
    lat: 37.8080,
    lon: -122.4177,
    yOffset: 2,
    heading: 3.0,
    blurb: "Ghirardelli Square, the sea lions and the cable car turntable.",
  },
  {
    key: "golden-gate-park",
    name: "Golden Gate Park",
    lat: 37.7715,
    lon: -122.4686,
    yOffset: 2,
    heading: 1.5,
    blurb: "The Conservatory of Flowers, the de Young and the meadows.",
  },
  {
    key: "cliff-house",
    name: "Lands End",
    lat: 37.7787,
    lon: -122.5137,
    yOffset: 3,
    heading: 1.6,
    blurb: "The Cliff House over the Sutro Baths, and the Pacific.",
  },
  {
    key: "coit",
    name: "Coit Tower",
    lat: 37.8024,
    lon: -122.4058,
    yOffset: 66,
    heading: 2.2,
    blurb: "Top of Telegraph Hill. The whole city under your boots.",
  },
  {
    /* At the foot of the switchback, not on the summit: the point of arriving
       here is seeing the thing before you climb it. */
    key: "twinpeaks",
    name: "Twin Peaks",
    x: -3878,
    z: 4207,
    yOffset: 4,
    heading: -2.5,
    blurb: "The foot of the Terraces. Seven levels and a long walk up.",
  },
  {
    /* Over the pavilion, which is 52 m back from the landmark's anchor: the
       terraces step away from downtown as they rise, so the summit is not
       above the point the mountain is registered at. World metres rather than
       lat/lon because it is a position in a *building*, not a place.

       `walkY` is 151 against a deck at anchor-terrain + 148, and the terrain
       under this point is 1.25 m lower than under the anchor — so it is a
       two-metre drop onto the pavilion floor, which is the right side of
       exact. `terraces.test.ts` checks the deck is really there. */
    key: "terraces",
    name: "The Terraces · Summit",
    x: -4113,
    z: 4396,
    yOffset: 165,
    walkY: 151,
    heading: 0.6,
    blurb: "440 metres up a painted mountain. Snow, a pavilion, and the whole city under it.",
  },
  {
    key: "transamerica",
    name: "Transamerica Pyramid",
    lat: 37.7952,
    lon: -122.4028,
    yOffset: 266,
    heading: 1.1,
    blurb: "260 metres up the spike. Step off.",
  },
  {
    key: "goldengate",
    name: "Golden Gate Bridge",
    lat: 37.8199,
    lon: -122.4783,
    yOffset: 232,
    heading: 1.6,
    blurb: "The south tower. Fog optional.",
  },
  {
    key: "fort-point",
    name: "Fort Point",
    lat: 37.8106,
    lon: -122.4770,
    yOffset: 3,
    heading: 5.6,
    blurb: "Under the bridge's south anchorage, at the water.",
  },
  {
    key: "alcatraz",
    name: "Alcatraz",
    lat: 37.8267,
    lon: -122.4230,
    yOffset: 24,
    heading: 2.7,
    blurb: "On the Rock. Swim, boat, or grapple your way out.",
  },
];
