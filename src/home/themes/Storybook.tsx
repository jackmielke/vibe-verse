/**
 * Storybook — a picture book, opened flat.
 *
 * Two facing pages with a gutter shadow down the middle, a hand-lettered feel,
 * and worlds introduced the way a book introduces places rather than the way a
 * store lists products: one per spread opening, in a sentence, with the picture
 * doing the persuading.
 *
 * The reason it belongs among the fifteen is that the vibeverse is a *place*,
 * and every other theme here sells it as a catalogue. This one is the only
 * layout that has a beginning. It is also the one a nine-year-old would pick,
 * which is not a small consideration for a hub of browser games.
 *
 * The illustration trick: no illustrations. The card art is real, and it reads
 * as painted because of the rounded frame, the warm paper it sits on, and a
 * very slight saturation lift — nothing that would survive being described as a
 * filter, and nothing that lies about what the world looks like.
 */
import { Link } from "react-router-dom";

import { Grain, useHomeData } from "@/home/kit";

const PAGE = "#fdf6e8";
const INK = "#3b2f26";
const BERRY = "#c0442f";
const LEAF = "#3f7a54";

/* Deterministic, so the book is the same book every time it is opened. */
const tilt = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ((h % 500) / 100 - 2.5).toFixed(2);
};

export default function Storybook() {
  const d = useHomeData();
  const spreads = [...d.featured, ...d.rest].slice(0, 6);
  const contents = [...d.featured, ...d.rest].slice(6, 20);

  return (
    <div
      className="relative min-h-[100dvh] w-full overflow-hidden py-6 sm:py-10"
      style={{ background: "#8f7a5f", color: INK }}
    >
      <Grain opacity={0.2} />

      <div className="relative z-10 mx-auto max-w-5xl px-3 sm:px-6">
        {/* The book itself: one surface with a gutter painted down the middle,
            so both halves are genuinely one sheet rather than two cards. */}
        <div
          className="relative overflow-hidden rounded-[10px]"
          style={{
            background: PAGE,
            boxShadow: "0 40px 90px rgba(0,0,0,0.45), 0 2px 0 rgba(255,255,255,0.5) inset",
          }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-16 -translate-x-1/2 sm:block"
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(90,66,40,0.16) 42%, rgba(90,66,40,0.22) 50%, rgba(90,66,40,0.16) 58%, transparent)",
            }}
          />

          <div className="relative px-6 py-9 sm:px-12 sm:py-14">
            <nav className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-[12px]">
              <span className="font-heading text-[13px] font-black">The Vibeverse</span>
              <Link to="/game" className="opacity-60 hover:opacity-100">Worlds</Link>
              <Link to="/arcade" className="opacity-60 hover:opacity-100">Arcade</Link>
              <Link to="/build" className="opacity-60 hover:opacity-100">Create</Link>
              <Link
                to={d.coin.signedIn ? "/shop" : "/profile"}
                className="ml-auto opacity-60 hover:opacity-100"
              >
                {d.coin.signedIn ? d.coin.display : "Sign in"}
              </Link>
            </nav>

            {/* Title page. Centred over the gutter, as a title page is. */}
            <header className="py-16 text-center sm:py-24">
              <p className="font-heading text-[10px] font-bold uppercase tracking-[0.36em]" style={{ color: BERRY }}>
                A book of places
              </p>
              <h1
                className="mx-auto mt-5 max-w-2xl font-heading font-black leading-[0.9] tracking-[-0.03em]"
                style={{ fontSize: "clamp(2.6rem, 8vw, 5rem)" }}
              >
                Fifty-three
                <br />
                worlds
              </h1>
              <p className="mx-auto mt-6 max-w-sm text-[14.5px] leading-[1.75] opacity-75">
                Every one of them made by somebody with an idea and an afternoon.
                Turn the page and pick one — you can be inside it before the
                kettle boils.
              </p>
              {/* The ornament. Every title page has one, it costs three
                  divs, and without it the page reads as a hero section on
                  cream rather than as the front of a book. */}
              <div aria-hidden className="mt-9 flex items-center justify-center gap-3">
                <span className="h-px w-16 sm:w-24" style={{ background: "rgba(59,47,38,0.3)" }} />
                <span className="text-[13px]" style={{ color: BERRY }}>❧</span>
                <span className="h-px w-16 sm:w-24" style={{ background: "rgba(59,47,38,0.3)" }} />
              </div>
              <p className="mt-6 font-heading text-[9.5px] uppercase tracking-[0.3em] opacity-45">
                Powered by creators · owned by players
              </p>
            </header>

            {/* Spreads. Art on one side, a sentence on the other, alternating —
                which is exactly what a picture book does and why it never gets
                boring at six repetitions. */}
            <div className="space-y-16 sm:space-y-24">
              {spreads.map((w, i) => {
                const flip = i % 2 === 1;
                return (
                  <article
                    key={w.key}
                    className={`flex flex-col items-center gap-6 sm:flex-row sm:gap-12 ${
                      flip ? "sm:flex-row-reverse" : ""
                    }`}
                  >
                    <Link to={w.route} className="group w-full sm:w-1/2">
                      <div
                        className="overflow-hidden rounded-[22px] border-[6px] border-white transition-transform duration-500 group-hover:rotate-0"
                        style={{
                          transform: `rotate(${tilt(w.key)}deg)`,
                          boxShadow: "0 14px 34px rgba(59,47,38,0.28)",
                        }}
                      >
                        <div className="aspect-[4/3]">
                          {d.art(w.key) && (
                            <img
                              src={d.art(w.key)}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                              style={{ filter: "saturate(1.12) contrast(1.03)" }}
                            />
                          )}
                        </div>
                      </div>
                    </Link>

                    <div className={`w-full sm:w-1/2 ${flip ? "sm:text-right" : ""}`}>
                      <span
                        className="font-heading text-[10px] font-bold uppercase tracking-[0.24em]"
                        style={{ color: i % 3 === 1 ? LEAF : BERRY }}
                      >
                        Chapter {i + 1}
                      </span>
                      <h2 className="mt-2 font-heading text-[30px] font-black leading-[0.95] tracking-tight sm:text-[38px]">
                        <Link to={w.route} className="hover:underline">
                          {w.name}
                        </Link>
                      </h2>
                      <p className="mt-3 text-[14.5px] leading-[1.8] opacity-80">{w.blurb}</p>
                      <Link
                        to={w.route}
                        className="mt-5 inline-block rounded-full px-5 py-2.5 font-heading text-[12px] font-bold text-white"
                        style={{ background: i % 3 === 1 ? LEAF : BERRY }}
                      >
                        Go there →
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>

            {/* The index at the back, as every book has. */}
            <section className="mt-24 border-t pt-8" style={{ borderColor: "rgba(59,47,38,0.2)" }}>
              <h2 className="text-center font-heading text-[11px] font-bold uppercase tracking-[0.28em] opacity-55">
                The rest of the book
              </h2>
              <ul className="mx-auto mt-6 max-w-2xl columns-1 gap-x-10 sm:columns-2">
                {contents.map((w, i) => (
                  <li key={w.key} className="break-inside-avoid py-1.5">
                    <Link
                      to={w.route}
                      className="flex items-baseline gap-2 text-[13.5px] hover:underline"
                    >
                      <span className="font-heading font-bold">{w.name}</span>
                      <span
                        aria-hidden
                        className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted"
                        style={{ borderColor: "rgba(59,47,38,0.35)" }}
                      />
                      <span className="font-mono text-[11px] tabular-nums opacity-50">
                        {String(i + 7).padStart(2, "0")}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>

              <div className="mt-10 text-center">
                <Link
                  to="/game"
                  className="inline-block rounded-full border-2 px-6 py-3 font-heading text-[12px] font-bold"
                  style={{ borderColor: INK }}
                >
                  All {d.counts.worlds} worlds →
                </Link>
              </div>
            </section>
          </div>
        </div>

        <p className="mt-5 text-center font-heading text-[10px] uppercase tracking-[0.28em] text-white/45">
          Vibeverse · first edition · still being written
        </p>
      </div>
    </div>
  );
}
