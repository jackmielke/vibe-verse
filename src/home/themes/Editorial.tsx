/**
 * Editorial — a design annual, not an app.
 *
 * Serif, cream paper, a rule under everything, and a hero that is mostly
 * whitespace. The bet is that the worlds look more valuable when the page
 * around them behaves like print: nothing glows, nothing floats, and the only
 * saturated colour on the page is inside a photograph.
 *
 * The lead world gets a full-width plate the way a magazine gives its opening
 * spread to one image. Everything after it is a two-column index, because a
 * contents page is exactly what this is.
 */
import { Link } from "react-router-dom";

import { Grain, useHomeData } from "@/home/kit";

const PAPER = "#faf7f0";
const INK = "#171412";

export default function Editorial() {
  const d = useHomeData();
  const [lead, ...others] = [...d.featured, ...d.rest];
  const index = others.slice(0, 14);

  return (
    <div
      className="relative min-h-[100dvh] w-full"
      style={{ background: PAPER, color: INK, fontFamily: "Georgia, 'Times New Roman', serif" }}
    >
      <Grain opacity={0.12} />

      <div className="relative mx-auto max-w-5xl px-6 pb-24 sm:px-10">
        <nav className="flex items-baseline gap-6 border-b py-5 text-[12px]" style={{ borderColor: `${INK}22` }}>
          <span className="text-[15px] font-bold italic">Vibeverse</span>
          <Link to="/game" className="opacity-60 hover:opacity-100">Worlds</Link>
          <Link to="/arcade" className="opacity-60 hover:opacity-100">Arcade</Link>
          <Link to="/chronicle" className="opacity-60 hover:opacity-100">Chronicle</Link>
          <span className="ml-auto tabular-nums opacity-45">
            №{d.counts.worlds} ·{" "}
            <Link to={d.coin.signedIn ? "/shop" : "/profile"} className="hover:underline">
              {d.coin.signedIn ? d.coin.display : "Sign in"}
            </Link>
          </span>
        </nav>

        <header className="border-b py-16 sm:py-24" style={{ borderColor: `${INK}22` }}>
          <p
            className="text-[10px] uppercase tracking-[0.42em] opacity-45"
            style={{ fontFamily: "system-ui, sans-serif" }}
          >
            Powered by creators, owned by players
          </p>
          <h1
            className="mt-6 font-normal leading-[0.94] tracking-[-0.02em]"
            style={{ fontSize: "clamp(2.8rem, 8vw, 6rem)" }}
          >
            A massive collection
            <br />
            of <span className="italic">AI-coded</span> games
          </h1>
          <div className="mt-8 grid max-w-3xl gap-6 sm:grid-cols-[1fr_auto]">
            <p className="text-[17px] leading-[1.65] opacity-75">
              {d.counts.worlds} worlds in one browser tab — no install, no
              account, no launcher. Each one was built by somebody with an idea
              and an afternoon, and every one of them opens in a few seconds.
            </p>
            <Link
              to="/game"
              className="self-end whitespace-nowrap border-b-2 pb-1 text-[13px] font-bold uppercase tracking-[0.16em]"
              style={{ borderColor: INK, fontFamily: "system-ui, sans-serif" }}
            >
              Enter →
            </Link>
          </div>
        </header>

        {/* The opening plate. One world, full width, treated like a photograph
            in a magazine rather than a card in a grid. */}
        {lead && (
          <Link to={lead.route} className="group mt-14 block">
            <div className="relative aspect-[21/9] overflow-hidden" style={{ background: `${INK}10` }}>
              {d.art(lead.key) && (
                <img
                  src={d.art(lead.key)}
                  alt=""
                  className="h-full w-full object-cover transition-transform duration-[1200ms] group-hover:scale-[1.03]"
                />
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span
                className="text-[10px] uppercase tracking-[0.28em] opacity-45"
                style={{ fontFamily: "system-ui, sans-serif" }}
              >
                Opening plate
              </span>
              <h2 className="text-3xl leading-tight">{lead.name}</h2>
              <span className="text-[12px] italic opacity-50">{d.freshness(lead.key)}</span>
            </div>
            <p className="mt-2 max-w-2xl text-[15.5px] leading-relaxed opacity-70">{lead.blurb}</p>
          </Link>
        )}

        <section className="mt-16">
          <h2
            className="border-b pb-2 text-[10px] uppercase tracking-[0.32em] opacity-45"
            style={{ borderColor: `${INK}22`, fontFamily: "system-ui, sans-serif" }}
          >
            Contents
          </h2>
          <ol className="mt-1">
            {index.map((w, i) => (
              <li key={w.key} style={{ borderColor: `${INK}14` }} className="border-b">
                <Link to={w.route} className="group flex items-baseline gap-4 py-3.5">
                  <span className="w-7 shrink-0 text-[12px] tabular-nums opacity-35">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[17px] transition-[letter-spacing] group-hover:tracking-[0.01em]">
                    {w.name}
                  </span>
                  <span className="hidden flex-1 truncate text-[13px] opacity-50 sm:block">
                    {w.blurb}
                  </span>
                  <span className="ml-auto shrink-0 text-[11.5px] italic opacity-40">
                    {d.freshness(w.key) ?? ""}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
          <Link
            to="/game"
            className="mt-6 inline-block border-b-2 pb-0.5 text-[12px] font-bold uppercase tracking-[0.16em]"
            style={{ borderColor: INK, fontFamily: "system-ui, sans-serif" }}
          >
            The full index — {d.counts.worlds} worlds
          </Link>
        </section>

        <footer
          className="mt-20 border-t pt-6 text-[12px] italic opacity-50"
          style={{ borderColor: `${INK}22` }}
        >
          Set in Georgia. Every world listed here is live, and the list is read
          from the same registry the rest of the site is.
        </footer>
      </div>
    </div>
  );
}
