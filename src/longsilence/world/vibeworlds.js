/* ============================================================================
   The worlds that are actually out there.

   Everything else in this galaxy falls out of a seed. These do not. Each one is
   a real destination in the vibeverse, so each gets a star system of its own,
   named after it, sitting at a fixed place on the chart where it can be found
   again.

   The planet in each system is hand-authored to *look* like the world it leads
   to, because the only promise a hub can make from orbit is a visual one. San
   Francisco is fog over cold water with the grid burning through at night;
   Seafair is a lake world under summer cloud; Vibe Island II is an archipelago
   at golden hour. Land on one and you are in it.

   Adding another is this object plus nothing else — `generateGalaxy` reads the
   length of this array and the rest of the game follows. Roll first and
   override second, though: see the note on the draw sequence in generate.js,
   and the test that fails if a new world quietly reshuffles the whole galaxy.

   One of them has no `route`. A world without a route is one you cannot walk
   into, because there is nothing on the other side of it yet — so landing there
   leaves you standing on it, which is exactly what an invasion wants. See
   `contested` below and Troopers.js.
   ========================================================================== */

/** Where they sit on the chart, in light-years. Close enough that the
 *  fold drive can reach the next one early, far enough that going there is a
 *  decision. The origin system is first and is always San Francisco. */
export const VIBE_WORLDS = [
  {
    key: 'sf',
    route: '/sf',
    /** The system's name on the star map, and the planet's name in the scanner. */
    name: 'SAN FRANCISCO',
    designation: 'VV-001',
    /** What the ship says when you get a lock on it. */
    tagline: 'The real city, hill for hill. Fog on the water, grid on the hills.',
    /** Signal colour — matches the world's own card in the hub. */
    accent: 0xff6a2b,
    star: 'G',
    chart: { x: 0, y: 0 },
    planet: {
      kind: 'terran',
      radius: 4100,
      /* Cold Pacific, dark headlands, dry gold in the hills. The water is the
         loudest channel from orbit and it is deliberately a grey-blue rather
         than a tropical one — this is not a holiday world. */
      colors: {
        c0: 0x0b1a22, c1: 0x3f5a3c, c2: 0x9a8f58, c3: 0x6b6250,
        c4: 0xb0a68e, polar: 0xe6f0f6, water: 0x14465e,
      },
      sea: 0.58,
      veg: 0.62,
      relief: 1.38,          // the hills are the whole point
      craters: 0.06,
      /* Night lights, and hard. A city world seen from the dark side is the
         single clearest "someone lives here" signal the renderer has. */
      night: 1.7,
      clouds: { cover: 0.52, scale: 2.4, alt: 0.028, thick: 0.015, tint: 0xf2f6fa },
    },
  },
  {
    key: 'seafair',
    route: '/seafair',
    name: 'SEAFAIR',
    designation: 'VV-002',
    tagline: 'Hydros on the lake, Blue Angels overhead, something alien on the tower.',
    accent: 0x12a5f5,
    star: 'F',
    chart: { x: 17.5, y: -9.0 },
    planet: {
      kind: 'ocean',
      radius: 3900,
      /* Almost all water, and a bright summer one. Where San Francisco's sea is
         grey this is the blue of a lake in August, because that is the day the
         world is set on and it should read from a hundred thousand kilometres. */
      colors: {
        c0: 0x06202c, c1: 0x2f7a86, c2: 0x84a06a, c3: 0x6f7a62,
        c4: 0xbcc6a8, polar: 0xeaf8ff, water: 0x0d6a94,
      },
      /* Held at the top of the range the engine already ships for ocean worlds
         (0.55-0.66) rather than pushed past it. The landing site is chosen by
         direction, not by looking for dry ground, so a sea level above what the
         terrain generator was tuned against is a good way to set down
         underwater. It still reads as a water world from orbit. */
      sea: 0.66,
      veg: 0.80,             // the evergreen shoulder above the water line
      relief: 1.05,
      craters: 0.04,
      night: 1.25,
      clouds: { cover: 0.66, scale: 2.9, alt: 0.030, thick: 0.018, tint: 0xffffff },
    },
  },
  {
    key: 'island-2',
    route: '/island-2',
    name: 'VIBE ISLAND',
    designation: 'VV-003',
    tagline: 'A floating archipelago at golden hour. Islands you can fly underneath.',
    accent: 0xffb347,
    star: 'K',
    chart: { x: -14.0, y: 15.5 },
    planet: {
      kind: 'terran',
      radius: 3500,
      /* Warm everything. An orange dwarf does most of the work — the palette
         only has to not fight it. Shallow turquoise water and a lot of small
         land is what an archipelago looks like from orbit. */
      colors: {
        c0: 0x11201c, c1: 0x4f7a44, c2: 0xc0a058, c3: 0x8a7550,
        c4: 0xdcc79a, polar: 0xf6f0e4, water: 0x1a8a94,
      },
      // Likewise capped: 0.60 is the highest the garden worlds go, and an
      // archipelago reads from small-scale relief more than from the water line.
      sea: 0.60,
      veg: 0.92,
      relief: 1.22,
      craters: 0.03,
      night: 0.85,
      clouds: { cover: 0.34, scale: 3.4, alt: 0.026, thick: 0.012, tint: 0xffeeda },
    },
  },
  {
    key: 'edm-town',
    route: '/edm-town',
    name: 'EDM TOWN',
    designation: 'VV-004',
    tagline: 'Lasers, a crowd, and a guestbook. The party has not stopped once.',
    accent: 0xff2bd6,
    // A red dwarf, and chosen for it: a dim star means a long, cold day side and
    // very little to look at until the terminator comes round. Which is the joke.
    star: 'M',
    chart: { x: 8.0, y: 21.0 },
    planet: {
      kind: 'terran',
      radius: 3300,
      /* Muted to the point of drab in daylight — deep water, dark basalt, almost
         no vegetation. Every bit of this world's budget is spent after dark. */
      colors: {
        c0: 0x0a0c14, c1: 0x2a2f42, c2: 0x4c4258, c3: 0x3e3a4a,
        c4: 0x77708a, polar: 0xdfe4f2, water: 0x101a3a,
      },
      sea: 0.55,
      veg: 0.18,
      relief: 1.10,
      craters: 0.10,
      /* Twice what a city world burns, in magenta and cyan. The night side is
         the brightest thing in the system that is not a star, and coming round
         the terminator onto it is the entire reason this world is on the chart.
         The lamp colours are the world's own — see uLampWarm in planetShaders. */
      night: 3.2,
      lamp: { warm: 0xff2bd6, cold: 0x2bf0ff },
      clouds: { cover: 0.28, scale: 3.0, alt: 0.026, thick: 0.012, tint: 0xd8c8f0 },
    },
  },
  {
    key: 'redline',
    /* No route, deliberately. The other four are doors: land on Seafair and the
       browser goes to Seafair. This one has nothing behind it — so the landing
       *is* the destination, the handoff never fires, and you are left on the
       ground with the ship at your back and a firefight in front of it. */
    route: null,
    contested: true,
    /* It still gets a passport stamp — you just cannot earn it by arriving.
       Holding the landing site writes this; see lib/passport.ts, which lists
       the same identifier as the one world nothing is mounted at. */
    stamp: '/vibeverse/redline',
    name: 'REDLINE',
    designation: 'VV-005',
    tagline: 'Held by someone else. Blue is with you. Red is not.',
    accent: 0xff3b30,
    // A K dwarf: low sun, long shadows across open ground, which is the light a
    // fight reads best in. Nothing here is trying to look welcoming.
    star: 'K',
    chart: { x: -9.5, y: -19.0 },
    planet: {
      kind: 'terran',
      radius: 3600,
      /* Rust, basalt and a shallow iron sea. The palette exists to make blue and
         red armour the only saturated things on the planet — a green world would
         swallow the allied line and a red one would swallow the enemy. */
      colors: {
        c0: 0x160f0c, c1: 0x4a3324, c2: 0x8a6440, c3: 0x6b4a33,
        c4: 0xb08a63, polar: 0xe8ded2, water: 0x27201c,
      },
      sea: 0.44,             // mostly land: a battlefield needs somewhere to be
      veg: 0.10,
      relief: 1.30,
      craters: 0.34,         // it has been fought over before
      // A garrison, not a city. Enough light after dark to know it is occupied.
      night: 0.55,
      lamp: { warm: 0xff7a3c, cold: 0xff2f24 },
      clouds: { cover: 0.30, scale: 2.2, alt: 0.024, thick: 0.011, tint: 0xd8bda6 },
      // The scatter that makes a garden world lush would hide half the troopers.
      garden: false,
    },
  },
  {
    key: 'venus',
    route: '/venus',
    name: 'VENUS',
    designation: 'VV-006',
    tagline: 'Everybody went to Mars. Fifty-four kilometres up, somebody is building a utopia.',
    accent: 0xffc27a,
    // A G star, like ours, and the planet sits close in: Venus is the sunward
    // door. You fall toward it rather than climbing out.
    star: 'G',
    chart: { x: 5.5, y: -7.0 },
    planet: {
      kind: 'terran',
      radius: 3950,
      /* The surface nobody visits: basalt plains at 462 degrees, no water, no
         green. It hardly matters, because from orbit you only ever see the
         cloud deck, and the cloud deck is the whole point. */
      colors: {
        c0: 0x1a0c06, c1: 0x5a2c16, c2: 0x8a4a22, c3: 0x6a3a1e,
        c4: 0xb07a46, polar: 0xd8b888, water: 0x2a140a,
      },
      sea: 0.32,
      veg: 0.02,
      relief: 0.9,
      craters: 0.05,
      /* The cities float, so the night side glows faintly from above the
         ground rather than on it: warm, sparse, and in the cloud. */
      night: 0.7,
      lamp: { warm: 0xffc27a, cold: 0xffe6b0 },
      /* Total cover, cream and butter, thick and high: the planet everyone
         pictures as hell looks, from here, like a pearl. */
      clouds: { cover: 0.97, scale: 1.6, alt: 0.034, thick: 0.03, tint: 0xf6e2b4 },
      // Nothing grows on the ground. Everything grows fifty kilometres up.
      garden: false,
    },
  },
];

/** Look one up by the route it leads to, or by its key. */
export function worldFor(keyOrRoute) {
  return VIBE_WORLDS.find((w) => w.key === keyOrRoute || w.route === keyOrRoute) || null;
}

/**
 * The identifier this world's passport stamp is filed under.
 *
 * For four of the five it is simply the route, because arriving *is* the stamp.
 * Redline has no route, so it carries its identifier explicitly — and anything
 * matching a world against the passport has to go through here rather than
 * reading `.route`, or the one world you have to fight for is the one the chart
 * will never admit you have been to.
 */
export function stampRouteFor(world) {
  return (world && (world.route || world.stamp)) || null;
}
