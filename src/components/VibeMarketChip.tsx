/**
 * `$VIBE $70.78K` — the token's market cap, on the front door.
 *
 * Small, quiet, and always the same width, because it sits in a row of chips
 * and a ticker that reflows the header every time it updates is a ticker
 * people learn to ignore.
 *
 * It renders the cached figure on the first frame and corrects it behind the
 * scenes — see `lib/vibeMarket.ts`. The one state it never shows is a spinner:
 * a first-time visitor with nothing cached gets a dash for a moment, and
 * everybody else gets a number immediately.
 *
 * The link goes to the pool chart rather than to `/coin`. Somebody who taps a
 * market cap wants the market, and the coin page is one tap further on from
 * there anyway.
 */
import { useEffect, useState } from "react";

import VibeWink from "@/components/VibeWink";
import {
  STALE_AFTER_MS,
  VIBE_LINKS,
  formatPrice,
  formatUsdCompact,
  getVibeMarket,
  marketCap,
  refreshVibeMarket,
  subscribeVibeMarket,
  type VibeMarket,
} from "@/lib/vibeMarket";

export default function VibeMarketChip({ className = "" }: { className?: string }) {
  const [m, setM] = useState<VibeMarket>(getVibeMarket);

  useEffect(() => {
    const off = subscribeVibeMarket(setM);
    void refreshVibeMarket();
    // Whatever landed between this component's initial state and its
    // subscription — another chip's fetch resolving, say.
    setM(getVibeMarket());
    return off;
  }, []);

  const cap = marketCap(m.usd);
  const stale = m.at > 0 && Date.now() - m.at > STALE_AFTER_MS;
  const up = m.change24h != null && m.change24h > 0;
  const down = m.change24h != null && m.change24h < 0;

  return (
    <a
      href={VIBE_LINKS.chart}
      target="_blank"
      rel="noreferrer noopener"
      title={
        m.usd == null
          ? "Vibecoin — the real token on Base"
          : `Vibecoin · ${formatPrice(m.usd)} per VIBE · market cap ${formatUsdCompact(cap)}${
              stale ? " (last known)" : ""
            }`
      }
      className={`group flex items-center gap-2 rounded-full border border-[#8fb4ff]/30 bg-[#8fb4ff]/[0.06] px-2.5 py-1 transition-colors hover:border-[#8fb4ff]/60 sm:px-3 sm:py-1.5 ${className}`}
    >
      {/* The wink is Vibecoin's mark and the ✦ is the play coin's. Using the
          right one here is most of what makes the two legible as different
          things everywhere else. */}
      <VibeWink size={18} className="shrink-0" />
      <span className="font-heading text-[9px] font-bold uppercase tracking-[0.18em] text-[#8fb4ff]/70">
        $Vibe
      </span>
      <span className="font-heading text-[12px] font-black tabular-nums leading-none text-[#cfe0ff] sm:text-[13px]">
        {formatUsdCompact(cap)}
      </span>
      {m.change24h != null && (
        <span
          className={`font-heading text-[9.5px] font-bold tabular-nums leading-none ${
            up ? "text-[#7dffd4]" : down ? "text-rose-300/90" : "text-muted-foreground"
          }`}
        >
          {up ? "▲" : down ? "▼" : ""}
          {Math.abs(m.change24h).toFixed(1)}%
        </span>
      )}
      {/* A quiet dot, not an error. The number is still the best one we have,
          and a visitor does not need to be told the pool API is slow. */}
      {stale && (
        <span
          className="h-1 w-1 shrink-0 rounded-full bg-amber-400/70"
          title="Last known — the pool has not answered recently"
        />
      )}
    </a>
  );
}
