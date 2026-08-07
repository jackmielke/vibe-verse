/**
 * useWalletBook — your wallets, with what is actually in them and what it is
 * worth.
 *
 * The book itself (`lib/walletBook.ts`) is just addresses. This adds the three
 * numbers that make the page a dashboard rather than a list: the $VIBE
 * balance, what that is in dollars, and the ETH balance.
 *
 * ## Why the reads go through an edge function
 *
 * They used to be viem calls straight from the page against `mainnet.base.org`,
 * and every balance on `/wallet` rendered as a dash. That public endpoint is
 * rate-limited per IP and shared with every other tab on the machine, so from
 * a browser it fails often — and "your wallet is empty" is the single worst
 * thing a wallet screen can be wrong about. `vibe-holdings` does the same two
 * reads from one server with endpoint failover, batches them into a single
 * JSON-RPC round trip, and carries the price along so the dollar figure lands
 * on the same frame as the token count instead of flickering in after it.
 *
 * ## The ETH figure is the one that matters
 *
 * A brand-new Base Account holds zero ETH. It can receive tokens forever —
 * the sender pays — and the first time its owner tries to *send* anything it
 * fails on gas they did not know they needed. That is where first-time crypto
 * users actually give up, and it is invisible on every wallet screen that only
 * lists tokens. So this one carries `canPayGas` and the page says it out loud.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getWalletBook,
  subscribeWalletBook,
  type BookedWallet,
  type WalletBook,
} from "@/lib/walletBook";

export interface VibePrice {
  usd: number;
  change24h: number | null;
  fetchedAt: number;
}

export interface WalletBalances {
  /** $VIBE, human-readable. null while unknown. */
  vibe: number | null;
  /** ETH on Base, human-readable. null while unknown. */
  eth: number | null;
}

export interface WalletRow extends BookedWallet, WalletBalances {
  isPayout: boolean;
  /** Enough ETH that a transaction would actually go through. */
  canPayGas: boolean;
  /** What the $VIBE is worth, or null if either half is unknown. */
  usd: number | null;
}

/**
 * Base gas is fractions of a cent, so the bar for "you can transact" is very
 * low — but it is not zero, and rounding it to zero is how you tell somebody
 * with 0.000004 ETH that they are fine when they are not. A single ERC-20
 * transfer on Base lands around 0.000002 ETH; ten of them is the floor here.
 */
const GAS_FLOOR_ETH = 0.00002;

interface HoldingsReply {
  price: VibePrice | null;
  holdings: Record<string, WalletBalances>;
}

export interface UseWalletBook {
  rows: WalletRow[];
  payout: WalletRow | null;
  price: VibePrice | null;
  /** Every wallet's $VIBE added up, in dollars. null if nothing is known. */
  totalUsd: number | null;
  loading: boolean;
  /** The reads failed; whatever is shown is the last thing we knew. */
  stale: boolean;
  refresh: () => void;
}

export function useWalletBook(): UseWalletBook {
  const [book, setBook] = useState<WalletBook>(getWalletBook);
  const [balances, setBalances] = useState<Record<string, WalletBalances>>({});
  const [price, setPrice] = useState<VibePrice | null>(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => subscribeWalletBook(setBook), []);

  /* Keyed on the addresses rather than on `book.wallets`, which is a fresh
     array on every commit — otherwise switching which wallet gets the drop
     would re-hit the chain for all of them. */
  const key = book.wallets.map((w) => w.address).join(",");

  useEffect(() => {
    let live = true;
    setLoading(true);
    void supabase.functions
      .invoke("vibe-holdings", {
        body: { addresses: key ? key.split(",") : [] },
      })
      .then(({ data, error }) => {
        if (!live) return;
        setLoading(false);
        const payload = data?.ok ? (data.data as HoldingsReply) : null;
        if (error || !payload) {
          // Keep the last known figures on screen. A dash where a balance was
          // reads as "it went away", which is worse than reading as stale.
          setStale(true);
          return;
        }
        setStale(false);
        if (payload.price) setPrice(payload.price);
        if (payload.holdings) {
          setBalances((prev) => ({ ...prev, ...payload.holdings }));
        }
      });
    return () => {
      live = false;
    };
  }, [key, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const rows: WalletRow[] = book.wallets.map((w) => {
    const b = balances[w.address.toLowerCase()] ?? { vibe: null, eth: null };
    return {
      ...w,
      ...b,
      isPayout: w.address.toLowerCase() === book.payout,
      canPayGas: (b.eth ?? 0) >= GAS_FLOOR_ETH,
      usd: b.vibe != null && price ? b.vibe * price.usd : null,
    };
  });

  const known = rows.filter((r) => r.usd != null);

  return {
    rows,
    payout: rows.find((r) => r.isPayout) ?? null,
    price,
    totalUsd: known.length ? known.reduce((t, r) => t + (r.usd ?? 0), 0) : null,
    loading,
    stale,
    refresh,
  };
}
