/**
 * Blueprint — the vibeverse as a technical drawing.
 *
 * Cyanotype blue, a ruled grid that everything sits on, dimension lines with
 * arrowheads, and each world given a part number and a revision date. The cards
 * are drawings of cards: a hairline box, a title block along the bottom, the
 * art dropped in as if it were a photograph pasted onto a plan.
 *
 * What makes it worth building rather than just tinting a page blue is that the
 * repository already knows the things a title block wants — when a world last
 * changed, whether it is playable, what it is called — so the drawing is filled
 * in with facts rather than with lorem. A blueprint with made-up numbers on it
 * is a wallpaper.
 */
import { Link } from "react-router-dom";

import { BlueprintGrid, shortStatus, useHomeData } from "@/home/kit";

const BLUE = "#0d2a5c";
const LINE = "rgba(190,220,255,0.55)";
const CHALK = "#dceaff";

/** A dimension line with tick ends. Pure decoration, drawn honestly. */
function Dim({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2" style={{ color: LINE }}>
      <span className="h-2.5 w-px" style={{ background: LINE }} />
      <span className="h-px flex-1" style={{ background: LINE }} />
      <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] whitespace-nowrap">
        {label}
      </span>
      <span className="h-px flex-1" style={{ background: LINE }} />
      <span className="h-2.5 w-px" style={{ background: LINE }} />
    </div>
  );
}

export default function Blueprint() {
  const d = useHomeData();
  const cards = [...d.featured, ...d.rest].slice(0, 12);

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden" style={{ background: BLUE, color: CHALK }}>
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <BlueprintGrid color="rgba(160,200,255,0.10)" size={24} />
        <BlueprintGrid color="rgba(160,200,255,0.16)" size={120} />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-5 py-6 sm:px-8">
        {/* The sheet. Everything lives inside one drawn border, the way a real
            drawing does — the margin outside it is the drafting table. */}
        <div className="border p-5 sm:p-8" style={{ borderColor: LINE }}>
          <nav className="flex flex-wrap items-baseline gap-x-6 gap-y-2 font-mono text-[10.5px] uppercase tracking-[0.16em]">
            <span className="font-bold tracking-[0.24em]">Vibeverse</span>
            <Link to="/game" className="opacity-70 hover:opacity-100">Worlds</Link>
            <Link to="/arcade" className="opacity-70 hover:opacity-100">Arcade</Link>
            <Link to="/build" className="opacity-70 hover:opacity-100">Create</Link>
            <Link
              to={d.coin.signedIn ? "/shop" : "/profile"}
              className="ml-auto opacity-70 hover:opacity-100"
            >
              {d.coin.signedIn ? d.coin.display : "Sign in"}
            </Link>
          </nav>

          <div className="mt-8" style={{ borderTop: `1px solid ${LINE}` }} />

          <header className="grid gap-8 py-12 lg:grid-cols-[1.6fr_1fr] lg:py-16">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] opacity-60">
                General arrangement · sheet 1 of 1
              </p>
              <h1
                className="mt-4 font-heading font-black uppercase leading-[0.86] tracking-[-0.03em]"
                style={{ fontSize: "clamp(2.6rem, 8.4vw, 6rem)" }}
              >
                The
                <br />
                Vibeverse
              </h1>
              <div className="mt-6 max-w-md">
                <Dim label={`${d.counts.worlds} worlds`} />
              </div>
              <p className="mt-6 max-w-md text-[14px] leading-relaxed opacity-80">
                A hub of worlds you can walk, fly, drive and shoot your way
                through. Every one of them opens from here, in a browser tab,
                with nothing installed. Powered by creators, owned by players.
              </p>
              <div className="mt-7 flex flex-wrap gap-2.5">
                <Link
                  to="/game"
                  className="px-5 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em]"
                  style={{ background: CHALK, color: BLUE }}
                >
                  Open index
                </Link>
                <Link
                  to="/chronicle"
                  className="border px-5 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em]"
                  style={{ borderColor: LINE }}
                >
                  Revision history
                </Link>
              </div>
            </div>

            {/* The title block. Bottom-right of the sheet, as it always is. */}
            <div className="self-end border" style={{ borderColor: LINE }}>
              {[
                ["Project", "Vibeverse"],
                ["Worlds", String(d.counts.worlds)],
                ["Playable", String(d.counts.playable)],
                ["Surveyed", `${d.passport.visited} of ${d.passport.total}`],
                ["Status", "In construction"],
              ].map(([k, v], i, a) => (
                <div
                  key={k}
                  className="flex items-baseline justify-between gap-4 px-3.5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.12em]"
                  style={{ borderBottom: i < a.length - 1 ? `1px solid ${LINE}` : undefined }}
                >
                  <span className="opacity-60">{k}</span>
                  <span className="font-bold tabular-nums">{v}</span>
                </div>
              ))}
            </div>
          </header>

          <div style={{ borderTop: `1px solid ${LINE}` }} />

          <section className="pt-8">
            <div className="flex flex-wrap items-baseline gap-x-4 font-mono text-[10.5px] uppercase tracking-[0.16em]">
              <h2 className="font-bold">Schedule of worlds</h2>
              <span className="ml-auto opacity-60">Scale 1:1 · all dimensions in worlds</span>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((w, i) => (
                <Link
                  key={w.key}
                  to={w.route}
                  className="group border transition-colors hover:bg-white/[0.06]"
                  style={{ borderColor: LINE }}
                >
                  <div className="relative aspect-[16/10] overflow-hidden" style={{ borderBottom: `1px solid ${LINE}` }}>
                    {d.art(w.key) && (
                      <img
                        src={d.art(w.key)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover opacity-60 transition-opacity duration-500 group-hover:opacity-95"
                        /* Lifted and screened, not just desaturated. Half the
                           worlds are night scenes, and a grey night scene laid
                           on a navy sheet is a navy rectangle — which is what
                           this did first. Screening makes every world a pale
                           ghost on the paper, which is also what a photograph
                           pasted onto a cyanotype actually looks like. */
                        style={{
                          filter: "grayscale(1) contrast(0.8) brightness(1.45)",
                          mixBlendMode: "screen",
                        }}
                      />
                    )}
                    <span
                      className="absolute left-2 top-2 px-1.5 py-0.5 font-mono text-[9px] font-bold tabular-nums"
                      style={{ background: CHALK, color: BLUE }}
                    >
                      P-{String(i + 1).padStart(3, "0")}
                    </span>
                  </div>
                  <div className="px-3 py-2.5">
                    <h3 className="font-heading text-[14px] font-bold uppercase leading-none tracking-tight">
                      {w.name}
                    </h3>
                    <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug opacity-65">
                      {w.blurb}
                    </p>
                    <div
                      className="mt-2.5 flex items-baseline justify-between gap-2 pt-2 font-mono text-[9px] uppercase tracking-[0.12em] opacity-55"
                      style={{ borderTop: `1px solid ${LINE}` }}
                    >
                      <span>{shortStatus(w.status) ?? "World"}</span>
                      <span>Rev. {d.freshness(w.key) ?? "—"}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>

            <div className="mt-8">
              <Dim label={`${d.counts.worlds - cards.length} more on the index`} />
            </div>

            <div className="mt-7 text-center">
              <Link
                to="/game"
                className="inline-block border px-6 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.16em]"
                style={{ borderColor: LINE }}
              >
                Full schedule →
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
