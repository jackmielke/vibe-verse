/**
 * The browser side of the rock-paper-scissors table on Vibe Island.
 *
 * Three calls, and the ordering between them is the whole design:
 * `openHand` takes your stake and hands back a commitment, `throwHand` sends
 * your move and gets the reveal. Nothing here decides an outcome — the server
 * does, and `src/rps/rps.ts` checks its work.
 */
import { supabase } from "@/integrations/supabase/client";
import { currentOwner, refreshVibecoin } from "@/lib/vibecoin";
import type { Outcome, Throw } from "@/rps/rps";

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vibe-rounds", {
    body: { action, ...payload },
  });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? "the table is not answering");
  return data.data as T;
}

export interface TableState {
  /** What the picker opens on. */
  stake: number;
  /** The bounds the server will accept. Mirrored from `vibe-rounds`. */
  minStake: number;
  maxStake: number;
  /** Live $VIBE, for the audit line. Null when the price feed is down. */
  vibePriceUsd: number | null;
  /** A hand already paid for and not yet thrown — you get it back, not a new one. */
  open: { id: string; commit_hash: string; stake: number; opened_at: string } | null;
  history: Array<{
    outcome: Outcome;
    player_throw: Throw;
    house_throw: Throw;
    stake: number;
    payout: number;
    settled_at: string;
  }>;
  record: { win: number; lose: number; push: number };
}

export async function fetchTable(): Promise<TableState> {
  const owner = await currentOwner();
  return call<TableState>("rps_table", { ownerRef: owner.ref });
}

export interface OpenHand {
  handId: string;
  commit: string;
  stake: number;
  balance?: number;
  vibePriceUsd?: number | null;
  /** True when you walked away mid-hand and came back to the same one. */
  resumed: boolean;
}

/**
 * Pay the ante and get the house's commitment.
 *
 * Throws — "you could not cover the ante" and "the table is out of chips" are
 * both things the player has to be told in words rather than left guessing at.
 */
export async function openHand(
  opts: { stake?: number; payoutAddress?: string | null } = {},
): Promise<OpenHand> {
  const owner = await currentOwner();
  const r = await call<OpenHand>("rps_open", {
    ownerKind: owner.kind,
    ownerRef: owner.ref,
    /* Omitted rather than defaulted here: the server owns both the default and
       the bounds, and a second copy of "25" in the browser is a second thing
       to forget when it changes. */
    stake: opts.stake,
    payoutAddress: opts.payoutAddress ?? null,
  });
  void refreshVibecoin();
  return r;
}

export interface HandResult {
  outcome: Outcome;
  playerThrow: Throw;
  houseThrow: Throw;
  payout: number;
  stake: number;
  balance: number | null;
  reveal: { throw: string; nonce: string; commit: string };
}

export async function throwHand(handId: string, playerThrow: Throw): Promise<HandResult> {
  const owner = await currentOwner();
  const r = await call<HandResult>("rps_throw", {
    ownerKind: owner.kind,
    ownerRef: owner.ref,
    handId,
    playerThrow,
  });
  void refreshVibecoin();
  return r;
}
