/**
 * Who you are in the square: a name and a character, remembered on this
 * device. Shared by the card on the front page and the page itself, so
 * whatever you pick on one is who you are on the other.
 */
import { CHARACTERS } from "@/lib/characters";

const NAME_KEY = "oni.name";
const CHAR_KEY = "oni.character";

export function readName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; }
}

export function writeName(n: string): void {
  try { localStorage.setItem(NAME_KEY, n.trim().slice(0, 16)); } catch { /* private mode */ }
}

export function randomCharacter(except?: string): string {
  const pool = CHARACTERS.filter((c) => c.id !== except);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/** Your character here; a random one the first time, which is half the fun. */
export function readCharacter(): string {
  try {
    const q = new URLSearchParams(window.location.search).get("char");
    if (q && CHARACTERS.some((c) => c.id === q)) return q;
    const s = localStorage.getItem(CHAR_KEY);
    if (s && CHARACTERS.some((c) => c.id === s)) return s;
  } catch { /* no storage */ }
  const id = randomCharacter();
  writeCharacter(id);
  return id;
}

export function writeCharacter(id: string): void {
  try { localStorage.setItem(CHAR_KEY, id); } catch { /* private mode */ }
}

/** Step through the roster from `id`. */
export function stepCharacter(id: string, dir: 1 | -1): string {
  const i = Math.max(0, CHARACTERS.findIndex((c) => c.id === id));
  return CHARACTERS[(i + dir + CHARACTERS.length) % CHARACTERS.length].id;
}
