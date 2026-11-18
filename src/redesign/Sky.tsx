/**
 * Direction A, "Sky": the cover, taken literally.
 *
 * The page opens on the cover's own blue, with its white pixel wordmark and
 * its serif question, and the painted islands (the robot, the dog, the city,
 * the pagoda) along the bottom of the first screen. Scrolling carries you down
 * out of the sky onto a pale, airy page where the worlds sit on white cards.
 * Friendly, bright, and the closest of the three to the poster itself.
 */
import { Link, useNavigate } from "react-router-dom";
import { Search, X, ChevronDown, Shuffle } from "lucide-react";

import { useHomeData } from "@/home/kit";
import Account from "./Account";
import {
  CardArt,
  CoverFonts,
  PIXEL,
  SANS,
  SERIF,
  coinLabel,
  coverBandUrl,
  randomRoute,
  shortStatus,
  useHover,
  usePreloadFonts,
  usePrice,
  useWorldList,
} from "./shared";
import type { WorldEntry } from "@/worlds/registry";

const INK = "#0b2a55";
const SKY_TOP = "#0a7cf4";
const SKY_MID = "#1f9bfc";
const SKY_LOW = "#5cbcff";

/** One puffy cloud, drawn from circles so it reads as the cover's, not as fog. */
function Cloud({
  x,
  y,
  s,
  speed,
  delay,
  only,
}: {
  x: string;
  y: string;
  s: number;
  speed: number;
  delay: number;
  only?: "desktop" | "phone";
}) {
  const puff = (l: number, t: number, d: number) => (
    <span
      className="absolute rounded-full"
      style={{
        left: l * s,
        top: t * s,
        width: d * s,
        height: d * s,
        background: "radial-gradient(circle at 40% 35%, #ffffff 55%, #e4f1ff 100%)",
      }}
    />
  );
  return (
    <div
      aria-hidden
      className={`vv-cloud pointer-events-none absolute ${only === "desktop" ? "hidden md:block" : only === "phone" ? "md:hidden" : ""}`}
      style={{
        left: x,
        top: y,
        width: 220 * s,
        height: 110 * s,
        animationDuration: `${speed}s`,
        animationDelay: `${-delay}s`,
        filter: "drop-shadow(0 18px 24px rgba(10,60,140,0.18))",
      }}
    >
      {puff(0, 48, 80)}
      {puff(46, 18, 96)}
      {puff(112, 6, 82)}
      {puff(150, 44, 70)}
      <span className="absolute rounded-full bg-white" style={{ left: 20 * s, top: 70 * s, width: 190 * s, height: 40 * s }} />
    </div>
  );
}

function Card({ world }: { world: WorldEntry }) {
  const { hovering, bind } = useHover();
  const status = shortStatus(world);
  return (
    <Link
      to={world.route}
      {...bind}
      className="group flex h-full flex-col overflow-hidden rounded-[18px] bg-white sm:rounded-[22px] ring-1 ring-[#0b2a55]/[0.06] transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-[0_22px_44px_-18px_rgba(11,42,85,0.35)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1f9bfc]"
      style={{ boxShadow: "0 10px 30px -18px rgba(11,42,85,0.28)" }}
    >
      <div className="relative">
        <CardArt world={world} hovering={hovering} />
        {status && (
          <span
            className="absolute left-2 top-2 max-w-[calc(100%-1rem)] truncate rounded-full bg-white/90 px-2 py-0.5 text-[9px] sm:left-2.5 sm:top-2.5 sm:px-2.5 sm:py-1 sm:text-[10px] font-bold uppercase tracking-[0.08em] backdrop-blur"
            style={{ color: INK }}
          >
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: world.accent }} />
            {status}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col px-3 pb-3 pt-2.5 sm:px-4 sm:pb-4 sm:pt-3.5">
        <h3 className="text-[13.5px] font-extrabold leading-tight sm:text-base" style={{ color: INK }}>
          <span className="mr-1.5">{world.emoji}</span>
          {world.name}
        </h3>
        <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-[#0b2a55]/65 sm:mt-1.5 sm:text-[13px]">{world.blurb}</p>
      </div>
    </Link>
  );
}

export default function Sky() {
  usePreloadFonts();
  const d = useHomeData();
  const list = useWorldList();
  const price = usePrice();
  const go = useNavigate();

  const chip =
    "flex h-9 items-center gap-2 rounded-full bg-white/20 px-3.5 text-[12.5px] font-semibold text-white ring-1 ring-white/35 backdrop-blur-md transition-colors hover:bg-white/30";

  return (
    <div className="min-h-[100dvh] w-full" style={{ background: "#f4f9ff", color: INK, fontFamily: SANS }}>
      <CoverFonts />
      <style>{`
        .vv-cloud{animation-name:vv-cloud;animation-timing-function:ease-in-out;animation-iteration-count:infinite;animation-direction:alternate}
        @keyframes vv-cloud{from{transform:translateX(-24px)}to{transform:translateX(24px)}}
        @media (prefers-reduced-motion: reduce){.vv-cloud{animation:none}}
      `}</style>

      {/* ---------------------------------------------------------------- sky */}
      <section
        className="relative isolate overflow-hidden"
        style={{ background: `linear-gradient(180deg, ${SKY_TOP} 0%, ${SKY_MID} 45%, ${SKY_LOW} 100%)` }}
      >
        <Cloud x="-7%" y="40%" s={0.95} speed={38} delay={0} only="desktop" />
        <Cloud x="85%" y="9%" s={1.0} speed={46} delay={12} only="desktop" />
        <Cloud x="81%" y="50%" s={0.5} speed={30} delay={6} only="desktop" />
        <Cloud x="9%" y="9%" s={0.42} speed={34} delay={20} only="desktop" />
        <Cloud x="-10%" y="10%" s={0.4} speed={34} delay={4} only="phone" />

        <header className="relative z-10 mx-auto flex max-w-6xl items-center gap-2 px-4 pt-4 sm:px-6 sm:pt-5">
          <Link to="/" className="mr-auto text-[15px] font-bold tracking-[0.06em] text-white sm:text-[17px]" style={{ fontFamily: PIXEL }}>
            VIBEVERSE
          </Link>
          <a href="#worlds" className="hidden rounded-full px-3 py-2 text-[13px] font-semibold text-white/90 hover:text-white sm:block">
            Worlds
          </a>
          <Link to="/arcade" className="hidden rounded-full px-3 py-2 text-[13px] font-semibold text-white/90 hover:text-white sm:block">
            Arcade
          </Link>
          <Link to="/passport" className="hidden rounded-full px-3 py-2 text-[13px] font-semibold text-white/90 hover:text-white sm:block">
            Passport
          </Link>
          <Account className="ml-1 h-9 rounded-full bg-white px-4 text-[13px] font-bold shadow-sm transition-transform hover:scale-[1.03]" />
        </header>

        <div className="relative z-10 mx-auto max-w-4xl px-4 pb-6 pt-10 text-center sm:px-6 sm:pt-12">
          <h1
            className="font-bold leading-none tracking-[0.02em] text-white"
            style={{
              fontFamily: PIXEL,
              fontSize: "clamp(2.9rem, 12.5vw, 8.4rem)",
              textShadow: "0 4px 0 rgba(6,70,160,0.35), 0 18px 40px rgba(6,60,150,0.25)",
            }}
          >
            VIBEVERSE
          </h1>
          <p
            className="mx-auto mt-5 max-w-xl leading-[1.12] sm:mt-7"
            style={{ fontFamily: SERIF, fontSize: "clamp(1.6rem, 4.6vw, 2.7rem)", color: "#06204a" }}
          >
            What kind of <em>adventure</em>
            <br />
            do you want today?
          </p>
          <p className="mx-auto mt-4 max-w-md text-[14.5px] leading-relaxed text-[#06204a]/75 sm:text-[15.5px]">
            {d.counts.worlds} little worlds and games, made with AI, all one tap away. No download, no account needed.
          </p>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
            <a
              href="#worlds"
              className="flex h-12 items-center rounded-full bg-white px-7 text-[15px] font-extrabold shadow-[0_10px_24px_-10px_rgba(6,40,110,0.6)] transition-transform hover:scale-[1.03]"
            >
              Pick a world
            </a>
            <button
              type="button"
              onClick={() => go(randomRoute())}
              className="flex h-12 items-center gap-2 rounded-full bg-[#06204a]/15 px-6 text-[15px] font-bold text-white ring-1 ring-white/40 backdrop-blur-md transition-colors hover:bg-[#06204a]/25"
            >
              <Shuffle className="h-4 w-4" /> Surprise me
            </button>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <Link to="/arcade" className={chip} title="Vibey coins: earn them in the worlds, spend them in the arcade">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-[#ffd84a] text-[11px] text-[#7a4b00]">✦</span>
              {coinLabel(d.coin.balance, d.coin.display)}
            </Link>
            {price.price && (
              <a href={price.href} target="_blank" rel="noreferrer noopener" className={chip} title={`Market cap ${price.cap}`}>
                <span className="text-white/75">$VIBE</span>
                <span className="tabular-nums">{price.price}</span>
                {price.change && (
                  <span className={`tabular-nums ${price.direction === "down" ? "text-[#ffd0d0]" : "text-[#d4ffe9]"}`}>
                    {price.change}
                  </span>
                )}
              </a>
            )}
            <Link to="/passport" className={chip}>
              Passport <span className="tabular-nums text-white/75">{d.passport.visited}/{d.passport.total}</span>
            </Link>
          </div>
        </div>

        {/* The cover's islands along the bottom of the first screen. Masked at
            the top so the painted sky melts into the drawn one. */}
        <div className="relative -mt-8 h-[clamp(220px,34vw,460px)] sm:-mt-24">
          <img
            src={coverBandUrl}
            alt="A yellow robot and a dog on a hill, looking out at floating islands"
            width={1200}
            height={362}
            className="absolute inset-0 h-full w-full object-cover object-[50%_60%]"
            style={{
              maskImage: "linear-gradient(to bottom, transparent 0%, #000 34%)",
              WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, #000 34%)",
            }}
          />
          <div className="absolute inset-x-0 bottom-0 h-16" style={{ background: "linear-gradient(to bottom, transparent, #f4f9ff)" }} />
        </div>
      </section>

      {/* -------------------------------------------------------------- grid */}
      <main id="worlds" className="mx-auto max-w-6xl scroll-mt-4 px-4 pb-24 sm:px-6">
        <div className="flex flex-col gap-1 pt-6 sm:flex-row sm:items-end sm:justify-between">
          <h2 style={{ fontFamily: SERIF, fontSize: "clamp(2rem,5vw,2.9rem)" }} className="leading-none">
            Where to <em>next?</em>
          </h2>
          <p className="text-[13px] text-[#0b2a55]/55">{list.total} worlds and counting</p>
        </div>

        <div className="sticky top-0 z-20 -mx-4 mt-4 flex flex-col gap-2 bg-[#f4f9ff]/85 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div role="tablist" aria-label="Order the worlds" className="flex self-start rounded-full bg-white p-1 ring-1 ring-[#0b2a55]/10">
            {list.tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={list.sort === t.id}
                onClick={() => list.setSort(t.id)}
                className={`rounded-full px-4 py-1.5 text-[13px] font-bold transition-colors ${
                  list.sort === t.id ? "bg-[#1f9bfc] text-white" : "text-[#0b2a55]/60 hover:text-[#0b2a55]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <label className="relative block sm:w-72">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#0b2a55]/40" />
            <input
              type="search"
              value={list.query}
              onChange={(e) => list.setQuery(e.target.value)}
              placeholder="Search worlds"
              aria-label="Search worlds"
              className="h-10 w-full appearance-none rounded-full bg-white pl-10 pr-9 text-[14px] outline-none ring-1 ring-[#0b2a55]/10 placeholder:text-[#0b2a55]/40 focus:ring-2 focus:ring-[#1f9bfc] [&::-webkit-search-cancel-button]:hidden"
            />
            {list.query && (
              <button type="button" aria-label="Clear search" onClick={() => list.setQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#0b2a55]/45">
                <X className="h-4 w-4" />
              </button>
            )}
          </label>
        </div>

        <div className="mt-3 grid auto-rows-fr grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
          {list.visible.map((w) => (
            <Card key={w.key} world={w} />
          ))}
        </div>

        {list.shown.length === 0 && (
          <p className="py-16 text-center text-[15px] text-[#0b2a55]/60">Nothing called “{list.query}” yet. Try another word?</p>
        )}

        {list.collapsed && (
          <div className="mt-8 flex justify-center">
            <button
              type="button"
              onClick={list.expand}
              className="flex h-12 items-center gap-2 rounded-full bg-white px-7 text-[14px] font-bold ring-1 ring-[#0b2a55]/10 transition-shadow hover:shadow-lg"
            >
              Show all {list.shown.length} worlds <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        )}

        <footer className="mt-20 flex flex-col items-center gap-3 text-center text-[13px] text-[#0b2a55]/55">
          <span style={{ fontFamily: PIXEL }} className="text-[13px] tracking-[0.08em] text-[#0b2a55]/70">
            VIBEVERSE
          </span>
          <nav className="flex flex-wrap justify-center gap-x-5 gap-y-1">
            <Link to="/submit-world" className="hover:text-[#0b2a55]">Submit a world</Link>
            <Link to="/world-builder" className="hover:text-[#0b2a55]">World builder</Link>
            <Link to="/chronicle" className="hover:text-[#0b2a55]">Chronicle</Link>
            <Link to="/coin" className="hover:text-[#0b2a55]">About $VIBE</Link>
          </nav>
        </footer>
      </main>
    </div>
  );
}
