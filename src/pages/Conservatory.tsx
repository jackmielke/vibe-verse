/**
 * The Conservatory — `/conservatory`.
 *
 * A thin page. It owns the way in and one line of chrome; everything that
 * moves lives under `src/conservatory/`.
 *
 * The chrome is deliberately almost nothing. Every other realm here has a
 * HUD because every other realm is keeping score. This one is a room, and a
 * counter in the corner of a room is the fastest way to turn it back into a
 * game.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createConservatory, type ConservatoryWorld } from "@/conservatory/Conservatory";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function Conservatory() {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<ConservatoryWorld | null>(null);
  const [entered, setEntered] = useState(false);
  const [muted, setMuted] = useState(false);
  const [walked, setWalked] = useState(0);

  useWorldStamp("/conservatory", "The Conservatory");

  useEffect(() => {
    if (!entered) return;
    const host = hostRef.current;
    if (!host) return;
    let last = 0;
    const world = createConservatory({
      container: host,
      muted,
      onWalked: (m) => {
        // Metres arrive every frame; the display only ever changes at ten.
        const decade = Math.floor(m / 10) * 10;
        if (decade !== last) { last = decade; setWalked(decade); }
      },
    });
    worldRef.current = world;
    return () => {
      world.dispose();
      worldRef.current = null;
    };
    // `muted` is read once at construction and pushed imperatively after,
    // so it must not be a dependency — rebuilding the whole glasshouse to
    // turn the rain down would be an odd way to do it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered]);

  useEffect(() => { worldRef.current?.setMuted(muted); }, [muted]);

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-[#141a18]">
      <div ref={hostRef} className="absolute inset-0" />

      {!entered && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#10161a] px-6">
          <div className="max-w-md text-center">
            <p className="text-[11px] uppercase tracking-[0.45em] text-[#8fae94]">the vibeverse</p>
            <h1 className="mt-4 font-serif text-5xl font-light tracking-tight text-[#e8efe6] sm:text-6xl">
              The Conservatory
            </h1>
            <p className="mt-6 text-sm leading-relaxed text-[#9db3a2]">
              Forty-eight metres of glasshouse, late in the afternoon, in the
              rain. The sun is low enough to come in sideways and the roof
              cuts it into bars.
            </p>
            <p className="mt-4 text-sm leading-relaxed text-[#6f8577]">
              There is nothing to collect and nothing to survive. Walk to the
              far end and back.
            </p>
            <button
              onClick={() => setEntered(true)}
              className="mt-9 rounded-sm border border-[#5f7d66] px-9 py-3 text-xs font-medium uppercase tracking-[0.3em] text-[#cfe0d1] transition hover:bg-[#5f7d66] hover:text-[#0f1512]"
            >
              Go in
            </button>
            <p className="mt-7 text-[11px] tracking-wide text-[#5c7063]">
              W A S D to walk · drag to look · shift to hurry, if you must
            </p>
          </div>
        </div>
      )}

      {entered && (
        <>
          {/* One line, bottom left, in the building's own typeface. It is a
              distance walked, not a score — nothing counts it down and
              nothing is unlocked by it. */}
          <div className="pointer-events-none absolute bottom-6 left-7 z-10 select-none font-serif text-[#cfe0d1]/70">
            <span className="text-2xl tabular-nums">{walked}</span>
            <span className="ml-1.5 text-xs uppercase tracking-[0.2em]">metres walked</span>
          </div>

          <button
            onClick={() => setMuted((m) => !m)}
            className="absolute bottom-6 right-7 z-10 rounded-sm px-3 py-2 text-[11px] uppercase tracking-[0.2em] text-[#cfe0d1]/60 transition hover:text-[#cfe0d1]"
          >
            {muted ? "rain off" : "rain on"}
          </button>

          <Link
            to="/"
            className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2 text-[11px] uppercase tracking-[0.25em] text-[#cfe0d1]/45 transition hover:text-[#cfe0d1]"
          >
            out
          </Link>
        </>
      )}
    </div>
  );
}
