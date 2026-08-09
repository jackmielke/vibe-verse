/**
 * /shop — the first place Vibey Coins buy something you keep.
 *
 * The arcade proved coins could be spent; it could not prove they were worth
 * having, because everything you won there went straight back into the same
 * machines. This is the other half: a hat costs 25, a crown costs 250, and the
 * one you buy is yours on every device you ever open the vibeverse on.
 *
 * Those prices are not new. They have been sitting in the catalog since the
 * cosmetics were written, next to a comment reading "currently free during
 * early access" — the shop existed as a number nobody charged. What changed is
 * where ownership lives: `vibe_inventory` on the ledger instead of an array in
 * `localStorage`, so it survives a cleared browser, a different laptop, and
 * signing in.
 *
 * Two rules the UI has to keep:
 *
 * 1. **Never show a price you will not charge.** The card reads its number
 *    from the same catalog the server prices against, and the server is the
 *    one that actually moves money. They are checked against each other in
 *    `src/test/wardrobe.test.ts`.
 * 2. **Equipping is instant, buying is not.** Putting a hat on is a local
 *    change with a server confirmation behind it; spending 250 coins gets a
 *    spinner and an honest error, because it is the one action here that can
 *    fail in a way you need to know about.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import VibeCoinMark from "@/components/VibeCoinMark";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import ItemShelves from "@/components/shop/ItemShelves";
import { VIBECOIN_GLYPH, formatVibecoin } from "@/lib/vibecoin";
import { buyCosmetic, equip, itemKey, type CosmeticKind } from "@/lib/wardrobe";
import {
  CATALOG,
  type CosmeticItem,
  type FlameItem,
  type JetpackItem,
} from "@/lib/cosmeticCatalog";


export default function VibeShop() {
  useWorldStamp("/shop", "The Vibe Shop");

  const { balance } = useVibecoin();



  return (
    <div className="relative min-h-[100dvh] w-full bg-background">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[60vh]"
        style={{
          background:
            "radial-gradient(65% 50% at 20% 0%, hsl(160 85% 50% / 0.14), transparent 66%)," +
            "radial-gradient(55% 45% at 82% 4%, hsl(266 85% 62% / 0.13), transparent 70%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-5xl px-4 pb-24 pt-20 sm:px-6 sm:pt-24">
        <motion.header
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.36em] text-muted-foreground sm:text-[10px]">
            Yours on every device
          </p>
          <h1 className="mt-1.5 font-heading text-3xl font-black tracking-tight sm:text-5xl">
            The <span className="text-gradient-mint">Vibe Shop</span>
          </h1>
          <p className="mt-2.5 max-w-xl text-[13px] leading-relaxed text-muted-foreground sm:text-sm">
            Everything here is bought with the same Vibey Coins you earn in the worlds
            and win in the arcade. What you buy is recorded against your wallet, not
            your browser — clear your history, open it on your phone, it is still
            yours.
          </p>
        </motion.header>

        {/* The bank */}
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-border/50 bg-black/25 px-4 py-3 backdrop-blur-sm">
          <VibeCoinMark size={34} />
          <div className="min-w-0">
            <div className="font-heading text-2xl font-black leading-none tabular-nums text-[#7dffd4]">
              {balance == null ? "—" : formatVibecoin(balance, { compact: false })}
            </div>
            <div className="mt-1 font-heading text-[8.5px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
              To spend
            </div>
          </div>
          <Link
            to="/arcade"
            className="ml-auto rounded-full border border-border/60 px-3.5 py-2 font-heading text-[9.5px] font-bold uppercase tracking-wider text-foreground/80 transition-colors hover:text-foreground"
          >
            🕹️ Win more
          </Link>
        </div>

        <ItemShelves />

        <footer className="mt-16 border-t border-border/40 pt-6 text-[11px] leading-relaxed text-muted-foreground">
          What you are wearing shows up in{" "}
          <Link to="/city" className="text-primary hover:underline">
            Vibe City
          </Link>
          . Prices are enforced server-side — the shelf label and the charge come
          from the same catalog. Signing in brings any coins you earned as a guest
          across with you, once.
        </footer>
      </div>

      {/* A quiet nudge for the case that otherwise reads as a broken shop. */}
      <AnimatePresence>
        {balance != null && balance < 25 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full border border-amber-400/40 bg-[#0b1016]/95 px-4 py-2.5 text-[11.5px] text-amber-200/90 backdrop-blur-xl"
          >
            Nothing here is in reach yet —{" "}
            <Link to="/arcade" className="font-semibold underline hover:text-amber-100">
              the arcade pays out
            </Link>
            .
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
