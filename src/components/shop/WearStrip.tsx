/**
 * The wearables strip — hats, jetpacks and flames, on the same page as the
 * character you are putting them on.
 *
 * `/shop` has had a full item shelf for months, and the character screen had a
 * tab that swapped the whole stage out for it. Both are fine at listing
 * things and both get the same thing wrong: you cannot see what a hat looks
 * like on the character while you are choosing it. Choosing a hat by reading
 * its name is not choosing a hat.
 *
 * So this sits under the stage, and tapping a hat puts it on the character
 * three feet above it. One tap does the whole thing — buys it if you do not
 * own it, equips it either way — because "buy" and "wear" as two separate
 * taps is a step nobody wanted; there is no reason to buy a hat you are not
 * about to put on.
 *
 * Honesty about what the stage can show: hats are real geometry on the head.
 * Jetpacks and flames are not — this rig has no pack, so the preview would be
 * lying if it claimed to show one. Those get a swatch and a line saying where
 * they do show up, rather than a fake.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Check, Lock } from "lucide-react";

import VibeCoinMark from "@/components/VibeCoinMark";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { VIBECOIN_GLYPH } from "@/lib/vibecoin";
import { buyCosmetic, equip, itemKey, type CosmeticKind } from "@/lib/wardrobe";
import {
  CATALOG,
  type CosmeticItem,
  type FlameItem,
  type JetpackItem,
} from "@/lib/cosmeticCatalog";

type Row = {
  kind: CosmeticKind;
  label: string;
  /** Said under the row when the stage cannot show what this does. */
  note?: string;
};

const ROWS: Row[] = [
  { kind: "hat", label: "Hats" },
  {
    kind: "jetpack",
    label: "Jetpacks",
    note: "Packs and flames show up in Vibe City and Vibe Island — this stage has no pack to hang one on.",
  },
  { kind: "flame", label: "Flames" },
];

/** The dot on a jetpack or flame chip, since there is nothing to preview. */
function swatch(kind: CosmeticKind, item: CosmeticItem): string | null {
  if (kind === "flame") return (item as FlameItem).color;
  if (kind === "jetpack") return (item as JetpackItem).body;
  return null;
}

export default function WearStrip({
  /** Which hat the stage is currently showing, so the row can mark it. */
  wornHat,
  onHatChange,
}: {
  wornHat: string;
  onHatChange: (id: string) => void;
}) {
  const { balance } = useVibecoin();
  const { owned, loadout, refresh: refreshWardrobe } = useWardrobe();
  const [busy, setBusy] = useState<string | null>(null);

  const act = useCallback(
    async (kind: CosmeticKind, item: CosmeticItem) => {
      const key = itemKey(kind, item.id);
      const have = item.price <= 0 || owned.includes(key);
      setBusy(key);
      try {
        if (!have) await buyCosmetic(kind, item.id);
        await equip({ [kind]: item.id });
        // The stage reads its hat from here rather than from `loadout`, so it
        // changes on the same frame as the tap instead of after a round trip.
        if (kind === "hat") onHatChange(item.id);
        if (!have) {
          toast.success(`${item.name} is yours`, {
            description: `−${item.price} ${VIBECOIN_GLYPH}. Wearing it now.`,
          });
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        toast.error("That did not go through", {
          description: /not enough/i.test(msg)
            ? `${item.name} costs ${item.price} ${VIBECOIN_GLYPH}. Win some downstairs and come back.`
            : msg,
        });
      } finally {
        setBusy(null);
        void refreshWardrobe();
      }
    },
    [owned, onHatChange, refreshWardrobe],
  );

  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-heading text-[11px] font-black uppercase tracking-[0.2em] text-[#7dffd4]">
          Put something on
        </h3>
        <span className="text-[10px] text-muted-foreground/70">
          One tap buys it and wears it
        </span>
      </div>

      <div className="mt-3 space-y-3">
        {ROWS.map((row) => {
          const items = CATALOG[row.kind] as CosmeticItem[];
          // The hat comes from the stage's own state so the highlight moves on
          // the same frame as the character does; the other two have nothing
          // on stage to be in step with, so they read the server's loadout.
          const wearing = row.kind === "hat" ? wornHat : loadout[row.kind];
          return (
            <div key={row.kind}>
              <div className="mb-1.5 font-heading text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                {row.label}
              </div>
              {/* Bleeds off the right edge for the same reason the arcade
                  shelf does: a row that ends flush looks like the whole
                  catalogue. */}
              <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="flex w-max gap-2">
                  {items.map((item) => {
                    const key = itemKey(row.kind, item.id);
                    const free = item.price <= 0;
                    const have = free || owned.includes(key);
                    const on = wearing === item.id;
                    const afford = balance == null || balance >= item.price;
                    const dot = swatch(row.kind, item);
                    return (
                      <button
                        key={item.id}
                        onClick={() => void act(row.kind, item)}
                        disabled={busy != null || (!have && !afford)}
                        aria-pressed={on}
                        className={`relative flex w-[4.6rem] shrink-0 flex-col items-center gap-1 rounded-xl border px-2 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          on
                            ? "border-[#7dffd4] bg-[#7dffd4]/10"
                            : "border-border/50 bg-black/30 hover:bg-white/[0.05]"
                        }`}
                      >
                        {dot ? (
                          <span
                            className="h-6 w-6 rounded-full border border-white/20"
                            style={{ background: dot }}
                            aria-hidden
                          />
                        ) : (
                          <span className="text-lg leading-none" aria-hidden>
                            {item.emoji}
                          </span>
                        )}
                        <span className="w-full truncate text-center text-[9px] leading-tight text-foreground/80">
                          {item.name}
                        </span>
                        <span className="flex items-center gap-0.5 font-heading text-[9px] font-black tabular-nums">
                          {busy === key ? (
                            <span className="text-muted-foreground">…</span>
                          ) : have ? (
                            <Check className="h-3 w-3 text-[#7dffd4]" />
                          ) : afford ? (
                            <>
                              <VibeCoinMark size={9} />
                              <span className="text-[#7dffd4]">{item.price}</span>
                            </>
                          ) : (
                            <>
                              <Lock className="h-2.5 w-2.5 text-muted-foreground" />
                              <span className="text-muted-foreground">{item.price}</span>
                            </>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {row.note && (
                <p className="mt-1 text-[10px] leading-snug text-muted-foreground/60">
                  {row.note}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
