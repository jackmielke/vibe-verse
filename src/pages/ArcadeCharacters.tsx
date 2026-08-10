/**
 * /arcade/characters — the character shop.
 *
 * The arcade already had the loop that matters (pay, play, get paid) and one
 * thing to spend on that you keep: hats. A hat is a good sink and a bad
 * *reason*. Nobody has ever opened a game to look at their hat. What people
 * open a game to look at is who they are in it, which is why the character
 * screen in Fortnite is the second most-visited surface in the product and the
 * hat menu is not.
 *
 * So this is that screen. One character at a time, filling the frame, walking
 * — not a grid of thumbnails, because the whole argument for a 600-coin
 * character is the way it moves and a still frame makes that argument badly.
 * Flip left and right through the stock, see what it costs, buy it, wear it,
 * and take it into Vibe Island, which is the only place that sentence ends.
 *
 * Three things it is careful about:
 *
 * 1. **One WebGL context.** Six characters, one canvas, swapped in place.
 *    Browsers cap live contexts and a shop that burns six of them breaks the
 *    next world the visitor opens.
 * 2. **Ownership is the server's answer, not this page's.** `useWardrobe`
 *    holds it; the buy button asks the edge function and believes what comes
 *    back. A cached "owned" that turns out to be wrong shows up here as a
 *    failed equip rather than as a free character.
 * 3. **It says what the free option is.** Sixty-odd characters are free in the
 *    Character Portal and this page links to them. A shop that pretends it is
 *    the only door is how you end up with people who think the roster costs
 *    money.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, Lock } from "lucide-react";
import ItemShelves from "@/components/shop/ItemShelves";
import WearStrip from "@/components/shop/WearStrip";
import VibeCoinMark from "@/components/VibeCoinMark";
import { CharacterPreview } from "@/island/CharacterPreview";
import { DEFAULT_POSE, POSES, type PoseId } from "@/island/previewPose";
import type { CharacterOption } from "@/island/characters";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { useActiveCharacter } from "@/hooks/use-active-character";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { VIBECOIN_GLYPH, formatVibecoin } from "@/lib/vibecoin";
import { buyCosmetic, itemKey } from "@/lib/wardrobe";
import { findCharacter, type CharSpec } from "@/lib/characters";
import {
  SHOP_CHARACTERS,
  TIER_STYLE,
  byShelfOrder,
  type ShopCharacter,
} from "@/lib/characterShop";

/**
 * `CharSpec` is the roster's shape and `CharacterOption` is the preview's, and
 * they are not the same because the preview also needs camera tuning. Every
 * character on this shelf is code-built (no url), so `CharacterPreview`
 * auto-frames from the built group's real bounds and these numbers are only
 * the value it uses for the frame or two before the model exists.
 */
const toOption = (c: CharSpec): CharacterOption => ({
  id: c.id,
  name: c.label,
  description: c.blurb,
  url: c.url,
  scale: 1,
  yOffset: 0,
  previewDistance: 2.7,
  previewHeight: 1.55,
  previewTarget: 1.25,
  accent: "",
});

interface Entry {
  shop: ShopCharacter;
  spec: CharSpec;
  option: CharacterOption;
}

export default function ArcadeCharacters() {
  /* Stamps the arcade, not itself. This is a room inside one world rather
     than a world of its own — it is not in the registry, has no card, and
     shows up in no picker. Someone who walked in here was in the arcade, and
     a second passport entry for the back room would be a lie about where
     they had been. */
  useWorldStamp("/arcade", "Vibe Arcade");

  const { balance, refresh: refreshCoin } = useVibecoin();
  const { owned, loadout, refresh: refreshWardrobe } = useWardrobe();
  const { charId, setCharId } = useActiveCharacter();

  /* Two tabs, because "the shop" was two different shops on two pages: six
     characters here and the hats over on /shop, with nothing telling you the
     other existed. Characters lead — they are the thing worth looking at. */
  const [tab, setTab] = useState<"characters" | "items">("characters");
  const [index, setIndex] = useState(0);
  const [buying, setBuying] = useState<string | null>(null);
  const [pose, setPose] = useState<PoseId>(DEFAULT_POSE);
  /* The hat on the stage. Mirrors the loadout but is set locally on tap, so
     the character puts it on immediately rather than after the server agrees.
     Seeded once the wardrobe has actually loaded — seeding from the default
     would overwrite a real hat with "none" a beat after the page opened. */
  const [wornHat, setWornHat] = useState<string>("none");
  const [hatSeeded, setHatSeeded] = useState(false);
  const [params, setParams] = useSearchParams();
  /* Which way the last flip went, so the card slides in from the side you
     came from rather than always from the right. */
  const [dir, setDir] = useState(1);

  const entries = useMemo<Entry[]>(
    () =>
      [...SHOP_CHARACTERS].sort(byShelfOrder).map((shop) => {
        const spec = findCharacter(shop.id);
        return { shop, spec, option: toOption(spec) };
      }),
    [],
  );

  /* `?c=<id>` — which character to open on.
     The arcade's shop window links here with the card you tapped, and without
     this the page always opened on the cheapest one: you tapped Space Rex and
     landed on Pixel. It is a URL parameter rather than component state
     because it also has to survive being shared, bookmarked and reloaded. */
  useEffect(() => {
    const want = params.get("c");
    if (!want) return;
    const i = entries.findIndex((e) => e.shop.id === want);
    if (i >= 0) setIndex(i);
    setTab("characters");
  }, [params, entries]);

  /* …and land at the top of it. A link into a long page inherits whatever
     scroll position the browser felt like restoring, which is why tapping a
     character from the arcade dropped you halfway down the shop. */
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  useEffect(() => {
    if (hatSeeded || !loadout.hat) return;
    setWornHat(loadout.hat);
    setHatSeeded(true);
  }, [loadout.hat, hatSeeded]);

  const current = entries[index] ?? entries[0];
  const tier = TIER_STYLE[current.shop.tier];
  const isOwned = owned.includes(itemKey("character", current.shop.id));
  const isWorn = charId === current.shop.id;
  const canAfford = balance != null && balance >= current.shop.price;

  const show = useCallback(
    (i: number, direction: number) => {
      setDir(direction);
      setIndex(i);
      /* `replace` so flipping through eight characters does not leave eight
         entries in the back stack between here and the arcade. */
      setParams({ c: entries[i].shop.id }, { replace: true });
    },
    [entries, setParams],
  );

  const flip = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = (i + delta + entries.length) % entries.length;
        setDir(delta);
        setParams({ c: entries[next].shop.id }, { replace: true });
        return next;
      });
    },
    [entries, setParams],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") flip(-1);
      else if (e.key === "ArrowRight") flip(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flip]);

  const buy = useCallback(async () => {
    const { id, price, title } = current.shop;
    setBuying(id);
    try {
      await buyCosmetic("character", id);
      /* Wear it immediately. Someone who just spent 600 on a body wants to be
         in it, and the alternative is a second button they have to find. */
      setCharId(id);
      toast.success(`${title} is yours`, {
        description: `−${price} ${VIBECOIN_GLYPH}. You are wearing it now — take it into Vibe Island.`,
      });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      toast.error("That did not go through", {
        description: /not enough/i.test(msg)
          ? `${title} costs ${price} ${VIBECOIN_GLYPH}. Win some in the arcade and come back.`
          : msg,
      });
    } finally {
      setBuying(null);
      // Both, either way: a failed buy still wants the true balance back on
      // screen, and a successful one has to be reflected before the next tap.
      void refreshWardrobe();
      void refreshCoin();
    }
  }, [current.shop, setCharId, refreshWardrobe, refreshCoin]);

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#05070d] text-foreground">
      {/* Same room as the arcade floor — two washes and a scanline veil. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            `radial-gradient(65% 50% at 50% 0%, ${tier.color}22, transparent 70%),` +
            "radial-gradient(55% 45% at 84% 10%, hsl(280 90% 62% / 0.14), transparent 68%)",
          transition: "background 400ms ease",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.055]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, #fff 0px, #fff 1px, transparent 1px, transparent 3px)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-4xl px-4 pb-20 pt-20 sm:px-6 sm:pt-24">
        <div className="flex items-center justify-between gap-3">
          <Link
            to="/arcade"
            className="inline-flex items-center gap-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Arcade floor
          </Link>
          <div className="flex items-center gap-2">
            <VibeCoinMark size={20} />
            <span className="font-heading text-sm font-black tabular-nums text-[#7dffd4]">
              {balance == null ? "—" : formatVibecoin(balance, { compact: false })}
            </span>
          </div>
        </div>

        <header className="mt-5 text-center">
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.34em] text-[#7dffd4]/70 sm:text-[10px]">
            {tab === "characters"
              ? `${SHOP_CHARACTERS.length} originals · built here, sold here`
              : "Hats, flames and jetpacks · yours on every device"}
          </p>
          <h1
            className="mt-2 font-heading text-3xl font-black tracking-tight sm:text-5xl"
            style={{
              color: "#fff",
              textShadow:
                "0 0 12px hsl(160 90% 60% / 0.85), 0 0 38px hsl(280 90% 62% / 0.45)",
            }}
          >
            THE SHOP
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
            {tab === "characters"
              ? "Buy one with the Vibey Coins you won downstairs, and wear it everywhere — Vibe Island, the hub, the lobby. Nothing here was taken off the free shelf to make room; every one of them was drawn for it."
              : "Everything else you can put on. Bought against your wallet rather than your browser, so it survives a cleared history and a new phone."}
          </p>
        </header>

        {/* ---- The tabs ---- */}
        <div className="mx-auto mt-6 flex max-w-xs gap-1 rounded-full border border-border/50 bg-black/40 p-1">
          {(["characters", "items"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`flex-1 rounded-full px-3 py-2 font-heading text-[10px] font-black uppercase tracking-[0.14em] transition-colors ${
                tab === t
                  ? "bg-white text-black"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "characters" ? "🧑‍🚀 Characters" : "🎩 Items"}
            </button>
          ))}
        </div>

        {tab === "items" ? (
          <div className="mt-4">
            <ItemShelves />
          </div>
        ) : (
        <>
        {/* ---- The stage, and everything you can do to it ----
            Two columns from `lg` up, with the stage sticky in the left one.
            One column meant the wearables were four hundred pixels below the
            character they go on, so picking a hat scrolled the character off
            the screen — which is precisely the thing this page exists to let
            you see. Stacked on a phone, where there is no second column to
            put anything in and the scroll is short. */}
        <div className="mt-7 lg:grid lg:grid-cols-2 lg:items-start lg:gap-8">
        <div className="relative lg:sticky lg:top-20">
          <div
            className="relative overflow-hidden rounded-3xl border bg-black/50 backdrop-blur-sm"
            style={{
              borderColor: `${tier.color}44`,
              boxShadow: `0 0 70px ${tier.color}1f, inset 0 0 0 1px ${tier.color}18`,
              transition: "border-color 400ms ease, box-shadow 400ms ease",
            }}
          >
            {/* Floor glow under the feet, so the character is standing on
                something rather than floating in a black box. */}
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-40"
              style={{
                background: `radial-gradient(60% 100% at 50% 100%, ${tier.color}33, transparent 72%)`,
                transition: "background 400ms ease",
              }}
              aria-hidden
            />

            <div className="relative h-[340px] sm:h-[420px]">
              {/* One canvas for the whole shelf. The key is on the wrapper,
                  not the Canvas — remounting the Canvas would take a WebGL
                  context down and bring a new one up on every single flip. */}
              <CharacterPreview
                character={current.option}
                spinning={false}
                pose={pose}
                hat={wornHat}
              />
            </div>

            {/* Flip controls, over the stage. Big hit targets: this is the
                primary interaction on the page and it is used on a phone. */}
            <button
              onClick={() => flip(-1)}
              aria-label="Previous character"
              className="absolute left-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-border/60 bg-black/60 text-foreground/80 backdrop-blur transition-colors hover:bg-black/80 hover:text-foreground sm:left-4"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <button
              onClick={() => flip(1)}
              aria-label="Next character"
              className="absolute right-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-border/60 bg-black/60 text-foreground/80 backdrop-blur transition-colors hover:bg-black/80 hover:text-foreground sm:right-4"
            >
              <ArrowRight className="h-5 w-5" />
            </button>

            {/* Tier badge */}
            <div
              className="absolute left-4 top-4 rounded-full px-2.5 py-1 font-heading text-[8.5px] font-black uppercase tracking-[0.2em]"
              style={{
                color: tier.color,
                background: `${tier.color}1a`,
                border: `1px solid ${tier.color}55`,
              }}
            >
              {tier.label}
            </div>

            {isOwned && (
              <div className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-full border border-[#7dffd4]/50 bg-[#7dffd4]/10 px-2.5 py-1 font-heading text-[8.5px] font-black uppercase tracking-[0.2em] text-[#7dffd4]">
                <Check className="h-3 w-3" /> {isWorn ? "Wearing" : "Owned"}
              </div>
            )}
          </div>

          {/* ---- Emotes ----
              The stage used to jog on the spot at 3.8 m/s, permanently. It
              showed off the gait solver and it was the wrong thing to look at
              while deciding whether to spend 600 coins on a face. Now it
              stands still and turns, and the run is one of six things you can
              ask for. See `src/island/previewPose.ts` — every pose is written
              in the rig's own five numbers, not as new animation code. */}
          <div className="-mx-4 mt-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:overflow-visible sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex w-max gap-1.5 sm:w-auto sm:flex-wrap sm:justify-center">
              {POSES.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPose(p.id)}
                  aria-pressed={pose === p.id}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 font-heading text-[9.5px] font-bold uppercase tracking-wider transition-colors ${
                    pose === p.id
                      ? "border-white/50 bg-white/10 text-foreground"
                      : "border-border/50 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span aria-hidden>{p.emoji}</span>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

        </div>

        <div className="relative">
          {/* ---- The label ---- */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={current.shop.id}
              initial={{ opacity: 0, x: dir * 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: dir * -24 }}
              transition={{ duration: 0.22 }}
              className="mt-5 text-center"
            >
              <h2
                className="font-heading text-2xl font-black uppercase tracking-wide sm:text-3xl"
                style={{ color: tier.color, textShadow: `0 0 22px ${tier.color}55` }}
              >
                {current.spec.emoji} {current.shop.title}
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-[12.5px] leading-relaxed text-foreground/70">
                {current.shop.pitch}
              </p>
              <p className="mt-1.5 text-[11px] text-muted-foreground/70">{tier.blurb}</p>
            </motion.div>
          </AnimatePresence>

          {/* ---- The till ---- */}
          <div className="mx-auto mt-5 flex max-w-sm flex-col gap-2">
            {isOwned ? (
              isWorn ? (
                <Link
                  to="/city?spawn=hub"
                  className="w-full rounded-xl bg-primary px-4 py-3 text-center font-heading text-[11px] font-black uppercase tracking-[0.14em] text-primary-foreground transition-transform hover:scale-[1.02]"
                >
                  Take {current.shop.title} into Vibe Island →
                </Link>
              ) : (
                <button
                  onClick={() => setCharId(current.shop.id)}
                  className="w-full rounded-xl px-4 py-3 font-heading text-[11px] font-black uppercase tracking-[0.14em] text-black transition-transform hover:scale-[1.02]"
                  style={{ background: tier.color, boxShadow: `0 0 26px ${tier.color}55` }}
                >
                  Wear {current.shop.title}
                </button>
              )
            ) : (
              <button
                onClick={() => void buy()}
                disabled={buying != null || !canAfford}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 font-heading text-[11px] font-black uppercase tracking-[0.14em] text-black transition-transform enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: tier.color, boxShadow: `0 0 26px ${tier.color}55` }}
              >
                {buying === current.shop.id ? (
                  "Ringing it up…"
                ) : canAfford ? (
                  <>Buy for {current.shop.price} {VIBECOIN_GLYPH}</>
                ) : (
                  <>
                    <Lock className="h-3.5 w-3.5" /> Need {current.shop.price} {VIBECOIN_GLYPH}
                  </>
                )}
              </button>
            )}

            {!isOwned && !canAfford && (
              <p className="text-center text-[11px] leading-snug text-amber-300/80">
                You are{" "}
                {balance == null ? "short" : `${current.shop.price - balance} ${VIBECOIN_GLYPH} short`}
                . The{" "}
                <Link to="/arcade" className="underline hover:text-amber-200">
                  cabinets downstairs
                </Link>{" "}
                pay out, and so do the sky islands over Vibe Island.
              </p>
            )}
          </div>

          {/* ---- What to put on it ----
              On this page rather than behind the Items tab, because choosing a
              hat by reading its name is not choosing a hat. Tapping one puts
              it on the character beside it. */}
          <WearStrip wornHat={wornHat} onHatChange={setWornHat} />
        </div>
        </div>

        {/* ---- The shelf ---- */}
        <div className="mt-8 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {entries.map((e, i) => {
            const t = TIER_STYLE[e.shop.tier];
            const have = owned.includes(itemKey("character", e.shop.id));
            const active = i === index;
            return (
              <button
                key={e.shop.id}
                onClick={() => show(i, i > index ? 1 : -1)}
                className={`relative flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 transition-all ${
                  active ? "scale-[1.04] bg-white/[0.06]" : "bg-black/30 hover:bg-white/[0.03]"
                }`}
                style={{ borderColor: active ? t.color : `${t.color}33` }}
              >
                <span className="text-lg leading-none" aria-hidden>
                  {e.spec.emoji}
                </span>
                <span
                  className="truncate text-center font-heading text-[8.5px] font-bold uppercase tracking-wider"
                  style={{ color: active ? t.color : undefined }}
                >
                  {e.shop.title}
                </span>
                <span className="font-heading text-[9px] font-black tabular-nums text-muted-foreground">
                  {have ? (
                    <Check className="h-3 w-3 text-[#7dffd4]" />
                  ) : (
                    `${e.shop.price}`
                  )}
                </span>
              </button>
            );
          })}
        </div>
        </>
        )}

        <footer className="mt-12 border-t border-border/40 pt-6 text-[11px] leading-relaxed text-muted-foreground">
          Sixty-odd more characters are free and always will be — pick one in the{" "}
          <Link to="/characters" className="text-primary hover:underline">
            Character Portal
          </Link>
          . These six are the ones the arcade built, and buying one is a row in
          the same ledger as every coin you have ever won: tap the coin in the
          corner to read it.
        </footer>
      </div>
    </div>
  );
}
