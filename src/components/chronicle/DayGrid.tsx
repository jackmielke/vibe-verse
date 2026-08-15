/**
 * Every day of the vibeverse, one square each.
 *
 * The list below this on `/chronicle` says what was built. This says when
 * anybody was *here* — and it is the only view that shows the shape of the
 * work rather than its results: the fortnight nothing happened, the day a
 * hundred and ninety-six commits landed, the run of evenings that turned into
 * a month.
 *
 * ## Silence is data
 *
 * Days with no commits are drawn, not skipped. A grid that only plots the days
 * somebody worked is a grid where a fortnight off looks like a weekend, which
 * inverts the one thing this is good at showing. `COMMIT_DAYS` stores only the
 * days that had commits — the gaps are the silence, and `spanDays` puts them
 * back.
 *
 * ## Weekday rows, not a straight run
 *
 * Columns are weeks and rows are weekdays, the way every contribution graph
 * does it, because the rhythm of a side project is weekly. Laid out as a plain
 * run of 123 squares the pattern that says "this is built on weekends" is
 * invisible; on a weekday grid it is the shape of the thing.
 */
import { COMMIT_DAYS, REPO_LIFE, WORLD_LIFE } from "@/worlds/chronicle";
import { bornOn, dayKey, dayMs, heat, spanDays } from "@/worlds/chronicleStats";

/** Faint to bright. Index is `heat()`. */
const SHADE = [
  "rgba(255,255,255,0.045)",
  "rgba(125,255,212,0.22)",
  "rgba(125,255,212,0.45)",
  "rgba(160,200,255,0.72)",
  "rgba(196,178,255,0.98)",
];

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

export default function DayGrid({
  now = Date.now(),
  arrival,
}: {
  now?: number;
  /** Epoch ms of the visitor's first ever stamp, if they have one. */
  arrival?: number;
}) {
  const days = spanDays(REPO_LIFE.born, now);
  const arrivalDay = arrival ? dayKey(arrival) : null;

  /* Column zero starts on the Sunday of the first week, so the weekday rows
     line up all the way across. The leading blanks are real calendar days that
     precede the project — drawn as nothing rather than as silence, because the
     vibeverse did not exist to be quiet in them. */
  const firstDow = new Date(dayMs(days[0])).getUTCDay();
  const cells: (string | null)[] = [...Array(firstDow).fill(null), ...days];
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  /* A month's label sits over the first week that contains its first day. */
  const monthAt = new Map<number, string>();
  weeks.forEach((week, i) => {
    for (const d of week) {
      if (!d) continue;
      if (d.slice(-2) === "01" || (i === 0 && !monthAt.size)) {
        if (!monthAt.has(i)) {
          monthAt.set(
            i,
            new Date(dayMs(d)).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
          );
        }
      }
    }
  });

  return (
    <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="inline-block min-w-full">
        <div className="flex gap-[3px] pl-[14px]">
          {weeks.map((_, i) => (
            <div
              key={i}
              className="w-[11px] shrink-0 font-heading text-[8px] uppercase tracking-wider text-muted-foreground/45"
            >
              {monthAt.get(i) ?? ""}
            </div>
          ))}
        </div>

        <div className="mt-1 flex gap-[3px]">
          {/* Weekday gutter. Only alternate rows are labelled — seven letters
              down the side of an eleven-pixel grid is noise. */}
          <div className="flex w-[11px] shrink-0 flex-col gap-[3px]">
            {WEEKDAY.map((d, i) => (
              <div
                key={i}
                className="h-[11px] font-heading text-[7.5px] leading-[11px] text-muted-foreground/40"
              >
                {i % 2 === 1 ? d : ""}
              </div>
            ))}
          </div>

          {weeks.map((week, wi) => (
            <div key={wi} className="flex shrink-0 flex-col gap-[3px]">
              {Array.from({ length: 7 }, (_, di) => {
                const day = week[di] ?? null;
                if (!day) return <div key={di} className="h-[11px] w-[11px]" />;

                const commits = COMMIT_DAYS[day] ?? 0;
                const born = bornOn(WORLD_LIFE, day);
                const isArrival = day === arrivalDay;
                const label = new Date(dayMs(day)).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                  timeZone: "UTC",
                });

                return (
                  <div
                    key={di}
                    className="h-[11px] w-[11px] rounded-[2px]"
                    style={{
                      background: SHADE[heat(commits)],
                      /* A world's birthday gets a ring, your arrival gets a
                         brighter one. Rings rather than a different fill: the
                         fill already means something, and a day can be both. */
                      boxShadow: isArrival
                        ? "0 0 0 1.5px #7dffd4"
                        : born.length
                          ? "0 0 0 1px rgba(255,209,122,0.75)"
                          : undefined,
                    }}
                    title={
                      `${label} — ${commits === 0 ? "nothing" : `${commits} commit${commits === 1 ? "" : "s"}`}` +
                      (born.length ? ` · ${born.join(", ")} born` : "") +
                      (isArrival ? " · you arrived" : "")
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[9px] text-muted-foreground/60">
          <span className="flex items-center gap-1.5">
            quiet
            {SHADE.map((c, i) => (
              <span key={i} className="h-[9px] w-[9px] rounded-[2px]" style={{ background: c }} />
            ))}
            busy
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-[9px] w-[9px] rounded-[2px]"
              style={{ background: SHADE[2], boxShadow: "0 0 0 1px rgba(255,209,122,0.75)" }}
            />
            a world was born
          </span>
          {arrivalDay && (
            <span className="flex items-center gap-1.5">
              <span
                className="h-[9px] w-[9px] rounded-[2px]"
                style={{ background: SHADE[2], boxShadow: "0 0 0 1.5px #7dffd4" }}
              />
              you arrived
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
