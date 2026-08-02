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
export const WORLDS: WorldEntry[] = [
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
    key: "i-spy",
    route: "/i-spy",
    aliases: ["/ispy", "/geometry-dash"],
    name: "I Spy",
    emoji: "👁",
    kind: "game",
    blurb:
      "The Geometry Dash level, in two dimensions. One button, sixty seconds, and a screen so full of spikes that most of them have to be lying — because they are.",
    status: "Playable — desktop, phone, one button",
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
    key: "home-alone",
    route: "/home-alone",
    aliases: ["/kevin"],
    name: "Home Alone",
    emoji: "🎄",
    kind: "game",
    blurb:
      "671 Lincoln Avenue at Christmas — lights on the eaves, a tree in the window, and two men outside who think it is empty. Walk the house, light it up, arm eight traps, then shout from the top of the stairs and see who comes.",
    status: "Playable — five levels, plus free roam",
    accent: "#e0b64a",
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
      "FREE FALL — the real city, hill for hill, bridge for bridge. Fly it now; grapple and wingsuit soon.",
    status: "Sandbox — fly the city",
    accent: "#ff6a2b",
    featured: true,
    source: "src/sf",
    nav: true,
    passport: true,
    chromeless: true,
  },
  {
    key: "kart",
    route: "/kart",
    name: "Vibe Kart",
    emoji: "🏁",
    kind: "game",
    blurb:
      "Arcade kart racing — drift for mini-turbos, sling shells, and take the hairpin shortcut.",
    status: "New — one circuit, eight racers",
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
    name: "Vibe City",
    emoji: "🏙️",
    kind: "world",
    blurb:
      "Jetpack a neon district — multiplayer, NPCs, star runs, and Vibey to talk to.",
    status: "Playable — multiplayer",
    accent: "#f0abfc",
    source: "src/pages/City.tsx + src/components/city",
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
    name: "Genesis Bloom",
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
    route: "/world",
    aliases: ["/agent-lobby"],
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
    aliases: ["/vibe"],
    name: "VIBE",
    emoji: "🪙",
    kind: "tool",
    blurb: "$VIBE — the community currency hub, holders, and market.",
    accent: "#fcd34d",
    source: "src/pages/VibeHub.tsx",
    nav: true,
  },
  {
    key: "times",
    route: "/times",
    name: "The Vibe Times",
    emoji: "📰",
    kind: "tool",
    blurb: "The world's own newspaper, written nightly by the loop out of what happened.",
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

/** Featured first, otherwise the hand-tuned order above. */
export const featuredFirst = (list: WorldEntry[] = WORLDS): WorldEntry[] =>
  [...list].sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)));

export const worldsOfKind = (kind: WorldKind): WorldEntry[] =>
  WORLDS.filter((w) => w.kind === kind);

/** Everything you can actually play or walk around in — not the app's own UI. */
export const PLAYABLE = WORLDS.filter((w) => w.kind !== "tool");

/** Routes that own the whole viewport, aliases included. */
export const CHROMELESS_ROUTES: string[] = WORLDS.filter((w) => w.chromeless).flatMap(
  routesOf,
);

/** Worlds that stamp the passport, plus the one you have to earn. */
export const PASSPORT_ROUTES: { route: string; name: string; emoji: string }[] = [
  ...WORLDS.filter((w) => w.passport).map((w) => ({
    route: w.route,
    name: w.name,
    emoji: w.emoji,
  })),
  { route: CONTESTED.stampRoute, name: CONTESTED.name, emoji: CONTESTED.emoji },
];
