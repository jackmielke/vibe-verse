/**
 * Alpine — a mid-century travel poster.
 *
 * Flat blocks of colour, a hard diagonal horizon, and type set enormous and
 * condensed. No photographs in the furniture at all: the only images on the
 * page are the worlds themselves, which is what makes them read as the
 * destinations on a poster rather than as thumbnails in a grid.
 *
 * Warm paper, cold sky, one red. Restraint in the palette is the whole trick —
 * a poster with five colours is a poster; with nine it is a flyer.
 */
import { Link } from "react-router-dom";

import { Grain, shortStatus, useHomeData } from "@/home/kit";

const PAPER = "#f3ead9";
const INK = "#1b2430";
const SKY = "#2f6f8f";
const SUN = "#e8622c";

export default function Alpine() {
  const d = useHomeData();
  const cards = [...d.featured, ...d.rest].slice(0, 9);

  return (
    <div className="relative min-h-[100dvh] w-full" style={{ background: PAPER, color: INK }}>
      <Grain opacity={0.22} />

      {/* The poster's sky, cut on a diagonal. One shape, and it sets the
          whole layout — everything above the cut is inverted. */}
      <div className="relative overflow-hidden" style={{ background: SKY }}>
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-32"
          style={{ background: PAPER, clipPath: "polygon(0 100%, 100% 22%, 100% 100%)" }}
        />
        <div
          aria-hidden
          className="absolute rounded-full"
          style={{ width: 190, height: 190, right: "12%", top: "14%", background: SUN, opacity: 0.95 }}
        />

        <div className="relative mx-auto max-w-6xl px-6 pb-36 pt-6 sm:px-10">
          <nav className="flex items-center gap-6 font-heading text-[11px] font-bold uppercase tracking-[0.2em] text-white/85">
            <span className="text-white">Vibeverse</span>
            <Link to="/game" className="hover:text-white">Worlds</Link>
            <Link to="/arcade" className="hover:text-white">Arcade</Link>
            <Link to="/build" className="hover:text-white">Create</Link>
            <Link
              to={d.coin.signedIn ? "/shop" : "/profile"}
              className="ml-auto rounded-sm px-2 py-1"
              style={{ background: SUN, color: PAPER }}
            >
              {d.coin.signedIn ? d.coin.display : "Sign in"}
            </Link>
          </nav>

          <p className="mt-20 font-heading text-[10px] font-bold uppercase tracking-[0.4em] text-white/70">
            Powered by creators · owned by players
          </p>
          <h1
            className="mt-3 font-heading font-black uppercase leading-[0.82] text-white"
            style={{ fontSize: "clamp(3.2rem, 13vw, 9rem)", letterSpacing: "-0.04em" }}
          >
            Vibe
            <br />
            Verse
          </h1>
          <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-white/85">
            {d.counts.worlds} worlds. No install, no account, no launcher. Pick a
            card and you are in it in a few seconds.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 pb-24 sm:px-10">
        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            to="/game"
            className="rounded-sm px-6 py-3 font-heading text-[12px] font-black uppercase tracking-[0.18em]"
            style={{ background: SUN, color: PAPER }}
          >
            Explore worlds
          </Link>
          <Link
            to="/chronicle"
            className="rounded-sm border-2 px-6 py-3 font-heading text-[12px] font-black uppercase tracking-[0.18em]"
            style={{ borderColor: INK, color: INK }}
          >
            The chronicle
          </Link>
        </div>

        <div className="mt-14 flex flex-wrap items-end gap-x-10 gap-y-4 border-y-2 py-5" style={{ borderColor: INK }}>
          {[
            [String(d.counts.worlds), "Worlds"],
            [String(d.counts.playable), "Playable"],
            [`${d.passport.visited}/${d.passport.total}`, "Passport"],
          ].map(([v, k]) => (
            <div key={k}>
              <div className="font-heading text-4xl font-black leading-none tabular-nums">{v}</div>
              <div className="mt-1 font-heading text-[9.5px] font-bold uppercase tracking-[0.24em] opacity-60">
                {k}
              </div>
            </div>
          ))}
          <p className="ml-auto max-w-xs text-[12px] leading-relaxed opacity-70">
            Every world here was built by somebody with an idea and an afternoon.
          </p>
        </div>

        <section className="mt-12">
          <h2 className="font-heading text-[11px] font-black uppercase tracking-[0.28em] opacity-55">
            The destinations
          </h2>
          <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((w, i) => {
              const art = d.art(w.key);
              return (
                <Link key={w.key} to={w.route} className="group block">
                  <div
                    className="relative aspect-[4/5] overflow-hidden"
                    style={{ background: INK, border: `2px solid ${INK}` }}
                  >
                    {art && (
                      <img
                        src={art}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition-all duration-700 group-hover:scale-[1.04]"
                        style={{ filter: "saturate(0.85) contrast(1.06)" }}
                      />
                    )}
                    <span
                      className="absolute left-0 top-0 px-2.5 py-1 font-heading text-[9px] font-black uppercase tracking-[0.16em]"
                      style={{ background: SUN, color: PAPER }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {shortStatus(w.status) && (
                      <span
                        className="absolute bottom-0 right-0 px-2.5 py-1 font-heading text-[8.5px] font-black uppercase tracking-[0.14em]"
                        style={{ background: PAPER, color: INK }}
                      >
                        {shortStatus(w.status)}
                      </span>
                    )}
                  </div>
                  <h3 className="mt-2.5 font-heading text-lg font-black uppercase leading-none tracking-tight">
                    {w.name}
                  </h3>
                  <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug opacity-65">{w.blurb}</p>
                </Link>
              );
            })}
          </div>
        </section>

        <footer className="mt-16 border-t-2 pt-5 font-heading text-[10px] font-bold uppercase tracking-[0.2em] opacity-55" style={{ borderColor: INK }}>
          Vibeverse · {d.counts.worlds} worlds · built in the open
        </footer>
      </div>
    </div>
  );
}
