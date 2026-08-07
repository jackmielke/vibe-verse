/**
 * /wallet — where your $VIBE would go.
 *
 * The wallet card existed for a while and lived only on `/join/:code`, which
 * meant the person most likely to want it — somebody already looking at their
 * balance and wondering whether it is real — had no route to it at all. This is
 * that route, linked from the Vibecoin chip.
 *
 * The page is deliberately calm and mostly words. It is the one screen in the
 * vibeverse where somebody decides whether to trust us with something, and the
 * honest answer is that there is very little to trust us with: a signature, no
 * transaction, no key we ever see. That reads better plainly than dressed up.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import VibeCoinMark from "@/components/VibeCoinMark";
import VibeWalletConnect from "@/components/VibeWalletConnect";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { VIBECOIN_GLYPH, formatVibecoin } from "@/lib/vibecoin";

export default function VibeWallet() {
  useWorldStamp("/wallet", "The Vibe Wallet");
  const { balance } = useVibecoin();
  const { isGuest, displayName } = useVibeIdentity();
  const [linked, setLinked] = useState<string | null>(null);

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

      <div className="relative mx-auto flex min-h-[100dvh] max-w-lg flex-col justify-center px-5 py-20">
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
                The currency of the vibeverse. Buys hats, plays cabinets, stakes
                rounds. Play money, and yours the moment you arrive.
              </p>
            </div>

            <div className="rounded-2xl border border-[#8fb4ff]/30 bg-[#8fb4ff]/[0.06] p-4">
              <p className="font-heading text-lg font-black text-[#8fb4ff]">$VIBE</p>
              <p className="mt-1.5 font-heading text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                A real token, on Base
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

          <div className="mt-4">
            <VibeWalletConnect
              displayName={isGuest ? undefined : displayName}
              onLinked={setLinked}
            />
          </div>

          {linked && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mt-3 text-center text-[11.5px] text-[#7dffd4]"
            >
              You are on the list. Nothing else to do — a drop would find you here.
            </motion.p>
          )}

          <div className="mt-6 rounded-2xl border border-border/50 bg-black/25 p-4">
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
                Every game, every round, every hat works without it.
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
            <Link to="/shop" className="underline underline-offset-2 hover:text-foreground">
              or spend it
            </Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
