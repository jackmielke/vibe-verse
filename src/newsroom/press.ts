/**
 * What the presses are doing, worked out from the editions themselves.
 *
 * The newsroom shows a clock and a streak, and both are the kind of thing
 * that is easy to get subtly wrong and hard to notice: an off-by-one in the
 * streak, a countdown that says "due in 23 hours" during the very hour the
 * paper is being written. So the arithmetic lives here as plain functions
 * over plain data, with no clock of its own — every one of them takes `now`
 * — and the room is left to be a room.
 *
 * The schedule these describe is the pg_cron job `vibe-times-daily`:
 * hourly from 13:00 to 20:00 UTC, writing one edition on the first run that
 * finds the day unwritten. See docs/vibe-times.md.
 */

export const FIRST_RUN_UTC = 13;
export const LAST_RUN_UTC = 20;

/** UTC calendar day, which is the day an edition is dated by. */
export function utcDay(d: Date | string): string {
  return (typeof d === "string" ? new Date(d) : d).toISOString().slice(0, 10);
}

/**
 * How many mornings in a row the paper has come out, counting back from the
 * most recent edition.
 *
 * Counted from the latest edition rather than from today, because at 06:00
 * UTC today's paper does not exist yet and a streak that drops to zero every
 * morning is not measuring anything.
 */
export function streak(editionDates: string[], now: Date): number {
  const days = new Set(editionDates.map((d) => d.slice(0, 10)));
  if (!days.size) return 0;

  const today = utcDay(now);
  const yesterday = utcDay(new Date(now.getTime() - 86_400_000));
  // Start at whichever of today or yesterday actually has an edition; any
  // older and the run has already been broken.
  let cursor = days.has(today) ? today : days.has(yesterday) ? yesterday : null;
  if (!cursor) return 0;

  let run = 0;
  while (days.has(cursor)) {
    run += 1;
    cursor = utcDay(new Date(Date.parse(`${cursor}T00:00:00Z`) - 86_400_000));
  }
  return run;
}

export interface PressState {
  /** True while the schedule's window is open and today has no edition yet. */
  imminent: boolean;
  /** When the next edition is expected, as a Date. */
  due: Date;
  /** "in 4 hours", "in 12 minutes", "any minute now". */
  eta: string;
}

/**
 * When the next edition is due.
 *
 * Two cases, and the second is the one worth having a function for: if the
 * window is open and today's paper has not come out, the next attempt is at
 * the top of this hour, not tomorrow lunchtime.
 */
export function nextRun(now: Date, hasTodaysEdition: boolean): PressState {
  const hour = now.getUTCHours();
  const windowOpen = hour >= FIRST_RUN_UTC && hour <= LAST_RUN_UTC;

  if (!hasTodaysEdition && windowOpen) {
    const due = new Date(now);
    due.setUTCMinutes(0, 0, 0);
    due.setUTCHours(hour + 1);
    return { imminent: true, due, eta: describeGap(due.getTime() - now.getTime()) };
  }

  const due = new Date(now);
  due.setUTCMinutes(0, 0, 0);
  due.setUTCHours(FIRST_RUN_UTC);
  // Past this morning's run, or today is already written: it is tomorrow's.
  if (due.getTime() <= now.getTime() || hasTodaysEdition) {
    due.setUTCDate(due.getUTCDate() + 1);
  }
  return { imminent: false, due, eta: describeGap(due.getTime() - now.getTime()) };
}

/** "in 4 hours", "in 12 minutes", "any minute now". */
export function describeGap(ms: number): string {
  if (ms <= 60_000) return "any minute now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** "3 minutes ago", "2 hours ago", "yesterday". */
export function describeAge(iso: string | undefined, now: Date): string {
  if (!iso) return "some time ago";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "some time ago";
  const ms = now.getTime() - then;
  if (ms < 90_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
