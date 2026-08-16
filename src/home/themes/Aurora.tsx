/**
 * Aurora — glass over a slow gradient, laid out as a bento box.
 *
 * The structural bet here is the grid: not a row of equal cards but tiles of
 * three different sizes, so the eye is given an order to read them in. Every
 * other theme with a grid says "these are all the same kind of thing"; this one
 * says "start here, then here".
 *
 * Bento only works if the sizes are genuinely different and the gaps stay
 * constant. Two sizes reads as a mistake, four reads as noise. Three, with the
 * lead tile twice the area of anything else, is the whole recipe.
 */
import { Link } from "react-router-dom";

import { AuroraWash, Grain, shortStatus, spellCount, useHomeData } from "@/home/kit";

/** Tile shapes, in order. Repeats once the list runs out. */
const SPANS = [
  "col-span-2 row-span-2",
  "col-span-1 row-span-1",
  "col-span-1 row-span-1",
  "col-span-2 row-span-1",
  "col-span-1 row-span-2",
  "col-span-1 row-span-1",
  "col-span-1 row-span-1",
  "col-span-2 row-span-1",
];

export default function Aurora() {
  const d = useHomeData();
  const cards = [...d.featured, ...d.rest].slice(0, 11);

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#0a0716] text-white">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <AuroraWash colors={["#a78bfa", "#22d3ee", "#f0abfc"]} />
        {/* The vignette has to start late. Pulled in tight it swallows the
            aurora entirely and the page becomes flat near-black with a
            gradient headline pasted on — which is what it did first. */}
        <div className="absolute inset-0 bg-[radial-gradient(135%_95%_at_50%_-14%,transparent_34%,#0a0716_94%)]" />
      </div>
      <Grain opacity={0.08} />

      <div className="relative z-10 mx-auto max-w-6xl px-5 pb-24 pt-8 sm:px-8">
        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
          <span className="font-heading text-[15px] font-black tracking-tight">vibeverse</span>
          <Link to="/game" className="text-white/60 transition-colors hover:text-white">
            Worlds
          </Link>
          <Link to="/arcade" className="text-white/60 transition-colors hover:text-white">
            Arcade
          </Link>
          <Link to="/build" className="text-white/60 transition-colors hover:text-white">
            Create
          </Link>
          <Link
            to={d.coin.signedIn ? "/shop" : "/profile"}
            className="ml-auto rounded-full border border-white/15 bg-white/5 px-3 py-1 font-mono text-[12px] text-[#a5f3fc] backdrop-blur transition-colors hover:bg-white/10"
          >
            {d.coin.signedIn ? d.coin.display : "Sign in"}
          </Link>
        </nav>

        <header className="pt-16 sm:pt-24">
          <h1 className="max-w-3xl font-heading text-[2.6rem] font-black leading-[1.02] tracking-[-0.035em] sm:text-[4.4rem]">
            {spellCount(d.counts.worlds, true)} worlds,
            <br />
            <span className="bg-gradient-to-r from-[#a78bfa] via-[#22d3ee] to-[#f0abfc] bg-clip-text text-transparent">
              one link away.
            </span>
          </h1>
          <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-white/60">
            Powered by creators, owned by players. Nothing to install and nothing
            to sign up for — every tile below is a game you are three seconds
            from playing.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              to="/game"
              className="rounded-xl bg-white px-5 py-2.5 font-heading text-[13px] font-bold text-[#0a0716] transition-transform hover:scale-[1.03]"
            >
              Start exploring
            </Link>
            <span className="text-[12.5px] text-white/45">
              {d.passport.visited} of {d.passport.total} stamped
            </span>
          </div>
        </header>

        {/* The bento. `auto-rows` fixed so a row-span-2 is genuinely double —
            with auto rows the tall tiles collapse to whatever their content
            needs and the whole thing turns back into a plain grid. */}
        <div className="mt-14 grid auto-rows-[132px] grid-cols-2 gap-3 sm:auto-rows-[164px] sm:gap-4 lg:grid-cols-4">
          {cards.map((w, i) => {
            const art = d.art(w.key);
            const span = SPANS[i % SPANS.length];
            const big = span.startsWith("col-span-2");
            return (
              <Link
                key={w.key}
                to={w.route}
                className={`${span} group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.05] backdrop-blur-xl transition-all hover:border-white/30`}
              >
                {art && (
                  <img
                    src={art}
                    alt=""
                    loading="lazy"
                    className="absolute inset-0 h-full w-full object-cover opacity-70 transition-all duration-700 group-hover:scale-105 group-hover:opacity-90"
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#0a0716]/95 via-[#0a0716]/25 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-3.5 sm:p-4">
                  {shortStatus(w.status) && big && (
                    <span className="mb-1.5 inline-block rounded-full border border-white/20 bg-white/10 px-2 py-0.5 font-heading text-[8px] font-bold uppercase tracking-[0.16em] text-white/80 backdrop-blur">
                      {shortStatus(w.status)}
                    </span>
                  )}
                  <h3
                    className={`font-heading font-bold leading-tight ${
                      big ? "text-[19px] sm:text-[24px]" : "text-[13px]"
                    }`}
                  >
                    {w.name}
                  </h3>
                  {big && (
                    <p className="mt-1 line-clamp-2 max-w-sm text-[12.5px] leading-snug text-white/60">
                      {w.blurb}
                    </p>
                  )}
                </div>
              </Link>
            );
          })}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link
            to="/game"
            className="rounded-xl border border-white/15 bg-white/5 px-5 py-3 font-heading text-[13px] font-bold backdrop-blur transition-colors hover:bg-white/10"
          >
            All {d.counts.worlds} worlds →
          </Link>
          <Link
            to="/submit-game"
            className="rounded-xl border border-white/15 bg-white/5 px-5 py-3 font-heading text-[13px] font-bold backdrop-blur transition-colors hover:bg-white/10"
          >
            Submit a game
          </Link>
        </div>
      </div>
    </div>
  );
}
