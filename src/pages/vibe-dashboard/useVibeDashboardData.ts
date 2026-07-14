/**
 * useVibeDashboardData — every live read the $VIBE dashboard makes,
 * with a hard rule: nothing here ever throws into the UI. Each source
 * resolves to either live data or `null`, and the components render
 * the clearly-marked static snapshot from ./data.ts when it's null.
 *
 * Live sources:
 *   1. Supabase `vibe_balances` + `vibe_ledger` (public-read RLS) —
 *      the in-app simulated economy.
 *   2. Supabase `world_agents` (public-read) — display names for
 *      agent wallets. User names live in `users`, which anon can NOT
 *      read, so user wallets are anonymized to short refs on purpose.
 *   3. GeckoTerminal pool API — on-chain market cap (same endpoint
 *      VibeCoinPanel uses).
 *   4. viem `balanceOf` on Base — the treasury wallet's $VIBE.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getVibeBalance, formatVibe, type Address } from "@/lib/vibe-wallet";
import { TREASURY_ADDRESS, type HolderRow, type LedgerRow } from "./data";

const POOL_ENDPOINT =
  "https://api.geckoterminal.com/api/v2/networks/base/pools/0xc3ad498815597f1e6f71d3cb1166856e947efb46";

export interface EconomySnapshot {
  holders: HolderRow[];
  ledger: LedgerRow[];
  totalSupply: number;
  holdersCount: number;
}

const shortRef = (ref: string) => `${ref.slice(0, 4)}…${ref.slice(-3)}`;

function displayName(
  kind: string,
  ref: string,
  agentNames: Record<string, string>,
): string {
  if (kind === "agent") {
    const n = agentNames[ref];
    return n ? `${n} (agent)` : `agent ${shortRef(ref)}`;
  }
  if (kind === "system") return "treasury";
  return `user ${shortRef(ref)}`;
}

/** In-app economy from Supabase. Resolves null on any error. */
export function useEconomy(): { economy: EconomySnapshot | null; loading: boolean } {
  const [economy, setEconomy] = useState<EconomySnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [balRes, ledRes] = await Promise.all([
          supabase
            .from("vibe_balances")
            .select("owner_kind, owner_ref, balance")
            .order("balance", { ascending: false })
            .limit(50),
          supabase
            .from("vibe_ledger")
            .select("id, amount, reason, memo, from_kind, to_kind, to_ref, created_at")
            .order("created_at", { ascending: false })
            .limit(12),
        ]);
        if (balRes.error || ledRes.error || !balRes.data?.length) throw new Error("empty");

        // Resolve agent display names (public table). Best-effort only.
        const agentIds = [
          ...new Set(
            [...balRes.data, ...ledRes.data]
              .flatMap((r) =>
                "owner_kind" in r
                  ? r.owner_kind === "agent" ? [r.owner_ref] : []
                  : r.to_kind === "agent" && r.to_ref ? [r.to_ref] : [],
              ),
          ),
        ];
        let agentNames: Record<string, string> = {};
        if (agentIds.length) {
          const { data: agents } = await supabase
            .from("world_agents")
            .select("id, name")
            .in("id", agentIds);
          agentNames = Object.fromEntries((agents ?? []).map((a) => [a.id, a.name]));
        }

        const holders: HolderRow[] = balRes.data.map((b) => ({
          ownerKind: (b.owner_kind === "agent" ? "agent" : "user") as HolderRow["ownerKind"],
          ownerRef: b.owner_ref,
          balance: Number(b.balance),
          name: displayName(b.owner_kind, b.owner_ref, agentNames),
        }));
        const ledger: LedgerRow[] = ledRes.data.map((l) => ({
          id: l.id,
          amount: Number(l.amount),
          reason: l.reason,
          memo: l.memo,
          fromKind: l.from_kind,
          toKind: l.to_kind,
          toName: l.to_kind && l.to_ref ? displayName(l.to_kind, l.to_ref, agentNames) : "—",
          createdAt: l.created_at,
        }));

        if (!cancelled) {
          setEconomy({
            holders,
            ledger,
            totalSupply: holders.reduce((s, h) => s + h.balance, 0),
            holdersCount: holders.length,
          });
        }
      } catch {
        if (!cancelled) setEconomy(null); // components fall back to snapshot
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { economy, loading };
}

/** On-chain market cap (FDV) from GeckoTerminal. Null on failure. */
export function useMarketCap(): number | null {
  const [cap, setCap] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(POOL_ENDPOINT, { headers: { accept: "application/json" } });
        if (!res.ok) return;
        const json = await res.json();
        const fdv = parseFloat(json?.data?.attributes?.fdv_usd);
        if (!cancelled && Number.isFinite(fdv)) setCap(fdv);
      } catch {
        /* stay null → static fallback with marker */
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return cap;
}

/** Treasury wallet's on-chain $VIBE balance, formatted. Null on failure. */
export function useTreasuryBalance(): string | null {
  const [balance, setBalance] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // getVibeBalance throws on RPC failure (unlike the batched
        // helper, which coerces failures to 0n) — a throw here means
        // "show the marked static fallback", never a fake "0".
        const { raw } = await getVibeBalance(TREASURY_ADDRESS as Address);
        if (!cancelled) setBalance(formatVibe(raw, { compact: true }));
      } catch {
        /* stay null → static fallback with marker */
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return balance;
}
