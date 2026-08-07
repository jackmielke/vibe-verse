/**
 * useWalletBook — your wallets, with what is actually in them.
 *
 * The book itself (`lib/walletBook.ts`) is just addresses. This adds the two
 * numbers that make the page a dashboard rather than a list: the $VIBE balance
 * and the ETH balance, both read straight off Base.
 *
 * **The ETH figure is the one that matters** and it is the reason it is here at
 * all. A brand-new Base Account holds zero ETH. It can receive tokens all day
 * — the sender pays — but the first time its owner tries to move anything they
 * need gas they do not have and have no idea how to get. That is the exact
 * point where a first-time crypto user gives up, and it is completely
 * invisible unless a screen says "0 ETH — you cannot send yet". So one does.
 *
 * Reads are best-effort and never throw: a rate-limited public RPC should
 * leave the addresses on screen with a dash beside them, not blank the page.
 */
import { useCallback, useEffect, useState } from "react";
import { formatEther, formatUnits, type Address } from "viem";
import {
  basePublicClient,
  VIBE_TOKEN_ADDRESS,
  VIBE_TOKEN_DECIMALS,
} from "@/lib/vibe-wallet";
import {
  getWalletBook,
  subscribeWalletBook,
  type BookedWallet,
  type WalletBook,
} from "@/lib/walletBook";

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
}

/**
 * Base gas is fractions of a cent, so the bar for "you can transact" is very
 * low — but it is not zero, and rounding it to zero is how you tell somebody
 * with 0.000004 ETH that they are fine when they are not. A single ERC-20
 * transfer on Base lands around 0.000002 ETH; ten of them is the floor here.
 */
const GAS_FLOOR_ETH = 0.00002;

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

async function readBalances(address: Address): Promise<WalletBalances> {
  const [vibe, eth] = await Promise.all([
    (basePublicClient.readContract as (a: unknown) => Promise<unknown>)({
      address: VIBE_TOKEN_ADDRESS,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [address],
    })
      .then((r) => Number(formatUnits(r as bigint, VIBE_TOKEN_DECIMALS)))
      .catch(() => null),
    basePublicClient
      .getBalance({ address })
      .then((r) => Number(formatEther(r)))
      .catch(() => null),
  ]);
  return { vibe, eth };
}

export interface UseWalletBook {
  rows: WalletRow[];
  payout: WalletRow | null;
  loading: boolean;
  refresh: () => void;
}

export function useWalletBook(): UseWalletBook {
  const [book, setBook] = useState<WalletBook>(getWalletBook);
  const [balances, setBalances] = useState<Record<string, WalletBalances>>({});
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => subscribeWalletBook(setBook), []);

  useEffect(() => {
    const addresses = book.wallets.map((w) => w.address);
    if (addresses.length === 0) return;
    let live = true;
    setLoading(true);
    void Promise.all(
      addresses.map(async (a) => [a.toLowerCase(), await readBalances(a)] as const),
    ).then((pairs) => {
      if (!live) return;
      setBalances((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
      setLoading(false);
    });
    return () => {
      live = false;
    };
    // `book.wallets` is a fresh array on every commit; key on the addresses so
    // an unrelated payout switch does not re-hit the RPC for every wallet.
  }, [book.wallets.map((w) => w.address).join(","), tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const rows: WalletRow[] = book.wallets.map((w) => {
    const b = balances[w.address.toLowerCase()] ?? { vibe: null, eth: null };
    return {
      ...w,
      ...b,
      isPayout: w.address.toLowerCase() === book.payout,
      canPayGas: (b.eth ?? 0) >= GAS_FLOOR_ETH,
    };
  });

  return {
    rows,
    payout: rows.find((r) => r.isPayout) ?? null,
    loading,
    refresh,
  };
}
