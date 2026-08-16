/**
 * Field — a trail guide, and the only theme with no grid at all.
 *
 * Worlds hang off a single dotted line running down the page, alternating left
 * and right, the way stops are drawn on a route map. It is a deliberately
 * inefficient way to show fifty-three of anything, and that is the argument it
 * is making: a grid says "choose"; a trail says "go in this order, and here is
 * how far you have got".
 *
 * That makes the passport the point rather than a statistic. A stop you have
 * stamped is filled in and dated; one you have not is an open circle further
 * along the path. Nothing else on the page competes with that.
 *
 * The line is a border on a centred column rather than an SVG, so it stretches
 * to whatever the content ends up being and costs nothing.
 */
import { Link } from "react-router-dom";

import { Grain, Topo, shortStatus, useHomeData } from "@/home/kit";

const KRAFT = "#e8dfcc";
const INK = "#2a2620";
const MOSS = "#4a6d4a";
const RUST = "#b1502a";

export default function Field() {
  const d = useHomeData();
  const seen = d.visited;
  const stops = [...d.featured, ...d.rest].slice(0, 14);

  return (
    <div className="relative min-h-[100dvh] w-full" style={{ background: KRAFT, color: INK }}>
      <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-70" aria-hidden>
        <Topo color="rgba(42,38,32,0.10)" />
      </div>
      <Grain opacity={0.3} />

      <div className="relative z-10 mx-auto max-w-3xl px-6 pb-28 pt-8 sm:px-8">
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.14em]">
          <span className="font-bold">Vibeverse Field Guide</span>
          <Link to="/game" className="opacity-60 hover:opacity-100">Worlds</Link>
          <Link to="/arcade" className="opacity-60 hover:opacity-100">Arcade</Link>
          <Link to={d.coin.signedIn ? "/shop" : "/profile"} className="ml-auto opacity-60 hover:opacity-100">
            {d.coin.signedIn ? d.coin.display : "Sign in"}
          </Link>
        </nav>

        <header className="mt-14 border-y-2 py-8 text-center" style={{ borderColor: INK }}>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.3em] opacity-55">
            Powered by creators · owned by players
          </p>
          <h1 className="mt-3 font-heading text-[2.7rem] font-black leading-[0.95] tracking-tight sm:text-[3.6rem]">
            The Vibeverse
          </h1>
          <p className="mx-auto mt-4 max-w-md text-[14.5px] leading-relaxed opacity-75">
            {d.counts.worlds} places you can walk, fly, drive and shoot your way
            through. This is the route. Start anywhere; the guide keeps count.
          </p>

          <div className="mt-6 inline-flex items-center gap-5 font-mono text-[11px] uppercase tracking-[0.12em]">
            <span>
              <strong className="text-[15px] tabular-nums">{d.passport.visited}</strong>
              <span className="opacity-55"> / {d.passport.total} stamped</span>
            </span>
            <span className="h-4 w-px" style={{ background: INK, opacity: 0.25 }} />
            <Link to="/passport" className="underline decoration-dotted underline-offset-4">
              Open passport
            </Link>
          </div>
        </header>

        {/* The trail. One dotted rule down the middle; stops alternate. */}
        <ol className="relative mt-12">
          <div
            aria-hidden
            className="absolute inset-y-0 left-[13px] w-0 border-l-2 border-dotted sm:left-1/2"
            style={{ borderColor: INK, opacity: 0.35 }}
          />

          {stops.map((w, i) => {
            const art = d.art(w.key);
            const been = seen.has(w.route);
            const right = i % 2 === 1;
            return (
              <li
                key={w.key}
                className={`relative pb-10 pl-10 sm:w-1/2 sm:pl-0 ${
                  right ? "sm:ml-auto sm:pl-10" : "sm:pr-10 sm:text-right"
                }`}
              >
                {/* The marker sits on the line, so its offset has to mirror. */}
                <span
                  aria-hidden
                  className={`absolute top-1.5 grid h-[26px] w-[26px] place-items-center rounded-full border-2 font-mono text-[10px] font-bold tabular-nums ${
                    right ? "left-0 sm:-left-[13px]" : "left-0 sm:left-auto sm:-right-[13px]"
                  }`}
                  style={{
                    borderColor: been ? MOSS : INK,
                    background: been ? MOSS : KRAFT,
                    color: been ? KRAFT : INK,
                  }}
                >
                  {been ? "✓" : i + 1}
                </span>

                <Link to={w.route} className="group block">
                  <div className={`flex items-baseline gap-2 ${right ? "" : "sm:justify-end"}`}>
                    <h3 className="font-heading text-[20px] font-black leading-none tracking-tight group-hover:underline">
                      {w.name}
                    </h3>
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] opacity-45">
                      {shortStatus(w.status) ?? "world"}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[13px] leading-snug opacity-70">{w.blurb}</p>

                  {art && (
                    <div
                      className="mt-3 aspect-[5/3] overflow-hidden border-2"
                      style={{ borderColor: INK }}
                    >
                      <img
                        src={art}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                        style={{ filter: "sepia(0.28) saturate(0.9) contrast(1.05)" }}
                      />
                    </div>
                  )}

                  <p
                    className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em]"
                    style={{ color: been ? MOSS : RUST }}
                  >
                    {been ? `Visited · ${d.freshness(w.key) ?? "logged"}` : "Not yet walked"}
                  </p>
                </Link>
              </li>
            );
          })}
        </ol>

        <div className="relative mt-2 text-center">
          <Link
            to="/game"
            className="inline-block border-2 px-6 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.16em]"
            style={{ borderColor: INK, background: KRAFT }}
          >
            The rest of the map — all {d.counts.worlds} →
          </Link>
        </div>
      </div>
    </div>
  );
}
