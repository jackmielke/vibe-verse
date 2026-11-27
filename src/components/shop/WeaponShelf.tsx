/**
 * The weapons shelf: Vibe City's guns and pineapple bombs.
 *
 * Same till as the hats (`buyCosmetic("weapon", id)`), same inventory, so a
 * Glock bought on /shop is in your hand in Vibe City, and one bought at the
 * Vibe Arms stall in town shows up as owned here. Nothing to equip: a gun you
 * buy goes straight into your hand in the city, sits on the weapon bar, and
 * never runs out.
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { VIBECOIN_GLYPH } from "@/lib/vibecoin";
import { buyCosmetic, itemKey } from "@/lib/wardrobe";
import { WEAPON_ITEMS, type WeaponItem } from "@/lib/weaponCatalog";

const ACCENT = "#ff8a6b";

export default function WeaponShelf({ inCity = false }: { inCity?: boolean }) {
  const { balance } = useVibecoin();
  const { owned, refresh } = useWardrobe();
  const [busy, setBusy] = useState<string | null>(null);
  const ownedSet = useMemo(() => new Set(owned), [owned]);

  const onBuy = async (item: WeaponItem) => {
    setBusy(item.id);
    try {
      await buyCosmetic("weapon", item.id);
      toast.success(`${item.emoji} ${item.name} is yours`, {
        description: `−${item.price} ${VIBECOIN_GLYPH} · ${
          item.id === "pineapple"
            ? "tap 🍍 or press X in Vibe City to throw one"
            : "it is in your hand in Vibe City, and on the weapon bar at the side"
        }. It never runs out.`,
      });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      toast.error("That did not go through", {
        description: /not enough/i.test(msg)
          ? `${item.name} costs ${item.price} ${VIBECOIN_GLYPH} and you are short. Win some in the arcade.`
          : msg,
      });
      void refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mt-10"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-heading text-base font-black uppercase tracking-wider" style={{ color: ACCENT }}>
          Vibe Arms
        </h2>
        <p className="text-[11.5px] text-muted-foreground">
          {inCity
            ? "Buy once, never run out. Tap a gun on the weapon bar (or 1 to 5) to draw it, R fires, X throws a pineapple."
            : "For Vibe City. Buy once, never run out of ammo."}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3">
        {WEAPON_ITEMS.map((item) => {
          const ownedIt = ownedSet.has(itemKey("weapon", item.id));
          const affordable = balance == null || balance >= item.price;
          const working = busy === item.id;
          return (
            <div
              key={item.id}
              className="flex flex-col gap-2.5 rounded-2xl border p-3"
              style={{
                borderColor: ownedIt ? item.color : "hsl(var(--border) / 0.5)",
                background: ownedIt ? `${item.color}14` : "rgba(0,0,0,0.22)",
              }}
            >
              <div className="flex items-start gap-2.5">
                <div
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-lg"
                  style={{ background: `${item.color}22`, boxShadow: `inset 0 0 0 1.5px ${item.color}88` }}
                  aria-hidden
                >
                  <span className="text-2xl leading-none">{item.emoji}</span>
                </div>
                <div className="min-w-0">
                  <div className="font-heading text-[12.5px] font-bold leading-tight">{item.name}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{item.blurb}</div>
                </div>
              </div>
              {ownedIt ? (
                <div
                  className="rounded-lg px-2 py-2 text-center font-heading text-[9.5px] font-black uppercase tracking-wider text-black"
                  style={{ background: item.color }}
                >
                  ✓ Owned · unlimited
                </div>
              ) : (
                <button
                  onClick={() => void onBuy(item)}
                  disabled={working || !affordable}
                  className="rounded-lg px-2 py-2 font-heading text-[9.5px] font-black uppercase tracking-wider text-black transition-transform enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ background: item.color }}
                >
                  {working
                    ? "…"
                    : affordable
                      ? `Buy · ${item.price} ${VIBECOIN_GLYPH}`
                      : `Need ${item.price} ${VIBECOIN_GLYPH}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </motion.section>
  );
}
