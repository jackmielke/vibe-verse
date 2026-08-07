/**
 * Rock, paper, scissors — the rules, and the proof.
 *
 * This module is deliberately pure and has no network in it. It holds three
 * things: the throws, who beats whom, and the one function that makes betting
 * against a house reasonable — `verifyCommit`.
 *
 * ## Why a commitment
 *
 * A house that picks its throw *after* seeing yours never loses. There is no
 * way to tell that from the outside — the outcome looks like chance either way
 * — so the server publishes a commitment before you move:
 *
 *   1. `rps_open`  → the server picks a throw and a random nonce, keeps both,
 *                    and returns only `sha256("<throw>:<nonce>")`.
 *   2. you throw    → having seen the hash, and nothing else.
 *   3. `rps_throw` → the server reveals its throw and its nonce.
 *
 * Then this file re-hashes the reveal and compares. If the server had swapped
 * its throw after seeing yours, the hash would not match the one it published,
 * and the game says so on screen. That is a real check the player can run —
 * not a promise in a FAQ — and it is why the result panel shows the hash.
 *
 * It is not zero-knowledge and it is not a blockchain. It closes the one hole
 * that matters for a game of this shape, which is the right amount of rigour
 * for a table on an island.
 */

export const THROWS = ["rock", "paper", "scissors"] as const;
export type Throw = (typeof THROWS)[number];
export type Outcome = "win" | "lose" | "push";

/** Player's side. `beats[x]` is what x defeats. */
const BEATS: Record<Throw, Throw> = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
};

export function resolve(player: Throw, house: Throw): Outcome {
  if (player === house) return "push";
  return BEATS[player] === house ? "win" : "lose";
}

/**
 * The client's copy of the table's terms.
 *
 * Only ever used to draw a label before you commit — the edge function decides
 * what is actually charged and paid, and `rps.test.ts` asserts the two agree by
 * reading the function's own source.
 */
export const RPS_STAKE = 25;
export const RPS_PAYOUT: Record<Outcome, number> = { win: 2, push: 1, lose: 0 };

export const THROW_EMOJI: Record<Throw, string> = {
  rock: "✊",
  paper: "✋",
  scissors: "✌️",
};

export const THROW_LABEL: Record<Throw, string> = {
  rock: "Rock",
  paper: "Paper",
  scissors: "Scissors",
};

/**
 * Re-hash the reveal and check it against the commitment published before the
 * player threw.
 *
 * Returns `null` when the browser has no WebCrypto (insecure origin, ancient
 * device) — the caller shows "could not check" rather than "cheated", because
 * an unverifiable hand is not the same as a dishonest one and calling it one
 * would be its own kind of lie.
 */
export async function verifyCommit(
  houseThrow: string,
  nonce: string,
  commit: string,
): Promise<boolean | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const bytes = new TextEncoder().encode(`${houseThrow}:${nonce}`);
    const digest = await subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex === commit;
  } catch {
    return null;
  }
}

/** `0x8f3a…c210` — a hash is only readable at the ends. */
export function shortHash(h: string): string {
  return h.length <= 18 ? h : `${h.slice(0, 8)}…${h.slice(-6)}`;
}

/** What the result panel says. Short, and never sarcastic about a loss. */
export function outcomeLine(outcome: Outcome, player: Throw, house: Throw): string {
  if (outcome === "push") return `Both ${THROW_LABEL[house].toLowerCase()}. Nobody wins, nobody pays.`;
  if (outcome === "win") return `${THROW_LABEL[player]} takes ${THROW_LABEL[house].toLowerCase()}.`;
  return `${THROW_LABEL[house]} takes ${THROW_LABEL[player].toLowerCase()}.`;
}
