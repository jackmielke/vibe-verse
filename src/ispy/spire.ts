/**
 * THE SPIRE — the other realm.
 *
 * Eleven levels exist. Played from the picker they are eleven separate
 * things: you pick one, you learn it, you beat it, you pick another. The
 * Spire is the same eleven levels arranged as one building — floor one is
 * the city, floor eleven is whatever is at the top — and you climb it in a
 * single sitting with three lives for the whole ascent.
 *
 * Nothing here is a new level. That is the point of it: a marathon realm
 * costs no new content and completely changes what the content is for. A
 * level you can clear four times out of five is a level you have beaten; a
 * level you can clear four times out of five is also a floor you will fall
 * off, twice, on the way up.
 *
 * This file owns only the record. The run itself lives in the page, because
 * a run is a sequence of engines and the engine deliberately knows about
 * exactly one level.
 */

const KEY = "ispy:spire";

/** Lives for the whole climb, not per floor. */
export const SPIRE_LIVES = 3;

export interface SpireRecord {
  /** Floors cleared outright. The score. */
  cleared: number;
  /** How far into the floor after those the best run got, 0..100. */
  percent: number;
  /** Whether anyone has ever topped the building out. */
  topped: boolean;
}

const EMPTY: SpireRecord = { cleared: 0, percent: 0, topped: false };

export function readSpire(): SpireRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return EMPTY;
    return {
      cleared: Number(raw.cleared) || 0,
      percent: Number(raw.percent) || 0,
      topped: Boolean(raw.topped),
    };
  } catch {
    return EMPTY;
  }
}

/** Keep whichever run got further, and write it back. Returns the winner. */
export function bankSpire(run: SpireRecord): SpireRecord {
  const best = readSpire();
  const better =
    run.cleared > best.cleared ||
    (run.cleared === best.cleared && run.percent > best.percent);
  const keep: SpireRecord = better
    ? { ...run, topped: run.topped || best.topped }
    : { ...best, topped: best.topped || run.topped };
  try {
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    /* private browsing — the climb still happened, it just will not persist */
  }
  return keep;
}

/** "3 floors · 41%" — the one string the whole realm is scored by. */
export function spireLabel(r: SpireRecord, floors: number): string {
  if (r.topped) return "topped out";
  if (r.cleared === 0 && r.percent === 0) return "never climbed";
  const f = `${r.cleared} floor${r.cleared === 1 ? "" : "s"}`;
  if (r.cleared >= floors) return f;
  return `${f} · ${r.percent.toFixed(0)}%`;
}
