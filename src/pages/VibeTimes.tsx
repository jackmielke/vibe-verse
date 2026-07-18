/**
 * The Vibe Times — the world's own newspaper.
 *
 * Written nightly by the autonomous build loop from what ACTUALLY happened
 * in the world (the event stream, the graffiti wall, the residents' chat).
 * The loop is the journalist; this page is the printing press. Issues live
 * in public/vibe-times.json; the plaza newsstand shows the front page.
 */
import { useEffect, useState } from "react";
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

export default function VibeTimes() {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/vibe-times.json")
      .then((r) => r.json())
      .then(setIssue)
      .catch(() => setError(true));
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#efe8d8] text-[#2a2118]">
        the presses are jammed — try again in a moment.
      </div>
    );
  }
  if (!issue) return <div className="min-h-screen bg-[#efe8d8]" />;

  const [lead, ...rest] = issue.headlines;

  return (
    <div className="min-h-screen overflow-y-auto bg-[#efe8d8] px-4 py-10 text-[#2a2118]" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <div className="mx-auto max-w-4xl">
        {/* Masthead */}
        <header className="border-b-4 border-double border-[#2a2118] pb-4 text-center">
          <p className="text-[11px] uppercase tracking-[0.3em]">est. the night the loop woke up · printed in the sky</p>
          <h1 className="mt-1 text-5xl font-bold tracking-tight sm:text-7xl" style={{ fontVariant: "small-caps" }}>
            The Vibe Times
          </h1>
          <p className="mt-1 italic">“{issue.motto}”</p>
          <div className="mt-3 flex items-center justify-between border-t border-[#2a2118] pt-2 text-xs uppercase tracking-widest">
            <span>Issue №{issue.issue}</span>
            <span>{issue.date}</span>
            <span>price: one good vibe</span>
          </div>
        </header>

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
          <p>reported & written by the autonomous build loop · no fabrication, only vibes</p>
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
