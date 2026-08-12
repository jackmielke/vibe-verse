/**
 * The cast, on the front door — a rail you push sideways.
 *
 * `/game` answers "what can I play here?" and answered nothing at all about
 * *who you play as*, which is half of what the vibeverse has been building.
 * Sixty-odd characters existed and the only way to meet one was to already know
 * about `/shop` or `/arcade/characters`.
 *
 * ## Why a rail and not the shelf
 *
 * The obvious move was to drop `CharacterShelf` here, and it is the wrong one:
 * that is a four-column grid of everything for sale, with prices and buy
 * buttons, and putting it on the landing page turns the front door into a
 * checkout. A rail shows the same tiles — literally the same `CharacterCard` —
 * in the shape a landing page wants: one row, a dozen faces, push it sideways,
 * and a link through to the place that sells them.
 *
 * ## What is on it
 *
 * Newest first, which is the honest reading of the roster array: characters are
 * appended, so the tail is the recent work and the head is Vibey and the
 * original cast. It is a proxy — there is no built date on a `CharSpec` — but
 * it is the same proxy the character portal reads, and a wrong guess here costs
 * an ordering, not a correctness.
 *
 * Only characters with a portrait are eligible. A rail is a row of pictures; a
 * card that falls back to an emoji is fine in a grid of forty and conspicuous
 * as one of twelve. Every rig-built character has one — `characterArt` is the
 * list — so in practice this excludes the GLB roster, which has a model to
 * render and does not need a photograph.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";

import CharacterCard from "@/components/shop/CharacterCard";
import { useCharacterActions } from "@/components/shop/useCharacterActions";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { characterArt } from "@/lib/characterArt";
import { CHARACTERS } from "@/lib/characters";
import { shopCharacter } from "@/lib/characterShop";
import { itemKey } from "@/lib/wardrobe";

/** How many faces the rail carries before "see them all" is the better answer. */
const RAIL_LENGTH = 14;

export default function FeaturedCharacters() {
  const { balance } = useVibecoin();
  const { owned, loadout } = useWardrobe();
  const { busy, buy, wear } = useCharacterActions();

  const cast = useMemo(
    () =>
      [...CHARACTERS]
        .reverse()
        .filter((c) => characterArt(c.id))
        .slice(0, RAIL_LENGTH),
    [],
  );

  if (!cast.length) return null;

  return (
    <section className="mt-14">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-0.5">
        <h2 className="font-heading text-base font-black uppercase tracking-wider text-[#e2b7ff]">
          Characters
        </h2>
        <p className="text-[11.5px] text-muted-foreground">
          Built from code, not bought in. Pick one and you are them everywhere.
        </p>
        <Link
          to="/arcade/characters"
          className="ml-auto shrink-0 font-heading text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          See them move →
        </Link>
      </div>

      {/* Bleeds to the viewport edges so the last tile is visibly cut off — a
          rail that ends flush with the text column looks like a short grid and
          nobody pushes it. The padding puts the first tile back in line.

          `snap-x` rather than a pair of arrow buttons: this is a touch surface
          first, and a scroller that snaps is the thing a phone already knows
          how to do. */}
      <div className="-mx-3 mt-3 overflow-x-auto pb-2 sm:-mx-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex snap-x snap-mandatory gap-2.5 px-3 sm:gap-3 sm:px-6">
          {cast.map((c) => {
            const stock = shopCharacter(c.id);
            return (
              <div key={c.id} className="w-[132px] shrink-0 snap-start sm:w-[150px]">
                <CharacterCard
                  id={c.id}
                  title={stock?.title ?? c.label}
                  pitch={stock?.pitch ?? c.blurb}
                  price={stock?.price}
                  tier={stock?.tier}
                  owned={owned.includes(itemKey("character", c.id))}
                  worn={loadout.character === c.id}
                  affordable={balance == null || stock == null || balance >= stock.price}
                  busy={busy === c.id}
                  onBuy={() => void buy(c.id)}
                  onWear={() => void wear(c.id)}
                  className="h-full"
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
