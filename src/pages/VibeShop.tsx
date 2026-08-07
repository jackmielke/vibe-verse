/**
 * /shop — the first place Vibecoin buys something you keep.
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
import { VIBECOIN_GLYPH, formatVibecoin } from "@/lib/vibecoin";
import { buyCosmetic, equip, itemKey, type CosmeticKind } from "@/lib/wardrobe";
import {
  CATALOG,
  type CosmeticItem,
  type FlameItem,
  type JetpackItem,
} from "@/lib/cosmeticCatalog";

const SHELVES: Array<{
  kind: CosmeticKind;
  label: string;
  blurb: string;
  accent: string;
}> = [
  {
    kind: "hat",
    label: "Hats",
    blurb: "Worn on your head, everywhere you go.",
    accent: "#7dffd4",
  },
  {
    kind: "flame",
    label: "Jetpack flames",
    blurb: "The colour you leave behind when you take off.",
    accent: "#ffb86b",
  },
  {
    kind: "jetpack",
    label: "Jetpacks",
    blurb: "The pack itself. The Return Pack takes it off your back.",
    accent: "#8fb4ff",
  },
];

/** Flames and jetpacks carry real colours; hats are drawn as geometry. */
function Swatch({ kind, item }: { kind: CosmeticKind; item: CosmeticItem }) {
  if (kind === "flame") {
    const f = item as FlameItem;
    return (
      <div
        className="h-12 w-12 shrink-0 rounded-full"
        style={{
          background: `radial-gradient(circle at 50% 65%, ${f.core}, ${f.color} 55%, transparent 72%)`,
          boxShadow: `0 0 22px ${f.color}66`,
        }}
        aria-hidden
      />
    );
  }
  if (kind === "jetpack") {
    const j = item as JetpackItem;
    return (
      <div
        className="grid h-12 w-12 shrink-0 place-items-center rounded-lg"
        style={{ background: j.body, boxShadow: `inset 0 0 0 2px ${j.trim}` }}
        aria-hidden
      >
        <span className="text-lg leading-none">{item.emoji}</span>
      </div>
    );
  }
  return (
    <div
      className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-white/[0.06]"
      aria-hidden
    >
      <span className="text-2xl leading-none">{item.emoji}</span>
    </div>
  );
}

export default function VibeShop() {
  useWorldStamp("/shop", "The Vibe Shop");

  const { balance } = useVibecoin();
  const { owned, loadout, refresh } = useWardrobe();
  const [busy, setBusy] = useState<string | null>(null);

  const ownedSet = useMemo(() => new Set(owned), [owned]);

  const isOwned = (kind: CosmeticKind, item: CosmeticItem) =>
    item.price <= 0 || ownedSet.has(itemKey(kind, item.id));

  const isWorn = (kind: CosmeticKind, id: string) => loadout[kind] === id;

  const onBuy = async (kind: CosmeticKind, item: CosmeticItem) => {
    setBusy(itemKey(kind, item.id));
    try {
      await buyCosmetic(kind, item.id);
      toast.success(`${item.name} is yours`, {
        description: `−${item.price} ${VIBECOIN_GLYPH} · put it on whenever you like`,
      });
      // Bought is not worn. Wearing it immediately is what you want 95% of the
      // time and the twelfth hat is the other 5%, so: wear it, and the shelf
      // shows what happened.
      await equip({ [kind]: item.id });
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

  const onEquip = async (kind: CosmeticKind, item: CosmeticItem) => {
    const ok = await equip({ [kind]: item.id });
    if (!ok) toast.error("Could not reach the ledger — that change did not stick.");
  };

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
            Everything here is bought with the same Vibecoin you earn in the worlds
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

        {SHELVES.map((shelf, si) => (
          <motion.section
            key={shelf.kind}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 * si, duration: 0.4 }}
            className="mt-10"
          >
            <div className="flex items-baseline gap-3">
              <h2
                className="font-heading text-base font-black uppercase tracking-wider"
                style={{ color: shelf.accent }}
              >
                {shelf.label}
              </h2>
              <p className="text-[11.5px] text-muted-foreground">{shelf.blurb}</p>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
              {CATALOG[shelf.kind].map((item) => {
                const key = itemKey(shelf.kind, item.id);
                const ownedIt = isOwned(shelf.kind, item);
                const worn = isWorn(shelf.kind, item.id);
                const affordable = balance == null || balance >= item.price;
                const working = busy === key;

                return (
                  <div
                    key={item.id}
                    className="flex flex-col gap-2.5 rounded-2xl border p-3 transition-colors"
                    style={{
                      borderColor: worn ? shelf.accent : "hsl(var(--border) / 0.5)",
                      background: worn ? `${shelf.accent}12` : "rgba(0,0,0,0.22)",
                    }}
                  >
                    <div className="flex items-center gap-2.5">
                      <Swatch kind={shelf.kind} item={item} />
                      <div className="min-w-0">
                        <div className="truncate font-heading text-[12.5px] font-bold leading-tight">
                          {item.name}
                        </div>
                        <div className="mt-0.5 font-heading text-[10px] font-bold uppercase tracking-wider tabular-nums">
                          {item.price <= 0 ? (
                            <span className="text-muted-foreground">Stock issue</span>
                          ) : ownedIt ? (
                            <span className="text-muted-foreground">Owned</span>
                          ) : (
                            <span className="text-[#7dffd4]">
                              {item.price} {VIBECOIN_GLYPH}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {worn ? (
                      <div
                        className="rounded-lg px-2 py-2 text-center font-heading text-[9.5px] font-black uppercase tracking-wider text-black"
                        style={{ background: shelf.accent }}
                      >
                        ✓ Wearing
                      </div>
                    ) : ownedIt ? (
                      <button
                        onClick={() => void onEquip(shelf.kind, item)}
                        className="rounded-lg border border-border/60 px-2 py-2 font-heading text-[9.5px] font-black uppercase tracking-wider text-foreground/85 transition-colors hover:border-foreground/40 hover:text-foreground"
                      >
                        Wear it
                      </button>
                    ) : (
                      <button
                        onClick={() => void onBuy(shelf.kind, item)}
                        disabled={working || !affordable}
                        className="rounded-lg px-2 py-2 font-heading text-[9.5px] font-black uppercase tracking-wider text-black transition-transform enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
                        style={{ background: shelf.accent }}
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
        ))}

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
