/**
 * The wire tape.
 *
 * A strip of paper coming out of a machine, carrying the same dispatches
 * that ran in this morning's paper. It is the one thing in the room that
 * moves on its own, which is most of why the room feels occupied.
 *
 * The tape is duplicated and translated by exactly half its width, which is
 * the only way to loop a marquee without a seam. Hovering stops it, because
 * a headline you want to read should not walk away from you, and
 * `prefers-reduced-motion` stops it for good.
 */
import type { Dispatch } from "@/lib/vibeTimes";

export function Ticker({ dispatches }: { dispatches: Dispatch[] }) {
  if (!dispatches.length) return null;
  // Two copies, so the second is arriving as the first leaves.
  const tape = [...dispatches, ...dispatches];

  return (
    <div className="group relative overflow-hidden border-y border-[#d8cfae]/25 bg-black/40 py-2">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-[#12100c] to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-[#12100c] to-transparent" />
      <div
        className="flex w-max gap-8 whitespace-nowrap motion-safe:animate-wire group-hover:[animation-play-state:paused]"
        aria-label="the wire"
      >
        {tape.map((d, i) => (
          <a
            key={`${d.url}-${i}`}
            href={d.url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex shrink-0 items-baseline gap-2 font-mono text-[11px] uppercase tracking-widest text-[#d8cfae]/70 transition-colors hover:text-[#ffd479]"
            // The tape is decorative on its second pass; one copy in the
            // accessibility tree is enough.
            aria-hidden={i >= dispatches.length}
            tabIndex={i >= dispatches.length ? -1 : undefined}
          >
            <span className="text-[#ffd479]/60">{d.source}</span>
            <span>{d.headline}</span>
            <span className="text-[#d8cfae]/30">•</span>
          </a>
        ))}
      </div>
    </div>
  );
}
