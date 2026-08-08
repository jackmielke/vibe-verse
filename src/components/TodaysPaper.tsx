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
      className="mt-6 overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-[#0e1520] to-[#080c13] sm:mt-8"
      aria-label="The Vibe Times"
    >
      <div className="flex items-center gap-2.5 border-b border-border/40 px-4 py-2.5">
        <span className="text-base leading-none" aria-hidden>
          🤖
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-heading text-[9.5px] font-black uppercase tracking-[0.24em] text-[#8fb4ff]">
            The Vibe Times
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground/70">
            {dateline(issue)} · brought to you by Vibey
          </p>
        </div>
        <Link
          to="/times"
          className="shrink-0 font-heading text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          Read it →
        </Link>
      </div>

      <Link to="/times" className="block px-4 py-3.5 transition-colors hover:bg-white/[0.02]">
        <div className="flex items-start gap-2.5">
          <span className="text-lg leading-none" aria-hidden>
            {lead.emoji}
          </span>
          <div className="min-w-0">
            <h2 className="font-heading text-[13.5px] font-black uppercase leading-tight tracking-wide text-foreground sm:text-[15px]">
              {lead.headline}
            </h2>
            <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
              {lead.body}
            </p>
          </div>
        </div>

        {rest.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-border/30 pt-2.5">
            {rest.slice(0, 2).map((h) => (
              <li key={h.headline} className="flex items-baseline gap-2">
                <span className="text-[11px] leading-none" aria-hidden>
                  {h.emoji}
                </span>
                <span className="truncate font-heading text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {h.headline}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Link>

      {issue.weather && (
        <p className="border-t border-border/30 px-4 py-2 text-[10.5px] italic text-muted-foreground/60">
          {issue.weather}
        </p>
      )}
    </motion.section>
  );
}
