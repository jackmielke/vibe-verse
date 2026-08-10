/**
 * The shop window on the arcade floor.
 *
 * What was here before was a row of emoji and two lines of text — 🩷🐝🦇🪞😈🌌 —
 * next to the sentence "Six originals you can only get here". It described the
 * shop accurately and sold nothing, because a shop window's job is to show you
 * the thing, and an emoji is a label for a thing.
 *
 * So it is a window now: the actual characters, rendered from the actual rig,
 * lit and standing in lit alcoves. The most expensive one leads, because that
 * is the one the window is for.
 *
 * Two decisions worth keeping:
 *
 * 1. **Stills, not live 3D.** Six spinning previews would be six WebGL
 *    contexts on a page that already has a cabinet canvas, and browsers cap
 *    those at around sixteen — a shop window that breaks the next world
 *    somebody opens is a bad trade for a slow rotation. The portraits are
 *    renders of the same code, produced by `scripts/character-shots.mjs`.
 * 2. **It scrolls rather than wraps.** A grid would push the cabinets below
 *    the fold on a phone. A shelf that runs off the right edge says "there is
 *    more" in the way a wrapped grid never does.
 */
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

import VibeCoinMark from "@/components/VibeCoinMark";
import { characterArt } from "@/lib/characterArt";
import { SHOP_CHARACTERS, TIER_STYLE, byShelfOrder } from "@/lib/characterShop";

/** Dearest first — the window leads with what it is trying to sell. */
const WINDOW = [...SHOP_CHARACTERS].sort(byShelfOrder).reverse();

export default function ShopWindow() {
  return (
    <section className="mt-8">
      <div className="flex items-end justify-between gap-3 px-0.5">
        <div>
          <h2 className="font-heading text-sm font-black uppercase tracking-wider text-[#e2b7ff]">
            The shop
          </h2>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            Seven originals you can only get here, plus every hat and jetpack.
            Spend what you win, wear it in Vibe Island.
          </p>
        </div>
        <Link
          to="/arcade/characters"
          className="shrink-0 font-heading text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          Open →
        </Link>
      </div>

      {/* Bleed to the viewport edges on a phone so the last card is visibly
          cut off rather than sitting neatly inside a margin — a shelf that
          ends flush looks like the whole stock. */}
      <div className="-mx-4 mt-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex w-max gap-3">
          {WINDOW.map((c, i) => {
            const tier = TIER_STYLE[c.tier];
            const art = characterArt(c.id);
            return (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, duration: 0.35 }}
              >
                <Link
                  to="/arcade/characters"
                  aria-label={`${c.title} — ${c.price} Vibey Coins`}
                  className="group relative flex w-[9.5rem] flex-col overflow-hidden rounded-2xl border border-border/50 bg-black/45 backdrop-blur-sm transition-transform hover:-translate-y-0.5"
                  style={{ boxShadow: `inset 0 0 0 1px ${tier.color}22` }}
                >
                  {/* The alcove: a pool of the tier's colour with the
                      character standing in it. The gradient is what makes a
                      transparent PNG read as lit from below rather than as a
                      cut-out pasted on a dark rectangle. */}
                  <div
                    className="relative aspect-[4/5] w-full overflow-hidden"
                    style={{
                      background:
                        `radial-gradient(115% 78% at 50% 106%, ${tier.color}66, transparent 64%),` +
                        `linear-gradient(180deg, ${tier.color}1a, transparent 58%),` +
                        "#0a0f1a",
                    }}
                  >
                    {art ? (
                      <img
                        src={art}
                        alt=""
                        loading="lazy"
                        className="absolute inset-0 h-full w-full object-contain object-bottom p-1 transition-transform duration-300 group-hover:scale-[1.06]"
                        style={{ filter: `drop-shadow(0 10px 22px ${tier.color}55)` }}
                      />
                    ) : (
                      <div className="grid h-full place-items-center text-3xl" aria-hidden>
                        ✦
                      </div>
                    )}
                    <span
                      className="absolute left-2 top-2 rounded-full px-1.5 py-0.5 font-heading text-[7.5px] font-bold uppercase tracking-[0.16em]"
                      style={{ color: tier.color, background: `${tier.color}1f` }}
                    >
                      {tier.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 px-2.5 py-2">
                    <span className="min-w-0 flex-1 truncate font-heading text-[11px] font-bold text-foreground">
                      {c.title}
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 font-heading text-[11px] font-black tabular-nums text-[#7dffd4]">
                      <VibeCoinMark size={11} />
                      {c.price}
                    </span>
                  </div>
                </Link>
              </motion.div>
            );
          })}

          {/* The hats live on their own page and always have. Putting the door
              to them at the end of the character shelf is how somebody finds
              out it exists — the old card mentioned them in a sentence nobody
              read. */}
          <Link
            to="/shop"
            className="group flex w-[9.5rem] shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/50 p-4 text-center transition-colors hover:border-[#7dffd4]/50 hover:bg-white/[0.03]"
          >
            <span className="text-2xl leading-none" aria-hidden>
              🎩
            </span>
            <span className="font-heading text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors group-hover:text-foreground">
              Hats & jetpacks
            </span>
            <span className="text-[10px] leading-snug text-muted-foreground/60">
              Everything else you can wear
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}
