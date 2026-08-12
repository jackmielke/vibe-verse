/**
 * One character, as a tile — the shelf's card, extracted so the front page can
 * show the same thing without a second copy of it.
 *
 * Presentational on purpose: it is handed what is true and what to call, and it
 * decides nothing about money. That is what lets the same tile appear in a
 * four-column grid you can buy from and in a horizontal rail on the landing
 * page, without either surface inheriting the other's layout.
 *
 * ## Free characters are a first-class case
 *
 * `characterShop.ts` states the rule that governs this: **in that table means
 * you must own it, absent means it is free.** Most of the roster is free —
 * including every one of the newest designs — so a card that could only render
 * a price would have been a card that could only show the older half of the
 * cast. No price, no tier badge, and the action is simply "Wear".
 */
import { Loader2 } from "lucide-react";

import VibeCoinMark from "@/components/VibeCoinMark";
import { TIER_STYLE, type CharacterTier } from "@/lib/characterShop";
import { characterArt } from "@/lib/characterArt";
import { findCharacter } from "@/lib/characters";

export interface CharacterCardProps {
  /** Matches a `CharSpec.id` in `src/lib/characters.ts`. */
  id: string;
  title: string;
  pitch: string;
  /** Vibecoin. Absent means free — see the note above. */
  price?: number;
  tier?: CharacterTier;
  owned: boolean;
  worn: boolean;
  /** Whether the visitor's balance covers `price`. Ignored when free. */
  affordable?: boolean;
  busy?: boolean;
  onBuy?: () => void;
  onWear?: () => void;
  className?: string;
}

export default function CharacterCard({
  id,
  title,
  pitch,
  price,
  tier,
  owned,
  worn,
  affordable = true,
  busy = false,
  onBuy,
  onWear,
  className = "",
}: CharacterCardProps) {
  const spec = findCharacter(id);
  const art = characterArt(id);
  const style = tier ? TIER_STYLE[tier] : null;
  /* Free, or already paid for. Either way the only thing left to do is put
     it on. */
  const wearable = owned || price == null;

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-2xl border transition-colors ${className}`}
      style={{
        borderColor: worn ? spec.accent : "hsl(var(--border) / 0.5)",
        background: worn ? `${spec.accent}12` : "rgba(0,0,0,0.22)",
      }}
    >
      {/* The picture is the pitch. A character card that leads with its name is
          a price list; this shelf sells on silhouette. */}
      <div
        className="relative aspect-[4/5] shrink-0 overflow-hidden"
        style={{
          background: `radial-gradient(120% 80% at 50% 8%, ${spec.accent}30, transparent 62%)`,
        }}
      >
        {art ? (
          <img
            src={art}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-contain p-1.5 drop-shadow-[0_8px_18px_rgba(0,0,0,0.5)]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl" aria-hidden>
            {spec.emoji}
          </div>
        )}
        {style && (
          <span
            className="absolute left-1.5 top-1.5 rounded-full px-2 py-0.5 font-heading text-[8px] font-black uppercase tracking-[0.14em] text-black"
            style={{ background: style.color }}
          >
            {style.label}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-2.5">
        <div className="truncate font-heading text-[12.5px] font-bold leading-tight">{title}</div>
        <p className="mt-1 line-clamp-2 text-[10.5px] leading-snug text-muted-foreground">
          {pitch}
        </p>

        <div className="mt-auto pt-2.5">
          {worn ? (
            <div
              className="rounded-full px-3 py-1.5 text-center font-heading text-[9.5px] font-bold uppercase tracking-wider"
              style={{ background: `${spec.accent}22`, color: spec.accent }}
            >
              Wearing
            </div>
          ) : wearable ? (
            <button
              onClick={onWear}
              className="w-full rounded-full border border-border/60 px-3 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              Wear
            </button>
          ) : (
            <button
              onClick={onBuy}
              disabled={busy || !affordable}
              className="flex w-full items-center justify-center gap-1.5 rounded-full px-3 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider transition-colors disabled:opacity-45"
              style={{
                background: affordable ? `${spec.accent}1f` : "transparent",
                color: affordable ? spec.accent : undefined,
                border: `1px solid ${affordable ? `${spec.accent}55` : "hsl(var(--border) / 0.5)"}`,
              }}
              title={affordable ? undefined : "Not enough Vibey Coins yet"}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <VibeCoinMark size={11} />}
              <span className="tabular-nums">{price}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
