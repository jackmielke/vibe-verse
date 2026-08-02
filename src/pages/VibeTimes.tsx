/**
 * The Vibe Times — the world's own newspaper.
 *
 * Written from what ACTUALLY happened: the build record (this repo's own
 * commits, which are the world's construction history) and the live world
 * (residents arriving, leaving, walking up to each other). The daily loop
 * is the journalist and this page is the printing press —
 * `tools/vibe-times-brief.mjs` gathers the facts,
 * `.claude/skills/vibe-times/SKILL.md` is the style guide.
 *
 * The current issue is public/vibe-times.json; everything older is in
 * public/vibe-times-archive.json, newest first. The plaza newsstand reads
 * the current issue, which is why that file keeps its name and shape.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

interface Issue {
  issue: number;
  date: string;
  motto: string;
  headlines: { emoji: string; headline: string; body: string }[];
  gossip: string;
  weather: string;
  quote: { text: string; author: string };
  stats: Record<string, number | string>;
}

/** "2026-08-01" → "Saturday, 1 August 2026", in a newspaper's voice. */
function longDate(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

/** Whole days between an issue date and today, UTC. */
function daysOld(iso: string) {
  const then = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(then)) return 0;
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.round((today - then) / 86_400_000));
}

export default function VibeTimes() {
  const [current, setCurrent] = useState<Issue | null>(null);
  const [archive, setArchive] = useState<Issue[]>([]);
  const [reading, setReading] = useState<number | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/vibe-times.json")
      .then((r) => r.json())
      .then(setCurrent)
      .catch(() => setError(true));
    // Back issues are a nice-to-have: a missing or malformed archive
    // must never stop today's paper from printing.
    fetch("/vibe-times-archive.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setArchive(Array.isArray(rows) ? rows : []))
      .catch(() => setArchive([]));
  }, []);

  const issues = useMemo(
    () => (current ? [current, ...archive.filter((a) => a.issue !== current.issue)] : []),
    [current, archive],
  );
  const issue = useMemo(
    () => issues.find((i) => i.issue === reading) ?? current,
    [issues, reading, current],
  );

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#efe8d8] text-[#2a2118]">
        the presses are jammed — try again in a moment.
      </div>
    );
  }
  if (!issue || !current) return <div className="min-h-screen bg-[#efe8d8]" />;

  const [lead, ...rest] = issue.headlines;
  const isBackIssue = issue.issue !== current.issue;
  const age = daysOld(current.date);

  return (
    // The global nav floats over the top of the page, and it was sitting
    // right on top of the "est. the night the loop woke up" line.
    <div className="min-h-screen overflow-y-auto bg-[#efe8d8] px-4 pb-10 pt-24 text-[#2a2118]" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <div className="mx-auto max-w-4xl">
        {/* Masthead */}
        <header className="border-b-4 border-double border-[#2a2118] pb-4 text-center">
          <p className="text-[11px] uppercase tracking-[0.3em]">est. the night the loop woke up · printed in the sky</p>
          <h1 className="mt-1 text-5xl font-bold tracking-tight sm:text-7xl" style={{ fontVariant: "small-caps" }}>
            The Vibe Times
          </h1>
          <p className="mt-1 italic">“{issue.motto}”</p>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#2a2118] pt-2 text-[10px] uppercase tracking-widest sm:text-xs">
            <span>Issue №{issue.issue}</span>
            <span className="text-center">{longDate(issue.date)}</span>
            <span>price: one good vibe</span>
          </div>
        </header>

        {/* Back issues. Only shown once there is more than one, so the
            paper doesn't advertise an empty archive on day one. */}
        {issues.length > 1 && (
          <nav className="mt-3 flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-widest">
            <span className="opacity-60">Back issues:</span>
            {issues.map((i) => {
              const active = i.issue === issue.issue;
              return (
                <button
                  key={i.issue}
                  onClick={() => setReading(i.issue)}
                  className={
                    active
                      ? "font-bold underline decoration-2 underline-offset-2"
                      : "underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100"
                  }
                  aria-current={active ? "page" : undefined}
                >
                  №{i.issue}
                </button>
              );
            })}
          </nav>
        )}

        {/* Reading something other than today's front page. */}
        {isBackIssue && (
          <p className="mt-3 border border-[#2a2118]/40 bg-[#2a2118]/[0.04] px-3 py-2 text-center text-xs uppercase tracking-widest">
            from the archive ·{" "}
            <button onClick={() => setReading(null)} className="underline">
              back to issue №{current.issue}
            </button>
          </p>
        )}

        {/* The masthead used to claim a nightly loop that did not exist.
            If the presses genuinely stall, say so rather than letting a
            stale front page pass for today's news. */}
        {!isBackIssue && age >= 3 && (
          <p className="mt-3 border border-[#2a2118]/40 px-3 py-2 text-center text-xs italic">
            The presses have been quiet for {age} days — this is the most recent issue.
          </p>
        )}

        {/* Lead story */}
        {lead && (
          <article className="mt-6 border-b border-[#2a2118]/30 pb-6">
            <h2 className="text-3xl font-bold leading-tight sm:text-4xl">
              {lead.emoji} {lead.headline}
            </h2>
            <p className="mt-3 text-justify text-[15px] leading-relaxed first-letter:float-left first-letter:mr-2 first-letter:text-5xl first-letter:font-bold first-letter:leading-[0.85]">
              {lead.body}
            </p>
          </article>
        )}

        {/* Secondary stories in columns */}
        <section className="mt-6 grid gap-6 sm:grid-cols-2">
          {rest.map((h) => (
            <article key={h.headline} className="border-b border-[#2a2118]/20 pb-5">
              <h3 className="text-xl font-bold leading-snug">
                {h.emoji} {h.headline}
              </h3>
              <p className="mt-2 text-justify text-sm leading-relaxed">{h.body}</p>
            </article>
          ))}
        </section>

        {/* Columns row: gossip / weather */}
        <section className="mt-6 grid gap-6 sm:grid-cols-2">
          <div className="border border-[#2a2118]/40 p-4">
            <h4 className="text-center text-sm font-bold uppercase tracking-[0.25em]">🫖 Overheard on the Island</h4>
            <p className="mt-2 text-sm italic leading-relaxed">{issue.gossip}</p>
          </div>
          <div className="border border-[#2a2118]/40 p-4">
            <h4 className="text-center text-sm font-bold uppercase tracking-[0.25em]">⛅ Sky Weather</h4>
            <p className="mt-2 text-sm leading-relaxed">{issue.weather}</p>
            <div className="mt-3 border-t border-[#2a2118]/30 pt-2 text-center text-xs uppercase tracking-widest">
              {Object.entries(issue.stats).map(([k, v]) => (
                <div key={k} className="mt-1">
                  <span className="font-bold">{String(v)}</span> {k.replace(/_/g, " ")}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Quote of the day */}
        <section className="mt-8 text-center">
          <p className="text-2xl italic">“{issue.quote.text}”</p>
          <p className="mt-1 text-sm uppercase tracking-widest">— {issue.quote.author}</p>
        </section>

        <footer className="mt-10 border-t-4 border-double border-[#2a2118] pt-4 text-center text-xs uppercase tracking-widest">
          <p>reported from the build record and the world's own event stream</p>
          <p className="mt-1 normal-case tracking-normal opacity-70">
            Every claim in this paper traces to a commit or a logged event. Nothing here is invented.
          </p>
          <p className="mt-2">
            <Link to="/city?spawn=island" className="underline">visit the island</Link>
            <span className="mx-2">·</span>
            <Link to="/" className="underline">the VibeVerse</Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
