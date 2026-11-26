/**
 * The What's New list, merged and sorted, plus "have you seen it yet".
 *
 * Hand-written entries live in `entries.ts`. Build mode writes one JSON file
 * per shipped build into `auto/` (see `.github/workflows/build-mode.yml`), and
 * they are picked up here at build time, so there is nothing to register.
 */
import { useEffect, useState } from "react";
import { ENTRIES, type WhatsNewEntry } from "./entries";

export type { WhatsNewEntry, WhatsNewTag } from "./entries";

const AUTO = import.meta.glob<{ default: Partial<WhatsNewEntry> }>("./auto/*.json", { eager: true });

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Turn a build-mode file into an entry, or drop it if it is malformed. */
export function fromAuto(file: string, raw: Partial<WhatsNewEntry>): WhatsNewEntry | null {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const date = typeof raw.date === "string" ? raw.date.slice(0, 10) : "";
  if (!title || !DATE.test(date)) return null;
  const id = raw.id || file.replace(/^.*\//, "").replace(/\.json$/, "");
  return {
    id: String(id),
    date,
    emoji: raw.emoji || "🛠️",
    title,
    body: typeof raw.body === "string" ? raw.body.trim() : "",
    tag: raw.tag ?? "update",
    route: raw.route,
    world: raw.world,
    auto: true,
  };
}

/** Newest first. Same-day entries keep the order they were written in. */
export function mergeEntries(hand: WhatsNewEntry[], auto: WhatsNewEntry[]): WhatsNewEntry[] {
  const seen = new Set<string>();
  const all = [...auto, ...hand].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  return all
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.date === b.e.date ? a.i - b.i : a.e.date < b.e.date ? 1 : -1))
    .map(({ e }) => e);
}

const autoEntries = Object.entries(AUTO)
  .map(([file, mod]) => fromAuto(file, (mod as { default?: Partial<WhatsNewEntry> }).default ?? (mod as Partial<WhatsNewEntry>)))
  .filter((e): e is WhatsNewEntry => e !== null)
  // Build-mode files are named by date and time, so this puts the latest first.
  .sort((a, b) => (a.id < b.id ? 1 : -1));

export const WHATS_NEW: WhatsNewEntry[] = mergeEntries(ENTRIES, autoEntries);

/** Entries grouped by day, newest day first. */
export function byDay(list: WhatsNewEntry[] = WHATS_NEW): { date: string; entries: WhatsNewEntry[] }[] {
  const out: { date: string; entries: WhatsNewEntry[] }[] = [];
  for (const e of list) {
    const last = out[out.length - 1];
    if (last && last.date === e.date) last.entries.push(e);
    else out.push({ date: e.date, entries: [e] });
  }
  return out;
}

/** "Thursday, 26 November" style, read as a calendar date (no timezone shift). */
export function dayLabel(date: string, withYear = false): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

/** "Nov 26" */
export function shortDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ------------------------------------------------------------ seen / unseen */

const KEY = "vibe.whatsnew.seen";
const EVENT = "vibe:whatsnew-seen";

function readSeen(): Set<string> | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? new Set(v.map(String)) : null;
  } catch {
    return null;
  }
}

/**
 * How many entries this visitor has not seen. A first-time visitor has seen
 * nothing, but a badge reading "27" on somebody's first ever page is noise,
 * so they get the entries from the latest day only.
 */
export function unseenCount(list: WhatsNewEntry[] = WHATS_NEW): number {
  const seen = readSeen();
  if (!seen) {
    const latest = list[0]?.date;
    return latest ? Math.min(list.filter((e) => e.date === latest).length, 9) : 0;
  }
  return list.filter((e) => !seen.has(e.id)).length;
}

export function isUnseen(id: string): boolean {
  const seen = readSeen();
  return seen ? !seen.has(id) : false;
}

export function markAllSeen(list: WhatsNewEntry[] = WHATS_NEW): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.map((e) => e.id)));
  } catch {
    /* Private browsing: the badge comes back next visit, which is fine. */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Live unseen count, updated when any view marks the list as read. */
export function useUnseenCount(): number {
  const [n, setN] = useState(() => (typeof window === "undefined" ? 0 : unseenCount()));
  useEffect(() => {
    const on = () => setN(unseenCount());
    window.addEventListener(EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  return n;
}
