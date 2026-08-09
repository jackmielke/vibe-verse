/**
 * The Vibey Coin chip — the play currency, made visible.
 *
 * The vibeverse has had a working ledger for months and no visitor could tell.
 * You could earn ninety coins on a floating island and the only evidence was a
 * toast that faded in four seconds; there was nowhere in the app that said
 * "this place has money in it, and you have some". This is that place. It sits
 * in the same corner on every page that has chrome, next to the profile pill,
 * and it is the first thing that makes the economy feel like it exists.
 *
 * Three jobs, in order of importance:
 *
 * 1. **State the balance.** Always visible, never a spinner. A cached figure
 *    from the last visit beats a dash while a request is in flight.
 * 2. **React when it moves.** A run in the arcade or a mini-game payout floats
 *    a `+18` off the chip. Money that changes silently does not feel earned.
 * 3. **Say what it is for.** One tap opens the ledger and the two doors —
 *    where to spend it, and where the real token lives.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Wallet } from "lucide-react";
import VibeCoinMark from "@/components/VibeCoinMark";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { VIBECOIN_NAME, formatVibecoin } from "@/lib/vibecoin";
import { readPayoutAddress } from "@/components/VibeWalletConnect";
import { getWalletBook } from "@/lib/walletBook";
import { shortAddress } from "@/lib/vibe-wallet";

/** Human labels for the `reason` column, which is written for machines. */
const REASON_LABEL: Record<string, string> = {
  starter: "Welcome grant",
  game_reward: "Mini-game payout",
  arcade_play: "Arcade — coin in",
  arcade_win: "Arcade — payout",
  tip: "Tip",
  service: "Bought a service",
  item: "Bought an item",
  bounty: "Bounty paid",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function VibeCoinChip() {
  const { balance, display, ledger, stale, refresh } = useVibecoin();
  const [open, setOpen] = useState(false);
  /* Read when the panel opens rather than once at mount: somebody can link a
     wallet on `/wallet` and come straight back to this chip, and a value
     captured at mount would still say "Set up a wallet". */
  const [payout, setPayout] = useState<string | null>(null);
  const [walletCount, setWalletCount] = useState(0);
  const [pop, setPop] = useState<number | null>(null);
  const location = useLocation();

  /* Previous balance, so a change can be animated. Starts undefined rather
     than null so the *first* number to arrive does not fly a "+100" past
     someone who has simply loaded the page. */
  const prev = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (balance == null) return;
    if (prev.current != null && balance !== prev.current) {
      setPop(balance - prev.current);
      const id = window.setTimeout(() => setPop(null), 1500);
      prev.current = balance;
      return () => window.clearTimeout(id);
    }
    prev.current = balance;
  }, [balance]);

  // Any navigation closes the panel — it is anchored to a fixed pill, and a
  // popover that survives a route change ends up hovering over a new page.
  useEffect(() => setOpen(false), [location.pathname]);

  // Click-away and Escape. Both, because the panel is reachable by keyboard.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.("[data-vibecoin-pop]")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" data-vibecoin-pop>
      <button
        onClick={() => {
          setOpen((v) => !v);
          if (!open) {
            void refresh();
            setPayout(readPayoutAddress());
            setWalletCount(getWalletBook().wallets.length);
          }
        }}
        aria-expanded={open}
        aria-label={`${VIBECOIN_NAME} balance: ${display}`}
        title={`${display} ${VIBECOIN_NAME} — tap for your ledger`}
        className="group relative flex items-center gap-1.5 rounded-full px-2 py-1.5 transition-colors hover:bg-primary/15"
      >
        <VibeCoinMark size={17} />
        <span className="font-heading text-[11px] font-bold leading-none tracking-wider text-[#7dffd4] tabular-nums">
          {display}
        </span>
        {/* A quiet dot, not an error state. The number is still the best one we
            have; the player does not need to be told the network is flaky. */}
        {stale && (
          <span
            className="absolute -right-0 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400/80"
            title="Showing your last known balance — the ledger is unreachable"
          />
        )}

        <AnimatePresence>
          {pop != null && pop !== 0 && (
            <motion.span
              key={`${pop}-${balance}`}
              initial={{ opacity: 0, y: 2, scale: 0.8 }}
              animate={{ opacity: 1, y: -18, scale: 1 }}
              exit={{ opacity: 0, y: -26 }}
              transition={{ duration: 0.5 }}
              className={`pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap font-heading text-[11px] font-black tabular-nums ${
                pop > 0 ? "text-[#7dffd4]" : "text-rose-300"
              }`}
              style={{ textShadow: "0 2px 10px rgba(0,0,0,0.6)" }}
            >
              {pop > 0 ? "+" : ""}
              {formatVibecoin(pop)}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.16 }}
            /* Right-anchored: the chip lives at the right edge of the viewport
               and a left-anchored panel would hang off it on a phone. */
            className="absolute right-0 top-full z-50 mt-2 w-[17.5rem] overflow-hidden rounded-2xl border border-border/60 bg-[#070d16]/95 shadow-[0_18px_50px_rgba(0,0,0,0.6)] backdrop-blur-xl"
          >
            <div className="border-b border-border/40 bg-gradient-to-br from-[#0d2a26] to-transparent px-3.5 py-3">
              <div className="flex items-center gap-2.5">
                <VibeCoinMark size={34} />
                <div className="min-w-0">
                  <div className="font-heading text-xl font-black leading-none tabular-nums text-[#7dffd4]">
                    {balance == null ? "—" : formatVibecoin(balance, { compact: false })}
                  </div>
                  <div className="mt-1 font-heading text-[8.5px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
                    {VIBECOIN_NAME}
                  </div>
                </div>
              </div>
              <p className="mt-2.5 text-[10.5px] leading-snug text-muted-foreground">
                The currency of the vibeverse. Earn it in the worlds, spend it in
                the arcade. Everyone starts with 100 — no account needed.
              </p>
            </div>

            <div className="flex gap-1.5 px-3.5 py-2.5">
              {/* Spend before win: the shop is where the number acquires a
                  point, and the arcade is how you get more of it. A popover
                  that only offered "go gamble" made the balance feel like a
                  score again. */}
              <Link
                to="/shop"
                className="flex-1 rounded-xl bg-primary px-2 py-2 text-center font-heading text-[9.5px] font-bold uppercase tracking-wider text-primary-foreground transition-transform hover:scale-[1.02]"
              >
                🛍️ Spend it
              </Link>
              <Link
                to="/arcade"
                className="flex-1 rounded-xl border border-border/60 px-2 py-2 text-center font-heading text-[9.5px] font-bold uppercase tracking-wider text-foreground/80 transition-colors hover:text-foreground"
              >
                🕹️ Win more
              </Link>
            </div>

            {/* The wallet used to live only on `/join/:code`, which meant the
                one person most likely to want it — somebody already looking at
                their balance — had no way to find it.

                It says "wallets", plural, and counts them: the old copy read
                "Create a Vibe Wallet" to anybody who had not linked one, which
                is exactly the wrong thing to say to somebody who already owns
                two and would rather connect one of those. */}
            <Link
              to="/wallet"
              className="flex items-center gap-2 border-t border-border/40 px-3.5 py-2.5 transition-colors hover:bg-white/[0.04]"
            >
              <Wallet className="h-3.5 w-3.5 shrink-0 text-[#8fb4ff]" />
              <span className="font-heading text-[9.5px] font-bold uppercase tracking-wider text-[#8fb4ff]">
                {payout
                  ? walletCount > 1
                    ? `Your ${walletCount} wallets`
                    : "Your wallet"
                  : "Connect a wallet"}
              </span>
              <span className="ml-auto truncate font-mono text-[9.5px] text-muted-foreground/60">
                {payout ? shortAddress(payout as `0x${string}`) : "yours, or make one"}
              </span>
            </Link>

            <div className="max-h-56 overflow-y-auto border-t border-border/40">
              {ledger.length === 0 ? (
                <p className="px-3.5 py-4 text-center text-[10.5px] text-muted-foreground/70">
                  Nothing has moved yet. Play a cabinet in the{" "}
                  <Link to="/arcade" className="text-primary hover:underline">
                    arcade
                  </Link>
                  .
                </p>
              ) : (
                ledger.slice(0, 12).map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center gap-2 px-3.5 py-2 text-[10.5px] odd:bg-white/[0.02]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground/85">
                        {REASON_LABEL[row.reason] ?? row.reason}
                      </div>
                      {row.memo && (
                        <div className="truncate text-[9.5px] text-muted-foreground/70">
                          {row.memo}
                        </div>
                      )}
                    </div>
                    <div
                      className={`shrink-0 font-heading font-bold tabular-nums ${
                        row.delta >= 0 ? "text-[#7dffd4]" : "text-rose-300/80"
                      }`}
                    >
                      {row.delta >= 0 ? "+" : "−"}
                      {formatVibecoin(Math.abs(row.delta))}
                    </div>
                    <div className="w-12 shrink-0 text-right text-[9px] text-muted-foreground/50">
                      {timeAgo(row.created_at)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
