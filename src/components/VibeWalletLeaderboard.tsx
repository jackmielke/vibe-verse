/**
 * VibeWalletLeaderboard — list of every community member who has
 * linked a wallet, sorted by their live on-chain $VIBE balance.
 *
 * Reads from the public `users` table where `wallet_address is not null`.
 * Then fans out on-chain `balanceOf` reads via viem so the displayed
 * numbers are real-time, not the cached `vibecoin_balance` column.
 *
 * Renders compactly by default (the first 5 holders). Clicking the
 * "Show all" pill expands. Each row has an optional "Send VIBE" action
 * that opens the user's wallet for a transfer.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Trophy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  getVibeBalances,
  formatVibe,
  shortAddress,
  type Address,
} from "@/lib/vibe-wallet";

interface Member {
  id: string;
  name: string | null;
  username: string | null;
  avatar_url: string | null;
  wallet_address: string;
  wallet_connected_at: string | null;
}

const EDGE_COMMUNITY_ID = "4202857f-13fd-4407-8906-3f8ffe63e510";

interface Props {
  /** Show this many rows by default before "Show all" is clicked. */
  defaultVisible?: number;
  /** Max rows to fetch + show after expansion. Hard cap so a huge
      community doesn't blow up the on-chain fan-out. */
  maxRows?: number;
  /** Hide the heading + chrome when this component is dropped into a
      composed panel that already has its own header. */
  bare?: boolean;
}

export default function VibeWalletLeaderboard({
  defaultVisible = 5,
  maxRows = 40,
  bare = false,
}: Props) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 1. Load members with wallets.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The Edge Esmeralda users live in the `users` table; there's no
      // direct FK to a specific community in that schema, but the
      // table itself is community-scoped at this scale. If you reuse
      // this in a multi-community project, filter further.
      const { data, error: err } = await supabase
        .from("users")
        .select("id, name, username, avatar_url, wallet_address, wallet_connected_at")
        .not("wallet_address", "is", null)
        .order("wallet_connected_at", { ascending: false })
        .limit(maxRows);
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setMembers([]);
        return;
      }
      const rows = (data ?? []).filter((m) => m.wallet_address) as Member[];
      setMembers(rows);
    })();
    return () => { cancelled = true; };
  }, [maxRows]);

  // 2. Fetch on-chain balances for everyone in the list.
  useEffect(() => {
    if (!members?.length) return;
    let cancelled = false;
    (async () => {
      const addrs = members.map((m) => m.wallet_address as Address);
      try {
        const result = await getVibeBalances(addrs);
        if (!cancelled) setBalances(result);
      } catch {
        // Soft-fail; rows render as "—" instead of breaking.
      }
    })();
    return () => { cancelled = true; };
  }, [members]);

  const sorted = useMemo(() => {
    if (!members) return [];
    return [...members].sort((a, b) => {
      const ba = balances[a.wallet_address.toLowerCase()] ?? 0n;
      const bb = balances[b.wallet_address.toLowerCase()] ?? 0n;
      if (ba > bb) return -1;
      if (ba < bb) return 1;
      return 0;
    });
  }, [members, balances]);

  const visible = expanded ? sorted : sorted.slice(0, defaultVisible);

  return (
    <div className={bare ? "" : "glass-panel rounded-2xl border border-primary/30 p-4 flex flex-col gap-3"}>
      {!bare && (
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-primary" />
          <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary flex-1">
            $VIBE Holders
          </p>
          <span className="text-[10px] text-muted-foreground">
            {members ? `${members.length} linked` : "loading…"}
          </span>
        </div>
      )}

      {error && (
        <p className="text-xs text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5">
          {error}
        </p>
      )}

      {members && members.length === 0 && !error && (
        <p className="text-xs text-muted-foreground italic">
          No wallets linked yet. Be the first — connect above.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {visible.map((m, i) => {
          const bal = balances[m.wallet_address.toLowerCase()];
          return (
            <MemberRow
              key={m.id}
              rank={sorted.indexOf(m) + 1}
              member={m}
              balanceWei={bal ?? null}
              accent={i === 0 && expanded === false ? "gold" : "default"}
            />
          );
        })}
      </div>

      {members && members.length > defaultVisible && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded-md border border-border/60 bg-background/30 hover:bg-primary/10 hover:border-primary/40 transition-colors px-2 py-1.5 text-[11px] font-heading font-semibold flex items-center justify-center gap-1.5"
        >
          {expanded ? (
            <><ChevronUp className="w-3 h-3" /> Show less</>
          ) : (
            <><ChevronDown className="w-3 h-3" /> Show all {members.length} holders</>
          )}
        </button>
      )}

    </div>
  );
}

// ----------------------------------------------------------------------
// Row
// ----------------------------------------------------------------------

function MemberRow({
  rank,
  member,
  balanceWei,
  accent,
}: {
  rank: number;
  member: Member;
  balanceWei: bigint | null;
  accent: "default" | "gold";
}) {
  const display = member.name ?? member.username ?? shortAddress(member.wallet_address);
  const accentClass =
    accent === "gold"
      ? "border-amber-400/40 bg-amber-400/8"
      : "border-border/40 bg-background/30";
  return (
    <div className={`flex items-center gap-2 rounded-lg border ${accentClass} px-2 py-1.5`}>
      <div className="w-5 text-center font-mono text-[10px] text-muted-foreground tabular-nums">
        {rank}
      </div>
      {member.avatar_url ? (
        // Using a plain <img>; community avatars often live on
        // Supabase storage so we don't bother with optimized loaders.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={member.avatar_url}
          alt=""
          className="w-7 h-7 rounded-full object-cover border border-border/60"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ) : (
        <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-mono text-primary">
          {member.wallet_address.slice(2, 4).toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-heading font-semibold text-foreground truncate">
          {display}
        </p>
        <a
          href={`https://basescan.org/address/${member.wallet_address}`}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] font-mono text-muted-foreground hover:text-primary truncate flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          {shortAddress(member.wallet_address)}
          <ExternalLink className="w-2.5 h-2.5 opacity-60" />
        </a>
      </div>
      <div className="text-right">
        <p className="font-heading text-xs font-semibold text-primary tabular-nums">
          {balanceWei != null ? formatVibe(balanceWei, { compact: true }) : "—"}
        </p>
        <p className="text-[9px] uppercase tracking-widest text-muted-foreground">VIBE</p>
      </div>
    </div>
  );
}

// Wallet-popup "Send VIBE" intentionally removed from this v1.
// The leaderboard is now strictly read-only: see who holds what,
// click through to BaseScan to verify, and let the user initiate
// any transfer in their own wallet on their own terms.

