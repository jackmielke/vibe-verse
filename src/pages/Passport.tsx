/**
 * `/passport` — the book of everywhere you have been.
 *
 * The passport has existed for months as five words on the landing page:
 * "passport 18/28", in grey, not a link. It was the only thing in the
 * vibeverse that spanned every world, and the only way to see it was to read
 * a fraction.
 *
 * So this is the book. One badge per world, and the badge is the point: a
 * stamped world gets a lit seal in its own accent colour, an unexplored one
 * gets a dark blank with a dashed rim. The difference has to be visible from
 * across the room, because the whole feeling this page is trying to produce is
 * *there are more of these to get*.
 *
 * Three things it does that a checklist would not:
 *
 * 1. **Rank, not just presence.** A world you have been to twelve times reads
 *    differently from one you glanced at once. `rankOf` in `lib/passport.ts`
 *    turns arrival count into Stamped / Regular / Local, and the seal gains a
 *    ring for each. A record that flattens those two into "✓" is throwing away
 *    the more interesting half of what it knows.
 * 2. **The unexplored ones are doors.** Every locked badge is a link. A
 *    completion page that shows you what you are missing and does not offer to
 *    take you there is a scoreboard, not a passport.
 * 3. **One stamp cannot be visited at all.** Redline has no page — you earn it
 *    by holding the landing site. It is called out rather than sitting in the
 *    grid pretending to be a link that does nothing.
 *
 * The passport itself is `localStorage`, deliberately — see `lib/passport.ts`.
 * That means this page is honest only about *this browser*, and it says so at
 * the bottom rather than implying an account-wide record it does not have.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import VibeMark from "@/components/VibeMark";
import { REPO_LIFE } from "@/worlds/chronicle";
import { motion } from "framer-motion";
import { Lock } from "lucide-react";

import {
  RANKS,
  passportRows,
  type PassportRow,
  type Rank,
} from "@/lib/passport";

type Filter = "all" | "stamped" | "unexplored";

const DAY_MS = 86_400_000;

/** Whole days from the vibeverse's first commit to `t`, 1-indexed. */
function dayOfVibeverse(t: number): number {
  return Math.max(1, Math.floor((t - Date.parse(REPO_LIFE.born)) / DAY_MS) + 1);
}

/** How many rings the seal wears. One per rank above "stamped". */
const RANK_RINGS: Record<Rank, number> = {
  unexplored: 0,
  visited: 1,
  regular: 2,
  local: 3,
};

/**
 * Badge shape, by what kind of place it is.
 *
 * Colour and emoji already make every badge unique; this makes the *kinds*
 * legible at a glance, so a wall of twenty-eight seals has a second thing to
 * read besides "lit or not". Corner radius rather than clip-path, because a
 * clip cuts the ring borders off and the rings are what rank is made of.
 */
const KIND_SHAPE: Record<string, string> = {
  game: "34%",      // rounded hex-ish — the most badge-like
  world: "50%",     // a proper circle: the classic stamp
  hangout: "26%",
  tool: "16%",      // nearly a square. Tools are not places.
};

const KIND_LABEL: Record<string, string> = {
  game: "Games",
  world: "Worlds",
  hangout: "Hangouts",
  tool: "The building",
};

function when(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * One seal.
 *
 * Built from nested rings rather than an image so it takes its colour from the
 * registry — a world that changes its accent changes its badge, and a world
 * added tomorrow gets a badge nobody has to draw.
 */
function Badge({ row, i }: { row: PassportRow; i: number }) {
  const rings = RANK_RINGS[row.rank];
  const lit = row.visited;
  const c = row.accent;
  const radius = KIND_SHAPE[row.kind] ?? "50%";

  const seal = (
    <div className="relative grid h-[4.6rem] w-[4.6rem] shrink-0 place-items-center sm:h-20 sm:w-20">
      {/* Rank rings, outermost first. They are the one thing on the badge that
          can only be got by going back. */}
      {Array.from({ length: rings }).map((_, r) => (
        <span
          key={r}
          className="absolute"
          style={{
            inset: `${r * 5}px`,
            borderRadius: radius,
            border: `1.5px solid ${c}${r === 0 ? "cc" : r === 1 ? "88" : "55"}`,
            boxShadow: r === 0 ? `0 0 18px ${c}44` : undefined,
          }}
          aria-hidden
        />
      ))}
      {!lit && (
        <span
          className="absolute inset-0 border border-dashed border-white/15"
          style={{ borderRadius: radius }}
          aria-hidden
        />
      )}
      <span
        className="absolute inset-[13px]"
        style={{
          borderRadius: radius,
          background: lit
            ? `radial-gradient(120% 120% at 30% 20%, ${c}3a, ${c}0d 60%, transparent)`
            : "rgba(255,255,255,0.025)",
        }}
        aria-hidden
      />
      <span
        className={`relative text-[1.6rem] leading-none transition-transform duration-300 sm:text-[1.75rem] ${
          lit ? "" : "opacity-25 grayscale"
        }`}
        aria-hidden
      >
        {row.emoji}
      </span>
      {!lit && (
        <span className="absolute bottom-0 right-0 grid h-5 w-5 place-items-center rounded-full border border-white/10 bg-[#0a0d16]">
          <Lock className="h-2.5 w-2.5 text-white/35" />
        </span>
      )}
    </div>
  );

  const body = (
    <>
      {seal}
      <div className="min-w-0 flex-1">
        <div
          className={`truncate font-heading text-[12.5px] font-bold leading-tight ${
            lit ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          {row.name}
        </div>
        <div
          className="mt-0.5 font-heading text-[8.5px] font-bold uppercase tracking-[0.18em]"
          style={{ color: lit ? c : undefined }}
        >
          <span className={lit ? "" : "text-muted-foreground/50"}>
            {RANKS[row.rank].label}
          </span>
        </div>
        <div className="mt-1 text-[10px] leading-snug text-muted-foreground/60">
          {lit
            ? `${row.count} ${row.count === 1 ? "arrival" : "arrivals"} · ${when(row.last)}`
            : row.earned
              ? "Held, not visited"
              : "Never been"}
        </div>
      </div>
    </>
  );

  const shell =
    "group flex items-center gap-3 rounded-2xl border p-3 text-left transition-colors";
  const skin = lit
    ? "border-white/10 bg-white/[0.035] hover:bg-white/[0.06]"
    : "border-white/[0.06] bg-white/[0.012] hover:bg-white/[0.04]";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(i, 14) * 0.025, duration: 0.3 }}
    >
      {row.earned ? (
        /* No link: Redline has no page. Rendered as a plain card so a tap
           does not silently do nothing. */
        <div className={`${shell} ${skin} cursor-default`} title={row.blurb}>
          {body}
        </div>
      ) : (
        <Link to={row.route} className={`${shell} ${skin}`} title={row.blurb}>
          {body}
        </Link>
      )}
    </motion.div>
  );
}

export default function Passport() {
  /* No stamp of its own. This is the book, not a place in it — a passport
     that records you having looked at your passport is counting the wrong
     thing, and it would need a page in itself to do it. */

  /* Read once. The passport is localStorage and nothing on this page writes
     to it, so re-reading on every render would be work for no new answer. */
  const rows = useMemo(() => passportRows(), []);
  const [filter, setFilter] = useState<Filter>("all");

  const visited = rows.filter((r) => r.visited);
  const trips = rows.reduce((n, r) => n + r.count, 0);
  const pct = rows.length ? Math.round((visited.length / rows.length) * 100) : 0;
  const first = visited.reduce((m, r) => (r.first && (!m || r.first < m) ? r.first : m), 0);
  const arrivalDay = first ? dayOfVibeverse(first) : 0;
  const ageDays = dayOfVibeverse(Date.now());

  const shown = rows.filter((r) =>
    filter === "all" ? true : filter === "stamped" ? r.visited : !r.visited,
  );

  /* Grouped by what kind of place it is, which is the same grouping `/game`
     uses. A flat grid of twenty-eight badges is a wall; four short sections
     are a book with chapters. */
  const groups = useMemo(() => {
    const out = new Map<string, PassportRow[]>();
    for (const r of shown) {
      const k = r.kind ?? "world";
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(r);
    }
    return [...out.entries()].sort(
      (a, b) => ["game", "world", "hangout", "tool"].indexOf(a[0]) -
        ["game", "world", "hangout", "tool"].indexOf(b[0]),
    );
  }, [shown]);

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-[#05070f] text-foreground">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 45% at 50% -8%, hsl(200 85% 45% / 0.20), transparent 62%)," +
            "radial-gradient(60% 40% at 12% 22%, hsl(272 80% 55% / 0.16), transparent 66%)," +
            "radial-gradient(60% 40% at 90% 34%, hsl(160 80% 45% / 0.10), transparent 68%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-4xl px-4 pb-24 pt-20 sm:px-6 sm:pt-24">
        {/* ---- The document ----
            Laid out as an identity page rather than a dashboard header: a
            seal, a title, and a data block. The point is that this reads as a
            thing you were issued, not a progress bar somebody rendered. */}
        <motion.header
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="overflow-hidden rounded-3xl border border-white/12 bg-white/[0.035] backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-5 sm:p-6">
            {/* The progress seal. A ring rather than a bar because everything
                else on this page is a circle, and because a bar at 64% reads
                as a loading screen. */}
            <div className="relative grid h-24 w-24 shrink-0 place-items-center">
              <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
                <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" />
                <motion.circle
                  cx="50" cy="50" r="44" fill="none"
                  stroke="url(#pp)" strokeWidth="6" strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 44}
                  initial={{ strokeDashoffset: 2 * Math.PI * 44 }}
                  animate={{ strokeDashoffset: 2 * Math.PI * 44 * (1 - pct / 100) }}
                  transition={{ duration: 1.1, ease: "easeOut" }}
                />
                <defs>
                  <linearGradient id="pp" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#7dffd4" />
                    <stop offset="100%" stopColor="#8fb4ff" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="text-center">
                <div className="font-heading text-xl font-black leading-none tabular-nums">
                  {visited.length}
                  <span className="text-sm text-muted-foreground">/{rows.length}</span>
                </div>
                <div className="mt-0.5 font-heading text-[7.5px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  Stamped
                </div>
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <p className="font-heading text-[8.5px] font-bold uppercase tracking-[0.34em] text-[#7dffd4]/70">
                Vibeverse · Traveller's record
              </p>
              <h1 className="mt-1.5 font-heading text-3xl font-black leading-none tracking-tight sm:text-4xl">
                The Passport
              </h1>
              <p className="mt-2 max-w-md text-[12px] leading-relaxed text-muted-foreground">
                Every world stamps this book when you arrive. Go back often
                enough and the stamp gains rings.
              </p>
              {/* Where your record sits inside the vibeverse's own.
                  `first` is the earliest arrival in this browser, `REPO_LIFE`
                  is the first commit there ever was, and the difference is the
                  one fact only the passport can tell you — not when you turned
                  up, but how far into the story. It is also the only link to
                  `/chronicle` that is about *you* rather than about the place. */}
              {first > 0 && (
                <p className="mt-2 max-w-md text-[12px] leading-relaxed text-muted-foreground">
                  You arrived on{" "}
                  <span className="text-foreground">day {arrivalDay}</span> of a
                  story that is {ageDays} days long so far —{" "}
                  <Link to="/chronicle" className="text-[#c4b2ff] hover:underline">
                    read the whole thing
                  </Link>
                  .
                </p>
              )}
            </div>

            {/* The crest. Every real passport has one on the cover, and this is
                the vibeverse's — the live mark rather than the flat render,
                because on a page that is otherwise a record of things already
                done it is the one element doing something now. It celebrates:
                earn coins with this page open and it takes a lap. */}
            <div className="hidden shrink-0 lg:block" aria-hidden>
              <VibeMark size={92} rotateSeconds={34} celebrates />
            </div>

            <dl className="flex gap-5 sm:gap-7">
              {[
                ["Arrivals", String(trips)],
                ["Left to find", String(rows.length - visited.length)],
                ["Since", first ? when(first) : "—"],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="font-heading text-[7.5px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    {k}
                  </dt>
                  <dd className="mt-1 font-heading text-base font-black tabular-nums text-foreground">
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* The strip along the bottom of every real passport. Here it is the
              actual record, encoded — visited worlds as filled cells, in
              registry order — so it is a readable index rather than a
              decoration pretending to be data. */}
          <div
            className="flex h-8 items-stretch gap-[2px] border-t border-white/10 bg-black/30 px-3 py-2"
            aria-hidden
          >
            {rows.map((r) => (
              <span
                key={r.route}
                className="flex-1 rounded-[1px]"
                style={{
                  background: r.visited ? r.accent : "rgba(255,255,255,0.06)",
                  opacity: r.visited ? 0.25 + RANK_RINGS[r.rank] * 0.25 : 1,
                }}
                title={r.name}
              />
            ))}
          </div>
        </motion.header>

        {/* ---- Filter ---- */}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {(
            [
              ["all", `All ${rows.length}`],
              ["stamped", `Stamped ${visited.length}`],
              ["unexplored", `Unexplored ${rows.length - visited.length}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
              className={`rounded-full border px-4 py-2 font-heading text-[10px] font-bold uppercase tracking-wider transition-colors ${
                filter === k
                  ? "border-white/40 bg-white/10 text-foreground"
                  : "border-white/10 text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="mt-12 text-center text-sm text-muted-foreground">
            {filter === "unexplored"
              ? "Nothing left. You have been everywhere."
              : "Nothing stamped yet — open any world and this fills in."}
          </p>
        ) : (
          <div className="mt-8 space-y-10">
            {groups.map(([kind, items]) => (
              <section key={kind}>
                <h2 className="font-heading text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
                  {KIND_LABEL[kind] ?? kind}
                  <span className="ml-2 text-muted-foreground/40">{items.length}</span>
                </h2>
                <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((r, i) => (
                    <Badge key={r.route} row={r} i={i} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <footer className="mt-14 border-t border-white/10 pt-6 text-[11px] leading-relaxed text-muted-foreground">
          The passport lives in this browser, not in your account — it needs no
          sign-in and works offline, and the trade for that is that it does not
          follow you to a different device. Ranks are{" "}
          {Object.values(RANKS)
            .filter((r) => r.at > 0)
            .map((r) => `${r.label} at ${r.at}`)
            .join(", ")}
          . One stamp has no page at all:{" "}
          <span className="text-foreground/70">Redline</span> is earned by
          clearing its landing site on the ground, which makes a full book the
          only thing here you cannot get to by clicking.
        </footer>
      </div>
    </div>
  );
}
