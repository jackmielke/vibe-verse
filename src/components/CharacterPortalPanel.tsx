/**
 * CharacterPortalPanel — a compact holographic character picker that
 * lives right next to the Vibe Shop. Pick a character here and it
 * follows you into /city (and everywhere else that reads the active
 * character).
 *
 * Uses the shared `useActiveCharacter` hook so any pick made here is
 * instantly reflected in the top-right avatar dropdown, /city, /lobby,
 * /profile — the whole VibeVerse.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Shuffle, ArrowRight, Lock } from "lucide-react";
import { useActiveCharacter } from "@/hooks/use-active-character";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { itemKey } from "@/lib/wardrobe";
import { isForSale, characterPrice } from "@/lib/characterShop";
import { VIBECOIN_GLYPH } from "@/lib/vibecoin";
import type { CharSpec } from "@/lib/characters";

export default function CharacterPortalPanel() {
  const { charId, setCharId, character, all } = useActiveCharacter();
  const { owned } = useWardrobe();
  const [query, setQuery] = useState("");

  /* The arcade's six are shown here rather than hidden, and locked rather
     than filtered out. A shop nobody can see is a shop nobody visits, and the
     honest version of "you cannot have this" is a padlock and a price — not a
     roster that quietly has six holes in it. */
  const locked = (c: CharSpec) =>
    isForSale(c.id) && !owned.includes(itemKey("character", c.id));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (c.blurb ?? "").toLowerCase().includes(q),
    );
  }, [all, query]);

  const pickRandom = () => {
    // Never roll something they would then have to buy — a random button that
    // lands on a padlock two times in ten is a broken button.
    const pool = (filtered.length > 0 ? filtered : all).filter((c) => !locked(c));
    const next = pool[Math.floor(Math.random() * pool.length)];
    if (next) setCharId(next.id);
  };

  return (
    <div className="glass-panel rounded-2xl border border-primary/30 p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-primary" />
        <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
          Character Portal
        </p>
      </div>

      {/* Active preview */}
      <div
        className="flex items-center gap-4 rounded-xl border p-4"
        style={{
          background: `linear-gradient(135deg, hsl(${hueFromAccent(character.accent)} / 0.22), hsl(280 80% 60% / 0.14))`,
          borderColor: character.accent ?? "hsl(150 80% 60% / 0.4)",
          boxShadow: `0 0 24px ${character.accent ?? "hsl(150 80% 60% / 0.25)"}`,
        }}
      >
        <div
          className="shrink-0 w-16 h-16 rounded-xl flex items-center justify-center text-3xl"
          style={{
            background: "hsl(0 0% 0% / 0.35)",
            border: `1px solid ${character.accent ?? "hsl(150 80% 60% / 0.5)"}`,
          }}
          aria-hidden
        >
          {character.emoji ?? "🧑‍🚀"}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-heading text-base font-semibold text-foreground truncate">
            {character.label}
          </p>
          <p className="text-xs text-muted-foreground leading-snug mt-0.5 line-clamp-2">
            {character.blurb ?? "Your avatar across the VibeVerse."}
          </p>
        </div>
        <a
          href="/city?spawn=hub"
          className="hidden sm:inline-flex items-center gap-1.5 rounded-lg px-3 py-2 font-heading font-semibold text-xs tracking-wide uppercase bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Enter <ArrowRight className="w-3.5 h-3.5" />
        </a>
      </div>

      {/* Search + shuffle */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search characters…"
          className="flex-1 rounded-lg bg-background/40 border border-border/60 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60"
        />
        <button
          type="button"
          onClick={pickRandom}
          className="rounded-lg px-3 py-2 text-xs font-heading font-semibold uppercase tracking-wide border border-primary/40 text-primary hover:bg-primary/10 transition-colors inline-flex items-center gap-1.5"
        >
          <Shuffle className="w-3.5 h-3.5" /> Random
        </button>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-72 overflow-y-auto pr-1">
        {filtered.map((c) => {
          const active = c.id === charId;
          const isLocked = locked(c);
          if (isLocked) {
            return (
              <Link
                key={c.id}
                to="/arcade/characters"
                title={`${c.label} — ${characterPrice(c.id)} ${VIBECOIN_GLYPH} in the arcade`}
                className="relative aspect-square rounded-lg flex flex-col items-center justify-center gap-0.5 border border-amber-300/30 bg-amber-300/[0.06] text-lg transition-all hover:border-amber-300/60 hover:bg-amber-300/10"
              >
                <span className="opacity-45" aria-hidden>
                  {c.emoji ?? "🧍"}
                </span>
                <span className="text-[8px] font-medium truncate w-full text-center px-0.5 text-amber-300/80 tabular-nums">
                  {characterPrice(c.id)} {VIBECOIN_GLYPH}
                </span>
                <Lock className="absolute right-1 top-1 w-2.5 h-2.5 text-amber-300/70" />
              </Link>
            );
          }
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setCharId(c.id)}
              title={c.label}
              className={`aspect-square rounded-lg flex flex-col items-center justify-center gap-0.5 border text-lg transition-all ${
                active
                  ? "border-primary bg-primary/15 scale-105 shadow-[0_0_16px_hsl(150_80%_60%/0.5)]"
                  : "border-border/60 bg-background/30 hover:border-primary/50 hover:bg-background/50"
              }`}
              style={active && c.accent ? { boxShadow: `0 0 18px ${c.accent}` } : undefined}
            >
              <span aria-hidden>{c.emoji ?? "🧍"}</span>
              <span className="text-[8px] text-muted-foreground font-medium truncate w-full text-center px-0.5">
                {c.label}
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="col-span-full text-center text-xs text-muted-foreground py-6">
            No characters match "{query}".
          </p>
        )}
      </div>

      <a
        href="/city?spawn=hub"
        className="sm:hidden w-full inline-flex justify-center items-center gap-1.5 rounded-lg px-3 py-2 font-heading font-semibold text-xs tracking-wide uppercase bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Enter Vibe Island <ArrowRight className="w-3.5 h-3.5" />
      </a>

      <p className="text-[10px] text-muted-foreground/80 leading-relaxed">
        Your character follows you everywhere in the VibeVerse — /city, /lobby, /profile,
        and even into the arcade. Pick anytime, no wallet required. The six with a
        padlock are the arcade's own:{" "}
        <Link to="/arcade/characters" className="text-amber-300/90 hover:underline">
          see them move
        </Link>
        .
      </p>
    </div>
  );
}

/** Extract an HSL hue from an accent color string like "#a78bfa" or "hsl(...)". */
function hueFromAccent(accent?: string): string {
  if (!accent) return "150 80% 60%";
  if (accent.startsWith("hsl")) {
    const inner = accent.replace(/hsl\(|\)/g, "").trim();
    return inner.split("/")[0].trim();
  }
  // hex → rough HSL by dropping through CSS var fallback
  return "150 80% 60%";
}

// Keep the type re-exported so imports don't break tree-shaking assumptions.
export type { CharSpec };
