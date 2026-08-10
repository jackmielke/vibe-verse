/**
 * `/shop/cosmos` — the same shop, in a different room.
 *
 * `/shop` is a well-lit catalogue: shelves, a running balance, a clear grid.
 * It works, and it looks like software. This is the other treatment — a dark
 * sky, one big title, and the goods standing in lit alcoves — because a shop
 * that sells *characters* should feel more like a poster than a spreadsheet.
 *
 * It is a skin, not a fork. Every price, every item and every purchase goes
 * through the same `characterShop.ts`, the same `CATALOG` and the same
 * `buyCosmetic`, so there is exactly one answer to "what does Grimlock cost"
 * and both rooms are views of it. The registry's whole argument, applied to a
 * storefront: the moment two shops can disagree, one of them is lying.
 *
 * The tabs mirror the way people actually think about this — who I am, versus
 * what I am wearing — rather than the way the data is stored, which is one
 * table of characters and three of cosmetics.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { Check, Sparkles } from "lucide-react";

import VibeCoinMark from "@/components/VibeCoinMark";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { useActiveCharacter } from "@/hooks/use-active-character";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { VIBECOIN_GLYPH, VIBECOIN_NAME, formatVibecoin } from "@/lib/vibecoin";
import { buyCosmetic, equip, itemKey, type CosmeticKind } from "@/lib/wardrobe";
import { CATALOG, type CosmeticItem } from "@/lib/cosmeticCatalog";
import { characterArt } from "@/lib/characterArt";
import { SHOP_CHARACTERS, TIER_STYLE, byShelfOrder } from "@/lib/characterShop";

type Tab = "avatars" | "wearables";

/** The one card shape, used for a 450-coin dinosaur and a 25-coin hat alike. */
interface Card {
  key: string;
  kind: "character" | CosmeticKind;
  id: string;
  title: string;
  price: number;
  /** Rarity chip. Cosmetics get one derived from price — see `bandOf`. */
  band: { label: string; color: string };
  art?: string;
  emoji?: string;
  sub?: string;
}

/**
 * Rarity for things that were never given any.
 *
 * The characters carry an explicit tier because somebody decided what each one
 * is worth. The hats never did — they are a flat price list — and a grid where
 * two thirds of the cards have a chip and one third has a hole looks broken.
 * Banding by price is honest (it is the same information, binned) and it makes
 * the shelf scannable, which is the whole reason the chip is there.
 */
function bandOf(price: number): { label: string; color: string } {
  if (price >= 400) return { label: "Legendary", color: "#ffd166" };
  if (price >= 200) return { label: "Epic", color: "#c084fc" };
  if (price >= 60) return { label: "Rare", color: "#5db8e8" };
  return { label: "Common", color: "#8fa3bd" };
}

export default function ShopCosmos() {
  /* Same stamp as `/shop`. Two rooms in one shop is not two places you have
     been, and a passport that counts a re-skin as a second destination is
     padding its own numbers. */
  useWorldStamp("/shop", "The Vibe Shop");

  const { balance, refresh: refreshCoin } = useVibecoin();
  const { owned, refresh: refreshWardrobe } = useWardrobe();
  const { charId, setCharId } = useActiveCharacter();

  const [tab, setTab] = useState<Tab>("avatars");
  const [busy, setBusy] = useState<string | null>(null);

  const avatars = useMemo<Card[]>(
    () =>
      [...SHOP_CHARACTERS].sort(byShelfOrder).map((c) => ({
        key: itemKey("character", c.id),
        kind: "character" as const,
        id: c.id,
        title: c.title,
        price: c.price,
        band: { label: TIER_STYLE[c.tier].label, color: TIER_STYLE[c.tier].color },
        art: characterArt(c.id),
        sub: c.pitch,
      })),
    [],
  );

  const wearables = useMemo<Card[]>(() => {
    const out: Card[] = [];
    for (const kind of ["hat", "jetpack", "flame"] as CosmeticKind[]) {
      for (const item of CATALOG[kind] as CosmeticItem[]) {
        // Price zero is stock issue — always yours, never bought. A "free"
        // card in a shop is a card that does nothing.
        if (item.price <= 0) continue;
        out.push({
          key: itemKey(kind, item.id),
          kind,
          id: item.id,
          title: item.name,
          price: item.price,
          band: bandOf(item.price),
          emoji: item.emoji,
          sub: kind === "hat" ? "Headwear" : kind === "jetpack" ? "Jetpack" : "Thruster flame",
        });
      }
    }
    return out.sort((a, b) => a.price - b.price);
  }, []);

  const cards = tab === "avatars" ? avatars : wearables;

  const act = useCallback(
    async (card: Card) => {
      const isOwned = owned.includes(card.key);
      setBusy(card.key);
      try {
        if (!isOwned) await buyCosmetic(card.kind as CosmeticKind, card.id);
        // Wear it either way. Somebody who just spent 450 on a body wants to
        // be in it, and somebody tapping an owned card meant "put this on" —
        // there is no third thing either tap could have meant.
        if (card.kind === "character") setCharId(card.id);
        else await equip({ [card.kind]: card.id });
        toast.success(isOwned ? `${card.title} on` : `${card.title} is yours`, {
          description: isOwned
            ? "Take it into Vibe Island."
            : `−${card.price} ${VIBECOIN_GLYPH}. You are wearing it now.`,
        });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        toast.error("That did not go through", {
          description: /not enough/i.test(msg)
            ? `${card.title} costs ${card.price} ${VIBECOIN_GLYPH}. Win some in the arcade and come back.`
            : msg,
        });
      } finally {
        setBusy(null);
        void refreshWardrobe();
        void refreshCoin();
      }
    },
    [owned, setCharId, refreshWardrobe, refreshCoin],
  );

  /** The headliner: the dearest thing nobody owns yet. */
  const featured = useMemo(
    () => [...avatars].reverse().find((c) => !owned.includes(c.key)) ?? avatars[avatars.length - 1],
    [avatars, owned],
  );

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#04060d] text-foreground">
      {/* The sky. Three washes and a field of stars, all painted rather than
          loaded — a starfield JPEG is 400 kB of something two gradients and a
          repeating radial do better, and it scales to any viewport. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(90% 55% at 50% -10%, hsl(262 80% 40% / 0.38), transparent 62%)," +
            "radial-gradient(70% 45% at 12% 18%, hsl(190 85% 45% / 0.16), transparent 66%)," +
            "radial-gradient(60% 40% at 88% 28%, hsl(320 80% 55% / 0.14), transparent 68%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.55]"
        style={{
          backgroundImage:
            "radial-gradient(1.1px 1.1px at 12% 18%, #fff, transparent)," +
            "radial-gradient(1px 1px at 74% 8%, #cfe3ff, transparent)," +
            "radial-gradient(1.4px 1.4px at 38% 42%, #fff, transparent)," +
            "radial-gradient(1px 1px at 88% 62%, #e9d5ff, transparent)," +
            "radial-gradient(1.2px 1.2px at 22% 74%, #fff, transparent)," +
            "radial-gradient(1px 1px at 62% 88%, #bfdbfe, transparent)",
          backgroundSize: "520px 420px",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-5xl px-4 pb-28 pt-20 sm:px-6 sm:pt-24">
        <motion.header
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="text-center"
        >
          <h1 className="font-heading text-4xl font-black uppercase tracking-[0.02em] sm:text-6xl">
            The Vibe Shop
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-muted-foreground">
            Everything here is bought with {VIBECOIN_NAME} you earned. What you
            buy is yours on every device you ever open this on.
          </p>
          <Link
            to="/manifesto"
            className="mt-3 inline-flex items-center gap-1.5 font-heading text-[9.5px] font-bold uppercase tracking-[0.2em] text-[#c9a8ff] transition-colors hover:text-white"
          >
            <Sparkles className="h-3 w-3" />
            The arcade of the future
          </Link>
        </motion.header>

        {/* The headliner. A shop with everything at the same size has no
            opinion about anything in it. */}
        {featured && (
          <motion.button
            onClick={() => void act(featured)}
            disabled={busy != null}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08, duration: 0.45 }}
            className="group mt-8 flex w-full items-center gap-4 overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] p-4 text-left backdrop-blur-md transition-colors hover:bg-white/[0.07] disabled:opacity-60 sm:gap-6 sm:p-5"
            style={{ boxShadow: `inset 0 0 0 1px ${featured.band.color}22, 0 0 60px ${featured.band.color}14` }}
          >
            <div
              className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl sm:h-32 sm:w-32"
              style={{
                background: `radial-gradient(120% 85% at 50% 110%, ${featured.band.color}55, transparent 62%), #080d18`,
              }}
            >
              {featured.art && (
                <img
                  src={featured.art}
                  alt=""
                  className="absolute inset-0 h-full w-full object-contain object-bottom p-1.5 transition-transform duration-500 group-hover:scale-105"
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <span
                className="font-heading text-[9px] font-bold uppercase tracking-[0.22em]"
                style={{ color: featured.band.color }}
              >
                New this drop
              </span>
              <div className="mt-1 font-heading text-xl font-black leading-tight sm:text-3xl">
                {featured.title}
              </div>
              <p className="mt-1.5 line-clamp-2 max-w-md text-[11.5px] leading-snug text-muted-foreground sm:text-[13px]">
                {featured.sub}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <div className="flex items-center justify-end gap-1 font-heading text-lg font-black tabular-nums text-[#7dffd4] sm:text-2xl">
                <VibeCoinMark size={16} />
                {featured.price}
              </div>
              <span className="mt-2 inline-block rounded-full border border-white/25 px-3.5 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-[0.16em] text-white/90 transition-colors group-hover:border-white/60 group-hover:bg-white/10">
                {busy === featured.key ? "…" : "Buy"}
              </span>
            </div>
          </motion.button>
        )}

        {/* Tabs */}
        <div className="mt-8 flex justify-center gap-2">
          {(
            [
              ["avatars", "Avatars"],
              ["wearables", "Wearables"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-full border px-5 py-2 font-heading text-[11px] font-bold uppercase tracking-wider transition-colors ${
                tab === k
                  ? "border-white/40 bg-white/10 text-white"
                  : "border-white/10 text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
          <AnimatePresence mode="popLayout">
            {cards.map((card, i) => {
              const isOwned = owned.includes(card.key);
              const isWorn = card.kind === "character" && charId === card.id;
              const afford = balance == null || balance >= card.price;
              return (
                <motion.button
                  key={card.key}
                  layout
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ delay: Math.min(i, 8) * 0.035, duration: 0.3 }}
                  onClick={() => void act(card)}
                  disabled={busy != null || (!isOwned && !afford)}
                  className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] text-left backdrop-blur-sm transition-transform hover:-translate-y-1 disabled:cursor-not-allowed"
                  style={{ boxShadow: `inset 0 0 0 1px ${card.band.color}1f` }}
                >
                  <div
                    className="relative aspect-square w-full overflow-hidden"
                    style={{
                      background: `radial-gradient(115% 80% at 50% 108%, ${card.band.color}5c, transparent 66%), #070c16`,
                    }}
                  >
                    <span
                      className="absolute left-2 top-2 z-10 rounded-full px-1.5 py-0.5 font-heading text-[7.5px] font-bold uppercase tracking-[0.16em]"
                      style={{ color: card.band.color, background: `${card.band.color}22` }}
                    >
                      {card.band.label}
                    </span>
                    {isOwned && (
                      <span className="absolute right-2 top-2 z-10 grid h-5 w-5 place-items-center rounded-full bg-[#7dffd4] text-black">
                        <Check className="h-3 w-3" strokeWidth={3.5} />
                      </span>
                    )}
                    {card.art ? (
                      <img
                        src={card.art}
                        alt=""
                        loading="lazy"
                        className="absolute inset-0 h-full w-full object-contain object-bottom p-1.5 transition-transform duration-300 group-hover:scale-105"
                        style={{ filter: `drop-shadow(0 12px 26px ${card.band.color}4d)` }}
                      />
                    ) : (
                      <span
                        className="absolute inset-0 grid place-items-center text-5xl transition-transform duration-300 group-hover:scale-110"
                        aria-hidden
                      >
                        {card.emoji ?? "✦"}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-1 flex-col gap-1.5 p-2.5">
                    <div className="truncate font-heading text-[12px] font-bold leading-tight">
                      {card.title}
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-2">
                      <span className="flex items-center gap-0.5 font-heading text-[12px] font-black tabular-nums text-[#7dffd4]">
                        <VibeCoinMark size={11} />
                        {formatVibecoin(card.price)}
                      </span>
                      <span
                        className={`rounded-full border px-2.5 py-1 font-heading text-[8.5px] font-bold uppercase tracking-[0.14em] transition-colors ${
                          isWorn
                            ? "border-[#7dffd4]/50 text-[#7dffd4]"
                            : isOwned
                              ? "border-white/25 text-white/80 group-hover:bg-white/10"
                              : afford
                                ? "border-white/25 text-white/90 group-hover:border-white/60 group-hover:bg-white/10"
                                : "border-white/10 text-white/35"
                        }`}
                      >
                        {busy === card.key
                          ? "…"
                          : isWorn
                            ? "Worn"
                            : isOwned
                              ? "Wear"
                              : afford
                                ? "Buy"
                                : "Short"}
                      </span>
                    </div>
                  </div>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>

        <footer className="mt-14 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-white/10 pt-6 text-[11px] text-muted-foreground">
          <span>
            {balance == null ? "—" : formatVibecoin(balance, { compact: false })}{" "}
            {VIBECOIN_GLYPH} to spend
          </span>
          <Link to="/arcade" className="text-primary hover:underline">
            Win more in the arcade
          </Link>
          <Link to="/shop" className="hover:text-foreground hover:underline">
            The other shop layout
          </Link>
          <Link to="/characters" className="hover:text-foreground hover:underline">
            Sixty free characters
          </Link>
        </footer>
      </div>
    </div>
  );
}
