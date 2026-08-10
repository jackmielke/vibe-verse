/**
 * How long ago a world last changed, in words short enough for a card.
 *
 * The dates come from `updated.ts`, which is generated from git — see
 * `scripts/stamp-worlds.mjs`. This module is the reading of them, kept separate
 * so the generated file stays pure data and can be overwritten without thought.
 *
 * The vocabulary is deliberately coarse. "Updated 19 days ago" is a number
 * nobody does anything with; "updated 3 weeks ago" says the same thing and is
 * read rather than parsed. Anything past a year gets the year, because at that
 * distance "58 weeks ago" is just a worse way of writing 2025.
 */
import { WORLD_UPDATED } from "./updated";

export function updatedAt(key: string): string | null {
  return WORLD_UPDATED[key] ?? null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * `2026-08-07T06:58:26+00:00` → `today`, `3 days ago`, `last month`…
 *
 * `now` is injectable so the tests do not depend on what day it is.
 */
export function sinceLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;

  const ms = now - then;
  // A clock skew or a commit stamped slightly in the future should not produce
  // "in -3 days"; the honest reading of "just changed" is "today".
  if (ms < 0) return "today";
  if (ms < 22 * HOUR) return "today";
  if (ms < 2 * DAY) return "yesterday";
  if (ms < WEEK) return `${Math.round(ms / DAY)} days ago`;
  if (ms < 2 * WEEK) return "last week";
  if (ms < 5 * WEEK) return `${Math.round(ms / WEEK)} weeks ago`;
  if (ms < 8 * WEEK) return "last month";
  if (ms < 52 * WEEK) return `${Math.round(ms / (30 * DAY))} months ago`;
  return new Date(then).toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

/** The same thing, ready for a `title=` tooltip: the actual date. */
export function exactLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/** The clock, in the reader's own timezone and their own 12/24-hour habit. */
const clock = (d: Date): string =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * The same moment, for a *log* rather than a card.
 *
 * `sinceLabel` is deliberately coarse, which is right on a card: one date, one
 * glance, and "19 days ago" is a number nobody does anything with. It is wrong
 * in the changelog, where four entries in a row all read "today" and the list
 * stops being a sequence — you cannot tell which came first, or whether "today"
 * meant this morning or four minutes ago.
 *
 * So here the clock is always shown. Recent entries keep the relative word,
 * because "yesterday at 09:04" is easier to place than a date; past a week the
 * word stops helping and the actual date is shorter and more precise.
 *
 * `now` is injectable so the tests do not depend on what day it is.
 */
export function changeLabel(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const then = d.getTime();
  if (!Number.isFinite(then)) return null;

  const ms = now - then;
  const at = clock(d);
  /* Same guard as sinceLabel: a commit stamped slightly ahead of this clock is
     "just now", not "in -3 hours". */
  if (ms < 22 * HOUR) return `today at ${at}`;
  if (ms < 2 * DAY) return `yesterday at ${at}`;
  if (ms < WEEK) return `${Math.round(ms / DAY)} days ago at ${at}`;

  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date} at ${at}`;
}

/** Newest first. Used by `/game`'s "recently updated" sort. */
export function byFreshest(aKey: string, bKey: string): number {
  const a = updatedAt(aKey);
  const b = updatedAt(bKey);
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return new Date(b).getTime() - new Date(a).getTime();
}
