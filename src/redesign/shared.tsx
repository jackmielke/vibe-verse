/**
 * The shared half of the three cover-art directions at `/redesign`.
 *
 * Jack's note was that the front door does not look like the VibeVerse cover
 * (a bright daytime sky, floating islands, a white pixel wordmark and a serif
 * line asking "What kind of adventure do you want today?") and that it feels
 * glitchy on first open. These three pages are candidates for replacing `/`,
 * so they share every behaviour and differ only in how they look:
 *
 * - the same registry, search, sort and "show all" as the live grid
 * - the same Vibey balance and $VIBE price
 * - the same sign-in dialog
 *
 * The glitch fixes are also shared, because they are not a matter of taste:
 * self-hosted fonts with metric-matched fallbacks (no headline jumping when a
 * webfont lands), fixed aspect ratios on every image (no cards growing under
 * the cursor), no staggered entrance animation on the grid (cards used to
 * slide in one by one on every sort change), and no dash where a number
 * should be.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { PointerEvent as ReactPointerEvent } from "react";
import { WORLDS, type WorldEntry } from "@/worlds/registry";
import { artFor } from "@/worlds/art";
import { motionFor } from "@/worlds/motion";
import { SORT_TABS, initialSort, rememberSort, sortWorlds, type WorldSort } from "@/worlds/sorting";
import { readPassport, type Stamp } from "@/lib/passport";
import {
  STALE_AFTER_MS,
  VIBE_LINKS,
  formatPrice,
  formatUsdCompact,
  getVibeMarket,
  marketCap,
  refreshVibeMarket,
  subscribeVibeMarket,
  type VibeMarket,
} from "@/lib/vibeMarket";

import pix500 from "@/assets/redesign/pixelify-sans-latin-500-normal.woff2";
import pix700 from "@/assets/redesign/pixelify-sans-latin-700-normal.woff2";
import serif400 from "@/assets/redesign/instrument-serif-latin-400-normal.woff2";
import serif400i from "@/assets/redesign/instrument-serif-latin-400-italic.woff2";

export { default as coverUrl } from "@/assets/redesign/cover.webp";
export { default as coverBandUrl } from "@/assets/redesign/cover-band.webp";
export { default as coverHeroesUrl } from "@/assets/redesign/cover-heroes.webp";

export const PIXEL = "'VV Pixel', 'Courier New', monospace";
export const SERIF = "'VV Serif', Georgia, 'Times New Roman', serif";
export const SANS = "Manrope, system-ui, -apple-system, 'Segoe UI', sans-serif";

/**
 * The two cover faces, served from our own origin.
 *
 * `font-display: block` on the pixel face is deliberate. It is only ever the
 * wordmark and a few labels, it is 15 KB, and the alternative is VIBEVERSE
 * painting in Courier for a frame and then snapping to pixels, which is
 * exactly the "glitchy on open" Jack described.
 */
export function CoverFonts() {
  return (
    <style>{`
@font-face{font-family:'VV Pixel';src:url(${pix500}) format('woff2');font-weight:400 600;font-display:block}
@font-face{font-family:'VV Pixel';src:url(${pix700}) format('woff2');font-weight:700;font-display:block}
@font-face{font-family:'VV Serif';src:url(${serif400}) format('woff2');font-weight:400;font-style:normal;font-display:swap;size-adjust:96%}
@font-face{font-family:'VV Serif';src:url(${serif400i}) format('woff2');font-weight:400;font-style:italic;font-display:swap;size-adjust:96%}
`}</style>
  );
}

/** Preload the two fonts the first frame needs, so `block` is a few ms, not a flash. */
export function usePreloadFonts() {
  useEffect(() => {
    const links = [pix700, serif400i].map((href) => {
      const l = document.createElement("link");
      l.rel = "preload";
      l.as = "font";
      l.type = "font/woff2";
      l.crossOrigin = "anonymous";
      l.href = href;
      document.head.appendChild(l);
      return l;
    });
    return () => links.forEach((l) => l.remove());
  }, []);
}

/* -------------------------------------------------------------------------- */
/* The world list                                                             */
/* -------------------------------------------------------------------------- */

export const PREVIEW_COUNT = 8;

export function useWorldList() {
  const [query, setQuery] = useState("");
  const lastPlayed = useMemo(() => {
    const map: Record<string, number> = {};
    for (const st of Object.values(readPassport().stamps) as Stamp[]) map[st.route] = st.last;
    return map;
  }, []);
  const hasPlays = Object.keys(lastPlayed).length > 0;
  const [sort, setSortState] = useState<WorldSort>(() => initialSort(hasPlays));
  const tabs = useMemo(() => SORT_TABS.filter((t) => t.id !== "played" || hasPlays), [hasPlays]);
  const setSort = useCallback((s: WorldSort) => {
    setSortState(s);
    rememberSort(s);
  }, []);
  const [expanded, setExpanded] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = q
      ? WORLDS.filter((w) => `${w.name} ${w.blurb} ${w.status ?? ""}`.toLowerCase().includes(q))
      : WORLDS;
    return sortWorlds(hit, sort, lastPlayed);
  }, [query, sort, lastPlayed]);

  const collapsed = !expanded && !query.trim() && shown.length > PREVIEW_COUNT;
  return {
    query,
    setQuery,
    sort,
    setSort,
    tabs,
    shown,
    visible: collapsed ? shown.slice(0, PREVIEW_COUNT) : shown,
    collapsed,
    expand: () => setExpanded(true),
    total: WORLDS.length,
  };
}

/** "Playable", from "Playable — phone or laptop". */
export const shortStatus = (w: WorldEntry) => (w.status ? w.status.split("—")[0].trim() : null);

/* -------------------------------------------------------------------------- */
/* $VIBE                                                                      */
/* -------------------------------------------------------------------------- */

export interface Price {
  /** `$0.0000712`, or null when we have never had a reading. */
  price: string | null;
  /** `$71.2K`. */
  cap: string | null;
  /** `+3.4%` / `−2.1%`, or null. */
  change: string | null;
  direction: "up" | "down" | "flat";
  stale: boolean;
  href: string;
}

export function usePrice(): Price {
  const [m, setM] = useState<VibeMarket>(getVibeMarket);
  useEffect(() => {
    const off = subscribeVibeMarket(setM);
    void refreshVibeMarket();
    setM(getVibeMarket());
    return off;
  }, []);
  const c = m.change24h;
  return {
    price: m.usd == null ? null : formatPrice(m.usd),
    cap: m.usd == null ? null : formatUsdCompact(marketCap(m.usd)),
    change: c == null ? null : `${c > 0 ? "+" : c < 0 ? "−" : ""}${Math.abs(c).toFixed(1)}%`,
    direction: c == null || c === 0 ? "flat" : c > 0 ? "up" : "down",
    stale: m.at > 0 && Date.now() - m.at > STALE_AFTER_MS,
    href: VIBE_LINKS.chart,
  };
}

/**
 * The play balance, as words a stranger understands.
 *
 * The live page prints "— VIBEY" until the ledger answers, and for a guest the
 * answer can take a while: a lone dash next to a coin is the single most
 * broken-looking thing on the front door. A guest with nothing yet is told
 * what the coin is for instead.
 */
export function coinLabel(balance: number | null, display: string): string {
  if (balance == null) return "Earn coins";
  if (balance === 0) return "0 coins";
  return `${display} coins`;
}

/* -------------------------------------------------------------------------- */
/* Card art                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A world's still, with its few seconds of footage over it on hover.
 *
 * Same rules as the live grid: the clip is not even requested until a mouse
 * has been on the card (a phone's tap would download it on the way out), and
 * it fades in only once its bytes have landed. The box has a fixed aspect and
 * the world's accent behind it, so a slow image is a coloured tile, never a
 * card that changes height.
 */
export function CardArt({
  world,
  hovering,
  aspect = "16 / 10",
  className = "",
}: {
  world: WorldEntry;
  hovering: boolean;
  aspect?: string;
  className?: string;
}) {
  const [ever, setEver] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (hovering) setEver(true);
  }, [hovering]);
  const still = artFor(world.key);
  const reduce =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const clip = ever && !reduce ? motionFor(world.key) : undefined;

  return (
    <div
      className={`relative w-full overflow-hidden ${className}`}
      style={{ aspectRatio: aspect, background: `${world.accent}33` }}
    >
      {still ? (
        <img
          src={still}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-4xl" aria-hidden>
          {world.emoji}
        </div>
      )}
      {clip && (
        <img
          src={clip}
          alt=""
          onLoad={() => setReady(true)}
          className="absolute inset-0 h-full w-full object-cover transition-opacity duration-300"
          style={{ opacity: ready && hovering ? 1 : 0 }}
        />
      )}
    </div>
  );
}

/** Pointer-hover state that ignores touch, for `CardArt`. */
export function useHover() {
  const [hovering, setHovering] = useState(false);
  return {
    hovering,
    bind: {
      onPointerEnter: (e: ReactPointerEvent) => e.pointerType === "mouse" && setHovering(true),
      onPointerLeave: () => setHovering(false),
    },
  };
}

/** A random playable world, for "Surprise me". */
export function randomRoute(): string {
  const pool = WORLDS.filter((w) => /playable|open|new/i.test(w.status ?? ""));
  const list = pool.length ? pool : WORLDS;
  return list[Math.floor(Math.random() * list.length)].route;
}
