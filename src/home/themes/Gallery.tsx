/**
 * Gallery — worlds hung on a wall, with brass plaques.
 *
 * The bet: almost everything on a normal games page is there to persuade you,
 * and persuasion reads as cheap. A gallery does the opposite — it puts the work
 * up, gives it far more room than it needs, writes the label small, and trusts
 * you to walk over. Nothing glows, nothing badges, nothing counts down.
 *
 * Structurally that means one very wide column, works at generous intervals
 * rather than in a grid, and a salon hang below the fold for the rest. The
 * whitespace is the design; the moment it is tightened to fit more in, this
 * becomes an ordinary list on a beige background.
 *
 * The wall is warm white with a faint vertical gradient, because a flat #fff
 * reads as a browser default rather than as a room.
 */
import { Link } from "react-router-dom";

import { Grain, useHomeData } from "@/home/kit";

const WALL = "#f2efe9";
const LABEL = "#3d3a34";
const BRASS = "#8c7434";
/* Wall text and plaques are set in a serif. Every gallery on earth does this,
   and a sans here is the single thing that makes the page read as a landing
   page wearing beige rather than as a room. */
const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';

export default function Gallery() {
  const d = useHomeData();
  const hung = d.featured.slice(0, 4);
  const salon = [...d.featured.slice(4), ...d.rest].slice(0, 18);

  return (
    <div
      className="relative min-h-[100dvh] w-full"
      style={{
        color: LABEL,
        background: `linear-gradient(180deg, #f7f5f1 0%, ${WALL} 38%, #ebe7df 100%)`,
      }}
    >
      <Grain opacity={0.16} />

      <div className="relative z-10 mx-auto max-w-5xl px-6 pb-32 pt-8 sm:px-10">
        <nav className="flex flex-wrap items-center gap-x-7 gap-y-2 text-[11.5px] tracking-[0.06em]">
          <span className="font-heading text-[12px] font-bold uppercase tracking-[0.2em]">
            Vibeverse
          </span>
          <Link to="/game" className="opacity-55 transition-opacity hover:opacity-100">Worlds</Link>
          <Link to="/arcade" className="opacity-55 transition-opacity hover:opacity-100">Arcade</Link>
          <Link to="/build" className="opacity-55 transition-opacity hover:opacity-100">Create</Link>
          <Link
            to={d.coin.signedIn ? "/shop" : "/profile"}
            className="ml-auto font-mono text-[11px] opacity-45 transition-opacity hover:opacity-100"
          >
            {d.coin.signedIn ? d.coin.display : "Sign in"}
          </Link>
        </nav>

        {/* The wall text. Small, centred, and a very long way from the works. */}
        <header className="mx-auto max-w-xl py-28 text-center sm:py-40">
          <p
            className="font-heading text-[9.5px] font-bold uppercase tracking-[0.4em]"
            style={{ color: BRASS }}
          >
            Permanent collection
          </p>
          <h1
            className="mt-6 text-[2.3rem] font-normal leading-[1.14] tracking-[-0.015em] sm:text-[3.15rem]"
            style={{ fontFamily: SERIF }}
          >
            {d.counts.worlds} worlds, made
            <br />
            by people you could meet
          </h1>
          <p
            className="mx-auto mt-7 max-w-md text-[14.5px] leading-[1.8] opacity-65"
            style={{ fontFamily: SERIF }}
          >
            Every piece here was built in an afternoon by somebody with an idea.
            Admission is free, there is nothing to install, and you are allowed to
            touch everything.
          </p>
          <p className="mt-8 font-heading text-[9.5px] uppercase tracking-[0.28em] opacity-40">
            Powered by creators · owned by players
          </p>
        </header>

        {/* The hang. Each work alone, alternating side, with its plaque. */}
        <div className="space-y-32 sm:space-y-44">
          {hung.map((w, i) => {
            const art = d.art(w.key);
            const right = i % 2 === 1;
            return (
              <article
                key={w.key}
                className={`flex flex-col gap-6 sm:flex-row sm:items-end sm:gap-10 ${
                  right ? "sm:flex-row-reverse" : ""
                }`}
              >
                <Link to={w.route} className="group block sm:flex-[3]">
                  <div
                    className="overflow-hidden bg-white p-2 sm:p-3"
                    style={{ boxShadow: "0 18px 46px rgba(60,52,38,0.16), 0 2px 6px rgba(60,52,38,0.10)" }}
                  >
                    <div className="aspect-[4/3] overflow-hidden">
                      {art && (
                        <img
                          src={art}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform duration-[1200ms] group-hover:scale-[1.03]"
                        />
                      )}
                    </div>
                  </div>
                </Link>

                {/* The plaque: a hairline rule, the title, the medium, the
                    year. Same order as a real one, same restraint. */}
                <div className="sm:flex-[2] sm:pb-2">
                  <div className="h-px w-10" style={{ background: BRASS }} />
                  <h2
                    className="mt-4 text-[21px] font-normal leading-tight sm:text-[25px]"
                    style={{ fontFamily: SERIF }}
                  >
                    <Link to={w.route} className="hover:underline">
                      {w.name}
                    </Link>
                  </h2>
                  <p className="mt-2.5 text-[14px] leading-[1.75] opacity-70" style={{ fontFamily: SERIF }}>
                    {w.blurb}
                  </p>
                  <p className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.14em] opacity-45">
                    {w.status ?? "Interactive"} · {d.freshness(w.key) ?? "in the collection"}
                  </p>
                  <Link
                    to={w.route}
                    className="mt-5 inline-block border-b pb-0.5 font-heading text-[11px] font-bold uppercase tracking-[0.18em]"
                    style={{ borderColor: BRASS, color: BRASS }}
                  >
                    Walk in →
                  </Link>
                </div>
              </article>
            );
          })}
        </div>

        {/* Salon hang. Small, close together, deliberately unlabelled — the
            back room where the rest of the collection lives. */}
        <section className="mt-36">
          <div className="flex items-baseline gap-4 border-b pb-2" style={{ borderColor: "rgba(61,58,52,0.18)" }}>
            <h2 className="font-heading text-[10px] font-bold uppercase tracking-[0.3em] opacity-55">
              The rest of the collection
            </h2>
            <Link
              to="/game"
              className="ml-auto font-heading text-[10px] uppercase tracking-[0.18em]"
              style={{ color: BRASS }}
            >
              Full catalogue →
            </Link>
          </div>

          <div className="mt-7 grid grid-cols-3 gap-3 sm:grid-cols-5 sm:gap-4">
            {salon.map((w) => {
              const art = d.art(w.key);
              return (
                <Link key={w.key} to={w.route} className="group block" title={w.name}>
                  <div
                    className="bg-white p-1"
                    style={{ boxShadow: "0 6px 18px rgba(60,52,38,0.13)" }}
                  >
                    <div className="aspect-square overflow-hidden">
                      {art && (
                        <img
                          src={art}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover transition-opacity duration-500 group-hover:opacity-80"
                        />
                      )}
                    </div>
                  </div>
                  <p className="mt-2 truncate text-[10.5px] tracking-[0.02em] opacity-55 group-hover:opacity-100">
                    {w.name}
                  </p>
                </Link>
              );
            })}
          </div>
        </section>

        <footer className="mt-28 text-center font-heading text-[9.5px] uppercase tracking-[0.3em] opacity-35">
          Open always · admission free
        </footer>
      </div>
    </div>
  );
}
