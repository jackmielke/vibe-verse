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
 *
 * The tile and the purchase are both shared now — `CharacterCard` and
 * `useCharacterActions` — because the front page shows the same cast. This file
 * is the part that is only true of the shop: the stock, and the grid.
 */
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

import CharacterCard from "@/components/shop/CharacterCard";
import { useCharacterActions } from "@/components/shop/useCharacterActions";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { SHOP_CHARACTERS, byShelfOrder } from "@/lib/characterShop";
import { itemKey } from "@/lib/wardrobe";

export default function CharacterShelf() {
  const { balance } = useVibecoin();
  const { owned, loadout } = useWardrobe();
  const { busy, buy, wear } = useCharacterActions();

  const stock = [...SHOP_CHARACTERS].sort(byShelfOrder);

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
        {stock.map((c) => (
          <CharacterCard
            key={c.id}
            id={c.id}
            title={c.title}
            pitch={c.pitch}
            price={c.price}
            tier={c.tier}
            owned={owned.includes(itemKey("character", c.id))}
            worn={loadout.character === c.id}
            affordable={balance == null || balance >= c.price}
            busy={busy === c.id}
            onBuy={() => void buy(c.id)}
            onWear={() => void wear(c.id)}
          />
        ))}
      </div>
    </motion.section>
  );
}
