/**
 * Direction C, "Postcard": the serif half of the cover, made calm.
 *
 * Warm paper instead of a screen, the cover art sent to you as a postcard,
 * and the $VIBE price as its postage stamp. The type does the talking (the
 * cover's own question, set large in the cover's serif) and the worlds are
 * printed photographs on the page. Quietest of the three, and the one that
 * sits most naturally on a personal site.
 */
import { Link, useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";

import { useHomeData, Grain } from "@/home/kit";
import VibeMark from "@/components/VibeMark";
import Account from "./Account";
import {
  CardArt,
  CoverFonts,
  PIXEL,
  SANS,
  SERIF,
  coinLabel,
  coverUrl,
  randomRoute,
  shortStatus,
  useHover,
  usePreloadFonts,
  usePrice,
  useWorldList,
} from "./shared";
import type { WorldEntry } from "@/worlds/registry";

const PAPER = "#f6f0e4";
const INK = "#1c2b45";
const BLUE = "#1f8ff7";

/** Perforated stamp edge: a scalloped mask around a white tile. */
/* White paper with holes punched on a 10px grid; the blue tile covers all but
   the outer ring of them, which is what reads as perforation. */
const PERFORATION = "radial-gradient(circle, transparent 2.6px, #fff 3px) -5px -5px / 10px 10px";

function Stamp() {
  const price = usePrice();
  return (
    <a
      href={price.href}
      target="_blank"
      rel="noreferrer noopener"
      title={price.price ? `${price.price} per VIBE` : "$VIBE on Base"}
      className="absolute -right-4 -top-12 w-[96px] rotate-[7deg] transition-transform hover:rotate-[3deg] sm:-right-10 sm:-top-16 sm:w-[120px]"
      style={{ filter: "drop-shadow(0 6px 10px rgba(28,43,69,0.25))" }}
    >
      <div className="p-[8px]" style={{ background: PERFORATION }}>
        <div className="flex aspect-[4/5] flex-col items-center justify-center gap-1 text-center text-white" style={{ background: BLUE }}>
          <span className="text-[17px] leading-none sm:text-[20px]" style={{ fontFamily: PIXEL, fontWeight: 700 }}>
            $VIBE
          </span>
          <span className="text-[13px] tabular-nums leading-none sm:text-[14px]" style={{ fontFamily: SANS, fontWeight: 800 }}>
            {price.cap ?? "on Base"}
          </span>
          <span className="text-[10px] uppercase tracking-[0.12em] opacity-80">{price.cap ? "market cap" : ""}</span>
          {price.change && <span className="text-[11px] tabular-nums opacity-85">{price.change} today</span>}
        </div>
      </div>
    </a>
  );
}

function Print({ world }: { world: WorldEntry }) {
  const { hovering, bind } = useHover();
  const status = shortStatus(world);
  return (
    <Link
      to={world.route}
      {...bind}
      className="group flex h-full flex-col bg-white p-2 transition-[transform,box-shadow] duration-300 hover:-translate-y-1 sm:p-2.5"
      style={{ boxShadow: "0 1px 2px rgba(28,43,69,0.12), 0 12px 28px -16px rgba(28,43,69,0.35)" }}
    >
      <CardArt world={world} hovering={hovering} aspect="4 / 3" />
      <div className="flex flex-1 flex-col px-1 pb-1 pt-2.5 sm:px-1.5 sm:pt-3">
        {status && (
          <span className="truncate text-[9.5px] font-bold uppercase tracking-[0.14em] sm:text-[10px]" style={{ color: BLUE }}>
            {status}
          </span>
        )}
        <h3 className="mt-0.5 text-[19px] leading-[1.05] sm:text-[23px]" style={{ fontFamily: SERIF }}>
          {world.name}
        </h3>
        <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-[#1c2b45]/65 sm:text-[13px]">{world.blurb}</p>
      </div>
    </Link>
  );
}

export default function Postcard() {
  usePreloadFonts();
  const d = useHomeData();
  const list = useWorldList();
  const go = useNavigate();

  return (
    <div className="relative min-h-[100dvh] w-full overflow-x-clip" style={{ background: PAPER, color: INK, fontFamily: SANS }}>
      <CoverFonts />
      <div className="pointer-events-none fixed inset-0" aria-hidden>
        <Grain opacity={0.08} />
      </div>

      <header className="relative z-10 mx-auto flex max-w-6xl items-center gap-1 px-5 pt-5 sm:px-8 sm:pt-7">
        <Link to="/" className="mr-auto flex items-center gap-2 text-[17px] tracking-[0.04em] sm:text-[19px]" style={{ fontFamily: PIXEL, fontWeight: 700 }}>
          <VibeMark size={40} rotateSeconds={30} priority className="shrink-0" />
          VIBEVERSE
        </Link>
        <a href="#worlds" className="hidden px-3 py-2 text-[14px] text-[#1c2b45]/75 hover:text-[#1c2b45] sm:block">Worlds</a>
        <Link to="/arcade" className="hidden px-3 py-2 text-[14px] text-[#1c2b45]/75 hover:text-[#1c2b45] sm:block">Arcade</Link>
        <Link to="/passport" className="hidden px-3 py-2 text-[14px] text-[#1c2b45]/75 hover:text-[#1c2b45] sm:block">Passport</Link>
        <Account className="ml-2 h-9 rounded-full border border-[#1c2b45]/25 px-4 text-[13.5px] font-semibold transition-colors hover:border-[#1c2b45]" />
      </header>

      <section className="relative z-10 mx-auto grid max-w-6xl gap-12 px-5 pb-10 pt-12 sm:px-8 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:gap-14 lg:pt-20">
        <div>
          <p className="text-[12px] tracking-[0.16em]" style={{ fontFamily: PIXEL, color: BLUE }}>
            A COLLECTION OF AI-CODED WORLDS
          </p>
          <h1 className="mt-4 leading-[0.98]" style={{ fontFamily: SERIF, fontSize: "clamp(2.9rem, 7.4vw, 5.4rem)" }}>
            What kind of <em style={{ color: BLUE }}>adventure</em> do you want today?
          </h1>
          <p className="mt-5 max-w-md text-[16px] leading-relaxed text-[#1c2b45]/75">
            {d.counts.worlds} small worlds and games, each one a browser tab away. Walk a harbour town, race a kart, talk a
            valley into snowing. No download, no account.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
            <a href="#worlds" className="flex h-12 items-center rounded-full px-7 text-[15px] font-bold text-white transition-transform hover:scale-[1.03]" style={{ background: INK }}>
              Browse the worlds
            </a>
            <button type="button" onClick={() => go(randomRoute())} className="text-[15px] font-semibold underline decoration-[#1c2b45]/30 underline-offset-[6px] hover:decoration-[#1c2b45]">
              Surprise me
            </button>
          </div>
          <p className="mt-8 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[#1c2b45]/60">
            <Link to="/arcade" className="hover:text-[#1c2b45]">✦ {coinLabel(d.coin.balance, d.coin.display)}</Link>
            <Link to="/passport" className="hover:text-[#1c2b45]">
              Passport {d.passport.visited} of {d.passport.total}
            </Link>
          </p>
        </div>

        <div className="relative mx-auto w-full max-w-[600px] px-2 sm:px-6">
          <div className="relative rotate-[-2deg] bg-white p-3 sm:p-4" style={{ boxShadow: "0 2px 4px rgba(28,43,69,0.1), 0 30px 60px -24px rgba(28,43,69,0.45)" }}>
            <img src={coverUrl} alt="The VibeVerse cover: a robot and a dog looking out at floating islands" width={1200} height={630} className="block aspect-[1200/630] w-full object-cover" />
            <div className="flex items-baseline justify-between px-1 pt-3 text-[13px] text-[#1c2b45]/60">
              <span style={{ fontFamily: SERIF, fontSize: 18, color: INK }}>
                <em>Greetings from the VibeVerse</em>
              </span>
              <span className="hidden sm:inline">{d.counts.worlds} worlds inside</span>
            </div>
            <Stamp />
          </div>
        </div>
      </section>

      <main id="worlds" className="relative z-10 mx-auto max-w-6xl scroll-mt-2 px-5 pb-28 pt-10 sm:px-8">
        <div className="flex items-end justify-between gap-4 border-b border-[#1c2b45]/15 pb-3">
          <h2 className="leading-none" style={{ fontFamily: SERIF, fontSize: "clamp(2.1rem,5vw,3.2rem)" }}>
            The worlds
          </h2>
          <span className="pb-1 text-[13px] text-[#1c2b45]/55">{list.total} and counting</span>
        </div>

        <div className="sticky top-0 z-20 -mx-5 flex flex-col gap-2 px-5 py-3 sm:-mx-8 sm:flex-row sm:items-center sm:justify-between sm:px-8" style={{ background: `${PAPER}f0` }}>
          <div role="tablist" aria-label="Order the worlds" className="flex gap-5">
            {list.tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={list.sort === t.id}
                onClick={() => list.setSort(t.id)}
                className={`border-b-2 py-1 text-[14.5px] font-semibold transition-colors ${
                  list.sort === t.id ? "border-[#1c2b45] text-[#1c2b45]" : "border-transparent text-[#1c2b45]/50 hover:text-[#1c2b45]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <label className="relative block sm:w-64">
            <Search className="pointer-events-none absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 text-[#1c2b45]/45" />
            <input
              type="search"
              value={list.query}
              onChange={(e) => list.setQuery(e.target.value)}
              placeholder="Find a world"
              aria-label="Search worlds"
              className="h-10 w-full appearance-none border-b border-[#1c2b45]/25 bg-transparent pl-7 pr-7 text-[15px] outline-none placeholder:text-[#1c2b45]/40 focus:border-[#1c2b45] [&::-webkit-search-cancel-button]:hidden"
            />
            {list.query && (
              <button type="button" aria-label="Clear search" onClick={() => list.setQuery("")} className="absolute right-0 top-1/2 -translate-y-1/2 text-[#1c2b45]/50">
                <X className="h-4 w-4" />
              </button>
            )}
          </label>
        </div>

        <div className="mt-4 grid auto-rows-fr grid-cols-2 gap-3 sm:gap-6 md:grid-cols-3 lg:grid-cols-4">
          {list.shown.map((w) => (
            <Print key={w.key} world={w} />
          ))}
        </div>

        {list.shown.length === 0 && (
          <p className="py-16 text-center text-[22px]" style={{ fontFamily: SERIF }}>
            <em>Nothing by that name yet.</em>
          </p>
        )}


        <footer className="mt-24 flex flex-col items-center gap-3 text-center">
          <p style={{ fontFamily: SERIF, fontSize: 24 }}>
            <em>Wish you were here.</em>
          </p>
          <nav className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-[13px] text-[#1c2b45]/60">
            <Link to="/submit-world" className="hover:text-[#1c2b45]">Submit a world</Link>
            <Link to="/world-builder" className="hover:text-[#1c2b45]">World builder</Link>
            <Link to="/chronicle" className="hover:text-[#1c2b45]">Chronicle</Link>
            <Link to="/coin" className="hover:text-[#1c2b45]">About $VIBE</Link>
          </nav>
        </footer>
      </main>
    </div>
  );
}
