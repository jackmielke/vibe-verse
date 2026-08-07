/**
 * /wallet — every wallet you have, and what is actually in them.
 *
 * ## What this used to be, and why it changed
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
import { Check, Copy, ExternalLink, Fuel, Star, Trash2, Wallet } from "lucide-react";
import VibeCoinMark from "@/components/VibeCoinMark";
import VibeWalletConnect from "@/components/VibeWalletConnect";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { useWalletBook, type WalletRow } from "@/hooks/use-wallet-book";
import { useWorldStamp } from "@/hooks/use-world-stamp";
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
          <dt className="font-heading text-[7.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">
            $VIBE
          </dt>
          <dd className="mt-0.5 font-heading text-sm font-black tabular-nums text-[#8fb4ff]">
            {amount(row.vibe, "")}
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

export default function VibeWallet() {
  useWorldStamp("/wallet", "The Vibe Wallet");
  const { balance } = useVibecoin();
  const { isGuest, displayName } = useVibeIdentity();
  const { rows, refresh } = useWalletBook();

  const totalVibe = rows.reduce((t, r) => t + (r.vibe ?? 0), 0);
  const anyGas = rows.some((r) => r.canPayGas);

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#03050c] text-foreground">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 50% at 50% -10%, hsl(220 92% 58% / 0.18), transparent 62%)," +
            "radial-gradient(55% 45% at 88% 14%, hsl(268 88% 62% / 0.14), transparent 68%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-lg px-5 pb-24 pt-20">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <p className="text-center font-heading text-[9px] font-bold uppercase tracking-[0.42em] text-[#8fb4ff]">
            Your wallet
          </p>
          <h1
            className="mt-2.5 text-center font-heading text-4xl font-black leading-[1.05] tracking-tight sm:text-5xl"
            style={{ textShadow: "0 0 20px hsl(220 90% 60% / 0.4)" }}
          >
            Two kinds of coin
          </h1>

          {/* The distinction the whole app rests on, said once, at the top. */}
          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-[#7dffd4]/30 bg-[#7dffd4]/[0.06] p-4">
              <div className="flex items-center gap-2">
                <VibeCoinMark size={26} />
                <span className="font-heading text-2xl font-black tabular-nums text-[#7dffd4]">
                  {balance == null ? "—" : formatVibecoin(balance, { compact: false })}
                </span>
              </div>
              <p className="mt-1.5 font-heading text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                Vibecoin {VIBECOIN_GLYPH}
              </p>
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
                The currency of the vibeverse. Buys characters, plays cabinets,
                stakes rounds. Play money, and yours the moment you arrive.
              </p>
            </div>

            <div className="rounded-2xl border border-[#8fb4ff]/30 bg-[#8fb4ff]/[0.06] p-4">
              <p className="font-heading text-2xl font-black tabular-nums text-[#8fb4ff]">
                {rows.length === 0 ? "$VIBE" : amount(totalVibe, "")}
              </p>
              <p className="mt-1.5 font-heading text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                $VIBE · a real token on Base
              </p>
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
                Separate, real, and held in your own wallet. This app reads it
                and has never sent a transaction.{" "}
                <Link to="/coin" className="text-[#8fb4ff] underline underline-offset-2">
                  See the market
                </Link>
                .
              </p>
            </div>
          </div>

          {/* ---- The list ---- */}
          {rows.length > 0 && (
            <div className="mt-6">
              <p className="font-heading text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">
                {rows.length === 1 ? "Your wallet" : `Your ${rows.length} wallets`}
              </p>
              <div className="mt-2.5 flex flex-col gap-2.5">
                {rows.map((r) => (
                  <WalletCard key={r.address} row={r} onRefresh={refresh} />
                ))}
              </div>
            </div>
          )}

          <div className="mt-4">
            <VibeWalletConnect
              displayName={isGuest ? undefined : displayName}
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
                Not your $VIBE, not your ETH, not your Vibecoin.
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

          <p className="mt-6 text-center text-[11px] text-muted-foreground/70">
            <Link to="/arcade" className="underline underline-offset-2 hover:text-foreground">
              Go win some Vibecoin
            </Link>
            {" · "}
            <Link to="/arcade/characters" className="underline underline-offset-2 hover:text-foreground">
              or spend it
            </Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
