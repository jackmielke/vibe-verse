/**
 * The Newsroom — the room the paper is made in.
 *
 * Everything else about The Vibe Times is the finished thing: a front page,
 * a strip on the door, a board on a newsstand. This is the other side of it.
 * A desk with a lamp on it at four in the morning, the wire coming in over
 * a tape, the presses waiting for their hour, the back issues on a spike,
 * and the wall where the letters go up.
 *
 * It is deliberately not a 3D world. The paper is words and the newsroom is
 * paper, so this is built out of type and light — which also means it opens
 * instantly, works on a phone, and cannot leak a WebGL context.
 *
 * Nothing in here is decorative-only: every panel is showing real state.
 * The tape is this morning's actual wire, the clock is the actual pg_cron
 * schedule, the streak is counted from the actual editions, and the wall is
 * the actual graffiti table. A room that lies about the building it is in
 * would be a screensaver.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { loadPaper, printedAt, type Issue } from "@/lib/vibeTimes";
import { Letterbox } from "@/components/times/Letterbox";
import { ReadAloud } from "@/components/times/ReadAloud";
import { Ticker } from "./Ticker";
import { describeAge, nextRun, streak, utcDay } from "./press";

interface WallLine {
  author_name: string | null;
  text: string;
  created_at: string;
}

export function PressRoom() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [wall, setWall] = useState<WallLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Letters waiting for the morning. A count, never the letters — the
  // postbag has no read policy and should not get one, because an unprinted
  // letter is somebody's post before an editor has opened it.
  const [postbag, setPostbag] = useState(0);
  // One clock for the whole room, ticking a minute at a time. The countdown
  // is the only thing that needs it, and a room that re-renders every second
  // to move a minute hand is a waste of a battery.
  const [now, setNow] = useState(() => new Date());

  // The wall is public to read, so this needs no session. It is also
  // entirely optional furniture: a failure here leaves an empty spike.
  const refreshWall = useCallback(async () => {
    const { data } = await supabase
      .from("world_graffiti")
      .select("author_name,text,created_at")
      .order("created_at", { ascending: false })
      .limit(8);
    if (data) setWall(data as WallLine[]);
  }, []);

  useEffect(() => {
    let live = true;

    loadPaper(14)
      .then((paper) => {
        if (!live) return;
        setIssues(paper.current ? [paper.current, ...paper.archive] : []);
        setPostbag(paper.postbag);
        setLoaded(true);
      })
      .catch(() => live && setLoaded(true));

    void refreshWall().catch(() => {
      /* the wall is furniture; an empty one is not an error */
    });

    const tick = window.setInterval(() => live && setNow(new Date()), 60_000);
    return () => {
      live = false;
      window.clearInterval(tick);
    };
  }, [refreshWall]);

  const current = issues[0] ?? null;
  const press = useMemo(
    () => nextRun(now, !!current && utcDay(`${current.date}T12:00:00Z`) === utcDay(now)),
    [now, current],
  );
  const run = useMemo(() => streak(issues.map((i) => i.date), now), [issues, now]);

  return (
    <div
      className="min-h-screen overflow-x-hidden bg-[#12100c] px-4 pb-16 pt-20 text-[#d8cfae]"
      style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
    >
      {/* The lamp. One warm pool of light on an otherwise dark room, which
          is the entire art direction. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-[70vh] opacity-70"
        style={{
          background:
            "radial-gradient(60% 55% at 50% 0%, rgba(255,196,92,0.16) 0%, rgba(255,170,60,0.05) 45%, transparent 75%)",
        }}
      />

      <div className="relative mx-auto max-w-5xl">
        <header className="text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-[#ffd479]/60">
            the vibe times · editorial floor
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl" style={{ fontVariant: "small-caps" }}>
            The Newsroom
          </h1>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-[#d8cfae]/60">
            Where the paper gets made. The wire comes in overhead, the presses run at first
            light, and the letters go up on the wall on their way to the page.
          </p>
        </header>

        <div className="mt-6">
          <Ticker dispatches={current?.dispatches ?? []} />
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {/* ---- The presses ------------------------------------------- */}
          <section className="min-w-0 rounded-sm border border-[#d8cfae]/20 bg-black/30 p-5">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-[#ffd479]/70">The presses</h2>

            {current ? (
              <>
                <p className="mt-3 text-2xl font-bold">
                  No. {current.issue}
                  <span className="ml-2 text-sm font-normal text-[#d8cfae]/60">
                    printed {printedAt(current.printed_at) ?? "by hand"}
                    {current.printed_at && `, ${describeAge(current.printed_at, now)}`}
                  </span>
                </p>
                <p className="mt-1 text-sm italic text-[#d8cfae]/70">“{current.motto}”</p>

                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-[#d8cfae]/15 pt-3 text-sm">
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-widest text-[#d8cfae]/40">Next edition</dt>
                    <dd className="mt-0.5">
                      {press.eta}
                      {press.imminent && <span className="ml-1 text-[#ffd479]">· running</span>}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-widest text-[#d8cfae]/40">Unbroken run</dt>
                    <dd className="mt-0.5">
                      {run} {run === 1 ? "morning" : "mornings"}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-widest text-[#d8cfae]/40">Editions</dt>
                    <dd className="mt-0.5">{current.issue} in all</dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-widest text-[#d8cfae]/40">On the wire</dt>
                    <dd className="mt-0.5">{current.dispatches?.length ?? 0} dispatches</dd>
                  </div>
                </dl>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Link
                    to="/times"
                    className="border border-[#d8cfae]/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors hover:bg-[#d8cfae] hover:text-[#12100c]"
                  >
                    read today's paper →
                  </Link>
                  <a
                    href={`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/vibe-times?format=rss`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-mono text-[10px] uppercase tracking-widest text-[#d8cfae]/50 underline decoration-dotted underline-offset-4 hover:text-[#ffd479]"
                  >
                    subscribe (rss)
                  </a>
                </div>
              </>
            ) : (
              <p className="mt-3 text-sm text-[#d8cfae]/50">
                {loaded ? "No edition has reached the floor yet." : "Checking the floor…"}
              </p>
            )}
          </section>

          {/* ---- The desk ---------------------------------------------- */}
          <section className="min-w-0 rounded-sm border border-[#d8cfae]/20 bg-black/30 p-5">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-[#ffd479]/70">The editor's desk</h2>
            {current ? (
              <>
                <p className="mt-3 text-sm leading-relaxed text-[#d8cfae]/70">
                  Vibey works nights. It will read you the morning's paper, or take a line from
                  you for the next one.
                </p>
                <div className="mt-2 [&_button]:border-[#d8cfae]/40 [&_button]:text-[#d8cfae] [&_button:hover]:bg-[#d8cfae] [&_button:hover]:text-[#12100c]">
                  <ReadAloud issue={current} />
                </div>
                {/* The letterbox is the same component the paper uses. One
                    letterbox, two rooms — a second implementation would be a
                    second set of rules about what a letter is. */}
                <div className="mt-4 [&>section]:mt-0 [&>section]:border-[#d8cfae]/20 [&_input]:border-[#d8cfae]/30 [&_input]:text-[#d8cfae] [&_input]:placeholder:text-[#d8cfae]/30 [&_button[type=submit]]:border-[#ffd479]/60 [&_button[type=submit]]:bg-[#ffd479] [&_button[type=submit]]:text-[#12100c]">
                  {/* Posting a line moves the spike and the wall in the same
                      breath, because both of those are what actually just
                      happened. A count that only updates on reload would make
                      the room look like a screenshot of itself. */}
                  <Letterbox
                    onSent={() => {
                      setPostbag((n) => n + 1);
                      void refreshWall();
                    }}
                  />
                </div>
                <p className="mt-3 border-t border-[#d8cfae]/15 pt-3 font-mono text-[10px] uppercase tracking-widest text-[#d8cfae]/50">
                  on the spike:{" "}
                  {postbag === 0
                    ? "nothing waiting"
                    : `${postbag} ${postbag === 1 ? "letter" : "letters"} for the morning`}
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm text-[#d8cfae]/50">The desk is dark.</p>
            )}
          </section>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-[1.1fr_1fr]">
          {/* ---- The morgue -------------------------------------------- */}
          <section className="min-w-0 rounded-sm border border-[#d8cfae]/20 bg-black/30 p-5">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-[#ffd479]/70">
              The morgue
            </h2>
            <p className="mt-1 text-[11px] italic text-[#d8cfae]/40">
              what every newspaper calls the room where it keeps its back issues
            </p>
            {issues.length ? (
              <ul className="mt-3 divide-y divide-[#d8cfae]/10">
                {issues.slice(0, 10).map((i, idx) => (
                  <li key={i.issue}>
                    <Link
                      to={idx === 0 ? "/times" : `/times/${i.issue}`}
                      className="flex items-baseline gap-3 py-2 transition-colors hover:text-[#ffd479]"
                    >
                      <span className="w-12 shrink-0 font-mono text-[11px] text-[#d8cfae]/40">
                        №{i.issue}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {i.headlines[0]?.headline ?? i.motto}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-[#d8cfae]/30">
                        {i.date.slice(5)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-[#d8cfae]/50">The spike is empty.</p>
            )}
          </section>

          {/* ---- The wall ---------------------------------------------- */}
          <section className="min-w-0 rounded-sm border border-[#d8cfae]/20 bg-black/30 p-5">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-[#ffd479]/70">The wall</h2>
            <p className="mt-1 text-[11px] italic text-[#d8cfae]/40">
              every line written on the plaza wall, letters included
            </p>
            {wall.length ? (
              <ul className="mt-3 space-y-3">
                {wall.map((line) => (
                  <li key={`${line.created_at}-${line.text}`} className="text-sm leading-snug">
                    <span className="text-[#d8cfae]/85">“{line.text}”</span>
                    <span className="ml-2 break-words font-mono text-[10px] uppercase tracking-widest text-[#d8cfae]/40">
                      — {line.author_name ?? "someone"}, {describeAge(line.created_at, now)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-[#d8cfae]/50">
                Nothing on the wall yet. Yours would be the first.
              </p>
            )}
          </section>
        </div>

        <footer className="mt-10 border-t border-[#d8cfae]/15 pt-4 text-center font-mono text-[10px] uppercase tracking-widest text-[#d8cfae]/40">
          <p>the presses run every morning from 13:00 utc, and keep trying until one takes</p>
          <p className="mt-2">
            <Link to="/times" className="underline decoration-dotted underline-offset-4 hover:text-[#ffd479]">
              the paper
            </Link>
            <span className="mx-2">·</span>
            <Link to="/city?spawn=island" className="underline decoration-dotted underline-offset-4 hover:text-[#ffd479]">
              the plaza
            </Link>
            <span className="mx-2">·</span>
            <Link to="/" className="underline decoration-dotted underline-offset-4 hover:text-[#ffd479]">
              the vibeverse
            </Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
