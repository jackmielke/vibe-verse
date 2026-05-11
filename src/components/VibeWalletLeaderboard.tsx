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
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronUp, Send, ExternalLink, Trophy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  getVibeBalances,
  formatVibe,
  shortAddress,
  sendVibe,
  loadSession,
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
  const [sendTo, setSendTo] = useState<Member | null>(null);
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
              onSend={() => setSendTo(m)}
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

      <AnimatePresence>
        {sendTo && (
          <SendVibeModal
            to={sendTo}
            onClose={() => setSendTo(null)}
          />
        )}
      </AnimatePresence>
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
  onSend,
  accent,
}: {
  rank: number;
  member: Member;
  balanceWei: bigint | null;
  onSend: () => void;
  accent: "default" | "gold";
}) {
  const display = member.name ?? member.username ?? shortAddress(member.wallet_address);
  const isSelf =
    loadSession()?.address.toLowerCase() === member.wallet_address.toLowerCase();
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
        <p className="text-xs font-heading font-semibold text-foreground truncate flex items-center gap-1.5">
          {display}
          {isSelf && (
            <span className="text-[8px] uppercase tracking-widest text-primary bg-primary/15 px-1 py-0.5 rounded">
              you
            </span>
          )}
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
      <button
        onClick={onSend}
        className="p-1.5 rounded-md hover:bg-primary/15 transition-colors"
        title={`Send VIBE to ${display}`}
      >
        <Send className="w-3.5 h-3.5 text-primary" />
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------
// Send modal
// ----------------------------------------------------------------------

function SendVibeModal({ to, onClose }: { to: Member; onClose: () => void }) {
  const session = loadSession();
  const [amount, setAmount] = useState("10");
  const [status, setStatus] = useState<"idle" | "signing" | "sent" | "error">("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const display = to.name ?? to.username ?? shortAddress(to.wallet_address);

  const send = async () => {
    if (!session) {
      setError("Connect your wallet first.");
      setStatus("error");
      return;
    }
    const num = parseFloat(amount);
    if (!Number.isFinite(num) || num <= 0) {
      setError("Enter a positive amount.");
      setStatus("error");
      return;
    }
    setError(null);
    setStatus("signing");
    try {
      // Convert decimal amount to wei (18 decimals).
      const wei = BigInt(Math.floor(num * 1e6)) * BigInt(1e12);
      const hash = await sendVibe({
        from: session.address,
        to: to.wallet_address as Address,
        amount: wei,
      });
      setTxHash(hash);
      setStatus("sent");
    } catch (e) {
      setError((e as Error).message ?? "Transaction failed");
      setStatus("error");
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[3px] p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 12 }}
        transition={{ type: "spring", damping: 22, stiffness: 240 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm rounded-2xl glass-panel p-5 border border-primary/30"
      >
        <p className="text-[10px] uppercase tracking-widest text-primary font-heading font-semibold mb-1">
          Send $VIBE
        </p>
        <h2 className="font-heading text-lg font-bold mb-1">to {display}</h2>
        <p className="text-[10px] font-mono text-muted-foreground mb-4">
          {shortAddress(to.wallet_address)}
        </p>

        {!session && (
          <p className="text-xs text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5 mb-3">
            Connect a wallet first.
          </p>
        )}

        <label className="block mb-3">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Amount (VIBE)
          </span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={!session || status === "signing"}
            className="mt-1 w-full rounded-lg bg-background/60 border border-border/60 focus:border-primary/60 outline-none px-3 py-2 text-base font-mono disabled:opacity-60"
            placeholder="0"
          />
        </label>

        <div className="flex flex-wrap gap-1 mb-4">
          {[10, 100, 1000, 10000].map((amt) => (
            <button
              key={amt}
              onClick={() => setAmount(String(amt))}
              disabled={!session || status === "signing"}
              className="rounded-md border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-50"
            >
              {amt.toLocaleString()}
            </button>
          ))}
        </div>

        {status === "sent" && txHash && (
          <div className="rounded-lg bg-emerald-400/10 border border-emerald-400/40 px-3 py-2 mb-3 text-xs text-emerald-200">
            Sent.{" "}
            <a
              href={`https://basescan.org/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-emerald-100"
            >
              View tx
            </a>
          </div>
        )}

        {error && (
          <p className="text-[11px] text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5 mb-3">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            onClick={send}
            disabled={!session || status === "signing"}
            className="flex-1 bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm font-heading font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {status === "signing" ? "Confirming in wallet…" : "Send"}
          </button>
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-lg text-sm font-heading font-semibold bg-muted/40 hover:bg-muted/60 transition-colors text-foreground/80"
          >
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
