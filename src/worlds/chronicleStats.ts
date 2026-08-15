/**
 * What a full history knows that a list of birthdays does not.
 *
 * `chronicle.ts` is generated data: when each world was born, and how many
 * commits landed on each day. This is the reading of it — kept separate and
 * pure so the interesting claims (*the busiest day*, *the longest silence*) can
 * be tested against known input instead of eyeballed on a page.
 *
 * Every function here takes the day map rather than importing it, for the same
 * reason: a statistic that can only be checked by looking at the real data is a
 * statistic nobody checks.
 */

const DAY_MS = 86_400_000;

/** `2026-06-18` → epoch ms at UTC midnight. */
export function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** Epoch ms → `2026-06-18`. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Every calendar day from the first commit to today, inclusive.
 *
 * Including the empty ones, which are most of them and the whole point: a grid
 * that skips silent days is a grid where a fortnight off looks like a weekend.
 */
export function spanDays(bornISO: string, now: number): string[] {
  const start = dayMs(bornISO.slice(0, 10));
  const end = dayMs(dayKey(now));
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(dayKey(t));
  return out;
}

export interface BusiestDay {
  day: string;
  commits: number;
}

/**
 * The single hardest day.
 *
 * Ties break to the *earliest*, deliberately: if a record is equalled the day
 * it was set that is a coincidence, and if it is equalled a month later the
 * first one is still the day it first happened.
 */
export function busiestDay(days: Record<string, number>): BusiestDay | null {
  let best: BusiestDay | null = null;
  for (const day of Object.keys(days).sort()) {
    if (!best || days[day] > best.commits) best = { day, commits: days[day] };
  }
  return best;
}

export interface Silence {
  /** First silent day and last silent day, inclusive. */
  from: string;
  to: string;
  days: number;
}

/**
 * The longest run of days with no commits at all.
 *
 * Bounded by the first and last day of the span rather than by the data, so a
 * quiet stretch at either end counts. A project's longest silence is very often
 * the one it is in right now, and a function that only looked *between* commits
 * would be the one thing unable to see it.
 */
export function longestSilence(
  days: Record<string, number>,
  bornISO: string,
  now: number,
): Silence | null {
  const span = spanDays(bornISO, now);
  let best: Silence | null = null;
  let runStart: string | null = null;
  let runLen = 0;

  const close = (endIndex: number) => {
    if (runStart && (!best || runLen > best.days)) {
      best = { from: runStart, to: span[endIndex], days: runLen };
    }
    runStart = null;
    runLen = 0;
  };

  span.forEach((day, i) => {
    if (days[day]) close(i - 1);
    else {
      if (!runStart) runStart = day;
      runLen++;
      if (i === span.length - 1) close(i);
    }
  });

  return best;
}

/** Which worlds were born on a given day. Keys, in whatever order given. */
export function bornOn(
  life: Record<string, { born: string }>,
  day: string,
): string[] {
  return Object.keys(life).filter((k) => life[k].born.slice(0, 10) === day);
}

/**
 * Five buckets of busyness, for shading a cell.
 *
 * Thresholds rather than a linear scale because the distribution is wildly
 * skewed — one day has 196 commits and the median working day has about ten, so
 * anything proportional renders every ordinary day as the same near-black and
 * the whole grid becomes one bright square and a lot of nothing.
 */
export function heat(commits: number): 0 | 1 | 2 | 3 | 4 {
  if (!commits) return 0;
  if (commits <= 3) return 1;
  if (commits <= 12) return 2;
  if (commits <= 40) return 3;
  return 4;
}

/** Totals worth putting above a grid nobody will count by hand. */
export function activity(days: Record<string, number>, bornISO: string, now: number) {
  const span = spanDays(bornISO, now);
  const active = span.filter((d) => days[d]).length;
  return {
    totalDays: span.length,
    activeDays: active,
    /* Of the days that existed, the share anybody worked. The honest version
       of "how often is this thing touched" — a commit count alone cannot tell
       a steady month from one heroic weekend. */
    sharePct: span.length ? Math.round((active / span.length) * 100) : 0,
  };
}
