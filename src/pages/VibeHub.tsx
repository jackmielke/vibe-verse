/**
 * `/coin` — the one page about the currency.
 *
 * ## Why there is only one now
 *
 * There were two, and they disagreed about what they were for. `/coin` led
 * with "our community currency" and then showed a shop panel, a character
 * picker and a holder leaderboard — a junk drawer of everything that touched
 * money. `/wallet` explained the thing properly, in order, and was reachable
 * only from a popover most people never opened. Two pages about one subject
 * is how you get a visitor who has read neither.
 *
 * So: one page, at `/coin`, answering to `/vibe` and `/wallet` too. It is a
 * story rather than a dashboard, and the story is the actual product:
 *
 *   1. **MAKE A VIBE ACCOUNT.** An email and a six-digit code. This is the
 *      thing that has to be easy, because everything below it is worthless if
 *      nobody gets past it.
 *   2. **Earn Vibey Coins.** Playing games. No wallet, no crypto, none
 *      of the decisions.
 *   3. **Claim it for real.** When you have enough to care about, connect a
 *      wallet — or make one with Face ID in one tap — and a real token can
 *      find you.
 *
 * Step 3 being *last* is the whole design. Every crypto product puts "connect
 * wallet" first and loses everybody who does not have one; here you can play
 * for a month before the word wallet appears.
 *
 * The shop and character panels moved off this page to `/shop` and
 * `/characters`, which is where somebody looking for them goes anyway.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Check, Copy, LogIn, Sparkles } from "lucide-react";
import { VIBE_TOKEN_ADDRESS } from "@/lib/vibe-wallet";
import VibeArc from "@/components/VibeArc";
import VibeCoinMark from "@/components/VibeCoinMark";
import VibeWink from "@/components/VibeWink";
import VibeCoinPanel from "@/components/VibeCoinPanel";
import VibeWalletSection from "@/components/VibeWalletSection";
import VibeWalletLeaderboard from "@/components/VibeWalletLeaderboard";
import VibeAuthDialog from "@/components/vibe-auth/VibeAuthDialog";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { useWalletBook } from "@/hooks/use-wallet-book";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { VIBECOIN_GLYPH, VIBECOIN_NAME, formatVibecoin } from "@/lib/vibecoin";

/** A numbered step, so the page reads as a sequence and not as four cards. */
function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-9">
      <div className="flex items-center gap-2.5">
        <span
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-full font-heading text-[11px] font-black ${
            done
              ? "bg-[#7dffd4] text-black"
              : "border border-border/60 text-muted-foreground"
          }`}
        >
          {done ? <Check className="h-3.5 w-3.5" /> : n}
        </span>
        <h2 className="font-heading text-[13px] font-black uppercase tracking-[0.14em] text-foreground/90">
          {title}
        </h2>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function VibeHub() {
  useWorldStamp("/coin", "Vibe Coin");
  const { balance, loading } = useVibecoin();
  const { isGuest, displayName } = useVibeIdentity();
  const { rows, totalUsd } = useWalletBook();
  const [authOpen, setAuthOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const totalVibe = rows.reduce((t, r) => t + (r.vibe ?? 0), 0);

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#03050c] text-foreground">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 50% at 50% -8%, hsl(150 70% 40% / 0.15), transparent 60%)," +
            "radial-gradient(55% 45% at 88% 16%, hsl(268 88% 62% / 0.13), transparent 68%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-lg px-5 pb-24 pt-16">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {/* ---- Hero ---- */}
          <div className="flex justify-center">
            <VibeArc size={170} rotateSeconds={30} />
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1">
              <Sparkles className="h-2.5 w-2.5 text-primary" />
              <span className="font-heading text-[9px] font-semibold uppercase tracking-[0.25em] text-primary">
                $VIBE on Base
              </span>
            </span>
            {/* The contract, one tap away from the headline. People ask for it
                before they read anything else on this page. */}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(VIBE_TOKEN_ADDRESS)
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1600);
                  })
                  .catch(() => { /* clipboard blocked — nothing useful to do */ });
              }}
              title={VIBE_TOKEN_ADDRESS}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 font-heading text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
            >
              {copied ? <Check className="h-2.5 w-2.5 text-primary" /> : <Copy className="h-2.5 w-2.5" />}
              {copied ? "Copied" : "Copy address"}
            </button>
          </div>
          <h1 className="mt-3.5 text-center font-heading text-4xl font-black leading-[1.05] tracking-tight sm:text-5xl">
            Our community currency.
          </h1>
          <p className="mx-auto mt-3.5 max-w-md text-center text-[13px] leading-relaxed text-foreground/75">
            Earn Vibey Coins by playing, spend them in the arcade, and claim them as
            real Vibecoin when you have enough to care about. No wallet needed
            to start — an email is the whole sign-up.
          </p>

          {/* ---- The one distinction everything else rests on ---- */}
          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-[#7dffd4]/30 bg-[#7dffd4]/[0.06] p-4">
              <div className="flex items-center gap-2">
                <VibeCoinMark size={26} />
                <span className="font-heading text-2xl font-black tabular-nums text-[#7dffd4]">
                  {balance == null ? "—" : formatVibecoin(balance, { compact: false })}
                </span>
              </div>
              <p className="mt-1.5 font-heading text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                {VIBECOIN_NAME} {VIBECOIN_GLYPH}
              </p>
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
                What you earn in the worlds. Buys characters, plays cabinets,
                stakes rounds. Yours the moment you arrive, no account needed.
              </p>
            </div>

            <div className="rounded-2xl border border-[#8fb4ff]/30 bg-[#8fb4ff]/[0.06] p-4">
              {/* The wink, not the ✦ — this card is the real token, and the
                  two marks are how you tell the two coins apart at a glance. */}
              <div className="flex items-baseline gap-2">
                <VibeWink size={26} className="shrink-0 self-center" />
                <p className="font-heading text-2xl font-black tabular-nums text-[#8fb4ff]">
                  {rows.length === 0
                    ? "$VIBE"
                    : totalVibe.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
                {rows.length > 0 && totalUsd != null && (
                  <p className="font-heading text-sm font-black tabular-nums text-foreground/70">
                    ${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </p>
                )}
              </div>
              <p className="mt-1.5 font-heading text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                Vibecoin · $VIBE on Base
              </p>
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
                Lives on Base, in a wallet you control. This app reads it and
                has never sent a transaction from your side.
              </p>
            </div>
          </div>

          {/* ---- 1. The account ---- */}
          <Step n={1} title="MAKE A VIBE ACCOUNT" done={!isGuest}>
            {isGuest ? (
              <div className="rounded-2xl border border-border/50 bg-black/28 p-4">
                <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                  An email and a six-digit code — no password, nothing to
                  download. It is what makes your Vibey Coins follow you from your
                  laptop to your phone instead of living in one browser.
                </p>
                <button
                  onClick={() => setAuthOpen(true)}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-3 font-heading text-[10.5px] font-black uppercase tracking-wider text-primary-foreground transition-transform hover:scale-[1.02]"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  Create your Vibe account
                </button>
                <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground/70">
                  You can keep playing without one. Everything you have earned
                  so far comes with you when you sign in — the guest wallet gets
                  merged, once, automatically.
                </p>
              </div>
            ) : (
              <div className="rounded-2xl border border-[#7dffd4]/30 bg-[#7dffd4]/[0.06] p-4">
                <p className="font-heading text-[11px] font-black uppercase tracking-wider text-[#7dffd4]">
                  Signed in{displayName ? ` as ${displayName}` : ""}
                </p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                  Your Vibey Coins are on your account now, not in this browser. They
                  are there on any device you sign in from.
                </p>
              </div>
            )}
          </Step>

          {/* ---- 2. Earning it ---- */}
          <Step n={2} title="Earn some Vibey Coins" done={(balance ?? 0) > 100}>
            <div className="rounded-2xl border border-border/50 bg-black/28 p-4">
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                Everyone starts with 100. The cabinets in the arcade pay out,
                the sky islands over Vibe Island pay out, and ORBIT pays the
                whole pot to whoever flies furthest.
              </p>
              <div className="mt-3 flex gap-1.5">
                <Link
                  to="/arcade"
                  className="flex-1 rounded-xl bg-primary px-2 py-2.5 text-center font-heading text-[9.5px] font-bold uppercase tracking-wider text-primary-foreground transition-transform hover:scale-[1.02]"
                >
                  🕹️ Win some
                </Link>
                <Link
                  to="/arcade/characters"
                  className="flex-1 rounded-xl border border-border/60 px-2 py-2.5 text-center font-heading text-[9.5px] font-bold uppercase tracking-wider text-foreground/80 transition-colors hover:text-foreground"
                >
                  🧑‍🚀 Spend it
                </Link>
              </div>
            </div>
          </Step>

          {/* ---- 3. Claiming it ---- */}
          <Step n={3} title="Claim them as real Vibecoin" done={rows.length > 0}>
            <p className="mb-3 text-[11.5px] leading-relaxed text-muted-foreground">
              Last on purpose. Connect a wallet you already have, or make one
              with Face ID in a single tap — either way you sign a sentence,
              never a transaction, and nothing moves out of your wallet.
            </p>
            <VibeWalletSection displayName={isGuest ? undefined : displayName} />
          </Step>

          {/* ---- The market, and who is holding ---- */}
          <div className="mt-10">
            <VibeCoinPanel />
          </div>
          <div className="mt-6">
            <VibeWalletLeaderboard defaultVisible={8} maxRows={40} />
          </div>
        </motion.div>
      </div>

      <VibeAuthDialog open={authOpen} onOpenChange={setAuthOpen} />
    </div>
  );
}
