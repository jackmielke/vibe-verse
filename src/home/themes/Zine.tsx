/**
 * Zine — the mood board itself as the front door.
 *
 * Worlds pinned to a black wall at angles, different sizes, slightly
 * overlapping, with tape on the corners. The layout is deliberately *not* a
 * grid: a mood board reads as a mood board because nothing lines up, and the
 * moment these snap to columns it becomes a gallery page with a jaunty tilt.
 *
 * The angles and offsets are derived from each world's key rather than random,
 * so the wall is the same wall every time you open it. A collage that
 * reshuffles on refresh is a screensaver, and you cannot develop an affection
 * for a screensaver.
 */
import { Link } from "react-router-dom";

import { Grain, useHomeData } from "@/home/kit";

/** A small stable hash, so a world always lands in the same place. */
function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export default function Zine() {
  const d = useHomeData();
  const wall = [...d.featured, ...d.rest].slice(0, 18);

  return (
    <div className="relative min-h-[100dvh] w-full bg-[#080808] text-white">
      <Grain opacity={0.2} />

      <div className="relative z-10 mx-auto max-w-6xl px-5 pb-28 pt-6 sm:px-8">
        <nav className="flex items-center gap-5 font-mono text-[11px] uppercase tracking-[0.18em] text-white/50">
          <span className="text-white">vibeverse</span>
          <Link to="/game" className="hover:text-white">worlds</Link>
          <Link to="/arcade" className="hover:text-white">arcade</Link>
          <Link to={d.coin.signedIn ? "/shop" : "/profile"} className="ml-auto hover:underline">
            {d.coin.signedIn ? d.coin.display : "Sign in"}
          </Link>
        </nav>

        {/* Text beside the wall rather than above it. Stacked, the headline
            took the whole first screen and the pinned wall — which is the only
            reason this theme exists — began below the fold. It also reads more
            like a zine this way: the writing is pinned up among the pictures
            instead of introducing them. */}
        <div className="lg:flex lg:items-start lg:gap-10">
        <header className="relative py-12 sm:py-16 lg:sticky lg:top-6 lg:w-[36%] lg:shrink-0 lg:self-start lg:py-10">
          <h1
            className="font-heading font-black uppercase leading-[0.85] tracking-[-0.045em]"
            style={{ fontSize: "clamp(2.6rem, 9vw, 4.4rem)" }}
          >
            what kind
            <br />
            of adventure
            <br />
            <span className="text-white/35">do I want today?</span>
          </h1>
          <p className="mt-7 max-w-sm font-mono text-[12.5px] leading-relaxed text-white/55">
            {d.counts.worlds} worlds, pinned to a wall. No install, no account.
            Pull one down and you are in it.
          </p>
          <Link
            to="/game"
            className="mt-6 inline-block -rotate-1 bg-white px-5 py-2.5 font-heading text-[12px] font-black uppercase tracking-[0.16em] text-black transition-transform hover:rotate-0"
          >
            Take me somewhere
          </Link>
        </header>

        {/* The wall. `columns` rather than a grid so the cards stack at their
            own heights and the rows never line up — which is the entire look. */}
        <div className="columns-2 gap-4 sm:columns-3 lg:min-w-0 lg:flex-1 lg:pt-10 [column-fill:balance]">
          {wall.map((w) => {
            const s = seedOf(w.key);
            const tilt = (s - 0.5) * 5.4;
            const art = d.art(w.key);
            /* Three sizes, chosen by the same hash. A wall of identical
               rectangles is a grid wearing a costume. */
            const aspect = s > 0.72 ? "4/5" : s > 0.38 ? "1/1" : "16/11";
            return (
              <Link
                key={w.key}
                to={w.route}
                className="group mb-4 block break-inside-avoid transition-transform duration-300 hover:!rotate-0 hover:scale-[1.03]"
                style={{ transform: `rotate(${tilt.toFixed(2)}deg)` }}
              >
                <div className="relative bg-white p-1.5 pb-7 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.9)]">
                  {/* Tape. Two strips, slightly different angles. */}
                  <span
                    aria-hidden
                    className="absolute -top-2 left-1/2 h-4 w-14 -translate-x-1/2 rotate-[-3deg] bg-white/25 backdrop-blur-[1px]"
                  />
                  <div className="relative overflow-hidden bg-neutral-900" style={{ aspectRatio: aspect }}>
                    {art ? (
                      <img
                        src={art}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                      />
                    ) : (
                      <div
                        className="h-full w-full"
                        style={{ background: `linear-gradient(150deg, ${w.accent}55, #111)` }}
                      />
                    )}
                  </div>
                  <p className="absolute inset-x-2 bottom-1.5 truncate text-center font-mono text-[10px] text-black/70">
                    {w.name}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[11px] text-white/40">
          <span>{d.counts.worlds} worlds</span>
          <span>{d.passport.visited}/{d.passport.total} stamped</span>
          <Link to="/game" className="underline hover:text-white">see all of them →</Link>
        </div>
      </div>
    </div>
  );
}
