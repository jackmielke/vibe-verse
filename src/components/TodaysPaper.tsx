/**
 * The front page of The Vibe Times, on the front door.
 *
 * `/game` used to open with "Start at the Terminal" and "The 3D hub" — two
 * buttons nobody pressed, sending people to two surfaces nobody used. The
 * paper is a better answer to the same question ("what is going on in here?"),
 * because it is *different every time* and it is about the place rather than
 * about navigating it.
 *
 * Written every morning by the presses out of what actually got built, what
 * happened in the world, and what came over the wire from outside it. It is
 * genuinely the most alive thing on the page.
 *
 * Deliberately small: a lead headline, two more, one line of weather. This is a
 * teaser for `/times`, not the paper. It asks `loadCurrentIssue` for the live
 * edition and takes the committed copy if the presses are unreachable, with no
 * loading state above the fold — if it is slow or missing, the strip is simply
 * not there rather than a spinner on the front door.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { loadCurrentIssue, printedAt, type Issue } from "@/lib/vibeTimes";

/** Whole days between an issue date and today, UTC. */
function daysOld(iso: string): number {
  const then = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(then)) return 0;
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.round((today - then) / 86_400_000));
}

/**
 * The dateline, told honestly.
 *
 * The paper comes out every morning, and a press that has not run for a week
 * should not have its issue announced as "today's". Saying "Tuesday's
 * edition" when it is Sunday costs nothing and keeps the one surface that
 * claims to be current from quietly lying.
 *
 * Today's and yesterday's editions also carry the hour they were printed —
 * on a surface that says "today", the time is what makes it feel live.
 * Older ones don't: the exact minute of a fortnight-old paper is noise.
 */
function dateline(issue: Issue): string {
  const age = daysOld(issue.date);
  const at = printedAt(issue.printed_at);
  if (age === 0) return at ? `Today's edition, ${at}` : "Today's edition";
  if (age === 1) return at ? `Yesterday's edition, ${at}` : "Yesterday's edition";
  const d = new Date(`${issue.date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "Latest edition";
  if (age < 7) {
    return `${d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}'s edition`;
  }
  return `Edition of ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })}`;
}

export default function TodaysPaper() {
  const [issue, setIssue] = useState<Issue | null>(null);

  useEffect(() => {
    let live = true;
    loadCurrentIssue()
      .then((d) => {
        if (live && d) setIssue(d);
      })
      .catch(() => {
        /* No paper today. The page is fine without it. */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!issue) return null;

  const [lead, ...rest] = issue.headlines;

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.15 }}
      className="mt-5 overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-[#0e1520] to-[#080c13] sm:mt-6"
      aria-label="The Vibe Times"
    >
      {/* The masthead is one line now, not two stacked ones, and the weather
          rides along on it instead of taking a bordered strip of its own. */}
      <div className="flex items-baseline gap-2 px-3.5 pt-2.5 text-[9.5px]">
        <span className="font-heading font-black uppercase tracking-[0.22em] text-[#8fb4ff]">
          The Vibe Times
        </span>
        <span className="truncate text-muted-foreground/60">{dateline(issue)}</span>
        {/* The weather is a whole paragraph of it, and on a masthead line it
            reads as clutter rather than as charm. It gets whatever room is
            left on a wide screen and nothing at all below that; the full text
            is on `/times`, where it is the point. */}
        {issue.weather && (
          <span className="hidden min-w-0 max-w-[38%] flex-1 truncate italic text-muted-foreground/40 lg:block">
            {issue.weather}
          </span>
        )}
        <Link
          to="/times"
          className="ml-auto shrink-0 font-heading font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          Read it →
        </Link>
      </div>

      {/* One lead, one line of it, and the other two headlines on a single row.
          This strip is a teaser for `/times` sitting directly above the grid of
          worlds, and it was running to a third of a phone screen — every line
          of it was a game the visitor had to scroll past to see. */}
      <Link
        to="/times"
        className="block px-3.5 pb-2.5 pt-1.5 transition-colors hover:bg-white/[0.02]"
      >
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-[13px] leading-none" aria-hidden>
            {lead.emoji}
          </span>
          <h2 className="min-w-0 font-heading text-[12.5px] font-black uppercase leading-tight tracking-wide text-foreground sm:text-[13.5px]">
            {lead.headline}
          </h2>
        </div>
        <p className="mt-1 line-clamp-1 pl-[1.3rem] text-[11px] leading-relaxed text-muted-foreground">
          {lead.body}
        </p>

        {rest.length > 0 && (
          <p className="mt-1.5 flex items-baseline gap-1.5 truncate pl-[1.3rem] font-heading text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground/55">
            {rest.slice(0, 2).map((h, i) => (
              <span key={h.headline} className="truncate">
                {i > 0 && <span className="mr-1.5 opacity-40">·</span>}
                <span aria-hidden>{h.emoji}</span> {h.headline}
              </span>
            ))}
          </p>
        )}
      </Link>
    </motion.section>
  );
}
