/**
 * The two coins, explained once, at the bottom of the front door.
 *
 * There are two currencies in here and they are easy to confuse because they
 * are named after each other. Everything downstream of that confusion is bad:
 * somebody thinks the arcade is gambling with real money, or thinks the token
 * is a score, or does not realise the thing they have been earning all evening
 * can become dollars.
 *
 * So it is one panel with the two of them side by side, and the difference is
 * carried by the mark before it is carried by any sentence — the 3D wink is
 * Vibecoin, the ✦ is Vibey Coins, and those two shapes are used consistently
 * everywhere else in the app precisely so this panel can do its job in a
 * glance.
 *
 * The bridge between them is the one part people actually want to know, so it
 * gets its own row rather than a footnote, it names the real rate, and it is
 * honest that the rate is not fixed yet. A conversion page that implies a peg
 * that does not exist is the one mistake here that would cost somebody money.
 *
 * The live numbers come from `lib/vibeMarket.ts` and are cached, so this
 * section never renders a row of dashes to a returning visitor.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ExternalLink } from "lucide-react";

import VibeCoinMark from "@/components/VibeCoinMark";
import VibeWink from "@/components/VibeWink";
import { VIBECOIN_GLYPH, VIBECOIN_NAME } from "@/lib/vibecoin";
import {
  VIBE_LINKS,
  VIBE_SUPPLY,
  formatPrice,
  formatUsdCompact,
  getVibeMarket,
  marketCap,
  refreshVibeMarket,
  subscribeVibeMarket,
  type VibeMarket,
} from "@/lib/vibeMarket";

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-white/[0.07] py-1.5 first:border-t-0">
      <dt className="text-[10.5px] text-muted-foreground">{k}</dt>
      <dd className="font-heading text-[11px] font-bold tabular-nums text-foreground/85">{v}</dd>
    </div>
  );
}

export default function TwoCoins() {
  const [m, setM] = useState<VibeMarket>(getVibeMarket);
  useEffect(() => {
    const off = subscribeVibeMarket(setM);
    void refreshVibeMarket();
    setM(getVibeMarket());
    return off;
  }, []);

  const cap = marketCap(m.usd);
  /* What a thousand VIBE is worth — a fact about the token, not a claim about
     the exchange rate. The first version of this line priced a thousand PLAY
     coins, which quietly asserted the 1:1 rate that the sentence immediately
     after it says does not exist yet. Thousands rather than one, because a
     per-token figure at this price is four leading zeros and reads as nothing. */
  const per1kVibe = m.usd == null ? null : m.usd * 1000;

  return (
    <section className="mt-16">
      <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.025] backdrop-blur-sm">
        <div className="border-b border-white/[0.07] px-5 py-4 sm:px-6">
          <h2 className="font-heading text-lg font-black tracking-tight sm:text-xl">
            Two coins, and what each one is for
          </h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
            One you play with, one you keep. They are named after each other,
            which is confusing exactly once — after that, the mark tells you
            which is which.
          </p>
        </div>

        <div className="grid gap-px bg-white/[0.07] sm:grid-cols-2">
          {/* ---- The play coin ---- */}
          <div className="bg-[#070b13] p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <VibeCoinMark size={38} />
              <div>
                <div className="font-heading text-base font-black leading-none text-[#7dffd4]">
                  {VIBECOIN_NAME}
                </div>
                <div className="mt-1 font-heading text-[8.5px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  The one you play with
                </div>
              </div>
            </div>
            <p className="mt-3.5 text-[12px] leading-relaxed text-foreground/70">
              Everyone starts with 100, no account needed. Earn them in the
              worlds, win them in the arcade, spend them on characters and hats
              you keep. They live in our own ledger — every movement is a row —
              and nothing about them touches a blockchain.
            </p>
            <dl className="mt-4">
              <Row k="Symbol" v={`${VIBECOIN_GLYPH} — a struck coin`} />
              <Row k="Where it lives" v="Our ledger, per wallet" />
              <Row k="To start" v="100, free, no sign-in" />
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                to="/arcade"
                className="rounded-full border border-[#7dffd4]/40 px-3.5 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider text-[#7dffd4] transition-colors hover:bg-[#7dffd4]/10"
              >
                Go and win some
              </Link>
              <Link
                to="/shop/cosmos"
                className="rounded-full border border-white/15 px-3.5 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider text-foreground/75 transition-colors hover:text-foreground"
              >
                Spend them
              </Link>
            </div>
          </div>

          {/* ---- The real one ---- */}
          <div className="bg-[#070b13] p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <VibeWink size={38} />
              <div>
                <div className="font-heading text-base font-black leading-none text-[#8fb4ff]">
                  Vibecoin
                </div>
                <div className="mt-1 font-heading text-[8.5px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  The one you keep
                </div>
              </div>
            </div>
            <p className="mt-3.5 text-[12px] leading-relaxed text-foreground/70">
              A real ERC-20 on Base, with a real price and a fixed supply of one
              billion. It is not a score and it is not ours to mint more of —
              you hold it in your own wallet, and you can sell it, send it or
              keep it without asking anybody here.
            </p>
            <dl className="mt-4">
              <Row k="Price" v={formatPrice(m.usd)} />
              <Row k="Market cap" v={formatUsdCompact(cap)} />
              <Row k="Supply" v={`${(VIBE_SUPPLY / 1e9).toFixed(0)}B, fixed`} />
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                to="/coin"
                className="rounded-full border border-[#8fb4ff]/40 px-3.5 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider text-[#8fb4ff] transition-colors hover:bg-[#8fb4ff]/10"
              >
                Claim yours
              </Link>
              <a
                href={VIBE_LINKS.chart}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 rounded-full border border-white/15 px-3.5 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider text-foreground/75 transition-colors hover:text-foreground"
              >
                Chart <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </div>
          </div>
        </div>

        {/* ---- The bridge ----
            The question everybody actually has, given its own row instead of
            a footnote at the bottom of one column. */}
        <div className="border-t border-white/[0.07] bg-gradient-to-r from-[#7dffd4]/[0.05] via-transparent to-[#8fb4ff]/[0.05] px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="flex items-center gap-1.5 font-heading text-[11px] font-black text-[#7dffd4]">
              <VibeCoinMark size={15} flat /> {VIBECOIN_NAME}
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex items-center gap-1.5 font-heading text-[11px] font-black text-[#8fb4ff]">
              <VibeWink size={16} /> Vibecoin
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-heading text-[11px] font-black text-foreground">
              Actual dollars
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-[11.5px] leading-relaxed text-muted-foreground">
            Play coins can be claimed out as real Vibecoin to a wallet you own,
            and Vibecoin trades on Base — so what you win in here can leave with
            you and become dollars.{" "}
            <span className="text-foreground/70">
              How many play coins buy how much Vibecoin is not set yet
            </span>{" "}
            — it is a decision nobody has made, not a peg, so today the claim
            is a flat grant of 1,000 real Vibecoin per wallet rather than an
            exchange.
            {per1kVibe != null && (
              <>
                {" "}
                At today&apos;s price that grant is worth about{" "}
                <span className="font-semibold text-foreground/85">
                  {per1kVibe < 0.01 ? "less than a cent" : `$${per1kVibe.toFixed(2)}`}
                </span>
                .
              </>
            )}{" "}
            Nothing here is an investment, and the app has never sent a
            transaction on anybody&apos;s behalf.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={VIBE_LINKS.announcement}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3.5 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider text-foreground/80 transition-colors hover:border-white/40 hover:text-foreground"
            >
              Why we launched it <ExternalLink className="h-2.5 w-2.5" />
            </a>
            <Link
              to="/coin"
              className="rounded-full border border-white/15 px-3.5 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider text-foreground/80 transition-colors hover:border-white/40 hover:text-foreground"
            >
              Our community currency →
            </Link>
            <Link
              to="/manifesto"
              className="rounded-full border border-white/15 px-3.5 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider text-foreground/80 transition-colors hover:border-white/40 hover:text-foreground"
            >
              Why any of it →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
