/**
 * Characters, on the shelf in the actual shop.
 *
 * They were only ever for sale at `/arcade/characters` — a separate page,
 * behind the arcade, that you had to already know about. Meanwhile `/shop` is
 * the page called The Vibe Shop, the one the nav points at and the one a
 * visitor with coins goes looking for, and it sold hats. Somebody standing in
 * the shop could not buy the most expensive thing the shop sells.
 *
 * So the stock is here now. `/arcade/characters` still exists and is still the
 * better place to *look* at one — it has a live rotating preview and a
 * flip-through — but buying no longer requires finding it.
 *
 * This is a second surface over one table, not a second table: `SHOP_CHARACTERS`
 * is the stock, the portraits come from `characterArt`, and the money moves
 * through the same `buyCosmetic("character", id)` the arcade page uses. Prices
 * are the server's copy, checked by `src/test/characterShop.test.ts`.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import VibeCoinMark from "@/components/VibeCoinMark";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { characterArt } from "@/lib/characterArt";
import { findCharacter } from "@/lib/characters";
import { SHOP_CHARACTERS, TIER_STYLE, byShelfOrder } from "@/lib/characterShop";
import { buyCosmetic, equip, itemKey } from "@/lib/wardrobe";

export default function CharacterShelf() {
  const { balance, refresh: refreshCoin } = useVibecoin();
  const { owned, loadout, refresh: refreshWardrobe } = useWardrobe();
  const [busy, setBusy] = useState<string | null>(null);

  const stock = [...SHOP_CHARACTERS].sort(byShelfOrder);

  const buy = async (id: string) => {
    setBusy(id);
    try {
      await buyCosmetic("character", id);
      /* Wearing it immediately is the whole reason somebody just paid. Doing it
         without asking is safe here in a way it would not be for a hat: you can
         only be one character, and the one you just bought is unambiguously the
         one you wanted. */
      await equip({ character: id });
      toast.success(`${findCharacter(id).label} is yours — and you are wearing it.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That purchase did not go through.");
    } finally {
      // Both, either way: a failed buy still wants the true balance back.
      await Promise.all([refreshCoin(), refreshWardrobe()]);
      setBusy(null);
    }
  };

  const wear = async (id: string) => {
    const ok = await equip({ character: id });
    if (!ok) toast.error("Could not reach the ledger — that change did not stick.");
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mt-10"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-heading text-base font-black uppercase tracking-wider text-[#e2b7ff]">
          Characters
        </h2>
        <p className="text-[11.5px] text-muted-foreground">
          Built from code, not bought in. Every one of these exists only here.
        </p>
        <Link
          to="/arcade/characters"
          className="ml-auto shrink-0 font-heading text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          See them move →
        </Link>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
        {stock.map((c) => {
          const spec = findCharacter(c.id);
          const art = characterArt(c.id);
          const tier = TIER_STYLE[c.tier];
          const isOwned = owned.includes(itemKey("character", c.id));
          const worn = loadout.character === c.id;
          const affordable = balance == null || balance >= c.price;
          const working = busy === c.id;

          return (
            <div
              key={c.id}
              className="flex flex-col overflow-hidden rounded-2xl border transition-colors"
              style={{
                borderColor: worn ? spec.accent : "hsl(var(--border) / 0.5)",
                background: worn ? `${spec.accent}12` : "rgba(0,0,0,0.22)",
              }}
            >
              {/* The picture is the pitch. A character card that leads with its
                  name is a price list; this shelf sells on silhouette. */}
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
                <span
                  className="absolute left-1.5 top-1.5 rounded-full px-2 py-0.5 font-heading text-[8px] font-black uppercase tracking-[0.14em] text-black"
                  style={{ background: tier.color }}
                >
                  {tier.label}
                </span>
              </div>

              <div className="flex flex-1 flex-col p-2.5">
                <div className="truncate font-heading text-[12.5px] font-bold leading-tight">
                  {c.title}
                </div>
                <p className="mt-1 line-clamp-2 text-[10.5px] leading-snug text-muted-foreground">
                  {c.pitch}
                </p>

                <div className="mt-auto pt-2.5">
                  {worn ? (
                    <div
                      className="rounded-full px-3 py-1.5 text-center font-heading text-[9.5px] font-bold uppercase tracking-wider"
                      style={{ background: `${spec.accent}22`, color: spec.accent }}
                    >
                      Wearing
                    </div>
                  ) : isOwned ? (
                    <button
                      onClick={() => void wear(c.id)}
                      className="w-full rounded-full border border-border/60 px-3 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider transition-colors hover:border-foreground/40 hover:text-foreground"
                    >
                      Wear
                    </button>
                  ) : (
                    <button
                      onClick={() => void buy(c.id)}
                      disabled={working || !affordable}
                      className="flex w-full items-center justify-center gap-1.5 rounded-full px-3 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider transition-colors disabled:opacity-45"
                      style={{
                        background: affordable ? `${spec.accent}1f` : "transparent",
                        color: affordable ? spec.accent : undefined,
                        border: `1px solid ${affordable ? `${spec.accent}55` : "hsl(var(--border) / 0.5)"}`,
                      }}
                      title={affordable ? undefined : "Not enough Vibey Coins yet"}
                    >
                      {working ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <VibeCoinMark size={11} />
                      )}
                      <span className="tabular-nums">{c.price}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </motion.section>
  );
}
