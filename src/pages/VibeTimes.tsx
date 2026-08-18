/**
 * The Vibe Times — the world's own newspaper.
 *
 * Written from what ACTUALLY happened, in three parts: the build record
 * (this repo's own commits, which are the world's construction history),
 * the live world (residents arriving, leaving, walking up to each other,
 * VIBE moving around), and — since the presses started running themselves
 * — the actual internet outside the sky, on the wire desk.
 *
 * The `vibe-times` edge function writes an issue every morning and stores
 * it in Supabase; `src/lib/vibeTimes.ts` reads it and falls back to the
 * committed public/vibe-times.json when the presses are unreachable. Back
 * issues come down with the same request.
 *
 * Older issues predate the wire desk and simply do not have those fields,
 * so every section below the fold renders only when there is something in
 * it. That is also what keeps a thin news day from printing empty boxes.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { loadPaper, printedAt, type Dispatch, type Issue } from "@/lib/vibeTimes";
import { smallAds } from "@/lib/smallAds";
import { WORLDS } from "@/worlds/registry";
import { Letterbox } from "@/components/times/Letterbox";
import { ReadAloud } from "@/components/times/ReadAloud";

/** What each wire item gets called above its headline. */
const DESKS: Record<string, string> = {
  ai: "The AI Desk",
  tech: "The Tech Desk",
  sports: "The Sports Desk",
  culture: "The Culture Desk",
  history: "From the Archives",
};

/** "https://www.theverge.com/…" → "theverge.com", for the credit line. */
function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
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
  const [error, setError] = useState(false);
  // Which edition is on screen lives in the URL, not in a useState. A back
  // issue you cannot link to is not an archive, it is a toggle: /times/7 is
  // the seventh paper, it can be sent to somebody, and the feed points at
  // exactly these addresses.
  const { issueNo } = useParams();
  const reading = issueNo ? Number(issueNo) : null;

  useEffect(() => {
    let live = true;
    loadPaper()
      .then((paper) => {
        if (!live) return;
        if (!paper.current) {
          setError(true);
          return;
        }
        setCurrent(paper.current);
        setArchive(paper.archive);
      })
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, []);

  const issues = useMemo(
    () => (current ? [current, ...archive.filter((a) => a.issue !== current.issue)] : []),
    [current, archive],
  );
  const issue = useMemo(
    () => issues.find((i) => i.issue === reading) ?? current,
    [issues, reading, current],
  );
  // A number nobody ever printed. Say so rather than quietly showing today's
  // paper under someone else's link.
  const missing = reading !== null && issues.length > 0 && !issues.some((i) => i.issue === reading);
  // The classifieds rotate with the issue, so they are part of the edition
  // rather than part of the page: reload it, open it tomorrow, or open issue
  // seven, and you get the column that edition ran.
  const ads = useMemo(() => (issue ? smallAds(WORLDS, issue.issue) : []), [issue]);

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
  const wire = issue.dispatches ?? [];
  const forecast = issue.forecast ?? [];
  const sources = issue.sources ?? [];
  const letters = issue.letters ?? [];
  const ground = issue.ground_weather ?? null;
  const printed = printedAt(issue.printed_at);

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
            <span>Vol. I · No. {issue.issue}</span>
            <span className="text-center">
              {longDate(issue.date)}
              {/* The hour it was printed, on the reader's clock. Old issues
                  were written by hand and do not know theirs. */}
              {printed && <span className="whitespace-nowrap"> · printed {printed}</span>}
            </span>
            <span>price: one good vibe</span>
          </div>
          <ReadAloud issue={issue} />
        </header>

        {/* Back issues. Only shown once there is more than one, so the
            paper doesn't advertise an empty archive on day one. */}
        {issues.length > 1 && (
          <nav className="mt-3 flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-widest">
            <span className="opacity-60">Back issues:</span>
            {issues.map((i) => {
              const active = i.issue === issue.issue;
              return (
                <Link
                  key={i.issue}
                  to={i.issue === current.issue ? "/times" : `/times/${i.issue}`}
                  className={
                    active
                      ? "font-bold underline decoration-2 underline-offset-2"
                      : "underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100"
                  }
                  aria-current={active ? "page" : undefined}
                >
                  №{i.issue}
                </Link>
              );
            })}
          </nav>
        )}

        {/* A link to an edition nobody ever printed. Better to say so than
            to show today's paper under someone else's number. */}
        {missing && (
          <p className="mt-3 border border-[#2a2118]/40 px-3 py-2 text-center text-xs uppercase tracking-widest">
            no issue №{reading} was ever printed · showing the latest instead
          </p>
        )}

        {/* Reading something other than today's front page. */}
        {isBackIssue && !missing && (
          <p className="mt-3 border border-[#2a2118]/40 bg-[#2a2118]/[0.04] px-3 py-2 text-center text-xs uppercase tracking-widest">
            from the archive ·{" "}
            <Link to="/times" className="underline">
              back to issue №{current.issue}
            </Link>
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
            {/* The desk that filed it. Printed only when the issue has one —
                every edition up to №13 predates bylines, and inventing
                "Staff Reporter" for the archive would be the paper telling
                its first lie. */}
            {lead.byline && (
              <p className="mt-2 text-[11px] uppercase tracking-[0.25em] opacity-60">{lead.byline}</p>
            )}
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
              {h.byline && (
                <p className="mt-1 text-[10px] uppercase tracking-[0.25em] opacity-60">{h.byline}</p>
              )}
              <p className="mt-2 text-justify text-sm leading-relaxed">{h.body}</p>
            </article>
          ))}
        </section>

        {/* The wire. Everything here happened outside the sky, and every
            item carries the link the paper read it from — the function
            drops any dispatch whose url it did not fetch itself. */}
        {wire.length > 0 && (
          <section className="mt-8">
            <div className="border-y-4 border-double border-[#2a2118] py-2 text-center">
              <h3 className="text-sm font-bold uppercase tracking-[0.35em]">📡 The Wire · from outside the sky</h3>
            </div>
            <div className="mt-5 grid gap-6 sm:grid-cols-2">
              {wire.map((d: Dispatch) => (
                <article key={d.url + d.headline} className="border-b border-[#2a2118]/20 pb-5">
                  <p className="text-[10px] uppercase tracking-[0.25em] opacity-60">
                    {DESKS[d.desk] ?? "The Wire"}
                  </p>
                  <h4 className="mt-1 text-lg font-bold leading-snug">
                    {d.emoji} {d.headline}
                  </h4>
                  <p className="mt-2 text-justify text-sm leading-relaxed">{d.body}</p>
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-2 inline-block text-[11px] uppercase tracking-widest underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100"
                  >
                    {d.source}
                    {host(d.url) ? ` · ${host(d.url)}` : ""} ↗
                  </a>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Columns row: gossip / weather */}
        <section className="mt-6 grid gap-6 sm:grid-cols-2">
          <div className="border border-[#2a2118]/40 p-4">
            <h4 className="text-center text-sm font-bold uppercase tracking-[0.25em]">🫖 Overheard on the Island</h4>
            <p className="mt-2 text-sm italic leading-relaxed">{issue.gossip}</p>
          </div>
          <div className="border border-[#2a2118]/40 p-4">
            <h4 className="text-center text-sm font-bold uppercase tracking-[0.25em]">⛅ Sky Weather</h4>
            <p className="mt-2 text-sm leading-relaxed">{issue.weather}</p>

            {/* And the real forecast, for the real town the village is built
                on top of. The map under Vibe Island is genuine Healdsburg
                coordinates, so this is not a flourish: it is the weather
                where the plaza is. Fiction in the paragraph above, a
                thermometer directly beneath it. */}
            {ground && (
              <div className="mt-3 border-t border-[#2a2118]/30 pt-2">
                <p className="text-center text-[10px] uppercase tracking-widest opacity-60">
                  On the ground · {ground.place}
                </p>
                <div className="mt-1 flex items-baseline justify-center gap-3 text-sm">
                  <span className="text-2xl font-bold">{ground.now_f}°</span>
                  <span className="italic">{ground.conditions}</span>
                </div>
                <p className="mt-1 text-center text-[11px] uppercase tracking-widest opacity-70">
                  {ground.high_f}° / {ground.low_f}°
                  {ground.rain_chance > 0 && <> · {ground.rain_chance}% rain</>}
                  {ground.sunrise && ground.sunset && (
                    <> · sun {ground.sunrise}–{ground.sunset}</>
                  )}
                </p>
              </div>
            )}
            <div className="mt-3 border-t border-[#2a2118]/30 pt-2 text-center text-xs uppercase tracking-widest">
              {Object.entries(issue.stats).map(([k, v]) => (
                <div key={k} className="mt-1">
                  <span className="font-bold">{String(v)}</span> {k.replace(/_/g, " ")}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* The postbag. Letters print as the reader wrote them — the editor
            chooses which run and answers underneath, and never touches the
            words in between. */}
        {letters.length > 0 && (
          <section className="mt-8">
            <div className="border-y-4 border-double border-[#2a2118] py-2 text-center">
              <h3 className="text-sm font-bold uppercase tracking-[0.35em]">✉️ Letters to the Editor</h3>
            </div>
            <div className="mt-5 space-y-5">
              {letters.map((l) => (
                <article key={l.author + l.text} className="border-b border-[#2a2118]/20 pb-4">
                  <blockquote className="text-[15px] leading-relaxed">“{l.text}”</blockquote>
                  <p className="mt-1 text-xs uppercase tracking-widest">— {l.author}</p>
                  {l.note && (
                    <p className="mt-2 border-l-2 border-[#2a2118]/40 pl-3 text-sm italic leading-relaxed opacity-80">
                      {l.note}
                      <span className="ml-2 not-italic text-[10px] uppercase tracking-widest opacity-60">— ed.</span>
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Only today's paper takes letters. Writing to a back issue would
            be writing to the past, and the box would be lying about it. */}
        {!isBackIssue && <Letterbox />}

        {/* Vibey's column and the forecast. The forecast is the only part
            of the paper allowed to make things up, and it says so. */}
        {(issue.vibey_says || forecast.length > 0) && (
          <section className="mt-6 grid gap-6 sm:grid-cols-2">
            {issue.vibey_says && (
              <div className="border-l-4 border-[#2a2118] bg-[#2a2118]/[0.03] p-4">
                <h4 className="text-sm font-bold uppercase tracking-[0.25em]">🤖 Vibey Says</h4>
                <p className="mt-2 text-[15px] leading-relaxed">{issue.vibey_says}</p>
                <p className="mt-2 text-[11px] uppercase tracking-widest opacity-60">
                  — Vibey, editor-in-chief, writing from the asteroid
                </p>
              </div>
            )}
            {forecast.length > 0 && (
              <div className="border border-dashed border-[#2a2118]/50 p-4">
                <h4 className="text-center text-sm font-bold uppercase tracking-[0.25em]">🔮 The Vibe Forecast</h4>
                <ul className="mt-2 space-y-2">
                  {forecast.map((f) => (
                    <li key={f.label + f.text} className="text-sm leading-relaxed">
                      <span aria-hidden>{f.emoji}</span>{" "}
                      <span className="font-bold uppercase tracking-wide">{f.label}:</span> {f.text}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-center text-[10px] uppercase tracking-widest opacity-50">
                  entertainment only · the forecast has never once been right
                </p>
              </div>
            )}
          </section>
        )}

        {/* The classifieds. Every ad is a real world, quoting its own blurb,
            rotating with the issue number — so a back issue keeps the column
            it ran with instead of quietly showing this morning's. */}
        {ads.length > 0 && (
          <section className="mt-8">
            <div className="border-y-4 border-double border-[#2a2118] py-2 text-center">
              <h3 className="text-sm font-bold uppercase tracking-[0.35em]">🗂 The Small Ads</h3>
            </div>
            <div className="mt-5 grid gap-5 sm:grid-cols-3">
              {ads.map((ad) => (
                <Link
                  key={ad.key}
                  to={ad.route}
                  className="group border-b border-[#2a2118]/20 pb-4 transition-opacity hover:opacity-70"
                >
                  <p className="text-[10px] uppercase tracking-[0.25em] opacity-60">{ad.heading}</p>
                  <p className="mt-1 text-sm font-bold uppercase tracking-wide">
                    {ad.emoji} {ad.name}
                  </p>
                  <p className="mt-1 text-sm leading-snug">{ad.line}</p>
                  <p className="mt-1 text-[11px] uppercase tracking-widest underline decoration-dotted underline-offset-2 opacity-60">
                    apply at {ad.route}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Quote of the day */}
        <section className="mt-8 text-center">
          <p className="text-2xl italic">“{issue.quote.text}”</p>
          <p className="mt-1 text-sm uppercase tracking-widest">— {issue.quote.author}</p>
        </section>

        <footer className="mt-10 border-t-4 border-double border-[#2a2118] pt-4 text-center text-xs uppercase tracking-widest">
          <p>
            reported from the build record, the world's own event stream
            {wire.length > 0 ? ", and the wire" : ""}
          </p>
          <p className="mt-1 normal-case tracking-normal opacity-70">
            Every claim about this world traces to a commit or a logged event. Every story from outside
            it links to where the paper read it. Only the forecast is invented.
          </p>
          {sources.length > 0 && (
            <p className="mt-2 normal-case tracking-normal opacity-70">
              Today's wire:{" "}
              {sources.map((s, i) => (
                <span key={s.label}>
                  {i > 0 && ", "}
                  <a href={s.url} target="_blank" rel="noreferrer noopener" className="underline">
                    {s.label}
                  </a>
                </span>
              ))}
            </p>
          )}
          {/* The colophon. A paper that can only be read on the page it is
              printed on is a web page wearing a serif font; this is the
              building it comes out of and the way to get it delivered. */}
          <p className="mt-2">
            <Link to="/newsroom" className="underline">the newsroom</Link>
            <span className="mx-2">·</span>
            <a
              href={`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/vibe-times?format=rss`}
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              subscribe (rss)
            </a>
            <span className="mx-2">·</span>
            <Link to="/city?spawn=island" className="underline">visit the island</Link>
            <span className="mx-2">·</span>
            <Link to="/" className="underline">the VibeVerse</Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
