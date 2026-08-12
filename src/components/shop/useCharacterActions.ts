/**
 * Buying and wearing a character, once, for every surface that offers it.
 *
 * This was inlined in `CharacterShelf` and it has to be shared now that the
 * front page offers the same stock: the interesting part is not the two API
 * calls, it is the error handling around them. In particular the "not on sale
 * yet" translation below is a piece of knowledge about how this repo deploys,
 * and a second copy of it would be a second copy to forget to update.
 *
 * The hook owns nothing but `busy`. Whose money it is, what is owned and what
 * is worn all come from `useVibecoin` / `useWardrobe`, which reference-count a
 * single request per page — so mounting this twice does not fetch twice.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { findCharacter } from "@/lib/characters";
import { buyCosmetic, equip } from "@/lib/wardrobe";

export interface CharacterActions {
  /** Which id is mid-purchase, or null. */
  busy: string | null;
  buy: (id: string) => Promise<void>;
  wear: (id: string) => Promise<void>;
}

export function useCharacterActions(): CharacterActions {
  const { refresh: refreshCoin } = useVibecoin();
  const { refresh: refreshWardrobe } = useWardrobe();
  const [busy, setBusy] = useState<string | null>(null);

  const buy = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await buyCosmetic("character", id);
        /* Wearing it immediately is the whole reason somebody just paid. Doing
           it without asking is safe here in a way it would not be for a hat:
           you can only be one character, and the one you just bought is
           unambiguously the one you wanted. */
        await equip({ character: id });
        toast.success(`${findCharacter(id).label} is yours — and you are wearing it.`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        /**
         * The one failure worth translating.
         *
         * Prices live in this repo twice on purpose — once in `characterShop`
         * so a shelf can print an honest number before you pay, and once in
         * the `vibe-economy` edge function, which is the copy that actually
         * charges. Adding stock therefore needs a function deploy as well as a
         * push, and until that lands the server answers `no such cosmetic:
         * character/bolt`, which reads to a visitor as "this character is
         * broken" when what it means is "the till has not been told yet".
         *
         * Nothing has been charged when this happens — `cosmeticSpec` throws
         * before any balance is touched — so the honest message is that it is
         * not on sale yet, and it is safe to try later.
         */
        toast.error(
          /no such cosmetic/i.test(msg)
            ? `${findCharacter(id).label} is not on sale yet — the shop's till has not been updated. You were not charged.`
            : msg || "That purchase did not go through.",
        );
      } finally {
        // Both, either way: a failed buy still wants the true balance back.
        await Promise.all([refreshCoin(), refreshWardrobe()]);
        setBusy(null);
      }
    },
    [refreshCoin, refreshWardrobe],
  );

  const wear = useCallback(async (id: string) => {
    const ok = await equip({ character: id });
    if (!ok) toast.error("Could not reach the ledger — that change did not stick.");
  }, []);

  return { busy, buy, wear };
}
