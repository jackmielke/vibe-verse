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

export const findCharacter = (id: string | null | undefined): CharSpec =>
  CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
