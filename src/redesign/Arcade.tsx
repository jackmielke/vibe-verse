/**
 * Direction B, "Arcade": the pixel half of the cover, turned up.
 *
 * The cover itself is the title screen, framed like a cabinet, with PRESS
 * START under it. The coins, the $VIBE price and the passport are a game HUD
 * along the top, because that is what a number in the corner of a game is.
 * Worlds are chunky cartridges with hard shadows. Still the cover's blue and
 * still bright: playful rather than neon.
 */
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";

import { useHomeData } from "@/home/kit";
import VibeMark from "@/components/VibeMark";
import Account from "./Account";
import {
  CardArt,
  CoverFonts,
  PIXEL,
  ROUND,
  SANS,
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
import { WHATS_NEW, shortDay, useUnseenCount } from "@/whatsnew";

const NAVY = "#06204a";
const BLUE = "#1585f5";
const SUN = "#ffd23f";

const block = (lift = 5) =>
  ({ border: `3px solid ${NAVY}`, boxShadow: `${lift}px ${lift}px 0 ${NAVY}` }) as const;

function HudBox({ label, children, href, to }: { label: string; children: ReactNode; href?: string; to?: string }) {
  const inner = (
    <>
      <span className="text-[10px] tracking-[0.12em] text-[#06204a]/55">{label}</span>
      <span className="text-[13px] tabular-nums leading-none sm:text-[15px]">{children}</span>
    </>
  );
  const cls =
    "flex h-11 flex-col justify-center gap-0.5 rounded-[6px] bg-white px-3 text-left transition-transform hover:-translate-x-px hover:-translate-y-px";
  const style = { ...block(3), fontFamily: PIXEL, color: NAVY };
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={cls} style={style}>
        {inner}
      </a>
    );
  return (
    <Link to={to ?? "/"} className={cls} style={style}>
      {inner}
    </Link>
  );
}

function Cartridge({ world, n }: { world: WorldEntry; n: number }) {
  const { hovering, bind } = useHover();
  const status = shortStatus(world);
  return (
    <Link
      to={world.route}
      {...bind}
      className="group flex h-full flex-col overflow-hidden rounded-[8px] bg-white transition-[transform,box-shadow] duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:!shadow-[8px_8px_0_#06204a] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#ffd23f]"
      style={block(5)}
    >
      <div className="relative" style={{ borderBottom: `3px solid ${NAVY}` }}>
        <CardArt world={world} hovering={hovering} />
        <span
          className="absolute right-2 top-2 rounded-[4px] bg-white px-1.5 py-0.5 text-[11px] leading-none"
          style={{ fontFamily: PIXEL, color: NAVY, border: `2px solid ${NAVY}` }}
        >
          #{String(n).padStart(2, "0")}
        </span>
      </div>
      <div className="flex flex-1 flex-col p-2.5 sm:p-3.5">
        <h3 className="text-[15px] font-bold leading-tight sm:text-[18px]" style={{ fontFamily: ROUND, color: NAVY }}>
          {world.name}
        </h3>
        <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-[#06204a]/70 sm:text-[13px]">{world.blurb}</p>
        {status && (
          <span
            className="mt-auto self-start truncate rounded-[4px] px-1.5 py-[3px] text-[10px] font-bold uppercase leading-none tracking-[0.06em]"
            style={{ fontFamily: ROUND, background: world.accent, color: NAVY, border: `2px solid ${NAVY}`, marginTop: "0.6rem", maxWidth: "100%" }}
          >
            {status}
          </span>
        )}
      </div>
    </Link>
  );
}

export default function Arcade() {
  usePreloadFonts();
  const d = useHomeData();
  const list = useWorldList();
  const price = usePrice();
  const unseen = useUnseenCount();
  const go = useNavigate();

  return (
    <div
      className="min-h-[100dvh] w-full"
      style={{
        fontFamily: SANS,
        color: NAVY,
        backgroundColor: BLUE,
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.07) 2px, transparent 2px), linear-gradient(90deg, rgba(255,255,255,0.07) 2px, transparent 2px)",
        backgroundSize: "32px 32px",
      }}
    >
      <CoverFonts />
      <style>{`
        @keyframes vv-blink{0%,55%{opacity:1}56%,100%{opacity:.25}}
        .vv-blink{animation:vv-blink 1.1s steps(1) infinite}
        @media (prefers-reduced-motion: reduce){.vv-blink{animation:none}}
      `}</style>

      {/* -------------------------------------------------------------- HUD */}
      <header className="mx-auto flex max-w-6xl 2xl:max-w-7xl flex-wrap items-center gap-2 px-4 pt-4 sm:gap-3 sm:px-6 sm:pt-5">
        <Link to="/" className="mr-auto flex items-center gap-2 text-[20px] text-white sm:gap-3 sm:text-[26px]" style={{ fontFamily: PIXEL, fontWeight: 700, textShadow: `3px 3px 0 ${NAVY}` }}>
          {/* The 3D wink, kept from the old front door at Jack's request. */}
          <VibeMark size={52} rotateSeconds={30} priority className="shrink-0" />
          VIBEVERSE
        </Link>
        <div className="order-last flex w-full gap-2 sm:order-none sm:w-auto sm:gap-3 [&>*]:flex-1 sm:[&>*]:flex-none">
          <HudBox label="COINS" to="/arcade">
            ✦ {coinLabel(d.coin.balance, d.coin.display).replace(" coins", "")}
          </HudBox>
          {price.cap && (
            <HudBox label="$VIBE MCAP" href={price.href}>
              {price.cap}
              {price.change && (
                <span className={price.direction === "down" ? "ml-1.5 text-[#d1344b]" : "ml-1.5 text-[#0f9d58]"}>
                  {price.direction === "down" ? "▼" : "▲"}
                  {price.change.replace(/^[+−]/, "")}
                </span>
              )}
            </HudBox>
          )}
          <HudBox label="STAMPS" to="/passport">
            {d.passport.visited}/{d.passport.total}
          </HudBox>
          <HudBox label="WHAT'S NEW" to="/whats-new">
            <span className="relative">
              ✨ {shortDay(WHATS_NEW[0].date).toUpperCase()}
              {unseen > 0 && <span className="vv-blink absolute -right-3 -top-1 h-2 w-2 rounded-full bg-[#d1344b]" aria-label={`${unseen} new`} />}
            </span>
          </HudBox>
        </div>
        <Account
          className="h-11 rounded-[6px] px-4 text-[14px] transition-transform hover:-translate-x-px hover:-translate-y-px"
          signedOut="SIGN IN"
          style={{ fontFamily: PIXEL, background: SUN, color: NAVY, ...block(3) }}
        >
          {(name) => name.toUpperCase()}
        </Account>
      </header>
      {/* ------------------------------------------------------ title screen */}
      <section className="mx-auto grid max-w-6xl 2xl:max-w-7xl gap-6 px-4 pt-6 sm:px-6 sm:pt-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center lg:gap-10">
        <div className="overflow-hidden rounded-[10px] bg-white" style={block(8)}>
          <img src={coverUrl} alt="The VibeVerse cover: a robot and a dog looking out at floating islands" width={1200} height={630} className="block aspect-[1200/630] w-full object-cover" />
          <div className="flex items-center gap-2 p-2.5 sm:p-3" style={{ borderTop: `3px solid ${NAVY}`, background: NAVY }}>
            <a
              href="#worlds"
              className="flex h-11 flex-1 items-center justify-center rounded-[6px] text-[15px] sm:text-[17px]"
              style={{ fontFamily: PIXEL, fontWeight: 700, background: SUN, color: NAVY, border: `3px solid ${NAVY}`, boxShadow: "0 0 0 2px #fff" }}
            >
              <span className="vv-blink">▶ PRESS START</span>
            </a>
            <button
              type="button"
              onClick={() => go(randomRoute())}
              className="h-11 rounded-[6px] bg-white px-4 text-[14px]"
              style={{ fontFamily: PIXEL, color: NAVY, border: `3px solid ${NAVY}`, boxShadow: "0 0 0 2px #fff" }}
            >
              ? RANDOM
            </button>
          </div>
        </div>

        <div className="rounded-[10px] bg-white p-5 sm:p-6" style={block(8)}>
          <p className="text-[12px] tracking-[0.14em] text-[#1585f5]" style={{ fontFamily: PIXEL }}>
            PLAYER 1, READY?
          </p>
          <h1 className="mt-2 text-[30px] font-bold leading-[1.02] sm:text-[40px]" style={{ fontFamily: ROUND }}>
            What kind of adventure do you want today?
          </h1>
          <p className="mt-3 text-[14.5px] leading-relaxed text-[#06204a]/75">
            {d.counts.worlds} worlds and games, all made with AI, all playable in your browser. No download, no account.
            Earn coins as you go and collect a stamp for every world you visit.
          </p>
          <div className="mt-5 grid grid-cols-3 gap-2 text-center" style={{ fontFamily: ROUND }}>
            {[
              [String(d.counts.worlds), "WORLDS"],
              [String(d.counts.playable), "PLAYABLE"],
              [`${d.passport.visited}`, "VISITED"],
            ].map(([v, l]) => (
              <div key={l} className="rounded-[6px] bg-[#eaf4ff] py-2.5" style={{ border: `2px solid ${NAVY}` }}>
                <div className="text-[24px] font-bold leading-none">{v}</div>
                <div className="mt-1 text-[10px] font-semibold tracking-[0.1em] text-[#06204a]/60">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- the worlds */}
      <main id="worlds" className="mx-auto max-w-6xl 2xl:max-w-7xl scroll-mt-2 px-4 pb-28 pt-12 sm:px-6">
        <h2 className="text-[28px] font-bold text-white sm:text-[36px]" style={{ fontFamily: ROUND, textShadow: `3px 3px 0 ${NAVY}` }}>
          Select a world <span className="align-middle text-[0.6em] text-white/70">{list.total}</span>
        </h2>

        <div className="sticky top-0 z-20 -mx-4 mt-3 flex flex-col gap-2 px-4 py-3 sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6" style={{ background: `${BLUE}f2` }}>
          <div role="tablist" aria-label="Order the worlds" className="flex gap-2">
            {list.tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={list.sort === t.id}
                onClick={() => list.setSort(t.id)}
                className="h-10 rounded-[6px] px-4 text-[15px] font-bold transition-transform active:translate-x-px active:translate-y-px"
                style={{
                  fontFamily: ROUND,
                  border: `3px solid ${NAVY}`,
                  background: list.sort === t.id ? SUN : "#fff",
                  boxShadow: list.sort === t.id ? `1px 1px 0 ${NAVY}` : `3px 3px 0 ${NAVY}`,
                  transform: list.sort === t.id ? "translate(2px,2px)" : undefined,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <label className="relative block sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
            <input
              type="search"
              value={list.query}
              onChange={(e) => list.setQuery(e.target.value)}
              placeholder="Search worlds"
              aria-label="Search worlds"
              className="h-10 w-full appearance-none rounded-[6px] bg-white pl-9 pr-9 text-[15px] font-semibold outline-none placeholder:text-[#06204a]/40 focus:bg-[#fffbe6] [&::-webkit-search-cancel-button]:hidden"
              style={{ fontFamily: ROUND, border: `3px solid ${NAVY}`, boxShadow: `3px 3px 0 ${NAVY}` }}
            />
            {list.query && (
              <button type="button" aria-label="Clear search" onClick={() => list.setQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2">
                <X className="h-4 w-4" />
              </button>
            )}
          </label>
        </div>

        <div className="mt-4 grid auto-rows-fr grid-cols-2 gap-3.5 sm:gap-5 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {list.shown.map((w, i) => (
            <Cartridge key={w.key} world={w} n={i + 1} />
          ))}
        </div>

        {list.shown.length === 0 && (
          <p className="py-16 text-center text-[20px] font-bold text-white" style={{ fontFamily: ROUND }}>
            No world by that name. Try again?
          </p>
        )}


        <footer className="mt-20 flex flex-col items-center gap-3 text-center font-semibold text-white" style={{ fontFamily: ROUND }}>
          <Link to="/submit-world" className="text-[18px] hover:underline" style={{ textShadow: `2px 2px 0 ${NAVY}` }}>
            Insert coin: submit a world
          </Link>
          <nav className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-[13px] text-white/80">
            <Link to="/world-builder" className="hover:text-white">World builder</Link>
            <Link to="/chronicle" className="hover:text-white">Chronicle</Link>
            <Link to="/coin" className="hover:text-white">About $VIBE</Link>
          </nav>
        </footer>
      </main>
    </div>
  );
}
