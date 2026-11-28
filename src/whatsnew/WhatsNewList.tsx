/**
 * The changelog itself: days, newest first, each update as a card with a way
 * to go and try it. Used full-page at /whats-new and as a sheet on Vibe Island.
 */
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { WHATS_NEW, byDay, dayLabel, isUnseen, type WhatsNewEntry, type WhatsNewTag } from "./index";

const TAG: Record<WhatsNewTag, { label: string; cls: string }> = {
  new: { label: "New", cls: "bg-emerald-400/20 text-emerald-300 ring-emerald-300/30" },
  update: { label: "Update", cls: "bg-sky-400/20 text-sky-300 ring-sky-300/30" },
  fix: { label: "Fix", cls: "bg-zinc-400/20 text-zinc-200 ring-zinc-300/30" },
  event: { label: "Event", cls: "bg-amber-400/20 text-amber-300 ring-amber-300/30" },
};

export default function WhatsNewList({
  entries = WHATS_NEW,
  onNavigate,
  compact = false,
  fresh: freshOverride,
}: {
  entries?: WhatsNewEntry[];
  /** Called when a "Try it" link is followed, so a sheet can close itself. */
  onNavigate?: () => void;
  compact?: boolean;
  /** Which entries get the "new" dot. Defaults to unseen on this device. */
  fresh?: Set<string>;
}) {
  // Read once, before the parent marks everything seen, so the dots stay put
  // for this visit.
  const [fresh] = useState(() => freshOverride ?? new Set(entries.filter((e) => isUnseen(e.id)).map((e) => e.id)));
  const days = byDay(entries);
  const thisYear = String(new Date().getFullYear());
  // "Try it" for the world you are already standing in would just reload it.
  const here = useLocation().pathname;

  return (
    <ol className="space-y-7">
      {days.map((day) => (
        <li key={day.date}>
          <h3 className="sticky top-0 z-10 -mx-1 mb-3 bg-[#0b0f1f]/90 px-1 py-1 backdrop-blur text-[11px] font-heading font-semibold uppercase tracking-[0.14em] text-white/55">
            {dayLabel(day.date, !day.date.startsWith(thisYear))}
          </h3>
          <ul className="space-y-2.5">
            {day.entries.map((e) => (
              <li
                key={e.id}
                className={`relative rounded-2xl border border-white/10 bg-white/[0.04] ${compact ? "p-3" : "p-4"} transition-colors hover:bg-white/[0.07]`}
              >
                {fresh.has(e.id) && (
                  <span
                    className="absolute right-3 top-3 h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.8)]"
                    aria-label="New since your last visit"
                  />
                )}
                <div className="flex gap-3">
                  <span className={`${compact ? "text-2xl" : "text-3xl"} leading-none shrink-0`} aria-hidden>
                    {e.emoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 pr-4">
                      <h4 className={`${compact ? "text-[14px]" : "text-[15.5px]"} font-semibold leading-snug text-white`}>
                        {e.title}
                      </h4>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {e.tag && (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${TAG[e.tag].cls}`}>
                          {TAG[e.tag].label}
                        </span>
                      )}
                      {e.world && (
                        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10.5px] font-medium text-white/75">
                          {e.world}
                        </span>
                      )}
                      {e.auto && (
                        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10.5px] font-medium text-white/60" title="Made with build mode">
                          🛠️ build mode
                        </span>
                      )}
                    </div>
                    {e.body && (
                      <p className={`mt-2 ${compact ? "text-[13px]" : "text-[14px]"} leading-relaxed text-white/75`}>{e.body}</p>
                    )}
                    {e.route && e.route.split("?")[0] !== here && e.route !== "/whats-new" && (
                      <Link
                        to={e.route}
                        onClick={onNavigate}
                        className="mt-2.5 inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-white/20"
                      >
                        Try it →
                      </Link>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
