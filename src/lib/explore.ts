/**
 * The explorer's payout — the client half of `vibe-explore`.
 *
 * ## What this fixes
 *
 * The passport has been quietly recording where people go since June, in
 * `localStorage`, where nothing could ever act on it. Meanwhile the ledger said
 * something bleak: of 495 wallets, 491 sat at exactly the 100 coins they were
 * handed on arrival, one had ever gone past it, and the richest in the whole
 * vibeverse held 116. Every way to earn was buried inside a world almost nobody
 * reached, so the arcade and the character shop were furniture downstream of an
 * action that essentially never happened.
 *
 * Walking into a world is the action that DOES happen. This module is the wire
 * between that and the ledger.
 *
 * ## Two records, each authoritative about a different thing
 *
 * - `localStorage` (see `passport.ts`) knows *when* you arrived and *how many
 *   times*. It works offline, it works signed out, and it is instant — a world
 *   booting a canvas must never wait on a network call to draw its first frame.
 * - The server knows *whether you have been paid*, which is the only part that
 *   has to be tamper-resistant, and it is the part that survives a new device.
 *
 * `sync()` unions them. Anything local the server has not seen gets sent and
 * paid; anything the server has that the browser does not gets written back, so
 * signing in on a phone restores a passport filled in on a laptop.
 *
 * ## Never in the way
 *
 * Every function here resolves and none of them throw. A world is a canvas at
 * 60fps and a payout is a decoration on top of it: Supabase being unreachable
 * must not blank a passport, must not stall a route, and must not throw into a
 * render. A failed sync leaves the local passport exactly where it was and the
 * next arrival tries again.
 */
import { supabase } from "@/integrations/supabase/client";
import { celebrate } from "@/lib/celebrate";
import { currentOwner } from "@/lib/vibecoin";
import {
  markSettled,
  mergeServerVisits,
  readPassport,
  stampsForSync,
  unsettledStamps,
} from "@/lib/passport";

export interface Milestone {
  at: number;
  bonus: number;
  title: string;
}

export interface ExploreResult {
  /** World keys that were paid for by *this* call. Empty is the normal case. */
  newly: string[];
  /** Coins credited in total, worlds plus any milestone crossed. */
  amount: number;
  worldCoins: number;
  bonusCoins: number;
  balance: number;
  /** How many worlds this wallet has now been paid for, all time. */
  visited: number;
  milestones: Milestone[];
  perWorld: number;
}

/** What one world pays, until the server says otherwise. */
export const DEFAULT_PER_WORLD = 25;

/**
 * The thresholds, mirrored for display only.
 *
 * The server's copy is the one that pays; this exists so the passport can draw
 * a progress bar toward the next rank without a round trip. `src/test/
 * explore.test.ts` checks the two still agree, which is the same arrangement
 * the arcade paytable has with `ARCADE_SPECS`.
 */
export const MILESTONES: Milestone[] = [
  { at: 5, bonus: 100, title: "Wanderer" },
  { at: 10, bonus: 200, title: "Voyager" },
  { at: 20, bonus: 400, title: "Pathfinder" },
  { at: 30, bonus: 1000, title: "Cartographer" },
];

/** The rank a traveller has reached, and the one they are walking toward. */
export function rankFor(visited: number): {
  earned: Milestone | null;
  next: Milestone | null;
} {
  let earned: Milestone | null = null;
  for (const m of MILESTONES) if (visited >= m.at) earned = m;
  const next = MILESTONES.find((m) => visited < m.at) ?? null;
  return { earned, next };
}

/**
 * Payout announcements, for whatever wants to draw one.
 *
 * `celebrate()` is already fired for the balance going up, and the mark in the
 * corner does its lap off that. But a celebration carries a number and nothing
 * else, and the stamp moment needs to know *which* worlds and *which* rank —
 * so this is a second, narrower wire rather than a widening of a shared one.
 *
 * Same posture as the celebration bus: fire-and-forget, a listener that throws
 * cannot take the payout down with it, and nothing waits on a subscriber.
 */
type PayoutListener = (r: ExploreResult) => void;
const payoutListeners = new Set<PayoutListener>();

export function onExplorePayout(fn: PayoutListener): () => void {
  payoutListeners.add(fn);
  return () => {
    payoutListeners.delete(fn);
  };
}

function announce(r: ExploreResult): void {
  for (const l of payoutListeners) {
    try {
      l(r);
    } catch {
      /* An animation is never worth breaking the thing that paid out. */
    }
  }
}

async function call<T>(action: string, payload: Record<string, unknown>): Promise<T | null> {
  try {
    const { data, error } = await supabase.functions.invoke("vibe-explore", {
      body: { action, ...payload },
    });
    if (error) throw new Error(error.message);
    if (!data?.ok) throw new Error(data?.error ?? "vibe-explore error");
    return data.data as T;
  } catch {
    /* Offline, signed out mid-flight, a function cold-starting slowly. The
       passport is unharmed and the next arrival will try again. */
    return null;
  }
}

/**
 * One in-flight sync at a time, ever.
 *
 * Worlds mount fast and some of them remount — a resize, a strict-mode double
 * mount, a route that swaps engines. Without this, arriving somewhere could
 * fire three identical syncs, and while the server would correctly pay only
 * once, the other two would each come back reporting "you earned nothing" and
 * race the celebration.
 */
let inFlight: Promise<ExploreResult | null> | null = null;

/**
 * Push every local stamp at the server and take whatever it owes.
 *
 * Sends the WHOLE passport rather than just the new arrival. It is one request
 * either way, the server pays only for what it has never seen, and it means a
 * passport that filled up before any of this existed settles in a single call
 * the first time somebody opens a world — which is the nicest possible version
 * of shipping this: people who have been exploring for weeks get paid for it.
 */
export async function syncExplore(): Promise<ExploreResult | null> {
  if (inFlight) return inFlight;

  // The common case by far: somebody re-entering a world they have already
  // collected. There is nothing to tell the server, so nothing is sent — a
  // request per world entry forever, to be told "you earned nothing", is not a
  // price a canvas booting at 60fps should pay.
  if (unsettledStamps().length === 0) return null;

  inFlight = (async () => {
    try {
      // Send the WHOLE book, not just the unsettled part. It is one request
      // either way, the server pays only for what it has never seen, and it
      // means a browser whose settled-list was cleared re-converges instead of
      // drifting. `sent` is what gets marked, so a world the server already had
      // stops being asked about too.
      const worlds = stampsForSync();
      if (worlds.length === 0) return null;
      const owner = await currentOwner();
      const r = await call<ExploreResult>("explore", {
        ownerKind: owner.kind,
        ownerRef: owner.ref,
        worlds,
      });
      if (!r) return null;
      markSettled(worlds.map((w) => w.key));
      if (r.amount > 0) {
        celebrate("explore", r.amount);
        announce(r);
      }
      return r;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Pull the server's record into the browser.
 *
 * This is what makes a passport portable: sign in on a new device and the
 * worlds you have been paid for come back as stamps, so the book is not blank
 * and — more to the point — a world you already collected does not look
 * unvisited and tempt you into thinking there are coins there.
 */
export async function pullVisits(): Promise<{
  keys: string[];
  visited: number;
  earned: number;
} | null> {
  const owner = await currentOwner();
  const r = await call<{
    keys: string[];
    first: Record<string, number>;
    visited: number;
    earned: number;
  }>("visits", { ownerKind: owner.kind, ownerRef: owner.ref });
  if (!r) return null;
  // Anything the server has been paid for is, by definition, settled — and
  // writing it into the book here is what makes the passport portable.
  mergeServerVisits(r.keys ?? [], r.first ?? {});
  markSettled(r.keys ?? []);
  return { keys: r.keys ?? [], visited: r.visited ?? 0, earned: r.earned ?? 0 };
}

/**
 * Carry travel onto an account after signing in.
 *
 * Called alongside `vibe-economy`'s own guest claim. Without it the account has
 * no visit rows and the next sync would pay it a second time for worlds the
 * guest wallet was already paid for — while `claim_guest` has by then handed
 * the account the guest's coins as well.
 *
 * Returns `null` — deliberately distinct from `0` — when the call did not get
 * through, so the caller can decline to mark the claim as done and let the next
 * sign-in try again. Moving zero worlds is a perfectly good outcome; never
 * having asked is not, and the two must not look the same to a caller whose
 * job is deciding whether to stop asking.
 */
export async function claimGuestTravel(guestRef: string): Promise<number | null> {
  const r = await call<{ worldsMoved: number }>("claim_guest", { guestRef });
  return r ? r.worldsMoved ?? 0 : null;
}

/** How many worlds this browser has a stamp for, without any network call. */
export function localVisitedCount(): number {
  return Object.keys(readPassport().stamps).length;
}
