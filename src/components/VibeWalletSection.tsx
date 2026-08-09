/**
 * The wallet half of `/coin` — every wallet you have, and what is in them.
 *
 * This was its own page at `/wallet` until the two pages about the currency
 * were merged into one. It stayed a single component rather than being
 * inlined because the page is now telling a three-step story — make an
 * account, earn Vibecoin, claim it for real — and this is step three whole.
 *
 * ## What it used to be before that, and why it changed
 *
 * It was a single card that said "payout address set" and then refused to say
 * anything else. One address, no balances, and no way to add a second — so a
 * person holding a MetaMask they have used for years *and* a Base Account they
 * made here last week could keep exactly one of them, and the app's only
 * vocabulary for the other was an invitation to make a third.
 *
 * So it is a dashboard now. The list is the page: every address you have
 * proved, what proved it, what is in it on Base, and which one a drop would go
 * to — switchable with one tap, because switching should not mean re-linking.
 *
 * ## The number nobody else shows you
 *
 * Each row prints its **ETH on Base**, not just its $VIBE. A new smart account
 * holds zero ETH: it can receive tokens forever, because the sender pays, and
 * the first time its owner tries to *send* anything it fails on gas they did
 * not know they needed. That is where first-time crypto users actually give
 * up, and it is invisible on every wallet screen that only shows token
 * balances. This one says "0 ETH — cannot send yet" out loud, and the panel at
 * the bottom says what to do about it.
 *
 * Still true, and still the most important sentence here: this app has never
 * sent a transaction. Linking is a signature over a sentence.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Fuel, RefreshCw, Star, Trash2, Wallet } from "lucide-react";
import VibeWink from "@/components/VibeWink";
import VibeWalletConnect from "@/components/VibeWalletConnect";
import VibeTestDrop from "@/components/VibeTestDrop";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWalletBook, type WalletRow } from "@/hooks/use-wallet-book";
import { VIBECOIN_GLYPH, formatVibecoin } from "@/lib/vibecoin";
import { shortAddress } from "@/lib/vibe-wallet";
import { isVibeWallet, removeWallet, setPayoutWallet } from "@/lib/walletBook";
import { isPaymasterConfigured } from "@/lib/baseAccount";

const BASESCAN = "https://basescan.org/address/";

/** Token amounts, at the precision the number deserves. */
function amount(n: number | null, unit: string): string {
  if (n == null) return "—";
  if (n === 0) return `0 ${unit}`;
  if (n < 0.0001) return `<0.0001 ${unit}`;
  if (n >= 1000) return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${unit}`;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${unit}`;
}

/**
 * Dollars, honestly.
 *
 * $VIBE trades around $0.00015, so a holding worth real money is a number with
 * a lot of zeros in front of it. Rounding to two decimals turns "$0.004" into
 * "$0.00" and tells somebody holding twenty-odd dollars of token that they
 * hold nothing — so small amounts keep going until they say something.
 */
function usd(n: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toPrecision(2)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function WalletCard({ row, onRefresh }: { row: WalletRow; onRefresh: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(row.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy", { description: row.address });
    }
  };

  return (
    <div
      className={`rounded-2xl border p-4 transition-colors ${
        row.isPayout
          ? "border-[#7dffd4]/40 bg-[#7dffd4]/[0.06]"
          : "border-border/50 bg-black/25"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <Wallet
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            row.isPayout ? "text-[#7dffd4]" : "text-muted-foreground"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-heading text-[11px] font-black uppercase tracking-wider text-foreground/90">
              {row.label}
            </span>
            {isVibeWallet(row) && (
              <span className="rounded-full border border-[#8fb4ff]/40 px-1.5 py-px font-heading text-[7.5px] font-black uppercase tracking-[0.16em] text-[#8fb4ff]">
                Made here
              </span>
            )}
            {row.isPayout && (
              <span className="rounded-full border border-[#7dffd4]/40 px-1.5 py-px font-heading text-[7.5px] font-black uppercase tracking-[0.16em] text-[#7dffd4]">
                Drops go here
              </span>
            )}
          </div>
          <button
            onClick={() => void copy()}
            title="Copy the full address"
            className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {shortAddress(row.address)}
            {copied ? (
              <Check className="h-3 w-3 text-[#7dffd4]" />
            ) : (
              <Copy className="h-3 w-3 opacity-60" />
            )}
          </button>
        </div>
        <a
          href={`${BASESCAN}${row.address}`}
          target="_blank"
          rel="noreferrer noopener"
          title="Open on Basescan"
          className="shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* What is actually in it, on Base. */}
      <dl className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-border/40 bg-black/30 px-3 py-2">
          <dt className="flex items-center gap-1 font-heading text-[7.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">
            {/* The wink marks the real token everywhere it is counted. */}
            <VibeWink size={11} className="shrink-0" />
            $VIBE
          </dt>
          <dd className="mt-0.5 font-heading text-sm font-black tabular-nums text-[#8fb4ff]">
            {amount(row.vibe, "")}
          </dd>
          <dd className="mt-0.5 font-heading text-[9.5px] font-bold tabular-nums text-muted-foreground">
            {usd(row.usd)}
          </dd>
        </div>
        <div className="rounded-xl border border-border/40 bg-black/30 px-3 py-2">
          <dt className="font-heading text-[7.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">
            Gas · ETH on Base
          </dt>
          <dd
            className={`mt-0.5 font-heading text-sm font-black tabular-nums ${
              row.eth == null
                ? "text-muted-foreground"
                : row.canPayGas
                  ? "text-[#7dffd4]"
                  : "text-amber-300"
            }`}
          >
            {amount(row.eth, "")}
          </dd>
        </div>
      </dl>

      {row.eth != null && !row.canPayGas && (
        <p className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-snug text-amber-300/85">
          <Fuel className="mt-0.5 h-3 w-3 shrink-0" />
          Can receive, cannot send. Every chain charges gas in its own coin, and
          this one has none — see below.
        </p>
      )}

      <div className="mt-2.5 flex gap-1.5">
        {!row.isPayout && (
          <button
            onClick={() => {
              setPayoutWallet(row.address);
              toast.success("Drops will go here", {
                description: shortAddress(row.address),
              });
            }}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border/60 px-2 py-1.5 font-heading text-[9px] font-bold uppercase tracking-wider text-foreground/80 transition-colors hover:text-foreground"
          >
            <Star className="h-3 w-3" /> Send drops here
          </button>
        )}
        <button
          onClick={() => {
            removeWallet(row.address);
            onRefresh();
            toast.info("Removed from this browser", {
              description:
                "Nothing on chain changed. Link it again any time — it takes one signature.",
            });
          }}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-border/50 px-2.5 py-1.5 font-heading text-[9px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-rose-300"
        >
          <Trash2 className="h-3 w-3" /> Forget
        </button>
      </div>
    </div>
  );
}

/**
 * Step three of the currency story: the wallets you have proved, what is in
 * them, and the one real transaction that proves the pipe works.
 *
 * A section rather than a page — no background, no hero, no min-height. The
 * page above owns all of that, and the "two kinds of coin" explainer that
 * used to sit at the top of this file now leads the page instead, because it
 * is the first thing anybody needs and not a wallet detail.
 */
export default function VibeWalletSection({
  displayName,
}: {
  displayName?: string;
}) {
  const { rows, payout, loading, refresh } = useWalletBook();

  const anyGas = rows.some((r) => r.canPayGas);

  return (
    <div>
          {/* ---- The list ---- */}
          {rows.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center justify-between gap-3">
                <p className="font-heading text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">
                  {rows.length === 1 ? "Your wallet" : `Your ${rows.length} wallets`}
                </p>
                {/* These are on-chain figures read once when the page opened,
                    so they go stale the moment anything moves — including a
                    transfer you made in another app thirty seconds ago. There
                    was no way to ask again short of reloading the page. */}
                <button
                  onClick={refresh}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 font-heading text-[9px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
                  {loading ? "Reading Base" : "Refresh"}
                </button>
              </div>
              <div className="mt-2.5 flex flex-col gap-2.5">
                {rows.map((r) => (
                  <WalletCard key={r.address} row={r} onRefresh={refresh} />
                ))}
              </div>
            </div>
          )}

          {/* Directly under the list, because it is about the wallet marked
              "drops go here" — the claim that panel makes, made testable. */}
          <VibeTestDrop address={payout?.address ?? null} onSent={refresh} />

          <div className="mt-4">
            <VibeWalletConnect
              displayName={displayName}
              onLinked={refresh}
              showLinkedState={false}
            />
          </div>

          {/* ---- Can I actually trade with this? ----
              The question every person asks the moment they have made one, and
              the one no wallet UI answers. It gets a straight answer. */}
          {rows.length > 0 && (
            <div className="mt-6 rounded-2xl border border-border/50 bg-black/25 p-4">
              <p className="font-heading text-[10px] font-black uppercase tracking-wider text-foreground/80">
                Can I trade with these yet?
              </p>
              <ul className="mt-2.5 space-y-2 text-[11.5px] leading-relaxed text-muted-foreground">
                <li>
                  <span className="text-foreground/85">Receiving: yes, right now.</span>{" "}
                  Any of these addresses can be sent $VIBE or ETH today. The
                  sender pays the gas, so nothing has to be set up first.
                </li>
                <li>
                  <span className="text-foreground/85">
                    Sending or swapping: only with gas.
                  </span>{" "}
                  {anyGas
                    ? "At least one wallet above has enough ETH on Base to transact."
                    : "None of these hold ETH on Base yet, so none of them can move anything."}{" "}
                  Base gas is fractions of a cent — a few dollars of ETH lasts a
                  very long time. The shortest route is a Coinbase account
                  withdrawing ETH straight to the Base network, which skips
                  bridging entirely.
                </li>
                <li>
                  <span className="text-foreground/85">Not from inside here.</span>{" "}
                  The vibeverse has never sent a transaction and there is no swap
                  screen in it. A Base Account is a real account though — sign in
                  with the same passkey at any Base app and trade there.
                </li>
                <li>
                  <span className="text-foreground/85">
                    Sponsored gas: {isPaymasterConfigured() ? "on" : "not switched on"}.
                  </span>{" "}
                  {isPaymasterConfigured()
                    ? "This app can pay gas for Base Accounts, so a wallet with no ETH still works."
                    : "With a Coinbase Developer Platform paymaster key set as VITE_BASE_PAYMASTER_URL, the app could pay gas for Base Accounts and an empty wallet would just work. The slot is wired; the key is not set."}
                </li>
              </ul>
            </div>
          )}

          <div className="mt-4 rounded-2xl border border-border/50 bg-black/25 p-4">
            <p className="font-heading text-[10px] font-black uppercase tracking-wider text-foreground/80">
              What linking does, and does not, do
            </p>
            <ul className="mt-2.5 space-y-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
              <li>
                <span className="text-foreground/85">It proves an address is yours.</span>{" "}
                You sign a sentence. That is the entire transaction.
              </li>
              <li>
                <span className="text-foreground/85">It does not move anything.</span>{" "}
                Not your Vibecoin, not your ETH, not your Vibey Coins.
              </li>
              <li>
                <span className="text-foreground/85">It is not needed to play.</span>{" "}
                Every game, every round, every character works without it.
              </li>
              <li>
                <span className="text-foreground/85">We never see a key.</span>{" "}
                A passkey stays with your device; an extension stays in your
                extension.
              </li>
            </ul>
          </div>
    </div>
  );
}
