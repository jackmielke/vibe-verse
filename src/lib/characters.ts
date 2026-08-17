/**
 * Shared character catalog. Used by /lobby ("Choose your fighter") and
 * /profile so the same roster of ~58 Quaternius characters + Vibey +
 * Alien shows up everywhere, and the active pick (stored in
 * localStorage under `lobby.character`) is consistent across worlds.
 */
import alienUrl from "@/assets/glb/alien.glb";
import vibeyUrl from "@/assets/glb/robot-expressive.glb";

const QUATERNIUS_URLS = import.meta.glob(
  "@/assets/glb/characters/*.glb",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

const CHAR_OVERRIDES: Record<string, { emoji?: string; accent?: string; blurb?: string }> = {
  Wizard: { emoji: "🧙", accent: "#a78bfa", blurb: "Casts vibes." },
  Witch: { emoji: "🧙‍♀️", accent: "#b392ff", blurb: "Pointy-hat energy." },
  Knight_Male: { emoji: "🛡", accent: "#6aa8ff", blurb: "Square-jawed and shiny." },
  Knight_Golden_Male: { emoji: "🥇", accent: "#ffd166", blurb: "Polished to a mirror." },
  Knight_Golden_Female: { emoji: "🥇", accent: "#ffd166", blurb: "Polished to a mirror." },
  Ninja_Male: { emoji: "🥷", accent: "#ff7e8a" },
  Ninja_Female: { emoji: "🥷", accent: "#ff7e8a" },
  Ninja_Sand: { emoji: "🥷", accent: "#e6c890" },
  Ninja_Sand_Female: { emoji: "🥷", accent: "#e6c890" },
  Chef_Male: { emoji: "🥘", accent: "#ffd166" },
  Chef_Female: { emoji: "🥘", accent: "#ffd166" },
  Cowboy_Male: { emoji: "🤠", accent: "#ff9f7a" },
  Cowboy_Female: { emoji: "🤠", accent: "#ff9f7a" },
  Goblin_Male: { emoji: "👺", accent: "#8ad48a" },
  Goblin_Female: { emoji: "👺", accent: "#8ad48a" },
  Casual_Male: { emoji: "🧍", accent: "#eaeaf0" },
  Casual_Female: { emoji: "🧍‍♀️", accent: "#eaeaf0" },
  Casual_Bald: { emoji: "🧑‍🦲", accent: "#eaeaf0" },
  Casual2_Male: { emoji: "🧍", accent: "#eaeaf0" },
  Casual2_Female: { emoji: "🧍‍♀️", accent: "#eaeaf0" },
  Casual3_Male: { emoji: "🧍", accent: "#eaeaf0" },
  Casual3_Female: { emoji: "🧍‍♀️", accent: "#eaeaf0" },
  Cow: { emoji: "🐄", accent: "#ffffff", blurb: "It's a cow. From space, somehow." },
  Pug: { emoji: "🐶", accent: "#ffd9b3", blurb: "Pug, just hanging out." },
  Elf: { emoji: "🧝", accent: "#a5d8ff" },
  Doctor_Female_Old: { emoji: "🧑‍⚕️", accent: "#a5d8ff" },
  Doctor_Female_Young: { emoji: "🧑‍⚕️", accent: "#a5d8ff" },
  Doctor_Male_Old: { emoji: "🧑‍⚕️", accent: "#a5d8ff" },
  Doctor_Male_Young: { emoji: "🧑‍⚕️", accent: "#a5d8ff" },
  Pirate_Male: { emoji: "🏴‍☠️", accent: "#ff7e8a" },
  Pirate_Female: { emoji: "🏴‍☠️", accent: "#ff7e8a" },
  Viking_Male: { emoji: "⚒", accent: "#c9a86a" },
  Viking_Female: { emoji: "⚒", accent: "#c9a86a" },
  Soldier_Male: { emoji: "🪖", accent: "#8ad48a" },
  Soldier_Female: { emoji: "🪖", accent: "#8ad48a" },
  BlueSoldier_Male: { emoji: "🪖", accent: "#6aa8ff" },
  BlueSoldier_Female: { emoji: "🪖", accent: "#6aa8ff" },
  Worker_Male: { emoji: "👷", accent: "#ffd166" },
  Worker_Female: { emoji: "👷", accent: "#ffd166" },
  Suit_Male: { emoji: "🕴", accent: "#9aa3b5" },
  Suit_Female: { emoji: "💼", accent: "#9aa3b5" },
  Kimono_Male: { emoji: "🎎", accent: "#ff7e8a" },
  Kimono_Female: { emoji: "🎎", accent: "#ff7e8a" },
  OldClassy_Male: { emoji: "🎩", accent: "#c9a86a" },
  OldClassy_Female: { emoji: "🎩", accent: "#c9a86a" },
  Zombie_Male: { emoji: "🧟", accent: "#8ad48a" },
  Zombie_Female: { emoji: "🧟‍♀️", accent: "#8ad48a" },
  Pirate_Anne: { emoji: "🏴‍☠️", accent: "#ff7e8a", blurb: "Anne, captain of the Esmeralda fleet." },
  Pirate_Captain_Barbarossa: { emoji: "🏴‍☠️", accent: "#c9a86a", blurb: "Barbarossa. Big beard, bigger plans." },
  Pirate_Henry: { emoji: "🏴‍☠️", accent: "#6aa8ff", blurb: "Henry. First mate." },
  Pirate_Mako: { emoji: "🦈", accent: "#a5d8ff", blurb: "Mako. Half pirate, half shark." },
  Pirate_Shark: { emoji: "🦈", accent: "#a5d8ff", blurb: "Just a shark." },
  Pirate_Sharky: { emoji: "🦈", accent: "#a5d8ff", blurb: "Sharky. Smaller, friendlier." },
  Pirate_Skeleton: { emoji: "💀", accent: "#eaeaf0", blurb: "Cursed crew member." },
  Pirate_Skeleton_Headless: { emoji: "🦴", accent: "#eaeaf0", blurb: "Lost his head, kept the vibe." },
  Pirate_Tentacle: { emoji: "🐙", accent: "#b392ff", blurb: "Kraken correspondent." },
};

export type CharSpec = {
  id: string;
  url: string;
  label: string;
  emoji: string;
  blurb: string;
  accent: string;
};

const prettyName = (filename: string) => filename.replace(/_/g, " ");

export const CHARACTERS: CharSpec[] = [
  /* The default leads. Whoever sits in this slot is both who you are before
     you have chosen and the first tile in every picker, and those being the
     same character is the whole reason the picker opens on you rather than on
     somebody else. It used to be Flux then Webslinger, which meant the second
     face anybody saw in the vibeverse was a wall-crawler. See
     DEFAULT_CHARACTER_ID. */
  {
    id: "toadstool", url: "", label: "Toadstool", emoji: "🍄",
    blurb: "A cap, a soft round body, and legs much too short for either.",
    accent: "#ffd9c2",
  },
  // Flux has no `url` because it has no model file — it is assembled
  // from primitives and animated entirely in code. Anything that renders
  // a character should go through loadCharacterRig(), which handles the
  // empty url; anything that reaches for `spec.url` directly will show
  // nothing for this one.
  {
    id: "flux", url: "", label: "Flux", emoji: "✦",
    blurb: "Built from code, not a model file. Animated head to toe.",
    accent: "#73ffb8",
  },
  // The rest of the code-built cast. Same rig, same gait solver, same
  // springs — a different design table entry each. See PILOT_DESIGNS.
  {
    id: "webslinger", url: "", label: "Webslinger", emoji: "🕷️",
    blurb: "Red-and-blue wall-crawler. Big lenses, quick feet, no model file.",
    accent: "#f2f6ff",
  },
  {
    id: "nightcape", url: "", label: "Nightcape", emoji: "🦇",
    blurb: "Cowl, ears, and a cape that swings through every turn.",
    accent: "#ffd75e",
  },
  {
    id: "whiskers", url: "", label: "Whiskers", emoji: "🐈",
    blurb: "An orange menace. The tail whips when you corner.",
    accent: "#8bf07a",
  },
  {
    id: "emberwing", url: "", label: "Emberwing", emoji: "🐉",
    blurb: "Horns, spiked tail, and wings that spread when you leave the ground.",
    accent: "#ff8a3d",
  },
  // The body-plan five. Everything else on this list — code-built or GLB —
  // is a biped, so these are the first characters here that are recognisable
  // by how they move rather than by what colour they are. Free, not stock:
  // see `characterShop.ts` for why the shelf is deliberately small.
  {
    id: "marshmallow", url: "", label: "Marshmallow", emoji: "🤍",
    blurb: "Inflated, not built. No seams, no joints, no visor — two dots and the bar between them.",
    accent: "#cfd6e6",
  },
  {
    id: "scrap", url: "", label: "Scrap", emoji: "🔭",
    blurb: "A crate on tracks with binoculars for a head. The wheels turn at the speed you are actually going.",
    accent: "#9be8ff",
  },
  {
    id: "ovoid", url: "", label: "Ovoid", emoji: "🥚",
    blurb: "No legs, no arms, no seam. Floats, banks like an aircraft, and its hands trail half a beat behind it.",
    accent: "#3fa9ff",
  },
  {
    id: "tuxedo", url: "", label: "Tuxedo", emoji: "🐧",
    blurb: "Squat and wide, with legs too short to stride — so the walk is a roll, and the roll is the joke.",
    accent: "#ffa53d",
  },
  {
    id: "sprout", url: "", label: "Sprout", emoji: "🌱",
    blurb: "Moss and bark on the same stubby body plan. Waddles, and the tail keeps swinging after it stops.",
    accent: "#ffe27a",
  },
  // The wide cast. Thirty designs assembled from the parts table in
  // `proceduralPilot.ts` rather than written one at a time.
  {
    id: "bolt", url: "", label: "Bolt", emoji: "🔵",
    blurb: "Rocks on two rigid struts and a centre foot. No knees, no stride — it tips onto one leg and then the other.",
    accent: "#2f9bff",
  },
  {
    id: "pip", url: "", label: "Pip", emoji: "🟠",
    blurb: "A ball that spins at real ground speed, with a dome head riding on top of it that stays upright.",
    accent: "#ff8f3c",
  },
  {
    id: "gilt", url: "", label: "Gilt", emoji: "🏅",
    blurb: "Polished gold, a jointed faceplate, and lit bands at every seam.",
    accent: "#fff0b8",
  },
  {
    id: "sentry", url: "", label: "Sentry", emoji: "🪖",
    blurb: "White armour and a T-slot helmet. There is no face under it and that is the whole design.",
    accent: "#5b7fb0",
  },
  {
    id: "warden", url: "", label: "Warden", emoji: "🖤",
    blurb: "Black plate, a cape to the floor, and a red core burning through it.",
    accent: "#ff2d3f",
  },
  {
    id: "bounty", url: "", label: "Bounty", emoji: "🎯",
    blurb: "Mirror plating, a pauldron, a cape and a jetpack. Dressed for somewhere with no law in it.",
    accent: "#4ad6a0",
  },
  {
    id: "bramble", url: "", label: "Bramble", emoji: "🦬",
    blurb: "Shaggy — the silhouette is spikes, not fur — with two tusks off the jaw.",
    accent: "#ffd36a",
  },
  {
    id: "elder", url: "", label: "Elder", emoji: "🍵",
    blurb: "Small, robed and enormous-eared. Old rather than cute.",
    accent: "#ffe9a8",
  },
  {
    id: "gonk", url: "", label: "Gonk", emoji: "📦",
    blurb: "A walking box with a single eye sweeping its slot. It is finished. That is the joke.",
    accent: "#ffb03a",
  },
  {
    id: "medic", url: "", label: "Medic", emoji: "💉",
    blurb: "Clinical white with a dome head and one scanning bar where a face would be.",
    accent: "#5ff2c8",
  },
  {
    id: "magnate", url: "", label: "Magnate", emoji: "🔴",
    blurb: "Red and gold armour, a lit core, a hinged faceplate and a pack on the back.",
    accent: "#7ee8ff",
  },
  {
    id: "bulwark", url: "", label: "Bulwark", emoji: "🛡️",
    blurb: "Heavy blue, a white emblem, and nothing lit anywhere on it.",
    accent: "#f4f7fb",
  },
  {
    id: "emerald", url: "", label: "Emerald", emoji: "💚",
    blurb: "No armour, because the body is the armour. There is a lot of body.",
    accent: "#d6ff8a",
  },
  {
    id: "voltaic", url: "", label: "Voltaic", emoji: "⚡",
    blurb: "Storm navy with rings that read as charge and a cape that lags behind every turn.",
    accent: "#ffe14a",
  },
  {
    id: "seraph", url: "", label: "Seraph", emoji: "😇",
    blurb: "Halo, wings, cape and a lit core. Bought to be looked at.",
    accent: "#ffcf5e",
  },
  {
    id: "vantablack", url: "", label: "Vantablack", emoji: "🕶️",
    blurb: "Matte black with thin piping and big lenses. Would rather not be seen.",
    accent: "#5b6b86",
  },
  {
    id: "crimson", url: "", label: "Crimson", emoji: "🧿",
    blurb: "A long cloak over a floating body. It does not walk anywhere.",
    accent: "#ffb95e",
  },
  {
    id: "stinger", url: "", label: "Stinger", emoji: "🐝",
    blurb: "Amber and black, antennae, and wings that open the moment you leave the ground.",
    accent: "#ffe98a",
  },
  {
    id: "titan", url: "", label: "Titan", emoji: "🗿",
    blurb: "Pauldrons, lit bands, and enough bulk to change the shape of a doorway.",
    accent: "#ff7a3d",
  },
  {
    id: "phase", url: "", label: "Phase", emoji: "🌀",
    blurb: "Seamless mirror plating with one sweeping eye. Unsettling on purpose.",
    accent: "#b46bff",
  },
  {
    id: "cinder", url: "", label: "Cinder", emoji: "🔥",
    blurb: "Lit from the inside, horned, and heavy at the back.",
    accent: "#ff5a1e",
  },
  {
    id: "frostbite", url: "", label: "Frostbite", emoji: "❄️",
    blurb: "Pale and spiked. The only warm thing on it is the light.",
    accent: "#6ff0ff",
  },
  {
    id: "mothling", url: "", label: "Mothling", emoji: "🦋",
    blurb: "Fuzzy, winged and mostly eyes. The gentlest thing on the shelf.",
    accent: "#ffe9a0",
  },
  {
    id: "jelly", url: "", label: "Jelly", emoji: "🪼",
    blurb: "Floats, glows, and has no bones in it anywhere.",
    accent: "#8affea",
  },
  {
    id: "prickle", url: "", label: "Prickle", emoji: "🌵",
    blurb: "Boxy, green and spiked along the crown. Do not hug.",
    accent: "#ffe27a",
  },
  {
    id: "origami", url: "", label: "Origami", emoji: "📄",
    blurb: "Hard folds and paper colours, with wings that fold flat.",
    accent: "#e05a4a",
  },
  {
    id: "ridgeback", url: "", label: "Ridgeback", emoji: "🐕",
    blurb: "Four legs, a long body, a head out front and a tail. Trots, properly.",
    accent: "#ffc46a",
  },
  {
    id: "strider", url: "", label: "Strider", emoji: "🤖",
    blurb: "Four legs built out of plate and light. It trots like something that was designed to.",
    accent: "#5ff2c8",
  },
  {
    id: "hauler", url: "", label: "Hauler", emoji: "🚜",
    blurb: "A crate on tracks with binoculars for a head. All cargo, no manners.",
    accent: "#ffd166",
  },
  // The originals — same rig, same table, but these six are the arcade's
  // stock and have a price on them. See `src/lib/characterShop.ts`, which is
  // the authority on which of these you have to buy; this list is only the
  // roster, and anything that renders a character has to be able to find them
  // here whether or not the player owns one yet.
  {
    id: "aurora", url: "", label: "Aurora", emoji: "🌌",
    blurb: "A halo that lags through every turn, a cape, and wings that open in the air.",
    accent: "#7df0ff",
  },
  {
    id: "grimlock", url: "", label: "Grimlock", emoji: "😈",
    blurb: "Horns and a heavy cape over a black chest with a magenta emblem burning on it.",
    accent: "#ff4fd8",
  },
  {
    id: "pixel", url: "", label: "Pixel", emoji: "🩷",
    blurb: "Short, hot pink, cat-eared, and mostly lenses. The mascot of the place.",
    accent: "#fff27a",
  },
  {
    id: "chrome", url: "", label: "Chrome", emoji: "🪞",
    blurb: "Mirror plating, a burnt-orange visor, and a metal tail with weight in it.",
    accent: "#ff7a3d",
  },
  {
    id: "bumble", url: "", label: "Bumble", emoji: "🐝",
    blurb: "Amber and black, with antennae that bob a beat behind the head.",
    accent: "#fff6c2",
  },
  {
    id: "sable", url: "", label: "Sable", emoji: "🦇",
    blurb: "Bat ears over a muzzle, and a long tail. Nocturnal rather than heroic.",
    accent: "#c9a86a",
  },
  {
    id: "eddie", url: "", label: "Eddie", emoji: "🤖",
    blurb: "Your friendly Edge Esmeralda assistant. Brass, teal, antennae, and a reactor that never stops humming.",
    accent: "#8fe9ff",
  },
  {
    id: "vibe-police", url: "", label: "Vibe Police", emoji: "🚨",
    blurb: "A corgi in uniform who has seen enough vibes for one day. NO MORE VIBES.",
    accent: "#ffc94a",
  },
  {
    id: "space-rex", url: "", label: "Space Rex", emoji: "🦖",
    blurb: "A green dinosaur in a white suit under a glass bubble. Dressed for somewhere else.",
    accent: "#b57bff",
  },
  /* The eight-legged, the airborne and the patterned.
     Free, all of them. These are the first characters on the roster you could
     pick out from behind in silhouette — three of them do not walk at all, and
     six wear a pattern drawn into a canvas at build time rather than a texture
     anybody had to ship. See `proceduralPilot.ts` for both. */
  {
    id: "pinch", url: "", label: "Pinch", emoji: "🦀",
    blurb: "Travels sideways, on eight legs, with the eyestalks still pointed where it is going. Snaps when it lands.",
    accent: "#ffe066",
  },
  {
    id: "hermit", url: "", label: "Hermit", emoji: "🐚",
    blurb: "Sand and shell, scuttling broadside. Slower than Pinch and in no hurry about it.",
    accent: "#7ce0d0",
  },
  {
    id: "barnacle", url: "", label: "Barnacle", emoji: "🌊",
    blurb: "Something from far enough down that it brought its own light. Chrome carapace, eight legs, no interest in you.",
    accent: "#3df0ff",
  },
  {
    id: "widow", url: "", label: "Widow", emoji: "🕷️",
    blurb: "The body barely moves. All eight legs do, in a wave that runs back to front, and that is the whole problem with it.",
    accent: "#ff2d4b",
  },
  {
    id: "harvest", url: "", label: "Harvest", emoji: "🕸️",
    blurb: "Pale, long, and far more polite than Widow. Steps over things rather than through them.",
    accent: "#ffb84d",
  },
  {
    id: "roo", url: "", label: "Roo", emoji: "🦘",
    blurb: "Does not walk. Hops — and the faster you go the further the arc, with the tail holding the whole thing level.",
    accent: "#ffdf87",
  },
  {
    id: "pogo", url: "", label: "Pogo", emoji: "🤸",
    blurb: "A crate that learned to jump. One scanning bar for a face and no plan for stairs.",
    accent: "#ffe14d",
  },
  {
    id: "cricket", url: "", label: "Cricket", emoji: "🦗",
    blurb: "Antennae, enormous lenses, and legs folded like a spring. Bounces the moment you ask it to move.",
    accent: "#d9ff5c",
  },
  {
    id: "tabby", url: "", label: "Tabby", emoji: "🐈",
    blurb: "Four legs at a trot, with stripes that were drawn rather than downloaded.",
    accent: "#8bf07a",
  },
  {
    id: "dapple", url: "", label: "Dapple", emoji: "🦌",
    blurb: "Long legs, small horns, and a spotted coat. Trots like it knows the way.",
    accent: "#ffb35c",
  },
  {
    id: "basilisk", url: "", label: "Basilisk", emoji: "🦎",
    blurb: "Scaled head to tail, with tusks and a heavy tail that arrives a beat after the turn.",
    accent: "#c9ff3d",
  },
  {
    id: "hexen", url: "", label: "Hexen", emoji: "⬡",
    blurb: "Mirror plate under a honeycomb weave, with a reactor in the chest and shoulders to match.",
    accent: "#59e0ff",
  },
  {
    id: "grit", url: "", label: "Grit", emoji: "🛠️",
    blurb: "Sandblasted, blunt, and built to carry things. The pack on the back is not for show.",
    accent: "#ff8a3d",
  },
  {
    id: "monarch", url: "", label: "Monarch", emoji: "🦋",
    blurb: "Black and orange, patterned wings folded on the ground and open the moment you leave it.",
    accent: "#ffcf5c",
  },
  { id: "vibey", url: vibeyUrl, label: "Vibey 2.0", emoji: "🤖", blurb: "Resident bot.", accent: "#73ffb8" },
  { id: "alien", url: alienUrl, label: "Alien", emoji: "👽", blurb: "Quaternius animated visitor.", accent: "#b392ff" },
  ...Object.entries(QUATERNIUS_URLS)
    .map(([path, url]) => {
      const filename = (path.split("/").pop() ?? "").replace(/\.glb$/, "");
      const o = CHAR_OVERRIDES[filename] ?? {};
      return {
        id: filename,
        url,
        label: prettyName(filename),
        emoji: o.emoji ?? "👤",
        blurb: o.blurb ?? "Quaternius character.",
        accent: o.accent ?? "#eaeaf0",
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label)),
];

/**
 * Who you are before you have chosen anybody.
 *
 * It lives here, next to the roster, because three other places have to agree
 * with it — `DEFAULT_LOADOUT`, the fallback in `use-active-character`, and
 * whatever the shop is selling — and a literal repeated in four files is a
 * literal that will disagree with itself.
 *
 * Two rules for whatever sits in this slot:
 *
 *   1. **It must be free.** The server refuses to equip a priced character you
 *      do not own, so a default with a price on it fails for every visitor who
 *      has not bought it — and fails at the moment they change a hat, which is
 *      nowhere near the mistake.
 *   2. **It should be funny rather than impressive.** This is the first thing
 *      anybody sees themselves as, and a heroic default reads as the app
 *      telling you who to be. A penguin-adjacent mushroom with legs too short
 *      to stride does not have that problem.
 */
export const DEFAULT_CHARACTER_ID = "toadstool";

export const findCharacter = (id: string | null | undefined): CharSpec =>
  CHARACTERS.find((c) => c.id === id) ??
  CHARACTERS.find((c) => c.id === DEFAULT_CHARACTER_ID) ??
  CHARACTERS[0];
