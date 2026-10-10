/** Where the roster's models live, by id, for the statues and the townsfolk. */
import { CHARACTERS } from "@/lib/characters";

export function characterUrl(id: string): string | null {
  return CHARACTERS.find((c) => c.id === id)?.url || null;
}
