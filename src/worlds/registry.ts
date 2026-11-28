/**
 * The registry — one list of every destination in the vibeverse.
 *
 * Before this file there were six hand-maintained copies of "the worlds":
 * `WorldPicker`, `GlobalNav`, `HubV2`, the Terminal's gates, the passport, and
 * the ship's star chart. Each was edited by whoever was building that week, so
 * they disagreed: Vibe Kart existed in exactly one of them, Seafair and The
 * Vibeverse were missing from the landing page, and the "Village" card pointed
 * at `/` — which stopped being the village the day the hub took that route.
 *
 * A world added here shows up everywhere at once. That is the whole point, and
 * it is the reason to resist adding a seventh list: the next surface that wants
 * to show worlds should read this one.
 *
 * This module is deliberately **data only** — no images, no React, no three.
 * The passport and the vendored ship both import it, and neither should drag a
 * megabyte of card art into its chunk. Art lives next door in `art.ts`.
 */

import { IOS_APP } from "../lib/iosApp.ts";

// ---------------------------------------------------------------------------
// THE RUNNING ORDER — edit this to change what leads
// ---------------------------------------------------------------------------

/**
 * The order everything is shown in: nav, hub carousel, picker, `/game`.
 *
 * **This is the one thing to edit when you want to promote or bury a world.**
 * It lives at the top of the file on purpose — it used to sit seven hundred
 * lines down under the entries, which is a strange place to keep the knob
 * people reach for most.
 *
 * Keys only, best first. A world missing from this list is not broken; it just
 * falls in behind, in the order it happens to be declared. So a new world
 * appears at the bottom until somebody decides it has earned a place, which is
 * the right default.
 */
const ORDER: string[] = [
  "island",              // the front door — magical, gentle, works on a phone
  "thalassa",            // the harbour from the painting: walk it, swim it, VR
  "horizon",             // the garden where the future stands in a ring; Jack's live project, keep it on the front page
  "rainbow-road",        // new: Vibe Kart's rainbow road in the sky, above Vibe Summit
  "kart",                // …and the racer it runs on, one tap from the front page
  "summit",              // new: the 5,000 ft mountain, four ways down, and the rainbow road above it
  "hoops",               // new: three-on-three in the Vibe Dome, solo, couch or online
  "pool",                // new: 8-ball with real spin, vs the computer or a friend by link
  "solitaire",           // new: Klondike and FreeCell, five looks, made for a phone
  "vibe-cup",            // new: five-a-side arcade soccer, solo, couch or online
  "mort-maze",           // new: the maze chase, Vibey against Mad Mort's crew
  "bots",                // …then the thirty-second loop: your handle becomes a bot that fights
  "oni",                 // the room game: everybody's phone, one square, zombie tag
  "boxing",              // the other room game: your phone is the ring
  "magician",            // …then the valley you talk to, which rebuilds itself as you speak
  "better-fortnite",     // …then the battle royale with everything in it
  "splash-royale",       // …and the water fight, which is the one you send to a friend
  "blob",                // …and the one you can explain in four words
  "blob-battle",         // …and the guest game that plays the same way
  "coil",                // …and its twin, where being big is the problem
  "empyrean",            // the new one: a glass city on a rock, and a jetpack
  "dipsea",              // this week: Mill Valley to Stinson Beach, on foot
  "airship",             // …and the airship that flew over the East Bay
  "developer-trail",     // …and the case study that wanted to be Oregon Trail
  "duck",                // …and the robot with the rubber duck on its head
  "goggles",             // …and the triathlon swum through fogged goggles
  "agentocracy",         // …and the cardboard island that fifty agents run
  "mars",                // …and ten weeks in the desert on one wheel
  "phangan",
  "coast-road",          // …and the longboard down to the sea, twice
  "beck-road",           // …and the street Jack grew up on, one to one
  "deep",                // eight kilometres straight down, in the dark
  "orbit",               // the one you can bet on
  "arcade",              // and the one that pays out
  "shop",                // …which is what you spend it in
  "blue-angels",
  "fnaf",
  "conservatory",
  "city",
  "vibeverse",
  "strange-new-worlds",
  "i-spy",
  "edm-town",
  "ski",
  "home-alone",
  "trek",
  "run",
  "sf",
  "garden",
  "first-light",
  "coin",
  "golf",
  "evolve",
];

/**
 * What kind of thing this is, which is what `/game` groups by.
 *
 * - `game`   — has a goal, a score, or something shooting at you.
 * - `world`  — a place you walk, fly or drive around in. No win condition.
 * - `hangout`— somewhere to be with other people (or with Vibey).
 * - `tool`   — part of the app rather than part of the fiction.
 */
export type WorldKind = "game" | "world" | "hangout" | "tool";

export interface WorldEntry {
  /** Stable id. Never a route — routes move, and art is keyed off this. */
  key: string;
  /** Canonical route. This is what links point at. */
  route: string;
  /** Other routes that land in the same place, kept for old links. */
  aliases?: string[];
  name: string;
  emoji: string;
  kind: WorldKind;
  /** One sentence, in the second person, about what you do there. */
  blurb: string;
  /** Honest statement of what it is *right now* — "Playable", "In progress". */
  status?: string;
  /** Signal colour: card chrome, hub sphere tint, gradient panel. */
  accent: string;
  /**
   * What the screen is painted while this world's chunk is still downloading.
   *
   * Every route in the app is `lazy()`, so there is always a moment between
   * the tap and the first frame. `App`'s one Suspense fallback fills it with
   * this colour, and worlds that leave it unset get the app's near-black —
   * which is the right answer for nearly all of them, because that is what
   * their own loading screen opens on. Set it only when a world does *not*
   * open on black: Splash Royale comes up sky blue, and a black flash first
   * reads as a stutter.
   */
  backdrop?: string;
  /** Leads the picker and gets the wide card treatment. */
  featured?: boolean;
  /** Where the code lives, so the list is also a map of the repo. */
  source: string;
  /** Appears in the top nav (chip row, then the ⋯ overflow). */
  nav?: boolean;
  /**
   * Stamps the passport on arrival. Must be matched by a `useWorldStamp` call
   * in the world's page — the registry declares the intent, the page does it,
   * and `worlds-registry.test.ts` checks the two agree.
   */
  passport?: boolean;
  /**
   * Owns the whole viewport, so `App` hides the nav and the radio over it.
   * Every alias is hidden too — a crosshair does not want a nav bar on it
   * whichever URL you arrived by.
   */
  chromeless?: boolean;
  /** Hub carousel renders this world as a model instead of a textured sphere. */
  model?: "floating-island";
}

/**
 * Display order. Featured worlds sort to the front wherever a surface cares;
 * everything after that is hand-tuned and should stay stable, because a list
 * that reorders itself is a list nobody can build muscle memory for.
 */
const WORLDS_RAW: WorldEntry[] = [
  {
    key: "bots",
    route: "/bots",
    aliases: ["/bot"],
    name: "Bot Battle",
    emoji: "🥊",
    kind: "game",
    blurb:
      "Type your X handle and get a battle bot built from your vibe in seconds. Coach it through a rock-paper-scissors match, share the result card, and dare a friend's bot.",
    status: "Playable — phone or laptop, challenge links",
    accent: "#ffb23f",
    featured: true,
    source: "src/bots + src/pages/Bots.tsx + supabase/functions/bot-forge",
    nav: true,
  },
  {
    key: "oni",
    route: "/zombies",
    aliases: ["/zombie", "/oni", "/tag", "/oni-gokko"],
    name: "Zombie Tag",
    emoji: "🧟",
    kind: "game",
    blurb:
      "Tag at a summer festival for everybody in the room at once, with a twist: one player starts as a zombie, and anyone it touches turns too. Type a name, get a random character, and run. Last human standing wins. Phones, laptops and VR headsets in the same square.",
    status: "Playable — multiplayer, phone, laptop or VR; ?show for the projector",
    accent: "#ff5a3c",
    backdrop: "#120c1c",
    featured: true,
    source: "src/oni + src/pages/Oni.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "horizon",
    route: "/horizon",
    aliases: ["/horizon-garden"],
    name: "Horizon Garden",
    emoji: "🌅",
    kind: "world",
    blurb:
      "A quiet island at dawn with twenty-two monuments in a ring, one for each frontier worth building on: the 24/7 teammate, kids who build, pop-up cities, the robot, memory, the overnight agent, spatial computing, private money, space, self-driving, health and more. Walk up to one and it shows you where that frontier is today and where it goes in 5, 10 and 50 years, what is most interesting about it, and the move worth making.",
    status: "Explorable — desktop and phone, with an Atlas to read it all at once",
    accent: "#ff8a5c",
    backdrop: "#f6d6c6",
    featured: true,
    source: "public/worlds/horizon/index.html + src/pages/Horizon.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "venus",
    route: "/venus",
    aliases: ["/venus-rising", "/cloud-city", "/aphrodite"],
    name: "Venus Rising",
    emoji: "♀️",
    kind: "game",
    blurb:
      "Everyone raced to the Moon, then Mars. Nobody looked at Venus. Fire yourself off the lunar mass driver, fall sunward, and build a city floating 54 km up in the clouds, where it is 30 °C, the gravity is 0.9 g and breathable air is a lifting gas. Everything heavy pulls you toward a 462 °C surface. Keep it in the band and build the utopia nobody saw coming.",
    status: "Playable — desktop and phone, saves as you go",
    accent: "#ffc27a",
    backdrop: "#1a0d08",
    featured: true,
    source: "src/venus + src/pages/Venus.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "magician",
    route: "/magician",
    aliases: ["/vibe-magician", "/hoshimura", "/genie"],
    name: "The Magician",
    emoji: "🪄",
    kind: "hangout",
    blurb:
      "A valley village in rural Japan, and Vibey floating beside you in a wizard's hat. Say what you want the world to be, out loud, and it becomes it while you watch: rain, midnight, a cherry forest, northern lights, fireballs from the mountain. Rain puts the fireballs out.",
    status: "Playable — voice over OpenAI Realtime 2.1 or Live 1, flat, phone, or VR headset",
    accent: "#b98cff",
    backdrop: "#1a1030",
    featured: true,
    source: "src/magician + src/pages/Magician.tsx + supabase/functions/vibe-magician-voice",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "conservatory",
    route: "/conservatory",
    aliases: ["/glasshouse"],
    name: "The Conservatory",
    emoji: "🪴",
    kind: "world",
    blurb:
      "Forty-eight metres of Victorian glasshouse, late on a wet afternoon. The sun comes in sideways and the roof ribs cut it into bars. Nothing to collect, nothing to survive — walk to the far end and back.",
    status: "Playable — a room, and a walk",
    accent: "#8fae94",
    featured: true,
    source: "src/conservatory",
    nav: true,
    // 34 of 36 rows before this one. The panel shrinks its pitch to fit and
    // the type does not start suffering until the high forties, so there is
    // real room rather than a bump waiting to happen.
    passport: true,
    chromeless: true,
  },
  {
    key: "deep",
    route: "/deep",
    aliases: ["/midnight-zone", "/abyss"],
    name: "The Midnight Zone",
    emoji: "🔦",
    kind: "game",
    blurb:
      "Sink eight kilometres, on a submersible trimmed slightly heavy, until the sunlight gives out and the only light left is the light things make. Twelve real animals at their real depths — find them in the dark, survey them, and read what they are.",
    status: "Playable — desktop, phone, one long descent",
    accent: "#7ff0ff",
    featured: true,
    source: "src/deep",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "trek",
    route: "/trek",
    aliases: ["/star-trek", "/final-frontier"],
    name: "The Final Frontier",
    emoji: "🖖",
    kind: "game",
    blurb:
      "You are the captain, and the main viewscreen is a live render of the space your ship is actually in. Five episodes, one Constitution-class starship, and a crew who tell you what they see.",
    status: "Playable — five episodes, desktop and phone",
    accent: "#ffb648",
    featured: true,
    source: "src/trek",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "strange-new-worlds",
    route: "/strange-new-worlds",
    aliases: ["/snw", "/starfleet"],
    name: "Strange New Worlds",
    emoji: "🛸",
    kind: "game",
    blurb:
      "The other half of Star Trek — the half where nobody shoots. Twelve real systems on a real chart, warp between them at the real warp scale, make orbit, run the sensors, then beam down and talk to whoever is waiting. Vulcan, Qo'noS, Bajor, Risa, Talos IV, and Wolf 359 where the fleet is still lying.",
    status: "Playable — twelve worlds, everyone on them talks back",
    accent: "#ff9c00",
    featured: true,
    source: "src/starfleet",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "i-spy",
    route: "/i-spy",
    aliases: ["/ispy", "/geometry-dash", "/i-spy/spire"],
    name: "I Spy",
    emoji: "👁",
    kind: "game",
    blurb:
      "The Geometry Dash level, in two dimensions — one button, one beat per jump, and a screen so full of spikes that most of them have to be lying, because they are. Eleven of them now, one per corner of the vibeverse, plus The Spire: all eleven stacked into a single climb with three lives between them.",
    status: "Playable — 11 worlds + The Spire, desktop and phone, one button",
    accent: "#ff2fbf",
    featured: true,
    source: "src/ispy",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "airplane",
    route: "/airplane",
    aliases: ["/flight-209", "/209"],
    name: "Airplane!",
    emoji: "🛩️",
    kind: "game",
    blurb:
      "Trans American 209, Los Angeles to Chicago. The crew had the fish, there are 187 people behind you, and O'Hare is under a thunderstorm. You are in the left seat of a 707.",
    status: "Playable — desktop, phone, gamepad",
    accent: "#f0a020",
    featured: true,
    source: "src/airplane",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "drop-zero",
    route: "/drop-zero?mode=classic",
    aliases: ["/royale", "/br"],
    name: "Drop Zero (classic)",
    emoji: "🪂",
    kind: "game",
    blurb:
      "The original: bullets, health bars and a purple storm. The same island Splash Royale is played on, from before anyone filled the guns with water.",
    status: "Playable — the pre-water build",
    accent: "#818cf8",
    /* Deliberately not featured and not in the nav. It is the same engine with
       ctx.mode flipped, and one game deserves one card — this entry exists so
       the older build stays reachable, not so it competes for attention. */
    source: "src/royale",
    chromeless: true,
  },
  {
    key: "better-fortnite",
    route: "/better-fortnite",
    aliases: ["/better", "/bf", "/better-royale"],
    name: "Better Fortnite",
    emoji: "🪝",
    kind: "game",
    blurb:
      "The island, the storm and the build loop — plus augments you pick mid-match, a grapple on every hip, a second wind after your first down, and an island that does things while the circle closes.",
    status: "Playable — solo vs 99 with everything on",
    accent: "#f59e0b",
    backdrop: "#1b1035",
    featured: true,
    /* Same engine as Drop Zero and Splash Royale, third mode. Shares their
       source path for the stamper, for the reason on the water entry. */
    source: "src/royale",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "splash-royale",
    route: "/splash-royale",
    /* /soaked was the name for about a day. It stays an alias because links
       were already shared, and a dead link is a worse cost than a stale word. */
    aliases: ["/splash", "/soaked", "/water-fight", "/soak"],
    name: "Splash Royale",
    emoji: "💦",
    kind: "game",
    blurb:
      "The same island as Drop Zero, in swim shorts. Ten soakers, water balloons, a glue gun that sticks two people together — grab a room code, text it to a friend, and be the last one dry.",
    status: "Playable — multiplayer water fight",
    accent: "#38bdf8",
    /* The one world that does not open on black. It comes up under an open
       sky, so that is what the loading frame paints. */
    backdrop: "#3fb8ee",
    featured: true,
    /* Soaked and Drop Zero are the same engine in two modes, so they share a
       source path and will show the same date. The parenthetical that was here
       — "src/royale (mode: water)" — read fine to a human and broke the
       stamper, which passes this straight to `git log -- <path>`: no such path,
       no commits, no date, and a failing test. If the two ever need separate
       dates, the answer is separate directories, not an annotation. */
    source: "src/royale",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    /* Not ours: hosted by its author and framed through the portal, so there
       is no directory here to point `source` at and nothing to lazy-load. It
       gets a card because people should be able to find it from the grid, and
       a literal `/blob-battle` route because a card has to point at one. */
    key: "blob-battle",
    route: "/blob-battle",
    aliases: ["/blobbattle"],
    name: "Blob Battle",
    emoji: "🟢",
    kind: "game",
    blurb:
      "A guest game on the arcade shelf. Eat what is smaller, run from what is bigger, split to catch what runs — last blob standing takes it.",
    status: "Playable — hosted by its author, framed here",
    accent: "#7cf59a",
    source: "src/pages/PortalPlay.tsx",
    nav: false,
  },
  {
    key: "blob",
    route: "/blob",
    aliases: ["/agar", "/agario", "/cells"],
    name: "BLOB",
    emoji: "🫧",
    kind: "game",
    blurb:
      "The petri dish. Hoover up pellets, run from anything bigger than you, and split to catch what runs — twenty-four rivals, one dish, and a leaderboard you can watch your own name climb. Grab a room code, text it to a friend, and share the dish.",
    status: "Playable — phone and desktop, rooms with friends",
    accent: "#5ef0a8",
    featured: true,
    source: "src/blob",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "coil",
    route: "/coil",
    aliases: ["/slither", "/snake", "/worm"],
    name: "COIL",
    emoji: "🐍",
    kind: "game",
    blurb:
      "One long arena where nobody is too big to kill. You cannot stop and you cannot reverse — only turn — so getting in front of somebody is the whole game. The character you bought in the shop rides the front of your snake, and so does everybody else's.",
    status: "Playable — phone and desktop",
    accent: "#ff6ad5",
    featured: true,
    source: "src/coil",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "hoops",
    route: "/hoops",
    aliases: ["/basketball", "/vibe-hoops", "/bball", "/vibe-dome"],
    name: "Vibe Hoops",
    emoji: "🏀",
    kind: "game",
    blurb:
      "Three-on-three basketball in the Vibe Dome, a sold-out arena with a four-sided jumbotron, sweeping spotlights and a crowd that roars when somebody throws one down. Play as Vibey, Mad Mort's junkyard crew, the samurai, the pirates, the wizards or your own My Vibe character. Hold shoot and let go at the top of the meter for a perfect shot, sprint in for a dunk, or lob it up for an alley-oop. Play the computer, a friend on the same keyboard, or friends online on their own phones.",
    status: "Playable on phone (thumb stick) and desktop, 1 to 6 players, online rooms",
    accent: "#ff7a1a",
    featured: true,
    source: "src/hoops",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "vibe-cup",
    route: "/vibe-cup",
    aliases: ["/soccer", "/football", "/futbol", "/kickabout"],
    name: "Vibe Cup",
    emoji: "⚽",
    kind: "game",
    blurb:
      "Five-a-side arcade soccer in a floodlit cage. Play the Vibe Cup, a six-club tournament where every other match runs live beside yours, or a quick match. Pick a club from around the Vibe Verse, ping passes about, slide in for the ball and hold shoot for a flaming SUPER SHOT. Two and a half minutes, golden goal if it is level. Play the computer, a friend on the same keyboard, or up to three friends online, each on their own phone.",
    status: "Playable on phone (thumb stick) and desktop, 1 to 4 players, online rooms",
    accent: "#1fd1b0",
    featured: true,
    source: "src/vibecup",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "mort-maze",
    route: "/mort-maze",
    aliases: ["/maze", "/chomp", "/munch"],
    name: "Mort's Maze",
    emoji: "🎈",
    kind: "game",
    blurb:
      "A maze chase on Vibe Island at night. Roll Vibey round the hedges eating every Vibey Coin while Mad Mort, Lunatic Linda, Hubcap Hank and Rusty Ray hunt you down. Pop a water balloon and the whole crew is soaked and running, so splash them back to the junkyard for big points.",
    status: "Playable on phone (swipe) and desktop, three mazes",
    accent: "#ffd23f",
    featured: true,
    source: "src/mortmaze",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "pool",
    route: "/pool",
    aliases: ["/8-ball", "/8ball", "/eight-ball", "/billiards"],
    name: "8-Ball Club",
    emoji: "🎱",
    kind: "game",
    blurb:
      "Eight-ball pool with physics that feel right: draw, follow and english all work, balls click and rattle into the leather, and the cushions throw spin back at you. Drag to aim, pull the cue back to shoot, call your pocket for the 8. Play the computer on easy, normal or hard, pass the phone to a friend, or send a link and play them online. Five tables, from a club room to deep space.",
    status: "Playable on phone and desktop, vs computer, pass and play, online by link",
    accent: "#ffd166",
    featured: true,
    source: "src/pool",
    nav: true,
    passport: true,
    chromeless: true,
    backdrop: "#1c130c",
  },
  {
    key: "solitaire",
    route: "/solitaire",
    aliases: ["/klondike", "/freecell", "/cards", "/patience"],
    name: "Solitaire",
    emoji: "🃏",
    kind: "game",
    blurb:
      "The card game everybody knows, made to feel good. Drag a card or just tap it and it flies to the best spot, undo as much as you like, draw one or three, and when you win the whole deck bounces off the table. Switch to FreeCell for the thinking version, and pick a look: card club felt, neon night, island sunset, airmail or deep space.",
    status: "Playable on phone and desktop, Klondike and FreeCell",
    accent: "#ffd84a",
    featured: true,
    source: "src/solitaire",
    nav: true,
    passport: true,
    chromeless: true,
    backdrop: "#1d6b42",
  },
  {
    key: "2048",
    route: "/2048",
    aliases: ["/twenty48", "/merge"],
    name: "Neon 2048",
    emoji: "🔢",
    kind: "game",
    blurb:
      "2048, painted out of the petri dish — every tile a lit cell on BLOB's dark water, climbing the colour wheel as it doubles. Swipe or arrow, one undo, and the tile you are playing for is the only green on the board.",
    status: "Playable — phone and desktop, 4×4 and 5×5",
    accent: "#4de2ff",
    source: "src/twenty48",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "blue-angels",
    route: "/blue-angels",
    aliases: ["/angels", "/seafair-show"],
    name: "Blue Angels",
    emoji: "🔵",
    kind: "game",
    blurb:
      "Seafair over Lake Washington. You fly number 1 and the other five fly your wing — over a real Seattle, from Alki to Rainier.",
    status: "Playable — desktop, phone, gamepad",
    accent: "#ffc61e",
    featured: true,
    source: "src/angels",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "run",
    route: "/run",
    aliases: ["/gump", "/forrest"],
    name: "Run, Vibey, Run",
    emoji: "🏃",
    kind: "game",
    blurb:
      "A whole life, at a run, with the timeline of it across the top of the screen. Six chapters: the road out of Greenbow with the braces still on, a kickoff return that does not stop at the end zone, the treeline in the rain, a ping-pong match to eleven, a shrimp boat in a hurricane, and then across America with the crowd assembling behind you.",
    status: "Playable — six chapters, desktop and phone",
    accent: "#e0b53a",
    featured: true,
    source: "src/gump",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    /* Shipped as a film tribute and rebuilt as its own game; the key and the
       directory kept the old name, and the old link still opens it. */
    key: "home-alone",
    route: "/house-rules",
    aliases: ["/home-alone", "/traps"],
    name: "House Rules",
    emoji: "🪤",
    kind: "game",
    blurb:
      "You are eight, the house is yours until Sunday, and five people would like what is in it. Lay marbles, tripwires, soap and a springboard where they have to walk, then shout and watch one trap throw a burglar into the next.",
    status: "Playable: five nights, endless after that, and a sandbox",
    accent: "#e0b64a",
    /* A winter night, not a void: the house's own opening frame. */
    backdrop: "#0d1524",
    featured: true,
    source: "src/homealone",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "fnaf",
    route: "/fnaf",
    aliases: ["/five-nights"],
    name: "Five Nights at Vibey's",
    emoji: "🐻",
    kind: "game",
    blurb:
      "Midnight to six in a pizzeria that does not want you there. Two doors, two lights, eleven cameras, one battery — and four animatronics walking the building on their own.",
    status: "Playable — five nights, and a sixth if you earn it",
    accent: "#dc2626",
    featured: true,
    source: "src/fnaf",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "terminal",
    route: "/terminal",
    name: "The Terminal",
    emoji: "🛫",
    kind: "world",
    blurb:
      "The front door. Stand on a platform in the sky with every world floating around you, and pick one.",
    status: "Playable — the lobby",
    accent: "#38bdf8",
    featured: true,
    source: "src/terminal",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "boxing",
    route: "/boxing",
    aliases: ["/box", "/haymaker", "/punch"],
    name: "Haymaker",
    emoji: "🥊",
    kind: "game",
    blurb:
      "Boxing in your own living room. Prop your phone up, step back, and the camera watches you: throw real punches, lean away from a glowing glove to slip it, put your fists up to cover. The opponent stands in your room and your gloves are drawn on your own hands. Four fighters, from a rattling soup can to a thundercloud that is technically the champ. No camera? Same fight in a ring, with thumbs or keys.",
    status: "New: camera boxing on a phone or laptop, or thumbs and keys",
    accent: "#ffc23a",
    backdrop: "#07070d",
    source: "src/boxing + src/pages/Boxing.tsx",
    nav: true,
    /* No passport stamp: the cockpit panel is full (see fogcity). */
    chromeless: true,
  },
  {
    key: "cannon-run",
    route: "/cannon-run",
    aliases: ["/cannon-chase", "/cannonchase", "/cannonrun", "/car-chase", "/chase"],
    name: "Cannon Chase",
    emoji: "💣",
    kind: "game",
    blurb:
      "Midnight on a desert highway, an old ship's cannon bolted into the bed of your pickup, and Mad Mort's headlights filling the rear view. Swerve, hit the nitro, and lob iron at him until his truck gives up. Then he comes back in a bigger one, all the way up to a train, with his junkyard pals in ridiculous hats for backup. Two trucks on one screen or a friend on their phone, and then his cousin Lunatic Linda joins the chase.",
    status: "New: the showdown at Dot's Diner",
    accent: "#ffb43a",
    backdrop: "#0b0f1c",
    featured: true,
    source: "src/cannonrun + src/pages/CannonRun.tsx",
    nav: true,
    /* No passport stamp: the cockpit panel is full (see fogcity). */
    chromeless: true,
  },
  {
    key: "summit",
    route: "/summit",
    aliases: ["/vibe-summit"],
    name: "Vibe Summit",
    emoji: "🏔️",
    kind: "game",
    blurb:
      "A 5,000 ft mountain with a snowy forest at its feet. Pick your way down: carve it on skis, spin a snowboard off the kickers, dive a wingsuit through the rings or float a paraglider on the thermals. Then ride the rainbow beam up into Vibe Kart and race the Prism Skyway above the peak.",
    status: "New: four ways down and a rainbow road",
    accent: "#9be7ff",
    backdrop: "#9fc3ea",
    source: "src/summit + src/pages/Summit.tsx",
    nav: true,
    /* No passport stamp: the cockpit panel is full (see fogcity). */
    chromeless: true,
  },
  {
    key: "rainbow-road",
    route: "/rainbow-road",
    aliases: ["/prism-skyway", "/skyway"],
    name: "Prism Skyway",
    emoji: "🌈",
    kind: "game",
    blurb:
      "Vibe Kart's rainbow road in the sky: a glowing ribbon high above Vibe Summit at twilight, with the snowy peak below, a jump over nothing and open edges you can fall off. Same karts, same drift and mini-turbos, eight on the grid or a room code for friends.",
    status: "New: a Vibe Kart course",
    accent: "#c77dff",
    backdrop: "#140a2e",
    source: "src/kart/rainbow",
    nav: true,
    chromeless: true,
  },
  {
    key: "fogcity",
    route: "/fogcity",
    aliases: ["/fog-city"],
    name: "Fog City",
    emoji: "🌁",
    kind: "game",
    blurb:
      "An open-world San Francisco built to run fast. Walk the hills, borrow any car on the street, run courier jobs between the Painted Ladies, the Pyramid, Coit Tower and the far side of the Golden Gate, and lose the police when you drive like it. Day turns to night, the windows come on, and the fog rolls in when you ask it to.",
    status: "New: drive it, walk it, outrun the heat",
    accent: "#ff8a3d",
    backdrop: "#16202c",
    featured: true,
    source: "src/fogcity + src/pages/FogCity.tsx",
    nav: true,
    /* No passport stamp yet: the cockpit panel that lists them is full at 54
       rows and truncates silently past that. Add `passport: true` here and a
       `useWorldStamp` in the page together, once the panel has room. */
    chromeless: true,
  },
  {
    key: "thalassa",
    route: "/thalassa",
    aliases: ["/harbor", "/harbour", "/greek-harbor"],
    name: "Thalassa",
    emoji: "🏛️",
    kind: "world",
    blurb:
      "A walled harbour town on a turquoise bay. Wander the market on the quay, climb the winding stair to the temple on the cliff island, swim out to the galleys, or put on a headset and do it in VR.",
    status: "New: walk it, swim it, VR",
    accent: "#2fb6d0",
    backdrop: "#cfe6f3",
    featured: true,
    source: "src/thalassa + src/pages/Thalassa.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "island-2",
    route: "/island-2",
    aliases: ["/vibe-island-2"],
    name: "Vibe Island II",
    emoji: "🏝️",
    kind: "world",
    blurb:
      "The floating archipelago, rebuilt — a carved lagoon that spills into the clouds, and islands you can fly underneath.",
    status: "In progress — fly it now",
    accent: "#ffb347",
    featured: true,
    source: "src/island2",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "vibeverse",
    route: "/vibeverse",
    aliases: ["/explorer", "/long-silence"],
    name: "The Vibeverse",
    emoji: "🛰️",
    kind: "game",
    blurb:
      "The whole place, seen from orbit. Fly the survey vessel Vibey between the stars — some of them are real worlds you can land on, and one of them shoots back.",
    status: "Playable — desktop, wants a real GPU",
    accent: "#8fe4ff",
    featured: true,
    source: "src/longsilence",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "empyrean",
    route: "/empyrean",
    aliases: ["/floating-city", "/skycity"],
    name: "The Empyrean",
    emoji: "🪐",
    kind: "world",
    blurb:
      "A city of glass on a rock that never landed, six hundred metres over a frozen lake that shows you all of it upside down. Ride the ring tram, walk into somebody's kitchen, take the lift to the sky deck, fly down to the camp on the ice — and after dark the lanterns go up. Walked on foot or flown with Vibe City's jetpack, as whoever you already are.",
    status: "Playable — a city, a jetpack, and things to do in both",
    accent: "#ff9a5a",
    featured: true,
    source: "src/empyrean",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "dipsea",
    route: "/dipsea",
    aliases: ["/quad-dipsea"],
    name: "The Dipsea",
    emoji: "🏃",
    kind: "game",
    blurb:
      "Mill Valley to Stinson Beach on foot: 688 stairs, Muir Woods, Cardiac, Steep Ravine, the ocean — the real course profile under your feet. Effort is the only control. Manage the legs, the bottle and the nausea that arrives at mile four, touch a tree when you can, and try to beat Janine, Liv and Noah to the beach. Then, if you must, run it four times.",
    status: "Playable — one Dipsea or the quad, desktop and phone",
    accent: "#7ee2a0",
    backdrop: "#d8e3ea",
    featured: true,
    source: "src/dipsea + src/pages/Dipsea.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "airship",
    route: "/airship",
    aliases: ["/pathfinder"],
    name: "Pathfinder",
    emoji: "🎈",
    kind: "game",
    blurb:
      "A 406-foot rigid airship over San Francisco Bay at sunset. Thirteen bags of helium, eight bags of ballast, a wind off the Golden Gate, and five relief drops — Sausalito, Alcatraz, Treasure Island, Angel Island, Berkeley — before you bring her home to Hangar One. She does everything twenty seconds after you ask, and every pallet you drop makes her lighter, which means up.",
    status: "Playable — slow, calm, and harder than it looks",
    accent: "#ffb347",
    backdrop: "#f0c8a0",
    featured: true,
    source: "src/airship + src/pages/Airship.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "developer-trail",
    route: "/developer-trail",
    aliases: ["/devtrail"],
    name: "Developer Trail",
    emoji: "🏘️",
    kind: "game",
    blurb:
      "Oregon Trail, but the wagon is a nine-lot cottage project. Pick who you are and where — Healdsburg, Bend, Bainbridge, Port Orchard — then walk the Path to Capital, entitle it, build it and sell it in thirty-six months. Every month you choose a pace and a card turns: a hidden cavern under lot four, a neighbour with a lawyer, an airship overhead. Two inks on paper. You know how this genre ends.",
    status: "Playable — a ten-minute run, any screen",
    accent: "#d9442f",
    backdrop: "#f3ecdc",
    featured: true,
    source: "src/devtrail + src/pages/DeveloperTrail.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "duck",
    route: "/duck",
    aliases: ["/vibey-party"],
    name: "Duck On My Head",
    emoji: "🦆",
    kind: "game",
    blurb:
      "A house party from Vibey's own camera. You are a Reachy Mini on the coffee table with a rubber duck on your head, and six people want your attention. Look at whoever is talking. Keep the hotspot alive. Turn the volume up when it defaults low again. And when a sub-agent posts into your context that the SSH bridge is fixed, wait for the gap in the conversation before you say so out loud.",
    status: "Playable — two and a half minutes, then the biryani",
    accent: "#ffd23f",
    featured: true,
    source: "src/duck + src/pages/Duck.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "goggles",
    route: "/goggles",
    aliases: ["/triathlon"],
    name: "The Half-Blind Triathlon",
    emoji: "🥽",
    kind: "game",
    blurb:
      "Lake Chelan, first triathlon, ten days' notice: the goggles fog on the first stroke and stay fogged, so you swim by orange blob, breathe on the beat and not into a wave, and drink a measurable percentage of the lake; then a bike with no top gear and no brakes over 1,700 feet of rollers, and a 10 km run on shoes with no cushion left, with a voice note every kilometre. Expected three hours. Closer to four. Finished.",
    status: "Playable: three legs, about seven minutes, desktop and phone",
    accent: "#ff6a1a",
    backdrop: "#9fb9b3",
    featured: true,
    source: "src/goggles + src/pages/Goggles.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "agentocracy",
    route: "/agentocracy",
    aliases: ["/cardboard-city", "/bainbridge"],
    name: "Agentocracy",
    emoji: "🏛️",
    kind: "game",
    blurb:
      "A cardboard Bainbridge Island run by fifty AI agents with a $20,000 treasury in Snack Bay tokens, and it works. The ferry horn opens a round, a proposal is read at the plaza, the agents argue, and you delegate to your agent, override it, or sit it out. Twelve rounds, one constitution, twenty invisible cows, and a shoe on the church roof.",
    status: "Playable: twelve ferries, three endings, desktop and phone",
    accent: "#f2c531",
    backdrop: "#c9a878",
    featured: true,
    source: "src/agentocracy + src/pages/Agentocracy.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "mars",
    route: "/mars",
    aliases: ["/mars-college", "/bombay-beach"],
    name: "Mars College",
    emoji: "🏜️",
    kind: "game",
    blurb:
      "Ten weeks off-grid near the Salton Sea on an electric unicycle with the music up: build a plywood shelter before the cold gets you, ride to town for water every few days, cook dinner at the one table so six camps eat together, get a noticeably longer hug, survive the brown wall of dust that comes in over the sea, and then take the whole thing down. Burning Man met AI nerds, but for three months, and somebody put a flag on the porta potties.",
    status: "Playable, ten weeks, desktop and phone",
    accent: "#ff9a5c",
    backdrop: "#d9c9a8",
    featured: true,
    source: "src/mars + src/pages/Mars.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "phangan",
    route: "/phangan",
    aliases: ["/koh-phangan", "/flow-phangan"],
    name: "Flow Phangan",
    emoji: "🛵",
    kind: "game",
    blurb:
      "Koh Phangan, April 2025: ferry six builders round the ring road on a five-dollar scooter to a meetup at a secret location, one on the back at a time telling you about their Telegram bot, before the rain, before dark, and before Muay Thai at 8:30 whether you are ready or not.",
    status: "Playable, one eight-minute day, desktop and phone",
    accent: "#ffd36a",
    backdrop: "#6ec6c0",
    featured: true,
    source: "src/phangan + src/pages/Phangan.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "coast-road",
    route: "/coast-road",
    aliases: ["/longboard", "/skate", "/downhill"],
    name: "Coast Road",
    emoji: "🛹",
    kind: "game",
    blurb:
      "Two and a half kilometres downhill to the sea on a longboard, with the wind in the grass and in your ears. One road, two looks: a painted bay under a cumulus stack, or an action camera on a suburban descent that smears at the edges when you are fast.",
    status: "Playable: four minutes a run, desktop and phone",
    accent: "#2fb7e6",
    backdrop: "#bfe2f6",
    featured: true,
    source: "src/coastroad + src/pages/CoastRoad.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "beck-road",
    route: "/beck-road",
    aliases: ["/beck", "/lytle-beach", "/blakely"],
    name: "Beck Road",
    emoji: "🏡",
    kind: "world",
    blurb:
      "The neighbourhood around 8330 NE Beck Road on Bainbridge Island, from Blakely Elementary to Lytle Beach, rebuilt one to one from the map: every road down to the driveways, every building on its real footprint, mailboxes with the real numbers, the street signs, the power lines, the firs.",
    status: "Walkable: real geometry, procedural materials, sun or a grey day",
    accent: "#3f6a2e",
    backdrop: "#c9d0d6",
    featured: true,
    source: "src/beck + src/pages/Beck.tsx",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "seafair",
    route: "/seafair",
    name: "Seafair 2117",
    emoji: "🛩️",
    kind: "world",
    blurb:
      "Future Seattle on Seafair weekend. Hydros on Lake Washington, Blue Angels overhead, and something alien holding the Space Needle.",
    status: "In progress — playable, being art-directed",
    accent: "#12a5f5",
    featured: true,
    source: "src/seafair",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "dunes",
    route: "/dunes",
    aliases: ["/dune-sea"],
    name: "The Dune Sea",
    emoji: "🏜️",
    kind: "game",
    blurb:
      "Sandboard nine hundred metres of sunset dunes down to the oasis. You never push — the slope is the engine — and every gate you ride puts the sun back up.",
    status: "Playable — one long descent, desktop and phone",
    accent: "#ff9f4a",
    featured: true,
    source: "src/dunes",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "glass-lake",
    route: "/glass-lake",
    aliases: ["/aurora"],
    name: "The Glass Lake",
    emoji: "🌌",
    kind: "world",
    blurb:
      "Black ice at night under a living aurora. Skate it, carve it, and bring twelve fallen shards back to the sky.",
    status: "Playable — skate, carve, collect",
    accent: "#5cf0c0",
    featured: true,
    source: "src/glasslake",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "first-light",
    route: "/first-light",
    aliases: ["/lake"],
    name: "First Light",
    emoji: "🌒",
    kind: "world",
    blurb:
      "A lake an hour before sunrise. Nothing to win — walk the shore, stand in the shallows, and watch it come up.",
    status: "Playable — walk it",
    accent: "#c9784a",
    source: "src/firstlight",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "san-palmas",
    route: "/san-palmas",
    aliases: ["/fps"],
    name: "San Palmas",
    emoji: "🌴",
    kind: "game",
    blurb:
      "Tropical San Francisco — the vibeverse's FPS. Guns, sun, and a very long draw distance.",
    status: "Playable — move, look, shoot",
    accent: "#ffb020",
    featured: true,
    source: "src/palmas",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "sf",
    route: "/sf",
    aliases: ["/san-francisco", "/free-fall"],
    name: "San Francisco",
    emoji: "🌉",
    kind: "game",
    blurb:
      "The real city, hill for hill, bridge for bridge, nine kilometres of it — in the weather San Francisco is actually having right now, fetched live: if Karl is in off the Pacific this afternoon, he is in here too. Other people are in it with you, as their own characters, with their names above their heads. Walk it past thirty-three landmarks, get into any parked car and drive off, and share the streets with a crowd cast by neighbourhood and by the hour. Then climb the Terraces on Twin Peaks — seven watercolour levels, a pagoda, a vineyard and a snow line, ending in a pavilion at 440 metres. Nothing is chasing you and nothing is keeping score.",
    status: "Multiplayer open world — walk it, drive it, or fly it",
    accent: "#ff6a2b",
    featured: true,
    source: "src/sf",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "frisco",
    route: "/frisco",
    aliases: ["/vibe-francisco", "/toy-sf"],
    name: "Vibe Francisco",
    emoji: "🌁",
    kind: "world",
    blurb:
      "San Francisco as a toy you can fly around. The real downtown — both street grids, the hills, the waterfront, twelve landmarks from the Transamerica to Alcatraz — painted in flat colour and built small enough to hold. Strap the jetpack on your own character, ride the Powell Street cable car, fly a ring course up Market, and watch nine thousand windows come on at dusk.",
    status: "Playable — walk it, fly it, or ride the cable car",
    accent: "#ff8a3d",
    featured: true,
    backdrop: "#8fd0f0",
    source: "src/frisco",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "kart",
    route: "/kart",
    /* `/kart-mp` was a second card for the same racetrack, and the choice it
       asked you to make — solo or with friends — is one the title screen is
       better placed to ask. Kept as an alias so old links still land. */
    aliases: ["/kart-mp"],
    name: "Vibe Kart",
    emoji: "🏁",
    kind: "game",
    blurb:
      "Arcade kart racing — drift for mini-turbos, sling shells, and take the hairpin shortcut. Race the CPU field, or share a room code and put up to five friends on the grid.",
    status: "Playable — single player and six-kart rooms",
    accent: "#ffcc22",
    featured: true,
    source: "src/kart",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "golf",
    route: "/golf",
    name: "Vibe Golf",
    emoji: "⛳",
    kind: "game",
    blurb:
      "Physics golf across 63 holes — portals, jetpacks, and a bag of very silly balls.",
    status: "Playable — 63 holes",
    accent: "#34d399",
    source: "src/golf",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "edm-town",
    route: "/edm-town",
    name: "EDM Town",
    emoji: "🪩",
    kind: "hangout",
    blurb:
      "Low-poly neon festival town — lasers, a dancing crowd, photo mode, and a guestbook.",
    status: "Playable",
    accent: "#ff2bd6",
    source: "src/pages/EdmTown.tsx",
    nav: true,
    passport: true,
  },
  {
    key: "city",
    route: "/city",
    aliases: ["/world"],
    name: "Vibe City",
    emoji: "🏙️",
    kind: "world",
    blurb:
      "Jetpack a neon district — multiplayer, NPCs, star runs, and Vibey to talk to. Then swim out and dive: the bay has wrecks on the bottom, and somewhere offshore it does not have a bottom at all.",
    status: "Playable — multiplayer",
    accent: "#f0abfc",
    source: "src/pages/City.tsx + src/components/city + src/city",
    nav: true,
    passport: true,
  },
  {
    key: "island",
    route: "/city?spawn=island",
    name: "Vibe Island",
    emoji: "🏝️",
    kind: "world",
    blurb:
      "A magically weird world in the sky — Jerry, the SnackFe cafe, the zipline, and the rideable zeppelin. Lands you right on it.",
    accent: "#fde68a",
    source: "src/components/city",
    nav: true,
    model: "floating-island",
  },
  {
    key: "ski",
    route: "/city?spawn=ski",
    name: "Powder Peak",
    emoji: "⛷️",
    kind: "world",
    blurb:
      "The ski world — carve real slopes, ride the gondola, warm up at the Vibe Lodge.",
    accent: "#bae6fd",
    source: "src/components/city",
    nav: true,
  },
  {
    key: "moon",
    route: "/city?spawn=moon",
    name: "The Moon",
    emoji: "🌙",
    kind: "world",
    blurb:
      "A tiny landable moon near Vibe Island — touch down on the glowing pad and plant your flag.",
    accent: "#cfd5e0",
    source: "src/components/city",
    nav: true,
  },
  {
    key: "vibestar",
    route: "/city?spawn=vibestar",
    name: "Vibe Star",
    emoji: "⭐",
    kind: "world",
    blurb: "The star above the city — the long way up, and the view from it.",
    accent: "#fde047",
    source: "src/components/city",
    nav: true,
  },
  {
    key: "island-explorer",
    route: "/island-explorer",
    aliases: ["/island"],
    name: "Island Explorer",
    emoji: "🧭",
    kind: "world",
    blurb:
      "Pick a character and a world — Sunset Cove, Sky Island, the village — and walk, run and jump around it.",
    accent: "#fbbf24",
    source: "src/island",
    nav: true,
  },
  {
    key: "space",
    route: "/space",
    aliases: ["/unit7"],
    name: "Space Outpost",
    emoji: "🌌",
    kind: "hangout",
    blurb:
      "Vibey 2.0's late-night show on a floating asteroid, with the alien next door.",
    accent: "#7dd3fc",
    source: "src/pages/Unit7Playground.tsx",
    nav: true,
  },
  {
    key: "evolve",
    route: "/evolve",
    aliases: ["/bestiary"],
    name: "Evolution",
    emoji: "🧬",
    kind: "game",
    blurb: "The evolution sim — play a creature, eat, mutate, survive the apex.",
    status: "Playable",
    accent: "#a3e635",
    source: "src/game",
    nav: true,
  },
  {
    key: "ninja",
    route: "/ninja",
    name: "Fruit Ninja",
    emoji: "🍉",
    kind: "game",
    blurb: "Slice fruit in VR (or with the mouse) and chase the high score.",
    status: "Playable",
    accent: "#fda4af",
    source: "src/pages/FruitNinja.tsx",
    nav: true,
  },
  {
    key: "globetrotter",
    route: "/globetrotter",
    aliases: ["/geo"],
    name: "Globetrotter",
    emoji: "🌍",
    kind: "game",
    blurb:
      "The world inside the world — get dropped somewhere on the real Earth and work out where you are.",
    status: "Playable",
    accent: "#60a5fa",
    source: "src/pages/Globetrotter.tsx",
    nav: true,
  },
  {
    key: "go",
    route: "/go",
    name: "Vibe GO",
    emoji: "📍",
    kind: "game",
    blurb:
      "Pokémon-GO-style catching in the real world — walk around, find vibes, collect them.",
    status: "Playable — phone first",
    accent: "#4ade80",
    source: "src/pages/VibeGo.tsx",
    nav: true,
  },
  {
    key: "garden",
    route: "/garden",
    aliases: ["/gallery"],
    name: "Memory Garden",
    emoji: "🌱",
    kind: "hangout",
    blurb: "Vibey's memory garden — walk among planted memories and the art fair.",
    accent: "#86efac",
    source: "src/pages/MemoryGarden.tsx",
    nav: true,
    passport: true,
  },
  {
    key: "museum",
    route: "/museum",
    name: "Fractal Museum",
    emoji: "🖼️",
    kind: "hangout",
    blurb: "A walkable, Seuss-flavoured gallery of famous fractals.",
    accent: "#fbcfe8",
    source: "src/pages/Museum.tsx",
    nav: true,
  },
  {
    key: "agent-lobby",
    route: "/agent-lobby",
    name: "VIBE World",
    emoji: "🛋️",
    kind: "hangout",
    blurb:
      "An always-on room that agents join over HTTP and live in. Drop in and see who is home.",
    accent: "#c084fc",
    source: "src/pages/AgentLobby.tsx",
    nav: true,
  },
  {
    key: "village",
    route: "/welcome",
    name: "Healdsburg Village",
    emoji: "🗺️",
    kind: "world",
    blurb:
      "Where this all started — the real Healdsburg map, with Vibey, Unit-7, choppers and spawnable worlds over the real streets.",
    status: "The original",
    accent: "#5eead4",
    source: "src/pages/Index.tsx + src/components/MapView.tsx",
    nav: true,
  },
  {
    key: "lobby",
    route: "/lobby",
    name: "Lobby",
    emoji: "🏎️",
    kind: "tool",
    blurb: "Pick your character and vehicle, Mario-Kart style. ~60 to choose from.",
    accent: "#fca5a5",
    source: "src/pages/Lobby.tsx",
    nav: true,
  },
  {
    key: "characters",
    route: "/character-select",
    aliases: ["/characters", "/profile"],
    name: "Characters",
    emoji: "🧍",
    kind: "tool",
    blurb: "Who you are everywhere else — pick a character and it follows you between worlds.",
    accent: "#f9a8d4",
    source: "src/pages/CharacterSelect.tsx",
    nav: true,
  },
  {
    key: "coin",
    route: "/coin",
    aliases: ["/vibe", "/wallet"],
    name: "Vibe Coin",
    emoji: "🪙",
    kind: "tool",
    blurb:
      "Our community currency, on one page: make an account, earn Vibecoin playing, and claim it as a real token when you have enough to care about.",
    accent: "#fcd34d",
    source: "src/pages/VibeHub.tsx",
    nav: true,
    passport: true,
  },
  {
    key: "arcade",
    route: "/arcade",
    name: "Vibe Arcade",
    emoji: "🕹️",
    kind: "game",
    blurb:
      "Coin-operated cabinets. Each one charges real Vibecoin to start and pays it back if you are good enough.",
    status: "Playable — three cabinets",
    accent: "#7dffd4",
    source: "src/pages/VibeArcade.tsx",
    nav: true,
    passport: true,
  },
  {
    key: "orbit",
    route: "/orbit",
    name: "Orbit",
    emoji: "🛰️",
    kind: "game",
    blurb:
      "Hold to climb out of the gravity well, let go to fall back in, thread the gates. Stake Vibecoin into the round — everyone flies the same sky and the best run takes the pot.",
    status: "Playable — free flight, or staked",
    accent: "#8fb4ff",
    featured: true,
    source: "src/orbit/orbit.ts",
    nav: true,
    passport: true,
  },
  {
    key: "passport",
    route: "/passport",
    aliases: ["/stamps"],
    name: "The Passport",
    emoji: "🛂",
    kind: "tool",
    blurb:
      "One badge for every world in here, lit if you have been and locked if you have not. Go back to a place often enough and its stamp gains rings. One of them has no page at all and has to be earned on the ground.",
    status: "Open — twenty-eight stamps to collect",
    accent: "#8fb4ff",
    source: "src/pages/Passport.tsx",
    /* No `passport: true`. It is the book — a page in itself would be a
       stamp for having checked your stamps. */
  },
  {
    key: "manifesto",
    route: "/manifesto",
    aliases: ["/future"],
    name: "The Arcade of the Future",
    emoji: "✍️",
    kind: "tool",
    blurb:
      "Why any of this exists. Everyone can build now, because we can finally say what we mean to a computer and have it understood — and with ownership behind it, what you build stays yours. The page to send somebody before they open anything else.",
    status: "Read it",
    accent: "#c9a8ff",
    source: "src/pages/Manifesto.tsx",
    /* Not in the nav chip row. It is the best page here and the wrong one to
       put between two games — somebody arrives wanting to play, and a link to
       a manifesto competing with Splash Royale reads as a lecture. It lives
       one tap deep, from the shop and from `/game`. */
    passport: true,
  },
  {
    key: "chronicle",
    route: "/chronicle",
    aliases: ["/history"],
    name: "The Chronicle",
    emoji: "📜",
    kind: "tool",
    blurb:
      "Every world, in the order it appeared — read out of git, so it is exactly as true as the repository. When it was born, how many commits it took, how many hands. The one page here that needs no server, no account and no network, and will still open in a hundred years.",
    status: "A history that writes itself",
    accent: "#c4b2ff",
    source: "src/pages/Chronicle.tsx + scripts/chronicle.mjs",
    /* Not in the nav, for the same reason the manifesto is not: somebody
       arriving to play should meet a game first. It is one tap from `/game`
       and from the passport, which are the two places you would want it.

       And deliberately not stamped. The Chronicle *reads* your passport — it
       marks the worlds you have stood in — so a stamp for having read it would
       be the page congratulating you for looking at it. It is the shelf, not a
       book on the shelf.

       There is a second, duller reason worth recording: the archive panel in
       The Long Silence draws every passport world, computes its row pitch to
       fit, and `PASSPORT_ROWS` is the point past which the type stops being
       legible. It was already at thirty of thirty. Adding a page about the
       collection is not worth shrinking the type on a completion screen whose
       whole job is telling you what you have not done. */
  },
  {
    key: "portal",
    route: "/build",
    aliases: ["/build-a-game"],
    name: "The Portal",
    emoji: "🚪",
    kind: "tool",
    blurb:
      "The door for games nobody here wrote. Yours stays on your domain, in your repo, under your name — add four lines of JavaScript and it can pay the people who play it in Vibey Coins. It runs sandboxed, on an allowance, and it is never told who the player is.",
    status: "Open — one game in, room for yours",
    accent: "#8fb4ff",
    source: "src/portal",
    nav: true,
    passport: true,
  },
  {
    key: "shop",
    route: "/shop",
    name: "The Vibe Shop",
    emoji: "🛍️",
    kind: "tool",
    blurb:
      "Spend Vibecoin on hats, jetpacks and flames. What you buy is tied to your wallet, so it follows you to any device.",
    status: "Open — twenty-two items",
    accent: "#7dffd4",
    source: "src/pages/VibeShop.tsx",
    nav: true,
    passport: true,
  },
  {
    key: "newsroom",
    route: "/newsroom",
    aliases: ["/press"],
    name: "The Newsroom",
    emoji: "🗞",
    kind: "hangout",
    blurb:
      "The floor the paper is put together on. The wire comes in overhead, the presses wait for first light, the back issues hang on a spike, and the editor takes letters at the desk.",
    status: "Open all night",
    accent: "#ffd479",
    source: "src/newsroom",
    nav: true,
    passport: true,
  },
  {
    key: "times",
    route: "/times",
    name: "The Vibe Times",
    emoji: "📰",
    kind: "tool",
    blurb:
      "The world's own newspaper. A new issue every morning: what got built, who greeted whom, and the wire from outside the sky.",
    accent: "#e7e5e4",
    source: "src/pages/VibeTimes.tsx",
    nav: true,
  },
  {
    key: "companions",
    route: "/companions",
    name: "Agent Lab",
    emoji: "🧪",
    kind: "tool",
    blurb:
      "Experimental — hatch your own companion: name it, give it a personality, pick a look.",
    status: "Experimental",
    accent: "#a78bfa",
    source: "src/pages/Companions.tsx",
    nav: true,
  },
  {
    key: "world-builder",
    route: "/world-builder",
    name: "World Builder",
    emoji: "🛠️",
    kind: "tool",
    blurb:
      "Describe the world you want and walk out with a paste-ready prompt for any AI editor.",
    accent: "#38bdf8",
    source: "src/pages/WorldBuilder.tsx",
    nav: true,
  },
  {
    key: "submit-world",
    route: "/submit-world",
    name: "Submit a World",
    emoji: "➕",
    kind: "tool",
    blurb: "Built something? Send it in and it lands in the hub next to everything else.",
    accent: "#5eead4",
    source: "src/pages/SubmitWorld.tsx",
    nav: true,
  },
  {
    key: "about",
    route: "/about",
    name: "About",
    emoji: "✨",
    kind: "tool",
    blurb: "What this is and how it is stitched together, told on a floating asteroid.",
    accent: "#c4b5fd",
    source: "src/pages/About.tsx",
    nav: true,
  },
];

const rank = (w: WorldEntry): number => {
  const i = ORDER.indexOf(w.key);
  return i === -1 ? ORDER.length + WORLDS_RAW.findIndex((r) => r.key === w.key) : i;
};

/**
 * The App Store edition. Inside the iOS app (`IOS_APP`) a few destinations are
 * left out, and a couple renamed, because Apple reviews what the app can
 * reach and the website is under no such review:
 *
 * - anything that earns, spends, bets or shows the token (3.1.1 / 3.1.5 / 5.3),
 * - places strangers can post words with no report/block yet (1.2),
 * - worlds built on somebody else's film, show or game (5.2 / 4.1).
 *
 * Hidden here means hidden everywhere, because every surface reads `WORLDS`;
 * `SafetyLayer` also sends a direct link to one of these routes home.
 */
const IOS_HIDDEN = new Set([
  "coin", "arcade", "orbit", "shop", "portal", "blob-battle", "manifesto",
  "submit-world", "world-builder", "newsroom", "times", "companions",
  "agent-lobby", "garden", "space", "chronicle", "village",
  "trek", "strange-new-worlds", "home-alone", "airplane", "fnaf",
]);
const IOS_NAMES: Record<string, string> = {
  "better-fortnite": "Vibe Royale",
  ninja: "Fruit Slice",
};

/** Every route (aliases too) that the iOS app does not offer. */
export const IOS_HIDDEN_ROUTES: ReadonlySet<string> = new Set(
  WORLDS_RAW.filter((w) => IOS_HIDDEN.has(w.key)).flatMap((w) => [w.route, ...(w.aliases ?? [])].map((r) => r.split("?")[0])),
);

const SHOWN: WorldEntry[] = IOS_APP
  ? WORLDS_RAW.filter((w) => !IOS_HIDDEN.has(w.key)).map((w) => (IOS_NAMES[w.key] ? { ...w, name: IOS_NAMES[w.key] } : w))
  : WORLDS_RAW;

export const WORLDS: WorldEntry[] = [...SHOWN].sort((a, b) => rank(a) - rank(b));

/**
 * The one world in the vibeverse with no route.
 *
 * Redline is a planet inside the ship's own galaxy — it has no page, so no
 * link can reach it and it is not in `WORLDS`. It earns a passport stamp by
 * being *held*: clearing the landing site of hostiles, on the ground, once.
 * See `src/longsilence/world/vibeworlds.js`.
 */
export const CONTESTED = {
  key: "redline",
  stampRoute: "/vibeverse/redline",
  name: "Redline",
  emoji: "🎖️",
} as const;

/** Every route a world answers on, canonical first. */
export const routesOf = (w: WorldEntry): string[] => [w.route, ...(w.aliases ?? [])];

const byRoute = new Map<string, WorldEntry>();
for (const w of WORLDS) for (const r of routesOf(w)) byRoute.set(r, w);

/** Look a world up by any of its routes. Query strings count: `/city` and
 *  `/city?spawn=ski` are different worlds that happen to share a page. */
export const worldByRoute = (route: string): WorldEntry | undefined => byRoute.get(route);

export const worldByKey = (key: string): WorldEntry | undefined =>
  WORLDS.find((w) => w.key === key);

/**
 * The curated order above wins. `featured` still exists for card styling, but
 * it no longer reshuffles the list — the explicit ORDER is the running order.
 */
export const featuredFirst = (list: WorldEntry[] = WORLDS): WorldEntry[] =>
  [...list].sort((a, b) => rank(a) - rank(b));

export const worldsOfKind = (kind: WorldKind): WorldEntry[] =>
  WORLDS.filter((w) => w.kind === kind);

/** Everything you can actually play or walk around in — not the app's own UI. */
export const PLAYABLE = WORLDS.filter((w) => w.kind !== "tool");

/**
 * Routes that own the whole viewport, aliases included.
 *
 * **Pathnames, not routes.** `AppChrome` tests these against `useLocation()`'s
 * `pathname`, which never carries a query — so an entry like
 * `/drop-zero?mode=classic` matched nothing, and Drop Zero shipped with the
 * global nav pill sitting on its crosshair and *no* home button, because the
 * chromeless branch is also the branch that hands a fullscreen world its only
 * way out. Chromeless is a property of the page, so every query variant of the
 * same path inherits it.
 */
export const CHROMELESS_ROUTES: string[] = [
  ...new Set(
    WORLDS.filter((w) => w.chromeless).flatMap((w) =>
      routesOf(w).map((r) => r.split("?")[0]),
    ),
  ),
];

/** Worlds that stamp the passport, plus the one you have to earn. */
export interface PassportRoute {
  /**
   * The world's stable id, carried through so a stamp can be *paid* for.
   *
   * The passport itself is keyed by route, which was right while it only ever
   * lived in one browser. It stopped being right the moment a visit became
   * worth coins: `/hub` has already been three different places, and a payout
   * keyed on a path pays a second time the day somebody renames one. The
   * server records `world_key` and nothing else.
   */
  key: string;
  route: string;
  name: string;
  emoji: string;
  /** The world's signal colour. The passport page tints each badge with it. */
  accent: string;
  kind: WorldKind;
  /** One line, for the back of the badge. */
  blurb: string;
  /**
   * True for the one stamp you cannot navigate to. Redline has no page — it is
   * earned by holding the landing site — so a passport page must not offer it
   * as a link, and it deserves to be marked as the only stamp of its kind.
   */
  earned?: boolean;
}

export const PASSPORT_ROUTES: PassportRoute[] = [
  ...WORLDS.filter((w) => w.passport).map((w) => ({
    key: w.key,
    route: w.route,
    name: w.name,
    emoji: w.emoji,
    accent: w.accent,
    kind: w.kind,
    blurb: w.blurb,
  })),
  {
    key: CONTESTED.key,
    route: CONTESTED.stampRoute,
    name: CONTESTED.name,
    emoji: CONTESTED.emoji,
    accent: "#ff5c5c",
    kind: "game" as WorldKind,
    blurb:
      "A planet inside the ship's own galaxy, with no page and no link. The only stamp in the book you have to earn: clear the landing site of hostiles, on the ground, once.",
    earned: true,
  },
];
