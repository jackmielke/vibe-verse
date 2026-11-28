/**
 * Floating coins are Vibey Coins.
 *
 *     pickUpVibeyCoin("frisco");        // one coin off a rooftop
 *     pickUpVibeyCoin("city", 15);      // the zeppelin heist coin
 *
 * Every world that scatters coins to grab calls this, and the grab lands in
 * the one balance the chip in the corner shows. Two halves:
 *
 * - **The chip moves on the same frame as the chime.** `applyLocalDelta`
 *   nudges the shared store straight away, as long as this device has not
 *   already hit the day's ceiling for that world (so the number does not climb
 *   past what the server will honour and then snap back).
 * - **The server is told in batches.** Flying through a line of twelve coins
 *   is one request, not twelve: pickups pool for a moment, then go to
 *   `coin_pickup` in vibe-economy, which owns the real ceilings and answers
 *   with the true balance.
 *
 * The ceilings below mirror `PICKUP_WORLDS` in the function. The function's
 * copy is the authority; this one only stops the optimistic number lying.
 */
import { applyLocalDelta, coinPickup } from "@/lib/vibecoin";

export type PickupWorld = "city" | "frisco" | "kart" | "vibequest";

export const PICKUP_DAILY: Record<PickupWorld, number> = {
  city: 80,
  frisco: 60,
  kart: 40,
  vibequest: 40,
};
export const PICKUP_DAILY_TOTAL = 180;

const FLUSH_MS = 1500;
const MAX_PER_CALL = 30;
const TALLY_KEY = "vibe.pickups.v1";

interface Tally {
  day: string;
  worlds: Partial<Record<PickupWorld, number>>;
}

const today = () => new Date().toISOString().slice(0, 10);

function readTally(): Tally {
  try {
    const t = JSON.parse(localStorage.getItem(TALLY_KEY) ?? "null") as Tally | null;
    if (t && t.day === today() && t.worlds) return t;
  } catch {
    /* private mode, or junk: start the day over */
  }
  return { day: today(), worlds: {} };
}

function writeTally(t: Tally): void {
  try {
    localStorage.setItem(TALLY_KEY, JSON.stringify(t));
  } catch {
    /* the server keeps the real count; this is only the optimistic one */
  }
}

/** How many more coins this device expects to be paid for in `world` today. */
export function pickupsLeftToday(world: PickupWorld): number {
  const t = readTally();
  const total = Object.values(t.worlds).reduce((a, b) => a + (b ?? 0), 0);
  return Math.max(0, Math.min(PICKUP_DAILY[world] - (t.worlds[world] ?? 0), PICKUP_DAILY_TOTAL - total));
}

const pending: Partial<Record<PickupWorld, number>> = {};
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  for (const w of Object.keys(pending) as PickupWorld[]) {
    let n = pending[w] ?? 0;
    delete pending[w];
    while (n > 0) {
      const take = Math.min(MAX_PER_CALL, n);
      n -= take;
      void coinPickup(w, take);
    }
  }
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_MS);
}

if (typeof document !== "undefined") {
  /* Closing the tab inside the batching window should not cost the coins. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && timer) {
      clearTimeout(timer);
      flush();
    }
  });
}

/**
 * Pick up `n` Vibey Coins in `world`. Returns how many will count toward the
 * balance (0 once today's ceiling for that world is reached), so a world can
 * say "+1 ✦" or stay quiet.
 */
export function pickUpVibeyCoin(world: PickupWorld, n = 1): number {
  const want = Math.max(0, Math.floor(n));
  if (want === 0) return 0;
  // `?shot` is a world playing itself for a card capture: nobody's coins.
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("shot")) return 0;
  const paid = Math.min(want, pickupsLeftToday(world));
  if (paid <= 0) return 0;
  const t = readTally();
  t.worlds[world] = (t.worlds[world] ?? 0) + paid;
  writeTally(t);
  applyLocalDelta(paid);
  pending[world] = (pending[world] ?? 0) + paid;
  schedule();
  return paid;
}

/** Test hook: send whatever is pooled now. */
export function flushVibeyPickups(): void {
  if (timer) clearTimeout(timer);
  flush();
}
