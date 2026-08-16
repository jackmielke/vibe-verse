/**
 * Riso — a two-ink risograph print, slightly out of register.
 *
 * Risograph is a duplicator, not a printer: each colour is a separate pass on a
 * drum, the paper moves a fraction between passes, and the inks are transparent
 * so where they cross you get a third colour for free. The look everybody
 * recognises comes from the mistakes — the misregistration, the halftone dots,
 * the ink that will not quite fill a solid.
 *
 * So this one is built out of those, rather than out of a filter: two offset
 * copies of the headline in fluorescent pink and blue, a dot screen over the
 * whole page, and world art forced to duotone with `mix-blend-mode` rather than
 * with a hue-rotate. Blending is the honest version — it composites the ink over
 * the paper the way the machine does, so the light parts of a photograph go to
 * paper white instead of to pale pink.
 */
import { Link } from "react-router-dom";

import { shortStatus, useHomeData } from "@/home/kit";

const PAPER = "#f7f4ea";
const PINK = "#ff48b0";
const BLUE = "#1a4bd6";
const INK = "#141414";

/** The halftone screen, as a repeating radial. Coarse on purpose. */
function Halftone({ color = INK, opacity = 0.14 }: { color?: string; opacity?: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[2]"
      style={{
        opacity,
        backgroundImage: `radial-gradient(${color} 1px, transparent 1.2px)`,
        backgroundSize: "4px 4px",
      }}
    />
  );
}

export default function Riso() {
  const d = useHomeData();
  const cards = [...d.featured, ...d.rest].slice(0, 10);

  return (
    <div
      className="relative min-h-[100dvh] w-full overflow-hidden"
      style={{ background: PAPER, color: INK }}
    >
      <Halftone />

      <div className="relative z-10 mx-auto max-w-5xl px-6 pb-24 pt-7 sm:px-10">
        <nav
          className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b-[3px] pb-3 font-heading text-[11px] font-black uppercase tracking-[0.16em]"
          style={{ borderColor: INK }}
        >
          <span>Vibeverse</span>
          <Link to="/game" className="opacity-60 hover:opacity-100">Worlds</Link>
          <Link to="/arcade" className="opacity-60 hover:opacity-100">Arcade</Link>
          <Link to="/build" className="opacity-60 hover:opacity-100">Create</Link>
          <Link
            to={d.coin.signedIn ? "/shop" : "/profile"}
            className="ml-auto px-2 py-0.5"
            style={{ background: PINK, color: PAPER }}
          >
            {d.coin.signedIn ? d.coin.display : "Sign in"}
          </Link>
        </nav>

        {/* The misregistered headline. Three stacked copies: two inks that
            missed, and the black that landed. */}
        <header className="relative pt-14 sm:pt-20">
          <div className="relative select-none">
            {/* Offsets in `em`, not px. A fixed 7px miss is a seventh of the
                cap height on a phone and a twentieth on a desktop, so the same
                number that reads as a printing error on one reads as a smear on
                the other. Tied to the type size it is one press either way. */}
            {[
              { c: PINK, dx: -0.055, dy: 0.04 },
              { c: BLUE, dx: 0.05, dy: -0.032 },
              { c: INK, dx: 0, dy: 0 },
            ].map(({ c, dx, dy }, i) => (
              <h1
                key={c}
                aria-hidden={i < 2}
                className="font-heading font-black uppercase leading-[0.8]"
                style={{
                  fontSize: "clamp(3rem, 14vw, 8.5rem)",
                  letterSpacing: "-0.045em",
                  color: c,
                  mixBlendMode: i < 2 ? "multiply" : "normal",
                  position: i < 2 ? "absolute" : "relative",
                  inset: i < 2 ? 0 : undefined,
                  transform: `translate(${dx}em, ${dy}em)`,
                }}
              >
                Play
                <br />
                Anything
              </h1>
            ))}
          </div>

          <p className="mt-7 max-w-md text-[15px] font-medium leading-relaxed">
            {d.counts.worlds} worlds, printed here in two inks and one afternoon
            each. Powered by creators, owned by players.
          </p>

          <div className="mt-6 flex flex-wrap gap-2.5">
            <Link
              to="/game"
              className="px-5 py-2.5 font-heading text-[12px] font-black uppercase tracking-[0.14em]"
              style={{ background: BLUE, color: PAPER }}
            >
              Open the index
            </Link>
            <Link
              to="/submit-game"
              className="border-[3px] px-5 py-2.5 font-heading text-[12px] font-black uppercase tracking-[0.14em]"
              style={{ borderColor: INK }}
            >
              Submit a game
            </Link>
          </div>
        </header>

        <section className="mt-16">
          <div
            className="flex items-baseline gap-3 border-b-[3px] pb-2 font-heading text-[11px] font-black uppercase tracking-[0.2em]"
            style={{ borderColor: INK }}
          >
            <span>The index</span>
            <span className="ml-auto opacity-50">{d.counts.playable} playable</span>
          </div>

          <div className="mt-6 grid gap-x-6 gap-y-9 sm:grid-cols-2">
            {cards.map((w, i) => {
              const art = d.art(w.key);
              const ink = i % 2 ? BLUE : PINK;
              return (
                <Link key={w.key} to={w.route} className="group block">
                  {/* Duotone by compositing, not by filter: the art goes to
                      greyscale, the ink sits over it in `multiply`, so paper
                      shows through the highlights. */}
                  <div
                    className="relative aspect-[3/2] overflow-hidden"
                    style={{ background: PAPER, border: `3px solid ${INK}` }}
                  >
                    {art && (
                      <img
                        src={art}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                        /* Blacks are lifted hard on purpose. A riso drum lays
                           down ink density, not darkness — it cannot print
                           black — so art left at full contrast multiplies to
                           mud and the ink never shows. Half the worlds here are
                           night scenes, which is exactly the case that fails. */
                        style={{ filter: "grayscale(1) contrast(0.72) brightness(1.62)" }}
                      />
                    )}
                    <div
                      aria-hidden
                      className="absolute inset-0 transition-opacity group-hover:opacity-60"
                      style={{ background: ink, mixBlendMode: "multiply", opacity: 0.85 }}
                    />
                    <span
                      className="absolute right-0 top-0 px-2 py-1 font-heading text-[10px] font-black tabular-nums"
                      style={{ background: INK, color: PAPER }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline gap-2">
                    <h3 className="font-heading text-[17px] font-black uppercase leading-none tracking-tight">
                      {w.name}
                    </h3>
                    {shortStatus(w.status) && (
                      <span className="font-heading text-[9px] font-black uppercase tracking-[0.14em] opacity-45">
                        {shortStatus(w.status)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[13px] leading-snug opacity-70">{w.blurb}</p>
                </Link>
              );
            })}
          </div>
        </section>

        <footer
          className="mt-16 border-t-[3px] pt-4 font-heading text-[10px] font-black uppercase tracking-[0.18em] opacity-60"
          style={{ borderColor: INK }}
        >
          Edition of {d.counts.worlds} · printed in {PINK.toUpperCase()} and {BLUE.toUpperCase()}
        </footer>
      </div>
    </div>
  );
}
