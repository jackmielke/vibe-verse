/**
 * Tickets and the prize counter.
 *
 * Every game in the Vibe Arcade pays out tickets for a run (`games.ts` says how
 * many), and the counter by the door trades them for prizes. Tickets are a toy
 * currency kept on this device, deliberately apart from Vibey Coins: nothing
 * here can be turned back into money, so nothing here needs a server to stop
 * somebody minting it. Prizes are things to own and show: a shelf in the
 * arcade that fills up with what you won, and three hats you can wear.
 */
import { earnQuestHat } from "@/city/quests/hats";

export interface Prize {
  id: string;
  name: string;
  emoji: string;
  cost: number;
  /** "hat" prizes go on your head (via the quest hats); the rest go on your shelf. */
  kind: "shelf" | "hat";
  blurb: string;
}

export const PRIZES: Prize[] = [
  { id: "duck", name: "Rubber Duck", emoji: "🦆", cost: 20, kind: "shelf", blurb: "Squeaks. Floats. Judges you quietly." },
  { id: "mort-plush", name: "Mort Plush", emoji: "👻", cost: 35, kind: "shelf", blurb: "The maze ghost, soft and harmless at last." },
  { id: "lava-lamp", name: "Lava Lamp", emoji: "🫧", cost: 50, kind: "shelf", blurb: "Blobs rise and fall. That is the whole show." },
  { id: "visor", name: "Arcade Visor", emoji: "🕶️", cost: 60, kind: "hat", blurb: "A neon visor. Wear it anywhere in Vibe City." },
  { id: "vibey-plush", name: "Vibey Plush", emoji: "🤖", cost: 80, kind: "shelf", blurb: "Vibey, stuffed. Still somehow beeps." },
  { id: "propeller", name: "Propeller Beanie", emoji: "🧢", cost: 100, kind: "hat", blurb: "A little propeller on top. Does not help you fly." },
  { id: "flamingo", name: "Neon Flamingo", emoji: "🦩", cost: 140, kind: "shelf", blurb: "A real glowing tube sign for your shelf." },
  { id: "neon-crown", name: "Neon Crown", emoji: "👑", cost: 200, kind: "hat", blurb: "For the high score holder in all of us." },
  { id: "golden-joystick", name: "Golden Joystick", emoji: "🕹️", cost: 320, kind: "shelf", blurb: "The trophy. The legend. The joystick." },
];

const TICKETS = "arcade.tickets";
const OWNED = "arcade.prizes";
const EVENT = "arcade-tickets";

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: the run counted, it just is not remembered */
  }
};

export function tickets(): number {
  const n = Number(read(TICKETS) ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function ownedPrizes(): string[] {
  try {
    const v = JSON.parse(read(OWNED) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const changed = () => {
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* no window */
  }
};

export function addTickets(n: number): number {
  const next = tickets() + Math.max(0, Math.round(n));
  write(TICKETS, String(next));
  changed();
  return next;
}

/** Trade tickets for a prize. Returns false if it is already yours or you are short. */
export function redeem(id: string): boolean {
  const p = PRIZES.find((x) => x.id === id);
  if (!p) return false;
  const owned = ownedPrizes();
  if (owned.includes(id) || tickets() < p.cost) return false;
  write(TICKETS, String(tickets() - p.cost));
  write(OWNED, JSON.stringify([...owned, id]));
  if (p.kind === "hat") earnQuestHat(id);
  changed();
  return true;
}

export function onTicketsChanged(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  const storage = (e: StorageEvent) => {
    if (e.key === TICKETS || e.key === OWNED) fn();
  };
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", storage);
  };
}
