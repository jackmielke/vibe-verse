/**
 * The locker — choose who drops.
 *
 * A full-bleed character select in the shape every battle royale player
 * already knows: the character you have picked stands large on the left,
 * turning; the roster is a grid of tiles on the right, framed in the
 * character's colour, with the ones the shop sells wearing their tier. A
 * search box, a shuffle, and one button.
 *
 * It picks through `setActiveCharacter`, so who you are here is who you are
 * in the city, the profile and the hub. The one exception is the drop suit,
 * the island's own rig, which is a flag of this world's rather than a roster
 * id — see `skinChoice.ts`.
 *
 * One WebGL canvas: the preview. There are seventy tiles and a browser has
 * about sixteen contexts, so the tiles are portraits, not canvases — the
 * renders `characterArt` already keeps for the shop.
 */
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Dices, Lock, Search, X } from "lucide-react";
import { CharacterPreview } from "@/island/CharacterPreview";
import type { CharacterOption } from "@/island/characters";
import { CHARACTERS, findCharacter, type CharSpec } from "@/lib/characters";
import { characterArt } from "@/lib/characterArt";
import { SHOP_CHARACTERS, TIER_STYLE, shopCharacter } from "@/lib/characterShop";
import { owns, subscribeWardrobe } from "@/lib/wardrobe";
import { setActiveCharacter } from "@/hooks/use-active-character";
import { SUIT_ID, lockerSelection, setWearsSuit } from "../play/skinChoice";

/** The island's own rig, as a tile. Never written to the shared pick. */
const SUIT: CharSpec = {
  id: SUIT_ID,
  url: "",
  label: "Drop Suit",
  emoji: "🪂",
  blurb: "The island's own kit. Navy, orange scarf, sand pack, the glider that matches.",
  accent: "#e07a3c",
};

function toOption(c: CharSpec): CharacterOption {
  return {
    id: c.id,
    name: c.label,
    description: c.blurb,
    url: c.url,
    scale: 1,
    yOffset: 0,
    previewDistance: 2.6,
    previewHeight: 1.55,
    previewTarget: 1.1,
    accent: "from-white/10 to-white/0",
  };
}

interface LockerProps {
  /** Title of the game this locker opens under, for the eyebrow. */
  game: string;
  /** The button. Closes the locker; the caller decides whether to drop. */
  cta: string;
  onDone: () => void;
  /** Rendered as an overlay over an entry veil, or inline. */
  onClose?: () => void;
}

export default function Locker({ game, cta, onDone, onClose }: LockerProps) {
  const [selected, setSelected] = useState<string>(() => lockerSelection());
  const [query, setQuery] = useState("");
  const [, setWardrobeTick] = useState(0);
  const [tab, setTab] = useState<"all" | "free" | "shop">("all");

  // Ownership can land after the first paint (the wardrobe fetch).
  useEffect(() => subscribeWardrobe(() => setWardrobeTick((t) => t + 1)), []);

  const roster = useMemo<CharSpec[]>(() => [SUIT, ...CHARACTERS], []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster.filter((c) => {
      if (tab === "shop" && !shopCharacter(c.id)) return false;
      if (tab === "free" && shopCharacter(c.id)) return false;
      if (!q) return true;
      return c.label.toLowerCase().includes(q) || c.blurb.toLowerCase().includes(q);
    });
  }, [roster, query, tab]);

  const current = selected === SUIT_ID ? SUIT : findCharacter(selected);
  const shop = shopCharacter(current.id);
  const locked = !!shop && !owns("character", current.id, shop.price);
  const previewOption = useMemo(() => toOption(current), [current]);

  function pick(c: CharSpec) {
    const s = shopCharacter(c.id);
    if (s && !owns("character", c.id, s.price)) {
      // Locked tiles preview but do not equip; the shop is where they unlock.
      setSelected(c.id);
      return;
    }
    setSelected(c.id);
    if (c.id === SUIT_ID) {
      setWearsSuit(true);
    } else {
      setWearsSuit(false);
      setActiveCharacter(c.id);
    }
  }

  function shuffle() {
    const pool = roster.filter((c) => {
      const s = shopCharacter(c.id);
      return !s || owns("character", c.id, s.price);
    });
    const c = pool[Math.floor(Math.random() * pool.length)];
    if (c) pick(c);
  }

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[#070a18]/96 text-white backdrop-blur-md">
      {/* header */}
      <div className="flex items-center justify-between gap-4 py-4 pl-16 pr-5 sm:pr-8">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.4em] text-white/45">{game} · locker</div>
          <h2 className="font-heading text-2xl font-black uppercase tracking-tight sm:text-3xl">Choose your character</h2>
        </div>
        <div className="flex items-center gap-2">
          <label className="hidden items-center gap-2 rounded-full border border-white/12 bg-white/5 px-3 py-1.5 sm:flex">
            <Search className="h-3.5 w-3.5 text-white/50" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the roster"
              className="w-40 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
            />
          </label>
          <button
            type="button"
            onClick={shuffle}
            className="flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-white/80 hover:bg-white/10"
            title="Random"
          >
            <Dices className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Random</span>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-white/12 bg-white/5 p-2 text-white/70 hover:bg-white/10"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pb-5 pt-4 sm:flex-row sm:px-8">
        {/* the one you picked */}
        <div className="relative flex h-[38vh] shrink-0 flex-col overflow-hidden rounded-2xl border border-white/10 sm:h-auto sm:w-[38%]"
          style={{ background: `radial-gradient(120% 90% at 50% 100%, ${current.accent}33, transparent 60%), linear-gradient(180deg, #0d1230, #070a18)` }}
        >
          <div className="absolute inset-0">
            {/* Not keyed on the pick. A key remounts the Canvas — a fresh WebGL
                context per click, which is slow everywhere and fatal after
                sixteen — and the preview already reloads its model when the
                character changes. */}
            <CharacterPreview character={previewOption} spinning pose="idle" />
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#070a18] via-[#070a18]/70 to-transparent px-5 pb-5 pt-16">
            <div className="flex items-center gap-2">
              {shop && (
                <span
                  className="rounded-[3px] px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.2em]"
                  style={{ background: `${TIER_STYLE[shop.tier].color}22`, color: TIER_STYLE[shop.tier].color }}
                >
                  {TIER_STYLE[shop.tier].label}
                </span>
              )}
              {locked && (
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/55">
                  <Lock className="h-3 w-3" /> {shop?.price} vibe in the arcade
                </span>
              )}
            </div>
            <div className="mt-1 font-heading text-3xl font-black uppercase leading-none tracking-tight sm:text-4xl" style={{ color: current.accent }}>
              {current.label}
            </div>
            <div className="mt-1 max-w-md text-sm text-white/70">{current.blurb}</div>
          </div>
        </div>

        {/* the roster */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.2em]">
            {(["all", "free", "shop"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-full px-3 py-1 transition ${tab === t ? "bg-white text-[#070a18]" : "text-white/55 hover:text-white"}`}
              >
                {t === "all" ? `All ${roster.length}` : t === "free" ? "Free" : `Shop ${SHOP_CHARACTERS.length}`}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {filtered.map((c) => {
                const s = shopCharacter(c.id);
                const isLocked = !!s && !owns("character", c.id, s.price);
                const active = c.id === selected;
                const art = characterArt(c.id);
                const frame = s ? TIER_STYLE[s.tier].color : c.accent;
                return (
                  <motion.button
                    key={c.id}
                    type="button"
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => pick(c)}
                    className="relative aspect-[4/5] overflow-hidden rounded-xl border text-left"
                    style={{
                      borderColor: active ? "#fff" : `${frame}66`,
                      background: `linear-gradient(180deg, ${frame}2e, #0b1026 70%)`,
                      boxShadow: active ? `0 0 0 2px #fff, 0 0 26px ${frame}66` : undefined,
                    }}
                    title={c.blurb}
                  >
                    {art ? (
                      <img src={art} alt="" loading="lazy" className="absolute inset-x-0 top-1 mx-auto h-[78%] w-auto object-contain" />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-4xl">{c.emoji}</div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#070a18] to-transparent px-2 pb-1.5 pt-6">
                      <div className="truncate text-[11px] font-black uppercase tracking-[0.06em]" style={{ color: active ? "#fff" : frame }}>
                        {c.label}
                      </div>
                    </div>
                    {isLocked && (
                      <div className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1">
                        <Lock className="h-3 w-3 text-white/80" />
                      </div>
                    )}
                    {s && (
                      <div
                        className="absolute left-1.5 top-1.5 rounded-[3px] px-1 text-[8px] font-black uppercase tracking-[0.15em]"
                        style={{ background: `${frame}33`, color: frame }}
                      >
                        {TIER_STYLE[s.tier].label}
                      </div>
                    )}
                  </motion.button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* footer */}
      <div className="flex items-center justify-between gap-4 border-t border-white/10 px-5 py-3 sm:px-8">
        <div className="text-xs text-white/50">
          Your character follows you across the vibeverse.{" "}
          <span className="text-white/35">The drop suit is this island's own and stays here.</span>
        </div>
        <AnimatePresence>
          <motion.button
            key="cta"
            type="button"
            onClick={onDone}
            disabled={locked}
            whileTap={{ scale: 0.98 }}
            className="rounded-full bg-gradient-to-r from-amber-300 to-orange-500 px-8 py-2.5 text-sm font-black uppercase tracking-[0.2em] text-[#1a0d00] shadow-[0_0_34px_rgba(251,191,36,0.4)] disabled:opacity-40"
          >
            {locked ? "Locked" : cta}
          </motion.button>
        </AnimatePresence>
      </div>
    </div>
  );
}
