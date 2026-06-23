/**
 * character-naming — a single helper that turns a character label like
 * "BlueSoldier Female" into a friendly auto-generated display name like
 * "Cosmic BlueSoldier". Shared across the Lobby, the City entry screen,
 * and the first-run auto-roll in the Hub so the same naming feel
 * follows the visitor everywhere.
 *
 * The shape is intentionally "Adjective + CharacterCore" so the name
 * reads as an obvious nickname tied to the character they picked.
 */

const ADJECTIVES = [
  "Cosmic", "Neon", "Mellow", "Turbo", "Glitchy", "Lucid", "Vibey",
  "Plush", "Disco", "Solar", "Lunar", "Pixel", "Velvet", "Frosty",
  "Sparkly", "Drifty", "Cyber", "Holo", "Zesty", "Cozy", "Snappy",
  "Breezy", "Funky", "Radiant", "Sneaky", "Loud", "Quiet", "Wild",
  "Brave", "Chrome", "Hyper", "Misty", "Aurora", "Static", "Magnetic",
];

/**
 * Pull the most distinctive single word from a character label.
 * "BlueSoldier Female" → "BlueSoldier"
 * "Pirate Anne"       → "Anne"
 * "Vibey 2.0"         → "Vibey"
 * "Casual2 Male"      → "Casual"
 */
export function coreFromLabel(label: string): string {
  const clean = label
    .replace(/\b(Male|Female|Old|Young|Bald)\b/gi, "")
    .replace(/[^A-Za-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "Drifter";
  const parts = clean.split(" ").filter(Boolean);
  // Prefer the last word — usually the distinctive bit ("Pirate Anne"
  // → "Anne"). When there's only one word, just return it.
  return parts[parts.length - 1] || "Drifter";
}

export function randomAdjective(): string {
  return ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
}

/**
 * "Cosmic Vibey", "Sneaky Ninja", "Loud Pirate".
 * Pass the character's display label so the noun ties back to who they
 * actually picked. Falls back to a neutral noun if no label is given.
 */
export function generateCharacterName(label?: string): string {
  const core = label ? coreFromLabel(label) : "Drifter";
  return `${randomAdjective()} ${core}`;
}
