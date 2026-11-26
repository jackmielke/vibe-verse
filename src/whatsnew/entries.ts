/**
 * What's New: the player-facing changelog.
 *
 * This is the one list. The page at /whats-new, the ✨ New chip in the top
 * bar, the WHAT'S NEW box on the front page and the ✨ button on Vibe Island
 * are all views of it, so a line added here shows up in every one of them.
 *
 * How to add an update:
 *   - By hand: add an object to the TOP of `ENTRIES` below. Newest first.
 *   - From build mode: nothing to do. The workflow drops a JSON file in
 *     `src/whatsnew/auto/` with the build's own commit message, and
 *     `allEntries()` folds those in by date. One file per build, so two builds
 *     running at once can never conflict over this file.
 *
 * Write it for a player, not a developer: what they can now do and where.
 * Plain sentences, no em dashes, no file names.
 */

export type WhatsNewTag = "new" | "update" | "fix" | "event";

export interface WhatsNewEntry {
  /** Stable id, used to remember what a visitor has already seen. */
  id: string;
  /** YYYY-MM-DD, the day it went live. */
  date: string;
  emoji: string;
  title: string;
  /** One to three plain sentences. */
  body: string;
  tag?: WhatsNewTag;
  /** Where to go to try it. A path inside the site. */
  route?: string;
  /** Short name of the world it belongs to, shown as a chip. */
  world?: string;
  /** Filed by build mode rather than written by hand. */
  auto?: boolean;
}

export const ENTRIES: WhatsNewEntry[] = [
  {
    id: "city-orange-bad-guys",
    date: "2026-11-26",
    emoji: "🟠",
    title: "Bad guys break out in orange",
    body: "Summon a bad guy from the Warehouse 13 roof and he now starts behind the wheel inside the warehouse, in an orange jumpsuit and an orange getaway car, and tears out the front door. The police spot the orange cars and go after them, and they still go up in flames when they are caught.",
    tag: "update",
    route: "/city",
    world: "Vibe City",
  },
  {
    id: "city-vibe-arms",
    date: "2026-11-26",
    emoji: "🔫",
    title: "Vibe Arms: buy weapons with Vibey Coins",
    body: "A new stall on the Vibe City plaza, and the Vibe Shop on the island, sell a Super Soaker that slows cops and cars to a crawl, the Glock 19, a Nova Blaster that fires like crazy, and packs of pineapple bombs that stick to whatever they hit. Buy once, never run out. Every gun you own sits on a weapon bar at the side of the screen: tap one to draw it (or press 1 to 4), tap FIRE or hold R to shoot, and X or the 🍍 button throws a pineapple.",
    tag: "new",
    route: "/city",
    world: "Vibe City",
  },
  {
    id: "whats-new",
    date: "2026-11-26",
    emoji: "✨",
    title: "What's New",
    body: "This page! Every update to the Vibe Verse now lands here with a date, so you can see what changed since you last played.",
    tag: "new",
    route: "/whats-new",
  },
  {
    id: "city-marina",
    date: "2026-11-26",
    emoji: "🚤",
    title: "Vibe Marina and a speedboat",
    body: "A timber pier off the west beach with sailboats on their moorings and a speedboat you can drive. Press E to board from a pier or the water.",
    tag: "new",
    route: "/city",
    world: "Vibe City",
  },
  {
    id: "city-commons",
    date: "2026-11-26",
    emoji: "⚽",
    title: "Vibe Commons park and a soccer pitch",
    body: "A new park on the west side with a fountain, a pond and a five-a-side pitch. Run into the ball to kick it, and every goal counts on the scoreboard.",
    tag: "new",
    route: "/city",
    world: "Vibe City",
  },
  {
    id: "city-bad-guys",
    date: "2026-11-26",
    emoji: "🦹",
    title: "Bad guys, a hideout and a police station",
    body: "Summon up to three bad guys from the pad on the warehouse roof. Each one steals a car and runs while the police chase him down, and you can hop on his roof and shoot. The police station has a garage the cruisers roll out of.",
    tag: "new",
    route: "/city",
    world: "Vibe City",
  },
  {
    id: "city-landmarks",
    date: "2026-11-26",
    emoji: "🗼",
    title: "Space Needle, Empire State and Eiffel Tower",
    body: "Three landmarks you can ride to the top. Glass elevators up the Needle, an Art Deco express lift in the Empire State, and the Eiffel Tower sparkles every hour at night. Binoculars on every deck.",
    tag: "new",
    route: "/city",
    world: "Vibe City",
  },
  {
    id: "city-helicopter",
    date: "2026-11-26",
    emoji: "🚁",
    title: "A helicopter you can fly",
    body: "A red helicopter waits on a pad by the spawn. Walk up, hop in and fly it anywhere in the city.",
    tag: "new",
    route: "/city",
    world: "Vibe City",
  },
  {
    id: "city-police",
    date: "2026-11-26",
    emoji: "🚓",
    title: "Police that fight back, and blow up",
    body: "Crash, wreck cars or shoot and you earn up to five stars of heat. Police cruisers hunt you through the streets and ram you. Ram them back and they smoke, burn and explode. Lie low for about a minute and they let you go.",
    tag: "new",
    route: "/city",
    world: "Vibe City",
  },
  {
    id: "city-gta-junior",
    date: "2026-11-26",
    emoji: "🔫",
    title: "GTA Junior: guns, fire and exploding buildings",
    body: "Find a pistol on the plaza and a rifle hidden on a rooftop (jetpack up to the glint). Trees catch fire and spread, and hit a building hard enough and its front blows out and keeps burning.",
    tag: "new",
    route: "/city",
    world: "Vibe City",
  },
  {
    id: "island-lawnmower",
    date: "2026-11-26",
    emoji: "🚜",
    title: "A ride-on lawnmower",
    body: "There is a ride-on lawnmower on the island lawn next to the go-karts. A green beam marks it until you take it for a spin.",
    tag: "new",
    route: "/city?spawn=island",
    world: "Vibe Island",
  },
  {
    id: "cannon-chase-highlight-reel",
    date: "2026-11-26",
    emoji: "🎬",
    title: "Cannon Chase opens with a highlight reel",
    body: "The start screen is now a highlight reel of the wildest moments in the chase, with a button to read the story first.",
    tag: "update",
    route: "/cannon-run",
    world: "Cannon Chase",
  },
  {
    id: "cannon-chase-endless",
    date: "2026-11-26",
    emoji: "♾️",
    title: "Cannon Chase never ends",
    body: "The chase keeps going: past the train, the next ride just keeps coming. How long can you keep Grandpa's cannon?",
    tag: "update",
    route: "/cannon-run",
    world: "Cannon Chase",
  },
  {
    id: "cannon-chase-replay",
    date: "2026-11-26",
    emoji: "📺",
    title: "Gatch News replay",
    body: "Gatch News records every bulletin while it airs, and the end screen plays back a replay reel of every story from your night.",
    tag: "new",
    route: "/cannon-run",
    world: "Cannon Chase",
  },
  {
    id: "cannon-chase-storybook",
    date: "2026-11-26",
    emoji: "📖",
    title: "Read the story",
    body: "Cannon Chase has a storybook, for one player or two, with pictures taken from the game itself. Open it from the start screen.",
    tag: "new",
    route: "/cannon-run?story",
    world: "Cannon Chase",
  },
  {
    id: "my-vibe",
    date: "2026-11-26",
    emoji: "🪞",
    title: "My Vibe, your new profile",
    body: "Your profile is now a locker. See your character wearing your hat and stickers, equip anything you own in one tap, and see which worlds your character can go to.",
    tag: "new",
    route: "/profile",
  },
  {
    id: "thanksgiving-island",
    date: "2026-11-26",
    emoji: "🦃",
    title: "Thanksgiving on Vibe Island",
    body: "Ride a giant turkey in a pilgrim hat, watch the parade float loop the High Street, and catch the autumn leaves falling. On through 30 November.",
    tag: "event",
    route: "/city?spawn=island",
    world: "Vibe Island",
  },
  {
    id: "scoreboard",
    date: "2026-11-26",
    emoji: "🏆",
    title: "The scoreboard",
    body: "Rate every world on lore, fun and smoothness, and see how everyone else rated them, plus hours played. Cannon Chase and Vibe Island are pinned at the top.",
    tag: "new",
    route: "/scores",
  },
  {
    id: "cannon-chase-linda",
    date: "2026-11-26",
    emoji: "👵",
    title: "Lunatic Linda and the junkyard henchmen",
    body: "Mort's cousin Linda joins two-player and chases the leading truck. The henchmen now wear ridiculous hats and swing nail boards and pipes.",
    tag: "new",
    route: "/cannon-run",
    world: "Cannon Chase",
  },
  {
    id: "cannon-chase-news",
    date: "2026-11-26",
    emoji: "🎙️",
    title: "Gatch News covers your chase live",
    body: "A news chopper circles the chase with BREAKING headlines for every new ride and wreck, and Gatch Radio plays between bulletins.",
    tag: "new",
    route: "/cannon-run",
    world: "Cannon Chase",
  },
  {
    id: "cannon-chase-train",
    date: "2026-11-26",
    emoji: "🚂",
    title: "A train, an 18-wheeler and the northern lights",
    body: "After the cement truck comes an 18-wheeler, then a whole train, all under an aurora sky.",
    tag: "update",
    route: "/cannon-run",
    world: "Cannon Chase",
  },
  {
    id: "island-crashes",
    date: "2026-11-26",
    emoji: "💥",
    title: "Crashes, a monster truck and a rare Comet",
    body: "Cars on Vibe Island now dent, smoke and explode. Smash trees and lamp posts, crush traffic in the monster truck on the plaza, and keep an eye out for the super fast Comet parked under a gold beam.",
    tag: "new",
    route: "/city?spawn=island",
    world: "Vibe Island",
  },
  {
    id: "cannon-chase-launch",
    date: "2026-11-26",
    emoji: "🛻",
    title: "Cannon Chase",
    body: "A brand new game: a night chase with a ship's cannon in the back of your pickup. Mad Mort wants it back. Play solo or with a friend.",
    tag: "new",
    route: "/cannon-run",
    world: "Cannon Chase",
  },
  {
    id: "island-phones",
    date: "2026-11-26",
    emoji: "📱",
    title: "Vibe Island plays better on phones",
    body: "The buttons are out of the way of the joystick, and you ride Pegasus by walking up to it and tapping Ride.",
    tag: "fix",
    route: "/city?spawn=island",
    world: "Vibe Island",
  },
  {
    id: "build-mode",
    date: "2026-11-25",
    emoji: "🛠️",
    title: "Build mode",
    body: "Admins on Vibe Island can type or say a change, and an AI builds it into the island and ships it. Now with undo, retry and a full history.",
    tag: "new",
    route: "/city?spawn=island",
    world: "Vibe Island",
  },
  {
    id: "island-stickers",
    date: "2026-11-25",
    emoji: "🏷️",
    title: "Body stickers",
    body: "Put stickers on your character on Vibe Island, and everyone else in the world can see them.",
    tag: "new",
    route: "/city?spawn=island",
    world: "Vibe Island",
  },
  {
    id: "island-sky-mounts",
    date: "2026-11-25",
    emoji: "🐉",
    title: "Pegasus, a dragon and aerial tag",
    body: "Pegasus and a dragon rest on Vibe Island. Climb on, take to the sky and play tag in the air with other players.",
    tag: "new",
    route: "/city?spawn=island",
    world: "Vibe Island",
  },
  {
    id: "fog-city",
    date: "2026-11-22",
    emoji: "🌁",
    title: "Fog City",
    body: "A brand new open-world San Francisco, built from scratch to run fast on any device. Drive it from the Sunset to Twin Peaks.",
    tag: "new",
    route: "/fogcity",
    world: "Fog City",
  },
  {
    id: "free-fall",
    date: "2026-11-22",
    emoji: "🌉",
    title: "San Francisco in daylight",
    body: "Free Fall now opens in daylight with real water, a proper sunset and no more white roofs.",
    tag: "update",
    route: "/free-fall",
    world: "San Francisco",
  },
  {
    id: "arcade-front-page",
    date: "2026-11-18",
    emoji: "🕹️",
    title: "A new front page",
    body: "The Vibe Verse has a new arcade-style front door. On a bigger screen you can switch to the Sky or Postcard look in the corner.",
    tag: "update",
    route: "/",
  },
];
