/* ============================================================================
   THE CHART — every system you can set a course for.

   This is the one list. The star map reads it, the warp computer reads it, the
   planet shader reads it, the away team reads it, and the people you talk to
   are looked up out of it. Adding a destination is one object here plus one
   character in `crew/characters.ts`, and it appears on the chart, in the
   sensor readout, and under your boots.

   Two rules kept it honest while it was being written:

   **Where a star is real, its numbers are real.** 40 Eridani is 16.3 light
   years away and it really is a K1 dwarf with two companions; Wolf 359 really
   is 7.86 light years out and really is an M6 red dwarf so dim you could look
   straight at it. Those are the numbers in here. The chart is a projection of
   actual stellar positions for the real ones, and Memory-Alpha's stated
   distances for the invented ones — which is why Qo'noS is a long way off to
   one side and Bajor is most of the way across the Alpha Quadrant. A game that
   makes the trip to Vulcan feel like the trip to Qo'noS has thrown away the
   only sense of scale it had.

   **Where the show gave a fact, the show wins.** Vulcan's gravity is 1.4 g and
   its air is thin because Spock says so; Ferenginar's rain has 178 words for
   it; Talos IV carries the only General Order in Starfleet that still ends in
   the death penalty. Those are not decoration — the sensor panel reads this
   object out loud, and a scan that tells you something true about a world you
   have known since you were nine is the entire appeal of the exercise.

   The planet block underneath each one is what the surface shader is handed.
   It is authored, never random: a world has to be recognisable from orbit
   before it is anything else, because orbit is where you decide whether to go
   down.
   ========================================================================== */

/** Spectral class of the primary. Drives the light colour and the star's size. */
export type StarClass = "O" | "B" | "A" | "F" | "G" | "K" | "M";

/** Surface kits, built by `surface/kits.ts`. One per place worth standing on. */
export type KitName =
  | "presidio"
  | "seleya"
  | "first-city"
  | "kendra"
  | "ferengi-market"
  | "risa-beach"
  | "andoria-ice"
  | "cardassia-plaza"
  | "romulan-forum"
  | "trill-caves"
  | "talos-surface"
  | "dead-world";

export interface PlanetSpec {
  /** Rocky/ocean/ice/gas — picks the terrain profile inside the shader. */
  kind: "terran" | "ocean" | "desert" | "ice" | "volcanic" | "barren" | "gas";
  /** Elevation ramp, low to high, then the caps and the sea. Hex, sRGB. */
  colors: {
    c0: number;
    c1: number;
    c2: number;
    c3: number;
    c4: number;
    polar: number;
    water: number;
  };
  /** 0-1. Above this height is land. `barren` worlds ignore it. */
  sea: number;
  /** How much of the mid-band goes green. 0 on a dead world. */
  veg: number;
  /** Vertical exaggeration of the noise. 1 is Earthlike. */
  relief: number;
  /** Crater density. Only visible where `veg` and `clouds` are low. */
  craters: number;
  /** Brightness of the inhabited night side. 0 means nobody is home. */
  night: number;
  /** Colour of that night side. Sodium by default; Ferenginar is not. */
  lamp?: number;
  clouds: { cover: number; scale: number; alt: number; thick: number; tint: number } | null;
  /** Rim scattering. `density` 0 is an airless rock. */
  air: { color: number; density: number };
  /** Degrees. Tilts the terminator and the caps; Uranus-like values look wrong
   *  on a class-M world, which is the point of having it per-world. */
  tilt: number;
  rings?: { inner: number; outer: number; tint: number; tilt: number };
  moons?: { radius: number; dist: number; tint: number; speed: number }[];
}

export interface SurfaceSpec {
  kit: KitName;
  /** What the transporter chief calls the coordinates. */
  site: string;
  /** Ground haze — colour and how fast it closes in. */
  fog: { color: number; density: number };
  /** Two-stop sky. Horizon first. */
  sky: { horizon: number; zenith: number };
  /**
   * Sun elevation and azimuth in degrees, and its colour on the ground.
   *
   * Azimuth is not free. The transporter always puts the away team down facing
   * -Z, so a key at 180° is dead backlight and every person, pillar and statue
   * on the world renders as a black cut-out — which is exactly what the first
   * pass did on all eleven of them. Keep it in 20-60° or 300-340°: a
   * three-quarter key over the away team's shoulder, which is where a
   * cinematographer would have put it and for the same reason.
   */
  sun: { elevation: number; azimuth: number; color: number; intensity: number };
  /** Ground tint under the kit's own materials. */
  ground: number;
  /** Local gravity, in g. Affects the jump and nothing else. */
  gravity: number;
  /** Weather the surface loop runs. */
  weather?: "rain" | "snow" | "ash" | "dust" | "none";
  /** A body hanging in the sky — a moon, the gas giant you orbit, a wormhole. */
  skyBody?: { name: string; size: number; tint: number; elevation: number; azimuth: number };
}

export interface TrekSystem {
  key: string;
  /** What the helm calls it. */
  name: string;
  star: {
    name: string;
    class: StarClass;
    /** Effective temperature, kelvin. The light colour is computed from it. */
    kelvin: number;
    /** Real-star note, or the canon citation for an invented one. */
    note: string;
  };
  /** Distance from Sol in light years. */
  ly: number;
  /** Chart position in light years, Sol at the origin, galactic north up. */
  chart: { x: number; y: number };
  quadrant: "Alpha" | "Beta" | "Gamma" | "Delta";
  /** Signal colour: chart pip, LCARS accent while you are here, orbit trim. */
  accent: number;
  /** One line, in the voice of the science officer, on why you would go. */
  tagline: string;
  /** The scan. Every field is read out on the sensor panel. */
  world: {
    name: string;
    designation: string;
    /** Planetary classification — M is the one you can breathe. */
    class: string;
    diameterKm: number;
    gravity: number;
    day: string;
    year: string;
    atmosphere: string;
    population: string;
    government: string;
    contact: string;
    /** The three or four lines Spock's console adds under the numbers. */
    notes: string[];
  };
  planet: PlanetSpec;
  /** Absent means you cannot beam down, and `hazard` says why. */
  surface?: SurfaceSpec;
  /** Key into `crew/characters.ts` — who answers the hail, and who is standing
   *  at the beam-in site when you get there. */
  character?: string;
  /** Set on the worlds Starfleet will not let you land on. */
  hazard?: string;
  /** Starts unlocked. Everything else has to be reached by flying to it. */
  origin?: boolean;
}

/* -------------------------------------------------------------------------- */

const SYSTEMS_RAW: TrekSystem[] = [
  {
    key: "sol",
    name: "SOL",
    star: {
      name: "Sol",
      class: "G",
      kelvin: 5778,
      note: "G2V main sequence. The reference against which every other star in the catalogue is measured.",
    },
    ly: 0,
    chart: { x: 0, y: 0 },
    quadrant: "Alpha",
    accent: 0x5ac8fa,
    tagline: "Sector 001. Home port, and the only planet on the chart where the harbour is named after a fog.",
    world: {
      name: "EARTH",
      designation: "Sol III",
      class: "M",
      diameterKm: 12742,
      gravity: 1.0,
      day: "23h 56m",
      year: "365.25 days",
      atmosphere: "Nitrogen-oxygen, 78/21. Breathable without support.",
      population: "9 billion",
      government: "United Federation of Planets — capital, Paris. Starfleet Command, San Francisco.",
      contact: "N/A — founding member, 2161",
      notes: [
        "Starfleet Headquarters occupies the Presidio at the south anchorage of the Golden Gate.",
        "Planetary weather modification net online since 2130. Hurricanes are a matter of record only.",
        "Orbital drydock facilities at 400 km. Traffic control is the busiest in the Federation.",
      ],
    },
    planet: {
      kind: "terran",
      colors: {
        c0: 0x0a1c22,
        c1: 0x37592f,
        c2: 0x8d8a53,
        c3: 0x6d5f45,
        c4: 0xb9b3a0,
        polar: 0xeef6fb,
        water: 0x0f3d68,
      },
      sea: 0.62,
      veg: 0.72,
      relief: 1.2,
      craters: 0.0,
      night: 1.8,
      lamp: 0xffc98a,
      clouds: { cover: 0.55, scale: 2.6, alt: 0.028, thick: 0.016, tint: 0xffffff },
      air: { color: 0x5aa9ff, density: 1.0 },
      tilt: 23.4,
      moons: [{ radius: 0.27, dist: 8.6, tint: 0xb9b6ae, speed: 0.09 }],
    },
    surface: {
      kit: "presidio",
      site: "Starfleet Command, San Francisco",
      fog: { color: 0xd8e6ec, density: 0.0032 },
      sky: { horizon: 0xd8e6ec, zenith: 0x2f6ba8 },
      sun: { elevation: 26, azimuth: 318, color: 0xffd9ac, intensity: 1.25 },
      ground: 0x6f7a58,
      gravity: 1.0,
      weather: "none",
    },
    character: "admiral",
    origin: true,
  },

  {
    key: "vulcan",
    name: "40 ERIDANI",
    star: {
      name: "40 Eridani A",
      class: "K",
      kelvin: 5072,
      note: "Real star. K1V dwarf, 16.3 ly, with a white dwarf and a red dwarf in a wide binary a few thousand AU out. Named as Vulcan's primary in the Star Trek Star Charts and endorsed by Roddenberry in a 1991 letter to Sky & Telescope.",
    },
    ly: 16.3,
    chart: { x: 12.4, y: -10.6 },
    quadrant: "Beta",
    accent: 0xff8a3c,
    tagline: "Hot, dry, and thin at the top. The air at Mount Seleya will not support a human at rest for long.",
    world: {
      name: "VULCAN",
      designation: "40 Eridani A II",
      class: "M",
      diameterKm: 15200,
      gravity: 1.4,
      day: "25.3 hours",
      year: "266 days",
      atmosphere: "Thin. Oxygen partial pressure below Earth normal — humans require acclimatisation or support above 2,000 m.",
      population: "6 billion",
      government: "Confederacy of Vulcan — founding member of the Federation",
      contact: "5 April 2063, Bozeman, Montana",
      notes: [
        "Surface temperature at the equator regularly exceeds 40 °C in shade. There is very little shade.",
        "No natural satellite. The bright object in the Vulcan sky is T'Khut, the sister planet, at closest approach.",
        "Mount Seleya: the oldest continuously occupied site of the Kolinahr discipline. Ceremonial access by ground only.",
      ],
    },
    planet: {
      kind: "desert",
      colors: {
        c0: 0x40241a,
        c1: 0x7a3f22,
        c2: 0xb26536,
        c3: 0xd08a4a,
        c4: 0xe8bb84,
        polar: 0xe4d3b6,
        water: 0x4a2a1c,
      },
      sea: 0.24,
      veg: 0.05,
      relief: 1.55,
      craters: 0.22,
      night: 0.55,
      lamp: 0xffb45e,
      clouds: { cover: 0.1, scale: 3.6, alt: 0.022, thick: 0.008, tint: 0xffe6c8 },
      air: { color: 0xff9a52, density: 0.55 },
      tilt: 8,
      moons: [{ radius: 0.62, dist: 11.0, tint: 0xc98f5e, speed: 0.05 }],
    },
    surface: {
      kit: "seleya",
      site: "Mount Seleya, the ceremonial approach",
      fog: { color: 0xf4b877, density: 0.0021 },
      sky: { horizon: 0xf4b877, zenith: 0x5d1f28 },
      sun: { elevation: 46, azimuth: 44, color: 0xffcf94, intensity: 1.75 },
      ground: 0xa1522c,
      gravity: 1.4,
      weather: "dust",
      skyBody: { name: "T'Khut", size: 0.22, tint: 0xd08a4a, elevation: 30, azimuth: 300 },
    },
    character: "tprel",
  },

  {
    key: "qonos",
    name: "QO'NOS",
    star: {
      name: "Klingon primary",
      class: "K",
      kelvin: 4600,
      note: "Beta Quadrant. Distance from Sol stated on screen as roughly 90 light years — a week and a half at warp 8 in a ship with a good engineer.",
    },
    ly: 90.3,
    chart: { x: 61.0, y: 66.4 },
    quadrant: "Beta",
    accent: 0xd23b2c,
    tagline: "Green sky, no ozone to speak of, and a capital built on the site of every battle that decided who ran it.",
    world: {
      name: "QO'NOS",
      designation: "Kronos",
      class: "M",
      diameterKm: 14700,
      gravity: 1.14,
      day: "18.4 hours",
      year: "391 days",
      atmosphere: "Dense, high turbidity. Chronic volcanic loading gives the sky its colour.",
      population: "3.5 billion",
      government: "Klingon Empire — the High Council, seated at the Great Hall in the First City",
      contact: "2218 — badly. Formal relations followed the Khitomer Accords, 2293.",
      notes: [
        "Axial instability produces violent seasons. The First City is rebuilt on average once a century.",
        "Praxis, the primary moon, was destroyed in 2293 by over-mining. Its remains are still in orbit and still falling.",
        "Approach without a filed flight plan is treated as a challenge. This is not a figure of speech.",
      ],
    },
    planet: {
      kind: "volcanic",
      colors: {
        c0: 0x161a12,
        c1: 0x2e3a1e,
        c2: 0x556028,
        c3: 0x4a4230,
        c4: 0x8f8a64,
        polar: 0xcfd6b8,
        water: 0x1d3a2a,
      },
      sea: 0.5,
      veg: 0.55,
      relief: 1.7,
      craters: 0.1,
      night: 1.1,
      lamp: 0xff7a3a,
      clouds: { cover: 0.42, scale: 2.2, alt: 0.03, thick: 0.02, tint: 0xcfe0a0 },
      air: { color: 0x7ecf5a, density: 1.35 },
      tilt: 31,
      moons: [
        { radius: 0.2, dist: 7.4, tint: 0x8a8070, speed: 0.14 },
        { radius: 0.11, dist: 10.2, tint: 0x6b6055, speed: 0.08 },
      ],
    },
    surface: {
      kit: "first-city",
      site: "The First City — the steps of the Great Hall",
      fog: { color: 0xa8c96b, density: 0.0042 },
      sky: { horizon: 0xa8c96b, zenith: 0x17301f },
      sun: { elevation: 19, azimuth: 334, color: 0xffb26b, intensity: 1.0 },
      ground: 0x3a3a2c,
      gravity: 1.14,
      weather: "ash",
      skyBody: { name: "Praxis (debris)", size: 0.3, tint: 0x9a8f7e, elevation: 22, azimuth: 90 },
    },
    character: "kvrel",
  },

  {
    key: "bajor",
    name: "B'HAVA'EL",
    star: {
      name: "B'hava'el",
      class: "G",
      kelvin: 5600,
      note: "Alpha Quadrant, near the Cardassian border. The system also holds the only stable wormhole known to exist.",
    },
    ly: 52.0,
    chart: { x: -44.6, y: 26.8 },
    quadrant: "Alpha",
    accent: 0xc08a3e,
    tagline: "Farmland, and a wormhole. One of those was here first, and the Bajorans will tell you it is the other one.",
    world: {
      name: "BAJOR",
      designation: "Bajor VII",
      class: "M",
      diameterKm: 13400,
      gravity: 1.02,
      day: "26 hours",
      year: "412 days",
      atmosphere: "Nitrogen-oxygen. Breathable. Trace sulphur near the Fire Caves.",
      population: "3.8 billion",
      government: "Republic of Bajor — Chamber of Ministers, with the Vedek Assembly in council",
      contact: "2328, under Cardassian occupation",
      notes: [
        "Occupied by the Cardassian Union 2328-2369. Withdrawal was unilateral and abrupt.",
        "Five moons. Jeraddo was rendered uninhabitable by an energy-transfer project in 2370.",
        "The Bajoran wormhole terminates 70,000 light years away in the Gamma Quadrant. Transit is under three minutes.",
      ],
    },
    planet: {
      kind: "terran",
      colors: {
        c0: 0x1a2418,
        c1: 0x4e6b32,
        c2: 0x9a8f4a,
        c3: 0x7d6a45,
        c4: 0xc4b58c,
        polar: 0xf0f4f6,
        water: 0x1b5a72,
      },
      sea: 0.54,
      veg: 0.8,
      relief: 1.1,
      craters: 0.02,
      night: 0.9,
      lamp: 0xffd9a0,
      clouds: { cover: 0.44, scale: 2.8, alt: 0.026, thick: 0.014, tint: 0xfff6e8 },
      air: { color: 0x7fb6ff, density: 0.95 },
      tilt: 19,
      moons: [
        { radius: 0.18, dist: 8.0, tint: 0xb0a894, speed: 0.1 },
        { radius: 0.12, dist: 11.5, tint: 0x9a9488, speed: 0.06 },
      ],
    },
    surface: {
      kit: "kendra",
      site: "Kendra Province — the terraces below the shrine",
      fog: { color: 0xf7e0b4, density: 0.0018 },
      sky: { horizon: 0xf7e0b4, zenith: 0x27578f },
      sun: { elevation: 18, azimuth: 306, color: 0xffcf9a, intensity: 1.3 },
      ground: 0x8a7c4a,
      gravity: 1.02,
      weather: "none",
      skyBody: { name: "Derna", size: 0.16, tint: 0xcfc7b4, elevation: 40, azimuth: 60 },
    },
    character: "vedek",
  },

  {
    key: "ferenginar",
    name: "FERENGINAR",
    star: {
      name: "Ferengar",
      class: "G",
      kelvin: 5350,
      note: "Alpha Quadrant. Seat of the Ferengi Alliance, and the only capital in the catalogue with a posted admission charge.",
    },
    ly: 68.0,
    chart: { x: -58.0, y: -35.6 },
    quadrant: "Alpha",
    accent: 0xc9a227,
    tagline: "It is raining. It was raining when the survey was taken in 2151 and there is no record of it having stopped.",
    world: {
      name: "FERENGINAR",
      designation: "Ferenginar",
      class: "M",
      diameterKm: 12900,
      gravity: 0.98,
      day: "24.9 hours",
      year: "384 days",
      atmosphere: "Saturated. Relative humidity has not been recorded below 90%.",
      population: "7 billion",
      government: "Ferengi Alliance — the Grand Nagus, advised by the Board of Liquidators",
      contact: "2364, formally. Informally, considerably earlier and at a markdown.",
      notes: [
        "The Ferengi language has 178 words for rain and no word for 'crisp'.",
        "Commerce is conducted under the Rules of Acquisition, of which there are 285.",
        "Admission to the Tower of Commerce carries an entrance fee, a browsing charge, and a gratuity.",
      ],
    },
    planet: {
      kind: "ocean",
      colors: {
        c0: 0x14201c,
        c1: 0x33523a,
        c2: 0x5c6b45,
        c3: 0x4c5240,
        c4: 0x7d8268,
        polar: 0xd6e2e0,
        water: 0x1d4a4e,
      },
      sea: 0.6,
      veg: 0.9,
      relief: 0.9,
      craters: 0.0,
      night: 1.3,
      lamp: 0xffe08a,
      clouds: { cover: 0.92, scale: 2.0, alt: 0.03, thick: 0.026, tint: 0xdfe8e4 },
      air: { color: 0x8fd6c8, density: 1.25 },
      tilt: 12,
    },
    surface: {
      kit: "ferengi-market",
      site: "Tower of Commerce — the lower arcade",
      fog: { color: 0x9aa79a, density: 0.006 },
      sky: { horizon: 0x9aa79a, zenith: 0x2c3a3a },
      sun: { elevation: 38, azimuth: 26, color: 0xd8e0cf, intensity: 0.7 },
      ground: 0x4a4a3c,
      gravity: 0.98,
      weather: "rain",
    },
    character: "brek",
  },

  {
    key: "risa",
    name: "EPSILON CETI",
    star: {
      name: "Epsilon Ceti B",
      class: "F",
      kelvin: 6400,
      note: "Real star system, 90 ly. Risa's weather is not — it is manufactured, continuously, by a planetary control net.",
    },
    ly: 90.0,
    chart: { x: -20.0, y: -87.0 },
    quadrant: "Alpha",
    accent: 0x2fd6c3,
    tagline: "A rain forest with the rain taken out of it by machine. The tourist board would like a word about that phrasing.",
    world: {
      name: "RISA",
      designation: "Epsilon Ceti B II",
      class: "M",
      diameterKm: 13100,
      gravity: 0.95,
      day: "22.5 hours",
      year: "301 days",
      atmosphere: "Nitrogen-oxygen, held at 26 °C and 40% humidity by the weather net.",
      population: "1.2 billion, plus a permanent visiting population of roughly the same",
      government: "Risian Hedony — Federation member",
      contact: "2152",
      notes: [
        "Native climate is seismically unstable jungle. Every fine day on Risa is an engineering achievement.",
        "The horga'hn is a fertility idol. Displaying one in public is an invitation, and is understood as one.",
        "Weather net failure in 2373 restored the natural climate within four hours. It was not popular.",
      ],
    },
    planet: {
      kind: "ocean",
      colors: {
        c0: 0x0d2c34,
        c1: 0x2f8a6a,
        c2: 0x86b45c,
        c3: 0x9c8a58,
        c4: 0xe6dcb4,
        polar: 0xf2fbff,
        water: 0x11a0b4,
      },
      sea: 0.66,
      veg: 0.95,
      relief: 0.95,
      craters: 0.0,
      night: 0.8,
      lamp: 0xffe6b0,
      clouds: { cover: 0.28, scale: 3.2, alt: 0.024, thick: 0.01, tint: 0xffffff },
      air: { color: 0x6fe0ff, density: 1.05 },
      tilt: 4,
      rings: { inner: 1.45, outer: 2.1, tint: 0xdcf0f4, tilt: 8 },
      moons: [{ radius: 0.15, dist: 9.0, tint: 0xd9d2c0, speed: 0.11 }],
    },
    surface: {
      kit: "risa-beach",
      site: "Suraya Bay — the resort shelf",
      fog: { color: 0xffe8c4, density: 0.0012 },
      sky: { horizon: 0xffe8c4, zenith: 0x0e6fb4 },
      sun: { elevation: 32, azimuth: 324, color: 0xfff0cf, intensity: 1.5 },
      ground: 0xe6d8a8,
      gravity: 0.95,
      weather: "none",
    },
    character: "arandis",
  },

  {
    key: "andoria",
    name: "PROCYON",
    star: {
      name: "Procyon",
      class: "F",
      kelvin: 6530,
      note: "Real star. F5IV-V subgiant with a white dwarf companion, 11.46 ly — the eighth brightest star in Earth's sky. Andoria is not a planet: it is the moon of a gas giant.",
    },
    ly: 11.46,
    chart: { x: 8.9, y: 7.2 },
    quadrant: "Alpha",
    accent: 0x63c8ff,
    tagline: "An ice moon with an ocean under it, and a species that considers the surface merely the roof.",
    world: {
      name: "ANDORIA",
      designation: "Procyon — moon of Andor",
      class: "M (marginal)",
      diameterKm: 7200,
      gravity: 0.9,
      day: "tidally locked to Andor — 42-hour cycle",
      year: "489 days",
      atmosphere: "Thin, cold, breathable. Surface mean −40 °C.",
      population: "2.1 billion, almost all of it subsurface",
      government: "Andorian Empire — Federation founding member",
      contact: "2097. Relations with Vulcan were poor for a further sixty years.",
      notes: [
        "Cities are cut into the ice above liquid-water oceans. Nothing of consequence happens on the surface.",
        "Andorian antennae are sensory organs and are not decorative. Damage to them is treated as maiming.",
        "The Imperial Guard maintains the oldest continuously operating military tradition in the Federation.",
      ],
    },
    planet: {
      kind: "ice",
      colors: {
        c0: 0x2a4a63,
        c1: 0x4f7c96,
        c2: 0x8fb6cc,
        c3: 0xa9c6d6,
        c4: 0xdfeef7,
        polar: 0xffffff,
        water: 0x123a55,
      },
      sea: 0.3,
      veg: 0.0,
      relief: 1.25,
      craters: 0.45,
      night: 0.7,
      lamp: 0x9fdcff,
      clouds: { cover: 0.22, scale: 3.0, alt: 0.02, thick: 0.008, tint: 0xeaf6ff },
      air: { color: 0x9fd8ff, density: 0.45 },
      tilt: 2,
    },
    surface: {
      kit: "andoria-ice",
      site: "Laibok — the outer gallery",
      fog: { color: 0xdcecf7, density: 0.0038 },
      sky: { horizon: 0xdcecf7, zenith: 0x102e56 },
      sun: { elevation: 11, azimuth: 34, color: 0xdcecff, intensity: 0.85 },
      ground: 0xbcd6e6,
      gravity: 0.9,
      weather: "snow",
      skyBody: { name: "Andor", size: 0.85, tint: 0x7fa8c8, elevation: 34, azimuth: 100 },
    },
    character: "thelin",
  },

  {
    key: "cardassia",
    name: "CARDASSIA",
    star: {
      name: "Cardassia",
      class: "K",
      kelvin: 4900,
      note: "Alpha Quadrant. A resource-poor system that built an empire out of taking other people's.",
    },
    ly: 62.0,
    chart: { x: -55.2, y: 12.0 },
    quadrant: "Alpha",
    accent: 0xb0762e,
    tagline: "Dry, hot, and orderly. Everything on the surface was designed by someone who wanted you to know it was designed.",
    world: {
      name: "CARDASSIA PRIME",
      designation: "Cardassia Prime",
      class: "K",
      diameterKm: 14100,
      gravity: 1.06,
      day: "26.6 hours",
      year: "356 days",
      atmosphere: "Hot and dry. Cardassians prefer 38 °C and high humidity indoors; the outside obliges on neither count.",
      population: "3.1 billion",
      government: "Cardassian Union — Detapa Council, with the Obsidian Order in attendance",
      contact: "2327",
      notes: [
        "Poor in ore and arable land. The Occupation of Bajor was, on the record, an extraction programme.",
        "The Obsidian Order maintained surveillance of every Cardassian household. This was not a secret.",
        "Cardassian architecture is deliberately repetitive. Disorientation of the visitor is the intent.",
      ],
    },
    planet: {
      kind: "desert",
      colors: {
        c0: 0x3a2c1c,
        c1: 0x6e5330,
        c2: 0x9c7a41,
        c3: 0xb99257,
        c4: 0xd9bd8a,
        polar: 0xe6dcc4,
        water: 0x3c4a3a,
      },
      sea: 0.2,
      veg: 0.12,
      relief: 1.15,
      craters: 0.08,
      night: 1.0,
      lamp: 0xffcf7a,
      clouds: { cover: 0.16, scale: 3.4, alt: 0.022, thick: 0.009, tint: 0xf2e4cc },
      air: { color: 0xffb469, density: 0.72 },
      tilt: 14,
    },
    surface: {
      kit: "cardassia-plaza",
      site: "The Central Archive — north plaza",
      fog: { color: 0xecca96, density: 0.0026 },
      sky: { horizon: 0xecca96, zenith: 0x4e3018 },
      sun: { elevation: 44, azimuth: 56, color: 0xffd79c, intensity: 1.6 },
      ground: 0x8d6f42,
      gravity: 1.06,
      weather: "dust",
    },
    character: "terec",
  },

  {
    key: "romulus",
    name: "ROMULUS",
    star: {
      name: "Romulan primary",
      class: "G",
      kelvin: 5450,
      note: "Beta Quadrant, beyond the Neutral Zone. Entry is an act of war, which the Senate will remind you of at length.",
    },
    ly: 116.0,
    chart: { x: 88.0, y: -76.0 },
    quadrant: "Beta",
    accent: 0x4fbf6a,
    tagline: "The Vulcans who left. Two thousand years of doing the opposite on purpose, and the architecture shows it.",
    world: {
      name: "ROMULUS",
      designation: "Romulus",
      class: "M",
      diameterKm: 15900,
      gravity: 1.18,
      day: "26.2 hours",
      year: "418 days",
      atmosphere: "Nitrogen-oxygen, warm and heavy. Comparable to Vulcan at sea level.",
      population: "18 billion, with Remus",
      government: "Romulan Star Empire — the Senate, the Praetor, and the Tal Shiar",
      contact: "2160, by treaty, at a distance, over subspace radio only",
      notes: [
        "The Earth-Romulan War was fought and concluded without either side seeing the other's face.",
        "Remus, the sister world, is tidally locked and mined by a labouring caste kept out of the light.",
        "The Neutral Zone is one light year deep. Crossing it is, by treaty, an act of war.",
      ],
    },
    planet: {
      kind: "terran",
      colors: {
        c0: 0x102015,
        c1: 0x2f5a30,
        c2: 0x6e8a3e,
        c3: 0x6a6440,
        c4: 0xada183,
        polar: 0xe8f2ea,
        water: 0x14504a,
      },
      sea: 0.56,
      veg: 0.86,
      relief: 1.3,
      craters: 0.02,
      night: 1.2,
      lamp: 0x9fffc0,
      clouds: { cover: 0.48, scale: 2.7, alt: 0.027, thick: 0.015, tint: 0xeafff2 },
      air: { color: 0x6fe0a0, density: 1.1 },
      tilt: 21,
      moons: [{ radius: 0.42, dist: 9.4, tint: 0x6a6a72, speed: 0.07 }],
    },
    surface: {
      kit: "romulan-forum",
      site: "Ki Baratan — the Hall of State, outer colonnade",
      fog: { color: 0xb4dfbb, density: 0.0028 },
      sky: { horizon: 0xb4dfbb, zenith: 0x0f3a30 },
      sun: { elevation: 41, azimuth: 40, color: 0xe0ffd8, intensity: 1.2 },
      ground: 0x51603f,
      gravity: 1.18,
      weather: "none",
      skyBody: { name: "Remus", size: 0.45, tint: 0x5a5a64, elevation: 26, azimuth: 320 },
    },
    character: "vraal",
  },

  {
    key: "trill",
    name: "TRILL",
    star: {
      name: "Trill",
      class: "G",
      kelvin: 5700,
      note: "Alpha Quadrant. Federation member. The interesting part of the planet is underneath it.",
    },
    ly: 42.0,
    chart: { x: -24.0, y: 34.5 },
    quadrant: "Alpha",
    accent: 0x8f7ce0,
    tagline: "Temperate, quiet, unremarkable — and beneath the capital, caverns full of something very old and still alive.",
    world: {
      name: "TRILL",
      designation: "Trill",
      class: "M",
      diameterKm: 13600,
      gravity: 1.0,
      day: "24.8 hours",
      year: "371 days",
      atmosphere: "Nitrogen-oxygen. Temperate maritime over most of the inhabited band.",
      population: "3.4 billion — of whom roughly 0.3% are joined",
      government: "Trill — Federation member; the Symbiosis Commission holds separate authority",
      contact: "2367",
      notes: [
        "A symbiont carries the memories of every host it has had. Some are three hundred years old.",
        "The Commission states that only one in a thousand Trill is suitable for joining. This is false; the true figure is closer to one in two.",
        "The Caves of Mak'ala hold the symbionts in pools of electrically conductive water. Contact there is direct.",
      ],
    },
    planet: {
      kind: "terran",
      colors: {
        c0: 0x141f24,
        c1: 0x3d6240,
        c2: 0x7f8a56,
        c3: 0x6b6450,
        c4: 0xb4ae96,
        polar: 0xf0f6fa,
        water: 0x1a5570,
      },
      sea: 0.58,
      veg: 0.78,
      relief: 1.05,
      craters: 0.01,
      night: 0.85,
      lamp: 0xdcd0ff,
      clouds: { cover: 0.52, scale: 2.9, alt: 0.026, thick: 0.015, tint: 0xf6f8ff },
      air: { color: 0x9a8fff, density: 0.98 },
      tilt: 17,
    },
    surface: {
      kit: "trill-caves",
      site: "The Caves of Mak'ala — the second pool",
      fog: { color: 0x353c5e, density: 0.007 },
      sky: { horizon: 0x353c5e, zenith: 0x07080f },
      sun: { elevation: 66, azimuth: 22, color: 0x9fb0ff, intensity: 0.5 },
      ground: 0x2a2f3c,
      gravity: 1.0,
      weather: "none",
    },
    character: "jadmar",
  },

  {
    key: "talos",
    name: "TALOS",
    star: {
      name: "Talos",
      class: "M",
      kelvin: 3400,
      note: "Talos star group. General Order 7 forbids contact. It carries the only remaining death penalty in Starfleet regulations.",
    },
    ly: 39.0,
    chart: { x: 30.0, y: 25.0 },
    quadrant: "Alpha",
    accent: 0xb04ce0,
    tagline: "Nothing here is necessarily here. The Talosians can put anything at all behind your eyes, and they are better at it than you are at doubting.",
    world: {
      name: "TALOS IV",
      designation: "Talos IV",
      class: "M",
      diameterKm: 12300,
      gravity: 0.9,
      day: "23.1 hours",
      year: "351 days",
      atmosphere: "Breathable, heavy in argon and traces of an inert unidentified compound.",
      population: "Unknown — surviving population lives below the surface",
      government: "None recorded. The Keeper speaks for the group.",
      contact: "2254, USS Enterprise, Captain Christopher Pike",
      notes: [
        "The surface was rendered lifeless by war some thousands of years ago. The survivors went underground and stopped building.",
        "Talosian illusion is total across every sense. It cannot be detected from inside it.",
        "Starfleet General Order 7: no vessel under any circumstance shall visit Talos IV.",
      ],
    },
    planet: {
      kind: "barren",
      colors: {
        c0: 0x2a2230,
        c1: 0x4c3c4e,
        c2: 0x6d5566,
        c3: 0x8a6c74,
        c4: 0xb59aa2,
        polar: 0xd8ccd6,
        water: 0x2a2438,
      },
      sea: 0.0,
      veg: 0.06,
      relief: 1.4,
      craters: 0.3,
      night: 0.15,
      lamp: 0xc07aff,
      clouds: { cover: 0.2, scale: 3.1, alt: 0.02, thick: 0.01, tint: 0xe4d4f0 },
      air: { color: 0xb46cff, density: 0.62 },
      tilt: 11,
    },
    surface: {
      kit: "talos-surface",
      site: "The surface above the menagerie",
      fog: { color: 0xcf9ae0, density: 0.0035 },
      sky: { horizon: 0xcf9ae0, zenith: 0x180722 },
      sun: { elevation: 24, azimuth: 330, color: 0xffb0e0, intensity: 0.9 },
      ground: 0x5c4458,
      gravity: 0.9,
      weather: "none",
    },
    character: "keeper",
  },

  {
    key: "ceti-alpha",
    name: "CETI ALPHA",
    star: {
      name: "Ceti Alpha",
      class: "K",
      kelvin: 4750,
      note: "Six months after the Botany Bay's people were put down here, Ceti Alpha VI exploded and shifted this world's orbit. Nobody came back to check.",
    },
    ly: 48.0,
    chart: { x: -6.0, y: -46.0 },
    quadrant: "Alpha",
    accent: 0xd06a3a,
    tagline: "A class-M world in 2267 and a sandstorm with a surface in 2285. Sensors read no life. Sensors have been wrong here before.",
    world: {
      name: "CETI ALPHA V",
      designation: "Ceti Alpha V",
      class: "Y (formerly M)",
      diameterKm: 12800,
      gravity: 1.0,
      day: "20.2 hours",
      year: "unstable — orbit shifted 2268",
      atmosphere: "Trace. Surface winds exceed 200 km/h continuously. Not survivable unprotected.",
      population: "None on record",
      government: "None",
      contact: "2267 — USS Enterprise, marooning of the Botany Bay complement",
      notes: [
        "Ceti Alpha VI detonated six months after the landing party was left. The shockwave moved this planet's orbit.",
        "Surviving fauna: Ceti eels. Larval stage enters the host through the ear and wraps itself around the cerebral cortex.",
        "Cargo carrier debris on the surface reads as pre-Federation construction. Nothing answers a hail.",
      ],
    },
    planet: {
      kind: "barren",
      colors: {
        c0: 0x3a2418,
        c1: 0x5e3a22,
        c2: 0x8a5a30,
        c3: 0xa4703c,
        c4: 0xc99a63,
        polar: 0xc0a888,
        water: 0x3a2a1e,
      },
      sea: 0.0,
      veg: 0.0,
      relief: 1.5,
      craters: 0.5,
      night: 0.0,
      clouds: { cover: 0.7, scale: 1.6, alt: 0.018, thick: 0.014, tint: 0xd0a878 },
      air: { color: 0xd07a3a, density: 0.4 },
      tilt: 27,
    },
    hazard:
      "SURFACE CONDITIONS EXCEED SUIT TOLERANCE — sustained 200 km/h particulate wind, no breathable atmosphere. Transport denied.",
    character: "ceti-signal",
  },

  {
    key: "wolf359",
    name: "WOLF 359",
    star: {
      name: "Wolf 359",
      class: "M",
      kelvin: 2800,
      note: "Real star. M6V red dwarf, 7.86 ly — one of the nearest stars to Sol, and so dim it was not catalogued until 1918. Thirty-nine ships were lost here in 2367.",
    },
    ly: 7.86,
    chart: { x: -5.6, y: 5.5 },
    quadrant: "Alpha",
    accent: 0x8a97a8,
    tagline: "Thirty-nine ships, eleven thousand people, and one Borg cube. The wreckage has not been cleared, and it will not be.",
    world: {
      name: "WOLF 359",
      designation: "the battle site",
      class: "— (no planetary body)",
      diameterKm: 0,
      gravity: 0,
      day: "—",
      year: "—",
      atmosphere: "None",
      population: "None",
      government: "Federation war grave",
      contact: "—",
      notes: [
        "2 January 2367. Thirty-nine starships engaged a single Borg cube. Thirty-nine were destroyed.",
        "Eleven thousand crew were lost. The cube reached Earth orbit twelve hours later.",
        "By Starfleet order the debris field is not to be salvaged. Ships passing through fly at one-quarter impulse.",
      ],
    },
    planet: {
      kind: "barren",
      colors: {
        c0: 0x1a1a1e,
        c1: 0x26262c,
        c2: 0x34343c,
        c3: 0x42424a,
        c4: 0x56565e,
        polar: 0x6a6a72,
        water: 0x141418,
      },
      sea: 0.0,
      veg: 0.0,
      relief: 0.6,
      craters: 0.7,
      night: 0.0,
      clouds: null,
      air: { color: 0x6a7a90, density: 0.0 },
      tilt: 0,
    },
    hazard: "FEDERATION WAR GRAVE — no landing site. By order, transport and salvage are prohibited.",
    character: "wolf-log",
  },
];

/* -------------------------------------------------------------------------- */

/** The chart, ordered by distance from Sol, which is the order you will fly it in. */
export const SYSTEMS: TrekSystem[] = [...SYSTEMS_RAW].sort((a, b) => a.ly - b.ly);

export const systemByKey = (key: string): TrekSystem | undefined =>
  SYSTEMS.find((s) => s.key === key);

export const ORIGIN: TrekSystem = SYSTEMS.find((s) => s.origin) ?? SYSTEMS[0];

/** Straight-line distance between two systems, light years, off the chart. */
export function distanceLy(a: TrekSystem, b: TrekSystem): number {
  const dx = a.chart.x - b.chart.x;
  const dy = a.chart.y - b.chart.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ---------------------------------------------------------------------------
   The warp scale, because a course plot that says "a while" is not a course
   plot. TNG-era: v = w^(10/3) · c, which puts warp 1 at light speed exactly,
   warp 6 at 392c, and warp 9 at 1516c. The asymptote at warp 10 is why the
   engines here top out at 9.6 and why holding it costs the hull.
   --------------------------------------------------------------------------- */

export const MAX_WARP = 9.6;

/** Multiples of c for a given warp factor. */
export const warpVelocity = (w: number): number => Math.pow(Math.max(w, 0.01), 10 / 3);

/** Days of travel for a distance in light years at a given warp factor. */
export function travelDays(ly: number, warp: number): number {
  const years = ly / warpVelocity(warp);
  return years * 365.25;
}

/** "3 days 4 hours", "6 hours", "41 minutes" — what the helm says out loud. */
export function travelTime(ly: number, warp: number): string {
  const days = travelDays(ly, warp);
  if (days >= 1) {
    const d = Math.floor(days);
    const h = Math.round((days - d) * 24);
    return h > 0 ? `${d} day${d === 1 ? "" : "s"} ${h} h` : `${d} day${d === 1 ? "" : "s"}`;
  }
  const hours = days * 24;
  if (hours >= 1) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m > 0 ? `${h} h ${m} m` : `${h} h`;
  }
  return `${Math.max(1, Math.round(hours * 60))} m`;
}

/* ---------------------------------------------------------------------------
   Stardates. The TNG form: 41000.0 was the start of the first season, and one
   unit is roughly 0.4 days. This is a game, so the clock starts wherever the
   session starts and runs from there — but it runs, and the ship's log writes
   the number it is actually on rather than a constant.
   --------------------------------------------------------------------------- */

export const STARDATE_EPOCH = 47000;

export function stardate(elapsedDays: number): string {
  return (STARDATE_EPOCH + elapsedDays / 0.4).toFixed(1);
}

/** Colour of a star of a given effective temperature, as a hex int. A crude
 *  blackbody fit — good enough that a K dwarf is orange and an F star is not. */
export function starColor(kelvin: number): number {
  const t = Math.max(1000, Math.min(12000, kelvin)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.52 * Math.log(t - 10) - 305.04;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}
