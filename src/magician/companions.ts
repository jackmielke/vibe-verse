/**
 * Who floats beside you.
 *
 * The companion is Vibey by default, but it can be anybody in the roster:
 * the same `CHARACTERS` list the lobby and the shop use, plus the two
 * Vibeys — the expressive robot (`vibey`, "Vibey 2.0", the roster's own
 * entry) and the round goggled one from the reference photo
 * (`vibey-classic`, built in code in `src/fnaf/vibey.ts`).
 *
 * `resolveCompanion("the wizard")` is what the `become` tool calls, so a
 * visitor can say "turn into a pug" and get the pug. Pure, so it is tested.
 */
import { CHARACTERS, type CharSpec } from "@/lib/characters";

export interface CompanionSpec {
  id: string;
  label: string;
  emoji: string;
  /** A roster character to load, or null for a body built in code. */
  spec: CharSpec | null;
  /** How the body is made. */
  kind: "robot" | "classic" | "rig";
}

export const DEFAULT_COMPANION = "vibey";
export const COMPANION_KEY = "magician.companion";

export const COMPANIONS: CompanionSpec[] = [
  { id: "vibey", label: "Vibey 2.0", emoji: "🤖", spec: null, kind: "robot" },
  { id: "vibey-classic", label: "Vibey", emoji: "🥽", spec: null, kind: "classic" },
  ...CHARACTERS.filter((c) => c.id !== "vibey").map<CompanionSpec>((c) => ({ id: c.id, label: c.label, emoji: c.emoji, spec: c, kind: "rig" })),
];

export function findCompanion(id: string | null | undefined): CompanionSpec {
  return COMPANIONS.find((c) => c.id === id) ?? COMPANIONS[0];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Find a companion from plain words. Exact id or label first, then a label
 * that contains every word asked for, then any label sharing a word. Returns
 * null when nothing is close, with `suggest` giving a few names to offer.
 */
export function resolveCompanion(text: string): { match: CompanionSpec | null; suggest: string[] } {
  const q = norm(text).replace(/\b(the|a|an|into|to|be|become|turn|character|please|as)\b/g, " ").trim();
  if (!q) return { match: null, suggest: sample() };
  const words = q.split(/\s+/).filter(Boolean);
  const exact = COMPANIONS.find((c) => norm(c.id) === q || norm(c.label) === q);
  if (exact) return { match: exact, suggest: [] };
  // "vibey" alone means the default robot; "classic vibey" the round one.
  if (words.includes("vibey")) return { match: findCompanion(words.some((w) => /classic|round|goggle|original/.test(w)) ? "vibey-classic" : "vibey"), suggest: [] };
  const all = COMPANIONS.filter((c) => words.every((w) => norm(c.label).includes(w) || norm(c.id).includes(w)));
  if (all.length) return { match: all[0], suggest: all.slice(1, 4).map((c) => c.label) };
  const any = COMPANIONS.filter((c) => words.some((w) => w.length > 2 && (norm(c.label).includes(w) || norm(c.id).includes(w))));
  if (any.length) return { match: any[0], suggest: any.slice(1, 4).map((c) => c.label) };
  return { match: null, suggest: sample() };
}

function sample(): string[] {
  const picks = ["Wizard", "Witch", "Pug", "Cow", "Knight Male", "Ninja Female", "Pirate Mako", "Elf"];
  return picks.filter((p) => COMPANIONS.some((c) => c.label === p)).slice(0, 5);
}

export function readCompanion(): string {
  try {
    const q = new URLSearchParams(window.location.search).get("companion");
    if (q && COMPANIONS.some((c) => c.id === q)) return q;
    return localStorage.getItem(COMPANION_KEY) ?? DEFAULT_COMPANION;
  } catch {
    return DEFAULT_COMPANION;
  }
}

export function writeCompanion(id: string): void {
  try { localStorage.setItem(COMPANION_KEY, id); } catch { /* private mode */ }
}
