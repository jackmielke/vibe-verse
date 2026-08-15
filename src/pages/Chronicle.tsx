/**
 * /chronicle — every world, in the order it appeared.
 *
 * The vibeverse has fifty-two worlds and no memory of building any of them.
 * `/game` shows what exists; the passport shows where *you* have been; nothing
 * has ever shown how the place came to be. This is that: a history that writes
 * itself out of git, so it is exactly as true as the repository and cannot
 * drift from it.
 *
 * ## The reason it is built this way
 *
 * Everything else interesting here needs something to still be running. The
 * coins need Supabase. The portal needs an edge function and somebody's game
 * server. Sign-in needs an OAuth provider that still exists. All of that is
 * fine and none of it is permanent.
 *
 * This page needs **nothing**. No network, no database, no account, no key
 * that expires. Its data is a generated TypeScript file committed beside it,
 * its pictures are files in the repository, and it renders the same from a
 * folder on a disk in a hundred years as it does from a CDN today. That is a
 * design constraint rather than a boast, and `src/test/chronicle.test.ts`
 * enforces it: the module graph for this page may not reach the network.
 *
 * The one thing it does read is the passport, which is `localStorage` — so the
 * history is the same for everyone and the path through it is yours.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";

import StarField from "@/components/StarField";
import DayGrid from "@/components/chronicle/DayGrid";
import { artFor } from "@/worlds/art";
import { COMMIT_DAYS, REPO_LIFE, WORLD_LIFE } from "@/worlds/chronicle";
import { activity, bornOn, busiestDay, dayMs, longestSilence } from "@/worlds/chronicleStats";
import { WORLDS, type WorldEntry } from "@/worlds/registry";
import { readPassport, type Stamp } from "@/lib/passport";

const DAY = 86_400_000;

/** `2026-05-07` → `May 2026`. Month is the right grain: a week is noise. */
function monthLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Whole days from the vibeverse's first commit to this one, 1-indexed. */
function dayNumber(iso: string): number {
  const t = Date.parse(iso) - Date.parse(REPO_LIFE.born);
  return Math.max(1, Math.floor(t / DAY) + 1);
}

interface Era {
  month: string;
  worlds: WorldEntry[];
}

/**
 * The worlds that have a birthday, oldest first, grouped by the month they
 * arrived in.
 *
 * A world with no entry in `WORLD_LIFE` is left out rather than dated
 * `undefined` and sorted to the front. That happens when a `source` points
 * somewhere git has never heard of — a typo, or a world whose code moved — and
 * a chronicle quietly inventing a date for it is the one failure this whole
 * thing exists to avoid.
 */
function buildEras(): { eras: Era[]; dated: number } {
  const dated = WORLDS.filter((w) => WORLD_LIFE[w.key]);
  const sorted = [...dated].sort((a, b) =>
    WORLD_LIFE[a.key].born.localeCompare(WORLD_LIFE[b.key].born),
  );
  const eras: Era[] = [];
  for (const w of sorted) {
    const month = monthLabel(WORLD_LIFE[w.key].born);
    const last = eras[eras.length - 1];
    if (last && last.month === month) last.worlds.push(w);
    else eras.push({ month, worlds: [w] });
  }
  return { eras, dated: dated.length };
}

export default function Chronicle() {
  /* No `useWorldStamp`. This page reads your passport rather than adding to
     it — a stamp for having looked at the history would be the shelf filing
     itself among the books. `registry.ts` says the same in the other
     direction, and a test enforces that the two agree. */
  const { eras, dated } = useMemo(buildEras, []);

  /* Which of these you have actually stood in. Read once — the passport is
     localStorage and re-reading it per row to draw a tick is work for nothing. */
  const visited = useMemo(() => {
    const set = new Set<string>();
    for (const st of Object.values(readPassport().stamps) as Stamp[]) set.add(st.route);
    return set;
  }, []);

  /** Epoch ms of the earliest stamp in this browser, for the grid's marker. */
  const arrival = useMemo(() => {
    const times = (Object.values(readPassport().stamps) as Stamp[])
      .map((s) => s.first)
      .filter((n) => typeof n === "number" && n > 0);
    return times.length ? Math.min(...times) : undefined;
  }, []);

  const beenTo = useMemo(
    () => eras.reduce((n, e) => n + e.worlds.filter((w) => visited.has(w.route)).length, 0),
    [eras, visited],
  );

  const ageDays = Math.max(1, Math.floor((Date.now() - Date.parse(REPO_LIFE.born)) / DAY));

  /* Computed once. `Date.now()` is read here rather than inside the helpers so
     every number on the page agrees about what day it is — a render that
     straddles midnight would otherwise report a span and a silence measured
     against two different todays. */
  const now = useMemo(() => Date.now(), []);
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const act = useMemo(() => activity(COMMIT_DAYS, REPO_LIFE.born, now), [now]);
  const peak = useMemo(() => busiestDay(COMMIT_DAYS), []);
  const peakBorn = useMemo(() => (peak ? bornOn(WORLD_LIFE, peak.day) : []), [peak]);
  const quiet = useMemo(() => longestSilence(COMMIT_DAYS, REPO_LIFE.born, now), [now]);
  const busiest = Math.max(...eras.map((e) => e.worlds.length), 1);

  return (
    <div className="relative min-h-[100dvh] w-full bg-background">
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
        <StarField density={150} seed={0xc47} />
        <div
          className="absolute inset-x-0 top-0 h-[70vh]"
          style={{
            background:
              "radial-gradient(65% 50% at 30% 0%, hsl(266 85% 62% / 0.16), transparent 70%)," +
              "radial-gradient(55% 45% at 78% 8%, hsl(160 80% 50% / 0.12), transparent 72%)",
          }}
        />
      </div>

      <div className="relative mx-auto max-w-3xl px-4 pb-24 pt-16 sm:px-6 sm:pt-20">
        <header>
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.34em] text-muted-foreground sm:text-[10px]">
            Every world, in the order it appeared
          </p>
          <h1 className="mt-2 font-heading text-4xl font-black leading-[1.04] tracking-tight sm:text-6xl">
            <span className="text-gradient-mint">THE CHRONICLE</span>
          </h1>

          {/* The opening line is the repository's own first commit, quoted.
              It is not a grand one and that is exactly why it is worth keeping:
              nothing that has grown to fifty worlds started by announcing
              itself. */}
          <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground">
            The vibeverse begins on{" "}
            <span className="text-foreground">{dayLabel(REPO_LIFE.born)}</span>, with a
            commit that says{" "}
            <span className="italic text-foreground/80">“{REPO_LIFE.firstWords}”</span>.
            Everything below grew from that in {ageDays.toLocaleString()} days.
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Worlds" value={dated.toLocaleString()} />
            <Stat label="Commits" value={REPO_LIFE.commits.toLocaleString()} />
            <Stat label="Hands" value={String(REPO_LIFE.hands)} />
            <Stat label="You have seen" value={`${beenTo}/${dated}`} accent="#7dffd4" />
          </dl>
        </header>

        {/* The shape of the growth, before the detail of it. Fifty-two rows
            answer "what happened"; this answers "how fast", which is the
            question the list is too long to answer on its own. */}
        <section className="mt-10" aria-label="Worlds opened per month">
          <div className="flex items-end gap-1.5">
            {eras.map((e) => (
              <div key={e.month} className="flex flex-1 flex-col items-center gap-1.5">
                <div
                  className="w-full rounded-t"
                  style={{
                    height: `${Math.max(8, (e.worlds.length / busiest) * 72)}px`,
                    background: "linear-gradient(to top, #7dffd4aa, #c4b2ff)",
                  }}
                  title={`${e.worlds.length} in ${e.month}`}
                />
                <span className="font-mono text-[9px] tabular-nums text-muted-foreground/60">
                  {e.worlds.length}
                </span>
                <span className="font-heading text-[8.5px] uppercase tracking-wider text-muted-foreground/50">
                  {e.month.split(" ")[0].slice(0, 3)}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* The days themselves, under the months. The bar chart says how many
            worlds a month produced; this says what the work looked like — and
            the two disagree in the interesting way, because the busiest day in
            the vibeverse's history produced no worlds at all. */}
        <section className="mt-10" aria-label="Every day, by how much was committed">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="font-heading text-sm font-black uppercase tracking-wider text-[#c4b2ff]">
              Every day
            </h2>
            <p className="text-[11.5px] text-muted-foreground">
              {act.activeDays} of {act.totalDays} days had something committed —{" "}
              {act.sharePct}% of them.
            </p>
          </div>
          <div className="mt-3">
            <DayGrid arrival={arrival} />
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {peak && (
              <Note label="The hardest day">
                <span className="text-foreground">{longDate(peak.day)}</span> —{" "}
                {peak.commits} commits.{" "}
                {peakBorn.length
                  ? `${peakBorn.map(worldName).join(", ")} ${peakBorn.length === 1 ? "was" : "were"} born that day.`
                  : "Nothing was born that day; it was all repair and rebuild."}
              </Note>
            )}
            {quiet && (
              <Note label="The longest quiet">
                {quiet.days} days without a commit, from{" "}
                <span className="text-foreground">{longDate(quiet.from)}</span> to{" "}
                <span className="text-foreground">{longDate(quiet.to)}</span>.{" "}
                {quiet.to === todayKey
                  ? "That silence is the one we are in now."
                  : "Then it started again."}
              </Note>
            )}
          </div>
        </section>

        <div className="mt-12 space-y-12">
          {eras.map((era) => (
            <section key={era.month}>
              <div className="flex items-baseline gap-3">
                <h2 className="font-heading text-lg font-black uppercase tracking-wider text-[#c4b2ff]">
                  {era.month}
                </h2>
                <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground/60">
                  {era.worlds.length} {era.worlds.length === 1 ? "world" : "worlds"}
                </span>
              </div>

              {/* The line down the left is the timeline itself. Each world is a
                  node on it, so a month with one world reads as a quiet month
                  rather than as a formatting accident. */}
              <ol className="mt-4 border-l border-border/50 pl-5">
                {era.worlds.map((w) => {
                  const life = WORLD_LIFE[w.key];
                  const art = artFor(w.key);
                  const been = visited.has(w.route);
                  return (
                    <li key={w.key} className="relative py-3 first:pt-0 last:pb-0">
                      <span
                        aria-hidden
                        className="absolute -left-[1.42rem] top-5 h-2 w-2 rounded-full ring-4 ring-background"
                        style={{ background: been ? "#7dffd4" : w.accent }}
                      />
                      <Link
                        to={w.route}
                        className="group flex gap-3.5 rounded-xl p-2 transition-colors hover:bg-white/[0.03] sm:gap-4"
                      >
                        <div
                          className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-black/50 sm:w-32"
                          style={{ boxShadow: `inset 0 0 0 1px ${w.accent}33` }}
                        >
                          {art ? (
                            <img
                              src={art}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                            />
                          ) : (
                            <div
                              className="h-full w-full"
                              style={{
                                background: `radial-gradient(120% 90% at 20% 0%, ${w.accent}44, transparent 65%), #0a0e16`,
                              }}
                            />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="text-sm leading-none" aria-hidden>
                              {w.emoji}
                            </span>
                            <h3 className="font-heading text-[13.5px] font-bold leading-tight">
                              {w.name}
                            </h3>
                            {been && (
                              <span className="font-heading text-[8.5px] font-bold uppercase tracking-wider text-[#7dffd4]">
                                stamped
                              </span>
                            )}
                          </div>
                          <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
                            {w.blurb}
                          </p>
                          {/* Day-of-the-vibeverse rather than a bare date: it
                              says how far into the story this one arrives,
                              which a calendar date does not. */}
                          <p className="mt-1.5 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/50">
                            {dayLabel(life.born)} · day {dayNumber(life.born)} ·{" "}
                            {life.commits.toLocaleString()}{" "}
                            {life.commits === 1 ? "commit" : "commits"}
                            {life.hands > 1 ? ` · ${life.hands} hands` : ""}
                          </p>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>

        <footer className="mt-16 border-t border-border/40 pt-6">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            <span className="text-foreground/80">
              None of this history is fetched from anywhere.
            </span>{" "}
            The dates are read out of git by a script and committed as a file
            beside this one, the pictures are files in the repository, and the
            only thing read at runtime is your own passport, which never leaves
            this browser. There is no request behind any line below — a test
            walks this page's imports and fails if one appears. (The sign-in
            chip in the corner is the app around it, and does talk to a server;
            that is the app's business, not the Chronicle's.) When the coins,
            the accounts and the servers are gone, this page still opens from a
            folder on a disk, and is still true.
          </p>
          <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
            It is also not finished, and cannot be: add a world and it writes
            itself a line here.{" "}
            <Link to="/game" className="text-primary hover:underline">
              Go and see them
            </Link>
            , or{" "}
            <Link to="/manifesto" className="text-primary hover:underline">
              read why they exist
            </Link>
            .
          </p>
        </footer>
      </div>
    </div>
  );
}

/** `2026-06-18` → `18 June 2026`. */
function longDate(day: string): string {
  return new Date(dayMs(day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A world's display name, falling back to its key if it has left the registry. */
function worldName(key: string): string {
  return WORLDS.find((w) => w.key === key)?.name ?? key;
}

function Note({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/40 bg-black/20 p-3.5">
      <div className="font-heading text-[8.5px] font-bold uppercase tracking-[0.18em] text-muted-foreground/60">
        {label}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-border/40 bg-black/20 px-3 py-2.5">
      <dt className="font-heading text-[8.5px] font-bold uppercase tracking-[0.18em] text-muted-foreground/60">
        {label}
      </dt>
      <dd
        className="mt-0.5 font-heading text-xl font-black tabular-nums"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
