/**
 * Swiss — International Style, and the strictest page here.
 *
 * A twelve-column grid that is genuinely visible: everything on the page starts
 * and stops on a column line, the type is one family at three sizes, and the
 * only colour is a single red used for less than one percent of the surface.
 * No shadows, no rounded corners, no gradients, no icons.
 *
 * The bet is that a page this disciplined reads as *considered* in a way that no
 * amount of glass and glow can buy — and that a hundred worlds would slot into
 * it without a single decision, because the grid has already made them all.
 *
 * The rule that keeps it honest: nothing may be positioned by eye. If a thing
 * needs to move, it moves a whole column or a whole line of leading.
 */
import { Link } from "react-router-dom";

import { shortStatus, useHomeData } from "@/home/kit";

const RED = "#e2231a";
const PAPER = "#fafafa";
const INK = "#111111";

export default function Swiss() {
  const d = useHomeData();
  const cards = [...d.featured, ...d.rest].slice(0, 12);

  return (
    <div className="min-h-[100dvh] w-full" style={{ background: PAPER, color: INK }}>
      <div className="mx-auto max-w-[1180px] px-5 pb-24 sm:px-8">
        {/* Every rule on this page is 1px and #111. Two weights of rule is the
            first step back towards a flyer. */}
        <nav
          className="grid grid-cols-12 items-baseline gap-x-4 border-b py-3 text-[11px] uppercase tracking-[0.1em]"
          style={{ borderColor: INK }}
        >
          <span className="col-span-6 font-bold sm:col-span-3">Vibeverse</span>
          <Link to="/game" className="col-span-2 hidden sm:block">Worlds</Link>
          <Link to="/arcade" className="col-span-2 hidden sm:block">Arcade</Link>
          <Link to="/build" className="col-span-2 hidden sm:block">Create</Link>
          <Link
            to={d.coin.signedIn ? "/shop" : "/profile"}
            className="col-span-6 text-right sm:col-span-3"
          >
            {d.coin.signedIn ? d.coin.display : "Sign in"}
          </Link>
        </nav>

        {/* Hero: headline on columns 1–8, the abstract on 9–12, both starting
            on the same baseline. That offset is the entire composition. */}
        <header className="grid grid-cols-12 gap-x-4 gap-y-8 border-b py-14 sm:py-24" style={{ borderColor: INK }}>
          <h1
            className="col-span-12 font-heading font-bold leading-[0.88] tracking-[-0.035em] sm:col-span-8"
            style={{ fontSize: "clamp(2.6rem, 7.6vw, 6rem)" }}
          >
            Fifty-three
            <br />
            worlds. One
            <br />
            <span style={{ color: RED }}>afternoon</span> each.
          </h1>

          <div className="col-span-12 sm:col-span-4 sm:pt-2">
            <p className="text-[13.5px] leading-[1.65]">
              The Vibeverse is a collection of browser games built by people who
              had an idea in the morning and a playable link by dinner. Powered by
              creators, owned by players.
            </p>
            <dl className="mt-8 space-y-2 text-[11px] uppercase tracking-[0.1em]">
              {[
                ["Worlds", String(d.counts.worlds)],
                ["Playable now", String(d.counts.playable)],
                ["Your passport", `${d.passport.visited} / ${d.passport.total}`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between border-b pb-1.5" style={{ borderColor: "#d4d4d4" }}>
                  <dt>{k}</dt>
                  <dd className="font-bold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <Link
              to="/game"
              className="mt-8 inline-block px-6 py-3 text-[11px] font-bold uppercase tracking-[0.14em]"
              style={{ background: RED, color: PAPER }}
            >
              Index →
            </Link>
          </div>
        </header>

        <div className="grid grid-cols-12 gap-x-4 pt-8">
          <h2 className="col-span-12 mb-6 text-[11px] font-bold uppercase tracking-[0.14em] sm:col-span-3">
            Selected works
          </h2>
          <p className="col-span-12 mb-8 text-[11px] uppercase tracking-[0.1em] sm:col-span-9 sm:text-right">
            {String(cards.length).padStart(2, "0")} of {d.counts.worlds}
          </p>
        </div>

        {/* Cards are three columns wide and share one rule between rows, which
            is why they carry no border of their own. */}
        <div className="grid grid-cols-12 gap-x-4 gap-y-12">
          {cards.map((w, i) => (
            <Link key={w.key} to={w.route} className="group col-span-6 sm:col-span-4 lg:col-span-3">
              <div className="aspect-[4/3] overflow-hidden" style={{ background: "#e5e5e5" }}>
                {d.art(w.key) && (
                  <img
                    src={d.art(w.key)}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition-opacity duration-300 group-hover:opacity-75"
                  />
                )}
              </div>
              <div className="mt-3 flex items-baseline gap-2 border-t pt-2" style={{ borderColor: INK }}>
                <span className="text-[10px] tabular-nums" style={{ color: RED }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="font-heading text-[15px] font-bold leading-tight tracking-tight">
                  {w.name}
                </h3>
              </div>
              <p className="mt-1.5 line-clamp-3 text-[12px] leading-[1.55] text-neutral-600">
                {w.blurb}
              </p>
              <p className="mt-2 text-[10px] uppercase tracking-[0.1em] text-neutral-400">
                {shortStatus(w.status) ?? "World"}
              </p>
            </Link>
          ))}
        </div>

        <footer
          className="mt-20 grid grid-cols-12 gap-x-4 border-t pt-4 text-[10px] uppercase tracking-[0.1em]"
          style={{ borderColor: INK }}
        >
          <span className="col-span-6">Vibeverse</span>
          <span className="col-span-6 text-right">Built in the open</span>
        </footer>
      </div>
    </div>
  );
}
