/**
 * The item shelves — hats, jetpack flames and jetpack shells.
 *
 * Lifted out of `/shop` so the arcade's Items tab and the shop page are the
 * same code rather than two grids that drift. They were one page and one tab
 * showing overlapping things, which is how you end up buying a hat in one
 * place and not seeing you own it in the other.
 *
 * Everything about money lives in `lib/wardrobe.ts` and the `vibe-economy`
 * edge function; this file draws a shelf and calls `buyCosmetic`.
 */
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { VIBECOIN_GLYPH, formatVibecoin } from "@/lib/vibecoin";
import { buyCosmetic, equip, itemKey, type CosmeticKind } from "@/lib/wardrobe";
import {
  CATALOG,
  type CosmeticItem,
  type FlameItem,
  type JetpackItem,
} from "@/lib/cosmeticCatalog";
import WeaponShelf from "@/components/shop/WeaponShelf";

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

export default function ItemShelves({
  weapons = "last",
}: {
  /** Where Vibe City's weapons shelf goes. Vibe Arms in town opens on it. */
  weapons?: "first" | "last";
} = {}) {
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
    <div>
        {weapons === "first" && <WeaponShelf inCity />}
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
        {weapons === "last" && <WeaponShelf />}
    </div>
  );
}
